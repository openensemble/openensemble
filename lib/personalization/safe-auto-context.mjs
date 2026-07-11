// @ts-check
/**
 * Async-local provenance for one validated preference safe-auto activation.
 * Watcher registration reads this context and stamps every watcher created by
 * that tool invocation with an unguessable nonce, letting verification and
 * rollback distinguish it from concurrent user-created watchers.
 */
import { AsyncLocalStorage } from 'async_hooks';

const storage = new AsyncLocalStorage();

export function runWithPreferenceSafeAutoContext(context, fn) {
  if (!context || typeof fn !== 'function') throw new Error('safe-auto context and function required');
  return storage.run(Object.freeze({ ...context }), fn);
}

export function getPreferenceSafeAutoContext() {
  return storage.getStore() || null;
}
