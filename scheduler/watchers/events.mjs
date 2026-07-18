// @ts-check
/**
 * In-process watcher event bus + event_subscription handler.
 * Bound to watcher store via bindEventBusDeps().
 */

/** @type {any} */
let getUserStore = () => null; // (userId) => store | null
/** @type {any} */
let persistUser = () => false;
/** @type {any} */
let setSystemHandler = () => {};

export function bindEventBusDeps(deps) {
  getUserStore = deps.getUserStore;
  persistUser = deps.persistUser;
  setSystemHandler = deps.setSystemHandler;
}

// ── event bus ────────────────────────────────────────────────────────────────
//
// In-process pub/sub for "an external thing happened" — webhook arrivals,
// Telegram bot replies, file-change notifications, anything with a real
// trigger source instead of a polled one.
//
// A watcher with kind='event_subscription' and state.event='<name>' subscribes
// itself at registration time. emitEvent() finds matching watchers, stamps
// the payload onto state, and pulls their nextTickAt forward so the
// supervisor picks them up on the next 5s sweep. The handler then evaluates
// any predicate and decides whether to fire.

const _eventListeners = new Map(); // userId -> Map(eventName -> Set<watcherId>)

function eventKey(record) {
  return record?.state?.event || null;
}

export function subscribeToEvent(record) {
  const ev = eventKey(record);
  if (!ev) return;
  if (!_eventListeners.has(record.userId)) _eventListeners.set(record.userId, new Map());
  const userMap = _eventListeners.get(record.userId);
  if (!userMap.has(ev)) userMap.set(ev, new Set());
  userMap.get(ev).add(record.id);
}

export function unsubscribeFromEvent(record) {
  const userMap = _eventListeners.get(record.userId);
  if (!userMap) return;
  const ev = eventKey(record);
  if (!ev) return;
  const set = userMap.get(ev);
  if (set) {
    set.delete(record.id);
    if (!set.size) userMap.delete(ev);
  }
}

/**
 * Fire an event. Any watcher of kind='event_subscription' with a matching
 * state.event will get its payload stamped and tick on the next supervisor
 * sweep. Returns the count of matched watchers.
 *
 * Safe to call even when the supervisor is idle — just no-ops.
 */
export function emitEvent(userId, eventName, payload = {}) {
  if (!userId || !eventName) return 0;
  const userMap = _eventListeners.get(userId);
  if (!userMap) return 0;
  const watcherIds = userMap.get(eventName);
  if (!watcherIds || !watcherIds.size) return 0;
  const data = getUserStore(userId);
  if (!data) return 0;
  let matched = 0;
  for (const wid of watcherIds) {
    const w = data.active.find(x => x.id === wid);
    if (!w) continue;
    // Queue every payload. A single lastEventPayload slot silently lost one of
    // two events landing in the same ~5s window (or one arriving mid-tick); the
    // subscription handler drains the whole queue. lastEventPayload is kept as
    // "most recent" only for back-compat with any in-flight persisted state.
    const queue = Array.isArray(w.state?.pendingEvents) ? w.state.pendingEvents.slice() : [];
    queue.push(payload);
    w.state = { ...w.state, pendingEvents: queue, lastEventPayload: payload, lastEventAt: Date.now() };
    w.nextTickAt = Date.now(); // tick on next supervisor sweep
    matched++;
  }
  if (matched) persistUser(userId);
  return matched;
}

// Built-in event_subscription handler. Runs whenever the supervisor ticks the
// watcher — either after emitEvent() pulled nextTickAt forward, or once every
// 24h as a sanity sweep. Without a fresh lastEventAt it just goes back to
// sleep; with one, it evaluates the predicate and fires/declines.
export async function eventSubscriptionHandler(state) {
  const { event, predicate } = state || {};
  if (!event) return { done: true, textUpdate: '❌ event watcher missing event name' };
  // Drain every event queued since the last tick — two events arriving in the
  // same ~5s window both get evaluated, so a matching one can't be lost.
  let queue = Array.isArray(state.pendingEvents) ? state.pendingEvents : [];
  // Back-compat: a watcher persisted before the queue existed carries only
  // lastEventPayload — treat it as a one-element queue.
  if (!queue.length && state.lastEventAt !== undefined && state.lastEventPayload !== undefined) {
    queue = [state.lastEventPayload];
  }
  if (state.lastEventAt === undefined && !queue.length) {
    return {}; // waiting for first event
  }
  // Consuming clears the queue + event markers so a later sweep doesn't
  // re-evaluate the same payloads.
  const consumedState = { ...state, lastEventAt: undefined, lastEventPayload: undefined, pendingEvents: [] };

  if (!predicate) {
    return { done: true, textUpdate: `🔔 event "${event}" fired` }; // any event fires
  }
  for (const payload of queue) {
    let val;
    try {
      // Reuse the dotted-path logic from watch-handlers via a tiny inline
      // walker — keeping watchers.mjs free of cross-file imports for the
      // built-in handler.
      val = walkPath(payload, predicate.jsonPath || '$');
    } catch { val = undefined; }
    let hit = false;
    try { hit = comparePayload(val, predicate.comparator, predicate.target); }
    catch (e) { return { done: true, textUpdate: `❌ ${e.message}` }; }
    if (hit) return { done: true, textUpdate: `🔔 event "${event}" fired` };
  }
  return { newState: consumedState }; // events came but none matched
}

// Tiny duplicates of compare/jsonGet from scheduler/watch-handlers.mjs — kept
// inline so this file doesn't depend on the handler module's load order.
function walkPath(obj, path) {
  if (!path || path === '$') return obj;
  let cur = obj;
  const tokens = path.replace(/^\$\.?/, '').match(/[^.[\]]+|\[\d+\]/g) || [];
  for (const tok of tokens) {
    if (cur == null) return undefined;
    cur = tok.startsWith('[') ? cur[Number(tok.slice(1, -1))] : cur[tok];
  }
  return cur;
}
function comparePayload(value, comparator, target) {
  switch (comparator) {
    case 'gte':      return Number(value) >= Number(target);
    case 'lte':      return Number(value) <= Number(target);
    case 'gt':       return Number(value) >  Number(target);
    case 'lt':       return Number(value) <  Number(target);
    case 'eq':       return String(value) === String(target);
    case 'neq':      return String(value) !== String(target);
    case 'matches':  return new RegExp(String(target)).test(String(value));
    case 'contains': return String(value).includes(String(target));
    default: throw new Error(`unknown comparator "${comparator}"`);
  }
}

/** Wire the built-in event_subscription handler onto the parent system map. */
export function registerEventSubscriptionHandler() {
  setSystemHandler('event_subscription', eventSubscriptionHandler);
}
