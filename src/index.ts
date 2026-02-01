import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginApi, RemoteClawPluginConfig } from './types.js';
import { sendJson, handleCors } from './http.js';
import { authorize } from './auth.js';
import { handleProviders } from './providers.js';
import { handleRateLimits, warmUsageLoader } from './rate-limits.js';
import {
  handleVoiceCapabilities,
  handleVoiceTranscribe,
  handleVoiceSynthesize,
  resolveVoiceAvailability,
} from './voice.js';
import { startProxy } from './proxy.js';

const ROUTES = new Set([
  '/api/providers',
  '/api/rate-limits',
  '/api/voice/capabilities',
  '/api/voice/transcribe',
  '/api/voice/synthesize',
]);

const plugin = {
  id: 'remoteclaw',
  name: 'RemoteClaw',
  description:
    'Exposes /api/providers, /api/rate-limits, and /api/voice/* HTTP endpoints for the RemoteClaw TUI client.',

  register(api: PluginApi) {
    const pluginCfg = (api.pluginConfig ?? {}) as RemoteClawPluginConfig;

    api.logger.info('RemoteClaw plugin loaded');

    // Start the rate-limit capture proxy
    startProxy(pluginCfg.proxyPort ?? 18793, api.logger);

    // Eagerly warm up the usage loader in background
    warmUsageLoader(api.logger);

    // Log voice availability
    const { sttAvailable, ttsAvailable } = resolveVoiceAvailability(pluginCfg.voice);
    if (sttAvailable || ttsAvailable) {
      api.logger.info(`RemoteClaw: voice enabled (STT: ${sttAvailable}, TTS: ${ttsAvailable})`);
    }

    api.registerHttpHandler(
      async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
        const url = new URL(
          req.url ?? '/',
          `http://${req.headers.host ?? 'localhost'}`,
        );

        if (!ROUTES.has(url.pathname)) return false;
        if (handleCors(req, res)) return true;

        const cfg = api.runtime.config.loadConfig();
        if (!authorize(req, cfg)) {
          sendJson(res, 401, {
            error: { message: 'Unauthorized', type: 'unauthorized' },
          });
          return true;
        }

        const ctx = { req, res, url, cfg, pluginCfg, logger: api.logger };

        switch (url.pathname) {
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
        }

        return true;
      },
    );
  },
};

export default plugin;
