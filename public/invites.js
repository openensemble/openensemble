// ── Conversation viewer ───────────────────────────────────────────────────────
let _convViewerUserId = null;

async function openConvViewer(userId, userName) {
  _convViewerUserId = userId;
  $('convViewerTitle').textContent = `💬 ${escHtml(userName)}'s Conversations`;
  $('convViewerBody').innerHTML = '<div style="color:var(--muted);font-size:13px">Loading…</div>';
  $('convViewerModal').classList.add('open');
  try {
    const manifest = await fetch(`/api/admin/sessions/${userId}`).then(r => r.json());
    if (!manifest.length) {
      $('convViewerBody').innerHTML = '<div style="color:var(--muted);font-size:13px">No conversation history.</div>';
      return;
    }
    $('convViewerBody').innerHTML = manifest.map(m => {
      const ts = m.lastTs ? new Date(m.lastTs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return `<div style="background:var(--bg3);border-radius:8px;padding:10px 12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px" onclick="loadConvMessages('${userId}','${escHtml(m.agent)}','${escHtml(userName)}')">
        <div>
          <div style="font-size:13px;font-weight:600">${escHtml(agents.find(a=>a.id===m.agent)?.name ?? m.agent)}</div>
          <div style="font-size:11px;color:var(--muted)">${m.messageCount} messages${ts ? ' · ' + ts : ''}</div>
        </div>
        <span style="color:var(--accent);font-size:12px">View →</span>
      </div>`;
    }).join('');
  } catch (e) {
    $('convViewerBody').innerHTML = `<div style="color:var(--red);font-size:13px">${escHtml(e.message)}</div>`;
  }
}

async function loadConvMessages(userId, agentId, userName) {
  const agentDisplayName = agents.find(a=>a.id===agentId)?.name ?? agentId;
  $('convViewerBody').innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <button onclick="openConvViewer('${userId}','${escHtml(userName)}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:2px 6px;line-height:1">←</button>
      <span style="font-size:13px;font-weight:600">${escHtml(agentDisplayName)}</span>
    </div>
    <div style="color:var(--muted);font-size:13px">Loading messages…</div>`;
  try {
    const { messages } = await fetch(`/api/admin/sessions/${userId}?agent=${encodeURIComponent(agentId)}`).then(r => r.json());
    const backBtn = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <button onclick="openConvViewer('${userId}','${escHtml(userName)}')" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:2px 6px;line-height:1">←</button>
      <span style="font-size:13px;font-weight:600">${escHtml(agentDisplayName)}</span>
    </div>`;
    if (!messages.length) {
      $('convViewerBody').innerHTML = backBtn + '<div style="color:var(--muted);font-size:13px">No messages.</div>';
      return;
    }
    const msgs = messages.map(m => {
      const ts = m.ts ? new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const isUser = m.role === 'user';
      return `<div style="display:flex;flex-direction:column;align-items:${isUser ? 'flex-end' : 'flex-start'};gap:2px">
        <div style="background:${isUser ? 'var(--accent)' : 'var(--bg3)'};color:${isUser ? '#fff' : 'var(--text)'};border-radius:10px;padding:8px 12px;font-size:13px;max-width:85%;line-height:1.45">${renderMarkdown(m.content ?? '')}</div>
        ${ts ? `<div style="font-size:10px;color:var(--muted);padding:0 4px">${ts}</div>` : ''}
      </div>`;
    }).join('');
    $('convViewerBody').innerHTML = backBtn + `<div style="display:flex;flex-direction:column;gap:8px">${msgs}</div>`;
  } catch (e) {
    $('convViewerBody').innerHTML = `<div style="color:var(--red);font-size:13px">${escHtml(e.message)}</div>`;
  }
}

function closeConvViewer() { $('convViewerModal').classList.remove('open'); }

// ── Invite management ─────────────────────────────────────────────────────────
async function openInviteModal() {
  $('inviteModal').classList.add('open');
  $('inviteResult').style.display = 'none';
  await loadInviteList();
}

function closeInviteModal() { $('inviteModal').classList.remove('open'); }

async function loadInviteList() {
  const el = $('inviteList');
  el.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading…</div>';
  try {
    const invites = await fetch('/api/admin/invites').then(r => r.json());
    if (!invites.length) { el.innerHTML = '<div style="color:var(--muted);font-size:12px">No pending invites.</div>'; return; }
    el.innerHTML = invites.map(i => {
      const exp = new Date(i.expiresAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<div style="display:flex;align-items:center;gap:8px;background:var(--bg3);border-radius:6px;padding:6px 10px;font-size:11px">
        <span style="flex:1">${escHtml(i.role)} · expires ${exp}</span>
        <button onclick="revokeInvite('${escHtml(i.fullToken)}')" style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);border-radius:4px;padding:2px 8px;font-size:10px;cursor:pointer">Revoke</button>
      </div>`;
    }).join('');
  } catch { el.innerHTML = '<div style="color:var(--red);font-size:12px">Failed to load.</div>'; }
}

async function generateInvite() {
  const role = $('inviteRole').value;
  const emailTo = $('inviteEmailTo').value.trim();
  try {
    const result = await fetch('/api/admin/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, emailTo: emailTo || undefined }),
    }).then(r => r.json());
    $('inviteUrlInput').value = result.url;
    $('inviteResult').style.display = 'flex';
    if (result.email?.sent) showToast(`Invite emailed to ${result.email.to}`, 2500);
    else if (result.email && !result.email.sent) showToast(`Invite created, but email failed: ${result.email.error}`, 4000);
    await loadInviteList();
  } catch { showToast('Failed to generate invite'); }
}

async function revokeInvite(token) {
  try {
    await fetch(`/api/admin/invites/${token}`, { method: 'DELETE' });
    await loadInviteList();
    showToast('Invite revoked', 2000);
  } catch { showToast('Failed to revoke invite'); }
}

function copyInviteUrl() {
  const input = $('inviteUrlInput');
  input.select();
  navigator.clipboard?.writeText(input.value).catch(() => {});
  showToast('Copied!', 1500);
}

// ── Invite page ───────────────────────────────────────────────────────────────
async function showInvitePage(token) {
  const screen = $('loginScreen');
  screen.classList.remove('hidden');
  $('loginUserList').innerHTML = '';
  $('loginPwRow').style.display = 'none';
  $('loginBtn').style.display = 'none';
  $('loginSetupLink').style.display = 'none';
  $('loginSetupForm').style.display = 'none';

  $('loginSubtitle').textContent = 'Checking invite…';

  try {
    const result = await _origFetch(`/api/invite/${token}`).then(r => r.json());
    if (!result.valid) {
      $('loginSubtitle').textContent = result.reason === 'expired' ? 'This invite link has expired.' : 'Invalid invite link.';
      return;
    }
    $('loginSubtitle').textContent = `You've been invited! Create your profile.`;

    // Build invite setup form
    const panel = screen.querySelector('.login-panel');
    const formEl = document.createElement('div');
    formEl.className = 'login-setup-form';
    formEl.style.display = 'flex';
    formEl.innerHTML = `
      <div style="font-size:13px;color:var(--muted);text-align:center">Role: ${escHtml(result.role)}</div>
      <div class="login-emoji-row">
        <select id="inviteSetupEmoji">
          <option>🙂</option><option>🧑</option><option>👩</option><option>👨</option>
          <option>🧒</option><option>🦊</option><option>🧑‍💻</option><option>🎨</option>
        </select>
        <input id="inviteSetupName" placeholder="Your name" maxlength="30">
      </div>
      <input type="password" id="inviteSetupPw" placeholder="Choose a password" autocomplete="new-password">
      <input type="password" id="inviteSetupPin" placeholder="Optional PIN (for profile switching)" autocomplete="new-password">
      <div class="login-error" id="inviteSetupError"></div>
      <button class="login-btn" id="inviteSetupBtn">Create Profile & Sign In</button>`;
    panel.appendChild(formEl);

    $('inviteSetupBtn').addEventListener('click', async () => {
      const name = $('inviteSetupName').value.trim();
      const pw = $('inviteSetupPw').value;
      const pin = $('inviteSetupPin').value;
      const emoji = $('inviteSetupEmoji').value;
      const errEl = $('inviteSetupError');
      if (!name) { errEl.textContent = 'Name required'; return; }
      if (!pw || pw.length < 4) { errEl.textContent = 'Password must be at least 4 characters'; return; }
      errEl.textContent = '';
      try {
        const r = await _origFetch(`/api/invite/${token}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, emoji, password: pw, pin: pin || undefined }),
        });
        const d = await r.json();
        if (!r.ok) { errEl.textContent = d.error ?? 'Failed to create profile'; return; }
        setToken(d.token);
        setCurrentUser(d.user);
        history.replaceState({}, '', '/');
        screen.classList.add('hidden');
        reconnectWS();
      } catch (e) { errEl.textContent = e.message; }
    });
  } catch {
    $('loginSubtitle').textContent = 'Failed to validate invite.';
  }
}

