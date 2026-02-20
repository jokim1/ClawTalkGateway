import type { ExecutionMode } from './talk-policy.js';

export type RoutingFlow = 'talk-chat' | 'slack-ingress' | 'job-scheduler';

export type RoutingGuardCode =
  | 'ROUTING_GUARD_FORBIDDEN_AGENT_HEADER'
  | 'ROUTING_GUARD_FORBIDDEN_SESSION_KEY';

export class RoutingGuardError extends Error {
  readonly code: RoutingGuardCode;
  readonly flow: RoutingFlow;
  readonly executionMode: ExecutionMode;

  constructor(params: {
    code: RoutingGuardCode;
    flow: RoutingFlow;
    executionMode: ExecutionMode;
    message: string;
  }) {
    super(params.message);
    this.code = params.code;
    this.flow = params.flow;
    this.executionMode = params.executionMode;
  }
}

function hasValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assertRoutingHeaders(params: {
  flow: RoutingFlow;
  executionMode: ExecutionMode;
  headers: Record<string, string>;
}): void {
  if (params.executionMode !== 'full_control') return;

  if (hasValue(params.headers['x-openclaw-agent-id'])) {
    throw new RoutingGuardError({
      code: 'ROUTING_GUARD_FORBIDDEN_AGENT_HEADER',
      flow: params.flow,
      executionMode: params.executionMode,
      message: `routing_guard_forbidden_agent_header: flow=${params.flow} executionMode=${params.executionMode}`,
    });
  }

  const sessionKey = params.headers['x-openclaw-session-key'];
  if (hasValue(sessionKey) && sessionKey!.trim().startsWith('agent:')) {
    throw new RoutingGuardError({
      code: 'ROUTING_GUARD_FORBIDDEN_SESSION_KEY',
      flow: params.flow,
      executionMode: params.executionMode,
      message: `routing_guard_forbidden_session_key: flow=${params.flow} executionMode=${params.executionMode} (agent-prefixed key not allowed in full_control)`,
    });
  }
}
