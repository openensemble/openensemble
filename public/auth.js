// ── Migrate legacy localStorage keys ─────────────────────────────────────────
for (const [o, n] of [['clawd_token','oe_token'],['clawd_user_id','oe_user_id'],
  ['clawd_layout','oe_layout'],['clawd_custom_models','oe_custom_models'],
  ['clawd_reminder_board','oe_reminder_board']]) {
  const v = localStorage.getItem(o);
  if (v !== null && localStorage.getItem(n) === null) {
    localStorage.setItem(n, v); localStorage.removeItem(o);
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function getToken() { return localStorage.getItem('oe_token'); }
function setToken(t) {
  if (t) localStorage.setItem('oe_token', t);
  else { localStorage.removeItem('oe_token'); _mediaTok = null; _mediaTokExpiresAt = 0; }
}

// Short-lived media tokens for <img>/<video>/<iframe> URLs — we never put the
// real session token in a URL (leaks via Referer/history/logs). The server
// mints these via POST /api/media-token with a 10-minute TTL. We cache one
// in memory and refresh well before expiry.
let _mediaTok = null;
let _mediaTokExpiresAt = 0;
let _mediaTokPromise = null;
const MEDIA_REFRESH_SKEW_MS = 60_000; // refresh 1 minute before expiry

async function refreshMediaToken() {
  if (_mediaTokPromise) return _mediaTokPromise;
  _mediaTokPromise = (async () => {
    const r = await fetch('/api/media-token', { method: 'POST' });
    if (!r.ok) { _mediaTok = null; _mediaTokExpiresAt = 0; return null; }
    const { token, expiresIn } = await r.json();
    _mediaTok = token;
    _mediaTokExpiresAt = Date.now() + expiresIn * 1000;
    return token;
  })();
  try { return await _mediaTokPromise; } finally { _mediaTokPromise = null; }
}

// Best-effort sync accessor for URL interpolation: returns the cached token
// if it's still fresh; otherwise kicks off a refresh and returns whatever we
// have (empty string on cold start). Callers should re-render after login.
function getMediaTokenSync() {
  if (_mediaTok && Date.now() < _mediaTokExpiresAt - MEDIA_REFRESH_SKEW_MS) return _mediaTok;
  refreshMediaToken().catch(() => {});
  return _mediaTok || '';
}

async function ensureMediaToken() {
  if (_mediaTok && Date.now() < _mediaTokExpiresAt - MEDIA_REFRESH_SKEW_MS) return _mediaTok;
  return await refreshMediaToken();
}

// Intercept all fetch calls to add auth token and handle 401
const _origFetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (typeof url === 'string' && url.startsWith('/api') && url !== '/api/login') {
    const token = getToken();
    if (token) opts = { ...opts, headers: { ...(opts.headers ?? {}), Authorization: `Bearer ${token}` } };
  }
  return _origFetch(url, opts).then(r => {
    if (r.status === 401 && typeof url === 'string' && url !== '/api/login') {
      setToken(null);
      showLoginScreen();
    }
    return r;
  });
};

let _loginSelectedUser = null;

async function showLoginScreen() {
  const screen = $('loginScreen');
  screen.classList.remove('hidden');
  $('loginPwRow').style.display = 'none';
  $('loginBtn').style.display = 'none';
  $('loginSetupForm').style.display = 'none';
  $('loginSetupLink').style.display = 'none';
  $('loginError').textContent = '';
  _loginSelectedUser = null;

  const users = await _origFetch('/api/users').then(r => r.json()).catch(() => []);
  const list = $('loginUserList');

  if (!users.length) {
    list.innerHTML = '';
    $('loginSubtitle').textContent = 'Welcome to OpenEnsemble';
    $('loginSetupForm').style.display = 'flex';
  } else {
    $('loginSubtitle').textContent = 'Select your profile';
    list.innerHTML = users.map(u => {
      const avatarInner = u.avatar
        ? `<div class="login-avatar"><img src="${u.avatar}" alt=""></div>`
        : `<div class="login-avatar" style="background:${u.color ?? 'var(--bg3)'}">${u.emoji ?? '🧑'}</div>`;
      return `<button class="login-user-btn" data-id="${u.id}" onclick="selectLoginUser('${u.id}','${escHtml(u.name)}')">
        ${avatarInner}
        <div class="login-user-name">${escHtml(u.name)}</div>
      </button>`;
    }).join('');
    // Auto-select if only one user
    if (users.length === 1) selectLoginUser(users[0].id, users[0].name);
  }
}

function selectLoginUser(id, name) {
  _loginSelectedUser = id;
  document.querySelectorAll('.login-user-btn').forEach(b => b.classList.toggle('selected', b.dataset.id === id));
  $('loginSubtitle').textContent = `Welcome back, ${name}`;
  $('loginPwRow').style.display = 'flex';
  $('loginBtn').style.display = 'block';
  $('loginSetupForm').style.display = 'none';
  setTimeout(() => $('loginPw').focus(), 50);
}

async function doLogin() {
  const pw = $('loginPw').value;
  if (!pw || !_loginSelectedUser) return;
  $('loginBtn').disabled = true;
  $('loginError').textContent = '';
  try {
    const r = await _origFetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: _loginSelectedUser, password: pw }),
    });
    const d = await r.json();
    if (!r.ok) { $('loginError').textContent = d.error ?? 'Login failed'; $('loginBtn').disabled = false; return; }
    setToken(d.token);
    setCurrentUser(d.user);
    $('loginScreen').classList.add('hidden');
    $('loginPw').value = '';
    ensureMediaToken().catch(() => {});
    // Reconnect WS with new token
    reconnectWS();
  } catch (e) { $('loginError').textContent = e.message; }
  $('loginBtn').disabled = false;
}

function showSetupForm() {
  $('loginSetupForm').style.display = 'flex';
  $('loginUserList').innerHTML = '';
  $('loginSubtitle').textContent = 'Create a new profile';
  $('loginSetupLink').style.display = 'none';
  $('loginPwRow').style.display = 'none';
  $('loginBtn').style.display = 'none';
}

async function doSetup() {
  const name = $('setupName').value.trim();
  const pw = $('setupPw').value;
  const pw2 = $('setupPw2').value;
  const emoji = $('setupEmoji').value;
  if (!name) { $('setupError').textContent = 'Name required'; return; }
  if (!pw || pw.length < 8) { $('setupError').textContent = 'Password must be at least 8 characters'; return; }
  if (pw !== pw2) { $('setupError').textContent = 'Passwords do not match'; return; }
  $('setupError').textContent = '';
  try {
    const r = await _origFetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, emoji, password: pw }),
    });
    const d = await r.json();
    if (!r.ok) { $('setupError').textContent = d.error ?? 'Failed to create profile'; return; }
    // Auto-login
    const lr = await _origFetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: d.id, password: pw }),
    });
    const ld = await lr.json();
    setToken(ld.token);
    setCurrentUser(ld.user ?? d);
    $('loginScreen').classList.add('hidden');
    $('setupName').value = ''; $('setupPw').value = ''; $('setupPw2').value = '';
    reconnectWS();
  } catch (e) { $('setupError').textContent = e.message; }
}

async function doInitialRestore() {
  const fileInput = document.getElementById('setupRestoreFile');
  const btn = document.getElementById('setupRestoreBtn');
  const status = document.getElementById('setupRestoreStatus');
  if (!fileInput?.files?.length) { status.textContent = 'Choose a .tar.gz backup first.'; return; }
  if (!confirm('Restore this backup? Your profiles and data will be imported from the archive.')) return;
  btn.disabled = true; btn.textContent = 'Restoring…';
  status.style.color = 'var(--muted)';
  status.textContent = 'Uploading backup…';
  try {
    const buf = await fileInput.files[0].arrayBuffer();
    const r = await _origFetch('/api/admin/restore-initial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: buf,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Restore failed (${r.status})`);
    status.style.color = 'var(--green,#43b89c)';
    status.textContent = `Restored ${data.restored} item(s). Reloading…`;
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    status.style.color = 'var(--red,#e05c5c)';
    status.textContent = 'Error: ' + e.message;
    btn.disabled = false; btn.textContent = 'Restore from Backup';
  }
}

// Allow Enter key on password field
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('loginPw')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('setupPw2')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSetup(); });
  const restoreFile = document.getElementById('setupRestoreFile');
  const restoreBtn = document.getElementById('setupRestoreBtn');
  if (restoreFile && restoreBtn) {
    restoreFile.addEventListener('change', () => {
      restoreBtn.disabled = !restoreFile.files?.length;
    });
  }
});

async function logout() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  setToken(null);
  setCurrentUser(null);
  location.reload();
}

// ── Users (multi-profile) ─────────────────────────────────────────────────────
let _currentUser = null;

function getCurrentUserId() {
  return localStorage.getItem('oe_user_id') ?? null;
}

function setCurrentUser(user) {
  _currentUser = user;
  if (user) {
    localStorage.setItem('oe_user_id', user.id);
    if (user.avatar) {
      $('stripUserEmoji').innerHTML = `<img src="${user.avatar}?t=${Date.now()}" alt="">`;
      $('stripUserBtn').style.background = 'transparent';
    } else {
      $('stripUserEmoji').textContent = user.emoji ?? '🧑';
      $('stripUserBtn').style.background = user.color ?? 'var(--bg3)';
    }
    $('stripUserBtn').title = user.name;
    $('stripUserTooltip').textContent = user.name;
    // Apply saved news topic (may be overridden by plugin prefs in loadPlugins)
    if (typeof user.newsDefaultTopic === 'number') newsTopic = user.newsDefaultTopic;
    loadDrawers();
    // Surface the update badge for admins without requiring them to open Settings.
    if ((user.role === 'owner' || user.role === 'admin') && typeof loadUpdateStatus === 'function') {
      loadUpdateStatus();
    }
  } else {
    localStorage.removeItem('oe_user_id');
    $('stripUserEmoji').textContent = '🧑';
    $('stripUserBtn').style.background = 'var(--bg3)';
    $('stripUserBtn').title = 'Profile';
    $('stripUserTooltip').textContent = 'Profile';
  }
}

async function saveNewsTopicPref(idx) {
  newsTopic = idx;
  const p = plugins.find(pl => pl.id === 'news');
  if (p?.settings) p.settings.defaultTopic = idx;
  try {
    await fetch('/api/drawers/news/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultTopic: idx }),
    });
  } catch {}
}

async function saveNewsPreference() {
  const idx = parseInt($('newsDefaultTopicSelect')?.value ?? '0');
  await saveNewsTopicPref(idx);
}

async function loadSkillsList() {
  const rolesEl = $('rolesList');
  const skillsEl = $('skillsList');
  if (!rolesEl && !skillsEl) return;
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  try {
    const [skills, allAgents, cfg] = await Promise.all([
      fetch('/api/roles').then(r => r.json()),
      fetch('/api/agents').then(r => r.json()),
      fetch('/api/config-public').then(r => r.json()).catch(() => ({})),
    ]);
    const roles = skills.filter(s => s.service);
    const tools = skills.filter(s => !s.service && s.category !== 'delegate');

    function roleCard(s) {
      const owner = s.assignment ? (allAgents.find(a => a.id === s.assignment) ?? null) : null;
      const delegationHtml = owner
        ? `<div style="font-size:10px;color:var(--muted);margin-top:3px">${escHtml(owner.emoji ?? '')} ${escHtml(owner.name)}</div>`
        : `<div style="font-size:10px;color:var(--muted);margin-top:3px;font-style:italic">Unassigned</div>`;
      const deleteBtn = isPriv
        ? `<button onclick="deleteRole('${escHtml(s.id)}')" title="Delete"
             style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:4px 2px;flex-shrink:0;line-height:1"
             onmouseover="this.style.color='var(--red,#e05c5c)'" onmouseout="this.style.color='var(--muted)'">✕</button>`
        : '';
      return `<div>
        <div style="display:flex;align-items:flex-start;gap:12px;background:var(--bg3);border-radius:8px;padding:10px 12px">
          <span style="font-size:20px;flex-shrink:0;margin-top:1px">${s.icon ?? '🎯'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text)">${escHtml(s.name)}</div>
            ${s.description ? `<div style="font-size:11px;color:var(--muted)">${escHtml(s.description)}</div>` : ''}
            ${delegationHtml}
          </div>
          ${deleteBtn}
        </div>
      </div>`;
    }

    function toolCard(s) {
      return `<div style="background:var(--bg3);border-radius:8px;padding:10px 12px">
        <div style="display:flex;align-items:center;gap:12px">
          <span style="font-size:18px;flex-shrink:0">${s.icon ?? '🔧'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text)">${escHtml(s.name)}</div>
            ${s.description ? `<div style="font-size:11px;color:var(--muted)">${escHtml(s.description)}</div>` : ''}
          </div>
        </div>
      </div>`;
    }

    const noAccessMsg = `<div style="color:var(--muted);font-size:12px;font-style:italic">Access is managed by your administrator.</div>`;

    // ── Roles panel ──
    if (rolesEl) {
      if (!isPriv && roles.length === 0) {
        rolesEl.innerHTML = noAccessMsg;
      } else {
        let html = `<div style="display:flex;flex-direction:column;gap:8px">` + roles.map(roleCard).join('') + `</div>`;
        if (isPriv) {
          html += `<button onclick="openNewRoleModal()"
            style="width:100%;background:var(--bg3);border:1px dashed var(--border);color:var(--muted);border-radius:8px;padding:9px;font-size:12px;cursor:pointer;margin-top:8px;font-weight:500"
            onmouseover="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
            onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--muted)'">+ New Role</button>`;
        }
        rolesEl.innerHTML = html;
      }
    }

    // ── Skills panel ──
    if (skillsEl) {
      if (!isPriv && tools.length === 0) {
        skillsEl.innerHTML = noAccessMsg;
      } else {
        skillsEl.innerHTML = tools.length
          ? `<div style="display:flex;flex-direction:column;gap:8px">` + tools.map(toolCard).join('') + `</div>`
          : `<div style="color:var(--muted);font-size:12px">No tools available.</div>`;
      }
    }
  } catch (e) {
    const msg = `<div style="color:var(--red);font-size:12px">${escHtml(e.message)}</div>`;
    if (rolesEl) rolesEl.innerHTML = msg;
    if (skillsEl) skillsEl.innerHTML = msg;
  }
}

async function deleteRole(id) {
  if (!confirm('Delete this role? This cannot be undone.')) return;
  try {
    const r = await fetch(`/api/roles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json()).error);
    showToast('Role deleted');
    _skillsCache = null;
    loadSkillsList();
  } catch (e) { showToast(e.message || 'Failed to delete'); }
}

function openNewRoleModal() {
  let modal = $('newRoleModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'newRoleModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;width:100%;max-width:440px;display:flex;flex-direction:column;gap:12px">
        <div style="font-size:15px;font-weight:700;color:var(--text)">New Role</div>
        <div style="display:flex;gap:8px">
          <input id="newRoleIcon" placeholder="🎯" maxlength="4"
            style="width:52px;text-align:center;font-size:18px;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px">
          <input id="newRoleName" placeholder="Role name (e.g. Researcher)"
            style="flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:13px">
        </div>
        <input id="newRoleDesc" placeholder="Short description (shown in Tools tab)"
          style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:13px">
        <textarea id="newRoleResp" rows="5" placeholder="Responsibilities — injected into the agent's system prompt when this role is active"
          style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:12px;resize:vertical;font-family:inherit"></textarea>
        <div id="newRoleError" style="font-size:11px;color:var(--red,#e05c5c);min-height:14px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button onclick="$('newRoleModal').remove()"
            style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:8px 16px;font-size:12px;cursor:pointer">Cancel</button>
          <button onclick="submitNewRole()"
            style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:8px 16px;font-size:12px;cursor:pointer;font-weight:600">Create Role</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }
  modal.style.display = 'flex';
  $('newRoleName')?.focus();
}

async function submitNewRole() {
  const name = $('newRoleName')?.value.trim();
  const icon = $('newRoleIcon')?.value.trim();
  const description = $('newRoleDesc')?.value.trim();
  const responsibilities = $('newRoleResp')?.value.trim();
  const errEl = $('newRoleError');
  if (!name) { if (errEl) errEl.textContent = 'Name is required'; return; }
  try {
    const r = await fetch('/api/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, icon, description, responsibilities }) });
    const data = await r.json();
    if (!r.ok) { if (errEl) errEl.textContent = data.error; return; }
    $('newRoleModal')?.remove();
    showToast(`Role "${name}" created`);
    _skillsCache = null;
    loadSkillsList();
  } catch { if (errEl) errEl.textContent = 'Failed to create role'; }
}

async function toggleSkill(skillId, enabled) {
  try {
    await fetch('/api/roles/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId, enabled }),
    });
    // Reload agents list since tool availability changed
    const updated = await fetch('/api/agents').then(r => r.json());
    agents = updated;
    buildTabs();
    buildAgentDrawer();
  } catch {}
}
