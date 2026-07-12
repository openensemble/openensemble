const POPUP_VERSION = '0.3.3';
console.log(`[OE Bridge popup] script loaded version=${POPUP_VERSION}`);

const $ = (id) => document.getElementById(id);

// Populate the input fields exactly once at popup open. The 3-second
// refresh loop only updates the STATUS pill — it must NOT touch the
// input fields, otherwise the user can't finish typing the server URL
// (every refresh overwrites the half-typed value with the empty stored
// value).
let _fieldsPopulated = false;

function populateFields(config) {
  if (_fieldsPopulated || !config) return;
  $('serverUrl').value = config.serverUrl || '';
  $('token').value     = config.token     || '';
  $('name').value      = config.name      || '';
  _fieldsPopulated = true;
}

function renderStatus(status) {
  const el = $('status');
  if (status.connected) {
    el.className = 'status ok';
    const since = status.since ? new Date(status.since).toLocaleTimeString() : '?';
    const userName = typeof status.userName === 'string' ? status.userName.trim() : '';
    el.replaceChildren();
    const label = document.createElement('b');
    label.textContent = userName ? `Connected ${userName}` : 'Connected';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `extId: ${status.extId ?? '?'}\nsince: ${since}\nserver: ${status.server ?? ''}`;
    meta.style.whiteSpace = 'pre-wrap';
    el.append(label, meta);
  } else if (status.lastError) {
    el.className = 'status bad';
    el.innerHTML = `<b>Disconnected</b><div class="meta">${status.lastError}</div>`;
  } else {
    el.className = 'status idle';
    el.textContent = 'Waiting for config…';
  }
  // Show the chat panel only when connected — no point asking Sydney
  // if the bridge can't reach OE.
  const panel = $('chatPanel');
  if (panel) panel.style.display = status.connected ? 'block' : 'none';
}

// ── Capability lease controls ────────────────────────────────────────────
// Grants originate HERE (a click in extension UI) and nowhere else. The
// background broker denies every tab-touching server command without one.
function renderLease(lease) {
  const statusEl = $('leaseStatus');
  const revokeBtn = $('leaseRevoke');
  if (!statusEl || !revokeBtn) return;
  const tabs = (lease && Array.isArray(lease.tabs)) ? lease.tabs : [];
  if (tabs.length) {
    const until = new Date(lease.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const active = tabs.filter(t => !t.suspended).length;
    const paused = tabs.length - active;
    statusEl.innerHTML = `🔓 <b>OE can use ${active} tab${active === 1 ? '' : 's'} until ${until}.</b>` +
      (paused ? ` ${paused} paused (tab left its granted site — press Resume on its banner).` : '') +
      ' Leased tabs show an amber banner.';
    revokeBtn.style.display = 'block';
  } else {
    statusEl.textContent = 'OE has no access to your tabs. Grant a short lease to let it read or act on the current tab.';
    revokeBtn.style.display = 'none';
  }
}

const leaseGrantBtn = $('leaseGrant');
const leaseRevokeBtn = $('leaseRevoke');
if (leaseGrantBtn) leaseGrantBtn.addEventListener('click', async () => {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'grant_lease' });
    if (resp?.ok) renderLease(resp.lease);
    else showError(resp?.error || 'lease grant failed');
  } catch (e) {
    showError(e?.message || String(e));
  }
});
if (leaseRevokeBtn) leaseRevokeBtn.addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'revoke_lease' }); } catch {}
  renderLease(null);
});

// ── Chat with Sydney from the popup ──────────────────────────────────────
let _chatRequestId = null;
function appendReply(text, replace = false) {
  const el = $('chatReply');
  if (!el) return;
  if (replace) el.textContent = text;
  else el.textContent += text;
  el.scrollTop = el.scrollHeight;
}
function setReplyLabel(label) { appendReply(label, true); }

async function sendChat(text) {
  const t = String(text || '').trim();
  if (!t) return;
  setReplyLabel('…');
  const input = $('chatInput');
  if (input) input.value = '';
  _chatRequestId = `pp_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'chat_send', requestId: _chatRequestId, text: t });
    if (!resp?.ok) appendReply(`\n\n[error: ${resp?.error || 'send failed'}]`, true);
  } catch (e) {
    appendReply(`\n\n[error: ${e?.message || String(e)}]`, true);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.requestId !== _chatRequestId) return;
  if (msg.type === 'chat_event') {
    const ev = msg.event || {};
    if (ev.type === 'token' && typeof ev.text === 'string') {
      const el = $('chatReply');
      if (el && el.textContent === '…') el.textContent = '';
      appendReply(ev.text);
    } else if (ev.type === 'tool_call') {
      appendReply(`\n\n[${ev.name}…]\n`);
    } else if (ev.type === 'tool_result') {
      // Tool results are usually long — show a one-line preview, the
      // full text already lands as token events in the next assistant
      // turn anyway.
      const preview = (ev.preview || ev.text || '').slice(0, 120);
      appendReply(`\n  ↳ ${preview}${(ev.text||'').length > 120 ? '…' : ''}\n`);
    } else if (ev.type === 'error') {
      appendReply(`\n\n[error: ${ev.message || 'unknown'}]`);
    }
  } else if (msg.type === 'chat_done') {
    // Final newline so the reply doesn't run into the next user turn.
    appendReply('\n');
  } else if (msg.type === 'chat_error') {
    appendReply(`\n\n[server error: ${msg.message || 'unknown'}]`);
  }
});

const sendBtn = $('chatSend');
const clearBtn = $('chatClear');
const askPageBtn = $('askThisPage');
const chatInput = $('chatInput');
const sidepanelBtn = $('openSidepanel');
if (sendBtn) sendBtn.addEventListener('click', () => sendChat($('chatInput')?.value));
if (clearBtn) clearBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'chat_history_clear' });
  setReplyLabel('');
});
if (askPageBtn) askPageBtn.addEventListener('click', async () => {
  // One-shot: snapshot the page now and send it with the question — no
  // lease is minted. Asking is consent to read this page once, nothing
  // more; only the explicit Allow button grants OE the ability to act.
  // Uses whatever is typed in the chat box as the question, else a default.
  const q = (chatInput?.value || '').trim();
  if (chatInput) chatInput.value = '';
  setReplyLabel('…');
  _chatRequestId = `pp_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'ask_page_oneshot', requestId: _chatRequestId, question: q });
    if (!r?.ok) appendReply(`\n\n[error: ${r?.error || 'ask failed'}]`, true);
  } catch (e) {
    appendReply(`\n\n[error: ${e?.message || String(e)}]`, true);
  }
});
if (sidepanelBtn) sidepanelBtn.addEventListener('click', async () => {
  // chrome.sidePanel.open() needs the user-gesture call stack — delegating
  // to the service worker silently fails. Open directly from the popup's
  // own click event instead.
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  } catch (e) {
    console.error('[popup] sidepanel open failed:', e);
  }
});
if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat(chatInput.value);
    }
  });
}

async function refresh() {
  const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
  if (!resp) return;
  populateFields(resp.config);   // no-op after first call
  renderStatus(resp.status);
  renderLease(resp.lease);
}

// On every popup open, restore the saved chat history into the reply
// pane. Without this, closing the popup mid-conversation made all of
// Sydney's previous turns disappear from view (the data still lived
// in background SW storage; the popup just never read it). Now the
// pane shows everything stored, plus any partial current response.
async function loadChatHistoryIntoReply() {
  const replyEl = $('chatReply');
  if (!replyEl) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'chat_history_get' });
    if (!r) return;
    const history = r.history || [];
    const current = r.current || null;
    if (!history.length && !current) return;
    const lines = [];
    for (const m of history) {
      lines.push(`${m.role === 'user' ? '› You' : 'Sydney'}: ${m.text}`);
    }
    if (current) {
      lines.push(`› You: ${current.userText}`);
      lines.push(`Sydney: ${current.assistantText || '…'}`);
    }
    replyEl.textContent = lines.join('\n\n');
    replyEl.scrollTop = replyEl.scrollHeight;
  } catch { /* storage unavailable — leave pane empty */ }
}

async function autoPair() {
  const el = $('status');
  el.className = 'status idle';
  el.textContent = 'Detecting OE (active tab, localhost) …';
  try {
    // Don't pass an explicit serverUrl — let background pick from its
    // candidate list (active tab origin, prior config, localhost). The
    // active-tab fallback is how this works for LAN OE without manual
    // entry: open OE in any tab, click Detect & connect, done.
    const resp = await chrome.runtime.sendMessage({ type: 'auto_pair' });
    if (!resp || resp.ok !== true) {
      showError(resp?.error || 'Auto-pair failed. Try the manual setup below.');
      return;
    }
    _fieldsPopulated = false;
    if (resp.config) populateFields(resp.config);
    setTimeout(refresh, 600);
  } catch (e) {
    showError(`Couldn't reach the background service worker: ${e?.message || String(e)}.`);
  }
}

function showError(text) {
  const el = $('status');
  el.className = 'status bad';
  el.innerHTML = `<b>Popup error</b><div class="meta">${text}</div>`;
}

$('save').addEventListener('click', async () => {
  const config = {
    serverUrl: $('serverUrl').value.trim(),
    token:     $('token').value.trim(),
    name:      $('name').value.trim(),
  };
  if (!config.serverUrl) return showError('Server URL is required (e.g. http://localhost:3737).');
  if (!config.token)     return showError('Auth token is required. Open the OE setup-token URL in a logged-in tab to get it.');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'save_config', config });
    if (!resp || resp.ok !== true) {
      showError(`Save returned: ${JSON.stringify(resp || null)}. The background service worker may be inactive — reload the extension.`);
      return;
    }
    setTimeout(refresh, 500);
  } catch (e) {
    showError(`Couldn't reach the background service worker: ${e?.message || String(e)}. Reload the extension at chrome://extensions.`);
  }
});

$('reconnect').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'reconnect' });
    setTimeout(refresh, 500);
  } catch (e) {
    showError(`Reconnect failed: ${e?.message || String(e)}.`);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'status') renderStatus(msg.status);
});

const autopairBtn = $('autopair');
if (autopairBtn) autopairBtn.addEventListener('click', autoPair);

// First-open: if nothing's saved yet AND OE is on localhost, just do it.
// Most users never see the manual fields because of this.
(async () => {
  const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
  const cfg = resp?.config || {};
  if (!cfg.serverUrl && !cfg.token) {
    autoPair();
  }
})();

refresh();
setInterval(refresh, 3000);
loadChatHistoryIntoReply();
