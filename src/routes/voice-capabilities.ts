/**
 * GET /api/voice/capabilities
 *
 * Returns what STT/TTS features are available on this gateway.
 */

import type { MoltbotPluginApi, PluginConfig, OutgoingResponse } from '../types.js';

const TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

export function handleVoiceCapabilities(
  api: MoltbotPluginApi,
  config: PluginConfig,
  res: OutgoingResponse,
): void {
  const voiceConfig = config.voice;
  const hasRuntime = api.runtime?.stt && api.runtime?.tts;

  const sttConfigured = !!(voiceConfig?.stt?.provider || hasRuntime);
  const ttsConfigured = !!(voiceConfig?.tts?.provider || hasRuntime);

  const capabilities = {
    stt: {
      available: sttConfigured,
      ...(sttConfigured && {
        provider: voiceConfig?.stt?.provider ?? 'openai',
        model: voiceConfig?.stt?.model ?? 'whisper-1',
        maxDurationSeconds: 120,
        maxFileSizeMB: 25,
      }),
    },
    tts: {
      available: ttsConfigured,
      ...(ttsConfigured && {
        provider: voiceConfig?.tts?.provider ?? 'openai',
        model: voiceConfig?.tts?.model ?? 'tts-1',
        voices: TTS_VOICES,
        defaultVoice: voiceConfig?.tts?.defaultVoice ?? 'nova',
      }),
    },
  };

  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify(capabilities));
}
