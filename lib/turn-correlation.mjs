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
  const sessionAttemptId = attemptId ?? turnId;
  return {
    rootId: rootTaskId,
    turnId: sessionAttemptId,
    messageId: sideEffectMessageId ?? messageId,
    attemptId: sideEffectAttemptId ?? attemptId ?? turnId,
    // Hidden continuations may retain the original message/attempt as their
    // side-effect authorization while using a fresh durable chat attempt.
    // Ordinary turns keep both identity pairs identical.
    sessionMessageId: messageId ?? sideEffectMessageId,
    sessionAttemptId: sessionAttemptId ?? sideEffectAttemptId ?? turnId,
  };
}
