/**
 * Talk Tools HTTP Handlers
 *
 * Handles /api/talks/:id/tools and /api/talks/:id/skills endpoints,
 * plus /api/tools routes for tool management, catalog, and Google OAuth.
 */

import type { HandlerContext } from './types.js';
import type { TalkStore } from './talk-store.js';
import type { ToolRegistry } from './tool-registry.js';
import { sendJson, readJsonBody } from './http.js';
import { getToolCatalog } from './tool-catalog.js';
import {
  EXECUTION_MODE_OPTIONS,
  evaluateToolAvailability,
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
import { isOpenClawNativeGoogleTool } from './openclaw-native-tools.js';
import {
  completeGoogleOAuthConnect,
  getGoogleOAuthConnectSessionStatus,
  googleDocsAuthStatus,
  googleDocsAuthStatusForProfile,
  listGoogleDocsAuthProfiles,
  setGoogleDocsActiveProfile,
  startGoogleOAuthConnect,
  upsertGoogleDocsAuthConfig,
} from './google-docs.js';
import { DEFAULT_GATEWAY_PORT } from './constants.js';
import {
  requireTalkPreconditionVersion,
  extractClientIdHeader,
  resolveExecutionCapabilities,
  buildTalkAuthReadyResolver,
  resolveCatalogAuth,
  normalizeToolModeInput,
  normalizeToolNameListInput,
  normalizeGoogleAuthProfileInput,
  normalizeStateStreamInput,
  normalizeStateBackendInput,
  executionModeValidationError,
  filesystemAccessValidationError,
  networkAccessValidationError,
  stateBackendValidationError,
} from './talks.js';

// ---------------------------------------------------------------------------
// Skills catalog cache
// ---------------------------------------------------------------------------

interface SkillCatalogEntry {
  name: string;
  description: string;
  emoji?: string;
  eligible: boolean;
}

let skillsCatalogCache: SkillCatalogEntry[] | null = null;
let skillsCatalogCacheAt = 0;
const SKILLS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchSkillsCatalog(logger?: { info: (msg: string) => void }): Promise<SkillCatalogEntry[]> {
  const now = Date.now();
  if (skillsCatalogCache && now - skillsCatalogCacheAt < SKILLS_CACHE_TTL_MS) {
    return skillsCatalogCache;
  }
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('openclaw', ['skills', 'list', '--json'], {
      timeout: 15_000,
      env: { ...process.env },
    });
    // Parse JSON — the output may have non-JSON prefix lines from doctor warnings
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) {
      logger?.info('[skills] openclaw skills list returned no JSON');
      return skillsCatalogCache ?? [];
    }
    const parsed = JSON.parse(stdout.slice(jsonStart)) as { skills: Array<{
      name: string;
      description: string;
      emoji?: string;
      eligible: boolean;
    }> };
    skillsCatalogCache = parsed.skills.map(s => ({
      name: s.name,
      description: s.description,
      emoji: s.emoji,
      eligible: s.eligible,
    }));
    skillsCatalogCacheAt = now;
    return skillsCatalogCache;
  } catch (err) {
    logger?.info(`[skills] Failed to fetch skills catalog: ${err}`);
    return skillsCatalogCache ?? [];
  }
}

// ---------------------------------------------------------------------------
// Per-Talk tool/skill handlers
// ---------------------------------------------------------------------------

export async function handleGetTalkTools(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
  registry?: ToolRegistry,
): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const catalog = getToolCatalog(ctx.pluginCfg.dataDir, ctx.logger);
  const proxyGatewayToolsEnabled = resolveProxyGatewayToolsEnabled(
    process.env.CLAWTALK_PROXY_GATEWAY_TOOLS_ENABLED,
  );
  const openClawNativeToolsEnabled = resolveOpenClawNativeGoogleToolsEnabled(
    process.env.CLAWTALK_OPENCLAW_NATIVE_GOOGLE_TOOLS_ENABLED,
  );
  const registeredTools = registry?.listTools() ?? [];
  const allTools = registeredTools;
  const googleAuthStatus = await googleDocsAuthStatusForProfile(talk.googleAuthProfile);
  const isAuthReady = buildTalkAuthReadyResolver({
    googleOAuthReady: Boolean(googleAuthStatus.accessTokenReady),
    googleAuthProfile: talk.googleAuthProfile,
    getToolRequiredAuth: (toolName) => catalog.getToolRequiredAuth(toolName),
  });
  const availabilityOptions = {
    isInstalled: (toolName: string) => catalog.isToolEnabled(toolName),
    isAuthReady,
    isManagedTool: (toolName: string) => catalog.isManagedTool(toolName),
    proxyGatewayToolsEnabled,
    isOpenClawNativeTool: (toolName: string) => isOpenClawNativeGoogleTool(toolName),
    openClawNativeToolsEnabled,
  };
  const effectiveToolStates = evaluateToolAvailability(allTools, talk, availabilityOptions);
  const openclawStates = evaluateToolAvailability(
    allTools,
    { ...talk, executionMode: 'openclaw' as const },
    availabilityOptions,
  );
  const fullControlStates = evaluateToolAvailability(
    allTools,
    { ...talk, executionMode: 'full_control' as const },
    availabilityOptions,
  );
  const openclawByName = new Map(openclawStates.map((t) => [t.name, t]));
  const fullControlByName = new Map(fullControlStates.map((t) => [t.name, t]));
  const effectiveToolsWithModes = effectiveToolStates.map((tool) => ({
    ...tool,
    openclawStatus: openclawByName.get(tool.name)?.enabled ? 'on' as const : 'blocked' as const,
    clawtalkStatus: fullControlByName.get(tool.name)?.enabled ? 'on' as const : 'blocked' as const,
  }));
  const enabledTools = effectiveToolStates
    .filter((tool) => tool.enabled)
    .map(({ name, description, builtin }) => ({ name, description, builtin }));
  const executionMode = resolveExecutionMode(talk);
  const capabilities = resolveExecutionCapabilities({
    executionMode,
    openClawNativeToolsEnabled,
    proxyGatewayToolsEnabled,
  });
  sendJson(ctx.res, 200, {
    talkId,
    toolMode: talk.toolMode ?? 'auto',
    executionMode,
    executionModeLabel: executionModeLabel(executionMode),
    executionModeOptions: EXECUTION_MODE_OPTIONS,
    filesystemAccess: resolveFilesystemAccess(talk),
    filesystemAccessOptions: ['workspace_sandbox', 'full_host_access'],
    networkAccess: resolveNetworkAccess(talk),
    networkAccessOptions: ['restricted', 'full_outbound'],
    stateBackend: talk.stateBackend ?? 'stream_store',
    stateBackendOptions: ['stream_store', 'workspace_files'],
    toolsAllow: talk.toolsAllow ?? [],
    toolsDeny: talk.toolsDeny ?? [],
    googleAuthProfile: talk.googleAuthProfile,
    defaultStateStream: talk.defaultStateStream,
    availableTools: allTools,
    enabledTools,
    effectiveTools: effectiveToolsWithModes,
    capabilities,
  });
}

export async function handleUpdateTalkTools(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
  registry?: ToolRegistry,
): Promise<void> {
  let body: {
    toolMode?: string;
    executionMode?: string;
    filesystemAccess?: string;
    networkAccess?: string;
    stateBackend?: string;
    toolsAllow?: string[];
    toolsDeny?: string[];
    googleAuthProfile?: string;
    defaultStateStream?: string;
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

  const updated = store.updateTalk(talkId, {
    ...(toolMode !== undefined ? { toolMode } : {}),
    ...(executionMode !== undefined ? { executionMode } : {}),
    ...(filesystemAccess !== undefined ? { filesystemAccess } : {}),
    ...(networkAccess !== undefined ? { networkAccess } : {}),
    ...(stateBackend !== undefined ? { stateBackend } : {}),
    ...(toolsAllow !== undefined ? { toolsAllow } : {}),
    ...(toolsDeny !== undefined ? { toolsDeny } : {}),
    ...(googleAuthProfile !== undefined ? { googleAuthProfile: googleAuthProfile || undefined } : {}),
    ...(defaultStateStream !== undefined ? { defaultStateStream: defaultStateStream || undefined } : {}),
  }, { modifiedBy });
  if (!updated) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }

  const catalog = getToolCatalog(ctx.pluginCfg.dataDir, ctx.logger);
  const proxyGatewayToolsEnabled = resolveProxyGatewayToolsEnabled(
    process.env.CLAWTALK_PROXY_GATEWAY_TOOLS_ENABLED,
  );
  const openClawNativeToolsEnabled = resolveOpenClawNativeGoogleToolsEnabled(
    process.env.CLAWTALK_OPENCLAW_NATIVE_GOOGLE_TOOLS_ENABLED,
  );
  const registeredTools = registry?.listTools() ?? [];
  const allTools = registeredTools;
  const googleAuthStatus = await googleDocsAuthStatusForProfile(updated.googleAuthProfile);
  const isAuthReady = buildTalkAuthReadyResolver({
    googleOAuthReady: Boolean(googleAuthStatus.accessTokenReady),
    googleAuthProfile: updated.googleAuthProfile,
    getToolRequiredAuth: (toolName) => catalog.getToolRequiredAuth(toolName),
  });
  const availabilityOptions = {
    isInstalled: (toolName: string) => catalog.isToolEnabled(toolName),
    isAuthReady,
    isManagedTool: (toolName: string) => catalog.isManagedTool(toolName),
    proxyGatewayToolsEnabled,
    isOpenClawNativeTool: (toolName: string) => isOpenClawNativeGoogleTool(toolName),
    openClawNativeToolsEnabled,
  };
  const effectiveToolStates = evaluateToolAvailability(allTools, updated, availabilityOptions);
  const openclawStates = evaluateToolAvailability(
    allTools,
    { ...updated, executionMode: 'openclaw' as const },
    availabilityOptions,
  );
  const fullControlStates = evaluateToolAvailability(
    allTools,
    { ...updated, executionMode: 'full_control' as const },
    availabilityOptions,
  );
  const openclawByName = new Map(openclawStates.map((t) => [t.name, t]));
  const fullControlByName = new Map(fullControlStates.map((t) => [t.name, t]));
  const effectiveToolsWithModes = effectiveToolStates.map((tool) => ({
    ...tool,
    openclawStatus: openclawByName.get(tool.name)?.enabled ? 'on' as const : 'blocked' as const,
    clawtalkStatus: fullControlByName.get(tool.name)?.enabled ? 'on' as const : 'blocked' as const,
  }));
  const enabledTools = effectiveToolStates
    .filter((tool) => tool.enabled)
    .map(({ name, description, builtin }) => ({ name, description, builtin }));
  const executionModeResolved = resolveExecutionMode(updated);
  const capabilities = resolveExecutionCapabilities({
    executionMode: executionModeResolved,
    openClawNativeToolsEnabled,
    proxyGatewayToolsEnabled,
  });
  sendJson(ctx.res, 200, {
    talkId,
    toolMode: updated.toolMode ?? 'auto',
    executionMode: executionModeResolved,
    executionModeLabel: executionModeLabel(executionModeResolved),
    executionModeOptions: EXECUTION_MODE_OPTIONS,
    filesystemAccess: resolveFilesystemAccess(updated),
    filesystemAccessOptions: ['workspace_sandbox', 'full_host_access'],
    networkAccess: resolveNetworkAccess(updated),
    networkAccessOptions: ['restricted', 'full_outbound'],
    stateBackend: updated.stateBackend ?? 'stream_store',
    stateBackendOptions: ['stream_store', 'workspace_files'],
    toolsAllow: updated.toolsAllow ?? [],
    toolsDeny: updated.toolsDeny ?? [],
    googleAuthProfile: updated.googleAuthProfile,
    defaultStateStream: updated.defaultStateStream,
    availableTools: allTools,
    enabledTools,
    effectiveTools: effectiveToolsWithModes,
    capabilities,
  });
}

// ---------------------------------------------------------------------------
// Skills handlers
// ---------------------------------------------------------------------------

export async function handleGetTalkSkills(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
): Promise<void> {
  const talk = store.getTalk(talkId);
  if (!talk) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  const catalog = await fetchSkillsCatalog(ctx.logger);
  const allSkillsMode = talk.skills === undefined;
  const enabledSet = allSkillsMode ? null : new Set(talk.skills);
  const skills = catalog.map(s => ({
    name: s.name,
    description: s.description,
    emoji: s.emoji,
    eligible: s.eligible,
    enabled: enabledSet ? enabledSet.has(s.name) : true,
  }));
  sendJson(ctx.res, 200, { talkId, skills, allSkillsMode });
}

export async function handleUpdateTalkSkills(
  ctx: HandlerContext,
  store: TalkStore,
  talkId: string,
): Promise<void> {
  let body: { skills?: string[] | null };
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

  // null or undefined → reset to all-skills mode (undefined in meta)
  // string[] → validate against catalog and set
  let skillsValue: string[] | undefined;
  if (body.skills === null || body.skills === undefined) {
    skillsValue = undefined;
  } else if (Array.isArray(body.skills)) {
    const catalog = await fetchSkillsCatalog(ctx.logger);
    const knownNames = new Set(catalog.map(s => s.name));
    const invalid = body.skills.filter(s => !knownNames.has(s));
    if (invalid.length > 0) {
      sendJson(ctx.res, 400, { error: `Unknown skill names: ${invalid.join(', ')}` });
      return;
    }
    skillsValue = body.skills;
  } else {
    sendJson(ctx.res, 400, { error: 'skills must be an array of strings or null' });
    return;
  }

  // updateTalk treats empty array as clearing (sets undefined)
  const updated = store.updateTalk(talkId, {
    skills: skillsValue ?? [],
  }, { modifiedBy });
  if (!updated) {
    sendJson(ctx.res, 404, { error: 'Talk not found' });
    return;
  }
  // Return same shape as GET
  const catalog = await fetchSkillsCatalog(ctx.logger);
  const allSkillsMode = updated.skills === undefined;
  const enabledSet = allSkillsMode ? null : new Set(updated.skills);
  const skills = catalog.map(s => ({
    name: s.name,
    description: s.description,
    emoji: s.emoji,
    eligible: s.eligible,
    enabled: enabledSet ? enabledSet.has(s.name) : true,
  }));
  sendJson(ctx.res, 200, { talkId, skills, allSkillsMode });
}

// ---------------------------------------------------------------------------
// Google OAuth callback
// ---------------------------------------------------------------------------

export async function handleGoogleOAuthCallback(ctx: HandlerContext): Promise<void> {
  const state = ctx.url.searchParams.get('state')?.trim() ?? '';
  const code = ctx.url.searchParams.get('code')?.trim() ?? undefined;
  const error = ctx.url.searchParams.get('error')?.trim() ?? undefined;

  const result = await completeGoogleOAuthConnect({ state, code, error });
  const html = result.ok
    ? `<!doctype html><html><head><meta charset="utf-8"><title>Google Connected</title></head>
       <body style="font-family: sans-serif; padding: 24px;">
       <h2>Google account connected</h2>
       <p>Profile: <b>${result.profile ?? 'default'}</b></p>
       <p>Account: <b>${result.accountEmail ?? '(unknown)'}</b></p>
       <p>You can close this tab and return to ClawTalk.</p>
       </body></html>`
    : `<!doctype html><html><head><meta charset="utf-8"><title>Google Connect Failed</title></head>
       <body style="font-family: sans-serif; padding: 24px;">
       <h2>Google connect failed</h2>
       <p>${result.error ?? 'Unknown error'}</p>
       <p>You can close this tab and retry from ClawTalk.</p>
       </body></html>`;

  ctx.res.statusCode = result.ok ? 200 : 400;
  ctx.res.setHeader('Content-Type', 'text/html; charset=utf-8');
  ctx.res.end(html);
}

// ---------------------------------------------------------------------------
// /api/tools routes (tool management, catalog, Google OAuth start/status)
// ---------------------------------------------------------------------------

export async function handleToolRoutes(ctx: HandlerContext, registry: ToolRegistry): Promise<void> {
  const { req, res, url } = ctx;
  const pathname = url.pathname;
  const catalog = getToolCatalog(ctx.pluginCfg.dataDir, ctx.logger);

  // POST /api/tools/google/oauth/start — start browser OAuth flow.
  if (pathname === '/api/tools/google/oauth/start' && req.method === 'POST') {
    let body: { profile?: string };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const profile = normalizeGoogleAuthProfileInput(body.profile);
    if (body.profile !== undefined && !profile) {
      sendJson(res, 400, { error: 'profile must be a non-empty string when provided' });
      return;
    }
    const proto = (ctx.req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
      || ((ctx.req.socket as any)?.encrypted ? 'https' : 'http');
    const host = ctx.req.headers.host ?? `localhost:${DEFAULT_GATEWAY_PORT}`;
    const redirectUri = `${proto}://${host}/api/tools/google/oauth/callback`;
    try {
      const started = await startGoogleOAuthConnect({ redirectUri, profile: profile || undefined });
      sendJson(res, 200, started);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // GET /api/tools/google/oauth/status?sessionId=... — poll connection result.
  if (pathname === '/api/tools/google/oauth/status' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')?.trim() ?? '';
    if (!sessionId) {
      sendJson(res, 400, { error: 'Missing query param: sessionId' });
      return;
    }
    sendJson(res, 200, getGoogleOAuthConnectSessionStatus(sessionId));
    return;
  }

  // PATCH /api/tools — built-in tool management actions
  if (pathname === '/api/tools' && req.method === 'PATCH') {
    let body:
      | {
          action?: 'google_auth_status';
          profile?: string;
        }
      | {
          action?: 'google_auth_profiles';
        }
      | {
          action?: 'google_auth_use_profile';
          profile?: string;
        }
      | {
          action?: 'google_auth_config';
          profile?: string;
          setActive?: boolean;
          refreshToken?: string;
          clientId?: string;
          clientSecret?: string;
          tokenUri?: string;
        };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (body.action === 'google_auth_status') {
      const statusReq = body as { profile?: string };
      const profile = normalizeGoogleAuthProfileInput(statusReq.profile);
      if (statusReq.profile !== undefined && profile === undefined) {
        sendJson(res, 400, { error: 'profile must be a string' });
        return;
      }
      const status = profile ? await googleDocsAuthStatusForProfile(profile) : await googleDocsAuthStatus();
      sendJson(res, 200, { status });
      return;
    }

    if (body.action === 'google_auth_profiles') {
      const profiles = await listGoogleDocsAuthProfiles();
      sendJson(res, 200, { profiles });
      return;
    }

    if (body.action === 'google_auth_use_profile') {
      const payload = body as { profile?: string };
      const profile = normalizeGoogleAuthProfileInput(payload.profile);
      if (!profile) {
        sendJson(res, 400, { error: 'profile is required' });
        return;
      }
      const updated = await setGoogleDocsActiveProfile(profile);
      const status = await googleDocsAuthStatusForProfile(profile);
      sendJson(res, 200, { updated, status });
      return;
    }

    if (body.action === 'google_auth_config') {
      const payload = body as {
        profile?: string;
        setActive?: boolean;
        refreshToken?: string;
        clientId?: string;
        clientSecret?: string;
        tokenUri?: string;
      };
      const profile = normalizeGoogleAuthProfileInput(payload.profile);
      if (payload.profile !== undefined && !profile) {
        sendJson(res, 400, { error: 'profile must be a non-empty string when provided' });
        return;
      }
      if (
        payload.refreshToken === undefined
        && payload.clientId === undefined
        && payload.clientSecret === undefined
        && payload.tokenUri === undefined
      ) {
        sendJson(res, 400, { error: 'Expected at least one of: refreshToken, clientId, clientSecret, tokenUri' });
        return;
      }
      const updated = await upsertGoogleDocsAuthConfig({
        profile,
        setActive: payload.setActive === true,
        refreshToken: payload.refreshToken,
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        tokenUri: payload.tokenUri,
      });
      const status = await googleDocsAuthStatusForProfile(updated.profile);
      sendJson(res, 200, { updated, status });
      return;
    }

    sendJson(res, 400, { error: 'Unknown PATCH /api/tools action' });
    return;
  }

  // GET /api/tools — list all tools
  if (pathname === '/api/tools' && req.method === 'GET') {
    const tools = registry.listTools();
    const catalogEntries = catalog.list(tools);
    sendJson(res, 200, {
      tools,
      installedTools: catalog.filterEnabledTools(tools),
      catalog: catalogEntries,
      installedCatalogIds: catalog.getInstalledIds(),
    });
    return;
  }

  // GET /api/tools/catalog — list tool catalog + installed state
  if (pathname === '/api/tools/catalog' && req.method === 'GET') {
    const tools = registry.listTools();
    const catalogEntries = catalog.list(tools);
    const catalogWithAuth = await Promise.all(
      catalogEntries.map(async (entry) => ({
        ...entry,
        auth: await resolveCatalogAuth(entry.requiredAuth),
      })),
    );
    sendJson(res, 200, {
      catalog: catalogWithAuth,
      installedCatalogIds: catalog.getInstalledIds(),
      installedTools: catalog.filterEnabledTools(tools),
      registeredTools: tools,
    });
    return;
  }

  // POST /api/tools/catalog/install — install a catalog tool by id
  if (pathname === '/api/tools/catalog/install' && req.method === 'POST') {
    let body: { id?: string };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const id = body.id?.trim();
    if (!id) {
      sendJson(res, 400, { error: 'Missing required field: id' });
      return;
    }
    const result = catalog.install(id, registry.listTools());
    if (!result.ok) {
      sendJson(res, 409, { error: result.error ?? 'Install failed' });
      return;
    }
    const auth = await resolveCatalogAuth(result.entry?.requiredAuth);
    sendJson(res, 200, {
      ok: true,
      installed: result.entry,
      auth,
      authSetupRecommended: !auth.ready,
    });
    return;
  }

  // POST /api/tools/catalog/uninstall — uninstall a catalog tool by id
  if (pathname === '/api/tools/catalog/uninstall' && req.method === 'POST') {
    let body: { id?: string };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const id = body.id?.trim();
    if (!id) {
      sendJson(res, 400, { error: 'Missing required field: id' });
      return;
    }
    const result = catalog.uninstall(id, registry.listTools());
    if (!result.ok) {
      sendJson(res, 404, { error: result.error ?? 'Uninstall failed' });
      return;
    }
    sendJson(res, 200, { ok: true, uninstalled: result.entry });
    return;
  }

  // POST /api/tools — register a new tool
  if (pathname === '/api/tools' && req.method === 'POST') {
    let body: { name?: string; description?: string; parameters?: any };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    if (!body.name || !body.description) {
      sendJson(res, 400, { error: 'Missing name or description' });
      return;
    }

    const parameters = body.parameters ?? { type: 'object', properties: {} };
    const ok = registry.registerTool(body.name, body.description, parameters);
    if (!ok) {
      sendJson(res, 409, { error: `Cannot register tool "${body.name}" (name conflicts with built-in)` });
      return;
    }
    sendJson(res, 201, { ok: true, name: body.name });
    return;
  }

  // DELETE /api/tools/:name — remove a dynamic tool
  const toolNameMatch = pathname.match(/^\/api\/tools\/([\w-]+)$/);
  if (toolNameMatch && req.method === 'DELETE') {
    const name = toolNameMatch[1];
    const ok = registry.removeTool(name);
    if (!ok) {
      sendJson(res, 404, { error: `Tool "${name}" not found or is built-in` });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}
