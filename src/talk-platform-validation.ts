/**
 * Talk Platform Validation
 *
 * Validates and normalizes platform bindings, platform behaviors,
 * and Talk agents. Extracted from talks.ts.
 */

import type {
  TalkPlatformBehavior,
  TalkPlatformBinding,
  PlatformPermission,
  TalkAgent,
  TalkMeta,
} from './types.js';
import {
  normalizeResponseMode,
  normalizeMirrorToTalk,
  normalizeDeliveryMode,
  normalizeTriggerPolicy,
  normalizeAllowedSenders,
  normalizePermission,
} from './talk-store.js';
import { SLACK_DEFAULT_ACCOUNT_ID, normalizeSlackAccountId } from './slack-auth.js';
import { type SlackScopeResolutionResult, normalizeSlackBindingScope } from './slack-scope-resolver.js';
import { randomUUID } from 'node:crypto';

export type PlatformBindingsValidationResult =
  | { ok: true; bindings: TalkPlatformBinding[]; ownershipKeys: string[] }
  | { ok: false; error: string };

export type PlatformBehaviorsValidationResult =
  | { ok: true; behaviors: TalkPlatformBehavior[] }
  | { ok: false; error: string };

export type AgentsValidationResult =
  | { ok: true; agents: TalkAgent[] }
  | { ok: false; error: string };

export type PlatformBindingsValidationOptions = {
  resolveSlackScope?: (scope: string, accountId?: string) => Promise<SlackScopeResolutionResult>;
};

const TALK_AGENT_ROLES = new Set(['analyst', 'critic', 'strategist', 'devils-advocate', 'synthesizer', 'editor']);

function canWrite(permission: PlatformPermission): boolean {
  return permission === 'write' || permission === 'read+write';
}

function parseScopedSlackInput(rawScope: string): { accountId?: string; scope: string } {
  const rawTrimmed = rawScope.trim();
  if (!rawTrimmed) return { scope: '' };

  const quoted =
    (rawTrimmed.startsWith('"') && rawTrimmed.endsWith('"')) ||
    (rawTrimmed.startsWith("'") && rawTrimmed.endsWith("'"));
  const trimmed = quoted ? rawTrimmed.slice(1, -1).trim() : rawTrimmed;
  if (!trimmed) return { scope: '' };

  const accountPrefix = trimmed.match(/^account:([a-z0-9._-]+):(.+)$/i);
  if (accountPrefix?.[1] && accountPrefix?.[2]) {
    return {
      accountId: accountPrefix[1].toLowerCase(),
      scope: accountPrefix[2].trim(),
    };
  }

  const spaced = trimmed.match(/^([a-z0-9._-]+)\s+(#?[a-z0-9._-]+)$/i);
  if (spaced?.[1] && spaced?.[2] && spaced[2].startsWith('#')) {
    return {
      accountId: spaced[1].toLowerCase(),
      scope: spaced[2].trim(),
    };
  }

  const shorthand = trimmed.match(/^([a-z0-9._-]+):(.+)$/i);
  if (shorthand?.[1] && shorthand?.[2]) {
    const accountPrefix = shorthand[1].toLowerCase();
    const scoped = shorthand[2].trim();
    if (
      !['slack', 'channel', 'user'].includes(accountPrefix) &&
      (
        scoped.startsWith('#') ||
        /^channel:/i.test(scoped) ||
        /^user:/i.test(scoped) ||
        /^slack:\*/i.test(scoped) ||
        scoped === '*'
      )
    ) {
      return {
        accountId: shorthand[1].toLowerCase(),
        scope: scoped,
      };
    }
  }

  return { scope: trimmed };
}

function resolveBindingIdFromAlias(
  alias: string,
  bindings: TalkPlatformBinding[],
): string | undefined {
  const trimmed = alias.trim();
  if (!trimmed) return undefined;

  const byDirectId = bindings.find((binding) => binding.id === trimmed);
  if (byDirectId) return byDirectId.id;

  const byPlatformIndex = trimmed.match(/^platform(\d+)$/i);
  if (byPlatformIndex) {
    const idx = parseInt(byPlatformIndex[1], 10);
    if (idx >= 1 && idx <= bindings.length) {
      return bindings[idx - 1].id;
    }
  }

  const lowered = trimmed.toLowerCase();
  const byScope = bindings.find((binding) => binding.scope.trim().toLowerCase() === lowered);
  if (byScope) return byScope.id;

  const byDisplayScope = bindings.find(
    (binding) => (binding.displayScope ?? '').trim().toLowerCase() === lowered,
  );
  if (byDisplayScope) return byDisplayScope.id;

  return undefined;
}

export function mapChannelResponseSettingsInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const row = entry as Record<string, unknown>;
    const connectionId =
      typeof row.connectionId === 'string' ? row.connectionId.trim() : '';
    const platformBindingId =
      typeof row.platformBindingId === 'string' ? row.platformBindingId.trim() : connectionId;
    const responderAgent =
      typeof row.responderAgent === 'string' ? row.responderAgent.trim() : '';
    const responseInstruction =
      typeof row.responseInstruction === 'string' ? row.responseInstruction.trim() : '';
    const responseMode =
      normalizeResponseMode(row.responseMode) ??
      (typeof row.autoRespond === 'boolean'
        ? (row.autoRespond ? 'all' : 'off')
        : undefined);
    const mirrorToTalk = normalizeMirrorToTalk(row.mirrorToTalk);
    const autoRespond =
      typeof row.autoRespond === 'boolean' ? row.autoRespond : undefined;
    const deliveryMode = normalizeDeliveryMode(row.deliveryMode);
    const responsePolicy = row.responsePolicy && typeof row.responsePolicy === 'object'
      ? (row.responsePolicy as Record<string, unknown>)
      : undefined;
    const triggerPolicy = normalizeTriggerPolicy(responsePolicy?.triggerPolicy);
    const allowedSenders = normalizeAllowedSenders(responsePolicy?.allowedSenders);
    const minConfidence = typeof responsePolicy?.minConfidence === 'number'
      ? responsePolicy.minConfidence
      : undefined;

    return {
      ...row,
      ...(platformBindingId ? { platformBindingId } : {}),
      ...(responderAgent ? { agentName: responderAgent } : {}),
      ...(responseInstruction ? { onMessagePrompt: responseInstruction } : {}),
      ...(responseMode !== undefined ? { responseMode } : {}),
      ...(mirrorToTalk !== undefined ? { mirrorToTalk } : {}),
      ...(autoRespond !== undefined ? { autoRespond } : {}),
      ...(deliveryMode !== undefined ? { deliveryMode } : {}),
      ...(
        triggerPolicy !== undefined || allowedSenders !== undefined || minConfidence !== undefined
          ? {
              responsePolicy: {
                ...(triggerPolicy !== undefined ? { triggerPolicy } : {}),
                ...(allowedSenders !== undefined ? { allowedSenders } : {}),
                ...(minConfidence !== undefined ? { minConfidence } : {}),
              },
            }
          : {}
      ),
    };
  });
}

export function normalizeAndValidateAgentsInput(input: unknown): AgentsValidationResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'agents must be an array' };
  }
  const seen = new Set<string>();
  let primaryCount = 0;
  const normalized: TalkAgent[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const entry = input[i];
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: `agents[${i + 1}] must be an object` };
    }
    const row = entry as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const model = typeof row.model === 'string' ? row.model.trim() : '';
    const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
    const isPrimary = row.isPrimary === true;
    const openClawAgentId = typeof row.openClawAgentId === 'string' ? row.openClawAgentId.trim() : '';
    if (!name) return { ok: false, error: `agents[${i + 1}].name is required` };
    if (!model) return { ok: false, error: `agents[${i + 1}].model is required` };
    if (!TALK_AGENT_ROLES.has(role)) {
      return { ok: false, error: `agents[${i + 1}].role must be one of: ${Array.from(TALK_AGENT_ROLES).join(', ')}` };
    }
    const key = name.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `Duplicate agent name "${name}"` };
    seen.add(key);
    if (isPrimary) primaryCount += 1;
    normalized.push({
      name,
      model,
      role: role as TalkAgent['role'],
      isPrimary,
      ...(openClawAgentId ? { openClawAgentId } : {}),
    });
  }
  if (primaryCount > 1) {
    return { ok: false, error: 'Only one agent can be primary (isPrimary=true)' };
  }
  return { ok: true, agents: normalized };
}

export function resolvePlatformBehaviorBindingRefsInput(
  input: unknown,
  bindings: TalkPlatformBinding[],
): unknown {
  if (!Array.isArray(input) || bindings.length === 0) return input;
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const row = entry as Record<string, unknown>;
    const explicitBindingId =
      typeof row.platformBindingId === 'string' ? row.platformBindingId.trim() : '';
    const connectionId =
      typeof row.connectionId === 'string' ? row.connectionId.trim() : '';

    const resolvedBindingId =
      resolveBindingIdFromAlias(explicitBindingId, bindings) ??
      resolveBindingIdFromAlias(connectionId, bindings) ??
      (bindings.length === 1 ? bindings[0].id : undefined);

    return {
      ...row,
      ...(resolvedBindingId ? { platformBindingId: resolvedBindingId } : {}),
    };
  });
}

export async function normalizeAndValidatePlatformBindingsInput(
  input: unknown,
  options?: PlatformBindingsValidationOptions,
): Promise<PlatformBindingsValidationResult> {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'platformBindings must be an array' };
  }

  const normalized: TalkPlatformBinding[] = [];
  const ownershipKeys = new Set<string>();

  for (let i = 0; i < input.length; i += 1) {
    const entry = input[i];
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: `platformBindings[${i + 1}] must be an object` };
    }
    const row = entry as Record<string, unknown>;
    const platform = typeof row.platform === 'string' ? row.platform.trim().toLowerCase() : '';
    const rawScope = typeof row.scope === 'string' ? row.scope.trim() : '';
    const parsedScopedInput = platform === 'slack'
      ? parseScopedSlackInput(rawScope)
      : { scope: rawScope };
    const scope = parsedScopedInput.scope.trim();
    if (!platform || !scope) {
      return { ok: false, error: `platformBindings[${i + 1}] requires platform and scope` };
    }

    const permission = normalizePermission(row.permission);
    let normalizedScope = scope;
    let accountId = normalizeSlackAccountId(
      typeof row.accountId === 'string' ? row.accountId : undefined,
    ) ?? normalizeSlackAccountId(parsedScopedInput.accountId);
    let displayScope = typeof row.displayScope === 'string' ? row.displayScope.trim() : '';
    if (platform === 'slack') {
      if (options?.resolveSlackScope) {
        const resolved = await options.resolveSlackScope(scope, accountId);
        if (!resolved.ok) {
          return { ok: false, error: `platformBindings[${i + 1}] ${resolved.error}` };
        }
        normalizedScope = resolved.canonicalScope;
        accountId = normalizeSlackAccountId(resolved.accountId) ?? accountId;
        if (resolved.displayScope) {
          displayScope = resolved.displayScope.trim();
        }
      } else {
        const canonicalScope = normalizeSlackBindingScope(scope);
        if (!canonicalScope) {
          return {
            ok: false,
            error:
              `platformBindings[${i + 1}] has invalid Slack scope "${scope}". ` +
              'Use channel:<ID>, user:<ID>, #channel, account:#channel, or slack:*.',
          };
        }
        normalizedScope = canonicalScope;
        accountId = accountId ?? SLACK_DEFAULT_ACCOUNT_ID;
      }

      if (!normalizedScope) {
        return {
          ok: false,
          error:
            `platformBindings[${i + 1}] has invalid Slack scope "${scope}". ` +
            'Use channel:<ID>, user:<ID>, #channel, account:#channel, channel:<name>, or slack:*.',
        };
      }
      if (canWrite(permission)) {
        const ownershipAccountId = accountId ?? SLACK_DEFAULT_ACCOUNT_ID;
        ownershipKeys.add(`slack:${ownershipAccountId}:${normalizedScope.toLowerCase()}`);
      }
    }

    normalized.push({
      ...row,
      platform,
      scope: normalizedScope,
      ...(accountId ? { accountId } : {}),
      ...(displayScope ? { displayScope } : {}),
      permission,
    } as TalkPlatformBinding);
  }

  return {
    ok: true,
    bindings: normalized,
    ownershipKeys: Array.from(ownershipKeys),
  };
}

export function normalizeAndValidatePlatformBehaviorsInput(
  input: unknown,
  params: {
    bindings: TalkPlatformBinding[];
    agents: TalkAgent[];
  },
): PlatformBehaviorsValidationResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'platformBehaviors must be an array' };
  }

  const now = Date.now();
  const bindingIds = new Set(params.bindings.map((binding) => binding.id));
  const agentNames = new Set((params.agents ?? []).map((agent) => agent.name.toLowerCase()));
  const seenBindingIds = new Set<string>();
  const normalized: TalkPlatformBehavior[] = [];

  for (let i = 0; i < input.length; i += 1) {
    const entry = input[i];
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: `platformBehaviors[${i + 1}] must be an object` };
    }
    const row = entry as Record<string, unknown>;
    const platformBindingId = typeof row.platformBindingId === 'string' ? row.platformBindingId.trim() : '';
    if (!platformBindingId) {
      return { ok: false, error: `platformBehaviors[${i + 1}] requires platformBindingId` };
    }
    if (!bindingIds.has(platformBindingId)) {
      return {
        ok: false,
        error:
          `platformBehaviors[${i + 1}] references unknown binding "${platformBindingId}". ` +
          'Use /platform list to get a valid platformN first.',
      };
    }
    if (seenBindingIds.has(platformBindingId)) {
      return {
        ok: false,
        error:
          `platformBehaviors has multiple entries for binding "${platformBindingId}". ` +
          'Use one behavior per binding.',
      };
    }
    seenBindingIds.add(platformBindingId);

    const agentName = typeof row.agentName === 'string' ? row.agentName.trim() : '';
    if (agentName && !agentNames.has(agentName.toLowerCase())) {
      return {
        ok: false,
        error:
          `platformBehaviors[${i + 1}] references unknown agent "${agentName}". ` +
          'Add the agent first or omit agentName to use the primary talk agent.',
      };
    }

    const onMessagePrompt = typeof row.onMessagePrompt === 'string' ? row.onMessagePrompt.trim() : '';
    const autoRespond = typeof row.autoRespond === 'boolean' ? row.autoRespond : undefined;
    const responseMode =
      normalizeResponseMode(row.responseMode) ??
      (autoRespond === false ? 'off' : autoRespond === true ? 'all' : undefined);
    const mirrorToTalk = normalizeMirrorToTalk(row.mirrorToTalk);
    const deliveryMode = normalizeDeliveryMode(row.deliveryMode);
    const responsePolicyRaw =
      row.responsePolicy && typeof row.responsePolicy === 'object'
        ? row.responsePolicy as Record<string, unknown>
        : undefined;
    const triggerPolicy = normalizeTriggerPolicy(responsePolicyRaw?.triggerPolicy);
    const allowedSenders = normalizeAllowedSenders(responsePolicyRaw?.allowedSenders);
    const minConfidence = typeof responsePolicyRaw?.minConfidence === 'number'
      ? responsePolicyRaw.minConfidence
      : undefined;

    if (responsePolicyRaw && triggerPolicy === undefined && allowedSenders === undefined && minConfidence === undefined) {
      return {
        ok: false,
        error:
          `platformBehaviors[${i + 1}].responsePolicy is invalid. ` +
          'Expected triggerPolicy, allowedSenders array, and/or numeric minConfidence.',
      };
    }

    if (
      !agentName &&
      !onMessagePrompt &&
      responseMode === undefined &&
      mirrorToTalk === undefined &&
      deliveryMode === undefined &&
      triggerPolicy === undefined &&
      allowedSenders === undefined &&
      minConfidence === undefined
    ) {
      return {
        ok: false,
        error:
          `platformBehaviors[${i + 1}] must define at least one behavior field ` +
          '(agentName, onMessagePrompt, responseMode, mirrorToTalk, deliveryMode, or responsePolicy).',
      };
    }

    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : randomUUID();
    const createdAt = typeof row.createdAt === 'number' ? row.createdAt : now;
    const updatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : now;

    normalized.push({
      id,
      platformBindingId,
      ...(responseMode !== undefined ? { responseMode } : {}),
      ...(mirrorToTalk !== undefined ? { mirrorToTalk } : {}),
      ...(agentName ? { agentName } : {}),
      ...(onMessagePrompt ? { onMessagePrompt } : {}),
      ...(deliveryMode !== undefined ? { deliveryMode } : {}),
      ...(
        triggerPolicy !== undefined || allowedSenders !== undefined || minConfidence !== undefined
          ? {
              responsePolicy: {
                ...(triggerPolicy !== undefined ? { triggerPolicy } : {}),
                ...(allowedSenders !== undefined ? { allowedSenders } : {}),
                ...(minConfidence !== undefined ? { minConfidence } : {}),
              },
            }
          : {}
      ),
      createdAt,
      updatedAt,
    });
  }

  return { ok: true, behaviors: normalized };
}

export function findSlackBindingConflicts(params: {
  candidateOwnershipKeys: string[];
  talks: TalkMeta[];
  skipTalkId?: string;
}): Array<{ scope: string; talkId: string }> {
  const keySet = new Set(params.candidateOwnershipKeys.map((value) => value.toLowerCase()));
  if (keySet.size === 0) return [];

  const conflicts = new Map<string, { scope: string; talkId: string }>();
  for (const talk of params.talks) {
    if (params.skipTalkId && talk.id === params.skipTalkId) continue;
    for (const binding of talk.platformBindings ?? []) {
      if (binding.platform.trim().toLowerCase() !== 'slack') continue;
      const permission = normalizePermission(binding.permission);
      if (!canWrite(permission)) continue;
      const canonicalScope = normalizeSlackBindingScope(binding.scope);
      if (!canonicalScope) continue;
      const accountId = normalizeSlackAccountId(binding.accountId) ?? SLACK_DEFAULT_ACCOUNT_ID;
      const key = `slack:${accountId}:${canonicalScope.toLowerCase()}`;
      if (!keySet.has(key)) continue;
      const mapKey = `${talk.id}:${key}`;
      conflicts.set(mapKey, { scope: canonicalScope, talkId: talk.id });
    }
  }
  return Array.from(conflicts.values());
}
