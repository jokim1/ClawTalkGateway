/**
 * GET /api/providers
 *
 * Returns billing mode per configured provider so the client can
 * show the correct pricing model (API per-token vs subscription plan).
 */

import type { PluginConfig, OutgoingResponse } from '../types.js';

export function handleProviders(config: PluginConfig, res: OutgoingResponse): void {
  const providers = Object.entries(config.providers ?? {}).map(([id, p]) => ({
    id,
    billing: {
      mode: p.billing,
      ...(p.plan && { plan: p.plan }),
      ...(p.monthlyPrice !== undefined && { monthlyPrice: p.monthlyPrice }),
    },
  }));

  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify({ providers }));
}
