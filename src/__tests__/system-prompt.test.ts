import { composeSystemPrompt } from '../system-prompt';
import type { TalkMeta, TalkMessage } from '../types';

function makeMeta(overrides: Partial<TalkMeta> = {}): TalkMeta {
  return {
    id: 'test-talk-1',
    pinnedMessageIds: [],
    jobs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeMessage(overrides: Partial<TalkMessage> = {}): TalkMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'This is a test message.',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('composeSystemPrompt', () => {
  it('returns a prompt even when no enrichment data exists', () => {
    const result = composeSystemPrompt({
      meta: makeMeta(),
      contextMd: '',
      pinnedMessages: [],
    });
    // Always includes base instruction and execution environment
    expect(result).toBeDefined();
    expect(result).toContain('focused assistant');
  });

  it('returns a prompt for whitespace-only contextMd', () => {
    const result = composeSystemPrompt({
      meta: makeMeta(),
      contextMd: '   \n\n  ',
      pinnedMessages: [],
    });
    expect(result).toBeDefined();
    // Should NOT include context section for whitespace-only
    expect(result).not.toContain('## Conversation Context');
  });

  it('includes objective section when set', () => {
    const result = composeSystemPrompt({
      meta: makeMeta({ objective: 'Help user plan their sprint tasks' }),
      contextMd: '',
      pinnedMessages: [],
    });
    expect(result).toBeDefined();
    expect(result).toContain('## Objectives');
    expect(result).toContain('Help user plan their sprint tasks');
    expect(result).toContain('steer it back');
  });

  it('includes context section when contextMd is provided', () => {
    const result = composeSystemPrompt({
      meta: makeMeta(),
      contextMd: 'User is working on a React project. They prefer TypeScript.',
      pinnedMessages: [],
    });
    expect(result).toBeDefined();
    expect(result).toContain('## Conversation Context');
    expect(result).toContain('User is working on a React project');
  });

  it('trims contextMd whitespace', () => {
    const result = composeSystemPrompt({
      meta: makeMeta(),
      contextMd: '\n  Some context with whitespace  \n',
      pinnedMessages: [],
    });
    expect(result).toContain('Some context with whitespace');
    expect(result).not.toContain('\n  Some context');
  });

  it('includes pinned messages section', () => {
    const msg = makeMessage({
      role: 'assistant',
      content: 'The API endpoint is /api/users and requires Bearer auth.',
      timestamp: new Date('2026-01-15T10:30:00Z').getTime(),
    });
    const result = composeSystemPrompt({
      meta: makeMeta({ pinnedMessageIds: [msg.id] }),
      contextMd: '',
      pinnedMessages: [msg],
    });
    expect(result).toBeDefined();
    expect(result).toContain('## Pinned References');
    expect(result).toContain('assistant');
    expect(result).toContain('2026-01-15 10:30');
    expect(result).toContain('/api/users');
  });

  it('truncates long pinned message content to 200 chars', () => {
    const longContent = 'A'.repeat(300);
    const msg = makeMessage({ content: longContent });
    const result = composeSystemPrompt({
      meta: makeMeta({ pinnedMessageIds: [msg.id] }),
      contextMd: '',
      pinnedMessages: [msg],
    })!;
    // Should contain the truncated version, not the full 300 chars
    expect(result).toContain('A'.repeat(200) + '...');
    expect(result).not.toContain('A'.repeat(201));
  });

  it('caps pinned messages at 10', () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      makeMessage({ id: `msg-${i}`, content: `Pin ${i}` })
    );
    const result = composeSystemPrompt({
      meta: makeMeta({ pinnedMessageIds: messages.map(m => m.id) }),
      contextMd: '',
      pinnedMessages: messages,
    })!;
    expect(result).toContain('Pin 0');
    expect(result).toContain('Pin 9');
    expect(result).not.toContain('Pin 10');
    expect(result).toContain('5 more pinned messages');
  });

  it('includes active jobs section', () => {
    const result = composeSystemPrompt({
      meta: makeMeta({
        jobs: [
          { id: 'j1', schedule: 'every 6h', prompt: 'Check sprint burndown', active: true, createdAt: Date.now() },
          { id: 'j2', schedule: 'daily 9am', prompt: 'Summarize PRs', active: false, createdAt: Date.now() },
        ],
      }),
      contextMd: '',
      pinnedMessages: [],
    });
    expect(result).toBeDefined();
    expect(result).toContain('## Active Automations');
    expect(result).toContain('[every 6h] Check sprint burndown');
    // Inactive job should NOT appear in Active Automations section
    expect(result).not.toContain('Summarize PRs');
  });

  it('omits active jobs section when all jobs are inactive', () => {
    const result = composeSystemPrompt({
      meta: makeMeta({
        jobs: [
          { id: 'j1', schedule: 'daily', prompt: 'Paused task', active: false, createdAt: Date.now() },
        ],
      }),
      contextMd: '',
      pinnedMessages: [],
    });
    // Should still return a prompt (base instruction), but no Active Automations section
    expect(result).toBeDefined();
    expect(result).not.toContain('## Active Automations');
  });

  it('truncates long job prompts to 200 chars', () => {
    const longPrompt = 'B'.repeat(300);
    const result = composeSystemPrompt({
      meta: makeMeta({
        jobs: [
          { id: 'j1', schedule: 'every 1h', prompt: longPrompt, active: true, createdAt: Date.now() },
        ],
      }),
      contextMd: '',
      pinnedMessages: [],
    })!;
    expect(result).toContain('B'.repeat(200) + '...');
    expect(result).not.toContain('B'.repeat(201));
  });

  it('combines all sections together', () => {
    const msg = makeMessage({ content: 'Important finding about the bug.' });
    const result = composeSystemPrompt({
      meta: makeMeta({
        objective: 'Debug the login flow',
        pinnedMessageIds: [msg.id],
        jobs: [
          { id: 'j1', schedule: 'every 1h', prompt: 'Check error logs', active: true, createdAt: Date.now() },
        ],
      }),
      contextMd: 'User found a null pointer in auth middleware.',
      pinnedMessages: [msg],
    })!;

    expect(result).toContain('focused assistant');
    expect(result).toContain('## Objectives');
    expect(result).toContain('Debug the login flow');
    expect(result).toContain('## Conversation Context');
    expect(result).toContain('null pointer in auth middleware');
    expect(result).toContain('## Pinned References');
    expect(result).toContain('Important finding');
    expect(result).toContain('## Active Automations');
    expect(result).toContain('Check error logs');
  });

  it('includes the base instruction', () => {
    const result = composeSystemPrompt({
      meta: makeMeta({ objective: 'Test' }),
      contextMd: '',
      pinnedMessages: [],
    })!;
    expect(result).toContain('focused assistant');
  });

  it('separates sections with double newlines', () => {
    const result = composeSystemPrompt({
      meta: makeMeta({ objective: 'Test objective' }),
      contextMd: 'Some context',
      pinnedMessages: [],
    })!;
    // Sections should be separated by \n\n
    expect(result).toContain('## Objectives');
    expect(result).toContain('## Conversation Context');
    // Both should appear with clear separation
    expect(result).toContain('Test objective');
    expect(result).toContain('Some context');
  });
});
