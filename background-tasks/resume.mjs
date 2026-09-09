import { activeTasks } from './state.mjs';
import { changeCheckpoint, checkpointNote, checkpointToolEvents, getJobCheckpoint } from './checkpoints.mjs';
import { getProcessIdentity, processIdentityIsProvenDead } from '../lib/file-lock.mjs';
import { projectContext, projectIdFromSession } from '../lib/project-context.mjs';
import { runInTaskContext } from '../lib/task-proxy-context.mjs';
import { runWithTurnContext } from '../lib/turn-abort-context.mjs';
import { toolRouterContext } from '../lib/tool-router-context.mjs';
import { iterateUntilAbort } from '../lib/abortable-async-iterator.mjs';

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function executionAgent(entry) {
  const { getAgentsForUser, getUser, isUserTimeBlocked } = await import('../routes/_helpers.mjs');
  if (!getUser(entry.userId)) throw httpError(403, 'The job owner no longer exists.');
  if (isUserTimeBlocked(entry.userId)) throw httpError(403, 'The job is waiting for your allowed access hours.');
  const { getSessionEpoch } = await import('../sessions.mjs');
  if (entry.sourceSessionEpoch && getSessionEpoch(entry.sourceSessionKey) !== entry.sourceSessionEpoch) {
    throw httpError(410, 'The original chat was cleared. This job cannot resume.');
  }
  const projectId = projectIdFromSession(entry.sourceSessionKey);
  if (projectId) {
    const { getProjectSpace } = await import('../lib/project-spaces.mjs');
    getProjectSpace(entry.userId, projectId);
  }
  const saved = entry.checkpoint.execution;
  const current = getAgentsForUser(entry.userId).find(a => a.id === saved.agentId);
  if (!current) throw httpError(403, 'This agent is no longer available to you.');
  const available = new Set((current.tools || []).map(t => t.function?.name));
  if (saved.toolNames.some(name => !available.has(name))) throw httpError(403, 'The tools assigned to this job have changed. Review the agent settings before resuming.');
  return {
    ...current, id: saved.sessionId, ephemeral: true,
    provider: entry.runtimeProvider || saved.provider, model: entry.runtimeModel || saved.model, reasoningEffort: saved.reasoningEffort,
    skillCategory: saved.skillCategory || current.skillCategory,
    _executionModelLocked: true,
    _executionTargetLocked: saved.executionTargetExplicit,
    tools: current.tools.filter(t => saved.toolNames.includes(t.function?.name)),
    ...(saved.workerMemoryAgentId ? { workerOwnerId: saved.workerMemoryAgentId } : {}),
  };
}

async function showPaused(taskId, entry, reason) {
  changeCheckpoint(taskId, entry.userId, cp => { cp.status = 'paused'; cp.reason = reason; });
  const rec = activeTasks.get(taskId);
  rec.status = 'paused'; rec.phase = 'paused'; rec.currentTool = null;
  const { pushWatcherStatus } = await import('../scheduler/watchers.mjs');
  pushWatcherStatus(entry.userId, entry.watcherId, `Job paused: ${reason}`, {
    taskId, phase: 'paused', status: 'paused', canCancel: true,
    recoveryAvailable: true, recoveryTaskId: taskId, activity: reason,
  });
}

function restoreRecord(taskId, entry) {
  const rec = {
    ...entry, taskId, checkpoint: entry.checkpoint,
    isWorker: entry.kind === 'worker', isDelegation: entry.kind === 'delegation',
    status: 'paused', phase: 'paused', currentTool: null,
    toolsUsed: entry.checkpoint.actions.filter(a => a.status === 'done').length,
    lastActivityAt: Date.now(),
    // Stop works even while no generator is running.
    abort: () => {
      import('./dispatch.mjs').then(({ _onComplete }) => _onComplete(taskId, entry.userId,
        entry.coordinatorAgentId || entry.visibleAgentId, entry.agentName, entry.agentEmoji,
        null, 'Job stopped by user.', 'cancelled')).catch(e => console.warn('[resume]', e.message));
    },
  };
  activeTasks.set(taskId, rec);
  return rec;
}

/** Returns true when this module owns recovery; legacy jobs keep their prior path. */
export async function recoverCheckpointedTask(taskId, entry) {
  const cp = entry.checkpoint;
  if (!cp || cp.version !== 1 || entry.completion || cp.disabledReason || cp.status === 'cancelled') return false;
  if (activeTasks.has(taskId) || !processIdentityIsProvenDead(cp.owner)) return true;
  // Claim under the journal lock, rechecking the owner to exclude another OE process.
  let claimed = false;
  changeCheckpoint(taskId, entry.userId, current => {
    if (!processIdentityIsProvenDead(current.owner)) return;
    current.owner = getProcessIdentity(); claimed = true;
  });
  if (!claimed) return true;
  restoreRecord(taskId, entry);
  try {
    if (cp.status === 'paused') { await showPaused(taskId, entry, cp.reason || 'Review this job before continuing.'); return true; }
    if (cp.actions.some(a => a.status === 'started' && a.mutation)) {
      await showPaused(taskId, entry, 'A tool was interrupted before its result was saved. Check its outcome before continuing.');
      return true;
    }
    if (cp.resumes >= 3) { await showPaused(taskId, entry, 'This job has restarted three times. Review it before continuing.'); return true; }
    await startResumedJob(taskId, entry.userId);
  } catch (error) { await showPaused(taskId, entry, error.message); }
  return true;
}

export async function resumeJob(userId, taskId, { revision, resolutions = [] } = {}) {
  const entry = getJobCheckpoint(userId, taskId);
  if (!entry) throw httpError(404, 'Job not found.');
  const cp = entry.checkpoint;
  if (cp.status !== 'paused' || activeTasks.get(taskId)?.status !== 'paused') throw httpError(409, 'This job is already running or finished.');
  if (cp.disabledReason) throw httpError(409, cp.disabledReason);
  await executionAgent(entry);
  changeCheckpoint(taskId, userId, current => {
    if (current.revision !== revision || current.status !== 'paused') throw httpError(409, 'The job changed. Open its recovery details again.');
    const pending = current.actions.filter(a => a.status === 'started' && a.mutation);
    if (!Array.isArray(resolutions) || resolutions.length !== pending.length) throw httpError(400, 'Review every interrupted action.');
    for (const action of pending) {
      const resolution = resolutions.find(r => r?.id === action.id);
      if (!resolution || !['completed', 'retry'].includes(resolution.outcome)) throw httpError(400, 'Choose completed or retry for every interrupted action.');
      if (resolution.outcome === 'completed') {
        if (typeof resolution.result !== 'string' || !resolution.result.trim() || resolution.result.length > 12000) throw httpError(400, 'Enter the observed result of the completed action (up to 12,000 characters).');
        action.status = 'done'; action.result = `User verified after restart: ${resolution.result.trim()}`; action.isError = false;
        current.sequence = (current.sequence || 0) + 1; action.resultSeq = current.sequence;
      } else action.status = 'retry_authorized';
      action.reviewedAt = Date.now();
    }
    current.status = 'ready';
  });
  try { await startResumedJob(taskId, userId); }
  catch (error) { await showPaused(taskId, entry, error.message); throw error; }
  return { ok: true, taskId };
}

async function startResumedJob(taskId, userId) {
  const entry = getJobCheckpoint(userId, taskId);
  const agent = await executionAgent(entry);
  const savedNote = checkpointNote(entry.checkpoint);
  const rec = activeTasks.get(taskId);
  if (!rec || rec.status !== 'paused') throw httpError(409, 'The job is no longer paused.');
  const cp = changeCheckpoint(taskId, userId, current => {
    if (current.status === 'cancelled') throw httpError(409, 'This job was stopped.');
    current.status = 'running'; current.reason = null; current.resumes++;
    for (const action of current.actions) if (action.status === 'started' && !action.mutation) action.status = 'retry_authorized';
    return structuredClone(current);
  });
  const ac = new AbortController();
  rec.status = 'running'; rec.phase = 'resuming'; rec.checkpoint = cp;
  rec.abort = reason => ac.abort(reason);
  const { pushWatcherStatus } = await import('../scheduler/watchers.mjs');
  pushWatcherStatus(userId, entry.watcherId, 'Resuming from saved progress', {
    taskId, phase: 'resuming', status: 'running', recoveryAvailable: false, canCancel: true,
    activity: 'Continuing after restart', resumeCount: cp.resumes,
  });
  const projectId = projectIdFromSession(entry.sourceSessionKey);
  // The job starts detached, with fresh cancellation and routing contexts.
  void projectContext.run({ userId, projectId }, () => runWithTurnContext({ signal: ac.signal },
    () => toolRouterContext.run(null, () => runInTaskContext({
      taskId, userId, agentId: agent.id, watcherId: entry.watcherId,
      rootTaskId: entry.rootTaskId || taskId, rootWatcherId: entry.rootWatcherId || entry.watcherId,
      visibleAgentId: entry.visibleAgentId, ownerKey: entry.ownerKey,
    }, async () => {
      const { _onComplete } = await import('./dispatch.mjs');
      let text = '';
      let toolEvents = [];
      const images = cp.actions.flatMap(a => a.events || []).filter(e => e.type === 'image');
      try {
        const { streamChat } = await import('../chat.mjs');
        const { backgroundRunTraceOptions } = await import('../background-tasks.mjs');
        const { getSessionEpoch } = await import('../sessions.mjs');
        const checkDestination = () => {
          if (entry.sourceSessionEpoch && getSessionEpoch(entry.sourceSessionKey) !== entry.sourceSessionEpoch) {
            ac.abort('Original chat was cleared.');
            throw new Error('The original chat was cleared.');
          }
        };
        checkDestination();
        for await (const ev of iterateUntilAbort(streamChat(agent, cp.execution.task, ac.signal, null, userId, null,
          `${cp.execution.note || ''}${savedNote}`, false, null, {
            isolatedTaskRun: true, routeText: entry.originalTask,
            workerMemoryAgentId: cp.execution.workerMemoryAgentId,
            ...backgroundRunTraceOptions(rec),
          }), ac.signal, 'Resumed job stopped')) {
          if (ev.type === 'token') text += ev.text;
          else if (ev.type === '__content') text = String(ev.content || '');
          else if (ev.type === 'replace') text = String(ev.text || '');
          if (ev.type === 'image' && ev.filename) images.push(ev);
          if (ev.type === 'tool_call' || ev.type === 'tool_result') {
            checkDestination();
            rec.currentTool = ev.type === 'tool_call' ? ev.name : null;
            rec.phase = ev.type === 'tool_call' ? 'tool' : 'result';
            rec.lastActivityAt = Date.now();
            pushWatcherStatus(userId, entry.watcherId, ev.type === 'tool_call' ? `Continuing: ${ev.name}` : `${ev.name} finished`, { phase: rec.phase, currentTool: rec.currentTool });
          }
          if (ev.type === 'error') throw new Error(ev.message);
        }
        if (ac.signal.aborted) throw new Error('Job stopped.');
        toolEvents = checkpointToolEvents(getJobCheckpoint(userId, taskId).checkpoint);
        if (cp.execution.completionContract) {
          const { evaluateCompoundWorkflowContract, formatCompoundContractFailure } = await import('../lib/compound-workflow-contract.mjs');
          const audit = evaluateCompoundWorkflowContract(cp.execution.completionContract, toolEvents);
          if (!audit.ok) throw new Error(formatCompoundContractFailure(audit));
        }
        await _onComplete(taskId, userId, entry.coordinatorAgentId || entry.visibleAgentId, entry.agentName, entry.agentEmoji,
          text.trim() || 'Job completed.', null, null, toolEvents, agent.id, entry.originalTask, { images });
      } catch (error) {
        await _onComplete(taskId, userId, entry.coordinatorAgentId || entry.visibleAgentId, entry.agentName, entry.agentEmoji,
          null, ac.signal.aborted ? 'Job stopped by user.' : error.message, ac.signal.aborted ? 'cancelled' : 'error', toolEvents, agent.id, entry.originalTask, { images });
      }
    })))).catch(e => console.error('[resume] job finalization failed:', e.message));
}
