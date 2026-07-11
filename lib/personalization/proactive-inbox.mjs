// @ts-check
/**
 * Durable per-user proactive inbox/outbox.
 *
 * A proactive event is written before delivery is attempted.  Websocket
 * delivery can legitimately return zero (the user is offline), so an event
 * stays `pending` until at least one destination accepted it.  The UI can then
 * move `delivered` events to `read` without deleting their audit history.
 *
 * Storage intentionally uses an atomic, mode-0600 JSON file.  Event text can
 * contain personal data, so the containing directory is tightened to 0700 as
 * well.  Existing wider permissions are corrected on every write.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { USERS_DIR } from '../paths.mjs';
import { withLock, atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';
import { redactSecretsDeep, redactSecretsInText, sanitizeSignalMetadata } from './signal-safety.mjs';

const MAX_HISTORY_EVENTS = 500;
const DEFAULT_LEASE_MS = 2 * 60_000;
const VALID_STATUSES = new Set(['pending', 'delivered', 'read']);

function personalizationDir(userId) {
  return path.join(USERS_DIR, userId, 'personalization');
}

function inboxPath(userId) {
  return path.join(personalizationDir(userId), 'proactive-inbox.json');
}

function secureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX */ }
}

function isLivePreferenceMonitorReceipt(event) {
  return event?.kind === 'preference_monitor_activation'
    && (event?.metadata?.executionState === 'succeeded'
      || event?.metadata?.rollbackIncomplete === true);
}

function newestOperationalFirst(a, b) {
  const priority = Number(isLivePreferenceMonitorReceipt(b))
    - Number(isLivePreferenceMonitorReceipt(a));
  if (priority) return priority;
  const aMs = Date.parse(a?.createdAt || '');
  const bMs = Date.parse(b?.createdAt || '');
  return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
}

function readFile(userId) {
  const p = inboxPath(userId);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.events)) {
      throw new Error('invalid proactive inbox envelope');
    }
    return {
      version: Number.isInteger(data?.version) ? data.version : 0,
      events: Array.isArray(data?.events) ? data.events : [],
    };
  } catch (e) {
    if (e?.code === 'ENOENT') return { version: 0, events: [] };
    // Do not turn a corrupt/read-failed inbox into an empty file on the next
    // mutation.  Propagating lets the caller retry while preserving evidence.
    throw new Error(`proactive inbox read failed: ${e?.message || e}`);
  }
}

function writeFile(userId, file) {
  const dir = personalizationDir(userId);
  secureDir(dir);
  // A succeeded, still-controllable automatic monitor receipt is operational
  // state, not ordinary history: it is the exact watcher-to-policy stop
  // authority. Keep it until Stop/Undo/reconciliation transitions it away
  // from `succeeded`, even if hundreds of later receipts arrive.
  const pinnedControls = new Set(file.events.filter(isLivePreferenceMonitorReceipt));
  // Never discard undelivered work to make room for audit history. Bound only
  // delivered/read rows; pending rows remain durable until acknowledged.
  const history = file.events
    .filter(event => event?.status !== 'pending' && !pinnedControls.has(event))
    .sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
  const keptHistory = new Set(history.slice(-MAX_HISTORY_EVENTS));
  const events = file.events
    .filter(event => event?.status === 'pending' || pinnedControls.has(event) || keptHistory.has(event))
    .sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
  const data = {
    version: (file.version || 0) + 1,
    updated_at: Date.now(),
    events,
  };
  atomicWriteSync(inboxPath(userId), JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(inboxPath(userId), 0o600); } catch { /* best effort */ }
}

function cleanText(value, max) {
  return typeof value === 'string' ? redactSecretsInText(value, max) : '';
}

function publicEvent(event) {
  if (!event) return null;
  const { deliveryLeaseToken, deliveryLeaseExpiresAt, ...safe } = event;
  return safe;
}

function buildEvent(partial, dedupKey) {
  const now = new Date().toISOString();
  return {
    id: `pevt_${Date.now()}_${randomUUID().slice(0, 8)}`,
    dedupKey,
    kind: cleanText(partial.kind, 80) || 'personalization',
    sourceId: cleanText(partial.sourceId, 160) || null,
    title: cleanText(partial.title, 160) || 'Personalization',
    text: cleanText(partial.text, 1000),
    status: 'pending',
    createdAt: now,
    deliverAfter: partial.deliverAfter || null,
    deliveryAttempts: 0,
    deliveryCount: 0,
    lastAttemptAt: null,
    deliveredAt: null,
    readAt: null,
    channels: {},
    metadata: sanitizeSignalMetadata(partial.metadata),
  };
}

/**
 * Add an event, or return/update the existing event with the same dedupKey.
 * Existing delivered/read events are never moved backwards to pending.
 */
export async function enqueueProactiveEvent(userId, partial = {}) {
  if (!userId) throw new Error('enqueueProactiveEvent: userId required');
  const dedupKey = cleanText(partial.dedupKey, 240);
  if (!dedupKey) throw new Error('enqueueProactiveEvent: dedupKey required');
  return withLock(inboxPath(userId), () => {
    const file = readFile(userId);
    const existing = file.events.find(e => e?.dedupKey === dedupKey);
    if (existing) {
      // Refresh display fields while the item is pending (for example a better
      // lead summary), but do not resurrect an acknowledged item.
      if (existing.status === 'pending') {
        if (partial.title != null) existing.title = cleanText(partial.title, 160);
        if (partial.text != null) existing.text = cleanText(partial.text, 1000);
        if ('deliverAfter' in partial) existing.deliverAfter = partial.deliverAfter || null;
        if (partial.metadata && typeof partial.metadata === 'object' && !Array.isArray(partial.metadata)) {
          const executionState = existing.metadata?.executionState;
          existing.metadata = sanitizeSignalMetadata({ ...(existing.metadata || {}), ...partial.metadata });
          // Enqueue refreshes display content; it is never a lifecycle
          // transition primitive. Preserve a claimed/terminal execution state
          // so coalescing cannot turn an ambiguous send back into `ready`.
          if (executionState != null) existing.metadata.executionState = executionState;
        }
        writeFile(userId, file);
      }
      return publicEvent(existing);
    }

    const event = buildEvent(partial, dedupKey);
    file.events.push(event);
    writeFile(userId, file);
    return publicEvent(event);
  });
}

/**
 * Atomically reserve a deduplicated event exactly once. Unlike enqueue's
 * pending-row refresh behavior, an existing row is never modified. This is
 * the pre-side-effect idempotency boundary for automatic offer execution.
 */
export async function reserveProactiveEvent(userId, partial = {}) {
  if (!userId) throw new Error('reserveProactiveEvent: userId required');
  const dedupKey = cleanText(partial.dedupKey, 240);
  if (!dedupKey) throw new Error('reserveProactiveEvent: dedupKey required');
  return withLock(inboxPath(userId), () => {
    const file = readFile(userId);
    const existing = file.events.find(event => event?.dedupKey === dedupKey);
    if (existing) return { reserved: false, event: publicEvent(existing) };
    const event = buildEvent(partial, dedupKey);
    file.events.push(event);
    writeFile(userId, file);
    return { reserved: true, event: publicEvent(event) };
  });
}

/**
 * Trusted lifecycle update for an existing deduplicated event. Unlike enqueue,
 * this may refresh text/metadata after the user acknowledged the row, while
 * preserving its delivered/read status. Automatic execution uses it to commit
 * a final succeeded/failed state even if the reservation was read mid-run.
 */
export async function updateProactiveEventByDedupKey(userId, dedupKey, patch = {}) {
  if (!userId || !dedupKey) return null;
  return withLock(inboxPath(userId), () => {
    const file = readFile(userId);
    const event = file.events.find(item => item?.dedupKey === dedupKey);
    if (!event) return null;
    if (patch.expectedExecutionState != null
      && event?.metadata?.executionState !== patch.expectedExecutionState) return null;
    if (patch.title != null) event.title = cleanText(patch.title, 160);
    if (patch.text != null) event.text = cleanText(patch.text, 1000);
    if (patch.metadata && typeof patch.metadata === 'object' && !Array.isArray(patch.metadata)) {
      event.metadata = sanitizeSignalMetadata({ ...(event.metadata || {}), ...patch.metadata });
    }
    event.updatedAt = new Date().toISOString();
    writeFile(userId, file);
    return publicEvent(event);
  });
}

/** List newest-first. */
export async function listProactiveEvents(userId, { status = null, limit = 100, includeRead = true } = {}) {
  if (!userId) return [];
  const wanted = status == null ? null : String(status);
  if (wanted && !VALID_STATUSES.has(wanted)) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  return readFile(userId).events
    .filter(e => (!wanted || e.status === wanted) && (includeRead || e.status !== 'read'))
    .sort(newestOperationalFirst)
    .slice(0, cap)
    .map(publicEvent);
}

/** Exact-id lookup used by authenticated receipt controls. */
export async function getProactiveEvent(userId, id) {
  if (!userId || !id) return null;
  return publicEvent(readFile(userId).events.find(event => event?.id === id) || null);
}

/** Internal lifecycle scan that filters before applying its cap. */
export async function listProactiveEventsByKind(userId, kind, { limit = 100 } = {}) {
  if (!userId || typeof kind !== 'string' || !kind) return [];
  const cap = Math.max(1, Math.min(500, Number(limit) || 100));
  return readFile(userId).events
    .filter(event => event?.kind === kind)
    .sort(newestOperationalFirst)
    .slice(0, cap)
    .map(publicEvent);
}

/** Claim one pending event for an external delivery attempt. */
export async function claimProactiveEvent(userId, id, { now = new Date(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  if (!userId || !id) return null;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return withLock(inboxPath(userId), () => {
    const file = readFile(userId);
    const event = file.events.find(e => e?.id === id);
    if (!event || event.status !== 'pending') return null;
    const deliverMs = Date.parse(event.deliverAfter || '');
    if (Number.isFinite(deliverMs) && deliverMs > nowMs) return null;
    const leaseExpiry = Date.parse(event.deliveryLeaseExpiresAt || '');
    if (event.deliveryLeaseToken && Number.isFinite(leaseExpiry) && leaseExpiry > nowMs) return null;
    const token = `pclaim_${randomUUID()}`;
    event.deliveryLeaseToken = token;
    event.deliveryLeaseExpiresAt = new Date(nowMs + Math.max(10_000, Number(leaseMs) || DEFAULT_LEASE_MS)).toISOString();
    writeFile(userId, file);
    return { ...publicEvent(event), claimToken: token };
  });
}

/**
 * Finish a claimed delivery attempt. deliveryCount=0 releases it back to
 * pending; a positive count transitions it to delivered.
 * @param {string} userId
 * @param {string} id
 * @param {{claimToken?: string, deliveryCount?: number, channel?: string, error?: any}} [attempt]
 */
export async function recordProactiveDeliveryAttempt(userId, id, {
  claimToken, deliveryCount = 0, channel = 'websocket', error = null,
} = {}) {
  if (!userId || !id || !claimToken) return null;
  return withLock(inboxPath(userId), () => {
    const file = readFile(userId);
    const event = file.events.find(e => e?.id === id);
    if (!event || event.deliveryLeaseToken !== claimToken) return null;
    const count = Math.max(0, Math.floor(Number(deliveryCount) || 0));
    event.deliveryAttempts = Math.max(0, Number(event.deliveryAttempts) || 0) + 1;
    event.lastAttemptAt = new Date().toISOString();
    event.lastError = error
      ? redactSecretsDeep(cleanText(String(error), 300), { maxString: 300 })
      : null;
    event.deliveryLeaseToken = null;
    event.deliveryLeaseExpiresAt = null;
    if (count > 0) {
      event.deliveryCount = Math.max(0, Number(event.deliveryCount) || 0) + count;
      event.channels = (event.channels && typeof event.channels === 'object') ? event.channels : {};
      event.channels[channel] = Math.max(0, Number(event.channels[channel]) || 0) + count;
      event.status = 'delivered';
      event.deliveredAt = event.deliveredAt || new Date().toISOString();
    }
    writeFile(userId, file);
    return publicEvent(event);
  });
}

/**
 * Record delivery by an in-channel surface (briefing/digest/email) that does
 * not participate in the websocket lease protocol.
 */
export async function markProactiveEventDelivered(userId, id, { deliveryCount = 1, channel = 'inbox' } = {}) {
  if (!userId || !id) return null;
  return withLock(inboxPath(userId), () => {
    const file = readFile(userId);
    const event = file.events.find(e => e?.id === id);
    if (!event) return null;
    // Marking is idempotent. A briefing retry after a crash must not inflate
    // delivery counts or move a read item backwards.
    if (event.status === 'delivered' || event.status === 'read') return publicEvent(event);
    const count = Math.max(1, Math.floor(Number(deliveryCount) || 1));
    event.deliveryAttempts = Math.max(0, Number(event.deliveryAttempts) || 0) + 1;
    event.lastAttemptAt = new Date().toISOString();
    event.deliveryCount = Math.max(0, Number(event.deliveryCount) || 0) + count;
    event.channels = (event.channels && typeof event.channels === 'object') ? event.channels : {};
    event.channels[channel] = Math.max(0, Number(event.channels[channel]) || 0) + count;
    if (event.status !== 'read') event.status = 'delivered';
    event.deliveredAt = event.deliveredAt || new Date().toISOString();
    event.deliveryLeaseToken = null;
    event.deliveryLeaseExpiresAt = null;
    writeFile(userId, file);
    return publicEvent(event);
  });
}

export async function markProactiveEventDeliveredByDedupKey(userId, dedupKey, opts = {}) {
  if (!userId || !dedupKey) return null;
  const event = readFile(userId).events.find(e => e?.dedupKey === dedupKey);
  return event ? markProactiveEventDelivered(userId, event.id, opts) : null;
}

export async function markProactiveEventRead(userId, id) {
  if (!userId || !id) return null;
  return withLock(inboxPath(userId), () => {
    const file = readFile(userId);
    const event = file.events.find(e => e?.id === id);
    if (!event) return null;
    event.status = 'read';
    event.readAt = event.readAt || new Date().toISOString();
    event.deliveryLeaseToken = null;
    event.deliveryLeaseExpiresAt = null;
    writeFile(userId, file);
    return publicEvent(event);
  });
}

export async function markAllProactiveEventsRead(userId) {
  if (!userId) return 0;
  return withLock(inboxPath(userId), () => {
    const file = readFile(userId);
    const now = new Date().toISOString();
    let changed = 0;
    for (const event of file.events) {
      if (event.status === 'read') continue;
      event.status = 'read';
      event.readAt = event.readAt || now;
      event.deliveryLeaseToken = null;
      event.deliveryLeaseExpiresAt = null;
      changed++;
    }
    if (changed) writeFile(userId, file);
    return changed;
  });
}

/** Preserve but neutralize watcher updates after exact Stop/Undo. */
export async function cancelPendingProactiveEventsBySource(userId, kind, sourceId, { reason = 'canceled' } = {}) {
  if (!userId || !kind || !sourceId) return 0;
  return withLock(inboxPath(userId), () => {
    const file = readFile(userId);
    const now = new Date().toISOString();
    let changed = 0;
    for (const event of file.events) {
      if (event?.kind !== kind || event.sourceId !== sourceId) continue;
      let touched = false;
      if (event.status === 'pending') {
        event.status = 'read';
        event.readAt = event.readAt || now;
        event.deliveryLeaseToken = null;
        event.deliveryLeaseExpiresAt = null;
        touched = true;
      }
      const control = event.metadata?.control;
      if (control && Array.isArray(control.actions) && control.actions.length) touched = true;
      if (!touched) continue;
      event.metadata = sanitizeSignalMetadata({
        ...(event.metadata || {}), deliveryState: 'canceled', canceledAt: now,
        cancellationReason: cleanText(reason, 80),
        ...(control ? { control: { ...control, actions: [], state: reason } } : {}),
      });
      changed++;
    }
    if (changed) writeFile(userId, file);
    return changed;
  });
}
