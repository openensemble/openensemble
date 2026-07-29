import {
  taskCoordinationSnapshot,
  rootCoordinationSnapshot,
  coordinatedTasksSnapshot,
} from './work-coordination.mjs';

const TERMINAL_STATUSES = new Set([
  'done', 'complete', 'completed', 'error', 'failed', 'cancelled', 'canceled', 'stopped',
]);

function cleanString(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function finiteTimestamp(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeProgress(value) {
  if (typeof value === 'string') return cleanString(value, 160) || null;
  if (Number.isFinite(value)) return Math.max(0, Math.min(100, Number(value)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const progress = {};
  const text = cleanString(value.label || value.text, 160);
  const unit = cleanString(value.unit, 32);
  if (text) progress.label = text;
  if (unit) progress.unit = unit;
  for (const key of [
    'completed', 'current', 'done', 'total', 'maximum', 'max', 'percent', 'percentage',
  ]) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) progress[key] = number;
  }
  return Object.keys(progress).length ? progress : null;
}

function safeClaims(value) {
  return Array.isArray(value)
    ? value.slice(-8).map(claim => ({
        id: cleanString(claim?.id, 120),
        kind: cleanString(claim?.kind, 40) || 'work',
        label: cleanString(claim?.label, 160),
        mode: cleanString(claim?.mode, 24) || 'exclusive',
        status: cleanString(claim?.status, 24) || 'active',
      })).filter(claim => claim.id && claim.label)
    : [];
}

function taskProgressText(task, groupSize = 1) {
  const name = task.agentName || 'Background task';
  if (task.status === 'cancelling' || task.phase === 'cancelling') return `Stopping ${name}…`;
  if (task.phase === 'finalizing') return `${name} finished the work and is delivering the result…`;
  if (task.phase === 'queued') return `${name} is getting started…`;
  if (groupSize > 1) return `Working on it — ${groupSize} background tasks are still running.`;
  if (task.currentTool) return `${name} is working on it with ${task.currentTool}…`;
  if (task.phase === 'backgrounded') return `${name} is still working in the background…`;
  return `${name} is working on it…`;
}

function sanitizeTask(task) {
  if (!task || typeof task !== 'object') return null;
  const taskId = cleanString(task.taskId, 200);
  const watcherId = cleanString(task.watcherId, 200);
  const rootWatcherId = cleanString(task.rootWatcherId, 200) || watcherId;
  if (!taskId || !rootWatcherId) return null;

  const status = cleanString(task.status, 40) || 'running';
  const phase = cleanString(task.phase, 40) || status;
  const visibleAgentId = cleanString(
    task.visibleAgentId || task.coordinatorAgentId || task.agentId,
    240,
  );
  const startedAt = finiteTimestamp(task.startedAt);
  const lastActivityAt = finiteTimestamp(
    task.lastActivityAt || task.lastUpdateAt,
    startedAt,
  );
  const canCancel = typeof task.abort === 'function'
    && !TERMINAL_STATUSES.has(status)
    && status !== 'cancelling'
    && phase !== 'finalizing';
  const coordinated = taskCoordinationSnapshot(taskId);
  const claims = safeClaims(coordinated?.claims);

  return {
    taskId,
    watcherId,
    rootWatcherId,
    rootTaskId: cleanString(task.rootTaskId, 200) || taskId,
    parentTaskId: cleanString(task.parentTaskId, 200) || null,
    parentWatcherId: cleanString(task.parentWatcherId, 200) || null,
    visibleAgentId,
    agentId: cleanString(task.agentId, 240) || null,
    agentName: cleanString(task.agentName, 160) || 'Background task',
    agentEmoji: cleanString(task.agentEmoji, 16) || '⟳',
    summary: cleanString(task.summary, 600),
    status,
    phase,
    startedAt,
    lastActivityAt,
    currentTool: cleanString(task.currentTool, 160) || null,
    progress: safeProgress(task.progress),
    toolsUsed: Math.max(0, Number(task.toolsUsed) || 0),
    canCancel,
    isWorker: task.isWorker === true,
    requestedWorkstreams: Number.isSafeInteger(task.requestedWorkstreams)
      && task.requestedWorkstreams >= 2
      ? task.requestedWorkstreams
      : null,
    role: coordinated?.role || (task.isWorkstream ? 'worker' : null),
    claims,
    lastEvent: cleanString(coordinated?.lastEvent, 240),
    endedAt: finiteTimestamp(coordinated?.endedAt),
  };
}

function childSnapshot(task) {
  return {
    taskId: task.taskId,
    parentTaskId: task.parentTaskId || null,
    name: task.agentName,
    summary: task.summary,
    status: task.status,
    phase: task.phase || task.status,
    currentTool: task.currentTool,
    progress: task.progress || null,
    startedAt: task.startedAt,
    lastActivityAt: task.lastActivityAt,
    role: task.role || 'worker',
    claims: task.claims || [],
    lastEvent: task.lastEvent || '',
    endedAt: task.endedAt || null,
  };
}

function retainedChildSnapshot(task) {
  const taskId = cleanString(task?.taskId, 200);
  if (!taskId) return null;
  const status = cleanString(task?.status, 40) || 'running';
  return {
    taskId,
    parentTaskId: cleanString(task?.parentTaskId, 200) || null,
    name: cleanString(task?.name, 160) || 'Worker',
    summary: cleanString(task?.summary, 600),
    status,
    phase: cleanString(task?.phase, 40) || status,
    currentTool: null,
    progress: null,
    startedAt: finiteTimestamp(task?.startedAt),
    lastActivityAt: finiteTimestamp(task?.endedAt, finiteTimestamp(task?.startedAt)),
    role: cleanString(task?.role, 40) || 'worker',
    claims: safeClaims(task?.claims),
    lastEvent: TERMINAL_STATUSES.has(status) ? '' : cleanString(task?.lastEvent, 240),
    endedAt: finiteTimestamp(task?.endedAt),
  };
}

/**
 * Reduce internal background-task records to the small, user-facing shape sent
 * in an active_streams reconnect frame. Internal prompts, verifier leases,
 * callbacks, and task context must never cross this boundary.
 */
export function projectActiveTasksForWire(tasks = []) {
  const groups = new Map();
  for (const raw of Array.isArray(tasks) ? tasks : []) {
    // Defense in depth for silent scheduled children. They normally have no
    // watcher at all, but must also stay absent from reconnect snapshots if a
    // legacy/adopted watcher id is present on their runtime record.
    if (raw?.originScheduledSilent === true) continue;
    const task = sanitizeTask(raw);
    if (!task) continue;
    const key = `${task.visibleAgentId}\u0000${task.rootWatcherId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }

  const snapshots = [];
  for (const group of groups.values()) {
    const displayWatcherId = group[0].rootWatcherId;
    const primary = group.find(task => task.watcherId === displayWatcherId)
      || group.find(task => task.taskId === task.rootTaskId)
      || group[0];
    const activeChildren = group
      .filter(task => task.taskId !== primary.taskId)
      .map(childSnapshot);
    const coordinationRaw = rootCoordinationSnapshot(primary.rootTaskId || primary.taskId);
    const retainedChildren = coordinatedTasksSnapshot(primary.rootTaskId || primary.taskId)
      .map(retainedChildSnapshot)
      .filter(Boolean);
    // Retained coordination rows supply completed lanes after their execution
    // records are gone. Live records win for active lanes because they carry
    // richer phase, tool, and progress state.
    const childrenById = new Map();
    for (const child of retainedChildren) {
      if (child.taskId !== primary.taskId) childrenById.set(child.taskId, child);
    }
    for (const child of activeChildren) childrenById.set(child.taskId, child);
    const children = [...childrenById.values()].sort((left, right) => {
      const leftTerminal = TERMINAL_STATUSES.has(left.status);
      const rightTerminal = TERMINAL_STATUSES.has(right.status);
      if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
      return (left.startedAt || 0) - (right.startedAt || 0);
    });
    const coordination = coordinationRaw?.coordination ? {
      coordinatorTaskId: cleanString(coordinationRaw.coordination.coordinatorTaskId, 200),
      total: Math.max(0, Number(coordinationRaw.coordination.total) || 0),
      active: Math.max(0, Number(coordinationRaw.coordination.active) || 0),
      completed: Math.max(0, Number(coordinationRaw.coordination.completed) || 0),
      failed: Math.max(0, Number(coordinationRaw.coordination.failed) || 0),
    } : null;
    const coordinationEvents = Array.isArray(coordinationRaw?.coordinationEvents)
      ? coordinationRaw.coordinationEvents.slice(-12).map(event => ({
          id: cleanString(event?.id, 120),
          ts: finiteTimestamp(event?.ts),
          type: cleanString(event?.type, 32),
          actorTaskId: cleanString(event?.actorTaskId, 200) || null,
          targetTaskId: cleanString(event?.targetTaskId, 200) || null,
          label: cleanString(event?.label, 240),
          reason: cleanString(event?.reason, 240),
        })).filter(event => event.id && event.type)
      : [];
    // A synthesized root (only nested children remain) has no execution record
    // that cancelTask can find by the displayed watcher id, so do not advertise
    // a Stop button that would deterministically fail with 409.
    const canCancel = primary.watcherId === displayWatcherId && primary.canCancel;
    const text = taskProgressText(primary, group.length);
    const labelSummary = primary.summary
      ? `: ${primary.summary.slice(0, 60)}${primary.summary.length > 60 ? '…' : ''}`
      : '';
    const label = `${primary.agentEmoji} ${primary.agentName}${labelSummary}`;

    snapshots.push({
      taskId: primary.taskId,
      watcherId: displayWatcherId,
      kind: 'task_proxy',
      visibleAgentId: primary.visibleAgentId,
      agentId: primary.agentId,
      agentName: primary.agentName,
      agentEmoji: primary.agentEmoji,
      summary: primary.summary,
      status: primary.status,
      phase: primary.phase,
      startedAt: primary.startedAt,
      lastActivityAt: Math.max(...group.map(task => task.lastActivityAt || 0)) || primary.startedAt,
      currentTool: primary.currentTool,
      toolsUsed: group.reduce((total, task) => total + task.toolsUsed, 0),
      canCancel,
      label,
      text,
      state: {
        taskId: primary.rootTaskId || primary.taskId,
        rootTaskId: primary.rootTaskId || primary.taskId,
        rootWatcherId: displayWatcherId,
        visibleAgentId: primary.visibleAgentId,
        status: primary.status,
        targetAgentId: primary.agentId,
        targetAgentName: primary.agentName,
        targetAgentEmoji: primary.agentEmoji,
        summary: primary.summary,
        startedAt: primary.startedAt,
        lastActivityAt: Math.max(...group.map(task => task.lastActivityAt || 0)) || primary.startedAt,
        toolsUsed: group.reduce((total, task) => total + task.toolsUsed, 0),
        currentTool: primary.currentTool,
        phase: primary.phase,
        isWorker: primary.isWorker,
        requestedWorkstreams: primary.requestedWorkstreams,
        canCancel,
        cancelling: primary.status === 'cancelling' || primary.phase === 'cancelling',
        ...(children.length ? { childTasks: children } : {}),
        ...(coordination ? { coordination } : {}),
        ...(coordinationEvents.length
          ? { coordinationEvents }
          : {}),
      },
    });
  }
  return snapshots;
}
