/**
 * POST /api/voice/transcribe
 *
 * Accepts multipart/form-data with a WAV audio file,
 * forwards to the configured STT provider (via moltbot runtime),
 * returns transcribed text.
 */

import Busboy from 'busboy';
import type {
  MoltbotPluginApi,
  PluginConfig,
  IncomingRequest,
  OutgoingResponse,
  Logger,
} from '../types.js';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

export async function handleVoiceTranscribe(
  api: MoltbotPluginApi,
  config: PluginConfig,
  req: IncomingRequest,
  res: OutgoingResponse,
  logger: Logger,
): Promise<void> {
  const voiceConfig = config.voice;
  const hasRuntime = api.runtime?.stt;

  if (!voiceConfig?.stt?.provider && !hasRuntime) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'No STT provider configured' }));
    return;
  }

  // Parse multipart form data
  let parsed: { audioBuffer: Buffer; language: string };

  try {
    const contentType = (req.headers['content-type'] as string) ?? '';

    if (!contentType.includes('multipart/form-data')) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
      return;
    }

    parsed = await new Promise<{ audioBuffer: Buffer; language: string }>((resolve, reject) => {
      const busboy = Busboy({
        headers: { 'content-type': contentType },
        limits: { fileSize: MAX_FILE_SIZE, files: 1 },
      });

      const chunks: Buffer[] = [];
      let lang = 'en';

      busboy.on('file', (_fieldname: string, stream: NodeJS.ReadableStream) => {
        stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
      });

      busboy.on('field', (fieldname: string, value: string) => {
        if (fieldname === 'language') lang = value;
      });

      busboy.on('finish', () => {
        resolve({ audioBuffer: Buffer.concat(chunks), language: lang });
      });
      busboy.on('error', (err: Error) => reject(err));

      req.pipe(busboy);
    });
  } catch (err) {
    logger.error('Failed to parse multipart data', err);
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Failed to parse audio upload' }));
    return;
  }

  const { audioBuffer, language } = parsed;

  if (!audioBuffer || audioBuffer.length < 100) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'No audio data received' }));
    return;
  }

  if (audioBuffer.length > MAX_FILE_SIZE) {
    res.statusCode = 413;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Audio file too large (max 25MB)' }));
    return;
  }

  // Transcribe via moltbot runtime
  try {
    const result = await api.runtime.stt.transcribe({
      audioBuffer,
      language,
      model: voiceConfig?.stt?.model,
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      text: result.text,
      language: result.language ?? language,
      duration: result.duration,
    }));
  } catch (err) {
    logger.error('STT transcription failed', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : 'Transcription failed',
    }));
  }
}
