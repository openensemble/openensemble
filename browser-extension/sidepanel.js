// OE Bridge — side panel chat surface.
//
// Stays open while the user interacts with the page (this is the whole
// point vs the popup). Reads chat history from chrome.storage.local on
// load so the conversation survives panel close + reopen. Listens for
// chat_event / chat_done / chat_error messages from the background SW
// for the currently-streaming response.

const $ = (id) => document.getElementById(id);

let _currentRequestId = null;
let _currentAssistantEl = null;
let _statusBadge = $('status');

function renderStatus(status) {
  const el = $('status');
  if (!el) return;
  if (status?.connected) {
    el.className = 'status ok';
    const userName = typeof status.userName === 'string' ? status.userName.trim() : '';
    el.textContent = userName ? `Connected ${userName}` : 'Connected';
  } else if (status?.lastError) {
    el.className = 'status bad';
    el.textContent = `Disconnected — ${String(status.lastError).slice(0, 60)}`;
  } else {
    el.className = 'status idle';
    el.textContent = 'Waiting…';
  }
}

async function refreshStatus() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'get_status' });
    if (r?.status) renderStatus(r.status);
  } catch {}
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'status') renderStatus(msg.status);
});

function appendMessage(role, text) {
  const empty = $('empty');
  if (empty) empty.remove();
  const msgsEl = $('messages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text || '';
  msgsEl.appendChild(div);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  return div;
}

async function loadHistory() {
  const msgsEl = $('messages');
  msgsEl.innerHTML = '<div id="empty" class="empty">Loading…</div>';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'chat_history_get' });
    const history = r?.history || [];
    const current = r?.current || null;
    msgsEl.innerHTML = '';
    if (!history.length && !current) {
      msgsEl.innerHTML = '<div id="empty" class="empty">No conversation yet. Ask Sydney something.</div>';
      return;
    }
    for (const m of history) appendMessage(m.role, m.text);
    if (current) {
      appendMessage('user', current.userText);
      _currentRequestId = current.requestId;
      _currentAssistantEl = appendMessage('assistant', current.assistantText || '…');
    }
  } catch (e) {
    msgsEl.innerHTML = `<div class="empty">Couldn't load history: ${e?.message || String(e)}</div>`;
  }
}

function startNewAssistantBubble() {
  _currentAssistantEl = appendMessage('assistant', '');
}

function appendToken(text) {
  if (!_currentAssistantEl) startNewAssistantBubble();
  if (_currentAssistantEl.textContent === '…') _currentAssistantEl.textContent = '';
  _currentAssistantEl.textContent += text;
  const msgsEl = $('messages');
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function appendToolLine(name, preview = null) {
  if (!_currentAssistantEl) startNewAssistantBubble();
  const line = document.createElement('div');
  line.className = 'tool-line';
  line.textContent = preview ? `↳ ${name}: ${String(preview).slice(0, 100)}` : `[${name}…]`;
  _currentAssistantEl.appendChild(line);
  const msgsEl = $('messages');
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function sendChat(text) {
  const t = String(text || '').trim();
  if (!t) return;
  appendMessage('user', t);
  $('chatInput').value = '';
  _currentRequestId = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _currentAssistantEl = null;
  startNewAssistantBubble();
  _currentAssistantEl.textContent = '…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'chat_send', requestId: _currentRequestId, text: t });
    if (!r?.ok) {
      _currentAssistantEl.textContent = `[error: ${r?.error || 'send failed'}]`;
    }
  } catch (e) {
    _currentAssistantEl.textContent = `[error: ${e?.message || String(e)}]`;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.requestId !== _currentRequestId) return;
  if (msg.type === 'chat_event') {
    const ev = msg.event || {};
    if (ev.type === 'token' && typeof ev.text === 'string') appendToken(ev.text);
    else if (ev.type === 'tool_call') appendToolLine(ev.name);
    else if (ev.type === 'tool_result') appendToolLine(ev.name, ev.preview || ev.text);
    else if (ev.type === 'error') appendToken(`\n[error: ${ev.message || 'unknown'}]`);
  } else if (msg.type === 'chat_done') {
    _currentRequestId = null;
    _currentAssistantEl = null;
  } else if (msg.type === 'chat_error') {
    appendToken(`\n[server error: ${msg.message || 'unknown'}]`);
    _currentRequestId = null;
    _currentAssistantEl = null;
  }
});

$('chatSend').addEventListener('click', () => sendChat($('chatInput').value));
$('chatClear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'chat_history_clear' });
  $('messages').innerHTML = '<div id="empty" class="empty">Cleared.</div>';
  _currentRequestId = null;
  _currentAssistantEl = null;
});
$('askThisPage').addEventListener('click', async () => {
  // One-shot page ask — background snapshots the active tab and attaches
  // it to the question. No lease is minted; only the popup's explicit
  // Allow button grants OE the ability to act on a tab.
  const q = ($('chatInput').value || '').trim();
  $('chatInput').value = '';
  _currentRequestId = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _currentAssistantEl = null;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'ask_page_oneshot', requestId: _currentRequestId, question: q });
    if (!r?.ok) {
      appendMessage('assistant', `[error: ${r?.error || 'ask failed'}]`);
      _currentRequestId = null;
      return;
    }
    // Mirror the display line background stored in chat history.
    appendMessage('user', `📄 [${r.title || 'this page'}] ${r.question || q}`);
    startNewAssistantBubble();
    _currentAssistantEl.textContent = '…';
  } catch (e) {
    appendMessage('assistant', `[error: ${e?.message || String(e)}]`);
    _currentRequestId = null;
  }
});
$('teachThisSite').addEventListener('click', () => appendMessage('assistant', 'Teach Mode is temporarily unavailable while its tab-scoped consent control is being added.'));
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('chatInput').value); }
});

(async () => {
  await loadHistory();
  await refreshStatus();
  setInterval(refreshStatus, 4000);
})();
