// @ts-check

/**
 * Turn an AbortSignal reason into a real Error. AbortController.abort() accepts
 * arbitrary values (including strings), but throwing those values breaks the
 * normal error/cancellation classification paths.
 */
export function abortError(signal, fallbackMessage = 'Operation cancelled') {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const message = typeof reason === 'string' && reason.trim()
    ? reason.trim()
    : fallbackMessage;
  const error = new Error(message || 'Operation cancelled');
  error.name = 'AbortError';
  return error;
}

/** Cancellation classification that also honors the authoritative owner signal. */
export function isAbortError(error, signal = null) {
  return signal?.aborted === true
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR';
}

/**
 * Create one controller for a single owned operation and link it to its parent.
 * The returned dispose function removes only the parent listener; it does not
 * abort an operation that has already been transferred to another owner.
 */
export function createLinkedAbortController(parentSignal = null, fallbackMessage = 'Operation cancelled') {
  const controller = new AbortController();
  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(abortError(parentSignal, fallbackMessage));
    }
  };
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });
  /** @type {(reason?: unknown) => boolean} */
  const abort = (reason) => {
    if (controller.signal.aborted) return false;
    const effectiveReason = reason ?? fallbackMessage;
    if (effectiveReason instanceof Error) controller.abort(effectiveReason);
    else {
      const error = new Error(String(effectiveReason || fallbackMessage));
      error.name = 'AbortError';
      controller.abort(error);
    }
    return true;
  };
  return {
    controller,
    signal: controller.signal,
    abort,
    dispose() {
      parentSignal?.removeEventListener?.('abort', onParentAbort);
    },
  };
}

/**
 * Release an await as soon as its owner aborts. The losing operation retains
 * fulfillment/rejection handlers, so a late failure cannot become an unhandled
 * rejection even when the underlying implementation ignores cancellation.
 */
export function raceWithAbort(value, signal, fallbackMessage = 'Operation cancelled') {
  const operation = Promise.resolve(value);
  if (!signal) return operation;
  if (signal.aborted) {
    operation.catch(() => {});
    return Promise.reject(abortError(signal, fallbackMessage));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(result);
    };
    const onAbort = () => finish(reject, abortError(signal, fallbackMessage));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      result => finish(resolve, result),
      error => finish(reject, error),
    );
    // Close the small check/listener race.
    if (signal.aborted) onAbort();
  });
}
