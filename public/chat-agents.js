// Current-chat delegation activity. Running tasks come from live events and
// authoritative snapshots; history alone must never resurrect a busy agent.
const chatAgentTasks = new Map();
const chatAgentHistory = new Set();
const chatAgentCompletedTasks = new Map();
let chatAgentsConnected = false;

function chatAgentScope(agent) {
  return typeof clientSessionAgentId === 'function' ? clientSessionAgentId(agent) : agent;
}

function chatAgentCurrentEpoch(agent, state) {
  const epoch = typeof agentSessionEpochs !== 'undefined' ? agentSessionEpochs[agent] : null;
  return !epoch || !state?.sourceSessionEpoch || epoch === state.sourceSessionEpoch;
}

function receiveChatAgentStatus(msg) {
  if (msg?.kind !== 'task_proxy' || !msg.watcherId) return;
  const agent = chatAgentScope(msg.agent || msg.state?.visibleAgentId);
  if (!agent || !chatAgentCurrentEpoch(agent, msg.state)) return;
  chatAgentTasks.set(msg.watcherId, { agent, status: msg, revision: Number(msg.chat_revision) || 0 });
  // Keep recent completions bounded; durable history is the source on reload.
  const finished = [...chatAgentTasks].filter(([, entry]) => entry.status.final);
  for (const [key] of finished.slice(0, Math.max(0, finished.length - 100))) chatAgentTasks.delete(key);
  updateChatAgents();
}

function reconcileChatAgents(tasks, revisions = {}) {
  const next = new Map();
  for (const task of (Array.isArray(tasks) ? tasks : [])) {
    const status = activeBackgroundTaskStatus(task);
    const agent = chatAgentScope(task.visibleAgentId || task.state?.visibleAgentId || task.agentId);
    if (status && agent && chatAgentCurrentEpoch(agent, status.state)) {
      next.set(status.watcherId, { agent, status, revision: Number(revisions[agent]) || 0 });
    }
  }
  for (const [key, entry] of chatAgentTasks) {
    // Do not let an older in-flight snapshot undo a newer live transition.
    if (entry.status.final || entry.revision > (Number(revisions[entry.agent]) || 0)) next.set(key, entry);
  }
  chatAgentTasks.clear();
  for (const [key, entry] of next) chatAgentTasks.set(key, entry);
  chatAgentsConnected = true;
  updateChatAgents();
}

function resetChatAgents(agent) {
  if (agent) {
    for (const [key, entry] of chatAgentTasks) if (entry.agent === agent) chatAgentTasks.delete(key);
    chatAgentHistory.delete(agent);
    chatAgentCompletedTasks.delete(agent);
  } else {
    chatAgentTasks.clear();
    chatAgentHistory.clear();
    chatAgentCompletedTasks.clear();
    chatAgentsConnected = false;
    closeChatAgents(false);
  }
  updateChatAgents();
}

function loadChatAgentHistory(agent, completedTasks, snapshotRevision = 0) {
  const completed = new Map();
  const userId = typeof _currentUser !== 'undefined' ? _currentUser?.id : null;
  const epoch = typeof agentSessionEpochs !== 'undefined' ? agentSessionEpochs[agent] : null;
  for (const status of (Array.isArray(completedTasks) ? completedTasks : [])) {
    if (status?.kind !== 'task_proxy' || status.final !== true || !status.watcherId
        || !TASK_CHIP_TERMINAL_STATES.has(status.state?.status)) continue;
    // A completed snapshot is accepted only for this exact chat incarnation.
    // Historical records never supply live work or cross a user/profile clear.
    const projectSuffix = typeof activeProjectSpaceId === 'string' && activeProjectSpaceId ? `__${activeProjectSpaceId}` : '';
    if (!userId || !epoch || status.state.sourceSessionKey !== `${userId}_${agent}${projectSuffix}`
        || status.state.sourceSessionEpoch !== epoch
        || chatAgentScope(status.agent || status.state.visibleAgentId) !== agent) continue;
    completed.set(status.watcherId, {
      status: { ...status, state: { ...status.state, canCancel: false, currentTool: null } },
      revision: Number(snapshotRevision) || 0,
    });
    const live = chatAgentTasks.get(status.watcherId);
    if (live?.agent === agent && !live.status.final && live.revision <= (Number(snapshotRevision) || 0)) {
      // Once authoritative history confirms completion, an obsolete running
      // entry must not reappear when this recent-history window later expires.
      chatAgentTasks.delete(status.watcherId);
    }
  }
  chatAgentCompletedTasks.set(agent, completed);
  chatAgentHistory.add(agent);
  updateChatAgents();
}

function setChatAgentsConnected(connected) {
  chatAgentsConnected = connected;
  updateChatAgents();
}

// An explicit history request can arrive after the reconnect task snapshot.
// Keep its live cards when replacing conversation rows with durable history.
function restoreChatAgentTaskRows(agent) {
  const rows = sessions[agent];
  if (!Array.isArray(rows)) return;
  for (const entry of chatAgentTasks.values()) {
    if (entry.agent !== agent || entry.status.final || !chatAgentCurrentEpoch(agent, entry.status.state)) continue;
    if (rows.some(row => row.role === 'status' && row.status?.watcherId === entry.status.watcherId)) continue;
    rows.push({ role: 'status', status: entry.status, content: `[Status: ${entry.status.text}]`,
      ts: entry.status.state?.startedAt || Date.now(), _activeTaskSnapshot: true });
  }
}

function chatAgentModel(state) {
  const runtime = taskChipText(state.runtimeModel, 300);
  const configured = taskChipText(state.model, 300);
  const provider = taskChipText(runtime ? state.runtimeProvider : state.provider, 100);
  if (!runtime && !configured) return 'Model not reported';
  return `${runtime || configured}${provider ? ` · ${provider}` : ''}${runtime ? '' : ' · configured'}`;
}

function chatAgentRows() {
  const entries = new Map();
  // Retain the most recent completed delegations after a reload.
  for (const row of (chatAgentHistory.has(activeAgent) ? sessions[activeAgent] || [] : [])) {
    if (row?.hidden || row?.status?.kind !== 'task_proxy' || !row.status.final) continue;
    if (chatAgentCurrentEpoch(activeAgent, row.status.state)) entries.set(row.status.watcherId, {
      status: row.status, revision: Number(row._liveRevision) || 0,
    });
  }
  for (const [key, entry] of (chatAgentHistory.has(activeAgent) ? chatAgentCompletedTasks.get(activeAgent) || [] : [])) {
    if (chatAgentCurrentEpoch(activeAgent, entry.status.state)) entries.set(key, entry);
  }
  for (const [key, entry] of chatAgentTasks) {
    if (entry.agent !== activeAgent || !chatAgentCurrentEpoch(activeAgent, entry.status.state)) continue;
    const prior = entries.get(key);
    // Equal-revision live finals retain their detail; terminal history wins
    // over an equally old running entry, including legacy revision-zero data.
    if (!prior || entry.revision > prior.revision || (entry.status.final && entry.revision === prior.revision)) entries.set(key, entry);
  }
  const statuses = [...entries.values()].map(entry => entry.status).sort((a, b) => Number(!!a.final) - Number(!!b.final)
    || (Number(b.state?.startedAt) || 0) - (Number(a.state?.startedAt) || 0));
  const rows = [];
  const seen = new Set();
  let completed = 0;
  for (const status of statuses) {
    if (status.final && ++completed > 20) continue;
    const state = status.state || {};
    const view = taskChipViewModel(status);
    const rootId = state.taskId || status.watcherId;
    const rootActive = !status.final && !TASK_CHIP_TERMINAL_STATES.has(state.status);
    const add = row => { if (!seen.has(row.id)) { rows.push(row); seen.add(row.id); } };
    add({
      id: rootId, name: view.agentPart, assignment: view.taskPart,
      model: chatAgentModel(state), active: rootActive, depth: 0,
      status: status.final ? view.phaseText : taskChipPhase(status),
      activity: status.final ? view.phaseText : (state.currentTool ? `Using ${taskChipToolLabel(state.currentTool)}` : '')
        || taskChipText(state.activity, 200) || view.phaseText,
      visualState: view.visualState,
    });
    for (const child of view.children) {
      const active = rootActive && !TASK_CHIP_TERMINAL_STATES.has(child.status);
      add({
        id: child.id, name: child.name, assignment: child.detail,
        model: chatAgentModel(child), active, depth: child.depth + 1,
        status: !active && !TASK_CHIP_TERMINAL_STATES.has(child.status) ? 'Last reported' : taskChipPhase({ state: child, final: !active, finalStatus: taskChipStateClass(child.status) }),
        activity: active && child.currentTool ? `Using ${taskChipToolLabel(child.currentTool)}` : child.action || child.phase,
        visualState: active ? 'running' : taskChipStateClass(child.status),
      });
    }
  }
  return rows;
}

function updateChatAgents() {
  const toggle = $('chatAgentsToggle');
  const panel = $('chatAgentsPanel');
  if (!toggle || !panel) return;
  const rows = chatAgentRows();
  const running = rows.filter(row => row.active).length;
  const count = $('chatAgentsCount');
  count.textContent = String(running);
  count.hidden = running === 0;
  toggle.setAttribute('aria-label', `Agents in this chat${running ? `, ${running} ${chatAgentsConnected ? 'active' : 'last active'}` : ''}`);
  toggle.classList.toggle('has-active-agents', running > 0 && chatAgentsConnected);
  if (panel.hidden) return;
  const chatName = taskChipText(agents.find(agent => agent.id === activeAgent)?.name, 100) || 'This chat';
  const summary = chatAgentsConnected
    ? `${chatName} · ${running} active${rows.some(row => !row.active) ? ' · recent tasks below' : ''}`
    : `${chatName} · Reconnecting — showing last known activity`;
  if ($('chatAgentsSummary').textContent !== summary) $('chatAgentsSummary').textContent = summary;
  $('chatAgentsEmpty').hidden = rows.length > 0;
  const list = $('chatAgentsList');
  const existing = new Map([...list.children].map(el => [el.dataset.taskId, el]));
  for (const row of rows) {
    let el = existing.get(row.id);
    if (!el) {
      el = document.createElement('article');
      el.className = 'chat-agent-row';
      el.dataset.taskId = row.id;
      el.setAttribute('role', 'listitem');
      for (const field of ['name', 'status', 'model', 'assignment', 'activity']) {
        const part = document.createElement('div');
        part.className = `chat-agent-${field}`;
        el.appendChild(part);
      }
    }
    existing.delete(row.id);
    el.dataset.status = row.active && !chatAgentsConnected ? 'unknown' : row.visualState;
    el.style.setProperty('--agent-depth', String(Math.min(row.depth, 3)));
    for (const field of ['name', 'status', 'model', 'assignment', 'activity']) {
      const part = el.querySelector(`.chat-agent-${field}`);
      const value = field === 'status' && row.active && !chatAgentsConnected ? 'Last known'
        : field === 'activity' && row.activity === row.status ? '' : row[field];
      if (part.textContent !== value) part.textContent = value;
      part.hidden = !value;
    }
    list.appendChild(el);
  }
  for (const el of existing.values()) el.remove();
}

function closeChatAgents(restoreFocus = true) {
  const panel = $('chatAgentsPanel');
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  $('chatAgentsToggle').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('chatAgentsToggle').focus();
}

$('chatAgentsToggle')?.addEventListener('click', () => {
  if (!$('chatAgentsPanel').hidden) return closeChatAgents();
  $('chatAgentsPanel').hidden = false;
  $('chatAgentsToggle').setAttribute('aria-expanded', 'true');
  updateChatAgents();
  $('chatAgentsClose').focus();
});
$('chatAgentsClose')?.addEventListener('click', () => closeChatAgents());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('chatAgentsPanel')?.hidden) {
    event.preventDefault();
    closeChatAgents();
  }
});
document.addEventListener('pointerdown', event => {
  if (!$('chatAgentsPanel')?.hidden && !$('chatAgentsPanel')?.contains(event.target)
      && !$('chatAgentsToggle')?.contains(event.target)) closeChatAgents(false);
});
