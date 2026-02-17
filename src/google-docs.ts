import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';

type OAuthTokenFile = {
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  token_uri?: string;
  access_token?: string;
  expiry_date?: number;
};

const DEFAULT_TOKEN_PATH = path.join(homedir(), '.openclaw', 'workspace', 'gdocs_token.json');
const GOOGLE_DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

function resolveTokenPath(): string {
  const fromEnv = process.env.GOOGLE_DOCS_TOKEN_PATH?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_TOKEN_PATH;
}

async function loadTokenRecord(): Promise<{ record: OAuthTokenFile; tokenPath: string }> {
  const tokenPath = resolveTokenPath();
  const raw = await fsp.readFile(tokenPath, 'utf-8');
  const record = JSON.parse(raw) as OAuthTokenFile;
  return { record, tokenPath };
}

async function saveTokenRecord(tokenPath: string, record: OAuthTokenFile): Promise<void> {
  await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
  await fsp.writeFile(tokenPath, JSON.stringify(record, null, 2));
}

async function refreshAccessToken(record: OAuthTokenFile): Promise<{ accessToken: string; expiresIn?: number }> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || record.client_id?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || record.client_secret?.trim();
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim() || record.refresh_token?.trim();
  const tokenUri =
    process.env.GOOGLE_OAUTH_TOKEN_URI?.trim()
    || record.token_uri?.trim()
    || 'https://oauth2.googleapis.com/token';

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Google Docs auth is not configured. Missing client_id/client_secret/refresh_token (env or token file).',
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Google OAuth token refresh failed (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error('Google OAuth token refresh returned no access token.');
  }

  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

async function getAccessToken(): Promise<string> {
  const { record, tokenPath } = await loadTokenRecord();

  const now = Date.now();
  const validAccessToken =
    record.access_token
    && typeof record.expiry_date === 'number'
    && record.expiry_date > now + 60_000;

  if (validAccessToken) return record.access_token as string;

  const refreshed = await refreshAccessToken(record);
  record.access_token = refreshed.accessToken;
  if (typeof refreshed.expiresIn === 'number') {
    record.expiry_date = now + refreshed.expiresIn * 1000;
  }
  await saveTokenRecord(tokenPath, record);
  return refreshed.accessToken;
}

function parseDocumentId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Document ID is required.');
  const fromUrl = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return (fromUrl?.[1] ?? trimmed).trim();
}

async function googleFetchJson(url: string, init: RequestInit): Promise<any> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Google API failed (${res.status}): ${err.slice(0, 300)}`);
  }
  return await res.json();
}

async function getDocumentEndIndex(docId: string): Promise<number> {
  const doc = await googleFetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`,
    { method: 'GET' },
  );
  const content = Array.isArray(doc?.body?.content) ? doc.body.content : [];
  if (content.length === 0) return 1;
  const last = content[content.length - 1];
  const end = typeof last?.endIndex === 'number' ? last.endIndex : 1;
  return Math.max(1, end - 1);
}

function extractDocumentText(doc: any): string {
  const content = Array.isArray(doc?.body?.content) ? doc.body.content : [];
  const parts: string[] = [];

  for (const block of content) {
    const elems = block?.paragraph?.elements;
    if (!Array.isArray(elems)) continue;
    for (const elem of elems) {
      const t = elem?.textRun?.content;
      if (typeof t === 'string') parts.push(t);
    }
  }

  return parts.join('').trim();
}

export async function googleDocsCreate(params: {
  title: string;
  content?: string;
  folderId?: string;
}): Promise<{ documentId: string; url: string; title: string }> {
  const title = params.title.trim();
  if (!title) throw new Error('title is required.');

  const created = await googleFetchJson('https://docs.googleapis.com/v1/documents', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });

  const documentId = String(created?.documentId ?? '');
  if (!documentId) throw new Error('Google Docs create returned no documentId.');

  const content = params.content?.trim();
  if (content) {
    const index = await getDocumentEndIndex(documentId);
    await googleFetchJson(
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                location: { index },
                text: content,
              },
            },
          ],
        }),
      },
    );
  }

  const folderId = params.folderId?.trim();
  if (folderId) {
    const meta = await googleFetchJson(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}?fields=parents`,
      { method: 'GET' },
    );
    const existingParents = Array.isArray(meta?.parents) ? meta.parents.filter((p: unknown): p is string => typeof p === 'string') : [];
    const removeParents = existingParents.join(',');
    const moveUrl = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(documentId)}`);
    moveUrl.searchParams.set('addParents', folderId);
    if (removeParents) moveUrl.searchParams.set('removeParents', removeParents);
    moveUrl.searchParams.set('fields', 'id,parents');
    await googleFetchJson(moveUrl.toString(), { method: 'PATCH' });
  }

  return {
    documentId,
    title,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export async function googleDocsAppend(params: {
  docId: string;
  text: string;
}): Promise<{ documentId: string; appendedChars: number; url: string }> {
  const documentId = parseDocumentId(params.docId);
  const text = params.text ?? '';
  if (!text.trim()) throw new Error('text is required.');

  const index = await getDocumentEndIndex(documentId);
  await googleFetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              location: { index },
              text,
            },
          },
        ],
      }),
    },
  );

  return {
    documentId,
    appendedChars: text.length,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export async function googleDocsRead(params: {
  docId: string;
  maxChars?: number;
}): Promise<{ documentId: string; title: string; text: string; truncated: boolean; url: string }> {
  const documentId = parseDocumentId(params.docId);
  const maxChars = Math.max(500, Math.min(200_000, Number(params.maxChars) || 20_000));

  const doc = await googleFetchJson(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`,
    { method: 'GET' },
  );

  const title = String(doc?.title ?? 'Untitled');
  const fullText = extractDocumentText(doc);
  const truncated = fullText.length > maxChars;
  const text = truncated ? fullText.slice(0, maxChars) : fullText;

  return {
    documentId,
    title,
    text,
    truncated,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
  };
}

export async function googleDocsAuthStatus(): Promise<{
  tokenPath: string;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
  accessTokenReady: boolean;
  error?: string;
}> {
  const tokenPath = resolveTokenPath();
  let record: OAuthTokenFile = {};

  try {
    const loaded = await loadTokenRecord();
    record = loaded.record;
  } catch (err) {
    return {
      tokenPath,
      hasClientId: false,
      hasClientSecret: false,
      hasRefreshToken: false,
      accessTokenReady: false,
      error: `Token file not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || record.client_id?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || record.client_secret?.trim();
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim() || record.refresh_token?.trim();

  try {
    await getAccessToken();
    return {
      tokenPath,
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasRefreshToken: Boolean(refreshToken),
      accessTokenReady: true,
    };
  } catch (err) {
    return {
      tokenPath,
      hasClientId: Boolean(clientId),
      hasClientSecret: Boolean(clientSecret),
      hasRefreshToken: Boolean(refreshToken),
      accessTokenReady: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const GOOGLE_DOCS_REQUIRED_SCOPES = [GOOGLE_DOCS_SCOPE, GOOGLE_DRIVE_SCOPE];

export interface GoogleDocsAuthConfigInput {
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUri?: string;
}

export interface GoogleDocsAuthConfigResult {
  tokenPath: string;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
}

export async function upsertGoogleDocsAuthConfig(
  updates: GoogleDocsAuthConfigInput,
): Promise<GoogleDocsAuthConfigResult> {
  const tokenPath = resolveTokenPath();
  let record: OAuthTokenFile = {};
  try {
    const loaded = await loadTokenRecord();
    record = loaded.record;
  } catch {
    record = {};
  }

  const refreshToken = updates.refreshToken?.trim();
  const clientId = updates.clientId?.trim();
  const clientSecret = updates.clientSecret?.trim();
  const tokenUri = updates.tokenUri?.trim();

  if (refreshToken !== undefined) record.refresh_token = refreshToken;
  if (clientId !== undefined) record.client_id = clientId;
  if (clientSecret !== undefined) record.client_secret = clientSecret;
  if (tokenUri !== undefined) record.token_uri = tokenUri;

  // Force new token exchange on next call when auth settings change.
  if (
    refreshToken !== undefined
    || clientId !== undefined
    || clientSecret !== undefined
    || tokenUri !== undefined
  ) {
    delete record.access_token;
    delete record.expiry_date;
  }

  await saveTokenRecord(tokenPath, record);
  return {
    tokenPath,
    hasClientId: Boolean((process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || record.client_id?.trim())),
    hasClientSecret: Boolean((process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || record.client_secret?.trim())),
    hasRefreshToken: Boolean((process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim() || record.refresh_token?.trim())),
  };
}
