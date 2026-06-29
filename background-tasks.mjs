/**
 * Background agent task dispatcher.
 * Fires ask_agent calls without blocking the coordinator's turn.
 * Live progress surfaces via the task_proxy watcher chip in chat; on
 * completion a notification is injected into the coordinator's session
 * and an agent_report card is broadcast to the UI.
 */

import { registerWatcher, pushWatcherStatus, completeWatcher } from './scheduler/watchers.mjs';
import { runInTaskContext } from './lib/task-proxy-context.mjs';
import { getScheduledContext } from './lib/scheduled-context.mjs';
import { learnToolPlanFromToolEvents, matchToolPlan } from './lib/tool-plan-memory.mjs';
import { registerScheduledChild, completeScheduledChild } from './lib/scheduled-child-barrier.mjs';

let _broadcast = null;
export function setBackgroundBroadcastFn(fn) { _broadcast = fn; }

// in-flight task registry: taskId -> { agentId, userId, agentName, startedAt }
const activeTasks = new Map();

// Root task graph for nested delegation. Existing ids remain intact:
// - watcher UUIDs are still the user-visible chip ids
// - bg_/deleg_/ephemeral ids remain internal runtime ids
// This graph links them so status lookups can resolve "root -> Gina/Rose/etc"
// and a root chip does not finish while child delegations are still running.
const rootTaskGraphs = new Map(); // rootTaskId -> { userId, rootWatcherId, visibleAgentId, children, pendingCompletion }

function _slug(s) {
  return String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

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
    if (root.children.size === 0 && root.pendingCompletion) rootTaskGraphs.delete(rec.rootTaskId);
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

function trackToolEvent(events, ev) {
  if (!Array.isArray(events) || !ev?.name) return;
  if (ev.type === 'tool_call') {
    events.push({
      name: ev.name,
      args: ev.args || null,
      startedAt: Date.now(),
      status: 'running',
      agentId: ev.agentId || null,
    });
    return;
  }
  const rec = [...events].reverse().find(e => e.name === ev.name && e.status !== 'done');
  if (ev.type === 'tool_progress' && rec) {
    rec.progressPreview = String(ev.text || '').slice(-1000);
    return;
  }
  if (ev.type === 'tool_result') {
    const target = rec || { name: ev.name, args: null, startedAt: Date.now(), status: 'running' };
    if (!rec) events.push(target);
    target.endedAt = Date.now();
    target.durationMs = target.endedAt - target.startedAt;
    target.status = 'done';
    target.preview = ev.preview || String(ev.text || '').split('\n').find(l => l.trim()) || '';
    target.text = String(ev.text || '').slice(0, 10000);
  }
}

// Safety net: if a worker hangs forever (stuck upstream stream, etc.) the task
// would stay in activeTasks forever. Sweep every hour, reap anything older
// than 24h so /health + UI don't accumulate ghosts.
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [taskId, info] of activeTasks) {
    if (info.startedAt && (now - info.startedAt) > TASK_TTL_MS) {
      console.warn('[background-tasks] Reaping stale task:', taskId, 'agent:', info.agentName);
      activeTasks.delete(taskId);
    }
  }
}, 60 * 60 * 1000).unref();

/**
 * Fire a background agent task. Returns a taskId immediately.
 * @param {object} scopedAgent - agent object with scoped id
 * @param {string} task - enriched task text
 * @param {string} userId
 * @param {string} coordinatorAgentId - scoped id of the coordinator
 * @param {string} agentName - display name for notifications
 * @param {string} agentEmoji - emoji icon (e.g. "📧")
 * @param {{autoContinue?: boolean, extraSystemNote?: string | null, routeText?: string | null}} [opts]
 */
export function dispatchBackground(scopedAgent, task, userId, coordinatorAgentId, agentName, agentEmoji = '🤖', opts = {}) {
  const taskId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const summary = (task || '').slice(0, 120);
  const ac = new AbortController();
  const scheduledCtx = getScheduledContext();
  const rootTaskId = opts?.rootTaskId || taskId;
  const parentTaskId = opts?.parentTaskId || null;
  const parentWatcherId = opts?.parentWatcherId || null;
  const visibleAgentId = opts?.visibleAgentId || coordinatorAgentId;
  const rootWatcherId = opts?.rootWatcherId || (rootTaskId === taskId ? null : parentWatcherId);
  const spanId = opts?.spanId || `${rootTaskId}:${_slug(agentName)}:${taskId}`;
  activeTasks.set(taskId, {
    agentId: scopedAgent.id, userId, agentName, agentEmoji,
    startedAt: Date.now(), summary, phase: 'queued', status: 'running',
    originalTask: task,
    coordinatorAgentId,
    visibleAgentId,
    rootTaskId,
    parentTaskId,
    parentWatcherId,
    rootWatcherId,
    spanId,
    aliases: [taskId, scopedAgent.id].filter(Boolean),
    // Mark this as a coordinator→specialist DELEGATION (distinct from a worker
    // and from a research ephemeral). This is what lets check_workers surface it
    // as user-level background work — so "is Gina still working?" resolves no
    // matter which agent the user happens to ask. See listActiveDelegationsForUser.
    isDelegation: true,
    abort: () => ac.abort(),
    autoContinue: opts?.autoContinue === true,
    originScheduledTaskId: opts?.originScheduledTaskId || scheduledCtx?.originTaskId || null,
    originScheduledTaskOwnerId: opts?.originScheduledTaskOwnerId || scheduledCtx?.originTaskOwnerId || userId || null,
    originScheduledTaskAgent: opts?.originScheduledTaskAgent || scheduledCtx?.originTaskAgent || null,
    originScheduledNote: scheduledCtx?.scheduledNote || null,
  });
  if (scheduledCtx?.originTaskId) {
    registerScheduledChild({
      userId,
      scheduledCtx,
      childId: taskId,
      label: `${agentName || 'Agent'}: ${summary}`,
      kind: 'delegate',
    });
  }

  // Phase 14: register a task_proxy watcher so the task surfaces as a chat
  // chip + becomes inspectable via list_watches. The watcher's history
  // accumulates progress events; on completion completeWatcher transitions
  // it to done/error. The activeTasks record gets the watcherId so progress
  // callbacks can update the same watcher.
  let watcherId = null;
  try {
    watcherId = registerWatcher({
      userId,
      agentId: visibleAgentId,       // chip lives in the user's visible chat
      kind: 'task_proxy',
      label: taskLabel(agentEmoji, agentName, summary),
      state: taskState(taskId, { phase: 'queued' }),
      cadenceSec: 30,
      expiresAt: null,   // indefinite — task runs as long as it takes
      // No skillId: system-handler (registered via _systemHandlers in watchers.mjs)
    });
    const rec = activeTasks.get(taskId);
    if (rec) {
      rec.watcherId = watcherId;
      rec.rootWatcherId = rec.rootWatcherId || watcherId;
      rec.aliases = [...new Set([...(rec.aliases || []), watcherId, rec.rootWatcherId, rec.parentWatcherId].filter(Boolean))];
      if (rec.rootTaskId === taskId) {
        registerTaskRoot({ userId, rootTaskId: rec.rootTaskId, rootWatcherId: watcherId, visibleAgentId, summary });
      } else {
        _attachRootChild(taskId, rec);
      }
    }
    pushTaskProgress(taskId, `Delegated to ${agentName}: ${summary}`, { phase: 'queued' });
  } catch (e) {
    console.warn('[background-tasks] task_proxy watcher registration failed:', e.message);
  }

  // Fire and forget — do not await
  (async () => {
    // Honor accessSchedule: a user whose curfew started mid-conversation cannot
    // launch new delegations. The coordinator will see the decline in its session.
    const { isUserTimeBlocked } = await import('./routes/_helpers.mjs');
    if (isUserTimeBlocked(userId)) {
      await _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, null,
        'Access is restricted at this time — delegation refused.');
      return;
    }
    try {
      const { streamChat } = await import('./chat.mjs');
      const { getScheduledNote } = await import('./lib/scheduled-context.mjs');
      // ALS propagates through this detached IIFE because dispatchBackground
      // was called from within scheduledContext.run(...). null in non-scheduled chats.
      const scheduledNote = getScheduledNote();
      const combinedNote = [scheduledNote, opts?.extraSystemNote].filter(Boolean).join('\n\n') || null;
      let fullText = '';
      let toolsUsed = 0;
      let currentTool = null;
      const toolEvents = [];
      const routeText = (typeof opts?.routeText === 'string' && opts.routeText.trim()) ? opts.routeText.trim() : task;
      const rememberedPlan = matchToolPlan(userId, { agentId: scopedAgent.id, phrase: routeText });
      pushTaskProgress(taskId, `${agentName} started working`, { phase: 'running' });
      // Phase-14b: wrap the streamChat loop in a task_proxy context so
      // ask_user_via_task (called inside the agent's tool chain) can find
      // this run's watcherId without any extra parameter threading.
      const rec = activeTasks.get(taskId);
      const taskCtx = {
        taskId,
        watcherId,
        userId,
        agentId: scopedAgent.id,
        rootTaskId: rec?.rootTaskId || taskId,
        parentTaskId: rec?.parentTaskId || null,
        parentWatcherId: rec?.parentWatcherId || null,
        rootWatcherId: rec?.rootWatcherId || watcherId,
        visibleAgentId: rec?.visibleAgentId || visibleAgentId,
        spanId: rec?.spanId || taskId,
      };
      await runInTaskContext(taskCtx, async () => {
      for await (const ev of streamChat(scopedAgent, task, ac.signal, null, userId, null, combinedNote, false, null, { toolPlan: rememberedPlan, routeText, isolatedTaskRun: true, rootTaskId: taskCtx.rootTaskId, traceSource: scheduledNote ? 'scheduled' : 'background' })) {
        if (ev.type === 'token') fullText += ev.text;
        trackToolEvent(toolEvents, ev);
        // Track in-flight tool calls so list_active_agents can report e.g.
        // "the coder is currently running coder_edit_file" instead of just
        // an opaque spinner.
        if (ev.type === 'tool_call' && ev.name) {
          toolsUsed++;
          currentTool = ev.name;
          const rec = activeTasks.get(taskId);
          if (rec) {
            rec.toolsUsed = toolsUsed;
            rec.currentTool = ev.name;
            rec.lastUpdateAt = Date.now();
          }
          // Rolling progress log so check_workers can replay what this delegation
          // has actually done (same surface workers use).
          pushWorkerProgress(taskId, { kind: 'tool', tool: ev.name });
          // Push to the watcher chip — the chip is the user-visible surface.
          // History accumulates each tool call so list_watches/get_task_log
          // can replay what happened.
          if (rec?.watcherId) {
            pushTaskProgress(taskId, `${agentName} is using ${ev.name}`, { currentTool: ev.name, toolsUsed, phase: 'tool' });
          }
        }
        if (ev.type === 'tool_progress' && ev.text) {
          pushTaskProgress(taskId, String(ev.text).slice(-1200), {
            currentTool,
            toolsUsed,
            phase: 'streaming',
          });
        }
        if (ev.type === 'tool_result' && ev.name) {
          const rec = activeTasks.get(taskId);
          const preview = String(ev.text || '').split('\n').find(l => l.trim()) || '';
          currentTool = null;
          if (rec) {
            rec.currentTool = null;
            rec.lastResultPreview = preview.slice(0, 160);
            rec.lastUpdateAt = Date.now();
          }
          // First non-empty result line usually carries the domain number
          // ("Event created…", "56 events added") — keep it for status reports.
          pushWorkerProgress(taskId, { kind: 'result', tool: ev.name, text: preview.slice(0, 160) });
          if (preview) {
            pushTaskProgress(taskId, `${ev.name}: ${preview.slice(0, 240)}`, { currentTool: null, phase: 'result' });
          }
        }
        if (ev.type === 'error') throw new Error(ev.message);
      }
      });   // end runInTaskContext
      await _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, fullText.trim() || `${agentName} completed the task.`, null, null, toolEvents, scopedAgent.id, task);
    } catch (err) {
      console.error('[background-tasks] error in task', taskId, err.message);
      await _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, null,
        ac.signal.aborted ? 'Task cancelled by user.' : err.message,
        ac.signal.aborted ? 'cancelled' : 'error');
    }
  })();

  return taskId;
}

function _coordinatorAgentIdFromSessionKey(sessionKey, userId) {
  const raw = String(sessionKey || '');
  const prefix = `${userId}_`;
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

async function _runContinuation({ taskId, userId, coordinatorAgentId, targetAgentId, agentName, result, errorMsg, originalTask, scheduledCtx = null }) {
  if (errorMsg || !result) return;
  const agentId = _coordinatorAgentIdFromSessionKey(coordinatorAgentId, userId);
  if (!agentId) return;
  const prompt = [
    'A background delegation you started has completed. Continue the original user workflow for THIS completed task only. The task id and original_task below are authoritative; do not infer from the latest visible chat message.',
    '',
    `<background_task id="${taskId}" agent="${agentName}" target_agent_id="${targetAgentId || ''}">`,
    `<original_task>${originalTask || ''}</original_task>`,
    `<result>${result}</result>`,
    '</background_task>',
    '',
    'If the original user request required a next step using this result, do it now. For example, if the task returned a briefing so it could be emailed, delegate to the email agent with this exact briefing. If there is no remaining action, give the user a concise completion update. Do not act on any other background task.',
  ].join('\n');
  const { handleChatMessage } = await import('./chat-dispatch.mjs');
  const { sendToUser } = await import('./ws-handler.mjs');
  const run = () => handleChatMessage({
    userId,
    agentId,
    text: prompt,
    attachment: null,
    source: 'web',
    onEvent: (e) => sendToUser(userId, e),
    onBroadcast: () => {},
    onNotify: () => {},
    _hiddenUser: true,
    _isBackgroundContinuation: true,
    _isolatedTaskRun: !!scheduledCtx?.originTaskId,
  });
  if (scheduledCtx?.originTaskId) {
    const { scheduledContext } = await import('./lib/scheduled-context.mjs');
    await scheduledContext.run(scheduledCtx, run);
  } else {
    await run();
  }
}

async function _onComplete(taskId, userId, coordinatorAgentId, agentName, agentEmoji, result, errorMsg = null, finalStatus = null, toolEvents = [], targetAgentId = null, originalTask = '') {
  const rec = activeTasks.get(taskId);
  const status = finalStatus || (errorMsg ? 'error' : 'done');
  const finalReportPreview = String(errorMsg ?? result ?? '').slice(0, 800);
  if (rec) {
    rec.status = status;
    rec.phase = status;
    rec.currentTool = null;
  }
  // When this root delegation finishes but still has child delegations in
  // flight, deliver its result NOW (report + broadcast + continuation, below)
  // and keep only the CHIP alive in a "waiting on children" state — it
  // finalizes from _completeRootChild once the last child drains. This used to
  // early-return here, which silently dropped the root's agent_report AND its
  // autoContinue wake, stranding the coordinator. Only the visual chip waits;
  // the result and the coordinator's reaction must not.
  const deferChip = rec?.rootTaskId === taskId && hasActiveTaskChildren(taskId) && !rec?.originScheduledTaskId;
  if (deferChip) {
    deferRootCompletion({
      userId,
      rootTaskId: taskId,
      rootWatcherId: rec.rootWatcherId || rec.watcherId || null,
      status,
      finalText: status === 'done' ? `✓ ${agentName} done` : finalReportPreview,
      finalReportPreview,
    });
  }
  // Retire a finished delegation into the recent ring so check_workers can still
  // show its terminal outcome briefly. (Workers are retired separately via
  // _retire from spawnWorker; this is the delegation analogue.)
  if (rec?.isDelegation) {
    recentDelegations.unshift({
      taskId, userId: rec.userId, agentId: rec.agentId,
      rootTaskId: rec.rootTaskId || taskId,
      parentTaskId: rec.parentTaskId || null,
      spanId: rec.spanId || null,
      watcherId: rec.watcherId || null,
      rootWatcherId: rec.rootWatcherId || null,
      visibleAgentId: rec.visibleAgentId || null,
      name: rec.agentName, summary: rec.summary,
      outcome: status === 'done' ? 'done' : (status === 'cancelled' ? 'stopped' : 'error'),
      finalText: finalReportPreview.slice(0, 240),
      toolsUsed: rec.toolsUsed || 0,
      startedAt: rec.startedAt, endedAt: Date.now(),
    });
    if (recentDelegations.length > RECENT_CAP) recentDelegations.length = RECENT_CAP;
  }
  _completeRootChild(taskId, rec, status, finalReportPreview);
  activeTasks.delete(taskId);
  // When deferring the chip, keep the root graph (it holds pendingCompletion +
  // the child set) so the last child can finalize the chip via _completeRootChild.
  if (rec?.rootTaskId === taskId && !deferChip) clearTaskRoot(taskId);

  // Phase 14: finalize the task_proxy watcher (chip) so it shows done/error
  // and slides into the "recent" pile. Lives independently of the activity-
  // panel broadcast below — the chip is the user's primary visible surface.
  // Skip when deferChip: the chip stays in "waiting on children" (set by
  // deferRootCompletion above) and finalizes from _completeRootChild instead.
  if (rec?.watcherId && !deferChip) {
    try {
      const finalText = status === 'cancelled'
        ? `■ ${agentName} cancelled`
        : errorMsg
          ? `⚠ ${agentName} failed: ${errorMsg}`
          : `✓ ${agentName} done`;
      pushWatcherStatus(userId, rec.watcherId, finalText, {
        taskId,
        status,
        phase: status,
        canCancel: false,
        cancelling: false,
        currentTool: null,
        lastActivityAt: Date.now(),
        finalReportPreview,
      });
      completeWatcher(userId, rec.watcherId, {
        status,
        finalText,
      });
    } catch (e) {
      console.warn('[background-tasks] watcher complete failed:', e.message);
    }
  }

  const content = errorMsg ?? result;

  // For a scheduled run, just record this delegation's completion in the
  // barrier. The barrier (scheduler.runTask) reacts to the aggregated results
  // and stamps/removes the scheduled task exactly once when everything drains —
  // this path must NOT stamp it itself (that was the double-finalize / one-shot-
  // removed-out-from-under-pending-work bug).
  if (rec?.originScheduledTaskId) {
    completeScheduledChild({
      userId,
      scheduledCtx: {
        originTaskId: rec.originScheduledTaskId,
        originTaskOwnerId: rec.originScheduledTaskOwnerId,
        originTaskAgent: rec.originScheduledTaskAgent,
      },
      childId: taskId,
      resultText: result || `${agentName} completed the task.`,
      errorMsg,
    });
  }

  if (!errorMsg && Array.isArray(toolEvents) && toolEvents.length) {
    try {
      const learned = learnToolPlanFromToolEvents(userId, {
        agentId: targetAgentId || rec?.agentId,
        phrase: originalTask || rec?.originalTask || rec?.summary || '',
        toolEvents,
        // The completion text. A non-exception failure ("I hit a tooling
        // limitation…", "handed it to…") reads as success to !errorMsg, so scan
        // the result so those runs aren't memorized as recipes.
        resultText: result || '',
        source: rec?.isWorker ? 'auto-worker-complete' : 'auto-background-complete',
      }).filter(r => r?.learned);
      if (learned.length) {
        console.log('[tool-plan] learned from background completion:', learned.map(r => `${r.recipe?.id}:${(r.recipe?.selectedTools || []).join(',')}`).join(' | '));
      }
    } catch (e) {
      console.warn('[tool-plan] background learning failed:', e.message);
    }
  }

  // 1. Inject into coordinator's session so it has context on next user message.
  //    Include the original task summary so the user (and the LLM on its next
  //    turn) can see WHICH task the specialist is replying to — important when
  //    multiple background tasks are in flight at once.
  try {
    const { appendToSession } = await import('./sessions.mjs');
    const reportAgentId = rec?.visibleAgentId || coordinatorAgentId;
    const taskSummary = rec?.summary || '';
    const taskRef = taskSummary
      ? ` — re: "${taskSummary.length > 80 ? taskSummary.slice(0, 80) + '…' : taskSummary}"`
      : '';
    const notice = errorMsg
      ? `[${agentName} ran into a problem${taskRef}]\n${errorMsg}`
      : `[${agentName} replied${taskRef}]\n${result}`;
    // Keep role:'assistant' so the LLM reads this as part of the
    // conversation on its next turn (it needs to know what the specialist
    // reported back). Add kind:'agent_report' so the browser knows to
    // render it with the fancier sender-tagged bubble on reload — same
    // visual as the live broadcast that fires immediately on completion.
    await appendToSession(reportAgentId, {
      role: 'assistant',
      kind: 'agent_report',
      agentName, agentEmoji,
      content: notice,
      toolEvents,
      targetAgentId: targetAgentId || rec?.agentId || null,
      originalTask: originalTask || rec?.summary || '',
      taskId,
      rootTaskId: rec?.rootTaskId || taskId,
      parentTaskId: rec?.parentTaskId || null,
      spanId: rec?.spanId || null,
      ts: Date.now(),
    });
  } catch (e) {
    console.error('[background-tasks] failed to inject session notice:', e.message);
  }

  // 2. Agent report card: render directly in the user's visible chat as a notification from the agent.
  //    reportAgentId is the chat the report belongs to — the browser
  //    uses it to push the report into sessions[coordinatorAgentId] so the
  //    bubble survives agent-tab switches (without it, the report only
  //    exists in the DOM until the next renderSession wipes it).
  const reportAgentId = rec?.visibleAgentId || coordinatorAgentId;
  _broadcast?.({
    type:       'agent_report',
    agent:      reportAgentId,
    agentName,
    agentEmoji,
    content,
    toolEvents,
    targetAgentId: targetAgentId || rec?.agentId || null,
    originalTask: originalTask || rec?.summary || '',
    taskId,
    rootTaskId: rec?.rootTaskId || taskId,
    parentTaskId: rec?.parentTaskId || null,
    spanId: rec?.spanId || null,
    ts: Date.now(),
  });

  // Direct (non-scheduled) delegations get the coordinator's inline react step.
  // Scheduled runs react+finalize via the barrier (scheduler.runScheduledReaction),
  // so they skip this — otherwise the task would get a duplicate reaction turn.
  if (rec?.autoContinue && !rec?.originScheduledTaskId) {
    _runContinuation({
      taskId,
      userId,
      coordinatorAgentId,
      targetAgentId: targetAgentId || rec?.agentId || null,
      agentName,
      result,
      errorMsg,
      originalTask: rec?.originalTask || originalTask || rec?.summary || '',
    }).catch(e => console.error('[background-tasks] continuation failed:', e?.stack ?? e?.message ?? e));
  }
}

export function cancelTask(userId, id, reason = 'cancelled') {
  for (const [taskId, info] of activeTasks) {
    if (info.userId !== userId) continue;
    if (taskId !== id && info.watcherId !== id) continue;
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
    return { ok: true, taskId, watcherId: info.watcherId };
  }
  return { ok: false, reason: 'not found' };
}

export function getActiveTasks() {
  return [...activeTasks.entries()].map(([taskId, info]) => ({ taskId, ...info }));
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
 * @returns {Promise<string>} final concatenated text
 */
export async function dispatchEphemeral(agent, task, userId, opts = {}) {
  const taskId = `eph_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const agentName = agent.name ?? 'Worker';
  const agentEmoji = opts.agentEmoji ?? '🔎';
  activeTasks.set(taskId, { agentId: agent.id, userId, agentName, startedAt: Date.now() });

  try {
    const { streamChat } = await import('./chat.mjs');
    let out = '';
    for await (const ev of streamChat(agent, task, null, null, userId, null, null, false, null, { rootTaskId: taskId, traceSource: 'background' })) {
      if (ev.type === 'token') {
        out += ev.text;
        opts.onProgress?.(ev.text);
      }
      if (ev.type === 'error') throw new Error(ev.message);
    }
    activeTasks.delete(taskId);
    return out.trim();
  } catch (err) {
    activeTasks.delete(taskId);
    throw err;
  }
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

// Recently-finished workers (ring buffer) so check_workers can report a TERMINAL
// outcome ("failed at 04:04") instead of silently showing nothing — the #1 cause
// of an agent telling the user "still running" when the worker actually died.
const recentWorkers = [];
const RECENT_CAP = 12;

// Same idea for coordinator→specialist DELEGATIONS (dispatchBackground). Lets
// check_workers report a terminal outcome ("Gina finished — 56 events added")
// for a moment after the task ends, instead of the task simply vanishing the
// instant it completes and leaving the next "is it done?" with nothing to show.
const recentDelegations = [];

function _retire(taskId, outcome, finalText) {
  const info = activeTasks.get(taskId);
  if (!info || !info.isWorker) return;
  recentWorkers.unshift({
    taskId, ownerKey: info.ownerKey, userId: info.userId,
    name: info.agentName, summary: info.summary,
    outcome,                                   // 'done' | 'error' | 'stopped'
    finalText: (finalText || '').slice(0, 240),
    toolsUsed: info.toolsUsed || 0,
    startedAt: info.startedAt, endedAt: Date.now(),
  });
  if (recentWorkers.length > RECENT_CAP) recentWorkers.length = RECENT_CAP;
}

// Append an entry to a worker's rolling progress log (cap 20). Tool results carry
// the real domain numbers (email tools return "Labeled 200…", "619 match…"), so
// this is what lets a manager report actual progress, not just "running a tool".
function pushWorkerProgress(taskId, entry) {
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
 * @param {string} a.task         - self-contained job for the worker
 * @param {string} a.userId
 * @param {string} a.chipOwnerId  - scoped session id of the owner's chat (chip + report target)
 * @param {string} a.ownerKey     - stable agent id of the owner (for check_workers lookup)
 * @param {string} a.workerName
 * @param {string} a.emoji
 * @returns {string} taskId
 */
export function spawnWorker({ workerAgent, task, userId, chipOwnerId, ownerKey, workerName = 'Worker', emoji = '🤖' }) {
  const taskId = `wkr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const summary = (task || '').slice(0, 120);
  const ac = new AbortController();
  activeTasks.set(taskId, {
    agentId: workerAgent.id, userId, agentName: workerName, agentEmoji: emoji,
    startedAt: Date.now(), summary, ownerKey, isWorker: true, phase: 'queued',
    status: 'running', abort: () => ac.abort(),
  });

  let watcherId = null;
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

  (async () => {
    const { isUserTimeBlocked } = await import('./routes/_helpers.mjs');
    if (isUserTimeBlocked(userId)) {
      await _onComplete(taskId, userId, chipOwnerId, workerName, emoji, null, 'Access is restricted at this time — worker not started.');
      return;
    }
    try {
      const { streamChat } = await import('./chat.mjs');
      const { getScheduledNote } = await import('./lib/scheduled-context.mjs');
      const scheduledNote = getScheduledNote();
      let fullText = '';
      const toolEvents = [];
      const rememberedPlan = matchToolPlan(userId, { agentId: workerAgent.id, phrase: task });
      const taskCtx = { taskId, watcherId, userId, agentId: workerAgent.id };
      pushTaskProgress(taskId, `${workerName} started working`, { phase: 'running' });
      await runInTaskContext(taskCtx, async () => {
        for await (const ev of streamChat(workerAgent, task, ac.signal, null, userId, null, scheduledNote, false, null, { toolPlan: rememberedPlan, isolatedTaskRun: true, rootTaskId: taskId, traceSource: scheduledNote ? 'scheduled' : 'background' })) {
          if (ev.type === 'token') fullText += ev.text;
          trackToolEvent(toolEvents, ev);
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
          if (ev.type === 'error') throw new Error(ev.message);
        }
      });
      _retire(taskId, 'done', fullText.trim());
      await _onComplete(taskId, userId, chipOwnerId, workerName, emoji, fullText.trim() || `${workerName} finished the job.`, null, null, toolEvents, workerAgent.id, task);
    } catch (err) {
      const stopped = ac.signal.aborted;
      _retire(taskId, stopped ? 'stopped' : 'error', stopped ? 'Stopped by its manager.' : err.message);
      await _onComplete(taskId, userId, chipOwnerId, workerName, emoji, null,
        stopped ? 'Worker stopped by its manager.' : err.message,
        stopped ? 'cancelled' : 'error');
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

/** Recently-finished workers for an owner — so check_workers can report terminal outcomes. */
export function listRecentWorkersForOwner(userId, ownerKey) {
  const now = Date.now();
  return recentWorkers
    .filter(r => r.userId === userId && r.ownerKey === ownerKey)
    .map(r => ({ ...r, endedAgoSec: Math.round((now - r.endedAt) / 1000) }));
}

/**
 * Live status of coordinator→specialist DELEGATIONS in flight for a user.
 *
 * Unlike workers, delegations are NOT scoped to an ownerKey: a delegation is
 * user-level background work (the coordinator handed a job to a specialist on
 * the user's behalf), so ANY agent the user asks — the specialist they're
 * chatting with, the coordinator, anyone — should be able to surface it. This
 * is the fix for the "is Gina still working?" black hole: the job was always
 * live in activeTasks, but check_workers only ever looked at isWorker records.
 *
 * `excludeAgentId` drops the caller's own delegation session so a running
 * specialist doesn't list itself back as a separate task.
 */
export function listActiveDelegationsForUser(userId, excludeAgentId = null) {
  const now = Date.now();
  return [...activeTasks.entries()]
    .filter(([, info]) => info.isDelegation && info.userId === userId && info.agentId !== excludeAgentId)
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
  return recentDelegations
    .filter(r => r.userId === userId && r.agentId !== excludeAgentId)
    .map(r => ({ ...r, endedAgoSec: Math.round((now - r.endedAt) / 1000) }));
}

/** Stop a worker by id. ownerKey (if given) must match — you can only stop your own. */
export function stopWorker(userId, taskId, ownerKey = null) {
  const info = activeTasks.get(taskId);
  if (!info || !info.isWorker || info.userId !== userId) return { ok: false, reason: 'not found' };
  if (ownerKey && info.ownerKey !== ownerKey) return { ok: false, reason: 'that worker belongs to a different agent' };
  const r = cancelTask(userId, taskId, 'stopped_by_manager');
  return r.ok ? { ok: true, name: info.agentName } : { ok: false, reason: r.reason || 'not cancellable' };
}
