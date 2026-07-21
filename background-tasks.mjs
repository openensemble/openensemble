/**
 * Background agent task dispatcher.
 * Fires ask_agent calls without blocking the coordinator's turn.
 * Live progress surfaces via the task_proxy watcher chip in chat; on
 * completion a private notification is injected into the owning user's
 * coordinator session and delivered only to that user's browser clients.
 */

import { getTurnContext, runWithTurnContext } from './lib/turn-abort-context.mjs';
import fs from 'fs';
import path from 'path';
import { registerWatcher, pushWatcherStatus, completeWatcher } from './scheduler/watchers.mjs';
import { currentTaskContext, runInTaskContext } from './lib/task-proxy-context.mjs';
import { toolRouterContext } from './lib/tool-router-context.mjs';
import { getScheduledContext } from './lib/scheduled-context.mjs';
import { learnToolPlanFromToolEvents, matchToolPlan } from './lib/tool-plan-memory.mjs';
import { registerScheduledChild, completeScheduledChild } from './lib/scheduled-child-barrier.mjs';
import { appendTaskOutcome, loadTaskOutcomes } from './lib/task-outcomes.mjs';
import { BASE_DIR, USERS_DIR } from './lib/paths.mjs';
import { looksLikeToolError, looksLikeToolRefusal } from './lib/tool-error.mjs';
import { resolveWriteTargetSync } from './lib/write-target.mjs';
import {
  evaluateCompoundWorkflowContract,
  formatCompoundContractFailure,
} from './lib/compound-workflow-contract.mjs';
import { getOrchestrationPolicy } from './lib/orchestration-policy.mjs';
import { assertActiveLabVerifierLeaseToken } from './lib/lab-verifier-lease.mjs';
import { iterateUntilAbort } from './lib/abortable-async-iterator.mjs';
import {
  setBackgroundUserSendFn,
  _sendOwner,
  activeTasks,
  verifierLeaseTokens,
  rootTaskGraphs,
  recentWorkers,
  RECENT_CAP,
  RECENT_READ_CAP,
  recentDelegations,
  _slug,
} from './background-tasks/state.mjs';
import {
  _journalAdd,
  _journalRemove,
  _journalMarkCompletion,
  _journalSnapshot,
  JOURNAL_PATH,
} from './background-tasks/journal.mjs';
import {
  registerAutoBackgroundTool,
  markAutoBackgroundToolTerminal,
  retireAutoBackgroundTool,
} from './background-tasks/auto-bg-tool.mjs';

import {
  bindWorkerDeps,
  _retire,
  pushWorkerProgress,
  recordWorkerProgress,
  spawnWorker,
  listWorkersForOwner,
  listWorkersForUser,
  listRecentWorkersForOwner,
  listRecentWorkersForUser,
  listActiveDelegationsForUser,
  listRecentDelegationsForUser,
  describeBackgroundWorkForSession,
  listActiveBackgroundWorkForAgent,
  stopWorker,
  _stableAgentRef,
} from './background-tasks/workers.mjs';

import {
  bindDispatchDeps,
  dispatchBackground,
  _onComplete,
  _resolveRuntimeSessionKey,
  _appendSessionReportOnce,
  _publishWorkerCompletion,
  _publishWorkerArtifacts,
  _coordinatorAgentIdFromSessionKey,
} from './background-tasks/dispatch.mjs';
export { dispatchBackground } from './background-tasks/dispatch.mjs';
export {
  recordWorkerProgress,
  spawnWorker,
  listWorkersForOwner,
  listWorkersForUser,
  listRecentWorkersForOwner,
  listRecentWorkersForUser,
  listActiveDelegationsForUser,
  listRecentDelegationsForUser,
  describeBackgroundWorkForSession,
  listActiveBackgroundWorkForAgent,
  stopWorker,
} from './background-tasks/workers.mjs';

export { setBackgroundUserSendFn } from './background-tasks/state.mjs';
export {
  registerAutoBackgroundTool,
  markAutoBackgroundToolTerminal,
  retireAutoBackgroundTool,
} from './background-tasks/auto-bg-tool.mjs';

/**
 * Restart recovery — called once from server boot, AFTER startWatcherSupervisor
 * (completeWatcher only sees watcher files already loaded into memory). Every
 * journal entry at this point is a task the restart killed mid-flight; mark it
 * cancelled + notify, do NOT auto-resume: silently re-running a side-effectful
 * task ("send the email") after a restart is worse than asking again.
 */
export async function bootRecoverInterruptedTasks() {
  let entries;
  try {
    entries = _journalSnapshot();
  } catch (error) {
    // Preserve corrupt evidence for an operator; never reinterpret it as an
    // empty journal and overwrite tasks whose state is unknown.
    const journalTarget = resolveWriteTargetSync(JOURNAL_PATH);
    const quarantine = `${journalTarget}.corrupt.${Date.now()}`;
    try { fs.renameSync(journalTarget, quarantine); }
    catch (renameError) {
      console.error('[background-tasks] corrupt journal could not be quarantined:', renameError?.message || renameError);
    }
    console.error('[background-tasks] boot recovery refused corrupt journal:', error?.message || error);
    return 0;
  }
  const ids = Object.keys(entries);
  if (!ids.length) return 0;
  const now = Date.now();
  const scheduledRecovery = new Map();
  const scheduledGroups = new Map();
  for (const [taskId, entry] of Object.entries(entries)) {
    if (!entry?.originScheduledTaskId) continue;
    const key = `${entry.userId}:${entry.originScheduledTaskId}:${entry.originScheduledRunId || 'r0'}`;
    if (!scheduledGroups.has(key)) scheduledGroups.set(key, []);
    scheduledGroups.get(key).push([taskId, entry]);
  }
  for (const [key, group] of scheduledGroups) {
    const [, first] = group[0];
    const aggregate = group.map(([taskId, entry]) => {
      const terminal = entry?.completion;
      const body = terminal
        ? (terminal.error || terminal.result || '(completed without text)')
        : 'ERROR: interrupted by server restart before the producer completed';
      return `## ${entry.agentName || taskId}\n${body}`;
    }).join('\n\n');
    try {
      const { recoverInterruptedScheduledBackground } = await import('./scheduler.mjs');
      const recovered = await recoverInterruptedScheduledBackground({
        userId: first.userId,
        originTaskId: first.originScheduledTaskId,
        originTaskOwnerId: first.originScheduledTaskOwnerId || first.userId,
        originScheduledRunId: first.originScheduledRunId || null,
        manual: first.originScheduledManual === true,
        silent: typeof first.originScheduledSilent === 'boolean'
          ? first.originScheduledSilent
          : null,
        aggregate,
      });
      scheduledRecovery.set(key, recovered?.ok === true);
    } catch (error) {
      scheduledRecovery.set(key, false);
      console.error('[background-tasks] scheduled restart recovery failed:', error?.message || error);
    }
  }
  for (const [taskId, e] of Object.entries(entries)) {
    const name = e.agentName || 'Agent';
    const completion = e?.completion && typeof e.completion === 'object' ? e.completion : null;
    const recoveredStatus = completion?.status === 'done' ? 'done'
      : (completion?.status === 'cancelled' ? 'cancelled' : 'error');
    const recoveredResult = completion?.result || '';
    const recoveredError = completion
      ? (completion.error || (recoveredStatus === 'cancelled' ? 'Cancelled before completion.' : ''))
      : 'Interrupted by a server restart — did not finish.';
    const interruptNote = completion
      ? (recoveredError || recoveredResult || 'The task finished before restart, but its completion notice was interrupted.')
      : recoveredError;
    const recentOutcome = recoveredStatus === 'done' ? 'done'
      : (recoveredStatus === 'cancelled' ? 'stopped' : 'error');
    const silentScheduled = Boolean(e.originScheduledTaskId) && e.originScheduledSilent === true;

    // 1. Terminal fact for check_workers (the rings are in-memory, also lost).
    if (e.kind === 'worker') {
      recentWorkers.unshift({
        taskId, ownerKey: e.ownerKey, userId: e.userId,
        name, summary: e.summary, outcome: recentOutcome,
        finalText: interruptNote, toolsUsed: 0,
        startedAt: e.startedAt, endedAt: now,
      });
      if (recentWorkers.length > RECENT_CAP) recentWorkers.length = RECENT_CAP;
    } else {
      recentDelegations.unshift({
        taskId, userId: e.userId, agentId: e.agentId,
        rootTaskId: e.rootTaskId || taskId,
        parentTaskId: null, spanId: null,
        watcherId: e.watcherId || null, rootWatcherId: null,
        visibleAgentId: e.visibleAgentId || null,
        name, summary: e.summary, outcome: recentOutcome,
        finalText: interruptNote, toolsUsed: 0,
        startedAt: e.startedAt, endedAt: now,
      });
      if (recentDelegations.length > RECENT_CAP) recentDelegations.length = RECENT_CAP;
    }
    await appendTaskOutcome(e.userId, {
      taskId,
      kind: e.kind === 'worker' ? 'worker' : 'delegation',
      status: recentOutcome,
      agentName: name,
      agentId: e.agentId || null,
      ownerKey: e.ownerKey || null,
      summary: interruptNote,
      durationMs: Math.max(0, now - (Number(e.startedAt) || now)),
      error: recoveredStatus === 'done' ? null : interruptNote,
    });

    // 2. Finalize the chip now instead of waiting out the 1h watcher boot-reap.
    //    completeWatcher no-ops if the reap already moved it to recent.
    if (e.watcherId && !silentScheduled) {
      try {
        completeWatcher(e.userId, e.watcherId, {
          status: recoveredStatus,
          finalText: completion
            ? (recoveredStatus === 'done' ? `✓ ${name} done` : `⚠ ${name} ${recoveredStatus}`)
            : `⚠ ${name} interrupted by server restart`,
        });
      } catch (err) {
        console.warn('[background-tasks] restart chip finalize failed:', err.message);
      }
    }

    // 3. Session notice — same agent_report shape _onComplete injects — so the
    //    owning chat's LLM reads the interruption as conversation fact on its
    //    next turn. This is what kills the "already in progress" fabrication:
    //    the session that holds the old promise now also holds the cancellation.
    const reportAgentId = await _resolveRuntimeSessionKey(
      e.userId,
      e.visibleAgentId || e.coordinatorAgentId,
    );
    const content = completion
      ? `[${name}'s completion notice was recovered after restart — re: "${e.summary}"]\n${recoveredError || recoveredResult}`
      : `[${name}'s background task was interrupted — re: "${e.summary}"]\nThe server restarted while ${name} was working on this. The task was cancelled and did NOT finish. If it is still wanted, it must be started again.`;
    const displayContent = completion
      ? (recoveredError || recoveredResult)
      : `The server restarted while ${name} was working on this. The task was cancelled and did not finish. If it is still wanted, it must be started again.`;
    const reportId = e.spanId || taskId;
    const scheduledKey = e.originScheduledTaskId
      ? `${e.userId}:${e.originScheduledTaskId}:${e.originScheduledRunId || 'r0'}`
      : null;
    const scheduledRecoveryDurable = !scheduledKey || scheduledRecovery.get(scheduledKey) === true;
    // Silent scheduled runs use the scheduler/task-run record as their durable
    // completion surface. They intentionally have no session report or live
    // completion notification to deliver.
    let deliveryDurable = silentScheduled
      ? scheduledRecoveryDurable
      : Boolean(reportAgentId) && scheduledRecoveryDurable;
    if (!silentScheduled && reportAgentId) {
      try {
        await _appendSessionReportOnce(reportAgentId, {
          role: 'assistant',
          kind: 'agent_report',
          ...(e.kind === 'worker' ? { hidden: true } : {}),
          reportId,
          agentName: name, agentEmoji: e.agentEmoji || '🤖',
          content,
          displayContent,
          toolEvents: [],
          targetAgentId: e.agentId || null,
          originalTask: e.originalTask || e.summary || '',
          taskId,
          rootTaskId: e.rootTaskId || taskId,
          watcherId: e.watcherId || null,
          rootWatcherId: e.rootWatcherId || e.watcherId || null,
          spanId: e.spanId || null,
          status: recoveredStatus,
          ts: now,
        });
      } catch (err) {
        deliveryDurable = false;
        console.warn('[background-tasks] restart-notice inject failed:', err.message);
      }
    }

    // 4. Best-effort live notice. Workers remain an internal implementation
    //    detail: their raw report is hidden above and a primary-labelled
    //    assistant notification is delivered instead. Named delegations keep
    //    their existing card, scoped to this owner only.
    if (!silentScheduled && e.kind === 'worker') {
      const published = await _publishWorkerCompletion({
        taskId,
        userId: e.userId,
        coordinatorAgentId: reportAgentId,
        agentName: name,
        result: recoveredStatus === 'done' ? recoveredResult : null,
        errorMsg: recoveredStatus === 'done' ? null : interruptNote,
        originalTask: e.originalTask || e.summary || '',
        persistedImages: Array.isArray(completion?.images) ? completion.images : [],
        verifierLeaseRequired: e.verifierLeaseRequired === true,
        // Verifier capabilities are never journaled. A recovered verifier task
        // therefore takes the deterministic zero-model completion path.
        verifierLeaseToken: null,
      });
      deliveryDurable = deliveryDurable && published;
      if (Array.isArray(completion?.images) && completion.images.length) {
        try {
          await _publishWorkerArtifacts({
            taskId,
            userId: e.userId,
            sessionAgentId: reportAgentId,
            wsAgentId: _coordinatorAgentIdFromSessionKey(reportAgentId, e.userId),
            reportImages: completion.images,
            persistedImages: completion.images,
          });
        } catch (error) {
          deliveryDurable = false;
          console.warn('[background-tasks] restart artifact recovery failed:', error?.message || error);
        }
      }
    } else if (!silentScheduled) {
      _sendOwner(e.userId, {
        type: 'agent_report',
        agent: reportAgentId,
        reportId,
        agentName: name, agentEmoji: e.agentEmoji || '🤖',
        content,
        displayContent,
        toolEvents: [],
        targetAgentId: e.agentId || null,
        originalTask: e.originalTask || e.summary || '',
        taskId,
        rootTaskId: e.rootTaskId || taskId,
        watcherId: e.watcherId || null,
        rootWatcherId: e.rootWatcherId || e.watcherId || null,
        spanId: e.spanId || null,
        status: recoveredStatus,
        ts: now,
      });
    }
    // A crash/failure midway leaves the entry available for the next boot.
    if (deliveryDurable) _journalRemove(taskId);
  }
  console.log(`[background-tasks] boot: recovered ${ids.length} interrupted/finalizing background task(s)`);
  return ids.length;
}



/** Stable correlation passed into one detached background agent run. */
export function backgroundRunTraceOptions(rec, traceSource = 'background') {
  return {
    rootTaskId: rec?.rootTaskId || rec?.taskId || null,
    traceSource,
    ...(rec?.sourceMessageId ? { messageId: rec.sourceMessageId } : {}),
    ...(rec?.sourceAttemptId ? { attemptId: rec.sourceAttemptId } : {}),
    ...(rec?.sourceSessionKey ? { sessionKey: rec.sourceSessionKey } : {}),
    ...(rec?.sourceSessionEpoch ? { sessionEpoch: rec.sourceSessionEpoch } : {}),
  };
}

export function resolveBackgroundRootTaskId(taskId, opts = {}, scheduledCtx = null) {
  // A scheduled occurrence is the outer authorization boundary. A nested
  // task context must not mint a fresh side-effect scope on replay.
  return scheduledCtx?.runId || opts?.rootTaskId || taskId;
}

// Voice-device origin of the CURRENT turn (ALS), stamped onto task records at
// registration so completions can announce themselves on the device speaker.
function _voiceOrigin() {
  try {
    const tc = getTurnContext();
    return { voiceDeviceId: tc?.deviceId ?? null, voiceConversation: !!tc?.conversationMode };
  } catch { return { voiceDeviceId: null, voiceConversation: false }; }
}

// Root task graph for nested delegation. Existing ids remain intact:
// - watcher UUIDs are still the user-visible chip ids
// - bg_/deleg_/ephemeral ids remain internal runtime ids
// This graph links them so status lookups can resolve "root -> child agent"
// and a root chip does not finish while child delegations are still running.
function _rootChildSnapshot(root) {
  if (!root?.children?.size) return [];
  return [...root.children.values()].map(c => ({
    taskId: c.taskId,
    watcherId: c.watcherId || null,
    spanId: c.spanId || null,
    name: c.name || 'Agent',
    summary: c.summary || '',
    status: c.status || 'running',
    currentTool: c.currentTool || null,
    startedAt: c.startedAt || null,
    lastActivityAt: c.lastActivityAt || null,
  }));
}

function _ensureRootGraph({ userId, rootTaskId, rootWatcherId = null, visibleAgentId = null, summary = '' }) {
  if (!rootTaskId) return null;
  let root = rootTaskGraphs.get(rootTaskId);
  if (!root) {
    root = {
      userId,
      rootTaskId,
      rootWatcherId: rootWatcherId || null,
      visibleAgentId: visibleAgentId || null,
      summary: summary || '',
      children: new Map(),
      pendingCompletion: null,
    };
    rootTaskGraphs.set(rootTaskId, root);
  } else {
    if (rootWatcherId && !root.rootWatcherId) root.rootWatcherId = rootWatcherId;
    if (visibleAgentId && !root.visibleAgentId) root.visibleAgentId = visibleAgentId;
    if (summary && !root.summary) root.summary = summary;
  }
  return root;
}

/** @param {{ userId?: string, rootTaskId?: string, rootWatcherId?: string|null, visibleAgentId?: string|null, summary?: string }} [opts] */
export function registerTaskRoot({ userId, rootTaskId, rootWatcherId, visibleAgentId = null, summary = '' } = {}) {
  return !!_ensureRootGraph({ userId, rootTaskId, rootWatcherId, visibleAgentId, summary });
}

function _attachRootChild(taskId, rec) {
  if (!rec?.rootTaskId || rec.rootTaskId === taskId) return;
  const root = _ensureRootGraph({
    userId: rec.userId,
    rootTaskId: rec.rootTaskId,
    rootWatcherId: rec.rootWatcherId || rec.parentWatcherId || null,
    visibleAgentId: rec.visibleAgentId || null,
  });
  if (!root) return;
  root.children.set(taskId, {
    taskId,
    watcherId: rec.watcherId || null,
    spanId: rec.spanId || null,
    name: rec.agentName,
    summary: rec.summary,
    status: rec.status || 'running',
    currentTool: rec.currentTool || null,
    startedAt: rec.startedAt,
    lastActivityAt: Date.now(),
  });
  if (root.rootWatcherId) {
    const names = _rootChildSnapshot(root).map(c => c.name).filter(Boolean).join(', ');
    pushWatcherStatus(rec.userId, root.rootWatcherId, `Delegated child task running: ${names || rec.agentName}`, {
      rootTaskId: rec.rootTaskId,
      phase: 'child_running',
      status: 'running',
      childTasks: _rootChildSnapshot(root),
      lastActivityAt: Date.now(),
    });
  }
}

function _updateRootChildProgress(rec, extra = {}) {
  if (!rec?.rootTaskId || rec.rootTaskId === rec.taskId) return;
  const root = rootTaskGraphs.get(rec.rootTaskId);
  const child = root?.children?.get(rec.taskId);
  if (!root || !child) return;
  Object.assign(child, {
    status: rec.status || child.status || 'running',
    currentTool: rec.currentTool || null,
    lastActivityAt: Date.now(),
    ...extra,
  });
  if (root.rootWatcherId && rec.watcherId !== root.rootWatcherId) {
    const action = rec.currentTool ? `running ${rec.currentTool}` : (extra.status || child.status || 'running');
    pushWatcherStatus(rec.userId, root.rootWatcherId, `${rec.agentName || 'Agent'}: ${action}`, {
      rootTaskId: rec.rootTaskId,
      phase: 'child_progress',
      status: 'running',
      childTasks: _rootChildSnapshot(root),
      lastActivityAt: Date.now(),
    });
  }
}

export function hasActiveTaskChildren(rootTaskId) {
  const root = rootTaskGraphs.get(rootTaskId);
  return !!(root?.children?.size);
}

export function clearTaskRoot(rootTaskId) {
  if (!rootTaskId) return false;
  return rootTaskGraphs.delete(rootTaskId);
}

/** @param {{ userId?: string, rootTaskId?: string, rootWatcherId?: string|null, status?: string, finalText?: string, finalReportPreview?: string }} [opts] */
export function deferRootCompletion({ userId, rootTaskId, rootWatcherId = null, status = 'done', finalText = '', finalReportPreview = '' } = {}) {
  const root = rootTaskGraphs.get(rootTaskId);
  if (!root?.children?.size) return false;
  if (rootWatcherId && !root.rootWatcherId) root.rootWatcherId = rootWatcherId;
  root.pendingCompletion = {
    status,
    finalText,
    finalReportPreview,
    at: Date.now(),
  };
  const names = _rootChildSnapshot(root).map(c => c.name).filter(Boolean).join(', ');
  if (root.rootWatcherId) {
    pushWatcherStatus(userId || root.userId, root.rootWatcherId, `Waiting on delegated task(s): ${names || 'child task'}`, {
      rootTaskId,
      phase: 'waiting_children',
      status: 'running',
      childTasks: _rootChildSnapshot(root),
      finalReportPreview,
      lastActivityAt: Date.now(),
    });
  }
  return true;
}

// Fire the voice completion a deferred root stashed on its pendingCompletion
// (see _onComplete's deferChip branch), exactly once, at TRUE tree completion
// — i.e. right before the pendingCompletion is consumed/the root graph is
// torn down below. `_voiceReleased` guards re-entry the same way
// `_waitHintReleased` guards the non-deferred, immediate path in _onComplete;
// the two paths are mutually exclusive per task but this keeps the invariant
// enforced even if this ever runs twice for the same pendingCompletion object
// (e.g. a duplicate final-child event racing in).
function _fireDeferredVoiceCompletion(pending) {
  if (!pending?.voiceDeviceId || pending._voiceReleased) return;
  pending._voiceReleased = true;
  const { voiceDeviceId, voiceAgentName, voiceResultText, voiceSummary, status } = pending;
  const agentLabel = voiceAgentName || 'The agent';
  import('./lib/voice-announcements.mjs')
    .then(({ enqueueVoiceAnnouncement, announcementLine }) => {
      const line = status && status !== 'done'
        ? `${agentLabel} hit a problem with the background task.`
        : announcementLine(agentLabel, voiceResultText || '', voiceSummary || '');
      enqueueVoiceAnnouncement(voiceDeviceId, line, { kind: 'background' });
    })
    .catch(() => {});
  import('./ws-handler.mjs')
    .then(m => m.noteDeviceBackgroundWork(voiceDeviceId, -1))
    .catch(() => {});
}

function _completeRootChild(taskId, rec, status, finalReportPreview) {
  if (!rec?.rootTaskId || rec.rootTaskId === taskId) return;
  const root = rootTaskGraphs.get(rec.rootTaskId);
  if (!root) return;
  const child = root.children.get(taskId);
  if (child) {
    child.status = status;
    child.currentTool = null;
    child.lastActivityAt = Date.now();
    child.finalReportPreview = finalReportPreview;
  }
  root.children.delete(taskId);
  if (!root.rootWatcherId) {
    if (root.children.size === 0) {
      if (root.pendingCompletion) _fireDeferredVoiceCompletion(root.pendingCompletion);
      // Scheduled/background correlation roots can be deliberately invisible
      // (the scheduled-child barrier owns their UI lifecycle). Retire that
      // graph when its last child finishes even when there is no root watcher
      // or deferred completion, otherwise one entry leaks per scheduled fire.
      rootTaskGraphs.delete(rec.rootTaskId);
    }
    return;
  }
  if (root.pendingCompletion && status !== 'done') {
    root.pendingCompletion.status = status;
    root.pendingCompletion.finalText = finalReportPreview || `${rec.agentName || 'Child task'} ${status}`;
    root.pendingCompletion.finalReportPreview = finalReportPreview;
  }

  if (root.children.size > 0) {
    const names = _rootChildSnapshot(root).map(c => c.name).filter(Boolean).join(', ');
    pushWatcherStatus(rec.userId, root.rootWatcherId, `${rec.agentName || 'Agent'} finished; waiting on ${names || 'remaining child task(s)'}`, {
      rootTaskId: rec.rootTaskId,
      phase: 'waiting_children',
      status: 'running',
      childTasks: _rootChildSnapshot(root),
      lastActivityAt: Date.now(),
    });
    return;
  }

  if (root.pendingCompletion) {
    const finalStatus = root.pendingCompletion.status || 'done';
    const finalText = root.pendingCompletion.finalText || (finalStatus === 'done'
      ? '✓ Delegated task tree done'
      : `Delegated task tree ${finalStatus}`);
    pushWatcherStatus(rec.userId, root.rootWatcherId, finalText, {
      rootTaskId: rec.rootTaskId,
      status: finalStatus,
      phase: finalStatus,
      childTasks: [],
      canCancel: false,
      currentTool: null,
      finalReportPreview: root.pendingCompletion.finalReportPreview || finalReportPreview,
      lastActivityAt: Date.now(),
    });
    completeWatcher(rec.userId, root.rootWatcherId, {
      status: finalStatus,
      finalText,
    });
    _fireDeferredVoiceCompletion(root.pendingCompletion);
    rootTaskGraphs.delete(rec.rootTaskId);
  }
}

function taskLabel(agentEmoji, agentName, summary) {
  const taskText = `${summary || ''}`.trim();
  return `${agentEmoji || '🤖'} ${agentName || 'Agent'}${taskText ? `: ${taskText.slice(0, 60)}${taskText.length > 60 ? '…' : ''}` : ''}`;
}

function taskState(taskId, extra = {}) {
  const rec = activeTasks.get(taskId);
  if (!rec) return null;
  return {
    taskId,
    rootTaskId: rec.rootTaskId || taskId,
    parentTaskId: rec.parentTaskId || null,
    parentWatcherId: rec.parentWatcherId || null,
    rootWatcherId: rec.rootWatcherId || rec.watcherId || null,
    spanId: rec.spanId || null,
    visibleAgentId: rec.visibleAgentId || rec.coordinatorAgentId || null,
    aliases: rec.aliases || [],
    status: rec.status || 'running',
    targetAgentId: rec.agentId,
    targetAgentName: rec.agentName,
    targetAgentEmoji: rec.agentEmoji,
    summary: rec.summary || '',
    startedAt: rec.startedAt,
    lastActivityAt: Date.now(),
    toolsUsed: rec.toolsUsed || 0,
    currentTool: rec.currentTool || null,
    phase: rec.phase || 'running',
    ownerKey: rec.ownerKey || null,
    isWorker: !!rec.isWorker,
    continuation: rec.autoContinue ? { enabled: true, parentAgentId: rec.coordinatorAgentId || null } : null,
    canCancel: typeof rec.abort === 'function' && rec.status !== 'cancelling',
    cancelling: rec.status === 'cancelling',
    ...extra,
  };
}

function pushTaskProgress(taskId, text, extra = {}) {
  const rec = activeTasks.get(taskId);
  if (!rec?.watcherId || !text) return false;
  rec.lastActivityAt = Date.now();
  rec.phase = extra.phase || rec.phase || 'running';
  const pushed = pushWatcherStatus(rec.userId, rec.watcherId, text, taskState(taskId, extra));
  _updateRootChildProgress({ ...rec, taskId }, { status: extra.phase || rec.phase || 'running' });
  return pushed;
}

function nextToolEventSeq(events) {
  const next = (Number(events?._rawEventSeq) || 0) + 1;
  try {
    Object.defineProperty(events, '_rawEventSeq', {
      value: next, writable: true, configurable: true, enumerable: false,
    });
  } catch { /* evidence rows still carry their own sequence */ }
  return next;
}

function eventToolCallId(ev) {
  const value = ev?.toolCallId ?? ev?.tool_call_id ?? ev?.callId ?? ev?.call_id;
  return value == null ? null : String(value).trim() || null;
}

// The generic slow-tool handoff returns progress, not proof that the requested
// operation completed. Keep it out of the completion-success ledger.
function looksLikePendingBackgroundResult(text) {
  return /\b(?:is|still)\s+running in the background\b[\s\S]{0,600}\btask\s+(?:wkr_\d+_[a-z0-9]+|[0-9a-f]{8}-[0-9a-f-]{27,})\b/i
    .test(String(text || ''));
}

function trackToolEvent(events, ev, agentId = null) {
  if (!Array.isArray(events) || !ev?.name) return;
  const seq = nextToolEventSeq(events);
  const toolCallId = eventToolCallId(ev);
  if (ev.type === 'tool_call') {
    events.push({
      name: ev.name,
      ...(toolCallId ? { toolCallId } : {}),
      args: ev.args || null,
      startedAt: Date.now(),
      status: 'running',
      callObserved: true,
      callSeq: seq,
      ...((ev.providerNative === true || ev.native === true) ? { native: true } : {}),
      agentId: ev.agentId || agentId || null,
    });
    return;
  }
  // Exact provider identity wins. Legacy providers pair same-name calls FIFO;
  // LIFO can attach parallel results to the wrong invocation.
  const candidates = events.filter(e => e.name === ev.name && e.status === 'running');
  const rec = toolCallId
    ? candidates.find(e => e.toolCallId === toolCallId)
    : candidates[0];
  if (ev.type === 'tool_progress' && rec) {
    rec.progressPreview = String(ev.text || '').slice(-1000);
    rec.updatedSeq = seq;
    return;
  }
  // Provider-hosted web search never emits a local tool_call — only a transient
  // tool_progress with no preceding record (openai-responses.mjs). Without a
  // synthetic record here the recipe learner never sees web_search on
  // native-search models, so learned recipes chronically omit the agent's only
  // path to the web. web_search ONLY — other hosted progress (image_generation)
  // must not fabricate recipe entries.
  if (ev.type === 'tool_progress' && ev.name === 'web_search' && !rec) {
    const aid = ev.agentId || agentId || null;
    if (!events.some(e => e.name === 'web_search' && e.native && e.agentId === aid)) {
      events.push({
        name: 'web_search', args: null, startedAt: Date.now(), endedAt: Date.now(),
        durationMs: 0, status: 'done', native: true, agentId: aid,
        callObserved: true, resultObserved: true,
        callSeq: seq, resultSeq: seq, syntheticHosted: true,
        completionEvidence: 'provider-progress',
        preview: 'provider-hosted web search',
      });
    }
    return;
  }
  if (ev.type === 'tool_result') {
    const now = Date.now();
    const text = String(ev.text || '');
    const target = rec || {
      name: ev.name, args: null, startedAt: now, status: 'running',
      callObserved: false,
      callSeq: null,
      ...(toolCallId ? { toolCallId } : {}),
      ...((ev.providerNative === true || ev.native === true) ? { native: true } : {}),
      agentId: ev.agentId || agentId || null,
    };
    if (!rec) events.push(target);
    target.endedAt = now;
    target.durationMs = target.endedAt - target.startedAt;
    target.resultObserved = true;
    target.resultSeq = seq;
    const errored = ev.isError === true || ev.status === 'error'
      || looksLikeToolError(text) || looksLikeToolRefusal(text);
    target.status = errored
      ? 'error'
      : (looksLikePendingBackgroundResult(text) ? 'pending' : 'done');
    target.preview = ev.preview || text.split('\n').find(l => l.trim()) || '';
    target.text = text.slice(0, 10000);
    if (ev.providerNative === true || ev.native === true) target.native = true;
  }
}

function reportImageFromEvent(ev) {
  if (ev?.type !== 'image' || !ev.filename) return null;
  const out = {
    filename: ev.filename,
    mimeType: ev.mimeType || ev.mediaType || 'image/png',
  };
  if (ev.savedPath) out.savedPath = ev.savedPath;
  if (ev.base64) out.base64 = ev.base64;
  return out;
}

function imageMimeFromFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function reportImagesFromText(userId, text) {
  if (!userId || !text) return [];
  const userImageDir = path.join(USERS_DIR, userId, 'images');
  const userImageDirResolved = path.resolve(userImageDir);
  const out = [];
  const re = /\[Image:\s*([^\]\r\n]+)\](?:[ \t]*(?:\r?\n|[ \t]+)[ \t]*Saved to:\s*([^\r\n]+))?/gi;
  for (const match of String(text).matchAll(re)) {
    const filename = path.basename(String(match[1] || '').trim());
    if (!filename) continue;
    const expectedPath = path.join(userImageDir, filename);
    if (!fs.existsSync(expectedPath)) continue;
    const savedRaw = String(match[2] || '').trim();
    let savedPath = expectedPath;
    if (savedRaw && path.basename(savedRaw) === filename) {
      const resolved = path.resolve(savedRaw);
      if (resolved === expectedPath || resolved.startsWith(`${userImageDirResolved}${path.sep}`)) {
        savedPath = savedRaw;
      }
    }
    out.push({ filename, mimeType: imageMimeFromFilename(filename), savedPath });
  }
  return out;
}

function mergeReportImages(images) {
  const out = [];
  const seen = new Set();
  for (const image of Array.isArray(images) ? images : []) {
    if (!image) continue;
    const key = image.filename || image.savedPath || image.base64?.slice?.(0, 64);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(image);
  }
  return out;
}

export function persistedReportImage(img) {
  if (!img?.filename && !img?.base64) return null;
  const out = {
    ...(img.filename ? { filename: img.filename } : {}),
    mimeType: img.mimeType || img.mediaType || 'image/png',
    ...(img.savedPath ? { savedPath: img.savedPath } : {}),
  };
  // Avoid bloating durable session rows when the generated file already has a
  // stable saved filename/path. For transient image-only payloads, base64 is
  // the only renderable copy, so keep it.
  if (img.base64 && !img.savedPath && !img.filename) out.base64 = img.base64;
  return out;
}

// Doc ids PRODUCED by a pipeline stage — from doc-PRODUCING tools only.
// Deliberately NOT a generic id regex over every tool result: list_research /
// list_profile_files output OLD doc ids, and harvesting those would whitelist
// exactly the stale documents the handoff guard exists to block.
const DOC_PRODUCING_TOOLS = new Set(['save_research', 'update_research', 'deep_research_parallel']);
function extractProducedBodyDocIds(ev) {
  if (ev?.type !== 'tool_result' || !DOC_PRODUCING_TOOLS.has(ev.name)) return [];
  const text = String(ev.text || '');
  const ids = new Set();
  if (ev.name === 'save_research' || ev.name === 'update_research') {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.id) ids.add(`research:${parsed.id}`);
    } catch { /* not JSON — fall through to the pattern below */ }
  }
  // deep_research_parallel: "… synthesized into document doc_xxxxxxxx."
  for (const m of text.matchAll(/\bdocument\s+(doc_[a-f0-9]{6,})\b/ig)) ids.add(`research:${m[1]}`);
  return [...ids];
}

// Only the doc-handoff phrasings — NOT generic "email the briefing", which
// legitimately emails the handed-off TEXT with no document involved.
function handoffExpectsProducedDoc(directive = '') {
  return /\bbody_doc_id\b|\b(?:saved|produced|generated) document\b|\bsaves?d?\b.{0,40}\bas a document\b|\bdocument (?:it|she|he|they) (?:saved|produced)\b/i
    .test(String(directive));
}

// Real email intent only — deliberately NOT generic "send", which would catch
// Telegram, push notifications, "send to calendar", etc. Used to arm the
// body-doc handoff guard and to decide whether a failed scheduled run owes the
// user a failure email.
function impliesEmailDelivery(text = '') {
  return /\b(?:e-?mail\w*|mail(?:ed|ing)?|body_doc_id|email_compose|email_user)\b/i.test(String(text));
}

// A scheduled run whose whole point was emailing the user must not fail
// SILENTLY — the user reads "no email arrived" as "my install is down". This
// is a deterministic system notice from the failure path; never model-written
// content, never a stale document substitute. One notice per scheduled task
// per day.
export function scheduledFailureEmailScope(originScheduledRunId, originScheduledTaskId, taskId, day) {
  // Prefer the scheduler's logical occurrence id. It survives process restart
  // and does not change when the same run crosses UTC midnight while failing.
  // Older/legacy callers have no run id, so retain the historical task/day
  // boundary as the safest bounded fallback.
  return originScheduledRunId
    ? `scheduled-failure-run:${originScheduledRunId}`
    : `scheduled-failure:${originScheduledTaskId || taskId}:${day}`;
}

export async function sendScheduledFailureEmail({ userId, taskId, originScheduledTaskId, originScheduledRunId, pipeName, originalTask, reason }) {
  const day = new Date().toISOString().slice(0, 10);
  const subject = `Scheduled task failed - ${day}`;
  const body = [
    'OpenEnsemble ran a scheduled task, but the run failed before the requested email could be produced.',
    '',
    `Task: ${String(originalTask || '(unknown)').slice(0, 300)}`,
    `Pipeline: ${pipeName}`,
    `Task ID: ${taskId}`,
    `Reason: ${String(reason || 'unknown').slice(0, 500)}`,
    '',
    'No older saved document or stale content was substituted.',
    'OpenEnsemble itself is running — this was a task failure, not an installation outage.',
  ].join('\n');
  try {
    const { sendEmailToUser } = await import('./lib/email-delivery.mjs');
    const delivery = await sendEmailToUser(userId, {
      subject,
      body,
      // The scheduler occurrence is the logical notification event. The
      // durable store is the source of truth so restart and concurrent failure
      // paths keep one boundary.
      idempotencyScope: scheduledFailureEmailScope(
        originScheduledRunId,
        originScheduledTaskId,
        taskId,
        day,
      ),
    });
    if (delivery.ok) {
      console.log('[background-tasks] scheduled failure notice emailed:', String(delivery.message).slice(0, 120));
    } else {
      console.warn('[background-tasks] scheduled failure email failed:', delivery.message);
    }
  } catch (e) {
    console.warn('[background-tasks] scheduled failure email failed:', e.message);
  }
}

// Safety net: if a worker hangs forever (stuck upstream stream, etc.) the task
// would stay in activeTasks forever. Sweep every hour, reap anything older
// than 24h so /health + UI don't accumulate ghosts.
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
export async function reapStaleTasks(now = Date.now()) {
  // Snapshot first: _onComplete mutates activeTasks (and may cascade-retire
  // children), so iterating while calling it would be unsafe.
  const stale = [];
  for (const [taskId, info] of activeTasks) {
    if (info.startedAt && (now - info.startedAt) > TASK_TTL_MS) stale.push([taskId, info]);
  }
  for (const [taskId, info] of stale) {
    if (!activeTasks.has(taskId)) continue; // a cascade already retired it
    console.warn('[background-tasks] Reaping stale task:', taskId, 'agent:', info.agentName);
    try {
      // Stop the producer before claiming terminal ownership. Its late
      // catch/result path becomes a no-op at _onComplete's synchronous claim.
      try { info.abort?.('ttl_reaped'); } catch { /* already stopping */ }
      // Route through the normal completion path so the child barrier, the
      // root-graph child, and any voice WAITING-ring hold are released. A bare
      // activeTasks.delete leaked rootTaskGraphs and left a device ring lit.
      await _onComplete(taskId, info.userId, info.coordinatorAgentId, info.agentName || 'Task', info.agentEmoji || '🤖', null, 'reaped: no activity in 24h', 'error');
      // A stale ROOT with (also-stale) children takes _onComplete's deferChip
      // branch and is left in activeTasks — which would re-reap it every hour.
      // The reap is terminal by definition (24h idle); its children are in this
      // same stale sweep and get reaped on their own, so hard-remove the root.
      if (activeTasks.has(taskId)) { activeTasks.delete(taskId); _journalRemove(taskId); }
    } catch (e) {
      console.warn('[background-tasks] reap via _onComplete failed, hard-removing:', e?.message || e);
      activeTasks.delete(taskId);
      _journalRemove(taskId);
    }
  }
  return stale.length;
}

setInterval(() => {
  reapStaleTasks().catch(e => console.warn('[background-tasks] stale-task sweep failed:', e?.message || e));
}, 60 * 60 * 1000).unref();

/**
 * Fire a background agent task. Returns a taskId immediately.
 * @param {object} scopedAgent - agent object with scoped id
 * @param {string} task - enriched task text
 * @param {string} userId
 * @param {string} coordinatorAgentId - scoped id of the coordinator
 * @param {string} agentName - display name for notifications
 * @param {string} agentEmoji - emoji icon (e.g. "📧")
 * @param {{autoContinue?: boolean, extraSystemNote?: string | null, routeText?: string | null, rootTaskId?: string|null, sourceMessageId?: string|null, sourceAttemptId?: string|null, sourceSessionKey?: string|null, sourceSessionEpoch?: string|null}} [opts]
 */
// Dispatch + completion: background-tasks/dispatch.mjs
export function cancelTask(userId, id, reason = 'cancelled') {
  for (const [taskId, info] of activeTasks) {
    if (info.userId !== userId) continue;
    if (taskId !== id && info.watcherId !== id) continue;
    if (info._finalizationClaimed || info._terminalMarked
        || ['done', 'error', 'cancelled', 'finalizing'].includes(info.status)) {
      return { ok: false, reason: 'already finalizing', taskId, watcherId: info.watcherId };
    }
    if (typeof info.abort !== 'function') return { ok: false, reason: 'not cancellable' };
    if (info.status === 'cancelling') return { ok: true, taskId, watcherId: info.watcherId, alreadyCancelling: true };
    info.status = 'cancelling';
    info.phase = 'cancelling';
    info.currentTool = null;
    pushTaskProgress(taskId, `Cancelling ${info.agentName || 'task'}...`, {
      status: 'cancelling',
      phase: 'cancelling',
      canCancel: false,
      cancelling: true,
      currentTool: null,
    });
    try { info.abort(reason); } catch { /* already stopping */ }
    // Cancelling a root cancels its still-running children too. Children share
    // the root's rootTaskId but have their own AbortControllers, so aborting
    // only the root would leave orphaned child delegations running (and
    // reporting) with no visible chip left to stop them from.
    // The graph may be keyed by this task's own id, by its rootTaskId, or by
    // its watcher id (auto-bg ADOPTS the sync delegation's chip as the root
    // key) — check all three or the cascade silently misses the children.
    const root = rootTaskGraphs.get(taskId)
      || (info.rootTaskId && rootTaskGraphs.get(info.rootTaskId))
      || (info.watcherId && rootTaskGraphs.get(info.watcherId))
      || null;
    if (root?.children?.size) {
      for (const childId of root.children.keys()) {
        if (childId === taskId) continue;
        const child = activeTasks.get(childId);
        if (!child || child.status === 'cancelling' || typeof child.abort !== 'function') continue;
        child.status = 'cancelling';
        child.phase = 'cancelling';
        child.currentTool = null;
        pushTaskProgress(childId, `Cancelling ${child.agentName || 'task'}...`, {
          status: 'cancelling',
          phase: 'cancelling',
          canCancel: false,
          cancelling: true,
          currentTool: null,
        });
        try { child.abort(reason); } catch { /* already stopping */ }
      }
    }
    return { ok: true, taskId, watcherId: info.watcherId };
  }
  return { ok: false, reason: 'not found' };
}

export function getActiveTasks() {
  return [...activeTasks.entries()].map(([taskId, info]) => ({ taskId, ...info }));
}

// Liveness probe for the task_proxy silence reaper (scheduler/watchers.mjs):
// a task still registered here is running, however long its current tool has
// been silent. Dynamic-imported there to avoid a static import cycle.
export function isTaskActive(taskId) {
  return activeTasks.has(taskId);
}

// ── Sync (in-turn) delegation tracking ───────────────────────────────────────
// A sync delegation streams into the caller's open turn, but it is still real
// background-shaped work: it can outlive the visible turn (the auto-bg net
// detaches it at 10s), the user may want to cancel it, and check_workers
// should see it. Registering it in the SAME activeTasks registry buys all of
// that at once: cancelTask finds it by taskId or watcherId (chip Stop button),
// listActiveDelegationsForUser lists it, the restart journal covers it, and
// it can join a root task graph like any dispatched child.
//
// The delegate skill drives the record through the returned handle. Completion
// does NOT inject an agent_report — the sync result returns inline in the
// caller's turn (or via the auto-bg drain once the turn detached).

/**
 * Complete a sync delegation: retire it to the recent ring, drop it from the
 * registry + journal, and finalize its chip. Children-aware: when the auto-bg
 * net ADOPTED this delegation's chip as a root (roles.mjs keys the root graph
 * by the watcherId), a chip with still-running child delegations defers to
 * deferRootCompletion instead of reading "done" under them.
 */
export function completeSyncDelegation(taskId, { outcome = 'done', finalText = '', finalReportPreview = '' } = {}) {
  const rec = activeTasks.get(taskId);
  if (!rec || !rec.isSync || rec._finalizationClaimed) return false;
  rec._finalizationClaimed = true;
  rec.abort = null;
  const status = (outcome === 'stopped' || outcome === 'cancelled') ? 'cancelled' : (outcome === 'error' ? 'error' : 'done');
  const syncOutcome = status === 'done' ? 'done' : (status === 'cancelled' ? 'stopped' : 'error');
  rec.status = status;
  rec.phase = status;
  rec.currentTool = null;
  const syncEndedAt = Date.now();
  recentDelegations.unshift({
    taskId, userId: rec.userId, agentId: rec.agentId,
    rootTaskId: rec.rootTaskId || taskId,
    parentTaskId: rec.parentTaskId || null,
    spanId: rec.spanId || null,
    watcherId: rec.watcherId || null,
    rootWatcherId: rec.rootWatcherId || null,
    visibleAgentId: rec.visibleAgentId || null,
    name: rec.agentName, summary: rec.summary,
    outcome: syncOutcome,
    finalText: String(finalReportPreview || finalText || '').slice(0, 240),
    toolsUsed: rec.toolsUsed || 0,
    startedAt: rec.startedAt, endedAt: syncEndedAt,
  });
  if (recentDelegations.length > RECENT_CAP) recentDelegations.length = RECENT_CAP;
  // Durable mirror — sync (in-turn) delegations retire through this function
  // instead of _onComplete, so this is the other delegation-retire point that
  // needs the same 7d JSONL durability. Fire-and-forget, never blocks.
  appendTaskOutcome(rec.userId, {
    taskId, kind: 'delegation', agentId: rec.agentId,
    agentName: rec.agentName, status: syncOutcome,
    summary: String(finalReportPreview || finalText || rec.summary || ''),
    durationMs: syncEndedAt - (rec.startedAt || syncEndedAt),
    error: status === 'error' ? String(finalText || finalReportPreview || '') : null,
  }).catch(e => console.warn('[background-tasks] sync delegation task-outcome append failed:', e.message));
  _completeRootChild(taskId, rec, status, String(finalReportPreview || finalText || '').slice(0, 800));
  activeTasks.delete(taskId);
  _journalRemove(taskId);

  if (rec.watcherId) {
    const rootKey = [taskId, rec.rootTaskId, rec.watcherId].find(k => k && rootTaskGraphs.get(k)?.children?.size);
    if (rootKey) {
      deferRootCompletion({ userId: rec.userId, rootTaskId: rootKey, rootWatcherId: rec.watcherId, status, finalText, finalReportPreview });
    } else {
      if (finalText) {
        pushWatcherStatus(rec.userId, rec.watcherId, finalText, {
          taskId, status, phase: status,
          canCancel: false, cancelling: false, currentTool: null,
          lastActivityAt: Date.now(), finalReportPreview,
        });
      }
      completeWatcher(rec.userId, rec.watcherId, { status, finalText });
      for (const k of [taskId, rec.rootTaskId, rec.watcherId]) {
        const g = k && rootTaskGraphs.get(k);
        if (g && !g.children.size) rootTaskGraphs.delete(k);
      }
    }
  }
  return true;
}

/**
 * Register a sync delegation. Returns a small handle the delegate skill uses
 * to keep the record honest while it streams, or null on bad input.
 */
export function registerSyncDelegation({ taskId, userId, agentId, agentName, agentEmoji = '🤖', summary = '', watcherId = null, visibleAgentId = null, abort = null, rootTaskId = null, parentTaskId = null, parentWatcherId = null, rootWatcherId = null }) {
  if (!taskId || !userId) return null;
  const rTask = rootTaskId || taskId;
  const scheduledCtx = getScheduledContext();
  const silentScheduled = scheduledCtx?.originTaskId && scheduledCtx?.silent === true;
  activeTasks.set(taskId, {
    agentId, userId, agentName, agentEmoji,
    startedAt: Date.now(), summary: String(summary || '').slice(0, 120),
    phase: 'running', status: 'running',
    watcherId: watcherId || null,
    visibleAgentId: visibleAgentId || null,
    rootTaskId: rTask,
    parentTaskId: parentTaskId || null,
    parentWatcherId: parentWatcherId || null,
    rootWatcherId: rootWatcherId || watcherId || null,
    spanId: `${rTask}:${_slug(agentName)}:${taskId}`,
    aliases: [taskId, agentId, watcherId].filter(Boolean),
    isDelegation: true,
    isSync: true,
    originScheduledTaskId: scheduledCtx?.originTaskId || null,
    originScheduledTaskOwnerId: scheduledCtx?.originTaskOwnerId || null,
    originScheduledTaskAgent: scheduledCtx?.originTaskAgent || null,
    originScheduledRunId: scheduledCtx?.runId || null,
    originScheduledManual: scheduledCtx?.manual === true,
    originScheduledSilent: silentScheduled === true,
    abort: typeof abort === 'function' ? abort : null,
  });
  const rec = activeTasks.get(taskId);
  if (rec.rootTaskId !== taskId) _attachRootChild(taskId, rec);
  _journalAdd(taskId);
  return {
    taskId,
    noteToolCall(name) {
      const r = activeTasks.get(taskId);
      if (!r || !name) return;
      r.toolsUsed = (r.toolsUsed || 0) + 1;
      r.currentTool = name;
      r.lastUpdateAt = Date.now();
      pushWorkerProgress(taskId, { kind: 'tool', tool: name });
      _updateRootChildProgress({ ...r, taskId });
    },
    noteToolResult(name, preview) {
      const r = activeTasks.get(taskId);
      if (!r || !name) return;
      r.currentTool = null;
      r.lastResultPreview = String(preview || '').slice(0, 160);
      r.lastUpdateAt = Date.now();
      pushWorkerProgress(taskId, { kind: 'result', tool: name, text: String(preview || '').slice(0, 160) });
    },
    // Pipeline stage transition — updates what check_workers + the chip header
    // call this delegation (for example, "agent" -> "agent -> specialist").
    setStageName(name) {
      const r = activeTasks.get(taskId);
      if (r && name) r.agentName = name;
    },
    isCancelling() {
      const r = activeTasks.get(taskId);
      return !!r && r.status === 'cancelling';
    },
    complete(o) { return completeSyncDelegation(taskId, o); },
  };
}

/**
 * Run an ephemeral agent synchronously (awaitable) and return its final text.
 * Differs from dispatchBackground in that:
 *   - Returns a Promise resolving to the result string (not a taskId)
 *   - Does NOT inject a completion notice into any coordinator session
 *   - Does NOT append to the worker's session (ephemeral agents are stateless)
 * Used by deep_research_parallel to fan out research sub-queries.
 *
 * @param {object} agent - ephemeral agent object (must have ephemeral:true, id prefixed "ephemeral_")
 * @param {string} task - prompt for this worker
 * @param {string} userId
 * @param {object} [opts]
 * @param {(tokenText:string)=>void} [opts.onProgress] - per-token callback (for UI streaming)
 * @param {string} [opts.agentEmoji] - icon (default 🔎)
 * @param {AbortSignal} [opts.signal] - owner cancellation propagated into the ephemeral turn
 * @returns {Promise<string>} final concatenated text
 */
export async function dispatchEphemeral(agent, task, userId, opts = {}) {
  const taskId = `eph_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const agentName = agent.name ?? 'Worker';
  const agentEmoji = opts.agentEmoji ?? '🔎';
  const parentTaskCtx = currentTaskContext();
  const taskCtx = {
    taskId,
    watcherId: parentTaskCtx?.watcherId || null,
    userId,
    agentId: agent.id,
    rootTaskId: parentTaskCtx?.rootTaskId || parentTaskCtx?.taskId || taskId,
    parentTaskId: parentTaskCtx?.taskId || null,
    parentWatcherId: parentTaskCtx?.watcherId || null,
    rootWatcherId: parentTaskCtx?.rootWatcherId || parentTaskCtx?.watcherId || null,
    visibleAgentId: parentTaskCtx?.visibleAgentId || parentTaskCtx?.agentId || null,
    spanId: `${parentTaskCtx?.rootTaskId || parentTaskCtx?.taskId || taskId}:ephemeral:${taskId}`,
  };
  const signal = opts.signal || getTurnContext()?.signal || null;
  activeTasks.set(taskId, {
    agentId: agent.id, userId, agentName, startedAt: Date.now(),
    rootTaskId: taskCtx.rootTaskId,
    parentTaskId: taskCtx.parentTaskId,
  });

  try {
    const { streamChat } = await import('./chat.mjs');
    let out = '';
    await runInTaskContext(taskCtx, async () => {
      for await (const ev of iterateUntilAbort(streamChat(agent, task, signal, null, userId, null, null, false, null, {
        rootTaskId: taskCtx.rootTaskId,
        traceSource: 'background',
      }), signal, 'Ephemeral background task cancelled')) {
        if (ev.type === 'token') {
          out += ev.text;
          opts.onProgress?.(ev.text);
        } else if (ev.type === 'replace') out = String(ev.text || '');
        else if (ev.type === '__content') out = String(ev.content || '');
        if (ev.type === 'error') throw new Error(ev.message);
      }
      if (signal?.aborted) throw new Error('cancelled');
    });
    activeTasks.delete(taskId);
    return out.trim();
  } catch (err) {
    activeTasks.delete(taskId);
    if (signal?.aborted) throw new Error('cancelled');
    throw err;
  }
}

// Workers: background-tasks/workers.mjs (spawn/list/stop + query helpers).

bindDispatchDeps({
  _attachRootChild,
  _completeRootChild,
  _voiceOrigin,
  backgroundRunTraceOptions,
  clearTaskRoot,
  deferRootCompletion,
  extractProducedBodyDocIds,
  handoffExpectsProducedDoc,
  hasActiveTaskChildren,
  impliesEmailDelivery,
  mergeReportImages,
  persistedReportImage,
  pushTaskProgress,
  registerTaskRoot,
  reportImageFromEvent,
  reportImagesFromText,
  resolveBackgroundRootTaskId,
  sendScheduledFailureEmail,
  taskLabel,
  taskState,
  trackToolEvent,
  cancelTask,
});
bindWorkerDeps({
  _onComplete,
  cancelTask,
  pushTaskProgress,
  resolveBackgroundRootTaskId,
  taskLabel,
  taskState,
  trackToolEvent,
  reportImageFromEvent,
  backgroundRunTraceOptions,
  _rootChildSnapshot,
});
