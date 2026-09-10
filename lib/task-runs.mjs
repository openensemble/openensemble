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
 * Rows retain the task identity, outcome, bounded output, and attempt count
 * even after a one-time task is removed.
 *   status: 'ok' | 'error' | 'warning' | 'skipped' | 'late'
 *
 * Only called for user-owned tasks (ownerId starting with "user_") — system
 * tasks (owned by the "system" pseudo-owner) live outside any user's
 * directory and have no per-user drawer to read this back from.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock, atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { signalWorkEvent } from './personalization/work-events.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function runsPath(userId) {
  if (!/^user_[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('Invalid task history owner');
  return path.join(USERS_DIR, userId, 'task-runs.jsonl');
}

/**
 * @param {string} userId
 * @param {{taskId: string, taskName?: string|null, scheduledFor?: string|number|null,
 *   firedAt?: number, status: 'ok'|'error'|'warning'|'skipped'|'late', lateByMs?: number,
 *   error?: string, manual?: boolean, runId?: string|null, projectId?: string|null,
 *   output?: any, agent?: string|null, repeat?: string|null, timezone?: string|null,
 *   attempts?: number|null, errorCode?: string|null, durationMs?: number}} row
 */
export async function appendTaskRun(userId, row) {
  const { taskId, taskName = null, scheduledFor = null, firedAt, status, lateByMs, error, manual, runId = null } = row;
  if (!userId || !taskId || !status) return;
  const now = Date.now();
  const line = JSON.stringify({
    ts: now,
    taskId,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    taskName: taskName || null,
    scheduledFor,
    firedAt: firedAt ?? now,
    status,
    ...(row.agent ? { agent: String(row.agent).slice(0, 160) } : {}),
    ...(row.repeat ? { repeat: String(row.repeat).slice(0, 16) } : {}),
    ...(row.timezone ? { timezone: String(row.timezone).slice(0, 80) } : {}),
    ...(row.output != null ? { output: String(row.output).slice(0, 16000), outputTruncated: String(row.output).length > 16000 } : {}),
    ...(Number.isSafeInteger(row.attempts) ? { attempts: row.attempts } : {}),
    ...(row.errorCode ? { errorCode: String(row.errorCode).slice(0, 80) } : {}),
    ...(Number.isFinite(row.durationMs) ? { durationMs: Math.max(0, row.durationMs) } : {}),
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
      atomicWriteSync(p, kept.slice(-5000).join('\n') + '\n', { mode: 0o600 });
      if (status === 'error' || status === 'ok') signalWorkEvent(userId, { kind: 'task', taskId });
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
      .filter(row => row && typeof row.taskId === 'string' && row.ts > Date.now() - RETENTION_MS);
    return taskId ? rows.filter(r => r.taskId === taskId) : rows;
  } catch { return []; }
}
