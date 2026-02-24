# Slack Integration Guide

Read this when touching any `slack-*.ts` file, modifying hooks/bindings, or debugging Slack message routing.

## Architecture

The gateway is a **context provider**, not a parallel message processor. OpenClaw's managed agent handles Slack replies natively.

### Connection Mode

All Slack accounts must use **socket mode** (the default). Socket mode opens an outbound WebSocket to Slack and works behind NAT/firewalls without a public URL.

`ensureSlackSocketMode()` in `slack-proxy-setup.ts` runs at startup and auto-corrects any account set to `mode: "http"` back to socket mode (if an app token is available). HTTP mode requires a publicly reachable webhook URL, which silently fails behind NAT/Tailscale.

Each account needs in `openclaw.json`:
- `botToken` — Bot User OAuth Token (`xoxb-...`)
- `appToken` — App-Level Token (`xapp-...`, required for socket mode)

### Message Flow

```
Slack message arrives (via socket mode WebSocket)
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

## Managed Agents

Each Talk with Slack write bindings gets a managed agent with ID `ct-<first 8 chars of Talk UUID>`.

- Managed agent IDs are detected by the `ct-` prefix (`gateway-origin.ts:90`)
- Agent config is **manually maintained** in `agents.list` in `openclaw.json`
- Each agent uses the Talk's configured model
- Agent name defaults to `talk.topicTitle` or `"ClawTalk ct-<shortId>"`
- Optional `skills` array propagated from Talk config

**Do not** use the `ct-` prefix for non-Talk agents — `resolveClawTalkAgentIds()` uses this prefix to identify Talk-managed agents.

## Delegation Model

When a Slack message arrives for a Talk-bound channel:

1. `routeSlackIngressEvent()` (`slack-ingress.ts`) resolves ownership via binding scoring
2. Returns `decision='pass'` with `reason='delegated-to-agent'`
3. No gateway LLM call, no suppression, no queue
4. OpenClaw processes the message through its managed agent
5. Gateway's `before_agent_start` hook injects Talk context (~2KB)

**Ownership scoring** (`slack-ingress.ts`): Direct channel ID match scores 100, outbound target 95, `#channel-name` match 90, wildcard `slack:*` scores 10. Highest score wins.

**Behavior filtering** (`slack-ingress.ts`): After ownership resolves, `shouldHandleViaBehavior()` checks `allowedSenders`, `responseMode` (off/mentions/all), and `triggerPolicy` (study_entries_only, advice_or_study, judgment).

## Manual Binding Setup

Managed agents and bindings in `openclaw.json` are **manually configured** (no automated sync). When adding a Talk with Slack bindings:

1. **Agent** — Add a `ct-<first 8 chars of Talk UUID>` entry to `agents.list` with the Talk's model
2. **Binding** — Add a binding entry matching the Slack account + channel to the `ct-` agent
3. **Channel settings** — Set `requireMention` and optional `systemPrompt` under `channels.slack.accounts.{accountId}.channels.{CHANNEL_ID}`

Config changes require a gateway restart (`openclaw gateway restart`).

## File Responsibilities

| File | Purpose |
|------|---------|
| `slack-ingress.ts` | Inbound event handling: ownership resolution, delegation, message mirroring |
| `slack-event-proxy.ts` | Slack Events API entry point: receives all events, routes to ingress or forwards to OpenClaw |
| `slack-auth.ts` | Multi-account token resolution, signing secret template expansion, account ID listing |
| `slack-proxy-setup.ts` | Detects setup gaps, logs onboarding instructions, auto-corrects socket mode |
| `slack-reply.ts` | Direct Slack API message sending |
| `slack-scope-resolver.ts` | Resolves Slack scope strings (channel names, IDs) |
| `slack-debug.ts` | Debug recording ring buffer for Slack event tracing |
| `event-dispatcher.ts` | Triggers event-driven jobs from OpenClaw `message_received` hook |
| `gateway-origin.ts` | Resolves ClawTalk agent IDs (including `ct-*` managed agents) |

## Debug Infrastructure

Set `CLAWTALK_SLACK_DEBUG=1` to enable debug recording.

- Ring buffer stores up to 200 recent entries (`index.ts`)
- Each entry tracks: phase, failure phase, talk ID, event ID, account ID, channel resolution, timing, errors
- Optional `CLAWTALK_SLACK_DEBUG_INSTANCE_TAG=<tag>` overrides auto-computed instance ID (default: `hostname:pid:boot-timestamp`)

## Known Issues

| Issue | Severity | Status |
|-------|----------|--------|
| Managed agents/bindings manually configured in openclaw.json | Medium | Open |
| OpenClaw doesn't hot-reload bindings after config changes | Medium | Open |
| Gateway-installed tools (state_*, google_docs_*) not available in managed agent sessions | Low | Open |
| Context.md not auto-updated by managed agent (agent can self-maintain via Write) | Low | Open |
