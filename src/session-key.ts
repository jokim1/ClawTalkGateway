/**
 * Session Key Builders
 *
 * Shared session key construction for Talk chat and job scheduler.
 * Session key prefix determines OpenClaw routing behavior:
 *   - `talk:` → legacy/alias, bypasses embedded agent (used for chat)
 *   - `job:` → transparent LLM-proxy mode (gateway tools forwarded)
 */

export function sanitizeSessionPart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 96);
}

export function buildTalkSessionKey(talkId: string, lanePart?: string): string {
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
