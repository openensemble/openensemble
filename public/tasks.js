// ── Tasks ─────────────────────────────────────────────────────────────────────
let tasks = [];
let watchers = { active: [], recent: [] };
let expandedTaskId = null;
let expandedWatcherId = null;
let expandedNodeHealthId = null;
let expandedHistoryId = null;
const watcherDetails = new Map();
const nodeHealthDetails = new Map();
const taskHistoryDetails = new Map();

const _DOW_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function _parseCronDow(spec) {
  if (!spec || spec === '*') return null;
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const range = part.trim().match(/^(\d)-(\d)$/);
    if (range) {
      const a = +range[1], b = +range[2];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (let d = lo; d <= hi; d++) out.add(d % 7);
      continue;
    }
    if (/^\d$/.test(part.trim())) out.add(+part.trim() % 7);
  }
  return out.size ? out : null;
}
// Mirror of scheduler.mjs:formatTaskCadence — kept in sync so the UI doesn't
// flatten "Mon/Wed/Fri" reminders to "daily".
function _formatIntervalText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'every ?';
  const totalMin = Math.max(1, Math.round(n / 60000));
  if (totalMin < 60) return `every ${totalMin} min`;
  if (totalMin % 60 === 0) {
    const h = totalMin / 60;
    if (h % 24 === 0) { const d = h / 24; return `every ${d} day${d > 1 ? 's' : ''}`; }
    return `every ${h} hour${h > 1 ? 's' : ''}`;
  }
  return `every ${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}
function formatTaskCadenceText(t) {
  if (t.repeat === 'interval') return _formatIntervalText(t.intervalMs);
  const time = t.time || '?';
  const dow = t.dow;
  if (dow && dow !== '*') {
    if (dow === '1-5') return `${time} weekdays`;
    if (dow === '0,6' || dow === '6,0') return `${time} weekends`;
    const days = _parseCronDow(dow);
    if (days && days.size) {
      const ordered = [...days].sort((a, b) => a - b).map(d => _DOW_NAMES_SHORT[d]);
      return `${time} ${ordered.join('/')}`;
    }
  }
  if (t.weekdaysOnly) return `${time} weekdays`;
  if (t.weekendsOnly) return `${time} weekends`;
  return `${time} daily`;
}
function formatTaskCadenceLabel(t) {
  const dow = t.dow;
  if (dow && dow !== '*') {
    if (dow === '1-5') return 'Weekdays at';
    if (dow === '0,6' || dow === '6,0') return 'Weekends at';
    const days = _parseCronDow(dow);
    if (days && days.size) {
      const ordered = [...days].sort((a, b) => a - b).map(d => _DOW_NAMES_SHORT[d]);
      return `${ordered.join('/')} at`;
    }
  }
  if (t.weekdaysOnly) return 'Weekdays at';
  if (t.weekendsOnly) return 'Weekends at';
  return 'Daily at';
}

async function loadTaskList() {
  try { const r = await fetch('/api/tasks'); tasks = await r.json(); } catch { tasks = []; }
  try {
    const r = await fetch('/api/watchers');
    watchers = await r.json();
    if (!watchers || typeof watchers !== 'object') watchers = { active: [], recent: [] };
    if (!Array.isArray(watchers.active)) watchers.active = [];
    if (!Array.isArray(watchers.recent)) watchers.recent = [];
  } catch { watchers = { active: [], recent: [] }; }
  renderTasks(); updateTasksBadge();
}

// Trailing-debounced wrapper for high-frequency callers. The WS status
// handler fires once per tool_progress chunk, and each loadTaskList call is
// two fetches + a full drawer re-render — a request-per-second loop during
// any streaming delegation, even with the drawer closed. Structural
// transitions (a watcher finishing) refresh immediately.
let _taskListDebounce = null;
function loadTaskListSoon({ immediate = false } = {}) {
  if (immediate) {
    clearTimeout(_taskListDebounce); _taskListDebounce = null;
    loadTaskList();
    return;
  }
  if (_taskListDebounce) return;
  _taskListDebounce = setTimeout(() => { _taskListDebounce = null; loadTaskList(); }, 2000);
}

// Format a "time ago" / "time until" tail for the watcher meta row.
function _watcherEtaText(w) {
  if (w.expiresAt === null || w.expiresAt === undefined) return 'indefinite';
  const ms = w.expiresAt - Date.now();
  if (ms <= 0) return 'expired';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `expires in ${m}m`;
  const h = Math.floor(m / 60);
  return `expires in ${h}h${m%60 ? ' ' + (m%60) + 'm' : ''}`;
}

function renderWatcherHealthDetails(w, detail) {
  if (w.kind !== 'profile_health') return '';
  if (!detail) return '<div class="task-edit-meta" style="margin-top:8px">Loading health details…</div>';
  if (detail.error) return `<div class="task-edit-meta" style="margin-top:8px;color:var(--red)">Could not load health details: ${escHtml(detail.error)}</div>`;
  return OENodeHealthView.renderNodeHealthWatchers([detail]);
}

function renderWatcherRow(w) {
  const isOpen = expandedWatcherId === w.id;
  const expandToggle = isOpen ? '▾' : '▸';
  const isIndefinite = w.expiresAt === null || w.expiresAt === undefined;
  const dot = isIndefinite ? `<span class="watcher-dot" title="Indefinite — click to dismiss" data-action="cancelWatcher" data-args='${JSON.stringify([w.id]).replace(/'/g, "&#39;")}' data-stop-propagation style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:6px;cursor:pointer"></span>` : '';
  const status = w.lastStatusText || 'waiting for first tick…';
  const meta = `${escHtml(w.kind)} · ${_watcherEtaText(w)}${w.ticks ? ' · tick ' + w.ticks : ''}`;
  const header = `
    <div class="task-item${isOpen ? ' task-item-open' : ''}" data-watcher="${escHtml(w.id)}">
      <div class="task-item-info" data-action="toggleWatcherExpanded" data-args='${JSON.stringify([w.id]).replace(/'/g, "&#39;")}' title="Click to view / adjust" style="cursor:pointer">
        <div class="task-item-label">${dot}${expandToggle} 📡 ${escHtml(w.label || w.kind)}</div>
        <div class="task-item-meta" style="font-style:italic">${escHtml(status)}</div>
        <div class="task-item-meta">${meta}</div>
      </div>
      <button class="btn-task-del" data-action="cancelWatcher" data-args='${JSON.stringify([w.id]).replace(/'/g, "&#39;")}' title="Cancel watcher">✕</button>
    </div>`;
  if (!isOpen) return header;
  const presets = [
    { label: '15 min', ms: 15*60*1000 },
    { label: '1 hour', ms: 60*60*1000 },
    { label: '4 hours', ms: 4*60*60*1000 },
    { label: '24 hours', ms: 24*60*60*1000 },
  ].map(p => `<button data-action="extendWatcher" data-args='${JSON.stringify([w.id, p.ms]).replace(/'/g, "&#39;")}' style="margin-right:6px">${p.label}</button>`).join('');
  const indefBtn = isIndefinite
    ? ''
    : `<button data-action="setWatcherIndefinite" data-args='${JSON.stringify([w.id]).replace(/'/g, "&#39;")}' style="margin-right:6px">make indefinite</button>`;
  const detail = watcherDetails.get(w.id);
  const healthDetails = renderWatcherHealthDetails(w, detail);
  const editor = `
    <div class="task-edit-panel">
      <div class="task-edit-meta">Started: ${new Date(w.createdAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</div>
      <div class="task-edit-meta">Cadence: every ${w.cadenceSec}s</div>
      ${w.expiresAt ? `<div class="task-edit-meta">Expires: ${new Date(w.expiresAt).toLocaleString()}</div>` : '<div class="task-edit-meta">Expires: indefinite</div>'}
      ${healthDetails}
      <div style="margin-top:8px;font-size:12px;color:var(--muted)">Extend by:</div>
      <div style="margin-top:4px">${presets}${indefBtn}</div>
    </div>`;
  return header + editor;
}

function toggleWatcherExpanded(id) {
  expandedWatcherId = expandedWatcherId === id ? null : id;
  renderTasks();
  if (expandedWatcherId === id && !watcherDetails.has(id)) {
    loadWatcherDetail(id);
  }
}

async function loadWatcherDetail(id) {
  try {
    const r = await fetch(`/api/watchers/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    watcherDetails.set(id, await r.json());
  } catch (e) {
    watcherDetails.set(id, { error: e.message });
  }
  renderTasks();
}

function nodeIdForWatcher(w) {
  return w.state?.node_id || (w.label || '').match(/@([^ ]+)/)?.[1] || 'unknown';
}

function renderNodeHealthGroup(nodeId, groupWatchers) {
  const isOpen = expandedNodeHealthId === nodeId;
  const failing = groupWatchers.reduce((n, w) => n + (Array.isArray(w.state?.signals) ? w.state.signals.filter(s => s.last_state === 'unhealthy').length : 0), 0);
  const totalSignals = groupWatchers.reduce((n, w) => n + (Array.isArray(w.state?.signals) ? w.state.signals.length : 0), 0);
  const meta = totalSignals ? `${totalSignals - failing}/${totalSignals} signals ok${failing ? ` · ${failing} failing` : ''}` : `${groupWatchers.length} monitor(s)`;
  const header = `
    <div class="task-item${isOpen ? ' task-item-open' : ''}">
      <div class="task-item-info" data-action="toggleNodeHealthGroup" data-args='${JSON.stringify([nodeId]).replace(/'/g, "&#39;")}' title="Click to view node health signals" style="cursor:pointer">
        <div class="task-item-label">${isOpen ? '▾' : '▸'} 🖥️ ${escHtml(nodeId)}</div>
        <div class="task-item-meta" style="font-style:italic">${escHtml(meta)}</div>
      </div>
    </div>`;
  if (!isOpen) return header;
  const detail = nodeHealthDetails.get(nodeId);
  let body;
  if (!detail) {
    body = '<div class="task-edit-panel"><div class="task-edit-meta">Loading node health…</div></div>';
  } else if (detail.error) {
    body = `<div class="task-edit-panel"><div class="task-edit-meta" style="color:var(--red)">Could not load node health: ${escHtml(detail.error)}</div></div>`;
  } else {
    body = `<div class="task-edit-panel">${OENodeHealthView.renderNodeOpsView(detail)}</div>`;
  }
  return header + body;
}

function toggleNodeHealthGroup(nodeId) {
  expandedNodeHealthId = expandedNodeHealthId === nodeId ? null : nodeId;
  renderTasks();
  if (expandedNodeHealthId === nodeId && !nodeHealthDetails.has(nodeId)) {
    loadNodeHealthDetail(nodeId);
  }
}

async function loadNodeHealthDetail(nodeId) {
  try {
    const r = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/health`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    nodeHealthDetails.set(nodeId, await r.json());
  } catch (e) {
    nodeHealthDetails.set(nodeId, { error: e.message });
  }
  renderTasks();
}

async function cancelWatcher(id) {
  if (!confirm('Stop monitoring this?')) return;
  await fetch(`/api/watchers/${id}`, { method: 'DELETE' });
  await loadTaskList();
}

async function extendWatcher(id, addMs) {
  await fetch(`/api/watchers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresAt: Date.now() + addMs }),
  });
  expandedWatcherId = null;
  await loadTaskList();
}

async function setWatcherIndefinite(id) {
  await fetch(`/api/watchers/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresAt: null }),
  });
  expandedWatcherId = null;
  await loadTaskList();
}

function _toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Shared local-time formatter for the drawer — accepts an ISO string
// (nextRunAt, datetime) or an epoch-ms number (run-history ts/firedAt) since
// `new Date(...)` accepts both. Mirrors the {month:'short', day:'numeric',
// hour:'2-digit', minute:'2-digit'} formatting already used throughout this
// file for task times so "Next:" and history rows read consistently with
// the rest of the drawer.
function _friendlyLocalTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// One row of GET /api/tasks/:id/runs — {ts, taskId, taskName, scheduledFor,
// firedAt, status:'ok'|'error'|'skipped'|'late', lateByMs?, error?, manual?}.
function _renderRunRow(run) {
  const when = _friendlyLocalTime(run.firedAt ?? run.ts) || '?';
  let statusText;
  if (run.status === 'ok') statusText = '✓ ok';
  else if (run.status === 'error') statusText = `⚠ error${run.error ? ' — ' + String(run.error).slice(0, 140) : ''}`;
  else if (run.status === 'skipped') statusText = `⊘ ${String(run.error || 'skipped').slice(0, 140)}`;
  else if (run.status === 'late') statusText = `⏰ late${run.lateByMs != null ? ' +' + Math.max(1, Math.round(run.lateByMs / 60000)) + 'm' : ''}`;
  else statusText = String(run.status || '?');
  const manualTag = run.manual ? ' <span style="opacity:.7">(manual)</span>' : '';
  return `<div class="task-edit-meta">${escHtml(when)} — ${escHtml(statusText)}${manualTag}</div>`;
}

function renderTaskHistoryPanel(taskId) {
  const detail = taskHistoryDetails.get(taskId);
  if (!detail) return '<div class="task-edit-meta">Loading history…</div>';
  if (detail.error) return `<div class="task-edit-meta" style="color:var(--red)">Could not load history: ${escHtml(detail.error)}</div>`;
  const runs = detail.runs || [];
  if (!runs.length) return '<div class="task-edit-meta">No runs yet.</div>';
  return `<div style="margin-top:2px">${runs.map(_renderRunRow).join('')}</div>`;
}

function renderTaskRow(t) {
  const schedStr = t.repeat === 'once'
    ? (t.datetime ? '1× ' + new Date(t.datetime).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '1× (no time set)')
    : `🔁 ${formatTaskCadenceText(t)}`;
  const statusSuffix = (t.repeat === 'once' && !t.enabled && t.lastRun) ? ' · ✓ done' : (t.lastRun ? ' · last run ' + new Date(t.lastRun).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '');
  const isReminder = t.type === 'reminder';
  const runner = isReminder ? '🔔 Reminder' : (agents.find(a=>a.id===t.agent)?.name ?? t.agent);
  const silentBadge = t.silent ? '🔕 ' : '';
  // For silent tasks the tasks drawer is the only feedback channel — surface
  // last run's reply (lastOutput) or error (lastError) so the user knows the
  // run actually did something.
  const silentTail = t.silent && (t.lastOutput || t.lastError)
    ? `<div class="task-item-meta" style="color:${t.lastError ? 'var(--red)' : 'var(--muted)'};font-style:italic;margin-top:2px">${t.lastError ? '⚠ ' + escHtml(t.lastError) : escHtml(t.lastOutput)}</div>`
    : '';
  const isOpen = expandedTaskId === t.id;
  const expandToggle = isOpen ? '▾' : '▸';
  // Next-fire time — null-guarded since disabled tasks (and tasks the
  // scheduler hasn't armed yet) carry nextRunAt: null.
  const nextText = t.nextRunAt ? _friendlyLocalTime(t.nextRunAt) : null;
  const nextLine = nextText ? `<div class="task-item-meta">Next: ${escHtml(nextText)}</div>` : '';
  // Cross-fire failure streak — only worth a warning once it's more than a
  // single blip (matches MAX_CONSECUTIVE_FAILURES auto-disable semantics in
  // scheduler.mjs, which also resets this to 0 on any success).
  const failCount = Number(t.consecutiveFailures) || 0;
  const failWarn = failCount > 1
    ? `<div class="task-item-meta" style="color:var(--red)" title="${escHtml(t.lastError || '')}">⚠ ${failCount} failed in a row</div>`
    : '';
  // Run-history affordance: lazy-fetched on open, independent of the
  // edit-expand toggle above so it's reachable without opening the editor.
  // data-stop-propagation keeps the click off the enclosing toggleTaskExpanded
  // area (matches the watcher-dot pattern in renderWatcherRow).
  const isHistOpen = expandedHistoryId === t.id;
  const historyToggle = `<button data-action="toggleTaskHistory" data-args='${JSON.stringify([t.id]).replace(/'/g, "&#39;")}' data-stop-propagation style="margin-top:4px;font-size:11px;background:none;border:1px solid var(--border);color:var(--muted);padding:2px 8px;border-radius:5px;cursor:pointer">${isHistOpen ? '▾' : '▸'} History</button>`;
  const historyPanel = isHistOpen ? renderTaskHistoryPanel(t.id) : '';
  // The header row: clicking the info area toggles the expanded view.
  // Edit/toggle/delete buttons remain accessible without expanding first.
  const header = `
    <div class="task-item${isOpen ? ' task-item-open' : ''}">
      <div class="task-item-info" data-action="toggleTaskExpanded" data-args='${JSON.stringify([t.id]).replace(/'/g, "&#39;")}' title="Click to view / edit details" style="cursor:pointer">
        <div class="task-item-label">${expandToggle} ${silentBadge}${escHtml(t.label)}</div>
        <div class="task-item-meta">${schedStr} · ${runner}${statusSuffix}</div>
        ${silentTail}
        ${nextLine}
        ${failWarn}
        ${historyToggle}
        ${historyPanel}
      </div>
      ${t.repeat === 'once' && !t.enabled ? '<span style="font-size:11px;color:var(--green)">✓</span>' : `<input type="checkbox" class="task-toggle" ${t.enabled ? 'checked' : ''} data-change-action="toggleTask" data-change-args='${JSON.stringify([t.id, "$checked"]).replace(/'/g, "&#39;")}'>`}
      <button class="btn-task-del" data-action="deleteTask" data-args='${JSON.stringify([t.id]).replace(/'/g, "&#39;")}'>✕</button>
    </div>`;
  if (!isOpen) return header;

  // Expanded detail / editor. Reminder tasks don't have an agent or prompt;
  // agent tasks expose those fields.
  const agentOptions = agents.map(a => `<option value="${escHtml(a.id)}"${a.id===t.agent?' selected':''}>${escHtml(a.emoji||'')} ${escHtml(a.name)}</option>`).join('');
  const timeField = t.repeat === 'once'
    ? `<label>When<input type="datetime-local" id="te-dt-${escHtml(t.id)}" value="${_toLocalInputValue(t.datetime)}"></label>`
    : t.repeat === 'interval'
    ? `<label>Run every (minutes)<input type="number" min="1" step="1" id="te-iv-${escHtml(t.id)}" value="${escHtml(String(Math.max(1, Math.round((t.intervalMs||3600000)/60000))))}"></label>`
    : `<label>${escHtml(formatTaskCadenceLabel(t))}<input type="time" id="te-tm-${escHtml(t.id)}" value="${escHtml(t.time||'09:00')}"></label>`;
  const agentBlock = isReminder ? '' : `
      <label>Runner
        <select id="te-ag-${escHtml(t.id)}">${agentOptions}</select>
      </label>
      <label>Prompt (what to ask the agent at fire time)
        <textarea id="te-pr-${escHtml(t.id)}" rows="3">${escHtml(t.prompt||'')}</textarea>
      </label>
      <label style="flex-direction:row;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;align-self:flex-start">
        <input type="checkbox" id="te-si-${escHtml(t.id)}" ${t.silent ? 'checked' : ''} style="margin:0;padding:0;width:auto;background:transparent;border:none;appearance:auto">
        Silent — run without showing in chat
      </label>`;
  const lastOutput = t.lastOutput ? `<div class="task-edit-meta">Last run: ${escHtml(String(t.lastOutput).slice(0, 200))}</div>` : '';
  const editor = `
    <div class="task-edit-panel">
      <label>Label<input type="text" id="te-lb-${escHtml(t.id)}" value="${escHtml(t.label||'')}"></label>
      ${timeField}
      ${agentBlock}
      ${lastOutput}
      <div class="task-edit-actions">
        <button class="btn-task-save" data-action="saveTaskEdits" data-args='${JSON.stringify([t.id]).replace(/'/g, "&#39;")}'>Save</button>
        ${isReminder ? '' : `<button class="btn-task-run" data-action="runTaskNow" data-args='${JSON.stringify([t.id]).replace(/'/g, "&#39;")}' title="Run this task once right now to test it">▶ Run now</button>`}
        <button class="btn-task-cancel" data-action="toggleTaskExpanded" data-args='${JSON.stringify([t.id]).replace(/'/g, "&#39;")}'>Cancel</button>
      </div>
    </div>`;
  return header + editor;
}

function renderTasks() {
  // Two sections: scheduled tasks (cron / one-shot) and active monitors
  // (watchers). They're related but distinct primitives — see
  // scheduler/watchers.mjs for the design rationale.
  const sectionHeader = (label) => `<div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin:8px 4px 4px">${label}</div>`;

  const tasksHtml = tasks.length
    ? tasks.map(renderTaskRow).join('')
    : '<em style="color:var(--muted);font-size:13px">No scheduled tasks.</em>';

  const activeWatchers = watchers.active || [];
  const recentWatchers = watchers.recent || [];

  // Per-node profile_health watchers (one per attached node) crowd out
  // everything else when more than a few nodes are paired. Group them under
  // a single collapsible header so the section reads as "node health: 5
  // nodes" instead of five separate rows competing with real monitors.
  const nodeWatchers = activeWatchers.filter(w => w.kind === 'profile_health');
  const otherWatchers = activeWatchers.filter(w => w.kind !== 'profile_health');

  let watchersHtml = '';
  if (nodeWatchers.length) {
    const nodeGroups = new Map();
    for (const w of nodeWatchers) {
      const nodeId = nodeIdForWatcher(w);
      if (!nodeGroups.has(nodeId)) nodeGroups.set(nodeId, []);
      nodeGroups.get(nodeId).push(w);
    }
    watchersHtml += [...nodeGroups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([nodeId, group]) => renderNodeHealthGroup(nodeId, group))
      .join('');
  }
  watchersHtml += otherWatchers.map(renderWatcherRow).join('');
  if (!watchersHtml) {
    watchersHtml = '<em style="color:var(--muted);font-size:13px">No active monitors.</em>';
  }

  const recentHtml = recentWatchers.length
    ? recentWatchers.slice(0, 5).map(w => {
        const icon = w.status === 'done' ? '✓' : w.status === 'error' ? '⚠' : w.status === 'expired' ? '⏰' : '✕';
        const ago = w.endedAt ? Math.round((Date.now() - w.endedAt) / 60000) + 'm ago' : '';
        return `<div class="task-item" style="opacity:0.55"><div class="task-item-info"><div class="task-item-label" style="font-weight:normal">${icon} ${escHtml(w.label || w.kind)}</div><div class="task-item-meta">${escHtml(w.lastStatusText || w.status)} · ${ago}</div></div></div>`;
      }).join('')
    : '';

  const html =
    sectionHeader('⏰ Scheduled tasks') + tasksHtml +
    sectionHeader('📡 Active monitors') + watchersHtml +
    (recentHtml ? sectionHeader('Recent') + recentHtml : '');

  const list = $('taskList');
  if (list) list.innerHTML = html;
  const settingsList = $('settingsTaskList');
  if (settingsList) settingsList.innerHTML = html;
}

function toggleTaskExpanded(id) {
  expandedTaskId = expandedTaskId === id ? null : id;
  renderTasks();
}

// Toggle the per-task run-history panel. Refetches every time it's opened
// (simpler than tracking staleness — history rows accumulate between opens
// and this endpoint is only hit on an explicit click) by dropping any cached
// detail first so the panel shows "Loading…" instead of a stale list.
function toggleTaskHistory(id) {
  expandedHistoryId = expandedHistoryId === id ? null : id;
  if (expandedHistoryId === id) {
    taskHistoryDetails.delete(id);
    renderTasks();
    loadTaskHistory(id);
  } else {
    renderTasks();
  }
}

async function loadTaskHistory(id) {
  try {
    const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/runs`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    // GET /api/tasks/:id/runs responds with a bare array of run rows (see
    // routes/misc.mjs), not {runs:[...]} — guarded here in case that shape
    // ever changes.
    const runs = Array.isArray(data) ? data : (Array.isArray(data?.runs) ? data.runs : []);
    taskHistoryDetails.set(id, { runs });
  } catch (e) {
    taskHistoryDetails.set(id, { error: e.message });
  }
  renderTasks();
}

async function saveTaskEdits(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  const patch = {};
  const lb = document.getElementById(`te-lb-${id}`);
  if (lb && lb.value.trim() && lb.value.trim() !== t.label) patch.label = lb.value.trim();
  if (t.repeat === 'once') {
    const dt = document.getElementById(`te-dt-${id}`);
    if (dt && dt.value) {
      const d = new Date(dt.value);
      if (Number.isNaN(d.getTime())) { alert('Invalid date/time.'); return; }
      if (d.getTime() < Date.now() + 5000) { alert('That time is in the past.'); return; }
      const iso = d.toISOString();
      if (iso !== t.datetime) patch.datetime = iso;
    }
  } else if (t.repeat === 'interval') {
    const iv = document.getElementById(`te-iv-${id}`);
    if (iv && iv.value) {
      const mins = Math.round(Number(iv.value));
      if (!Number.isFinite(mins) || mins < 1) { alert('Interval must be at least 1 minute.'); return; }
      const ms = mins * 60000;
      if (ms !== t.intervalMs) patch.intervalMs = ms;
    }
  } else {
    const tm = document.getElementById(`te-tm-${id}`);
    if (tm && /^\d{1,2}:\d{2}$/.test(tm.value) && tm.value !== t.time) patch.time = tm.value;
  }
  if (t.type !== 'reminder') {
    const ag = document.getElementById(`te-ag-${id}`);
    if (ag && ag.value && ag.value !== t.agent) patch.agent = ag.value;
    const pr = document.getElementById(`te-pr-${id}`);
    if (pr && pr.value !== (t.prompt||'')) patch.prompt = pr.value;
    const si = document.getElementById(`te-si-${id}`);
    if (si && !!si.checked !== !!t.silent) patch.silent = !!si.checked;
  }
  if (!Object.keys(patch).length) { expandedTaskId = null; renderTasks(); return; }
  const r = await fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  if (!r.ok) { alert('Update failed.'); return; }
  expandedTaskId = null;
  await loadTaskList();
}

// Let the user correct a mis-parsed scheduled time. One-shot tasks get a
// datetime-local prompt; daily tasks get an HH:MM prompt. Intentionally
// minimal UI (window.prompt) — the common case is "the plan model got today
// when I said tomorrow, let me nudge it" and that doesn't justify a modal.
async function editTaskTime(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  if (t.repeat === 'once') {
    const current = t.datetime ? new Date(t.datetime) : new Date(Date.now() + 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    const defaultVal = `${current.getFullYear()}-${pad(current.getMonth() + 1)}-${pad(current.getDate())}T${pad(current.getHours())}:${pad(current.getMinutes())}`;
    const input = prompt(`When should "${t.label}" fire?\n(YYYY-MM-DDTHH:MM in your local time)`, defaultVal);
    if (!input) return;
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) { alert('Invalid date/time.'); return; }
    if (d.getTime() < Date.now() + 5000) { alert('That time is in the past.'); return; }
    const r = await fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ datetime: d.toISOString() }) });
    if (!r.ok) { alert('Update failed.'); return; }
  } else {
    const input = prompt(`Daily fire time for "${t.label}" (HH:MM, 24-hour):`, t.time || '09:00');
    if (!input) return;
    if (!/^\d{1,2}:\d{2}$/.test(input.trim())) { alert('Use HH:MM format.'); return; }
    const r = await fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ time: input.trim() }) });
    if (!r.ok) { alert('Update failed.'); return; }
  }
  await loadTaskList();
}

function updateTasksBadge() {
  const tCount = tasks.filter(t => t.enabled).length;
  const wCount = (watchers.active || []).length;
  const count = tCount + wCount;
  const badge = $('tasksBadge');
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
  // Also update mobile drawer label
  const lbl = $('drawerTasksLabel');
  if (lbl) lbl.innerHTML = `Tasks${count ? ` <span class="task-badge">${count}</span>` : ''}`;
}

async function toggleTask(id, enabled) {
  await fetch(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }), headers: { 'Content-Type': 'application/json' } });
  await loadTaskList();
}
async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  await loadTaskList();
}

// Run a task once, right now, to test it. The server fires it out of band
// (doesn't disturb the schedule, delete a one-shot, or count failures). The
// run streams into the agent's chat session like a scheduled fire.
async function runTaskNow(id) {
  const btn = document.querySelector(`.btn-task-run[data-args*='"${id}"']`);
  const restore = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '▶ Running…'; }
  try {
    const r = await fetch(`/api/tasks/${id}/run`, { method: 'POST' });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
    if (btn) btn.textContent = '✓ Started — check chat';
    // Give the run a moment, then refresh so the "Last run" line updates.
    setTimeout(() => loadTaskList(), 2500);
  } catch (e) {
    alert(`Run failed: ${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = restore; }
  }
}

function openTasksDrawer(openIt = true) {
  if (openIt) toggleDrawer('drawerTasks', 'sbtnTasks');
  $('tAgent').innerHTML = agents.map(a => `<option value="${a.id}">${a.emoji} ${a.name}</option>`).join('');
  loadTaskList();
}

async function submitParsedTask({ promptId, agentId, errId, btn }) {
  const text = $(promptId).value.trim();
  const agent = $(agentId).value;
  const errEl = $(errId);
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  if (!text) { if (errEl) { errEl.textContent = 'Tell the agent what you want it to do.'; errEl.style.display = ''; } return; }
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Parsing…';
  try {
    const r = await fetch('/api/tasks/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, text }),
    });
    if (r.ok) {
      $(promptId).value = '';
      await loadTaskList();
    } else {
      const data = await r.json().catch(() => ({}));
      if (errEl) { errEl.textContent = data.error || 'Could not create that task.'; errEl.style.display = ''; }
    }
  } finally {
    btn.disabled = false; btn.textContent = orig;
  }
}

$('btnAddTask').addEventListener('click', (e) => submitParsedTask({
  promptId: 'tPrompt', agentId: 'tAgent', errId: 'tParseError', btn: e.currentTarget,
}));

$('btnAddSettingsTask').addEventListener('click', (e) => submitParsedTask({
  promptId: 'stPrompt', agentId: 'stAgent', errId: 'stParseError', btn: e.currentTarget,
}));
