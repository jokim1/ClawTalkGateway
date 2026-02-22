import {
  classifyModelClass,
  TtftTracker,
  resetTtftTracker,
  getTtftTracker,
} from '../ttft-tracker';

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop } as any;

afterEach(() => {
  resetTtftTracker();
});

describe('classifyModelClass', () => {
  it('classifies Opus models', () => {
    expect(classifyModelClass('claude-opus-4-6')).toBe('opus');
    expect(classifyModelClass('claude-opus-4-5-20251001')).toBe('opus');
  });

  it('classifies Sonnet models', () => {
    expect(classifyModelClass('claude-sonnet-4-6')).toBe('sonnet');
    expect(classifyModelClass('claude-sonnet-4-5-20250514')).toBe('sonnet');
  });

  it('classifies Haiku models', () => {
    expect(classifyModelClass('claude-haiku-4-5-20251001')).toBe('haiku');
  });

  it('classifies GPT-4 models', () => {
    expect(classifyModelClass('gpt-4-turbo')).toBe('gpt-4');
    expect(classifyModelClass('gpt-4')).toBe('gpt-4');
  });

  it('classifies GPT-4o models (before GPT-4)', () => {
    expect(classifyModelClass('gpt-4o')).toBe('gpt-4o');
    expect(classifyModelClass('gpt-4o-mini')).toBe('gpt-4o');
  });

  it('classifies o-series models', () => {
    expect(classifyModelClass('o1-preview')).toBe('o-series');
    expect(classifyModelClass('o3-mini')).toBe('o-series');
  });

  it('classifies Gemini models', () => {
    expect(classifyModelClass('gemini-2.5-pro')).toBe('gemini');
    expect(classifyModelClass('gemini-2.0-flash')).toBe('gemini');
  });

  it('returns unknown for unrecognized models', () => {
    expect(classifyModelClass('openclaw')).toBe('unknown');
    expect(classifyModelClass('llama-3')).toBe('unknown');
    expect(classifyModelClass('')).toBe('unknown');
  });
});

describe('TtftTracker', () => {
  describe('cold-start defaults', () => {
    it('returns 120s for Opus with no observations', () => {
      const tracker = new TtftTracker(logger);
      expect(tracker.computeTimeout('claude-opus-4-6', 90_000)).toBe(120_000);
    });

    it('returns 45s for Sonnet with no observations', () => {
      const tracker = new TtftTracker(logger);
      expect(tracker.computeTimeout('claude-sonnet-4-6', 90_000)).toBe(45_000);
    });

    it('returns 30s for Haiku with no observations', () => {
      const tracker = new TtftTracker(logger);
      expect(tracker.computeTimeout('claude-haiku-4-5-20251001', 90_000)).toBe(30_000);
    });

    it('returns 120s for o-series with no observations', () => {
      const tracker = new TtftTracker(logger);
      expect(tracker.computeTimeout('o1-preview', 90_000)).toBe(120_000);
    });

    it('returns fallback for unknown models', () => {
      const tracker = new TtftTracker(logger);
      expect(tracker.computeTimeout('openclaw', 90_000)).toBe(90_000);
      expect(tracker.computeTimeout('openclaw', 120_000)).toBe(120_000);
    });
  });

  describe('adaptive computation', () => {
    it('returns cold-start with fewer than 3 observations', () => {
      const tracker = new TtftTracker(logger);
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 50_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 60_000, timedOut: false });
      expect(tracker.computeTimeout('claude-opus-4-6', 90_000)).toBe(120_000);
    });

    it('returns P95 * 1.3 after 3+ observations', () => {
      const tracker = new TtftTracker(logger);
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 50_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 60_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 80_000, timedOut: false });
      // sorted: [50000, 60000, 80000], P95 index = ceil(3 * 0.95) - 1 = 2, P95 = 80000
      // 80000 * 1.3 = 104000
      expect(tracker.computeTimeout('claude-opus-4-6', 90_000)).toBe(104_000);
    });

    it('ignores timeouts when computing P95', () => {
      const tracker = new TtftTracker(logger);
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 50_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 120_000, timedOut: true });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 60_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 70_000, timedOut: false });
      // successes sorted: [50000, 60000, 70000], P95 index = ceil(3 * 0.95) - 1 = 2, P95 = 70000
      // 70000 * 1.3 = 91000
      expect(tracker.computeTimeout('claude-opus-4-6', 90_000)).toBe(91_000);
    });

    it('returns escalated cold-start when all observations are timeouts', () => {
      const tracker = new TtftTracker(logger);
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 120_000, timedOut: true });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 120_000, timedOut: true });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 120_000, timedOut: true });
      // cold-start 120_000 * 1.5 = 180_000
      expect(tracker.computeTimeout('claude-opus-4-6', 90_000)).toBe(180_000);
    });

    it('clamps to floor of 15s', () => {
      const tracker = new TtftTracker(logger);
      tracker.record({ model: 'claude-haiku-4-5-20251001', ttftMs: 500, timedOut: false });
      tracker.record({ model: 'claude-haiku-4-5-20251001', ttftMs: 600, timedOut: false });
      tracker.record({ model: 'claude-haiku-4-5-20251001', ttftMs: 700, timedOut: false });
      // P95 = 700, 700 * 1.3 = 910 → clamped to 15_000
      expect(tracker.computeTimeout('claude-haiku-4-5-20251001', 90_000)).toBe(15_000);
    });

    it('clamps to ceiling of 300s', () => {
      const tracker = new TtftTracker(logger);
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 250_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 260_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 270_000, timedOut: false });
      // P95 = 270_000, 270_000 * 1.3 = 351_000 → clamped to 300_000
      expect(tracker.computeTimeout('claude-opus-4-6', 90_000)).toBe(300_000);
    });
  });

  describe('window sliding', () => {
    it('evicts oldest entries beyond window size', () => {
      const tracker = new TtftTracker(logger);
      // Record 18 fast observations, then 2 slow ones to seed initial data
      for (let i = 0; i < 18; i++) {
        tracker.record({ model: 'claude-sonnet-4-6', ttftMs: 10_000, timedOut: false });
      }
      tracker.record({ model: 'claude-sonnet-4-6', ttftMs: 40_000, timedOut: false });
      tracker.record({ model: 'claude-sonnet-4-6', ttftMs: 42_000, timedOut: false });
      // Window is full at 20 entries

      // Adding more entries should evict the oldest fast ones
      tracker.record({ model: 'claude-sonnet-4-6', ttftMs: 44_000, timedOut: false });
      tracker.record({ model: 'claude-sonnet-4-6', ttftMs: 46_000, timedOut: false });

      // Window now: 16 fast (10000) + 4 slow (40000, 42000, 44000, 46000)
      // sorted: [10000 x16, 40000, 42000, 44000, 46000]
      // P95 index = ceil(20 * 0.95) - 1 = 18 → sorted[18] = 44000
      // 44000 * 1.3 = 57200
      const timeout = tracker.computeTimeout('claude-sonnet-4-6', 90_000);
      expect(timeout).toBe(57_200);
    });
  });

  describe('model class isolation', () => {
    it('tracks different model classes independently', () => {
      const tracker = new TtftTracker(logger);
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 80_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 90_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 95_000, timedOut: false });

      tracker.record({ model: 'claude-sonnet-4-6', ttftMs: 10_000, timedOut: false });
      tracker.record({ model: 'claude-sonnet-4-6', ttftMs: 12_000, timedOut: false });
      tracker.record({ model: 'claude-sonnet-4-6', ttftMs: 15_000, timedOut: false });

      // Opus: P95 = 95000, * 1.3 = 123500
      expect(tracker.computeTimeout('claude-opus-4-6', 90_000)).toBe(123_500);
      // Sonnet: P95 = 15000, * 1.3 = 19500
      expect(tracker.computeTimeout('claude-sonnet-4-6', 90_000)).toBe(19_500);
    });
  });

  describe('health check', () => {
    it('reports not degraded with no observations', () => {
      const tracker = new TtftTracker(logger);
      const health = tracker.getHealth('claude-opus-4-6');
      expect(health.modelClass).toBe('opus');
      expect(health.observationCount).toBe(0);
      expect(health.degraded).toBe(false);
    });

    it('reports not degraded with all successes', () => {
      const tracker = new TtftTracker(logger);
      for (let i = 0; i < 5; i++) {
        tracker.record({ model: 'claude-opus-4-6', ttftMs: 50_000, timedOut: false });
      }
      const health = tracker.getHealth('claude-opus-4-6');
      expect(health.degraded).toBe(false);
      expect(health.recentTimeoutRate).toBe(0);
    });

    it('reports degraded when >50% recent observations timeout', () => {
      const tracker = new TtftTracker(logger);
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 50_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 120_000, timedOut: true });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 120_000, timedOut: true });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 120_000, timedOut: true });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 120_000, timedOut: true });
      // 4/5 = 80% timeout rate
      const health = tracker.getHealth('claude-opus-4-6');
      expect(health.degraded).toBe(true);
      expect(health.recentTimeoutRate).toBe(0.8);
    });

    it('reports not degraded at exactly 50% timeout rate', () => {
      const tracker = new TtftTracker(logger);
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 50_000, timedOut: false });
      tracker.record({ model: 'claude-opus-4-6', ttftMs: 120_000, timedOut: true });
      // 1/2 = 50% → not degraded (threshold is >50%)
      const health = tracker.getHealth('claude-opus-4-6');
      expect(health.degraded).toBe(false);
    });
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = getTtftTracker(logger);
      const b = getTtftTracker(logger);
      expect(a).toBe(b);
    });

    it('returns a new instance after reset', () => {
      const a = getTtftTracker(logger);
      resetTtftTracker();
      const b = getTtftTracker(logger);
      expect(a).not.toBe(b);
    });
  });
});
