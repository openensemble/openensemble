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
import { abortError } from './abort-utils.mjs';

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
 * Consume an async iterable with every iterator operation bound to one task
 * context. Merely creating an async generator inside `_als.run()` is not
 * enough: its body executes when `next()` is called, often after that scope has
 * already returned. This wrapper is for streaming child model loops that must
 * yield events to a foreground parent while their own tools remain owned by a
 * durable task/delegation.
 *
 * @param {object} ctx
 * @param {AsyncIterable<any>|(() => AsyncIterable<any>)} source
 */
export async function* iterateInTaskContext(ctx, source) {
  const iterator = runInTaskContext(ctx, () => {
    const iterable = typeof source === 'function' ? source() : source;
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('iterateInTaskContext requires an async iterable');
    }
    return iterable[Symbol.asyncIterator]();
  });
  let finished = false;
  try {
    while (true) {
      const step = await runInTaskContext(ctx, () => iterator.next());
      if (step.done) {
        finished = true;
        return step.value;
      }
      yield step.value;
    }
  } finally {
    if (!finished && typeof iterator.return === 'function') {
      try { await runInTaskContext(ctx, () => iterator.return()); }
      catch { /* preserve the consumer's original teardown reason */ }
    }
  }
}

/**
 * Register an awaiting-input wait. Returns a Promise that resolves with the
 * user's reply text. Tool throws via timeoutMs caller-provided rejection.
 * If a reply already arrived (race), resolves immediately.
 */
export function awaitUserReply(
  watcherId,
  question,
  { timeoutMs = 24 * 60 * 60 * 1000, signal = null } = {},
) {
  return new Promise((resolve, reject) => {
    if (_pending.has(watcherId)) {
      // Pre-existing entry (shouldn't normally happen — tool called twice).
      // Reject so the second call doesn't silently double-wait.
      reject(new Error('watcher already awaiting input'));
      return;
    }
    let timer = null;
    const onAbort = () => {
      if (_pending.get(watcherId) !== entry) return;
      _pending.delete(watcherId);
      releaseWaitResources(entry);
      reject(abortError(signal, 'Background task cancelled while awaiting user input'));
    };
    const entry = {
      resolve, reject, question, askedAt: Date.now(), replyText: null,
      timer: null, signal, onAbort,
    };
    _pending.set(watcherId, entry);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (_pending.get(watcherId) === entry) {
          _pending.delete(watcherId);
          releaseWaitResources(entry);
          reject(new Error(`timed out waiting for user reply after ${Math.round(timeoutMs / 1000)}s`));
        }
      }, timeoutMs);
      entry.timer = timer;
      // Don't keep the process alive purely for a wait promise.
      if (timer.unref) timer.unref();
    }
  });
}

function releaseWaitResources(entry) {
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.signal?.removeEventListener?.('abort', entry.onAbort);
  entry.timer = null;
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
  releaseWaitResources(entry);
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
