// Inspect each task without mixing its evidence into the primary chat reply.
let chatAgentWorkScope = '';
let chatAgentWorkVersion = 0;
let chatAgentWorkTimer = null;
let chatAgentWorkLoading = false;
let chatAgentWorkLimit = 50;
const chatAgentWorkTasks = new Map();
const chatAgentWorkDetails = new Map();

function currentChatAgentWorkScope() {
  return JSON.stringify([
    typeof _currentUser !== 'undefined' ? _currentUser?.id : null,
    activeAgent,
    typeof activeProjectSpaceId === 'string' ? activeProjectSpaceId : '',
    typeof activeSavedChatId === 'string' ? activeSavedChatId : '',
    typeof agentSessionEpochs !== 'undefined' ? agentSessionEpochs[activeAgent] : null,
  ]);
}

function stopChatAgentWorkRefresh() {
  clearTimeout(chatAgentWorkTimer);
  chatAgentWorkTimer = null;
}

function resetChatAgentWork() {
  stopChatAgentWorkRefresh();
  chatAgentWorkVersion++;
  chatAgentWorkScope = '';
  chatAgentWorkLoading = false;
  chatAgentWorkLimit = 50;
  chatAgentWorkTasks.clear();
  chatAgentWorkDetails.clear();
  $('chatAgentWorkNotice')?.remove();
  $('chatAgentWorkMore')?.remove();
  for (const node of document.querySelectorAll('.chat-agent-work')) node.remove();
}

function ensureChatAgentWorkScope() {
  const scope = currentChatAgentWorkScope();
  if (chatAgentWorkScope !== scope) {
    resetChatAgentWork();
    chatAgentWorkScope = scope;
    if (!$('chatAgentsPanel')?.hidden) chatAgentWorkTimer = setTimeout(refreshChatAgentWork, 0);
  }
  return scope;
}

function chatAgentWorkParams(taskId = null) {
  const params = new URLSearchParams({ agent: activeAgent, limit: String(chatAgentWorkLimit) });
  if (typeof activeProjectSpaceId === 'string' && activeProjectSpaceId) params.set('project', activeProjectSpaceId);
  if (typeof activeSavedChatId === 'string' && activeSavedChatId) params.set('chat', activeSavedChatId);
  const epoch = typeof agentSessionEpochs !== 'undefined' ? agentSessionEpochs[activeAgent] : null;
  if (epoch) params.set('epoch', epoch);
  if (taskId) params.set('task', taskId);
  return params;
}

async function fetchChatAgentWork(params) {
  const response = await fetch(`/api/agent-work?${params}`, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Work details could not be loaded.');
  return data;
}

function chatAgentWorkNotice(text, more = false) {
  const panel = $('chatAgentsPanel');
  if (!panel) return;
  let notice = $('chatAgentWorkNotice');
  if (!notice) {
    notice = document.createElement('p'); notice.id = 'chatAgentWorkNotice';
    notice.className = 'chat-agent-work-notice'; notice.setAttribute('role', 'status');
    panel.appendChild(notice);
  }
  notice.textContent = text;
  let button = $('chatAgentWorkMore');
  if (more && !button) {
    button = document.createElement('button'); button.id = 'chatAgentWorkMore';
    button.type = 'button'; button.className = 'chat-agent-work-more'; button.textContent = 'Show more completed work';
    button.addEventListener('click', () => { chatAgentWorkLimit = Math.min(100, chatAgentWorkLimit + 50); refreshChatAgentWork(); });
    panel.appendChild(button);
  }
  if (button) button.hidden = !more || chatAgentWorkLimit >= 100;
}

async function refreshChatAgentWork() {
  stopChatAgentWorkRefresh();
  if ($('chatAgentsPanel')?.hidden || document.hidden || !activeAgent) return;
  const scope = ensureChatAgentWorkScope();
  if (chatAgentWorkLoading) return;
  const version = chatAgentWorkVersion;
  chatAgentWorkLoading = true;
  try {
    const data = await fetchChatAgentWork(chatAgentWorkParams());
    if (version !== chatAgentWorkVersion || scope !== currentChatAgentWorkScope()) return;
    if (!Array.isArray(data.tasks)) throw new Error('Work history is unavailable.');
    chatAgentWorkTasks.clear();
    for (const task of data.tasks) chatAgentWorkTasks.set(task.taskId, task);
    updateChatAgents();
    chatAgentWorkNotice(data.nextOffset != null
      ? `Showing ${data.tasks.length} of ${data.total} tasks in this conversation.`
      : 'Completed work stays with this conversation. Older project history is in Checkpoints.', data.nextOffset != null);
    const open = [...document.querySelectorAll('.chat-agent-work[open]')];
    await Promise.allSettled(open.map(node => loadChatAgentWorkDetail(node, true)));
  } catch (error) {
    if (version === chatAgentWorkVersion && scope === currentChatAgentWorkScope()) {
      chatAgentWorkNotice(`${error.message} Showing last known activity; retrying.`);
    }
  } finally {
    if (version === chatAgentWorkVersion) {
      chatAgentWorkLoading = false;
      if (!$('chatAgentsPanel')?.hidden) chatAgentWorkTimer = setTimeout(refreshChatAgentWork, 2500);
    }
  }
}

function mergeChatAgentWorkRows(rows) {
  ensureChatAgentWorkScope();
  const merged = new Map(rows.map(row => [row.id, row]));
  for (const task of chatAgentWorkTasks.values()) {
    const prior = merged.get(task.taskId);
    // A poll that began before a final WebSocket event must not revive it.
    if (prior && !prior.active && ['done', 'error', 'cancelled'].includes(prior.visualState) && task.active) continue;
    const phase = taskChipPhase({ state: { status: task.status, phase: task.phase }, final: !task.active,
      finalStatus: taskChipStateClass(task.status) });
    merged.set(task.taskId, {
      id: task.taskId, name: task.name, assignment: task.assignment,
      model: task.model ? `${task.model}${task.provider ? ` · ${task.provider}` : ''}${task.modelSource === 'configured' ? ' · configured' : ''}` : prior?.model || 'Model not recorded',
      depth: prior?.depth || (task.parentTaskId ? 1 : 0),
      active: task.active, status: phase,
      activity: task.active ? (task.currentTool ? `Using ${taskChipToolLabel(task.currentTool)}` : task.latestProgress || phase)
        : task.conclusionPreview || phase,
      visualState: taskChipStateClass(task.status),
    });
  }
  return [...merged.values()].sort((a, b) => Number(b.active) - Number(a.active));
}

function workElement(tag, text, className = '') {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function workTimestamp(value) { return value ? new Date(value).toLocaleString() : ''; }

function renderChatAgentWork(row, element) {
  let details = element.querySelector('.chat-agent-work');
  if (!details) {
    details = workElement('details', null, 'chat-agent-work');
    details.dataset.taskId = row.id;
    details.appendChild(workElement('summary', 'Progress, actions & conclusion'));
    details.appendChild(workElement('div', 'Open to inspect this agent’s work.', 'chat-agent-work-body'));
    details.addEventListener('toggle', () => { if (details.open) loadChatAgentWorkDetail(details); });
    element.appendChild(details);
  }
}

async function loadChatAgentWorkDetail(element, refresh = false) {
  const scope = ensureChatAgentWorkScope();
  const version = chatAgentWorkVersion;
  const id = element.dataset.taskId;
  const cached = chatAgentWorkDetails.get(id);
  if (cached && (!refresh || !cached.active)) {
    renderChatAgentWorkDetail(element, cached); return;
  }
  if (element.dataset.loading === 'true') return;
  element.dataset.loading = 'true';
  const body = element.querySelector('.chat-agent-work-body');
  if (!cached) body.textContent = 'Loading recorded work…';
  try {
    const data = await fetchChatAgentWork(chatAgentWorkParams(id));
    if (scope !== currentChatAgentWorkScope() || version !== chatAgentWorkVersion || !element.isConnected) return;
    if (!data.task || data.task.taskId !== id) throw new Error('Work details are unavailable.');
    chatAgentWorkDetails.set(id, data.task);
    renderChatAgentWorkDetail(element, data.task);
  } catch (error) {
    if (scope !== currentChatAgentWorkScope() || version !== chatAgentWorkVersion || !element.isConnected) return;
    if (!cached) body.textContent = error.message;
  } finally { delete element.dataset.loading; }
}

function renderChatAgentWorkDetail(element, task) {
  const signature = JSON.stringify(task);
  if (element._workSignature === signature) return;
  element._workSignature = signature;
  const body = element.querySelector('.chat-agent-work-body');
  const openActions = new Set([...body.querySelectorAll('details[open]')].map(node => node.dataset.actionId));
  body.replaceChildren();
  const section = (label, text) => {
    body.appendChild(workElement('h3', label));
    const content = workElement('div', text, 'chat-agent-work-text'); body.appendChild(content); return content;
  };
  section('Assignment', task.assignment || 'No assignment was recorded.');
  if (task.assignmentTruncated) body.appendChild(workElement('p', 'Long assignment shortened.', 'chat-agent-work-note'));
  const times = [task.startedAt && `Started ${workTimestamp(task.startedAt)}`, task.endedAt && `Ended ${workTimestamp(task.endedAt)}`].filter(Boolean);
  if (times.length) body.appendChild(workElement('p', times.join(' · '), 'chat-agent-work-note'));
  section('Progress', task.active
    ? (task.status === 'paused' ? 'Paused for recovery review.'
      : task.currentTool ? `Using ${taskChipToolLabel(task.currentTool)}` : task.latestProgress || 'Working — no milestone reported yet.')
    : `Run ${task.status === 'done' ? 'completed' : task.status}.`);
  const milestones = (task.progress || []).filter(entry => entry.kind === 'note');
  if (milestones.length) {
    const list = workElement('ol', null, 'chat-agent-work-progress');
    for (const item of milestones) list.appendChild(workElement('li', `${workTimestamp(item.ts)} — ${item.text}`));
    body.appendChild(list);
  }
  if (task.omittedProgress) body.appendChild(workElement('p', `${task.omittedProgress} older progress updates are outside the saved window.`, 'chat-agent-work-note'));
  body.appendChild(workElement('h3', `Actions (${task.actionCount})`));
  if (!task.actions?.length) body.appendChild(workElement('p', task.active ? 'No tool actions recorded yet.' : 'No tool actions were recorded for this task.', 'chat-agent-work-note'));
  for (const [index, action] of (task.actions || []).entries()) {
    const detail = workElement('details', null, 'chat-agent-work-action');
    detail.dataset.actionId = `${index}:${action.id}`;
    detail.open = openActions.has(detail.dataset.actionId);
    const status = action.providerReported ? 'provider reported activity'
      : action.status === 'unconfirmed' ? 'outcome not confirmed' : action.status;
    detail.appendChild(workElement('summary', `${index + 1}. ${taskChipToolLabel(action.name)} · ${status}`));
    if (action.startedAt) detail.appendChild(workElement('p', workTimestamp(action.startedAt), 'chat-agent-work-note'));
    if (action.args) { detail.appendChild(workElement('h4', 'Inputs')); detail.appendChild(workElement('pre', action.args)); }
    detail.appendChild(workElement('h4', 'Observed result'));
    detail.appendChild(workElement('pre', action.result || (task.active && action.status === 'running' ? 'Waiting for the tool result.' : 'No result recorded.')));
    if (action.argsTruncated || action.resultTruncated) detail.appendChild(workElement('p', 'Long inputs or output shortened in the saved record.', 'chat-agent-work-note'));
    body.appendChild(detail);
  }
  if (task.omittedActions) body.appendChild(workElement('p', `${task.omittedActions} additional actions are outside this view’s limit.`, 'chat-agent-work-note'));
  section(task.status === 'error' || task.status === 'failed' ? 'Failure report' : task.status === 'cancelled' || task.status === 'stopped' ? 'Stopped' : 'Agent’s conclusion',
    task.conclusion || (task.active ? 'This agent has not finished yet.' : 'No conclusion was recorded.'));
  if (task.conclusionTruncated) body.appendChild(workElement('p', 'Long conclusion shortened.', 'chat-agent-work-note'));
  if (task.artifacts?.length) section('Outputs', task.artifacts.map(item => item.filename).join('\n'));
  const button = workElement('button', 'Download work record', 'chat-agent-work-download');
  button.type = 'button';
  button.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(task, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `agent-work-${task.taskId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  body.appendChild(button);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopChatAgentWorkRefresh();
  else if (!$('chatAgentsPanel')?.hidden) refreshChatAgentWork();
});
