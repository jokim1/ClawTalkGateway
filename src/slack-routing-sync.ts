import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger, PlatformBinding, TalkMeta } from './types.js';

const MANAGED_AGENT_PREFIX = 'ct-';
const DEFAULT_ACCOUNT_ID = 'default';

type SlackPeer = { kind: 'channel' | 'user'; id: string };
type DesiredBinding = {
  talkId: string;
  agentId: string;
  accountId: string;
  peer: SlackPeer;
  requireMention: boolean;
};
type ManagedAgent = {
  id: string;
  name: string;
  model: string;
  sandbox: { mode: 'off' };
};

/** Build a stable managed agent ID from a Talk ID. */
export function buildManagedAgentId(talkId: string): string {
  return `${MANAGED_AGENT_PREFIX}${talkId.slice(0, 8)}`;
}

/** Check if an agent ID is ClawTalk-managed. */
export function isManagedAgentId(agentId: string): boolean {
  return agentId.startsWith(MANAGED_AGENT_PREFIX);
}

function normalizeAccountId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_ACCOUNT_ID;
  const trimmed = value.trim().toLowerCase();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

function isWritePermission(permission: PlatformBinding['permission']): boolean {
  return permission === 'write' || permission === 'read+write';
}

function parseSlackPeerFromScope(scopeRaw: string): SlackPeer | null {
  const scope = scopeRaw.trim();
  if (!scope) return null;
  const normalized = scope.toLowerCase().startsWith('slack:') ? scope.slice('slack:'.length) : scope;
  const colon = normalized.indexOf(':');
  if (colon < 0) return null;
  const kind = normalized.slice(0, colon).trim().toLowerCase();
  const id = normalized.slice(colon + 1).trim();
  if (!id) return null;
  if (kind === 'channel') return { kind: 'channel', id: id.toUpperCase() };
  if (kind === 'user') return { kind: 'user', id: id.toUpperCase() };
  return null;
}

function desiredSlackBindingsFromTalks(talks: TalkMeta[]): DesiredBinding[] {
  const out: DesiredBinding[] = [];
  const seen = new Set<string>();

  for (const talk of talks) {
    const agentId = buildManagedAgentId(talk.id);
    const behaviorsByBindingId = new Map(
      (talk.platformBehaviors ?? []).map((behavior) => [behavior.platformBindingId, behavior]),
    );
    for (const binding of talk.platformBindings ?? []) {
      if (binding.platform.trim().toLowerCase() !== 'slack') continue;
      if (!isWritePermission(binding.permission)) continue;
      const peer = parseSlackPeerFromScope(binding.scope);
      if (!peer) continue;
      const accountId = normalizeAccountId(binding.accountId);
      const key = `${accountId}:${peer.kind}:${peer.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const behavior = behaviorsByBindingId.get(binding.id);
      const responseMode =
        behavior?.responseMode ??
        ((behavior as { autoRespond?: boolean } | undefined)?.autoRespond === false ? 'off' : 'all');
      out.push({
        talkId: talk.id,
        agentId,
        accountId,
        peer,
        requireMention: responseMode === 'mentions',
      });
    }
  }
  return out;
}

function buildManagedAgentsFromTalks(
  talks: TalkMeta[],
  desired: DesiredBinding[],
  defaultModel: string,
): ManagedAgent[] {
  const talkIds = new Set(desired.map(d => d.talkId));
  const agents: ManagedAgent[] = [];
  const seen = new Set<string>();
  for (const talk of talks) {
    if (!talkIds.has(talk.id)) continue;
    const agentId = buildManagedAgentId(talk.id);
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    agents.push({
      id: agentId,
      name: talk.topicTitle || `ClawTalk ${agentId}`,
      model: talk.model || defaultModel,
      sandbox: { mode: 'off' },
    });
  }
  return agents;
}

function isSlackPeerBindingRow(row: unknown): row is Record<string, unknown> {
  if (!row || typeof row !== 'object') return false;
  const binding = row as Record<string, unknown>;
  const match = binding.match && typeof binding.match === 'object'
    ? binding.match as Record<string, unknown>
    : null;
  if (!match) return false;
  const channel = typeof match.channel === 'string' ? match.channel.trim().toLowerCase() : '';
  if (channel !== 'slack') return false;
  const peer = match.peer && typeof match.peer === 'object'
    ? match.peer as Record<string, unknown>
    : null;
  if (!peer) return false;
  const kind = typeof peer.kind === 'string' ? peer.kind.trim().toLowerCase() : '';
  const id = typeof peer.id === 'string' ? peer.id.trim() : '';
  return (kind === 'channel' || kind === 'user') && !!id;
}

function bindingKeyFromRow(row: Record<string, unknown>): string | null {
  const match = row.match as Record<string, unknown>;
  const peer = match.peer as Record<string, unknown>;
  const accountId = normalizeAccountId(match.accountId);
  const kind = String(peer.kind).trim().toLowerCase();
  const id = String(peer.id).trim().toUpperCase();
  if (!id || (kind !== 'channel' && kind !== 'user')) return null;
  return `${accountId}:${kind}:${id}`;
}

function ensureObjectPath(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  const obj: Record<string, unknown> = {};
  root[key] = obj;
  return obj;
}

function buildManagedBinding(entry: DesiredBinding): Record<string, unknown> {
  return {
    agentId: entry.agentId,
    match: {
      channel: 'slack',
      accountId: entry.accountId,
      peer: {
        kind: entry.peer.kind,
        id: entry.peer.id,
      },
    },
  };
}

export async function reconcileSlackRoutingForTalks(
  talks: TalkMeta[],
  logger: Logger,
): Promise<void> {
  const configPath = path.join(process.env.HOME ?? '', '.openclaw', 'openclaw.json');
  if (!configPath || configPath === '.openclaw/openclaw.json') return;

  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf-8');
  } catch {
    return;
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.warn(`ClawTalk: slack routing reconcile skipped (invalid openclaw.json): ${String(err)}`);
    return;
  }

  const desired = desiredSlackBindingsFromTalks(talks);
  const desiredByKey = new Map<string, DesiredBinding>();
  for (const entry of desired) {
    desiredByKey.set(`${entry.accountId}:${entry.peer.kind}:${entry.peer.id}`, entry);
  }

  const existingBindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  const retained: Record<string, unknown>[] = [];
  for (const row of existingBindings) {
    if (!row || typeof row !== 'object') continue;
    const binding = row as Record<string, unknown>;
    if (!isSlackPeerBindingRow(binding)) {
      retained.push(binding);
      continue;
    }

    const key = bindingKeyFromRow(binding);
    if (!key) {
      retained.push(binding);
      continue;
    }

    // Rebuild all ClawTalk-managed rows and any conflicting peer-specific rows
    // so talk bindings always own their configured Slack channel/user route.
    if (desiredByKey.has(key)) {
      continue;
    }
    const agentId = typeof binding.agentId === 'string' ? binding.agentId.trim().toLowerCase() : '';
    // Remove stale managed bindings and legacy 'clawtalk' bindings
    if (isManagedAgentId(agentId) || agentId === 'clawtalk') {
      continue;
    }
    retained.push(binding);
  }

  const managed = desired.map((entry) => buildManagedBinding(entry));
  cfg.bindings = [...managed, ...retained];

  // Merge managed agents into agents.list
  const agentsRoot = ensureObjectPath(cfg, 'agents');
  const existingAgentList: Record<string, unknown>[] = Array.isArray(agentsRoot.list)
    ? (agentsRoot.list as Record<string, unknown>[])
    : [];
  // Read default model from agents.defaults.model.primary
  const agentDefaults = agentsRoot.defaults && typeof agentsRoot.defaults === 'object'
    ? agentsRoot.defaults as Record<string, unknown>
    : {};
  const defaultModelObj = agentDefaults.model && typeof agentDefaults.model === 'object'
    ? agentDefaults.model as Record<string, unknown>
    : {};
  const defaultModel = typeof defaultModelObj.primary === 'string'
    ? defaultModelObj.primary.trim()
    : 'moltbot';
  const managedAgents = buildManagedAgentsFromTalks(talks, desired, defaultModel);
  // Keep non-managed agents, remove stale managed ones
  const retainedAgents = existingAgentList.filter(a => {
    const id = typeof a.id === 'string' ? a.id.trim() : '';
    return !isManagedAgentId(id);
  });
  agentsRoot.list = [...retainedAgents, ...managedAgents];
  if (managedAgents.length > 0) {
    logger.info(
      `ClawTalk: reconciled ${managedAgents.length} managed agents: ${managedAgents.map(a => a.id).join(', ')}`,
    );
  }

  // Ensure channels configured by talks are mention-free by default.
  const channelsRoot = ensureObjectPath(cfg, 'channels');
  const slackRoot = ensureObjectPath(channelsRoot, 'slack');
  const accountsRoot = ensureObjectPath(slackRoot, 'accounts');
  for (const entry of desired) {
    if (entry.peer.kind !== 'channel') continue;
    const accountRoot = ensureObjectPath(accountsRoot, entry.accountId);
    const accountChannels = ensureObjectPath(accountRoot, 'channels');
    const channelRow = ensureObjectPath(accountChannels, entry.peer.id);
    channelRow.requireMention = entry.requireMention;
  }

  // Propagate signing secret to accounts that are already in HTTP mode.
  // We no longer force HTTP mode — socket mode works with the handoff flow
  // and doesn't require a public URL or Slack portal configuration.
  if (desired.length > 0) {
    const seenAccounts = new Set(desired.map(d => d.accountId));
    for (const accountId of seenAccounts) {
      const accountRoot = ensureObjectPath(accountsRoot, accountId);
      if (accountRoot.mode === 'http' && !accountRoot.signingSecret) {
        const envSecret = process.env.GATEWAY_SLACK_SIGNING_SECRET?.trim()
          || process.env.SLACK_SIGNING_SECRET?.trim();
        const baseSecret = typeof slackRoot.signingSecret === 'string'
          ? slackRoot.signingSecret.trim() : '';
        const fallback = envSecret || baseSecret;
        if (fallback) {
          accountRoot.signingSecret = fallback;
          logger.info(`ClawTalk: propagated signing secret to account "${accountId}" from ${envSecret ? 'env' : 'base config'}`);
        }
      }
    }
  }

  const next = `${JSON.stringify(cfg, null, 2)}\n`;
  if (next === raw) return;

  const tmpPath = `${configPath}.tmp.${Date.now()}`;
  await fs.writeFile(tmpPath, next, 'utf-8');
  await fs.rename(tmpPath, configPath);
  logger.info(`ClawTalk: reconciled Slack routing for ${desired.length} talk channel/user bindings`);
}
