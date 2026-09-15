// ── Inbox preview ─────────────────────────────────────────────────────────────
function makeDrawerToolbar(label, refreshFn) {
  const q = _activeInboxQuery ?? '';
  const clearBtn = q
    ? `<button class="drawer-refresh" title="Clear search" data-action="clearInboxSearch" style="padding:0 8px">✕</button>`
    : '';
  return `<div class="drawer-toolbar" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0">
    <span style="font-size:11px;color:var(--muted)">${label}</span>
    <input id="inboxSearch" type="text" placeholder="Search…" value="${escHtml(q)}" data-keydown-action="_actionIf" data-keydown-args='[{"key":"Enter","action":"searchInbox","args":["$value"]}]' style="flex:1;background:var(--bg1);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:11px;color:var(--text);min-width:0">
    ${clearBtn}
    <button class="drawer-refresh" data-action="${refreshFn}">↻</button>
  </div>`;
}

async function searchInbox(query) {
  query = query?.trim();
  if (!query) { clearInboxSearch(); return; }
  _activeInboxQuery = query;
  const listGen = resetInboxListState();
  const accountId = _activeInboxAccountId;
  const el = $('inboxPreview');
  // Re-render toolbar so the X button appears and the input retains its value
  // when the cardList is replaced below.
  const tbHtml = makeDrawerToolbar('Inbox', 'loadInboxPreview');
  if (el) {
    el.innerHTML = tbHtml +
      `<div id="inboxCardList" class="inbox-card-list"><div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">Searching…</div></div>` +
      `<div id="inboxScrollSentinel" style="height:1px"></div>`;
  }
  try {
    const qs = `/api/inbox?max=30&query=${encodeURIComponent(query)}${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}`;
    const data = await fetch(qs, { cache: 'no-store' }).then(r => r.json());
    if (listGen !== _inboxListGen) return;
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
    if (listGen !== _inboxListGen) return;
    const list = $('inboxCardList');
    if (list) list.innerHTML = `<div style="color:var(--red);font-size:13px;padding:20px">${escHtml(err.message)}</div>`;
  }
}

function clearInboxSearch() {
  _activeInboxQuery = null;
  loadInboxPreview();
}

function _inboxCardHtml(e) {
  const from = e.from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || e.from;
  const date = e.date ? new Date(e.date).toLocaleDateString(undefined, { month:'short', day:'numeric' }) : '';
  const id = escHtml(e.id);
  const selected = _activeEmailDetail?.msgId === e.id && _activeEmailDetail?.accountId === _activeInboxAccountId;
  return `<div class="news-card email-card-row${selected ? ' is-selected' : ''}" data-message-id="${id}" role="button" tabindex="0" aria-controls="drawerEmail" aria-expanded="${selected}" data-action="openEmailDetail" data-args='${JSON.stringify([e.id]).replace(/'/g, "&#39;")}'>
    <div class="news-card-body">
      <div class="news-card-meta">
        <span class="news-card-source">${escHtml(from)}</span>
        <span class="news-card-age">${escHtml(date)}</span>
      </div>
      <div class="news-card-title">${escHtml(e.subject)}</div>
      <div class="news-card-desc">${escHtml(e.snippet)}</div>
    </div>
    <button class="email-card-delete" title="Delete" aria-label="Delete email" data-action="inboxQuickDelete" data-args='${JSON.stringify([e.id]).replace(/'/g, "&#39;")}' data-stop-propagation>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>
    </button>
  </div>`;
}

async function inboxQuickDelete(msgId, ev) {
  ev?.stopPropagation?.();
  ev?.preventDefault?.();
  const accountId = _activeInboxAccountId;
  await loadInboxEmailActions();
  const action = _inboxEmailActions.find(a => a.id === 'trash');
  if (!action?.tool) { showToast?.('Trash action unavailable'); return; }
  // ev.target works regardless of which inner element of the button (the
  // svg/path/polyline) actually received the click. ev.currentTarget points
  // at the delegation listener's host (document), not the button — using it
  // here used to return null silently, so the optimistic visual updates
  // never ran even though the server-side delete went through.
  const card = ev?.target?.closest?.('.email-card-row');
  if (card) { card.style.opacity = '0.5'; card.style.pointerEvents = 'none'; }
  try {
    const resp = await fetch('/api/email/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: action.tool,
        args: { account: accountId ?? undefined, messageId: msgId },
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    if (typeof updateStatusBar === 'function') updateStatusBar();
    removeInboxEmail(msgId, accountId);
  } catch (e) {
    if (card) { card.style.opacity = ''; card.style.pointerEvents = ''; }
    showToast?.(`Delete failed: ${e.message}`);
  }
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
    return `<button data-action="switchInboxTab" data-args='${JSON.stringify([a.id]).replace(/'/g, "&#39;")}' style="
      background:none;border:none;cursor:pointer;padding:8px 14px;font-size:12px;font-weight:600;
      color:${active ? 'var(--accent)' : 'var(--muted)'};
      border-bottom:2px solid ${active ? 'var(--accent)' : 'transparent'};
      white-space:nowrap;transition:color .15s,border-color .15s;flex-shrink:0
    ">${tabIcon} ${escHtml(a.label)}</button>`;
  }).join('');
}

function switchInboxTab(accountId) {
  closeEmailDetail(false);
  _activeInboxAccountId = accountId;
  loadInboxPreview(accountId);
}

function resetInboxListState() {
  _inboxNextPageToken = null;
  _inboxLoading = false;
  _inboxLastFetch = 0;
  _inboxKeyIdx = -1;
  _inboxEmailMeta = {};
  return ++_inboxListGen;
}

async function loadInboxPreview(accountId) {
  // event-delegation.js appends the click Event as the last positional arg
  // to the toolbar refresh handler, so only accept real account id strings.
  if (typeof accountId !== 'string') accountId = null;
  const listGen = resetInboxListState();
  // Load tabs if stale or empty
  if (!_inboxAccounts.length || Date.now() - _inboxAccountsLoadedAt > 300000) {
    await loadEmailAccountTabs();
  }
  if (listGen !== _inboxListGen) return;
  // Refresh preserves the current tab and the separate email drawer.
  if (!accountId) accountId = _activeInboxAccountId ?? _inboxAccounts[0]?.id ?? null;
  if (_activeEmailDetail && _activeEmailDetail.accountId !== accountId) closeEmailDetail(false);
  _activeInboxAccountId = accountId;
  // Re-render tabs to update active highlight
  await loadEmailAccountTabs();
  if (listGen !== _inboxListGen) return;

  const el = $('inboxPreview');
  if (!el) return;
  const drawerBody = el.closest('.desk-drawer-body');
  if (drawerBody && !drawerBody._inboxScrollHandler) {
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
  el.innerHTML = makeDrawerToolbar('Inbox', 'loadInboxPreview') +
    `<div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">Loading…</div>`;
  try {
    const qs = `/api/inbox?max=30${accountId ? `&accountId=${encodeURIComponent(accountId)}` : ''}${_activeInboxQuery ? `&query=${encodeURIComponent(_activeInboxQuery)}` : ''}`;
    const data = await fetch(qs, { cache: 'no-store' }).then(r => r.json());
    if (listGen !== _inboxListGen) return;
    if (data.error) throw new Error(data.error);
    const emails = data.emails ?? [];
    _inboxNextPageToken = data.nextPageToken ?? null;
    if (!emails.length) {
      el.innerHTML = makeDrawerToolbar('Inbox', 'loadInboxPreview') +
        `<div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">${_activeInboxQuery ? 'No results.' : 'Inbox is empty.'}</div>`;
      return;
    }
    // Store metadata for newly selected emails; the open drawer has its own copy.
    emails.forEach(e => { _inboxEmailMeta[e.id] = e; });

    el.innerHTML = makeDrawerToolbar('Inbox', 'loadInboxPreview') +
      `<div id="inboxCardList" class="inbox-card-list">${emails.map(_inboxCardHtml).join('')}</div>` +
      `<div id="inboxScrollSentinel" style="height:1px"></div>`;
  } catch (err) {
    if (listGen !== _inboxListGen) return;
    el.innerHTML = `<div style="color:var(--red);font-size:13px;padding:20px">Failed: ${escHtml(err.message)}</div>`;
  }
}

async function loadMoreInboxEmails() {
  if (_inboxLoading || !_inboxNextPageToken) return;
  const now = Date.now();
  if (now - _inboxLastFetch < 2000) return; // rate-limit: 2s between fetches
  _inboxLoading = true;
  _inboxLastFetch = now;
  const listGen = _inboxListGen;

  const sentinel = $('inboxScrollSentinel');
  if (sentinel) sentinel.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px;text-align:center">Loading more…</div>`;

  try {
    const url = `/api/inbox?max=30&pageToken=${encodeURIComponent(_inboxNextPageToken)}${_activeInboxAccountId ? `&accountId=${encodeURIComponent(_activeInboxAccountId)}` : ''}${_activeInboxQuery ? `&query=${encodeURIComponent(_activeInboxQuery)}` : ''}`;
    const data = await fetch(url, { cache: 'no-store' }).then(r => r.json());
    if (listGen !== _inboxListGen) return;
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
    if (listGen !== _inboxListGen) return;
    if (sentinel) sentinel.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px;text-align:center">Failed to load more</div>`;
  } finally {
    if (listGen === _inboxListGen) _inboxLoading = false;
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
let _inboxEmailActionsPromise = null;
let _inboxListGen = 0;
let _inboxNextPageToken = null;
let _inboxLoading = false;
let _inboxLastFetch = 0;
let _inboxAccounts = [];
let _activeInboxAccountId = null;
let _activeInboxQuery = null;
let _inboxAccountsLoadedAt = 0;

// Generation counter so a slow body fetch for message A cannot overwrite the
// iframe after the user has already opened message B or closed the drawer.
let _emailDetailGen = 0;
let _activeEmailDetail = null;

async function loadInboxEmailActions() {
  if (_inboxEmailActions.length) return _inboxEmailActions;
  if (!_inboxEmailActionsPromise) {
    _inboxEmailActionsPromise = fetch('/api/roles').then(r => r.json()).then(skills => {
      const emailSkill = skills.find(s => s.category === 'email' && s.enabled && s.actions);
      _inboxEmailActions = emailSkill?.actions ?? [];
      return _inboxEmailActions;
    }).catch(() => []).finally(() => { _inboxEmailActionsPromise = null; });
  }
  return _inboxEmailActionsPromise;
}

function syncInboxEmailSelection() {
  document.querySelectorAll('#inboxCardList .email-card-row').forEach(card => {
    const selected = card.dataset.messageId === _activeEmailDetail?.msgId
      && _activeInboxAccountId === _activeEmailDetail?.accountId;
    card.classList.toggle('is-selected', selected);
    card.setAttribute('aria-expanded', String(selected));
  });
}

function closeEmailDetail(restoreFocus = true) {
  const currentId = _activeEmailDetail?.msgId;
  _emailDetailGen++;
  _activeEmailDetail = null;
  closeReplyComposer();
  const drawer = $('drawerEmail');
  if (drawer) { drawer.classList.remove('open'); drawer.inert = true; }
  $('drawerInbox')?.classList.remove('email-detail-open');
  $('emailDetailPreview')?.replaceChildren();
  syncInboxEmailSelection();
  if (restoreFocus !== false && currentId && isInboxDrawerOpen()) {
    const card = [...document.querySelectorAll('#inboxCardList .email-card-row')]
      .find(el => el.dataset.messageId === currentId);
    (card || $('inboxSearch'))?.focus({ preventScroll: true });
  }
}

function removeInboxEmail(msgId, accountId) {
  if (_activeEmailDetail?.msgId === msgId && _activeEmailDetail?.accountId === accountId) closeEmailDetail();
  if (_activeInboxAccountId !== accountId) return;
  delete _inboxEmailMeta[msgId];
  const list = $('inboxCardList');
  const card = [...(list?.querySelectorAll('.email-card-row') ?? [])]
    .find(el => el.dataset.messageId === msgId);
  if (card) {
    if (card.contains(document.activeElement)) {
      (card.nextElementSibling || card.previousElementSibling || $('inboxSearch'))?.focus({ preventScroll: true });
    }
    card.remove();
  }
  _inboxKeyIdx = -1;
  if (list && !list.querySelector('.email-card-row')) loadInboxPreview();
}

async function openEmailDetail(msgId) {
  const meta = _inboxEmailMeta[msgId];
  const drawer = $('drawerEmail');
  const el = $('emailDetailPreview');
  if (!meta || !drawer || !el || !isInboxDrawerOpen()) return;
  const detailGen = ++_emailDetailGen;
  const accountIdAtOpen = _activeInboxAccountId;
  _activeEmailDetail = { msgId, accountId: accountIdAtOpen, meta };
  closeReplyComposer();
  syncInboxEmailSelection();
  $('drawerInbox').classList.add('email-detail-open');
  $('emailDetailSubject').textContent = meta.subject || '(No subject)';
  drawer.inert = false;
  drawer.classList.add('open');
  $('emailDetailClose')?.focus({ preventScroll: true });

  const fromDisplay = meta.from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || meta.from;
  const dateDisplay = meta.date ? new Date(meta.date).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';

  el.innerHTML = `
    <div class="email-detail-meta">
      <div class="email-detail-from">${escHtml(fromDisplay)}</div>
      <div class="email-detail-date">${escHtml(dateDisplay)}</div>
    </div>
    <div class="email-detail-body">
      <iframe id="emailFrame" sandbox="allow-popups allow-popups-to-escape-sandbox" title="Email content"></iframe>
    </div>
    <div id="emailReplyComposer" style="display:none;border-top:1px solid var(--border);padding:10px 16px;background:var(--bg2);flex-shrink:0">
      <div id="emailReplyLabel" style="font-size:11px;color:var(--muted);margin-bottom:6px"></div>
      <input id="emailForwardTo" type="email" placeholder="Forward to (email address)" style="display:none;width:100%;background:var(--bg1);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:13px;color:var(--text);font-family:inherit;margin-bottom:6px;box-sizing:border-box">
      <textarea id="emailReplyText" style="width:100%;min-height:80px;max-height:200px;resize:vertical;background:var(--bg1);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:13px;color:var(--text);font-family:inherit" placeholder="Type your reply…"></textarea>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;justify-content:flex-end">
        <button data-action="closeReplyComposer" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer">Cancel</button>
        <button id="emailReplyDraft" data-action="draftWithEmailAgent" style="background:none;border:1px solid var(--accent);color:var(--accent);border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600">Draft with AI</button>
        <button id="emailReplySend" data-action="sendInlineReply" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600">Send</button>
      </div>
    </div>
    <div id="emailActionBar" class="email-action-bar"></div>`;

  const frame = $('emailFrame');
  if (frame) {
    frame.srcdoc = `<p style="font-family:sans-serif;color:#888;padding:16px">Loading message…</p>`;
  }

  // Load actions and the message independently so the drawer opens immediately.
  const actionsReady = loadInboxEmailActions().then(actions => {
    if (detailGen !== _emailDetailGen) return;
    $('emailActionBar').innerHTML = actions.map(a =>
      `<button class="btn-email-action${a.id === 'trash' ? ' danger' : ''}" data-email-action="${escHtml(a.id)}" data-action="emailActionClick" data-args='${JSON.stringify([a.id, msgId]).replace(/'/g, "&#39;")}'>
        <span class="action-icon">${a.icon}</span>${escHtml(a.label)}
      </button>`
    ).join('');
  });

  // Fetch HTML with auth token, inject via srcdoc. Ignore the response if the
  // user has already opened another message or closed the drawer.
  try {
    const acctQs = accountIdAtOpen ? `?accountId=${encodeURIComponent(accountIdAtOpen)}` : '';
    const resp = await fetch(`/api/inbox/${encodeURIComponent(msgId)}${acctQs}`, { cache: 'no-store' });
    if (detailGen !== _emailDetailGen) return;
    let html = await resp.text();
    if (detailGen !== _emailDetailGen) return;
    if (!resp.ok) {
      const errFrame = $('emailFrame');
      if (errFrame && detailGen === _emailDetailGen) {
        errFrame.srcdoc = `<p style="font-family:sans-serif;color:red;padding:16px">Failed to load: ${escHtml(html.replace(/<[^>]+>/g, '').slice(0, 200) || resp.statusText)}</p>`;
      }
      return;
    }
    // Make all links open in a new browser tab
    html = html.replace(/<head([^>]*)>/i, '<head$1><base target="_blank" rel="noopener">');
    if (!/<head/i.test(html)) html = '<base target="_blank" rel="noopener">' + html;
    const liveFrame = $('emailFrame');
    if (liveFrame && detailGen === _emailDetailGen) liveFrame.srcdoc = html;
  } catch (e) {
    if (detailGen !== _emailDetailGen) return;
    const errFrame = $('emailFrame');
    if (errFrame) errFrame.srcdoc = `<p style="font-family:sans-serif;color:red;padding:16px">Failed to load: ${escHtml(e.message)}</p>`;
  } finally {
    await actionsReady;
  }
}

async function emailActionClick(actionId, msgId) {
  const action = _inboxEmailActions.find(a => a.id === actionId);
  const detail = _activeEmailDetail;
  if (!action || detail?.msgId !== msgId) return;
  const { meta, accountId } = detail;
  const detailGen = _emailDetailGen;

  // Direct actions call the skill tool immediately — no AI involved
  if (action.direct && action.tool) {
    const btn = [...document.querySelectorAll('#emailActionBar .btn-email-action')]
      .find(el => el.dataset.emailAction === actionId);
    if (btn?.disabled) return;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }

    // Build args per action type
    const toolArgs = { account: accountId ?? undefined };
    if (actionId === 'mark_read') {
      toolArgs.messageIds = [msgId];
    } else if (actionId === 'archive') {
      toolArgs.messageIds = [msgId];
      toolArgs.removeLabels = ['INBOX'];
    } else {
      toolArgs.messageId = msgId;
    }

    try {
      const response = await fetch('/api/email/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: action.tool, args: toolArgs }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
      if (actionId === 'mark_read') {
        showToast('Marked as read');
      } else if (actionId === 'archive' || actionId === 'trash') {
        showToast(actionId === 'archive' ? 'Archived' : 'Deleted');
        removeInboxEmail(msgId, accountId);
      } else if (detailGen === _emailDetailGen) {
        loadInboxPreview();
      }
      if (typeof updateStatusBar === 'function') updateStatusBar();
    } catch (e) {
      showToast(`Action failed: ${e.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }
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
    $('emailReplySend').disabled = false;
    $('emailReplySend').textContent = actionId === 'forward' ? 'Forward' : 'Send Reply';
    const fwdTo = $('emailForwardTo');
    if (fwdTo) {
      fwdTo.value = '';
      fwdTo.style.display = actionId === 'forward' ? '' : 'none';
    }
    $('emailReplyText').placeholder = actionId === 'forward' ? 'Add a note (optional)…' : 'Type your reply…';
    composer.style.display = '';
    (actionId === 'forward' ? fwdTo : $('emailReplyText'))?.focus();
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
  const detail = _activeEmailDetail;
  if (!detail || detail.msgId !== _replyMsgId) return;
  const detailGen = _emailDetailGen;
  const replyActionId = _replyActionId;
  const text = $('emailReplyText')?.value?.trim();
  const btn = $('emailReplySend');
  if (btn?.disabled) return;
  const isForward = _replyActionId === 'forward';
  let to = '';
  if (isForward) {
    to = $('emailForwardTo')?.value?.trim() ?? '';
    if (!to) { showToast('Enter a recipient to forward to'); $('emailForwardTo')?.focus(); return; }
  } else {
    if (!text) return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const payload = isForward
      ? { tool: 'email_compose', args: { account: detail.accountId ?? undefined, to, subject: 'Fwd: ' + (detail.meta.subject ?? ''), body: text || '' } }
      : { tool: 'email_reply',   args: { messageId: detail.msgId, account: detail.accountId ?? undefined, body: text } };
    const r = await fetch('/api/email/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
    const out = typeof data.result === 'string' ? data.result : '';
    // Success markers vary by backend:
    //   - Gmail / SMTP return "...Message ID: <id>"
    //   - Microsoft Graph /me/sendMail is async (202) and returns "Email sent." / "Reply sent."
    //     with no synchronous message ID
    // Accept either shape; treat anything else (Gmail API error, "Unknown tool", etc.) as failure.
    const looksSuccessful = /Message ID:/i.test(out) || /^\s*(?:Email|Reply|Message)\s+(?:sent|moved)\b/i.test(out);
    if (!looksSuccessful) throw new Error(out || 'Send failed');
    if (detailGen === _emailDetailGen && replyActionId === _replyActionId) closeReplyComposer();
    showToast(isForward ? 'Forwarded' : 'Reply sent');
  } catch (e) {
    alert(`Failed: ${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = isForward ? 'Forward' : 'Send Reply'; }
  }
}

function draftWithEmailAgent() {
  const emailAgent = agents.find(a => a.skillCategory === 'email');
  if (!emailAgent) { alert('No email agent configured. Assign the email skill to one of your agents in Settings.'); return; }
  const meta = _activeEmailDetail?.msgId === _replyMsgId ? _activeEmailDetail.meta : null;
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

document.addEventListener('keydown', (e) => {
  if (!isInboxDrawerOpen() || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
  const composerOpen = $('emailReplyComposer')?.style.display === '';
  if (e.target.matches('input, textarea, select') || e.target.isContentEditable) {
    if (e.key === 'Escape' && e.target.closest('#emailReplyComposer')) {
      e.preventDefault();
      closeReplyComposer();
      $('emailDetailClose')?.focus({ preventScroll: true });
    }
    return;
  }
  if (_activeEmailDetail && (e.key === 'Escape' || e.key === 'Backspace')) {
    e.preventDefault();
    if (composerOpen) closeReplyComposer();
    else closeEmailDetail();
    return;
  }
  // The list stays mounted. Route shortcuts by focus and the selected message.
  if (_activeEmailDetail && !e.target.closest('#drawerInbox')) {
    const actions = { r: 'reply', f: 'forward', e: 'archive', '#': 'trash' };
    if (actions[e.key]) {
      e.preventDefault();
      emailActionClick(actions[e.key], _activeEmailDetail.msgId);
    }
    return;
  }
  const cards = [...document.querySelectorAll('#inboxCardList .email-card-row')];
  const focusedIndex = cards.indexOf(e.target.closest('.email-card-row'));
  if (focusedIndex >= 0) _inboxKeyIdx = focusedIndex;
  if (cards.length) {
    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      _inboxKeyIdx = Math.min(_inboxKeyIdx + 1, cards.length - 1);
      cards[_inboxKeyIdx]?.focus({ preventScroll: true });
      cards[_inboxKeyIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      _inboxKeyIdx = Math.min(Math.max(_inboxKeyIdx - 1, 0), cards.length - 1);
      cards[_inboxKeyIdx]?.focus({ preventScroll: true });
      cards[_inboxKeyIdx]?.scrollIntoView({ block: 'nearest' });
    } else if ((e.key === 'Enter' || e.key === ' ') && focusedIndex >= 0 && !e.target.closest('button')) {
      e.preventDefault();
      cards[focusedIndex].click();
    }
  }
  if (e.key === 'Escape') { e.preventDefault(); closeAllDrawers(); }
});
