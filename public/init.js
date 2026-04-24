// ── Init ──────────────────────────────────────────────────────────────────────
let _initDone = false;

async function init() {
  // Check for invite URL first
  const inviteToken = window.location.pathname.match(/^\/invite\/([a-f0-9]+)$/)?.[1];
  if (inviteToken) { showInvitePage(inviteToken); return; }

  // Auth check first
  const token = getToken();
  let authed = false;
  if (token) {
    const me = await _origFetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null).catch(() => null);
    if (me) { setCurrentUser(me); $('loginScreen').classList.add('hidden'); authed = true; }
  }
  if (!authed) { showLoginScreen(); return; }
  ensureMediaToken().catch(() => {});

  // Handle OAuth callback redirect (?oauth=success|error)
  const oauthParam = new URLSearchParams(window.location.search).get('oauth');
  if (oauthParam) {
    const service = new URLSearchParams(window.location.search).get('service') ?? '';
    const label = service === 'gcal' ? 'Google Calendar' : 'Gmail';
    if (oauthParam === 'success') {
      setTimeout(() => appendAssistantBubble(`**${label} connected successfully.**`), 500);
    } else {
      const reason = new URLSearchParams(window.location.search).get('reason') ?? 'unknown error';
      setTimeout(() => appendError(`Google authorization failed: ${reason}`), 500);
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
  loadProviderConfig();
  loadModels();
  loadTaskList();
  startStatusBar();
  if (typeof initMirror === 'function') initMirror();

  if (!_initDone) {
    _initDone = true;
    $('input').addEventListener('input', () => {
      resizeTextarea();
      if ($('input').value.startsWith('/')) { slashMenuIdx = 0; updateSlashMenu(); }
      else hideSlashMenu();
    });
    $('input').addEventListener('keydown', e => {
      if (slashMenuItems.length) {
        if (e.key === 'ArrowUp')   { e.preventDefault(); slashMenuNav(-1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); slashMenuNav(1);  return; }
        if (e.key === 'Escape')    { e.preventDefault(); hideSlashMenu();   return; }
        if (e.key === 'Tab')       { e.preventDefault(); slashMenuItems[slashMenuIdx]?.action(); return; }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); slashMenuItems[slashMenuIdx]?.action(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 640) { e.preventDefault(); send(); }
    });
    $('input').addEventListener('blur', () => hideSlashMenu());
    $('btnSend').addEventListener('click', send);
    $('btnStop').addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'stop', agent: activeAgent }));
      setStreaming(false); setTyping(false);
    });
    $('btnAttach').addEventListener('click', () => $('chatFileInput').click());
    $('chatFileInput').addEventListener('change', e => handleChatFileSelect(e.target.files[0]));
  }

  connect();

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
