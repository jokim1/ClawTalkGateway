/**
 * Talk CRUD HTTP Handlers
 *
 * Handles /api/talks endpoints for creating, listing, reading,
 * updating, and deleting Talks, plus message history and pins.
 */

import type { HandlerContext } from './types.js';
import type { TalkStore } from './talk-store.js';
import {
  normalizeToolNames,
} from './talk-store.js';
import type {
  TalkAgent,
  TalkMeta,
} from './types.js';
import type { ToolRegistry } from './tool-registry.js';
import { sendJson, readJsonBody } from './http.js';
import { reconcileSlackRoutingForTalks } from './slack-routing-sync.js';
import {
  googleDocsAuthStatus,
} from './google-docs.js';
import {
  EXECUTION_MODE_OPTIONS,
  executionModeLabel,
  normalizeExecutionModeInput,
  normalizeFilesystemAccessInput,
  normalizeNetworkAccessInput,
  resolveOpenClawNativeGoogleToolsEnabled,
  resolveProxyGatewayToolsEnabled,
  resolveExecutionMode,
  resolveFilesystemAccess,
  resolveNetworkAccess,
} from './talk-policy.js';
import { createSlackScopeResolver } from './slack-scope-resolver.js';
export { normalizeSlackBindingScope } from './slack-scope-resolver.js';
import {
  findSlackBindingConflicts,
  mapChannelResponseSettingsInput,
  normalizeAndValidateAgentsInput,
  normalizeAndValidatePlatformBehaviorsInput,
  normalizeAndValidatePlatformBindingsInput,
  resolvePlatformBehaviorBindingRefsInput,
} from './talk-platform-validation.js';
import {
  handleCreateJob,
  handleListJobs,
  handleUpdateJob,
  handleDeleteJob,
  handleGetReports,
} from './talk-jobs-handler.js';
import {
  handleGetStateSummary,
  handleGetStateEvents,
  handleAppendStateEvent,
  handleGetStatePolicy,
  handleUpdateStatePolicy,
} from './talk-state-handler.js';
import {
  handleGetTalkTools,
  handleUpdateTalkTools,
  handleGetTalkSkills,
  handleUpdateTalkSkills,
} from './talk-tools-handler.js';
export { handleGoogleOAuthCallback, handleToolRoutes } from './talk-tools-handler.js';


export function extractClientIdHeader(ctx: HandlerContext): string | undefined {
  const raw = ctx.req.headers['x-clawtalk-client-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseIfMatchVersionHeader(ctx: HandlerContext): number | undefined {
  const raw = ctx.req.headers['if-match'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return parsed;
}

export function requireTalkPreconditionVersion(
  ctx: HandlerContext,
  talk: TalkMeta,
): { ok: true; version: number } | { ok: false } {
  const expected = parseIfMatchVersionHeader(ctx);
  if (expected === undefined) {
    sendJson(ctx.res, 428, {
      error: 'Precondition required: send If-Match with current talkVersion.',
      code: 'TALK_PRECONDITION_REQUIRED',
      talkId: talk.id,
      currentVersion: talk.talkVersion,
    });
    return { ok: false };
  }
  if (expected !== talk.talkVersion) {
    sendJson(ctx.res, 409, {
      error: 'Talk has changed on the gateway. Re-fetch and retry.',
      code: 'TALK_VERSION_CONFLICT',
      talkId: talk.id,
      expectedVersion: talk.talkVersion,
      receivedVersion: expected,
      latestTalk: talk,
    });
    return { ok: false };
  }
  return { ok: true, version: expected };
}

type CatalogAuthRequirement = {
  id: string;
  ready: boolean;
  message?: string;
};

export function resolveExecutionCapabilities(params: {
  executionMode: 'openclaw' | 'full_control';
  openClawNativeToolsEnabled: boolean;
  proxyGatewayToolsEnabled: boolean;
}): {
  openclawNativeToolsAvailable: boolean;
  directGatewayToolsAvailable: boolean;
  effectiveToolEngine: 'openclaw_native' | 'gateway_direct' | 'none';
} {
  const openclawNativeToolsAvailable = params.openClawNativeToolsEnabled;
  const directGatewayToolsAvailable = params.proxyGatewayToolsEnabled;
  const effectiveToolEngine =
    params.executionMode === 'openclaw'
      ? (openclawNativeToolsAvailable ? 'openclaw_native' : 'none')
      : (directGatewayToolsAvailable ? 'gateway_direct' : 'none');
  return {
    openclawNativeToolsAvailable,
    directGatewayToolsAvailable,
    effectiveToolEngine,
  };
}

export async function resolveCatalogAuth(requirements: string[] | undefined): Promise<{
  ready: boolean;
  requirements: CatalogAuthRequirement[];
}> {
  const reqs = Array.isArray(requirements) ? requirements : [];
  if (reqs.length === 0) {
    return { ready: true, requirements: [] };
  }

  const statuses: CatalogAuthRequirement[] = [];
  for (const req of reqs) {
    if (req === 'google_oauth') {
      const status = await googleDocsAuthStatus();
      statuses.push({
        id: req,
        ready: Boolean(status.accessTokenReady),
        message: status.accessTokenReady
          ? undefined
          : status.error || `Google OAuth is not ready. Token file: ${status.tokenPath}`,
      });
      continue;
    }
    statuses.push({
      id: req,
      ready: false,
      message: `Auth provider "${req}" setup is not yet available in guided flow.`,
    });
  }

  return {
    ready: statuses.every((entry) => entry.ready),
    requirements: statuses,
  };
}

export function buildTalkAuthReadyResolver(input: {
  googleOAuthReady: boolean;
  googleAuthProfile?: string;
  getToolRequiredAuth: (toolName: string) => string[];
}): (toolName: string) => { ready: boolean; reason?: string } | undefined {
  const profileLabel = input.googleAuthProfile?.trim() || 'default';
  return (toolName: string) => {
    const required = input.getToolRequiredAuth(toolName);
    if (!required.includes('google_oauth')) return undefined;
    if (input.googleOAuthReady) return { ready: true };
    return {
      ready: false,
      reason: `Blocked by Google OAuth: profile "${profileLabel}" is not ready.`,
    };
  };
}

function normalizeObjectiveAlias(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim()) return entry.trim();
    }
  }
  return undefined;
}

// Thin wrappers over talk-store normalizers — return undefined for missing/invalid
// input rather than the store defaults.
export function normalizeToolModeInput(raw: unknown): 'off' | 'confirm' | 'auto' | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'off' || value === 'confirm' || value === 'auto') return value;
  return undefined;
}

export function normalizeToolNameListInput(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return normalizeToolNames(raw);
}

export function normalizeGoogleAuthProfileInput(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || '';
}

export function normalizeStateStreamInput(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || '';
}

export function normalizeStateBackendInput(raw: unknown): 'stream_store' | 'workspace_files' | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'stream_store') return 'stream_store';
  if (value === 'workspace_files' || value === 'workspace') return 'workspace_files';
  return undefined;
}

export function executionModeValidationError(): string {
  return 'executionMode must be one of: openclaw, full_control, openclaw_agent, clawtalk_proxy';
}

export function filesystemAccessValidationError(): string {
  return 'filesystemAccess must be one of: workspace_sandbox, full_host_access';
}

export function networkAccessValidationError(): string {
  return 'networkAccess must be one of: restricted, full_outbound';
}

export function stateBackendValidationError(): string {
  return 'stateBackend must be one of: stream_store, workspace_files';
}

/**
 * Route a /api/talks request to the appropriate handler.
 * Returns true if the request was handled.
 */
export async function handleTalks(ctx: HandlerContext, store: TalkStore, registry?: ToolRegistry): Promise<void> {
  const { req, res, url } = ctx;
  const pathname = url.pathname;

  // POST /api/talks — create
  if (pathname === '/api/talks' && req.method === 'POST') {
    return handleCreateTalk(ctx, store);
  }

  // GET /api/talks — list
  if (pathname === '/api/talks' && req.method === 'GET') {
    return handleListTalks(ctx, store);
  }

  // Match /api/talks/:id patterns
  const talkMatch = pathname.match(/^\/api\/talks\/([\w-]+)$/);
  if (talkMatch) {
    const talkId = talkMatch[1];
    if (req.method === 'GET') return handleGetTalk(ctx, store, talkId);
    if (req.method === 'PATCH') return handleUpdateTalk(ctx, store, talkId);
    if (req.method === 'DELETE') return handleDeleteTalk(ctx, store, talkId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET/DELETE /api/talks/:id/messages
  const messagesMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/messages$/);
  if (messagesMatch) {
    if (req.method === 'DELETE') return handleDeleteMessages(ctx, store, messagesMatch[1]);
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    return handleGetMessages(ctx, store, messagesMatch[1]);
  }

  // GET /api/talks/:id/diagnostics
  const diagnosticsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/diagnostics$/);
  if (diagnosticsMatch) {
    if (req.method === 'GET') return handleListDiagnostics(ctx, store, diagnosticsMatch[1]);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // PATCH /api/talks/:id/diagnostics/:issueId
  const diagnosticMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/diagnostics\/([\w-]+)$/);
  if (diagnosticMatch) {
    if (req.method === 'PATCH') return handleUpdateDiagnostic(ctx, store, diagnosticMatch[1], diagnosticMatch[2]);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET/PATCH /api/talks/:id/tools
  const toolsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/tools$/);
  if (toolsMatch) {
    const talkId = toolsMatch[1];
    if (req.method === 'GET') return handleGetTalkTools(ctx, store, talkId, registry);
    if (req.method === 'PATCH') return handleUpdateTalkTools(ctx, store, talkId, registry);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET/PATCH /api/talks/:id/skills
  const skillsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/skills$/);
  if (skillsMatch) {
    const talkId = skillsMatch[1];
    if (req.method === 'GET') return handleGetTalkSkills(ctx, store, talkId);
    if (req.method === 'PATCH') return handleUpdateTalkSkills(ctx, store, talkId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET /api/talks/:id/state/:stream/summary
  const stateSummaryMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/state\/([\w.-]+)\/summary$/);
  if (stateSummaryMatch) {
    const [, talkId, stream] = stateSummaryMatch;
    if (req.method === 'GET') return handleGetStateSummary(ctx, store, talkId, stream);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET/POST /api/talks/:id/state/:stream/events
  const stateEventsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/state\/([\w.-]+)\/events$/);
  if (stateEventsMatch) {
    const [, talkId, stream] = stateEventsMatch;
    if (req.method === 'GET') return handleGetStateEvents(ctx, store, talkId, stream);
    if (req.method === 'POST') return handleAppendStateEvent(ctx, store, talkId, stream);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET/PATCH /api/talks/:id/state/:stream/policy
  const statePolicyMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/state\/([\w.-]+)\/policy$/);
  if (statePolicyMatch) {
    const [, talkId, stream] = statePolicyMatch;
    if (req.method === 'GET') return handleGetStatePolicy(ctx, store, talkId, stream);
    if (req.method === 'PATCH') return handleUpdateStatePolicy(ctx, store, talkId, stream);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // POST/DELETE /api/talks/:id/pin/:msgId
  const pinMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/pin\/([\w-]+)$/);
  if (pinMatch) {
    const [, talkId, msgId] = pinMatch;
    if (req.method === 'POST') return handleAddPin(ctx, store, talkId, msgId);
    if (req.method === 'DELETE') return handleRemovePin(ctx, store, talkId, msgId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // POST/GET /api/talks/:id/jobs
  const jobsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/jobs$/);
  if (jobsMatch) {
    const talkId = jobsMatch[1];
    if (req.method === 'POST') return handleCreateJob(ctx, store, talkId);
    if (req.method === 'GET') return handleListJobs(ctx, store, talkId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // PATCH/DELETE /api/talks/:id/jobs/:jobId
  const jobMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/jobs\/([\w-]+)$/);
  if (jobMatch) {
    const [, talkId, jobId] = jobMatch;
    if (req.method === 'PATCH') return handleUpdateJob(ctx, store, talkId, jobId);
    if (req.method === 'DELETE') return handleDeleteJob(ctx, store, talkId, jobId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET /api/talks/:id/jobs/:jobId/reports
  const reportsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/jobs\/([\w-]+)\/reports$/);
  if (reportsMatch) {
    const [, talkId, jobId] = reportsMatch;
    if (req.method === 'GET') return handleGetReports(ctx, store, talkId, jobId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // GET /api/talks/:id/reports (all reports for a talk)
  const talkReportsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/reports$/);
  if (talkReportsMatch) {
    if (req.method === 'GET') return handleGetReports(ctx, store, talkReportsMatch[1]);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // POST/GET /api/talks/:id/agents
  const agentsMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/agents$/);
  if (agentsMatch) {
    const talkId = agentsMatch[1];
    if (req.method === 'POST') return handleAddAgent(ctx, store, talkId);
    if (req.method === 'GET') return handleListAgents(ctx, store, talkId);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // DELETE /api/talks/:id/agents/:name
  const agentMatch = pathname.match(/^\/api\/talks\/([\w-]+)\/agents\/([\w-]+)$/);
  if (agentMatch) {
    const [, talkId, agentName] = agentMatch;
    if (req.method === 'DELETE') return handleDeleteAgent(ctx, store, talkId, agentName);
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleCreateTalk(ctx: HandlerContext, store: TalkStore): Promise<void> {
  let body: {
    model?: string;
    topicTitle?: string;
    objective?: string;
    objectives?: string | string[];
    directives?: any[];
    rules?: any[];
    platformBindings?: any[];
    channelConnections?: any[];
    platformBehaviors?: any[];
    channelResponseSettings?: any[];
    toolMode?: string;
    executionMode?: string;
    filesystemAccess?: string;
    networkAccess?: string;
    stateBackend?: string;
    toolsAllow?: string[];
    toolsDeny?: string[];
    skills?: string[];
    googleAuthProfile?: string;
    defaultStateStream?: string;
    toolPolicy?: {
      mode?: string;
      executionMode?: string;
      filesystemAccess?: string;
      networkAccess?: string;
      stateBackend?: string;
      allow?: string[];
      deny?: string[];
      skills?: string[];
      googleAuthProfile?: string;
      defaultStateStream?: string;
    };
  } = {};
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    // empty body is fine
  }

  if (body.objective === undefined && body.objectives !== undefined) {
    body.objective = normalizeObjectiveAlias(body.objectives);
  }
  if (body.directives === undefined && body.rules !== undefined) {
    body.directives = body.rules;
  }
  if (body.platformBindings === undefined && body.channelConnections !== undefined) {
    body.platformBindings = body.channelConnections;
  }
  if (body.platformBehaviors === undefined && body.channelResponseSettings !== undefined) {
    body.platformBehaviors = mapChannelResponseSettingsInput(body.channelResponseSettings) as any[];
  }
  if (body.toolMode === undefined && body.toolPolicy?.mode !== undefined) {
    body.toolMode = body.toolPolicy.mode;
  }
  if (body.toolsAllow === undefined && body.toolPolicy?.allow !== undefined) {
    body.toolsAllow = body.toolPolicy.allow;
  }
  if (body.executionMode === undefined && body.toolPolicy?.executionMode !== undefined) {
    body.executionMode = body.toolPolicy.executionMode;
  }
  if (body.filesystemAccess === undefined && body.toolPolicy?.filesystemAccess !== undefined) {
    body.filesystemAccess = body.toolPolicy.filesystemAccess;
  }
  if (body.networkAccess === undefined && body.toolPolicy?.networkAccess !== undefined) {
    body.networkAccess = body.toolPolicy.networkAccess;
  }
  if (body.stateBackend === undefined && body.toolPolicy?.stateBackend !== undefined) {
    body.stateBackend = body.toolPolicy.stateBackend;
  }
  if (body.toolsDeny === undefined && body.toolPolicy?.deny !== undefined) {
    body.toolsDeny = body.toolPolicy.deny;
  }
  if (body.skills === undefined && body.toolPolicy?.skills !== undefined) {
    body.skills = body.toolPolicy.skills;
  }
  if (body.googleAuthProfile === undefined && body.toolPolicy?.googleAuthProfile !== undefined) {
    body.googleAuthProfile = body.toolPolicy.googleAuthProfile;
  }
  if (body.defaultStateStream === undefined && body.toolPolicy?.defaultStateStream !== undefined) {
    body.defaultStateStream = body.toolPolicy.defaultStateStream;
  }

  const toolMode = normalizeToolModeInput(body.toolMode);
  if (body.toolMode !== undefined && toolMode === undefined) {
    sendJson(ctx.res, 400, { error: 'toolMode must be one of: off, confirm, auto' });
    return;
  }
  const executionMode = normalizeExecutionModeInput(body.executionMode);
  if (body.executionMode !== undefined && executionMode === undefined) {
    sendJson(ctx.res, 400, { error: executionModeValidationError() });
    return;
  }
  const filesystemAccess = normalizeFilesystemAccessInput(body.filesystemAccess);
  if (body.filesystemAccess !== undefined && filesystemAccess === undefined) {
    sendJson(ctx.res, 400, { error: filesystemAccessValidationError() });
    return;
  }
  const networkAccess = normalizeNetworkAccessInput(body.networkAccess);
  if (body.networkAccess !== undefined && networkAccess === undefined) {
    sendJson(ctx.res, 400, { error: networkAccessValidationError() });
    return;
  }
  const stateBackend = normalizeStateBackendInput(body.stateBackend);
  if (body.stateBackend !== undefined && stateBackend === undefined) {
    sendJson(ctx.res, 400, { error: stateBackendValidationError() });
    return;
  }
  const toolsAllow = normalizeToolNameListInput(body.toolsAllow);
  const toolsDeny = normalizeToolNameListInput(body.toolsDeny);
  const googleAuthProfile = normalizeGoogleAuthProfileInput(body.googleAuthProfile);
  if (body.googleAuthProfile !== undefined && googleAuthProfile === undefined) {
    sendJson(ctx.res, 400, { error: 'googleAuthProfile must be a string' });
    return;
  }
  const defaultStateStream = normalizeStateStreamInput(body.defaultStateStream);
  if (body.defaultStateStream !== undefined && defaultStateStream === undefined) {
    sendJson(ctx.res, 400, { error: 'defaultStateStream must be a string' });
    return;
  }

  if (body.platformBindings !== undefined) {
    const parsed = await normalizeAndValidatePlatformBindingsInput(body.platformBindings, {
      resolveSlackScope: createSlackScopeResolver(ctx.cfg, ctx.logger),
    });
    if (!parsed.ok) {
      sendJson(ctx.res, 400, { error: parsed.error });
      return;
    }
    const conflicts = findSlackBindingConflicts({
      candidateOwnershipKeys: parsed.ownershipKeys,
      talks: store.listTalks(),
    });
    if (conflicts.length > 0) {
      const conflict = conflicts[0];
      sendJson(ctx.res, 409, {
        error:
          `Slack ownership conflict for scope "${conflict.scope}". ` +
          `Already claimed by talk ${conflict.talkId}.`,
      });
      return;
    }
    body.platformBindings = parsed.bindings;
  }

  if (body.platformBehaviors !== undefined) {
    const effectiveBindings = body.platformBindings ?? [];
    body.platformBehaviors = resolvePlatformBehaviorBindingRefsInput(
      body.platformBehaviors,
      effectiveBindings,
    ) as any[];
    const behaviorParse = normalizeAndValidatePlatformBehaviorsInput(body.platformBehaviors, {
      bindings: effectiveBindings,
      agents: [],
    });
    if (!behaviorParse.ok) {
      sendJson(ctx.res, 400, { error: behaviorParse.error });
      return;
    }
    body.platformBehaviors = behaviorParse.behaviors;
  }

  const talk = store.createTalk(body.model);
  store.updateTalk(talk.id, {
    ...(body.topicTitle ? { topicTitle: body.topicTitle } : {}),
    ...(body.objective ? { objective: body.objective } : {}),
    ...(body.directives !== undefined ? { directives: body.directives } : {}),
    ...(body.platformBindings !== undefined ? { platformBindings: body.platformBindings } : {}),
    ...(body.platformBehaviors !== undefined ? { platformBehaviors: body.platformBehaviors } : {}),
    ...(toolMode !== undefined ? { toolMode } : {}),
    ...(executionMode !== undefined ? { executionMode } : {}),
    ...(filesystemAccess !== undefined ? { filesystemAccess } : {}),
    ...(networkAccess !== undefined ? { networkAccess } : {}),
    ...(stateBackend !== undefined ? { stateBackend } : {}),
    ...(toolsAllow !== undefined ? { toolsAllow } : {}),
    ...(toolsDeny !== undefined ? { toolsDeny } : {}),
    ...(body.skills !== undefined ? { skills: body.skills } : {}),
    ...(googleAuthProfile !== undefined ? { googleAuthProfile: googleAuthProfile || undefined } : {}),
    ...(defaultStateStream !== undefined ? { defaultStateStream: defaultStateStream || undefined } : {}),
  });

  void reconcileSlackRoutingForTalks(store.listTalks(), ctx.logger);

  sendJson(ctx.res, 201, store.getTalk(talk.id) ?? talk);
}

async function handleListTalks(ctx: HandlerContext, store: TalkStore): Promise<void> {
  const talks = store.listTalks().map((talk) => {
    const executionMode = resolveExecutionMode(talk);
    return {
      ...talk,
      executionMode,
      executionModeLabel: executionModeLabel(executionMode),
      filesystemAccess: resolveFilesystemAccess(talk),
      networkAccess: resolveNetworkAccess(talk),
    };
  });
  sendJson(ctx.res, 200, { talks });
}

async function handleGetTalk(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const contextMd = await store.getContextMd(talkId);
  const executionMode = resolveExecutionMode(talk);
  const proxyGatewayToolsEnabled = resolveProxyGatewayToolsEnabled(
    process.env.CLAWTALK_PROXY_GATEWAY_TOOLS_ENABLED,
  );
  const openClawNativeToolsEnabled = resolveOpenClawNativeGoogleToolsEnabled(
    process.env.CLAWTALK_OPENCLAW_NATIVE_GOOGLE_TOOLS_ENABLED,
  );
  const capabilities = resolveExecutionCapabilities({
    executionMode,
    openClawNativeToolsEnabled,
    proxyGatewayToolsEnabled,
  });
  ctx.res.setHeader('ETag', `"${talk.talkVersion}"`);
  sendJson(ctx.res, 200, {
    ...talk,
    executionMode,
    executionModeLabel: executionModeLabel(executionMode),
    executionModeOptions: EXECUTION_MODE_OPTIONS,
    filesystemAccess: resolveFilesystemAccess(talk),
    filesystemAccessOptions: ['workspace_sandbox', 'full_host_access'],
    networkAccess: resolveNetworkAccess(talk),
    networkAccessOptions: ['restricted', 'full_outbound'],
    stateBackend: talk.stateBackend ?? 'stream_store',
    stateBackendOptions: ['stream_store', 'workspace_files'],
    contextMd,
    diagnostics: store.listDiagnostics(talkId),
    capabilities,
  });
}


async function handleUpdateTalk(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  let body: {
    topicTitle?: string;
    objective?: string;
    objectives?: string | string[];
    model?: string;
    agents?: any[];
    replaceAgents?: boolean;
    directives?: any[];
    rules?: any[];
    platformBindings?: any[];
    channelConnections?: any[];
    platformBehaviors?: any[];
    channelResponseSettings?: any[];
    toolMode?: string;
    executionMode?: string;
    filesystemAccess?: string;
    networkAccess?: string;
    stateBackend?: string;
    toolsAllow?: string[];
    toolsDeny?: string[];
    skills?: string[];
    googleAuthProfile?: string;
    defaultStateStream?: string;
    toolPolicy?: {
      mode?: string;
      executionMode?: string;
      filesystemAccess?: string;
      networkAccess?: string;
      stateBackend?: string;
      allow?: string[];
      deny?: string[];
      skills?: string[];
      googleAuthProfile?: string;
      defaultStateStream?: string;
    };
  };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const precondition = requireTalkPreconditionVersion(ctx, talk);
  if (!precondition.ok) return;
  const modifiedBy = extractClientIdHeader(ctx);

  if (body.objective === undefined && body.objectives !== undefined) {
    body.objective = normalizeObjectiveAlias(body.objectives);
  }
  if (body.directives === undefined && body.rules !== undefined) {
    body.directives = body.rules;
  }
  if (body.platformBindings === undefined && body.channelConnections !== undefined) {
    body.platformBindings = body.channelConnections;
  }
  if (body.platformBehaviors === undefined && body.channelResponseSettings !== undefined) {
    body.platformBehaviors = mapChannelResponseSettingsInput(body.channelResponseSettings) as any[];
  }
  if (body.toolMode === undefined && body.toolPolicy?.mode !== undefined) {
    body.toolMode = body.toolPolicy.mode;
  }
  if (body.toolsAllow === undefined && body.toolPolicy?.allow !== undefined) {
    body.toolsAllow = body.toolPolicy.allow;
  }
  if (body.executionMode === undefined && body.toolPolicy?.executionMode !== undefined) {
    body.executionMode = body.toolPolicy.executionMode;
  }
  if (body.filesystemAccess === undefined && body.toolPolicy?.filesystemAccess !== undefined) {
    body.filesystemAccess = body.toolPolicy.filesystemAccess;
  }
  if (body.networkAccess === undefined && body.toolPolicy?.networkAccess !== undefined) {
    body.networkAccess = body.toolPolicy.networkAccess;
  }
  if (body.stateBackend === undefined && body.toolPolicy?.stateBackend !== undefined) {
    body.stateBackend = body.toolPolicy.stateBackend;
  }
  if (body.toolsDeny === undefined && body.toolPolicy?.deny !== undefined) {
    body.toolsDeny = body.toolPolicy.deny;
  }
  if (body.skills === undefined && body.toolPolicy?.skills !== undefined) {
    body.skills = body.toolPolicy.skills;
  }
  if (body.googleAuthProfile === undefined && body.toolPolicy?.googleAuthProfile !== undefined) {
    body.googleAuthProfile = body.toolPolicy.googleAuthProfile;
  }
  if (body.defaultStateStream === undefined && body.toolPolicy?.defaultStateStream !== undefined) {
    body.defaultStateStream = body.toolPolicy.defaultStateStream;
  }

  const toolMode = normalizeToolModeInput(body.toolMode);
  if (body.toolMode !== undefined && toolMode === undefined) {
    sendJson(ctx.res, 400, { error: 'toolMode must be one of: off, confirm, auto' });
    return;
  }
  const executionMode = normalizeExecutionModeInput(body.executionMode);
  if (body.executionMode !== undefined && executionMode === undefined) {
    sendJson(ctx.res, 400, { error: executionModeValidationError() });
    return;
  }
  const filesystemAccess = normalizeFilesystemAccessInput(body.filesystemAccess);
  if (body.filesystemAccess !== undefined && filesystemAccess === undefined) {
    sendJson(ctx.res, 400, { error: filesystemAccessValidationError() });
    return;
  }
  const networkAccess = normalizeNetworkAccessInput(body.networkAccess);
  if (body.networkAccess !== undefined && networkAccess === undefined) {
    sendJson(ctx.res, 400, { error: networkAccessValidationError() });
    return;
  }
  const stateBackend = normalizeStateBackendInput(body.stateBackend);
  if (body.stateBackend !== undefined && stateBackend === undefined) {
    sendJson(ctx.res, 400, { error: stateBackendValidationError() });
    return;
  }
  const toolsAllow = normalizeToolNameListInput(body.toolsAllow);
  const toolsDeny = normalizeToolNameListInput(body.toolsDeny);
  const skills = normalizeToolNameListInput(body.skills);
  const googleAuthProfile = normalizeGoogleAuthProfileInput(body.googleAuthProfile);
  if (body.googleAuthProfile !== undefined && googleAuthProfile === undefined) {
    sendJson(ctx.res, 400, { error: 'googleAuthProfile must be a string' });
    return;
  }
  const defaultStateStream = normalizeStateStreamInput(body.defaultStateStream);
  if (body.defaultStateStream !== undefined && defaultStateStream === undefined) {
    sendJson(ctx.res, 400, { error: 'defaultStateStream must be a string' });
    return;
  }

  if (body.platformBindings !== undefined) {
    const parsed = await normalizeAndValidatePlatformBindingsInput(body.platformBindings, {
      resolveSlackScope: createSlackScopeResolver(ctx.cfg, ctx.logger),
    });
    if (!parsed.ok) {
      sendJson(ctx.res, 400, { error: parsed.error });
      return;
    }
    const conflicts = findSlackBindingConflicts({
      candidateOwnershipKeys: parsed.ownershipKeys,
      talks: store.listTalks(),
      skipTalkId: talkId,
    });
    if (conflicts.length > 0) {
      const conflict = conflicts[0];
      sendJson(ctx.res, 409, {
        error:
          `Slack ownership conflict for scope "${conflict.scope}". ` +
          `Already claimed by talk ${conflict.talkId}.`,
      });
      return;
    }
    body.platformBindings = parsed.bindings;
  }

  let normalizedAgentsForUpdate: TalkAgent[] | undefined;
  if (body.agents !== undefined) {
    const parsedAgents = normalizeAndValidateAgentsInput(body.agents);
    if (!parsedAgents.ok) {
      sendJson(ctx.res, 400, { error: parsedAgents.error });
      return;
    }
    const replaceAgents = body.replaceAgents === true;
    if (replaceAgents) {
      normalizedAgentsForUpdate = parsedAgents.agents;
    } else {
      // Safety default: preserve existing agents not included in partial client payloads.
      const existingAgents = talk.agents ?? [];
      const incomingNames = new Set(parsedAgents.agents.map((agent) => agent.name.toLowerCase()));
      const preserved = existingAgents.filter((agent) => !incomingNames.has(agent.name.toLowerCase()));
      normalizedAgentsForUpdate = [...parsedAgents.agents, ...preserved];
    }
    body.agents = normalizedAgentsForUpdate;
  }

  if (body.platformBehaviors !== undefined) {
    const effectiveBindings = body.platformBindings ?? (talk.platformBindings ?? []);
    body.platformBehaviors = resolvePlatformBehaviorBindingRefsInput(
      body.platformBehaviors,
      effectiveBindings,
    ) as any[];
    const effectiveAgents = normalizedAgentsForUpdate ?? (talk.agents ?? []);
    const behaviorParse = normalizeAndValidatePlatformBehaviorsInput(body.platformBehaviors, {
      bindings: effectiveBindings,
      agents: effectiveAgents,
    });
    if (!behaviorParse.ok) {
      sendJson(ctx.res, 400, { error: behaviorParse.error });
      return;
    }
    body.platformBehaviors = behaviorParse.behaviors;
  }

  const updated = store.updateTalk(talkId, {
    topicTitle: body.topicTitle,
    objective: body.objective,
    model: body.model,
    agents: normalizedAgentsForUpdate,
    directives: body.directives,
    platformBindings: body.platformBindings,
    platformBehaviors: body.platformBehaviors,
    toolMode,
    executionMode,
    filesystemAccess,
    networkAccess,
    stateBackend,
    toolsAllow,
    toolsDeny,
    ...(skills !== undefined ? { skills } : {}),
    ...(googleAuthProfile !== undefined ? { googleAuthProfile: googleAuthProfile || undefined } : {}),
    ...(defaultStateStream !== undefined ? { defaultStateStream: defaultStateStream || undefined } : {}),
  }, { modifiedBy });
  if (!updated) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  void reconcileSlackRoutingForTalks(store.listTalks(), ctx.logger);
  sendJson(ctx.res, 200, updated);
}

async function handleDeleteTalk(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const confirmHeader = ctx.req.headers['x-clawtalk-confirm-delete'];
  const confirmValue = Array.isArray(confirmHeader) ? confirmHeader[0] : confirmHeader;
  const confirmed = typeof confirmValue === 'string' && confirmValue.trim().toLowerCase() === 'true';
  if (!confirmed) {
    sendJson(ctx.res, 409, {
      error: 'Delete requires explicit confirmation header: x-clawtalk-confirm-delete: true',
    });
    return;
  }
  const precondition = requireTalkPreconditionVersion(ctx, talk);
  if (!precondition.ok) return;
  const modifiedBy = extractClientIdHeader(ctx);
  ctx.logger.warn(
    `Talk delete requested: talk=${talkId} by=${modifiedBy || 'unknown'} ua=${ctx.req.headers['user-agent'] || '-'}`,
  );
  const success = store.deleteTalk(talkId, { modifiedBy });
  if (!success) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  void reconcileSlackRoutingForTalks(store.listTalks(), ctx.logger);
  sendJson(ctx.res, 200, { ok: true });
}

async function handleGetMessages(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const limit = parseInt(ctx.url.searchParams.get('limit') ?? '100', 10);
  const afterId = ctx.url.searchParams.get('after') ?? undefined;

  let messages = await store.getMessages(talkId);

  // Pagination: skip messages up to and including `after`
  if (afterId) {
    const idx = messages.findIndex(m => m.id === afterId);
    if (idx !== -1) {
      messages = messages.slice(idx + 1);
    }
  }

  // Apply limit
  messages = messages.slice(-limit);

  sendJson(ctx.res, 200, { messages });
}

async function handleDeleteMessages(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  let body: { messageIds?: string[] };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!Array.isArray(body.messageIds) || body.messageIds.length === 0) {
    sendJson(ctx.res, 400, { error: 'messageIds must be a non-empty array' });
    return;
  }

  const result = await store.deleteMessages(talkId, body.messageIds);
  sendJson(ctx.res, 200, result);
}

async function handleListDiagnostics(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  sendJson(ctx.res, 200, {
    talkId,
    diagnostics: store.listDiagnostics(talkId),
  });
}

async function handleUpdateDiagnostic(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
  issueId: string,
): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const precondition = requireTalkPreconditionVersion(ctx, talk);
  if (!precondition.ok) return;
  const modifiedBy = extractClientIdHeader(ctx);

  let body: { status?: string };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }
  const rawStatus = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
  if (rawStatus !== 'open' && rawStatus !== 'resolved' && rawStatus !== 'dismissed') {
    sendJson(ctx.res, 400, { error: 'status must be one of: open, resolved, dismissed' });
    return;
  }
  const updated = store.updateDiagnosticStatus(
    talkId,
    issueId,
    rawStatus as 'open' | 'resolved' | 'dismissed',
    { modifiedBy },
  );
  if (!updated) {
    sendJson(ctx.res, 404, { error: 'Diagnostic not found' });
    return;
  }
  const current = store.getTalk(talkId);
  if (current) {
    ctx.res.setHeader('ETag', `"${current.talkVersion}"`);
  }
  sendJson(ctx.res, 200, {
    talkId,
    diagnostic: updated,
    diagnostics: store.listDiagnostics(talkId),
  });
}

async function handleAddPin(ctx: HandlerContext, store: TalkStore, talkId: string, msgId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const success = store.addPin(talkId, msgId);
  if (!success) {
    sendJson(ctx.res, 409, { error: 'Already pinned' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true, pinnedMessageIds: talk.pinnedMessageIds });
}

async function handleRemovePin(ctx: HandlerContext, store: TalkStore, talkId: string, msgId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const success = store.removePin(talkId, msgId);
  if (!success) {
    sendJson(ctx.res, 404, { error: 'Pin not found' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true, pinnedMessageIds: talk.pinnedMessageIds });
}


// ---------------------------------------------------------------------------
// Agent handlers
// ---------------------------------------------------------------------------

async function handleAddAgent(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const precondition = requireTalkPreconditionVersion(ctx, talk);
  if (!precondition.ok) return;
  const modifiedBy = extractClientIdHeader(ctx);

  let body: { name?: string; model?: string; role?: string; isPrimary?: boolean };
  try {
    body = (await readJsonBody(ctx.req)) as typeof body;
  } catch {
    sendJson(ctx.res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.name || !body.model || !body.role) {
    sendJson(ctx.res, 400, { error: 'Missing name, model, or role' });
    return;
  }

  const agent = await store.addAgent(talkId, {
    name: body.name,
    model: body.model,
    role: body.role as any,
    isPrimary: body.isPrimary ?? false,
  }, { modifiedBy });
  sendJson(ctx.res, 201, agent);
}

async function handleListAgents(ctx: HandlerContext, store: TalkStore, talkId: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const agents = store.listAgents(talkId);
  sendJson(ctx.res, 200, { agents });
}

async function handleDeleteAgent(ctx: HandlerContext, store: TalkStore, talkId: string, agentName: string): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const precondition = requireTalkPreconditionVersion(ctx, talk);
  if (!precondition.ok) return;
  const modifiedBy = extractClientIdHeader(ctx);

  try {
    await store.removeAgent(talkId, agentName, { modifiedBy });
  } catch {
    sendJson(ctx.res, 404, { error: 'Agent not found' });
    return;
  }
  sendJson(ctx.res, 200, { ok: true });
}
