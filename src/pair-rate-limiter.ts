/**
 * Rate limiter for the pairing endpoint.
 *
 * Tracks per-IP request counts with a sliding window.
 * Stale entries are cleaned up every 5 minutes.
 */

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function isRateLimited(ip: string, maxAttempts = 5, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    // Prevent unbounded map growth between cleanup cycles
    if (!entry && rateLimitMap.size >= 10_000) return false;
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > maxAttempts;
}

// Cleanup stale entries every 5 minutes
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);
rateLimitCleanup.unref();
