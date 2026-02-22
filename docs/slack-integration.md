# Slack Integration Guide

Read this when touching any `slack-*.ts` file, modifying hooks/bindings, or debugging Slack message routing.

## Message Flow

The gateway is a **context provider**, not a parallel message processor. OpenClaw's managed agent handles Slack replies natively.

```
Slack message arrives
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

- **`buildManagedAgentId(talkId)`** — `slack-routing-sync.ts:27` — Generates the `ct-` prefixed ID
- **`isManagedAgentId(agentId)`** — `slack-routing-sync.ts:32` — Checks for `ct-` prefix
- Agent config written to `agents.list` in `openclaw.json`
- Each agent uses the Talk's configured model
- Agent name defaults to `talk.topicTitle` or `"ClawTalk ct-<shortId>"`
- Optional `skills` array propagated from Talk config

**Do not** manually create agents with the `ct-` prefix — they will be overwritten by routing sync.

## Delegation Model

When a Slack message arrives for a Talk-bound channel:

1. `routeSlackIngressEvent()` (`slack-ingress.ts:556`) resolves ownership via binding scoring
2. Returns `decision='pass'` with `reason='delegated-to-agent'`
3. No gateway LLM call, no suppression, no queue
4. OpenClaw processes the message through its managed agent
5. Gateway's `before_agent_start` hook injects Talk context (~2KB)

**Ownership scoring** (`slack-ingress.ts:294-340`): Direct channel ID match scores 100, outbound target 95, `#channel-name` match 90, wildcard `slack:*` scores 10. Highest score wins.

**Behavior filtering** (`slack-ingress.ts:497-546`): After ownership resolves, `shouldHandleViaBehavior()` checks `allowedSenders`, `responseMode` (off/mentions/all), and `triggerPolicy` (study_entries_only, advice_or_study, judgment).

## Binding Sync

`reconcileSlackRoutingForTalks()` in `slack-routing-sync.ts:170-316` writes to `openclaw.json`:

1. **Bindings** — Managed bindings (`ct-*` agents) placed at front of `cfg.bindings` array
2. **Agents** — `ManagedAgent` entries in `agents.list` with model, sandbox mode, skills
3. **Channel settings** — `requireMention` flag and `systemPrompt` per channel under `channels.slack.accounts.{accountId}.channels.{CHANNEL_ID}`
4. **Signing secrets** — Propagated from env var or base config to per-account settings

**Runs at:** Startup (`index.ts:816`), Talk creation (`talks.ts:1537`), Talk update (`talks.ts:1988,2225`), Talk deletion (`talks.ts:2255`). Mutations are fire-and-forget (`void reconcile...`).

**Atomic write:** Uses temp file + rename for crash safety.

## File Responsibilities

| File | Purpose |
|------|---------|
| `slack-ingress.ts` | Inbound event handling: ownership resolution, delegation, message mirroring |
| `slack-routing-sync.ts` | Reconciles Talk bindings → OpenClaw managed agents and bindings in `openclaw.json` |
| `slack-ownership-doctor.ts` | Detects Talk/OpenClaw binding ownership conflicts (detection-only, no auto-fix) |
| `slack-event-proxy.ts` | Slack Events API entry point: receives all events, routes to ingress or forwards to OpenClaw |
| `slack-auth.ts` | Multi-account token resolution, signing secret template expansion, account ID listing |
| `slack-proxy-setup.ts` | Detects setup gaps and logs guided onboarding instructions |
| `event-dispatcher.ts` | Triggers event-driven jobs from OpenClaw `message_received` hook |

## Debug Infrastructure

Set `CLAWTALK_SLACK_DEBUG=1` to enable debug recording.

- Ring buffer stores up to 200 recent entries (`index.ts:105-137`)
- Each entry tracks: phase, failure phase, talk ID, event ID, account ID, channel resolution, timing, errors
- Optional `CLAWTALK_SLACK_DEBUG_INSTANCE_TAG=<tag>` overrides auto-computed instance ID (default: `hostname:pid:boot-timestamp`)
- Function: `recordSlackDebug()` (`index.ts:126-137`)

## Known Issues

| Issue | Severity | Status |
|-------|----------|--------|
| Ownership doctor detection-only, no auto-remediation | Medium | Open |
| Routing sync runs at startup + Talk mutations, but OpenClaw doesn't hot-reload bindings | Medium | Open |
| Gateway-installed tools (state_*, google_docs_*) not available in managed agent sessions | Low | Open |
| Context.md not auto-updated by managed agent (agent can self-maintain via Write) | Low | Open |
