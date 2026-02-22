/**
 * Adaptive TTFT (Time-To-First-Token) Tracker
 *
 * In-memory per-model-class sliding window that tracks TTFT observations
 * and computes adaptive timeouts. Resets on restart, re-learns in ~3 requests.
 *
 * Model classes group model ID variations (e.g., `claude-opus-4-6` → `opus`)
 * so they share observations.
 */

import type { Logger } from './types.js';

// ---------------------------------------------------------------------------
// Model class classification
// ---------------------------------------------------------------------------

export type ModelClass = 'opus' | 'sonnet' | 'haiku' | 'gpt-4' | 'gpt-4o' | 'o-series' | 'gemini' | 'unknown';

const MODEL_CLASS_RULES: Array<{ pattern: RegExp; modelClass: ModelClass }> = [
  { pattern: /\bopus\b/i, modelClass: 'opus' },
  { pattern: /\bhaiku\b/i, modelClass: 'haiku' },
  { pattern: /\bsonnet\b/i, modelClass: 'sonnet' },
  { pattern: /\bo[134]-/i, modelClass: 'o-series' },
  { pattern: /\bgpt-4o\b/i, modelClass: 'gpt-4o' },
  { pattern: /\bgpt-4\b/i, modelClass: 'gpt-4' },
  { pattern: /\bgemini\b/i, modelClass: 'gemini' },
];

export function classifyModelClass(modelId: string): ModelClass {
  const id = modelId.trim().toLowerCase();
  if (!id) return 'unknown';
  for (const rule of MODEL_CLASS_RULES) {
    if (rule.pattern.test(id)) return rule.modelClass;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Cold-start defaults (ms)
// ---------------------------------------------------------------------------

const COLD_START_DEFAULTS: Record<ModelClass, number | null> = {
  opus: 120_000,
  'o-series': 120_000,
  'gpt-4': 60_000,
  sonnet: 45_000,
  'gpt-4o': 45_000,
  gemini: 45_000,
  haiku: 30_000,
  unknown: null, // falls back to resolveTalkFirstTokenTimeoutMs()
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimum observations before switching from cold-start to adaptive. */
const ADAPTIVE_MIN_OBSERVATIONS = 3;
/** Sliding window size — keep last N observations per model class. */
const WINDOW_SIZE = 20;
/** Margin multiplied onto P95 to compute adaptive timeout. */
const ADAPTIVE_MARGIN = 1.3;
/** Absolute minimum adaptive timeout (ms). */
const ADAPTIVE_FLOOR_MS = 15_000;
/** Absolute maximum adaptive timeout (ms). */
const ADAPTIVE_CEILING_MS = 300_000;
/** Escalation factor applied to cold-start default when all recent obs are timeouts. */
const ALL_TIMEOUT_ESCALATION = 1.5;
/** Number of recent observations to check for health/degradation. */
const HEALTH_WINDOW = 5;
/** Timeout rate threshold for degraded status. */
const DEGRADED_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TtftObservation {
  model: string;
  ttftMs: number;
  timedOut: boolean;
}

export interface TtftHealthStatus {
  modelClass: ModelClass;
  observationCount: number;
  recentTimeoutRate: number;
  degraded: boolean;
}

interface ObservationEntry {
  ttftMs: number;
  timedOut: boolean;
  recordedAt: number;
}

// ---------------------------------------------------------------------------
// TtftTracker
// ---------------------------------------------------------------------------

export class TtftTracker {
  private readonly windows = new Map<ModelClass, ObservationEntry[]>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Record a TTFT observation (success or timeout). */
  record(obs: TtftObservation): void {
    const modelClass = classifyModelClass(obs.model);
    let window = this.windows.get(modelClass);
    if (!window) {
      window = [];
      this.windows.set(modelClass, window);
    }
    window.push({
      ttftMs: obs.ttftMs,
      timedOut: obs.timedOut,
      recordedAt: Date.now(),
    });
    // Slide window
    if (window.length > WINDOW_SIZE) {
      window.splice(0, window.length - WINDOW_SIZE);
    }
    this.logger.info(
      `TtftTracker: recorded ${obs.timedOut ? 'timeout' : 'success'} `
      + `model=${obs.model} class=${modelClass} ttft=${obs.ttftMs}ms `
      + `observations=${window.length}`,
    );
  }

  /**
   * Compute an adaptive timeout for the given model.
   * @param model — the model ID (e.g., `claude-opus-4-6`)
   * @param fallbackMs — fallback for unknown model classes (from resolveTalkFirstTokenTimeoutMs)
   * @returns timeout in milliseconds
   */
  computeTimeout(model: string, fallbackMs: number): number {
    const modelClass = classifyModelClass(model);
    const coldStart = COLD_START_DEFAULTS[modelClass] ?? fallbackMs;
    const window = this.windows.get(modelClass);

    // No observations → cold-start default
    if (!window || window.length === 0) {
      return coldStart;
    }

    // Not enough observations → cold-start default
    if (window.length < ADAPTIVE_MIN_OBSERVATIONS) {
      return coldStart;
    }

    // All recent observations are timeouts → escalated cold-start
    const successes = window.filter((e) => !e.timedOut);
    if (successes.length === 0) {
      return Math.min(ADAPTIVE_CEILING_MS, coldStart * ALL_TIMEOUT_ESCALATION);
    }

    // Compute P95 of successful TTFTs
    const sorted = successes.map((e) => e.ttftMs).sort((a, b) => a - b);
    const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
    const p95 = sorted[p95Index];
    const adaptive = Math.round(p95 * ADAPTIVE_MARGIN);

    // Clamp to [floor, ceiling]
    return Math.max(ADAPTIVE_FLOOR_MS, Math.min(ADAPTIVE_CEILING_MS, adaptive));
  }

  /** Report health status for a model class. */
  getHealth(model: string): TtftHealthStatus {
    const modelClass = classifyModelClass(model);
    const window = this.windows.get(modelClass);
    if (!window || window.length === 0) {
      return { modelClass, observationCount: 0, recentTimeoutRate: 0, degraded: false };
    }
    const recentSlice = window.slice(-HEALTH_WINDOW);
    const timeoutCount = recentSlice.filter((e) => e.timedOut).length;
    const recentTimeoutRate = timeoutCount / recentSlice.length;
    return {
      modelClass,
      observationCount: window.length,
      recentTimeoutRate,
      degraded: recentTimeoutRate > DEGRADED_THRESHOLD,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let singletonTracker: TtftTracker | undefined;

export function getTtftTracker(logger: Logger): TtftTracker {
  if (singletonTracker) return singletonTracker;
  singletonTracker = new TtftTracker(logger);
  return singletonTracker;
}

/** Reset the singleton (for tests). */
export function resetTtftTracker(): void {
  singletonTracker = undefined;
}
