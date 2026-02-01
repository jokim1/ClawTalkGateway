import type { HandlerContext } from './types.js';
import { sendJson } from './http.js';

function detectConfiguredProviders(cfg: Record<string, any>): string[] {
  const providers = new Set<string>();

  const customProviders = cfg.models?.providers ?? {};
  for (const key of Object.keys(customProviders)) {
    providers.add(key.toLowerCase());
  }

  const profiles = cfg.auth?.profiles ?? {};
  for (const [, profile] of Object.entries(profiles)) {
    const p = profile as Record<string, any>;
    if (typeof p?.provider === 'string') {
      providers.add(p.provider.toLowerCase());
    }
  }

  const defaultModel = cfg.agents?.defaults?.model?.primary;
  if (typeof defaultModel === 'string') {
    const slash = defaultModel.indexOf('/');
    if (slash > 0) providers.add(defaultModel.slice(0, slash).toLowerCase());
  }

  const allowedModels = cfg.agents?.defaults?.models ?? {};
  for (const key of Object.keys(allowedModels)) {
    const slash = key.indexOf('/');
    if (slash > 0) providers.add(key.slice(0, slash).toLowerCase());
  }

  const agentList = cfg.agents?.list ?? [];
  for (const agent of agentList) {
    const model = agent?.model;
    if (typeof model === 'string') {
      const slash = model.indexOf('/');
      if (slash > 0) providers.add(model.slice(0, slash).toLowerCase());
    }
  }

  if (process.env.ANTHROPIC_API_KEY) providers.add('anthropic');
  if (process.env.OPENAI_API_KEY) providers.add('openai');
  if (process.env.DEEPSEEK_API_KEY) providers.add('deepseek');
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)
    providers.add('google');

  return Array.from(providers).sort();
}

export async function handleProviders(ctx: HandlerContext): Promise<void> {
  if (ctx.req.method !== 'GET') {
    ctx.res.statusCode = 405;
    ctx.res.setHeader('Allow', 'GET, OPTIONS');
    ctx.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    ctx.res.end('Method Not Allowed');
    return;
  }

  const configuredProviders = detectConfiguredProviders(ctx.cfg);
  const billingOverrides = ctx.pluginCfg.providers ?? {};

  const providers = configuredProviders.map((id) => {
    const override = billingOverrides[id];
    if (override) {
      const billing: Record<string, any> = {
        mode: override.billing ?? 'api',
      };
      if (override.plan) billing.plan = override.plan;
      if (override.monthlyPrice !== undefined)
        billing.monthlyPrice = override.monthlyPrice;
      return { id, billing };
    }
    return { id, billing: { mode: 'api' as const } };
  });

  sendJson(ctx.res, 200, { providers });
}
