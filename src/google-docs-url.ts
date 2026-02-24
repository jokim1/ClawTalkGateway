const GOOGLE_DOCS_URL_RE = /https?:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/i;

export function extractGoogleDocsDocumentIdFromUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(GOOGLE_DOCS_URL_RE);
  return match?.[1];
}

export function hasGoogleDocsDocumentUrl(value: string): boolean {
  return Boolean(extractGoogleDocsDocumentIdFromUrl(value));
}

export function extractGoogleDocsTabIdFromUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    const tab = url.searchParams.get('tab');
    return tab?.trim() || undefined;
  } catch {
    // Not a valid URL — try regex fallback for partial URLs
    const match = trimmed.match(/[?&]tab=([^&#\s]+)/);
    return match?.[1]?.trim() || undefined;
  }
}
