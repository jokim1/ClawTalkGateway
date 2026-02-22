/**
 * Gateway Origin Resolution
 *
 * Detects Tailscale FQDN/IP and resolves the gateway's self-call origin
 * for internal requests (scheduler, event dispatcher, Slack ingress).
 */

import { execSync } from 'node:child_process';
import type { Logger } from './types.js';
import { DEFAULT_GATEWAY_PORT } from './constants.js';

let _cachedFunnelUrl: string | null | undefined; // undefined = not yet checked

export function detectTailscaleFunnelUrl(log: Logger): string | null {
  if (_cachedFunnelUrl !== undefined) return _cachedFunnelUrl;

  try {
    const output = execSync('tailscale status --json', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const status = JSON.parse(output);
    const dnsName: string | undefined = status?.Self?.DNSName;
    if (dnsName) {
      // DNSName has a trailing dot (e.g. "host.tailnet.ts.net.") — strip it
      const hostname = dnsName.replace(/\.$/, '');
      if (hostname.includes('.')) {
        const url = `https://${hostname}`;
        log.info(`ClawTalk: detected Tailscale hostname: ${url}`);
        _cachedFunnelUrl = url;
        return url;
      }
    }
    log.info('ClawTalk: no Tailscale DNS name found');
  } catch (err) {
    log.info(`ClawTalk: Tailscale detection failed: ${err}`);
  }

  _cachedFunnelUrl = null;
  return null;
}

/**
 * Resolve the gateway's self-origin for internal calls (scheduler, dispatcher).
 * Reads gateway.bind and gateway.port from config. If bind is "tailnet",
 * resolves the Tailscale IPv4 via `tailscale status --json`.
 */
export function resolveGatewayOrigin(cfg: Record<string, any>, log: Logger): string {
  const port = cfg?.gateway?.port ?? DEFAULT_GATEWAY_PORT;
  const bind = cfg?.gateway?.bind;

  if (bind === 'tailnet' || bind === 'tailscale') {
    try {
      const output = execSync('tailscale ip -4', {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const ip = output.trim();
      if (ip) {
        const origin = `http://${ip}:${port}`;
        log.info(`ClawTalk: resolved gateway origin: ${origin}`);
        return origin;
      }
    } catch {
      // fall through to default
    }
  }

  // "loopback" is a symbolic name used by OpenClaw when Tailscale Serve proxies
  // HTTPS traffic to a localhost-bound gateway.
  if (bind && bind !== 'tailnet' && bind !== 'tailscale' && bind !== 'loopback' && bind !== '0.0.0.0') {
    return `http://${bind}:${port}`;
  }

  return `http://127.0.0.1:${port}`;
}

export function resolveClawTalkAgentIds(cfg: Record<string, any>): string[] {
  const ids = new Set<string>(['mobileclaw', 'clawtalk']);
  const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  for (const entry of agents) {
    if (!entry || typeof entry !== 'object') continue;
    const agent = entry as Record<string, unknown>;
    const id = typeof agent.id === 'string' ? agent.id.trim() : '';
    const name = typeof agent.name === 'string' ? agent.name.trim().toLowerCase() : '';
    if (!id) continue;
    // Include managed agents (ct-*) and any agent with 'clawtalk' in name/id
    if (id.startsWith('ct-') || name.includes('clawtalk') || id.toLowerCase().includes('clawtalk')) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}

/**
 * Resolve the gateway's self-origin from the incoming request's socket,
 * which correctly handles bind-to-specific-IP scenarios (e.g. Tailscale).
 */
export function resolveSelfOrigin(req: import('node:http').IncomingMessage): string {
  const selfAddr = req.socket?.localAddress ?? '127.0.0.1';
  const selfPort = req.socket?.localPort ?? DEFAULT_GATEWAY_PORT;
  return `http://${selfAddr}:${selfPort}`;
}
