/**
 * GET /api/rate-limits?provider={provider}
 *
 * Returns current rate-limit state. The cache is populated by the
 * rate-limit capture proxy (separate from this handler).
 */

import type { OutgoingResponse } from '../types.js';

interface RateLimitWindow {
  used: number;
  limit: number;
  resetsAt: string;
}

interface ProviderRateLimits {
  provider: string;
  session?: RateLimitWindow;
  weekly?: RateLimitWindow;
}

export class RateLimitCache {
  private cache: Map<string, ProviderRateLimits> = new Map();

  update(provider: string, data: Omit<ProviderRateLimits, 'provider'>): void {
    this.cache.set(provider, { provider, ...data });
  }

  get(provider: string): ProviderRateLimits | undefined {
    return this.cache.get(provider);
  }

  getAll(): ProviderRateLimits[] {
    return Array.from(this.cache.values());
  }
}

export function handleRateLimits(
  cache: RateLimitCache,
  provider: string | undefined,
  res: OutgoingResponse,
): void {
  res.setHeader('Content-Type', 'application/json');

  if (provider) {
    const data = cache.get(provider);
    if (data) {
      res.statusCode = 200;
      res.end(JSON.stringify(data));
    } else {
      res.statusCode = 200;
      res.end(JSON.stringify({}));
    }
  } else {
    res.statusCode = 200;
    res.end(JSON.stringify(cache.getAll()));
  }
}
