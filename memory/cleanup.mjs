/**
 * Hard-delete soft-forgotten memories.
 *
 * `forget_fact` / `forgetByText` / the salience-GC path all flip a `forgotten`
 * boolean — the row stays on disk so the user can recover from accidental
 * forgets. This module does the actual disk reclamation: rows older than
 * `graceDays` after their soft-forget time are dropped from each table.
 *
 *   cleanupForgottenForUser(userId, graceDays = 30)
 *   cleanupAllUsers(graceDays = 30)
 *
 * Both return per-table delete counts for logging.
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import { getTable } from './lance.mjs';
import { queuedWrite } from './shared.mjs';

const SAFETY_FLOOR_DAYS = 0; // graceDays = 0 means "delete every forgotten row right now"

function listUserIds() {
  if (!fs.existsSync(USERS_DIR)) return [];
  return fs.readdirSync(USERS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(USERS_DIR, d.name, 'cortex')))
    .map(d => d.name);
}

function listTableNames(userId) {
  const cortexDir = path.join(USERS_DIR, userId, 'cortex');
  if (!fs.existsSync(cortexDir)) return [];
  return fs.readdirSync(cortexDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.endsWith('.lance'))
    .map(d => d.name.slice(0, -'.lance'.length));
}

export async function cleanupForgottenForUser(userId, graceDays = 30) {
  const days = Math.max(SAFETY_FLOOR_DAYS, Number(graceDays) || 0);
  const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const tableNames = listTableNames(userId);
  if (!tableNames.length) return { userId, deleted: {}, totalDeleted: 0 };

  const deleted = {};
  let total = 0;

  for (const name of tableNames) {
    let table;
    try { table = await getTable(name, userId); }
    catch (e) { console.debug('[cortex-cleanup] skip', userId, name, e.message); continue; }

    let before = -1;
    try { before = await table.countRows(); } catch {}

    // The forgotten_at migration stamps legacy forgotten rows at migration
    // time, giving them a full recovery window regardless of row creation age.
    const seedId = `_init_${name}`.replace(/'/g, "''");
    const filter = `forgotten = true AND forgotten_at != '' AND id != '_init' AND id != '${seedId}' AND forgotten_at < '${cutoff}'`;
    try {
      await queuedWrite(name, () => table.delete(filter), userId);
    } catch (e) {
      console.warn('[cortex-cleanup] delete failed for', userId, name + ':', e.message);
      continue;
    }

    let after = -1;
    try { after = await table.countRows(); } catch {}
    const dropped = (before >= 0 && after >= 0) ? Math.max(0, before - after) : 0;
    if (dropped > 0) {
      deleted[name] = dropped;
      total += dropped;
    }
  }

  if (total > 0) {
    console.log(`[cortex-cleanup] userId=${userId} dropped ${total} forgotten row(s) older than ${days}d:`, deleted);
  }
  return { userId, deleted, totalDeleted: total, graceDays: days };
}

export async function cleanupAllUsers(graceDays = 30) {
  const userIds = listUserIds();
  const results = [];
  for (const userId of userIds) {
    try {
      results.push(await cleanupForgottenForUser(userId, graceDays));
    } catch (e) {
      console.warn('[cortex-cleanup] sweep failed for', userId + ':', e.message);
    }
  }
  const totalDeleted = results.reduce((sum, r) => sum + (r?.totalDeleted ?? 0), 0);
  if (totalDeleted > 0) {
    console.log(`[cortex-cleanup] sweep complete: ${totalDeleted} row(s) dropped across ${userIds.length} user(s)`);
  }
  return { users: userIds.length, totalDeleted, results };
}
