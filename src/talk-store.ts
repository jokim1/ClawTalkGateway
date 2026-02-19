/**
 * Talk Store
 *
 * Persistent storage for Talks — metadata, message history (JSONL),
 * and AI-maintained context documents. All writes are async
 * (fire-and-forget for non-critical paths, awaited for critical ones).
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
import type {
  TalkMeta,
  TalkMessage,
  TalkJob,
  TalkAgent,
  TalkDirective,
  TalkPlatformBinding,
  TalkPlatformBehavior,
  JobReport,
  JobOutputDestination,
  Directive,
  PlatformBinding,
  PlatformBehavior,
  PlatformPermission,
  Logger,
} from './types.js';

type TalkMutationType =
  | 'created'
  | 'updated'
  | 'deleted'
  | 'message_appended'
  | 'messages_deleted'
  | 'pin_added'
  | 'pin_removed'
  | 'job_added'
  | 'job_updated'
  | 'job_deleted'
  | 'agent_added'
  | 'agent_removed'
  | 'agents_set'
  | 'directives_set'
  | 'bindings_set'
  | 'behaviors_set';

export type TalkStoreChangeEvent = {
  type: TalkMutationType;
  talkId: string;
  talkVersion: number;
  changeId: string;
  timestamp: number;
  lastModifiedBy?: string;
};

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME || '~',
  '.openclaw',
  'plugins',
  'clawtalk',
);

/** Threshold below which getRecentMessages does a full load + slice. */
const SMALL_FILE_BYTES = 64 * 1024; // 64KB

/** TTL for context.md cache entries. */
const CONTEXT_CACHE_TTL_MS = 30_000;

/** Validate that a talk ID is safe for use as a directory name. */
function isValidId(id: string): boolean {
  return /^[\w-]+$/.test(id) && !id.includes('..');
}

function normalizePermission(raw: unknown): PlatformPermission {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'read' || value === 'write' || value === 'read+write') {
    return value;
  }
  return 'read+write';
}

function normalizeToolMode(raw: unknown): 'off' | 'confirm' | 'auto' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'off' || value === 'confirm' || value === 'auto') return value;
  return 'auto';
}

function normalizeResponseMode(raw: unknown): 'off' | 'mentions' | 'all' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'off' || value === 'mentions' || value === 'all') return value;
  return undefined;
}

function normalizeMirrorToTalk(raw: unknown): 'off' | 'inbound' | 'full' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'off' || value === 'inbound' || value === 'full') return value;
  return undefined;
}

function normalizeDeliveryMode(raw: unknown): 'thread' | 'channel' | 'adaptive' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'thread' || value === 'channel' || value === 'adaptive') return value;
  return undefined;
}

function normalizeTriggerPolicy(raw: unknown): 'judgment' | 'study_entries_only' | 'advice_or_study' | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'judgment' || value === 'study_entries_only' || value === 'advice_or_study') return value;
  return undefined;
}

function normalizeAllowedSenders(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const value = entry.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

function normalizeExecutionMode(raw: unknown): 'openclaw' | 'full_control' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'openclaw' || value === 'full_control') return value;
  // Migrate old values
  if (value === 'unsandboxed') return 'full_control';
  if (value === 'inherit' || value === 'sandboxed') return 'openclaw';
  return 'openclaw';
}

function normalizeFilesystemAccess(raw: unknown): 'workspace_sandbox' | 'full_host_access' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'workspace_sandbox' || value === 'workspace' || value === 'sandbox') return 'workspace_sandbox';
  if (value === 'full_host_access' || value === 'full_host' || value === 'full') return 'full_host_access';
  return 'full_host_access';
}

function normalizeNetworkAccess(raw: unknown): 'restricted' | 'full_outbound' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'restricted') return 'restricted';
  if (value === 'full_outbound' || value === 'full') return 'full_outbound';
  return 'full_outbound';
}

function normalizeToolNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!name) continue;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

function normalizeGoogleAuthProfile(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || undefined;
}

function normalizeDirectives(input: unknown): Directive[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  return input
    .filter((entry) => Boolean(entry && typeof entry === 'object'))
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const text = typeof row.text === 'string' ? row.text.trim() : '';
      if (!text) return null;
      const id =
        typeof row.id === 'string' && row.id.trim()
          ? row.id.trim()
          : randomUUID();
      return {
        id,
        text,
        active: row.active !== false,
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
      } satisfies Directive;
    })
    .filter((entry): entry is Directive => Boolean(entry));
}

function normalizeJobOutput(raw: unknown): JobOutputDestination {
  if (!raw || typeof raw !== 'object') {
    return { type: 'report_only' };
  }

  const row = raw as Record<string, unknown>;
  const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
  if (type === 'talk') {
    return { type: 'talk' };
  }

  if (type === 'slack') {
    const channelId = typeof row.channelId === 'string' ? row.channelId.trim() : '';
    const accountId = typeof row.accountId === 'string' ? row.accountId.trim() : '';
    const threadTs = typeof row.threadTs === 'string' ? row.threadTs.trim() : '';
    if (!channelId) return { type: 'report_only' };
    return {
      type: 'slack',
      channelId,
      ...(accountId ? { accountId } : {}),
      ...(threadTs ? { threadTs } : {}),
    };
  }

  return { type: 'report_only' };
}

function normalizeJob(raw: unknown): TalkJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;

  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const schedule = typeof row.schedule === 'string' ? row.schedule.trim() : '';
  const prompt = typeof row.prompt === 'string' ? row.prompt.trim() : '';
  if (!id || !schedule || !prompt) return null;

  const rawType = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
  const type: TalkJob['type'] =
    rawType === 'once' || rawType === 'recurring' || rawType === 'event'
      ? rawType
      : 'recurring';

  return {
    id,
    type,
    schedule,
    prompt,
    output: normalizeJobOutput(row.output),
    active: row.active !== false,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
    ...(typeof row.lastRunAt === 'number' ? { lastRunAt: row.lastRunAt } : {}),
    ...(typeof row.lastStatus === 'string' && row.lastStatus.trim()
      ? { lastStatus: row.lastStatus.trim() }
      : {}),
  };
}

function normalizeJobs(input: unknown): TalkJob[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(normalizeJob)
    .filter((job): job is TalkJob => Boolean(job));
}

function normalizePlatformBindings(input: unknown): PlatformBinding[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  return input
    .filter((entry) => Boolean(entry && typeof entry === 'object'))
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const platform = typeof row.platform === 'string' ? row.platform.trim() : '';
      const scope = typeof row.scope === 'string' ? row.scope.trim() : '';
      if (!platform || !scope) return null;
      const accountId = typeof row.accountId === 'string' ? row.accountId.trim() : '';
      const displayScope = typeof row.displayScope === 'string' ? row.displayScope.trim() : '';
      const id =
        typeof row.id === 'string' && row.id.trim()
          ? row.id.trim()
          : randomUUID();
      return {
        id,
        platform,
        scope,
        ...(accountId ? { accountId } : {}),
        ...(displayScope ? { displayScope } : {}),
        permission: normalizePermission(row.permission),
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
      } satisfies PlatformBinding;
    })
    .filter((entry): entry is PlatformBinding => Boolean(entry));
}

function normalizePlatformBehaviors(
  input: unknown,
  bindings?: TalkPlatformBinding[],
): PlatformBehavior[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const enforceBindingIds = Array.isArray(bindings);
  const bindingIds = new Set((bindings ?? []).map((binding) => binding.id));
  return input
    .filter((entry) => Boolean(entry && typeof entry === 'object'))
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const platformBindingId =
        typeof row.platformBindingId === 'string' ? row.platformBindingId.trim() : '';
      if (!platformBindingId) return null;
      if (enforceBindingIds && !bindingIds.has(platformBindingId)) return null;

      const agentName = typeof row.agentName === 'string' ? row.agentName.trim() : '';
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
      const minConfidence =
        typeof responsePolicyRaw?.minConfidence === 'number'
          ? responsePolicyRaw.minConfidence
          : undefined;
      if (
        !agentName &&
        !onMessagePrompt &&
        responseMode === undefined &&
        mirrorToTalk === undefined &&
        deliveryMode === undefined &&
        triggerPolicy === undefined &&
        allowedSenders === undefined &&
        minConfidence === undefined
      ) return null;

      const id =
        typeof row.id === 'string' && row.id.trim()
          ? row.id.trim()
          : randomUUID();

      return {
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
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : now,
      } satisfies PlatformBehavior;
    })
    .filter((entry): entry is PlatformBehavior => Boolean(entry));
}

export class TalkStore {
  private readonly talksDir: string;
  private readonly talks: Map<string, TalkMeta> = new Map();
  private readonly logger: Logger;
  private readonly changeListeners = new Set<(event: TalkStoreChangeEvent) => void>();

  // Caches
  private listTalksCache: TalkMeta[] | null = null;
  private contextCache = new Map<string, { content: string; expiresAt: number }>();

  onChange(listener: (event: TalkStoreChangeEvent) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emitChange(event: TalkStoreChangeEvent): void {
    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn(`TalkStore: change listener failed: ${String(err)}`);
      }
    }
  }

  private touchMeta(
    meta: TalkMeta,
    type: TalkMutationType,
    options?: { modifiedBy?: string; skipVersionBump?: boolean },
  ): void {
    const now = Date.now();
    if (!options?.skipVersionBump) {
      meta.talkVersion = Math.max(1, Math.floor(meta.talkVersion || 0) + 1);
      meta.changeId = randomUUID();
      meta.lastModifiedAt = now;
      meta.lastModifiedBy = options?.modifiedBy || 'gateway';
    }
    meta.updatedAt = now;
    this.invalidateListCache();
    this.persistMeta(meta);
    this.emitChange({
      type,
      talkId: meta.id,
      talkVersion: meta.talkVersion,
      changeId: meta.changeId,
      timestamp: now,
      ...(meta.lastModifiedBy ? { lastModifiedBy: meta.lastModifiedBy } : {}),
    });
  }

  constructor(dataDir: string | undefined, logger: Logger) {
    this.talksDir = path.join(dataDir || DEFAULT_DATA_DIR, 'talks');
    this.logger = logger;
    // Constructor no longer calls sync loadAll — use init() instead
  }

  /** Async initialization — call this before using the store. */
  async init(): Promise<void> {
    await this.ensureDir();
    await this.loadAllAsync();
    await this.clearStaleProcessingFlags();
  }

  private async ensureDir(): Promise<void> {
    await fsp.mkdir(this.talksDir, { recursive: true });
  }

  private async loadAllAsync(): Promise<void> {
    try {
      const dirs = await fsp.readdir(this.talksDir);
      for (const dir of dirs) {
        if (!isValidId(dir)) continue;
        const metaPath = path.join(this.talksDir, dir, 'talk.json');
        try {
          const raw = await fsp.readFile(metaPath, 'utf-8');
          const meta = JSON.parse(raw) as TalkMeta;
          // Ensure arrays exist (for older files)
          meta.pinnedMessageIds ??= [];
          meta.jobs = normalizeJobs(meta.jobs);
          meta.agents ??= [];
          meta.directives = normalizeDirectives(meta.directives);
          meta.platformBindings = normalizePlatformBindings(meta.platformBindings);
          meta.platformBehaviors = normalizePlatformBehaviors(meta.platformBehaviors, meta.platformBindings);
          meta.toolMode = normalizeToolMode(meta.toolMode);
          meta.executionMode = normalizeExecutionMode(meta.executionMode);
          meta.filesystemAccess = normalizeFilesystemAccess(meta.filesystemAccess);
          meta.networkAccess = normalizeNetworkAccess(meta.networkAccess);
          meta.toolsAllow = normalizeToolNames(meta.toolsAllow);
          meta.toolsDeny = normalizeToolNames(meta.toolsDeny);
          meta.googleAuthProfile = normalizeGoogleAuthProfile(meta.googleAuthProfile);
          meta.talkVersion =
            typeof meta.talkVersion === 'number' && Number.isFinite(meta.talkVersion)
              ? Math.max(1, Math.floor(meta.talkVersion))
              : 1;
          meta.changeId =
            typeof meta.changeId === 'string' && meta.changeId.trim()
              ? meta.changeId
              : randomUUID();
          meta.lastModifiedAt =
            typeof meta.lastModifiedAt === 'number' && Number.isFinite(meta.lastModifiedAt)
              ? meta.lastModifiedAt
              : meta.updatedAt;
          if (meta.lastModifiedBy !== undefined && typeof meta.lastModifiedBy !== 'string') {
            delete meta.lastModifiedBy;
          }
          if (meta.processing === undefined) {
            meta.processing = false;
          }
          this.talks.set(meta.id, meta);
        } catch (err) {
          // File may not exist or be corrupted — skip it
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.logger.warn(`TalkStore: skipping corrupted talk ${dir}: ${err}`);
          }
        }
      }
      this.logger.info(`TalkStore: loaded ${this.talks.size} talks`);
    } catch (err) {
      this.logger.warn(`TalkStore: failed to read talks dir: ${err}`);
    }
  }

  /** Invalidate listTalks sorted cache. */
  private invalidateListCache(): void {
    this.listTalksCache = null;
  }

  // -------------------------------------------------------------------------
  // Talk CRUD
  // -------------------------------------------------------------------------

  createTalk(model?: string): TalkMeta {
    const id = randomUUID();
    const now = Date.now();
    const meta: TalkMeta = {
      id,
      talkVersion: 1,
      changeId: randomUUID(),
      lastModifiedBy: 'gateway',
      lastModifiedAt: now,
      model,
      pinnedMessageIds: [],
      jobs: [],
      processing: false,
      directives: [],
      platformBindings: [],
      platformBehaviors: [],
      executionMode: 'openclaw',
      filesystemAccess: 'full_host_access',
      networkAccess: 'full_outbound',
      toolMode: 'auto',
      toolsAllow: [],
      toolsDeny: [],
      createdAt: now,
      updatedAt: now,
    };
    this.talks.set(id, meta);
    this.touchMeta(meta, 'created', { modifiedBy: 'gateway', skipVersionBump: true });
    return meta;
  }

  getTalk(id: string): TalkMeta | null {
    return this.talks.get(id) ?? null;
  }

  getTalkVersion(id: string): number | null {
    const meta = this.talks.get(id);
    return meta ? meta.talkVersion : null;
  }

  listTalks(): TalkMeta[] {
    if (this.listTalksCache) return this.listTalksCache;
    const sorted = Array.from(this.talks.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);
    this.listTalksCache = sorted;
    return sorted;
  }

  updateTalk(
    id: string,
    updates: Partial<
      Pick<
        TalkMeta,
        'topicTitle' | 'objective' | 'model' | 'agents' | 'directives' | 'platformBindings' | 'platformBehaviors' | 'toolMode' | 'executionMode' | 'filesystemAccess' | 'networkAccess' | 'toolsAllow' | 'toolsDeny' | 'googleAuthProfile'
      >
    >,
    options?: { modifiedBy?: string },
  ): TalkMeta | null {
    const meta = this.talks.get(id);
    if (!meta) return null;

    if (updates.topicTitle !== undefined) meta.topicTitle = updates.topicTitle;
    if (updates.objective !== undefined) meta.objective = updates.objective;
    if (updates.model !== undefined) meta.model = updates.model;
    if (updates.agents !== undefined) meta.agents = updates.agents;
    if (updates.directives !== undefined) meta.directives = normalizeDirectives(updates.directives);
    if (updates.platformBindings !== undefined) {
      meta.platformBindings = normalizePlatformBindings(updates.platformBindings);
      meta.platformBehaviors = normalizePlatformBehaviors(meta.platformBehaviors, meta.platformBindings);
    }
    if (updates.platformBehaviors !== undefined) {
      meta.platformBehaviors = normalizePlatformBehaviors(
        updates.platformBehaviors,
        meta.platformBindings,
      );
    }
    if (updates.toolMode !== undefined) {
      meta.toolMode = normalizeToolMode(updates.toolMode);
    }
    if (updates.executionMode !== undefined) {
      meta.executionMode = normalizeExecutionMode(updates.executionMode);
    }
    if (updates.filesystemAccess !== undefined) {
      meta.filesystemAccess = normalizeFilesystemAccess(updates.filesystemAccess);
    }
    if (updates.networkAccess !== undefined) {
      meta.networkAccess = normalizeNetworkAccess(updates.networkAccess);
    }
    if (updates.toolsAllow !== undefined) {
      meta.toolsAllow = normalizeToolNames(updates.toolsAllow);
    }
    if (updates.toolsDeny !== undefined) {
      meta.toolsDeny = normalizeToolNames(updates.toolsDeny);
    }
    if (updates.googleAuthProfile !== undefined) {
      meta.googleAuthProfile = normalizeGoogleAuthProfile(updates.googleAuthProfile);
    }
    this.touchMeta(meta, 'updated', { modifiedBy: options?.modifiedBy });
    return meta;
  }

  deleteTalk(id: string, options?: { modifiedBy?: string }): boolean {
    const existing = this.talks.get(id);
    if (!existing) return false;
    this.talks.delete(id);
    this.invalidateListCache();
    this.contextCache.delete(id);
    const now = Date.now();
    this.emitChange({
      type: 'deleted',
      talkId: id,
      talkVersion: existing.talkVersion + 1,
      changeId: randomUUID(),
      timestamp: now,
      ...(options?.modifiedBy ? { lastModifiedBy: options.modifiedBy } : {}),
    });
    if (isValidId(id)) {
      const talkDir = path.join(this.talksDir, id);
      fsp.rm(talkDir, { recursive: true, force: true }).catch((err) => {
        this.logger.error(`TalkStore: failed to delete talk directory ${id}: ${err}`);
      });
    }
    return true;
  }

  /** Set the processing flag without touching updatedAt (avoids re-triggering unread badge). */
  setProcessing(id: string, processing: boolean): void {
    const meta = this.talks.get(id);
    if (!meta) return;
    meta.processing = processing;
    this.invalidateListCache();
    this.persistMeta(meta);
  }

  /** Clear stale processing flags after startup/restart recovery. */
  async clearStaleProcessingFlags(): Promise<number> {
    let cleared = 0;
    for (const meta of this.talks.values()) {
      if (!meta.processing) continue;
      meta.processing = false;
      this.persistMeta(meta);
      cleared += 1;
    }
    if (cleared > 0) {
      this.invalidateListCache();
      this.logger.warn(`TalkStore: cleared stale processing flag for ${cleared} talk(s) on startup`);
    }
    return cleared;
  }

  // -------------------------------------------------------------------------
  // Message history (JSONL)
  // -------------------------------------------------------------------------

  /** Append a message to the Talk's history file. */
  async appendMessage(talkId: string, msg: TalkMessage, options?: { modifiedBy?: string }): Promise<void> {
    if (!isValidId(talkId)) return;
    const dir = path.join(this.talksDir, talkId);
    await fsp.mkdir(dir, { recursive: true });
    const line = JSON.stringify(msg) + '\n';
    await fsp.appendFile(path.join(dir, 'history.jsonl'), line, 'utf-8');

    // Touch the talk
    const meta = this.talks.get(talkId);
    if (meta) {
      this.touchMeta(meta, 'message_appended', { modifiedBy: options?.modifiedBy });
    }
  }

  /** Read all messages from a Talk's history. */
  async getMessages(talkId: string): Promise<TalkMessage[]> {
    if (!isValidId(talkId)) return [];
    const historyPath = path.join(this.talksDir, talkId, 'history.jsonl');
    if (!fs.existsSync(historyPath)) return [];

    const messages: TalkMessage[] = [];
    const stream = fs.createReadStream(historyPath, 'utf-8');
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as TalkMessage);
      } catch {
        // skip malformed lines
      }
    }
    return messages;
  }

  /**
   * Read the last N messages from history.
   * For files < 64KB, does a full load + slice.
   * For larger files, reads backwards in chunks (tail-first).
   */
  async getRecentMessages(talkId: string, limit: number): Promise<TalkMessage[]> {
    if (!isValidId(talkId)) return [];
    const historyPath = path.join(this.talksDir, talkId, 'history.jsonl');

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(historyPath);
    } catch {
      return [];
    }

    // Small files: full load + slice (simpler, fast enough)
    if (stat.size < SMALL_FILE_BYTES) {
      const all = await this.getMessages(talkId);
      return all.slice(-limit);
    }

    // Large files: read backwards in chunks
    const fd = await fsp.open(historyPath, 'r');
    try {
      const messages: TalkMessage[] = [];
      const chunkSize = 16 * 1024; // 16KB chunks
      let position = stat.size;
      let trailing = '';

      while (position > 0 && messages.length < limit) {
        const readSize = Math.min(chunkSize, position);
        position -= readSize;
        const buf = Buffer.alloc(readSize);
        await fd.read(buf, 0, readSize, position);
        const chunk = buf.toString('utf-8') + trailing;
        trailing = '';

        const lines = chunk.split('\n');
        // First element may be a partial line (unless we're at the start of file)
        if (position > 0) {
          trailing = lines.shift()!;
        }

        // Process lines in reverse order
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            messages.unshift(JSON.parse(line) as TalkMessage);
            if (messages.length >= limit) break;
          } catch {
            // skip malformed lines
          }
        }
      }

      // Handle any remaining trailing data from the start of the file
      if (trailing.trim() && messages.length < limit) {
        try {
          messages.unshift(JSON.parse(trailing) as TalkMessage);
        } catch {
          // skip malformed
        }
      }

      return messages.slice(-limit);
    } finally {
      await fd.close();
    }
  }

  /**
   * Get a specific message by ID.
   * Streams JSONL line-by-line and stops on match instead of loading all.
   */
  async getMessage(talkId: string, messageId: string): Promise<TalkMessage | null> {
    if (!isValidId(talkId)) return null;
    const historyPath = path.join(this.talksDir, talkId, 'history.jsonl');
    if (!fs.existsSync(historyPath)) return null;

    const stream = fs.createReadStream(historyPath, 'utf-8');
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as TalkMessage;
          if (msg.id === messageId) {
            return msg;
          }
        } catch {
          // skip malformed lines
        }
      }
    } finally {
      stream.destroy();
    }
    return null;
  }

  /**
   * Delete messages by ID from a Talk's history.
   * Rewrites history.jsonl with surviving messages and cleans dangling pins.
   */
  async deleteMessages(
    talkId: string,
    messageIds: string[],
    options?: { modifiedBy?: string },
  ): Promise<{ deleted: number; remaining: number }> {
    if (!isValidId(talkId)) return { deleted: 0, remaining: 0 };
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      const existing = await this.getMessages(talkId);
      return { deleted: 0, remaining: existing.length };
    }

    const idSet = new Set(messageIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()));
    if (idSet.size === 0) {
      const existing = await this.getMessages(talkId);
      return { deleted: 0, remaining: existing.length };
    }

    const history = await this.getMessages(talkId);
    const remainingMessages = history.filter((msg) => !idSet.has(msg.id));
    const deleted = history.length - remainingMessages.length;
    const dir = path.join(this.talksDir, talkId);
    await fsp.mkdir(dir, { recursive: true });
    const historyPath = path.join(dir, 'history.jsonl');
    const content = remainingMessages.map((m) => JSON.stringify(m)).join('\n');
    await fsp.writeFile(historyPath, content ? `${content}\n` : '', 'utf-8');

    const meta = this.talks.get(talkId);
    if (meta) {
      const beforePins = meta.pinnedMessageIds.length;
      meta.pinnedMessageIds = meta.pinnedMessageIds.filter((id) => !idSet.has(id));
      if (deleted > 0 || meta.pinnedMessageIds.length !== beforePins) {
        this.touchMeta(meta, 'messages_deleted', { modifiedBy: options?.modifiedBy });
      }
    }

    return { deleted, remaining: remainingMessages.length };
  }

  // -------------------------------------------------------------------------
  // Pin management
  // -------------------------------------------------------------------------

  addPin(talkId: string, messageId: string, options?: { modifiedBy?: string }): boolean {
    const meta = this.talks.get(talkId);
    if (!meta) return false;
    if (meta.pinnedMessageIds.includes(messageId)) return false;
    meta.pinnedMessageIds.push(messageId);
    this.touchMeta(meta, 'pin_added', { modifiedBy: options?.modifiedBy });
    return true;
  }

  removePin(talkId: string, messageId: string, options?: { modifiedBy?: string }): boolean {
    const meta = this.talks.get(talkId);
    if (!meta) return false;
    const idx = meta.pinnedMessageIds.indexOf(messageId);
    if (idx === -1) return false;
    meta.pinnedMessageIds.splice(idx, 1);
    this.touchMeta(meta, 'pin_removed', { modifiedBy: options?.modifiedBy });
    return true;
  }

  // -------------------------------------------------------------------------
  // Context document (with TTL cache)
  // -------------------------------------------------------------------------

  async getContextMd(talkId: string): Promise<string> {
    if (!isValidId(talkId)) return '';

    // Check cache first
    const cached = this.contextCache.get(talkId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.content;
    }

    const ctxPath = path.join(this.talksDir, talkId, 'context.md');
    try {
      const content = await fsp.readFile(ctxPath, 'utf-8');
      this.contextCache.set(talkId, {
        content,
        expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS,
      });
      return content;
    } catch {
      return '';
    }
  }

  async setContextMd(talkId: string, content: string): Promise<void> {
    if (!isValidId(talkId)) return;
    const dir = path.join(this.talksDir, talkId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'context.md'), content, 'utf-8');
    // Invalidate cache
    this.contextCache.set(talkId, {
      content,
      expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS,
    });
  }

  // -------------------------------------------------------------------------
  // Job management
  // -------------------------------------------------------------------------

  addJob(
    talkId: string,
    schedule: string,
    prompt: string,
    type?: 'once' | 'recurring' | 'event',
    output?: JobOutputDestination,
    options?: { modifiedBy?: string },
  ): TalkJob | null {
    const meta = this.talks.get(talkId);
    if (!meta) return null;

    const job: TalkJob = {
      id: randomUUID(),
      type: type ?? 'recurring',
      schedule,
      prompt,
      output: normalizeJobOutput(output),
      active: true,
      createdAt: Date.now(),
    };

    meta.jobs.push(job);
    this.touchMeta(meta, 'job_added', { modifiedBy: options?.modifiedBy });
    return job;
  }

  getJob(talkId: string, jobId: string): TalkJob | null {
    const meta = this.talks.get(talkId);
    if (!meta) return null;
    return meta.jobs.find(j => j.id === jobId) ?? null;
  }

  listJobs(talkId: string): TalkJob[] {
    const meta = this.talks.get(talkId);
    return meta?.jobs ?? [];
  }

  updateJob(
    talkId: string,
    jobId: string,
    updates: Partial<Pick<TalkJob, 'active' | 'type' | 'schedule' | 'prompt' | 'output' | 'lastRunAt' | 'lastStatus'>>,
    options?: { modifiedBy?: string },
  ): TalkJob | null {
    const meta = this.talks.get(talkId);
    if (!meta) return null;
    const job = meta.jobs.find(j => j.id === jobId);
    if (!job) return null;

    if (updates.active !== undefined) job.active = updates.active;
    if (updates.type !== undefined) job.type = updates.type;
    if (updates.schedule !== undefined) job.schedule = updates.schedule;
    if (updates.prompt !== undefined) job.prompt = updates.prompt;
    if (updates.output !== undefined) job.output = normalizeJobOutput(updates.output);
    if (updates.lastRunAt !== undefined) job.lastRunAt = updates.lastRunAt;
    if (updates.lastStatus !== undefined) job.lastStatus = updates.lastStatus;
    this.touchMeta(meta, 'job_updated', { modifiedBy: options?.modifiedBy });
    return job;
  }

  deleteJob(talkId: string, jobId: string, options?: { modifiedBy?: string }): boolean {
    const meta = this.talks.get(talkId);
    if (!meta) return false;
    const idx = meta.jobs.findIndex(j => j.id === jobId);
    if (idx === -1) return false;
    meta.jobs.splice(idx, 1);
    this.touchMeta(meta, 'job_deleted', { modifiedBy: options?.modifiedBy });
    return true;
  }

  /** Get all active jobs across all talks. */
  getAllActiveJobs(): Array<{ talkId: string; job: TalkJob }> {
    const result: Array<{ talkId: string; job: TalkJob }> = [];
    for (const [talkId, meta] of this.talks) {
      for (const job of meta.jobs) {
        if (job.active) result.push({ talkId, job });
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Agent management
  // -------------------------------------------------------------------------

  async addAgent(talkId: string, agent: TalkAgent, options?: { modifiedBy?: string }): Promise<TalkAgent> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    if (!meta.agents) meta.agents = [];
    meta.agents.push(agent);
    this.touchMeta(meta, 'agent_added', { modifiedBy: options?.modifiedBy });
    return agent;
  }

  async removeAgent(talkId: string, agentName: string, options?: { modifiedBy?: string }): Promise<void> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    const idx = (meta.agents ?? []).findIndex(a => a.name === agentName);
    if (idx === -1) throw new Error('Agent not found');
    meta.agents!.splice(idx, 1);
    this.touchMeta(meta, 'agent_removed', { modifiedBy: options?.modifiedBy });
  }

  listAgents(talkId: string): TalkAgent[] {
    const meta = this.talks.get(talkId);
    return meta?.agents ?? [];
  }

  async setAgents(talkId: string, agents: TalkAgent[], options?: { modifiedBy?: string }): Promise<void> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    meta.agents = agents;
    this.touchMeta(meta, 'agents_set', { modifiedBy: options?.modifiedBy });
  }

  // -------------------------------------------------------------------------
  // Directive management
  // -------------------------------------------------------------------------

  async setDirectives(talkId: string, directives: TalkDirective[], options?: { modifiedBy?: string }): Promise<void> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    meta.directives = directives;
    this.touchMeta(meta, 'directives_set', { modifiedBy: options?.modifiedBy });
  }

  // -------------------------------------------------------------------------
  // Platform binding management
  // -------------------------------------------------------------------------

  async setPlatformBindings(
    talkId: string,
    bindings: TalkPlatformBinding[],
    options?: { modifiedBy?: string },
  ): Promise<void> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    meta.platformBindings = normalizePlatformBindings(bindings);
    meta.platformBehaviors = normalizePlatformBehaviors(meta.platformBehaviors, meta.platformBindings);
    this.touchMeta(meta, 'bindings_set', { modifiedBy: options?.modifiedBy });
  }

  async setPlatformBehaviors(
    talkId: string,
    behaviors: TalkPlatformBehavior[],
    options?: { modifiedBy?: string },
  ): Promise<void> {
    const meta = this.talks.get(talkId);
    if (!meta) throw new Error('Talk not found');
    meta.platformBehaviors = normalizePlatformBehaviors(behaviors, meta.platformBindings);
    this.touchMeta(meta, 'behaviors_set', { modifiedBy: options?.modifiedBy });
  }

  // -------------------------------------------------------------------------
  // Job reports (JSONL)
  // -------------------------------------------------------------------------

  async appendReport(talkId: string, report: JobReport): Promise<void> {
    if (!isValidId(talkId)) return;
    const dir = path.join(this.talksDir, talkId);
    await fsp.mkdir(dir, { recursive: true });
    const line = JSON.stringify(report) + '\n';
    await fsp.appendFile(path.join(dir, 'reports.jsonl'), line, 'utf-8');
  }

  async getReports(talkId: string, jobId?: string): Promise<JobReport[]> {
    if (!isValidId(talkId)) return [];
    const reportsPath = path.join(this.talksDir, talkId, 'reports.jsonl');
    if (!fs.existsSync(reportsPath)) return [];

    const reports: JobReport[] = [];
    const stream = fs.createReadStream(reportsPath, 'utf-8');
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const report = JSON.parse(line) as JobReport;
        if (!jobId || report.jobId === jobId) {
          reports.push(report);
        }
      } catch {
        // skip malformed lines
      }
    }
    return reports;
  }

  async getRecentReports(talkId: string, limit: number, jobId?: string, since?: number): Promise<JobReport[]> {
    let all = await this.getReports(talkId, jobId);
    if (since) {
      all = all.filter(r => r.runAt > since);
    }
    return all.slice(-limit);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private persistMeta(meta: TalkMeta): void {
    if (!isValidId(meta.id)) return;
    const dir = path.join(this.talksDir, meta.id);
    fsp.mkdir(dir, { recursive: true })
      .then(() => fsp.writeFile(path.join(dir, 'talk.json'), JSON.stringify(meta, null, 2)))
      .catch((err) => this.logger.warn(`TalkStore: persist failed for ${meta.id}: ${err}`));
  }

  getDataDir(): string {
    return path.dirname(this.talksDir);
  }
}
