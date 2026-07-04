// @ts-check
/**
 * Activity trail for the Gmail auto-label poller (gmail-autolabel.mjs).
 *
 * One JSONL row per action the poller took on a message — either an applied
 * label (with whether it archived the message) or a skip (with why, e.g. a
 * learned-pin conflict). This is what makes the poller auditable and
 * reversible: the UI's "Put the last batch back" button and the
 * undo-last-batch endpoint both read this file.
 *
 * Storage: users/<userId>/gmail-autolabel-activity.jsonl — one file per user,
 * matching where gmail-autolabel.mjs already keeps gmail-autolabel.json (rules
 * are per-user, keyed internally by account; this mirrors that). Each row
 * carries an `account` field (the real accountId, or null for the default/
 * legacy account) so a shared file can still be filtered per account.
 *
 * Retention: rows older than 30 days are dropped on every append (same
 * pattern as lib/correction-events.mjs) — auto-label activity is a recent-
 * history/undo aid, not a permanent audit log.
 *
 * Undo model: every poll cycle that applies/skips at least one action shares
 * one `batchId` (see gmail-autolabel.mjs). getLastBatch() finds the most
 * recent batch for an account; markRowsUndone() flips `undone:true` on
 * specific rows by id, idempotently (re-marking an already-undone row is a
 * no-op) — see undoLastBatch() in gmail-autolabel.mjs for how a partial
 * failure leaves only the failed rows eligible for a retry.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock, atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SUBJECT_MAX = 80;

export function activityPath(userId) {
  return path.join(USERS_DIR, userId, 'gmail-autolabel-activity.jsonl');
}

/**
 * Append one poll cycle's worth of activity rows in a single locked
 * read-modify-write (rather than one lock acquisition per message).
 * @param {string} userId
 * @param {Array<{account?: string|null, messageId:string, from?:string, subject?:string,
 *   ruleId?: string|null, label?: string|null, archived?: boolean, batchId: string, skipped?: string}>} rows
 * @returns {Promise<object[]>} the rows actually written (with id/ts/undone filled in)
 */
export async function appendActivityBatch(userId, rows) {
  if (!userId || !Array.isArray(rows) || !rows.length) return [];
  const p = activityPath(userId);
  const now = Date.now();
  const written = rows.map((r, idx) => {
    const account = r.account ?? null;
    const out = {
      id: `${account ?? '__default__'}:${r.batchId}:${idx}`,
      ts: now,
      account,
      messageId: r.messageId,
      from: r.from ?? '',
      subject: (r.subject ?? '').slice(0, SUBJECT_MAX),
      ruleId: r.ruleId ?? null,
      label: r.label ?? null,
      archived: !!r.archived,
      batchId: r.batchId,
      undone: false,
    };
    if (r.skipped) out.skipped = r.skipped;
    return out;
  });
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let kept = [];
    if (fs.existsSync(p)) {
      const cutoff = now - RETENTION_MS;
      for (const line of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
        try { const rec = JSON.parse(line); if (rec.ts > cutoff) kept.push(line); } catch { /* drop bad lines */ }
      }
    }
    for (const w of written) kept.push(JSON.stringify(w));
    atomicWriteSync(p, kept.join('\n') + '\n');
  });
  return written;
}

/** All rows for a user, oldest first, exactly as stored. */
export function loadActivity(userId) {
  if (!userId) return [];
  const p = activityPath(userId);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Recent activity, newest first, for the GET endpoint.
 * @param {string} userId
 * @param {{accountId?: string|null, limit?: number}} [opts]
 *   accountId === undefined -> no account filter (all accounts).
 *   accountId === null (or '') -> rows for the default/legacy account only.
 */
export function tailActivity(userId, opts = {}) {
  let rows = loadActivity(userId);
  if (opts.accountId !== undefined) {
    const want = opts.accountId || null;
    rows = rows.filter(r => (r.account ?? null) === want);
  }
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 50;
  return rows.slice(-limit).reverse();
}

/**
 * The most recent poll-cycle batch for one account, or null if that account
 * has no activity yet.
 * @returns {{batchId: string, rows: object[]}|null}
 */
export function getLastBatch(userId, accountId) {
  const want = accountId || null;
  const rows = loadActivity(userId).filter(r => (r.account ?? null) === want);
  if (!rows.length) return null;
  // >= (not >) so that among rows with an identical ts (Date.now() has only
  // ms resolution — two appendActivityBatch calls in the same tick are
  // possible), the row that comes LATER in file/append order wins. Rows are
  // always appended in chronological order, so "last in the file" is the
  // more-recent batch even when the clock can't tell them apart.
  let latest = rows[0];
  for (const r of rows) if (r.ts >= latest.ts) latest = r;
  return { batchId: latest.batchId, rows: rows.filter(r => r.batchId === latest.batchId) };
}

/**
 * Mark specific rows (by id) as undone. Idempotent: rows already undone are
 * left alone and not counted again, so calling this twice with overlapping
 * ids only reverses each row once.
 * @returns {Promise<number>} count of rows newly marked undone
 */
export async function markRowsUndone(userId, ids) {
  if (!userId || !Array.isArray(ids) || !ids.length) return 0;
  const idSet = new Set(ids);
  const p = activityPath(userId);
  return withLock(p, () => {
    if (!fs.existsSync(p)) return 0;
    let count = 0;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const out = lines.map(line => {
      let rec;
      try { rec = JSON.parse(line); } catch { return line; }
      if (idSet.has(rec.id) && !rec.undone) {
        rec.undone = true;
        rec.undoneAt = Date.now();
        count++;
      }
      return JSON.stringify(rec);
    });
    if (count) atomicWriteSync(p, out.join('\n') + '\n');
    return count;
  });
}
