import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __resetSlackIngressStateForTests,
  handleSlackMessageReceivedHook,
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
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'slack-tool-block-test-'));
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
  const talk = store.createTalk('test-model');
  store.updateTalk(talk.id, {
    platformBindings: [{
      id: `binding-${Date.now()}`,
      platform: 'slack',
      scope,
      permission: 'read+write',
      createdAt: Date.now(),
    }],
  });
  return talk.id;
}

describe('delegated channel routing', () => {
  it('returns pass with delegated-to-agent reason for Talk-bound channels', () => {
    const talkId = addSlackBinding('channel:C123');
    const deps = buildDeps();

    const event: SlackIngressEvent = {
      eventId: 'test:1',
      channelId: 'C123',
      text: 'hello',
    };
    const result = routeSlackIngressEvent(event, deps);
    expect(result.payload.decision).toBe('pass');
    expect(result.payload.reason).toBe('delegated-to-agent');
    expect(result.payload.talkId).toBe(talkId);
  });

  it('deduplicates delegated events', () => {
    addSlackBinding('channel:C123');
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

  it('mirrors inbound message when mirrorToTalk is set', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = `binding-${Date.now()}`;
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        scope: 'channel:C456',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: `behavior-${Date.now()}`,
        platformBindingId: bindingId,
        mirrorToTalk: 'inbound',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });
    const deps = buildDeps();

    const event: SlackIngressEvent = {
      eventId: 'test:mirror',
      channelId: 'C456',
      userName: 'alice',
      text: 'study update: 30 minutes',
    };
    routeSlackIngressEvent(event, deps);

    // Give async mirror time to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    const messages = await store.getRecentMessages(talk.id, 10);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('study update');
  });

  it('does not mirror when mirrorToTalk is off', async () => {
    const talk = store.createTalk('test-model');
    const bindingId = `binding-${Date.now()}`;
    store.updateTalk(talk.id, {
      platformBindings: [{
        id: bindingId,
        platform: 'slack',
        scope: 'channel:C789',
        permission: 'read+write',
        createdAt: Date.now(),
      }],
      platformBehaviors: [{
        id: `behavior-${Date.now()}`,
        platformBindingId: bindingId,
        mirrorToTalk: 'off',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    });
    const deps = buildDeps();

    const event: SlackIngressEvent = {
      eventId: 'test:nomirror',
      channelId: 'C789',
      text: 'hello',
    };
    routeSlackIngressEvent(event, deps);

    await new Promise(resolve => setTimeout(resolve, 50));

    const messages = await store.getRecentMessages(talk.id, 10);
    expect(messages.length).toBe(0);
  });

  it('passes events for unbound channels', () => {
    addSlackBinding('channel:C123');
    const deps = buildDeps();

    const event: SlackIngressEvent = {
      eventId: 'test:unbound',
      channelId: 'C999',
      text: 'hello',
    };
    const result = routeSlackIngressEvent(event, deps);
    expect(result.payload.decision).toBe('pass');
    expect(result.payload.reason).toBe('no-binding');
  });

  it('delegates via message_received hook path', async () => {
    addSlackBinding('channel:C100');
    const deps = buildDeps();

    const hookResult = await handleSlackMessageReceivedHook(
      {
        from: 'slack:default:U999',
        content: 'hello world',
        metadata: {
          to: 'slack:channel:C100',
        },
      },
      { channelId: 'slack', conversationId: 'slack:channel:C100' },
      deps,
    );
    // Delegated channels return undefined (pass) so OpenClaw processes normally
    expect(hookResult).toBeUndefined();
  });
});
