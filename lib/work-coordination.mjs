// @ts-check
/**
 * In-memory coordination for bounded child workstreams.
 *
 * Claims and directives are deliberately domain-neutral: a resource may be a
 * source, file, API, account, topic, work step, or any other stable key the
 * coordinator and its children agree on. Nothing here interprets task content.
 */

const MAX_LABEL = 160;
const MAX_KEY = 240;
const MAX_DIRECTIVE = 500;
const MAX_EVENTS = 40;
const MAX_DIRECTIVES_PER_TASK = 8;
const URL_LIKE_CLAIM_KINDS = new Set([
  'domain',
  'host',
  'hostname',
  'source',
  'uri',
  'url',
  'web',
  'website',
]);

/** @type {Map<string, any>} */
const roots = new Map();
/** @type {Map<string, string>} */
const taskRoots = new Map();
let sequence = 0;

function clean(value, max = MAX_LABEL) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizedKey(kind, key) {
  const claimKind = clean(kind, 40).toLowerCase() || 'work';
  let value = clean(key, MAX_KEY).replace(/\s+/g, ' ');
  const looksLikeUrl = value.includes('://')
    || /^(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(value);
  if (URL_LIKE_CLAIM_KINDS.has(claimKind) && looksLikeUrl) {
    try {
      const parsed = new URL(value.includes('://') ? value : `https://${value}`);
      const host = parsed.host.replace(/^www\./i, '').toLowerCase();
      const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
      value = `${host}${path}${parsed.search}${parsed.hash}`;
    } catch {
      // Invalid URL-like keys remain exact. A stable caller key is safer than
      // a heuristic that accidentally merges case-sensitive resources.
    }
  }
  return `${claimKind}:${value}`;
}

export function canonicalWorkClaimKey(kind, key) {
  return normalizedKey(kind, key);
}

function rootRecord(rootTaskId, userId = '') {
  let root = roots.get(rootTaskId);
  if (!root) {
    root = {
      rootTaskId,
      userId: clean(userId, 160),
      tasks: new Map(),
      claims: new Map(),
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    roots.set(rootTaskId, root);
  }
  return root;
}

function addEvent(root, event) {
  const entry = {
    id: `coord_${Date.now().toString(36)}_${(++sequence).toString(36)}`,
    ts: Date.now(),
    ...event,
  };
  root.events.push(entry);
  if (root.events.length > MAX_EVENTS) root.events.splice(0, root.events.length - MAX_EVENTS);
  root.updatedAt = entry.ts;
  return entry;
}

function publicClaim(claim) {
  if (!claim) return null;
  return {
    id: claim.id,
    kind: claim.kind,
    label: claim.label,
    mode: claim.mode,
    status: claim.status,
    taskId: claim.taskId,
    createdAt: claim.createdAt,
    endedAt: claim.endedAt || null,
  };
}

function publicEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    ts: event.ts,
    type: event.type,
    actorTaskId: event.actorTaskId || null,
    targetTaskId: event.targetTaskId || null,
    label: event.label || '',
    reason: event.reason || '',
  };
}

export function registerCoordinatedTask({
  rootTaskId = '',
  taskId = '',
  parentTaskId = null,
  userId = '',
  name = 'Worker',
  label = '',
  phase = 'running',
} = {}) {
  const rootId = clean(rootTaskId, 200);
  const childId = clean(taskId, 200);
  if (!rootId || !childId) return null;
  const root = rootRecord(rootId, userId);
  if (root.userId && userId && root.userId !== userId) return null;
  const existing = root.tasks.get(childId);
  if (existing) return existing;
  const task = {
    taskId: childId,
    parentTaskId: clean(parentTaskId, 200) || null,
    name: clean(name) || 'Worker',
    label: clean(label) || clean(name) || 'Worker',
    status: 'running',
    phase: clean(phase, 40) === 'queued' ? 'queued' : 'running',
    claimIds: new Set(),
    pendingDirectives: [],
    replanRequired: '',
    lastDirective: '',
    startedAt: Date.now(),
    endedAt: null,
  };
  root.tasks.set(childId, task);
  taskRoots.set(childId, rootId);
  addEvent(root, {
    type: 'spawn',
    actorTaskId: task.parentTaskId,
    targetTaskId: childId,
    label: task.label,
  });
  return task;
}

/**
 * Atomically pre-register a coordinator's complete lane plan and its primary
 * claims before any lane waits for a concurrency slot. This preserves central
 * assignment: an early lane can never expand into a queued lane's scope.
 */
export function reserveCoordinatedTasks({
  rootTaskId = '',
  parentTaskId = null,
  userId = '',
  tasks = [],
} = {}) {
  const rootId = clean(rootTaskId, 200);
  const parentId = clean(parentTaskId, 200) || rootId;
  const candidates = (Array.isArray(tasks) ? tasks : []).map(item => ({
    taskId: clean(item?.taskId, 200),
    name: clean(item?.name) || 'Worker',
    label: clean(item?.label) || clean(item?.name) || 'Worker',
    claim: {
      kind: clean(item?.claim?.kind, 40).toLowerCase() || 'work',
      key: clean(item?.claim?.key, MAX_KEY),
      label: clean(item?.claim?.label) || clean(item?.label) || clean(item?.name) || 'Work',
      mode: ['shared', 'verification'].includes(item?.claim?.mode)
        ? item.claim.mode
        : 'exclusive',
    },
  }));
  if (!rootId || !candidates.length || candidates.some(item => !item.taskId || !item.claim.key)) {
    return { ok: false, reason: 'A root and complete task/claim plan are required.' };
  }
  const ids = new Set(candidates.map(item => item.taskId));
  if (ids.size !== candidates.length) {
    return { ok: false, reason: 'Every planned workstream needs a distinct task id.' };
  }
  const root = rootRecord(rootId, userId);
  if (root.userId && userId && root.userId !== userId) {
    return { ok: false, reason: 'This team root belongs to a different user.' };
  }
  if (candidates.some(item => root.tasks.has(item.taskId))) {
    return { ok: false, reason: 'A planned workstream id is already registered.' };
  }

  const plannedClaims = [];
  for (const item of candidates) {
    const canonical = normalizedKey(item.claim.kind, item.claim.key);
    const conflict = [...root.claims.values(), ...plannedClaims].find(claim =>
      claim.status !== 'released'
      && claim.canonical === canonical
      && (claim.mode === 'exclusive' || item.claim.mode === 'exclusive'));
    if (conflict) {
      return {
        ok: false,
        reason: `"${item.claim.label}" overlaps ${conflict.label || 'another planned lane'}.`,
      };
    }
    plannedClaims.push({
      canonical,
      mode: item.claim.mode,
      status: 'planned',
      label: item.claim.label,
    });
  }

  const reserved = [];
  for (const item of candidates) {
    registerCoordinatedTask({
      rootTaskId: rootId,
      taskId: item.taskId,
      parentTaskId: parentId,
      userId,
      name: item.name,
      label: item.label,
      phase: 'queued',
    });
    const claimed = claimWork({
      rootTaskId: rootId,
      taskId: item.taskId,
      ...item.claim,
    });
    // All conflicts were validated synchronously above; this is a defensive
    // invariant rather than a recoverable partial-reservation path.
    if (!claimed.ok) {
      throw new Error(`Atomic coordinated task reservation failed: ${claimed.reason}`);
    }
    reserved.push({ taskId: item.taskId, claim: claimed.claim });
  }
  return { ok: true, tasks: reserved };
}

export function markCoordinatedTaskStarted(taskId) {
  const childId = clean(taskId, 200);
  const rootId = taskRoots.get(childId);
  const task = rootId ? roots.get(rootId)?.tasks?.get(childId) : null;
  if (!task || task.status !== 'running') return false;
  task.phase = 'running';
  return true;
}

export function claimWork({
  rootTaskId = null,
  taskId = '',
  kind = 'work',
  key = '',
  label = '',
  mode = 'exclusive',
} = {}) {
  const childId = clean(taskId, 200);
  const rootId = clean(rootTaskId, 200) || taskRoots.get(childId) || '';
  const scopeKey = clean(key, MAX_KEY);
  if (!rootId || !childId || !scopeKey) {
    return { ok: false, reason: 'A coordinated task, claim kind, and stable key are required.' };
  }
  const root = roots.get(rootId);
  const task = root?.tasks?.get(childId);
  if (!root || !task || task.status !== 'running') {
    return { ok: false, reason: 'This task is not an active coordinated workstream.' };
  }
  const claimMode = mode === 'shared' || mode === 'verification' ? mode : 'exclusive';
  const claimKind = clean(kind, 40).toLowerCase() || 'work';
  const displayLabel = clean(label) || scopeKey;
  const canonical = normalizedKey(claimKind, scopeKey);
  const conflict = [...root.claims.values()].find(claim =>
    claim.status !== 'released'
    && claim.taskId !== childId
    && claim.canonical === canonical
    && (claim.mode === 'exclusive' || claimMode === 'exclusive'));
  if (conflict) {
    task.replanRequired = `"${displayLabel}" overlaps work already owned by ${conflict.workerName || 'another worker'}.`;
    addEvent(root, {
      type: 'conflict',
      actorTaskId: childId,
      targetTaskId: conflict.taskId,
      label: displayLabel,
      reason: `${conflict.label} is already claimed by ${conflict.workerName || 'another worker'}`,
    });
    return {
      ok: false,
      conflict: true,
      reason: `"${displayLabel}" is already covered by ${conflict.workerName || 'another worker'}. Do not duplicate it; choose a different uncovered scope and claim that instead.`,
      existing: publicClaim(conflict),
    };
  }
  const duplicate = [...root.claims.values()].find(claim =>
    claim.status !== 'released' && claim.taskId === childId && claim.canonical === canonical);
  if (duplicate) return { ok: true, duplicate: true, claim: publicClaim(duplicate) };

  const claim = {
    id: `claim_${Date.now().toString(36)}_${(++sequence).toString(36)}`,
    rootTaskId: rootId,
    taskId: childId,
    workerName: task.name,
    kind: claimKind,
    key: scopeKey,
    canonical,
    label: displayLabel,
    mode: claimMode,
    status: 'active',
    createdAt: Date.now(),
    endedAt: null,
  };
  root.claims.set(claim.id, claim);
  task.claimIds.add(claim.id);
  addEvent(root, {
    type: 'claim',
    actorTaskId: childId,
    label: displayLabel,
    reason: claimMode,
  });
  return { ok: true, claim: publicClaim(claim) };
}

export function releaseTaskClaims(taskId, reason = 'released', status = 'released') {
  const childId = clean(taskId, 200);
  const rootId = taskRoots.get(childId);
  const root = rootId ? roots.get(rootId) : null;
  const task = root?.tasks?.get(childId);
  if (!root || !task) return [];
  const released = [];
  for (const claimId of task.claimIds) {
    const claim = root.claims.get(claimId);
    if (!claim || !['active', 'redirect_pending'].includes(claim.status)) continue;
    claim.status = status;
    claim.endedAt = Date.now();
    released.push(publicClaim(claim));
    addEvent(root, {
      type: status === 'completed' ? 'complete' : 'release',
      actorTaskId: childId,
      label: claim.label,
      reason: clean(reason, 240),
    });
  }
  return released;
}

export function redirectCoordinatedTask({
  taskId = '',
  directive = '',
  reason = '',
  releaseClaims = true,
} = {}) {
  const childId = clean(taskId, 200);
  const text = clean(directive, MAX_DIRECTIVE);
  const rootId = taskRoots.get(childId);
  const root = rootId ? roots.get(rootId) : null;
  const task = root?.tasks?.get(childId);
  if (!root || !task || task.status !== 'running') {
    return { ok: false, reason: 'Target workstream is not active.' };
  }
  if (!text) return { ok: false, reason: 'A redirect directive is required.' };
  const duplicate = task.pendingDirectives.find(item => item.text === text);
  if (duplicate) return { ok: true, duplicate: true, directive: { ...duplicate } };
  const item = {
    id: `directive_${Date.now().toString(36)}_${(++sequence).toString(36)}`,
    text,
    reason: clean(reason, 240),
    releaseClaims: releaseClaims === true,
    createdAt: Date.now(),
  };
  if (item.releaseClaims) {
    for (const claimId of task.claimIds) {
      const claim = root.claims.get(claimId);
      if (claim?.status === 'active') claim.status = 'redirect_pending';
    }
  }
  task.pendingDirectives.push(item);
  if (task.pendingDirectives.length > MAX_DIRECTIVES_PER_TASK) task.pendingDirectives.shift();
  task.lastDirective = text;
  addEvent(root, {
    type: 'redirect',
    targetTaskId: childId,
    label: text,
    reason: item.reason,
  });
  return { ok: true, directive: { ...item } };
}

export function consumeTaskDirectives(taskId) {
  const childId = clean(taskId, 200);
  const rootId = taskRoots.get(childId);
  const task = rootId ? roots.get(rootId)?.tasks?.get(childId) : null;
  if (!task?.pendingDirectives?.length || task.status !== 'running') return [];
  const items = task.pendingDirectives.splice(0);
  // A provider may have emitted several tool calls in one assistant message.
  // Once a redirect is delivered after one call, later calls from that stale
  // batch must be skipped until the model has seen the update and replanned.
  task.replanRequired = 'A coordinator redirect changed this lane scope.';
  if (items.some(item => item.releaseClaims)) {
    releaseTaskClaims(childId, 'redirect delivered', 'released');
  }
  return items.map(item => ({ ...item }));
}

/** Return (without consuming) why the current coordinated lane must replan. */
export function taskActionBarrier(taskId) {
  const childId = clean(taskId, 200);
  const rootId = taskRoots.get(childId);
  const task = rootId ? roots.get(rootId)?.tasks?.get(childId) : null;
  if (!task || task.status !== 'running') return '';
  if (task.pendingDirectives.length) return 'A coordinator update is waiting for this lane.';
  return task.replanRequired || '';
}

/** Provider request boundary: the model has now received the prior result/update. */
export function acknowledgeTaskReplan(taskId) {
  const childId = clean(taskId, 200);
  const rootId = taskRoots.get(childId);
  const task = rootId ? roots.get(rootId)?.tasks?.get(childId) : null;
  if (!task) return false;
  task.replanRequired = '';
  return true;
}

/**
 * Atomically reserve one bounded fan-out wave for a coordinator lifetime.
 * The root is cleared with the worker task, so this cannot become a durable
 * quota or leak across unrelated outcomes.
 */
export function reserveParallelWork({
  rootTaskId = '',
  coordinatorTaskId = '',
  userId = '',
  childCount = 0,
  maxCalls = 1,
  maxChildren = 4,
  deadlineMs = 10 * 60_000,
} = {}) {
  const rootId = clean(rootTaskId, 200);
  const coordinatorId = clean(coordinatorTaskId, 200);
  const requestedChildren = Math.max(0, Math.floor(Number(childCount) || 0));
  if (!rootId || !coordinatorId || rootId !== coordinatorId) {
    return { ok: false, reason: 'Parallel work requires one isolated coordinator-owned team root.' };
  }
  if (!requestedChildren) return { ok: false, reason: 'At least one child workstream is required.' };
  const root = rootRecord(rootId, userId);
  if (root.userId && userId && root.userId !== userId) {
    return { ok: false, reason: 'This team root belongs to a different user.' };
  }
  const now = Date.now();
  if (!root.parallel) {
    root.parallel = {
      calls: 0,
      childStarts: 0,
      deadlineAt: now + Math.max(30_000, Math.min(30 * 60_000, Number(deadlineMs) || 10 * 60_000)),
    };
  }
  if (now >= root.parallel.deadlineAt) {
    return { ok: false, reason: 'This coordinator team has reached its parallel-work deadline.' };
  }
  if (root.parallel.calls >= Math.max(1, Math.floor(Number(maxCalls) || 1))) {
    return { ok: false, reason: 'This coordinator already used its bounded parallel-work wave.' };
  }
  if (root.parallel.childStarts + requestedChildren > Math.max(1, Math.floor(Number(maxChildren) || 4))) {
    return { ok: false, reason: 'This coordinator would exceed its lifetime child-workstream cap.' };
  }
  root.parallel.calls += 1;
  root.parallel.childStarts += requestedChildren;
  addEvent(root, {
    type: 'fanout',
    actorTaskId: coordinatorId,
    label: `${requestedChildren} workstreams`,
  });
  return {
    ok: true,
    calls: root.parallel.calls,
    childStarts: root.parallel.childStarts,
    deadlineAt: root.parallel.deadlineAt,
  };
}

export function completeCoordinatedTask(taskId, status = 'done', summary = '') {
  const childId = clean(taskId, 200);
  const rootId = taskRoots.get(childId);
  const root = rootId ? roots.get(rootId) : null;
  const task = root?.tasks?.get(childId);
  if (!root || !task) return false;
  task.status = clean(status, 40) || 'done';
  task.phase = task.status;
  task.endedAt = Date.now();
  task.pendingDirectives.length = 0;
  task.replanRequired = '';
  releaseTaskClaims(childId, summary || task.status, task.status === 'done' ? 'completed' : 'released');
  addEvent(root, {
    type: task.status === 'done' ? 'complete' : 'error',
    actorTaskId: childId,
    label: task.label,
    reason: clean(summary, 240),
  });
  return true;
}

/**
 * Atomically seal a lane only when no manager update is waiting. Once sealed,
 * redirectCoordinatedTask rejects new updates instead of accepting one that
 * completion would immediately discard.
 */
export function sealCoordinatedTask(taskId) {
  const childId = clean(taskId, 200);
  const rootId = taskRoots.get(childId);
  const task = rootId ? roots.get(rootId)?.tasks?.get(childId) : null;
  if (!task || task.status !== 'running') {
    return { ok: false, reason: 'This coordinated workstream is not running.' };
  }
  if (task.pendingDirectives.length) {
    return { ok: false, pending: true, reason: 'A coordinator update is waiting.' };
  }
  task.status = 'finalizing';
  task.phase = 'finalizing';
  return { ok: true };
}

export function taskCoordinationSnapshot(taskId) {
  const childId = clean(taskId, 200);
  const rootId = taskRoots.get(childId);
  const root = rootId ? roots.get(rootId) : null;
  const task = root?.tasks?.get(childId);
  if (!root || !task) return null;
  return {
    role: 'worker',
    claims: [...task.claimIds]
      .map(id => publicClaim(root.claims.get(id)))
      .filter(Boolean),
    lastEvent: task.lastDirective || '',
    endedAt: task.endedAt || null,
  };
}

export function rootCoordinationSnapshot(rootTaskId) {
  const root = roots.get(clean(rootTaskId, 200));
  if (!root) return null;
  const tasks = [...root.tasks.values()];
  const completed = tasks.filter(task => task.status === 'done').length;
  const activeStatuses = new Set(['running', 'finalizing']);
  const failed = tasks.filter(task =>
    !activeStatuses.has(task.status) && task.status !== 'done').length;
  return {
    coordination: {
      coordinatorTaskId: root.rootTaskId,
      total: tasks.length,
      active: tasks.filter(task => activeStatuses.has(task.status)).length,
      completed,
      failed,
    },
    coordinationEvents: root.events.slice(-12).map(publicEvent).filter(Boolean),
  };
}

/**
 * Public child rows retained for the lifetime of a coordinator team. Active
 * task records disappear as soon as a lane finishes, but reconnecting clients
 * still need to see those completed lanes while the coordinator synthesizes.
 * Canonical claim keys and pending directive bodies are deliberately omitted.
 */
export function coordinatedTasksSnapshot(rootTaskId) {
  const root = roots.get(clean(rootTaskId, 200));
  if (!root) return [];
  return [...root.tasks.values()].map(task => {
    return {
      taskId: task.taskId,
      parentTaskId: task.parentTaskId || null,
      name: task.name,
      summary: task.label,
      status: task.status,
      phase: task.phase || task.status,
      startedAt: task.startedAt,
      endedAt: task.endedAt || null,
      role: 'worker',
      claims: [...task.claimIds]
        .map(id => publicClaim(root.claims.get(id)))
        .filter(Boolean),
      lastEvent: '',
    };
  });
}

export function coordinatedTaskRoot(taskId) {
  return taskRoots.get(clean(taskId, 200)) || null;
}

export function clearWorkCoordination(rootTaskId) {
  const rootId = clean(rootTaskId, 200);
  const root = roots.get(rootId);
  if (!root) return false;
  for (const taskId of root.tasks.keys()) taskRoots.delete(taskId);
  roots.delete(rootId);
  return true;
}

/** Test-only state reset; not used by runtime code. */
export function _resetWorkCoordinationForTests() {
  roots.clear();
  taskRoots.clear();
  sequence = 0;
}
