// @ts-check
/**
 * Watcher supervisor loop, tickOne, on-fire, handlerHelpers, lifecycle.
 * Shared store: ./store.mjs. Parent binds remaining helpers via bindSupervisorDeps.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { USERS_DIR, SKILLS_DIR, userSkillsDir } from '../../lib/paths.mjs';
import { buildSkillCredentials } from '../../lib/credentials.mjs';
import { buildRuntimeBroker } from '../../lib/skill-runtime-broker.mjs';
import { log } from '../../logger.mjs';
import { buildSkillPersonalizationHelpers } from '../../lib/personalization/skill-helper.mjs';
import { tryAcquireUserTurnLease } from '../../chat-dispatch/slot-registry.mjs';
import { resolveRuntimeAgentId } from '../../routes/_helpers/agent-resolver.mjs';
import {
  TICK_MS,
  DEFAULT_CADENCE_SEC,
  MAX_FAILURES,
  MAX_HISTORY_ENTRIES,
  MAX_MEDIA_DELIVERY_RESERVATIONS,
  STUCK_RATIO,
  STUCK_BACKOFF_MAX_SEC,
  EXTERNAL_DISPATCH_STALE_MS,
  lifecycle,
  byUser,
  inFlight,
  inFlightControllers,
} from './store.mjs';

/** @type {any} */
let abortInFlightWatcher = () => {};
/** @type {any} */
let isApprovedPreferenceWatcher = () => false;
/** @type {any} */
let isManagedPreferenceWatcher = () => false;
/** @type {any} */
let isSafeInformationalWatcher = () => false;
/** @type {any} */
let listWatchers = () => [];
/** @type {any} */
let loadAllUsersFromDisk = () => null;
/** @type {any} */
let loadUserWatchers = () => null;
/** @type {any} */
let persistUser = () => false;
/** @type {any} */
let releaseApprovedPreferenceGrant = () => {};
/** @type {any} */
let resolveHandler = async () => null;
/** @type {any} */
let runCustomWatcherSandboxed = async () => null;
/** @type {any} */
let runtimeWatcherAgentRef = () => {};
/** @type {any} */
let stopUnauthorizedPreferenceWatcher = async () => null;
/** @type {any} */
let unregisterWatcher = () => {};
/** @type {any} */
let subscribeToEvent = () => {};
/** @type {any} */
let unsubscribeFromEvent = () => {};

export function bindSupervisorDeps(deps) {
  if (deps.abortInFlightWatcher !== undefined) abortInFlightWatcher = deps.abortInFlightWatcher;
  if (deps.isApprovedPreferenceWatcher !== undefined) isApprovedPreferenceWatcher = deps.isApprovedPreferenceWatcher;
  if (deps.isManagedPreferenceWatcher !== undefined) isManagedPreferenceWatcher = deps.isManagedPreferenceWatcher;
  if (deps.isSafeInformationalWatcher !== undefined) isSafeInformationalWatcher = deps.isSafeInformationalWatcher;
  if (deps.listWatchers !== undefined) listWatchers = deps.listWatchers;
  if (deps.loadAllUsersFromDisk !== undefined) loadAllUsersFromDisk = deps.loadAllUsersFromDisk;
  if (deps.loadUserWatchers !== undefined) loadUserWatchers = deps.loadUserWatchers;
  if (deps.persistUser !== undefined) persistUser = deps.persistUser;
  if (deps.releaseApprovedPreferenceGrant !== undefined) releaseApprovedPreferenceGrant = deps.releaseApprovedPreferenceGrant;
  if (deps.resolveHandler !== undefined) resolveHandler = deps.resolveHandler;
  if (deps.runCustomWatcherSandboxed !== undefined) runCustomWatcherSandboxed = deps.runCustomWatcherSandboxed;
  if (deps.runtimeWatcherAgentRef !== undefined) runtimeWatcherAgentRef = deps.runtimeWatcherAgentRef;
  if (deps.stopUnauthorizedPreferenceWatcher !== undefined) stopUnauthorizedPreferenceWatcher = deps.stopUnauthorizedPreferenceWatcher;
  if (deps.unregisterWatcher !== undefined) unregisterWatcher = deps.unregisterWatcher;
  if (deps.subscribeToEvent !== undefined) subscribeToEvent = deps.subscribeToEvent;
  if (deps.unsubscribeFromEvent !== undefined) unsubscribeFromEvent = deps.unsubscribeFromEvent;
}

// ── supervisor loop ──────────────────────────────────────────────────────────

async function tickOne(record, handlerOverride = null) {
  const inFlightKey = `${record.userId}:${record.id}`;
  if (inFlight.has(inFlightKey)) return; // previous tick still running
  inFlight.add(inFlightKey);
  const tickController = new AbortController();
  inFlightControllers.set(inFlightKey, tickController);

  try {
    // A crash/interruption between registration and durable receipt commit can
    // leave a nonce-stamped pending watcher on disk. It is never allowed to
    // run a handler; the receipt reconciler may also remove it sooner.
    if (['preference_safe_auto_pending', 'preference_approved_pending']
      .includes(record?.personalizationOrigin?.type)) {
      unregisterWatcher(record.userId, record.id, 'auto_activation_orphan');
      return;
    }

    // Revocation is checked before any custom module, preference verifier, or
    // sandbox process can run. This covers child allowedSkills changes and
    // ordinary per-user skill disablement for already-persisted watchers.
    if (record.skillId) {
      let enabled = false;
      try {
        const roles = await import('../../roles.mjs');
        enabled = roles.isSkillRuntimeEnabledForUser(record.skillId, record.userId);
      } catch { enabled = false; }
      if (!enabled) {
        finalizeWatcher(record, 'cancelled', `Monitor stopped: skill "${record.skillId}" is no longer permitted.`);
        return;
      }
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
        const authorization = await import('../../lib/personalization/preference-opportunities.mjs');
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
      const current = byUser.get(record.userId)?.active?.find(watcher => watcher.id === record.id);
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
      const live = byUser.get(record.userId)?.active?.find(watcher => watcher.id === record.id);
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
      try { const { isSandboxedSkill } = await import('../../roles.mjs'); sandboxed = isSandboxedSkill(record.skillId, record.userId); }
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
      const handler = handlerOverride ?? await resolveHandler(record);
      if (!handler) {
        log.warn('watchers', 'Handler not found', { kind: record.kind, skillId: record.skillId });
        failTick(`❌ No handler registered for kind=${record.kind}.`);
        return;
      }
      try {
        result = await handler(record.state, handlerHelpers(record, { signal: tickController.signal }));
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
    let postHandlerLive = byUser.get(record.userId)?.active
      ?.find(watcher => watcher.id === record.id);
    const postHandlerSnooze = Date.parse(record.snoozedUntil || '');
    if (postHandlerLive !== record || record.status !== 'active'
      || (Number.isFinite(postHandlerSnooze) && postHandlerSnooze > Date.now())) return;
    if (isManagedPreferenceWatcher(record)) {
      let stillAuthorized = false;
      try {
        const authorization = await import('../../lib/personalization/preference-opportunities.mjs');
        stillAuthorized = isSafeInformationalWatcher(record)
          ? await authorization.preferenceSafeAutoWatcherIsAuthorized(record.userId, record)
          : await authorization.preferenceApprovedWatcherIsAuthorized(record.userId, record);
      } catch { stillAuthorized = false; }
      if (!stillAuthorized) {
        await stopUnauthorizedPreferenceWatcher(record);
        return;
      }
      postHandlerLive = byUser.get(record.userId)?.active
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
          if (!isManagedPreferenceWatcher(record) && lifecycle.sendStatusFn) {
            lifecycle.sendStatusFn(record.userId, {
              type: 'status',
              agent: runtimeWatcherAgentRef(record),
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
      if (lifecycle.sendStatusFn) {
        lifecycle.sendStatusFn(record.userId, {
          type: 'status',
          agent: runtimeWatcherAgentRef(record),
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
    const persisted = persistUser(record.userId);
    if (result?.requirePersist === true && !persisted) {
      // Paid/external submission claims must be durable before the following
      // tick can initiate I/O. Remove the in-memory watcher on failure so this
      // process cannot advance a claim that disk still records as queued.
      finalizeWatcher(record, 'error', `❌ ${record.label}: durable pre-submission claim could not be saved; no provider request was sent.`);
    }
  } finally {
    inFlight.delete(inFlightKey);
    if (inFlightControllers.get(inFlightKey) === tickController) {
      inFlightControllers.delete(inFlightKey);
    }
  }
}

export function pushHistory(record, entry) {
  if (!Array.isArray(record.history)) record.history = [];
  record.history.push(entry);
  if (record.history.length > MAX_HISTORY_ENTRIES) {
    record.history = record.history.slice(-MAX_HISTORY_ENTRIES);
  }
}

export function watcherStatusPayload(record, text, extra = {}) {
  return {
    type: 'status',
    agent: runtimeWatcherAgentRef(record),
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

export function finalizeWatcher(record, status, finalText) {
  const data = byUser.get(record.userId);
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
  if (lifecycle.sendStatusFn && finalText && !isManagedPreferenceWatcher(record)) {
    lifecycle.sendStatusFn(record.userId, watcherStatusPayload(record, finalText, {
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
      import('../../lib/personalization/config.mjs'),
      import('../../lib/personalization/graduation.mjs'),
    ]);
    const cfg = await configModule.getConfig(record.userId);
    if (cfg.enabled !== true || cfg.setupComplete !== true
      || (typeof configModule.isQuietEngagement === 'function'
        ? configModule.isQuietEngagement(cfg)
        : cfg.proactivity === 'quiet' || cfg.engagement === 'quiet')) return false;
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
    const authorization = await import('../../lib/personalization/preference-opportunities.mjs');
    return isSafeInformationalWatcher(record)
      ? await authorization.preferenceSafeAutoWatcherIsAuthorized(record.userId, record)
      : await authorization.preferenceApprovedWatcherIsAuthorized(record.userId, record);
  } catch { return false; }
}

export async function deliverManagedPreferenceUpdate(record, value, { dispatchApproved = false } = {}) {
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
  const inbox = await import('../../lib/personalization/proactive-inbox.mjs');
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
    const { recordOpportunityOutcome } = await import('../../lib/personalization/opportunity-utility.mjs');
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
  const budget = await import('../../lib/personalization/graduation.mjs');
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
    delivered = Number(lifecycle.sendNotificationFn?.(record.userId, {
      type: 'agent_notification', agent: runtimeWatcherAgentRef(record), content: text,
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
function watcherDeliveryIdempotencyScope(record) {
  const eventKey = String(record?._deliveryIdempotencyEventKey || record?._emailIdempotencyEventKey || '').trim();
  if (eventKey) {
    // A retained collection event may be retried on a later supervisor tick
    // after an ambiguous provider boundary. Bind it to the durable event, not
    // record.ticks, so that replay fails closed across ticks and restarts.
    const eventDigest = createHash('sha256').update(eventKey).digest('hex').slice(0, 24);
    return `watcher:${record.id}:event:${eventDigest}`;
  }
  const slot = String(record?._deliveryIdempotencySlot || record?._emailIdempotencySlot || 'on-fire');
  const slotDigest = createHash('sha256').update(slot).digest('hex').slice(0, 24);
  return `watcher:${record.id}:tick:${Number(record.ticks) || 0}:slot:${slotDigest}`;
}

const watcherEmailIdempotencyScope = watcherDeliveryIdempotencyScope;

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
    try { const { isSandboxedSkill } = await import('../../roles.mjs'); untrusted = isSandboxedSkill(record.skillId, record.userId); }
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
      const delivered = Number(lifecycle.sendNotificationFn?.(record.userId, {
        type: 'agent_notification', agent: runtimeWatcherAgentRef(record),
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
      const { sendEmailToUser } = await import('../../lib/email-delivery.mjs');
      const subject = cfg.subject || `Monitor: ${record.label}`;
      const html    = cfg._html || record.lastStatusHtml || undefined;
      const body    = record.lastStatusText || (html ? stripHtml(html) : null) || `Your monitor "${record.label}" fired.`;
      if (!(await finalPreferenceAuthorization())) return false;
      const r = await sendEmailToUser(record.userId, {
        // Untrusted skills may only email the account owner (self) — ignore a
        // skill-supplied recipient, else onFire is a data-exfiltration channel.
        subject, body, html, to: untrusted ? undefined : cfg.to, account: cfg.account,
        idempotencyScope: watcherEmailIdempotencyScope(record),
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
      const { sendTelegramToUser } = await import('../../routes/telegram.mjs');
      const body = record.lastStatusText || `Your monitor "${record.label}" fired.`;
      const text = cfg.prefix ? `${cfg.prefix}\n\n${body}` : body;
      if (!(await finalPreferenceAuthorization())) return false;
      const ok = await sendTelegramToUser(record.userId, text, {
        idempotencyScope: watcherDeliveryIdempotencyScope(record),
      });
      if (!ok) log.warn('watchers', 'telegram onFire failed', { id: record.id });
      else log.info('watchers', 'telegram onFire sent', { id: record.id });
      return !!ok;
    } catch (e) {
      log.warn('watchers', 'telegram onFire threw', { id: record.id, err: e.message });
      return false;
    }
  }

  if (cfg.type !== 'agent') return false;

  const { streamChat } = await import('../../chat.mjs');
  const { appendToSession } = await import('../../sessions.mjs');
  const { resolveRuntimeAgentForUser } = await import('../../routes/_helpers.mjs');
  const { runAgentWithRetry } = await import('../../lib/run-agent-with-retry.mjs');

  const userId = record.userId;
  const scoped = record.agentId || '';
  const rawAgentId = scoped.startsWith(`${userId}_`) ? scoped.slice(userId.length + 1) : scoped;
  if (!rawAgentId) {
    log.warn('watchers', 'on_fire: no agent id on record', { id: record.id });
    return false;
  }

  // A terminal successful watcher has already committed its predicate hit and
  // must deliver even though finalizeWatcher moved it out of `active`. By
  // contrast, fire()/fireAgent() run while a recurring watcher is still active;
  // Stop/Undo must be able to revoke that pending action while it waits behind
  // a topology writer. Those helpers pass a synthetic record, so check the live
  // store by id rather than relying on object identity or the copied status.
  const agentActionStillAllowed = () => {
    if (record.status === 'done') return true;
    if (record.status !== 'active') return false;
    return byUser.get(userId)?.active
      ?.some(watcher => watcher.id === record.id && watcher.status === 'active') === true;
  };

  let topologyLease = null;
  let topologyWaits = 0;
  while (!topologyLease) {
    if (!agentActionStillAllowed()) {
      log.info('watchers', 'on_fire cancelled while waiting for account topology', { id: record.id });
      return false;
    }
    topologyLease = tryAcquireUserTurnLease(userId, { label: `watcher:${record.id}` });
    if (!topologyLease) {
      topologyWaits++;
      // Mode changes are brief under normal operation, but a fixed two-second
      // retry cap silently discarded an already-fired action if storage or a
      // deferred interactive transition ran long. Keep the watcher action
      // pending in-process until the writer releases instead of
      // converting ordinary topology contention into a dropped delivery.
      if (topologyWaits === 80) {
        log.info('watchers', 'on_fire waiting for account topology change', { id: record.id });
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  try {
    // Stop/Undo may have won immediately before the writer released and this
    // reader acquired. Recheck inside the lease before resolving or appending
    // anything to an agent session.
    if (!agentActionStillAllowed()) return false;

    const resolved = resolveRuntimeAgentForUser(userId, rawAgentId);
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

    const watcherActionGuidance = scopedAgent._rosterSolo === true
      ? 'Use your own tools and complete the action directly. If a needed tool is missing this turn, call request_tools; use spawn_worker only for genuinely long or parallel work.'
      : 'Use any ask_agent / tools needed and complete the action directly.';
    const watcherNote =
    `[WATCHER FIRED] You are reacting to a condition-triggered monitor that just fired. ` +
    `The user is NOT present. The watch label is "${record.label}" and its result is: ${fireText}. ` +
    `${watcherActionGuidance} Do NOT show a draft, ask "are you sure?", or wait for confirmation. ` +
    `Report what you did in your final message.`;

    log.info('watchers', 'on_fire agent run', { id: record.id, agentId: sessionKey });

  // Retry on stream errors, fetch throws, and LoopGuard stalls — all surfaced
  // through the shared helper. Single attempt by default keeps the previous
  // single-shot behavior; bump if a watcher class proves to need more.
    // The predicate watcher is already finalized. Give its unattended reaction
    // a distinct no-chip owner so nested tools await real results without
    // reopening the completed watcher.
    const runRootTaskId = `watcher:${record.id}:${record.endedAt || record.lastChangeAt || record.createdAt || 'current'}`;
    const { succeeded, lastError } = await runAgentWithRetry({
    scopedAgent, userText: userPrompt, systemNote: watcherNote, userId, streamChat,
    maxAttempts: 1,
    context: 'watchers',
    // A finalized watcher persists endedAt before onFire is dispatched. Reuse
    // that durable occurrence identity if this action is resumed/replayed;
    // active helper-fired watchers fall back to their last persisted change.
    rootTaskId: runRootTaskId,
    traceSource: 'watcher',
    taskContext: {
      taskId: runRootTaskId,
      watcherId: null,
      userId,
      agentId: sessionKey,
      rootTaskId: runRootTaskId,
      rootWatcherId: null,
      visibleAgentId: sessionKey,
      spanId: `${runRootTaskId}:agent`,
    },
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
    lifecycle.sendStatusFn?.(record.userId, {
      type: 'status',
      agent: runtimeWatcherAgentRef(record),
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
    lifecycle.sendStatusFn?.(record.userId, {
    type: 'task_complete',
    taskId: `watcher_${record.id}`,
    agent: resolved.id,
    });
    return succeeded === true;
  } finally {
    topologyLease.release();
  }
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

function reserveWatcherMediaDelivery(record, deliveryId, sessionKey) {
  if (!record?.id || !record?.userId || typeof deliveryId !== 'string' || !deliveryId
      || deliveryId.length > 300 || typeof sessionKey !== 'string'
      || !sessionKey.startsWith(`${record.userId}_`) || sessionKey.length > 600
      || /[\r\n\0]/.test(sessionKey)) {
    throw new Error('watcher media delivery reservation is invalid');
  }
  const previous = record.mediaDeliveryReservations;
  if (previous != null && !Array.isArray(previous)) {
    throw new Error('watcher media delivery reservation store is invalid');
  }
  const existing = (previous || []).filter(row => row?.deliveryId === deliveryId);
  if (existing.length > 1 || (existing[0] && (typeof existing[0].sessionKey !== 'string'
      || !existing[0].sessionKey.startsWith(`${record.userId}_`)))) {
    throw new Error('watcher media delivery reservation is corrupt');
  }
  if (existing[0]) return existing[0].sessionKey;
  if ((previous?.length || 0) >= MAX_MEDIA_DELIVERY_RESERVATIONS) {
    throw new Error('watcher media delivery reservation limit reached');
  }

  record.mediaDeliveryReservations = [
    ...(previous || []),
    { deliveryId, sessionKey, reservedAt: Date.now() },
  ];
  if (!persistUser(record.userId)) {
    if (previous === undefined) delete record.mediaDeliveryReservations;
    else record.mediaDeliveryReservations = previous;
    throw new Error('watcher media delivery session could not be persisted');
  }
  return sessionKey;
}

async function acquireWatcherMediaTopologyLease(record, isLive, signal) {
  while (isLive()) {
    const lease = tryAcquireUserTurnLease(record.userId, {
      label: `watcher-media:${record.id}`,
    });
    if (lease) return lease;
    await new Promise(resolve => setTimeout(resolve, 25));
    if (signal?.aborted) return null;
  }
  return null;
}

export function handlerHelpers(record, { signal = null } = {}) {
  const mediaDeliveryIsLive = () => !signal?.aborted
    && record.status === 'active'
    && byUser.get(record.userId)?.active?.find(watcher => watcher.id === record.id) === record;
  // ctx.browser shorthand for watcher handlers — same primitives the
  // skill-side ctx.browser exposes, bound to record.userId. Lets a
  // collection-watcher handler use the user's connected browser as its
  // fetcher (Best Buy stock pages, sites without RSS / public APIs, etc.).
  // Lazy-imported so watchers that don't touch the browser pay nothing.
  let _browserCache = null;
  let deliveryFireSequence = 0;
  async function getBrowser() {
    if (_browserCache) return _browserCache;
    const { buildBrowserHelpers } = await import('../../lib/browser-helper.mjs');
    _browserCache = buildBrowserHelpers({ userId: record.userId, agentId: runtimeWatcherAgentRef(record) });
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
      const rt = await import('../../lib/skill-runtime.mjs');
      const existing = rt.resolveSkillBinary(_skillDir, name);
      if (existing) return existing;
      throw new Error(`ensureRuntime: "${name}" is not provisioned for skill "${record.skillId}" — run it once via the skill's own tools first; watcher ticks cannot download binaries.`);
    },
    runSandboxed: async (bin, binArgs = [], opts = {}) => {
      const sb = await import('../../lib/skill-sandbox.mjs');
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
    agentId: runtimeWatcherAgentRef(record),
    watcherId: record.id,
    signal,
    // System collection handlers need to choose between the lightweight WS
    // notification helper and fire(), which owns email/Telegram/agent
    // delivery. Keep the persisted server-side choice out of skill state.
    deliveryMode: record.onFire?.type || null,
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
    showImage: async (img) => {
      if (isManagedPreferenceWatcher(record) || !mediaDeliveryIsLive()) return false;
      const topologyLease = await acquireWatcherMediaTopologyLease(
        record,
        mediaDeliveryIsLive,
        signal,
      );
      if (!topologyLease) return false;
      try {
        if (!mediaDeliveryIsLive()) return false;
        const runtimeAgent = runtimeWatcherAgentRef(record);
        if (!runtimeAgent) return false;
        return await lifecycle.showImageFn?.(record.userId, { ...img, agent: runtimeAgent });
      } finally {
        topologyLease.release();
      }
    },
    showVideo: async (vid) => {
      if (isManagedPreferenceWatcher(record)) return false;
      if (!mediaDeliveryIsLive()) return false;
      const filename = typeof vid?.filename === 'string' ? vid.filename : '';
      const url = typeof vid?.url === 'string' ? vid.url : '';
      if (!filename || !url) return false;
      const deliveryId = String(vid?.deliveryId || filename).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 300);
      const reportId = `watcher-video:${record.id}:${deliveryId}`;
      if (!deliveryId) return false;
      const topologyLease = await acquireWatcherMediaTopologyLease(
        record,
        mediaDeliveryIsLive,
        signal,
      );
      if (!topologyLease) return false;
      try {
        if (!mediaDeliveryIsLive()) return false;
        // Resolve only after acquiring the topology reader and keep that lease
        // through reservation, durable append, and the optional live send.
        const runtimeAgent = runtimeWatcherAgentRef(record);
        const currentSession = runtimeAgent
          ? (String(runtimeAgent).startsWith(`${record.userId}_`)
              ? String(runtimeAgent)
              : `${record.userId}_${runtimeAgent}`)
          : null;
        if (!currentSession) return false;
        const reservedSession = reserveWatcherMediaDelivery(
          record,
          deliveryId,
          currentSession,
        );
        const { appendSessionReportOnce } = await import('../../sessions.mjs');
        const stored = await appendSessionReportOnce(reservedSession, {
          role: 'assistant',
          reportId,
          video: { url, filename, savedPath: vid?.savedPath || null },
          content: `[Video: ${filename}]${vid?.savedPath ? `\nSaved to: ${vid.savedPath}` : ''}`,
          watcherId: record.id,
          ts: Date.now(),
        });
        if (stored !== 'appended' || !mediaDeliveryIsLive()) return false;
        // A reservation created before a crash remains authoritative. If the
        // account switched modes before retry, persist once to that reserved
        // session but do not broadcast to a now-stale live target.
        if (reservedSession !== currentSession) return false;
        await lifecycle.showVideoFn?.(record.userId, { ...vid, agent: runtimeAgent });
        return true;
      } finally {
        topologyLease.release();
      }
    },
    postStatus: async (text) => {
      if (isManagedPreferenceWatcher(record)) {
        const delivered = await deliverManagedPreferenceUpdate(record, text);
        return delivered;
      }
      if (text === record.lastStatusText) return;
      record.lastStatusText = text;
      pushHistory(record, { text, ts: Date.now() });
      lifecycle.sendStatusFn?.(record.userId, {
        type: 'status', agent: runtimeWatcherAgentRef(record), watcherId: record.id,
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
      const delivered = Number(lifecycle.sendNotificationFn?.(record.userId, {
        type: 'agent_notification',
        agent: runtimeWatcherAgentRef(record),
        content,
        from: { userName: fromName },
        event: opts.event || record.kind,
        data: opts.data || {},
        ts,
      })) || 0;
      return delivered > 0;
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
    //   fire({ message, subject, html, telegramPrefix, itemKey, deliver,
    //          eventKey })
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
      const eventKey   = isObj ? arg.eventKey       : null;
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

      // record.ticks advances only after the handler result is committed.
      // Pairing it with an item id (or deterministic call ordinal) makes one
      // fire stable across a crash/replayed tick while keeping distinct fires
      // in the same tick independent.
      const deliverySlot = baseCfg.type === 'email' || baseCfg.type === 'telegram'
        ? (itemKey != null ? `item:${String(itemKey)}` : `call:${deliveryFireSequence++}`)
        : null;

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
      const synth = {
        ...record,
        onFire: tempCfg,
        ...(deliverySlot ? { _deliveryIdempotencySlot: deliverySlot } : {}),
        ...(eventKey != null && String(eventKey).trim()
          ? { _deliveryIdempotencyEventKey: String(eventKey).trim().slice(0, 256) }
          : {}),
      };
      // executeOnFire's email/telegram branches read lastStatusText for the
      // body; surface the override through there so the handler doesn't have
      // to mutate persisted state.
      if (message && (baseCfg.type === 'email' || baseCfg.type === 'telegram')) {
        synth.lastStatusText = message;
      } else if (baseCfg.type === 'email' && html) {
        synth.lastStatusText = stripHtml(html);
      }
      try {
        // Preserve the delivery result. In particular, an email transport
        // failure must stay false so collection watchers retain pendingEvent
        // and retry instead of recording a notification that never arrived.
        return (await executeOnFire(synth)) === true;
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
        return await executeOnFire(synth);
      } catch (e) {
        log.warn('watchers', 'fireAgent threw', { id: record.id, err: e.message });
        return false;
      }
    },
  };
}

async function tick() {
  if (!lifecycle.running) return;
  const now = Date.now();
  for (const [userId, data] of byUser) {
    for (const w of data.active.slice()) {
      if (w.nextTickAt > now) continue;
      // Fire and forget — tickOne guards against re-entry per-watcher.
      tickOne(w).catch(e => log.warn('watchers', 'tickOne unhandled', { id: w.id, err: e.message }));
    }
  }
}

// Narrow regression seam for durability/cancellation tests. Production code
// drives the same function through the supervisor interval above.
export const __test = Object.freeze({ tickOne, reserveWatcherMediaDelivery });

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
  if (lifecycle.running) return;
  lifecycle.sendStatusFn = sendStatus || null;
  lifecycle.sendNotificationFn = sendNotification || null;
  lifecycle.showImageFn = showImage || null;
  lifecycle.showVideoFn = showVideo || null;
  loadAllUsersFromDisk();
  // Re-subscribe persisted event_subscription watchers to the in-process bus.
  // The bus lives only in memory, so a restart that doesn't replay this leaves
  // events firing into the void even though the watcher record on disk says
  // it's listening.
  for (const [, data] of byUser) {
    for (const w of data.active) {
      if (w.kind === 'event_subscription') subscribeToEvent(w);
    }
  }
  lifecycle.running = true;
  lifecycle.timer = setInterval(tick, TICK_MS);
  const totalActive = [...byUser.values()].reduce((n, d) => n + d.active.length, 0);
  log.info('watchers', 'Supervisor started', { tickMs: TICK_MS, activeOnBoot: totalActive });
}

export function stopWatcherSupervisor() {
  lifecycle.running = false;
  if (lifecycle.timer) clearInterval(lifecycle.timer);
  lifecycle.timer = null;
}

export function isWatcherSupervisorRunning() { return lifecycle.running; }
