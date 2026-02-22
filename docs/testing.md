# Testing Conventions

Read this when adding or modifying tests. Run tests with `npm test`.

## Framework Setup

- **Jest** with `ts-jest` preset, Node test environment
- Config: `jest.config.ts` — roots `['<rootDir>/src']`, matches `**/__tests__/**/*.test.ts`
- Module name mapper strips `.js` extensions: `'^(\\.{1,2}/.*)\\.js$': '$1'`
- All test files live in `src/__tests__/`

## Mock Patterns

**Logger mock** (used in every test file):
```typescript
const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
```

**`buildDeps()` factory** (for complex dependency bundles, e.g., `slack-ingress.test.ts:44`):
```typescript
function buildDeps() {
  return {
    store,
    registry,
    executor,
    dataDir: tmpDir,
    gatewayOrigin: 'http://127.0.0.1:18789',
    authToken: 'test-token',
    logger: mockLogger,
    sendSlackMessage: jest.fn(async () => true),
  };
}
```

**Module state reset** (for stateful modules like `slack-ingress.ts`):
```typescript
import { __resetSlackIngressStateForTests } from '../slack-ingress';
// Call in both beforeEach and afterEach
```

**Mock call inspection:**
```typescript
const calls = (mockLogger.info as jest.Mock).mock.calls.filter(
  ([msg]) => msg.includes('keyword'),
);
```

## Fixture Patterns

Factory functions with partial overrides using spread:

```typescript
function makeMeta(overrides: Partial<TalkMeta> = {}): TalkMeta {
  const now = Date.now();
  return {
    id: 'test-talk-1',
    talkVersion: 1,
    changeId: 'change-1',
    lastModifiedAt: now,
    pinnedMessageIds: [],
    jobs: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
```

Naming: `makeTalk()`, `makeJob()`, `makeEvent()`, `makeCtx()`, `makeMeta()`, `makeMessage()`, `makeTalkBinding()`. Always use `make` prefix + entity name.

**Temp directory setup/teardown** (for tests that use `TalkStore`):
```typescript
beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'test-prefix-'));
  store = new TalkStore(tmpDir, mockLogger);
  await store.init();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});
```

## Test Structure

- `describe()` blocks: lowercase, clear English — `'Talk CRUD'`, `'routing header guard'`, `'normalizeSlackBindingScope'`
- `it()` / `test()` blocks: present-tense imperative — `'creates a talk with a UUID'`, `'returns null for unknown talk ID'`
- Both `it()` and `test()` are used interchangeably
- Nest `describe` blocks for grouping related cases
- One assertion per `it()` when testing distinct behaviors; multiple assertions okay for testing a single operation's output

## Async Testing

- Use `async`/`await` in test functions — Jest handles returned promises
- For timing-sensitive tests, insert small delays: `await new Promise(r => setTimeout(r, 10))`
- Persist-reload pattern: create data → construct new `TalkStore` from same `tmpDir` → verify data survives reload
- Schedule tests use `Intl.DateTimeFormat` for timezone-aware assertions (`job-scheduler.test.ts:228`)

## Assertion Style

| Matcher | Use for |
|---------|---------|
| `.toBe(x)` | Primitives, exact reference equality |
| `.toEqual(x)` | Deep object/array equality |
| `.toHaveLength(n)` | Array/string length |
| `.toContain(x)` | String substring or array element |
| `.toMatch(/regex/)` | Regex matching (e.g., UUID format) |
| `.toMatchObject({})` | Partial object shape |
| `.toThrow(ErrorClass)` | Exception type verification |
| `.toBeNull()` / `.toBeUndefined()` | Nullish checks |
| `.toBeGreaterThan(n)` | Numeric comparisons |
| `expect.arrayContaining([])` | Subset of array elements |

Prefer specific matchers (`.toHaveLength(2)`) over generic ones (`.toBe(true)` on a length check).

## Coverage Gaps

14 of 37 runtime source files have test coverage (~38%). Priority files for new tests:

| File | Lines | Why |
|------|-------|-----|
| `talks.ts` | 3,132 | Only platform bindings tested; CRUD, jobs, validation untested |
| `talk-chat.ts` | 1,773 | Only automation policy tested; chat flow, tool loop, context injection untested |
| `index.ts` | 1,687 | No tests; route dispatch, pairing, hooks |
| `tool-loop.ts` | 978 | No tests; core tool execution loop |
| `voice.ts` | ~600 | No tests; STT/TTS provider selection |
| `auth.ts` | ~120 | No tests; token validation, localhost fallback |
| `context-updater.ts` | ~200 | No tests; context.md generation |
| `slack-routing-sync.ts` | ~320 | No tests; openclaw.json reconciliation |
