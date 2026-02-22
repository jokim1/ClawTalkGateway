export const SLACK_DEFAULT_ACCOUNT_ID = 'default';

export function normalizeSlackAccountId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed || undefined;
}

export function resolveTemplateSecret(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const envMatch = trimmed.match(/^\$\{(.+)\}$/);
  if (envMatch?.[1]) {
    const value = process.env[envMatch[1]]?.trim();
    return value || undefined;
  }
  return trimmed;
}

export function listSlackAccountIds(cfg: Record<string, any>): string[] {
  const accounts = cfg?.channels?.slack?.accounts;
  if (!accounts || typeof accounts !== 'object') {
    return [SLACK_DEFAULT_ACCOUNT_ID];
  }
  const ids = Object.keys(accounts).filter(Boolean);
  if (ids.length === 0) return [SLACK_DEFAULT_ACCOUNT_ID];
  if (ids.includes(SLACK_DEFAULT_ACCOUNT_ID)) {
    return [SLACK_DEFAULT_ACCOUNT_ID, ...ids.filter((id) => id !== SLACK_DEFAULT_ACCOUNT_ID).sort()];
  }
  return ids.sort();
}

export function resolveSlackBotTokenForAccount(
  cfg: Record<string, any>,
  accountId: string,
): string | undefined {
  const normalizedAccountId = normalizeSlackAccountId(accountId);
  if (!normalizedAccountId) return undefined;

  const accountToken = resolveTemplateSecret(cfg?.channels?.slack?.accounts?.[normalizedAccountId]?.botToken);
  if (accountToken) return accountToken;

  if (normalizedAccountId === SLACK_DEFAULT_ACCOUNT_ID) {
    const topLevelToken = resolveTemplateSecret(cfg?.channels?.slack?.botToken);
    if (topLevelToken) return topLevelToken;
    const envToken = resolveTemplateSecret(process.env.SLACK_BOT_TOKEN);
    if (envToken) return envToken;
  }

  return undefined;
}

