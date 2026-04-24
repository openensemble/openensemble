/**
 * Memory viewer API — browse, search, and manage cortex memories.
 *
 * Routes:
 *   GET    /api/memory?q=...&type=...&agent=...  — search or list memories
 *   GET    /api/memory/stats                     — memory statistics
 *   DELETE /api/memory/:id?type=...&agent=...    — soft-delete a memory
 */

import {
  requireAuth, getAuthToken, getSessionUserId, safeError,
} from './_helpers.mjs';
import { recall, forget, getMemoryStats } from '../memory.mjs';

export async function handle(req, res) {
  // ── GET /api/memory/stats ─────────────────────────────────────────────────
  if (req.url === '/api/memory/stats' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const stats = await getMemoryStats(authId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // ── GET /api/memory?q=...&type=...&agent=... ─────────────────────────────
  if (req.url?.startsWith('/api/memory') && req.method === 'GET' && !req.url.includes('/stats')) {
    const authId = requireAuth(req, res); if (!authId) return true;
    const url = new URL(req.url, 'http://localhost');

    // Don't match /api/memory/:id (DELETE path)
    if (url.pathname !== '/api/memory') return false;

    const query = url.searchParams.get('q') || 'recent memories';
    const type = url.searchParams.get('type') || 'episodes';
    const agentId = url.searchParams.get('agent') || 'main';
    const topK = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);

    try {
      const memories = await recall({
        agentId,
        type,
        query,
        topK,
        includeShared: true,
        userId: authId,
      });

      const safe = memories.map(m => ({
        id: m.id,
        text: m.text,
        category: m.category,
        source: m.source,
        confidence: m.confidence,
        immortal: m.immortal,
        forgotten: m.forgotten,
        salience_composite: m.salience_composite,
        stability: m.stability,
        retention_score: m.retention_score,
        recall_count: m.recall_count,
        created_at: m.created_at,
        last_recalled_at: m.last_recalled_at,
        final_score: m.final_score,
        agent_id: m.agent_id,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(safe));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // ── DELETE /api/memory/:id ────────────────────────────────────────────────
  const deleteMatch = req.url?.match(/^\/api\/memory\/([^?]+)/);
  if (deleteMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const memId = decodeURIComponent(deleteMatch[1]);
    const url = new URL(req.url, 'http://localhost');
    const type = url.searchParams.get('type') || 'episodes';
    const agentId = url.searchParams.get('agent') || 'main';

    try {
      const result = await forget({ agentId, type, exactId: memId, userId: authId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) { safeError(res, e, 400); }
    return true;
  }

  return false;
}
