/**
 * File Upload Handler
 *
 * Accepts base64-encoded file data and saves to the server's filesystem.
 * Used by ClawTalk clients to transfer local files to the gateway server
 * so the LLM can access them.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { HandlerContext } from './types.js';
import { sendJson, readJsonBody } from './http.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB decoded
const MAX_BODY_SIZE = 70 * 1024 * 1024; // ~70MB to account for base64 overhead
const DEFAULT_UPLOAD_DIR = join(homedir(), 'Downloads', 'ClawTalk');
const DEFAULT_AGENT_WORKSPACE_DIR = join(homedir(), '.openclaw', 'workspace-clawtalk');
const AGENT_UPLOAD_SUBDIR = 'uploads';

/** Sanitize filename: strip directory traversal, replace unsafe characters. */
function sanitizeFilename(name: string): string {
  // Take only the basename (strip any path components)
  let safe = basename(name);
  // Replace anything that isn't alphanumeric, dash, underscore, or dot
  safe = safe.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Collapse multiple underscores/dots
  safe = safe.replace(/_{2,}/g, '_').replace(/\.{2,}/g, '.');
  // Ensure non-empty
  if (!safe || safe === '.' || safe === '..') safe = 'upload';
  return safe;
}

/** Generate a timestamp prefix: 20260210-214800 */
function timestampPrefix(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export async function handleFileUpload(
  ctx: HandlerContext,
  uploadDir?: string,
): Promise<void> {
  const { req, res, logger } = ctx;

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Method Not Allowed');
    return;
  }

  let body: { filename?: string; base64Data?: string };
  try {
    body = (await readJsonBody(req, MAX_BODY_SIZE)) as {
      filename?: string;
      base64Data?: string;
    };
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body or body too large' });
    return;
  }

  if (!body.filename || typeof body.filename !== 'string') {
    sendJson(res, 400, { error: 'Missing or invalid "filename"' });
    return;
  }
  if (!body.base64Data || typeof body.base64Data !== 'string') {
    sendJson(res, 400, { error: 'Missing or invalid "base64Data"' });
    return;
  }

  // Decode base64
  let fileBuffer: Buffer;
  try {
    fileBuffer = Buffer.from(body.base64Data, 'base64');
  } catch {
    sendJson(res, 400, { error: 'Invalid base64 data' });
    return;
  }

  if (fileBuffer.length > MAX_FILE_SIZE) {
    sendJson(res, 413, {
      error: `File too large (${Math.round(fileBuffer.length / 1024 / 1024)}MB). Max: 50MB`,
    });
    return;
  }

  // Build destination path
  const dir = uploadDir || DEFAULT_UPLOAD_DIR;
  const safeName = sanitizeFilename(body.filename);
  const finalName = `${timestampPrefix()}_${safeName}`;
  const destPath = join(dir, finalName);
  const agentWorkspaceDir = (process.env.CLAWTALK_AGENT_WORKSPACE_DIR || DEFAULT_AGENT_WORKSPACE_DIR).trim() || DEFAULT_AGENT_WORKSPACE_DIR;
  const mirroredHostPath = join(agentWorkspaceDir, AGENT_UPLOAD_SUBDIR, finalName);
  const mirroredAgentPath = `/workspace/${AGENT_UPLOAD_SUBDIR}/${finalName}`;

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(destPath, fileBuffer);
    await mkdir(join(agentWorkspaceDir, AGENT_UPLOAD_SUBDIR), { recursive: true });
    await writeFile(mirroredHostPath, fileBuffer);
  } catch (err) {
    logger.error(`ClawTalk: file upload write failed: ${err}`);
    sendJson(res, 500, { error: 'Failed to save file on server' });
    return;
  }

  logger.info(
    `ClawTalk: file uploaded: ${finalName} (${fileBuffer.length} bytes) `
    + `serverPath=${destPath} workspacePath=${mirroredHostPath} agentPath=${mirroredAgentPath}`,
  );

  sendJson(res, 200, {
    ok: true,
    serverPath: destPath,
    workspacePath: mirroredHostPath,
    agentPath: mirroredAgentPath,
    filename: finalName,
    sizeBytes: fileBuffer.length,
  });
}
