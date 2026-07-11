// @ts-check
/**
 * Personalization — scheduler wiring.
 *
 * Registers two scheduler builtins (see ../../scheduler.mjs registerBuiltin)
 * and idempotently seeds the system-owned tasks that fire them:
 *
 *   - personalizationNightly    every 6 hours — for every enabled user: runs
 *     a reflection pass (runReflection), then prunes the observation log.
 *     Pruning happens INSIDE this handler rather than as its own task (see
 *     PERSONALIZATION_SPEC ADDENDUM A) — it's cheap and always follows a
 *     reflection pass 1:1. The handler KEY stays 'personalizationNightly' —
 *     that's the historical name from when this ran once a night; renaming
 *     it would orphan whatever task is already persisted on an existing
 *     install (the task's on-disk `handler` field wouldn't resolve to any
 *     registered builtin). Only the user-visible label and cadence changed
 *     (2026-07-06: nightly @ 03:00 → every 6 hours, ~4x/day) — see
 *     seedPersonalizationTasks()'s migration branch below for how an
 *     already-installed nightly task gets moved onto the new cadence.
 *   - personalizationLeadSweep  every 15 min — for every enabled user with at
 *     least one active lead, re-checks due leads (runDueLeads).
 *
 * Both tasks are ownerId:null / agent:'system' — ONE task per builtin that
 * internally iterates every user, exactly like the existing cortexCleanup
 * task (server.mjs ~:718-757), not one task per user. This also keeps them
 * outside the "a scheduled task cannot create another task" invariant
 * (scheduler.mjs addTask/getScheduledContext) — nothing in either handler
 * ever calls addTask.
 *
 * Schedule shape for the reflection task: scheduler.mjs has no "multiple
 * fixed times per day" shape for a single task — the daily branch carries
 * exactly one `time` ("HH:MM") field, and there's no cron-expression-list or
 * times-array field it reads (routes/misc.mjs's `cron` input is translated
 * down to `time`+`dow` or `intervalMs` at creation time; scheduleTask() never
 * looks at a raw cron string). Four fixed times (03:00/09:00/15:00/21:00)
 * would therefore require four sibling daily-at-time tasks sharing this
 * handler, which quadruples the migration surface (detect/update/re-arm four
 * records instead of one) and the admin Tasks drawer noise, for the same
 * outcome as a single `repeat:'interval'` task — the same first-class shape
 * personalizationLeadSweep already uses. Picked interval.
 *
 * Interval tasks anchor to `lastRun` and fire immediately if overdue (see
 * scheduler.mjs scheduleTask's interval branch) — including right after a
 * restart if 6 hours have already elapsed, same as personalizationLeadSweep
 * firing promptly at boot when overdue. That's understood and fine here: a
 * reflection run that's overdue by even a lot is still cheap when it fires,
 * because runReflection's analyzedThroughTs watermark means "nothing new
 * since last time" runs are a fast no-op-shaped pass, not a wasted full
 * analysis.
 *
 * Called once from server boot, right after seedSystemTasks() (see
 * INTEGRATION HUNKS returned by this builder). Idempotent: calling it more
 * than once just re-registers the same builtin names (harmless overwrite)
 * and skips seeding/migrating a task that's already on the current spec.
 */

import { registerBuiltin, addTask, updateTask, removeTask, findTaskById, loadTasksForOwner, scheduleNewTask } from '../../scheduler.mjs';
import { loadUsers } from '../../routes/_helpers.mjs';
import { getConfig } from './config.mjs';
import { pruneObservations } from './observations.mjs';
import { runReflection } from './reflect.mjs';
import { listLeads } from './leads.mjs';
import { runDueLeads } from './lead-runner.mjs';

const LEAD_SWEEP_INTERVAL_MS = 15 * 60_000;

// Reflection cadence — every 6 hours (~4x/day). See module doc for why this
// is a single interval task rather than four sibling daily-at-time tasks.
const REFLECTION_INTERVAL_MS = 6 * 60 * 60_000;
const REFLECTION_LABEL = 'Personalization reflection';

// ── Builtin: reflection + prune (registered under the historical key
// 'personalizationNightly' — see module doc) ────────────────────────────────
async function reflectionHandler() {
  /** @type {Array<{id: string}>} */
  let users;
  try {
    users = loadUsers();
  } catch (e) {
    console.error(`[personalization] reflection: loadUsers failed: ${e.message}`);
    return 'Personalization reflection: aborted (could not load users).';
  }

  let ran = 0, skipped = 0, failed = 0, prunedTotal = 0, profileRowsDecayed = 0,
    preferenceActions = 0, preferenceReconciled = 0;
  for (const user of users) {
    if (!user?.id) continue;

    // Profile aging is a privacy/lifecycle promise, not a model capability.
    // Run it before config/provider gating so disabled reflection and an
    // unavailable model cannot preserve stale inferred beliefs indefinitely.
    try {
      const { decayPersonalizationRows } = await import('./ledger.mjs');
      const result = await decayPersonalizationRows(user.id);
      profileRowsDecayed += result?.removed || 0;
    } catch (e) {
      console.warn(`[personalization] profile decay failed for ${user.id}: ${e.message}`);
    }

    let config;
    try {
      config = await getConfig(user.id);
    } catch (e) {
      console.error(`[personalization] reflection: getConfig failed for ${user.id}: ${e.message}`);
      skipped++;
      continue;
    }
    // Reconciliation is an interruption/privacy control, not a new learning
    // action. Run it even when the master switch is off so previously-created
    // unattended monitors are stopped promptly on the next sweep.
    try {
      const { reconcilePreferenceAutomationReceipts } = await import('./preference-opportunities.mjs');
      preferenceReconciled += await reconcilePreferenceAutomationReceipts(user.id);
    } catch (e) {
      console.warn(`[personalization] preference monitor reconciliation failed for ${user.id}: ${e.message}`);
    }
    if (!config?.enabled) {
      skipped++;
    } else {
      // One user's reflection failure must never block the rest of the run.
      // runReflection reports provider-unavailable/no-model as {skipped:true}
      // rather than throwing — count those as skipped, not reflected, so the
      // summary line stays honest about what actually ran.
      try {
        const stats = await runReflection(user.id, {});
        if (stats?.skipped) skipped++;
        else ran++;
        try {
          const { discoverPreferenceOpportunities } = await import('./preference-opportunities.mjs');
          const remainingOffers = Math.max(0, Number(config.maxOffersPerRun || 0) - Number(stats?.offers || 0));
          preferenceActions += await discoverPreferenceOpportunities(user.id, { limit: remainingOffers });
        } catch (e) {
          console.warn(`[personalization] preference opportunity discovery failed for ${user.id}: ${e.message}`);
        }
      } catch (e) {
        console.error(`[personalization] reflection: runReflection failed for ${user.id}: ${e.message}`);
        failed++;
      }
    }

    // Retention is a deletion promise, not a learning action. Keep pruning
    // while the master switch is off so disabling personalization can never
    // accidentally preserve old observations forever.
    try {
      const { removed } = await pruneObservations(user.id, config.retentionDays);
      prunedTotal += removed || 0;
    } catch (e) {
      console.error(`[personalization] reflection: pruneObservations failed for ${user.id}: ${e.message}`);
    }
  }
  return `Personalization reflection: ${ran} reflected, ${skipped} skipped (disabled/error), ${failed} failed, ${profileRowsDecayed} stale profile row(s) removed, ${preferenceActions} preference opportunity action(s), ${preferenceReconciled} preference monitor(s) reconciled, ${prunedTotal} observation(s) pruned.`;
}

// ── Builtin: lead sweep ──────────────────────────────────────────────────────
async function leadSweepHandler() {
  /** @type {Array<{id: string}>} */
  let users;
  try {
    users = loadUsers();
  } catch (e) {
    console.error(`[personalization] lead sweep: loadUsers failed: ${e.message}`);
    return 'Personalization lead sweep: aborted (could not load users).';
  }

  let usersWithLeads = 0, checked = 0, hits = 0, expired = 0, preferenceReconciled = 0;
  for (const user of users) {
    if (!user?.id) continue;

    try {
      const { reconcilePreferenceAutomationReceipts } = await import('./preference-opportunities.mjs');
      preferenceReconciled += await reconcilePreferenceAutomationReceipts(user.id);
    } catch (e) {
      console.warn(`[personalization] lead sweep preference reconciliation failed for ${user.id}: ${e.message}`);
    }

    try {
      const config = await getConfig(user.id);
      if (config?.enabled !== true || config?.setupComplete !== true || config?.model === 'off') continue;
    } catch (e) {
      console.error(`[personalization] lead sweep: getConfig failed for ${user.id}: ${e.message}`);
      continue;
    }

    // Include pending terminal hits as well as active leads.  A held hit is no
    // longer active; filtering only active records stranded the user's final
    // lead forever once quiet hours/budget ended.
    let relevant;
    try {
      const all = await listLeads(user.id, { activeOnly: false });
      relevant = all.filter(l => l.status === 'active' || (l.status === 'hit' && l.pendingNotify));
    } catch (e) {
      console.error(`[personalization] lead sweep: listLeads failed for ${user.id}: ${e.message}`);
      continue;
    }
    if (!relevant?.length) continue;
    usersWithLeads++;

    try {
      const r = await runDueLeads(user.id);
      checked += r?.checked || 0;
      hits += r?.hits || 0;
      expired += r?.expired || 0;
    } catch (e) {
      console.error(`[personalization] lead sweep: runDueLeads failed for ${user.id}: ${e.message}`);
    }
  }
  return `Personalization lead sweep: ${usersWithLeads} user(s) with active leads, ${checked} checked, ${hits} hit, ${expired} expired, ${preferenceReconciled} preference monitor(s) reconciled.`;
}

// Focused integration-test seam; production registration still uses the same
// function object below.
export {
  reflectionHandler as _testReflectionHandler,
  leadSweepHandler as _testLeadSweepHandler,
};

// ── Idempotent task seeding (pattern: server.mjs seedSystemTasks) ──────────
async function seedPersonalizationTasks() {
  let existing;
  try {
    existing = loadTasksForOwner('system');
  } catch (e) {
    console.error(`[personalization] seed: loadTasksForOwner failed: ${e.message}`);
    return;
  }

  // Reconcile duplicates left by an older concurrent boot/init.  Keep the
  // oldest record so its lastRun/failure history survives.
  const reflectionMatches = existing.filter(t => t.type === 'builtin' && t.handler === 'personalizationNightly');
  // Prefer an enabled duplicate if concurrent/legacy records disagree. Keeping
  // the oldest disabled row would silently turn the whole global worker off.
  const reflectionTask = reflectionMatches.find(t => t.enabled !== false) || reflectionMatches[0];
  for (const duplicate of reflectionMatches.filter(t => t !== reflectionTask)) {
    try { await removeTask(duplicate.id, 'system'); }
    catch (e) { console.warn(`[personalization] failed to remove duplicate reflection task ${duplicate.id}: ${e.message}`); }
  }
  if (!reflectionTask) {
    // Fresh install (or a system.json that never had this task) — seed it
    // directly on the current cadence, nothing to migrate.
    try {
      const saved = await addTask({
        label: REFLECTION_LABEL,
        type: 'builtin',
        handler: 'personalizationNightly',
        agent: 'system',
        repeat: 'interval',
        intervalMs: REFLECTION_INTERVAL_MS,
        ownerId: null,
      });
      // Arm immediately: addTask only persists, and if this seed lands after
      // startScheduler's boot arm loop the task would stay dormant until the
      // next restart.
      try { scheduleNewTask(saved); } catch { /* boot arm loop will cover it */ }
      console.log('[personalization] Seeded personalizationNightly task (every 6 hours)');
    } catch (e) {
      console.error(`[personalization] Failed to seed personalizationNightly task: ${e.message}`);
    }
  } else if (
    reflectionTask.repeat !== 'interval' ||
    Number(reflectionTask.intervalMs) !== REFLECTION_INTERVAL_MS ||
    reflectionTask.label !== REFLECTION_LABEL
  ) {
    // SELF-MIGRATION: an already-installed server has this task persisted on
    // the old daily-03:00 schedule (or some other stale shape/label). A
    // plain skip-if-exists seed would leave it there forever, so detect the
    // drift and update the SAME task record in place (never delete + re-add
    // — that would lose its id, lastRun, and consecutiveFailures history).
    // addTask/updateTask only persist — they do NOT arm a timer, so
    // scheduleNewTask() must be called explicitly after the patch lands (the
    // same gotcha the fresh-install branch above already accounts for).
    // Safe to run on every boot: once migrated, this branch's own condition
    // is false on the next boot (no-op, no churn).
    const prevCadence = reflectionTask.repeat === 'daily' ? `daily ${reflectionTask.time ?? '?'}`
      : reflectionTask.repeat === 'interval' ? `every ${Math.round((Number(reflectionTask.intervalMs) || 0) / 3_600_000)}h`
      : String(reflectionTask.repeat);
    try {
      await updateTask(reflectionTask.id, {
        label: REFLECTION_LABEL,
        repeat: 'interval',
        intervalMs: REFLECTION_INTERVAL_MS,
        // The old daily-at-time field no longer means anything once
        // repeat:'interval' takes over (scheduleTask branches on `repeat`
        // before it ever reads `time`) — cleared so the persisted record
        // doesn't carry a misleading leftover.
        time: null,
      });
      const fresh = findTaskById(reflectionTask.id, 'system');
      if (fresh) {
        try { scheduleNewTask(fresh); } catch { /* boot arm loop will cover it */ }
      }
      console.log(`[personalization] Migrated personalizationNightly task from "${prevCadence}" to every 6 hours`);
    } catch (e) {
      console.error(`[personalization] Failed to migrate personalizationNightly task: ${e.message}`);
    }
  }

  const freshExisting = loadTasksForOwner('system');
  const sweepMatches = freshExisting.filter(t => t.type === 'builtin' && t.handler === 'personalizationLeadSweep');
  const sweepTask = sweepMatches.find(t => t.enabled !== false) || sweepMatches[0];
  for (const duplicate of sweepMatches.filter(t => t !== sweepTask)) {
    try { await removeTask(duplicate.id, 'system'); }
    catch (e) { console.warn(`[personalization] failed to remove duplicate lead-sweep task ${duplicate.id}: ${e.message}`); }
  }
  if (!sweepTask) {
    try {
      const saved = await addTask({
        label: 'Personalization lead sweep',
        type: 'builtin',
        handler: 'personalizationLeadSweep',
        agent: 'system',
        repeat: 'interval',
        intervalMs: LEAD_SWEEP_INTERVAL_MS,
        ownerId: null,
      });
      try { scheduleNewTask(saved); } catch { /* boot arm loop will cover it */ }
      console.log('[personalization] Seeded personalizationLeadSweep task (every 15 min)');
    } catch (e) {
      console.error(`[personalization] Failed to seed personalizationLeadSweep task: ${e.message}`);
    }
  } else if (sweepTask.repeat !== 'interval' || Number(sweepTask.intervalMs) !== LEAD_SWEEP_INTERVAL_MS) {
    try {
      await updateTask(sweepTask.id, { repeat: 'interval', intervalMs: LEAD_SWEEP_INTERVAL_MS, time: null }, 'system');
      const fresh = findTaskById(sweepTask.id, 'system');
      if (fresh) scheduleNewTask(fresh);
    } catch (e) {
      console.error(`[personalization] Failed to repair personalizationLeadSweep cadence: ${e.message}`);
    }
  }
}

/**
 * Register the personalization scheduler builtins and idempotently seed
 * (or migrate) their tasks. Call once from server boot (see INTEGRATION
 * HUNKS). Never throws into the boot path — every failure branch inside
 * seedPersonalizationTasks() is caught and logged, not re-thrown.
 * @returns {Promise<void>}
 */
let _initChain = Promise.resolve();

export function initPersonalization() {
  // Serialize concurrent callers.  A resolved chain is intentionally reusable
  // so tests/hot reload can seed again after task files change, while two boot
  // callers can never decide "missing" from the same stale snapshot.
  const run = _initChain.then(async () => {
    registerBuiltin('personalizationNightly', reflectionHandler);
    registerBuiltin('personalizationLeadSweep', leadSweepHandler);
    await seedPersonalizationTasks();
  });
  _initChain = run.catch(() => {});
  return run;
}
