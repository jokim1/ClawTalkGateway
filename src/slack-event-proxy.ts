/**
 * Slack Event Proxy — Gateway as the Slack Events API entry point.
 *
 * Instead of OpenClaw receiving Slack events and asking Gateway whether to hand
 * them off, Gateway receives ALL Slack events first and decides:
 *   - ClawTalk-owned channels → process via the existing ingress pipeline
 *   - Everything else → forward the raw event to OpenClaw's HTTP webhook
 *
 * This eliminates the need for any code changes in OpenClaw. The only
 * requirement is that OpenClaw runs Slack in HTTP mode so it can receive
 * forwarded events from Gateway.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as undiciRequest } from 'undici';
import type { TalkStore } from './talk-store.js';
import type { Logger } from './types.js';
import {
  inspectSlackOwnership,
  routeSlackIngressEvent,
  parseSlackIngressEvent,
} from './slack-ingress.js';
import type { SlackIngressDeps } from './slack-ingress.js';
import { sendJson } from './http.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlackEventProxyDeps = {
  store: TalkStore;
  logger: Logger;
  getConfig: () => Record<string, unknown>;
  /** Build the deps object needed by routeSlackIngressEvent */
  buildIngressDeps: () => SlackIngressDeps;
};

type SlackEventsApiPayload = {
  token?: string;
  type: string;
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: {
    type: string;
    subtype?: string;
    channel?: string;
    channel_type?: string;
    user?: string;
    bot_id?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    event_ts?: string;
    files?: unknown[];
  };
  event_id?: string;
  event_time?: number;
};

// ---------------------------------------------------------------------------
// Slack request signature verification
// ---------------------------------------------------------------------------

const SLACK_SIGNATURE_VERSION = 'v0';
const SLACK_TIMESTAMP_TOLERANCE_S = 60 * 5; // 5 minutes

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: Buffer,
  signature: string,
): boolean {
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > SLACK_TIMESTAMP_TOLERANCE_S) return false;

  const sigBasestring = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${rawBody.toString('utf-8')}`;
  const mySignature = `${SLACK_SIGNATURE_VERSION}=` +
    createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  if (mySignature.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
}

// ---------------------------------------------------------------------------
// Raw body reader (preserves bytes for signature verification)
// ---------------------------------------------------------------------------

function readRawBody(req: IncomingMessage, maxBytes = 512 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds ${maxBytes} byte limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Config resolution helpers
// ---------------------------------------------------------------------------

type AccountSecret = { accountId: string; secret: string };

/**
 * Collect all configured signing secrets mapped to their accountId.
 * Resolution order:
 *   1. Per-account secrets (channels.slack.accounts.{id}.signingSecret)
 *   2. Base-level secret (channels.slack.signingSecret) applied to 'default' account
 *   3. Env var fallback (GATEWAY_SLACK_SIGNING_SECRET or SLACK_SIGNING_SECRET) applied to 'default'
 *
 * Returns deduplicated list; a secret appears only once (first accountId wins).
 */
export function collectSigningSecrets(cfg: Record<string, unknown>): AccountSecret[] {
  const result: AccountSecret[] = [];
  const seenSecrets = new Set<string>();

  const channels = cfg.channels && typeof cfg.channels === 'object'
    ? cfg.channels as Record<string, unknown> : null;
  const chSlack = channels?.slack && typeof channels.slack === 'object'
    ? channels.slack as Record<string, unknown> : null;

  // 1. Per-account secrets (highest specificity)
  const accounts = chSlack?.accounts;
  if (accounts && typeof accounts === 'object') {
    for (const [accountId, acc] of Object.entries(accounts as Record<string, unknown>)) {
      if (acc && typeof acc === 'object') {
        const s = (acc as Record<string, unknown>).signingSecret;
        if (typeof s === 'string' && s.trim() && !seenSecrets.has(s.trim())) {
          seenSecrets.add(s.trim());
          result.push({ accountId: accountId.trim().toLowerCase() || 'default', secret: s.trim() });
        }
      }
    }
  }

  // 2. Base-level secret (channels.slack.signingSecret)
  const chSecret = chSlack?.signingSecret;
  if (typeof chSecret === 'string' && chSecret.trim() && !seenSecrets.has(chSecret.trim())) {
    seenSecrets.add(chSecret.trim());
    result.push({ accountId: 'default', secret: chSecret.trim() });
  }

  // 3. Env var fallback
  const envSecret = process.env.GATEWAY_SLACK_SIGNING_SECRET?.trim()
    || process.env.SLACK_SIGNING_SECRET?.trim();
  if (envSecret && !seenSecrets.has(envSecret)) {
    result.push({ accountId: 'default', secret: envSecret });
  }

  return result;
}

/**
 * Verify a Slack request signature against all configured signing secrets.
 * Returns the accountId of the matching secret, or null if none match.
 */
export function verifyAndResolveAccount(
  cfg: Record<string, unknown>,
  timestamp: string,
  rawBody: Buffer,
  signature: string,
): { accountId: string } | null {
  const secrets = collectSigningSecrets(cfg);
  for (const { accountId, secret } of secrets) {
    if (verifySlackSignature(secret, timestamp, rawBody, signature)) {
      return { accountId };
    }
  }
  return null;
}

/** @deprecated Use collectSigningSecrets + verifyAndResolveAccount instead */
export function resolveSlackSigningSecret(cfg: Record<string, unknown>): string | undefined {
  const secrets = collectSigningSecrets(cfg);
  return secrets[0]?.secret;
}

/**
 * Resolve the OpenClaw webhook URL for forwarding Slack events.
 *
 * Priority:
 *   1. Env var GATEWAY_SLACK_OPENCLAW_WEBHOOK_URL (override for all accounts)
 *   2. Config gateway.slack.openclawWebhookUrl (override for all accounts)
 *   3. Per-account webhookPath from channels.slack.accounts.{accountId}.webhookPath
 *   4. Default: http://127.0.0.1:{port}/slack/events
 */
export function resolveOpenClawWebhookUrl(
  cfg: Record<string, unknown>,
  accountId?: string,
): string {
  // 1. Env var override (applies to all accounts)
  const envUrl = process.env.GATEWAY_SLACK_OPENCLAW_WEBHOOK_URL?.trim();
  if (envUrl) return envUrl;

  // 2. Config-level override (applies to all accounts)
  const gw = cfg.gateway && typeof cfg.gateway === 'object'
    ? cfg.gateway as Record<string, unknown> : null;
  const gwSlack = gw?.slack && typeof gw.slack === 'object'
    ? gw.slack as Record<string, unknown> : null;
  const cfgUrl = gwSlack?.openclawWebhookUrl;
  if (typeof cfgUrl === 'string' && cfgUrl.trim()) return cfgUrl.trim();

  // 3. Resolve per-account webhookPath from OpenClaw config
  const openclawPort = process.env.OPENCLAW_HTTP_PORT?.trim() || '3000';
  const baseUrl = `http://127.0.0.1:${openclawPort}`;

  if (accountId) {
    const channels = cfg.channels && typeof cfg.channels === 'object'
      ? cfg.channels as Record<string, unknown> : null;
    const chSlack = channels?.slack && typeof channels.slack === 'object'
      ? channels.slack as Record<string, unknown> : null;
    const accounts = chSlack?.accounts;
    if (accounts && typeof accounts === 'object') {
      const acc = (accounts as Record<string, unknown>)[accountId];
      if (acc && typeof acc === 'object') {
        const webhookPath = (acc as Record<string, unknown>).webhookPath;
        if (typeof webhookPath === 'string' && webhookPath.trim()) {
          const p = webhookPath.trim();
          return `${baseUrl}${p.startsWith('/') ? p : '/' + p}`;
        }
      }
    }
  }

  // 4. Default path
  return `${baseUrl}/slack/events`;
}

// ---------------------------------------------------------------------------
// Convert raw Slack Events API payload to SlackIngressEvent body
// ---------------------------------------------------------------------------

function buildEventIdFromSlack(payload: SlackEventsApiPayload, accountId: string): string {
  const evt = payload.event;
  if (!evt) return `slack:${accountId}:unknown:${Date.now()}`;
  const channelId = evt.channel ?? 'unknown';
  const ts = evt.ts ?? evt.event_ts ?? String(Date.now());
  return `slack:${accountId}:${channelId}:${ts}`;
}

function slackPayloadToIngressBody(
  payload: SlackEventsApiPayload,
  accountId: string,
): Record<string, unknown> | null {
  const evt = payload.event;
  if (!evt?.channel) return null;

  return {
    eventId: buildEventIdFromSlack(payload, accountId),
    accountId,
    channelId: evt.channel,
    threadTs: evt.thread_ts,
    messageTs: evt.ts,
    userId: evt.user,
    text: evt.text ?? '',
  };
}

// ---------------------------------------------------------------------------
// Forward raw Slack event to OpenClaw's HTTP webhook
// ---------------------------------------------------------------------------

const FORWARD_MAX_RETRIES = 2;
const FORWARD_RETRY_BASE_MS = 500;

async function forwardToOpenClawOnce(
  rawBody: Buffer,
  originalHeaders: Record<string, string>,
  openclawUrl: string,
): Promise<{ status: number; body: unknown }> {
  const resp = await undiciRequest(openclawUrl, {
    method: 'POST',
    headers: {
      'content-type': originalHeaders['content-type'] || 'application/json',
      'x-slack-signature': originalHeaders['x-slack-signature'] || '',
      'x-slack-request-timestamp': originalHeaders['x-slack-request-timestamp'] || '',
    },
    body: rawBody,
    headersTimeout: 10_000,
    bodyTimeout: 30_000,
  });
  const text = await resp.body.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: resp.statusCode, body };
}

async function forwardToOpenClaw(
  rawBody: Buffer,
  originalHeaders: Record<string, string>,
  openclawUrl: string,
  logger: Logger,
): Promise<{ status: number; body: unknown }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= FORWARD_MAX_RETRIES; attempt++) {
    try {
      const result = await forwardToOpenClawOnce(rawBody, originalHeaders, openclawUrl);
      // Retry on 5xx server errors (OpenClaw may be restarting)
      if (result.status >= 500 && attempt < FORWARD_MAX_RETRIES) {
        logger.debug(
          `SlackEventProxy: OpenClaw returned ${result.status}, retrying (${attempt + 1}/${FORWARD_MAX_RETRIES})`,
        );
        await new Promise(r => setTimeout(r, FORWARD_RETRY_BASE_MS * (attempt + 1)));
        continue;
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < FORWARD_MAX_RETRIES) {
        logger.debug(
          `SlackEventProxy: forward attempt ${attempt + 1} failed, retrying: ${String(err)}`,
        );
        await new Promise(r => setTimeout(r, FORWARD_RETRY_BASE_MS * (attempt + 1)));
      }
    }
  }
  logger.warn(
    `SlackEventProxy: failed to forward to OpenClaw at ${openclawUrl} after ${FORWARD_MAX_RETRIES + 1} attempts: ${String(lastErr)}`,
  );
  return { status: 502, body: { error: 'Failed to reach OpenClaw' } };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleSlackEventProxy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SlackEventProxyDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // 1. Read raw body (preserve bytes for signature verification + forwarding)
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch {
    sendJson(res, 400, { error: 'Failed to read request body' });
    return;
  }

  // 2. Verify Slack request signature and resolve accountId
  const cfg = deps.getConfig();
  const slackSignature = (req.headers['x-slack-signature'] as string) ?? '';
  const slackTimestamp = (req.headers['x-slack-request-timestamp'] as string) ?? '';

  const secrets = collectSigningSecrets(cfg);
  if (secrets.length === 0) {
    deps.logger.warn('SlackEventProxy: no signing secret configured — rejecting request');
    sendJson(res, 500, { error: 'Slack signing secret not configured' });
    return;
  }

  const verified = verifyAndResolveAccount(cfg, slackTimestamp, rawBody, slackSignature);
  if (!verified) {
    deps.logger.warn('SlackEventProxy: invalid Slack signature — rejecting request');
    sendJson(res, 401, { error: 'Invalid Slack signature' });
    return;
  }

  const resolvedAccountId = verified.accountId;

  // 3. Parse JSON payload
  let payload: SlackEventsApiPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8')) as SlackEventsApiPayload;
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  // 4. Handle Slack URL verification challenge
  if (payload.type === 'url_verification') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ challenge: payload.challenge }));
    return;
  }

  const originalHeaders: Record<string, string> = {
    'content-type': (req.headers['content-type'] as string) ?? 'application/json',
    'x-slack-signature': slackSignature,
    'x-slack-request-timestamp': slackTimestamp,
  };

  // Resolve the OpenClaw webhook URL for this account (may differ per account's webhookPath)
  const openclawUrl = resolveOpenClawWebhookUrl(cfg, resolvedAccountId);

  // 5. Only route event_callback payloads; forward everything else to OpenClaw
  if (payload.type !== 'event_callback') {
    void forwardToOpenClaw(rawBody, originalHeaders, openclawUrl, deps.logger);
    sendJson(res, 200, { ok: true, forwarded: true });
    return;
  }

  // 6. Skip bot messages to prevent reply loops
  if (payload.event?.bot_id || payload.event?.subtype === 'bot_message') {
    // Still forward to OpenClaw — it may have bot-message handling
    void forwardToOpenClaw(rawBody, originalHeaders, openclawUrl, deps.logger);
    sendJson(res, 200, { ok: true, skipped: 'bot_message' });
    return;
  }

  // 7. Routing decision for message/mention events
  const eventType = payload.event?.type;
  const isMessage = eventType === 'message' || eventType === 'app_mention';

  if (isMessage && payload.event?.channel) {
    // Check if any ClawTalk Talk owns this channel
    const minimalEvent = {
      eventId: buildEventIdFromSlack(payload, resolvedAccountId),
      channelId: payload.event.channel,
      accountId: resolvedAccountId,
      text: payload.event.text ?? '',
    };

    const ownership = inspectSlackOwnership(minimalEvent, deps.store, deps.logger);

    if (ownership.decision === 'handled' && ownership.talkId) {
      // ── ClawTalk owns this message ──
      deps.logger.info(
        `SlackEventProxy: routing to ClawTalk talk=${ownership.talkId} ` +
        `channel=${payload.event.channel} event_id=${payload.event_id}`,
      );

      // Ack to Slack immediately (must respond within 3 seconds)
      sendJson(res, 200, { ok: true, routed: 'clawtalk', talkId: ownership.talkId });

      // Feed into the existing ingress pipeline (async, non-blocking)
      const ingressBody = slackPayloadToIngressBody(payload, resolvedAccountId);
      if (ingressBody) {
        const parsed = parseSlackIngressEvent(ingressBody);
        if (parsed) {
          try {
            const ingressDeps = deps.buildIngressDeps();
            routeSlackIngressEvent(parsed, ingressDeps);
          } catch (err) {
            deps.logger.warn(
              `SlackEventProxy: ingress routing error for event_id=${payload.event_id}: ${String(err)}`,
            );
          }
        }
      }
      return;
    }
  }

  // ── Not ClawTalk-owned or not a message event → forward to OpenClaw ──
  deps.logger.debug(
    `SlackEventProxy: forwarding to OpenClaw event_type=${eventType ?? 'unknown'} ` +
    `channel=${payload.event?.channel ?? '-'} event_id=${payload.event_id ?? '-'}`,
  );

  // Fire-and-forget forward; ack Slack immediately
  void forwardToOpenClaw(rawBody, originalHeaders, openclawUrl, deps.logger);
  sendJson(res, 200, { ok: true, routed: 'openclaw' });
}
