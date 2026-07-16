/**
 * Resolve the trace-side identity for one dispatcher turn.
 *
 * Public message/attempt ids own the browser wire turn. Hidden continuations
 * deliberately leave those unset so the dispatcher mints a fresh visible
 * turn, while internal side-effect ids retain the original authorization used
 * by durable action ledgers.
 */
export function resolveDispatchTurnCorrelation({
  turnId = null,
  messageId = null,
  attemptId = null,
  rootTaskId = null,
  sideEffectMessageId = null,
  sideEffectAttemptId = null,
} = {}) {
  return {
    rootId: rootTaskId,
    turnId: attemptId ?? turnId,
    messageId: sideEffectMessageId ?? messageId,
    attemptId: sideEffectAttemptId ?? attemptId ?? turnId,
  };
}
