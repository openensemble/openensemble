// Task chips, status bubbles, cancel — extracted from chat-render.js.
// Globals intentional.

function taskChipTime(ts) {
  const d = new Date(ts || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function taskChipPhase(status) {
  const phase = status.state?.phase;
  if (status.awaiting_input) return 'awaiting reply';
  if (status.final && status.finalStatus === 'done') return 'done';
  if (status.final && status.finalStatus === 'error') return 'error';
  if (status.final && status.finalStatus === 'cancelled') return 'cancelled';
  if (phase === 'cancelling') return 'cancelling';
  if (phase === 'cancelled') return 'cancelled';
  if (phase === 'queued') return 'queued';
  if (phase === 'tool') return 'using tool';
  if (phase === 'streaming') return 'streaming';
  if (phase === 'result') return 'reviewing result';
  if (phase === 'coordinating') return 'combining results';
  if (phase === 'child_running' || phase === 'child_progress') return 'coordinating team';
  if (phase === 'milestone') return 'making progress';
  if (phase === 'backgrounded') return 'background';
  if (phase === 'waiting_children') return 'waiting on tasks';
  if (phase === 'finalizing') return 'finishing';
  if (phase === 'stalled') return 'needs attention';
  return status.final ? 'finished' : 'running';
}

function taskChipElapsed(startedAt, nowTs = Date.now()) {
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0) return null;
  const sec = Math.max(0, Math.round((nowTs - start) / 1000));
  if (sec < 60) return `${sec}s elapsed`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s elapsed` : `${min}m elapsed`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${hr}h ${m}m elapsed` : `${hr}h elapsed`;
}

async function cancelTaskChip(watcherId, btn) {
  if (!watcherId || !btn) return;
  btn.disabled = true;
  btn.textContent = 'Stopping...';
  try {
    const r = await fetch(`/api/watchers/${encodeURIComponent(watcherId)}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) {
      const err = await r.json().catch(() => ({}));
      btn.disabled = false;
      btn.textContent = 'Stop';
      alert(`Stop failed: ${err.error || r.statusText}`);
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Stop';
    alert(`Stop failed: ${e.message}`);
  }
}

const TASK_CHIP_TERMINAL_STATES = new Set([
  'done', 'complete', 'completed', 'error', 'failed', 'cancelled', 'canceled', 'stopped',
]);

function taskChipText(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function taskChipNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function taskChipToolLabel(name) {
  const value = taskChipText(name, 160);
  if (!value) return '';
  if (typeof toolDisplayLabel === 'function') {
    const friendly = toolDisplayLabel(value, {});
    if (friendly && friendly !== value) return friendly;
  }
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function taskChipExecutionLabel(value) {
  const provider = taskChipText(value?.provider, 100);
  const model = taskChipText(value?.model, 300);
  const reasoningEffort = taskChipText(value?.reasoningEffort, 40);
  const identity = provider && model ? `${provider}/${model}` : (provider || model);
  if (!identity) return '';
  return `${identity}${reasoningEffort ? ` · effort ${reasoningEffort}` : ''}`;
}

function taskChipStateValue(value) {
  return taskChipText(value, 40).toLowerCase().replace(/\s+/g, '_');
}

function taskChipIsTerminal(value) {
  return TASK_CHIP_TERMINAL_STATES.has(taskChipStateValue(value));
}

function taskChipStateClass(value) {
  const state = taskChipStateValue(value);
  if (state === 'done' || state === 'complete' || state === 'completed') return 'done';
  if (state === 'error' || state === 'failed') return 'error';
  if (state === 'cancelled' || state === 'canceled' || state === 'stopped') return 'cancelled';
  if (state === 'blocked' || state === 'stalled' || state === 'awaiting_input') return 'blocked';
  if (state === 'queued' || state === 'pending') return 'queued';
  return 'running';
}

function taskChipStateIcon(value) {
  switch (taskChipStateClass(value)) {
    case 'done': return '✓';
    case 'error': return '⚠';
    case 'cancelled': return '■';
    case 'blocked': return '!';
    case 'queued': return '○';
    default: return '●';
  }
}

function taskChipProgressText(progress) {
  if (typeof progress === 'string') return taskChipText(progress, 120);
  if (Number.isFinite(progress)) return `${Math.max(0, Math.min(100, Math.round(progress)))}%`;
  if (!progress || typeof progress !== 'object') return '';
  const explicit = taskChipText(progress.label || progress.text, 120);
  if (explicit) return explicit;
  const completed = taskChipNumber(progress.completed ?? progress.current ?? progress.done);
  const total = taskChipNumber(progress.total ?? progress.maximum ?? progress.max);
  const unit = taskChipText(progress.unit, 32);
  if (completed !== null && total !== null && total > 0) {
    return `${completed}/${total}${unit ? ` ${unit}` : ''}`;
  }
  const percent = taskChipNumber(progress.percent ?? progress.percentage);
  if (percent !== null) return `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  if (completed !== null) return `${completed}${unit ? ` ${unit}` : ''}`;
  return '';
}

function taskChipClaimList(value) {
  const claims = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  return claims.map((claim, index) => {
    if (typeof claim === 'string') {
      const label = taskChipText(claim, 120);
      return label ? { id: `claim-${index}`, label, kind: 'work', mode: '', status: 'active' } : null;
    }
    if (!claim || typeof claim !== 'object') return null;
    // Deliberately do not fall back to an internal resource key. The server may
    // use one for collision detection, but the card only renders display labels.
    const label = taskChipText(
      claim.label || claim.displayLabel || claim.resourceLabel || claim.scopeLabel || claim.purpose,
      120,
    );
    if (!label) return null;
    return {
      id: taskChipText(claim.id, 120) || `claim-${index}`,
      label,
      kind: taskChipText(claim.kind, 40) || 'work',
      mode: taskChipText(claim.mode, 40),
      status: taskChipStateValue(claim.status || 'active'),
    };
  }).filter(Boolean);
}

function taskChipChildList(value) {
  const output = [];
  let syntheticId = 0;
  const visit = (items, nestedParentId = null) => {
    for (const raw of (Array.isArray(items) ? items : [])) {
      if (!raw || typeof raw !== 'object') continue;
      const id = taskChipText(raw.taskId || raw.id, 200) || `task-chip-child-${++syntheticId}`;
      const parentTaskId = taskChipText(raw.parentTaskId || raw.parentId, 200) || nestedParentId;
      const status = taskChipStateValue(raw.status || raw.phase || 'running');
      const lastEvent = typeof raw.lastEvent === 'string'
        ? taskChipText(raw.lastEvent, 200)
        : taskChipText(raw.lastEvent?.label || raw.lastEvent?.text || raw.lastEvent?.message, 200);
      const currentTool = taskChipText(raw.currentTool, 160);
      const terminalState = taskChipStateClass(status);
      const terminalAction = terminalState === 'done' ? 'Completed'
        : terminalState === 'error' ? 'Failed'
          : terminalState === 'cancelled' ? 'Stopped'
            : '';
      output.push({
        id,
        taskId: id,
        parentTaskId,
        name: taskChipText(raw.name || raw.agentName || raw.label, 160) || 'Worker',
        role: taskChipText(raw.role, 60),
        provider: taskChipText(raw.provider, 100),
        model: taskChipText(raw.model, 300),
        reasoningEffort: taskChipText(raw.reasoningEffort, 40),
        executionTargetExplicit: raw.executionTargetExplicit === true,
        executionLabel: taskChipExecutionLabel(raw),
        detail: taskChipText(
          raw.scopeLabel || raw.assignment || raw.objective || raw.summary || raw.finalReportPreview,
          300,
        ),
        status,
        phase: taskChipStateValue(raw.phase || status),
        currentTool,
        action: terminalAction
          || taskChipText(raw.currentActivity || raw.activity, 200)
          || (currentTool ? `Using ${taskChipToolLabel(currentTool)}` : '')
          || lastEvent,
        progress: taskChipProgressText(raw.progress),
        claims: taskChipClaimList(raw.claims),
        startedAt: taskChipNumber(raw.startedAt),
        lastActivityAt: taskChipNumber(raw.lastActivityAt),
        endedAt: taskChipNumber(raw.endedAt),
      });
      visit(raw.children, id);
    }
  };
  visit(value);

  const byId = new Map(output.map(child => [child.id, child]));
  const childrenByParent = new Map();
  for (const child of output) {
    const parent = child.parentTaskId && byId.has(child.parentTaskId) ? child.parentTaskId : null;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(child);
  }
  const ordered = [];
  const visited = new Set();
  const appendBranch = (child, depth) => {
    if (!child || visited.has(child.id)) return;
    visited.add(child.id);
    ordered.push({ ...child, depth: Math.min(4, Math.max(0, depth)) });
    for (const nested of (childrenByParent.get(child.id) || [])) appendBranch(nested, depth + 1);
  };
  for (const root of (childrenByParent.get(null) || [])) appendBranch(root, 0);
  // Cycles and malformed parent references should not make work disappear.
  for (const child of output) appendBranch(child, 0);
  return ordered;
}

function taskChipEventList(state, children = []) {
  const coordination = state?.coordination && typeof state.coordination === 'object'
    ? state.coordination
    : {};
  const childNames = new Map(children.map(child => [child.taskId, child.name]));
  const source = [
    state?.coordinationEvents,
    state?.activityEvents,
    coordination.events,
  ].find(Array.isArray) || [];
  // Spawn events retain a display label after a completed child disappears
  // from the active child list, so later release/complete events can still name
  // the worker without exposing its internal task id.
  for (const event of source) {
    if (!event || typeof event !== 'object') continue;
    const type = taskChipStateValue(event.type || event.kind);
    const targetTaskId = taskChipText(event.targetTaskId, 200);
    const label = taskChipText(event.label, 160);
    if ((type === 'spawn' || type === 'started') && targetTaskId && label && !childNames.has(targetTaskId)) {
      childNames.set(targetTaskId, label);
    }
  }
  return source.map((event, index) => {
    if (typeof event === 'string') {
      const text = taskChipText(event, 300);
      return text ? { id: `event-${index}`, type: 'milestone', text, ts: null } : null;
    }
    if (!event || typeof event !== 'object') return null;
    const type = taskChipStateValue(event.type || event.kind || 'milestone');
    const actorTaskId = taskChipText(event.actorTaskId, 200);
    const targetTaskId = taskChipText(event.targetTaskId, 200);
    const actor = taskChipText(event.actorName || event.actor || event.workerName, 120)
      || childNames.get(actorTaskId)
      || '';
    const target = taskChipText(event.targetName || event.target || event.worker, 120)
      || childNames.get(targetTaskId)
      || '';
    const label = taskChipText(
      event.label || event.resourceLabel || event.scopeLabel || event.workLabel,
      160,
    );
    const fromLabel = taskChipText(event.fromLabel || event.from?.label, 160);
    const toLabel = taskChipText(event.toLabel || event.to?.label, 160);
    const reason = taskChipText(event.reason, 200);
    const explicit = taskChipText(event.message || event.text, 300);
    let text = explicit;
    if (!text && type === 'redirect') {
      text = `${target || actor || 'Worker'} redirected${fromLabel ? ` from ${fromLabel}` : ''}${toLabel ? ` to ${toLabel}` : ''}${label && !toLabel ? ` — ${label}` : ''}${reason ? ` (${reason})` : ''}`;
    } else if (!text && type === 'conflict') {
      text = `${actor || 'Worker'} hit an overlap${target ? ` with ${target}` : ''}${label ? ` — ${label}` : ''}${reason ? ` (${reason})` : ''}`;
    } else if (!text && type === 'claim') {
      text = `${actor || target || 'Worker'} claimed ${label || 'a work item'}`;
    } else if (!text && (type === 'release' || type === 'released')) {
      text = `${actor || target || 'Worker'} released ${label || 'a work item'}`;
    } else if (!text && (type === 'spawn' || type === 'started')) {
      const worker = target || actor || 'Worker';
      text = `${worker} started${label && label !== worker ? ` — ${label}` : ''}`;
    } else if (!text && (type === 'complete' || type === 'completed')) {
      text = `${actor || target || 'Worker'} completed${label ? ` — ${label}` : ''}`;
    } else if (!text) {
      text = [actor || target, label, reason].filter(Boolean).join(' — ');
    }
    if (!text) return null;
    return {
      id: taskChipText(event.id, 120) || `event-${index}`,
      type,
      text,
      ts: taskChipNumber(event.ts || event.at || event.createdAt),
    };
  }).filter(Boolean);
}

function taskChipOverview(state, children) {
  const coordination = state?.coordination && typeof state.coordination === 'object'
    ? state.coordination
    : {};
  const hasExplicitCoordination = Object.keys(coordination).length > 0;
  const requestedWorkers = taskChipNumber(state?.requestedWorkstreams);
  if (!hasExplicitCoordination && !children.length && !(requestedWorkers > 0)) return [];

  const coordinatorCount = taskChipNumber(coordination.coordinatorCount ?? coordination.coordinators) ?? 1;
  const workerCount = taskChipNumber(
    coordination.workerCount ?? coordination.workers ?? coordination.total,
  ) ?? (children.length || requestedWorkers || 0);
  const derivedActive = children.filter(child => !taskChipIsTerminal(child.status)).length;
  const derivedComplete = children.filter(child => taskChipStateClass(child.status) === 'done').length;
  const derivedFailed = children.filter(child => taskChipStateClass(child.status) === 'error').length;
  const derivedQueued = children.filter(child => taskChipStateClass(child.status) === 'queued').length;
  const active = taskChipNumber(coordination.active) ?? derivedActive;
  const completed = taskChipNumber(coordination.completed) ?? derivedComplete;
  const failed = taskChipNumber(coordination.failed) ?? derivedFailed;
  const queued = taskChipNumber(coordination.queued) ?? derivedQueued;
  const total = taskChipNumber(coordination.total ?? coordination.totalWorkItems);
  const awaitingPlan = requestedWorkers > 0 && !hasExplicitCoordination && children.length === 0;

  const bits = [
    `${coordinatorCount} coordinator${coordinatorCount === 1 ? '' : 's'}`,
    `${workerCount} worker${workerCount === 1 ? '' : 's'}${awaitingPlan ? ' requested' : ''}`,
    `${active} active`,
  ];
  if (queued > 0) bits.push(`${queued} queued`);
  if (total !== null && total > 0) bits.push(`${completed}/${total} complete`);
  else if (completed > 0) bits.push(`${completed} complete`);
  if (failed > 0) bits.push(`${failed} failed`);
  return bits;
}

// Pure, DOM-free reducer used by the renderer and focused frontend tests.
// Every new coordination field is additive; legacy task_proxy states still
// produce the same name, summary, status, and current activity.
function taskChipViewModel(status, ts = Date.now()) {
  const label = taskChipText(status?.label, 800);
  const dashIdx = label.indexOf(': ');
  const state = status?.state && typeof status.state === 'object' ? status.state : {};
  const fallbackAgentPart = dashIdx > 0 ? label.slice(0, dashIdx) : label;
  const fallbackTaskPart = dashIdx > 0 ? label.slice(dashIdx + 2) : '';
  const agentPart = `${taskChipText(state.targetAgentEmoji, 16)} ${taskChipText(state.targetAgentName, 160) || fallbackAgentPart || 'Task'}`.trim();
  const taskPart = taskChipText(state.summary, 600) || fallbackTaskPart;
  const executionLabel = taskChipExecutionLabel(state);
  const phaseText = taskChipPhase(status || {});
  const final = !!status?.final;
  const finalStatus = taskChipStateValue(status?.finalStatus);
  let visualState = 'running';
  let badge = `⏵ ${phaseText}`;
  if (status?.awaiting_input) {
    visualState = 'blocked'; badge = '⏳ awaiting reply';
  } else if (final && finalStatus === 'done') {
    visualState = 'done'; badge = '✓ done';
  } else if (final && finalStatus === 'error') {
    visualState = 'error'; badge = '⚠ error';
  } else if (final && finalStatus === 'cancelled') {
    visualState = 'cancelled'; badge = '■ cancelled';
  } else if (final) {
    visualState = 'finished'; badge = '· finished';
  } else if (state.cancelling || state.status === 'cancelling') {
    visualState = 'cancelled'; badge = '■ stopping';
  } else if (state.phase === 'stalled' || state.status === 'stalled') {
    visualState = 'blocked'; badge = '⚠ needs attention';
  }

  const coordination = state.coordination && typeof state.coordination === 'object'
    ? state.coordination
    : {};
  const childSource = [
    state.childTasks,
    coordination.children,
    state.workItems,
  ].find(Array.isArray) || [];
  const children = taskChipChildList(childSource);
  const events = taskChipEventList(state, children);
  const meta = [];
  if (state.currentTool) meta.push(`Using ${taskChipToolLabel(state.currentTool)}`);
  if (Number.isFinite(state.toolsUsed) && state.toolsUsed > 0) {
    meta.push(`${state.toolsUsed} tool${state.toolsUsed === 1 ? '' : 's'} used`);
  }
  const elapsed = taskChipElapsed(state.startedAt, ts);
  if (elapsed) meta.push(elapsed);
  if (state.startedAt) meta.push(`Started ${taskChipTime(state.startedAt)}`);
  if (state.lastActivityAt) meta.push(`Updated ${taskChipTime(state.lastActivityAt)}`);
  const history = Array.isArray(status?.recentHistory)
    ? status.recentHistory
      .filter(entry => entry?.text)
      .slice(-5)
      .map(entry => ({ text: taskChipText(entry.text, 1200), ts: taskChipNumber(entry.ts) }))
    : [];

  return {
    agentPart,
    taskPart,
    executionLabel,
    executionTargetExplicit: state.executionTargetExplicit === true,
    phaseText,
    visualState,
    badge,
    canCancel: !!state.canCancel && !final && !status?.awaiting_input,
    meta,
    overview: taskChipOverview(state, children),
    children,
    claims: taskChipClaimList(state.claims || coordination.claims),
    events,
    statusText: taskChipText(status?.text, 4000),
    history,
  };
}

function renderTaskChipClaims(container, claims, limit = 4) {
  container.innerHTML = '';
  const visible = (Array.isArray(claims) ? claims : []).slice(0, limit);
  for (const claim of visible) {
    const chip = document.createElement('span');
    chip.className = 'task-chip-claim';
    chip.dataset.status = taskChipStateClass(claim.status);
    if (claim.mode) chip.dataset.mode = claim.mode;
    chip.textContent = claim.label;
    chip.title = [claim.kind, claim.mode, claim.status].filter(Boolean).join(' · ');
    container.appendChild(chip);
  }
  if ((claims?.length || 0) > visible.length) {
    const more = document.createElement('span');
    more.className = 'task-chip-claim task-chip-claim-more';
    more.textContent = `+${claims.length - visible.length}`;
    more.title = `${claims.length - visible.length} more work claim${claims.length - visible.length === 1 ? '' : 's'}`;
    container.appendChild(more);
  }
  container.hidden = visible.length === 0;
}

function renderTaskChipChildRow(child) {
  const row = document.createElement('div');
  row.className = 'task-chip-child';
  row.dataset.depth = String(child.depth || 0);
  row.dataset.status = taskChipStateClass(child.status);
  row.setAttribute('role', 'listitem');
  row.setAttribute('aria-label', `${child.name}: ${child.action || child.status || 'running'}${child.executionLabel ? `; execution ${child.executionLabel}` : ''}`);

  const icon = document.createElement('span');
  icon.className = 'task-chip-child-icon';
  icon.textContent = taskChipStateIcon(child.status);
  icon.title = child.status || 'running';
  icon.setAttribute('aria-hidden', 'true');

  const main = document.createElement('div');
  main.className = 'task-chip-child-main';
  const nameRow = document.createElement('div');
  nameRow.className = 'task-chip-child-name-row';
  const name = document.createElement('span');
  name.className = 'task-chip-child-name';
  name.textContent = child.name;
  nameRow.appendChild(name);
  if (child.role) {
    const role = document.createElement('span');
    role.className = 'task-chip-child-role';
    role.textContent = child.role;
    nameRow.appendChild(role);
  }
  if (child.executionLabel) {
    const execution = document.createElement('span');
    execution.className = 'task-chip-child-role task-chip-child-execution';
    execution.textContent = child.executionLabel;
    execution.title = child.executionTargetExplicit
      ? `Explicit execution target: ${child.executionLabel}`
      : `Execution: ${child.executionLabel}`;
    nameRow.appendChild(execution);
  }
  main.appendChild(nameRow);
  if (child.detail) {
    const detail = document.createElement('div');
    detail.className = 'task-chip-child-detail';
    detail.textContent = child.detail;
    main.appendChild(detail);
  }
  const claims = document.createElement('div');
  claims.className = 'task-chip-claims task-chip-child-claims';
  renderTaskChipClaims(claims, child.claims, 3);
  main.appendChild(claims);

  const state = document.createElement('div');
  state.className = 'task-chip-child-state';
  if (child.progress) {
    const progress = document.createElement('span');
    progress.className = 'task-chip-child-progress';
    progress.textContent = child.progress;
    state.appendChild(progress);
  }
  const action = document.createElement('span');
  action.className = 'task-chip-child-action';
  action.textContent = child.action || child.phase || child.status || 'running';
  state.appendChild(action);

  row.appendChild(icon);
  row.appendChild(main);
  row.appendChild(state);
  return row;
}

function renderTaskChipChildren(container, children) {
  const previousMore = container.querySelector('.task-chip-more-children');
  const keepExpanded = previousMore?.open === true;
  const restoreSummaryFocus = !!previousMore
    && previousMore.querySelector('summary') === document.activeElement;
  container.innerHTML = '';
  if (!children.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.setAttribute('role', 'list');
  container.setAttribute('aria-label', 'Task team');
  const visible = children.slice(0, 6);
  for (const child of visible) container.appendChild(renderTaskChipChildRow(child));
  if (children.length > visible.length) {
    const more = document.createElement('details');
    more.className = 'task-chip-more-children';
    more.setAttribute('role', 'listitem');
    const summary = document.createElement('summary');
    const count = children.length - visible.length;
    summary.textContent = `Show ${count} more worker${count === 1 ? '' : 's'}`;
    more.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'task-chip-more-children-list';
    list.setAttribute('role', 'list');
    for (const child of children.slice(visible.length)) list.appendChild(renderTaskChipChildRow(child));
    more.appendChild(list);
    container.appendChild(more);
    more.open = keepExpanded;
    if (restoreSummaryFocus) more.querySelector('summary')?.focus();
  }
}

function renderTaskChipEventRow(event) {
  const row = document.createElement('div');
  row.className = 'task-chip-event-row';
  row.dataset.type = event.type;
  const icon = document.createElement('span');
  icon.className = 'task-chip-event-icon';
  icon.textContent = event.type === 'redirect' ? '↪'
    : event.type === 'conflict' ? '⚠'
    : event.type === 'claim' ? '◆'
      : (event.type === 'release' || event.type === 'released') ? '◇'
        : (event.type === 'complete' || event.type === 'completed') ? '✓'
          : event.type === 'error' ? '⚠' : '•';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'task-chip-event-text';
  text.textContent = event.text;
  row.appendChild(icon);
  row.appendChild(text);
  if (event.ts) {
    const time = document.createElement('time');
    time.className = 'task-chip-event-time';
    time.dateTime = new Date(event.ts).toISOString();
    time.textContent = taskChipTime(event.ts);
    row.appendChild(time);
  }
  return row;
}

// ── Task chip — compact coordinator card for in-flight background task trees.
// One card per root task_proxy watcher; additive coordination fields enrich the
// view while old state payloads continue to render as a simple single-worker job.
function appendTaskChip(status, ts = Date.now(), scroll = true) {
  const watcherId = status.watcherId || '';
  if (isNestedTaskProxyStatus(status)) {
    if (watcherId) document.querySelector(`.msg.task-chip[data-watcher-id="${CSS.escape(watcherId)}"]`)?.remove();
    return;
  }
  let el = watcherId ? document.querySelector(`.msg.task-chip[data-watcher-id="${CSS.escape(watcherId)}"]`) : null;
  const isUpdate = !!el;
  const model = taskChipViewModel(status, ts);

  if (!el) {
    el = document.createElement('div');
    el.className = 'msg task-chip';
    el.dataset.watcherId = watcherId;
  }
  // Clear legacy inline task-card styling when a page keeps an element alive
  // across an asset refresh; all steady-state presentation now lives in CSS.
  el.removeAttribute('style');
  el.dataset.taskState = model.visualState;
  el.setAttribute('role', 'group');
  const executionAria = model.executionLabel ? `; execution ${model.executionLabel}` : '';
  el.setAttribute('aria-label', `${model.taskPart ? `${model.agentPart}: ${model.taskPart}` : model.agentPart}${executionAria}`);

  let header = el.querySelector('.task-chip-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'task-chip-header';
    el.appendChild(header);
  }
  header.innerHTML = '';

  const agentEl = document.createElement('span');
  agentEl.className = 'task-chip-agent';
  agentEl.textContent = model.agentPart || 'Task';
  header.appendChild(agentEl);

  if (model.executionLabel) {
    const execution = document.createElement('span');
    execution.className = 'task-chip-child-role task-chip-child-execution task-chip-root-execution';
    execution.textContent = model.executionLabel;
    execution.title = model.executionTargetExplicit
      ? `Explicit execution target: ${model.executionLabel}`
      : `Execution: ${model.executionLabel}`;
    header.appendChild(execution);
  }

  const badgeEl = document.createElement('span');
  badgeEl.className = 'task-chip-badge';
  badgeEl.dataset.status = model.visualState;
  badgeEl.textContent = model.badge;
  badgeEl.setAttribute('aria-label', `Status: ${model.phaseText}`);
  header.appendChild(badgeEl);

  let cancelBtn = el.querySelector('.task-chip-cancel');
  if (model.canCancel) {
    if (!cancelBtn) {
      cancelBtn = document.createElement('button');
      cancelBtn.className = 'task-chip-cancel';
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Stop';
      cancelBtn.title = 'Stop this background task';
      cancelBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        cancelTaskChip(watcherId, cancelBtn);
      });
    }
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Stop';
    header.appendChild(cancelBtn);
  } else if (cancelBtn) {
    cancelBtn.remove();
  }

  let taskLine = el.querySelector('.task-chip-task');
  if (!taskLine) {
    taskLine = document.createElement('div');
    taskLine.className = 'task-chip-task';
    el.insertBefore(taskLine, header.nextSibling);
  }
  taskLine.textContent = model.taskPart;
  taskLine.hidden = !model.taskPart;

  let metaLine = el.querySelector('.task-chip-meta');
  if (!metaLine) {
    metaLine = document.createElement('div');
    metaLine.className = 'task-chip-meta';
    el.insertBefore(metaLine, taskLine.nextSibling);
  }
  metaLine.textContent = model.meta.join(' · ');
  metaLine.hidden = model.meta.length === 0;

  let overview = el.querySelector('.task-chip-overview');
  if (!overview) {
    overview = document.createElement('div');
    overview.className = 'task-chip-overview';
    el.insertBefore(overview, metaLine.nextSibling);
  }
  overview.innerHTML = '';
  for (const bit of model.overview) {
    const item = document.createElement('span');
    item.textContent = bit;
    overview.appendChild(item);
  }
  overview.hidden = model.overview.length === 0;

  let rootClaims = el.querySelector('.task-chip-root-claims');
  if (!rootClaims) {
    rootClaims = document.createElement('div');
    rootClaims.className = 'task-chip-claims task-chip-root-claims';
    el.insertBefore(rootClaims, overview.nextSibling);
  }
  renderTaskChipClaims(rootClaims, model.claims, 6);

  let childrenEl = el.querySelector('.task-chip-children');
  if (!childrenEl) {
    childrenEl = document.createElement('div');
    childrenEl.className = 'task-chip-children';
    el.insertBefore(childrenEl, rootClaims.nextSibling);
  }
  renderTaskChipChildren(childrenEl, model.children);

  let eventHighlight = el.querySelector('.task-chip-event-highlight');
  if (!eventHighlight) {
    eventHighlight = document.createElement('div');
    eventHighlight.className = 'task-chip-event-highlight';
    el.insertBefore(eventHighlight, childrenEl.nextSibling);
  }
  eventHighlight.innerHTML = '';
  const latestEvent = model.events[model.events.length - 1];
  if (latestEvent && latestEvent.text !== model.statusText) {
    eventHighlight.appendChild(renderTaskChipEventRow(latestEvent));
    eventHighlight.hidden = false;
  } else {
    eventHighlight.hidden = true;
  }

  let statusLine = el.querySelector('.task-chip-status');
  if (!statusLine) {
    statusLine = document.createElement('div');
    statusLine.className = 'task-chip-status';
    el.insertBefore(statusLine, eventHighlight.nextSibling);
  }
  statusLine.removeAttribute('style');
  statusLine.removeAttribute('role');
  statusLine.removeAttribute('aria-live');
  statusLine.removeAttribute('aria-atomic');
  statusLine.textContent = model.statusText;
  statusLine.hidden = !model.statusText;

  let liveStatus = el.querySelector('.task-chip-live-status');
  if (!liveStatus) {
    liveStatus = document.createElement('span');
    liveStatus.className = 'task-chip-live-status';
    liveStatus.setAttribute('role', 'status');
    liveStatus.setAttribute('aria-live', 'polite');
    liveStatus.setAttribute('aria-atomic', 'true');
    el.insertBefore(liveStatus, statusLine);
  }
  const liveSummary = [model.phaseText, ...model.overview.slice(-2)].filter(Boolean).join('; ');
  const liveText = `${model.agentPart}: ${liveSummary || 'running'}`;
  if (liveStatus.textContent !== liveText) liveStatus.textContent = liveText;

  let details = el.querySelector('.task-chip-details');
  if (!details) {
    details = document.createElement('details');
    details.className = 'task-chip-details';
    const summary = document.createElement('summary');
    summary.className = 'task-chip-details-summary';
    summary.textContent = 'Activity details';
    details.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'task-chip-details-body';
    details.appendChild(body);
    el.insertBefore(details, statusLine.nextSibling);
  }
  const detailsBody = details.querySelector('.task-chip-details-body');
  let eventList = detailsBody.querySelector('.task-chip-event-list');
  if (!eventList) {
    eventList = document.createElement('div');
    eventList.className = 'task-chip-event-list';
    detailsBody.appendChild(eventList);
  }
  eventList.innerHTML = '';
  if (model.events.length) {
    const label = document.createElement('div');
    label.className = 'task-chip-detail-label';
    label.textContent = 'Coordination';
    eventList.appendChild(label);
    for (const event of model.events.slice(-8)) eventList.appendChild(renderTaskChipEventRow(event));
    eventList.hidden = false;
  } else {
    eventList.hidden = true;
  }

  let recent = detailsBody.querySelector('.task-chip-recent');
  if (!recent) {
    recent = document.createElement('div');
    recent.className = 'task-chip-recent';
    detailsBody.appendChild(recent);
  }
  recent.innerHTML = '';
  const historyRows = model.history.filter(entry => entry.text !== model.statusText);
  if (historyRows.length) {
    const label = document.createElement('div');
    label.className = 'task-chip-detail-label';
    label.textContent = 'Recent activity';
    recent.appendChild(label);
    for (const entry of historyRows) {
      const row = document.createElement('div');
      row.className = 'task-chip-history-row';
      const time = document.createElement('time');
      time.textContent = taskChipTime(entry.ts);
      if (entry.ts) time.dateTime = new Date(entry.ts).toISOString();
      const text = document.createElement('span');
      text.textContent = entry.text;
      row.appendChild(time);
      row.appendChild(text);
      recent.appendChild(row);
    }
    recent.hidden = false;
  } else {
    recent.hidden = true;
  }

  let raw = detailsBody.querySelector('.task-chip-raw');
  if (!raw) {
    raw = document.createElement('div');
    raw.className = 'task-chip-raw';
    const label = document.createElement('div');
    label.className = 'task-chip-detail-label';
    label.textContent = 'Current output';
    const pre = document.createElement('pre');
    raw.appendChild(label);
    raw.appendChild(pre);
    detailsBody.appendChild(raw);
  }
  raw.querySelector('pre').textContent = model.statusText;
  raw.hidden = !model.statusText;

  let historyBtn = detailsBody.querySelector('.task-chip-history-button');
  if (!historyBtn && watcherId) {
    historyBtn = document.createElement('button');
    historyBtn.type = 'button';
    historyBtn.className = 'task-chip-history-button';
    historyBtn.textContent = 'Load full history';
    historyBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await toggleWatcherHistory(el, watcherId);
      const panel = el.querySelector('.watcher-history');
      if (panel && panel.parentElement !== detailsBody) detailsBody.appendChild(panel);
      historyBtn.textContent = el.dataset.historyOpen === '1' ? 'Hide full history' : 'Load full history';
    });
    detailsBody.appendChild(historyBtn);
  }
  if (historyBtn) historyBtn.hidden = !watcherId;

  // Reply input — appears ONLY when awaiting_input, removed otherwise.
  // Multi-tab: when the server WS reports awaiting_input=false (another tab
  // already replied), this branch removes the form so neither tab can
  // submit again. First-write-wins is enforced server-side too.
  let replyBox = el.querySelector('.task-chip-reply');
  if (status.awaiting_input) {
    if (!replyBox) {
      replyBox = document.createElement('div');
      replyBox.className = 'task-chip-reply';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Your reply…';
      input.setAttribute('aria-label', 'Reply to background task');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Send';
      const send = async () => {
        const reply = input.value.trim();
        if (!reply) return;
        input.disabled = true; btn.disabled = true; btn.textContent = '…';
        try {
          const r = await fetch(`/api/watchers/${encodeURIComponent(watcherId)}/reply`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reply }),
          });
          if (!r.ok && r.status !== 409) {
            input.disabled = false; btn.disabled = false; btn.textContent = 'Send';
            const err = await r.json().catch(() => ({}));
            alert(`Reply failed: ${err.error || r.statusText}`);
          }
          // On success the server broadcasts a new status with
          // awaiting_input=false; the next applyStatus tick will remove
          // the reply box from BOTH tabs.
        } catch (e) {
          input.disabled = false; btn.disabled = false; btn.textContent = 'Send';
          alert(`Reply failed: ${e.message}`);
        }
      };
      btn.addEventListener('click', send);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); send(); } });
      replyBox.appendChild(input);
      replyBox.appendChild(btn);
      el.appendChild(replyBox);
      // Focus the input so the user can just type and Enter
      setTimeout(() => input.focus(), 50);
    }
    replyBox.removeAttribute('style');
    replyBox.querySelector('input')?.removeAttribute('style');
    replyBox.querySelector('button')?.removeAttribute('style');
  } else if (replyBox) {
    replyBox.remove();
  }

  if (!isUpdate) {
    insertBefore(el);
    if (scroll) scrollToBottom();
  }
}

function appendStatusBubble(status, ts = Date.now(), scroll = true) {
  // Phase-14: task_proxy watchers get their own richer card treatment
  // (agent header + task line + reply input when awaiting), distinct from
  // the muted-italic generic watcher status.
  if (status.kind === 'task_proxy') {
    return appendTaskChip(status, ts, scroll);
  }
  const watcherId = status.watcherId || '';
  let el = watcherId ? document.querySelector(`.msg.watcher-status[data-watcher-id="${CSS.escape(watcherId)}"]`) : null;
  const isUpdate = !!el;

  if (!el) {
    el = document.createElement('div');
    el.className = 'msg watcher-status';
    el.dataset.watcherId = watcherId;
    el.style.cssText = 'padding:6px 12px;margin:4px 0;font-size:12px;color:var(--muted);font-style:italic;border-left:2px solid var(--border);background:rgba(127,127,127,0.04);border-radius:4px;transition:background 200ms ease,border-color 200ms ease';
  }

  // Header (icon + label + latest text + expand caret) — rebuilt on every
  // update. History panel is a sibling that survives across updates.
  let header = el.querySelector('.watcher-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'watcher-header';
    header.style.cssText = 'display:flex;gap:8px;align-items:flex-start;cursor:pointer';
    header.title = 'Click to view progress history';
    if (watcherId) {
      header.addEventListener('click', (ev) => {
        if (window.getSelection?.().toString()) return; // don't toggle while user is selecting text
        toggleWatcherHistory(el, watcherId);
        ev.stopPropagation();
      });
    }
    el.appendChild(header);
  }
  header.innerHTML = '';

  const icon = document.createElement('span');
  icon.textContent = status.final ? (status.finalStatus === 'done' ? '✓' : status.finalStatus === 'error' ? '⚠' : '⏰') : '📡';
  icon.style.cssText = 'flex-shrink:0;font-style:normal';
  header.appendChild(icon);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0';
  if (status.label) {
    const labelEl = document.createElement('div');
    labelEl.style.cssText = 'font-weight:500;font-style:normal;font-size:11px;opacity:0.7;margin-bottom:2px';
    labelEl.textContent = status.label;
    body.appendChild(labelEl);
  }
  const text = document.createElement('div');
  text.textContent = status.text || '';
  body.appendChild(text);
  header.appendChild(body);

  if (watcherId) {
    const caret = document.createElement('span');
    caret.className = 'watcher-caret';
    caret.textContent = el.dataset.historyOpen === '1' ? '▾' : '▸';
    caret.style.cssText = 'flex-shrink:0;font-style:normal;opacity:0.5;font-size:10px;align-self:center';
    header.appendChild(caret);
  }

  // Final-state styling: brighten/dim per outcome so a finished bubble is
  // visually distinct from a still-ticking one.
  if (status.final) {
    if (status.finalStatus === 'done') {
      el.style.borderLeftColor = 'var(--green, #4caf50)';
      el.style.background = 'rgba(76,175,80,0.06)';
    } else if (status.finalStatus === 'error') {
      el.style.borderLeftColor = 'var(--red, #f44336)';
      el.style.background = 'rgba(244,67,54,0.06)';
    } else {
      el.style.borderLeftColor = 'var(--muted)';
      el.style.opacity = '0.7';
    }
  }

  // Phase-14b: when a task_proxy watcher is awaiting input, render an
  // inline reply form on the chip. Multi-tab dedup: when the server WS
  // reports awaiting_input=false (because another tab replied), clear the
  // form. First-write-wins is enforced server-side.
  let replyBox = el.querySelector('.watcher-reply-box');
  if (status.awaiting_input && status.kind === 'task_proxy') {
    if (!replyBox) {
      replyBox = document.createElement('div');
      replyBox.className = 'watcher-reply-box';
      replyBox.style.cssText = 'margin-top:6px;display:flex;gap:6px;align-items:center';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Your reply…';
      input.style.cssText = 'flex:1;background:var(--bg1);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:12px;color:var(--text);font-style:normal';
      const btn = document.createElement('button');
      btn.textContent = 'Send';
      btn.style.cssText = 'background:var(--accent,#4f82ff);color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer';
      const send = async () => {
        const reply = input.value.trim();
        if (!reply) return;
        input.disabled = true; btn.disabled = true; btn.textContent = '…';
        try {
          const r = await fetch(`/api/watchers/${encodeURIComponent(watcherId)}/reply`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reply }),
          });
          if (!r.ok && r.status !== 409) {
            input.disabled = false; btn.disabled = false; btn.textContent = 'Send';
            const err = await r.json().catch(() => ({}));
            alert(`Reply failed: ${err.error || r.statusText}`);
          }
          // On success the server broadcasts a new status with awaiting_input=false;
          // the next applyStatus tick will remove the reply box.
        } catch (e) {
          input.disabled = false; btn.disabled = false; btn.textContent = 'Send';
          alert(`Reply failed: ${e.message}`);
        }
      };
      btn.addEventListener('click', send);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); send(); } });
      replyBox.appendChild(input);
      replyBox.appendChild(btn);
      el.appendChild(replyBox);
    }
  } else if (replyBox) {
    // No longer awaiting — server-side state cleared (replied, timed out,
    // task finalized). Remove the input form so neither tab can submit again.
    replyBox.remove();
  }

  if (!isUpdate) {
    insertBefore(el);
    if (scroll) scrollToBottom();
  } else {
    // Subtle flash so the user notices the update without yanking scroll.
    el.style.background = 'rgba(127,127,127,0.12)';
    setTimeout(() => {
      // Restore the resting background unless we just set a final-state one.
      if (!status.final) el.style.background = 'rgba(127,127,127,0.04)';
    }, 200);
    // If history panel is currently open, refresh it so the new update shows.
    if (el.dataset.historyOpen === '1') refreshWatcherHistory(el, watcherId);
  }
  return el;
}

// Friction-tracker proposal bubble — rendered when the cortex friction head
// detects a 3rd repetition of an actionable phrasing and proposes an
// automation (recurring task or watch). Two action buttons; click one and
// the bubble mutates in place to the outcome. Transient — not persisted to
// the session today, so reloading the chat removes pending bubbles.
