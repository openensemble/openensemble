// ── Shared Notes (save only — drawer open/tab logic is in docs.js) ────────────
async function saveNotes() {
  const content = $('notesTextarea').value;
  try {
    const result = await fetch('/api/notes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then(r => r.json());
    if (result.updatedAt) {
      const when = new Date(result.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      $('notesMetaRow').textContent = `Last updated ${when}${result.updatedByName ? ' by ' + result.updatedByName : ''}`;
    }
    showToast('Notes saved!', 2000);
  } catch { showToast('Failed to save notes'); }
}

// ── Messages drawer open/close ────────────────────────────────────────────────
let _msgPollInterval = null;

function openMessagesDrawer() {
  showMsgView('list');
  if (!_msgPollInterval) _msgPollInterval = setInterval(_msgPoll, 30000);
}

// Called when the drawer closes (hooked from closeAllDrawers via drawers.js)
function closeMessagesDrawer() {
  clearInterval(_msgPollInterval);
  _msgPollInterval = null;
}

async function _msgPoll() {
  // If a conversation is open, silently refresh its messages
  if (_activeThreadId) {
    try {
      const messages = await fetch(`/api/threads/${_activeThreadId}/messages`).then(r => r.json());
      if (messages.length !== _convoMsgCount) {
        _convoMsgCount = messages.length;
        renderConvoMessages(messages);
        fetch(`/api/threads/${_activeThreadId}/read`, { method: 'PATCH' }).catch(() => {});
      }
    } catch {}
  }
  // Always refresh thread list (unread counts, previews)
  try {
    _threads = await fetch('/api/threads').then(r => r.json());
    if ($('msgViewList').style.display !== 'none') renderThreadList();
    updateNotesBadgeCount();
  } catch {}
}

// ── Threads ───────────────────────────────────────────────────────────────────
let _threads = [];
let _activeThreadId = null;
let _threadUsers = [];
let _newPickerSelected = new Set();

function showMsgView(view) {
  // view: 'list' | 'new' | 'convo'
  $('msgViewList').style.display  = view === 'list'  ? 'flex' : 'none';
  $('msgViewNew').style.display   = view === 'new'   ? 'flex' : 'none';
  $('msgViewConvo').style.display = view === 'convo' ? 'flex' : 'none';
  if (view !== 'convo') { _activeThreadId = null; _convoMsgCount = 0; }
  if (view === 'list') loadThreadList();
}

// ── Thread list ───────────────────────────────────────────────────────────────
async function loadThreadList() {
  const list = $('msgThreadList');
  list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;text-align:center">Loading…</div>';
  try {
    _threads = await fetch('/api/threads').then(r => r.json());
    renderThreadList();
    updateNotesBadgeCount();
  } catch {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;text-align:center">Failed to load messages</div>';
  }
}

function renderThreadList() {
  const list = $('msgThreadList');
  if (!_threads.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:30px 20px;text-align:center;line-height:1.6">No conversations yet.<br>Tap <b>+ New Message</b> to start one.</div>';
    return;
  }
  list.innerHTML = _threads.map(t => {
    const last = t.lastMessage;
    const preview = last ? escHtml(last.content.length > 60 ? last.content.slice(0, 60) + '…' : last.content) : '<i style="color:var(--muted)">No messages yet</i>';
    const when = last ? fmtRelTime(last.sentAt) : '';
    const hasUnread = t.unread > 0;
    return `<div onclick="openThread('${t.id}')" style="display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s" onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
      <div style="width:40px;height:40px;border-radius:50%;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">${escHtml(t.displayEmoji)}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
          <span style="font-size:13px;font-weight:${hasUnread ? '700' : '500'};color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${escHtml(t.displayName)}</span>
          <span style="font-size:11px;color:var(--muted);flex-shrink:0">${when}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="font-size:12px;color:${hasUnread ? 'var(--text)' : 'var(--muted)'};font-weight:${hasUnread ? '500' : '400'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${last && last.from !== getCurrentUserId() ? '' : last ? '<span style="color:var(--muted)">You: </span>' : ''}${preview}</div>
          ${hasUnread ? `<span style="background:var(--accent);color:#fff;border-radius:10px;font-size:10px;padding:1px 6px;flex-shrink:0;min-width:18px;text-align:center;line-height:16px">${t.unread > 99 ? '99+' : t.unread}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

async function openThread(id) {
  _activeThreadId = id;
  const t = _threads.find(x => x.id === id);
  if (!t) return;
  $('msgConvoTitle').textContent = t.displayName;
  showMsgView('convo');
  $('msgConvoMessages').innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;text-align:center">Loading…</div>';
  // Mark read immediately
  fetch(`/api/threads/${id}/read`, { method: 'PATCH' }).catch(() => {});
  await loadConvoMessages(id, t.isGroup);
  updateNotesBadgeCount();
}

// ── Conversation ──────────────────────────────────────────────────────────────
let _convoIsGroup = false;
let _convoMsgCount = 0;

async function loadConvoMessages(id, isGroup) {
  _convoIsGroup = isGroup ?? false;
  try {
    const messages = await fetch(`/api/threads/${id}/messages`).then(r => r.json());
    _convoMsgCount = messages.length;
    renderConvoMessages(messages);
  } catch {
    $('msgConvoMessages').innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;text-align:center">Failed to load</div>';
  }
}

function renderConvoMessages(messages) {
  const box = $('msgConvoMessages');
  if (!messages.length) {
    box.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:30px 20px;text-align:center">No messages yet.<br>Send the first one!</div>';
    return;
  }

  // Group consecutive messages from same sender (within 5 min)
  const groups = [];
  messages.forEach(m => {
    const last = groups[groups.length - 1];
    if (last && last.from === m.from && new Date(m.sentAt) - new Date(last.msgs[last.msgs.length - 1].sentAt) < 300000) {
      last.msgs.push(m);
    } else {
      groups.push({ from: m.from, fromName: m.fromName, isMine: m.isMine, msgs: [m] });
    }
  });

  box.innerHTML = groups.map(g => {
    const mine = g.isMine;
    const align = mine ? 'flex-end' : 'flex-start';
    const bg    = mine ? 'var(--accent)' : 'var(--bg3)';
    const color = mine ? '#fff' : 'var(--text)';

    const senderLabel = _convoIsGroup && !mine
      ? `<div style="font-size:11px;color:var(--muted);margin-bottom:3px;padding-left:4px">${escHtml(g.fromName)}</div>`
      : '';

    const bubbles = g.msgs.map((m, i) => {
      const isLast = i === g.msgs.length - 1;
      const isSingle = g.msgs.length === 1;
      let br;
      if (mine) {
        br = isSingle ? '18px 18px 4px 18px' : isLast ? '18px 4px 4px 18px' : '18px 4px 4px 18px';
        if (!isSingle && i === 0) br = '18px 18px 4px 18px';
      } else {
        br = isSingle ? '18px 18px 18px 4px' : isLast ? '4px 18px 18px 4px' : '4px 18px 18px 4px';
        if (!isSingle && i === 0) br = '18px 18px 18px 4px';
      }
      const mb = isLast ? '0' : '2px';
      const time = isLast ? `<div style="font-size:10px;color:var(--muted);margin-top:3px;${mine ? 'text-align:right' : 'text-align:left'};padding:0 4px">${fmtMsgTime(m.sentAt)}</div>` : '';
      return `<div style="display:flex;flex-direction:column;align-items:${align};width:100%;margin-bottom:${mb}">
        <div style="background:${bg};color:${color};border-radius:${br};padding:8px 12px;max-width:78%;word-break:break-word;font-size:13px;line-height:1.45;white-space:pre-wrap">${escHtml(m.content)}</div>
        ${time}
      </div>`;
    }).join('');

    return `<div style="display:flex;flex-direction:column;align-items:${align};width:100%;margin-bottom:10px">
      ${senderLabel}
      ${bubbles}
    </div>`;
  }).join('');

  _convoMsgCount = messages.length;
  box.scrollTop = box.scrollHeight;
}

async function deleteThread() {
  if (!_activeThreadId) return;
  if (!confirm('Delete this conversation? It will be removed from your inbox.')) return;
  try {
    const r = await fetch(`/api/threads/${_activeThreadId}`, { method: 'DELETE' });
    if (!r.ok) { showToast('Failed to delete'); return; }
    showMsgView('list');
    showToast('Conversation deleted', 2000);
  } catch { showToast('Failed to delete'); }
}

async function sendThreadMsg() {
  if (!_activeThreadId) return;
  const input = $('msgConvoInput');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  resizeMsgInput(input);
  try {
    const msg = await fetch(`/api/threads/${_activeThreadId}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then(r => r.json());
    if (msg.error) { showToast(msg.error); input.value = content; return; }
    // Append to convo
    const box = $('msgConvoMessages');
    const noMsg = box.querySelector('div[style*="No messages"]');
    if (noMsg) box.innerHTML = '';
    const mine = msg.isMine;
    const br = mine ? '18px 18px 4px 18px' : '18px 18px 18px 4px';
    const bg = mine ? 'var(--accent)' : 'var(--bg3)';
    const color = mine ? '#fff' : 'var(--text)';
    const el = document.createElement('div');
    el.style.cssText = `display:flex;flex-direction:column;align-items:${mine ? 'flex-end' : 'flex-start'};width:100%;margin-bottom:10px`;
    el.innerHTML = `<div style="background:${bg};color:${color};border-radius:${br};padding:8px 12px;max-width:78%;word-break:break-word;font-size:13px;line-height:1.45;white-space:pre-wrap">${escHtml(msg.content)}</div>
      <div style="font-size:10px;color:var(--muted);margin-top:3px;${mine ? 'text-align:right' : ''};padding:0 4px">${fmtMsgTime(msg.sentAt)}</div>`;
    _convoMsgCount++;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    // Update thread list preview in background
    loadThreadList().catch(() => {});
  } catch { showToast('Failed to send'); input.value = content; }
}

function msgInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendThreadMsg(); }
}

function resizeMsgInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── New thread ────────────────────────────────────────────────────────────────
async function openNewThreadView() {
  _newPickerSelected = new Set();
  $('msgGroupName').value = '';
  $('msgGroupNameRow').style.display = 'none';
  showMsgView('new');
  const picker = $('msgNewPicker');
  picker.innerHTML = '<span style="font-size:12px;color:var(--muted)">Loading…</span>';
  try {
    _threadUsers = await fetch('/api/users').then(r => r.json());
    renderNewPicker();
  } catch { picker.innerHTML = '<span style="font-size:12px;color:var(--muted)">Failed to load users</span>'; }
}

function renderNewPicker() {
  const picker = $('msgNewPicker');
  const others = _threadUsers.filter(u => u.id !== getCurrentUserId());
  if (!others.length) { picker.innerHTML = '<span style="font-size:12px;color:var(--muted)">No other users</span>'; return; }
  picker.innerHTML = others.map(u => {
    const sel = _newPickerSelected.has(u.id);
    return `<button onclick="toggleNewUser('${u.id}')" id="npick-${u.id}" style="background:${sel ? 'var(--accent)' : 'var(--bg3)'};border:1px solid ${sel ? 'var(--accent)' : 'var(--border)'};color:${sel ? '#fff' : 'var(--text)'};border-radius:20px;padding:5px 12px;font-size:12px;cursor:pointer;transition:all .15s">${escHtml(u.emoji ?? '🧑')} ${escHtml(u.name)}</button>`;
  }).join('');
}

function toggleNewUser(id) {
  if (_newPickerSelected.has(id)) _newPickerSelected.delete(id);
  else _newPickerSelected.add(id);
  $('msgGroupNameRow').style.display = _newPickerSelected.size > 1 ? 'block' : 'none';
  renderNewPicker();
}

async function startNewThread() {
  if (_newPickerSelected.size === 0) { showToast('Select at least one person'); return; }
  const name = $('msgGroupName').value.trim() || null;
  try {
    const r = await fetch('/api/threads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participants: [..._newPickerSelected], name }),
    }).then(r => r.json());
    if (r.error) { showToast(r.error); return; }
    await loadThreadList();
    openThread(r.id);
  } catch { showToast('Failed to start conversation'); }
}

// ── Push notification handler (called from websocket.js) ──────────────────────
function handleNewThreadMessage({ threadId, message }) {
  // If this conversation is currently open, append the bubble live
  if (_activeThreadId === threadId && $('msgViewConvo')?.style.display !== 'none') {
    const box = $('msgConvoMessages');
    const noMsg = box?.querySelector('div[style*="No messages"]');
    if (noMsg) box.innerHTML = '';
    if (box) {
      const br = '18px 18px 18px 4px';
      const el = document.createElement('div');
      el.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;width:100%;margin-bottom:10px';
      el.innerHTML = `<div style="background:var(--bg3);color:var(--text);border-radius:${br};padding:8px 12px;max-width:78%;word-break:break-word;font-size:13px;line-height:1.45;white-space:pre-wrap">${escHtml(message.content)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:3px;padding:0 4px">${fmtMsgTime(message.sentAt)}</div>`;
      box.appendChild(el);
      _convoMsgCount++;
      box.scrollTop = box.scrollHeight;
    }
    fetch(`/api/threads/${threadId}/read`, { method: 'PATCH' }).catch(() => {});
  } else {
    // Drawer closed or different thread — update thread list if visible
    if ($('msgViewList')?.style.display !== 'none') {
      loadThreadList().catch(() => {});
    }
  }
  // Always update the badge (increment by 1 immediately, then confirm with server)
  const badge = $('notesBadge');
  const cur = parseInt(badge?.textContent || '0', 10) || 0;
  setNotesBadge(cur + 1);
  updateNotesBadgeCount();  // confirm with server async
}

// ── Badge ─────────────────────────────────────────────────────────────────────
async function updateNotesBadgeCount() {
  try {
    const data = await fetch('/api/dashboard').then(r => r.json());
    setNotesBadge(data.messagesUnread ?? 0);
  } catch {}
}

function setNotesBadge(count) {
  const label = count > 99 ? '99+' : count;
  [$('notesBadge'), $('notesBadgeMobile')].forEach(b => {
    if (!b) return;
    if (count > 0) { b.textContent = label; b.style.display = ''; }
    else b.style.display = 'none';
  });
  const tb = $('notesMsgBadge');
  if (tb) {
    if (count > 0) { tb.textContent = label; tb.style.display = ''; }
    else tb.style.display = 'none';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtRelTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtMsgTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
