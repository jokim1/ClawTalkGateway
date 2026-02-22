/**
 * Session Key Builders
 *
 * Shared session key construction for Talk chat and job scheduler.
 * Session key prefix determines OpenClaw routing behavior:
 *   - `agent:<id>:` → embedded agent mode (agent's own tool set)
 *   - `job:` → transparent LLM-proxy mode (gateway tools forwarded)
 *   - `talk:` (no agent: prefix) → legacy/alias, bypasses embedded agent
 */

export const CLAWTALK_DEFAULT_AGENT_ID = 'clawtalk';

export function sanitizeSessionPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 96);
}

export function buildTalkSessionKey(talkId: string, agentPart: string, lanePart?: string): string {
  const talk = sanitizeSessionPart(talkId) || 'talk';
  const agent = sanitizeSessionPart(agentPart) || CLAWTALK_DEFAULT_AGENT_ID;
  const lane = lanePart ? sanitizeSessionPart(lanePart) : '';
  return lane
    ? `agent:${agent}:clawtalk:talk:${talk}:chat:lane:${lane}`
    : `agent:${agent}:clawtalk:talk:${talk}:chat`;
}

export function buildFullControlTalkSessionKey(talkId: string, lanePart?: string): string {
  const talk = sanitizeSessionPart(talkId) || 'talk';
  const lane = lanePart ? sanitizeSessionPart(lanePart) : '';
  return lane
    ? `talk:clawtalk:talk:${talk}:chat:lane:${lane}`
    : `talk:clawtalk:talk:${talk}:chat`;
}

export function buildTalkJobSessionKey(talkId: string, jobId: string): string {
  const talk = sanitizeSessionPart(talkId) || 'talk';
  const job = sanitizeSessionPart(jobId) || 'job';
  return `job:clawtalk:talk:${talk}:job:${job}`;
}
