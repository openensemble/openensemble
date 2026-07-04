// @ts-check
/**
 * Durable terminal-outcome log for background delegations and workers.
 *
 * background-tasks.mjs keeps terminal outcomes only in two GLOBAL in-memory
 * rings (recentWorkers / recentDelegations, RECENT_CAP=12 entries TOTAL
 * across every user). That means one busy user's flurry of tasks can evict
 * another user's history, and a server restart erases all of it — the #1
 * cause of check_workers reporting "nothing recent" for a task that in fact
 * just finished.
 *
 * This module is a per-user JSONL mirror: one row per TERMINAL outcome
 * (a delegation or a worker finishing, failing, or being stopped), appended
 * at the same retire points that push into the in-memory rings. It is
 * deliberately dumb and best-effort — callers wrap writes in a fire-and-forget
 * `.catch()` so a disk hiccup here can NEVER break task finalization (same
 * philosophy as the report-image extraction guard in background-tasks.mjs).
 *
 * Retention is short (7 days) — this is a "did it finish, and how" bridge
 * across restarts / ring eviction, not a task history feature.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PREVIEW_MAX = 300;

function outcomesPath(userId) {
  return path.join(USERS_DIR, userId, 'task-outcomes.jsonl');
}

/**
 * Append one terminal-outcome row and prune anything past retention.
 * Best-effort: swallows its own errors (still logs a warning) so a caller
 * can fire this without awaiting if it wants zero chance of blocking.
 * @param {string} userId
 * @param {{
 *   taskId: string,
 *   kind: 'delegation'|'worker',
 *   status: 'done'|'error'|'stopped',
 *   agentName?: string,
 *   agentId?: string|null,
 *   ownerKey?: string|null,
 *   summary?: string,
 *   durationMs?: number,
 *   error?: string|null,
 * }} outcome
 */
export async function appendTaskOutcome(userId, outcome) {
  if (!userId || !outcome?.taskId) return;
  const now = Date.now();
  const row = {
    ts: now,
    kind: outcome.kind === 'worker' ? 'worker' : 'delegation',
    taskId: outcome.taskId,
    status: outcome.status === 'done' ? 'done' : (outcome.status === 'stopped' ? 'stopped' : 'error'),
    agentName: outcome.agentName || null,
    // Extra correlation fields beyond the minimal shape — needed so the
    // check_workers-facing readers can filter a durable row by ownerKey
    // (workers) / agentId (delegations) exactly like the in-memory ring does.
    ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
    ...(outcome.ownerKey ? { ownerKey: outcome.ownerKey } : {}),
    summary: String(outcome.summary || '').slice(0, PREVIEW_MAX),
    ...(Number.isFinite(outcome.durationMs) ? { durationMs: outcome.durationMs } : {}),
    ...(outcome.error ? { error: String(outcome.error).slice(0, PREVIEW_MAX) } : {}),
  };
  const line = JSON.stringify(row);
  const p = outcomesPath(userId);
  try {
    await withLock(p, () => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const cutoff = now - RETENTION_MS;
      let kept = [];
      if (fs.existsSync(p)) {
        const fileLines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        for (const ln of fileLines) {
          try {
            const rec = JSON.parse(ln);
            if (rec.ts > cutoff) kept.push(ln);
          } catch { /* drop bad lines */ }
        }
      }
      kept.push(line);
      fs.writeFileSync(p, kept.join('\n') + '\n');
    });
  } catch (e) {
    console.warn('[task-outcomes] append failed:', e.message);
  }
}

/**
 * Load this user's outcome rows within the retention window, newest first.
 * @param {string} userId
 * @param {{kind?: 'delegation'|'worker'|null, limit?: number}} [opts]
 */
export function loadTaskOutcomes(userId, { kind = null, limit = 25 } = {}) {
  if (!userId) return [];
  const p = outcomesPath(userId);
  if (!fs.existsSync(p)) return [];
  try {
    const cutoff = Date.now() - RETENTION_MS;
    const rows = fs.readFileSync(p, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter(r => r.ts > cutoff && (!kind || r.kind === kind));
    rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return limit ? rows.slice(0, limit) : rows;
  } catch { return []; }
}
