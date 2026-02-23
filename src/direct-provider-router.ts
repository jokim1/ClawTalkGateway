/**
 * Direct Provider Router
 *
 * Resolves a qualified model ID (e.g. "anthropic/claude-opus-4-6") to a
 * direct provider endpoint for lower latency.
 *
 * Falls back gracefully — returns { ok: false } when the provider is
 * missing, API key unavailable, or model not found in config.
 */

import type { OpenClawConfig, Logger } from './types.js';

export type ApiFormat = 'openai-completions' | 'anthropic-messages';

export interface DirectProviderRoute {
  /** Full endpoint URL (e.g. https://api.openai.com/v1/chat/completions). */
  url: string;
  /** Auth + content-type headers for the provider. */
  headers: Record<string, string>;
  /** Wire format for this provider. */
  apiFormat: ApiFormat;
  /** Model ID without provider prefix (sent to the provider API). */
  providerModelId: string;
  /** Provider key for logging (e.g. "anthropic", "openai"). */
  providerKey: string;
  /** Max output tokens from provider config (required by Anthropic). */
  maxTokens: number;
}

export type DirectRouteResult =
  | { ok: true; data: DirectProviderRoute }
  | { ok: false; error: string };

/**
 * Expand `${ENV_VAR}` references in a string to the environment variable value.
 * Returns undefined if the variable is not set or empty.
 */
function expandEnvVar(raw: string): string | undefined {
  const match = raw.match(/^\$\{(\w+)\}$/);
  if (!match) return raw.trim() || undefined;
  const value = process.env[match[1]];
  return value?.trim() || undefined;
}

export function resolveDirectRoute(
  model: string,
  config: OpenClawConfig,
  logger: Logger,
): DirectRouteResult {
  const slashIdx = model.indexOf('/');
  if (slashIdx <= 0 || slashIdx === model.length - 1) {
    return { ok: false, error: `unqualified model "${model}" (no provider/ prefix)` };
  }

  const providerKey = model.slice(0, slashIdx).toLowerCase();
  const providerModelId = model.slice(slashIdx + 1);

  const providers = config.models?.providers;
  if (!providers) {
    return { ok: false, error: 'no providers configured in openclaw.json' };
  }

  const provider = providers[providerKey] as Record<string, unknown> | undefined;
  if (!provider) {
    return { ok: false, error: `provider "${providerKey}" not found in config` };
  }

  const apiFormat = (provider.api as string | undefined) ?? 'openai-completions';
  if (apiFormat !== 'openai-completions' && apiFormat !== 'anthropic-messages') {
    return { ok: false, error: `unsupported api format "${apiFormat}" for provider "${providerKey}"` };
  }

  // Resolve API key
  const rawApiKey = typeof provider.apiKey === 'string' ? provider.apiKey : '';
  let apiKey = rawApiKey ? expandEnvVar(rawApiKey) : undefined;

  // Anthropic fallback: if no apiKey in provider config, try ANTHROPIC_API_KEY
  if (!apiKey && providerKey === 'anthropic') {
    apiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  }

  if (!apiKey) {
    return { ok: false, error: `no API key resolved for provider "${providerKey}"` };
  }

  // Find model in provider's model list
  const models = Array.isArray(provider.models) ? provider.models as Array<Record<string, unknown>> : [];
  const modelEntry = models.find((m) => m.id === providerModelId);
  if (!modelEntry) {
    return { ok: false, error: `model "${providerModelId}" not in provider "${providerKey}" config` };
  }

  const maxTokens = typeof modelEntry.maxTokens === 'number' ? modelEntry.maxTokens : 4096;
  const baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl.replace(/\/+$/, '') : '';
  if (!baseUrl) {
    return { ok: false, error: `no baseUrl for provider "${providerKey}"` };
  }

  // Build URL and headers based on API format.
  // Handle baseUrl with or without trailing /v1 (e.g. OpenAI uses
  // "https://api.openai.com/v1", Anthropic proxy uses "http://127.0.0.1:18793").
  const hasV1Suffix = /\/v1\/?$/.test(baseUrl);
  let url: string;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (apiFormat === 'anthropic-messages') {
    url = hasV1Suffix ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    url = hasV1Suffix ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  logger.debug(
    `DirectRoute: resolved ${model} → ${providerKey} (${apiFormat}) url=${url} maxTokens=${maxTokens}`,
  );

  return {
    ok: true,
    data: { url, headers, apiFormat, providerModelId, providerKey, maxTokens },
  };
}
