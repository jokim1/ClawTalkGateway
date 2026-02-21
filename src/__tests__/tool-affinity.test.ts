import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  classifyMessageIntent,
  computeAffinityTimeout,
  computeColdStartBaseline,
  ToolAffinityStore,
  type ToolAffinityObservation,
  type AffinityPhase,
} from '../tool-affinity';

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop } as any;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'affinity-test-'));
}

describe('classifyMessageIntent', () => {
  it('classifies study entries', () => {
    expect(classifyMessageIntent('I studied math for 2 hours')).toBe('study');
    expect(classifyMessageIntent('Worked on coding for 30 minutes')).toBe('study');
  });

  it('classifies bare time quantities as other (no study keyword)', () => {
    expect(classifyMessageIntent('add 440 minutes for asher and 135 for jaxon')).toBe('other');
    expect(classifyMessageIntent('44m for kaela')).toBe('other');
    expect(classifyMessageIntent('pls add 2h for jaxon')).toBe('other');
  });

  it('classifies state_tracking', () => {
    expect(classifyMessageIntent('log my progress today')).toBe('state_tracking');
    expect(classifyMessageIntent('update my streak count')).toBe('state_tracking');
  });

  it('classifies google_docs', () => {
    expect(classifyMessageIntent('create a google doc called Notes')).toBe('google_docs');
    expect(classifyMessageIntent('read https://docs.google.com/document/d/abc/edit')).toBe('google_docs');
    expect(classifyMessageIntent('list my google drive files')).toBe('google_docs');
  });

  it('classifies web_research', () => {
    expect(classifyMessageIntent('search for the latest news')).toBe('web_research');
    expect(classifyMessageIntent('look up that URL for me')).toBe('web_research');
  });

  it('classifies code_execution', () => {
    expect(classifyMessageIntent('run the shell command ls -la')).toBe('code_execution');
    expect(classifyMessageIntent('execute this bash script')).toBe('code_execution');
  });

  it('classifies file_ops', () => {
    expect(classifyMessageIntent('read the file at /tmp/data.json')).toBe('file_ops');
    expect(classifyMessageIntent('create a new folder called test')).toBe('file_ops');
  });

  it('classifies automation', () => {
    expect(classifyMessageIntent('schedule a daily check')).toBe('automation');
    expect(classifyMessageIntent('create a recurring job every 2 hours')).toBe('automation');
  });

  it('classifies model_meta', () => {
    expect(classifyMessageIntent('what model are you?')).toBe('model_meta');
    expect(classifyMessageIntent('which model is running?')).toBe('model_meta');
    expect(classifyMessageIntent('who are you?')).toBe('model_meta');
  });

  it('classifies conversation', () => {
    expect(classifyMessageIntent('hi there')).toBe('conversation');
    expect(classifyMessageIntent('how do i get better at math?')).toBe('conversation');
    expect(classifyMessageIntent('thanks!')).toBe('conversation');
  });

  it('returns other for ambiguous messages', () => {
    expect(classifyMessageIntent('the sky is blue')).toBe('other');
    expect(classifyMessageIntent('')).toBe('other');
  });
});

describe('computeAffinityTimeout', () => {
  it('returns baseTimeout for warmup phase', () => {
    expect(computeAffinityTimeout({ phase: 'warmup', toolCount: 2, baseTimeoutMs: 240_000 }))
      .toBe(240_000);
  });

  it('returns baseTimeout for exploration phase', () => {
    expect(computeAffinityTimeout({ phase: 'exploration', toolCount: 2, baseTimeoutMs: 240_000 }))
      .toBe(240_000);
  });

  it('scales timeout for learned phase with 0 tools', () => {
    expect(computeAffinityTimeout({ phase: 'learned', toolCount: 0, baseTimeoutMs: 240_000 }))
      .toBe(60_000);
  });

  it('scales timeout for learned phase with 2 tools', () => {
    expect(computeAffinityTimeout({ phase: 'learned', toolCount: 2, baseTimeoutMs: 240_000 }))
      .toBe(100_000);
  });

  it('scales timeout for learned phase with 5 tools', () => {
    expect(computeAffinityTimeout({ phase: 'learned', toolCount: 5, baseTimeoutMs: 240_000 }))
      .toBe(160_000);
  });

  it('caps at baseTimeout for many tools', () => {
    expect(computeAffinityTimeout({ phase: 'learned', toolCount: 17, baseTimeoutMs: 240_000 }))
      .toBe(240_000);
  });

  it('respects minTimeoutMs floor for learned phase with 0 tools', () => {
    expect(computeAffinityTimeout({ phase: 'learned', toolCount: 0, baseTimeoutMs: 240_000, minTimeoutMs: 120_000 }))
      .toBe(120_000);
  });

  it('respects minTimeoutMs floor for learned phase with 1 tool', () => {
    // 60_000 + 1*20_000 = 80_000 < 120_000 floor → floor wins
    expect(computeAffinityTimeout({ phase: 'learned', toolCount: 1, baseTimeoutMs: 240_000, minTimeoutMs: 120_000 }))
      .toBe(120_000);
  });

  it('uses computed timeout when it exceeds minTimeoutMs', () => {
    // 60_000 + 5*20_000 = 160_000 > 120_000 floor → computed wins
    expect(computeAffinityTimeout({ phase: 'learned', toolCount: 5, baseTimeoutMs: 240_000, minTimeoutMs: 120_000 }))
      .toBe(160_000);
  });

  it('ignores minTimeoutMs for warmup/exploration phases', () => {
    expect(computeAffinityTimeout({ phase: 'warmup', toolCount: 0, baseTimeoutMs: 240_000, minTimeoutMs: 120_000 }))
      .toBe(240_000);
    expect(computeAffinityTimeout({ phase: 'exploration', toolCount: 0, baseTimeoutMs: 240_000, minTimeoutMs: 120_000 }))
      .toBe(240_000);
  });
});

describe('ToolAffinityStore', () => {
  describe('recordObservation', () => {
    it('appends observations to JSONL file', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-talk-1';

      store.recordObservation(talkId, {
        timestamp: Date.now(),
        intent: 'study',
        availableTools: ['tool_a', 'tool_b'],
        usedTools: ['tool_a'],
        toolsOffered: 2,
        model: 'test-model',
        source: 'talk-chat',
      });

      const filePath = path.join(dataDir, 'talks', talkId, 'affinity', 'observations.jsonl');
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.intent).toBe('study');
      expect(parsed.usedTools).toEqual(['tool_a']);
    });

    it('invalidates snapshot cache on new observation', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-talk-cache';

      // Seed observations
      for (let i = 0; i < 10; i++) {
        store.recordObservation(talkId, {
          timestamp: Date.now(),
          intent: 'study',
          availableTools: ['tool_a'],
          usedTools: i % 2 === 0 ? ['tool_a'] : [],
          toolsOffered: 1,
          model: 'test-model',
          source: 'talk-chat',
        });
      }

      const snap1 = store.getSnapshot(talkId);
      expect(snap1).toBeDefined();

      // Record a new observation — should invalidate cache
      store.recordObservation(talkId, {
        timestamp: Date.now(),
        intent: 'study',
        availableTools: ['tool_a', 'tool_b'],
        usedTools: ['tool_b'],
        toolsOffered: 2,
        model: 'test-model',
        source: 'talk-chat',
      });

      const snap2 = store.getSnapshot(talkId);
      expect(snap2).toBeDefined();
      expect(snap2!.computedAt).toBeGreaterThanOrEqual(snap1!.computedAt);
    });
  });

  describe('getSnapshot', () => {
    it('returns undefined for empty talk', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      expect(store.getSnapshot('nonexistent')).toBeUndefined();
    });

    it('computes sliding window aggregation', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-talk-snap';

      // Add 10 study observations: tool_a used 8 times, tool_b used 2 times
      for (let i = 0; i < 10; i++) {
        store.recordObservation(talkId, {
          timestamp: Date.now() + i,
          intent: 'study',
          availableTools: ['tool_a', 'tool_b'],
          usedTools: i < 8 ? ['tool_a'] : ['tool_b'],
          toolsOffered: 2,
          model: 'test-model',
          source: 'talk-chat',
        });
      }

      const snapshot = store.getSnapshot(talkId)!;
      expect(snapshot.talkId).toBe(talkId);
      expect(snapshot.intents).toHaveLength(1);
      expect(snapshot.intents[0].intent).toBe('study');
      expect(snapshot.intents[0].totalObservations).toBe(10);
      expect(snapshot.intents[0].toolCounts['tool_a']).toBe(8);
      expect(snapshot.intents[0].toolCounts['tool_b']).toBe(2);
    });
  });

  describe('selectTools', () => {
    function seedObservations(store: ToolAffinityStore, talkId: string, count: number, usedTools: string[]): void {
      for (let i = 0; i < count; i++) {
        store.recordObservation(talkId, {
          timestamp: Date.now() + i,
          intent: 'study',
          availableTools: ['tool_a', 'tool_b', 'tool_c'],
          usedTools,
          toolsOffered: 3,
          model: 'test-model',
          source: 'talk-chat',
        });
      }
    }

    it('returns warmup for insufficient observations on non-cold-start intent', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-warmup';

      // Use 'web_research' intent which is NOT a cold-start intent
      // 2 observations is below the warmup threshold of 3
      for (let i = 0; i < 2; i++) {
        store.recordObservation(talkId, {
          timestamp: Date.now() + i,
          intent: 'web_research',
          availableTools: ['tool_a', 'tool_b', 'tool_c'],
          usedTools: ['tool_a'],
          toolsOffered: 3,
          model: 'test-model',
          source: 'talk-chat',
        });
      }
      const snapshot = store.getSnapshot(talkId);
      const result = store.selectTools({
        talkId,
        intent: 'web_research',
        policyAllowedTools: ['tool_a', 'tool_b', 'tool_c'],
        snapshot,
      });

      expect(result.phase).toBe('warmup');
      expect(result.selectedTools).toEqual(['tool_a', 'tool_b', 'tool_c']);
      expect(result.prunedTools).toEqual([]);
    });

    it('returns cold-start learned with baseline tools when baseline provided', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-cold-start';

      // No observations at all — baseline provided, study intent uses it
      const origRandom = Math.random;
      Math.random = () => 0.5; // avoid exploration
      try {
        const result = store.selectTools({
          talkId,
          intent: 'study',
          policyAllowedTools: ['state_append_event', 'state_read_summary', 'google_docs_append', 'web_search'],
          snapshot: undefined,
          coldStartBaseline: ['state_append_event', 'state_read_summary'],
        });

        expect(result.phase).toBe('learned');
        expect(result.selectedTools).toEqual(['state_append_event', 'state_read_summary']);
        expect(result.prunedTools).toEqual(['google_docs_append', 'web_search']);
        expect(result.reason).toContain('cold-start');
        expect(result.reason).toContain('baseline=2');
      } finally {
        Math.random = origRandom;
      }
    });

    it('returns cold-start learned with zero tools for cold-start intent without baseline', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-cold-start-no-baseline';

      const origRandom = Math.random;
      Math.random = () => 0.5; // avoid exploration
      try {
        const result = store.selectTools({
          talkId,
          intent: 'conversation',
          policyAllowedTools: ['google_docs_append', 'web_search'],
          snapshot: undefined,
        });

        expect(result.phase).toBe('learned');
        expect(result.selectedTools).toEqual([]);
        expect(result.prunedTools).toEqual(['google_docs_append', 'web_search']);
        expect(result.reason).toContain('cold-start');
        expect(result.reason).toContain('baseline=0');
      } finally {
        Math.random = origRandom;
      }
    });

    it('returns cold-start baseline for "other" intent when baseline provided', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-other-with-baseline';

      const origRandom = Math.random;
      Math.random = () => 0.5; // avoid exploration
      try {
        const result = store.selectTools({
          talkId,
          intent: 'other',
          policyAllowedTools: ['state_append_event', 'state_read_summary', 'google_docs_append', 'web_search'],
          snapshot: undefined,
          coldStartBaseline: ['state_append_event', 'state_read_summary'],
        });

        expect(result.phase).toBe('learned');
        expect(result.selectedTools).toEqual(['state_append_event', 'state_read_summary']);
        expect(result.prunedTools).toEqual(['google_docs_append', 'web_search']);
        expect(result.reason).toContain('cold-start');
        expect(result.reason).toContain('baseline=2');
      } finally {
        Math.random = origRandom;
      }
    });

    it('returns warmup for "other" intent without baseline', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-other-no-baseline';

      const result = store.selectTools({
        talkId,
        intent: 'other',
        policyAllowedTools: ['state_append_event', 'web_search'],
        snapshot: undefined,
      });

      expect(result.phase).toBe('warmup');
      expect(result.selectedTools).toEqual(['state_append_event', 'web_search']);
    });

    it('returns learned subset after warmup threshold', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-learned';

      seedObservations(store, talkId, 10, ['tool_a']);
      const snapshot = store.getSnapshot(talkId);

      // Mock Math.random to avoid exploration trigger
      const origRandom = Math.random;
      Math.random = () => 0.5; // > 1/20, so learned phase

      try {
        const result = store.selectTools({
          talkId,
          intent: 'study',
          policyAllowedTools: ['tool_a', 'tool_b', 'tool_c'],
          snapshot,
        });

        expect(result.phase).toBe('learned');
        expect(result.selectedTools).toEqual(['tool_a']);
        expect(result.prunedTools).toEqual(['tool_b', 'tool_c']);
      } finally {
        Math.random = origRandom;
      }
    });

    it('returns exploration on random trigger', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-explore';

      seedObservations(store, talkId, 10, ['tool_a']);
      const snapshot = store.getSnapshot(talkId);

      // Mock Math.random to trigger exploration (< 1/20 = 0.05)
      const origRandom = Math.random;
      Math.random = () => 0.01;

      try {
        const result = store.selectTools({
          talkId,
          intent: 'study',
          policyAllowedTools: ['tool_a', 'tool_b', 'tool_c'],
          snapshot,
        });

        expect(result.phase).toBe('exploration');
        expect(result.selectedTools).toEqual(['tool_a', 'tool_b', 'tool_c']);
      } finally {
        Math.random = origRandom;
      }
    });

    it('returns all tools for unknown intent', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-unknown';

      seedObservations(store, talkId, 10, ['tool_a']);
      const snapshot = store.getSnapshot(talkId);

      const result = store.selectTools({
        talkId,
        intent: 'completely_new_intent',
        policyAllowedTools: ['tool_a', 'tool_b'],
        snapshot,
      });

      expect(result.phase).toBe('warmup');
      expect(result.selectedTools).toEqual(['tool_a', 'tool_b']);
    });

    it('uses baseline (not 0 tools) when 1 observation recorded with 0 tools used (death spiral regression)', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-death-spiral';
      const allTools = ['state_append_event', 'state_read_summary', 'state_read_state', 'state_get_event',
        'google_docs_append', 'web_search', 'tool_x'];
      const baseline = ['state_append_event', 'state_read_summary', 'state_read_state', 'state_get_event'];

      // Simulate: first study request observed 0 tools used (cold-start baseline was sent)
      store.recordObservation(talkId, {
        timestamp: Date.now(),
        intent: 'study',
        availableTools: baseline,
        usedTools: [],
        toolsOffered: 4,
        model: 'kimi-k2.5',
        source: 'slack-ingress',
      });

      const origRandom = Math.random;
      Math.random = () => 0.5; // avoid exploration
      try {
        const snapshot = store.getSnapshot(talkId);
        const result = store.selectTools({
          talkId,
          intent: 'study',
          policyAllowedTools: allTools,
          snapshot,
          coldStartBaseline: baseline,
        });

        // With the fix: 1 observation < warmup threshold (3) → use baseline, NOT affinity
        expect(result.phase).toBe('learned');
        expect(result.selectedTools).toEqual(baseline);
        expect(result.reason).toContain('cold-start');
        expect(result.reason).toContain('baseline=4');
      } finally {
        Math.random = origRandom;
      }
    });

    it('uses baseline at WARMUP_THRESHOLD-1 observations, switches to affinity at WARMUP_THRESHOLD', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-threshold-boundary';
      const allTools = ['state_append_event', 'state_read_summary', 'google_docs_append'];
      const baseline = ['state_append_event', 'state_read_summary'];

      // Seed 2 observations (WARMUP_THRESHOLD - 1) with 0 tools used
      for (let i = 0; i < 2; i++) {
        store.recordObservation(talkId, {
          timestamp: Date.now() + i,
          intent: 'study',
          availableTools: baseline,
          usedTools: [],
          toolsOffered: 2,
          model: 'test-model',
          source: 'talk-chat',
        });
      }

      const origRandom = Math.random;
      Math.random = () => 0.5; // avoid exploration
      try {
        let snapshot = store.getSnapshot(talkId);
        let result = store.selectTools({
          talkId,
          intent: 'study',
          policyAllowedTools: allTools,
          snapshot,
          coldStartBaseline: baseline,
        });

        // 2 < 3 → still uses baseline
        expect(result.phase).toBe('learned');
        expect(result.selectedTools).toEqual(baseline);
        expect(result.reason).toContain('cold-start');

        // Add observation #3 to cross threshold — still 0 tools used
        store.recordObservation(talkId, {
          timestamp: Date.now() + 3,
          intent: 'study',
          availableTools: baseline,
          usedTools: [],
          toolsOffered: 2,
          model: 'test-model',
          source: 'talk-chat',
        });

        snapshot = store.getSnapshot(talkId);
        result = store.selectTools({
          talkId,
          intent: 'study',
          policyAllowedTools: allTools,
          snapshot,
          coldStartBaseline: baseline,
        });

        // 3 >= 3 → learned affinity kicks in, all 3 observations had 0 tools → prunes all
        expect(result.phase).toBe('learned');
        expect(result.selectedTools).toEqual([]);
        expect(result.reason).toContain('affinity=0');
      } finally {
        Math.random = origRandom;
      }
    });
  });

  describe('warmup to learned transition', () => {
    it('transitions from warmup to learned after threshold observations', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-transition';
      const allTools = ['tool_a', 'tool_b', 'tool_c', 'tool_d'];

      // Use 'file_ops' intent — NOT a cold-start intent, so it goes through normal warmup
      // Record 2 observations (below threshold of 3)
      for (let i = 0; i < 2; i++) {
        store.recordObservation(talkId, {
          timestamp: Date.now() + i,
          intent: 'file_ops',
          availableTools: allTools,
          usedTools: [],
          toolsOffered: 4,
          model: 'test-model',
          source: 'talk-chat',
        });
      }

      let snapshot = store.getSnapshot(talkId);
      let selection = store.selectTools({
        talkId,
        intent: 'file_ops',
        policyAllowedTools: allTools,
        snapshot,
      });
      expect(selection.phase).toBe('warmup');
      expect(selection.selectedTools).toHaveLength(4);

      // Add observation #3 to cross threshold
      store.recordObservation(talkId, {
        timestamp: Date.now() + 3,
        intent: 'file_ops',
        availableTools: allTools,
        usedTools: [],
        toolsOffered: 4,
        model: 'test-model',
        source: 'talk-chat',
      });

      // Mock Math.random to avoid exploration
      const origRandom = Math.random;
      Math.random = () => 0.5;
      try {
        snapshot = store.getSnapshot(talkId);
        selection = store.selectTools({
          talkId,
          intent: 'file_ops',
          policyAllowedTools: allTools,
          snapshot,
        });
        // All 3 observations used 0 tools, so learned phase with no tools
        expect(selection.phase).toBe('learned');
        expect(selection.selectedTools).toHaveLength(0);
        expect(selection.prunedTools).toHaveLength(4);
      } finally {
        Math.random = origRandom;
      }
    });
  });

  describe('resolvePhase', () => {
    it('returns warmup for undefined snapshot on non-cold-start intent', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      expect(store.resolvePhase('web_research', undefined)).toBe('warmup');
    });

    it('returns warmup for unknown intent in snapshot', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const snapshot = { talkId: 't', computedAt: Date.now(), intents: [] };
      expect(store.resolvePhase('web_research', snapshot)).toBe('warmup');
    });

    it('returns learned for cold-start intent even with no snapshot', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const origRandom = Math.random;
      Math.random = () => 0.5;
      try {
        expect(store.resolvePhase('study', undefined)).toBe('learned');
        expect(store.resolvePhase('conversation', undefined)).toBe('learned');
        expect(store.resolvePhase('state_tracking', undefined)).toBe('learned');
        expect(store.resolvePhase('model_meta', undefined)).toBe('learned');
      } finally {
        Math.random = origRandom;
      }
    });

    it('returns learned for non-cold-start intent when hasBaseline is true', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const origRandom = Math.random;
      Math.random = () => 0.5;
      try {
        expect(store.resolvePhase('other', undefined, true)).toBe('learned');
        expect(store.resolvePhase('google_docs', undefined, true)).toBe('learned');
      } finally {
        Math.random = origRandom;
      }
    });

    it('returns warmup for non-cold-start intent when hasBaseline is false', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      expect(store.resolvePhase('other', undefined, false)).toBe('warmup');
      expect(store.resolvePhase('google_docs', undefined)).toBe('warmup');
    });
  });
});

describe('computeColdStartBaseline', () => {
  it('returns state tools for stream_store backend', () => {
    const result = computeColdStartBaseline({
      stateBackend: 'stream_store',
      policyAllowedTools: ['state_append_event', 'state_read_summary', 'google_docs_append', 'web_search'],
    });
    expect(result).toEqual(['state_append_event', 'state_read_summary']);
  });

  it('returns state tools when stateBackend is undefined (defaults to stream_store)', () => {
    const result = computeColdStartBaseline({
      stateBackend: undefined,
      policyAllowedTools: ['state_append_event', 'state_read_summary', 'web_search'],
    });
    expect(result).toEqual(['state_append_event', 'state_read_summary']);
  });

  it('returns empty array for workspace_files backend', () => {
    const result = computeColdStartBaseline({
      stateBackend: 'workspace_files',
      policyAllowedTools: ['state_append_event', 'state_read_summary', 'web_search'],
    });
    expect(result).toEqual([]);
  });

  it('returns empty array when no state tools in policy', () => {
    const result = computeColdStartBaseline({
      stateBackend: 'stream_store',
      policyAllowedTools: ['google_docs_append', 'web_search'],
    });
    expect(result).toEqual([]);
  });
});
