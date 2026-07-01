// @ts-check
/**
 * Per-user polling/monitor service ("watchers").
 *
 * A watcher is a long-running poll registered by a skill (or by the system) to
 * monitor evolving state — video render progress, price alerts, training jobs,
 * pod lifecycle, background syncs. It's NOT a scheduled task: tasks fire once
 * (or on a cron) and finish; watchers tick forever (or until expiry / done /
 * cancellation) and emit status updates over WS as they go.
 *
 * Architecture:
 *   • One supervisor per server instance (single setInterval).
 *   • Watchers live in users/<uid>/watchers.json (per-user file). Disk-backed
 *     because server restart wiping in-memory state is the main pain point this
 *     replaces (see memory: feedback_server_restart_cost).
 *   • Handlers are looked up lazily via the same path skills use for tools:
 *     a skill's executor exports `watcherHandlers: { [kind]: handler }`.
 *   • Skills register watchers via `ctx.watch({kind, state, cadenceSec, expiresAt})`
 *     and unregister via `ctx.unwatch(id)`.
 *   • Status updates flow to chat via the WS `status` message type.
 *
 * Distinction from scheduler/tasks (documented at the type level so authors
 * don't pick the wrong tool):
 *
 *   Task    : fire scheduled action, runs to completion. (cron / once)
 *   Watcher : tick every N seconds, push progress, reap on done/expiry/cancel.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import { USERS_DIR, SKILLS_DIR, userSkillsDir } from '../lib/paths.mjs';
import { log } from '../logger.mjs';

const TICK_MS = 5_000;
const DEFAULT_CADENCE_SEC = 30;
const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;       // 1h fallback when caller forgets
const SOFT_EXPIRY_WARN_MS = 30 * 24 * 60 * 60 * 1000; // 30d — long-but-finite is suspicious
// 50 is the post-coalescence number — when watchers were 1-per-signal we ran
// 10 because a few onboarded services would already swamp the budget. Now
// each profile is 1 watcher (state.signals[] internal), so 50 covers 50
// managed services + headroom for video gen, training runs, price alerts,
// custom skills, etc. Bump again if it becomes load-bearing.
const MAX_PER_USER = 50;
const MAX_FAILURES = 3;
const RECENT_KEEP_MS = 60 * 60 * 1000;          // Keep completed/errored watchers visible 1h
const MAX_HISTORY_ENTRIES = 100;                // Per-watcher progress scrollback cap
const STUCK_RATIO = 5;                          // No change for 5×cadence → annotate as "stuck"
const STUCK_BACKOFF_MAX_SEC = 3600;             // Back off noisy stuck polls up to hourly

let _running = false;
let _timer = null;
let _sendStatusFn = null;
let _sendNotificationFn = null;
let _showImageFn = null;
let _showVideoFn = null;

// In-memory cache per user, mirrored to disk on every change.
//   _byUser: userId -> { active: WatcherRecord[], recent: WatcherRecord[] }
// Recent is a small ring of completed/errored watchers for the tasks drawer.
const _byUser = new Map();

// Ticks-in-flight guard so a slow handler doesn't pile up duplicate runs.
const _inFlight = new Set();

// ── persistence ───────────────────────────────────────────────────────────────

function watchersPath(userId) {
  return path.join(USERS_DIR, userId, 'watchers.json');
}

function loadUserWatchers(userId) {
  if (_byUser.has(userId)) return _byUser.get(userId);
  const p = watchersPath(userId);
  let data = { active: [], recent: [] };
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      data = {
        active: Array.isArray(parsed.active) ? parsed.active : [],
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      };
    }
  } catch (e) {
    log.warn('watchers', `Failed to load ${userId} watchers`, { err: e.message });
  }

  // Phase-14c: boot-reap stale task_proxy watchers. A task_proxy in `active`
  // state with no recent activity (>1h) AND not awaiting input is almost
  // certainly a zombie from a server crash mid-task. Mark it failed and
  // move to recent so the chip shows an honest "task interrupted" outcome.
  const TASK_PROXY_BOOT_REAP_MS = 60 * 60 * 1000;
  const now = Date.now();
  let reaped = 0;
  data.active = data.active.filter(w => {
    if (w.kind !== 'task_proxy') return true;
    if (w.state?.awaiting_input) return true;   // user was just being slow
    const lastActivity = w.state?.lastActivityAt || w.lastChangeAt || w.createdAt || 0;
    if (lastActivity && now - lastActivity > TASK_PROXY_BOOT_REAP_MS) {
      reaped++;
      w.status = 'error';
      w.endedAt = now;
      w.lastStatusText = `⚠ Task interrupted by server restart (was running for ${Math.round((now - lastActivity) / 60000)}min)`;
      if (Array.isArray(w.history)) {
        w.history.push({ text: w.lastStatusText, ts: now, final: true, finalStatus: 'error' });
      }
      data.recent.unshift(w);
      return false;
    }
    return true;
  });
  if (data.recent.length > 20) data.recent = data.recent.slice(0, 20);
  if (reaped > 0) log.info('watchers', `boot-reaped ${reaped} stale task_proxy watcher(s)`, { userId });

  _byUser.set(userId, data);
  return data;
}

function persistUser(userId) {
  const data = _byUser.get(userId);
  if (!data) return;
  const p = watchersPath(userId);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (e) {
    log.warn('watchers', `Failed to persist ${userId} watchers`, { err: e.message });
  }
}

function loadAllUsersFromDisk() {
  if (!fs.existsSync(USERS_DIR)) return;
  for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const uid = entry.name;
    // Only load users that actually have a watchers.json — skip junk dirs.
    if (!fs.existsSync(watchersPath(uid))) continue;
    loadUserWatchers(uid);
  }
}

// ── public registration API (used by ctx.watch / ctx.unwatch) ────────────────

/**
 * Register a watcher.
 *
 * @param {object} opts
 * @param {string}  opts.userId      Required.
 * @param {string}  opts.agentId     Agent thread to post status into. Required.
 * @param {string}  opts.kind        Handler key — must match an entry in some
 *                                   skill's executor.watcherHandlers map.
 * @param {object}  [opts.state]     Opaque, kind-specific config (job_id, ...).
 * @param {number}  [opts.cadenceSec=30]   Tick interval.
 * @param {number|null} [opts.expiresAt]   Wall-clock ms. null = indefinite (must
 *                                   be unwatched manually). Omitting it logs a
 *                                   WARN and falls back to 1h.
 * @param {string}  [opts.skillId]   Owning skill — used to locate the handler.
 * @param {string}  [opts.label]     Short user-facing description for the tasks
 *                                   drawer. Falls back to kind.
 * @param {{type: 'notify'|'agent', prompt?: string, [k: string]: any} | null} [opts.onFire]
 *                                   Action to run when this watcher reaches `done`
 *                                   status — see executeOnFire below.
 * @returns {string} watcherId
 */
export function registerWatcher(opts) {
  const { userId, agentId, kind, state = {}, cadenceSec, expiresAt, skillId, label } = opts || {};
  if (!userId)  throw new Error('registerWatcher: userId required');
  if (!agentId) throw new Error('registerWatcher: agentId required');
  if (!kind)    throw new Error('registerWatcher: kind required');

  const data = loadUserWatchers(userId);

  if (data.active.length >= MAX_PER_USER) {
    log.warn('watchers', 'Per-user cap reached, refusing registration', { userId, kind });
    throw new Error(`watcher cap reached (${MAX_PER_USER} active per user)`);
  }

  // Caller MUST set expiresAt explicitly. If they omit it, warn loudly so it
  // gets fixed at the call site, then fall back to a 1h ceiling.
  let resolvedExpires;
  if (expiresAt === null) {
    resolvedExpires = null; // indefinite — explicit opt-out
  } else if (typeof expiresAt === 'number' && expiresAt > Date.now()) {
    resolvedExpires = expiresAt;
    if (expiresAt - Date.now() > SOFT_EXPIRY_WARN_MS) {
      log.warn('watchers', 'Suspiciously long expiresAt (>30d) — confirm this is intended', { kind, daysOut: (expiresAt - Date.now()) / 86400000 });
    }
  } else {
    log.warn('watchers', `kind=${kind} registered without valid expiresAt — defaulting to 1h, fix the caller`, { userId });
    resolvedExpires = Date.now() + DEFAULT_EXPIRY_MS;
  }

  // Disperse first ticks across the cadence window so a profile-attach burst
  // doesn't queue every node's health check at the same instant. Hash the
  // (node, service) identity when present so the offset is stable across
  // re-registrations (re-reviewing a profile doesn't shift its phase). For
  // non-health watchers, fall back to a per-record hash — still spreads new
  // registrations across the window. Once each watcher ticks, tickOne sets
  // nextTickAt = now + cadenceMs which keeps the spread for the lifetime of
  // the watcher.
  const id = randomUUID();
  const cadenceMs = Math.max(5, Number(cadenceSec) || DEFAULT_CADENCE_SEC) * 1000;
  const jitterKey = (state && (state.node_id || state.service_id))
    ? `${state.node_id || ''}|${state.service_id || ''}`
    : id;
  const phaseOffsetMs = Number(BigInt('0x' + createHash('sha1').update(jitterKey).digest('hex').slice(0, 12)) % BigInt(cadenceMs));

  const record = {
    id,
    userId,
    agentId,
    kind,
    skillId: skillId || null,
    label: label || kind,
    state,
    cadenceSec: Math.max(5, Number(cadenceSec) || DEFAULT_CADENCE_SEC),
    createdAt: Date.now(),
    nextTickAt: Date.now() + phaseOffsetMs,
    expiresAt: resolvedExpires,
    lastStatusText: null,
    lastChangeAt: Date.now(),
    lastTickAt: null,
    failures: 0,
    ticks: 0,
    status: 'active', // active | done | error | expired | cancelled
    history: [],      // [{text, ts, final?, finalStatus?}] — bounded scrollback
    onFire: opts.onFire || null, // { type: 'notify' | 'agent', prompt? } — see executeOnFire
  };

  data.active.push(record);
  // event_subscription watchers register against the in-process bus so
  // emitEvent() can pull their nextTickAt forward when their event arrives.
  // Polling kinds skip this — the supervisor's regular sweep handles them.
  if (kind === 'event_subscription') subscribeToEvent(record);
  persistUser(userId);
  return record.id;
}

/**
 * Mutate an active watcher in place. Returns the updated record or null if not
 * found. Supports changing cadence, label, expiresAt, and onFire (delivery
 * mode + delivery-specific fields). The skill-defined `state` is intentionally
 * NOT exposed here — that's per-watcher private data; changing it would
 * usually mean "re-register with different state", not "edit in place".
 *
 * Resets `nextTickAt` to a short window after now (≤60 s) when cadence changes
 * so the watcher doesn't tick on the OLD schedule one more time before
 * adopting the new one. Same jitter spread as registerWatcher uses for new
 * registrations.
 *
 * @param {string} userId
 * @param {string} watcherId
 * @param {{cadenceSec?: number, label?: string, expiresAt?: number|null, onFire?: object}} patch
 * @returns {object|null} updated record or null
 */
export function updateWatcher(userId, watcherId, patch) {
  const data = loadUserWatchers(userId);
  const w = data.active.find(x => x.id === watcherId);
  if (!w) return null;

  if (typeof patch.cadenceSec === 'number' && patch.cadenceSec >= 5) {
    w.cadenceSec = patch.cadenceSec;
    w.nextTickAt = Date.now() + Math.min(patch.cadenceSec * 1000, 60_000);
  }
  if (patch.label && typeof patch.label === 'string') {
    w.label = patch.label.slice(0, 200);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'expiresAt')) {
    if (patch.expiresAt === null) {
      w.expiresAt = null;
    } else if (typeof patch.expiresAt === 'number' && patch.expiresAt > Date.now()) {
      w.expiresAt = patch.expiresAt;
    }
  }
  if (patch.onFire && typeof patch.onFire === 'object' && patch.onFire.type) {
    w.onFire = patch.onFire;
  }
  persistUser(userId);
  return w;
}

// ── collection-watcher item operations ───────────────────────────────────────
//
// Collection watchers store a flat `state.items` array of `{ id, cadenceSec,
// nextDueAt, ... }` objects. The parent watcher ticks at COLLECTION_TICK_SEC
// (60s); the handler filters items by `nextDueAt <= now`, processes due ones
// in bounded-concurrency parallel (via helpers.mapItems), and writes back
// `nextDueAt = now + cadenceSec * 1000`.
//
// These exports let the owning skill — or the generic list/update/remove tools
// in skills/tasks — mutate the items array without re-registering the parent
// watcher. The cadence floor (60s) lives here so changes via update_watch_item
// can't drop below what the supervisor sweep can deliver.
export const COLLECTION_TICK_SEC = 60;
const ITEM_MIN_CADENCE_SEC = 60;

function _findCollectionWatcher(userId, { watcherId, skillId, kind }) {
  // Use loadUserWatchers so out-of-process callers (CLI scripts, isolated
  // test harnesses) — and the in-process supervisor — get the same view.
  // _byUser starts empty in fresh processes; loadUserWatchers hydrates it
  // from disk on first read.
  const data = loadUserWatchers(userId);
  if (!data) return null;
  if (watcherId) return data.active.find(w => w.id === watcherId) ?? null;
  // (skillId, kind) is the natural key — there's one collection per pair.
  return data.active.find(w =>
    (w.skillId || null) === (skillId || null) && w.kind === kind && Array.isArray(w?.state?.items),
  ) ?? null;
}

function _normalizeCadence(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n < ITEM_MIN_CADENCE_SEC) return ITEM_MIN_CADENCE_SEC;
  return Math.floor(n);
}

/**
 * Append an item to a collection watcher's `state.items`. Returns
 * { added: bool, item } — `added: false` means an item with the same `id` was
 * already present (the existing item is left untouched). Persists on add.
 */
export function addCollectionItem(userId, ref, item) {
  if (!item || typeof item !== 'object' || !item.id) {
    throw new Error('addCollectionItem: item.id required');
  }
  const w = _findCollectionWatcher(userId, ref);
  if (!w) return { added: false, item: null, error: 'collection watcher not found' };
  const items = w.state.items ||= [];
  if (items.some(x => x.id === item.id)) {
    return { added: false, item: items.find(x => x.id === item.id) };
  }
  const normalized = {
    ...item,
    cadenceSec: _normalizeCadence(item.cadenceSec),
    // First tick: due immediately so the user sees feedback on the next sweep
    // instead of waiting a full cadence period for the first poll.
    nextDueAt: 0,
    addedAt: Date.now(),
  };
  items.push(normalized);
  persistUser(userId);
  return { added: true, item: normalized };
}

/**
 * Remove an item by id. If the collection becomes empty, the parent watcher
 * is left in place (skill may add more later). Pass `{ finalizeIfEmpty: true }`
 * to instead cancel the parent on empty.
 */
export function removeCollectionItem(userId, ref, itemId, opts = {}) {
  const w = _findCollectionWatcher(userId, ref);
  if (!w) return { removed: false, error: 'collection watcher not found' };
  const items = w.state.items || [];
  const idx = items.findIndex(x => x.id === itemId);
  if (idx < 0) return { removed: false };
  items.splice(idx, 1);
  persistUser(userId);
  if (opts.finalizeIfEmpty && !items.length) {
    unregisterWatcher(userId, w.id, 'cancelled');
  }
  return { removed: true };
}

/**
 * Patch an item in place. `patch` is shallow-merged; passing `cadenceSec`
 * resets `nextDueAt = now` so the new cadence applies on the very next
 * supervisor sweep instead of waiting out the old cadence. Reserved fields
 * (`id`, `addedAt`) are ignored.
 */
export function updateCollectionItem(userId, ref, itemId, patch) {
  const w = _findCollectionWatcher(userId, ref);
  if (!w) return { updated: false, error: 'collection watcher not found' };
  const items = w.state.items || [];
  const it = items.find(x => x.id === itemId);
  if (!it) return { updated: false };
  const { id: _ignore1, addedAt: _ignore2, ...rest } = patch || {};
  Object.assign(it, rest);
  if (Object.prototype.hasOwnProperty.call(rest, 'cadenceSec')) {
    it.cadenceSec = _normalizeCadence(it.cadenceSec);
    it.nextDueAt = 0;
  }
  persistUser(userId);
  return { updated: true, item: it };
}

/**
 * Return the full items array (or null if no collection watcher found).
 * Caller treats result as read-only — mutating returned objects bypasses
 * persistence.
 */
export function listCollectionItems(userId, ref) {
  const w = _findCollectionWatcher(userId, ref);
  if (!w) return null;
  return [...(w.state.items || [])];
}

export function getCollectionItem(userId, ref, itemId) {
  const items = listCollectionItems(userId, ref);
  if (!items) return null;
  return items.find(x => x.id === itemId) ?? null;
}

/**
 * Enumerate every collection watcher for this user, optionally filtered by
 * (skillId, kind). Returns `[{ watcherId, skillId, kind, label, items }, …]`.
 * Used by the generic `list_watch_items` tool.
 */
export function listAllCollections(userId, filter = {}) {
  const data = loadUserWatchers(userId);
  if (!data) return [];
  return data.active
    .filter(w =>
      Array.isArray(w?.state?.items) &&
      (!filter.skillId || (w.skillId || null) === filter.skillId) &&
      (!filter.kind || w.kind === filter.kind),
    )
    .map(w => ({
      watcherId: w.id,
      skillId: w.skillId || null,
      kind: w.kind,
      label: w.label,
      items: [...(w.state.items || [])],
    }));
}

export function unregisterWatcher(userId, watcherId, reason = 'cancelled') {
  const data = loadUserWatchers(userId);
  const idx = data.active.findIndex(w => w.id === watcherId);
  if (idx < 0) return false;
  const w = data.active.splice(idx, 1)[0];
  if (w.kind === 'event_subscription') unsubscribeFromEvent(w);
  w.status = reason;
  w.endedAt = Date.now();
  data.recent.unshift(w);
  data.recent = data.recent.slice(0, 20);
  persistUser(userId);
  return true;
}

/**
 * Push a status update to a watcher from OUTSIDE a handler tick. Used by
 * detached workers (background-tasks.mjs etc) that drive their own watcher's
 * state. Mirrors the postStatus helper but callable from any context.
 *
 * Caller passes optional `extraState` (merged into state) plus the text. The
 * watcher's history is appended and a WS status event is broadcast to all
 * tabs. No-op if the watcher doesn't exist.
 */
export function pushWatcherStatus(userId, watcherId, text, extraState = null) {
  const data = _byUser.get(userId);
  if (!data) return false;
  const record = data.active.find(w => w.id === watcherId);
  if (!record) return false;
  if (extraState && typeof extraState === 'object') {
    record.state = { ...(record.state || {}), ...extraState };
  }
  if (record.state) record.state.lastActivityAt = Date.now();
  if (text && text !== record.lastStatusText) {
    record.lastStatusText = text;
    record.lastChangeAt = Date.now();
    pushHistory(record, { text, ts: Date.now() });
    _sendStatusFn?.(userId, watcherStatusPayload(record, text));
  }
  persistUser(userId);
  return true;
}

/**
 * Finalize a watcher as done/error from outside a handler. Same shape as
 * the internal finalizeWatcher but callable from background-tasks etc.
 */
export function completeWatcher(userId, watcherId, { status = 'done', finalText = '' } = {}) {
  const data = _byUser.get(userId);
  if (!data) return false;
  const record = data.active.find(w => w.id === watcherId);
  if (!record) return false;
  finalizeWatcher(record, status, finalText || record.lastStatusText || `${record.label} ${status}`);
  return true;
}

export function listWatchers(userId) {
  const data = loadUserWatchers(userId);
  // Drop recent entries older than 1h before returning.
  const cutoff = Date.now() - RECENT_KEEP_MS;
  data.recent = data.recent.filter(w => (w.endedAt || 0) > cutoff);
  // Strip per-watcher history from the list payload — it's potentially large
  // and only needed when the user expands a single bubble. The per-id GET
  // (getWatcher) returns the full record including history.
  const stripHistory = (w) => ({ ...w, history: undefined, historyLen: w.history?.length || 0 });
  return {
    active: data.active.map(stripHistory),
    recent: data.recent.map(stripHistory),
  };
}

// Single-watcher fetch — used by the chat bubble's click-to-expand history.
// Searches both active and recent so a finished bubble can still be opened
// while the watcher is in the 1h reap window.
export function getWatcher(userId, watcherId) {
  const data = loadUserWatchers(userId);
  return (
    data.active.find(w => w.id === watcherId) ||
    data.recent.find(w => w.id === watcherId) ||
    null
  );
}

export function patchWatcher(userId, watcherId, patch) {
  const data = loadUserWatchers(userId);
  const w = data.active.find(x => x.id === watcherId);
  if (!w) return false;
  // Only allow user-mutable fields. Everything else is supervisor-managed.
  if (patch.expiresAt !== undefined) {
    w.expiresAt = patch.expiresAt === null ? null : Math.max(Date.now() + 60_000, Number(patch.expiresAt));
  }
  if (patch.cadenceSec !== undefined) {
    w.cadenceSec = Math.max(5, Number(patch.cadenceSec));
  }
  if (patch.label !== undefined) w.label = String(patch.label);
  persistUser(userId);
  return true;
}

// ── handler resolution ───────────────────────────────────────────────────────
//
// Handlers live on the owning skill's executor under `watcherHandlers`. Same
// lazy-import path the role tool dispatcher uses.

async function resolveHandler(record) {
  const { skillId } = record;
  if (!skillId) {
    // No owning skill; this watcher came from the system layer.
    return _systemHandlers.get(record.kind) || null;
  }
  try {
    const { getWatcherHandler } = await import('../roles.mjs');
    return await getWatcherHandler(skillId, record.userId, record.kind);
  } catch (e) {
    log.warn('watchers', 'Failed to resolve handler', { skillId, kind: record.kind, err: e.message });
    return null;
  }
}

const _systemHandlers = new Map();
export function registerSystemWatcherHandler(kind, fn) {
  _systemHandlers.set(kind, fn);
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

function subscribeToEvent(record) {
  const ev = eventKey(record);
  if (!ev) return;
  if (!_eventListeners.has(record.userId)) _eventListeners.set(record.userId, new Map());
  const userMap = _eventListeners.get(record.userId);
  if (!userMap.has(ev)) userMap.set(ev, new Set());
  userMap.get(ev).add(record.id);
}

function unsubscribeFromEvent(record) {
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
  const data = _byUser.get(userId);
  if (!data) return 0;
  let matched = 0;
  for (const wid of watcherIds) {
    const w = data.active.find(x => x.id === wid);
    if (!w) continue;
    w.state = { ...w.state, lastEventPayload: payload, lastEventAt: Date.now() };
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
async function eventSubscriptionHandler(state) {
  const { event, predicate } = state || {};
  if (!event) return { done: true, textUpdate: '❌ event watcher missing event name' };
  if (state.lastEventAt === undefined) {
    return {}; // waiting for first event
  }
  // Each event fires the handler once. Mark consumed by clearing lastEventAt
  // so a subsequent supervisor sweep doesn't re-evaluate the same payload.
  const payload = state.lastEventPayload;
  const consumedState = { ...state, lastEventAt: undefined, lastEventPayload: undefined };

  if (predicate) {
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
    if (!hit) {
      return { newState: consumedState }; // event came but didn't match
    }
  }
  return { done: true, textUpdate: `🔔 event "${event}" fired` };
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
_systemHandlers.set('event_subscription', eventSubscriptionHandler);

// task_proxy: state-container for in-flight background-agent runs (Phase 14).
// The actual work runs in a detached promise outside this loop. The handler
// here is a heartbeat — every tick, check whether the underlying task has
// gone silent (no activity in 5min) and flip to failed. That's the third
// crash-detection layer (the first two are promise-catch + boot-reap).
const TASK_PROXY_SILENCE_MS = 5 * 60 * 1000;
const TASK_PROXY_NUDGE_MS = 60 * 60 * 1000;   // 1h re-broadcast when awaiting input
function taskProxyHandler(state, helpers) {
  // Phase-14d: awaiting_input watchers sit indefinitely, but periodically
  // re-broadcast the question so a forgotten chip surfaces again.
  if (state?.awaiting_input) {
    const lastNudge = state.lastNudgeAt || state.questionPostedAt || state.lastActivityAt || 0;
    if (lastNudge && Date.now() - lastNudge > TASK_PROXY_NUDGE_MS) {
      const question = state.pending_question || 'a question';
      return {
        newState: { ...state, lastNudgeAt: Date.now() },
        textUpdate: `⏳ Still waiting on your reply: ${question}`,
      };
    }
    return { newState: state };
  }
  if (state?.completed) return { newState: state, done: true };
  const lastActivity = state?.lastActivityAt || state?.startedAt || 0;
  if (lastActivity && Date.now() - lastActivity > TASK_PROXY_SILENCE_MS) {
    return {
      newState: { ...state, failed: true, failureReason: 'no progress in 5min — may have crashed' },
      textUpdate: `⚠ Task went silent for >5 min: ${state.label || state.targetAgentName || 'unknown task'}`,
      done: true,
    };
  }
  return { newState: state };   // benign heartbeat tick
}
_systemHandlers.set('task_proxy', taskProxyHandler);

// Fire a CUSTOM skill's watcher handler INSIDE the bwrap jail. The handler's
// helpers.* calls come back as `helper.<m>` RPCs, which we service with the REAL
// handlerHelpers(record) bound to this process — so fire/postStatus/notify/etc.
// keep their full behaviour, but the skill's own handler code (the fetch/compare
// logic) never runs in-process. Returns { ok, result } where result is the
// serializable { newState, textUpdate, done, … } the supervisor already expects.
export async function runCustomWatcherSandboxed(record) {
  const realHelpers = handlerHelpers(record);
  const handleRpc = async (method, args) => {
    if (typeof method !== 'string' || !method.startsWith('helper.')) throw new Error(`watcher rpc not allowed: ${method}`);
    const fn = realHelpers[method.slice(7)];
    if (typeof fn !== 'function') throw new Error(`helper.${method.slice(7)} is not available to sandboxed watchers`);
    return await fn(...(Array.isArray(args) ? args : [args]));
  };
  const { runSandboxedJob, customSkillBindings } = await import('../lib/skill-subprocess.mjs');
  const { execPath } = customSkillBindings(record.userId, record.skillId);
  const jobPayload = {
    t: 'job', mode: 'watcher', skillExecPath: execPath, kind: record.kind,
    state: record.state, userId: record.userId, agentId: record.agentId, watcherId: record.id,
  };
  return runSandboxedJob({ userId: record.userId, skillId: record.skillId, jobPayload, handleRpc, net: true, timeoutMs: 120_000 });
}

// ── supervisor loop ──────────────────────────────────────────────────────────

async function tickOne(record) {
  const inFlightKey = `${record.userId}:${record.id}`;
  if (_inFlight.has(inFlightKey)) return; // previous tick still running
  _inFlight.add(inFlightKey);

  try {
    // Expiry check — only if not indefinite.
    if (record.expiresAt !== null && Date.now() > record.expiresAt) {
      finalizeWatcher(record, 'expired', `⏰ Monitor expired without completing.`);
      return;
    }

    // Shared failure handling: bump the counter, finalize at the cap, otherwise
    // back off one cadence. `msg` is only surfaced when we actually finalize.
    const failTick = (msg) => {
      record.failures++;
      if (record.failures >= MAX_FAILURES) finalizeWatcher(record, 'error', msg);
      else { record.nextTickAt = Date.now() + record.cadenceSec * 1000; persistUser(record.userId); }
    };

    // Custom (user-authored) skills fire their handler INSIDE the jail so a
    // watcher tick can't reach other users' data / secrets — same boundary as
    // their tool calls. Global + system handlers stay in-process.
    let result;
    let sandboxed = false;
    if (record.skillId) {
      try { const { isSandboxedSkill } = await import('../roles.mjs'); sandboxed = isSandboxedSkill(record.skillId, record.userId); }
      catch { sandboxed = false; }
    }
    if (sandboxed) {
      let sres;
      try { sres = await runCustomWatcherSandboxed(record); }
      catch (e) { log.warn('watchers', 'Sandboxed handler error', { kind: record.kind, err: e.message }); failTick(`❌ ${record.label}: sandboxed handler error — ${e.message}`); return; }
      if (!sres.ok) { const serr = /** @type {any} */ (sres).error; log.warn('watchers', 'Sandboxed handler failed', { kind: record.kind, err: serr }); failTick(`❌ ${record.label}: sandboxed handler failed ${MAX_FAILURES}× — ${serr}`); return; }
      result = sres.result;
    } else {
      const handler = await resolveHandler(record);
      if (!handler) {
        log.warn('watchers', 'Handler not found', { kind: record.kind, skillId: record.skillId });
        failTick(`❌ No handler registered for kind=${record.kind}.`);
        return;
      }
      try {
        result = await handler(record.state, handlerHelpers(record));
      } catch (e) {
        log.warn('watchers', 'Handler threw', { kind: record.kind, err: e.message });
        failTick(`❌ ${record.label}: handler failed ${MAX_FAILURES}× — ${e.message}`);
        return;
      }
    }

    record.failures = 0;
    record.ticks++;
    record.lastTickAt = Date.now();

    if (result && typeof result === 'object') {
      if (result.newState !== undefined) {
        record.state = result.newState;
      }
      if (result.extendExpiryBy && record.expiresAt !== null) {
        record.expiresAt = (record.expiresAt || Date.now()) + Number(result.extendExpiryBy);
      }
      if (result.nextCadenceSec) {
        record.cadenceSec = Math.max(5, Number(result.nextCadenceSec));
      }
      if (result.textUpdate) {
        // Dedup consecutive identical updates so the chat doesn't fill with
        // the same line tick after tick. lastChangeAt tracks visible-text
        // changes specifically — that's the signal stuck-detection uses,
        // since handlers may update lastValue cosmetically every tick.
        if (result.textUpdate !== record.lastStatusText) {
          record.lastStatusText = result.textUpdate;
          record.lastChangeAt = Date.now();
          record.stuckAnnounced = false;
          record.stuckSinceAt = null;
          pushHistory(record, { text: result.textUpdate, ts: Date.now() });
          if (_sendStatusFn) {
            _sendStatusFn(record.userId, {
              type: 'status',
              agent: record.agentId,
              watcherId: record.id,
              kind: record.kind,
              label: record.label,
              text: result.textUpdate,
              ts: Date.now(),
            });
          }
        }
      }
      if (result.done) {
        finalizeWatcher(record, 'done', result.textUpdate || `✓ ${record.label} done.`);
        return;
      }
    }

    // Stuck detection — fire a synthetic status when N×cadence elapses with
    // no visible change, then back off noisy polling up to a cap. Don't reap;
    // long-running things like price alerts genuinely sit unchanged for hours.
    // The user can read the annotation/status and decide whether to cancel.
    const sinceChange = Date.now() - record.lastChangeAt;
    const stuckThresholdMs = STUCK_RATIO * record.cadenceSec * 1000;
    // Health watchers are silent when everything is healthy ("no news is good
    // news") — they only emit a textUpdate on a transition. Treating that
    // steady state as "stuck" fires a false "may be stuck" alert and halves the
    // check cadence on a perfectly healthy host, so exempt them.
    const stuckEligible = record.kind !== 'profile_health';
    if (stuckEligible && !record.stuckAnnounced && sinceChange > stuckThresholdMs) {
      record.stuckAnnounced = true;
      record.stuckSinceAt = record.stuckSinceAt || Date.now();
      record.stuckRecoveryCount = Number(record.stuckRecoveryCount || 0) + 1;
      const oldCadence = record.cadenceSec;
      record.cadenceSec = Math.min(STUCK_BACKOFF_MAX_SEC, Math.max(record.cadenceSec, record.cadenceSec * 2));
      const minutes = Math.round(sinceChange / 60_000);
      const backoffText = record.cadenceSec !== oldCadence ? `; backing off checks to every ${record.cadenceSec}s` : '';
      const stuckText = `${record.lastStatusText || record.label} — no change for ${minutes} min, may be stuck${backoffText}`;
      pushHistory(record, { text: stuckText, ts: Date.now(), stuck: true });
      if (_sendStatusFn) {
        _sendStatusFn(record.userId, {
          type: 'status',
          agent: record.agentId,
          watcherId: record.id,
          kind: record.kind,
          label: record.label,
          text: stuckText,
          ts: Date.now(),
          stuck: true,
        });
      }
    }

    record.nextTickAt = Date.now() + record.cadenceSec * 1000;
    persistUser(record.userId);
  } finally {
    _inFlight.delete(inFlightKey);
  }
}

function pushHistory(record, entry) {
  if (!Array.isArray(record.history)) record.history = [];
  record.history.push(entry);
  if (record.history.length > MAX_HISTORY_ENTRIES) {
    record.history = record.history.slice(-MAX_HISTORY_ENTRIES);
  }
}

function watcherStatusPayload(record, text, extra = {}) {
  return {
    type: 'status',
    agent: record.agentId,
    watcherId: record.id,
    kind: record.kind,
    label: record.label,
    text,
    ts: Date.now(),
    state: record.state || {},
    recentHistory: Array.isArray(record.history) ? record.history.slice(-5) : [],
    awaiting_input: record.state?.awaiting_input || false,
    pending_question: record.state?.pending_question || null,
    ...extra,
  };
}

function finalizeWatcher(record, status, finalText) {
  const data = _byUser.get(record.userId);
  if (!data) return;
  const idx = data.active.findIndex(w => w.id === record.id);
  if (idx >= 0) data.active.splice(idx, 1);
  if (record.kind === 'event_subscription') unsubscribeFromEvent(record);
  record.status = status;
  record.endedAt = Date.now();
  record.lastStatusText = finalText || record.lastStatusText;
  if (finalText) {
    const last = record.history?.[record.history.length - 1];
    if (!last || last.text !== finalText) {
      pushHistory(record, { text: finalText, ts: Date.now(), final: true, finalStatus: status });
    } else {
      // Annotate the existing tail as the final entry so the scrollback shows
      // which line ended the run.
      last.final = true; last.finalStatus = status;
    }
  }
  data.recent.unshift(record);
  data.recent = data.recent.slice(0, 20);
  persistUser(record.userId);
  if (_sendStatusFn && finalText) {
    _sendStatusFn(record.userId, watcherStatusPayload(record, finalText, {
      final: true,
      finalStatus: status,
    }));
  }
  // Only fire the chained action on a successful predicate hit. Errors,
  // expiries, and user-cancellations should not auto-run an agent — that
  // would burn cloud tokens on a state the user didn't intend to act on.
  if (status === 'done' && record.onFire && record.onFire.type && record.onFire.type !== 'notify') {
    executeOnFire(record).catch(e =>
      log.warn('watchers', 'on_fire failed', { id: record.id, type: record.onFire?.type, err: e.message })
    );
  }
}

// Minimal HTML→text for the plain-text alternative part when a handler fires
// an HTML-only email body (helpers.fire({ html })). Not a sanitizer — just
// enough to give clients without HTML rendering, and the chat/tasks-drawer
// status bubble, a readable fallback.
function stripHtml(html) {
  return String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/tr|\/h[1-6]|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || 'New update.';
}

// Run the watcher's onFire action. The supported shapes are:
//
//   { type: 'notify' }                 — status bubble only (default; not handled here)
//   { type: 'agent', prompt? }         — kick off an agent run on the watcher's
//                                        owning agentId, with an injected
//                                        [WATCHER FIRED] system note that
//                                        explains the trigger and tells the
//                                        agent to act, not ask.
//
// agentId on the watcher record is the WS-scoped sessionKey (e.g.
// "user_<uid>_coordinator"). We need the unscoped registry id to resolve
// the agent, then re-scope for streaming. The systemNote pattern mirrors
// scheduler.mjs's [SCHEDULED RUN] note — same constraint (no human present).
async function executeOnFire(record) {
  const cfg = record.onFire;
  if (!cfg) return;

  // ── Email delivery — no LLM, no agent turn ───────────────────────────────
  // cfg shape: { type: 'email', subject?, to?, account?, _html? }
  // body is the watcher's lastStatusText (or label as fallback). When the
  // handler fired with an HTML body (helpers.fire({ html })), `_html` carries
  // the rich part; `body` is the plain-text alternative (auto-derived from the
  // HTML when the handler didn't pass a separate message).
  if (cfg.type === 'email') {
    try {
      const { sendEmailToUser } = await import('../lib/email-delivery.mjs');
      const subject = cfg.subject || `Monitor: ${record.label}`;
      const html    = cfg._html || record.lastStatusHtml || undefined;
      const body    = record.lastStatusText || (html ? stripHtml(html) : null) || `Your monitor "${record.label}" fired.`;
      const r = await sendEmailToUser(record.userId, {
        subject, body, html, to: cfg.to, account: cfg.account,
      });
      if (!r.ok) log.warn('watchers', 'email onFire failed', { id: record.id, err: r.message });
      else log.info('watchers', 'email onFire sent', { id: record.id, to: cfg.to || '(self)' });
    } catch (e) {
      log.warn('watchers', 'email onFire threw', { id: record.id, err: e.message });
    }
    return;
  }

  // ── Telegram delivery — no LLM, no agent turn ────────────────────────────
  // cfg shape: { type: 'telegram', prefix? }
  // text = (cfg.prefix ?? '') + record.lastStatusText (or label as fallback).
  if (cfg.type === 'telegram') {
    try {
      const { sendTelegramToUser } = await import('../routes/telegram.mjs');
      const body = record.lastStatusText || `Your monitor "${record.label}" fired.`;
      const text = cfg.prefix ? `${cfg.prefix}\n\n${body}` : body;
      const ok = await sendTelegramToUser(record.userId, text);
      if (!ok) log.warn('watchers', 'telegram onFire failed', { id: record.id });
      else log.info('watchers', 'telegram onFire sent', { id: record.id });
    } catch (e) {
      log.warn('watchers', 'telegram onFire threw', { id: record.id, err: e.message });
    }
    return;
  }

  if (cfg.type !== 'agent') return;

  const { getAgent } = await import('../agents.mjs');
  const { streamChat } = await import('../chat.mjs');
  const { appendToSession } = await import('../sessions.mjs');
  const { getAgentsForUser, getUser } = await import('../routes/_helpers.mjs');
  const { runAgentWithRetry } = await import('../lib/run-agent-with-retry.mjs');

  const userId = record.userId;
  const scoped = record.agentId || '';
  const rawAgentId = scoped.startsWith(`${userId}_`) ? scoped.slice(userId.length + 1) : scoped;
  if (!rawAgentId) {
    log.warn('watchers', 'on_fire: no agent id on record', { id: record.id });
    return;
  }

  const isChild = getUser(userId)?.role === 'child';
  const resolved = getAgentsForUser(userId).find(a => a.id === rawAgentId)
    ?? (isChild ? null : getAgent(rawAgentId));
  if (!resolved) {
    log.warn('watchers', 'on_fire: agent not resolvable', { id: record.id, agentId: rawAgentId });
    return;
  }

  const sessionKey = `${userId}_${resolved.id}`;
  const scopedAgent = { ...resolved, id: sessionKey };

  const fireText = record.lastStatusText || `Watch "${record.label}" fired.`;
  const userPrompt = (cfg.prompt && String(cfg.prompt).trim())
    || `The watch you set ("${record.label}") just fired: ${fireText}. Act on this now.`;

  appendToSession(sessionKey, {
    role: 'system',
    content: `[Watcher fired] ${record.label} — ${fireText}`,
    watcherId: record.id,
    ts: Date.now(),
  });

  const watcherNote =
    `[WATCHER FIRED] You are reacting to a condition-triggered monitor that just fired. ` +
    `The user is NOT present. The watch label is "${record.label}" and its result is: ${fireText}. ` +
    `Use any ask_agent / tools needed and complete the action directly — do NOT show a draft, ask "are you sure?", or wait for confirmation. ` +
    `Report what you did in your final message.`;

  log.info('watchers', 'on_fire agent run', { id: record.id, agentId: sessionKey });

  // Retry on stream errors, fetch throws, and LoopGuard stalls — all surfaced
  // through the shared helper. Single attempt by default keeps the previous
  // single-shot behavior; bump if a watcher class proves to need more.
  const { succeeded, lastError } = await runAgentWithRetry({
    scopedAgent, userText: userPrompt, systemNote: watcherNote, userId, streamChat,
    maxAttempts: 1,
    context: 'watchers',
  });

  if (!succeeded) {
    log.warn('watchers', 'on_fire run failed', { id: record.id, err: lastError });
    // Append a visible message to the session so the user sees something under
    // the [Watcher fired] header instead of a bare trigger with no follow-up.
    // Same role:'assistant' shape the scheduler uses for failed scheduled tasks.
    try {
      appendToSession(sessionKey, {
        role: 'assistant',
        content: `⚠️ Watcher fired but the agent's response failed: ${lastError || 'unknown error'}.`,
        watcherId: record.id,
        watcherFailed: true,
        ts: Date.now(),
      });
    } catch (e) {
      log.warn('watchers', 'on_fire failure-message append threw', { id: record.id, err: e.message });
    }
    // Surface as a status bubble too — the watcher itself already finalized
    // 'done' (predicate hit), so the user has a green check next to a failed
    // chained run unless we say otherwise.
    _sendStatusFn?.(record.userId, {
      type: 'status',
      agent: record.agentId,
      watcherId: record.id,
      kind: record.kind,
      label: record.label,
      text: `⚠️ Agent run after watcher fired failed: ${lastError || 'unknown error'}`,
      ts: Date.now(),
      onFireFailed: true,
    });
  }

  // Tell the user's connected client to reload the agent session so the
  // streamed turns become visible. Without this, the UI keeps showing the
  // pre-fire state and the user sees the trigger bubble but not the agent
  // response — same shape as scheduled tasks broadcasting task_complete.
  // Fires on both success and failure so the failure message above renders.
  _sendStatusFn?.(record.userId, {
    type: 'task_complete',
    taskId: `watcher_${record.id}`,
    agent: resolved.id,
  });
}

// Bulk-cancel watchers matching a predicate. Returns the count cancelled.
// Used by skills that explicitly tear down the resource a watcher polls
// (e.g. runpod_terminate_pod) so the chat doesn't keep showing "still
// rendering" for a job the user just killed.
export function unregisterMatchingWatchers(userId, predicate, reason = 'cancelled') {
  if (!userId || typeof predicate !== 'function') return 0;
  const data = loadUserWatchers(userId);
  const remaining = [];
  let cancelled = 0;
  for (const w of data.active) {
    let match = false;
    try { match = !!predicate(w); } catch { match = false; }
    if (match) {
      if (w.kind === 'event_subscription') unsubscribeFromEvent(w);
      w.status = reason;
      w.endedAt = Date.now();
      data.recent.unshift(w);
      cancelled++;
    } else {
      remaining.push(w);
    }
  }
  if (cancelled === 0) return 0;
  data.active = remaining;
  data.recent = data.recent.slice(0, 20);
  persistUser(userId);
  return cancelled;
}

// Construct a one-shot onFire config for a per-item delivery override. Used
// by helpers.fire when state.items[].deliver disagrees with the watcher's
// stored onFire — e.g. one channel in a YouTube collection set to 'email'
// while the rest stay 'agent'. Caller's explicit `deliver` arg flows through
// the same path.
function _onFireForDeliver(deliver, record) {
  switch (deliver) {
    case 'agent':
      return { type: 'agent', prompt: `A monitor you set up fired (${record.label || record.kind}). Summarize the change in one or two sentences.` };
    case 'email':
      return { type: 'email', subject: `Monitor: ${record.label || record.kind}` };
    case 'telegram':
      return { type: 'telegram' };
    case 'notify':
      return { type: 'notify' };
    default:
      return record.onFire || null;
  }
}

export function handlerHelpers(record) {
  // ctx.browser shorthand for watcher handlers — same primitives the
  // skill-side ctx.browser exposes, bound to record.userId. Lets a
  // collection-watcher handler use the user's connected browser as its
  // fetcher (Best Buy stock pages, sites without RSS / public APIs, etc.).
  // Lazy-imported so watchers that don't touch the browser pay nothing.
  let _browserCache = null;
  async function getBrowser() {
    if (_browserCache) return _browserCache;
    const { buildBrowserHelpers } = await import('../lib/browser-helper.mjs');
    _browserCache = buildBrowserHelpers({ userId: record.userId, agentId: record.agentId });
    return _browserCache;
  }
  const browser = {
    list:         (...a) => getBrowser().then(b => b.list(...a)),
    openTab:      (...a) => getBrowser().then(b => b.openTab(...a)),
    readPage:     (...a) => getBrowser().then(b => b.readPage(...a)),
    mediaControl: (...a) => getBrowser().then(b => b.mediaControl(...a)),
    closeTab:     (...a) => getBrowser().then(b => b.closeTab(...a)),
    focusTab:     (...a) => getBrowser().then(b => b.focusTab(...a)),
    back:         (...a) => getBrowser().then(b => b.back(...a)),
    forward:      (...a) => getBrowser().then(b => b.forward(...a)),
    reload:       (...a) => getBrowser().then(b => b.reload(...a)),
    focusWindow:  (...a) => getBrowser().then(b => b.focusWindow(...a)),
    screenshot:   (...a) => getBrowser().then(b => b.screenshot(...a)),
    clickXY:      (...a) => getBrowser().then(b => b.clickXY(...a)),
    type:         (...a) => getBrowser().then(b => b.type(...a)),
    keypress:     (...a) => getBrowser().then(b => b.keypress(...a)),
  };
  // Sandboxed binary runtime for watcher handlers — the same capability a
  // skill's tool ctx gets (roles.mjs buildCtx), so a handler can run an
  // already-provisioned binary (e.g. yt-dlp) on its tick. Scoped to the
  // watcher's OWNING skill dir. Unlike the tool-ctx version there's no human on
  // a tick, so ensureRuntime NEVER prompts to download — it resolves a binary
  // provisioned earlier at tool time and throws if missing. hasRuntime() in
  // skill code gates on both fns being present.
  const _skillDir = (() => {
    if (!record.skillId) return null;
    const ud = path.join(userSkillsDir(record.userId), record.skillId);
    if (fs.existsSync(ud)) return ud;
    const bd = path.join(SKILLS_DIR, record.skillId);
    return fs.existsSync(bd) ? bd : null;
  })();
  const runtimeHelpers = _skillDir ? {
    /** @param {{ name?: string }} [opts] */
    ensureRuntime: async ({ name } = {}) => {
      if (!name) throw new Error('ensureRuntime: { name } required');
      const rt = await import('../lib/skill-runtime.mjs');
      const existing = rt.resolveSkillBinary(_skillDir, name);
      if (existing) return existing;
      throw new Error(`ensureRuntime: "${name}" is not provisioned for skill "${record.skillId}" — run it once via the skill's own tools first; watcher ticks cannot download binaries.`);
    },
    runSandboxed: async (bin, binArgs = [], opts = {}) => {
      const sb = await import('../lib/skill-sandbox.mjs');
      const roDirs = [_skillDir, ...(opts.roDirs || [])].filter(Boolean);
      return sb.runSandboxed(bin, binArgs, { ...opts, roDirs });
    },
  } : {};
  return {
    userId: record.userId,
    agentId: record.agentId,
    watcherId: record.id,
    ...runtimeHelpers,
    browser,
    showImage: async (img) => _showImageFn?.(record.userId, { ...img, agent: record.agentId }),
    showVideo: async (vid) => _showVideoFn?.(record.userId, { ...vid, agent: record.agentId }),
    postStatus: (text) => {
      if (text === record.lastStatusText) return;
      record.lastStatusText = text;
      pushHistory(record, { text, ts: Date.now() });
      _sendStatusFn?.(record.userId, {
        type: 'status', agent: record.agentId, watcherId: record.id,
        kind: record.kind, label: record.label, text, ts: Date.now(),
      });
    },
    // Send a real notification (toast + persisted in agent session). Use for
    // events that warrant the user's attention NOW even with the chat closed —
    // a service going down, a deploy failing, a deadline missed. Routine
    // progress updates should use postStatus instead.
    notify: (content, opts = {}) => {
      const ts = Date.now();
      const fromName = opts.from || record.label || record.kind;
      _sendNotificationFn?.(record.userId, {
        type: 'agent_notification',
        agent: record.agentId,
        content,
        from: { userName: fromName },
        event: opts.event || record.kind,
        data: opts.data || {},
        ts,
      });
    },
    // Trigger this watcher's onFire delivery WITHOUT finalising the watcher.
    // Use when the watcher should keep polling after delivering a notification
    // (channel feeds, recurring deal alerts) — returning done=true would
    // archive the record and only fire onFire once. Dispatches based on
    // record.onFire.type so handlers stay delivery-agnostic: a channel
    // watcher registered with deliver='email' emails the user; the SAME
    // handler registered with deliver='agent' runs an agent turn.
    //
    // Two call shapes:
    //   fire('message string')   — legacy, watcher-level onFire only.
    //   fire({ message, subject, html, telegramPrefix, itemKey, deliver })
    //                            — object form. For deliver='email', `html`
    //                            sends a rich HTML body (multipart/alternative;
    //                            `message` becomes the plain-text part, or it's
    //                            auto-derived from `html`), and `subject`
    //                            overrides the registered subject per fire.
    //                            For collection watchers, pass
    //                            `itemKey` so an item-level `deliver` override
    //                            (from state.items[].deliver) wins over the
    //                            watcher-level setting; pass `deliver` to force
    //                            a delivery mode for this one fire (used by
    //                            handlers that want one item to email even
    //                            though the watcher defaults to agent).
    //
    // For 'agent': message → prompt. For 'email': message → body, subject
    // overrides default. For 'telegram': message → body, telegramPrefix
    // overrides default.
    fire: async (arg) => {
      const isObj = arg && typeof arg === 'object';
      const message    = isObj ? arg.message        : arg;
      const subject    = isObj ? arg.subject        : null;
      const html       = isObj ? arg.html           : null;
      const tgPrefix   = isObj ? arg.telegramPrefix : null;
      const itemKey    = isObj ? arg.itemKey        : null;
      let   forceDeliv = isObj ? arg.deliver        : null;

      // Per-item delivery override (collection mode): if the caller passed
      // itemKey AND that item carries its own `deliver`, that wins. Caller's
      // explicit `deliver` still beats item-level — explicit > item > watcher.
      if (!forceDeliv && itemKey && Array.isArray(record?.state?.items)) {
        const it = record.state.items.find(x => x.id === itemKey);
        if (it && typeof it.deliver === 'string') forceDeliv = it.deliver;
      }

      const baseCfg = forceDeliv ? _onFireForDeliver(forceDeliv, record) : record.onFire;
      if (!baseCfg?.type) return false;

      let tempCfg = baseCfg;
      if (message) {
        if (baseCfg.type === 'agent')         tempCfg = { ...baseCfg, prompt: message };
        else if (baseCfg.type === 'email')    tempCfg = { ...baseCfg, _bodyOverride: message, ...(subject ? { subject } : {}) };
        else if (baseCfg.type === 'telegram') tempCfg = { ...baseCfg, ...(tgPrefix ? { prefix: tgPrefix } : {}) };
      }
      // An HTML body and/or a per-fire subject can be supplied even without a
      // plaintext message — executeOnFire reads `_html` for the rich part and
      // falls back to a stripped-to-text version for the plain alternative.
      if (baseCfg.type === 'email' && (html || subject)) {
        tempCfg = { ...tempCfg, ...(subject ? { subject } : {}), ...(html ? { _html: html } : {}) };
      }
      const synth = { ...record, onFire: tempCfg };
      // executeOnFire's email/telegram branches read lastStatusText for the
      // body; surface the override through there so the handler doesn't have
      // to mutate persisted state.
      if (message && (baseCfg.type === 'email' || baseCfg.type === 'telegram')) {
        synth.lastStatusText = message;
      } else if (baseCfg.type === 'email' && html) {
        synth.lastStatusText = stripHtml(html);
      }
      try {
        await executeOnFire(synth);
        return true;
      } catch (e) {
        log.warn('watchers', 'fire threw', { id: record.id, err: e.message });
        return false;
      }
    },
    // Bounded-parallel map over an array. Used by collection-watcher handlers
    // to process due items without serializing N HTTP fetches (which would
    // blow the supervisor's per-tick budget at high item counts) and without
    // unbounded parallelism (which would melt the network on the 100-channels-
    // all-due-at-once case).
    mapItems: async (items, fn, opts = {}) => {
      const concurrency = Math.max(1, Number(opts.concurrency) || 5);
      const arr = Array.isArray(items) ? items : [];
      const results = new Array(arr.length);
      let cursor = 0;
      async function worker() {
        for (;;) {
          const i = cursor++;
          if (i >= arr.length) return;
          try { results[i] = await fn(arr[i], i); }
          catch (e) { results[i] = { _error: e?.message || String(e) }; }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, arr.length) }, worker));
      return results;
    },
    // Back-compat alias — older handlers (publix-bogo, youtube channel watch)
    // call fireAgent directly. Keep the old gate-on-agent semantics so they
    // never accidentally email when they meant to narrate.
    fireAgent: async (promptOverride) => {
      if (!record.onFire || record.onFire.type !== 'agent') return false;
      const tempCfg = promptOverride
        ? { ...record.onFire, prompt: promptOverride }
        : record.onFire;
      const synth = { ...record, onFire: tempCfg };
      try {
        await executeOnFire(synth);
        return true;
      } catch (e) {
        log.warn('watchers', 'fireAgent threw', { id: record.id, err: e.message });
        return false;
      }
    },
  };
}

async function tick() {
  if (!_running) return;
  const now = Date.now();
  for (const [userId, data] of _byUser) {
    for (const w of data.active.slice()) {
      if (w.nextTickAt > now) continue;
      // Fire and forget — tickOne guards against re-entry per-watcher.
      tickOne(w).catch(e => log.warn('watchers', 'tickOne unhandled', { id: w.id, err: e.message }));
    }
  }
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Start the supervisor. Pass it the WS push functions so handlers can post
 * status / image / video bubbles.
 *
 * @param {{
 *   sendStatus?:       (userId: string, msg: object) => void,
 *   sendNotification?: (userId: string, text: string, meta?: object) => void,
 *   showImage?:        (userId: string, url: string, meta?: object) => void,
 *   showVideo?:        (userId: string, url: string, meta?: object) => void,
 * }} [opts]
 */
export function startWatcherSupervisor({ sendStatus, sendNotification, showImage, showVideo } = {}) {
  if (_running) return;
  _sendStatusFn = sendStatus || null;
  _sendNotificationFn = sendNotification || null;
  _showImageFn = showImage || null;
  _showVideoFn = showVideo || null;
  loadAllUsersFromDisk();
  // Re-subscribe persisted event_subscription watchers to the in-process bus.
  // The bus lives only in memory, so a restart that doesn't replay this leaves
  // events firing into the void even though the watcher record on disk says
  // it's listening.
  for (const [, data] of _byUser) {
    for (const w of data.active) {
      if (w.kind === 'event_subscription') subscribeToEvent(w);
    }
  }
  _running = true;
  _timer = setInterval(tick, TICK_MS);
  const totalActive = [..._byUser.values()].reduce((n, d) => n + d.active.length, 0);
  log.info('watchers', 'Supervisor started', { tickMs: TICK_MS, activeOnBoot: totalActive });
}

export function stopWatcherSupervisor() {
  _running = false;
  if (_timer) clearInterval(_timer);
  _timer = null;
}

export function isWatcherSupervisorRunning() { return _running; }
