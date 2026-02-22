/**
 * Slack Scope Resolver
 *
 * Resolves Slack channel/user scope strings (e.g. "#general", "channel:C123")
 * to canonical binding scopes. Includes channel name → ID resolution with
 * caching and multi-account support.
 */

import type { HandlerContext } from './types.js';
import { SLACK_DEFAULT_ACCOUNT_ID, normalizeSlackAccountId, listSlackAccountIds, resolveSlackBotTokenForAccount } from './slack-auth.js';

export function normalizeSlackBindingScope(scope: string): string | null {
  const trimmed = scope.trim();
  if (!trimmed) return null;

  if (/^(?:\*|all|slack:\*)$/i.test(trimmed)) {
    return 'slack:*';
  }

  const channel =
    trimmed.match(/^channel:([a-z0-9]+)$/i) ??
    trimmed.match(/^slack:channel:([a-z0-9]+)$/i);
  if (channel?.[1]) {
    return `channel:${channel[1].toUpperCase()}`;
  }

  const user =
    trimmed.match(/^user:([a-z0-9]+)$/i) ??
    trimmed.match(/^slack:user:([a-z0-9]+)$/i);
  if (user?.[1]) {
    return `user:${user[1].toUpperCase()}`;
  }

  return null;
}

export type SlackScopeResolutionResult =
  | { ok: true; canonicalScope: string; accountId?: string; displayScope?: string }
  | { ok: false; error: string };

type SlackConversation = {
  id?: string;
  name?: string;
  name_normalized?: string;
};

type SlackConversationsListResponse = {
  ok?: boolean;
  error?: string;
  channels?: SlackConversation[];
  response_metadata?: {
    next_cursor?: string;
  };
};

type SlackConversationInfoResponse = {
  ok?: boolean;
  error?: string;
  channel?: SlackConversation;
};

const SLACK_LOOKUP_TIMEOUT_MS = 10_000;
const SLACK_CHANNEL_CACHE_TTL_MS = 5 * 60_000;

const slackChannelNameByIdCache = new Map<string, { name: string; expiresAt: number }>();
const slackChannelIdByNameCache = new Map<string, { id: string; name: string; expiresAt: number }>();

export function normalizeSlackChannelNameScope(scope: string): string | null {
  const trimmed = scope.trim();
  if (!trimmed) return null;

  const withPrefix =
    trimmed.match(/^#([a-z0-9._-]+)$/i) ??
    trimmed.match(/^channel:#([a-z0-9._-]+)$/i) ??
    trimmed.match(/^slack:channel:#([a-z0-9._-]+)$/i);
  if (withPrefix?.[1]) {
    return withPrefix[1].toLowerCase();
  }

  const maybeNamedChannel =
    trimmed.match(/^channel:([a-z0-9._-]+)$/i) ??
    trimmed.match(/^slack:channel:([a-z0-9._-]+)$/i);
  if (maybeNamedChannel?.[1]) {
    // If channel:<ID> already matched the canonical parser, don't treat it as a name.
    const candidate = maybeNamedChannel[1];
    if (/^[cu][a-z0-9]+$/i.test(candidate)) {
      return null;
    }
    return candidate.toLowerCase();
  }

  if (/^[a-z0-9._-]+$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return null;
}

function getCachedSlackChannelName(accountId: string, channelId: string): string | undefined {
  const key = `${accountId}:${channelId.toUpperCase()}`;
  const cached = slackChannelNameByIdCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    slackChannelNameByIdCache.delete(key);
    return undefined;
  }
  return cached.name;
}

function setCachedSlackChannelName(accountId: string, channelId: string, channelName: string): void {
  const now = Date.now();
  const keyById = `${accountId}:${channelId.toUpperCase()}`;
  const keyByName = `${accountId}:${channelName.toLowerCase()}`;
  slackChannelNameByIdCache.set(keyById, {
    name: channelName,
    expiresAt: now + SLACK_CHANNEL_CACHE_TTL_MS,
  });
  slackChannelIdByNameCache.set(keyByName, {
    id: channelId.toUpperCase(),
    name: channelName,
    expiresAt: now + SLACK_CHANNEL_CACHE_TTL_MS,
  });
}

function getCachedSlackChannelId(accountId: string, channelName: string): { id: string; name: string } | undefined {
  const key = `${accountId}:${channelName.toLowerCase()}`;
  const cached = slackChannelIdByNameCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    slackChannelIdByNameCache.delete(key);
    return undefined;
  }
  return { id: cached.id, name: cached.name };
}

async function fetchSlackConversationInfo(params: {
  token: string;
  channelId: string;
}): Promise<SlackConversationInfoResponse | null> {
  const url = new URL('https://slack.com/api/conversations.info');
  url.searchParams.set('channel', params.channelId);
  url.searchParams.set('include_num_members', 'false');
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${params.token}`,
      },
      signal: AbortSignal.timeout(SLACK_LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as SlackConversationInfoResponse;
  } catch {
    return null;
  }
}

async function fetchSlackChannelByName(params: {
  token: string;
  channelName: string;
}): Promise<{ id: string; name: string } | null> {
  let cursor = '';
  const wantedName = params.channelName.toLowerCase();

  while (true) {
    const url = new URL('https://slack.com/api/conversations.list');
    url.searchParams.set('exclude_archived', 'true');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('types', 'public_channel,private_channel');
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    let payload: SlackConversationsListResponse | null = null;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${params.token}`,
        },
        signal: AbortSignal.timeout(SLACK_LOOKUP_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      payload = (await res.json()) as SlackConversationsListResponse;
    } catch {
      return null;
    }

    if (!payload?.ok) return null;
    for (const channel of payload.channels ?? []) {
      const channelId = channel.id?.trim();
      const name = (channel.name_normalized ?? channel.name ?? '').trim();
      if (!channelId || !name) continue;
      if (name.toLowerCase() !== wantedName) continue;
      return { id: channelId.toUpperCase(), name };
    }

    const nextCursor = payload.response_metadata?.next_cursor?.trim();
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return null;
}

export function createSlackScopeResolver(cfg: Record<string, any>, logger: HandlerContext['logger']) {
  const accounts = listSlackAccountIds(cfg)
    .map((accountId) => ({
      accountId: accountId.toLowerCase(),
      token: resolveSlackBotTokenForAccount(cfg, accountId),
    }))
    .filter((entry): entry is { accountId: string; token: string } => Boolean(entry.token));

  const defaultAccountId = accounts[0]?.accountId ?? SLACK_DEFAULT_ACCOUNT_ID;

  const selectAccounts = (accountHint?: string): Array<{ accountId: string; token: string }> => {
    const normalizedHint = normalizeSlackAccountId(accountHint);
    if (!normalizedHint) return accounts;
    return accounts.filter((account) => account.accountId === normalizedHint);
  };

  return async (scope: string, accountIdHint?: string): Promise<SlackScopeResolutionResult> => {
    const normalizedHint = normalizeSlackAccountId(accountIdHint);
    const candidateAccounts = selectAccounts(normalizedHint);
    if (normalizedHint && candidateAccounts.length === 0) {
      return {
        ok: false,
        error: `references unknown Slack account "${normalizedHint}".`,
      };
    }

    const canonical = normalizeSlackBindingScope(scope);
    if (canonical) {
      if (!canonical.startsWith('channel:')) {
        return {
          ok: true,
          canonicalScope: canonical,
          accountId: normalizedHint ?? defaultAccountId,
        };
      }

      const channelId = canonical.slice('channel:'.length);
      if (!channelId) {
        return {
          ok: true,
          canonicalScope: canonical,
          accountId: normalizedHint ?? defaultAccountId,
        };
      }

      const accountsForLookup = candidateAccounts.length > 0 ? candidateAccounts : accounts;
      const cachedName = accountsForLookup[0]
        ? getCachedSlackChannelName(accountsForLookup[0].accountId, channelId)
        : undefined;
      if (cachedName) {
        return {
          ok: true,
          canonicalScope: canonical,
          accountId: accountsForLookup[0].accountId,
          displayScope: `#${cachedName}`,
        };
      }

      if (accountsForLookup.length === 0) {
        return {
          ok: true,
          canonicalScope: canonical,
          accountId: normalizedHint ?? defaultAccountId,
        };
      }

      for (const account of accountsForLookup) {
        const info = await fetchSlackConversationInfo({ token: account.token, channelId });
        if (!info?.ok || !info.channel?.id) continue;
        const channelName = (info.channel.name_normalized ?? info.channel.name ?? '').trim();
        if (!channelName) continue;
        setCachedSlackChannelName(account.accountId, info.channel.id, channelName);
        return {
          ok: true,
          canonicalScope: canonical,
          accountId: account.accountId,
          displayScope: `#${channelName}`,
        };
      }

      return {
        ok: true,
        canonicalScope: canonical,
        accountId: normalizedHint ?? defaultAccountId,
      };
    }

    const channelName = normalizeSlackChannelNameScope(scope);
    if (!channelName) {
      const trimmedScope = scope.trim();
      const looksLikeDisplayLabel = /\s+#/.test(trimmedScope)
        && !trimmedScope.startsWith('#')
        && !/^[a-z0-9._-]+:#/i.test(trimmedScope)
        && !/^account:[a-z0-9._-]+:/i.test(trimmedScope)
        && !/^channel:/i.test(trimmedScope)
        && !/^user:/i.test(trimmedScope)
        && !/^slack:/i.test(trimmedScope);
      if (looksLikeDisplayLabel) {
        return {
          ok: false,
          error:
            `Invalid Slack scope "${scope}". ` +
            'This looks like a display label. Use account ID scope (e.g. lilagames:#team-product) ' +
            'or channel:<ID> (e.g. channel:C01JZCR4ATU).',
        };
      }
      return {
        ok: false,
        error:
          `Invalid Slack scope "${scope}". ` +
          'Use channel:<ID>, user:<ID>, #channel, account:#channel, channel:<name>, or slack:*.',
      };
    }

    if (candidateAccounts.length === 0) {
      return {
        ok: false,
        error:
          `Cannot resolve Slack channel "${channelName}" because no Slack bot token is configured. ` +
          'Set channels.slack.accounts.<id>.botToken (or channels.slack.botToken/SLACK_BOT_TOKEN for default).',
      };
    }

    if (!normalizedHint && candidateAccounts.length > 1) {
      return {
        ok: false,
        error:
          `is ambiguous across Slack accounts for channel "${channelName}". ` +
          'Prefix scope with an account, e.g. kimfamily:#general or account:kimfamily:#general.',
      };
    }

    for (const account of candidateAccounts) {
      const cached = getCachedSlackChannelId(account.accountId, channelName);
      if (cached) {
        return {
          ok: true,
          canonicalScope: `channel:${cached.id.toUpperCase()}`,
          accountId: account.accountId,
          displayScope: `#${cached.name}`,
        };
      }

      const resolved = await fetchSlackChannelByName({
        token: account.token,
        channelName,
      });
      if (!resolved) continue;
      setCachedSlackChannelName(account.accountId, resolved.id, resolved.name);
      return {
        ok: true,
        canonicalScope: `channel:${resolved.id.toUpperCase()}`,
        accountId: account.accountId,
        displayScope: `#${resolved.name}`,
      };
    }

    logger.warn(
      `ClawTalk: Slack channel lookup failed for scope "${scope}"` +
      `${normalizedHint ? ` account=${normalizedHint}` : ''}`,
    );
    return {
      ok: false,
      error:
        `Slack channel "${channelName}" not found or not visible to the configured Slack bot token. ` +
        'Invite the bot to the channel or use channel:<ID>.',
    };
  };
}
