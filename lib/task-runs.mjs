// @ts-check
/**
 * Per-task run history for the scheduler.
 *
 * Mirrors lib/routine-fires.mjs's per-user JSONL + 30-day retention pattern.
 * Where routine-fires answers "did this routine's fast-path get used", this
 * answers "what actually happened the last time this scheduled task tried to
 * run" — including the misfires that used to be invisible:
 *   - a recurring task silently skipped (dow mismatch, weekdays/weekends-only,
 *     access-schedule curfew)
 *   - a one-shot ("remind me in 2 hours") that was armed after its own due
 *     time had already passed (server was down) and fired immediately
 *   - the normal ok/error outcome already surfaced via lastRun/lastError, now
 *     with a queryable history instead of only the latest snapshot
 *
 * Row shape: { ts, taskId, taskName, scheduledFor, firedAt, status, lateByMs?, error?, manual? }
 *   status: 'ok' | 'error' | 'skipped' | 'late'
 *
 * Only called for user-owned tasks (ownerId starting with "user_") — system
 * tasks (owned by the "system" pseudo-owner) live outside any user's
 * directory and have no per-user drawer to read this back from.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function runsPath(userId) {
  return path.join(USERS_DIR, userId, 'task-runs.jsonl');
}

/**
 * @param {string} userId
 * @param {{taskId: string, taskName?: string|null, scheduledFor?: string|number|null,
 *   firedAt?: number, status: 'ok'|'error'|'skipped'|'late', lateByMs?: number,
 *   error?: string, manual?: boolean, runId?: string|null}} row
 */
export async function appendTaskRun(userId, row) {
  const { taskId, taskName = null, scheduledFor = null, firedAt, status, lateByMs, error, manual, runId = null } = row;
  if (!userId || !taskId || !status) return;
  const now = Date.now();
  const line = JSON.stringify({
    ts: now,
    taskId,
    taskName: taskName || null,
    scheduledFor,
    firedAt: firedAt ?? now,
    status,
    ...(runId ? { runId: String(runId).slice(0, 160) } : {}),
    ...(lateByMs != null ? { lateByMs } : {}),
    ...(error ? { error: String(error).slice(0, 500) } : {}),
    ...(manual ? { manual: true } : {}),
  });
  const p = runsPath(userId);
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
      if (runId && kept.some(existing => {
        try {
          const parsed = JSON.parse(existing);
          return parsed.taskId === taskId && parsed.runId === String(runId).slice(0, 160);
        } catch { return false; }
      })) return;
      kept.push(line);
      fs.writeFileSync(p, kept.join('\n') + '\n');
    });
  } catch (e) {
    console.warn('[task-runs] append failed:', e.message);
  }
}

/** All run rows for a user, newest-last (file order). Optionally scoped to one taskId. */
export function loadTaskRuns(userId, taskId = null) {
  if (!userId) return [];
  const p = runsPath(userId);
  if (!fs.existsSync(p)) return [];
  try {
    const rows = fs.readFileSync(p, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return taskId ? rows.filter(r => r.taskId === taskId) : rows;
  } catch { return []; }
}
