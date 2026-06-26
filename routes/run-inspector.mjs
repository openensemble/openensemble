/**
 * Agent Run Inspector API.
 *
 * Routes:
 *   GET    /api/run-inspector?limit=50
 *   GET    /api/run-inspector/:id
 *   DELETE /api/run-inspector
 */

import { requireAuth, safeError } from './_helpers.mjs';
import { listRunTraces, getRunTrace, clearRunTraces } from '../lib/run-inspector.mjs';

export async function handle(req, res) {
  if (req.url?.startsWith('/api/run-inspector') && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/run-inspector') {
        const traces = listRunTraces(authId, { limit: url.searchParams.get('limit') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ traces }));
        return true;
      }
      const id = decodeURIComponent(url.pathname.replace(/^\/api\/run-inspector\/?/, ''));
      if (!id) return false;
      const trace = getRunTrace(authId, id);
      if (!trace) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Run trace not found' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(trace));
    } catch (e) { safeError(res, e); }
    return true;
  }

  if (req.url === '/api/run-inspector' && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const ok = clearRunTraces(authId);
    res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return true;
  }

  return false;
}
