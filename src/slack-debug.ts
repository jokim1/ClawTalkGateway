/**
 * Slack Debug Ring Buffer
 *
 * Circular buffer of recent Slack-related events for diagnostics.
 * Enabled via CLAWTALK_SLACK_DEBUG=1 environment variable.
 */

import { hostname } from 'node:os';

export type SlackDebugPath = 'slack-ingress' | 'event-reply' | 'openclaw-message';

export type SlackDebugEntry = {
  ts: number;
  instanceTag: string;
  path: SlackDebugPath;
  phase: string;
  failurePhase?: string;
  attempt?: number;
  attemptToken?: string;
  elapsedMs?: number;
  talkId?: string;
  jobId?: string;
  eventId?: string;
  accountId?: string;
  channelIdRaw?: string;
  channelIdResolved?: string;
  threadTs?: string;
  errorCode?: string;
  errorMessage?: string;
};

const SLACK_DEBUG_RING_MAX = 200;
const slackDebugRing: SlackDebugEntry[] = [];

export function isSlackDebugEnabled(): boolean {
  return process.env.CLAWTALK_SLACK_DEBUG === '1';
}

export function computeSlackInstanceTag(): string {
  const explicit = (process.env.CLAWTALK_SLACK_DEBUG_INSTANCE_TAG ?? '').trim();
  if (explicit) return explicit.slice(0, 64);
  const host = hostname().replace(/[^a-zA-Z0-9_.-]+/g, '').slice(0, 24) || 'host';
  const boot = Date.now().toString(36).slice(-6);
  return `${host}:${process.pid}:${boot}`.slice(0, 64);
}

export function recordSlackDebug(entry: Omit<SlackDebugEntry, 'ts' | 'instanceTag'>, instanceTag: string): void {
  const normalized: SlackDebugEntry = {
    ts: Date.now(),
    instanceTag,
    ...entry,
    ...(entry.errorMessage ? { errorMessage: entry.errorMessage.slice(0, 220) } : {}),
  };
  slackDebugRing.push(normalized);
  if (slackDebugRing.length > SLACK_DEBUG_RING_MAX) {
    slackDebugRing.splice(0, slackDebugRing.length - SLACK_DEBUG_RING_MAX);
  }
}

export function querySlackDebugRing(filter: {
  talkId?: string;
  path?: SlackDebugPath;
}, limit: number): SlackDebugEntry[] {
  return slackDebugRing
    .filter((entry) => {
      if (filter.talkId && entry.talkId !== filter.talkId) return false;
      if (filter.path && entry.path !== filter.path) return false;
      return true;
    })
    .slice(-limit)
    .reverse();
}
