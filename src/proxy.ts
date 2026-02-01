import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import type { CachedRateLimitData, Logger } from './types.js';

// ---------------------------------------------------------------------------
// In-memory rate-limit cache (singleton across plugin reloads)
// ---------------------------------------------------------------------------

const store = new Map<string, CachedRateLimitData>();

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const UPSTREAM_DEFAULT = 'https://api.anthropic.com';

// Singleton guard — prevent double-binding on plugin hot-reload
let activeServer: http.Server | null = null;

// ---------------------------------------------------------------------------
// Header parsing (Anthropic unified rate-limit format)
// ---------------------------------------------------------------------------

function parseAnthropicHeaders(
  headers: http.IncomingHttpHeaders,
): CachedRateLimitData | null {
  const status = headers['anthropic-ratelimit-unified-status'] as string | undefined;
  if (!status) return null;

  const now = Date.now();
  const data: CachedRateLimitData = {
    provider: 'anthropic',
    status,
    lastUpdated: now,
  };

  // 5-hour window
  const fiveHUtil = Number(headers['anthropic-ratelimit-unified-5h-utilization']);
  const fiveHReset = Number(headers['anthropic-ratelimit-unified-5h-reset']);
  const fiveHStatus = headers['anthropic-ratelimit-unified-5h-status'] as string | undefined;
  if (!isNaN(fiveHUtil) && fiveHStatus) {
    data.fiveHour = {
      utilization: fiveHUtil,
      resetsAt: fiveHReset || 0,
      status: fiveHStatus,
    };
  }

  // 7-day window
  const sevenDUtil = Number(headers['anthropic-ratelimit-unified-7d-utilization']);
  const sevenDReset = Number(headers['anthropic-ratelimit-unified-7d-reset']);
  const sevenDStatus = headers['anthropic-ratelimit-unified-7d-status'] as string | undefined;
  if (!isNaN(sevenDUtil) && sevenDStatus) {
    data.sevenDay = {
      utilization: sevenDUtil,
      resetsAt: sevenDReset || 0,
      status: sevenDStatus,
    };
  }

  return data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getProxyCachedLimits(provider: string): CachedRateLimitData | null {
  return store.get(provider.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Proxy server
// ---------------------------------------------------------------------------

export function startProxy(
  port: number,
  logger: Logger,
): { server: http.Server; close: () => Promise<void> } {
  // If already running (plugin hot-reload), return existing server
  if (activeServer?.listening) {
    logger.debug(`RemoteClaw: proxy already running on 127.0.0.1:${port}`);
    return {
      server: activeServer,
      close: () => new Promise((resolve) => { activeServer?.close(() => resolve()); }),
    };
  }

  const server = http.createServer((req, res) => {
    const upstream = new URL(req.url ?? '/', UPSTREAM_DEFAULT);
    upstream.protocol = 'https:';
    upstream.hostname = new URL(UPSTREAM_DEFAULT).hostname;
    upstream.port = '';

    // Build upstream headers — copy all except hop-by-hop
    const forwardHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      if (key.toLowerCase() === 'host') {
        forwardHeaders[key] = new URL(UPSTREAM_DEFAULT).host;
        continue;
      }
      if (value !== undefined) {
        forwardHeaders[key] = value as string | string[];
      }
    }

    const upstreamReq = https.request(
      upstream.href,
      {
        method: req.method,
        headers: forwardHeaders,
      },
      (upstreamRes) => {
        // Capture rate-limit headers
        const parsed = parseAnthropicHeaders(upstreamRes.headers);
        if (parsed) {
          store.set('anthropic', parsed);
          logger.debug(
            `RemoteClaw proxy: captured — 5h: ${parsed.fiveHour ? `${Math.round(parsed.fiveHour.utilization * 100)}%` : 'n/a'}, 7d: ${parsed.sevenDay ? `${Math.round(parsed.sevenDay.utilization * 100)}%` : 'n/a'}`,
          );
        }

        // Forward response headers — skip hop-by-hop
        const responseHeaders: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (HOP_BY_HOP.has(key.toLowerCase())) continue;
          if (value !== undefined) {
            responseHeaders[key] = value;
          }
        }

        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
      },
    );

    upstreamReq.on('error', (err) => {
      logger.error(`RemoteClaw proxy: upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end('Bad Gateway');
    });

    req.pipe(upstreamReq);
  });

  activeServer = server;

  let retries = 0;
  const maxRetries = 5;
  const retryDelay = 1000;
  let started = false;

  function tryListen() {
    server.listen(port, '127.0.0.1', () => {
      if (!started) {
        started = true;
        logger.info(`RemoteClaw: proxy started on 127.0.0.1:${port}`);
      }
    });
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && retries < maxRetries) {
      retries++;
      logger.info(`RemoteClaw: port ${port} busy, retrying (${retries}/${maxRetries})...`);
      setTimeout(tryListen, retryDelay);
    } else {
      logger.error(`RemoteClaw: proxy server error: ${err.message}`);
    }
  });

  tryListen();

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      activeServer = null;
      server.close(() => resolve());
    });

  return { server, close };
}
