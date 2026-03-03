# ClawTalk on NanoClaw: Web App + Settings Manager + Multi-LLM Plan

Date: March 3, 2026

## Summary
Build a NanoClaw-based ClawTalk web platform with:

1. Web-native ClawTalk UX (talks, chat, sharing, scheduled tasks).
2. A secure web settings manager as the single source of truth for integrations, auth, models, and runtime configuration.
3. Configurable multi-LLM support.
4. Per-installation account model: one owner, optional family members, admin/member roles, private-by-default talks, and explicit sharing.

## Decisions Already Locked

1. Access model: Hybrid (public app features + private admin/settings plane).
2. Identity topology: Local-only on each NanoClaw machine.
3. Auth: Google OAuth.
4. Secrets backend: OS keychain.
5. Talk visibility: Private by default.
6. Upgrade strategy: Build on top of NanoClaw with a minimal patch surface (no long-lived heavy fork).

## Goals and Non-Goals

### Goals

1. Replace OpenClaw plugin complexity with a cohesive NanoClaw-native architecture.
2. Ship a web app that supports ClawTalk flows for owner + family users.
3. Centralize settings and credentials in one auditable admin surface.
4. Add model/provider policy controls with safe defaults and fallbacks.
5. Preserve future NanoClaw upgradeability.

### Non-Goals (v1)

1. Multi-tenant cloud control plane.
2. Internet-exposed admin endpoints.
3. Enterprise IAM/SAML and advanced org hierarchy.
4. Full provider parity from day one.

## Target Architecture

### Runtime Components

1. NanoClaw Core Runtime: Existing message loop, scheduler, container runner, IPC.
2. ClawTalk Web API Module: REST + streaming API for browser clients.
3. Web Channel Adapter: Bridges browser traffic into NanoClaw group/message semantics.
4. Settings Control Plane: Schema-validated config state + keychain secret refs.
5. Multi-LLM Router: Provider/model policy resolution and runtime model selection.
6. Web Frontend: End-user ClawTalk UI + private admin settings UI.

### Network Zones

1. Public zone:
   - Chat and talk APIs.
   - User-facing web app.
2. Private zone (Tailnet/local network only):
   - Settings and credential APIs.
   - User role administration.
3. Defense in depth:
   - Network-gated admin paths.
   - RBAC-gated admin mutations.

### Domain Strategy

1. Product domain suggestion: `clawtalk.app`.
2. Machine endpoint can use a user-custom domain (for example `home.clawtalk.app`).
3. Admin endpoint stays private (for example Tailnet hostname).

## Upgrade-Friendly Integration Strategy

### Patch Surface (Keep Small)

Limit core edits to:

1. `nanoclaw/src/index.ts`
2. `nanoclaw/src/types.ts`
3. `nanoclaw/src/db.ts`
4. `nanoclaw/src/ipc.ts`
5. `nanoclaw/src/container-runner.ts`
6. `nanoclaw/src/channels/index.ts`

### New Isolated Modules

Add mostly-new modules instead of expanding core files:

1. `nanoclaw/src/web/server.ts`
2. `nanoclaw/src/web/routes-auth.ts`
3. `nanoclaw/src/web/routes-talks.ts`
4. `nanoclaw/src/web/routes-settings.ts`
5. `nanoclaw/src/web/rbac.ts`
6. `nanoclaw/src/channels/web.ts`
7. `nanoclaw/src/llm/router.ts`
8. `nanoclaw/src/llm/providers/*`
9. `nanoclaw/src/secrets/keychain.ts`
10. `nanoclaw/webapp/*`

### Upstream Sync Process

1. Maintain an integration diff with clear boundaries.
2. Rebase frequently onto upstream NanoClaw.
3. Run compatibility tests after each rebase.
4. Avoid scope creep into unrelated NanoClaw internals.

## Public Interfaces and Data Model

### Core Type Additions

Add to `nanoclaw/src/types.ts`:

```ts
export type UserRole = 'owner' | 'admin' | 'member';
export type TalkAccessRole = 'owner' | 'editor' | 'viewer';
export type TalkVisibility = 'private' | 'shared';

export interface LlmModelRef {
  providerId: string;
  modelId: string;
}

export interface LlmPolicy {
  primary: LlmModelRef;
  fallback?: LlmModelRef;
  maxBudgetUsd?: number;
  maxTurns?: number;
  temperature?: number;
}

export interface RegisteredGroup {
  // existing fields...
  llmPolicy?: LlmPolicy;
}
```

### DB Schema Additions

Add migrations in `nanoclaw/src/db.ts`:

1. `users`
2. `web_sessions`
3. `talks`
4. `talk_members`
5. `provider_configs`
6. `model_catalog`
7. `group_llm_policies`
8. `settings_state`
9. `audit_log`

Also add a JSON `llm_policy` field to `registered_groups`.

### v1 API Surface

#### Auth + Session

1. `POST /api/v1/auth/google/start`
2. `GET /api/v1/auth/google/callback`
3. `POST /api/v1/auth/logout`
4. `GET /api/v1/session/me`

#### Talks + Messaging

1. `GET /api/v1/talks`
2. `POST /api/v1/talks`
3. `GET /api/v1/talks/:talkId`
4. `POST /api/v1/talks/:talkId/messages`
5. `GET /api/v1/talks/:talkId/messages`
6. `POST /api/v1/talks/:talkId/share`
7. `DELETE /api/v1/talks/:talkId/share/:userId`

#### Settings (Private + Admin)

1. `GET /api/v1/settings/providers`
2. `PUT /api/v1/settings/providers/:providerId`
3. `GET /api/v1/settings/models`
4. `PUT /api/v1/settings/groups/:groupId/llm-policy`
5. `GET /api/v1/settings/users`
6. `POST /api/v1/settings/users/invite`
7. `PATCH /api/v1/settings/users/:userId/role`

### IPC Extension

Extend `register_group` payload in `nanoclaw/src/ipc.ts` to accept optional `llmPolicy`.

## Security and Permission Model

### Identity + Account Binding

1. One installation has one owner.
2. First-login claim flow binds owner account to the machine.
3. Owner/admin can invite family users.
4. Sessions use short-lived access + rotating refresh tokens.

### RBAC

1. Owner: full control, including role assignment.
2. Admin: settings and operations management (no ownership transfer).
3. Member: talk usage only, no settings mutation.

### Talk ACL

1. New talks are private by default.
2. Owners can share talks per user.
3. Shared users get viewer/editor access.
4. Every talk endpoint enforces ACL checks.

### Secrets

1. Secret values are not stored plaintext in SQLite.
2. SQLite stores keychain references + metadata only.
3. Secrets are loaded just-in-time at execution.
4. All settings mutations are audit logged.

### Hybrid Boundary Rules

1. Admin/settings endpoints require private-network access.
2. Admin/settings endpoints also require owner/admin role.
3. Public APIs never return secret values.

## Settings Manager as Single Source of Truth

### Managed Settings Scope

1. Provider endpoints, credentials, model lists.
2. Group/talk model policies and fallback rules.
3. Channel integration credentials and status.
4. User roles and invite lifecycle.
5. Runtime defaults for ClawTalk behavior.

### Settings Write Pipeline

1. Validate payload against central schema.
2. Apply atomic update: DB metadata + keychain write + audit event.
3. Trigger runtime reload hook for affected subsystems.

### Migration from OpenClaw-style Config

1. Import utility reads existing env/config values.
2. UI displays conflicts and missing values for confirmation.
3. After cutover, settings UI becomes authoritative.

## Multi-LLM Delivery Strategy

### Adapter Contract

Define `ProviderAdapter` with:

1. `validateConfig()`
2. `listModels()`
3. `invoke()`
4. `normalizeUsage()`
5. `classifyError()`

### Delivery Phases

1. Phase A: Claude SDK + Anthropic-compatible endpoint model selection/fallback.
2. Phase B: Add native adapters (OpenAI-compatible, Gemini) as needed.
3. Phase C: Per-talk/per-agent override controls in UI.

### Policy Resolution Order

1. Talk override.
2. Group override.
3. User default.
4. Installation default.

### Failure and Fallback

1. Retry transient errors once.
2. Fallback model on primary provider/model failure.
3. Emit structured fallback event and audit entry.
4. Surface fallback usage in UI metadata.

## Implementation Phases

### Phase 0: Foundation (Week 1)

1. Web server scaffold + route framework.
2. DB migration plumbing for new tables.
3. Keychain abstraction and health checks.
4. Public/private path middleware.

### Phase 1: Identity and Family Accounts (Week 2)

1. Google OAuth local callback flow.
2. Owner claim flow.
3. Invite flow for admin/member family accounts.
4. Session management + RBAC middleware.

### Phase 2: Web ClawTalk UX (Weeks 3-4)

1. Web channel adapter and message pipeline integration.
2. Talk CRUD + message history APIs.
3. Private/shared talk UX in web app.
4. ACL enforcement and tests.

### Phase 3: Settings Manager (Weeks 4-5)

1. Provider/model/integration settings APIs.
2. Private admin UI for settings + roles.
3. Runtime reload hooks.
4. Remove dependency on ad hoc JSON/env editing for managed settings.

### Phase 4: Multi-LLM Routing (Weeks 5-7)

1. Provider config UI and model catalog.
2. Group/talk LLM policy assignment.
3. Runtime routing + fallback integration.
4. Usage and cost telemetry surface.

### Phase 5: Hardening and Rollout (Week 8)

1. Security review (session, CORS/CSRF, secrets boundaries).
2. Load and soak tests.
3. Upstream NanoClaw rebase compatibility run.
4. Runbook + backup/restore documentation.

## Test Plan

### Auth and Roles

1. First owner claim succeeds exactly once.
2. Invite + acceptance flow by role works.
3. Role downgrade removes admin mutation privileges.
4. Logout invalidates refresh chain.

### Talk Privacy and Sharing

1. Private talks are inaccessible to non-owners.
2. Shared viewer can read but not write.
3. Shared editor can read/write.
4. Share removal is enforced immediately.

### Settings and Secrets

1. Provider secrets persist in keychain, not DB plaintext.
2. Admin routes blocked from public zone.
3. Member role cannot mutate settings.
4. All settings writes produce audit records.

### Multi-LLM Routing

1. Group policy primary model is used.
2. Forced primary failure triggers fallback.
3. Invalid model config rejected by schema.
4. Usage metadata is normalized and stored.

### NanoClaw Compatibility

1. Existing channel workflows remain functional.
2. Scheduler and IPC permission checks remain intact.
3. Runtime behavior unchanged for non-web users.
4. Rebase compatibility suite passes on upstream updates.

## Rollout and Operations

### Deployment

1. Start with one household machine as canary.
2. Enable public user routes and private admin routes.
3. Monitor auth failures, fallback rate, and settings mutation errors.

### Backup

1. Daily backup of `store/messages.db`.
2. Daily backup of `groups/` and `data/sessions/`.
3. Document keychain rehydration steps for disaster recovery.

### Observability

1. Structured logs for auth, ACL denials, settings writes, routing decisions.
2. Metrics: API latency, fallback frequency, token/cost trends, invite failures.
3. Alerts on repeated auth failures and provider outage patterns.

## Key Trade-Offs

1. Local-only identity is simpler and private, but less turnkey for remote multi-home machine management.
2. Hybrid network model reduces blast radius for admin paths, but adds deployment complexity.
3. Minimal patch surface improves upgradeability, but requires strict engineering discipline.
4. Phased multi-LLM rollout lowers risk, but delays full provider parity.

## Open Decisions for Next Design Round

1. Final frontend stack and component system for the web app.
2. Exact session token strategy (cookie-only vs split token model) under local-only constraints.
3. Invite acceptance UX for non-admin family members.
4. Whether to allow per-message model override in v1 or defer to v2.
