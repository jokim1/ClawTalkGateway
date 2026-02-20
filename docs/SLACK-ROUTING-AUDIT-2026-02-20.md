# Slack Message Routing Audit — ClawTalk System

**Date:** 2026-02-20
**Scope:** ClawTalk (client), ClawTalkGateway (plugin), and their interaction with the OpenClaw host
**Focus:** Repeated errors in Slack message response, dual routing path conflicts

---

## Executive Summary

The ClawTalk Slack integration has a fundamental architectural tension: messages from Slack can be processed by **two independent systems** (OpenClaw's native agent routing and ClawTalkGateway's Talk-based routing), and the coordination between them is fragile. This audit identifies **7 bug categories** causing repeated errors, duplicate responses, and dropped messages.

---

## System Architecture: The Dual Path Problem

When a Slack message arrives, it can be processed through two distinct paths:

```
Slack Message
     │
     ▼
┌──────────────────────────────────────────────────┐
│               OpenClaw Gateway                    │
│                                                    │
│  Path A: OpenClaw Native                           │
│  ─────────────────────                             │
│  1. Slack monitor receives event                   │
│  2. maybeHandoffSlackInbound() → asks Gateway      │
│  3. If NOT handed off → resolveAgentRoute()        │
│  4. dispatchInboundMessage() → LLM via agent       │
│  5. Deliver reply back to Slack                    │
│                                                    │
│  Path B: ClawTalkGateway (Plugin)                  │
│  ────────────────────────────────                  │
│  1. Receives handoff at /api/events/slack          │
│  2. handleSlackIngress() claims or passes          │
│  3. If claimed → find owning Talk                  │
│  4. Process via Talk context + system prompt       │
│  5. Send reply via direct Slack API call           │
│                                                    │
│  Hooks:                                            │
│  • message_received → event-driven jobs            │
│  • message_sending → outbound suppression          │
└──────────────────────────────────────────────────┘
```

The coordination relies on:
- **Inbound handoff** (OpenClaw asks Gateway first, Gateway claims or passes)
- **Outbound suppression** (Gateway's `message_sending` hook can cancel OpenClaw replies)
- **Ownership tracking** (only one Talk should own a Slack channel for writing)

---

## Bug Category 1: Handoff Race Condition — Gateway Claims but Also Gets `message_received`

**Files:** `ClawTalkGateway/src/index.ts` (line 586-596), `ClawTalkGateway/src/slack-ingress.ts`, `ClawTalkGateway/src/event-dispatcher.ts`

**Problem:**
When a Slack message arrives, OpenClaw fires **both** the handoff call AND the `message_received` hook. The plugin registers handlers for both:

```typescript
// index.ts line 586-596
api.on('message_received', async (event, ctx) => {
  if (eventDispatcher) {
    eventDispatcher.handleMessageReceived(event, ctx).catch(...);  // PATH 1
  }
  return handleSlackMessageReceivedHook(event, ctx, buildSlackIngressDeps()).catch(...);  // PATH 2
});
```

Meanwhile, the handoff endpoint also processes the same message:
```
POST /api/events/slack → handleSlackIngress()  // PATH 3
```

**Result:** A single Slack message can trigger **three processing paths simultaneously**:
1. `handleSlackIngress()` via the handoff POST
2. `eventDispatcher.handleMessageReceived()` via the `message_received` hook
3. `handleSlackMessageReceivedHook()` via the same `message_received` hook

If all three fire for the same message, you get duplicate or triple responses.

**Impact:** HIGH — This is likely the primary cause of repeated responses.

**Fix:** The `message_received` hook handler needs to check whether the ingress handler already claimed this message. Add a shared "recently claimed" set with the eventId, and skip event dispatch + ownership hook if the message was already claimed by ingress.

---

## Bug Category 2: Suppression TTL Window Causes Outbound Leaks

**File:** `ClawTalkGateway/src/slack-ingress.ts`

**Problem:**
The outbound suppression mechanism in `handleSlackMessageSendingHook` relies on a time-based TTL (default 120 seconds). The suppression entry is created when the Gateway claims an inbound message, and it blocks OpenClaw's outbound messages for that channel/thread.

However:
1. If the LLM response takes longer than 120 seconds (e.g., complex tool loops), the suppression expires before the Gateway can send its own reply
2. OpenClaw's native agent may have queued a reply that arrives after suppression expires
3. The suppression key matching may not account for thread vs. channel scope differences

**Result:** After 120s, OpenClaw's suppressed reply "leaks through," and the user gets a delayed duplicate.

**Impact:** MEDIUM — Affects long-running responses.

**Fix:**
- Extend suppression TTL dynamically based on whether a Talk response is still in-progress
- Use the Talk's `processing` flag to keep suppression active until the Talk response completes
- Add a cleanup sweep instead of relying solely on TTL

---

## Bug Category 3: Event Dispatcher Binding Match Uses Wrong Field

**File:** `ClawTalkGateway/src/event-dispatcher.ts` (line 111)

**Problem:**
```typescript
// Line 111
if (matchingBinding.platform.toLowerCase() !== ctx.channelId.toLowerCase()) continue;
```

This compares `platform` (e.g., "slack") against `channelId` (e.g., "slack" from OpenClaw's context). This comparison is conceptually correct when OpenClaw passes the platform name as `channelId`, but the naming is confusing and fragile. If OpenClaw ever passes the actual Slack channel ID (like `C01234`) as `channelId`, this match will silently fail and no event jobs will trigger.

Additionally, the binding scope match (line 104-106) uses a simple string comparison:
```typescript
const matchingBinding = bindings.find(
  b => b.scope.toLowerCase() === scope.toLowerCase(),
);
```

But binding scopes in ClawTalk use formats like `channel:C01234` while event job scopes from `parseEventTrigger` may use formats like `#channel-name`. These won't match.

**Impact:** MEDIUM — Event-driven jobs may silently fail to trigger.

**Fix:** Normalize scope formats before comparison. Both `channel:C01234` and `#channel-name` should resolve to the same canonical form.

---

## Bug Category 4: OpenClaw Agent Routing Conflicts with Talk Agents

**Files:** `ClawTalkGateway/src/types.ts` (TalkAgent.openClawAgentId), `ClawTalkGateway/src/talk-chat.ts`, `ClawTalkGateway/src/slack-ingress.ts`

**Problem:**
The `TalkAgent` type has an optional `openClawAgentId` field:
```typescript
export interface TalkAgent {
  name: string;
  model: string;
  role: AgentRole;
  isPrimary: boolean;
  openClawAgentId?: string;  // ← Optional OpenClaw routing
}
```

When ClawTalkGateway processes a Talk message, it calls the OpenClaw gateway's `/v1/chat/completions` endpoint. But OpenClaw has its own agent routing system (`resolveAgentRoute()` in `resolve-route.ts`) that selects an agent based on bindings configuration.

The conflict manifests in several ways:

1. **Model mismatch:** The Talk's agent specifies `model: "anthropic/claude-sonnet-4-5"` but OpenClaw's routing resolves to a different agent with a different default model. The request sends the Talk's model, but OpenClaw may override it based on the resolved agent's configuration.

2. **System prompt collision:** ClawTalkGateway composes a detailed system prompt via `composeSystemPrompt()`, but OpenClaw's agent also has its own system prompt/instructions. When the request goes through `/v1/chat/completions`, both system prompts may be applied, causing confused or contradictory behavior.

3. **Session key divergence:** OpenClaw builds session keys based on its own routing (`buildAgentSessionKey`), but ClawTalkGateway manages Talk sessions independently. The same conversation may have two different session states in OpenClaw vs. the Talk store.

**Impact:** HIGH — This is the "proxy agent routing path vs. openclaw agent routing path" conflict you described.

**Fix:**
- When ClawTalkGateway calls `/v1/chat/completions`, it should either:
  (a) Bypass OpenClaw's agent routing entirely (use a direct LLM provider endpoint), or
  (b) Explicitly set the OpenClaw agent ID in the request headers/params so routing is deterministic
- The `openClawAgentId` field on TalkAgent should be required (not optional) and always used
- Consider adding a `X-ClawTalk-Agent` header that OpenClaw respects to skip its binding resolution

---

## Bug Category 5: Gateway Origin Resolution Inconsistency

**Files:** `ClawTalkGateway/src/index.ts` (multiple locations)

**Problem:**
The gateway origin URL is resolved differently in different contexts:

1. **Job scheduler** (line 537-539):
   ```typescript
   const schedulerOrigin = resolveGatewayOrigin(cfg0, api.logger);
   // Uses Tailscale IP or config bind address
   ```

2. **Talk chat handler** (line 774-776):
   ```typescript
   const selfAddr = req.socket?.localAddress ?? '127.0.0.1';
   const selfPort = req.socket?.localPort ?? 18789;
   const gatewayOrigin = `http://${selfAddr}:${selfPort}`;
   // Uses the incoming request's local socket address
   ```

3. **Slack ingress** (line 936-938):
   ```typescript
   const host = req.headers.host ?? 'localhost:18789';
   const gatewayOrigin = `http://${host}`;
   // Uses the Host header from the request
   ```

4. **Slack ingress deps** (line 494-498):
   ```typescript
   slackIngressOrigin = resolveGatewayOrigin(cfg0, api.logger);
   // Uses Tailscale IP or config bind address
   ```

When the gateway binds to a Tailscale IP (e.g., `100.69.69.108`) but local requests come in on `127.0.0.1`, the self-call from the tool loop or job scheduler may target the wrong address. This was documented in the existing ROOT-CAUSE-ANALYSIS.md as a known issue.

**Impact:** HIGH — LLM calls from the tool loop/scheduler may fail with ECONNREFUSED if the origin doesn't match the actual bind address.

**Fix:** Consolidate all gateway origin resolution into a single function that accounts for both the bind address and listen address. The `req.socket.localAddress` approach (method 2) is actually the most reliable for self-calls since it uses the address the request actually arrived on.

---

## Bug Category 6: Slack Ownership Doctor Detects but Doesn't Remediate

**File:** `ClawTalkGateway/src/slack-ownership-doctor.ts`

**Problem:**
The ownership doctor (`findOpenClawSlackOwnershipConflicts`) correctly identifies when a ClawTalk Talk and an OpenClaw binding both claim the same Slack channel. However:

1. It only **logs warnings** — it never actually resolves the conflict
2. It runs once on startup (with a 2-second delay) and on `gateway_start`, but not when bindings change
3. The routing sync (`reconcileSlackRoutingForTalks`) runs only on init and gateway_start, not when Talk platform bindings are updated via the API

**Result:** When a user adds a Slack channel binding to a Talk, the system may already have an OpenClaw binding for that channel routing to a different agent. Both systems will try to respond.

**Impact:** HIGH — The root cause of dual responses when OpenClaw bindings aren't cleaned up.

**Fix:**
- Run the ownership doctor after every Talk platform binding change (PATCH /api/talks/:id)
- Either auto-remediate (update OpenClaw bindings to route to the ClawTalk agent) or return a warning to the client that the user can act on
- The `reconcileSlackRoutingForTalks` function should be called from the Talk update handler

---

## Bug Category 7: `handleSlackMessageReceivedHook` Processing Overlap

**File:** `ClawTalkGateway/src/slack-ingress.ts`

**Problem:**
The `handleSlackMessageReceivedHook` function (called from the `message_received` hook) has its own Slack message processing logic that runs **independently** from `handleSlackIngress` (called from the handoff endpoint). Both functions:

1. Look up the owning Talk for the channel
2. Check platform behaviors for auto-respond settings
3. May initiate LLM processing for the message
4. May send replies back to Slack

The `message_received` hook fires for **every** message OpenClaw sees, including messages that were already handed off to and claimed by the ingress handler. There's no deduplication between the two paths.

**Impact:** HIGH — This is the most direct cause of double-processing.

**Fix:** Add a message deduplication layer:
- When `handleSlackIngress` claims a message, record its `eventId` in a time-limited set
- When `handleSlackMessageReceivedHook` fires, check this set and skip if already claimed
- Same for the event dispatcher

---

## Additional Issues Found

### Issue A: No Backpressure on Ingress Queue

The Slack ingress uses an in-memory queue (max 1000 items) but has no backpressure mechanism. If messages arrive faster than they can be processed (e.g., during an LLM outage), the queue fills up and subsequent messages are silently dropped.

### Issue B: Retry Logic Can Cause Stale Responses

The ingress retry mechanism (3 attempts, exponential backoff) means a message from 30+ seconds ago may still be retried and responded to. By that point, the conversation may have moved on, and the late response is confusing.

### Issue C: Processing Flag Race

The Talk `processing` flag is set when a response is being generated, but it's not atomic. If two paths (ingress + hook) both check `processing` simultaneously, both may proceed.

### Issue D: Provider Base URL Sync Timing

`reconcileAnthropicProxyBaseUrls` runs on startup but mutates agent config files on disk. If the OpenClaw process is also starting up and reading those files, there's a TOCTOU race.

---

## Recommended Fix Priority

| Priority | Bug | Impact | Effort |
|----------|-----|--------|--------|
| P0 | #1 — Triple-path processing | Duplicate responses | Medium |
| P0 | #7 — Hook/Ingress overlap | Duplicate responses | Medium |
| P0 | #4 — Agent routing conflict | Wrong model/prompt | High |
| P1 | #6 — Ownership not remediated | Dual responses | Medium |
| P1 | #2 — Suppression TTL leak | Late duplicates | Low |
| P1 | #5 — Origin inconsistency | ECONNREFUSED errors | Low |
| P2 | #3 — Event scope mismatch | Jobs don't trigger | Low |

---

## Recommended Architecture Changes

### Short-term (Fix the bugs):

1. **Add message deduplication:** Shared `Set<string>` of recently-processed eventIds with 5-minute TTL, checked by all three processing paths before doing work.

2. **Make ingress authoritative:** When `handleSlackIngress` claims a message, set a flag that the `message_received` hook respects. The hook should only process messages the ingress explicitly passed on.

3. **Fix origin resolution:** Use a single `getGatewayOrigin()` function everywhere, preferring `req.socket.localAddress` for self-calls.

### Medium-term (Architecture improvements):

4. **Direct LLM routing for Talks:** Instead of going through OpenClaw's `/v1/chat/completions` (which applies agent routing), have ClawTalkGateway call the LLM provider directly (or through a dedicated pass-through endpoint that skips agent resolution).

5. **Active ownership enforcement:** When a Talk claims a Slack channel, automatically update OpenClaw's bindings to route that channel to the ClawTalk agent (or a no-op agent), preventing native processing.

6. **Processing lock:** Use a file-based or atomic lock for Talk processing to prevent concurrent responses to the same Talk.

### Long-term (Design considerations):

7. **Unified routing:** Either OpenClaw or ClawTalkGateway should be the single authority for Slack routing, not both. The current hybrid approach is the root cause of most issues.

8. **Event sourcing for messages:** Instead of multiple handlers racing to process messages, use a single inbound queue that dispatches to exactly one handler based on ownership.
