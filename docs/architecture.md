# Architecture Reference

Read this when working on routes, execution modes, config, auth, or navigating the module map.

## Module Responsibilities

### Core / Entry
| Module | Responsibility |
|--------|---------------|
| `index.ts` | Plugin entry, route dispatch, rate limiter, pairing handler, Tailscale detection, hook handlers |
| `types.ts` | TypeScript interfaces (`PluginApi`, `ClawTalkPluginConfig`, `HandlerContext`, etc.) |
| `http.ts` | `sendJson()`, `readJsonBody()`, `handleCors()` |
| `auth.ts` | Bearer token auth, localhost fallback, timing-safe compare, `resolveGatewayToken()` |

### Providers / Rate Limits
| Module | Responsibility |
|--------|---------------|
| `providers.ts` | `GET /api/providers` — auto-detect configured LLM providers + billing overrides |
| `rate-limits.ts` | `GET /api/rate-limits` — usage from OpenClaw internals or proxy-captured headers |
| `proxy.ts` | HTTP proxy on port 18793 capturing Anthropic rate-limit headers |
| `provider-baseurl-sync.ts` | Reconcile proxy base URLs for Anthropic API routing |

### Voice
| Module | Responsibility |
|--------|---------------|
| `voice.ts` | Capabilities, transcribe (multi-provider STT), synthesize (multi-provider TTS) |
| `voice-stream.ts` | WebSocket live voice streaming |
| `realtime-voice.ts` | Real-time voice conversation (OpenAI, Cartesia+Deepgram, ElevenLabs, Gemini) |

### Talks
| Module | Responsibility |
|--------|---------------|
| `talks.ts` | CRUD, messages, pins, jobs — HTTP route handler |
| `talk-store.ts` | File-based persistent storage under `~/.openclaw/plugins/clawtalk/` |
| `talk-chat.ts` | Talk-aware chat: context injection, system prompts, tool loop orchestration |
| `system-prompt.ts` | Composes system prompts from Talk metadata, context, pins, and jobs |
| `context-updater.ts` | Updates Talk `context.md` after new messages |
| `job-scheduler.ts` | Cron-based job scheduler — checks every 60s, runs due jobs with full Talk context |

### Tools
| Module | Responsibility |
|--------|---------------|
| `tool-registry.ts` | Registers and stores available tools |
| `tool-executor.ts` | Executes tool calls from LLM responses |
| `tool-loop.ts` | Drives the tool-use loop (LLM call → tool execution → re-prompt) |
| `tool-catalog.ts` | Persisted catalog of tools at `~/.openclaw/plugins/clawtalk/tool-catalog.json` |
| `tool-affinity.ts` | Tool affinity scoring and phase management |
| `openclaw-native-tools.ts` | Bridges OpenClaw's built-in tools (Read, Write, shell_exec) |

### Policy / Routing
| Module | Responsibility |
|--------|---------------|
| `talk-policy.ts` | Execution mode resolution, tool availability evaluation |
| `routing-headers.ts` | Guards against header leakage between execution modes |
| `model-routing-diagnostics.ts` | Reads OpenClaw config to trace agent/model routing decisions |

### Slack
| Module | Responsibility |
|--------|---------------|
| `slack-ingress.ts` | Inbound Slack message handling: ownership resolution, delegation to OpenClaw agent |
| `slack-routing-sync.ts` | Writes managed agents (`ct-*`) and Talk bindings into `openclaw.json` |
| `slack-ownership-doctor.ts` | Detects Talk/OpenClaw binding conflicts (detection-only) |
| `slack-event-proxy.ts` | Gateway as Slack Events API entry point, routes to ingress or OpenClaw |
| `slack-auth.ts` | Multi-account Slack token resolution, signing secret expansion |
| `slack-proxy-setup.ts` | Detects setup gaps and logs guided onboarding instructions |
| `event-dispatcher.ts` | Triggers event-driven jobs from OpenClaw `message_received` hook |

### Integrations
| Module | Responsibility |
|--------|---------------|
| `google-docs.ts` | Google Docs tool implementation |
| `google-docs-url.ts` | Google Docs URL parsing |
| `file-upload.ts` | File upload handling |
| `commands.ts` | Custom command handling |
| `intent-outcome-verifier.ts` | Verifies LLM intent matches actual outcome |

## Routes

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/api/pair` | Pairing password (rate-limited) | index.ts |
| GET | `/api/providers` | Bearer token | providers.ts |
| GET | `/api/rate-limits` | Bearer token | rate-limits.ts |
| GET | `/api/voice/capabilities` | Bearer token | voice.ts |
| POST | `/api/voice/transcribe` | Bearer token | voice.ts |
| POST | `/api/voice/synthesize` | Bearer token | voice.ts |
| POST | `/api/voice/stt/provider` | Bearer token | voice.ts |
| POST | `/api/voice/tts/provider` | Bearer token | voice.ts |
| GET | `/api/voice/stream` | Bearer token | voice-stream.ts |
| GET | `/api/realtime-voice/capabilities` | Bearer token | realtime-voice.ts |
| GET | `/api/realtime-voice/stream` | Bearer token | realtime-voice.ts |
| POST | `/api/talks` | Bearer token | talks.ts |
| GET | `/api/talks` | Bearer token | talks.ts |
| GET | `/api/talks/:id` | Bearer token | talks.ts |
| PATCH | `/api/talks/:id` | Bearer token | talks.ts |
| DELETE | `/api/talks/:id` | Bearer token | talks.ts |
| GET | `/api/talks/:id/messages` | Bearer token | talks.ts |
| POST | `/api/talks/:id/chat` | Bearer token | talk-chat.ts |
| POST | `/api/talks/:id/pin` | Bearer token | talks.ts |
| DELETE | `/api/talks/:id/pin/:msgId` | Bearer token | talks.ts |
| POST | `/api/talks/:id/jobs` | Bearer token | talks.ts |
| GET | `/api/talks/:id/jobs` | Bearer token | talks.ts |
| PATCH | `/api/talks/:id/jobs/:jobId` | Bearer token | talks.ts |
| DELETE | `/api/talks/:id/jobs/:jobId` | Bearer token | talks.ts |
| GET | `/api/talks/:id/reports` | Bearer token | talks.ts |

## Execution Modes

Each Talk has an `executionMode` controlling how chat requests route through OpenClaw:

- **`openclaw`** (default) — Session key uses `agent:<agentId>:` prefix, activating OpenClaw's embedded agent. OpenClaw replaces the gateway's tools with its own (Read, Write, exec). The `x-openclaw-agent-id` header is sent.
- **`full_control`** — Session key uses `talk:clawtalk:talk:<id>:chat` prefix (no `agent:` prefix), bypassing OpenClaw's agent. Gateway acts as transparent LLM proxy with gateway-installed tools callable. The `x-openclaw-agent-id` header is suppressed.

Session key construction in `talk-chat.ts`: `buildTalkSessionKey()` for openclaw, `buildFullControlTalkSessionKey()` for full_control. Job scheduler always uses `job:` prefix (`buildTalkJobSessionKey()` in `job-scheduler.ts`) — jobs run in transparent proxy mode.

Old values (`inherit`, `sandboxed`, `unsandboxed`) are lazily migrated on load in `talk-store.ts`.

## Auth

- If `OPENCLAW_GATEWAY_TOKEN` or `config.gateway.auth.token` is set: requires `Authorization: Bearer <token>`
- If no token configured: only allows localhost (127.0.0.1 / ::1)
- Exception: `/api/pair` authenticates via password in request body

## Pairing

Disabled by default. Enabled when `pairPassword` is set (config or `CLAWDBOT_PAIR_PASSWORD` env var).

Flow: ClawTalkMobile sends `POST /api/pair` with `{"password":"..."}` → gateway returns `{name, gatewayURL, port, authToken, agentID}`.

Rate limited: 5 attempts per IP per 60s. Timing-safe password comparison. Auto-detects Tailscale Funnel URL for HTTPS gatewayURL, falls back to `externalUrl` config or request Host header.

## Plugin Config

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

## Data Storage Layout

```
~/.openclaw/plugins/clawtalk/
├── talks/
│   └── <uuid>/
│       ├── talk.json          # TalkMeta: metadata, jobs, bindings, behaviors
│       ├── history.jsonl      # One TalkMessage per line (append-only)
│       ├── context.md         # AI-maintained context document
│       ├── reports.jsonl      # Job execution reports
│       ├── affinity/          # Tool affinity cache
│       └── state/             # state_* stream storage
├── tool-catalog.json          # Available tools catalog
└── ingress-dead-letter.jsonl  # Undeliverable Slack messages
```
