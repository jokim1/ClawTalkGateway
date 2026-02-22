/**
 * Talk State Store — Pure Computation
 *
 * State-related constants, normalizers, and snapshot computation logic
 * used by TalkStore for structured talk state (event ledger + snapshots).
 */

import type {
  TalkStateCarryOverMode,
  TalkStateEvent,
  TalkStatePolicy,
  TalkStateSnapshot,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_STATE_STREAM = 'default';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_STATE_POLICY_BASE = {
  timezone: 'America/Los_Angeles',
  weekStartDay: 1,
  rolloverHour: 0,
  rolloverMinute: 0,
  carryOverMode: 'excess_only' as TalkStateCarryOverMode,
  targetMinutes: 300,
};

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

export function normalizeStateStream(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) return DEFAULT_STATE_STREAM;
  const normalized = value.replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || DEFAULT_STATE_STREAM;
}

export function normalizeOptionalStateStream(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return normalizeStateStream(trimmed);
}

export function normalizeCarryOverMode(raw: unknown): TalkStateCarryOverMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'none' || value === 'excess_only' || value === 'all') return value;
  return DEFAULT_STATE_POLICY_BASE.carryOverMode;
}

export function normalizeStatePolicy(
  stream: string,
  raw: Partial<TalkStatePolicy> | undefined,
  now = Date.now(),
): TalkStatePolicy {
  return {
    stream: normalizeStateStream(stream),
    timezone:
      typeof raw?.timezone === 'string' && raw.timezone.trim()
        ? raw.timezone.trim()
        : DEFAULT_STATE_POLICY_BASE.timezone,
    weekStartDay:
      typeof raw?.weekStartDay === 'number' && Number.isInteger(raw.weekStartDay)
        ? Math.max(0, Math.min(6, raw.weekStartDay))
        : DEFAULT_STATE_POLICY_BASE.weekStartDay,
    rolloverHour:
      typeof raw?.rolloverHour === 'number' && Number.isInteger(raw.rolloverHour)
        ? Math.max(0, Math.min(23, raw.rolloverHour))
        : DEFAULT_STATE_POLICY_BASE.rolloverHour,
    rolloverMinute:
      typeof raw?.rolloverMinute === 'number' && Number.isInteger(raw.rolloverMinute)
        ? Math.max(0, Math.min(59, raw.rolloverMinute))
        : DEFAULT_STATE_POLICY_BASE.rolloverMinute,
    carryOverMode: normalizeCarryOverMode(raw?.carryOverMode),
    targetMinutes:
      typeof raw?.targetMinutes === 'number' && Number.isFinite(raw.targetMinutes) && raw.targetMinutes > 0
        ? Math.floor(raw.targetMinutes)
        : DEFAULT_STATE_POLICY_BASE.targetMinutes,
    updatedAt: typeof raw?.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
}

export function normalizeKidKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Week-boundary computation
// ---------------------------------------------------------------------------

export function formatWeekKeyFromPseudoUtc(startAt: number): string {
  const d = new Date(startAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function resolveWeekWindow(ts: number, policy: TalkStatePolicy): { weekKey: string; weekStartAt: number; weekEndAt: number } {
  const date = new Date(ts);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: policy.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const partMap = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(partMap.get('year') ?? '0');
  const month = Number(partMap.get('month') ?? '1');
  const day = Number(partMap.get('day') ?? '1');
  const hour = Number(partMap.get('hour') ?? '0');
  const minute = Number(partMap.get('minute') ?? '0');
  const second = Number(partMap.get('second') ?? '0');

  let pseudoNow = Date.UTC(year, month - 1, day, hour, minute, second);
  if (hour < policy.rolloverHour || (hour === policy.rolloverHour && minute < policy.rolloverMinute)) {
    pseudoNow -= DAY_MS;
  }
  const pseudoDate = new Date(pseudoNow);
  const pseudoWeekday = pseudoDate.getUTCDay();
  const daysSinceStart = (pseudoWeekday - policy.weekStartDay + 7) % 7;
  const weekStartDayAtMidnight = Date.UTC(
    pseudoDate.getUTCFullYear(),
    pseudoDate.getUTCMonth(),
    pseudoDate.getUTCDate(),
  ) - daysSinceStart * DAY_MS;
  const weekStartAt = weekStartDayAtMidnight + policy.rolloverHour * 60 * 60 * 1000 + policy.rolloverMinute * 60 * 1000;
  const weekEndAt = weekStartAt + 7 * DAY_MS;
  return {
    weekKey: formatWeekKeyFromPseudoUtc(weekStartAt),
    weekStartAt,
    weekEndAt,
  };
}

// ---------------------------------------------------------------------------
// Snapshot computation (pure functions)
// ---------------------------------------------------------------------------

export function computeCarryOver(
  totals: Record<string, number>,
  policy: TalkStatePolicy,
): Record<string, number> {
  const carry: Record<string, number> = {};
  for (const [kid, total] of Object.entries(totals)) {
    if (!Number.isFinite(total) || total <= 0) continue;
    if (policy.carryOverMode === 'all') {
      carry[kid] = total;
    } else if (policy.carryOverMode === 'excess_only') {
      carry[kid] = Math.max(0, total - policy.targetMinutes);
    }
  }
  return carry;
}

export function applyStateEventToTotals(
  totals: Record<string, number>,
  event: TalkStateEvent,
): Record<string, number> {
  const next = { ...totals };
  const payload = event.payload ?? {};
  if (event.type === 'minutes_logged' || event.type === 'manual_adjustment') {
    const kid = normalizeKidKey((payload as Record<string, unknown>).kid);
    const minutesRaw = Number((payload as Record<string, unknown>).minutes);
    if (!kid || !Number.isFinite(minutesRaw)) return next;
    next[kid] = Math.max(0, (next[kid] ?? 0) + minutesRaw);
    return next;
  }
  if (event.type === 'set_total') {
    const kid = normalizeKidKey((payload as Record<string, unknown>).kid);
    const totalRaw = Number((payload as Record<string, unknown>).total);
    if (!kid || !Number.isFinite(totalRaw)) return next;
    next[kid] = Math.max(0, totalRaw);
    return next;
  }
  return next;
}

export function buildStateSnapshot(
  stream: string,
  policy: TalkStatePolicy,
  events: TalkStateEvent[],
  asOf: number = Date.now(),
): TalkStateSnapshot {
  const normalizedStream = normalizeStateStream(stream);
  const baseWindow = resolveWeekWindow(asOf, policy);
  let currentWeek = baseWindow;
  let totals: Record<string, number> = {};
  let carryOver: Record<string, number> = {};

  for (const event of events) {
    const eventWeek = resolveWeekWindow(event.occurredAt || event.recordedAt || asOf, policy);
    if (eventWeek.weekStartAt > currentWeek.weekStartAt) {
      while (currentWeek.weekStartAt < eventWeek.weekStartAt) {
        carryOver = computeCarryOver(totals, policy);
        totals = { ...carryOver };
        currentWeek = {
          weekStartAt: currentWeek.weekStartAt + 7 * DAY_MS,
          weekEndAt: currentWeek.weekEndAt + 7 * DAY_MS,
          weekKey: formatWeekKeyFromPseudoUtc(currentWeek.weekStartAt + 7 * DAY_MS),
        };
      }
    } else if (eventWeek.weekStartAt < currentWeek.weekStartAt) {
      currentWeek = eventWeek;
      totals = {};
      carryOver = {};
    }
    totals = applyStateEventToTotals(totals, event);
  }

  const finalWindow = resolveWeekWindow(asOf, policy);
  if (finalWindow.weekStartAt > currentWeek.weekStartAt) {
    while (currentWeek.weekStartAt < finalWindow.weekStartAt) {
      carryOver = computeCarryOver(totals, policy);
      totals = { ...carryOver };
      currentWeek = {
        weekStartAt: currentWeek.weekStartAt + 7 * DAY_MS,
        weekEndAt: currentWeek.weekEndAt + 7 * DAY_MS,
        weekKey: formatWeekKeyFromPseudoUtc(currentWeek.weekStartAt + 7 * DAY_MS),
      };
    }
  } else {
    currentWeek = finalWindow;
  }

  const completed: Record<string, boolean> = {};
  for (const [kid, total] of Object.entries(totals)) {
    completed[kid] = total >= policy.targetMinutes;
  }

  return {
    stream: normalizedStream,
    weekKey: currentWeek.weekKey,
    weekStartAt: currentWeek.weekStartAt,
    weekEndAt: currentWeek.weekEndAt,
    totals,
    carryOver,
    completionTarget: policy.targetMinutes,
    completed,
    lastEventSequence: events.length ? events[events.length - 1].sequence : 0,
    updatedAt: Date.now(),
    policy,
  };
}
