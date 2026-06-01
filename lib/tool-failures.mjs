// @ts-check
/**
 * Per-user tool-failure tracker.
 *
 * Counts exceptions/errors from tool calls per (user, tool) and emits a
 * tool_failure proposal when the count crosses threshold in a 7d window.
 *
 * Dedup: only NEW error-message-prefixes count toward threshold within the
 * window. A tight retry loop hitting the same error 50× shouldn't trip — but
 * a flaky tool failing with three different errors should.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const COUNT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_THRESHOLD = 3;
const ERROR_PREFIX_LEN = 80;          // dedup key — first N chars of message
const MAX_RETAINED_PER_TOOL = 50;     // bound for the on-disk history slice

function failuresPath(userId) {
  return path.join(USERS_DIR, userId, 'tool-failures.json');
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

export function loadFailures(userId) {
  if (!userId) return {};
  return readJsonSafe(failuresPath(userId));
}

async function saveFailures(userId, data) {
  const p = failuresPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  });
}

function errPrefix(message) {
  return String(message || '').slice(0, ERROR_PREFIX_LEN);
}

/**
 * Record a failure observation. Returns whether the threshold tripped on
 * this call so the dispatcher can decide to propose:
 *   { proposed: false }
 *   { proposed: true, tool, recentErrors: [...up to 3 unique prefixes], count }
 *
 * cooldownLastProposedAt is set on trip so we don't propose again within
 * 24h purely from in-store state. The proposal layer's own dismiss cooldown
 * gates the user-facing card the same way for other kinds.
 */
export async function recordToolFailure(userId, toolName, errorMessage) {
  if (!userId || !toolName) return { proposed: false };
  const data = loadFailures(userId);
  const now = Date.now();
  const cutoff = now - COUNT_WINDOW_MS;

  const rec = data[toolName] || { msgs: [], cooldownLastProposedAt: 0 };
  rec.msgs = (rec.msgs || []).filter(m => m.ts > cutoff);
  rec.msgs.push({ ts: now, error: errPrefix(errorMessage) });
  if (rec.msgs.length > MAX_RETAINED_PER_TOOL) {
    rec.msgs = rec.msgs.slice(-MAX_RETAINED_PER_TOOL);
  }

  data[toolName] = rec;
  try { await saveFailures(userId, data); } catch (e) {
    console.warn('[tool-failures] persist failed:', e.message);
  }

  // Threshold check: count UNIQUE error prefixes. A loop of identical errors
  // is one signal, not N.
  const uniquePrefixes = new Set(rec.msgs.map(m => m.error));
  if (uniquePrefixes.size < FAILURE_THRESHOLD) return { proposed: false };

  // Don't re-propose within 24h of the last proposal (regardless of dismiss).
  if (now - (rec.cooldownLastProposedAt || 0) < 24 * 60 * 60 * 1000) {
    return { proposed: false };
  }

  rec.cooldownLastProposedAt = now;
  try { await saveFailures(userId, data); } catch (_) { /* best-effort */ }

  // Surface the 3 most-recent unique-prefix errors so the proposal message
  // can quote what's actually breaking.
  const seen = new Set();
  const recentErrors = [];
  for (let i = rec.msgs.length - 1; i >= 0 && recentErrors.length < 3; i--) {
    const p = rec.msgs[i].error;
    if (seen.has(p)) continue;
    seen.add(p);
    recentErrors.push(p);
  }

  return { proposed: true, tool: toolName, recentErrors, count: rec.msgs.length };
}

/**
 * Read-only — used by the Learn panel to surface tools currently exhibiting
 * recent failures. Returns one entry per tool with at least one failure in
 * the last 7 days, sorted by recency.
 */
export function listRecentFailures(userId) {
  const data = loadFailures(userId);
  const cutoff = Date.now() - COUNT_WINDOW_MS;
  const out = [];
  for (const [tool, rec] of Object.entries(data)) {
    const msgs = (rec?.msgs || []).filter(m => m.ts > cutoff);
    if (!msgs.length) continue;
    const last = msgs[msgs.length - 1];
    out.push({
      tool,
      count: msgs.length,
      uniqueErrorCount: new Set(msgs.map(m => m.error)).size,
      lastTs: last.ts,
      lastError: last.error,
    });
  }
  out.sort((a, b) => b.lastTs - a.lastTs);
  return out;
}
