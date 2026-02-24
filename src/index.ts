import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginApi, ClawTalkPluginConfig } from './types.js';
import { sendJson, readJsonBody, handleCors } from './http.js';
import { authorize, resolveGatewayToken, safeEqual } from './auth.js';
import { handleProviders } from './providers.js';
import { handleRateLimits, warmUsageLoader } from './rate-limits.js';
import {
  handleVoiceCapabilities,
  handleVoiceTranscribe,
  handleVoiceSynthesize,
  handleSTTProviderSwitch,
  handleTTSProviderSwitch,
  resolveVoiceAvailability,
} from './voice.js';
import { handleVoiceStreamUpgrade } from './voice-stream.js';
import {
  handleRealtimeVoiceCapabilities,
  handleRealtimeVoiceStreamUpgrade,
} from './realtime-voice.js';
import { startProxy } from './proxy.js';
import { TalkStore } from './talk-store.js';
import { handleTalks } from './talks.js';
import { handleTalkChat } from './talk-chat.js';
import { startJobScheduler } from './job-scheduler.js';
import { EventDispatcher } from './event-dispatcher.js';
import { handleFileUpload } from './file-upload.js';
import { ToolRegistry } from './tool-registry.js';
import { ToolExecutor } from './tool-executor.js';
import { registerCommands } from './commands.js';
import {
  handleSlackIngress,
  inspectSlackOwnership,
  getSlackIngressTalkRuntimeSnapshot,
  handleSlackMessageReceivedHook,
} from './slack-ingress.js';
import { normalizeSlackBindingScope } from './talks.js';
import { reconcileAnthropicProxyBaseUrls, reconcileGatewayResponsesEndpoint } from './provider-baseurl-sync.js';
import { registerOpenClawNativeGoogleTools } from './openclaw-native-tools.js';
import { listSlackAccountIds, resolveSlackBotTokenForAccount } from './slack-auth.js';
import { handleSlackEventProxy } from './slack-event-proxy.js';
import { checkSlackProxySetup, logSlackProxySetupStatus, ensureSlackSocketMode } from './slack-proxy-setup.js';
import { isRateLimited } from './pair-rate-limiter.js';
import {
  type SlackDebugPath,
  type SlackDebugEntry,
  isSlackDebugEnabled,
  computeSlackInstanceTag,
  recordSlackDebug,
  querySlackDebugRing,
} from './slack-debug.js';
import {
  detectTailscaleFunnelUrl,
  resolveGatewayOrigin,
  resolveSelfOrigin,
} from './gateway-origin.js';
import { DEFAULT_GATEWAY_PORT } from './constants.js';
import {
  fetchSlackChannelsForAccount,
  collectTalkSlackChannelHints,
  createEventReplyHandler,
} from './slack-reply.js';

// ---------------------------------------------------------------------------
// Node.js 25 fetch fix — replace built-in undici connector to fix Tailscale IP
// connectivity (100.64.0.0/10 CGNAT range). Without this, fetch() to the
// gateway origin fails with ECONNREFUSED on Tailscale IPs.
// ---------------------------------------------------------------------------
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Agent, setGlobalDispatcher, buildConnector } = require('undici');
  const connector = buildConnector({});
  setGlobalDispatcher(new Agent({
    connect: (opts: Record<string, unknown>, cb: Function) => connector(opts, cb),
  }));
} catch {
  // undici not installed — fetch uses Node's built-in connector
}

const ROUTES = new Set([
  '/api/pair',
  '/api/providers',
  '/api/rate-limits',
  '/api/tools',
  '/api/voice/capabilities',
  '/api/voice/transcribe',
  '/api/voice/synthesize',
  '/api/voice/stream',
  '/api/voice/stt/provider',
  '/api/voice/tts/provider',
  '/api/realtime-voice/capabilities',
  '/api/realtime-voice/stream',
  '/api/files/upload',
  '/api/events/slack',
  '/api/events/slack/options',
  '/api/events/slack/resolve',
  '/api/events/slack/doctor',
  '/api/events/slack/status',
  '/api/debug/slack/recent',
  '/api/status/clawtalk',
  '/api/sync/stream',
  '/slack/events',
  '/api/events/slack/proxy-setup',
]);

// ============================================================================
// Pair Password
// ============================================================================

function resolvePairPassword(pluginCfg: ClawTalkPluginConfig): string | undefined {
  return pluginCfg.pairPassword ?? process.env.CLAWDBOT_PAIR_PASSWORD ?? undefined;
}

function normalizeSlackResolveScope(channelIdRaw: string): string | null {
  const channelId = channelIdRaw.trim();
  if (!channelId) return null;
  if (channelId.includes(':')) {
    return normalizeSlackBindingScope(channelId);
  }
  return normalizeSlackBindingScope(`channel:${channelId}`);
}

function resolveSlackBotTokenForDiscovery(cfg: Record<string, any>, accountId: string): string | undefined {
  return resolveSlackBotTokenForAccount(cfg, accountId);
}

function listSlackAccountOptions(cfg: Record<string, any>): Array<{
  id: string;
  isDefault: boolean;
  hasBotToken: boolean;
}> {
  const ids = new Set<string>(
    listSlackAccountIds(cfg).map((id) => id.trim().toLowerCase()).filter(Boolean),
  );
  if (ids.size === 0) {
    ids.add('default');
  }

  return Array.from(ids)
    .sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
    .map((id) => ({
      id,
      isDefault: id === 'default',
      hasBotToken: Boolean(resolveSlackBotTokenForDiscovery(cfg, id)),
    }));
}

// ============================================================================
// Plugin
// ============================================================================

const plugin = {
  id: 'clawtalk',
  name: 'ClawTalk',
  description:
    'Exposes /api/providers, /api/rate-limits, and /api/voice/* HTTP endpoints for the ClawTalk TUI client.',

  register(api: PluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as ClawTalkPluginConfig;

    api.logger.info('ClawTalk plugin loaded');

    // Start the rate-limit capture proxy
    const proxyPort = pluginCfg.proxyPort ?? 18793;
    startProxy(proxyPort, api.logger);
    // Reconcile config files sequentially (shared lock serializes openclaw.json writes).
    // This promise runs in parallel with talkStore.init() and is awaited before Slack routing.
    const configReconciled = reconcileAnthropicProxyBaseUrls(proxyPort, api.logger)
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.warn(`ClawTalk: failed to reconcile Anthropic baseUrl: ${message}`);
      })
      .then(() => reconcileGatewayResponsesEndpoint(api.logger))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.warn(`ClawTalk: failed to reconcile responses endpoint config: ${message}`);
      });

    // Eagerly warm up the usage loader in background
    warmUsageLoader(api.logger);

    // Initialize Talk store (async)
    type ReadyPhase = 'booting' | 'loading_talks' | 'ready' | 'failed';
    let readyPhase: ReadyPhase = 'booting';
    let readyError: string | undefined;
    const readySinceMs = Date.now();
    const isGatewayReady = (): boolean => readyPhase === 'ready';

    const talkStore = new TalkStore(pluginCfg.dataDir, api.logger);

    type SyncStreamEvent = {
      id: number;
      type: string;
      ts: number;
      payload: Record<string, unknown>;
    };
    const syncClients = new Set<ServerResponse>();
    const syncHistory: SyncStreamEvent[] = [];
    let syncEventId = 0;
    const SYNC_HISTORY_MAX = 500;
    const appendSyncEvent = (type: string, payload: Record<string, unknown>) => {
      const event: SyncStreamEvent = {
        id: ++syncEventId,
        type,
        ts: Date.now(),
        payload,
      };
      syncHistory.push(event);
      if (syncHistory.length > SYNC_HISTORY_MAX) {
        syncHistory.splice(0, syncHistory.length - SYNC_HISTORY_MAX);
      }
      const chunk = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ ...payload, ts: event.ts })}\n\n`;
      for (const res of syncClients) {
        try {
          res.write(chunk);
        } catch {
          syncClients.delete(res);
        }
      }
    };
    const removeSyncClient = (res: ServerResponse) => {
      syncClients.delete(res);
    };
    const unsubscribeTalkStoreChange = talkStore.onChange((evt) => {
      api.logger.info(
        `TalkStore change: type=${evt.type} talk=${evt.talkId} talkCount=${talkStore.listTalks().length} ` +
        `store=${talkStore.getInstanceId()} by=${evt.lastModifiedBy ?? 'unknown'} version=${evt.talkVersion}`,
      );
      appendSyncEvent('talk_changed', {
        talkId: evt.talkId,
        mutationType: evt.type,
        talkVersion: evt.talkVersion,
        changeId: evt.changeId,
        ...(evt.lastModifiedBy ? { lastModifiedBy: evt.lastModifiedBy } : {}),
      });
    });
    readyPhase = 'loading_talks';
    appendSyncEvent('gateway_phase', { phase: readyPhase });
    const readyBarrier = talkStore.init()
      .then(async () => {
        await configReconciled;
        // Auto-correct Slack accounts using HTTP mode to socket mode
        const proxyCfg = api.runtime.config.loadConfig();
        await ensureSlackSocketMode(proxyCfg, api.logger);
        // Check and log Slack event proxy setup status
        logSlackProxySetupStatus(talkStore, proxyCfg, api.logger);
        readyPhase = 'ready';
        appendSyncEvent('gateway_phase', { phase: readyPhase });
      })
      .catch(err => {
        readyPhase = 'failed';
        readyError = err instanceof Error ? err.message : String(err);
        appendSyncEvent('gateway_phase', { phase: readyPhase, error: readyError });
        api.logger.error(`TalkStore init failed: ${readyError}`);
      });

    // Shared Slack reply path (direct Slack API).
    const slackDebugInstanceTag = computeSlackInstanceTag();
    const emitSlackDebug = (entry: Omit<SlackDebugEntry, 'ts' | 'instanceTag'>) => {
      if (!isSlackDebugEnabled()) return;
      recordSlackDebug(entry, slackDebugInstanceTag);
    };
    const replyHandler = createEventReplyHandler(
      () => api.runtime.config.loadConfig(),
      api.logger,
      {
        debugEnabled: isSlackDebugEnabled,
        onDebug: emitSlackDebug,
      },
    );
    let slackIngressOrigin = `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;
    let slackIngressToken: string | undefined;
    const refreshSlackIngressRoute = () => {
      const cfg0 = api.runtime.config.loadConfig();
      slackIngressOrigin = resolveGatewayOrigin(cfg0, api.logger);
      slackIngressToken = resolveGatewayToken(cfg0);
    };
    const buildSlackIngressDeps = () => ({
      store: talkStore,
      registry: toolRegistry,
      executor: toolExecutor,
      dataDir: pluginCfg.dataDir,
      gatewayOrigin: slackIngressOrigin,
      authToken: slackIngressToken,
      logger: api.logger,
      debugEnabled: isSlackDebugEnabled(),
      instanceTag: slackDebugInstanceTag,
      recordSlackDebug: (entry: {
        path: 'slack-ingress';
        phase: string;
        failurePhase?: string;
        attempt?: number;
        attemptToken?: string;
        elapsedMs?: number;
        talkId?: string;
        eventId?: string;
        accountId?: string;
        channelIdRaw?: string;
        channelIdResolved?: string;
        threadTs?: string;
        errorCode?: string;
        errorMessage?: string;
      }) => emitSlackDebug(entry),
      sendSlackMessage: async (params: {
        accountId?: string;
        channelId: string;
        threadTs?: string;
        message: string;
      }) =>
        replyHandler(
          {
            platform: 'slack',
            accountId: params.accountId,
            platformChannelId: params.channelId,
            threadId: params.threadTs,
          },
          params.message,
        ),
    });
    refreshSlackIngressRoute();

    // Initialize tool registry and executor
    const toolRegistry = new ToolRegistry(pluginCfg.dataDir, api.logger);
    const toolExecutor = new ToolExecutor(toolRegistry, talkStore, api.logger);
    registerOpenClawNativeGoogleTools({
      api,
      executor: toolExecutor,
      logger: api.logger,
    });

    // Register job scheduler as a managed service
    let stopScheduler: (() => void) | null = null;
    api.registerService({
      id: 'clawtalk-job-scheduler',
      start: () => {
        void readyBarrier.then(() => {
          if (!isGatewayReady()) return;
          const cfg0 = api.runtime.config.loadConfig();
          const gatewayToken0 = resolveGatewayToken(cfg0);
          const schedulerOrigin = resolveGatewayOrigin(cfg0, api.logger);
          stopScheduler = startJobScheduler({
            store: talkStore,
            gatewayOrigin: schedulerOrigin,
            authToken: gatewayToken0,
            logger: api.logger,
            registry: toolRegistry,
            executor: toolExecutor,
            dataDir: pluginCfg.dataDir,
            jobTimeoutMs: pluginCfg.jobTimeoutMs,
            sendSlackMessage: async (params: {
              accountId?: string;
              channelId: string;
              threadTs?: string;
              message: string;
            }) =>
              replyHandler(
                {
                  platform: 'slack',
                  accountId: params.accountId,
                  platformChannelId: params.channelId,
                  threadId: params.threadTs,
                },
                params.message,
              ),
          });
        }).catch((err) => api.logger.warn(`ClawTalk: scheduler start failed: ${err}`));
      },
      stop: () => {
        if (stopScheduler) {
          stopScheduler();
          stopScheduler = null;
        }
      },
    });

    // Initialize event dispatcher for event-driven jobs
    let eventDispatcher: EventDispatcher | null = null;
    api.registerService({
      id: 'clawtalk-event-dispatcher',
      start: () => {
        void readyBarrier.then(() => {
          if (!isGatewayReady()) return;
          refreshSlackIngressRoute();
          eventDispatcher = new EventDispatcher({
            store: talkStore,
            gatewayOrigin: slackIngressOrigin,
            authToken: slackIngressToken,
            logger: api.logger,
            registry: toolRegistry,
            executor: toolExecutor,
            dataDir: pluginCfg.dataDir,
            jobTimeoutMs: pluginCfg.jobTimeoutMs,
            replyToEvent: replyHandler,
          });
          api.logger.info('ClawTalk: event dispatcher started');
        }).catch((err) => api.logger.warn(`ClawTalk: event dispatcher start failed: ${err}`));
      },
      stop: () => {
        if (eventDispatcher) {
          eventDispatcher.cleanup();
          eventDispatcher = null;
          api.logger.info('ClawTalk: event dispatcher stopped');
        }
      },
    });

    // Listen for incoming platform messages (Slack, Telegram, etc.)
    api.on('message_received', async (event: any, ctx: any) => {
      if (!isGatewayReady()) {
        return undefined;
      }
      if (eventDispatcher) {
        eventDispatcher.handleMessageReceived(event, ctx).catch(err => {
          api.logger.warn(`ClawTalk: event dispatch error: ${err}`);
        });
      }
      return handleSlackMessageReceivedHook(event, ctx, buildSlackIngressDeps()).catch(err => {
        api.logger.warn(`ClawTalk: slack ownership hook failed: ${err}`);
        return undefined;
      });
    });

    const emitOpenClawMessageDebug = (
      phase: string,
      event: any,
      ctx: any,
      extra?: Pick<SlackDebugEntry, 'errorCode' | 'errorMessage'>,
    ) => {
      if (!isSlackDebugEnabled()) return;
      const metadata = event && typeof event === 'object' && event.metadata && typeof event.metadata === 'object'
        ? (event.metadata as Record<string, unknown>)
        : undefined;
      const rawTo =
        (typeof event?.to === 'string' ? event.to : undefined) ??
        (typeof metadata?.to === 'string' ? metadata.to : undefined) ??
        (typeof ctx?.conversationId === 'string' ? ctx.conversationId : undefined);
      const rawReplyTo =
        (typeof metadata?.replyTo === 'string' ? metadata.replyTo : undefined) ??
        (typeof event?.replyTo === 'string' ? event.replyTo : undefined);
      const accountId =
        (typeof metadata?.accountId === 'string' ? metadata.accountId : undefined) ??
        (typeof ctx?.accountId === 'string' ? ctx.accountId : undefined);
      const talkId =
        (typeof metadata?.talkId === 'string' ? metadata.talkId : undefined) ??
        (typeof event?.talkId === 'string' ? event.talkId : undefined);
      const channelIdRaw = typeof rawTo === 'string' ? rawTo.trim() : undefined;
      const channelIdResolved = (() => {
        if (!channelIdRaw) return undefined;
        const trimmed = channelIdRaw.trim();
        if (trimmed.toLowerCase().startsWith('slack:')) {
          return trimmed.slice(6);
        }
        return trimmed;
      })();
      recordSlackDebug(
        {
          path: 'openclaw-message',
          phase,
          ...(talkId ? { talkId } : {}),
          ...(accountId ? { accountId } : {}),
          ...(channelIdRaw ? { channelIdRaw } : {}),
          ...(channelIdResolved ? { channelIdResolved } : {}),
          ...(rawReplyTo ? { threadTs: rawReplyTo } : {}),
          ...(extra?.errorCode ? { errorCode: extra.errorCode } : {}),
          ...(extra?.errorMessage ? { errorMessage: extra.errorMessage } : {}),
        },
        slackDebugInstanceTag,
      );
    };

    api.on('message_sending', (event: any, ctx: any) => {
      if (!isGatewayReady()) {
        return undefined;
      }
      emitOpenClawMessageDebug('send_start', event, ctx);
      return undefined;
    });

    api.on('message_sent', (event: any, ctx: any) => {
      emitOpenClawMessageDebug('send_ok', event, ctx);
      return undefined;
    });
    api.on('message_send_failed', (event: any, ctx: any) => {
      const errorText =
        (typeof event?.error === 'string' ? event.error : undefined) ??
        (typeof event?.message === 'string' ? event.message : undefined) ??
        (typeof event?.reason === 'string' ? event.reason : undefined) ??
        'send failed';
      const lower = errorText.toLowerCase();
      const errorCode =
        lower.includes('unknown channel') ? 'unknown_channel'
          : lower.includes('not_in_channel') ? 'not_in_channel'
            : lower.includes('timeout') || lower.includes('timed out') ? 'timeout'
              : lower.includes('unauthorized') || lower.includes('forbidden') ? 'auth_error'
                : 'error';
      emitOpenClawMessageDebug('send_fail', event, ctx, { errorCode, errorMessage: errorText });
      return undefined;
    });

    // Register lifecycle hooks
    api.on('gateway_start', () => {
      refreshSlackIngressRoute();
      api.logger.info('ClawTalk: gateway_start event received');
    });

    api.on('gateway_stop', () => {
      api.logger.info('ClawTalk: gateway_stop event received — cleaning up');
      unsubscribeTalkStoreChange();
      for (const client of syncClients) {
        try {
          client.end();
        } catch {
          // ignore
        }
      }
      syncClients.clear();
      if (stopScheduler) {
        stopScheduler();
        stopScheduler = null;
      }
      if (eventDispatcher) {
        eventDispatcher.cleanup();
        eventDispatcher = null;
      }
    });

    // Register plugin commands
    registerCommands(api, talkStore);

    // Log voice availability
    const { sttAvailable, ttsAvailable } = resolveVoiceAvailability(pluginCfg.voice);
    if (sttAvailable || ttsAvailable) {
      api.logger.info(`ClawTalk: voice enabled (STT: ${sttAvailable}, TTS: ${ttsAvailable})`);
    }

    api.registerHttpHandler(
      async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        const url = new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? 'localhost'}`,
        );

        const isTalkRoute = url.pathname === '/api/talks' || url.pathname.startsWith('/api/talks/');
        const isToolRoute = url.pathname === '/api/tools' || url.pathname.startsWith('/api/tools/');
        if (!ROUTES.has(url.pathname) && !isTalkRoute && !isToolRoute) return false;
        if (handleCors(req, res)) return true;

        // =================================================================
        // POST /api/pair — unauthenticated pairing endpoint
        // =================================================================
        if (url.pathname === '/api/pair') {
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('Allow', 'POST, OPTIONS');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Method Not Allowed');
            return true;
          }

          const pairPassword = resolvePairPassword(pluginCfg);
          if (!pairPassword) {
            sendJson(res, 404, { error: 'Pairing not configured' });
            return true;
          }

          const clientIP = req.socket?.remoteAddress ?? 'unknown';
          if (isRateLimited(clientIP)) {
            sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
            return true;
          }

          let body: { password?: string };
          try {
            body = await readJsonBody(req) as { password?: string };
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON body' });
            return true;
          }

          if (!body.password || typeof body.password !== 'string') {
            sendJson(res, 400, { error: 'Missing password' });
            return true;
          }

          if (!safeEqual(body.password, pairPassword)) {
            sendJson(res, 403, { error: 'Invalid password' });
            return true;
          }

          const pairCfg = api.runtime.config.loadConfig();
          const gatewayToken = resolveGatewayToken(pairCfg);

          let gatewayURL: string;
          let port: number;
          const resolvedUrl = pluginCfg.externalUrl ?? detectTailscaleFunnelUrl(api.logger);
          if (resolvedUrl) {
            gatewayURL = resolvedUrl;
            try {
              const parsed = new URL(resolvedUrl);
              port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
            } catch {
              port = DEFAULT_GATEWAY_PORT;
            }
          } else {
            const host = req.headers.host ?? `localhost:${DEFAULT_GATEWAY_PORT}`;
            const hostPort = host.includes(':') ? parseInt(host.split(':').pop()!, 10) : 80;
            port = hostPort;
            gatewayURL = `http://${host}`;
          }

          sendJson(res, 200, {
            name: pluginCfg.name ?? 'Gateway',
            gatewayURL,
            port,
            authToken: gatewayToken ?? '',
            agentID: 'mobileclaw',
          });
          return true;
        }

        // =================================================================
        // GET /api/tools/google/oauth/callback — unauthenticated OAuth callback
        // =================================================================
        if (url.pathname === '/api/tools/google/oauth/callback') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'Method not allowed' });
            return true;
          }
          const { handleGoogleOAuthCallback } = await import('./talks.js');
          const cfg = api.runtime.config.loadConfig();
          const ctx = { req, res, url, cfg, pluginCfg, logger: api.logger };
          await handleGoogleOAuthCallback(ctx);
          return true;
        }

        // Auth (all other routes require authorization)
        const cfg = api.runtime.config.loadConfig();
        if (!authorize(req, cfg)) {
          sendJson(res, 401, {
            error: { message: 'Unauthorized', type: 'unauthorized' },
          });
          return true;
        }

        // WebSocket upgrade for voice streaming — handled separately
        if (url.pathname === '/api/voice/stream') {
          const gatewayOrigin = resolveSelfOrigin(req);
          const gatewayToken = resolveGatewayToken(cfg);
          handleVoiceStreamUpgrade(
            req, res, api.logger,
            pluginCfg.voice, gatewayOrigin, gatewayToken,
          );
          return true;
        }

        // WebSocket upgrade for realtime voice streaming
        if (url.pathname === '/api/realtime-voice/stream') {
          handleRealtimeVoiceStreamUpgrade(
            req, res, api.logger,
            pluginCfg.realtimeVoice,
          );
          return true;
        }

        const ctx = { req, res, url, cfg, pluginCfg, logger: api.logger };
        const readinessGated =
          isTalkRoute
          || url.pathname === '/api/events/slack'
          || url.pathname === '/api/events/slack/resolve'
          || url.pathname === '/api/events/slack/doctor'
          || url.pathname === '/api/events/slack/status'
          || url.pathname === '/slack/events';
        if (readinessGated && !isGatewayReady()) {
          const retryAfterSec = 2;
          res.setHeader('Retry-After', String(retryAfterSec));
          sendJson(res, 503, {
            error: 'Gateway is initializing. Retry shortly.',
            code: 'CLAWTALK_NOT_READY',
            phase: readyPhase,
            retryAfterMs: retryAfterSec * 1000,
            sinceMs: readySinceMs,
            ...(readyError ? { details: readyError } : {}),
          });
          return true;
        }

        // Talk routes (dynamic path segments)
        if (isTalkRoute) {
          // POST /api/talks/:id/chat
          const chatMatch = url.pathname.match(/^\/api\/talks\/([\w-]+)\/chat$/);
          if (chatMatch) {
            const gatewayOrigin = resolveSelfOrigin(req);
            const gatewayToken = resolveGatewayToken(cfg);
            await handleTalkChat({
              req, res,
              talkId: chatMatch[1],
              store: talkStore,
              gatewayOrigin,
              authToken: gatewayToken,
              logger: api.logger,
              registry: toolRegistry,
              executor: toolExecutor,
              dataDir: pluginCfg.dataDir,
              getConfig: () => api.runtime.config.loadConfig(),
            });
            return true;
          }
          // All other /api/talks/* CRUD routes
          await handleTalks(ctx, talkStore, toolRegistry);
          return true;
        }

        // /api/tools routes (also match /api/tools/:name)
        if (isToolRoute) {
          const { handleToolRoutes } = await import('./talks.js');
          await handleToolRoutes(ctx, toolRegistry);
          return true;
        }

        switch (url.pathname) {
          case '/api/status/clawtalk': {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'Method not allowed' });
              break;
            }
            sendJson(res, 200, {
              ready: isGatewayReady(),
              phase: readyPhase,
              sinceMs: readySinceMs,
              talkCount: talkStore.listTalks().length,
              sync: {
                connectedClients: syncClients.size,
                lastEventId: syncEventId,
              },
              ...(readyError ? { error: readyError } : {}),
            });
            break;
          }
          case '/api/sync/stream': {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'Method not allowed' });
              break;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.flushHeaders?.();

            const lastEventIdRaw = req.headers['last-event-id'];
            const lastEventIdText = Array.isArray(lastEventIdRaw) ? lastEventIdRaw[0] : lastEventIdRaw;
            const lastEventId = typeof lastEventIdText === 'string' ? Number.parseInt(lastEventIdText, 10) : NaN;
            const replayFromId = Number.isFinite(lastEventId) ? Math.max(0, lastEventId) : 0;
            const backlog = replayFromId > 0
              ? syncHistory.filter((entry) => entry.id > replayFromId)
              : [];
            for (const entry of backlog) {
              res.write(
                `id: ${entry.id}\nevent: ${entry.type}\ndata: ${JSON.stringify({ ...entry.payload, ts: entry.ts })}\n\n`,
              );
            }
            res.write(
              `id: ${syncEventId}\nevent: sync_ready\ndata: ${JSON.stringify({
                ready: isGatewayReady(),
                phase: readyPhase,
                talkCount: talkStore.listTalks().length,
                ts: Date.now(),
              })}\n\n`,
            );
            syncClients.add(res);
            const heartbeat = setInterval(() => {
              try {
                res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
              } catch {
                removeSyncClient(res);
              }
            }, 15000);
            heartbeat.unref?.();
            req.on('close', () => {
              clearInterval(heartbeat);
              removeSyncClient(res);
            });
            req.on('aborted', () => {
              clearInterval(heartbeat);
              removeSyncClient(res);
            });
            return true;
          }
          case '/api/events/slack/options': {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'Method not allowed' });
              break;
            }

            const requestedAccount = (url.searchParams.get('accountId')?.trim().toLowerCase() || undefined);
            const requestedLimit = parseInt(url.searchParams.get('limit') ?? '200', 10);
            const limit = Number.isFinite(requestedLimit) ? Math.min(1000, Math.max(1, requestedLimit)) : 200;

            const accounts = listSlackAccountOptions(cfg);
            const selectedAccountId = requestedAccount
              ?? accounts.find((account) => account.hasBotToken)?.id
              ?? accounts[0]?.id
              ?? 'default';

            const baseHints = collectTalkSlackChannelHints({
              talkStore,
              accountId: selectedAccountId,
              limit,
            });
            const merged = new Map(baseHints.map((entry) => [entry.id, entry]));
            let channelsSource: 'slack-api' | 'talk-bindings' | 'none' =
              baseHints.length > 0 ? 'talk-bindings' : 'none';

            const token = resolveSlackBotTokenForDiscovery(cfg, selectedAccountId);
            if (token) {
              const apiChannels = await fetchSlackChannelsForAccount({ token, limit });
              if (apiChannels.length > 0) {
                channelsSource = 'slack-api';
                for (const channel of apiChannels) {
                  merged.set(channel.id, channel);
                }
              }
            }

            sendJson(res, 200, {
              accounts,
              selectedAccountId,
              channels: Array.from(merged.values()).slice(0, limit),
              channelsSource,
            });
            break;
          }
          case '/api/events/slack/resolve': {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'Method not allowed' });
              break;
            }
            const channelIdInput = url.searchParams.get('channelId')?.trim() ?? '';
            if (!channelIdInput) {
              sendJson(res, 400, { error: 'Missing query param: channelId' });
              break;
            }
            const canonicalScope = normalizeSlackResolveScope(channelIdInput);
            if (!canonicalScope) {
              sendJson(res, 400, {
                error: 'Invalid channelId. Use C123..., channel:C123..., or user:U123...',
              });
              break;
            }

            const accountId = (url.searchParams.get('accountId')?.trim().toLowerCase() || undefined);
            const scopeTarget = canonicalScope.includes(':')
              ? canonicalScope.slice(canonicalScope.indexOf(':') + 1)
              : channelIdInput;
            const ownership = inspectSlackOwnership(
              {
                eventId: `resolve:${Date.now()}`,
                accountId,
                channelId: scopeTarget,
                channelName: url.searchParams.get('channelName')?.trim() || undefined,
                outboundTarget: url.searchParams.get('outboundTarget')?.trim() || undefined,
                text: '',
              },
              talkStore,
              api.logger,
            );
            sendJson(res, 200, {
              accountId: accountId ?? 'default',
              channelId: scopeTarget,
              canonicalScope,
              ownership,
              openClawConflicts: [],
            });
            break;
          }
          case '/api/events/slack/doctor': {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'Method not allowed' });
              break;
            }
            sendJson(res, 200, {
              ok: true,
              conflictCount: 0,
              conflicts: [],
            });
            break;
          }
          case '/api/events/slack/status': {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'Method not allowed' });
              break;
            }
            const talkId = url.searchParams.get('talkId')?.trim();
            if (talkId) {
              sendJson(res, 200, getSlackIngressTalkRuntimeSnapshot(talkId));
              break;
            }
            const talks = talkStore.listTalks();
            sendJson(res, 200, {
              talks: talks.map((talk) => getSlackIngressTalkRuntimeSnapshot(talk.id)),
            });
            break;
          }
          case '/api/debug/slack/recent': {
            if (req.method !== 'GET') {
              sendJson(res, 405, { error: 'Method not allowed' });
              break;
            }
            const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
            const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;
            const talkIdFilter = url.searchParams.get('talkId')?.trim();
            const pathFilter = url.searchParams.get('path')?.trim() as SlackDebugPath | undefined;
            const validPath = pathFilter === 'slack-ingress' || pathFilter === 'event-reply' || pathFilter === 'openclaw-message'
              ? pathFilter
              : undefined;
            const entries = querySlackDebugRing(
              { talkId: talkIdFilter, path: validPath },
              limit,
            );
            sendJson(res, 200, {
              debugEnabled: isSlackDebugEnabled(),
              instanceTag: slackDebugInstanceTag,
              count: entries.length,
              entries,
            });
            break;
          }
          case '/api/events/slack/proxy-setup': {
            if (req.method === 'GET') {
              const setupCfg = api.runtime.config.loadConfig();
              const setupStatus = checkSlackProxySetup(talkStore, setupCfg);
              sendJson(res, 200, setupStatus);
              break;
            }
            if (req.method === 'POST') {
              // Save signing secret from client-side setup wizard
              const body = await readJsonBody(req) as Record<string, unknown>;
              const signingSecret = typeof body.signingSecret === 'string' ? body.signingSecret.trim() : '';
              if (!signingSecret) {
                sendJson(res, 400, { error: 'signingSecret is required' });
                break;
              }
              try {
                const { saveSlackSigningSecret } = await import('./slack-proxy-setup.js');
                await saveSlackSigningSecret(signingSecret, api.logger);
                const updatedCfg = api.runtime.config.loadConfig();
                const updatedStatus = checkSlackProxySetup(talkStore, updatedCfg);
                sendJson(res, 200, { ok: true, status: updatedStatus });
              } catch (err) {
                api.logger.warn(`proxy-setup POST failed: ${String(err)}`);
                sendJson(res, 500, { error: 'Failed to save signing secret' });
              }
              break;
            }
            sendJson(res, 405, { error: 'Method not allowed' });
            break;
          }
          case '/api/events/slack': {
            const gatewayOrigin = resolveSelfOrigin(req);
            const gatewayToken = resolveGatewayToken(cfg);
            await handleSlackIngress(ctx, {
              ...buildSlackIngressDeps(),
              gatewayOrigin,
              authToken: gatewayToken,
            });
            break;
          }
          case '/api/files/upload':
            await handleFileUpload(ctx, pluginCfg.uploadDir);
            break;
          case '/api/providers':
            await handleProviders(ctx);
            break;
          case '/api/rate-limits':
            await handleRateLimits(ctx);
            break;
          case '/api/voice/capabilities':
            await handleVoiceCapabilities(ctx);
            break;
          case '/api/voice/transcribe':
            await handleVoiceTranscribe(ctx);
            break;
          case '/api/voice/synthesize':
            await handleVoiceSynthesize(ctx);
            break;
          case '/api/voice/stt/provider':
            await handleSTTProviderSwitch(ctx);
            break;
          case '/api/voice/tts/provider':
            await handleTTSProviderSwitch(ctx);
            break;
          case '/api/realtime-voice/capabilities':
            await handleRealtimeVoiceCapabilities(ctx);
            break;
          case '/slack/events': {
            const gatewayOrigin = resolveSelfOrigin(req);
            const gatewayToken = resolveGatewayToken(cfg);
            await handleSlackEventProxy(req, res, {
              store: talkStore,
              logger: api.logger,
              getConfig: () => api.runtime.config.loadConfig(),
              buildIngressDeps: () => ({
                ...buildSlackIngressDeps(),
                gatewayOrigin,
                authToken: gatewayToken,
              }),
            });
            break;
          }
        }

        return true;
      },
    );
  },
};

export default plugin;
