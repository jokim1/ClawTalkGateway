import type { IncomingMessage } from 'node:http';
import Busboy from 'busboy';

import type { HandlerContext, VoicePluginConfig } from './types.js';
import { sendJson, readJsonBody } from './http.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const MAX_TEXT_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Multipart parser
// ---------------------------------------------------------------------------

function parseMultipart(
  req: IncomingMessage,
  contentType: string,
): Promise<{ audioBuffer: Buffer; language: string }> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    });

    const chunks: Buffer[] = [];
    let lang = 'en';

    busboy.on('file', (_fieldname: string, stream: NodeJS.ReadableStream) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
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
}

// ---------------------------------------------------------------------------
// OpenAI STT / TTS
// ---------------------------------------------------------------------------

async function transcribeViaOpenAI(
  audioBuffer: Buffer,
  language: string,
  model: string,
): Promise<{ text: string; language?: string; duration?: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const blob = new Blob([audioBuffer], { type: 'audio/wav' });
  const formData = new FormData();
  formData.append('file', blob, 'recording.wav');
  formData.append('model', model);
  formData.append('language', language);
  formData.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI STT error (${response.status}): ${body.slice(0, 200)}`);
  }

  return await response.json() as { text: string; language?: string; duration?: number };
}

async function synthesizeViaOpenAI(
  text: string,
  voice: string,
  model: string,
  speed?: number,
): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const body: Record<string, unknown> = {
    model,
    input: text,
    voice,
    response_format: 'mp3',
  };
  if (speed !== undefined) body.speed = speed;

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`OpenAI TTS error (${response.status}): ${errBody.slice(0, 200)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------------------------------------------------------------------------
// Voice availability helper
// ---------------------------------------------------------------------------

export function resolveVoiceAvailability(voiceCfg: VoicePluginConfig | undefined): {
  sttAvailable: boolean;
  ttsAvailable: boolean;
} {
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
  return {
    sttAvailable: !!(voiceCfg?.stt?.provider || hasOpenAIKey),
    ttsAvailable: !!(voiceCfg?.tts?.provider || hasOpenAIKey),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleVoiceCapabilities(ctx: HandlerContext): Promise<void> {
  if (ctx.req.method !== 'GET') {
    ctx.res.statusCode = 405;
    ctx.res.setHeader('Allow', 'GET, OPTIONS');
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end('Method Not Allowed');
    return;
  }

  const voiceCfg = ctx.pluginCfg.voice;
  const { sttAvailable, ttsAvailable } = resolveVoiceAvailability(voiceCfg);

  sendJson(ctx.res, 200, {
    stt: {
      available: sttAvailable,
      ...(sttAvailable && {
        provider: voiceCfg?.stt?.provider ?? 'openai',
        model: voiceCfg?.stt?.model ?? 'whisper-1',
        maxDurationSeconds: 120,
        maxFileSizeMB: 25,
      }),
    },
    tts: {
      available: ttsAvailable,
      ...(ttsAvailable && {
        provider: voiceCfg?.tts?.provider ?? 'openai',
        model: voiceCfg?.tts?.model ?? 'tts-1',
        voices: TTS_VOICES,
        defaultVoice: voiceCfg?.tts?.defaultVoice ?? 'nova',
      }),
    },
  });
}

export async function handleVoiceTranscribe(ctx: HandlerContext): Promise<void> {
  if (ctx.req.method !== 'POST') {
    ctx.res.statusCode = 405;
    ctx.res.setHeader('Allow', 'POST, OPTIONS');
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end('Method Not Allowed');
    return;
  }

  const voiceCfg = ctx.pluginCfg.voice;
  const { sttAvailable } = resolveVoiceAvailability(voiceCfg);

  if (!sttAvailable) {
    sendJson(ctx.res, 503, { error: 'No STT provider configured' });
    return;
  }

  const contentType = (ctx.req.headers['content-type'] as string) ?? '';
  if (!contentType.includes('multipart/form-data')) {
    sendJson(ctx.res, 400, { error: 'Expected multipart/form-data' });
    return;
  }

  let parsed: { audioBuffer: Buffer; language: string };
  try {
    parsed = await parseMultipart(ctx.req, contentType);
  } catch (err) {
    ctx.logger.error(`RemoteClaw: multipart parse failed: ${err}`);
    sendJson(ctx.res, 400, { error: 'Failed to parse audio upload' });
    return;
  }

  if (parsed.audioBuffer.length < 100) {
    sendJson(ctx.res, 400, { error: 'No audio data received' });
    return;
  }

  if (parsed.audioBuffer.length > MAX_FILE_SIZE) {
    sendJson(ctx.res, 413, { error: 'Audio file too large (max 25MB)' });
    return;
  }

  try {
    const model = voiceCfg?.stt?.model ?? 'whisper-1';
    const result = await transcribeViaOpenAI(
      parsed.audioBuffer,
      parsed.language,
      model,
    );

    sendJson(ctx.res, 200, {
      text: result.text,
      language: result.language ?? parsed.language,
      duration: result.duration,
    });
  } catch (err) {
    ctx.logger.error(`RemoteClaw: STT failed: ${err}`);
    sendJson(ctx.res, 500, {
      error: err instanceof Error ? err.message : 'Transcription failed',
    });
  }
}

export async function handleVoiceSynthesize(ctx: HandlerContext): Promise<void> {
  if (ctx.req.method !== 'POST') {
    ctx.res.statusCode = 405;
    ctx.res.setHeader('Allow', 'POST, OPTIONS');
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end('Method Not Allowed');
    return;
  }

  const voiceCfg = ctx.pluginCfg.voice;
  const { ttsAvailable } = resolveVoiceAvailability(voiceCfg);

  if (!ttsAvailable) {
    sendJson(ctx.res, 503, { error: 'No TTS provider configured' });
    return;
  }

  let body: { text?: string; voice?: string; speed?: number };
  try {
    body = await readJsonBody(ctx.req) as { text?: string; voice?: string; speed?: number };
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.text || !body.text.trim()) {
    sendJson(ctx.res, 400, { error: 'Missing or empty text' });
    return;
  }

  if (body.text.length > MAX_TEXT_LENGTH) {
    sendJson(ctx.res, 413, { error: `Text too long (max ${MAX_TEXT_LENGTH} chars)` });
    return;
  }

  const voice = body.voice ?? voiceCfg?.tts?.defaultVoice ?? 'nova';

  // Validate voice against allowlist
  if (!TTS_VOICES.includes(voice)) {
    sendJson(ctx.res, 400, {
      error: `Invalid voice "${voice}". Valid voices: ${TTS_VOICES.join(', ')}`,
    });
    return;
  }

  const model = voiceCfg?.tts?.model ?? 'tts-1';

  try {
    const audioBuffer = await synthesizeViaOpenAI(
      body.text,
      voice,
      model,
      body.speed,
    );

    ctx.res.statusCode = 200;
    ctx.res.setHeader('Content-Type', 'audio/mpeg');
    ctx.res.setHeader('Content-Length', audioBuffer.length);
    ctx.res.setHeader('Access-Control-Allow-Origin', '*');
    ctx.res.end(audioBuffer);
  } catch (err) {
    ctx.logger.error(`RemoteClaw: TTS failed: ${err}`);
    sendJson(ctx.res, 500, {
      error: err instanceof Error ? err.message : 'Synthesis failed',
    });
  }
}
