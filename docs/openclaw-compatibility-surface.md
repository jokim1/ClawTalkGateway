# OpenClaw Compatibility Surface

Every remaining dependency between ClawTalkGateway and OpenClaw.
Check each section when updating OpenClaw.

---

## Config reads (`openclaw.json`)

| Path | Used by | Purpose |
|------|---------|---------|
| `cfg.gateway.auth.token` | `auth.ts:18` | HTTP auth |
| `cfg.gateway.port` / `.bind` | `gateway-origin.ts:49-51` | Internal routing |
| `cfg.gateway.slack.openclawWebhookUrl` | `slack-event-proxy.ts:208` | Slack event forwarding |
| `cfg.gateway.http.port` | `slack-proxy-setup.ts:65` | Setup wizard URLs |
| `cfg.models.providers[key].api` | `direct-provider-router.ts` | Provider format (`openai-completions` or `anthropic-messages`) |
| `cfg.models.providers[key].apiKey` | `direct-provider-router.ts` | Auth (supports `${ENV_VAR}` templates) |
| `cfg.models.providers[key].baseUrl` | `direct-provider-router.ts` | Provider endpoint |
| `cfg.models.providers[key].models[].id/.maxTokens` | `direct-provider-router.ts` | Model validation |
| `cfg.agents.list[].id/.model/.name/.default` | `model-routing-diagnostics.ts`, `providers.ts` | Agent enumeration |
| `cfg.agents.defaults.model.primary` | `providers.ts:20` | Default model |
| `cfg.agents.defaults.models` | `providers.ts:26` | Allowed model list |
| `cfg.auth.profiles[name].provider` | `providers.ts:12` | Provider discovery |
| `cfg.channels.slack.*` | `slack-auth.ts`, `slack-event-proxy.ts` | Slack tokens, signing secrets |

## Config writes (`openclaw.json`)

| Path | Used by | Purpose |
|------|---------|---------|
| `cfg.models.providers.anthropic.baseUrl` | `provider-baseurl-sync.ts` | Proxy URL reconciliation |
| `cfg.gateway.http.endpoints.responses.enabled` | `provider-baseurl-sync.ts` | Enable /v1/responses |
| `cfg.channels.slack.accounts[id].signingSecret` | `slack-proxy-setup.ts` | Setup wizard |

All config writes go through `withOpenClawConfigLock()` from `openclaw-config-lock.ts`.

## Plugin API

| Method | Usage |
|--------|-------|
| `api.runtime.config.loadConfig()` | 11 call sites in `index.ts` — dynamic config refresh |
| `api.registerHttpHandler()` | Single handler for all `/api/*` routes |
| `api.registerService()` | `clawtalk-job-scheduler`, `clawtalk-event-dispatcher` |
| `api.registerCommand()` | `/talks`, `/talk-status`, `/jobs` (in `commands.ts`) |
| `api.registerTool()` | 9 Google Docs tools (conditional, in `openclaw-native-tools.ts`) |
| `api.logger` | Injected logger, used throughout |
| `api.pluginConfig` | Plugin-specific config (dataDir, proxyPort, voice, etc.) |

## Hooks (post-simplification)

| Hook | Purpose | Notes |
|------|---------|-------|
| `message_received` | Dispatch event-driven jobs, Slack ownership check | Fire-and-forget, return value IGNORED (`runVoidHook`) |
| `message_sending` | Debug logging | `ctx.channelId` = platform name (e.g. "slack"), NOT Slack channel ID |
| `message_sent` | Debug logging | |
| `message_send_failed` | Error classification + debug logging | |
| `gateway_start` | Refresh Slack ingress route | |
| `gateway_stop` | Cleanup: unsubscribe TalkStore, close sync clients, stop services | |

## Session keys

| Pattern | Used by | OpenClaw classification |
|---------|---------|------------------------|
| `talk:clawtalk:talk:{id}:chat[:lane:{lane}]` | `talk-chat.ts` | `legacy_or_alias` — bypasses embedded agent |
| `job:clawtalk:talk:{id}:job:{jobId}` | `job-scheduler.ts` | Transparent LLM-proxy mode |

Non-`agent:` keys are auto-wrapped with `agent:` during OpenClaw store ops
(see OpenClaw `session-key.ts:56-63`).

## Environment variables

### OpenClaw infrastructure
| Variable | Purpose |
|----------|---------|
| `OPENCLAW_HTTP_PORT` | Webhook forwarding fallback (default 3000) |
| `CLAWDBOT_GATEWAY_TOKEN` | Gateway auth token fallback |
| `CLAWDBOT_PAIR_PASSWORD` | Mobile pairing password |
| `HOME` | OpenClaw home directory (`~/.openclaw/`) |

### Provider API keys
| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic provider |
| `OPENAI_API_KEY` | OpenAI provider + voice |
| `DEEPSEEK_API_KEY` | DeepSeek provider |
| `GOOGLE_API_KEY` / `GEMINI_API_KEY` | Google/Gemini provider |

### Voice provider keys
| Variable | Purpose |
|----------|---------|
| `ELEVENLABS_API_KEY` / `ELEVENLABS_AGENT_ID` | ElevenLabs voice |
| `CARTESIA_API_KEY` | Cartesia voice |
| `DEEPGRAM_API_KEY` | Deepgram STT |
| `GROQ_API_KEY` | Groq STT |

### Google OAuth
| Variable | Purpose |
|----------|---------|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth secret |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | OAuth refresh |
| `GOOGLE_OAUTH_TOKEN_URI` | OAuth endpoint |
| `GOOGLE_DOCS_TOKEN_PATH` | Token storage path |

### Slack integration
| Variable | Purpose |
|----------|---------|
| `SLACK_BOT_TOKEN` | Slack bot token |
| `GATEWAY_SLACK_SIGNING_SECRET` / `SLACK_SIGNING_SECRET` | Event signature verification |
| `GATEWAY_SLACK_OPENCLAW_WEBHOOK_URL` | Override webhook URL |
| `CLAWTALK_SLACK_PROXY_URL` | Gateway proxy URL for Slack |
| `CLAWTALK_SLACK_DEBUG` | Debug logging toggle |

### Feature flags
| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAWTALK_PROXY_GATEWAY_TOOLS_ENABLED` | `true` | Forward tools to gateway |
| `CLAWTALK_OPENCLAW_NATIVE_GOOGLE_TOOLS_ENABLED` | `true` | Register native Google tools |
| `CLAWTALK_AFFINITY_ENABLED` | `true` | Tool affinity learning |

### Timeout overrides
| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAWTALK_TALK_TTFT_TIMEOUT_MS` | 90s | First-token timeout |
| `CLAWTALK_TALK_TOTAL_TIMEOUT_MS` | 900s | Total tool loop timeout |
| `CLAWTALK_TALK_INACTIVITY_TIMEOUT_MS` | 300s | Inactivity timeout |

---

## Breaking change checklist

Check on each OpenClaw update:

### P0 (production failure)
- Plugin API methods removed/renamed (`registerHttpHandler`, `registerService`, `registerCommand`, `registerTool`)
- Hook event structures changed (`message_received`, `gateway_start`, etc.)
- Session key prefix semantics changed (`talk:` or `job:` no longer classified as `legacy_or_alias`)
- `cfg.models.providers` schema changed (breaks direct provider routing)
- Config lock file path changed (breaks `openclaw-config-lock.ts`)

### P1 (design flaw)
- Config reload rules changed (bindings/agents become hot-reloadable)
- Hook timing changed (e.g. `gateway_start` fires before config is available)
- `message_received` return value honored (would require updating Slack ingress logic)
- `cfg.gateway.auth.token` path changed

### P2 (improvement)
- New hooks added (may enable better Slack integration)
- Slack webhook paths changed
- New provider config fields (could expand direct routing capabilities)
- `api.registerTool()` API changes
