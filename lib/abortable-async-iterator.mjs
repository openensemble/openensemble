// @ts-check
/**
 * Race each iterator read against an AbortSignal.
 *
 * Merely passing a signal into a provider/tool is not a hard ownership bound:
 * a buggy implementation may ignore it and leave its caller blocked in
 * `await iterator.next()`. This wrapper releases the owner immediately on
 * abort. The abandoned read keeps a rejection handler, and iterator.return()
 * is requested without awaiting a non-cooperative producer.
 */

function abortError(signal, fallback) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const message = typeof reason === 'string' && reason.trim() ? reason.trim() : fallback;
  const error = new Error(message || 'Operation aborted');
  error.name = 'AbortError';
  return error;
}

export async function* iterateUntilAbort(iterable, signal, fallbackMessage = 'Operation aborted') {
  const iterator = iterable?.[Symbol.asyncIterator]?.();
  if (!iterator) throw new TypeError('iterateUntilAbort requires an async iterable');
  let finished = false;
  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal, fallbackMessage);
      const nextPromise = Promise.resolve().then(() => iterator.next());
      let onAbort = null;
      const abortPromise = signal
        ? new Promise((_, reject) => {
            onAbort = () => reject(abortError(signal, fallbackMessage));
            signal.addEventListener('abort', onAbort, { once: true });
          })
        : null;
      let step;
      try {
        step = abortPromise
          ? await Promise.race([nextPromise, abortPromise])
          : await nextPromise;
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
      if (step.done) {
        finished = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!finished) {
      try { Promise.resolve(iterator.return?.()).catch(() => {}); }
      catch { /* best-effort teardown; ownership has already been released */ }
    }
  }
}

export const _internal = { abortError };
