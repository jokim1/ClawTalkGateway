# ClawTalkGateway

OpenClaw plugin: HTTP endpoints for ClawTalk (terminal) and ClawTalkMobile (iOS). Provider discovery, rate-limit tracking, voice I/O, Talks (persistent conversations), scheduled jobs, Slack integration, and mobile pairing.

## Build

```bash
npm install
npm run build    # tsc → dist/
npm run dev      # tsc --watch
npm test         # run tests
```

Requires Node 20+. Voice features require at minimum `OPENAI_API_KEY`.

## Codebase Patterns

1. **Context bundling** — `HandlerContext` (`types.ts:61`) bundles HTTP deps (req/res/url/cfg/logger). `TalkChatContext` (`talk-chat.ts:524`) bundles Talk-specific deps (store/registry/executor). All dependencies passed explicitly, never imported as globals.

2. **Result types** — `{ ok: true; data } | { ok: false; error }` discriminated unions for expected failures. See `talks.ts:50-63` for examples. Use instead of throwing for validation and multi-step operations.

3. **Normalize pattern** — Type guard → trim/lowercase → validate → return valid value or default. ~20 functions in `talk-store.ts:112-273` and `talks.ts:145-408`. Template: `const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''; if (isValid(value)) return value; return default;`

4. **Fire-and-forget async** — `void someOp().catch(err => log.warn(...))` for background work. `.unref()` on all intervals/timers to avoid blocking process exit.

5. **Session key prefixes** — `talk:` prefix for chat sessions (`buildTalkSessionKey` in `session-key.ts`), bypasses OpenClaw's embedded agent. `job:` prefix for scheduler (`buildTalkJobSessionKey` in `session-key.ts`).

6. **Talk data storage** — Flat files under `~/.openclaw/plugins/clawtalk/talks/<id>/`: `talk.json` (metadata), `history.jsonl` (messages), `context.md` (AI-maintained), `reports.jsonl` (job reports), `state/` and `affinity/` subdirs.

## Engineering Principles

1. **Single responsibility + explicit naming** — Each module does one thing. If a function name needs "and", split it. If a reader can't understand it from name + signature, rename it.
2. **Pass dependencies in, no hidden globals** — Constructor/function params, not module-level singletons. Logger is always injected.
3. **Extract at 3+ call sites, not 2** — Duplication is cheaper than the wrong abstraction. Two similar blocks are fine.
4. **Separate layers** — HTTP presentation (`http.ts`, `talks.ts` route dispatch) / business logic (`talk-chat.ts`, `talk-policy.ts`) / data access (`talk-store.ts`, `tool-catalog.ts`). A function should not cross layers.
5. **Verify against OpenClaw source** — Read actual code before implementing integrations. Do not assume behavior from naming or docs.
6. **Issue reporting: P0/P1/P2** — P0 (production failure), P1 (design flaw), P2 (improvement). Surface all P0s, never cap counts.

## Critical Warnings

1. **The `message_received` hook return value is IGNORED by OpenClaw.** Do not rely on `{ cancel: true }` to prevent message delivery. The hook is fire-and-forget (`runVoidHook`).
2. **The `ctx.channelId` in OpenClaw's `message_received` hook is the platform name** (e.g., "slack"), not a Slack channel ID. Don't confuse it with the Slack channel ID in `SlackIngressEvent.channelId`.
3. **All execution uses full_control mode.** The embedded agent (OpenClaw) path is removed. Session keys use `talk:` prefix (no `agent:` prefix), classified as `legacy_or_alias` by OpenClaw. Do not set `x-openclaw-agent-id` header.

## Context Files

Read these on-demand when working in a specific area:

| File | Read when... |
|------|-------------|
| `docs/architecture.md` | Navigating modules, routes, execution modes, config, auth, data layout |
| `docs/refactoring.md` | Writing new code, refactoring, reviewing — patterns, anti-patterns, SOLID mapping |
| `docs/slack-integration.md` | Touching `slack-*.ts` files, hooks, bindings, managed agents |
| `docs/testing.md` | Adding or modifying tests — mocks, fixtures, conventions, coverage gaps |
| `docs/openclaw-compatibility-surface.md` | Updating OpenClaw, checking config/hook/API dependencies |

## Related Projects

- **ClawTalk** — Terminal TUI client
- **ClawTalkMobile** — iOS client
- **OpenClaw** — The host server this plugin extends
