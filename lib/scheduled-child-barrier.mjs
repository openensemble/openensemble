/**
 * Scheduled-task child barrier.
 *
 * A scheduled task's run (scheduler.runTask) may spawn background work —
 * delegations (dispatchBackground) and auto-backgrounded tools — that outlives
 * the coordinator's main LLM turn. Without coordination the scheduler would
 * stamp lastRun / remove a one-shot / broadcast task_complete the instant the
 * main turn returned, while that background work was still running (and a
 * second, racing finalize would fire when the work later completed).
 *
 * This barrier tracks the main run (childId '__main__') PLUS every background
 * child under one group keyed by `userId:taskId`. The group cannot drain while
 * the main run is still registered, so child completions that race ahead of the
 * main turn don't trip a premature finalize. When the group fully drains it
 * runs an optional `onContinue` reaction step (up to CONTINUATION_CAP times — a
 * reaction may itself spawn more tracked children) and then calls `onFinalize`
 * EXACTLY ONCE. A per-group watchdog force-finalizes if a child hangs.
 *
 * Drain is evaluated on a microtask (scheduleDrain) so a synchronous
 * "complete child A, then register continuation child B" sequence in a caller
 * doesn't drain in the gap between the two calls.
 */

const groups = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;
// A continuation reaction may spawn more background work; cap how many reaction
// rounds we run before forcing finalize, so a self-delegating loop can't spin.
const CONTINUATION_CAP = 4;
// If a tracked child never reports completion (hung upstream stream, crashed
// worker), force-finalize after this long so the task doesn't show "running"
// forever. Background delegations (research, long node_exec) can be slow, so
// this is generous.
const WATCHDOG_MS = 30 * 60 * 1000;

function keyFor(userId, scheduledCtx) {
  const taskId = scheduledCtx?.originTaskId;
  if (!userId || !taskId) return null;
  return `${userId}:${taskId}`;
}

function getGroup(userId, scheduledCtx) {
  const key = keyFor(userId, scheduledCtx);
  if (!key) return null;
  let group = groups.get(key);
  if (!group) {
    group = {
      key,
      userId,
      scheduledCtx: { ...scheduledCtx },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      children: new Map(),
      meta: {},
      onContinue: null,
      onFinalize: null,
      hadBg: false,          // any non-main child ever registered
      continueRounds: 0,
      draining: false,       // a continuation round is in flight
      drainScheduled: false, // a maybeDrain microtask is queued
      finalized: false,
      watchdog: null,
    };
    groups.set(key, group);
  }
  return group;
}

function pruneGroups() {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, group] of groups) {
    if ((group.updatedAt || group.createdAt || 0) < cutoff) {
      if (group.watchdog) { clearTimeout(group.watchdog); group.watchdog = null; }
      groups.delete(key);
    }
  }
}

function pendingChildren(group) {
  return [...group.children.values()].filter(c => c.status === 'running');
}

function errorCount(group) {
  return [...group.children.values()].filter(c => c.status === 'error').length;
}

// Aggregate the BACKGROUND children's results (the main run's own text is
// carried separately by the scheduler, so '__main__' is excluded here).
function buildAggregate(group) {
  const kids = [...group.children.values()].filter(c => c.kind !== 'main');
  if (!kids.length) return '';
  return kids.map((c) => {
    const label = c.label || c.childId;
    const body = c.errorMsg ? `ERROR: ${c.errorMsg}` : (c.resultText || '(completed without text)');
    return `## ${label}\n${body}`;
  }).join('\n\n');
}

function armWatchdog(group) {
  if (group.watchdog) clearTimeout(group.watchdog);
  group.watchdog = setTimeout(() => {
    if (group.finalized || !groups.has(group.key)) return;
    console.warn('[scheduled-barrier] watchdog force-finalize', group.key, 'pending:', pendingChildren(group).length);
    finalizeGroup(group, { timedOut: true });
  }, WATCHDOG_MS);
  group.watchdog?.unref?.();
}

function finalizeGroup(group, { timedOut = false } = {}) {
  if (group.finalized) return;
  group.finalized = true;
  if (group.watchdog) { clearTimeout(group.watchdog); group.watchdog = null; }
  const aggregate = buildAggregate(group);
  const errs = errorCount(group);
  groups.delete(group.key);
  Promise.resolve()
    .then(() => group.onFinalize?.(aggregate, { errorCount: errs, timedOut }))
    .catch(e => console.warn('[scheduled-barrier] onFinalize threw:', e?.message || e));
}

function scheduleDrain(group) {
  if (group.drainScheduled || group.finalized) return;
  group.drainScheduled = true;
  queueMicrotask(() => {
    group.drainScheduled = false;
    maybeDrain(group).catch(e => console.warn('[scheduled-barrier] maybeDrain threw:', e?.message || e));
  });
}

async function maybeDrain(group) {
  if (!groups.has(group.key) || group.finalized || group.draining) return;
  if (pendingChildren(group).length) return;

  // All registered children are done. If the task did background work and a
  // reaction step is configured, run ONE reaction round (it may itself spawn
  // more tracked children) before finalizing. Bounded by CONTINUATION_CAP.
  if (group.hadBg && group.onContinue && group.continueRounds < CONTINUATION_CAP) {
    group.draining = true;
    group.continueRounds += 1;
    const aggregate = buildAggregate(group);
    try {
      await group.onContinue(aggregate, { round: group.continueRounds });
    } catch (e) {
      console.warn('[scheduled-barrier] onContinue threw:', e?.message || e);
    }
    group.draining = false;
    if (group.finalized || !groups.has(group.key)) return;     // watchdog may have fired
    if (pendingChildren(group).length) { scheduleDrain(group); return; } // reaction spawned work
    // reaction added no new tracked work → fall through to finalize
  }

  finalizeGroup(group);
}

/**
 * Register the scheduled task's MAIN run as a tracked child. Must be called
 * BEFORE the main run starts so the group stays pending throughout — otherwise
 * a fast background child that finishes mid-run could drain the group early.
 */
export function registerScheduledMain({ userId, scheduledCtx, label = 'scheduled run' }) {
  pruneGroups();
  const group = getGroup(userId, scheduledCtx);
  if (!group) return null;
  if (!group.children.has('__main__')) {
    group.children.set('__main__', {
      childId: '__main__', label, kind: 'main',
      status: 'running', startedAt: Date.now(), resultText: '', errorMsg: null,
    });
  }
  group.updatedAt = Date.now();
  return { key: group.key };
}

/**
 * Complete the MAIN run and install the drain handlers. After this, the group
 * drains as soon as every background child finishes; `onContinue` (optional)
 * reacts to the aggregated background results and `onFinalize` stamps the task.
 */
export function completeScheduledMain({ userId, scheduledCtx, resultText = '', errorMsg = null, onContinue = null, onFinalize = null, meta = {} }) {
  const key = keyFor(userId, scheduledCtx);
  if (!key) {
    Promise.resolve().then(() => onFinalize?.('', { errorCount: errorMsg ? 1 : 0, timedOut: false })).catch(() => {});
    return;
  }
  const group = groups.get(key);
  if (!group) {
    // No group means registerScheduledMain wasn't called and nothing spawned a
    // child — finalize directly so the task still gets stamped.
    Promise.resolve().then(() => onFinalize?.('', { errorCount: errorMsg ? 1 : 0, timedOut: false })).catch(() => {});
    return;
  }
  group.onContinue = onContinue;
  group.onFinalize = onFinalize;
  group.meta = { ...group.meta, ...meta };
  const main = group.children.get('__main__');
  if (main) {
    main.status = errorMsg ? 'error' : 'done';
    main.resultText = String(resultText || '');
    main.errorMsg = errorMsg ? String(errorMsg) : null;
    main.endedAt = Date.now();
  }
  group.updatedAt = Date.now();
  armWatchdog(group);
  scheduleDrain(group);
}

/**
 * Register a background child (delegation or auto-bg tool) under a scheduled
 * run. No-op outside a scheduled context (keyFor null).
 */
export function registerScheduledChild({ userId, scheduledCtx, childId, label = '', kind = 'background' }) {
  pruneGroups();
  if (!keyFor(userId, scheduledCtx) || !childId) return null;
  const group = getGroup(userId, scheduledCtx);
  if (!group) return null;
  if (!group.children.has(childId)) {
    group.children.set(childId, {
      childId, label, kind,
      status: 'running', startedAt: Date.now(), resultText: '', errorMsg: null,
    });
    if (kind !== 'main') group.hadBg = true;
  }
  group.updatedAt = Date.now();
  return { key: group.key, childCount: group.children.size, pendingCount: pendingChildren(group).length };
}

/**
 * Mark a background child done/errored and (re)evaluate the drain on a
 * microtask. Returns whether the child was tracked.
 */
export function completeScheduledChild({ userId, scheduledCtx, childId, resultText = '', errorMsg = null }) {
  const key = keyFor(userId, scheduledCtx);
  if (!key || !childId) return { tracked: false };
  const group = groups.get(key);
  if (!group) return { tracked: false };
  const child = group.children.get(childId);
  if (!child) return { tracked: false };

  child.status = errorMsg ? 'error' : 'done';
  child.endedAt = Date.now();
  child.resultText = String(resultText || '');
  child.errorMsg = errorMsg ? String(errorMsg) : null;
  group.updatedAt = Date.now();
  scheduleDrain(group);
  return { tracked: true, pendingCount: pendingChildren(group).length };
}

/** Snapshot of a group's child counts (diagnostics). */
export function getScheduledChildGroup({ userId, scheduledCtx }) {
  const key = keyFor(userId, scheduledCtx);
  const group = key ? groups.get(key) : null;
  if (!group) return null;
  const children = [...group.children.values()];
  return {
    key,
    childCount: children.length,
    pendingCount: children.filter(c => c.status === 'running').length,
    doneCount: children.filter(c => c.status === 'done').length,
    errorCount: children.filter(c => c.status === 'error').length,
  };
}
