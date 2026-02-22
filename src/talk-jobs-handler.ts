/**
 * Talk Job HTTP Handlers
 *
 * Handles /api/talks/:id/jobs endpoints for creating, listing,
 * updating, and deleting scheduled jobs, plus job reports.
 */

import type { HandlerContext, JobOutputDestination } from './types.js';
import type { TalkStore } from './talk-store.js';
import { sendJson, readJsonBody } from './http.js';
import { validateSchedule, parseEventTrigger } from './job-scheduler.js';
import { requireTalkPreconditionVersion, extractClientIdHeader } from './talks.js';

function normalizeJobOutputInput(raw: unknown): { ok: true; output: JobOutputDestination } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, output: { type: 'report_only' } };
  }
  if (typeof raw !== 'object') {
    return { ok: false, error: 'output must be an object' };
  }
  const row = raw as Record<string, unknown>;
  const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
  if (type === 'report_only') {
    return { ok: true, output: { type: 'report_only' } };
  }
  if (type === 'talk') {
    return { ok: true, output: { type: 'talk' } };
  }
  if (type === 'slack') {
    const channelId = typeof row.channelId === 'string' ? row.channelId.trim() : '';
    if (!channelId) {
      return { ok: false, error: 'output.channelId is required when output.type is "slack"' };
    }
    const accountId = typeof row.accountId === 'string' ? row.accountId.trim() : '';
    const threadTs = typeof row.threadTs === 'string' ? row.threadTs.trim() : '';
    return {
      ok: true,
      output: {
        type: 'slack',
        channelId,
        ...(accountId ? { accountId } : {}),
        ...(threadTs ? { threadTs } : {}),
      },
    };
  }
  return { ok: false, error: 'output.type must be one of: report_only, talk, slack' };
}

export async function handleCreateJob(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const precondition = requireTalkPreconditionVersion(ctx, talk);
  if (!precondition.ok) return;
  const modifiedBy = extractClientIdHeader(ctx);

  let body: { schedule?: string; prompt?: string; output?: unknown };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.schedule || !body.prompt) {
    sendJson(ctx.res, 400, { error: 'Missing schedule or prompt' });
    return;
  }
  const outputResult = normalizeJobOutputInput(body.output);
  if (!outputResult.ok) {
    sendJson(ctx.res, 400, { error: outputResult.error });
    return;
  }

  const scheduleError = validateSchedule(body.schedule);
  if (scheduleError) {
    sendJson(ctx.res, 400, { error: scheduleError });
    return;
  }

  // Detect event-driven jobs and validate scope against platform bindings
  const eventScope = parseEventTrigger(body.schedule);
  let jobType: 'once' | 'recurring' | 'event';
  if (/^(in\s|at\s)/i.test(body.schedule)) {
    jobType = 'once';
  } else {
    jobType = 'recurring';
  }

  if (eventScope) {
    const bindings = talk.platformBindings ?? [];

    // Resolve platformN shorthand → real scope
    let resolvedScope = eventScope;
    const platformMatch = eventScope.match(/^platform(\d+)$/i);
    if (platformMatch) {
      const idx = parseInt(platformMatch[1], 10);
      if (idx < 1 || idx > bindings.length) {
        sendJson(ctx.res, 400, {
          error: `No platform binding at position ${idx}. This talk has ${bindings.length} binding(s). Use /platform list to see them.`,
        });
        return;
      }
      resolvedScope = bindings[idx - 1].scope;
    }

    const matchingBinding = bindings.find(
      b => b.scope.toLowerCase() === resolvedScope.toLowerCase(),
    );
    if (!matchingBinding) {
      sendJson(ctx.res, 400, {
        error: `No platform binding found for "${resolvedScope}". Add one with /platform <name> ${resolvedScope} <permission>, or use platformN shorthand.`,
      });
      return;
    }
    // Rewrite schedule with resolved scope so downstream always sees real scope
    body.schedule = `on ${resolvedScope}`;
    jobType = 'event';
  }

  const job = store.addJob(talkId, body.schedule, body.prompt, jobType, outputResult.output, { modifiedBy });
  if (!job) {
    sendJson(ctx.res, 500, { error: 'Failed to create job' });
    return;
  }
  sendJson(ctx.res, 201, job);
}

export async function handleListJobs(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const jobs = store.listJobs(talkId);
  sendJson(ctx.res, 200, { jobs });
}

export async function handleUpdateJob(ctx: HandlerContext, store: TalkStore, talkId: string, jobId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const precondition = requireTalkPreconditionVersion(ctx, talk);
  if (!precondition.ok) return;
  const modifiedBy = extractClientIdHeader(ctx);

  let body: { active?: boolean; schedule?: string; prompt?: string; output?: unknown };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  let nextOutput: JobOutputDestination | undefined;
  if (body.output !== undefined) {
    const outputResult = normalizeJobOutputInput(body.output);
    if (!outputResult.ok) {
      sendJson(ctx.res, 400, { error: outputResult.error });
      return;
    }
    nextOutput = outputResult.output;
  }

  let nextType: 'once' | 'recurring' | 'event' | undefined;
  if (body.schedule) {
    const scheduleError = validateSchedule(body.schedule);
    if (scheduleError) {
      sendJson(ctx.res, 400, { error: scheduleError });
      return;
    }

    const eventScope = parseEventTrigger(body.schedule);
    if (eventScope) {
      const bindings = talk.platformBindings ?? [];

      let resolvedScope = eventScope;
      const platformMatch = eventScope.match(/^platform(\d+)$/i);
      if (platformMatch) {
        const idx = parseInt(platformMatch[1], 10);
        if (idx < 1 || idx > bindings.length) {
          sendJson(ctx.res, 400, {
            error: `No platform binding at position ${idx}. This talk has ${bindings.length} binding(s).`,
          });
          return;
        }
        resolvedScope = bindings[idx - 1].scope;
      }

      const matchingBinding = bindings.find(
        b => b.scope.toLowerCase() === resolvedScope.toLowerCase(),
      );
      if (!matchingBinding) {
        sendJson(ctx.res, 400, {
          error: `No platform binding found for "${resolvedScope}". Add a channel connection first.`,
        });
        return;
      }

      body.schedule = `on ${resolvedScope}`;
      nextType = 'event';
    } else if (/^(in\s|at\s)/i.test(body.schedule)) {
      nextType = 'once';
    } else {
      nextType = 'recurring';
    }
  }

  const updated = store.updateJob(talkId, jobId, {
    ...(body.active !== undefined ? { active: body.active } : {}),
    ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
    ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
    ...(nextOutput ? { output: nextOutput } : {}),
    ...(nextType ? { type: nextType } : {}),
  }, { modifiedBy });
  if (!updated) {
    sendJson(ctx.res, 404, { error: 'Job not found' });
    return;
  }
  sendJson(ctx.res, 200, updated);
}

export async function handleDeleteJob(ctx: HandlerContext, store: TalkStore, talkId: string, jobId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const precondition = requireTalkPreconditionVersion(ctx, talk);
  if (!precondition.ok) return;
  const modifiedBy = extractClientIdHeader(ctx);
  const success = store.deleteJob(talkId, jobId, { modifiedBy });
  if (!success) {
    sendJson(ctx.res, 404, { error: 'Job not found' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true });
}

export async function handleGetReports(ctx: HandlerContext, store: TalkStore, talkId: string, jobId?: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const limit = parseInt(ctx.url.searchParams.get('limit') ?? '20', 10);
  const sinceParam = ctx.url.searchParams.get('since');
  const since = sinceParam ? parseInt(sinceParam, 10) : undefined;
  const reports = await store.getRecentReports(talkId, limit, jobId, since);
  sendJson(ctx.res, 200, { reports });
}
