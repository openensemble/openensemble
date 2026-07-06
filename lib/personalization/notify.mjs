// @ts-check
/**
 * Notification bridge for Personalization — no push channel exists at this
 * layer of the codebase, so this module is a thin, swappable indirection:
 * the integrator calls setNotifyFn() once at server boot (near the existing
 * sendStatus wiring, server.mjs:906) to point it at the real WS sender
 * (e.g. `(uid, msg) => sendToUser(uid, msg)`). Until that happens — or in
 * tests — notifyUser() is a safe no-op.
 *
 * Callers (lead-runner.mjs's lead-hit ping, etc.) build the message payload
 * themselves; this module doesn't know or care about its shape.
 */

/** @type {((userId: string, msg: any) => void) | null} */
let _notifyFn = null;

/** Register (or clear, by passing a non-function) the real delivery function. */
export function setNotifyFn(fn) {
  _notifyFn = typeof fn === 'function' ? fn : null;
}

/** Deliver `msg` to `userId`. No-op (never throws) if setNotifyFn was never called. */
export function notifyUser(userId, msg) {
  if (!_notifyFn) return;
  try {
    _notifyFn(userId, msg);
  } catch (e) {
    console.warn('[personalization] notifyUser failed:', e?.message || e);
  }
}
