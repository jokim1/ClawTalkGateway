import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __resetSlackIngressStateForTests,
  getSlackIngressTalkRuntimeSnapshot,
  handleSlackMessageReceivedHook,
  inspectSlackOwnership,
  routeSlackIngressEvent,
  type SlackIngressEvent,
} from '../slack-ingress';
import { TalkStore } from '../talk-store';
import { ToolRegistry } from '../tool-registry';
import { ToolExecutor } from '../tool-executor';
import type { Logger } from '../types';

const mockLogger: Logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

let tmpDir: string;
let store: TalkStore;
let registry: ToolRegistry;
let executor: ToolExecutor;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'slack-ingress-test-'));
  store = new TalkStore(tmpDir, mockLogger);
  await store.init();
  registry = new ToolRegistry(tmpDir, mockLogger);
  executor = new ToolExecutor(registry, store, mockLogger);
  __resetSlackIngressStateForTests();
  jest.clearAllMocks();
});

afterEach(async () => {
  __resetSlackIngressStateForTests();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function buildDeps() {
  return {
    store,
    registry,
    executor,
    dataDir: tmpDir,
    gatewayOrigin: 'http://127.0.0.1:18789',
    authToken: 'test-token',
    logger: mockLogger,
    autoProcessQueue: false,
    sendSlackMessage: jest.fn(async () => true),
  };
}

function addSlackBinding(scope: string): string {
  return addSlackBindingWithId(scope).talkId;
}

function addSlackBindingWithId(scope: string): { talkId: string; bindingId: string } {
  const talk = store.createTalk('test-model');
  const bindingId = `binding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  store.updateTalk(talk.id, {
    platformBindings: [{
      id: bindingId,
      platform: 'slack',
      scope,
      permission: 'read+write',
      createdAt: Date.now(),
    }],
  });
  return { talkId: talk.id, bindingId };
}

describe('slack ingress delegation', () => {
  it('delegates matching channel events to OpenClaw agent (returns pass)', async () => {
    addSlackBinding('channel:c123');

    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C123',
        content: 'hello from slack',
        metadata: {
          to: 'channel:C123',
          messageId: '1700000000.100',
          senderId: 'U123',
        },
      },
      {
        channelId: 'slack',
        accountId: 'acct-1',
      },
      buildDeps(),
    );
    // Delegated channels return undefined (pass) — OpenClaw's managed agent handles
    expect(hookResult).toBeUndefined();
  });

  it('delegates user-scoped bindings for Slack DM targets', async () => {
    addSlackBinding('user:u777');

    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'slack:U777',
        content: 'dm message',
        metadata: {
          to: 'user:U777',
          messageId: '1700000001.200',
          senderId: 'U777',
        },
      },
      {
        channelId: 'slack',
        accountId: 'acct-2',
      },
      buildDeps(),
    );
    expect(hookResult).toBeUndefined();
  });

  it('does not suppress outbound when no talk binding matches', async () => {
    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C404',
        content: 'no owner',
        metadata: {
          to: 'channel:C404',
          messageId: '1700000002.300',
          senderId: 'U404',
        },
      },
      {
        channelId: 'slack',
        accountId: 'acct-3',
      },
      buildDeps(),
    );
    expect(hookResult).toBeUndefined();
  });

  it('ignores non-slack hook events', async () => {
    addSlackBinding('channel:c123');

    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'telegram:group:1',
        content: 'hello telegram',
      },
      {
        channelId: 'telegram',
        accountId: 'acct-4',
      },
      buildDeps(),
    );
    expect(hookResult).toBeUndefined();
  });

  it('exposes ownership inspection details for diagnostics', () => {
    const { talkId, bindingId } = addSlackBindingWithId('channel:c777');
    store.updateTalk(talkId, {
      platformBehaviors: [{
        id: 'behavior-diag',
        platformBindingId: bindingId,
        onMessagePrompt: 'Reply in one line.',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });

    const inspected = inspectSlackOwnership(
      {
        eventId: 'evt-1',
        accountId: 'default',
        channelId: 'C777',
      },
      store,
      mockLogger,
    );
    expect(inspected.decision).toBe('handled');
    expect(inspected.talkId).toBe(talkId);
    expect(inspected.bindingId).toBe(bindingId);
  });

  it('passes when autoRespond is explicitly disabled for a binding', async () => {
    const { talkId, bindingId } = addSlackBindingWithId('channel:c555');
    store.updateTalk(talkId, {
      platformBehaviors: [{
        id: 'behavior-disabled',
        platformBindingId: bindingId,
        autoRespond: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });

    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C555',
        content: 'hello',
        metadata: {
          to: 'channel:C555',
          messageId: '1700000010.100',
          senderId: 'U555',
        },
      },
      {
        channelId: 'slack',
      },
      buildDeps(),
    );
    expect(hookResult).toBeUndefined();
  });

  it('respects study_entries_only trigger policy and skips non-study chatter', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-trigger-policy';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c889',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: 'behavior-trigger-policy',
        platformBindingId: bindingId,
        responseMode: 'all',
        responsePolicy: { triggerPolicy: 'study_entries_only' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });

    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'slack:channel:C889',
        content: 'lol this is random chatter',
        metadata: {
          to: 'channel:C889',
          messageId: '1700000101.100',
          senderId: 'U889',
          senderName: 'Asher',
        },
      },
      {
        channelId: 'slack',
        accountId: 'kimfamily',
      },
      buildDeps(),
    );

    expect(hookResult).toBeUndefined();
  });

  it('mirrors inbound message for delegated channels when mirrorToTalk is inbound', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-mirror-inbound';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c891',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: 'behavior-mirror-inbound',
        platformBindingId: bindingId,
        responseMode: 'all',
        mirrorToTalk: 'inbound',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });
    const deps = buildDeps();

    const event: SlackIngressEvent = {
      eventId: 'test:mirror',
      accountId: 'kimfamily',
      channelId: 'C891',
      userName: 'Kaela',
      text: '1h art project',
    };
    const result = routeSlackIngressEvent(event, deps);
    expect(result.payload.decision).toBe('pass');
    expect(result.payload.reason).toBe('delegated-to-agent');

    // Give async mirror time to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const history = await store.getRecentMessages(talk.id, 50);
    const mirroredEntries = history.filter(m => m.content.includes('[Slack #'));
    expect(mirroredEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('does not mirror when mirrorToTalk is off for delegated channels', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-mirror-off';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        accountId: 'kimfamily',
        scope: 'channel:c890',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: 'behavior-mirror-off',
        platformBindingId: bindingId,
        responseMode: 'all',
        mirrorToTalk: 'off',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });
    const deps = buildDeps();

    const event: SlackIngressEvent = {
      eventId: 'test:nomirror',
      accountId: 'kimfamily',
      channelId: 'C890',
      text: '2h homework',
    };
    routeSlackIngressEvent(event, deps);

    await new Promise(resolve => setTimeout(resolve, 100));

    const history = await store.getRecentMessages(talk.id, 50);
    expect(history).toHaveLength(0);
  });

  it('does not make LLM calls for delegated channels', async () => {
    addSlackBinding('channel:c892');

    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const deps = {
        ...buildDeps(),
        autoProcessQueue: true,
      };

      await handleSlackMessageReceivedHook(
        {
          from: 'slack:channel:C892',
          content: 'please summarize study time',
          metadata: {
            to: 'channel:C892',
            messageId: '1700000104.100',
            senderId: 'U892',
          },
        },
        {
          channelId: 'slack',
          accountId: 'kimfamily',
        },
        deps,
      );

      // No LLM calls should be made for delegated channels
      const llmCalls = fetchSpy.mock.calls.filter(
        call => String(call[0]).includes('/v1/chat/completions'),
      );
      expect(llmCalls).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('does not enqueue delegated events to the processing queue', () => {
    const talk = store.createTalk('test-model');
    const bindingId = 'binding-no-queue';
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        scope: 'channel:c894',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
    });
    const deps = buildDeps();

    const event: SlackIngressEvent = {
      eventId: 'test:noqueue',
      channelId: 'C894',
      text: 'hello',
    };
    const result = routeSlackIngressEvent(event, deps);
    expect(result.payload.decision).toBe('pass');
    expect(result.payload.reason).toBe('delegated-to-agent');

    const runtime = getSlackIngressTalkRuntimeSnapshot(talk.id);
    expect(runtime.counters.passed).toBe(1);
  });

  it('deduplicates delegated events', () => {
    addSlackBinding('channel:c123');
    const deps = buildDeps();

    const event: SlackIngressEvent = {
      eventId: 'test:dup',
      channelId: 'C123',
      text: 'hello',
    };
    const first = routeSlackIngressEvent(event, deps);
    const second = routeSlackIngressEvent(event, deps);
    expect(first.payload.decision).toBe('pass');
    expect(second.payload.decision).toBe('pass');
    expect(second.payload.duplicate).toBe(true);
  });
});
