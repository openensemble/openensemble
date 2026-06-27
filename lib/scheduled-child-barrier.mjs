const groups = new Map();
const TTL_MS = 6 * 60 * 60 * 1000;

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
    };
    groups.set(key, group);
  }
  return group;
}

function pruneGroups() {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, group] of groups) {
    if ((group.updatedAt || group.createdAt || 0) < cutoff) groups.delete(key);
  }
}

export function registerScheduledChild({ userId, scheduledCtx, childId, label = '', kind = 'background' }) {
  pruneGroups();
  const group = getGroup(userId, scheduledCtx);
  if (!group || !childId) return null;
  if (!group.children.has(childId)) {
    group.children.set(childId, {
      childId,
      label,
      kind,
      status: 'running',
      startedAt: Date.now(),
      resultText: '',
      errorMsg: null,
    });
  }
  group.updatedAt = Date.now();
  return {
    key: group.key,
    childCount: group.children.size,
    pendingCount: [...group.children.values()].filter(c => c.status === 'running').length,
  };
}

export function completeScheduledChild({ userId, scheduledCtx, childId, resultText = '', errorMsg = null }) {
  pruneGroups();
  const key = keyFor(userId, scheduledCtx);
  if (!key || !childId) return { tracked: false, shouldContinue: true, pendingCount: 0 };
  const group = groups.get(key);
  if (!group) return { tracked: false, shouldContinue: true, pendingCount: 0 };
  const child = group.children.get(childId);
  if (!child) return { tracked: false, shouldContinue: true, pendingCount: 0 };

  child.status = errorMsg ? 'error' : 'done';
  child.endedAt = Date.now();
  child.resultText = String(resultText || '');
  child.errorMsg = errorMsg ? String(errorMsg) : null;
  group.updatedAt = Date.now();

  const children = [...group.children.values()];
  const pending = children.filter(c => c.status === 'running');
  const done = children.filter(c => c.status === 'done');
  const errors = children.filter(c => c.status === 'error');
  const shouldContinue = pending.length === 0;
  const aggregateResult = children.map((c, idx) => {
    const label = c.label || c.childId;
    const body = c.errorMsg ? `ERROR: ${c.errorMsg}` : (c.resultText || '(completed without text)');
    return `## Child ${idx + 1}: ${label}\n${body}`;
  }).join('\n\n');

  if (shouldContinue) groups.delete(key);
  return {
    tracked: true,
    shouldContinue,
    pendingCount: pending.length,
    doneCount: done.length,
    errorCount: errors.length,
    childCount: children.length,
    aggregateResult,
  };
}

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
