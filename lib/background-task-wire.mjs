const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled', 'failed', 'complete']);

function cleanString(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function finiteTimestamp(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
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
    toolsUsed: Math.max(0, Number(task.toolsUsed) || 0),
    canCancel,
    isWorker: task.isWorker === true,
  };
}

function childSnapshot(task) {
  return {
    taskId: task.taskId,
    name: task.agentName,
    summary: task.summary,
    status: task.status,
    currentTool: task.currentTool,
    lastActivityAt: task.lastActivityAt,
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
    const children = group
      .filter(task => task.taskId !== primary.taskId)
      .map(childSnapshot);
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
        canCancel,
        cancelling: primary.status === 'cancelling' || primary.phase === 'cancelling',
        ...(children.length ? { childTasks: children } : {}),
      },
    });
  }
  return snapshots;
}
