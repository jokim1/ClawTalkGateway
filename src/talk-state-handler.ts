/**
 * Talk State HTTP Handlers
 *
 * Handles /api/talks/:id/state/:stream endpoints for state events,
 * snapshots, and policy management.
 */

import type { HandlerContext } from './types.js';
import type { TalkStore } from './talk-store.js';
import { sendJson, readJsonBody } from './http.js';
import { extractClientIdHeader } from './talks.js';

export async function handleGetStateSummary(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
  stream: string,
): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const asOfRaw = ctx.url.searchParams.get('asOf');
  const asOf = asOfRaw ? Number(asOfRaw) : undefined;
  const summary = await store.getStateSnapshot(
    talkId,
    stream,
    Number.isFinite(asOf) ? asOf : undefined,
  );
  sendJson(ctx.res, 200, { summary });
}

export async function handleGetStateEvents(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
  stream: string,
): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const limitRaw = ctx.url.searchParams.get('limit');
  const sinceSequenceRaw = ctx.url.searchParams.get('sinceSequence');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  const sinceSequence = sinceSequenceRaw ? Number(sinceSequenceRaw) : undefined;
  const events = await store.getStateEvents(talkId, stream, {
    limit: Number.isFinite(limit) ? limit : undefined,
    sinceSequence: Number.isFinite(sinceSequence) ? sinceSequence : undefined,
  });
  sendJson(ctx.res, 200, { events, count: events.length });
}

export async function handleAppendStateEvent(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
  stream: string,
): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const modifiedBy = extractClientIdHeader(ctx);
  let body: {
    type?: string;
    payload?: Record<string, unknown>;
    occurredAt?: number;
    idempotencyKey?: string;
    actor?: string;
  };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const type = typeof body.type === 'string' ? body.type.trim() : '';
  if (!type || !body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    sendJson(ctx.res, 400, { error: 'Missing/invalid required fields: type, payload(object)' });
    return;
  }
  const appended = await store.appendStateEvent(
    talkId,
    stream,
    {
      type,
      payload: body.payload,
      occurredAt: Number.isFinite(body.occurredAt) ? body.occurredAt : undefined,
      idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
      actor: typeof body.actor === 'string' ? body.actor : undefined,
    },
    { modifiedBy },
  );
  if (!appended) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  sendJson(ctx.res, 201, appended);
}

export async function handleGetStatePolicy(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
  stream: string,
): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const policy = await store.getStatePolicy(talkId, stream);
  sendJson(ctx.res, 200, { policy });
}

export async function handleUpdateStatePolicy(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
  stream: string,
): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const modifiedBy = extractClientIdHeader(ctx);
  let body: {
    timezone?: string;
    weekStartDay?: number;
    rolloverHour?: number;
    rolloverMinute?: number;
    carryOverMode?: 'none' | 'excess_only' | 'all';
    targetMinutes?: number;
  };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const policy = await store.configureStatePolicy(
    talkId,
    stream,
    {
      timezone: body.timezone,
      weekStartDay: Number.isFinite(body.weekStartDay) ? body.weekStartDay : undefined,
      rolloverHour: Number.isFinite(body.rolloverHour) ? body.rolloverHour : undefined,
      rolloverMinute: Number.isFinite(body.rolloverMinute) ? body.rolloverMinute : undefined,
      carryOverMode: body.carryOverMode,
      targetMinutes: Number.isFinite(body.targetMinutes) ? body.targetMinutes : undefined,
    },
    { modifiedBy },
  );
  if (!policy) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  sendJson(ctx.res, 200, { policy });
}
