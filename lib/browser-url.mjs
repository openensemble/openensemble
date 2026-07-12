/** URL minimization shared by one-shot browser context features. */

export function sanitizeBrowserContextUrl(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('browser context URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('browser context URL must use http or https');
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}
