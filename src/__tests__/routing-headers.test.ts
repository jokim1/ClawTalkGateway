import { assertRoutingHeaders, RoutingGuardError } from '../routing-headers';

describe('routing header guard', () => {
  it('allows openclaw headers in openclaw mode', () => {
    expect(() => assertRoutingHeaders({
      flow: 'talk-chat',
      executionMode: 'openclaw',
      headers: {
        'x-openclaw-trace-id': 't1',
        'x-openclaw-agent-id': 'agent-1',
        'x-openclaw-session-key': 'agent:agent-1:foo',
      },
    })).not.toThrow();
  });

  it('blocks agent header in full_control mode', () => {
    expect(() => assertRoutingHeaders({
      flow: 'talk-chat',
      executionMode: 'full_control',
      headers: {
        'x-openclaw-trace-id': 't1',
        'x-openclaw-agent-id': 'agent-1',
      },
    })).toThrow(RoutingGuardError);
  });

  it('blocks agent-prefixed session key in full_control mode', () => {
    expect(() => assertRoutingHeaders({
      flow: 'slack-ingress',
      executionMode: 'full_control',
      headers: {
        'x-openclaw-trace-id': 't1',
        'x-openclaw-session-key': 'agent:main:clawtalk:foo',
      },
    })).toThrow(RoutingGuardError);
  });

  it('allows non-agent session key in full_control mode', () => {
    expect(() => assertRoutingHeaders({
      flow: 'slack-ingress',
      executionMode: 'full_control',
      headers: {
        'x-openclaw-trace-id': 't1',
        'x-openclaw-session-key': 'talk:clawtalk:talk:abc:slack:channel:C123:thread:t1',
      },
    })).not.toThrow();
  });
});
