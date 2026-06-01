// @ts-check
/**
 * task_proxy execution context (Phase 14b).
 *
 * Two responsibilities:
 *  - ALS scope so `ask_user_via_task` (called from inside a sub-agent's
 *    streamChat loop) can find which watcher it's running under, without
 *    threading watcherId through every tool call.
 *  - Per-watcher Promise registry so the tool can `await` the user's reply.
 *    POST /api/watchers/:id/reply resolves the matching promise.
 *
 * First-write-wins: once a reply lands on a watcher, subsequent POSTs
 * return 409 + the winning reply, so multi-tab UIs converge to the same
 * "replied" state.
 */
import { AsyncLocalStorage } from 'async_hooks';

const _als = new AsyncLocalStorage();
const _pending = new Map();   // watcherId → { resolve, replyText?, question, askedAt }

/** Wrap a function so its callees can call currentWatcherId(). */
export function runInTaskContext(ctx, fn) {
  return _als.run(ctx, fn);
}

export function currentTaskContext() {
  return _als.getStore() || null;
}

/**
 * Register an awaiting-input wait. Returns a Promise that resolves with the
 * user's reply text. Tool throws via timeoutMs caller-provided rejection.
 * If a reply already arrived (race), resolves immediately.
 */
export function awaitUserReply(watcherId, question, { timeoutMs = 24 * 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    if (_pending.has(watcherId)) {
      // Pre-existing entry (shouldn't normally happen — tool called twice).
      // Reject so the second call doesn't silently double-wait.
      reject(new Error('watcher already awaiting input'));
      return;
    }
    const entry = { resolve, question, askedAt: Date.now(), replyText: null };
    _pending.set(watcherId, entry);
    if (timeoutMs > 0) {
      const t = setTimeout(() => {
        if (_pending.get(watcherId) === entry) {
          _pending.delete(watcherId);
          reject(new Error(`timed out waiting for user reply after ${Math.round(timeoutMs / 1000)}s`));
        }
      }, timeoutMs);
      // Don't keep the process alive purely for a wait promise.
      if (t.unref) t.unref();
    }
  });
}

/**
 * Submit a reply for a watcher. First call wins. Returns:
 *   { ok: true, accepted: true }  — first reply, resolves the pending promise
 *   { ok: true, accepted: false, existing }  — second tab's late submit; idempotent
 *   { ok: false, error: 'not waiting' }  — no awaiting state for this watcher
 */
export function submitReply(watcherId, replyText) {
  const entry = _pending.get(watcherId);
  if (!entry) return { ok: false, error: 'not waiting' };
  if (entry.replyText !== null) {
    // Already replied — multi-tab dedup
    return { ok: true, accepted: false, existing: entry.replyText };
  }
  entry.replyText = String(replyText || '');
  entry.resolve(entry.replyText);
  // Keep entry briefly so a late second submit returns the same winning reply
  // rather than a confusing "not waiting" — sweep after a short window.
  setTimeout(() => _pending.delete(watcherId), 60_000);
  return { ok: true, accepted: true };
}

/** Read-only inspection: is a watcher currently awaiting input? */
export function isAwaitingInput(watcherId) {
  const entry = _pending.get(watcherId);
  return !!(entry && entry.replyText === null);
}

/** Read the original question text (for nudge re-broadcast). */
export function getAwaitingQuestion(watcherId) {
  const entry = _pending.get(watcherId);
  return entry?.question ?? null;
}
