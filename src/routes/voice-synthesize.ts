/**
 * POST /api/voice/synthesize
 *
 * Accepts JSON { text, voice?, speed? },
 * forwards to the configured TTS provider (via moltbot runtime),
 * returns binary MP3 audio.
 */

import type {
  MoltbotPluginApi,
  PluginConfig,
  IncomingRequest,
  OutgoingResponse,
  Logger,
} from '../types.js';

const MAX_TEXT_LENGTH = 4096;

export async function handleVoiceSynthesize(
  api: MoltbotPluginApi,
  config: PluginConfig,
  req: IncomingRequest,
  res: OutgoingResponse,
  logger: Logger,
): Promise<void> {
  const voiceConfig = config.voice;
  const hasRuntime = api.runtime?.tts;

  if (!voiceConfig?.tts?.provider && !hasRuntime) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'No TTS provider configured' }));
    return;
  }

  // Parse JSON body
  let body: { text?: string; voice?: string; speed?: number };

  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });

    body = JSON.parse(raw);
  } catch {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  if (!body.text || !body.text.trim()) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing or empty text' }));
    return;
  }

  if (body.text.length > MAX_TEXT_LENGTH) {
    res.statusCode = 413;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Text too long (max ${MAX_TEXT_LENGTH} chars)` }));
    return;
  }

  const voice = body.voice ?? voiceConfig?.tts?.defaultVoice ?? 'nova';
  const model = voiceConfig?.tts?.model ?? 'tts-1';

  // Synthesize via moltbot runtime
  try {
    const result = await api.runtime.tts.textToSpeech({
      text: body.text,
      voice,
      model,
      speed: body.speed,
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', result.audioBuffer.length);
    res.end(result.audioBuffer);
  } catch (err) {
    logger.error('TTS synthesis failed', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : 'Synthesis failed',
    }));
  }
}
