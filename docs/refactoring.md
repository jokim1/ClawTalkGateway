# Code Quality Guide

Read this when writing new code, refactoring existing modules, or reviewing pull requests. All examples reference actual source locations.

## Normalize Pattern

Type guard → trim/lowercase → validate → default. Used extensively in `talk-store.ts` and `talks.ts`.

**Template:**
```typescript
function normalizeXxx(raw: unknown): ValidType {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'a' || value === 'b' || value === 'c') return value;
  return 'a'; // default
}
```

**Examples from `talk-store.ts:112-175`:**
- `normalizePermission()` — string → `'read' | 'write' | 'read+write'`, default `'read+write'`
- `normalizeToolMode()` — string → `'off' | 'confirm' | 'auto'`, default `'auto'`
- `normalizeResponseMode()` — string → `'off' | 'mentions' | 'all' | undefined`
- `normalizeExecutionMode()` — string → `'openclaw' | 'full_control'`, migrates old values (`unsandboxed` → `full_control`, `inherit`/`sandboxed` → `openclaw`)
- `normalizeAllowedSenders()` — array with trim + lowercase dedup + empty filtering

**Composite variant** (`talk-store.ts:243-273`): `normalizeStatePolicy()` composes multiple field-level normalizations with bounds checking (e.g., `Math.max(0, Math.min(6, weekStartDay))`).

## Result Type Pattern

Discriminated union for expected failures. Return `{ ok: false; error }` instead of throwing.

**From `talks.ts:50-63`:**
```typescript
type PlatformBindingsValidationResult =
  | { ok: true; bindings: PlatformBinding[]; ownershipKeys: string[] }
  | { ok: false; error: string };
```

Also used in: `talk-store.ts:877` (migration), `voice.ts:492,530` (provider selection), `file-upload.ts:117` (upload validation), `tool-catalog.ts:216,231` (catalog operations).

**When to use:** Input validation, multi-step operations where partial failure is expected, anything that calls an external system.

## Context Object Pattern

Dependencies bundled into typed context objects, passed explicitly to handlers.

**`HandlerContext`** (`types.ts:61-68`) — HTTP-level: req, res, url, cfg, pluginCfg, logger. Used by all route handlers.

**`TalkChatContext`** (`talk-chat.ts:524-535`) — Talk-specific: talkId, store, gatewayOrigin, authToken, logger, registry, executor, dataDir. Used by chat processing.

The two contexts serve different layers. Route handlers receive `HandlerContext` and construct a `TalkChatContext` for business logic.

## Module Boundaries

| Layer | Responsibility | Example modules |
|-------|---------------|-----------------|
| HTTP / presentation | Parse request, format response, CORS, auth | `http.ts`, `auth.ts`, `talks.ts` (route dispatch) |
| Business logic | Validation, normalization, orchestration | `talk-chat.ts`, `system-prompt.ts`, `talk-policy.ts` |
| Data access | Read/write files, Talk storage, tool catalog | `talk-store.ts`, `tool-catalog.ts`, `tool-registry.ts` |

A function should not cross layers. `talk-store.ts` never formats HTTP responses; `talks.ts` route handlers delegate validation to normalize functions rather than implementing it inline.

## Error Handling Conventions

| Strategy | When | Example |
|----------|------|---------|
| `throw` | Programmer error, invariant violation | `assertRoutingHeaders()` in `routing-headers.ts` throws `RoutingGuardError` |
| Result type | Expected failure, caller decides how to handle | `normalizeJobOutputInput()` returns `{ ok: false; error }` |
| Fire-and-forget | Background ops where failure is acceptable | `void reconcileSlackRouting(...).catch(err => log.warn(...))` |
| `.unref()` | Timers/intervals that shouldn't block process exit | `proxy.ts:189`, `job-scheduler.ts:141` |

**Pattern for fire-and-forget:**
```typescript
void someAsyncOp().catch(err => {
  logger.warn(`Context: ${err}`);
});
```

Never use empty `.catch(() => {})` for new code — always log at `warn` level.

## Import Conventions

- Node built-ins: `from 'node:http'`, `from 'node:crypto'`
- Local modules: `from './module.js'` (always `.js` extension, even for `.ts` sources — ES module resolution)
- Type-only imports: `import type { Foo } from './types.js'`
- Named imports preferred over default imports
- No barrel files (`index.ts` re-exports)

## When to Extract vs Inline

- **2 call sites**: Keep duplicated unless the logic is complex (>10 lines) or likely to diverge
- **3+ call sites with identical patterns**: Extract to a shared utility
- **Same file**: Extract a local helper function
- **Cross-file**: Create a shared module (e.g., move `sanitizeSessionPart` out of both `talk-chat.ts` and `job-scheduler.ts`)

## Known Anti-Patterns to Fix

1. **Duplicate `sanitizeSessionPart`** — Identical function in `talk-chat.ts:393` and `job-scheduler.ts:70`. Extract to a shared session utility.

2. **Duplicate `normalizeAccountId`** — Identical function (with `DEFAULT_ACCOUNT_ID`) in `slack-routing-sync.ts:36` and `slack-ownership-doctor.ts:22`. Extract to `slack-auth.ts`.

3. **Gateway origin resolution scattered** — Three strategies in `index.ts:176-245` (Tailscale Funnel URL, Tailscale IP for internal calls, localhost fallback). Used by scheduler, Slack ingress, and Talk chat with subtle differences.

4. **Loose config types** — `HandlerContext.cfg` is `Record<string, any>` (`types.ts:65`). Should be a typed interface matching the actual config shape.

5. **Large monolithic files** — `talks.ts` (3,132 lines), `talk-chat.ts` (1,773 lines), `talk-store.ts` (1,891 lines). Consider splitting by concern (e.g., separate job CRUD from Talk CRUD in `talks.ts`).

## SOLID in This Codebase

| Principle | Concrete mapping |
|-----------|-----------------|
| Single Responsibility | Each `src/*.ts` file owns one subsystem. `talk-store.ts` = storage, `system-prompt.ts` = prompt composition, `talk-policy.ts` = execution mode policy. |
| Open/Closed | Normalize functions accept unknown input and produce valid typed output — new valid values are added to the union, callers don't change. |
| Liskov Substitution | Not heavily used — composition over inheritance throughout. |
| Interface Segregation | `HandlerContext` vs `TalkChatContext` — each consumer gets only the dependencies it needs. |
| Dependency Inversion | `TalkStore`, `ToolRegistry`, `ToolExecutor` are passed as constructor/function params, not imported as singletons. Logger is always injected. |
