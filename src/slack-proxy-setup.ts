/**
 * Slack Event Proxy — Setup detection and guided onboarding.
 *
 * Checks whether the Slack Event Proxy is fully configured and provides
 * clear, actionable instructions when setup steps are missing.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TalkStore } from './talk-store.js';
import type { Logger, PlatformBinding } from './types.js';
import { collectSigningSecrets, resolveOpenClawWebhookUrl } from './slack-event-proxy.js';

// ---------------------------------------------------------------------------
// Setup status types
// ---------------------------------------------------------------------------

export type SlackProxySetupStatus = {
  ready: boolean;
  slackBindingsDetected: boolean;
  signingSecretConfigured: boolean;
  openclawWebhookUrl: string;
  gatewayProxyUrl: string;
  /** Steps the user still needs to complete. Empty when fully configured. */
  pendingSteps: SlackProxySetupStep[];
};

export type SlackProxySetupStep = {
  id: string;
  title: string;
  instructions: string;
  url?: string;
};

// ---------------------------------------------------------------------------
// Detect Slack bindings in Talks
// ---------------------------------------------------------------------------

function isWritePermission(permission: PlatformBinding['permission']): boolean {
  return permission === 'write' || permission === 'read+write';
}

function talksHaveSlackBindings(store: TalkStore): boolean {
  for (const talk of store.listTalks()) {
    for (const binding of talk.platformBindings ?? []) {
      if (binding.platform.trim().toLowerCase() === 'slack' && isWritePermission(binding.permission)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Resolve Gateway proxy URL from config/env
// ---------------------------------------------------------------------------

function resolveGatewayProxyUrl(cfg: Record<string, unknown>): string {
  // If there's an explicit external URL configured, use that
  const envUrl = process.env.CLAWTALK_SLACK_PROXY_URL?.trim();
  if (envUrl) return envUrl;

  const gw = cfg.gateway && typeof cfg.gateway === 'object'
    ? cfg.gateway as Record<string, unknown> : null;
  const gwSlack = gw?.slack && typeof gw.slack === 'object'
    ? gw.slack as Record<string, unknown> : null;
  const cfgUrl = gwSlack?.proxyUrl;
  if (typeof cfgUrl === 'string' && cfgUrl.trim()) return cfgUrl.trim();

  // Default: local address
  const gwHttp = gw?.http && typeof gw.http === 'object'
    ? gw.http as Record<string, unknown> : null;
  const port = typeof gwHttp?.port === 'number' ? gwHttp.port : 18789;
  return `http://127.0.0.1:${port}/slack/events`;
}

// ---------------------------------------------------------------------------
// Main setup check
// ---------------------------------------------------------------------------

export function checkSlackProxySetup(
  store: TalkStore,
  cfg: Record<string, unknown>,
): SlackProxySetupStatus {
  const hasSlackBindings = talksHaveSlackBindings(store);
  const signingSecrets = collectSigningSecrets(cfg);
  const signingSecretConfigured = signingSecrets.length > 0;
  const openclawWebhookUrl = resolveOpenClawWebhookUrl(cfg);
  const gatewayProxyUrl = resolveGatewayProxyUrl(cfg);

  const pendingSteps: SlackProxySetupStep[] = [];

  if (hasSlackBindings) {
    if (!signingSecretConfigured) {
      pendingSteps.push({
        id: 'signing_secret',
        title: 'Set your Slack Signing Secret',
        instructions: [
          '1. Go to https://api.slack.com/apps and select your app',
          '2. Click "Basic Information" in the sidebar',
          '3. Scroll to "App Credentials" and copy the "Signing Secret"',
          '4. Set it as an environment variable:',
          '',
          '   export SLACK_SIGNING_SECRET=<your-signing-secret>',
          '',
          '   Or add to openclaw.json:',
          '   { "channels": { "slack": { "signingSecret": "<your-signing-secret>" } } }',
        ].join('\n'),
        url: 'https://api.slack.com/apps',
      });
    }

    pendingSteps.push({
      id: 'request_url',
      title: 'Update your Slack app Request URL',
      instructions: [
        '1. Go to https://api.slack.com/apps and select your app',
        '2. Click "Event Subscriptions" in the sidebar',
        '3. Enable Events if not already enabled',
        `4. Set the Request URL to your Gateway's external address:`,
        '',
        `   ${gatewayProxyUrl}`,
        '',
        '   If running locally, use ngrok or a similar tunnel:',
        '   ngrok http 18789',
        '   Then use the ngrok URL + /slack/events as the Request URL.',
        '',
        '5. Slack will send a verification challenge — Gateway handles this automatically.',
        '6. Click "Save Changes"',
      ].join('\n'),
      url: 'https://api.slack.com/apps',
    });

    pendingSteps.push({
      id: 'restart_openclaw',
      title: 'Restart OpenClaw',
      instructions: [
        'OpenClaw does not hot-reload Slack connection settings.',
        'After completing the steps above, restart OpenClaw so it picks up',
        'the new HTTP mode and signing secret from openclaw.json.',
      ].join('\n'),
    });
  }

  return {
    ready: hasSlackBindings && signingSecretConfigured && pendingSteps.every(s => s.id === 'request_url' || s.id === 'restart_openclaw'),
    slackBindingsDetected: hasSlackBindings,
    signingSecretConfigured,
    openclawWebhookUrl,
    gatewayProxyUrl,
    pendingSteps,
  };
}

// ---------------------------------------------------------------------------
// Startup log — prints setup status and instructions to the console
// ---------------------------------------------------------------------------

const DIVIDER = '─'.repeat(68);

export function logSlackProxySetupStatus(
  store: TalkStore,
  cfg: Record<string, unknown>,
  logger: Logger,
): SlackProxySetupStatus {
  const status = checkSlackProxySetup(store, cfg);

  if (!status.slackBindingsDetected) {
    logger.debug('ClawTalk: no Slack bindings detected — Slack event proxy not needed');
    return status;
  }

  if (status.pendingSteps.length === 0) {
    logger.info('ClawTalk: Slack event proxy is fully configured ✓');
    return status;
  }

  // Count only the steps that are truly pending (request_url and restart_openclaw are informational)
  const infoStepIds = new Set(['request_url', 'restart_openclaw']);
  const blockers = status.pendingSteps.filter(s => !infoStepIds.has(s.id));
  if (blockers.length === 0 && status.signingSecretConfigured) {
    logger.info(
      `ClawTalk: Slack event proxy ready — ensure your Slack app Request URL points to: ${status.gatewayProxyUrl}`,
    );
    return status;
  }

  logger.warn('');
  logger.warn(DIVIDER);
  logger.warn('  ClawTalk Slack Event Proxy — Setup Required');
  logger.warn(DIVIDER);
  logger.warn('');
  logger.warn(
    '  Talks with Slack bindings were detected. To route Slack messages',
  );
  logger.warn(
    '  through ClawTalk, complete the following setup steps:',
  );
  logger.warn('');

  for (let i = 0; i < status.pendingSteps.length; i++) {
    const step = status.pendingSteps[i];
    const prefix = `  Step ${i + 1}: `;
    logger.warn(`${prefix}${step.title}`);
    logger.warn('');
    for (const line of step.instructions.split('\n')) {
      logger.warn(`    ${line}`);
    }
    logger.warn('');
  }

  logger.warn(DIVIDER);
  logger.warn(
    '  Setup status: GET /api/events/slack/proxy-setup',
  );
  logger.warn(DIVIDER);
  logger.warn('');

  return status;
}

// ---------------------------------------------------------------------------
// Save signing secret to openclaw.json (used by client-side setup wizard)
// ---------------------------------------------------------------------------

function ensureObjectPath(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  const obj: Record<string, unknown> = {};
  root[key] = obj;
  return obj;
}

/**
 * Save a Slack signing secret to openclaw.json.
 *
 * If `accountId` is provided, writes to `channels.slack.accounts.{accountId}.signingSecret`.
 * Otherwise writes to the base-level `channels.slack.signingSecret` AND propagates to
 * any existing per-account configs that don't already have their own signing secret.
 * This ensures `collectSigningSecrets()` can map the correct accountId for verification.
 */
export async function saveSlackSigningSecret(
  signingSecret: string,
  logger: Logger,
  accountId?: string,
): Promise<void> {
  const configPath = path.join(process.env.HOME ?? '', '.openclaw', 'openclaw.json');
  if (!configPath || configPath === '.openclaw/openclaw.json') {
    throw new Error('Cannot resolve openclaw.json path');
  }

  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch {
    // File doesn't exist — create a minimal config
    raw = '{}';
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid openclaw.json — cannot parse');
  }

  const channels = ensureObjectPath(cfg, 'channels');
  const chSlack = ensureObjectPath(channels, 'slack');

  if (accountId && accountId !== 'default') {
    // Write to specific account path
    const accounts = ensureObjectPath(chSlack, 'accounts');
    const accObj = ensureObjectPath(accounts, accountId);
    accObj.signingSecret = signingSecret;
    logger.info(`ClawTalk: saving Slack signing secret for account "${accountId}"`);
  } else {
    // Write to base-level (fallback for all accounts)
    chSlack.signingSecret = signingSecret;

    // Also propagate to existing per-account configs that lack a signing secret,
    // so collectSigningSecrets() can map them to the correct accountId.
    const accounts = chSlack.accounts;
    if (accounts && typeof accounts === 'object') {
      for (const [accId, acc] of Object.entries(accounts as Record<string, unknown>)) {
        if (acc && typeof acc === 'object') {
          const existing = (acc as Record<string, unknown>).signingSecret;
          if (!existing || (typeof existing === 'string' && !existing.trim())) {
            (acc as Record<string, unknown>).signingSecret = signingSecret;
            logger.info(`ClawTalk: propagated signing secret to account "${accId}"`);
          }
        }
      }
    }
  }

  const next = `${JSON.stringify(cfg, null, 2)}\n`;
  if (next === raw) return;

  // Ensure directory exists
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${configPath}.tmp.${Date.now()}`;
  await fs.writeFile(tmpPath, next, 'utf-8');
  await fs.rename(tmpPath, configPath);
  logger.info('ClawTalk: saved Slack signing secret to openclaw.json');
}
