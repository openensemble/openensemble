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

/** @type {((userId: string, msg: any) => number|boolean|void|Promise<number|boolean|void>) | null} */
let _notifyFn = null;

/** Register (or clear, by passing a non-function) the real delivery function. */
export function setNotifyFn(fn) {
  _notifyFn = typeof fn === 'function' ? fn : null;
}

/**
 * Deliver `msg` to `userId`, returning the number of destinations that
 * accepted it.  Zero is a normal offline result, not success.  Callers that
 * need durability keep their outbox row pending when zero is returned.
 */
export async function notifyUser(userId, msg) {
  if (!_notifyFn) return 0;
  try {
    const result = await _notifyFn(userId, msg);
    if (result === true) return 1;
    const count = Number(result);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  } catch (e) {
    console.warn('[personalization] notifyUser failed:', e?.message || e);
    return 0;
  }
}
