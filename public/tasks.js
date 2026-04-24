// ── Tasks ─────────────────────────────────────────────────────────────────────
let tasks = [];

async function loadTaskList() {
  try { const r = await fetch('/api/tasks'); tasks = await r.json(); } catch { tasks = []; }
  renderTasks(); updateTasksBadge();
}

function renderTasks() {
  const html = !tasks.length
    ? '<em style="color:var(--muted);font-size:13px">No tasks yet.</em>'
    : tasks.map(t => {
        const schedStr = t.repeat === 'once'
          ? (t.datetime ? '1× ' + new Date(t.datetime).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '1× (no time set)')
          : `🔁 ${t.time} daily`;
        const statusSuffix = (t.repeat === 'once' && !t.enabled && t.lastRun) ? ' · ✓ done' : (t.lastRun ? ' · ' + new Date(t.lastRun).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '');
        const isReminder = t.type === 'reminder';
        const runner = isReminder ? '🔔 Reminder' : (agents.find(a=>a.id===t.agent)?.name ?? t.agent);
        const editBtn = `<button class="btn-task-edit" title="Edit time — catch a bad parse before it fires" onclick="editTaskTime('${escHtml(t.id)}')" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 6px;font-size:12px">✎</button>`;
        return `
        <div class="task-item">
          <div class="task-item-info">
            <div class="task-item-label">${escHtml(t.label)}</div>
            <div class="task-item-meta">${schedStr} · ${runner}${statusSuffix}</div>
          </div>
          ${editBtn}
          ${t.repeat === 'once' && !t.enabled ? '<span style="font-size:11px;color:var(--green)">✓</span>' : `<input type="checkbox" class="task-toggle" ${t.enabled ? 'checked' : ''} onchange="toggleTask('${escHtml(t.id)}', this.checked)">`}
          <button class="btn-task-del" onclick="deleteTask('${escHtml(t.id)}')">✕</button>
        </div>`;
      }).join('');
  const list = $('taskList');
  if (list) list.innerHTML = html;
  const settingsList = $('settingsTaskList');
  if (settingsList) settingsList.innerHTML = html;
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

