import { randomUUID } from 'node:crypto';
import type { TalkStore } from './talk-store.js';
import type { ToolExecutor } from './tool-executor.js';
import type { ToolRegistry } from './tool-registry.js';
import type {
  HandlerContext,
  Logger,
  PlatformBinding,
  TalkMessage,
  TalkMeta,
} from './types.js';
import { readJsonBody, sendJson } from './http.js';
import { buildManagedAgentId } from './slack-routing-sync.js';

const EVENT_TTL_MS = 6 * 60 * 60_000;
const SLACK_DEFAULT_ACCOUNT = 'default';

export type SlackIngressEvent = {
  eventId: string;
  accountId?: string;
  channelId: string;
  channelName?: string;
  threadTs?: string;
  messageTs?: string;
  userId?: string;
  userName?: string;
  /**
   * Expected OpenClaw outbound target for this conversation (e.g. channel:C123, user:U123).
   * Used for Talk ownership resolution via binding scope matching.
   */
  outboundTarget?: string;
  text: string;
};

type SeenDecision = {
  ts: number;
  decision: 'handled' | 'pass';
  talkId?: string;
  reason?: string;
};


type SlackIngressTalkCounters = {
  passed: number;
};

export type SlackIngressTalkRuntimeSnapshot = {
  talkId: string;
  counters: SlackIngressTalkCounters;
};

export type SlackIngressDeps = {
  store: TalkStore;
  registry: ToolRegistry;
  executor: ToolExecutor;
  dataDir?: string;
  gatewayOrigin: string;
  authToken: string | undefined;
  logger: Logger;
  /**
   * Optional direct Slack sender. When provided, replies bypass OpenClaw outbound hooks.
   */
  sendSlackMessage?: (params: {
    accountId?: string;
    channelId: string;
    threadTs?: string;
    message: string;
  }) => Promise<boolean>;
  /**
   * Set false in tests to enqueue ownership decisions without running the async queue.
   */
  autoProcessQueue?: boolean;
  /** Enables compact debug diagnostics in failure notices. */
  debugEnabled?: boolean;
  /** Optional stable runtime identifier for diagnostics. */
  instanceTag?: string;
  /** Optional callback for Slack debug diagnostics. */
  recordSlackDebug?: (entry: {
    path: 'slack-ingress';
    phase: string;
    failurePhase?: string;
    attempt?: number;
    attemptToken?: string;
    elapsedMs?: number;
    talkId?: string;
    eventId?: string;
    accountId?: string;
    channelIdRaw?: string;
    channelIdResolved?: string;
    threadTs?: string;
    errorCode?: string;
    errorMessage?: string;
  }) => void;
};


export type SlackOwnershipDecision = {
  decision: 'handled' | 'pass';
  eventId: string;
  talkId?: string;
  reason?: string;
  duplicate?: boolean;
};

export type SlackOwnershipInspection = {
  decision: 'handled' | 'pass';
  talkId?: string;
  reason?: string;
  bindingId?: string;
  behaviorAgentName?: string;
  behaviorOnMessagePrompt?: string;
  behaviorMirrorToTalk?: 'off' | 'inbound' | 'full';
  behaviorDeliveryMode?: 'thread' | 'channel' | 'adaptive';
  behaviorIntent?: 'study' | 'advice' | 'other';
};

export type MessageReceivedHookEvent = {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};

export type MessageHookContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};


export type MessageReceivedHookResult = { cancel: true } | undefined;

const seenEvents = new Map<string, SeenDecision>();
const runtimeCountersByTalkId = new Map<string, SlackIngressTalkCounters>();


function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function normalizeTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const slackScoped = trimmed.match(/^(?:slack:)?(channel|user):(.+)$/i);
  if (slackScoped?.[1] && slackScoped?.[2]) {
    const kind = slackScoped[1].toLowerCase();
    const rawId = slackScoped[2].trim();
    if (!rawId) return undefined;
    return `${kind}:${rawId.toLowerCase()}`;
  }

  const directId = trimmed.match(/^(?:slack:)?([a-z0-9]+)$/i);
  if (directId?.[1]) {
    const id = directId[1];
    if (/^u/i.test(id)) {
      return `user:${id.toLowerCase()}`;
    }
    return `channel:${id.toLowerCase()}`;
  }

  return trimmed.toLowerCase();
}

function parseSlackTargetId(target: string | undefined): string | undefined {
  const normalized = normalizeText(target);
  if (!normalized) return undefined;
  if (normalized.includes(':')) {
    const parts = normalized.split(':');
    const maybeId = parts[parts.length - 1]?.trim();
    return maybeId || undefined;
  }
  return normalized;
}

function parseSlackFromId(from: string | undefined): string | undefined {
  const normalized = normalizeText(from);
  if (!normalized) return undefined;
  const parts = normalized.split(':');
  if (parts.length >= 3) {
    return parts.slice(2).join(':') || undefined;
  }
  if (parts.length === 2) {
    return parts[1] || undefined;
  }
  return undefined;
}

function buildDefaultOutboundTarget(channelId: string): string {
  return `channel:${channelId}`;
}


function getTalkCounters(talkId: string): SlackIngressTalkCounters {
  const existing = runtimeCountersByTalkId.get(talkId);
  if (existing) return existing;
  const initial: SlackIngressTalkCounters = { passed: 0 };
  runtimeCountersByTalkId.set(talkId, initial);
  return initial;
}


function pruneSeenEvents(now = Date.now()): void {
  for (const [key, value] of seenEvents) {
    if (now - value.ts > EVENT_TTL_MS) {
      seenEvents.delete(key);
    }
  }
}


function buildEventId(input: {
  channelId: string;
  accountId?: string;
  messageTs?: string;
  threadTs?: string;
  userId?: string;
}): string {
  const base = [
    'slack',
    input.accountId ?? 'default',
    input.channelId,
    input.messageTs ?? input.threadTs ?? 'unknown',
    input.userId ?? 'unknown',
  ];
  return base.join(':');
}

export function parseSlackIngressEvent(raw: unknown): SlackIngressEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const channelId = normalizeText(body.channelId);
  const text = normalizeText(body.text);
  if (!channelId || !text) {
    return null;
  }

  const accountId = normalizeText(body.accountId);
  const messageTs = normalizeText(body.messageTs);
  const threadTs = normalizeText(body.threadTs);
  const userId = normalizeText(body.userId);
  const outboundTarget =
    normalizeText(body.outboundTarget) ??
    (channelId ? buildDefaultOutboundTarget(channelId) : undefined);
  const eventId =
    normalizeText(body.eventId) ??
    buildEventId({
      channelId,
      accountId,
      messageTs,
      threadTs,
      userId,
    });

  return {
    eventId,
    accountId,
    channelId,
    channelName: normalizeText(body.channelName),
    threadTs,
    messageTs,
    userId,
    userName: normalizeText(body.userName),
    outboundTarget,
    text,
  };
}

function normalizeScope(scope: string): string {
  return scope.trim().toLowerCase();
}

function normalizeAccountId(value: string | undefined): string {
  return (value ?? SLACK_DEFAULT_ACCOUNT).trim().toLowerCase();
}

function normalizeChannelName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/^#/, '').toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function canWrite(permission: string | undefined): boolean {
  const normalized = (permission ?? 'read+write').trim().toLowerCase();
  return normalized === 'write' || normalized === 'read+write';
}

function scoreSlackBinding(binding: PlatformBinding, event: SlackIngressEvent): number {
  if (binding.platform.trim().toLowerCase() !== 'slack') {
    return -1;
  }
  if (!canWrite(binding.permission)) {
    return -1;
  }
  const bindingAccountId = binding.accountId?.trim()
    ? normalizeAccountId(binding.accountId)
    : undefined;
  const explicitEventAccountId = event.accountId?.trim()
    ? normalizeAccountId(event.accountId)
    : undefined;
  if (bindingAccountId && explicitEventAccountId && bindingAccountId !== explicitEventAccountId) {
    return -1;
  }

  const scope = normalizeScope(binding.scope);
  if (!scope) return -1;

  const channelId = event.channelId.trim().toLowerCase();
  const channelName = normalizeChannelName(event.channelName);
  const outboundTarget = normalizeTarget(event.outboundTarget);

  if (scope === '*' || scope === 'all' || scope === 'slack:*') {
    return 10;
  }
  if (
    scope === channelId ||
    scope === `channel:${channelId}` ||
    scope === `user:${channelId}` ||
    scope === `slack:${channelId}`
  ) {
    return 100;
  }
  if (outboundTarget && (scope === outboundTarget || scope === `slack:${outboundTarget}`)) {
    return 95;
  }
  if (channelName) {
    if (scope === `#${channelName}` || scope === channelName) {
      return 90;
    }
    if (scope.endsWith(` #${channelName}`)) {
      return 80;
    }
  }
  return -1;
}

function resolveOwnerTalk(
  talks: TalkMeta[],
  event: SlackIngressEvent,
  logger: Logger,
): { talkId?: string; reason?: string; binding?: PlatformBinding } {
  let bestScore = -1;
  const candidates: Array<{ talk: TalkMeta; binding: PlatformBinding }> = [];

  for (const talk of talks) {
    const bindings = talk.platformBindings ?? [];
    let talkScore = -1;
    let talkBestBinding: PlatformBinding | undefined;
    for (const binding of bindings) {
      const score = scoreSlackBinding(binding, event);
      if (score > talkScore) {
        talkScore = score;
        talkBestBinding = binding;
      }
    }
    if (talkScore < 0 || !talkBestBinding) continue;
    if (talkScore > bestScore) {
      bestScore = talkScore;
      candidates.length = 0;
      candidates.push({ talk, binding: talkBestBinding });
      continue;
    }
    if (talkScore === bestScore) {
      candidates.push({ talk, binding: talkBestBinding });
    }
  }

  if (candidates.length === 0) {
    const slackBindingScores: string[] = [];
    for (const talk of talks) {
      for (const binding of talk.platformBindings ?? []) {
        if (binding.platform.trim().toLowerCase() !== 'slack') continue;
        const score = scoreSlackBinding(binding, event);
        slackBindingScores.push(
          `${talk.id}:${binding.id}:scope=${binding.scope}:acct=${binding.accountId ?? '-'}:perm=${binding.permission}:score=${score}`,
        );
      }
    }
    logger.debug(
      `SlackIngress: no-binding diagnostics event=${event.eventId} account=${event.accountId ?? '-'} ` +
      `channel=${event.channelId} target=${event.outboundTarget ?? '-'} bindings=[${slackBindingScores.join(' | ')}]`,
    );
    return { reason: 'no-binding' };
  }
  if (candidates.length > 1) {
    logger.warn(
      `SlackIngress: ambiguous owner for ${event.eventId}; ${candidates.length} talks matched score ${bestScore}`,
    );
    return { reason: 'ambiguous-binding' };
  }
  return {
    talkId: candidates[0].talk.id,
    binding: candidates[0].binding,
  };
}


function resolveBehaviorForBinding(meta: TalkMeta, bindingId: string): {
  responseMode?: 'off' | 'mentions' | 'all';
  agentName?: string;
  onMessagePrompt?: string;
  mirrorToTalk?: 'off' | 'inbound' | 'full';
  deliveryMode?: 'thread' | 'channel' | 'adaptive';
  responsePolicy?: {
    triggerPolicy?: 'judgment' | 'study_entries_only' | 'advice_or_study';
    allowedSenders?: string[];
    minConfidence?: number;
  };
} | undefined {
  const behavior = (meta.platformBehaviors ?? []).find((entry) => entry.platformBindingId === bindingId);
  if (!behavior) return undefined;
  const responseMode =
    behavior.responseMode ??
    ((behavior as { autoRespond?: boolean }).autoRespond === false ? 'off' : undefined);
  const mirrorToTalk = behavior.mirrorToTalk;
  const deliveryMode = behavior.deliveryMode;
  const triggerPolicy = behavior.responsePolicy?.triggerPolicy;
  const allowedSenders = behavior.responsePolicy?.allowedSenders;
  const minConfidence = behavior.responsePolicy?.minConfidence;
  return {
    ...(responseMode ? { responseMode } : {}),
    agentName: behavior.agentName?.trim() || undefined,
    onMessagePrompt: behavior.onMessagePrompt?.trim() || undefined,
    ...(mirrorToTalk ? { mirrorToTalk } : {}),
    ...(deliveryMode ? { deliveryMode } : {}),
    ...(
      triggerPolicy || (Array.isArray(allowedSenders) && allowedSenders.length > 0) || minConfidence !== undefined
        ? {
            responsePolicy: {
              ...(triggerPolicy ? { triggerPolicy } : {}),
              ...(Array.isArray(allowedSenders) && allowedSenders.length > 0 ? { allowedSenders } : {}),
              ...(minConfidence !== undefined ? { minConfidence } : {}),
            },
          }
        : {}
    ),
  };
}

function messageLooksLikeMention(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/<@[A-Z0-9]+>/i.test(trimmed)) return true;
  if (/\B@[a-z0-9._-]{2,}/i.test(trimmed)) return true;
  return false;
}

function looksLikeStudyEntry(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  const hasTime = /\b\d+\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i.test(t);
  const hasStudyKeyword = /\b(study|studied|homework|mathcounts|khan|practice|worked|work|productive|coding|art|project)\b/i.test(t);
  return hasTime && hasStudyKeyword;
}

function looksLikeAdviceRequest(text: string): boolean {
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  return /\b(help|advice|how do i|what should i|can you|should i|guidance)\b/i.test(t);
}

function senderAllowed(
  behavior: { responsePolicy?: { allowedSenders?: string[] } } | undefined,
  event: { userId?: string; userName?: string },
): boolean {
  const allowed = behavior?.responsePolicy?.allowedSenders;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  const keys = new Set(
    allowed
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  if (keys.size === 0) return true;
  const candidates = [
    event.userName?.trim().toLowerCase(),
    event.userId?.trim().toLowerCase(),
  ].filter((v): v is string => Boolean(v));
  return candidates.some((candidate) => keys.has(candidate));
}

function resolveMessageIntent(eventText: string): 'study' | 'advice' | 'other' {
  if (looksLikeStudyEntry(eventText)) return 'study';
  if (looksLikeAdviceRequest(eventText)) return 'advice';
  return 'other';
}





function shouldHandleViaBehavior(
  meta: TalkMeta,
  bindingId: string,
  event: { text: string; userId?: string; userName?: string },
): {
  handle: boolean;
  reason?: string;
  behavior?: {
    responseMode?: 'off' | 'mentions' | 'all';
    agentName?: string;
    onMessagePrompt?: string;
    mirrorToTalk?: 'off' | 'inbound' | 'full';
    deliveryMode?: 'thread' | 'channel' | 'adaptive';
    responsePolicy?: {
      triggerPolicy?: 'judgment' | 'study_entries_only' | 'advice_or_study';
      allowedSenders?: string[];
      minConfidence?: number;
    };
  };
  intent?: 'study' | 'advice' | 'other';
} {
  const behavior = resolveBehaviorForBinding(meta, bindingId);
  if (!behavior) {
    // Missing behavior row means "use default talk behavior" for this binding.
    return { handle: true, intent: resolveMessageIntent(event.text) };
  }

  if (!senderAllowed(behavior, event)) {
    return { handle: false, reason: 'sender-not-allowed' };
  }

  const responseMode = behavior.responseMode ?? 'all';
  if (responseMode === 'off') {
    return { handle: false, reason: 'on-message-disabled' };
  }
  if (responseMode === 'mentions' && !messageLooksLikeMention(event.text)) {
    return { handle: false, reason: 'mention-required' };
  }

  const intent = resolveMessageIntent(event.text);
  const triggerPolicy = behavior.responsePolicy?.triggerPolicy ?? 'judgment';
  if (triggerPolicy === 'study_entries_only' && intent !== 'study') {
    return { handle: false, reason: 'trigger-policy-no-match' };
  }
  if (triggerPolicy === 'advice_or_study' && intent === 'other') {
    return { handle: false, reason: 'trigger-policy-no-match' };
  }

  return { handle: true, behavior, intent };
}


function buildInboundMessage(event: SlackIngressEvent): string {
  const sender = event.userName ?? event.userId ?? 'unknown';
  const channelLabel = event.channelName ? `#${event.channelName.replace(/^#/, '')}` : `#${event.channelId}`;
  const threadSuffix = event.threadTs ? ` (thread ${event.threadTs})` : '';
  return `[Slack ${channelLabel}${threadSuffix} from ${sender}]\n${event.text}`;
}

export function routeSlackIngressEvent(
  event: SlackIngressEvent,
  deps: SlackIngressDeps,
): { statusCode: number; payload: SlackOwnershipDecision } {
  pruneSeenEvents();

  const liveTalks = deps.store.listTalks();
  const liveSlackBindings: string[] = [];
  for (const talk of liveTalks) {
    for (const binding of talk.platformBindings ?? []) {
      if (binding.platform.trim().toLowerCase() !== 'slack') continue;
      liveSlackBindings.push(`${talk.id}:${binding.scope}:${binding.accountId ?? '-'}`);
    }
  }
  deps.logger.debug(
    `SlackIngress: runtime store=${deps.store.getInstanceId()} talks=${liveTalks.length} slackBindings=${liveSlackBindings.length} ` +
    `[${liveSlackBindings.join(' | ')}] for event=${event.eventId}`,
  );

  const seen = seenEvents.get(event.eventId);
  if (seen) {
    return {
      statusCode: 200,
      payload: {
        decision: seen.decision,
        talkId: seen.talkId,
        reason: seen.reason,
        eventId: event.eventId,
        duplicate: true,
      },
    };
  }

  const ownership = inspectSlackOwnership(event, deps.store, deps.logger);
  if (ownership.decision === 'pass' || !ownership.talkId || !ownership.bindingId) {
    const reason = ownership.reason ?? 'no-binding';
    deps.logger.debug(
      `SlackIngress: pass event=${event.eventId} account=${event.accountId ?? 'unknown'} ` +
      `channel=${event.channelId} reason=${reason} ` +
      `talk=${ownership.talkId ?? '-'} binding=${ownership.bindingId ?? '-'}`,
    );
    if (ownership.talkId) {
      getTalkCounters(ownership.talkId).passed += 1;
    }
    seenEvents.set(event.eventId, {
      ts: Date.now(),
      decision: 'pass',
      reason,
    });
    return {
      statusCode: 200,
      payload: {
        decision: 'pass',
        reason,
        eventId: event.eventId,
      },
    };
  }

  // All Talk-bound channels delegate to OpenClaw managed agents (ct-*).
  // The before_agent_start hook injects Talk context into the managed agent.
  const managedAgentId = buildManagedAgentId(ownership.talkId);
  const ownerTalk = deps.store.getTalk(ownership.talkId);
  const isDelegated = Boolean(ownerTalk);  // managed agents exist for all Talks with write bindings

  if (isDelegated) {
    const reason = 'delegated-to-agent';
    deps.logger.info(
      `SlackIngress: delegated event=${event.eventId} account=${event.accountId ?? 'unknown'} ` +
      `channel=${event.channelId} talk=${ownership.talkId} agent=${managedAgentId}`,
    );
    seenEvents.set(event.eventId, {
      ts: Date.now(),
      decision: 'pass',
      talkId: ownership.talkId,
      reason,
    });
    getTalkCounters(ownership.talkId).passed += 1;

    // Mirror inbound message to Talk history if configured (async, fire-and-forget)
    const mirrorMode = ownership.behaviorMirrorToTalk ?? 'off';
    if ((mirrorMode === 'inbound' || mirrorMode === 'full') && ownerTalk) {
      const inboundContent = buildInboundMessage(event);
      const userMsg: TalkMessage = {
        id: randomUUID(),
        role: 'user',
        content: inboundContent,
        timestamp: Date.now(),
      };
      deps.store.appendMessage(ownership.talkId, userMsg).catch(err => {
        deps.logger.warn(`SlackIngress: mirror inbound failed for talk=${ownership.talkId}: ${String(err)}`);
      });
    }

    return {
      statusCode: 200,
      payload: {
        decision: 'pass',
        reason,
        talkId: ownership.talkId,
        eventId: event.eventId,
      },
    };
  }

  // All Talk-bound channels are delegated (managed agent exists for every Talk with write bindings).
  // If we reach here, the Talk was not found in the store (shouldn't happen).
  deps.logger.warn(
    `SlackIngress: talk ${ownership.talkId} matched binding but not found in store ` +
    `event=${event.eventId} channel=${event.channelId}`,
  );
  seenEvents.set(event.eventId, { ts: Date.now(), decision: 'pass', reason: 'talk-not-found' });
  return {
    statusCode: 200,
    payload: {
      decision: 'pass',
      reason: 'talk-not-found',
      eventId: event.eventId,
    },
  };
}

export function inspectSlackOwnership(
  event: Pick<SlackIngressEvent, 'accountId' | 'channelId' | 'channelName' | 'outboundTarget' | 'eventId' | 'userId' | 'userName'> & { text?: string },
  store: TalkStore,
  logger: Logger,
): SlackOwnershipInspection {
  const owner = resolveOwnerTalk(store.listTalks(), {
    ...event,
    text: '',
  }, logger);
  if (!owner.talkId || !owner.binding) {
    return {
      decision: 'pass',
      reason: owner.reason ?? 'no-binding',
    };
  }

  const ownerTalk = store.getTalk(owner.talkId);
  if (!ownerTalk) {
    return {
      decision: 'pass',
      reason: 'talk-not-found',
      talkId: owner.talkId,
      bindingId: owner.binding.id,
    };
  }

  const behaviorDecision = shouldHandleViaBehavior(ownerTalk, owner.binding.id, {
    text: event.text ?? '',
    userId: event.userId,
    userName: event.userName,
  });
  if (!behaviorDecision.handle) {
    return {
      decision: 'pass',
      reason: behaviorDecision.reason ?? 'no-platform-behavior',
      talkId: owner.talkId,
      bindingId: owner.binding.id,
    };
  }

  return {
    decision: 'handled',
    talkId: owner.talkId,
    bindingId: owner.binding.id,
    behaviorAgentName: behaviorDecision.behavior?.agentName,
    behaviorOnMessagePrompt: behaviorDecision.behavior?.onMessagePrompt,
    behaviorMirrorToTalk: behaviorDecision.behavior?.mirrorToTalk,
    behaviorDeliveryMode: behaviorDecision.behavior?.deliveryMode,
    behaviorIntent: behaviorDecision.intent,
  };
}

function parseSlackMessageReceivedHookEvent(
  event: MessageReceivedHookEvent,
  ctx: MessageHookContext,
): SlackIngressEvent | null {
  if (ctx.channelId.trim().toLowerCase() !== 'slack') {
    return null;
  }

  const text = normalizeText(event.content);
  if (!text) {
    return null;
  }

  const metadata = asRecord(event.metadata);
  // OpenClaw inbound hook metadata uses `originatingTo` for the original channel target.
  // `to` can be a human label (e.g., "general"), which is not stable for ownership routing.
  const outboundTarget =
    normalizeText(metadata?.originatingTo) ??
    normalizeText(ctx.conversationId) ??
    normalizeText(metadata?.to);
  const channelId = parseSlackTargetId(outboundTarget) ?? parseSlackFromId(event.from);
  if (!channelId) {
    return null;
  }

  const accountId = normalizeText(ctx.accountId) ?? normalizeText(metadata?.accountId);
  const threadTs = normalizeText(metadata?.threadId);
  const messageTs =
    normalizeText(metadata?.messageId) ??
    (typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? String(Math.floor(event.timestamp))
      : undefined);
  const userId = normalizeText(metadata?.senderId);
  const userName = normalizeText(metadata?.senderName) ?? normalizeText(metadata?.senderUsername);

  return {
    eventId: buildEventId({
      channelId,
      accountId,
      messageTs,
      threadTs,
      userId,
    }),
    accountId,
    channelId,
    threadTs,
    messageTs,
    userId,
    userName,
    outboundTarget: outboundTarget ?? buildDefaultOutboundTarget(channelId),
    text,
  };
}


export async function handleSlackMessageReceivedHook(
  event: MessageReceivedHookEvent,
  ctx: MessageHookContext,
  deps: SlackIngressDeps,
): Promise<MessageReceivedHookResult> {
  const parsed = parseSlackMessageReceivedHookEvent(event, ctx);
  if (!parsed) {
    if (ctx.channelId.trim().toLowerCase() === 'slack') {
      const metadata = asRecord(event.metadata);
      deps.logger.debug(
        `SlackIngress: parse-skip channel=${ctx.channelId} ` +
        `conversation=${ctx.conversationId ?? '-'} from=${event.from ?? '-'} ` +
        `meta.to=${normalizeText(metadata?.to) ?? '-'} ` +
        `meta.originatingTo=${normalizeText(metadata?.originatingTo) ?? '-'} ` +
        `textLen=${(event.content ?? '').length}`,
      );
    }
    return undefined;
  }
  deps.logger.debug(
    `SlackIngress: parsed event=${parsed.eventId} account=${parsed.accountId ?? '-'} ` +
    `channel=${parsed.channelId} target=${parsed.outboundTarget ?? '-'} textLen=${parsed.text.length}`,
  );
  routeSlackIngressEvent(parsed, deps);
  return undefined;
}


export async function handleSlackIngress(
  ctx: HandlerContext,
  deps: SlackIngressDeps,
): Promise<void> {
  if (ctx.req.method !== 'POST') {
    sendJson(ctx.res, 405, { error: 'Method not allowed' });
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(ctx.req);
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const event = parseSlackIngressEvent(body);
  if (!event) {
    sendJson(ctx.res, 400, {
      error: 'Missing required fields: channelId and text',
    });
    return;
  }

  const decision = routeSlackIngressEvent(event, deps);
  sendJson(ctx.res, decision.statusCode, decision.payload);
}

export function __resetSlackIngressStateForTests(): void {
  seenEvents.clear();
  runtimeCountersByTalkId.clear();
}

export function getSlackIngressTalkRuntimeSnapshot(talkId: string): SlackIngressTalkRuntimeSnapshot {
  const counters = getTalkCounters(talkId);
  return {
    talkId,
    counters: { ...counters },
  };
}
