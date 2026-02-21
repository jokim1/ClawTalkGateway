# ClawTalkGateway

OpenClaw plugin that adds HTTP endpoints for ClawTalk (terminal client) and ClawTalkMobile (iOS app). Provides provider discovery, rate-limit tracking, voice I/O, Talks (persistent conversations), scheduled jobs, and mobile pairing. API keys stay on the server.

## Source Files

```
src/
  index.ts            Plugin entry, route dispatch, rate limiter, pairing handler, Tailscale detection
  types.ts            TypeScript interfaces (PluginApi, RemoteClawPluginConfig, HandlerContext, etc.)
  http.ts             Utilities: sendJson(), readJsonBody(), handleCors()
  auth.ts             Bearer token auth, localhost fallback, timing-safe compare, resolveGatewayToken()
  providers.ts        GET /api/providers — auto-detect configured LLM providers + billing overrides
  rate-limits.ts      GET /api/rate-limits — usage from OpenClaw internals or proxy-captured headers
  proxy.ts            HTTP proxy on port 18793 capturing Anthropic rate-limit headers
  voice.ts            Voice endpoints: capabilities, transcribe (multi-provider STT), synthesize (multi-provider TTS)
  voice-stream.ts     WebSocket live voice streaming
  realtime-voice.ts   Real-time voice conversation (OpenAI, Cartesia+Deepgram, ElevenLabs, Gemini)
  talks.ts            Talks route handler — CRUD, messages, pins, jobs
  talk-store.ts       File-based persistent storage for Talks (~/.moltbot/plugins/remoteclaw/)
  talk-chat.ts        Talk-aware chat with context injection and system prompts
  system-prompt.ts    Composes system prompts from Talk metadata, context, pins, and jobs
  context-updater.ts  Updates Talk context markdown after new messages
  job-scheduler.ts    Cron-based job scheduler — checks every 60s, runs due jobs with full Talk context
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

## Auth

- If `CLAWDBOT_GATEWAY_TOKEN` or `config.gateway.auth.token` is set: requires `Authorization: Bearer <token>`
- If no token configured: only allows localhost (127.0.0.1 / ::1)
- Exception: `/api/pair` authenticates via password in request body, not bearer token

## Pairing

Disabled by default. Enabled when `pairPassword` is set (config or `CLAWDBOT_PAIR_PASSWORD` env var).

Flow: ClawTalkMobile sends `POST /api/pair` with `{"password":"..."}` → gateway returns `{name, gatewayURL, port, authToken, agentID}`.

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
npm test         # run tests
```

Requires Node 20+. Voice features require at minimum `OPENAI_API_KEY`.

## Execution Modes

Each Talk has an `executionMode` that controls how chat requests are routed through OpenClaw:

- **`openclaw`** (default) — Session key uses `agent:<agentId>:` prefix, which activates OpenClaw's embedded agent. OpenClaw replaces the gateway's tools array with its own (Read, Write, exec). The `x-openclaw-agent-id` header is sent. Gateway-installed tools are not callable.
- **`full_control`** — Session key uses `talk:clawtalk:talk:<id>:chat` prefix (no `agent:` prefix), bypassing OpenClaw's agent. The gateway acts as a transparent LLM proxy. Gateway-installed tools (google_docs_append, etc.) are callable. The `x-openclaw-agent-id` header is suppressed; model routing uses the `model` param instead.

Session key construction lives in `talk-chat.ts`: `buildTalkSessionKey()` for openclaw, `buildFullControlTalkSessionKey()` for full_control.

Job scheduler always uses `job:` prefix session keys (`buildTalkJobSessionKey()`) regardless of execution mode — jobs run in transparent proxy mode.

Old values (`inherit`, `sandboxed`, `unsandboxed`) are lazily migrated on load in `talk-store.ts` and accepted from stale clients in `talks.ts`.

## Engineering Principles

These apply to all code changes in this project:

- **Single Responsibility**: Each module/function does one thing. If a function name needs "and" in it, split it.
- **Dependency Inversion**: Depend on interfaces/types, not concrete implementations. Pass dependencies in (constructor/function params), don't reach out to grab them (no hidden global state).
- **Composition over inheritance**: Build behavior by combining small, focused functions rather than deep class hierarchies.
- **Explicit over clever**: No magic. If a reader can't understand what a function does from its name and signature alone, it needs refactoring or better naming.
- **DRY but "engineered enough"**: Extract shared logic when there are 3+ call sites with identical patterns. Don't prematurely abstract for 2 call sites — duplication is cheaper than the wrong abstraction.
- **Separation of concerns**: Data access, business logic, and HTTP/presentation are separate layers. A function that reads config should not also format HTTP responses.
- **Verify assumptions against source**: When integrating with OpenClaw or any external system, read the actual source code before implementing. Do not assume behavior based on naming conventions or documentation alone.
- **Priority-based issue reporting**: When reviewing or auditing, classify issues as P0 (production failure), P1 (design flaw), P2 (improvement). Never cap issue counts — surface all P0s.

## Key Patterns

- Plugin registers via `api.registerHttpHandler()` returning `boolean` (true = handled)
- Handler context (`HandlerContext`) bundles req/res/url/cfg/pluginCfg/logger
- Rate-limit data: tries OpenClaw's internal `loadProviderUsageSummary()` (dynamic import), falls back to proxy-captured Anthropic headers
- Proxy runs as singleton with hot-reload guard to prevent double-binding
- All intervals use `.unref()` to avoid blocking process exit
- Talk data stored as flat files under `~/.moltbot/plugins/remoteclaw/talks/<id>/`

## Slack Integration Files

```
src/
  slack-ingress.ts          Inbound Slack message handling: ownership resolution, delegation to OpenClaw agent, optional mirroring
  slack-ownership-doctor.ts Detects Talk/OpenClaw binding conflicts (detection-only, no auto-fix)
  slack-routing-sync.ts     Writes managed agents (ct-*) and Talk bindings into OpenClaw's openclaw.json config (startup only)
  routing-headers.ts        Guards against header leakage between execution modes
  talk-policy.ts            Execution mode resolution, tool availability evaluation
  event-dispatcher.ts       Triggers event-driven jobs from OpenClaw message_received hook
  model-routing-diagnostics.ts  Reads OpenClaw config to trace agent/model routing decisions
```

## Slack Message Flow

The gateway acts as a **context provider**, not a parallel message processor. OpenClaw's managed agent handles Slack replies natively.

```
Slack message arrives (socket mode)
  │
  ├── OpenClaw resolves agent via binding → ct-<shortId> (managed agent per Talk)
  │
  ├── before_agent_start hook fires (index.ts)
  │     └── Gateway reads Talk metadata + context.md
  │     └── Injects ~2KB context block via prependContext
  │           (instructions, objective, rules, conversation summary, pins, state paths)
  │
  ├── Agent runs LLM call (Talk's model) with:
  │     - OpenClaw's system prompt + tools (Read, Write, shell_exec, message)
  │     - Talk context (injected via prependContext)
  │     - User's Slack message
  │
  ├── Agent responds → OpenClaw delivers to Slack (single response, no duplicates)
  │
  └── message_received hook (parallel, fire-and-forget)
        └── Gateway mirrors message to Talk history (if mirrorToTalk != 'off')
        └── eventDispatcher.handleMessageReceived() → event jobs
```

**Managed agents:** `reconcileSlackRoutingForTalks()` creates a `ct-<shortId>` agent per Talk with Slack write bindings (e.g., `ct-8fabc85a`). Each agent uses the Talk's configured model. Bindings route Slack channels/users to the correct managed agent. Manual agents (lila, gamemakers, etc.) are preserved.

**Delegation:** When a Slack message arrives for a Talk-bound channel, `routeSlackIngressEvent()` returns `'pass'` with reason `'delegated-to-agent'` — no LLM call, no suppression, no queue. OpenClaw processes the message through its managed agent with Talk context injected.

## Known Issues (2026-02-21)

| Issue | Severity | Status |
|-------|----------|--------|
| Ownership doctor detection-only, no auto-remediation | Medium | Open |
| Slack routing sync only runs at startup, not on binding change | Medium | Open |
| Gateway origin resolution inconsistency across files | Low | Open |
| Gateway-installed tools (state_*, google_docs_*) not available in managed agent sessions | Low | Open |
| Context.md not auto-updated by managed agent (agent can self-maintain via Write) | Low | Open |

**Previously fixed:** Dual Slack processing (delegation architecture — gateway as context provider, OpenClaw as processor), triple-path processing (seenEvents dedup), agent routing conflicts (assertRoutingHeaders guard), execution mode routing (routing-headers.ts), full_control session key omission, suppression TTL leak, dead letter race condition, handoff not auto-configured.

## ⚠️ Warnings for Future Agents

1. **Do not set `x-openclaw-agent-id` in `full_control` mode.** The `assertRoutingHeaders()` guard in `routing-headers.ts` will throw `RoutingGuardError`. Session keys ARE allowed in full_control mode but MUST NOT have an `agent:` prefix — non-agent keys (e.g., `talk:clawtalk:...`) are classified as `legacy_or_alias` by OpenClaw and bypass the embedded agent.
2. **The `message_received` hook return value is IGNORED by OpenClaw.** Do not rely on `{ cancel: true }` to prevent message delivery. The hook is fire-and-forget (`runVoidHook`).
3. **The `ctx.channelId` in OpenClaw's `message_received` hook is the platform name** (e.g., "slack"), not a Slack channel ID. Don't confuse it with the Slack channel ID in `SlackIngressEvent.channelId`.
4. **`reconcileSlackRoutingForTalks()` only runs at startup.** New Talk bindings won't take effect until gateway restart. Managed agents (`ct-*` prefix) and their bindings are written to `agents.list` and `bindings` in `openclaw.json`.
5. **Managed agent IDs use the `ct-` prefix** (e.g., `ct-8fabc85a`). Do not manually create agents with this prefix — they will be overwritten by the routing sync. Use `buildManagedAgentId()` and `isManagedAgentId()` from `slack-routing-sync.ts`.
6. **The `before_agent_start` hook injects Talk context for managed agents.** It matches on `ct-*` agent IDs. The context block (~2KB) includes instructions, objective, rules, context.md, pins, and state paths. If no Talk is found for the agent ID, the hook passes through.

## Related Projects

- **ClawTalk** — Terminal TUI client
- **ClawTalkMobile** — iOS client
- **OpenClaw** — The host server this plugin extends
