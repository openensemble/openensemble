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
import { buildSkillCredentials } from '../lib/credentials.mjs';
import { buildRuntimeBroker } from '../lib/skill-runtime-broker.mjs';
import { skillDeclaresNetwork } from '../lib/skill-net-policy.mjs';
import { log } from '../logger.mjs';
import { buildSkillPersonalizationHelpers } from '../lib/personalization/skill-helper.mjs';
import { getPreferenceSafeAutoContext } from '../lib/personalization/safe-auto-context.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

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
const EXTERNAL_DISPATCH_STALE_MS = 5 * 60 * 1000;

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
const _watcherLoadErrors = new Map();

// Ticks-in-flight guard so a slow handler doesn't pile up duplicate runs.
const _inFlight = new Set();
// One controller per active tick. Sandboxed custom watchers receive the signal;
// Stop/Undo can therefore terminate code and direct network activity instead of
// merely discarding a result after the process eventually returns.
const _inFlightControllers = new Map();

function abortInFlightWatcher(userId, watcherId, reason = 'watcher stopped') {
  const controller = _inFlightControllers.get(`${userId}:${watcherId}`);
  if (!controller || controller.signal.aborted) return false;
  try { controller.abort(new Error(reason)); } catch { controller.abort(); }
  return true;
}

function isSafeInformationalWatcher(record) {
  return record?.personalizationOrigin?.type === 'preference_safe_auto';
}

function isApprovedPreferenceWatcher(record) {
  return record?.personalizationOrigin?.type === 'preference_approved';
}

function isManagedPreferenceWatcher(record) {
  return isSafeInformationalWatcher(record) || isApprovedPreferenceWatcher(record);
}

function releaseApprovedPreferenceGrant(record) {
  if (!isApprovedPreferenceWatcher(record)) return;
  import('../lib/personalization/skill-preference-grants.mjs')
    .then(grants => grants.revokeSkillPreferenceGrant(record.userId, {
      skillId: record.skillId,
      preferenceMemoryId: record.personalizationOrigin?.preferenceMemoryId,
      contractFingerprint: record.personalizationOrigin?.contractFingerprint,
    }))
    .catch(e => log.warn('watchers', 'terminal approved preference grant cleanup failed', {
      id: record.id, err: e?.message || String(e),
    }));
}

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
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !Array.isArray(parsed.active) || !Array.isArray(parsed.recent)) {
        throw new Error('invalid watchers envelope');
      }
      data = {
        active: parsed.active,
        recent: parsed.recent,
      };
      _watcherLoadErrors.delete(userId);
    }
  } catch (e) {
    _watcherLoadErrors.set(userId, e instanceof Error ? e : new Error(String(e)));
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

/** Strict storage health boundary used before unattended watcher lifecycle mutations. */
export function assertWatcherStoreHealthy(userId) {
  if (!userId) throw new Error('watcher store user required');
  const p = watchersPath(userId);
  try {
    if (!fs.existsSync(p)) {
      // If an unreadable file was removed as an out-of-band repair, discard
      // the fail-closed cache that was populated while parsing failed. The
      // next access must observe the repaired (now empty) store, not stale
      // in-memory rows from before the repair.
      if (_watcherLoadErrors.has(userId)) _byUser.delete(userId);
      _watcherLoadErrors.delete(userId);
      return true;
    }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Array.isArray(parsed.active) || !Array.isArray(parsed.recent)) {
      throw new Error('invalid watchers envelope');
    }
  } catch (e) {
    _watcherLoadErrors.set(userId, e instanceof Error ? e : new Error(String(e)));
    throw new Error(`watcher store is unreadable: ${e?.message || e}`);
  }
  if (_watcherLoadErrors.has(userId)) {
    // A valid direct read means an out-of-band repair landed; refresh the
    // previously fail-closed empty cache on the next access.
    _watcherLoadErrors.delete(userId);
    _byUser.delete(userId);
  }
  return true;
}

function _writeUserNow(userId) {
  const data = _byUser.get(userId);
  if (!data) return false;
  const p = watchersPath(userId);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(p), 0o700); } catch { /* best effort */ }
    atomicWriteSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
    _watcherLoadErrors.delete(userId);
    return true;
  } catch (e) {
    log.warn('watchers', `Failed to persist ${userId} watchers`, { err: e.message });
    return false;
  }
}

// Debounced persistence for HIGH-FREQUENCY updates (pushWatcherStatus gets a
// call per tool_progress chunk — tens per second during a streaming
// delegation, each of which used to stringify + writeFileSync the user's
// whole watchers file on the event loop). The in-memory _byUser map is the
// source of truth, so deferring the disk write only risks losing the last
// ≤1.5s of progress TEXT on a hard crash; structural transitions (register,
// finalize, unwatch, patch) still write through immediately.
const FLUSH_DEBOUNCE_MS = 1500;
const _dirtyUsers = new Set();
let _flushTimer = null;

function persistUser(userId, { debounce = false } = {}) {
  if (!debounce) {
    _dirtyUsers.delete(userId);
    return _writeUserNow(userId);
  }
  _dirtyUsers.add(userId);
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    for (const uid of _dirtyUsers) _writeUserNow(uid);
    _dirtyUsers.clear();
  }, FLUSH_DEBOUNCE_MS);
  _flushTimer.unref?.();
  return true;
}

// Graceful-shutdown net: flush any pending debounced writes synchronously.
process.on('exit', () => {
  for (const uid of _dirtyUsers) _writeUserNow(uid);
  _dirtyUsers.clear();
});

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

  const safeContext = getPreferenceSafeAutoContext();
  if (safeContext?.activationNonce) assertWatcherStoreHealthy(userId);
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

  // Stamp every watcher created inside a validated safe-auto tool invocation
  // with its unguessable async-local nonce. Verification later promotes the
  // one exact notify-only watcher; failures roll back only nonce-matched rows,
  // never a concurrent watcher created by another turn.
  if (safeContext?.activationNonce) {
    const watcherIdentity = state?.dedupKey || null;
    const approved = safeContext.mode === 'approved';
    record.personalizationOrigin = {
      type: approved ? 'preference_approved_pending' : 'preference_safe_auto_pending',
      activationNonce: safeContext.activationNonce,
      offerKind: safeContext.offerKind,
      contractFingerprint: safeContext.contractFingerprint,
      receiptEventId: safeContext.receiptEventId,
      watcherIdentity: safeContext.watcherIdentity,
      reviewedExecutorDigest: safeContext.reviewedExecutorDigest,
      ...(approved ? {
        preferenceMemoryId: safeContext.preferenceMemoryId,
        utilityContextKey: safeContext.utilityContextKey || 'general',
        executorDigest: safeContext.executorDigest,
        manifestDigest: safeContext.manifestDigest,
        expectedDelivery: safeContext.expectedDelivery,
      } : {}),
      contractMatch: skillId === safeContext.skillId
        && kind === safeContext.watcherKind
        && watcherIdentity === safeContext.watcherIdentity,
    };
  }

  data.active.push(record);
  // event_subscription watchers register against the in-process bus so
  // emitEvent() can pull their nextTickAt forward when their event arrives.
  // Polling kinds skip this — the supervisor's regular sweep handles them.
  if (kind === 'event_subscription') subscribeToEvent(record);
  const persisted = persistUser(userId);
  if (safeContext?.activationNonce && !persisted) {
    data.active = data.active.filter(watcher => watcher !== record);
    if (kind === 'event_subscription') unsubscribeFromEvent(record);
    throw new Error('safe-auto watcher registration could not be persisted');
  }
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
  if (!isManagedPreferenceWatcher(w)
    && patch.onFire && typeof patch.onFire === 'object' && patch.onFire.type) {
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
 * Append an item to a collection watcher's `state.items`. Pass
 * `{ requirePersist: true }` for standing grants or other mutations that must
 * roll back instead of reporting success when the disk write fails. Returns
 * { added: bool, item } — `added: false` means an item with the same `id` was
 * already present (the existing item is left untouched). Persists on add.
 */
export function addCollectionItem(userId, ref, item, opts = {}) {
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
  if (!persistUser(userId) && opts.requirePersist === true) {
    items.pop();
    return { added: false, item: null, error: 'collection watcher update could not be persisted' };
  }
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
 * (`id`, `addedAt`) are ignored. `{ requirePersist: true }` makes the mutation
 * transactional with respect to the on-disk watcher envelope.
 */
export function updateCollectionItem(userId, ref, itemId, patch, opts = {}) {
  const w = _findCollectionWatcher(userId, ref);
  if (!w) return { updated: false, error: 'collection watcher not found' };
  const items = w.state.items || [];
  const it = items.find(x => x.id === itemId);
  if (!it) return { updated: false };
  const previous = opts.requirePersist === true ? JSON.parse(JSON.stringify(it)) : null;
  const { id: _ignore1, addedAt: _ignore2, ...rest } = patch || {};
  Object.assign(it, rest);
  if (Object.prototype.hasOwnProperty.call(rest, 'cadenceSec')) {
    it.cadenceSec = _normalizeCadence(it.cadenceSec);
    it.nextDueAt = 0;
  }
  if (!persistUser(userId) && opts.requirePersist === true) {
    const idx = items.indexOf(it);
    if (idx >= 0) items[idx] = previous;
    return { updated: false, error: 'collection watcher update could not be persisted' };
  }
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
  assertWatcherStoreHealthy(userId);
  const data = loadUserWatchers(userId);
  const idx = data.active.findIndex(w => w.id === watcherId);
  if (idx < 0) return false;
  const w = data.active[idx];
  // Stop the jailed process before doing any further lifecycle work. Managed
  // removals still roll their record back if durable persistence fails, but an
  // in-flight process never retains authority while that failure is handled.
  abortInFlightWatcher(userId, watcherId, reason);
  const safeLifecycle = isManagedPreferenceWatcher(w)
    || ['preference_safe_auto_pending', 'preference_approved_pending']
      .includes(w?.personalizationOrigin?.type);
  data.active.splice(idx, 1);
  const previous = { status: w.status, endedAt: w.endedAt };
  if (w.kind === 'event_subscription') unsubscribeFromEvent(w);
  w.status = reason;
  w.endedAt = Date.now();
  data.recent.unshift(w);
  data.recent = data.recent.slice(0, 20);
  if (!persistUser(userId) && safeLifecycle) {
    const recentIdx = data.recent.indexOf(w);
    if (recentIdx >= 0) data.recent.splice(recentIdx, 1);
    data.active.splice(Math.min(idx, data.active.length), 0, w);
    w.status = previous.status;
    w.endedAt = previous.endedAt;
    if (w.kind === 'event_subscription') subscribeToEvent(w);
    throw new Error('safe-auto watcher removal could not be persisted');
  }
  releaseApprovedPreferenceGrant(w);
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
  if (isManagedPreferenceWatcher(record)) {
    if (text) {
      deliverManagedPreferenceUpdate(record, text)
        .catch(e => log.warn('watchers', 'managed preference pushed-status delivery failed', { id: record.id, err: e.message }));
    } else {
      persistUser(userId, { debounce: true });
    }
    return true;
  }
  if (text && text !== record.lastStatusText) {
    record.lastStatusText = text;
    record.lastChangeAt = Date.now();
    pushHistory(record, { text, ts: Date.now() });
    _sendStatusFn?.(userId, watcherStatusPayload(record, text));
  }
  // Debounced: this runs per tool_progress chunk during streaming delegations.
  persistUser(userId, { debounce: true });
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

/**
 * Strictly postpone one exact user-owned watcher. This is separate from the
 * broad patch surface because proactive receipt controls must know the delay
 * was durably persisted before claiming success.
 */
export function snoozeWatcher(userId, watcherId, until) {
  assertWatcherStoreHealthy(userId);
  const data = loadUserWatchers(userId);
  const watcher = data.active.find(record => record.id === watcherId);
  if (!watcher || (watcher.userId && watcher.userId !== userId)) return null;
  const untilMs = until instanceof Date ? until.getTime()
    : (typeof until === 'number' ? until : Date.parse(String(until || '')));
  const now = Date.now();
  if (!Number.isFinite(untilMs) || untilMs < now + 5 * 60_000
    || untilMs > now + 30 * 86_400_000) return null;
  const previousNextTickAt = watcher.nextTickAt;
  const previousSnoozedUntil = watcher.snoozedUntil;
  watcher.nextTickAt = Math.max(Number(watcher.nextTickAt) || 0, untilMs);
  watcher.snoozedUntil = new Date(untilMs).toISOString();
  if (!persistUser(userId)) {
    watcher.nextTickAt = previousNextTickAt;
    if (previousSnoozedUntil === undefined) delete watcher.snoozedUntil;
    else watcher.snoozedUntil = previousSnoozedUntil;
    return null;
  }
  return watcher;
}

/**
 * Promote one nonce-stamped pending watcher to a durable, notify-only
 * Personalization informational watcher. Returns the record or null when any
 * exact contract field differs.
 */
export function markWatcherSafeInformational(userId, watcherId, expected = {}) {
  assertWatcherStoreHealthy(userId);
  const data = loadUserWatchers(userId);
  const watcher = data.active.find(record => record.id === watcherId);
  const origin = watcher?.personalizationOrigin;
  const identity = watcher?.state?.dedupKey || watcher?.dedupKey;
  if (!watcher || origin?.type !== 'preference_safe_auto_pending'
    || origin.activationNonce !== expected.activationNonce
    || origin.contractMatch !== true
    || watcher.skillId !== expected.skillId
    || watcher.kind !== expected.watcherKind
    || identity !== expected.watcherIdentity
    || watcher.onFire?.type !== 'notify'
    || origin.offerKind !== expected.offerKind
    || origin.contractFingerprint !== expected.contractFingerprint
    || origin.receiptEventId !== expected.receiptEventId
    || typeof expected.reviewedExecutorDigest !== 'string'
    || origin.reviewedExecutorDigest !== expected.reviewedExecutorDigest) return null;
  const previousOrigin = watcher.personalizationOrigin;
  const previousOnFire = watcher.onFire;
  watcher.personalizationOrigin = {
    type: 'preference_safe_auto',
    activationNonce: expected.activationNonce,
    offerKind: expected.offerKind,
    contractFingerprint: expected.contractFingerprint,
    watcherIdentity: expected.watcherIdentity,
    receiptEventId: expected.receiptEventId,
    reviewedExecutorDigest: expected.reviewedExecutorDigest,
    ...(typeof expected.preferenceMemoryId === 'string' && expected.preferenceMemoryId.length <= 160
      ? { preferenceMemoryId: expected.preferenceMemoryId } : {}),
    ...(typeof expected.utilityContextKey === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(expected.utilityContextKey)
      ? { utilityContextKey: expected.utilityContextKey } : {}),
    activatedAt: Date.now(),
  };
  // Defense in depth against a mutable/persisted registration record.
  watcher.onFire = { type: 'notify' };
  if (!persistUser(userId)) {
    watcher.personalizationOrigin = previousOrigin;
    watcher.onFire = previousOnFire;
    return null;
  }
  return watcher;
}

/** Promote one user-approved preference watcher after its receipt commits. */
export function markWatcherPreferenceApproved(userId, watcherId, expected = {}) {
  assertWatcherStoreHealthy(userId);
  const data = loadUserWatchers(userId);
  const watcher = data.active.find(record => record.id === watcherId);
  const origin = watcher?.personalizationOrigin;
  const identity = watcher?.state?.dedupKey || watcher?.dedupKey;
  if (!watcher || origin?.type !== 'preference_approved_pending'
    || origin.activationNonce !== expected.activationNonce
    || origin.contractMatch !== true
    || watcher.skillId !== expected.skillId
    || watcher.kind !== expected.watcherKind
    || identity !== expected.watcherIdentity
    || origin.offerKind !== expected.offerKind
    || origin.contractFingerprint !== expected.contractFingerprint
    || origin.preferenceMemoryId !== expected.preferenceMemoryId
    || origin.executorDigest !== expected.executorDigest
    || origin.manifestDigest !== expected.manifestDigest
    || typeof expected.expectedDelivery !== 'string'
    || origin.expectedDelivery !== expected.expectedDelivery
    || watcher.onFire?.type !== expected.expectedDelivery) return null;
  const previousOrigin = watcher.personalizationOrigin;
  watcher.personalizationOrigin = {
    type: 'preference_approved',
    offerKind: expected.offerKind,
    contractFingerprint: expected.contractFingerprint,
    watcherIdentity: expected.watcherIdentity,
    receiptEventId: expected.receiptEventId,
    preferenceMemoryId: expected.preferenceMemoryId,
    utilityContextKey: expected.utilityContextKey || 'general',
    executorDigest: expected.executorDigest,
    manifestDigest: expected.manifestDigest,
    expectedDelivery: expected.expectedDelivery,
    approvedAt: Date.now(),
  };
  if (!persistUser(userId)) {
    watcher.personalizationOrigin = previousOrigin;
    return null;
  }
  return watcher;
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
// A "system" kind (exec, http_jsonpath, file_stat, task_proxy, …) runs its handler
// IN-PROCESS in the supervisor. Untrusted (sandboxed) skills must not register one:
// they'd fail-safe while jailed (no such handler in their execute.mjs), but the record
// would detonate in-process if the skill were ever de-sandboxed. Trusted callers only.
export function isSystemWatcherKind(kind) {
  return _systemHandlers.has(kind);
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
async function eventSubscriptionHandler(state) {
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
_systemHandlers.set('event_subscription', eventSubscriptionHandler);

// task_proxy: state-container for in-flight background-agent runs (Phase 14).
// The actual work runs in a detached promise outside this loop. The handler
// here is a heartbeat — every tick, check whether the underlying task has
// gone silent (no activity in 5min) and flip to failed. That's the third
// crash-detection layer (the first two are promise-catch + boot-reap).
const TASK_PROXY_SILENCE_MS = 5 * 60 * 1000;
const TASK_PROXY_NUDGE_MS = 60 * 60 * 1000;   // 1h re-broadcast when awaiting input
async function taskProxyHandler(state, helpers) {
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
    // A single long tool call (big local inference, long node_exec) emits no
    // progress for >5 min while very much alive — cross-check the task
    // registry and defer while the task is still registered. Reaping applies
    // only to tasks that vanished without completing (crash/kill). Dynamic
    // import: background-tasks statically imports this module.
    try {
      const { isTaskActive } = await import('../background-tasks.mjs');
      if (state?.taskId && isTaskActive(state.taskId)) return { newState: state };
    } catch { /* registry unavailable — fall through to reap */ }
    return {
      newState: { ...state, failed: true, failureReason: 'no progress in 5min — may have crashed' },
      textUpdate: `⚠ Task went silent for >5 min: ${state.label || state.targetAgentName || 'unknown task'}`,
      done: true,
      failed: true, // finalize as error, not a green "done" chip
    };
  }
  return { newState: state };   // benign heartbeat tick
}
_systemHandlers.set('task_proxy', taskProxyHandler);

async function stopUnauthorizedPreferenceWatcher(record) {
  // Prefer the receipt controller so the user-visible audit row, queued
  // updates, policy, and watcher transition atomically toward ask-first.
  try {
    const { controlPreferenceAutomationReceipt } = await import('../lib/personalization/preference-opportunities.mjs');
    const controlled = await controlPreferenceAutomationReceipt(
      record.userId, record.personalizationOrigin?.receiptEventId, 'undo',
    );
    if (controlled?.ok) {
      const stillActive = _byUser.get(record.userId)?.active
        ?.some(watcher => watcher.id === record.id);
      if (!stillActive) return true;
    }
  } catch (e) {
    log.warn('watchers', 'preference watcher receipt control failed', { id: record.id, err: e?.message || String(e) });
  }

  // A corrupt/missing receipt cannot authorize execution. Preserve the same
  // fail-closed ordering manually: block unattended reactivation and cancel
  // queued updates before the independently-fallible watcher-store mutation.
  try {
    const { revokeKindAutoApproval } = await import('../lib/personalization/graduation.mjs');
    await revokeKindAutoApproval(record.userId, record.personalizationOrigin?.offerKind);
  } catch (e) {
    log.warn('watchers', 'preference watcher approval revocation failed', { id: record.id, err: e?.message || String(e) });
  }
  try {
    const { cancelPendingProactiveEventsBySource } = await import('../lib/personalization/proactive-inbox.mjs');
    await cancelPendingProactiveEventsBySource(
      record.userId, 'preference_monitor_update', record.id, { reason: 'authorization_revoked' },
    );
  } catch (e) {
    log.warn('watchers', 'preference watcher queued-update cancellation failed', { id: record.id, err: e?.message || String(e) });
  }
  if (isApprovedPreferenceWatcher(record)) {
    try {
      const grants = await import('../lib/personalization/skill-preference-grants.mjs');
      await grants.revokeSkillPreferenceGrant(record.userId, {
        skillId: record.skillId,
        preferenceMemoryId: record.personalizationOrigin?.preferenceMemoryId,
        contractFingerprint: record.personalizationOrigin?.contractFingerprint,
      });
    } catch (e) {
      log.warn('watchers', 'approved preference grant revocation failed', { id: record.id, err: e?.message || String(e) });
    }
  }
  try {
    const current = _byUser.get(record.userId)?.active?.find(watcher => watcher.id === record.id);
    if (current) unregisterWatcher(record.userId, record.id, 'authorization_revoked');
    return true;
  } catch (e) {
    // Never execute the handler merely because cleanup storage is unhealthy.
    // Back off the in-memory record to avoid a hot 5-second retry loop; the
    // periodic receipt reconciler retains independent cleanup authority.
    record.nextTickAt = Date.now() + Math.max(60_000, Number(record.cadenceSec || 0) * 1000);
    log.warn('watchers', 'preference watcher removal failed closed', { id: record.id, err: e?.message || String(e) });
    return false;
  }
}

// Fire a CUSTOM skill's watcher handler INSIDE the bwrap jail. The handler's
// helpers.* calls come back as `helper.<m>` RPCs, which we service with the REAL
// handlerHelpers(record) bound to this process — so fire/postStatus/notify/etc.
// keep their full behaviour, but the skill's own handler code (the fetch/compare
// logic) never runs in-process. Returns { ok, result } where result is the
// serializable { newState, textUpdate, done, … } the supervisor already expects.
export async function runCustomWatcherSandboxed(record, { signal = null } = {}) {
  const managed = isManagedPreferenceWatcher(record);
  const executionController = new AbortController();
  const forwardAbort = () => {
    try { executionController.abort(signal?.reason); } catch { executionController.abort(); }
  };
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });

  const authorizationError = (message = 'preference watcher authorization changed') => {
    const error = new Error(message);
    /** @type {any} */ (error).code = 'PREFERENCE_WATCHER_AUTHORIZATION';
    return error;
  };
  const abortExecution = (error) => {
    if (!executionController.signal.aborted) {
      try { executionController.abort(error); } catch { executionController.abort(); }
    }
    throw error;
  };
  const exactManagedWatcherIsActive = () => _byUser.get(record.userId)?.active
    ?.find(watcher => watcher.id === record.id) === record
    && record.status === 'active'
    && isManagedPreferenceWatcher(record);
  const assertManagedRpcAuthorization = async () => {
    if (!managed) return;
    if (executionController.signal.aborted || !exactManagedWatcherIsActive()) {
      abortExecution(authorizationError('preference watcher execution was cancelled'));
    }
    let authorized = false;
    try {
      const authorization = await import('../lib/personalization/preference-opportunities.mjs');
      authorized = isSafeInformationalWatcher(record)
        ? await authorization.preferenceSafeAutoWatcherIsAuthorized(record.userId, record)
        : await authorization.preferenceApprovedWatcherIsAuthorized(record.userId, record);
    } catch { authorized = false; }
    // Stop/Undo can race the asynchronous receipt/code/preference checks.
    if (!authorized || executionController.signal.aborted || !exactManagedWatcherIsActive()) {
      abortExecution(authorizationError());
    }
  };

  const realHelpers = handlerHelpers(record);
  // Ordinary custom watchers retain their established runtime capability.
  // Managed preference ticks deny it even when a mutable binary already exists.
  const runtime = buildRuntimeBroker(record.userId, record.skillId, {
    allowPrompt: false,
    allowExecution: !managed,
  });
  const ordinaryAllowedHelperMethods = new Set([
    'helper.fire', 'helper.fireAgent', 'helper.showVideo', 'helper.showImage',
    'helper.postStatus', 'helper.notify',
    'helper.credentials.get', 'helper.credentials.set', 'helper.credentials.list',
    'helper.credentials.delete',
    'helper.personalization.confirmedPreferences',
    'helper.personalization.confirmedPreferenceDetails',
    'helper.ensureRuntime', 'helper.runSandboxed',
  ]);
  const managedAllowedHelperMethods = new Set([
    'helper.fire', 'helper.fireAgent', 'helper.postStatus', 'helper.notify',
    'helper.credentials.get', 'helper.credentials.list',
    'helper.personalization.confirmedPreferences',
    'helper.personalization.confirmedPreferenceDetails',
  ]);
  const handleRpc = async (method, args) => {
    if (typeof method !== 'string' || !method.startsWith('helper.')) throw new Error(`watcher rpc not allowed: ${method}`);
    if (managed) await assertManagedRpcAuthorization();
    const allowedHelperMethods = managed ? managedAllowedHelperMethods : ordinaryAllowedHelperMethods;
    if (!allowedHelperMethods.has(method)) throw new Error(`watcher rpc not allowed: ${method}`);
    // Runtime is clamped — route it to the broker, NOT the unclamped in-process helpers.
    if (method === 'helper.ensureRuntime') return runtime.ensureRuntime((Array.isArray(args) ? args[0] : args) || {});
    if (method === 'helper.runSandboxed') { const a = Array.isArray(args) ? args : [args]; return runtime.runSandboxed(a[0], a[1], a[2] || {}); }
    // Resolve dotted paths (e.g. 'credentials.get') against the real helpers.
    const parts = method.slice(7).split('.');
    let target = realHelpers, fn = null;
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) fn = target?.[parts[i]];
      else target = target?.[parts[i]];
    }
    if (typeof fn !== 'function') throw new Error(`helper.${method.slice(7)} is not available to sandboxed watchers`);
    return await fn(...(Array.isArray(args) ? args : [args]));
  };

  try {
    const { runSandboxedJob, customSkillBindings } = await import('../lib/skill-subprocess.mjs');
    const { execPath } = customSkillBindings(record.userId, record.skillId);
    const jobPayload = {
      t: 'job', mode: 'watcher', skillExecPath: execPath, kind: record.kind,
      state: record.state, userId: record.userId, agentId: record.agentId, watcherId: record.id,
    };
    // Default-deny egress on ticks too — only skills that declare sandbox.network get it.
    const net = skillDeclaresNetwork(record.userId, record.skillId);
    if (managed) {
      const roleModule = await import('../roles.mjs');
      if (!roleModule.isSandboxedSkill(record.skillId, record.userId)) {
        throw authorizationError('preference watcher execution requires sandbox isolation');
      }
      const candidates = roleModule.listRoles(record.userId)
        .filter(candidate => candidate?.id === record.skillId);
      const manifest = candidates.find(candidate => candidate?.userScope === record.userId)
        || candidates.find(candidate => candidate?.userScope == null);
      let snapshot = null;
      if (isSafeInformationalWatcher(record)) {
        const { materializeReviewedInformationalSnapshot } = await import('../lib/personalization/reviewed-informational-skills.mjs');
        snapshot = materializeReviewedInformationalSnapshot(
          record.userId, manifest, record.personalizationOrigin?.reviewedExecutorDigest,
        );
      } else {
        const grants = await import('../lib/personalization/skill-preference-grants.mjs');
        snapshot = grants.materializeGrantedSkillSnapshot(record.userId, manifest, {
          executorDigest: record.personalizationOrigin?.executorDigest,
          manifestDigest: record.personalizationOrigin?.manifestDigest,
        });
      }
      if (!snapshot) {
        throw authorizationError('preference watcher immutable snapshot could not be verified');
      }
      try {
        return await runSandboxedJob({
          userId: record.userId,
          skillId: record.skillId,
          jobPayload,
          handleRpc,
          net,
          timeoutMs: 120_000,
          execSnapshotPath: snapshot.execPath,
          signal: executionController.signal,
        });
      } finally {
        snapshot.cleanup();
      }
    }
    return await runSandboxedJob({
      userId: record.userId, skillId: record.skillId, jobPayload, handleRpc, net,
      timeoutMs: 120_000, signal: executionController.signal,
    });
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
  }
}

// ── supervisor loop ──────────────────────────────────────────────────────────

async function tickOne(record) {
  const inFlightKey = `${record.userId}:${record.id}`;
  if (_inFlight.has(inFlightKey)) return; // previous tick still running
  _inFlight.add(inFlightKey);
  const tickController = new AbortController();
  _inFlightControllers.set(inFlightKey, tickController);

  try {
    // A crash/interruption between registration and durable receipt commit can
    // leave a nonce-stamped pending watcher on disk. It is never allowed to
    // run a handler; the receipt reconciler may also remove it sooner.
    if (['preference_safe_auto_pending', 'preference_approved_pending']
      .includes(record?.personalizationOrigin?.type)) {
      unregisterWatcher(record.userId, record.id, 'auto_activation_orphan');
      return;
    }

    // `nextTickAt` is the normal scheduler gate, but event delivery and other
    // supervisor paths may pull it forward. Snooze is a user control, so
    // enforce its absolute timestamp again inside the tick boundary before
    // any authorization imports or custom handler code can run.
    const snoozedUntilMs = Date.parse(record.snoozedUntil || '');
    if (Number.isFinite(snoozedUntilMs) && snoozedUntilMs > Date.now()) {
      if (Number(record.nextTickAt) < snoozedUntilMs) {
        record.nextTickAt = snoozedUntilMs;
        persistUser(record.userId);
      }
      return;
    }
    if (record.snoozedUntil) delete record.snoozedUntil;

    // Recheck the exact receipt, live manifest/recipe, confirmed preference,
    // settings, overrides, policy, and reviewed executor digest on EVERY safe
    // tick. Without this boundary, edited custom code could run during the
    // interval before the periodic receipt reconciler noticed the change.
    if (isManagedPreferenceWatcher(record)) {
      let authorized = false;
      try {
        const authorization = await import('../lib/personalization/preference-opportunities.mjs');
        authorized = isSafeInformationalWatcher(record)
          ? await authorization.preferenceSafeAutoWatcherIsAuthorized(record.userId, record)
          : await authorization.preferenceApprovedWatcherIsAuthorized(record.userId, record);
      } catch { authorized = false; }
      if (!authorized) {
        await stopUnauthorizedPreferenceWatcher(record);
        return;
      }
      // Stop/Undo may have raced the async revalidation. Confirm that this
      // exact object is still the active promoted watcher immediately before
      // any handler resolution or custom-code execution.
      const current = _byUser.get(record.userId)?.active?.find(watcher => watcher.id === record.id);
      if (current !== record || record.status !== 'active' || !isManagedPreferenceWatcher(record)) return;
    }
    // Expiry check — only if not indefinite.
    if (record.expiresAt !== null && Date.now() > record.expiresAt) {
      finalizeWatcher(record, 'expired', `⏰ Monitor expired without completing.`);
      return;
    }

    // Shared failure handling: bump the counter, finalize at the cap, otherwise
    // back off one cadence. `msg` is only surfaced when we actually finalize.
    const failTick = (msg) => {
      const live = _byUser.get(record.userId)?.active?.find(watcher => watcher.id === record.id);
      if (live !== record || record.status !== 'active') return;
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
    if (isManagedPreferenceWatcher(record) && !sandboxed) {
      await stopUnauthorizedPreferenceWatcher(record);
      return;
    }
    if (sandboxed) {
      let sres;
      try { sres = await runCustomWatcherSandboxed(record, { signal: tickController.signal }); }
      catch (e) {
        log.warn('watchers', 'Sandboxed handler error', { kind: record.kind, err: e.message });
        if (isManagedPreferenceWatcher(record) && e?.code === 'PREFERENCE_WATCHER_AUTHORIZATION') {
          await stopUnauthorizedPreferenceWatcher(record);
          return;
        }
        failTick(`❌ ${record.label}: sandboxed handler error — ${e.message}`);
        return;
      }
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

    // Stop/Undo/Snooze can win while a slow handler is fetching. Discard the
    // returned object before mutating this shared record unless it is still the
    // exact active watcher. Managed preference monitors also repeat their full
    // receipt/preference/code authorization after the handler and before any
    // new state, history, terminal status, or cadence is persisted.
    let postHandlerLive = _byUser.get(record.userId)?.active
      ?.find(watcher => watcher.id === record.id);
    const postHandlerSnooze = Date.parse(record.snoozedUntil || '');
    if (postHandlerLive !== record || record.status !== 'active'
      || (Number.isFinite(postHandlerSnooze) && postHandlerSnooze > Date.now())) return;
    if (isManagedPreferenceWatcher(record)) {
      let stillAuthorized = false;
      try {
        const authorization = await import('../lib/personalization/preference-opportunities.mjs');
        stillAuthorized = isSafeInformationalWatcher(record)
          ? await authorization.preferenceSafeAutoWatcherIsAuthorized(record.userId, record)
          : await authorization.preferenceApprovedWatcherIsAuthorized(record.userId, record);
      } catch { stillAuthorized = false; }
      if (!stillAuthorized) {
        await stopUnauthorizedPreferenceWatcher(record);
        return;
      }
      postHandlerLive = _byUser.get(record.userId)?.active
        ?.find(watcher => watcher.id === record.id);
      if (postHandlerLive !== record || record.status !== 'active') return;
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
        record.origCadenceSec = null; // handler's explicit choice becomes the new baseline
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
          // Visible change ends the stuck back-off — restore the original
          // cadence. Without this, one quiet afternoon permanently rewrote a
          // 300s price-alert to hourly polling for the rest of its life.
          if (record.origCadenceSec) {
            record.cadenceSec = record.origCadenceSec;
            record.origCadenceSec = null;
          }
          pushHistory(record, { text: result.textUpdate, ts: Date.now() });
          if (!isManagedPreferenceWatcher(record) && _sendStatusFn) {
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
        // A handler can flag the terminal state as a failure — a silent-task
        // reap must not render as a green "done" chip with an error message.
        const finalStatus = result.failed ? 'error' : 'done';
        const finalText = result.textUpdate || `✓ ${record.label} done.`;
        if (isManagedPreferenceWatcher(record)) {
          await deliverManagedPreferenceUpdate(record, finalText, {
            dispatchApproved: isApprovedPreferenceWatcher(record) && finalStatus === 'done',
          });
        }
        finalizeWatcher(record, finalStatus, finalText);
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
    const stuckEligible = record.kind !== 'profile_health' && !isManagedPreferenceWatcher(record);
    if (stuckEligible && !record.stuckAnnounced && sinceChange > stuckThresholdMs) {
      record.stuckAnnounced = true;
      record.stuckSinceAt = record.stuckSinceAt || Date.now();
      record.stuckRecoveryCount = Number(record.stuckRecoveryCount || 0) + 1;
      const oldCadence = record.cadenceSec;
      // Remember the pre-backoff cadence so a visible change can restore it.
      record.origCadenceSec = record.origCadenceSec || oldCadence;
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
    if (_inFlightControllers.get(inFlightKey) === tickController) {
      _inFlightControllers.delete(inFlightKey);
    }
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
  abortInFlightWatcher(record.userId, record.id, status);
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
  if (_sendStatusFn && finalText && !isManagedPreferenceWatcher(record)) {
    _sendStatusFn(record.userId, watcherStatusPayload(record, finalText, {
      final: true,
      finalStatus: status,
    }));
  }
  // Only fire the chained action on a successful predicate hit. Errors,
  // expiries, and user-cancellations should not auto-run an agent — that
  // would burn cloud tokens on a state the user didn't intend to act on.
  if (status === 'done' && !isManagedPreferenceWatcher(record)
    && record.onFire && record.onFire.type && record.onFire.type !== 'notify') {
    executeOnFire(record).catch(e =>
      log.warn('watchers', 'on_fire failed', { id: record.id, type: record.onFire?.type, err: e.message })
    );
  }
  releaseApprovedPreferenceGrant(record);
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

/**
 * Last-line authorization for either server-reviewed safe-auto monitoring or
 * a monitor the user explicitly approved. Both classes are receipt-backed,
 * preference-bound, sandboxed, and locally auditable. Safe-auto additionally
 * requires the live Safe initiative policy; approval-backed monitors retain
 * only the exact delivery channel the user accepted.
 */
async function managedPreferenceDeliveryAllowed(record, { immediate = false } = {}) {
  if (!isManagedPreferenceWatcher(record)) return false;
  const isSnoozed = value => {
    const until = Date.parse(value?.snoozedUntil || '');
    return Number.isFinite(until) && until > Date.now();
  };
  if (isSnoozed(record)) return false;
  if (record.status !== 'active') return false;
  const active = (listWatchers(record.userId)?.active || []).find(watcher => watcher.id === record.id);
  if (!active || !isManagedPreferenceWatcher(active) || isSnoozed(active)) return false;
  try {
    const [configModule, policy] = await Promise.all([
      import('../lib/personalization/config.mjs'),
      import('../lib/personalization/graduation.mjs'),
    ]);
    const cfg = await configModule.getConfig(record.userId);
    if (cfg.enabled !== true || cfg.setupComplete !== true || cfg.proactivity === 'quiet') return false;
    if (await policy.isKindSuppressed(record.userId, record.personalizationOrigin.offerKind)) return false;
    if (isSafeInformationalWatcher(record)
      && (cfg.initiativeMode !== 'safe_auto'
        || !(await policy.isKindSafeAutoAllowed(record.userId, record.personalizationOrigin.offerKind)))) return false;
    if (immediate && (cfg.deliveryMode !== 'immediate' || configModule.isQuietHours(cfg, new Date()))) return false;
    // Snooze may race the config/policy reads above. Re-read the live record
    // before authorizing durable enqueue or an immediate notification.
    const live = (listWatchers(record.userId)?.active || []).find(watcher => watcher.id === record.id);
    if (isSnoozed(record) || !live || isSnoozed(live)) return false;
    // A handler can spend up to two minutes fetching. Revalidate the full
    // receipt, preference, skill enablement, reviewed code, utility, and exact
    // contract again at the last delivery boundary so an edit/delete made
    // while it was in flight wins before any result is persisted or sent.
    const authorization = await import('../lib/personalization/preference-opportunities.mjs');
    return isSafeInformationalWatcher(record)
      ? await authorization.preferenceSafeAutoWatcherIsAuthorized(record.userId, record)
      : await authorization.preferenceApprovedWatcherIsAuthorized(record.userId, record);
  } catch { return false; }
}

async function deliverManagedPreferenceUpdate(record, value, { dispatchApproved = false } = {}) {
  if (!isManagedPreferenceWatcher(record)) return false;
  const text = String(value || '').trim().slice(0, 1_000);
  if (!text) return false;
  if (!(await managedPreferenceDeliveryAllowed(record))) return false;
  const origin = record.personalizationOrigin;
  const payloadDigest = createHash('sha256').update(text).digest('hex');
  const digest = payloadDigest.slice(0, 16);
  let stateIdentity = '';
  try { stateIdentity = JSON.stringify(record.state ?? null); } catch { stateIdentity = '[unserializable]'; }
  const occurrenceDigest = createHash('sha256')
    .update(String(Number(record.ticks) || 0)).update('\0')
    .update(stateIdentity).update('\0')
    .update(payloadDigest).digest('hex');
  const inbox = await import('../lib/personalization/proactive-inbox.mjs');
  const recentUpdates = await inbox.listProactiveEventsByKind(
    record.userId, 'preference_monitor_update', { limit: 500 },
  );
  const existingPending = recentUpdates
    .find(item => item.status === 'pending' && item.sourceId === record.id);
  let coalesciblePending = existingPending;
  const approvedExternal = dispatchApproved && isApprovedPreferenceWatcher(record)
    && origin.expectedDelivery !== 'notify';
  const committedOccurrence = approvedExternal
    ? recentUpdates.find(item => item.sourceId === record.id
      && item.metadata?.executionState === 'succeeded'
      && item.metadata?.occurrenceDigest === occurrenceDigest)
    : null;
  if (committedOccurrence) {
    // Delivery and watcher-state persistence cannot share one transaction. The
    // tick/state fingerprint stays stable only when a process dies before the
    // handler result commits, so it safely closes that exact retry window while
    // allowing the same prose again on a later, successfully advanced tick.
    if (committedOccurrence.status === 'pending') {
      await inbox.markProactiveEventDelivered(record.userId, committedOccurrence.id, {
        deliveryCount: 1, channel: origin.expectedDelivery,
      });
    }
    return true;
  }
  if (approvedExternal && existingPending) {
    const executionState = existingPending.metadata?.executionState;
    const samePayload = typeof existingPending.metadata?.payloadDigest === 'string'
      ? existingPending.metadata.payloadDigest === payloadDigest
      : existingPending.text === text;
    const sameOccurrence = typeof existingPending.metadata?.occurrenceDigest === 'string'
      ? existingPending.metadata.occurrenceDigest === occurrenceDigest
      : samePayload;
    if (executionState === 'succeeded') {
      // The external send committed but the process stopped before the inbox
      // status update. Finish that receipt without repeating the send.
      await inbox.markProactiveEventDelivered(record.userId, existingPending.id, {
        deliveryCount: 1, channel: origin.expectedDelivery,
      });
      if (sameOccurrence) return true;
      coalesciblePending = null;
    }
    if (executionState === 'started') {
      const startedAt = Date.parse(existingPending.metadata?.externalDispatchStartedAt || '');
      if (!Number.isFinite(startedAt) || Date.now() - startedAt >= EXTERNAL_DISPATCH_STALE_MS) {
        await inbox.updateProactiveEventByDedupKey(record.userId, existingPending.dedupKey, {
          expectedExecutionState: 'started',
          metadata: {
            executionState: 'uncertain', deliveryState: 'manual_review',
            externalDispatchUncertainAt: new Date().toISOString(),
          },
        });
        if (!sameOccurrence) coalesciblePending = null;
      }
      if (sameOccurrence || coalesciblePending) return false;
    }
    if (['failed', 'uncertain', 'canceled'].includes(executionState)) {
      if (sameOccurrence) return false;
      coalesciblePending = null;
    }
  }
  const event = await inbox.enqueueProactiveEvent(record.userId, {
    // Coalesce an offline/briefing backlog to one pending update per watcher.
    // After acknowledgement, a new event key is created for the next hit.
    dedupKey: coalesciblePending?.dedupKey || `preference-monitor-update:${record.id}:${Date.now()}:${digest}`,
    kind: 'preference_monitor_update',
    sourceId: record.id,
    title: record.label || 'Preference monitor update',
    text,
    metadata: {
      watcherId: record.id,
      skillId: record.skillId,
      watcherKind: record.kind,
      offerKind: origin.offerKind,
      contractFingerprint: origin.contractFingerprint,
      autonomy: isApprovedPreferenceWatcher(record) ? 'approved' : 'informational',
      payloadDigest,
      occurrenceDigest,
      deliveryState: 'ready',
      executionState: 'ready',
      control: {
        actions: ['useful', 'not_useful', 'acted', 'snooze', 'edit_preference', 'stop', 'undo'],
        eventId: origin.receiptEventId,
        source: {
          ...(origin.preferenceMemoryId ? { preferenceMemoryId: origin.preferenceMemoryId } : {}),
          context: origin.utilityContextKey || 'general',
        },
      },
    },
  });
  // Stop/Snooze can race between the first authorization check and enqueue.
  // Recheck before treating the item as shown; if control won, neutralize the
  // just-created pending row so it cannot reappear after the controller's
  // earlier cancellation sweep.
  if (!(await managedPreferenceDeliveryAllowed(record))) {
    await inbox.cancelPendingProactiveEventsBySource(
      record.userId, 'preference_monitor_update', record.id,
      { reason: record.snoozedUntil ? 'snoozed' : 'authorization_revoked' },
    ).catch(() => 0);
    return false;
  }
  // Persist visible watcher state only after the post-enqueue authorization
  // wins. Stop/Snooze/Edit racing the fetch therefore cannot leave a newly
  // visible task-chip/history line after its pending inbox row was canceled.
  if (text !== record.lastStatusText) {
    record.lastStatusText = text;
    record.lastChangeAt = Date.now();
    pushHistory(record, { text, ts: Date.now() });
    persistUser(record.userId);
  }
  try {
    const { recordOpportunityOutcome } = await import('../lib/personalization/opportunity-utility.mjs');
    await recordOpportunityOutcome(record.userId, {
      actionContract: 'skill_preference_activation',
      contractFingerprint: origin.contractFingerprint,
    }, 'shown', {
      contextKey: origin.utilityContextKey || 'general',
      eventId: event.id,
    });
  } catch (e) {
    log.warn('watchers', 'Could not record preference monitor visibility', {
      watcherId: record.id, err: e?.message || String(e),
    });
  }

  if (approvedExternal) {
    if (record.onFire?.type !== origin.expectedDelivery) return false;
    const dispatchClaim = await inbox.updateProactiveEventByDedupKey(record.userId, event.dedupKey, {
      expectedExecutionState: 'ready',
      metadata: { executionState: 'started', externalDispatchStartedAt: new Date().toISOString() },
    });
    if (dispatchClaim) {
      if (!(await managedPreferenceDeliveryAllowed(record))) {
        await inbox.updateProactiveEventByDedupKey(record.userId, event.dedupKey, {
          expectedExecutionState: 'started',
          metadata: { executionState: 'canceled', externalDispatchCanceledAt: new Date().toISOString() },
        }).catch(() => null);
        return false;
      }
      try {
        // No handler-supplied delivery override reaches this boundary. The
        // immutable, receipt-authorized watcher onFire configuration is used.
        const sent = await executeOnFire(record);
        if (!sent) throw new Error(`${origin.expectedDelivery} delivery was not accepted`);
        const committed = await inbox.updateProactiveEventByDedupKey(record.userId, event.dedupKey, {
          expectedExecutionState: 'started',
          metadata: { executionState: 'succeeded', externalDispatchedAt: new Date().toISOString() },
        });
        if (!committed) throw new Error('external delivery receipt could not be committed');
      } catch (e) {
        await inbox.updateProactiveEventByDedupKey(record.userId, event.dedupKey, {
          expectedExecutionState: 'started',
          metadata: {
            executionState: 'failed', externalDispatchFailedAt: new Date().toISOString(),
            externalDispatchError: String(e?.message || e).slice(0, 160),
          },
        }).catch(() => null);
        return false;
      }
    } else {
      const current = await inbox.getProactiveEvent(record.userId, event.id).catch(() => null);
      if (current?.metadata?.executionState !== 'succeeded') return false;
    }
    await inbox.markProactiveEventDelivered(record.userId, event.id, {
      deliveryCount: 1, channel: origin.expectedDelivery,
    });
    return true;
  }
  if (event.status === 'delivered' || event.status === 'read') return true;

  if (!(await managedPreferenceDeliveryAllowed(record, { immediate: true }))) return true;

  const claimed = await inbox.claimProactiveEvent(record.userId, event.id, { now: new Date() });
  if (!claimed) return true;
  const budget = await import('../lib/personalization/graduation.mjs');
  const budgetOk = await budget.consumePingBudget(record.userId).catch(() => false);
  if (!budgetOk) {
    await inbox.recordProactiveDeliveryAttempt(record.userId, event.id, {
      claimToken: claimed.claimToken, deliveryCount: 0, channel: 'websocket', error: 'daily ping budget exhausted',
    });
    return true;
  }

  const allowed = await managedPreferenceDeliveryAllowed(record, { immediate: true });
  if (!allowed) {
    await budget.refundPingBudget(record.userId).catch(() => false);
    await inbox.recordProactiveDeliveryAttempt(record.userId, event.id, {
      claimToken: claimed.claimToken, deliveryCount: 0, channel: 'websocket', error: 'delivery controls changed',
    });
    return true;
  }

  let delivered = 0;
  let error = null;
  try {
    // Stop mutates this same record to a terminal status; this last-line check
    // closes the in-flight tick race immediately before the websocket send.
    if (!(await managedPreferenceDeliveryAllowed(record, { immediate: true }))) throw new Error('delivery authorization changed');
    delivered = Number(_sendNotificationFn?.(record.userId, {
      type: 'agent_notification', agent: record.agentId, content: text,
      from: { userName: record.label || record.skillId }, event: record.kind,
      data: {}, ts: Date.now(),
    })) || 0;
  } catch (e) { error = e?.message || String(e); }
  if (!(delivered > 0)) await budget.refundPingBudget(record.userId).catch(() => false);
  await inbox.recordProactiveDeliveryAttempt(record.userId, event.id, {
    claimToken: claimed.claimToken, deliveryCount: delivered, channel: 'websocket',
    error: delivered > 0 ? null : (error || 'user offline'),
  });
  return true;
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
  // Safe-auto informational monitors are permanently clamped at the final
  // delivery boundary. A handler-supplied override can never reach an agent
  // turn, email, or Telegram even if the persisted onFire object is mutated.
  const cfg = isSafeInformationalWatcher(record) ? { type: 'notify' } : record.onFire;
  if (!cfg) return false;
  const finalPreferenceAuthorization = async () => !isManagedPreferenceWatcher(record)
    || await managedPreferenceDeliveryAllowed(record);

  // If the watcher's owning skill is SANDBOXED (untrusted), onFire must not become an
  // escape hatch out of the jail. This is the single chokepoint — registration-time
  // onFire AND fire()/fireAgent() at tick time all land here — so the constraints below
  // cover every path a jailed skill could take.
  let untrusted = false;
  if (record.skillId) {
    try { const { isSandboxedSkill } = await import('../roles.mjs'); untrusted = isSandboxedSkill(record.skillId, record.userId); }
    catch { untrusted = false; }
  }

  // Untrusted 'agent' delivery is DOWNGRADED to a plain notification to the owner — no
  // agent turn, no tools, no confirmation-bypass. Otherwise a jailed skill could set
  // onFire.prompt (or fireAgent('…')) to make the coordinator take arbitrary actions
  // with the user's authority. A skill can inform its owner; it can't act as them.
  if (untrusted && cfg.type === 'agent') {
    const fireText = record.lastStatusText || `Monitor "${record.label}" fired.`;
    try {
      if (!(await finalPreferenceAuthorization())) return false;
      const delivered = Number(_sendNotificationFn?.(record.userId, {
        type: 'agent_notification', agent: record.agentId,
        content: `🔔 ${record.label}: ${fireText}`,
        from: { userName: record.label || record.skillId }, event: record.kind, data: {}, ts: Date.now(),
      })) || 0;
      return delivered > 0;
    } catch (e) {
      log.warn('watchers', 'untrusted onFire notify threw', { id: record.id, err: e.message });
      return false;
    }
  }

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
      if (!(await finalPreferenceAuthorization())) return false;
      const r = await sendEmailToUser(record.userId, {
        // Untrusted skills may only email the account owner (self) — ignore a
        // skill-supplied recipient, else onFire is a data-exfiltration channel.
        subject, body, html, to: untrusted ? undefined : cfg.to, account: cfg.account,
      });
      if (!r.ok) log.warn('watchers', 'email onFire failed', { id: record.id, err: r.message });
      else log.info('watchers', 'email onFire sent', { id: record.id, to: cfg.to || '(self)' });
      return r.ok === true;
    } catch (e) {
      log.warn('watchers', 'email onFire threw', { id: record.id, err: e.message });
      return false;
    }
  }

  // ── Telegram delivery — no LLM, no agent turn ────────────────────────────
  // cfg shape: { type: 'telegram', prefix? }
  // text = (cfg.prefix ?? '') + record.lastStatusText (or label as fallback).
  if (cfg.type === 'telegram') {
    try {
      const { sendTelegramToUser } = await import('../routes/telegram.mjs');
      const body = record.lastStatusText || `Your monitor "${record.label}" fired.`;
      const text = cfg.prefix ? `${cfg.prefix}\n\n${body}` : body;
      if (!(await finalPreferenceAuthorization())) return false;
      const ok = await sendTelegramToUser(record.userId, text);
      if (!ok) log.warn('watchers', 'telegram onFire failed', { id: record.id });
      else log.info('watchers', 'telegram onFire sent', { id: record.id });
      return !!ok;
    } catch (e) {
      log.warn('watchers', 'telegram onFire threw', { id: record.id, err: e.message });
      return false;
    }
  }

  if (cfg.type !== 'agent') return false;

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
    return false;
  }

  const isChild = getUser(userId)?.role === 'child';
  const resolved = getAgentsForUser(userId).find(a => a.id === rawAgentId)
    ?? (isChild ? null : getAgent(rawAgentId));
  if (!resolved) {
    log.warn('watchers', 'on_fire: agent not resolvable', { id: record.id, agentId: rawAgentId });
    return false;
  }

  const sessionKey = `${userId}_${resolved.id}`;
  const scopedAgent = { ...resolved, id: sessionKey };

  if (!(await finalPreferenceAuthorization())) return false;

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
  return succeeded === true;
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
      abortInFlightWatcher(userId, w.id, reason);
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
  const runtimeHelpers = _skillDir && !isManagedPreferenceWatcher(record) ? {
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
  const credentialHelpers = record.skillId
    ? buildSkillCredentials(record.userId, record.skillId)
    : null;
  const exposedCredentials = isManagedPreferenceWatcher(record) && credentialHelpers
    ? { get: credentialHelpers.get, list: credentialHelpers.list }
    : credentialHelpers;
  return {
    userId: record.userId,
    agentId: record.agentId,
    watcherId: record.id,
    // Per-skill encrypted secret store — same accessor as ctx.credentials, so a
    // skill's watcher handler reads the same config its tools stored.
    credentials: exposedCredentials,
    personalization: buildSkillPersonalizationHelpers({
      userId: record.userId,
      skillId: record.skillId,
      ...(isManagedPreferenceWatcher(record)
        ? { preferenceMemoryId: record.personalizationOrigin?.preferenceMemoryId } : {}),
    }),
    ...runtimeHelpers,
    browser,
    showImage: async (img) => isManagedPreferenceWatcher(record)
      ? false : _showImageFn?.(record.userId, { ...img, agent: record.agentId }),
    showVideo: async (vid) => isManagedPreferenceWatcher(record)
      ? false : _showVideoFn?.(record.userId, { ...vid, agent: record.agentId }),
    postStatus: async (text) => {
      if (isManagedPreferenceWatcher(record)) {
        const delivered = await deliverManagedPreferenceUpdate(record, text);
        return delivered;
      }
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
    notify: async (content, opts = {}) => {
      if (isManagedPreferenceWatcher(record)) {
        const delivered = await deliverManagedPreferenceUpdate(record, content);
        return delivered;
      }
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

      if (isManagedPreferenceWatcher(record)) {
        // Ignore every caller/item delivery override. Only the server-owned,
        // receipt-bound delivery path is reachable. Approved monitors may use
        // the exact persisted channel the user accepted; safe-auto remains
        // local notify-only.
        const safeMessage = message || (html ? stripHtml(html) : '') || record.label;
        const delivered = await deliverManagedPreferenceUpdate(record, safeMessage, {
          dispatchApproved: isApprovedPreferenceWatcher(record),
        });
        return delivered;
      }

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
      if (isSafeInformationalWatcher(record)) return false;
      if (isApprovedPreferenceWatcher(record)) {
        if (record.personalizationOrigin?.expectedDelivery !== 'agent') return false;
        return deliverManagedPreferenceUpdate(
          record, promptOverride || record.lastStatusText || record.label,
          { dispatchApproved: true },
        );
      }
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
