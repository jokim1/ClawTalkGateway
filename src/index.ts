/**
 * RemoteClaw Gateway Plugin — Moltbot Plugin
 *
 * Registers HTTP endpoints for the RemoteClaw TUI client:
 *   GET  /api/providers           — billing mode per provider
 *   GET  /api/rate-limits         — rate-limit consumption
 *   GET  /api/voice/capabilities  — discover STT/TTS availability
 *   POST /api/voice/transcribe    — audio → text (STT)
 *   POST /api/voice/synthesize    — text → audio (TTS)
 */

import type {
  MoltbotPluginApi,
  PluginConfig,
  IncomingRequest,
  OutgoingResponse,
} from './types.js';
import { handleProviders } from './routes/providers.js';
import { handleRateLimits, RateLimitCache } from './routes/rate-limits.js';
import { handleVoiceCapabilities } from './routes/voice-capabilities.js';
import { handleVoiceTranscribe } from './routes/voice-transcribe.js';
import { handleVoiceSynthesize } from './routes/voice-synthesize.js';

export const id = 'remoteclaw-gateway';
export const name = 'RemoteClaw Gateway';

export function register(api: MoltbotPluginApi) {
  const logger = api.logger;
  const pluginConfig = (api.config.plugins?.['remoteclaw-gateway'] ?? {}) as PluginConfig;

  logger.info('RemoteClaw gateway plugin loading...');

  const rateLimitCache = new RateLimitCache();

  // --- Provider billing ---
  api.registerRoute('GET', '/api/providers', (req: IncomingRequest, res: OutgoingResponse) => {
    handleProviders(pluginConfig, res);
  });

  // --- Rate limits ---
  api.registerRoute('GET', '/api/rate-limits', (req: IncomingRequest, res: OutgoingResponse) => {
    const provider = req.query?.provider;
    handleRateLimits(rateLimitCache, provider, res);
  });

  // --- Voice capabilities ---
  api.registerRoute('GET', '/api/voice/capabilities', (req: IncomingRequest, res: OutgoingResponse) => {
    handleVoiceCapabilities(api, pluginConfig, res);
  });

  // --- Voice transcribe (STT) ---
  api.registerRoute('POST', '/api/voice/transcribe', async (req: IncomingRequest, res: OutgoingResponse) => {
    await handleVoiceTranscribe(api, pluginConfig, req, res, logger);
  });

  // --- Voice synthesize (TTS) ---
  api.registerRoute('POST', '/api/voice/synthesize', async (req: IncomingRequest, res: OutgoingResponse) => {
    await handleVoiceSynthesize(api, pluginConfig, req, res, logger);
  });

  logger.info('RemoteClaw gateway plugin registered (providers, rate-limits, voice)');
}

export default register;
