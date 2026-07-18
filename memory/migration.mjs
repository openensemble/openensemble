/**
 * Migration + stats — rarely-touched code that doesn't fit anywhere else.
 */

import path from 'path';
import { assertId, dbPath } from './shared.mjs';
import { BASE_DIR } from '../lib/paths.mjs';
import { getDb, getTable, invalidateDbCache } from './lance.mjs';

export async function getMemoryStats(userId = 'default') {
  try {
    const db = await getDb(userId);
    const tableNames = await db.tableNames();
    let total = 0;
    for (const name of tableNames) {
      try {
        const t = await getTable(name, userId);
        total += await t.countRows("forgotten = false AND id != '_init'");
      } catch (e) { console.warn('[cortex] Failed to count rows in', name + ':', e.message); }
    }
    return total;
  } catch (e) { console.warn('[cortex] getMemoryStats failed:', e.message); return 0; }
}

export async function listMemoryRows({ userId = 'default', table = null, limit = 100, includeForgotten = false } = {}) {
  const db = await getDb(userId);
  const tableNames = table ? [table] : await db.tableNames();
  const rows = [];
  const max = Math.max(1, Math.min(Number(limit) || 100, 500));
  for (const name of tableNames) {
    if (!/^[a-zA-Z0-9_ -]+$/.test(name)) continue;
    try {
      const t = await getTable(name, userId);
      const seedId = `_init_${name}`.replace(/'/g, "''");
      const where = includeForgotten
        ? `id != '_init' AND id != '${seedId}'`
        : `forgotten = false AND id != '_init' AND id != '${seedId}'`;
      const got = await t.query().where(where).limit(max).toArray();
      for (const m of got) rows.push({ ...m, _table: name, _memory_type: tableType(name), _agent_table_id: tableAgentId(name) });
    } catch (e) {
      console.warn('[cortex] Failed to list rows in', name + ':', e.message);
    }
  }
  const byRecency = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
  // Curated, low-volume memories — pinned (immortal) rows and shared user_facts —
  // must never be evicted by the recency cap. Otherwise high-churn episode tables
  // (chat history) crowd them out and the control panel shows only a fraction of
  // the user's pinned/shared facts. Keep all of those, then fill the remaining
  // budget with the most-recent of everything else.
  const keep = rows.filter(m => m.immortal || m._table === 'user_facts');
  const rest = rows.filter(m => !(m.immortal || m._table === 'user_facts')).sort(byRecency);
  const room = Math.max(0, max - keep.length);
  return [...keep, ...rest.slice(0, room)].sort(byRecency);
}

function tableType(name) {
  if (name === 'user_facts') return 'user_facts';
  const m = String(name).match(/^(.*)_(episodes|params)$/);
  return m ? m[2] : 'unknown';
}

function tableAgentId(name) {
  if (name === 'user_facts') return 'shared';
  const m = String(name).match(/^(.*)_(episodes|params)$/);
  return m ? m[1] : '';
}

/** Copy legacy shared cortex-lancedb to a per-user directory. */
export async function migrateSharedCortexToUser(userId) {
  const { cpSync, existsSync } = await import('fs');
  const legacyPath = path.join(BASE_DIR, 'cortex-lancedb');
  const userPath   = dbPath(userId);
  if (!existsSync(legacyPath)) return { skipped: true, reason: 'No legacy cortex data' };
  if (existsSync(userPath)) return { skipped: true, reason: 'User cortex already exists' };
  try {
    cpSync(legacyPath, userPath, { recursive: true });
    // Invalidate any cached DB connection for this user so it re-opens the new path
    invalidateDbCache(userId);
    return { migrated: true };
  } catch (e) {
    return { skipped: true, reason: e.message };
  }
}

// assertId kept importable for compatibility — not used here.
export { assertId };
