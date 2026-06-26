/**
 * Memory viewer API — browse, search, and manage cortex memories.
 *
 * Routes:
 *   GET    /api/memory?q=...&type=...&agent=...  — search or list memories
 *   GET    /api/memory/stats                     — memory statistics
 *   DELETE /api/memory/:id?type=...&agent=...    — soft-delete a memory
 *   POST   /api/memory/cleanup                   — hard-delete soft-forgotten rows
 */

import {
  requireAuth, readBody, safeError,
} from './_helpers.mjs';
import { recall, forget, getMemoryStats, listMemoryRows } from '../memory.mjs';
import { cleanupForgottenForUser } from '../memory/cleanup.mjs';
import { getTable } from '../memory/lance.mjs';
import { assertId, queuedWrite } from '../memory/shared.mjs';
import { embed, scoreSalience } from '../memory/embedding.mjs';

function safeTableName(name) {
  const s = String(name || '');
  if (!/^[a-zA-Z0-9_ -]{1,120}$/.test(s)) throw new Error('Invalid memory table');
  return s;
}

function safeMemoryRow(m) {
  return {
    id: m.id,
    text: m.text,
    category: m.category,
    source: m.source,
    confidence: m.confidence,
    immortal: m.immortal,
    forgotten: m.forgotten,
    salience_composite: m.salience_composite,
    emotional_weight: m.emotional_weight,
    decision_weight: m.decision_weight,
    uniqueness_score: m.uniqueness_score,
    stability: m.stability,
    retention_score: m.retention_score,
    recall_count: m.recall_count,
    created_at: m.created_at,
    last_recalled_at: m.last_recalled_at,
    final_score: m.final_score,
    agent_id: m.agent_id,
    role_scope: m.role_scope,
    host_scope: m.host_scope,
    superseded_by: m.superseded_by,
    table: m._table,
    type: m._memory_type,
    table_agent_id: m._agent_table_id,
  };
}

export async function handle(req, res) {
  // ── GET /api/memory/browse?table=...&limit=... ───────────────────────────
  // Auth-scoped: no userId parameter is accepted. The route always reads only
  // users/{authId}/cortex via listMemoryRows({ userId: authId }).
  if (req.url?.startsWith('/api/memory/browse') && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const url = new URL(req.url, 'http://localhost');
    try {
      const table = url.searchParams.get('table');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '120', 10), 500);
      const includeForgotten = url.searchParams.get('forgotten') === '1';
      const memories = await listMemoryRows({
        userId: authId,
        table: table ? safeTableName(table) : null,
        limit,
        includeForgotten,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(memories.map(safeMemoryRow)));
    } catch (e) { safeError(res, e, 400); }
    return true;
  }

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

  // ── POST /api/memory/cleanup ──────────────────────────────────────────────
  // Hard-delete the calling user's soft-forgotten memories. Body: optional
  // { graceDays: number }. Default 0 = drop everything currently flagged.
  if (req.url?.startsWith('/api/memory/cleanup') && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    let body = '';
    for await (const chunk of req) body += chunk;
    let graceDays = 0;
    if (body) {
      try {
        const j = JSON.parse(body);
        if (typeof j.graceDays === 'number' && j.graceDays >= 0) graceDays = j.graceDays;
      } catch {}
    }
    try {
      const result = await cleanupForgottenForUser(authId, graceDays);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // ── POST /api/memory/:id/pin|unpin ───────────────────────────────────────
  const pinMatch = req.url?.match(/^\/api\/memory\/([^/]+)\/(pin|unpin)$/);
  if (pinMatch && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const memId = decodeURIComponent(pinMatch[1]);
    const action = pinMatch[2];
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const tableName = safeTableName(body.table);
      assertId(memId);
      const table = await getTable(tableName, authId);
      const rows = await table.query().where(`id = '${memId}'`).limit(1).toArray().catch(() => []);
      if (!rows.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Memory not found' }));
        return true;
      }
      const immortal = action === 'pin';
      await queuedWrite(tableName, () => table.update({
        where: `id = '${memId}'`,
        values: {
          immortal,
          stability: immortal ? 999999 : Math.min(rows[0].stability || 72, 72),
          retention_score: immortal ? 1.0 : (rows[0].retention_score || 1.0),
        },
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: memId, immortal }));
    } catch (e) { safeError(res, e, 400); }
    return true;
  }

  // ── PATCH /api/memory/:id/table — exact-table edit with re-embedding ─────
  const tablePatchMatch = req.url?.match(/^\/api\/memory\/([^/]+)\/table$/);
  if (tablePatchMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const memId = decodeURIComponent(tablePatchMatch[1]);
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const tableName = safeTableName(body.table);
      const text = String(body.text ?? '').trim();
      if (text.length < 8) throw new Error('Memory text must be at least 8 characters.');
      if (text.length > 10_000) throw new Error('Memory text is too long.');
      assertId(memId);
      const table = await getTable(tableName, authId);
      const rows = await table.query().where(`id = '${memId}'`).limit(1).toArray().catch(() => []);
      if (!rows.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Memory not found' }));
        return true;
      }
      const vector = await embed(text);
      if (vector.length && vector.every(v => v === 0)) {
        throw new Error('Embedding failed. Check cortex embed model configuration.');
      }
      const current = rows[0];
      const salience = current.immortal
        ? { composite: 1.0, emotional_weight: 1.0, decision_weight: 1.0, uniqueness: 1.0 }
        : await scoreSalience(text, { userId: authId, agentId: current.agent_id || 'main' });
      await queuedWrite(tableName, () => table.update({
        where: `id = '${memId}'`,
        values: {
          text,
          vector,
          source: current.source === 'user_stated' ? current.source : 'user_edited',
          salience_composite: salience.composite,
          emotional_weight: salience.emotional_weight,
          decision_weight: salience.decision_weight,
          uniqueness_score: salience.uniqueness,
          priority: salience.composite,
          enriched: true,
        },
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id: memId }));
    } catch (e) { safeError(res, e, 400); }
    return true;
  }

  // ── DELETE /api/memory/:id/table — exact-table soft delete ───────────────
  // Used by the control panel because browse/search can return shared facts
  // alongside agent memories. This avoids guessing the table from agent/type.
  const tableDeleteUrl = req.url ? new URL(req.url, 'http://localhost') : null;
  const tableDeleteMatch = tableDeleteUrl?.pathname.match(/^\/api\/memory\/([^/]+)\/table$/);
  if (tableDeleteMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const memId = decodeURIComponent(tableDeleteMatch[1]);
    try {
      const tableName = safeTableName(tableDeleteUrl.searchParams.get('table'));
      assertId(memId);
      const table = await getTable(tableName, authId);
      const rows = await table.query().where(`id = '${memId}'`).limit(1).toArray().catch(() => []);
      if (!rows.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Memory not found' }));
        return true;
      }
      if (rows[0].immortal) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Pinned memories must be unpinned before forgetting.' }));
        return true;
      }
      await queuedWrite(tableName, () => table.update({ where: `id = '${memId}'`, values: { forgotten: true } }));
      const verify = await table.query().where(`id = '${memId}'`).limit(1).toArray().catch(() => []);
      if (verify[0] && verify[0].forgotten !== true) {
        throw new Error('Memory update did not persist.');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ forgotten: true, id: memId }));
    } catch (e) { safeError(res, e, 400); }
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
