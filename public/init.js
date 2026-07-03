// ── Init ──────────────────────────────────────────────────────────────────────
let _initDone = false;
// Multi-step input recall state (terminal-style, last 10 user messages)
let _recallIdx = -1;
let _lastRecallText = null;

async function init() {
  // Check for invite URL first
  const inviteToken = window.location.pathname.match(/^\/invite\/([a-f0-9]+)$/)?.[1];
  if (inviteToken) { showInvitePage(inviteToken); return; }

  // Auth check first. Cookie auth is automatic for same-origin requests.
  const me = await _origFetch('/api/me', { credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null).catch(() => null);
  if (!me) { showLoginScreen(); return; }
  setCurrentUser(me);
  $('loginScreen').classList.add('hidden');
  ensureMediaToken().catch(() => {});

  // Handle OAuth callback redirect (?oauth=success|error)
  const oauthParam = new URLSearchParams(window.location.search).get('oauth');
  if (oauthParam) {
    const service = new URLSearchParams(window.location.search).get('service') ?? '';
    const SERVICE_LABELS = {
      'gcal':         'Google Calendar',
      'gmail':        'Gmail',
      'openai-codex': 'OpenAI (ChatGPT login)',
    };
    const label = SERVICE_LABELS[service] ?? 'Account';
    if (oauthParam === 'success') {
      setTimeout(() => appendAssistantBubble(`**${label} connected successfully.**`), 500);
    } else {
      const reason = new URLSearchParams(window.location.search).get('reason') ?? 'unknown error';
      setTimeout(() => appendError(`${label} authorization failed: ${reason}`), 500);
    }
    history.replaceState({}, '', '/');
  }

  try {
    const r = await fetch('/api/agents');
    agents = await r.json();
    activeAgent = agents[0]?.id ?? null;
  } catch { agents = [{ id: 'research', name: 'Research', emoji: '🔬', model: 'qwen2.5:7b', provider: 'ollama' }]; activeAgent = 'research'; }

  // Child onboarding: children start with zero agents. Ask them to name a helper
  // before the chat UI becomes usable. Server force-clamps the toolSet, so the
  // child can't bypass this by sending a hand-crafted POST either.
  if (_currentUser?.role === 'child' && agents.length === 0) {
    const created = await showChildHelperOnboarding();
    if (created) { agents = [created]; activeAgent = created.id; }
  }

  buildTabs();
  buildAgentDrawer();
  loadProviderConfig().then(() => checkEmptyState()).catch(() => {});
  loadModels().then(() => checkEmptyState()).catch(() => {});
  loadTaskList();
  startStatusBar();

  if (!_initDone) {
    _initDone = true;
    $('input').addEventListener('input', () => {
      resizeTextarea();
      if ($('input').value.startsWith('/')) { slashMenuIdx = 0; updateSlashMenu(); }
      else hideSlashMenu();
      if ($('input').value.startsWith('@')) { updateAtMenu(); }
      else hideAtMenu();
      renderToolPlanPicker();
      // If we're in recall mode and the user just typed (current value diverges
      // from what we set), exit recall so the next ArrowUp restarts at newest.
      // Programmatic .value sets do NOT fire 'input', so this only catches
      // genuine user edits.
      if (_recallIdx >= 0 && $('input').value !== _lastRecallText) {
        _recallIdx = -1;
        _lastRecallText = null;
      }
    });
    $('input').addEventListener('keydown', e => {
      if (slashMenuItems.length) {
        if (e.key === 'ArrowUp')   { e.preventDefault(); slashMenuNav(-1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); slashMenuNav(1);  return; }
        if (e.key === 'Escape')    { e.preventDefault(); hideSlashMenu();   return; }
        if (e.key === 'Tab')       { e.preventDefault(); slashMenuItems[slashMenuIdx]?.action(); return; }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); slashMenuItems[slashMenuIdx]?.action(); return; }
      }
      // @-menu nav: Tab completes the handle, Enter completes (doesn't send),
      // Escape closes the menu. Once the user has typed a space after the
      // handle the menu auto-hides via the input handler, so Enter goes back
      // to its normal "send" behavior for the rest of the message.
      if (window._atMenuItems && window._atMenuItems().length) {
        if (e.key === 'ArrowUp')   { e.preventDefault(); atMenuNav(-1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); atMenuNav(1);  return; }
        if (e.key === 'Escape')    { e.preventDefault(); hideAtMenu();   return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          window._atMenuAction?.();
          return;
        }
      }
      // Terminal-style multi-step recall: ArrowUp walks back through the last
      // 10 user messages in this agent's session (newest first); ArrowDown
      // walks back toward the most recent / blank. Per-agent — switching
      // agents wipes recall state. Skips if user has typed something we
      // didn't recall (preserves their in-progress text).
      //
      // State machine:
      //   _recallIdx = -1  → not in recall mode (input is empty or user-typed)
      //   _recallIdx = 0   → showing newest user message
      //   _recallIdx = N   → showing N+1-th newest
      //   _lastRecallText  → last value we wrote into the textarea, used to
      //                      detect whether the user has edited the recalled
      //                      message (in which case we exit recall and
      //                      preserve their text).
      if (e.key === 'ArrowUp') {
        const cur = $('input').value;
        const continuing = _recallIdx >= 0 && cur === _lastRecallText;
        if (!continuing) {
          if (cur !== '') return;       // user-typed text — leave alone
          _recallIdx = -1;              // restart from newest
        }
        const userMsgs = (sessions[activeAgent] || [])
          .filter(m => m.role === 'user' && !m.hidden && m.content)
          .slice(-10).reverse();        // last 10, newest first
        if (!userMsgs.length) return;    // session wiped or no user msgs
        const nextIdx = Math.min(userMsgs.length - 1, _recallIdx + 1);
        if (nextIdx === _recallIdx) return; // already at oldest available
        _recallIdx = nextIdx;
        _lastRecallText = userMsgs[_recallIdx].content;
        e.preventDefault();
        $('input').value = _lastRecallText;
        resizeTextarea();
        renderToolPlanPicker();
        $('input').setSelectionRange(_lastRecallText.length, _lastRecallText.length);
        return;
      }
      if (e.key === 'ArrowDown' && _recallIdx >= 0 && $('input').value === _lastRecallText) {
        const userMsgs = (sessions[activeAgent] || [])
          .filter(m => m.role === 'user' && !m.hidden && m.content)
          .slice(-10).reverse();
        const nextIdx = _recallIdx - 1;
        if (nextIdx < 0) {
          // Walked back past the newest — exit recall + clear input.
          _recallIdx = -1; _lastRecallText = null;
          e.preventDefault();
          $('input').value = '';
          resizeTextarea();
          renderToolPlanPicker();
          return;
        }
        _recallIdx = nextIdx;
        _lastRecallText = userMsgs[_recallIdx].content;
        e.preventDefault();
        $('input').value = _lastRecallText;
        resizeTextarea();
        renderToolPlanPicker();
        $('input').setSelectionRange(_lastRecallText.length, _lastRecallText.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 640) { e.preventDefault(); send(); }
    });
    $('input').addEventListener('blur', () => { hideSlashMenu(); hideAtMenu(); });
    $('btnSend').addEventListener('click', send);
    $('btnStop').addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'stop', agent: activeAgent }));
      // The server emits no terminal event for an aborted turn — finalize the
      // partial reply here, or the next turn's tokens append onto this bubble.
      // Commit what streamed so far (client-side only; the server never
      // persisted the aborted turn) so it survives an agent switch.
      flushStreamRender();
      if (streamEl && streamBuf && activeAgent) {
        if (!sessions[activeAgent]) sessions[activeAgent] = [];
        sessions[activeAgent].push({ role: 'assistant', content: streamBuf, ts: Date.now(), toolEvents: currentLiveToolEvents() });
        addTimestamp(streamEl.closest('.msg'));
      }
      streamEl = null; streamBuf = ''; resetToolRun();
      setStreaming(false); setTyping(false);
    });
    $('btnAttach').addEventListener('click', () => $('chatFileInput').click());
    $('chatFileInput').addEventListener('change', e => handleChatFileSelect(e.target.files[0]));

    // Drop a file anywhere on the page to attach it to the current chat.
    // Uses an enter/leave depth counter so leaving a child element doesn't
    // flicker the overlay off mid-drag.
    let _dropDepth = 0;
    let _dropOverlay = null;
    const _hasFiles = e => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const _ensureDropOverlay = () => {
      if (_dropOverlay) return _dropOverlay;
      _dropOverlay = document.createElement('div');
      _dropOverlay.style.cssText = 'position:fixed;inset:12px;border:3px dashed var(--accent);border-radius:14px;background:rgba(94,160,255,0.12);display:none;align-items:center;justify-content:center;z-index:9998;pointer-events:none;font-size:18px;font-weight:600;color:var(--text);letter-spacing:.3px;backdrop-filter:blur(2px)';
      _dropOverlay.textContent = 'Drop to attach to chat';
      document.body.appendChild(_dropOverlay);
      return _dropOverlay;
    };
    document.addEventListener('dragenter', e => {
      if (!_hasFiles(e)) return;
      _dropDepth++;
      _ensureDropOverlay().style.display = 'flex';
    });
    document.addEventListener('dragover', e => { if (_hasFiles(e)) e.preventDefault(); });
    document.addEventListener('dragleave', e => {
      if (!_hasFiles(e)) return;
      _dropDepth = Math.max(0, _dropDepth - 1);
      if (!_dropDepth && _dropOverlay) _dropOverlay.style.display = 'none';
    });
    document.addEventListener('drop', e => {
      if (!_hasFiles(e)) return;
      e.preventDefault();
      _dropDepth = 0;
      if (_dropOverlay) _dropOverlay.style.display = 'none';
      const file = e.dataTransfer.files?.[0];
      if (file) handleChatFileSelect(file);
    });

    // Paste an image (or any file) directly into the chat input.
    $('input').addEventListener('paste', e => {
      const items = e.clipboardData?.items ?? [];
      for (const it of items) {
        if (it.kind === 'file') {
          const file = it.getAsFile();
          if (file) { e.preventDefault(); handleChatFileSelect(file); return; }
        }
      }
    });
  }

  connect();

  // Fire-and-forget: light up the Guide button's "new" dot if whats-new.md
  // changed since this browser last opened it. Cheap GET; no need to await.
  if (typeof checkWhatsNewBadge === 'function') checkWhatsNewBadge();

  // Render Lucide icons for any data-lucide elements
  if (window.lucide) lucide.createIcons();
}

function reconnectWS() { init(); }

async function showChildHelperOnboarding() {
  const emojiChoices = ['🤖','🐶','🦊','🐼','🐯','🦄','🐙','🐳','🦖','🐝','🌟','🚀'];
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);display:flex;align-items:center;justify-content:center;z-index:10000;backdrop-filter:blur(4px)';
  overlay.innerHTML = `
    <div style="background:var(--bg1);border:1px solid var(--border);border-radius:14px;padding:28px 32px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5)">
      <h2 style="margin:0 0 6px;font-size:20px;color:var(--text)">Pick a name for your helper</h2>
      <p style="margin:0 0 18px;font-size:13px;color:var(--muted);line-height:1.5">This will be your AI assistant. You can pick any name and icon you like.</p>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px" id="childEmojiRow">
        ${emojiChoices.map((e, i) => `<button type="button" data-emoji="${e}" class="childEmojiBtn" style="font-size:22px;width:40px;height:40px;border:1px solid var(--border);background:${i===0?'var(--accent)':'var(--bg2)'};border-radius:8px;cursor:pointer">${e}</button>`).join('')}
      </div>
      <input id="childHelperName" type="text" placeholder="Buddy" maxlength="24" style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:10px 12px;font-size:15px;margin-bottom:6px" />
      <div id="childHelperErr" style="font-size:12px;color:#e05c5c;min-height:18px;margin-bottom:6px"></div>
      <button id="childHelperGo" style="width:100%;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:12px;font-size:15px;font-weight:600;cursor:pointer">Create my helper</button>
    </div>
  `;
  document.body.appendChild(overlay);
  let chosenEmoji = emojiChoices[0];
  overlay.querySelectorAll('.childEmojiBtn').forEach(btn => {
    btn.addEventListener('click', () => {
      chosenEmoji = btn.dataset.emoji;
      overlay.querySelectorAll('.childEmojiBtn').forEach(b => b.style.background = 'var(--bg2)');
      btn.style.background = 'var(--accent)';
    });
  });
  const nameEl = overlay.querySelector('#childHelperName');
  const errEl  = overlay.querySelector('#childHelperErr');
  const goBtn  = overlay.querySelector('#childHelperGo');
  nameEl.focus();
  return new Promise(resolve => {
    const submit = async () => {
      const name = nameEl.value.trim();
      errEl.textContent = '';
      if (!name) { errEl.textContent = 'Please type a name.'; return; }
      goBtn.disabled = true; goBtn.textContent = 'Creating…';
      try {
        const res = await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, emoji: chosenEmoji, description: `${name} is my helper.` }),
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Could not create');
        const agent = await res.json();
        overlay.remove();
        resolve(agent);
      } catch (e) {
        errEl.textContent = e.message;
        goBtn.disabled = false; goBtn.textContent = 'Create my helper';
      }
    };
    goBtn.addEventListener('click', submit);
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  });
}

init();
