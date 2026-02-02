# RemoteClawGateway

Moltbot plugin that adds HTTP endpoints for RemoteClaw (terminal client) and ClawTalk (iOS app). Provides provider discovery, rate-limit tracking, voice I/O, and mobile pairing. API keys stay on the server.

## Source Files

```
src/
  index.ts        Plugin entry, route dispatch, rate limiter, pairing handler, Tailscale detection
  types.ts        TypeScript interfaces (PluginApi, RemoteClawPluginConfig, HandlerContext, etc.)
  http.ts         Utilities: sendJson(), readJsonBody(), handleCors()
  auth.ts         Bearer token auth, localhost fallback, timing-safe compare, resolveGatewayToken()
  providers.ts    GET /api/providers — auto-detect configured LLM providers + billing overrides
  rate-limits.ts  GET /api/rate-limits — usage from moltbot internals or proxy-captured headers
  proxy.ts        HTTP proxy on port 18793 capturing Anthropic rate-limit headers
  voice.ts        Voice endpoints: capabilities, transcribe (Whisper), synthesize (OpenAI TTS)
```

## Routes

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/api/pair` | Pairing password (rate-limited) | index.ts |
| GET | `/api/providers` | Bearer token | providers.ts |
| GET | `/api/rate-limits` | Bearer token | rate-limits.ts |
| GET | `/api/voice/capabilities` | Bearer token | voice.ts |
| POST | `/api/voice/transcribe` | Bearer token | voice.ts |
| POST | `/api/voice/synthesize` | Bearer token | voice.ts |

## Auth

- If `CLAWDBOT_GATEWAY_TOKEN` or `config.gateway.auth.token` is set: requires `Authorization: Bearer <token>`
- If no token configured: only allows localhost (127.0.0.1 / ::1)
- Exception: `/api/pair` authenticates via password in request body, not bearer token

## Pairing

Disabled by default. Enabled when `pairPassword` is set (config or `CLAWDBOT_PAIR_PASSWORD` env var).

Flow: ClawTalk sends `POST /api/pair` with `{"password":"..."}` → gateway returns `{name, gatewayURL, port, authToken, agentID}`.

- Rate limited: 5 attempts per IP per 60s, cleanup every 5 min
- Timing-safe password comparison
- Auto-detects Tailscale Funnel URL via `tailscale status --json` for HTTPS gatewayURL
- Falls back to `externalUrl` config or request Host header

## Plugin Config (moltbot.plugin.json)

```yaml
plugins:
  remoteclaw:
    pairPassword: "secret"          # Enables /api/pair
    externalUrl: "https://..."      # Override gateway URL in pair response
    name: "Home Server"             # Friendly name in pair response
    proxyPort: 18793                # Rate-limit capture proxy port
    providers:
      anthropic:
        billing: "subscription"
        plan: "Max Pro"
        monthlyPrice: 200
    voice:
      stt: { model: "whisper-1" }
      tts: { model: "tts-1", defaultVoice: "nova" }
```

## Build

```bash
npm install
npm run build    # tsc → dist/
npm run dev      # tsc --watch
```

Requires Node 20+. Voice features require `OPENAI_API_KEY`.

## Key Patterns

- Plugin registers via `api.registerHttpHandler()` returning `boolean` (true = handled)
- Handler context (`HandlerContext`) bundles req/res/url/cfg/pluginCfg/logger
- Rate-limit data: tries moltbot's internal `loadProviderUsageSummary()` (dynamic import), falls back to proxy-captured Anthropic headers
- Proxy runs as singleton with hot-reload guard to prevent double-binding
- All intervals use `.unref()` to avoid blocking process exit

## Related Projects

- **ClawTalk** — iOS client that connects to these endpoints
- **RemoteClaw** — Terminal TUI client
- **Moltbot** — The host server this plugin extends
