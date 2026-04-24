/**
 * Migration + stats — rarely-touched code that doesn't fit anywhere else.
 */

import path from 'path';
import { assertId, dbPath } from './shared.mjs';
import { BASE_DIR } from '../lib/paths.mjs';
import { getDb, invalidateDbCache } from './lance.mjs';

export async function getMemoryStats(userId = 'default') {
  try {
    const db = await getDb(userId);
    const tableNames = await db.tableNames();
    let total = 0;
    for (const name of tableNames) {
      try {
        const t = await db.openTable(name);
        total += await t.countRows("forgotten = false AND id != '_init'");
      } catch (e) { console.warn('[cortex] Failed to count rows in', name + ':', e.message); }
    }
    return total;
  } catch (e) { console.warn('[cortex] getMemoryStats failed:', e.message); return 0; }
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
