/**
 * Tool Affinity Learning System
 *
 * Observes which tools the LLM actually uses per intent category and
 * dynamically prunes the tool set for future requests. Reduces token
 * overhead and latency — especially for reasoning models.
 *
 * Phases per intent:
 * - warmup  (first N observations): send ALL tools, gather data.
 * - learned (after warmup):         send only tools used >10% of the time.
 * - exploration (5% of learned):    send ALL tools to detect drift.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from './types.js';

// ---------------------------------------------------------------------------
// Constants (env-overridable)
// ---------------------------------------------------------------------------

const WARMUP_THRESHOLD = envInt('CLAWTALK_AFFINITY_WARMUP', 3);
const SLIDING_WINDOW_SIZE = envInt('CLAWTALK_AFFINITY_WINDOW', 50);
const EXPLORATION_RATE = envInt('CLAWTALK_AFFINITY_EXPLORATION_RATE', 20);
const MIN_AFFINITY_THRESHOLD = envFloat('CLAWTALK_AFFINITY_MIN_THRESHOLD', 0.1);

/**
 * Cold-start intents skip warmup and start in learned phase with only baseline
 * tools. The baseline pattern keeps state tools (state_append_event,
 * state_read_summary) so persistence always works, while pruning the other
 * ~15 tools that cause reasoning-model slowdowns.
 * Exploration probes (5%) still fire to discover unexpected tool needs.
 */
const COLD_START_INTENTS = new Set([
  'study',
  'state_tracking',
  'conversation',
  'model_meta',
]);

/** Cold-start baseline: always include state tools so persistence works. */
const COLD_START_BASELINE_PATTERN = /^state_/;

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolAffinityObservation {
  timestamp: number;
  intent: string;
  availableTools: string[];
  usedTools: string[];
  toolsOffered: number;
  model: string;
  source: 'talk-chat' | 'slack-ingress';
}

export interface IntentToolFrequency {
  intent: string;
  totalObservations: number;
  noToolCount: number;
  toolCounts: Record<string, number>;
}

export interface ToolAffinitySnapshot {
  talkId: string;
  computedAt: number;
  intents: IntentToolFrequency[];
}

export type AffinityPhase = 'warmup' | 'learned' | 'exploration';

export interface ToolAffinitySelection {
  phase: AffinityPhase;
  selectedTools: string[];
  prunedTools: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Intent Classification
// ---------------------------------------------------------------------------

/**
 * Classify a user message into an intent category for affinity tracking.
 * Regex-based, zero latency cost.
 */
export function classifyMessageIntent(text: string): string {
  const t = text.toLowerCase().trim();
  if (!t) return 'other';

  // Study / homework logging (time + study keyword)
  if (/\b\d+\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/.test(t)
    && /\b(study|studied|homework|mathcounts|khan|practice|worked|work|productive|coding|art|project)\b/.test(t)) {
    return 'study';
  }

  // State tracking (progress, scores, streaks, logs)
  if (/\b(log|track|record|update|score|streak|progress|status|total|tally|count)\b/.test(t)
    && !/\b(google|doc|drive|sheet)\b/.test(t)) {
    return 'state_tracking';
  }

  // Google Docs / Drive
  if (/\bgoogle\s+(doc|docs|drive|sheet|sheets|document)\b/.test(t)
    || /\bgdrive\b/.test(t)
    || /docs\.google\.com/.test(t)) {
    return 'google_docs';
  }

  // Web research
  if (/\b(search|look\s+up|research|find\s+out|browse|fetch|web|url|http)\b/.test(t)) {
    return 'web_research';
  }

  // Code execution / shell
  if (/\b(run|execute|shell|terminal|command|bash|script|code|compile|build|test)\b/.test(t)
    && /\b(run|execute|shell|terminal|command|bash)\b/.test(t)) {
    return 'code_execution';
  }

  // File operations
  if (/\b(read|write|edit|create|delete|move|rename|file|folder|directory|path)\b/.test(t)
    && /\b(file|folder|directory|path)\b/.test(t)) {
    return 'file_ops';
  }

  // Automation / jobs / scheduling
  if (/\b(automat|job|schedule|cron|recurring|every\s+\d+|daily|weekly|monthly)\b/.test(t)) {
    return 'automation';
  }

  // Model identity / meta questions
  if (/\bwhat\s+model\b/.test(t) || /\bwhich\s+model\b/.test(t) || /\bwho\s+are\s+you\b/.test(t)) {
    return 'model_meta';
  }

  // General conversation (greetings, opinions, advice)
  if (/\b(help|advice|how\s+do\s+i|what\s+should\s+i|can\s+you|should\s+i|guidance)\b/.test(t)
    || /^(hi|hey|hello|thanks|thank\s+you|ok|okay|good|great|sure|yes|no|yeah|nah)\b/.test(t)) {
    return 'conversation';
  }

  return 'other';
}

// ---------------------------------------------------------------------------
// Timeout Scaling
// ---------------------------------------------------------------------------

/**
 * Scale timeout proportionally to tool count.
 * 0 tools → 60s, 1-3 tools → 80-120s, 4-8 tools → 140-220s, 9+ tools → baseTimeout.
 * During warmup/exploration, always use baseTimeout since full tool set is sent.
 */
export function computeAffinityTimeout(params: {
  phase: AffinityPhase;
  toolCount: number;
  baseTimeoutMs: number;
}): number {
  if (params.phase === 'warmup' || params.phase === 'exploration') {
    return params.baseTimeoutMs;
  }
  return Math.min(params.baseTimeoutMs, 60_000 + params.toolCount * 20_000);
}

// ---------------------------------------------------------------------------
// ToolAffinityStore
// ---------------------------------------------------------------------------

export class ToolAffinityStore {
  private readonly dataDir: string;
  private readonly logger: Logger;
  private readonly snapshotCache = new Map<string, { snapshot: ToolAffinitySnapshot; cachedAt: number }>();
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(dataDir: string, logger: Logger) {
    this.dataDir = dataDir;
    this.logger = logger;
  }

  /** Append a single observation to the per-talk JSONL log. */
  recordObservation(talkId: string, obs: ToolAffinityObservation): void {
    try {
      const dir = this.affinityDir(talkId);
      mkdirSync(dir, { recursive: true });
      const line = JSON.stringify(obs) + '\n';
      appendFileSync(join(dir, 'observations.jsonl'), line, 'utf-8');
      this.snapshotCache.delete(talkId);
    } catch (err) {
      this.logger.warn(`ToolAffinity: failed to record observation for talk ${talkId}: ${err}`);
    }
  }

  /** Compute or return cached snapshot for a talk. */
  getSnapshot(talkId: string): ToolAffinitySnapshot | undefined {
    const cached = this.snapshotCache.get(talkId);
    if (cached && Date.now() - cached.cachedAt < ToolAffinityStore.CACHE_TTL_MS) {
      return cached.snapshot;
    }

    const observations = this.loadObservations(talkId);
    if (observations.length === 0) return undefined;

    const snapshot = this.computeSnapshot(talkId, observations);
    this.snapshotCache.set(talkId, { snapshot, cachedAt: Date.now() });

    // Persist for debugging
    try {
      writeFileSync(
        join(this.affinityDir(talkId), 'snapshot.json'),
        JSON.stringify(snapshot, null, 2),
        'utf-8',
      );
    } catch {
      // non-critical
    }

    return snapshot;
  }

  /** Select tools for an intent based on affinity data. */
  selectTools(params: {
    talkId: string;
    intent: string;
    policyAllowedTools: string[];
    snapshot: ToolAffinitySnapshot | undefined;
  }): ToolAffinitySelection {
    const { intent, policyAllowedTools, snapshot } = params;
    const phase = this.resolvePhase(intent, snapshot);

    if (phase === 'warmup' || phase === 'exploration') {
      return {
        phase,
        selectedTools: policyAllowedTools,
        prunedTools: [],
        reason: phase === 'warmup'
          ? `warmup: gathering data for intent="${intent}"`
          : `exploration: periodic full-set probe for intent="${intent}"`,
      };
    }

    // Learned phase: filter to tools with affinity above threshold
    const intentData = snapshot?.intents.find((i) => i.intent === intent);
    if (!intentData) {
      // Cold-start intent with no data yet: include only state tools baseline
      if (COLD_START_INTENTS.has(intent)) {
        const baseline = policyAllowedTools.filter(t => COLD_START_BASELINE_PATTERN.test(t));
        const pruned = policyAllowedTools.filter(t => !COLD_START_BASELINE_PATTERN.test(t));
        return {
          phase: 'learned',
          selectedTools: baseline,
          prunedTools: pruned,
          reason: `cold-start: intent="${intent}" baseline=${baseline.length} state tools`,
        };
      }
      return {
        phase: 'warmup',
        selectedTools: policyAllowedTools,
        prunedTools: [],
        reason: `no affinity data for intent="${intent}", falling back to warmup`,
      };
    }

    const affinitySet = new Set<string>();
    for (const [tool, count] of Object.entries(intentData.toolCounts)) {
      if (count / intentData.totalObservations >= MIN_AFFINITY_THRESHOLD) {
        affinitySet.add(tool.toLowerCase());
      }
    }

    // If no tools have affinity (all observations were no-tool), send empty
    const selectedTools = policyAllowedTools.filter(
      (tool) => affinitySet.has(tool.toLowerCase()),
    );
    const prunedTools = policyAllowedTools.filter(
      (tool) => !affinitySet.has(tool.toLowerCase()),
    );

    return {
      phase: 'learned',
      selectedTools,
      prunedTools,
      reason: `learned: intent="${intent}" affinity=${affinitySet.size} tools from ${intentData.totalObservations} observations`,
    };
  }

  /** Determine which phase an intent is in. */
  resolvePhase(intent: string, snapshot: ToolAffinitySnapshot | undefined): AffinityPhase {
    const intentData = snapshot?.intents.find((i) => i.intent === intent);
    const hasEnoughData = intentData && intentData.totalObservations >= WARMUP_THRESHOLD;

    if (!hasEnoughData && !COLD_START_INTENTS.has(intent)) {
      return 'warmup';
    }

    // Cold-start intents or intents with enough data: learned with exploration probes
    if (EXPLORATION_RATE > 0 && Math.random() < 1 / EXPLORATION_RATE) {
      return 'exploration';
    }
    return 'learned';
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private affinityDir(talkId: string): string {
    return join(this.dataDir, 'talks', talkId, 'affinity');
  }

  private loadObservations(talkId: string): ToolAffinityObservation[] {
    const filePath = join(this.affinityDir(talkId), 'observations.jsonl');
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }
    const observations: ToolAffinityObservation[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        observations.push(JSON.parse(trimmed) as ToolAffinityObservation);
      } catch {
        // skip malformed lines
      }
    }
    return observations;
  }

  private computeSnapshot(talkId: string, observations: ToolAffinityObservation[]): ToolAffinitySnapshot {
    // Group by intent, keep last SLIDING_WINDOW_SIZE per intent
    const byIntent = new Map<string, ToolAffinityObservation[]>();
    for (const obs of observations) {
      const arr = byIntent.get(obs.intent) ?? [];
      arr.push(obs);
      byIntent.set(obs.intent, arr);
    }

    const intents: IntentToolFrequency[] = [];
    for (const [intent, allObs] of byIntent) {
      const window = allObs.slice(-SLIDING_WINDOW_SIZE);
      const toolCounts: Record<string, number> = {};
      let noToolCount = 0;

      for (const obs of window) {
        if (obs.usedTools.length === 0) {
          noToolCount += 1;
        }
        for (const tool of obs.usedTools) {
          const key = tool.toLowerCase();
          toolCounts[key] = (toolCounts[key] ?? 0) + 1;
        }
      }

      intents.push({
        intent,
        totalObservations: window.length,
        noToolCount,
        toolCounts,
      });
    }

    return {
      talkId,
      computedAt: Date.now(),
      intents,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton Factory
// ---------------------------------------------------------------------------

const affinitySingletons = new Map<string, ToolAffinityStore>();

const DEFAULT_DATA_DIR = join(
  process.env.HOME || '~',
  '.openclaw',
  'plugins',
  'clawtalk',
);

export function getToolAffinityStore(dataDir: string | undefined, logger: Logger): ToolAffinityStore {
  const key = dataDir || DEFAULT_DATA_DIR;
  const existing = affinitySingletons.get(key);
  if (existing) return existing;
  const created = new ToolAffinityStore(key, logger);
  affinitySingletons.set(key, created);
  return created;
}

/** Kill switch: returns true if affinity system is disabled. */
export function isAffinityDisabled(): boolean {
  const raw = process.env.CLAWTALK_AFFINITY_ENABLED;
  if (!raw) return false;
  return raw.trim().toLowerCase() === 'false' || raw.trim() === '0';
}
