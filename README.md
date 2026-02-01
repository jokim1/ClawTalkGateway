# RemoteClawGateway

A [Moltbot](https://github.com/jokim1/moltbot) plugin that powers [RemoteClaw](https://github.com/jokim1/RemoteClaw).

This plugin runs on your server alongside Moltbot. It adds HTTP endpoints that RemoteClaw (the terminal client) uses to discover providers, track rate limits, and do voice input/output. Your API keys stay on the server — the client never sees them.

## What it does

- **`/api/providers`** — tells RemoteClaw which LLM providers are available and how they're billed
- **`/api/rate-limits`** — reports usage and rate-limit data for subscription plans (e.g. Anthropic Max)
- **`/api/voice/capabilities`** — tells RemoteClaw whether speech-to-text and text-to-speech are available
- **`/api/voice/transcribe`** — accepts audio, returns transcribed text (via OpenAI Whisper)
- **`/api/voice/synthesize`** — accepts text, returns spoken audio (via OpenAI TTS)

## Setup

### Step 1: Install the plugin

Copy or clone this repo into your Moltbot plugins directory:

```bash
cd /path/to/moltbot/plugins
git clone https://github.com/jokim1/RemoteClawGateway.git remoteclaw
cd remoteclaw
npm install
npm run build
```

Then restart Moltbot. You should see `RemoteClaw plugin loaded` in the logs.

### Step 2: Set an auth token (recommended)

If your server is accessible over the network, set a token so only you can use the endpoints.

Either set it in your Moltbot config:

```yaml
gateway:
  auth:
    token: "pick-a-strong-random-token"
```

Or set an environment variable:

```bash
export CLAWDBOT_GATEWAY_TOKEN="pick-a-strong-random-token"
```

If no token is set, the plugin only allows requests from localhost (127.0.0.1 / ::1).

Use this same token when configuring RemoteClaw on your local machine:

```bash
remoteclaw config --gateway http://your-server:18789 --token pick-a-strong-random-token
```

### Step 3: Enable voice (optional)

Voice features require an OpenAI API key on the server for Whisper (STT) and TTS:

```bash
export OPENAI_API_KEY="sk-..."
```

That's it. The plugin auto-detects the key and enables voice endpoints. RemoteClaw will discover voice support automatically.

You can customize the voice models in your Moltbot plugin config:

```yaml
plugins:
  remoteclaw:
    voice:
      stt:
        model: "whisper-1"       # default
      tts:
        model: "tts-1"           # default
        defaultVoice: "nova"     # default (options: alloy, echo, fable, onyx, nova, shimmer)
```

### Step 4: Configure provider billing (optional)

If you're on a subscription plan (e.g. Anthropic Max), tell the plugin so RemoteClaw can show rate-limit bars instead of per-token pricing:

```yaml
plugins:
  remoteclaw:
    providers:
      anthropic:
        billing: "subscription"
        plan: "Max Pro"
        monthlyPrice: 200
      deepseek:
        billing: "api"
```

## How it all fits together

```
Your machine                       Your server
┌──────────────┐                  ┌──────────────────────────────┐
│  RemoteClaw   │                 │  Moltbot                      │
│  (terminal)   │                 │  ├── /v1/chat/completions     │ ← chat (built into Moltbot)
│               │───── HTTP ─────▶│  ├── /v1/models               │ ← model list (built in)
│               │                 │  │                             │
│               │                 │  └── RemoteClawGateway plugin  │ ← this repo
│               │                 │      ├── /api/providers        │
│               │                 │      ├── /api/rate-limits      │
│               │                 │      ├── /api/voice/capabilities│
│               │                 │      ├── /api/voice/transcribe │
│               │                 │      └── /api/voice/synthesize │
└──────────────┘                  └──────────────────────────────┘
```

Moltbot handles chat and model routing. This plugin adds the extra endpoints RemoteClaw needs for provider info, rate limits, and voice.

## API reference

All endpoints require authentication (bearer token or localhost).

### GET /api/providers

Returns the list of configured LLM providers with billing info.

```json
{
  "providers": [
    { "id": "anthropic", "billing": { "mode": "subscription", "plan": "Max Pro", "monthlyPrice": 200 } },
    { "id": "deepseek", "billing": { "mode": "api" } },
    { "id": "openai", "billing": { "mode": "api" } }
  ]
}
```

Providers are auto-detected from Moltbot's config and environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`).

### GET /api/rate-limits

Returns usage data for all providers. Optionally filter with `?provider=anthropic`.

```json
{
  "rateLimits": [
    {
      "provider": "anthropic",
      "session": { "used": 45, "limit": 100, "resetsAt": "2025-01-15T12:00:00.000Z" },
      "weekly": { "used": 12, "limit": 100, "resetsAt": "2025-01-20T00:00:00.000Z" }
    }
  ]
}
```

### GET /api/voice/capabilities

Returns what voice features are available.

```json
{
  "stt": {
    "available": true,
    "provider": "openai",
    "model": "whisper-1",
    "maxDurationSeconds": 120,
    "maxFileSizeMB": 25
  },
  "tts": {
    "available": true,
    "provider": "openai",
    "model": "tts-1",
    "voices": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
    "defaultVoice": "nova"
  }
}
```

### POST /api/voice/transcribe

Upload audio, get text back.

- **Content-Type**: `multipart/form-data`
- **Fields**: `audio` (WAV file, max 25MB), `language` (optional, default `en`)

```json
{
  "text": "Hello, how are you?",
  "language": "en",
  "duration": 2.4
}
```

### POST /api/voice/synthesize

Send text, get audio back.

- **Content-Type**: `application/json`
- **Body**: `{ "text": "Hello!", "voice": "nova", "speed": 1.0 }`
- **Response**: `audio/mpeg` binary (MP3)

`voice` and `speed` are optional.

## Authentication

The plugin checks requests in this order:

1. If a token is configured (via config or `CLAWDBOT_GATEWAY_TOKEN` env var), the request must include `Authorization: Bearer <token>`
2. If no token is configured, only localhost requests are allowed

Token comparison uses timing-safe equality to prevent timing attacks.

## Requirements

- **Node.js 20+**
- **Moltbot** running on the same machine
- **`OPENAI_API_KEY`** environment variable (only needed for voice features)

## Development

```bash
npm install
npm run build
npm run dev    # watch mode
```

## License

MIT
