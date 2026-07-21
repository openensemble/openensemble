/**
 * Agent-owned background workers + query/list helpers.
 * Extracted from background-tasks.mjs — pure move with bindWorkerDeps for
 * parent completion/dispatch helpers (avoids circular static imports).
 */

import { getTurnContext, runWithTurnContext } from '../lib/turn-abort-context.mjs';
import { currentTaskContext, runInTaskContext } from '../lib/task-proxy-context.mjs';
import { toolRouterContext } from '../lib/tool-router-context.mjs';
import { getScheduledContext } from '../lib/scheduled-context.mjs';
import { matchToolPlan } from '../lib/tool-plan-memory.mjs';
import { registerScheduledChild, completeScheduledChild } from '../lib/scheduled-child-barrier.mjs';
import { appendTaskOutcome, loadTaskOutcomes } from '../lib/task-outcomes.mjs';
import {
  evaluateCompoundWorkflowContract,
  formatCompoundContractFailure,
} from '../lib/compound-workflow-contract.mjs';
import { getOrchestrationPolicy } from '../lib/orchestration-policy.mjs';
import { iterateUntilAbort } from '../lib/abortable-async-iterator.mjs';
import { registerWatcher, pushWatcherStatus, completeWatcher } from '../scheduler/watchers.mjs';
import {
  activeTasks,
  verifierLeaseTokens,
  rootTaskGraphs,
  recentWorkers,
  RECENT_CAP,
  RECENT_READ_CAP,
  recentDelegations,
} from './state.mjs';
import { _journalAdd } from './journal.mjs';

// Bound from background-tasks.mjs after parent helpers exist.
let _onComplete = async () => {};
let cancelTask = () => ({ ok: false });
let pushTaskProgress = () => {};
let resolveBackgroundRootTaskId = () => null;
let taskLabel = () => '';
let taskState = () => ({});
let trackToolEvent = () => {};
let reportImageFromEvent = () => null;
let backgroundRunTraceOptions = () => ({});
let _rootChildSnapshot = () => null;

export function bindWorkerDeps(deps) {
  if (deps._onComplete !== undefined) _onComplete = deps._onComplete;
  if (deps.cancelTask !== undefined) cancelTask = deps.cancelTask;
  if (deps.pushTaskProgress !== undefined) pushTaskProgress = deps.pushTaskProgress;
  if (deps.resolveBackgroundRootTaskId !== undefined) resolveBackgroundRootTaskId = deps.resolveBackgroundRootTaskId;
  if (deps.taskLabel !== undefined) taskLabel = deps.taskLabel;
  if (deps.taskState !== undefined) taskState = deps.taskState;
  if (deps.trackToolEvent !== undefined) trackToolEvent = deps.trackToolEvent;
  if (deps.reportImageFromEvent !== undefined) reportImageFromEvent = deps.reportImageFromEvent;
  if (deps.backgroundRunTraceOptions !== undefined) backgroundRunTraceOptions = deps.backgroundRunTraceOptions;
  if (deps._rootChildSnapshot !== undefined) _rootChildSnapshot = deps._rootChildSnapshot;
}

// ── Agent-owned background workers (manager/employee model) ──────────────────
// Generic capability: ANY agent can hire a background worker it OWNS, watch it,
// and report on it. Differs from dispatchBackground (coordinator→specialist
// delegation) in three ways:
//   1. ownerKey is the STABLE id of the owning agent (e.g. the email
//      specialist), derived by the delegate skill from the caller's session.
//      The owner sees its workers from ANY session — its direct chat OR an
//      ephemeral delegation (e.g. the coordinator asking it for status) — so
//      "how's it going" resolves the same workers either way.
//   2. The run is abortable, so stop_worker can cancel it.
//   3. The chip + completion report land in the OWNER's chat (chipOwnerId),
//      not the coordinator's. Completion bubbles up to whoever owns the worker.

export function _retire(taskId, outcome, finalText) {
  const info = activeTasks.get(taskId);
  if (!info || !info.isWorker) return;
  const endedAt = Date.now();
  recentWorkers.unshift({
    taskId, ownerKey: info.ownerKey, userId: info.userId,
    name: info.agentName, summary: info.summary,
    outcome,                                   // 'done' | 'error' | 'stopped'
    finalText: (finalText || '').slice(0, 240),
    toolsUsed: info.toolsUsed || 0,
    startedAt: info.startedAt, endedAt,
  });
  if (recentWorkers.length > RECENT_CAP) recentWorkers.length = RECENT_CAP;
  // Durable mirror (7d JSONL) — same fire-and-forget philosophy as the
  // delegation retire point in _onComplete: this must never affect the ring
  // push above or the caller's completion flow (spawnWorker's async IIFE
  // calls _retire synchronously right before awaiting _onComplete).
  appendTaskOutcome(info.userId, {
    taskId, kind: 'worker', ownerKey: info.ownerKey, agentId: info.agentId,
    agentName: info.agentName, status: outcome,
    summary: finalText || info.summary,
    durationMs: endedAt - (info.startedAt || endedAt),
    error: outcome === 'error' ? finalText : null,
  }).catch(e => console.warn('[background-tasks] worker task-outcome append failed:', e.message));
}

// Append an entry to a worker's rolling progress log (cap 20). Tool results carry
// the real domain numbers (email tools return "Labeled 200…", "619 match…"), so
// this is what lets a manager report actual progress, not just "running a tool".
export function pushWorkerProgress(taskId, entry) {
  const rec = activeTasks.get(taskId);
  if (!rec) return false;
  rec.progress = rec.progress || [];
  rec.progress.push({ ...entry, ts: Date.now() });
  if (rec.progress.length > 20) rec.progress.shift();
  rec.lastActivityAt = Date.now();
  return true;
}

/** Record an explicit milestone note from inside a worker (the report_progress tool). */
export function recordWorkerProgress(taskId, note) {
  const rec = activeTasks.get(taskId);
  if (!rec) return false;
  pushWorkerProgress(taskId, { kind: 'note', text: String(note || '').slice(0, 240) });
  if (rec.watcherId) { try { pushWatcherStatus(rec.userId, rec.watcherId, `• ${String(note || '').slice(0, 80)}`); } catch { /* chip gone */ } }
  return true;
}

/**
 * Hire a background worker owned by a specific agent.
 * @param {object} a
 * @param {object} a.workerAgent  - ephemeral agent (clone of the owner's role)
 * @param {string} a.task         - original user-visible job identity
 * @param {string} [a.executionTask] - optional execution-only model prompt
 * @param {string} a.userId
 * @param {string} a.chipOwnerId  - scoped session id of the owner's chat (chip + report target)
 * @param {string} a.ownerKey     - stable agent id of the owner (for check_workers lookup)
 * @param {string} a.workerName
 * @param {string} a.emoji
 * @returns {string} taskId
 */
export function spawnWorker({
  workerAgent, task, executionTask = null, userId, chipOwnerId, ownerKey,
  workerName = 'Worker', emoji = '🤖',
  originalTask: requestedOriginalTask = null,
  rootTaskId: requestedRootTaskId = null,
  sourceMessageId = null,
  sourceAttemptId = null,
  sourceSessionKey = null,
  sourceSessionEpoch = null,
  completionContract = null,
}) {
  const taskId = `wkr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const originalTask = String(requestedOriginalTask || task || '');
  const modelTask = typeof executionTask === 'string' && executionTask.trim()
    ? executionTask
    : originalTask;
  const summary = originalTask.slice(0, 120);
  const ac = new AbortController();
  // Scheduled-task barrier linkage — read the SAME AsyncLocalStorage signal
  // dispatchBackground uses (getScheduledContext()). spawn_worker is invoked
  // synchronously from inside the tool-dispatch loop that runAgentWithRetry
  // wraps in scheduledContext.run(...) for a scheduled run (scheduler.mjs ->
  // run-agent-with-retry.mjs -> streamChat -> executeSkillTool -> here), so
  // this is ambient — no explicit threading through skills/delegate/execute.mjs
  // is needed. Falls back to null for an interactive (non-scheduled) worker,
  // which must NOT link to any barrier group.
  const scheduledCtx = getScheduledContext();
  const silentScheduled = scheduledCtx?.originTaskId && scheduledCtx?.silent === true;
  const rootTaskId = resolveBackgroundRootTaskId(taskId, { rootTaskId: requestedRootTaskId }, scheduledCtx);
  const parentTurnCtx = getTurnContext() || {};
  const suppressLearning = parentTurnCtx.suppressLearning === true;
  // Missing capability never downgrades a verifier-started worker to an
  // ordinary completion: the required bit remains true and completion fails
  // closed to the deterministic zero-model notice.
  const verifierLeaseRequired = parentTurnCtx.verifierLeaseRequired === true
    || (process.env.OPENENSEMBLE_LAB === '1' && suppressLearning);
  const verifierLeaseToken = verifierLeaseRequired
    && typeof parentTurnCtx.verifierLeaseToken === 'string'
    && /^[a-f0-9]{64}$/.test(parentTurnCtx.verifierLeaseToken)
    ? parentTurnCtx.verifierLeaseToken
    : null;
  const taskRecord = {
    agentId: workerAgent.id, userId, agentName: workerName, agentEmoji: emoji,
    startedAt: Date.now(), summary, ownerKey, isWorker: true, phase: 'queued',
    // chipOwnerId doubles as the report target on completion (_onComplete gets
    // it as a parameter) — keep it on the record too so the restart journal
    // knows which chat to notify when this worker dies with the process.
    visibleAgentId: chipOwnerId,
    coordinatorAgentId: chipOwnerId,
    originalTask,
    autoContinue: true,
    rootTaskId,
    sourceMessageId,
    sourceAttemptId,
    sourceSessionKey,
    sourceSessionEpoch,
    suppressLearning,
    verifierLeaseRequired,
    verifierAllowedTools: Array.isArray(parentTurnCtx.verifierAllowedTools)
      ? [...parentTurnCtx.verifierAllowedTools]
      : null,
    status: 'running', abort: (reason = 'cancelled') => ac.abort(reason),
    originScheduledTaskId: scheduledCtx?.originTaskId || null,
    originScheduledTaskOwnerId: scheduledCtx?.originTaskOwnerId || userId || null,
    originScheduledTaskAgent: scheduledCtx?.originTaskAgent || null,
    originScheduledRunId: scheduledCtx?.runId || null, // barrier per-fire nonce — must rejoin the SAME fire's group
    originScheduledManual: scheduledCtx?.manual === true,
    originScheduledSilent: silentScheduled === true,
  };
  activeTasks.set(taskId, taskRecord);
  if (verifierLeaseToken) verifierLeaseTokens.set(taskRecord, verifierLeaseToken);
  if (scheduledCtx?.originTaskId) {
    // _onComplete's existing generic completion block (gated on
    // rec.originScheduledTaskId, shared by both delegations and workers)
    // reports this child's completion back to the barrier — no separate
    // completeScheduledChild call is needed here.
    registerScheduledChild({
      userId,
      scheduledCtx,
      childId: taskId,
      label: `${workerName}: ${summary}`,
      kind: 'worker',
      cancel: reason => cancelTask(userId, taskId, reason),
    });
  }

  let watcherId = null;
  if (!silentScheduled) {
    try {
      watcherId = registerWatcher({
        userId,
        agentId: chipOwnerId,   // chip lives in the OWNER's chat
        kind: 'task_proxy',
        label: taskLabel(emoji, workerName, summary),
        state: taskState(taskId, { phase: 'queued' }),
        cadenceSec: 30,
        expiresAt: null,
      });
      const rec = activeTasks.get(taskId);
      if (rec) rec.watcherId = watcherId;
      pushTaskProgress(taskId, `Started ${workerName}: ${summary}`, { phase: 'queued' });
    } catch (e) {
      console.warn('[workers] task_proxy watcher registration failed:', e.message);
    }
  }
  if (!_journalAdd(taskId)) {
    activeTasks.delete(taskId);
    if (watcherId) {
      try {
        completeWatcher(userId, watcherId, {
          status: 'error',
          finalText: `⚠ ${workerName} could not start: completion journal unavailable`,
        });
      } catch { /* watcher persistence already failed */ }
    }
    if (scheduledCtx?.originTaskId) {
      try {
        completeScheduledChild({
          userId, scheduledCtx, childId: taskId,
          resultText: '', errorMsg: 'Worker could not start because its completion journal was unavailable.',
        });
      } catch { /* the caller receives the admission error below */ }
    }
    throw Object.assign(
      new Error('Worker could not start because its durable completion journal is unavailable'),
      { code: 'WORKER_NOT_STARTED' },
    );
  }

  (async () => {
    let fullText = '';
    const toolEvents = [];
    const reportImages = [];
    const { isUserTimeBlocked } = await import('../routes/_helpers.mjs');
    if (isUserTimeBlocked(userId)) {
      await _onComplete(taskId, userId, chipOwnerId, workerName, emoji, null, 'Access is restricted at this time — worker not started.');
      return;
    }
    try {
      const { streamChat } = await import('../chat.mjs');
      const { getScheduledNote } = await import('../lib/scheduled-context.mjs');
      const scheduledNote = getScheduledNote();
      // Admission already selected every required capability for a contract
      // worker. A remembered plan could silently remove one of them.
      const rememberedPlan = completionContract
        ? null
        : matchToolPlan(userId, { agentId: workerAgent.id, phrase: originalTask });
      const workerRec = activeTasks.get(taskId);
      const taskCtx = {
        taskId,
        watcherId,
        userId,
        agentId: workerAgent.id,
        rootTaskId: workerRec?.rootTaskId || taskId,
        rootWatcherId: workerRec?.rootWatcherId || watcherId,
        visibleAgentId: workerRec?.visibleAgentId || chipOwnerId,
        spanId: workerRec?.spanId || `${workerRec?.rootTaskId || taskId}:worker:${taskId}`,
      };
      pushTaskProgress(taskId, `${workerName} started working`, { phase: 'running' });
      await runWithTurnContext({
        signal: ac.signal,
        deviceId: parentTurnCtx.deviceId ?? null,
        conversationMode: parentTurnCtx.conversationMode ?? null,
        suppressLearning: parentTurnCtx.suppressLearning === true,
        verifierAllowedTools: Array.isArray(parentTurnCtx.verifierAllowedTools)
          ? [...parentTurnCtx.verifierAllowedTools]
          : null,
        verifierLeaseRequired,
        verifierLeaseToken,
      }, () => toolRouterContext.run(null, () => runInTaskContext(taskCtx, async () => {
        const rec = activeTasks.get(taskId);
        for await (const ev of iterateUntilAbort(streamChat(workerAgent, modelTask, ac.signal, null, userId, null, scheduledNote, silentScheduled === true, null, {
          toolPlan: rememberedPlan,
          routeText: originalTask,
          isolatedTaskRun: true,
          workerMemoryAgentId: ownerKey,
          ...backgroundRunTraceOptions(rec, scheduledNote ? 'scheduled' : 'background'),
        }), ac.signal, `Worker ${taskId} cancelled`)) {
          if (ev.type === 'token') fullText += ev.text;
          else if (ev.type === 'replace') fullText = String(ev.text || '');
          else if (ev.type === '__content') fullText = String(ev.content || '');
          trackToolEvent(toolEvents, ev, workerAgent.id);
          if (ev.type === 'tool_call' && ev.name) {
            const rec = activeTasks.get(taskId);
            if (rec) { rec.toolsUsed = (rec.toolsUsed || 0) + 1; rec.currentTool = ev.name; rec.lastUpdateAt = Date.now(); }
            pushWorkerProgress(taskId, { kind: 'tool', tool: ev.name });
            if (rec?.watcherId) pushTaskProgress(taskId, `${workerName} is using ${ev.name}`, { currentTool: ev.name, toolsUsed: rec.toolsUsed, phase: 'tool' });
          }
          if (ev.type === 'tool_progress' && ev.text) {
            const rec = activeTasks.get(taskId);
            pushTaskProgress(taskId, String(ev.text).slice(-1200), {
              currentTool: rec?.currentTool || null,
              toolsUsed: rec?.toolsUsed || 0,
              phase: 'streaming',
            });
          }
          if (ev.type === 'tool_result' && ev.name) {
            const rec = activeTasks.get(taskId);
            if (rec) { rec.currentTool = null; rec.lastResultPreview = (ev.text || '').slice(0, 80); rec.lastUpdateAt = Date.now(); }
            // Richer preview — the first non-empty line of the result usually holds
            // the domain number ("Labeled 200…", "619 email(s) match…"), giving the
            // manager real progress to report instead of just the tool name.
            const firstLine = String(ev.text || '').split('\n').find(l => l.trim()) || '';
            pushWorkerProgress(taskId, { kind: 'result', tool: ev.name, text: firstLine.slice(0, 160) });
            if (firstLine) pushTaskProgress(taskId, `${ev.name}: ${firstLine.slice(0, 240)}`, { currentTool: null, phase: 'result' });
          }
          if (ev.type === 'image' && ev.filename) {
            const image = reportImageFromEvent(ev);
            if (image) reportImages.push(image);
            pushWorkerProgress(taskId, { kind: 'result', tool: ev.type, text: `produced ${ev.filename}` });
            pushTaskProgress(taskId, `${workerName} produced ${ev.filename}`, { currentTool: null, phase: 'result' });
          }
          if (ev.type === 'error') throw new Error(ev.message);
        }
      })));
      if (completionContract) {
        let audit;
        try {
          audit = evaluateCompoundWorkflowContract(completionContract, toolEvents);
        } catch (error) {
          audit = {
            ok: false,
            code: 'completion_contract_unverifiable',
            completed: [], missing: [], failed: [], pending: [], running: [],
            outOfOrder: [], overInvoked: [],
            unverifiable: [{ reason: error?.message || String(error) }],
            stepCount: Array.isArray(completionContract?.steps) ? completionContract.steps.length : 0,
          };
        }
        if (!audit?.ok) {
          let message;
          try { message = formatCompoundContractFailure(audit); }
          catch {
            message = 'Background workflow incomplete: required completion evidence could not be verified. No missing or failed step was retried automatically.';
          }
          await _onComplete(
            taskId, userId, chipOwnerId, workerName, emoji,
            fullText.trim() || null, message, 'error', toolEvents,
            workerAgent.id, originalTask, { images: reportImages },
          );
          return;
        }
      }
      await _onComplete(taskId, userId, chipOwnerId, workerName, emoji, fullText.trim() || `${workerName} finished the job.`, null, null, toolEvents, workerAgent.id, originalTask, { images: reportImages });
    } catch (err) {
      const stopped = ac.signal.aborted;
      await _onComplete(taskId, userId, chipOwnerId, workerName, emoji, null,
        stopped ? 'Worker stopped by its manager.' : err.message,
        stopped ? 'cancelled' : 'error', toolEvents, workerAgent.id, originalTask,
        { images: reportImages });
    }
  })();

  return taskId;
}

/** Live status of the workers owned by `ownerKey` (for check_workers / "how's it going"). */
export function listWorkersForOwner(userId, ownerKey) {
  const now = Date.now();
  return [...activeTasks.entries()]
    .filter(([, info]) => info.isWorker && info.userId === userId && info.ownerKey === ownerKey)
    .map(([taskId, info]) => {
      const lastAt = info.lastActivityAt || info.lastUpdateAt || info.startedAt;
      return {
        taskId,
        rootTaskId: info.rootTaskId || taskId,
        parentTaskId: info.parentTaskId || null,
        parentWatcherId: info.parentWatcherId || null,
        rootWatcherId: info.rootWatcherId || info.watcherId || null,
        spanId: info.spanId || null,
        watcherId: info.watcherId || null,
        visibleAgentId: info.visibleAgentId || null,
        name: info.agentName,
        summary: info.summary,
        currentTool: info.currentTool || null,
        toolsUsed: info.toolsUsed || 0,
        elapsedSec: Math.round((now - info.startedAt) / 1000),
        idleSec: Math.round((now - lastAt) / 1000),
        stalled: (now - lastAt) > 120000,         // no tool activity for >2min
        progress: (info.progress || []).slice(-8), // recent log w/ domain numbers
      };
    });
}

/** Single-mode view: the primary manages all workers while specialists park. */
export function listWorkersForUser(userId) {
  const now = Date.now();
  return [...activeTasks.entries()]
    .filter(([, info]) => info.isWorker && info.userId === userId)
    .map(([taskId, info]) => {
      const lastAt = info.lastActivityAt || info.lastUpdateAt || info.startedAt;
      return {
        taskId,
        rootTaskId: info.rootTaskId || taskId,
        parentTaskId: info.parentTaskId || null,
        parentWatcherId: info.parentWatcherId || null,
        rootWatcherId: info.rootWatcherId || info.watcherId || null,
        spanId: info.spanId || null,
        watcherId: info.watcherId || null,
        visibleAgentId: info.visibleAgentId || null,
        ownerKey: info.ownerKey || null,
        name: info.agentName,
        summary: info.summary,
        currentTool: info.currentTool || null,
        toolsUsed: info.toolsUsed || 0,
        elapsedSec: Math.round((now - info.startedAt) / 1000),
        idleSec: Math.round((now - lastAt) / 1000),
        stalled: (now - lastAt) > 120000,
        progress: (info.progress || []).slice(-8),
      };
    });
}

// Reshape a durable task-outcomes.jsonl row back into the recent-ring shape
// (taskId/name/summary/outcome/finalText/toolsUsed/startedAt/endedAt) so
// callers (check_workers, describeBackgroundWorkForSession) can treat a
// durable-only row exactly like a ring entry. Rows written after a ring
// eviction or a restart won't have the ring's richer routing fields
// (watcherId/spanId/rootTaskId — the chip is long gone by then), which is
// fine: every consumer already treats those as optional.
function _outcomeRowToRecent(row, userId) {
  return {
    taskId: row.taskId,
    userId,
    ownerKey: row.ownerKey || null,
    agentId: row.agentId || null,
    name: row.agentName || 'Agent',
    summary: row.summary || '',
    outcome: row.status,   // already normalized to 'done'|'stopped'|'error' at write time
    finalText: (row.error || row.summary || '').slice(0, 240),
    toolsUsed: 0,
    startedAt: Number.isFinite(row.durationMs) ? row.ts - row.durationMs : row.ts,
    endedAt: row.ts,
  };
}

// Merge the hot in-memory ring with the durable JSONL tail: ring entries win
// on taskId collisions (they carry the richer live-routing fields), durable
// rows fill in anything the ring already evicted or lost on restart.
function _mergeRecentWithDurable(ringItems, durableRows, userId, cap) {
  const seen = new Set(ringItems.map(r => r.taskId));
  const merged = ringItems.slice();
  for (const row of durableRows) {
    if (seen.has(row.taskId)) continue;
    seen.add(row.taskId);
    merged.push(_outcomeRowToRecent(row, userId));
  }
  merged.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  return cap ? merged.slice(0, cap) : merged;
}

/** Recently-finished workers for an owner — so check_workers can report terminal outcomes. */
export function listRecentWorkersForOwner(userId, ownerKey) {
  const now = Date.now();
  const ring = recentWorkers.filter(r => r.userId === userId && r.ownerKey === ownerKey);
  let durable = [];
  try {
    durable = loadTaskOutcomes(userId, { kind: 'worker' }).filter(r => (r.ownerKey || null) === ownerKey);
  } catch (e) { console.warn('[background-tasks] durable worker outcomes read failed:', e.message); }
  return _mergeRecentWithDurable(ring, durable, userId, RECENT_READ_CAP)
    .map(r => ({ ...r, endedAgoSec: Math.round((now - r.endedAt) / 1000) }));
}

/** Recently-finished workers across every parked/active agent for single mode. */
export function listRecentWorkersForUser(userId) {
  const now = Date.now();
  const ring = recentWorkers.filter(r => r.userId === userId);
  let durable = [];
  try {
    durable = loadTaskOutcomes(userId, { kind: 'worker' });
  } catch (e) { console.warn('[background-tasks] durable worker outcomes read failed:', e.message); }
  return _mergeRecentWithDurable(ring, durable, userId, RECENT_READ_CAP)
    .map(r => ({ ...r, endedAgoSec: Math.round((now - r.endedAt) / 1000) }));
}

/**
 * Live status of coordinator→specialist DELEGATIONS in flight for a user.
 *
 * Unlike workers, delegations are NOT scoped to an ownerKey: a delegation is
 * user-level background work (the coordinator handed a job to a specialist on
 * the user's behalf), so ANY agent the user asks — the specialist they're
 * chatting with, the coordinator, anyone — should be able to surface it. This
 * is the fix for the "is the specialist still working?" black hole: the job was always
 * live in activeTasks, but check_workers only ever looked at isWorker records.
 *
 * `excludeAgentId` drops the caller's own delegation session so a running
 * specialist doesn't list itself back as a separate task.
 */
export function listActiveDelegationsForUser(userId, excludeAgentId = null) {
  const now = Date.now();
  return [...activeTasks.entries()]
    .filter(([, info]) => info.isDelegation && info.userId === userId && info.agentId !== excludeAgentId
      && !(excludeAgentId && (info.aliases || []).includes(excludeAgentId)))
    .map(([taskId, info]) => {
      const lastAt = info.lastActivityAt || info.lastUpdateAt || info.startedAt;
      return {
        taskId,
        rootTaskId: info.rootTaskId || taskId,
        parentTaskId: info.parentTaskId || null,
        parentWatcherId: info.parentWatcherId || null,
        rootWatcherId: info.rootWatcherId || info.watcherId || null,
        spanId: info.spanId || null,
        watcherId: info.watcherId || null,
        visibleAgentId: info.visibleAgentId || null,
        name: info.agentName,
        summary: info.summary,
        currentTool: info.currentTool || null,
        toolsUsed: info.toolsUsed || 0,
        elapsedSec: Math.round((now - info.startedAt) / 1000),
        idleSec: Math.round((now - lastAt) / 1000),
        stalled: (now - lastAt) > 120000,         // no tool activity for >2min
        status: info.status || 'running',
        childTasks: info.rootTaskId ? _rootChildSnapshot(rootTaskGraphs.get(info.rootTaskId)) : [],
        progress: (info.progress || []).slice(-8),
      };
    });
}

/** Recently-finished delegations for a user — terminal outcomes for check_workers. */
export function listRecentDelegationsForUser(userId, excludeAgentId = null) {
  const now = Date.now();
  const ring = recentDelegations.filter(r => r.userId === userId && r.agentId !== excludeAgentId);
  let durable = [];
  try {
    durable = loadTaskOutcomes(userId, { kind: 'delegation' }).filter(r => (r.agentId || null) !== excludeAgentId);
  } catch (e) { console.warn('[background-tasks] durable delegation outcomes read failed:', e.message); }
  return _mergeRecentWithDurable(ring, durable, userId, RECENT_READ_CAP)
    .map(r => ({ ...r, endedAgoSec: Math.round((now - r.endedAt) / 1000) }));
}

/**
 * One-line ground-truth summary of a user's background work — the server-side
 * equivalent of check_workers, for chat.mjs's "already in progress" truthfulness
 * gate. The gate injects this into a retry note so the model answers from
 * verified status instead of its own stale promises in session memory.
 */
export function describeBackgroundWorkForSession(userId, sessionAgentId = null) {
  // Session ids arrive wrapped (`user_<uid>_<agentId>` or `ephemeral_deleg_…`) —
  // unwrap to the stable agent id for the worker-owner lookup. Keep in sync
  // with _parseCallerSession in skills/delegate/execute.mjs.
  const raw = String(sessionAgentId || '');
  const m = raw.match(/^ephemeral_deleg_d\d+_\d+_[a-z0-9]+_(.+)$/)
    || raw.match(/^ephemeral_deleg_\d+_[a-z0-9]+_(.+)$/)
    || raw.match(/^user_[a-z0-9]+_(.+)$/);
  const ownerKey = m ? m[1] : (raw || null);
  const singleMode = getOrchestrationPolicy(userId).mode === 'single';
  const ago = s => s < 90 ? `${s}s` : `${Math.round(s / 60)}m`;
  const lines = [];
  for (const d of listActiveDelegationsForUser(userId, sessionAgentId)) {
    lines.push(`RUNNING: ${d.name} — "${d.summary}" (${d.toolsUsed} tool calls, started ${ago(d.elapsedSec)} ago${d.stalled ? ', STALLED' : ''})`);
  }
  const activeWorkers = singleMode
    ? listWorkersForUser(userId)
    : (ownerKey ? listWorkersForOwner(userId, ownerKey) : []);
  for (const w of activeWorkers) {
    lines.push(`RUNNING worker: ${w.name} — "${w.summary}" (${w.toolsUsed} tool calls, started ${ago(w.elapsedSec)} ago${w.stalled ? ', STALLED' : ''})`);
  }
  const recent = [
    ...listRecentDelegationsForUser(userId, sessionAgentId),
    ...(singleMode
      ? listRecentWorkersForUser(userId)
      : (ownerKey ? listRecentWorkersForOwner(userId, ownerKey) : [])),
  ].sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)).slice(0, 5);
  for (const r of recent) {
    const verb = r.outcome === 'done' ? 'FINISHED' : (r.outcome === 'stopped' ? 'STOPPED' : 'FAILED');
    lines.push(`${verb} ${ago(r.endedAgoSec)} ago: ${r.name} — ${r.finalText || r.summary}`);
  }
  if (!lines.length) return 'NONE — no delegations or background workers are running for this user, and none finished recently.';
  return lines.join(' | ');
}

export function _stableAgentRef(userId, value) {
  let raw = String(value || '');
  const scopedPrefix = `${userId}_`;
  if (raw.startsWith(scopedPrefix)) raw = raw.slice(scopedPrefix.length);
  const ephemeral = raw.match(/^ephemeral_worker_[^_]+_[^_]+_(.+)$/)
    || raw.match(/^ephemeral_deleg_d\d+_\d+_[a-z0-9]+_(.+)$/)
    || raw.match(/^ephemeral_deleg_\d+_[a-z0-9]+_(.+)$/);
  return ephemeral?.[1] || raw;
}

/**
 * Active autonomous work whose durable owner/session points at an agent.
 * Agent deletion uses this under the account topology writer: deleting the
 * record while a worker/delegation is still reporting back would otherwise
 * orphan its session and make completion routing nondeterministic.
 */
export function listActiveBackgroundWorkForAgent(userId, agentId) {
  const target = _stableAgentRef(userId, agentId);
  if (!userId || !target) return [];
  const out = [];
  for (const [taskId, info] of activeTasks) {
    if (info?.userId !== userId) continue;
    const refs = [
      info.ownerKey,
      info.coordinatorAgentId,
      info.visibleAgentId,
      ...(Array.isArray(info.aliases) ? info.aliases : []),
      ...(Array.isArray(info.plannedAgentRefs) ? info.plannedAgentRefs : []),
    ];
    if (!info.isWorker && !info.isDelegation) refs.push(info.agentId);
    if (!refs.some(ref => _stableAgentRef(userId, ref) === target)) continue;
    out.push({
      taskId,
      name: info.agentName || 'Background task',
      summary: info.summary || '',
      kind: info.isWorker ? 'worker' : (info.isDelegation ? 'delegation' : 'task'),
    });
  }
  return out;
}

/**
 * Stop a worker OR a delegated background task by id. Workers are owner-scoped
 * (ownerKey must match — you can only stop your own); delegations are
 * user-level work (any agent the user asks may stop them, mirroring how
 * check_workers surfaces them to every agent).
 */
export function stopWorker(userId, taskId, ownerKey = null) {
  const info = activeTasks.get(taskId);
  if (!info || info.userId !== userId) return { ok: false, reason: 'not found' };
  if (info.isWorker) {
    if (ownerKey && info.ownerKey !== ownerKey) return { ok: false, reason: 'that worker belongs to a different agent' };
  } else if (!info.isDelegation) {
    return { ok: false, reason: 'not a worker or delegated task' };
  }
  const r = cancelTask(userId, taskId, 'stopped_by_manager');
  return r.ok ? { ok: true, name: info.agentName } : { ok: false, reason: r.reason || 'not cancellable' };
}
