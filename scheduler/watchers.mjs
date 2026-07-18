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
import { resolveRuntimeAgentId } from '../routes/_helpers/agent-resolver.mjs';
import { tryAcquireUserTurnLease } from '../chat-dispatch/slot-registry.mjs';
import {
  bindCollectionDeps,
  COLLECTION_TICK_SEC,
  addCollectionItem,
  removeCollectionItem,
  updateCollectionItem,
  listCollectionItems,
  getCollectionItem,
  listAllCollections,
} from './watchers/collections.mjs';
export {
  COLLECTION_TICK_SEC,
  addCollectionItem,
  removeCollectionItem,
  updateCollectionItem,
  listCollectionItems,
  getCollectionItem,
  listAllCollections,
} from './watchers/collections.mjs';

import {
  bindEventBusDeps,
  subscribeToEvent,
  unsubscribeFromEvent,
  registerEventSubscriptionHandler,
} from './watchers/events.mjs';
export { emitEvent } from './watchers/events.mjs';

import {
  TICK_MS,
  DEFAULT_CADENCE_SEC,
  DEFAULT_EXPIRY_MS,
  SOFT_EXPIRY_WARN_MS,
  MAX_PER_USER,
  MAX_FAILURES,
  RECENT_KEEP_MS,
  MAX_HISTORY_ENTRIES,
  MAX_MEDIA_DELIVERY_RESERVATIONS,
  STUCK_RATIO,
  STUCK_BACKOFF_MAX_SEC,
  EXTERNAL_DISPATCH_STALE_MS,
  lifecycle,
  byUser,
  watcherLoadErrors,
  inFlight,
  inFlightControllers,
} from './watchers/store.mjs';

import {
  bindSupervisorDeps,
  handlerHelpers,
  unregisterMatchingWatchers,
  startWatcherSupervisor,
  stopWatcherSupervisor,
  isWatcherSupervisorRunning,
  pushHistory,
  finalizeWatcher,
  watcherStatusPayload,
  deliverManagedPreferenceUpdate,
  __test as __supervisorTest,
} from './watchers/supervisor.mjs';
export {
  handlerHelpers,
  unregisterMatchingWatchers,
  startWatcherSupervisor,
  stopWatcherSupervisor,
  isWatcherSupervisorRunning,
};



// Keep persisted watcher ownership untouched for exact switch-back behavior,
// but route every outward surface through the currently active projection.
function runtimeWatcherAgentRef(record) {
  const stored = typeof record?.agentId === 'string' ? record.agentId : '';
  const userId = record?.userId;
  if (!userId) return stored;
  const prefix = `${userId}_`;
  const raw = stored.startsWith(prefix) ? stored.slice(prefix.length) : stored;
  const resolved = resolveRuntimeAgentId(userId, raw || null);
  if (!resolved) return stored;
  return stored.startsWith(prefix) ? `${prefix}${resolved}` : resolved;
}

function abortInFlightWatcher(userId, watcherId, reason = 'watcher stopped') {
  const controller = inFlightControllers.get(`${userId}:${watcherId}`);
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
  if (byUser.has(userId)) return byUser.get(userId);
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
      watcherLoadErrors.delete(userId);
    }
  } catch (e) {
    watcherLoadErrors.set(userId, e instanceof Error ? e : new Error(String(e)));
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

  byUser.set(userId, data);
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
      if (watcherLoadErrors.has(userId)) byUser.delete(userId);
      watcherLoadErrors.delete(userId);
      return true;
    }
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !Array.isArray(parsed.active) || !Array.isArray(parsed.recent)) {
      throw new Error('invalid watchers envelope');
    }
  } catch (e) {
    watcherLoadErrors.set(userId, e instanceof Error ? e : new Error(String(e)));
    throw new Error(`watcher store is unreadable: ${e?.message || e}`);
  }
  if (watcherLoadErrors.has(userId)) {
    // A valid direct read means an out-of-band repair landed; refresh the
    // previously fail-closed empty cache on the next access.
    watcherLoadErrors.delete(userId);
    byUser.delete(userId);
  }
  return true;
}

function _writeUserNow(userId) {
  const data = byUser.get(userId);
  if (!data) return false;
  const p = watchersPath(userId);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(p), 0o700); } catch { /* best effort */ }
    atomicWriteSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
    watcherLoadErrors.delete(userId);
    return true;
  } catch (e) {
    log.warn('watchers', `Failed to persist ${userId} watchers`, { err: e.message });
    return false;
  }
}

// Debounced persistence for HIGH-FREQUENCY updates (pushWatcherStatus gets a
// call per tool_progress chunk — tens per second during a streaming
// delegation, each of which used to stringify + writeFileSync the user's
// whole watchers file on the event loop). The in-memory byUser map is the
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
 * @param {boolean} [opts.requirePersist=false] Roll back registration unless
 *                                   the initial durable write succeeds.
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
  if ((safeContext?.activationNonce || opts.requirePersist === true) && !persisted) {
    data.active = data.active.filter(watcher => watcher !== record);
    if (kind === 'event_subscription') unsubscribeFromEvent(record);
    throw new Error('watcher registration could not be persisted');
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
  const data = byUser.get(userId);
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
    lifecycle.sendStatusFn?.(userId, watcherStatusPayload(record, text));
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
  const data = byUser.get(userId);
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

// Event bus: scheduler/watchers/events.mjs (subscribe/unsubscribe/emitEvent).

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
      const stillActive = byUser.get(record.userId)?.active
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
    const current = byUser.get(record.userId)?.active?.find(watcher => watcher.id === record.id);
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
  const exactManagedWatcherIsActive = () => byUser.get(record.userId)?.active
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
      state: record.state, userId: record.userId, agentId: runtimeWatcherAgentRef(record), watcherId: record.id,
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

// Wire collection + event bus + supervisor to this module's helpers/persistence.
bindCollectionDeps({ loadUserWatchers, persistUser, unregisterWatcher });
bindEventBusDeps({
  getUserStore: (userId) => byUser.get(userId) || null,
  persistUser,
  setSystemHandler: (kind, fn) => _systemHandlers.set(kind, fn),
});
registerEventSubscriptionHandler();
bindSupervisorDeps({
  abortInFlightWatcher,
  isApprovedPreferenceWatcher,
  isManagedPreferenceWatcher,
  isSafeInformationalWatcher,
  listWatchers,
  loadAllUsersFromDisk,
  loadUserWatchers,
  persistUser,
  releaseApprovedPreferenceGrant,
  resolveHandler,
  runCustomWatcherSandboxed,
  runtimeWatcherAgentRef,
  stopUnauthorizedPreferenceWatcher,
  unregisterWatcher,
  subscribeToEvent,
  unsubscribeFromEvent,
});

// Narrow regression seam — same tickOne the supervisor interval drives.
export const __test = __supervisorTest;
