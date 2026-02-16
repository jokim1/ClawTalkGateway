import { randomUUID } from 'node:crypto';
import type { TalkMeta } from '../types';
import { findOpenClawSlackOwnershipConflicts } from '../slack-ownership-doctor';

function makeTalkBinding(params: {
  accountId?: string;
  scope: string;
  permission?: 'read' | 'write' | 'read+write';
}): TalkMeta {
  const now = Date.now();
  return {
    id: randomUUID(),
    pinnedMessageIds: [],
    jobs: [],
    directives: [],
    platformBindings: [
      {
        id: randomUUID(),
        platform: 'slack',
        scope: params.scope,
        accountId: params.accountId,
        permission: params.permission ?? 'read+write',
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

describe('findOpenClawSlackOwnershipConflicts', () => {
  it('detects conflicts when OpenClaw routes same Slack channel to non-ClawTalk agent', () => {
    const talk = makeTalkBinding({
      accountId: 'kimfamily',
      scope: 'channel:C01CL1PU022',
    });
    const openClawConfig = {
      bindings: [
        {
          agentId: 'silent',
          match: {
            channel: 'slack',
            accountId: 'kimfamily',
            peer: { kind: 'channel', id: 'C01CL1PU022' },
          },
        },
      ],
    };

    const conflicts = findOpenClawSlackOwnershipConflicts({
      talks: [talk],
      openClawConfig,
      clawTalkAgentIds: ['mobileclaw', 'clawtalk'],
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      talkId: talk.id,
      talkAccountId: 'kimfamily',
      talkScope: 'channel:c01cl1pu022',
      openClawAgentId: 'silent',
      openClawAccountId: 'kimfamily',
      openClawScope: 'channel:c01cl1pu022',
    });
  });

  it('ignores non-conflicting or ClawTalk-owned OpenClaw bindings', () => {
    const talk = makeTalkBinding({
      accountId: 'kimfamily',
      scope: 'channel:C01CL1PU022',
    });
    const openClawConfig = {
      bindings: [
        {
          agentId: 'mobileclaw',
          match: {
            channel: 'slack',
            accountId: 'kimfamily',
            peer: { kind: 'channel', id: 'C01CL1PU022' },
          },
        },
        {
          agentId: 'silent',
          match: {
            channel: 'slack',
            accountId: 'lilagames',
            peer: { kind: 'channel', id: 'C01MS3YP54K' },
          },
        },
      ],
    };

    const conflicts = findOpenClawSlackOwnershipConflicts({
      talks: [talk],
      openClawConfig,
      clawTalkAgentIds: ['mobileclaw', 'clawtalk'],
    });
    expect(conflicts).toHaveLength(0);
  });
});
