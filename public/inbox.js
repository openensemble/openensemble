// ── Inbox preview ─────────────────────────────────────────────────────────────
function makeDrawerToolbar(label, refreshFn) {
  return `<div class="drawer-toolbar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0">
    <span style="font-size:11px;color:var(--muted)">${label}</span>
    <input id="inboxSearch" type="text" placeholder="Search…" onkeydown="if(event.key==='Enter')searchInbox(this.value)" style="flex:1;background:var(--bg1);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11px;color:var(--text);min-width:0">
    <button class="drawer-refresh" onclick="${refreshFn}()">↻</button>
  </div>`;
}

async function searchInbox(query) {
  query = query?.trim();
  if (!query) { loadInboxPreview(); return; }
  const el = $('inboxPreview');
  const cardList = $('inboxCardList');
  if (cardList) cardList.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">Searching…</div>';
  try {
    const qs = `/api/inbox?max=30&query=${encodeURIComponent(query)}${_activeInboxAccountId ? `&accountId=${encodeURIComponent(_activeInboxAccountId)}` : ''}`;
    const data = await fetch(qs, { cache: 'no-store' }).then(r => r.json());
    if (data.error) throw new Error(data.error);
    const emails = data.emails ?? [];
    _inboxNextPageToken = data.nextPageToken ?? null;
    emails.forEach(e => { _inboxEmailMeta[e.id] = e; });
    const list = $('inboxCardList');
    if (list) {
      list.innerHTML = emails.length
        ? emails.map(_inboxCardHtml).join('')
        : '<div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">No results.</div>';
    }
  } catch (err) {
    const list = $('inboxCardList');
    if (list) list.innerHTML = `<div style="color:var(--red);font-size:13px;padding:20px">${escHtml(err.message)}</div>`;
  }
}

function _inboxCardHtml(e) {
  const from = e.from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || e.from;
  const date = e.date ? new Date(e.date).toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '';
  return `<div class="news-card email-card-row" onclick="openEmailDetail('${escHtml(e.id)}')">
    <div class="news-card-body">
      <div class="news-card-meta">
        <span class="news-card-source">${escHtml(from)}</span>
        <span class="news-card-age">${escHtml(date)}</span>
      </div>
      <div class="news-card-title">${escHtml(e.subject)}</div>
      <div class="news-card-desc">${escHtml(e.snippet)}</div>
    </div>
  </div>`;
}

async function loadEmailAccountTabs() {
  try {
    const accounts = await fetch('/api/email-accounts', { cache: 'no-store' }).then(r => r.json());
    _inboxAccounts = Array.isArray(accounts) ? accounts : [];
    _inboxAccountsLoadedAt = Date.now();
  } catch (_) { _inboxAccounts = []; }
  const tabBar = $('inboxAccountTabs');
  if (!tabBar) return;
  tabBar.innerHTML = _inboxAccounts.map(a => {
    const tabIcon = a.provider === 'gmail' ? icon('mail', 13) : a.provider === 'microsoft' ? icon('building', 13) : icon('globe', 13);
    const active = a.id === _activeInboxAccountId;
    return `<button onclick="switchInboxTab('${escHtml(a.id)}')" style="
      background:none;border:none;cursor:pointer;padding:8px 14px;font-size:12px;font-weight:600;
      color:${active ? 'var(--accent)' : 'var(--muted)'};
      border-bottom:2px solid ${active ? 'var(--accent)' : 'transparent'};
      white-space:nowrap;transition:color .15s,border-color .15s;flex-shrink:0
    ">${tabIcon} ${escHtml(a.label)}</button>`;
  }).join('');
}

function switchInboxTab(accountId) {
  _activeInboxAccountId = accountId;
  loadInboxPreview(accountId);
}

async function loadInboxPreview(accountId) {
  // Load tabs if stale or empty
  if (!_inboxAccounts.length || Date.now() - _inboxAccountsLoadedAt > 300000) {
    await loadEmailAccountTabs();
  }
  // Default to first account
  if (!accountId) accountId = _inboxAccounts[0]?.id ?? null;
  _activeInboxAccountId = accountId;
  // Re-render tabs to update active highlight
  await loadEmailAccountTabs();

  const el = $('inboxPreview');
  // Reset scroll/pagination state
  _inboxNextPageToken = null;
  _inboxLoading = false;
  _inboxLastFetch = 0;
  // Restore drawer body scroll when returning to list
  el.style.height = '';
  const drawerBody = el.closest('.desk-drawer-body');
  if (drawerBody) { drawerBody.style.overflow = ''; drawerBody.style.height = ''; }
  el.innerHTML = makeDrawerToolbar('Inbox', 'loadInboxPreview') +
    `<div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">Loading…</div>`;
  try {
    const qs = `/api/inbox?max=30${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}`;
    const data = await fetch(qs, { cache: 'no-store' }).then(r => r.json());
    if (data.error) throw new Error(data.error);
    const emails = data.emails ?? [];
    _inboxNextPageToken = data.nextPageToken ?? null;
    if (!emails.length) {
      el.innerHTML = makeDrawerToolbar('Inbox', 'loadInboxPreview') +
        `<div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">Inbox is empty.</div>`;
      return;
    }
    // Store email metadata for the detail view to look up by id; clear action cache
    _inboxEmailMeta = {};
    _inboxEmailActions = [];
    emails.forEach(e => { _inboxEmailMeta[e.id] = e; });

    el.innerHTML = makeDrawerToolbar('Inbox', 'loadInboxPreview') +
      `<div id="inboxCardList" class="inbox-card-list">${emails.map(_inboxCardHtml).join('')}</div>` +
      `<div id="inboxScrollSentinel" style="height:1px"></div>`;

    // Attach infinite scroll to drawer body
    if (drawerBody) {
      drawerBody._inboxScrollHandler = () => {
        if (!_inboxNextPageToken || _inboxLoading) return;
        const sentinel = $('inboxScrollSentinel');
        if (!sentinel) return;
        const rect = sentinel.getBoundingClientRect();
        const parentRect = drawerBody.getBoundingClientRect();
        if (rect.top - parentRect.bottom < 200) loadMoreInboxEmails();
      };
      drawerBody.addEventListener('scroll', drawerBody._inboxScrollHandler);
    }
  } catch (err) {
    el.innerHTML = `<div style="color:var(--red);font-size:13px;padding:20px">Failed: ${escHtml(err.message)}</div>`;
  }
}

async function loadMoreInboxEmails() {
  if (_inboxLoading || !_inboxNextPageToken) return;
  const now = Date.now();
  if (now - _inboxLastFetch < 2000) return; // rate-limit: 2s between fetches
  _inboxLoading = true;
  _inboxLastFetch = now;

  const sentinel = $('inboxScrollSentinel');
  if (sentinel) sentinel.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px;text-align:center">Loading more…</div>`;

  try {
    const url = `/api/inbox?max=30&pageToken=${encodeURIComponent(_inboxNextPageToken)}${_activeInboxAccountId ? `&accountId=${encodeURIComponent(_activeInboxAccountId)}` : ''}`;
    const data = await fetch(url, { cache: 'no-store' }).then(r => r.json());
    if (data.error) throw new Error(data.error);
    const emails = data.emails ?? [];
    _inboxNextPageToken = data.nextPageToken ?? null;

    emails.forEach(e => { _inboxEmailMeta[e.id] = e; });
    const list = $('inboxCardList');
    if (list) list.insertAdjacentHTML('beforeend', emails.map(_inboxCardHtml).join(''));

    if (sentinel) {
      sentinel.innerHTML = _inboxNextPageToken ? '' : `<div style="color:var(--muted);font-size:12px;padding:8px;text-align:center">End of inbox</div>`;
    }
  } catch (err) {
    if (sentinel) sentinel.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px;text-align:center">Failed to load more</div>`;
  } finally {
    _inboxLoading = false;
  }
}

function askEmailAgentAbout(msgId, subject) {
  const emailAgent = agents.find(a => a.skillCategory === 'email');
  if (!emailAgent) { alert('No email agent configured. Assign the email skill to one of your agents in Settings.'); return; }
  closeAllDrawers();
  switchAgent(emailAgent.id);
  const text = `Read email ID: ${msgId} — "${subject}"`;
  if (!sessions[emailAgent.id]) sessions[emailAgent.id] = [];
  sessions[emailAgent.id].push({ role: 'user', content: text, ts: Date.now() });
  appendUserBubble(text);
  toolPillsEl = null;
  setStreaming(true); setTyping(true);
  ws.send(JSON.stringify({ type: 'chat', agent: emailAgent.id, text }));
}

let _inboxEmailMeta = {};   // id -> { id, subject, from, date, snippet }
let _inboxEmailActions = []; // cached from skill manifest
let _inboxNextPageToken = null;
let _inboxLoading = false;
let _inboxLastFetch = 0;
let _inboxAccounts = [];
let _activeInboxAccountId = null;
let _inboxAccountsLoadedAt = 0;

async function openEmailDetail(msgId) {
  const meta = _inboxEmailMeta[msgId];
  if (!meta) return;
  const el = $('inboxPreview');
  // Lock the drawer body so the iframe can fill it with height:100%
  const drawerBody = el.closest('.desk-drawer-body');
  // Remove infinite scroll listener while viewing detail
  if (drawerBody && drawerBody._inboxScrollHandler) {
    drawerBody.removeEventListener('scroll', drawerBody._inboxScrollHandler);
  }
  if (drawerBody) { drawerBody.style.overflow = 'hidden'; drawerBody.style.height = '100%'; }
  el.style.height = '100%';

  // Fetch skill actions from manifest (cache after first load)
  if (!_inboxEmailActions.length) {
    try {
      const skills = await fetch('/api/roles').then(r => r.json());
      const emailSkill = skills.find(s => s.category === 'email' && s.enabled && s.actions);
      _inboxEmailActions = emailSkill?.actions ?? [];
    } catch {}
  }

  const fromDisplay = meta.from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || meta.from;
  const dateDisplay = meta.date ? new Date(meta.date).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';

  const actionBtns = _inboxEmailActions.map(a =>
    `<button class="btn-email-action${a.id === 'trash' ? ' danger' : ''}" onclick="emailActionClick('${a.id}', '${escHtml(msgId)}')">
      <span class="action-icon">${a.icon}</span>${escHtml(a.label)}
    </button>`
  ).join('');

  el.innerHTML = `<div class="email-detail">
    <div class="email-detail-hdr">
      <button class="btn-email-back" onclick="loadInboxPreview()" title="Back">←</button>
      <div class="email-detail-subject">${escHtml(meta.subject)}</div>
    </div>
    <div class="email-detail-meta">
      <div class="email-detail-from">${escHtml(fromDisplay)}</div>
      <div class="email-detail-date">${escHtml(dateDisplay)}</div>
    </div>
    <div class="email-detail-body">
      <iframe id="emailFrame" sandbox="allow-popups allow-popups-to-escape-sandbox" title="Email content"></iframe>
    </div>
    <div id="emailReplyComposer" style="display:none;border-top:1px solid var(--border);padding:10px 16px;background:var(--bg2);flex-shrink:0">
      <div id="emailReplyLabel" style="font-size:11px;color:var(--muted);margin-bottom:6px"></div>
      <textarea id="emailReplyText" style="width:100%;min-height:80px;max-height:200px;resize:vertical;background:var(--bg1);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:13px;color:var(--text);font-family:inherit" placeholder="Type your reply…"></textarea>
      <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end">
        <button onclick="closeReplyComposer()" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer">Cancel</button>
        <button id="emailReplyDraft" onclick="draftWithEmailAgent()" style="background:none;border:1px solid var(--accent);color:var(--accent);border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600">Draft with AI</button>
        <button id="emailReplySend" onclick="sendInlineReply()" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600">Send</button>
      </div>
    </div>
    ${_inboxEmailActions.length ? `<div class="email-action-bar">${actionBtns}</div>` : ''}
  </div>`;

  // Fetch HTML with auth token, inject via srcdoc
  try {
    const acctQs = _activeInboxAccountId ? `?accountId=${encodeURIComponent(_activeInboxAccountId)}` : '';
    let html = await fetch(`/api/inbox/${encodeURIComponent(msgId)}${acctQs}`).then(r => r.text());
    // Make all links open in a new browser tab
    html = html.replace(/<head([^>]*)>/i, '<head$1><base target="_blank" rel="noopener">');
    if (!/<head/i.test(html)) html = '<base target="_blank" rel="noopener">' + html;
    const frame = $('emailFrame');
    if (frame) frame.srcdoc = html;
  } catch (e) {
    const frame = $('emailFrame');
    if (frame) frame.srcdoc = `<p style="font-family:sans-serif;color:red">Failed to load: ${e.message}</p>`;
  }
}

async function emailActionClick(actionId, msgId) {
  const action = _inboxEmailActions.find(a => a.id === actionId);
  const meta = _inboxEmailMeta[msgId];
  if (!action || !meta) return;

  // Direct actions call the skill tool immediately — no AI involved
  if (action.direct && action.tool) {
    const btn = document.querySelector(`.btn-email-action[onclick*="${actionId}"]`);
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }

    // Build args per action type
    let toolArgs = { account: _activeInboxAccountId ?? undefined };
    if (actionId === 'mark_read') {
      toolArgs.messageIds = [msgId];
    } else if (actionId === 'archive') {
      toolArgs.messageIds = [msgId];
      toolArgs.removeLabels = ['INBOX'];
    } else {
      toolArgs.messageId = msgId;
    }

    // Trash — delete immediately and return to inbox
    if (actionId === 'trash') {
      try {
        await fetch('/api/email/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: action.tool, args: toolArgs }),
        });
        updateStatusBar();
        loadInboxPreview();
      } catch (e) { showToast(`Delete failed: ${e.message}`); }
      return;
    }

    try {
      await fetch('/api/email/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: action.tool, args: toolArgs }),
      });
      if (actionId === 'mark_read') {
        showToast('Marked as read');
      } else if (actionId === 'archive') {
        showToast('Archived');
        loadInboxPreview();
      } else {
        loadInboxPreview();
      }
    } catch (e) {
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }
      alert(`Action failed: ${e.message}`);
    }
    return;
  }

  // Reply/Forward — open inline composer
  const composer = $('emailReplyComposer');
  if (composer) {
    _replyActionId = actionId;
    _replyMsgId = msgId;
    const label = actionId === 'forward' ? 'Forward this email' : `Reply to ${escHtml(meta.from.replace(/<[^>]+>/, '').replace(/"/g, '').trim())}`;
    $('emailReplyLabel').innerHTML = label;
    $('emailReplyText').value = '';
    $('emailReplySend').textContent = actionId === 'forward' ? 'Forward' : 'Send Reply';
    composer.style.display = '';
    $('emailReplyText').focus();
  }
}

let _replyActionId = null;
let _replyMsgId = null;

function closeReplyComposer() {
  const c = $('emailReplyComposer');
  if (c) c.style.display = 'none';
  _replyActionId = null; _replyMsgId = null;
}

async function sendInlineReply() {
  const text = $('emailReplyText')?.value?.trim();
  if (!text) return;
  const btn = $('emailReplySend');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    if (_replyActionId === 'forward') {
      const to = prompt('Forward to (email address):');
      if (!to) { if (btn) { btn.disabled = false; btn.textContent = 'Forward'; } return; }
      await fetch('/api/email/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'email_compose', args: { account: _activeInboxAccountId ?? undefined, to, subject: 'Fwd: ' + (_inboxEmailMeta[_replyMsgId]?.subject ?? ''), body: text } }),
      });
    } else {
      await fetch('/api/email/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'email_reply', args: { messageId: _replyMsgId, account: _activeInboxAccountId ?? undefined, body: text } }),
      });
    }
    closeReplyComposer();
    showToast(_replyActionId === 'forward' ? 'Forwarded' : 'Reply sent');
  } catch (e) {
    alert(`Failed: ${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = _replyActionId === 'forward' ? 'Forward' : 'Send Reply'; }
  }
}

function draftWithEmailAgent() {
  const emailAgent = agents.find(a => a.skillCategory === 'email');
  if (!emailAgent) { alert('No email agent configured. Assign the email skill to one of your agents in Settings.'); return; }
  const meta = _inboxEmailMeta[_replyMsgId];
  if (!meta) return;
  const action = _inboxEmailActions.find(a => a.id === _replyActionId);
  if (!action?.prompt) return;
  const text = action.prompt.replace('{id}', _replyMsgId).replace('{subject}', meta.subject);
  closeReplyComposer();
  closeAllDrawers();
  switchAgent(emailAgent.id);
  if (!sessions[emailAgent.id]) sessions[emailAgent.id] = [];
  sessions[emailAgent.id].push({ role: 'user', content: text, ts: Date.now() });
  appendUserBubble(text);
  toolPillsEl = null;
  setStreaming(true); setTyping(true);
  ws.send(JSON.stringify({ type: 'chat', agent: emailAgent.id, text }));
}

// ── Inbox keyboard shortcuts ──────────────────────────────────────────────────
let _inboxKeyIdx = -1;
function isInboxDrawerOpen() { return $('drawerInbox')?.classList.contains('open'); }
function isInboxListView() { return !!$('inboxCardList'); }

document.addEventListener('keydown', (e) => {
  if (!isInboxDrawerOpen()) return;
  // Don't capture when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const cards = $('inboxCardList')?.children;

  if (isInboxListView() && cards?.length) {
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      _inboxKeyIdx = Math.min(_inboxKeyIdx + 1, cards.length - 1);
      cards[_inboxKeyIdx]?.scrollIntoView({ block: 'nearest' });
      for (const c of cards) c.style.outline = '';
      cards[_inboxKeyIdx].style.outline = '2px solid var(--accent)';
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      _inboxKeyIdx = Math.max(_inboxKeyIdx - 1, 0);
      cards[_inboxKeyIdx]?.scrollIntoView({ block: 'nearest' });
      for (const c of cards) c.style.outline = '';
      cards[_inboxKeyIdx].style.outline = '2px solid var(--accent)';
    } else if (e.key === 'Enter' && _inboxKeyIdx >= 0) {
      e.preventDefault();
      cards[_inboxKeyIdx].click();
    }
  } else if (!isInboxListView()) {
    // Detail view shortcuts
    const emailIds = Object.keys(_inboxEmailMeta);
    const currentId = _replyMsgId || emailIds.find(id => $('emailFrame'));
    if (e.key === 'r') { e.preventDefault(); emailActionClick('reply', currentId); }
    else if (e.key === 'f') { e.preventDefault(); emailActionClick('forward', currentId); }
    else if (e.key === 'e') { e.preventDefault(); emailActionClick('archive', currentId); }
    else if (e.key === '#') { e.preventDefault(); emailActionClick('trash', currentId); }
    else if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      if ($('emailReplyComposer')?.style.display !== 'none') closeReplyComposer();
      else loadInboxPreview();
    }
  }
});

