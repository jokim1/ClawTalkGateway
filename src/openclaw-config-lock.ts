import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from './types.js';

// Async mutex — promise-chain, no external deps.
// Every caller awaits the previous holder before running.
let _lock: Promise<void> = Promise.resolve();

export function withOpenClawConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = _lock;
  let release!: () => void;
  _lock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release());
}

function resolveConfigPath(): string | null {
  const home = process.env.HOME?.trim();
  if (!home) return null;
  return path.join(home, '.openclaw', 'openclaw.json');
}

/**
 * Serialize a read→patch→write cycle on openclaw.json through the shared lock.
 *
 * `patch` receives the parsed config object and mutates it in place.
 * Return `true` if any field was changed, `false` to skip the write.
 */
export async function patchOpenClawConfig(
  patch: (cfg: Record<string, unknown>) => boolean,
  logger: Logger,
): Promise<boolean> {
  return withOpenClawConfigLock(async () => {
    const configPath = resolveConfigPath();
    if (!configPath) return false;

    let raw: string;
    try {
      raw = await fs.readFile(configPath, 'utf-8');
    } catch {
      return false;
    }

    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return false;
    }

    const changed = patch(cfg);
    if (!changed) return false;

    const next = `${JSON.stringify(cfg, null, 2)}\n`;
    if (next === raw) return false;

    const tmp = `${configPath}.tmp.${Date.now()}.${randomUUID()}`;
    try {
      await fs.writeFile(tmp, next, 'utf-8');
      await fs.rename(tmp, configPath);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* best-effort cleanup */ }
      logger.warn(`patchOpenClawConfig: write failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    return true;
  });
}
