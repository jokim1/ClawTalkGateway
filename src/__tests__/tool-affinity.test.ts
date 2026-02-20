import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  classifyMessageIntent,
  computeAffinityTimeout,
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
      for (let i = 0; i < 3; i++) {
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

    it('returns cold-start learned with zero tools for study intent', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-cold-start';

      // No observations at all — cold-start intents go directly to learned
      const origRandom = Math.random;
      Math.random = () => 0.5; // avoid exploration
      try {
        const result = store.selectTools({
          talkId,
          intent: 'study',
          policyAllowedTools: ['tool_a', 'tool_b', 'tool_c'],
          snapshot: undefined,
        });

        expect(result.phase).toBe('learned');
        expect(result.selectedTools).toEqual([]);
        expect(result.prunedTools).toEqual(['tool_a', 'tool_b', 'tool_c']);
        expect(result.reason).toContain('cold-start');
      } finally {
        Math.random = origRandom;
      }
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
  });

  describe('warmup to learned transition', () => {
    it('transitions from warmup to learned after threshold observations', () => {
      const dataDir = makeTmpDir();
      const store = new ToolAffinityStore(dataDir, logger);
      const talkId = 'test-transition';
      const allTools = ['tool_a', 'tool_b', 'tool_c', 'tool_d'];

      // Use 'file_ops' intent — NOT a cold-start intent, so it goes through normal warmup
      // Record 7 observations (below threshold of 8)
      for (let i = 0; i < 7; i++) {
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

      // Add observation #8 to cross threshold
      store.recordObservation(talkId, {
        timestamp: Date.now() + 8,
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
        // All 8 observations used 0 tools, so learned phase with no tools
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
  });
});
