// ── Attachment state ──────────────────────────────────────────────────────────
let pendingAttachment = null; // { id, name, mimeType, base64, extractedText, isImage, isFinanceFile }

function clearAttachment() {
  pendingAttachment = null;
  const p = $('attachPreview');
  p.style.display = 'none';
  p.innerHTML = '';
  $('chatFileInput').value = '';
}

async function handleChatFileSelect(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/chat-upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    pendingAttachment = data;
    // Show preview
    const p = $('attachPreview');
    p.style.display = 'flex';
    const thumb = data.isImage && data.base64
      ? `<img src="data:${data.mimeType};base64,${data.base64}" alt="">`
      : `<span style="font-size:20px">${data.mimeType.includes('pdf') ? icon('file-text', 20) : icon('bar-chart-2', 20)}</span>`;
    p.innerHTML = `${thumb}<span class="attach-preview-name">${escHtml(data.name)}</span><button class="attach-preview-remove" onclick="clearAttachment()">✕</button>`;
  } catch (e) {
    alert('Upload failed: ' + e.message);
  }
}

// ── Send ──────────────────────────────────────────────────────────────────────
async function send() {
  const text = $('input').value.trim();
  if ((!text && !pendingAttachment) || (streaming && !awaitingPermission) || !ws || ws.readyState !== WebSocket.OPEN) return;

  const attachment = pendingAttachment;
  const displayText = text || (attachment ? `[${attachment.name}]` : '');

  if (!sessions[activeAgent]) sessions[activeAgent] = [];
  sessions[activeAgent].push({ role: 'user', content: displayText, ts: Date.now(), attachment });
  updateSessionWarning();
  appendUserBubble(displayText, Date.now(), true, attachment);
  $('input').value = '';
  resizeTextarea();
  clearAttachment();
  toolPillsEl = null;
  if (awaitingPermission) {
    awaitingPermission = false;
    // Don't reset streaming — Ada is still running; just show typing indicator
    setTyping(true);
  } else {
    setStreaming(true); setTyping(true);
  }

  const payload = { type: 'chat', agent: activeAgent, text };
  if (attachment) payload.attachment = attachment;
  ws.send(JSON.stringify(payload));
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderSession() {
  const msgs = $('messages');
  [...msgs.children].forEach(el => { if (!el.id) el.remove(); });
  (sessions[activeAgent] ?? []).forEach(m => {
    if (m.scheduled)                 appendTaskHeader(m.content, m.ts, false);
    else if (m.role === 'notification') appendNotification({ agent: activeAgent, content: m.content, from: m.from, ts: m.ts });
    else if (m.role === 'user' && !m.hidden)        appendUserBubble(m.content, m.ts, false, m.attachment ?? null);
    else if (m.role === 'assistant' && m.image)    appendImageBubble(m.image, m.ts, false);
    else if (m.role === 'assistant' && m.video)    appendVideoBubble(m.video, m.ts, false);
    else if (m.role === 'assistant' && !m.hidden) appendAssistantBubble(m.content, m.ts, false);
  });
  const headers = $('messages').querySelectorAll('.task-header[data-ts]');
  if (headers.length) {
    const today = new Date().toDateString();
    let latest = null;
    headers.forEach(h => { if (new Date(+h.dataset.ts).toDateString() === today) latest = h; });
    if (latest) latest.scrollIntoView({ block: 'start' });
    else scrollToBottom();
  } else {
    scrollToBottom();
  }
}

function appendUserBubble(text, ts = Date.now(), scroll = true, attachment = null) {
  const el = msgEl('user');
  const bubble = el.querySelector('.msg-bubble');
  if (attachment) {
    const div = document.createElement('div');
    div.className = 'msg-attachment';
    if (attachment.isImage && attachment.base64) {
      div.innerHTML = `<img src="data:${attachment.mimeType};base64,${attachment.base64}" alt="${escHtml(attachment.name)}">`;
    } else {
      const fileIcon = attachment.mimeType?.includes('pdf') ? icon('file-text', 14) : icon('bar-chart-2', 14);
      div.innerHTML = `<span class="msg-attachment-badge">${fileIcon} ${escHtml(attachment.name)}</span>`;
    }
    bubble.appendChild(div);
  }
  if (text && text !== `[${attachment?.name}]`) {
    const span = document.createElement('span');
    span.textContent = text;
    bubble.appendChild(span);
  }
  addTimestamp(el, ts); insertBefore(el);
  if (scroll) scrollToBottom();
  return el;
}
function appendAssistantBubble(content, ts = Date.now(), scroll = true) {
  const el = msgEl('assistant');
  el.querySelector('.msg-bubble').innerHTML = renderMarkdown(content);
  addTimestamp(el, ts); insertBefore(el);
  if (scroll) scrollToBottom();
  return el;
}
function appendImageBubble(image, ts = Date.now(), scroll = true) {
  const el = msgEl('assistant');
  const bubble = el.querySelector('.msg-bubble');

  // Decode base64 → Blob → object URL (avoids large data URL in DOM)
  const byteChars = atob(image.base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: image.mimeType });
  const blobUrl = URL.createObjectURL(blob);

  const img = document.createElement('img');
  img.src = blobUrl;
  img.alt = image.filename;
  img.style.cssText = 'max-width:100%;border-radius:8px;display:block';
  bubble.appendChild(img);

  const meta = document.createElement('div');
  meta.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--muted)';
  if (image.savedPath) {
    const saved = document.createElement('span');
    saved.innerHTML = `${icon('save', 12)} Saved to ${escHtml(image.savedPath)}`;
    saved.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    meta.appendChild(saved);
  } else {
    const dlBtn = document.createElement('a');
    dlBtn.innerHTML = `${icon('download', 12)} Download`;
    dlBtn.style.cssText = 'color:var(--accent);text-decoration:none;cursor:pointer;flex-shrink:0';
    dlBtn.addEventListener('click', e => {
      e.preventDefault();
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = image.filename;
      a.click();
    });
    meta.appendChild(dlBtn);
  }
  bubble.appendChild(meta);

  addTimestamp(el, ts); insertBefore(el);
  if (scroll) scrollToBottom();
  return el;
}
function appendVideoBubble(video, ts = Date.now(), scroll = true) {
  const el = msgEl('assistant');
  const bubble = el.querySelector('.msg-bubble');

  const videoEl = document.createElement('video');
  videoEl.src = video.url;
  videoEl.controls = true;
  videoEl.style.cssText = 'max-width:100%;border-radius:8px;display:block';
  bubble.appendChild(videoEl);

  const meta = document.createElement('div');
  meta.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--muted)';
  if (video.savedPath) {
    const saved = document.createElement('span');
    saved.innerHTML = `${icon('save', 12)} Saved to ${escHtml(video.savedPath)}`;
    saved.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    meta.appendChild(saved);
  } else {
    const dlBtn = document.createElement('a');
    dlBtn.innerHTML = `${icon('download', 12)} Download`;
    dlBtn.href = video.url;
    dlBtn.download = video.filename;
    dlBtn.target = '_blank';
    dlBtn.style.cssText = 'color:var(--accent);text-decoration:none;cursor:pointer;flex-shrink:0';
    meta.appendChild(dlBtn);
  }
  bubble.appendChild(meta);

  addTimestamp(el, ts); insertBefore(el);
  if (scroll) scrollToBottom();
  return el;
}
function appendStreamingBubble() {
  const el = msgEl('assistant'); insertBefore(el);
  return el.querySelector('.msg-bubble');
}
function showToolPill(name) {
  if (!toolPillsEl) {
    toolPillsEl = document.createElement('div');
    toolPillsEl.className = 'tool-pills';
    toolPillsEl.addEventListener('click', onToolPillClick);
    toolPillsEl.addEventListener('keydown', onToolPillKey);
    insertBefore(toolPillsEl);
  }
  const pill = document.createElement('span');
  pill.className = 'tool-pill';
  pill.dataset.tool = name;
  pill.innerHTML = `${icon('settings', 13)} ${escHtml(name)}`;
  toolPillsEl.appendChild(pill);
  scrollToBottom();
}
function updateToolPill(name, summary, fullText) {
  if (!toolPillsEl) return;
  const pills = toolPillsEl.querySelectorAll('.tool-pill');
  for (let i = pills.length - 1; i >= 0; i--) {
    if (pills[i].dataset.tool === name && !pills[i].classList.contains('tool-done')) {
      pills[i].innerHTML = `${icon('check', 13)} ${escHtml(name)}`;
      if (summary) {
        const sum = document.createElement('span');
        sum.className = 'tool-pill-summary';
        sum.textContent = summary.length > 80 ? summary.slice(0, 80) + '...' : summary;
        pills[i].appendChild(sum);
      }
      pills[i].classList.add('tool-done');
      if (fullText) {
        pills[i]._toolFullText = fullText;
        pills[i].classList.add('clickable');
        pills[i].setAttribute('role', 'button');
        pills[i].setAttribute('tabindex', '0');
        pills[i].title = 'Click to view full output';
      }
      break;
    }
  }
}

function onToolPillClick(e) {
  const pill = e.target.closest('.tool-pill.clickable');
  if (!pill || !pill._toolFullText) return;
  openToolModal(pill.dataset.tool, pill._toolFullText);
}
function onToolPillKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const pill = e.target.closest('.tool-pill.clickable');
  if (!pill || !pill._toolFullText) return;
  e.preventDefault();
  openToolModal(pill.dataset.tool, pill._toolFullText);
}

let _toolModalEls = null;
function ensureToolModal() {
  if (_toolModalEls) return _toolModalEls;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0';
  const title = document.createElement('h2');
  title.style.cssText = 'font-family:monospace';
  const close = document.createElement('button');
  close.className = 'btn-modal-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close');
  header.appendChild(title);
  header.appendChild(close);
  const body = document.createElement('pre');
  body.className = 'tool-modal-body';
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.style.gap = '8px';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-modal-close';
  copyBtn.textContent = 'Copy';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-modal-close';
  closeBtn.textContent = 'Close';
  footer.appendChild(copyBtn);
  footer.appendChild(closeBtn);
  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const hide = () => backdrop.classList.remove('open');
  close.addEventListener('click', hide);
  closeBtn.addEventListener('click', hide);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) hide(); });
  modal.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.classList.contains('open')) hide();
  });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(body.textContent);
      const prev = copyBtn.textContent;
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = prev; }, 1200);
    } catch {}
  });

  _toolModalEls = { backdrop, title, body };
  return _toolModalEls;
}
function openToolModal(name, text) {
  const { backdrop, title, body } = ensureToolModal();
  title.textContent = name;
  body.textContent = text;
  backdrop.classList.add('open');
}
function appendError(msg) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="msg-bubble" style="color:#f44336;border:1px solid #f44336">⚠ ${escHtml(msg)}</div>`;
  insertBefore(el); scrollToBottom();
}
function appendNotification(msg) {
  const agentId = msg.agent;
  const fromName = msg.from?.userName ?? 'Someone';
  const timeStr = new Date(msg.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit' });
  // If notification is for the active agent, render inline
  if (agentId === activeAgent) {
    const el = document.createElement('div');
    el.className = 'msg notification';
    el.innerHTML = `<div class="msg-bubble" style="background:rgba(33,150,243,0.08);border:1px solid rgba(33,150,243,0.25);color:var(--fg);font-size:0.88em;padding:8px 12px;">
      <strong>${icon('megaphone', 13)} ${escHtml(fromName)}</strong> ${escHtml(msg.content)} <span style="opacity:0.5;font-size:0.85em;margin-left:6px">${timeStr}</span>
    </div>`;
    insertBefore(el); scrollToBottom();
  } else {
    // Show a toast for notifications on other agents
    const agentName = agents.find(a => a.id === agentId)?.name ?? agentId;
    showToast(`${fromName} via ${agentName}: ${msg.content}`);
  }
}
// ── Agent Activity Panel ───────────────────────────────────────────────────────
const _activityTasks  = new Map(); // taskId -> { agentName, status, summary, content, startedAt, el, intervalId }

function handleTaskUpdate(msg) {
  const { taskId, agentName, status, summary, content } = msg;
  const panel = document.getElementById('agentActivityPanel');
  if (!panel) return;

  let task = _activityTasks.get(taskId);

  if (!task) {
    // Create new row
    const el = document.createElement('div');
    el.className = `activity-row ${status}`;
    el.title = 'Click to expand result';
    el.addEventListener('click', () => {
      const t = _activityTasks.get(taskId);
      if (!t || t.status === 'running') return;
      el.classList.toggle('expanded');
    });
    panel.appendChild(el);
    task = { agentName, status, summary: summary ?? '', content: content ?? '', startedAt: Date.now(), el, intervalId: null };
    _activityTasks.set(taskId, task);
  }

  task.status  = status;
  task.content = content ?? task.content;
  task.summary = summary ?? task.summary;

  _renderActivityRow(taskId, task);

  // Show panel
  panel.style.display = _activityTasks.size > 0 ? 'flex' : 'none';

  // Auto-fade done rows after 8s
  if (status === 'done') {
    if (task.intervalId) clearInterval(task.intervalId);
    task.intervalId = setTimeout(() => {
      task.el?.classList.add('fading');
      setTimeout(() => _dismissActivity(taskId), 400);
    }, 8000);
  }
}

function _renderActivityRow(taskId, task) {
  const { agentName, status, summary, content, startedAt, el } = task;
  const elapsed = _formatElapsed(Date.now() - startedAt);
  const statusIcon = status === 'running' ? '' : status === 'done' ? '✓' : '✗';
  el.className = `activity-row ${status}`;
  el.innerHTML = `
    <div class="activity-dot"></div>
    <div class="activity-label">
      <strong>${statusIcon ? statusIcon + ' ' : ''}${escHtml(agentName)}</strong>
      <span class="activity-summary">${escHtml(summary.slice(0, 60))}</span>
      ${content && status !== 'running' ? `<div class="activity-detail">${escHtml(content)}</div>` : ''}
    </div>
    <span class="activity-elapsed">${elapsed}</span>
    <button class="activity-dismiss" title="Dismiss" onclick="event.stopPropagation();_dismissActivity('${escHtml(taskId)}')">×</button>
  `;
}

function _dismissActivity(taskId) {
  const task = _activityTasks.get(taskId);
  if (!task) return;
  if (task.intervalId) clearTimeout(task.intervalId);
  task.el?.remove();
  _activityTasks.delete(taskId);
  const panel = document.getElementById('agentActivityPanel');
  if (panel && _activityTasks.size === 0) panel.style.display = 'none';
}

function _formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  return `${m}:${String(rs).padStart(2, '0')}`;
}

// Keep elapsed timers ticking for running tasks
setInterval(() => {
  for (const [taskId, task] of _activityTasks) {
    if (task.status === 'running') _renderActivityRow(taskId, task);
  }
}, 5000);

// Render a direct report card from a background agent, inline in the current chat
function handleAgentReport(msg) {
  const { agentName, agentEmoji, content, ts } = msg;
  const timeStr = new Date(ts ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const el = document.createElement('div');
  el.className = 'msg agent-report';
  el.innerHTML = `
    <div class="agent-report-header">
      <span class="agent-report-who">${escHtml(agentEmoji ?? '')} <strong>${escHtml(agentName)}</strong></span>
      <span class="agent-report-time">${timeStr}</span>
    </div>
    <div class="agent-report-body msg-bubble">${renderMarkdown(content ?? '')}</div>
  `;
  insertBefore(el);
  scrollToBottom();
}

function appendTaskHeader(label, ts = Date.now(), scroll = true) {
  const timeStr = new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const el = document.createElement('div');
  el.className = 'task-header';
  el.dataset.ts = ts;
  el.innerHTML = `<span class="task-header-label">📋 ${escHtml(label)} — ${timeStr}</span>`;
  insertBefore(el);
  if (scroll) { el.scrollIntoView({ block: 'start' }); }
  return el;
}
function msgEl(role) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="msg-bubble"></div><div class="msg-time"></div>`;
  return el;
}
function addTimestamp(el, ts = Date.now()) {
  const t = el.querySelector('.msg-time');
  if (t) t.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function insertBefore(el) { $('messages').insertBefore(el, $('typing')); }
function scrollToBottom() { const m = $('messages'); m.scrollTop = m.scrollHeight; }
// escHtml defined below in Shared helpers section (with full quote escaping)

// ── Slash Command Menu ─────────────────────────────────────────────────────
let slashMenuIdx = 0, slashMenuItems = [];
let _skillsCache = null;
async function _loadSkills() {
  try { _skillsCache = await fetch('/api/roles').then(r => r.json()); } catch { _skillsCache = _skillsCache || []; }
  return _skillsCache;
}

const SLASH_COMMANDS = [
  { cmd: '/clear',     icon: 'trash-2',    desc: 'Clear the current chat session',
    action: () => { hideSlashMenu(); $('input').value = ''; clearSession(); } },
  { cmd: '/model',     icon: 'brain',      desc: 'Change the active model' },
  { cmd: '/agent',     icon: 'bot',        desc: 'Switch to a different agent' },
  { cmd: '/claim',     icon: 'wrench',     desc: 'Claim a role for this agent' },
  { cmd: '/release',   icon: 'unlock',     desc: 'Release a role from this agent' },
  { cmd: '/new-agent', icon: 'sparkles',   desc: 'Create a new agent',
    action: () => { hideSlashMenu(); $('input').value = ''; openNewAgentModal(); } },
];

function _slashGetItems(val) {
  const lo = val.toLowerCase();
  // /model <filter> → model submenu
  if (/^\/model\s/.test(val)) {
    const f = val.slice(7).toLowerCase();
    return allAvailableModels()
      .filter(m => !f || m.name.toLowerCase().includes(f) || (m.displayName||'').toLowerCase().includes(f))
      .map(m => ({
        label: m.displayName || m.name, desc: m.provider || '',
        action: () => {
          hideSlashMenu(); $('input').value = '';
          assignModelToAgent(activeAgent, m.name, m.provider);
          showToast(`Model → ${m.displayName || m.name}`);
        }
      }));
  }
  // /agent <filter> → agent submenu
  if (/^\/agent\s/.test(val)) {
    const f = val.slice(7).toLowerCase();
    return agents
      .filter(a => !f || a.id.toLowerCase().includes(f) || a.name.toLowerCase().includes(f))
      .map(a => ({
        label: `${a.emoji} ${a.name}`, desc: a.model || '',
        action: () => { hideSlashMenu(); $('input').value = ''; switchAgent(a.id); closeAllDrawers(); }
      }));
  }
  // /claim <filter> → roles only (same filter as Roles tab: s.service === true)
  if (/^\/claim\s/.test(val)) {
    const f = val.slice(7).toLowerCase();
    const cached = _skillsCache || [];
    if (!_skillsCache) { _loadSkills().then(() => updateSlashMenu()); }
    return cached
      .filter(s => s.service && (!f || s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f)))
      .map(s => ({
        label: s.name, desc: (s.assignment ? `claimed by ${agents.find(a=>a.id===s.assignment)?.name ?? s.assignment}` : 'unclaimed') + (s.description ? ' · ' + s.description : ''),
        action: () => { hideSlashMenu(); $('input').value = `/claim ${s.id}`; _skillsCache = null; send(); }
      }));
  }
  // /release <filter> → roles only
  if (/^\/release\s/.test(val)) {
    const f = val.slice(9).toLowerCase();
    const cached = _skillsCache || [];
    if (!_skillsCache) { _loadSkills().then(() => updateSlashMenu()); }
    return cached
      .filter(s => s.service && (!f || s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f)))
      .map(s => ({
        label: s.name, desc: s.assignment ? `claimed by ${agents.find(a=>a.id===s.assignment)?.name ?? s.assignment}` : 'unclaimed',
        action: () => { hideSlashMenu(); $('input').value = `/release ${s.id}`; _skillsCache = null; send(); }
      }));
  }
  // top-level commands
  return SLASH_COMMANDS
    .filter(c => c.cmd.startsWith(lo))
    .map(c => ({
      label: c.cmd, desc: c.desc, iconName: c.icon,
      action: c.action || (() => { $('input').value = c.cmd + ' '; updateSlashMenu(); $('input').focus(); })
    }));
}

function updateSlashMenu() {
  const val = $('input').value;
  if (!val.startsWith('/')) { hideSlashMenu(); return; }
  slashMenuItems = _slashGetItems(val);
  const menu = $('slashMenu');
  if (!slashMenuItems.length) { hideSlashMenu(); return; }
  if (slashMenuIdx >= slashMenuItems.length) slashMenuIdx = 0;
  menu.style.display = 'block';
  menu.innerHTML = slashMenuItems.map((item, i) =>
    `<div class="slash-menu-item${i === slashMenuIdx ? ' active' : ''}" data-idx="${i}">
       ${item.iconName ? `<span class="smi-icon">${icon(item.iconName, 14)}</span>` : ''}
       <span class="smi-label">${escHtml(item.label)}</span>
       <span class="smi-desc">${escHtml(item.desc)}</span>
     </div>`
  ).join('');
  menu.querySelectorAll('.slash-menu-item').forEach(el => {
    el.addEventListener('mousedown', e => { e.preventDefault(); slashMenuItems[+el.dataset.idx]?.action(); });
  });
}

function hideSlashMenu() { $('slashMenu').style.display = 'none'; slashMenuItems = []; slashMenuIdx = 0; }
function slashMenuNav(dir) {
  if (!slashMenuItems.length) return;
  slashMenuIdx = (slashMenuIdx + dir + slashMenuItems.length) % slashMenuItems.length;
  updateSlashMenu();
}
