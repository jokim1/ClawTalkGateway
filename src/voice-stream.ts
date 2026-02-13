import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

import type { Logger, VoicePluginConfig } from './types.js';
import { transcribeViaOpenAI, synthesizeViaOpenAI } from './voice.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM
const CHANNELS = 1;

// VAD parameters
const RMS_SPEECH_THRESHOLD = 400; // RMS above this → speech detected
const SILENCE_DURATION_MS = 1500; // 1.5s of silence after speech → process turn
const MIN_SPEECH_DURATION_MS = 300; // ignore very short blips

// ---------------------------------------------------------------------------
// Shared WebSocketServer (noServer mode)
// ---------------------------------------------------------------------------

let _wss: WebSocketServer | undefined;

function getWSS(): WebSocketServer {
  if (!_wss) {
    _wss = new WebSocketServer({ noServer: true });
  }
  return _wss;
}

// ---------------------------------------------------------------------------
// WAV header helper
// ---------------------------------------------------------------------------

function makeWavHeader(pcmByteLength: number): Buffer {
  const header = Buffer.alloc(44);
  const totalDataLen = pcmByteLength;
  const totalFileLen = totalDataLen + 36;

  header.write('RIFF', 0);
  header.writeUInt32LE(totalFileLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(totalDataLen, 40);

  return header;
}

// ---------------------------------------------------------------------------
// Voice Stream Session
// ---------------------------------------------------------------------------

/** Maximum audio buffer size before force-processing a turn. */
const MAX_AUDIO_BUFFER_BYTES = 5 * 1024 * 1024; // 5MB

interface SessionState {
  model: string;
  messages: Array<{ role: string; content: string }>;
  agentId: string;
  sessionKey: string;
  audioChunks: Buffer[];
  audioChunksBytes: number;
  speechDetected: boolean;
  speechStartedAt: number;
  lastSpeechAt: number;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  processing: boolean;
}

function createSession(): SessionState {
  return {
    model: '',
    messages: [],
    agentId: '',
    sessionKey: '',
    audioChunks: [],
    audioChunksBytes: 0,
    speechDetected: false,
    speechStartedAt: 0,
    lastSpeechAt: 0,
    silenceTimer: null,
    processing: false,
  };
}

function sendJsonMsg(ws: WebSocket, obj: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function calculateRMS(pcmBuffer: Buffer): number {
  const samples = pcmBuffer.length / BYTES_PER_SAMPLE;
  if (samples === 0) return 0;

  let sumSq = 0;
  for (let i = 0; i < pcmBuffer.length; i += BYTES_PER_SAMPLE) {
    const sample = pcmBuffer.readInt16LE(i);
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / samples);
}

async function processTurn(
  session: SessionState,
  ws: WebSocket,
  logger: Logger,
  voiceCfg: VoicePluginConfig | undefined,
  gatewayOrigin: string,
  authToken: string | undefined,
): Promise<void> {
  if (session.audioChunks.length === 0) {
    sendJsonMsg(ws, { type: 'ready' });
    return;
  }

  const pcmData = Buffer.concat(session.audioChunks);
  session.audioChunks = [];
  session.audioChunksBytes = 0;
  session.speechDetected = false;
  session.speechStartedAt = 0;
  session.lastSpeechAt = 0;

  // Wrap PCM in WAV header for Whisper
  const wavBuffer = Buffer.concat([makeWavHeader(pcmData.length), pcmData]);

  // 1. Transcribe
  let transcription: string;
  try {
    const sttModel = voiceCfg?.stt?.model ?? 'whisper-1';
    const result = await transcribeViaOpenAI(wavBuffer, 'en', sttModel);
    transcription = result.text;
  } catch (err) {
    logger.error(`VoiceStream: STT failed: ${err}`);
    sendJsonMsg(ws, { type: 'error', message: 'Transcription failed' });
    sendJsonMsg(ws, { type: 'ready' });
    return;
  }

  if (!transcription.trim()) {
    sendJsonMsg(ws, { type: 'ready' });
    return;
  }

  sendJsonMsg(ws, { type: 'transcription', text: transcription });

  // 2. Chat completion via internal gateway
  sendJsonMsg(ws, { type: 'response_start' });

  const chatMessages = [
    ...session.messages,
    { role: 'user', content: transcription },
  ];

  let assistantText: string;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const chatResp = await fetch(`${gatewayOrigin}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: session.model,
        messages: chatMessages,
      }),
    });

    if (!chatResp.ok) {
      const errBody = await chatResp.text().catch(() => '');
      throw new Error(`Chat API error (${chatResp.status}): ${errBody.slice(0, 200)}`);
    }

    const chatJson = await chatResp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    assistantText = chatJson.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    logger.error(`VoiceStream: chat completion failed: ${err}`);
    sendJsonMsg(ws, { type: 'error', message: 'Chat completion failed' });
    sendJsonMsg(ws, { type: 'response_end', text: '' });
    sendJsonMsg(ws, { type: 'ready' });
    return;
  }

  // Update message history for next turn
  session.messages.push({ role: 'user', content: transcription });
  session.messages.push({ role: 'assistant', content: assistantText });

  sendJsonMsg(ws, { type: 'response_end', text: assistantText });

  if (!assistantText.trim()) {
    sendJsonMsg(ws, { type: 'ready' });
    return;
  }

  // 3. TTS synthesis
  try {
    const ttsModel = voiceCfg?.tts?.model ?? 'tts-1';
    const ttsVoice = voiceCfg?.tts?.defaultVoice ?? 'nova';
    const audioBuffer = await synthesizeViaOpenAI(assistantText, ttsVoice, ttsModel);

    // Send MP3 audio as binary frame
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(audioBuffer);
    }
  } catch (err) {
    logger.error(`VoiceStream: TTS failed: ${err}`);
    sendJsonMsg(ws, { type: 'error', message: 'Speech synthesis failed' });
  }

  sendJsonMsg(ws, { type: 'audio_end' });
  sendJsonMsg(ws, { type: 'ready' });
}

// ---------------------------------------------------------------------------
// WebSocket Upgrade Handler
// ---------------------------------------------------------------------------

export function handleVoiceStreamUpgrade(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
  voiceCfg: VoicePluginConfig | undefined,
  gatewayOrigin: string,
  authToken: string | undefined,
): void {
  // Validate WebSocket upgrade
  const upgradeHeader = (req.headers['upgrade'] ?? '').toLowerCase();
  if (upgradeHeader !== 'websocket') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Expected WebSocket upgrade');
    return;
  }

  const socket = req.socket;
  const wss = getWSS();

  wss.handleUpgrade(req, socket, Buffer.alloc(0), (ws) => {
    logger.info('VoiceStream: client connected');

    const session = createSession();

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (session.processing) return; // ignore input while processing

      if (!isBinary) {
        // Text frame → JSON control message
        let msg: { type?: string; model?: string; agentId?: string; sessionKey?: string; messages?: unknown[] };
        try {
          msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
        } catch {
          sendJsonMsg(ws, { type: 'error', message: 'Invalid JSON' });
          return;
        }

        if (msg.type === 'start') {
          session.model = msg.model ?? '';
          session.agentId = msg.agentId ?? '';
          session.sessionKey = msg.sessionKey ?? '';

          // Convert messages from client format
          if (Array.isArray(msg.messages)) {
            session.messages = msg.messages
              .filter((m): m is Record<string, string> =>
                typeof m === 'object' && m !== null && typeof (m as Record<string, unknown>).role === 'string')
              .map((m) => ({
                role: m.role ?? 'user',
                content: m.content ?? '',
              }));
          }

          logger.info(`VoiceStream: session started (model=${session.model})`);
          sendJsonMsg(ws, { type: 'ready' });
          return;
        }

        if (msg.type === 'end') {
          logger.info('VoiceStream: client ended session');
          ws.close(1000, 'Session ended');
          return;
        }

        return;
      }

      // Binary frame → PCM audio
      const pcmBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);

      if (pcmBuffer.length < BYTES_PER_SAMPLE) return;

      const rms = calculateRMS(pcmBuffer);
      const now = Date.now();

      /** Force-process the current turn (used by silence timer and buffer cap). */
      function forceProcessTurn() {
        session.processing = true;
        processTurn(session, ws, logger, voiceCfg, gatewayOrigin, authToken)
          .catch((err) => {
            logger.error(`VoiceStream: processTurn error: ${err}`);
            sendJsonMsg(ws, { type: 'error', message: 'Processing error' });
            sendJsonMsg(ws, { type: 'ready' });
          })
          .finally(() => {
            session.processing = false;
          });
      }

      if (rms > RMS_SPEECH_THRESHOLD) {
        // Speech detected
        if (!session.speechDetected) {
          session.speechDetected = true;
          session.speechStartedAt = now;
        }
        session.lastSpeechAt = now;
        session.audioChunks.push(pcmBuffer);
        session.audioChunksBytes += pcmBuffer.length;

        // Clear any pending silence timer
        if (session.silenceTimer) {
          clearTimeout(session.silenceTimer);
          session.silenceTimer = null;
        }

        // Force-process if audio buffer exceeds cap
        if (session.audioChunksBytes >= MAX_AUDIO_BUFFER_BYTES) {
          logger.warn(`VoiceStream: audio buffer hit ${MAX_AUDIO_BUFFER_BYTES} byte cap, force-processing turn`);
          if (session.silenceTimer) {
            clearTimeout(session.silenceTimer);
            session.silenceTimer = null;
          }
          forceProcessTurn();
        }
      } else if (session.speechDetected) {
        // Silence after speech — still collect audio (captures trailing speech)
        session.audioChunks.push(pcmBuffer);
        session.audioChunksBytes += pcmBuffer.length;

        // Start/reset silence timer
        if (!session.silenceTimer) {
          session.silenceTimer = setTimeout(() => {
            session.silenceTimer = null;

            // Check minimum speech duration
            const speechDuration = session.lastSpeechAt - session.speechStartedAt;
            if (speechDuration < MIN_SPEECH_DURATION_MS) {
              // Too short — discard and reset
              session.audioChunks = [];
              session.audioChunksBytes = 0;
              session.speechDetected = false;
              session.speechStartedAt = 0;
              session.lastSpeechAt = 0;
              return;
            }

            // Process the turn
            forceProcessTurn();
          }, SILENCE_DURATION_MS);
        }
      }
      // If no speech detected yet and RMS is below threshold, ignore (background noise)
    });

    ws.on('close', () => {
      logger.info('VoiceStream: client disconnected');
      if (session.silenceTimer) {
        clearTimeout(session.silenceTimer);
        session.silenceTimer = null;
      }
    });

    ws.on('error', (err) => {
      logger.error(`VoiceStream: WebSocket error: ${err}`);
    });
  });
}
