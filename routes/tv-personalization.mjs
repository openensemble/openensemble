import { requireAuth } from './_helpers.mjs';

// Keep an explicit retirement response so an older TV cannot re-enable learning.
export async function handleTvPersonalization(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/api/tv/recommendations' && pathname !== '/api/tv/personalization'
      && !pathname.startsWith('/api/tv/personalization/')) return false;
  if (!requireAuth(req, res)) return true;
  const notice = 'TV playback reporting and history-based recommendations have been removed.';
  const status = req.method === 'GET' && pathname === '/api/tv/personalization';
  res.writeHead(status ? 200 : 410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(status
    ? { available: false, enabled: false, epoch: null, history_count: 0, notice }
    : { available: false, enabled: false, error: notice }));
  return true;
}
