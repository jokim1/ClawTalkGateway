/**
 * Slack Reply Handler
 *
 * Delivers event job output back to Slack channels via chat.postMessage.
 * Includes channel name → ID resolution with caching.
 */

import type { EventReplyTarget } from './event-dispatcher.js';
import type { TalkStore } from './talk-store.js';
import type { Logger } from './types.js';
import type { SlackDebugEntry } from './slack-debug.js';
import { resolveSlackBotTokenForAccount } from './slack-auth.js';

export async function fetchSlackChannelsForAccount(params: {
  token: string;
  limit: number;
}): Promise<Array<{ id: string; name: string; scope: string; displayScope: string }>> {
  const channels: Array<{ id: string; name: string; scope: string; displayScope: string }> = [];
  let cursor = '';
  const timeoutMs = 5_000;

  while (channels.length < params.limit) {
    const url = new URL('https://slack.com/api/conversations.list');
    url.searchParams.set('exclude_archived', 'true');
    url.searchParams.set('limit', '1000');
    url.searchParams.set('types', 'public_channel,private_channel');
    if (cursor) url.searchParams.set('cursor', cursor);

    let payload: any;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${params.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) break;
      payload = await res.json();
    } catch {
      break;
    }

    if (!payload?.ok) break;
    const batch = Array.isArray(payload.channels) ? payload.channels : [];
    for (const channel of batch) {
      const id = typeof channel?.id === 'string' ? channel.id.trim().toUpperCase() : '';
      const name = typeof channel?.name_normalized === 'string'
        ? channel.name_normalized.trim()
        : (typeof channel?.name === 'string' ? channel.name.trim() : '');
      if (!id || !name) continue;
      channels.push({
        id,
        name,
        scope: `channel:${id}`,
        displayScope: `#${name}`,
      });
      if (channels.length >= params.limit) break;
    }

    const nextCursor = typeof payload?.response_metadata?.next_cursor === 'string'
      ? payload.response_metadata.next_cursor.trim()
      : '';
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  return channels;
}

export function collectTalkSlackChannelHints(params: {
  talkStore: TalkStore;
  accountId: string;
  limit: number;
}): Array<{ id: string; name?: string; scope: string; displayScope: string }> {
  const results = new Map<string, { id: string; name?: string; scope: string; displayScope: string }>();
  const desiredAccount = params.accountId.trim().toLowerCase() || 'default';

  for (const talk of params.talkStore.listTalks()) {
    for (const binding of talk.platformBindings ?? []) {
      if (binding.platform.trim().toLowerCase() !== 'slack') continue;
      const bindingAccount = (binding.accountId?.trim().toLowerCase() || 'default');
      if (bindingAccount !== desiredAccount) continue;

      const scope = binding.scope.trim();
      const channelMatch = scope.match(/^channel:([a-z0-9]+)$/i);
      if (!channelMatch?.[1]) continue;

      const id = channelMatch[1].toUpperCase();
      const displayScope = binding.displayScope?.trim() || `#${id}`;
      const name = displayScope.startsWith('#') ? displayScope.slice(1) : undefined;
      results.set(id, {
        id,
        scope: `channel:${id}`,
        displayScope,
        ...(name ? { name } : {}),
      });
      if (results.size >= params.limit) break;
    }
    if (results.size >= params.limit) break;
  }

  return Array.from(results.values());
}

export function createEventReplyHandler(
  getConfig: () => Record<string, any>,
  logger: Logger,
  opts?: {
    debugEnabled?: () => boolean;
    onDebug?: (entry: Omit<SlackDebugEntry, 'ts' | 'instanceTag'>) => void;
  },
) {
  const nameCacheByAccount = new Map<string, { expiresAt: number; byName: Map<string, string> }>();
  const normalizeChannelName = (value: string): string =>
    value.trim().toLowerCase().replace(/^#/, '').replace(/^channel:/, '').trim();
  const isCanonicalChannelId = (value: string): boolean => /^[CDGU][A-Z0-9]+$/.test(value.trim().toUpperCase());
  const inferErrorCode = (message: string): string => {
    const text = message.toLowerCase();
    if (text.includes('unknown channel')) return 'unknown_channel';
    if (text.includes('not_in_channel')) return 'not_in_channel';
    if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
    if (text.includes('unauthorized') || text.includes('forbidden')) return 'auth_error';
    return 'error';
  };
  const emit = (entry: Omit<SlackDebugEntry, 'ts' | 'instanceTag'>): void => {
    if (opts?.debugEnabled && !opts.debugEnabled()) return;
    opts?.onDebug?.(entry);
  };
  const resolveChannelId = async (
    channelRaw: string,
    accountId: string,
    token: string,
  ): Promise<string | undefined> => {
    const normalizedRaw = channelRaw.trim();
    if (!normalizedRaw) return undefined;
    const direct = normalizedRaw.includes(':') ? normalizedRaw.slice(normalizedRaw.lastIndexOf(':') + 1) : normalizedRaw;
    if (isCanonicalChannelId(direct)) {
      return direct.trim().toUpperCase();
    }
    const cacheKey = accountId.trim().toLowerCase() || 'default';
    const now = Date.now();
    const cached = nameCacheByAccount.get(cacheKey);
    if (!cached || cached.expiresAt <= now) {
      const channels = await fetchSlackChannelsForAccount({ token, limit: 2000 });
      const byName = new Map<string, string>();
      for (const channel of channels) {
        byName.set(normalizeChannelName(channel.name), channel.id);
      }
      nameCacheByAccount.set(cacheKey, { expiresAt: now + 5 * 60_000, byName });
    }
    const refreshed = nameCacheByAccount.get(cacheKey);
    return refreshed?.byName.get(normalizeChannelName(direct));
  };
  return async (target: EventReplyTarget, message: string): Promise<boolean> => {
    if (target.platform !== 'slack') {
      logger.warn(`EventReply: unsupported platform "${target.platform}"`);
      return false;
    }

    if (!target.platformChannelId || !target.accountId) {
      logger.warn('EventReply: slack_account_context_required (missing channelId or accountId)');
      return false;
    }

    const cfg = getConfig();
    const botToken = resolveSlackBotTokenForAccount(cfg, target.accountId);
    if (!botToken) {
      logger.warn(`EventReply: no bot token for Slack account "${target.accountId}"`);
      emit({
        path: 'event-reply',
        phase: 'send_fail',
        accountId: target.accountId,
        channelIdRaw: target.platformChannelId,
        threadTs: target.threadId,
        errorCode: 'missing_token',
        errorMessage: `no bot token for account ${target.accountId ?? '-'}`,
      });
      return false;
    }

    try {
      const resolvedChannelId = await resolveChannelId(
        target.platformChannelId,
        target.accountId,
        botToken,
      );
      if (!resolvedChannelId) {
        const errorMessage = `Unknown channel: ${target.platformChannelId}`;
        emit({
          path: 'event-reply',
          phase: 'send_fail',
          accountId: target.accountId,
          channelIdRaw: target.platformChannelId,
          threadTs: target.threadId,
          errorCode: 'unknown_channel_name',
          errorMessage,
        });
        logger.warn(`EventReply: ${errorMessage}`);
        return false;
      }
      emit({
        path: 'event-reply',
        phase: 'send_start',
        accountId: target.accountId,
        channelIdRaw: target.platformChannelId,
        channelIdResolved: resolvedChannelId,
        threadTs: target.threadId,
      });
      const body: Record<string, unknown> = {
        channel: resolvedChannelId,
        text: message,
      };
      if (target.threadId) {
        body.thread_ts = target.threadId;
      }

      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const result = await res.json() as { ok: boolean; error?: string };
      if (!result.ok) {
        emit({
          path: 'event-reply',
          phase: 'send_fail',
          accountId: target.accountId,
          channelIdRaw: target.platformChannelId,
          channelIdResolved: resolvedChannelId,
          threadTs: target.threadId,
          errorCode: inferErrorCode(result.error ?? 'error'),
          errorMessage: result.error ?? 'slack api error',
        });
        logger.warn(`EventReply: Slack API error: ${result.error}`);
        return false;
      }

      emit({
        path: 'event-reply',
        phase: 'send_ok',
        accountId: target.accountId,
        channelIdRaw: target.platformChannelId,
        channelIdResolved: resolvedChannelId,
        threadTs: target.threadId,
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({
        path: 'event-reply',
        phase: 'send_fail',
        accountId: target.accountId,
        channelIdRaw: target.platformChannelId,
        threadTs: target.threadId,
        errorCode: inferErrorCode(msg),
        errorMessage: msg,
      });
      logger.warn(`EventReply: Slack post failed: ${msg}`);
      return false;
    }
  };
}
