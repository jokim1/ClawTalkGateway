import { extractGoogleDocsDocumentIdFromUrl, extractGoogleDocsTabIdFromUrl, hasGoogleDocsDocumentUrl } from '../google-docs-url.js';

describe('google docs URL helpers', () => {
  test('extracts document id from canonical docs URL', () => {
    const url = 'https://docs.google.com/document/d/1wNDevnRe-SbUAj6eNUwb-RJFRenWnUSUS11iKfIr2Eo/edit?usp=sharing';
    expect(extractGoogleDocsDocumentIdFromUrl(url)).toBe('1wNDevnRe-SbUAj6eNUwb-RJFRenWnUSUS11iKfIr2Eo');
    expect(hasGoogleDocsDocumentUrl(url)).toBe(true);
  });

  test('extracts document id from /u/ path variant', () => {
    const url = 'https://docs.google.com/document/u/0/d/abc123_DEF-456/edit';
    expect(extractGoogleDocsDocumentIdFromUrl(url)).toBe('abc123_DEF-456');
  });

  test('does not match non-docs URLs', () => {
    expect(extractGoogleDocsDocumentIdFromUrl('https://example.com/document/d/abc')).toBeUndefined();
    expect(extractGoogleDocsDocumentIdFromUrl('https://docs.google.com/spreadsheets/d/abc')).toBeUndefined();
    expect(hasGoogleDocsDocumentUrl('hello world')).toBe(false);
  });
});

describe('extractGoogleDocsTabIdFromUrl', () => {
  test('extracts tab param from URL with ?tab=t.xxx', () => {
    const url = 'https://docs.google.com/document/d/1abc123/edit?tab=t.0';
    expect(extractGoogleDocsTabIdFromUrl(url)).toBe('t.0');
  });

  test('extracts tab param when not the first query parameter', () => {
    const url = 'https://docs.google.com/document/d/1abc123/edit?usp=sharing&tab=t.12345';
    expect(extractGoogleDocsTabIdFromUrl(url)).toBe('t.12345');
  });

  test('returns undefined when no tab param present', () => {
    const url = 'https://docs.google.com/document/d/1abc123/edit?usp=sharing';
    expect(extractGoogleDocsTabIdFromUrl(url)).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(extractGoogleDocsTabIdFromUrl('')).toBeUndefined();
  });

  test('returns undefined for whitespace-only string', () => {
    expect(extractGoogleDocsTabIdFromUrl('   ')).toBeUndefined();
  });

  test('extracts tab param from URL with fragment after query', () => {
    const url = 'https://docs.google.com/document/d/1abc123/edit?tab=t.99#heading=h.abc';
    expect(extractGoogleDocsTabIdFromUrl(url)).toBe('t.99');
  });

  test('does not extract tab from fragment-only (no query param)', () => {
    const url = 'https://docs.google.com/document/d/1abc123/edit#tab=t.0';
    expect(extractGoogleDocsTabIdFromUrl(url)).toBeUndefined();
  });

  test('handles URL with empty tab parameter', () => {
    const url = 'https://docs.google.com/document/d/1abc123/edit?tab=';
    expect(extractGoogleDocsTabIdFromUrl(url)).toBeUndefined();
  });
});
