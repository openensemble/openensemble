// ── Tasks ─────────────────────────────────────────────────────────────────────
let tasks = [];
// [TEST 2026-04-26] Inline-expand editor — track which task is open so we
// can render its detail panel under the row. Click anywhere on the row body
// to toggle. REVERT: drop this var, the toggle/save funcs, and the expanded
// branch in renderTasks.
let expandedTaskId = null;

async function loadTaskList() {
  try { const r = await fetch('/api/tasks'); tasks = await r.json(); } catch { tasks = []; }
  renderTasks(); updateTasksBadge();
}

function _toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderTaskRow(t) {
  const schedStr = t.repeat === 'once'
    ? (t.datetime ? '1× ' + new Date(t.datetime).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '1× (no time set)')
    : `🔁 ${t.time} daily`;
  const statusSuffix = (t.repeat === 'once' && !t.enabled && t.lastRun) ? ' · ✓ done' : (t.lastRun ? ' · ' + new Date(t.lastRun).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '');
  const isReminder = t.type === 'reminder';
  const runner = isReminder ? '🔔 Reminder' : (agents.find(a=>a.id===t.agent)?.name ?? t.agent);
  const isOpen = expandedTaskId === t.id;
  const expandToggle = isOpen ? '▾' : '▸';
  // The header row: clicking the info area toggles the expanded view.
  // Edit/toggle/delete buttons remain accessible without expanding first.
  const header = `
    <div class="task-item${isOpen ? ' task-item-open' : ''}">
      <div class="task-item-info" onclick="toggleTaskExpanded('${escHtml(t.id)}')" title="Click to view / edit details" style="cursor:pointer">
        <div class="task-item-label">${expandToggle} ${escHtml(t.label)}</div>
        <div class="task-item-meta">${schedStr} · ${runner}${statusSuffix}</div>
      </div>
      ${t.repeat === 'once' && !t.enabled ? '<span style="font-size:11px;color:var(--green)">✓</span>' : `<input type="checkbox" class="task-toggle" ${t.enabled ? 'checked' : ''} onchange="toggleTask('${escHtml(t.id)}', this.checked)">`}
      <button class="btn-task-del" onclick="deleteTask('${escHtml(t.id)}')">✕</button>
    </div>`;
  if (!isOpen) return header;

  // Expanded detail / editor. Reminder tasks don't have an agent or prompt;
  // agent tasks expose those fields.
  const agentOptions = agents.map(a => `<option value="${escHtml(a.id)}"${a.id===t.agent?' selected':''}>${escHtml(a.emoji||'')} ${escHtml(a.name)}</option>`).join('');
  const timeField = t.repeat === 'once'
    ? `<label>When<input type="datetime-local" id="te-dt-${escHtml(t.id)}" value="${_toLocalInputValue(t.datetime)}"></label>`
    : `<label>Daily at<input type="time" id="te-tm-${escHtml(t.id)}" value="${escHtml(t.time||'09:00')}"></label>`;
  const agentBlock = isReminder ? '' : `
      <label>Runner
        <select id="te-ag-${escHtml(t.id)}">${agentOptions}</select>
      </label>
      <label>Prompt (what to ask the agent at fire time)
        <textarea id="te-pr-${escHtml(t.id)}" rows="3">${escHtml(t.prompt||'')}</textarea>
      </label>`;
  const lastOutput = t.lastOutput ? `<div class="task-edit-meta">Last run: ${escHtml(String(t.lastOutput).slice(0, 200))}</div>` : '';
  const editor = `
    <div class="task-edit-panel">
      <label>Label<input type="text" id="te-lb-${escHtml(t.id)}" value="${escHtml(t.label||'')}"></label>
      ${timeField}
      ${agentBlock}
      ${lastOutput}
      <div class="task-edit-actions">
        <button class="btn-task-save" onclick="saveTaskEdits('${escHtml(t.id)}')">Save</button>
        <button class="btn-task-cancel" onclick="toggleTaskExpanded('${escHtml(t.id)}')">Cancel</button>
      </div>
    </div>`;
  return header + editor;
}

function renderTasks() {
  const html = !tasks.length
    ? '<em style="color:var(--muted);font-size:13px">No tasks yet.</em>'
    : tasks.map(renderTaskRow).join('');
  const list = $('taskList');
  if (list) list.innerHTML = html;
  const settingsList = $('settingsTaskList');
  if (settingsList) settingsList.innerHTML = html;
}

function toggleTaskExpanded(id) {
  expandedTaskId = expandedTaskId === id ? null : id;
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
  } else {
    const tm = document.getElementById(`te-tm-${id}`);
    if (tm && /^\d{1,2}:\d{2}$/.test(tm.value) && tm.value !== t.time) patch.time = tm.value;
  }
  if (t.type !== 'reminder') {
    const ag = document.getElementById(`te-ag-${id}`);
    if (ag && ag.value && ag.value !== t.agent) patch.agent = ag.value;
    const pr = document.getElementById(`te-pr-${id}`);
    if (pr && pr.value !== (t.prompt||'')) patch.prompt = pr.value;
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
  const count = tasks.filter(t => t.enabled).length;
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

