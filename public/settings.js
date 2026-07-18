// Settings core (browser bridge, reminders, sessions, drawers, TV, …).
// Models / network / MCP panels live in sibling settings-*.js scripts.

// ── Browser Bridge tab ───────────────────────────────────────────────────────
let _browserBridgePollTimer = null;
async function loadBrowserBridge() {
  const body = document.getElementById('browserBridgeBody');
  if (!body) return;
  try {
    const r = await fetch('/api/browser/status', { credentials: 'include', cache: 'no-store' });
    if (!r.ok) {
      body.innerHTML = `<div style="font-size:12px;color:var(--muted)">Couldn't fetch status (HTTP ${r.status}).</div>`;
      return;
    }
    const j = await r.json();
    const list = j.connected || [];
    if (!list.length) {
      body.innerHTML = `
        <div style="font-size:13px;color:var(--muted);margin-bottom:12px">
          No browser extensions connected.
        </div>
        <div style="font-size:12px;color:var(--text);line-height:1.6">
          Install the <b>OpenEnsemble Bridge</b> extension to let your agents see your tabs, open URLs, control media playback, and use your browser as a fetcher for sites without APIs.
          <ol style="margin:8px 0 0 18px;padding:0">
            <li>Open <code>chrome://extensions</code> (or <code>edge://extensions</code>).</li>
            <li>Toggle <b>Developer mode</b> on.</li>
            <li>Click <b>Load unpacked</b> and pick <code>~/.openensemble/browser-extension/</code>.</li>
            <li>Click the new puzzle-piece icon. It should auto-detect this server and connect.</li>
          </ol>
        </div>
      `;
      return;
    }
    const fmtTime = (ts) => ts ? new Date(ts).toLocaleString() : '?';
    const rows = list.map(b => {
      const tabs = (b.tabs || []).slice(0, 25).map(t => {
        const star = t.active ? '★' : ' ';
        const safe = (s) => String(s || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
        return `<div style="font-size:11px;color:var(--text);font-family:monospace;padding:2px 0">${star} <span style="color:var(--muted)">[${t.tabId}]</span> ${safe(t.title || '(no title)')}<br><span style="color:var(--muted);margin-left:16px">${safe(t.url)}</span></div>`;
      }).join('');
      const overflow = (b.tabs || []).length > 25 ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">… ${(b.tabs || []).length - 25} more tab(s)</div>` : '';
      return `
        <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div>
              <div style="font-weight:600;font-size:13px">${escHtml(b.name || '(unnamed)')}${b.version ? ` <span style="color:var(--muted);font-weight:400;font-size:11px">v${escHtml(b.version)}</span>` : ''}</div>
              <div style="font-size:11px;color:var(--muted);font-family:monospace;margin-top:2px">extId: ${escHtml(b.extId)}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">Connected: ${fmtTime(b.registeredAt)} · ${b.tabCount} tab(s)</div>
            </div>
          </div>
          ${tabs ? `<details><summary style="cursor:pointer;font-size:11px;color:var(--muted)">Open tabs (${b.tabCount})</summary><div style="margin-top:6px;max-height:240px;overflow-y:auto">${tabs}${overflow}</div></details>` : ''}
        </div>
      `;
    }).join('');
    body.innerHTML = rows;
  } catch (e) {
    body.innerHTML = `<div style="font-size:12px;color:var(--red,#e05c5c)">Error: ${e?.message || String(e)}</div>`;
  }
}

// When the Browser Bridge tab is active, keep status fresh.
document.addEventListener('visibilitychange', () => {
  const panel = document.getElementById('stab-panel-browser');
  if (!panel?.classList.contains('active')) return;
  if (document.visibilityState === 'visible') loadBrowserBridge();
});
function browserBridgeAutoRefresh() {
  clearInterval(_browserBridgePollTimer);
  _browserBridgePollTimer = setInterval(() => {
    const panel = document.getElementById('stab-panel-browser');
    if (panel?.classList.contains('active')) loadBrowserBridge();
  }, 5000);
}
browserBridgeAutoRefresh();

// ── Server logs viewer (admin/owner only) ─────────────────────────────────────
let _logSearchDebounce = null;
function debounceLogs() {
  clearTimeout(_logSearchDebounce);
  _logSearchDebounce = setTimeout(refreshLogs, 300);
}

function _fmtSize(bytes) {
  if (!bytes) return '0 B';
  const k = 1024, units = ['B','KB','MB','GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  return (bytes / Math.pow(k, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
}

function _levelColor(level) {
  if (level === 'error') return '#e05c5c';
  if (level === 'warn')  return '#e0a35c';
  return 'var(--muted)';
}

function _escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function refreshLogs() {
  const box = $('logEntries'); if (!box) return;
  const file  = $('logFileSelect')?.value || 'app';
  const level = $('logLevelSelect')?.value || '';
  const q     = $('logSearchInput')?.value || '';
  const tail  = $('logTailInput')?.value || 200;
  const meta  = $('logFileMeta');

  const params = new URLSearchParams({ file, tail });
  if (level) params.set('level', level);
  if (q)     params.set('q', q);

  box.innerHTML = '<div style="color:var(--muted)">Loading…</div>';
  try {
    const r = await fetch(`/api/admin/logs?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const entries = data.entries || [];
    if (meta) meta.textContent = `${entries.length} shown — file is ${_fmtSize(data.totalBytes || 0)}`;
    if (!entries.length) { box.innerHTML = '<div style="color:var(--muted)">No entries match.</div>'; return; }
    box.innerHTML = entries.map(e => {
      const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : '';
      const metaStr = e.meta ? ' ' + _escapeHtml(JSON.stringify(e.meta)) : '';
      return `<div><span style="color:var(--muted)">${_escapeHtml(ts)}</span> `
        + `<span style="color:${_levelColor(e.level)};font-weight:600">${_escapeHtml((e.level || 'info').toUpperCase())}</span> `
        + `<span style="color:var(--accent)">[${_escapeHtml(e.tag || '')}]</span> `
        + `${_escapeHtml(e.msg || '')}`
        + `<span style="color:var(--muted)">${metaStr}</span></div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    box.innerHTML = `<div style="color:#e05c5c">Failed to load: ${_escapeHtml(e.message)}</div>`;
    if (meta) meta.textContent = '—';
  }
}


// ── Vision provider setting ───────────────────────────────────────────────────
async function saveVisionProvider() {
  const val = $('visionModelSelect')?.value;
  if (!val) return;
  const [model, provider] = val.split('||');
  try {
    await postJson('/api/config', { visionProvider: provider, visionModel: model || undefined }, { method: 'PATCH' });
    showToast('Vision model saved', 2000);
  } catch (e) { showToast(e.message || 'Failed to save'); }
}

// ── Strip thinking tags setting ───────────────────────────────────────────────
function setStripThinkingTrack(checked) {
  const track = $('stripThinkingTrack');
  if (track) track.style.background = checked ? 'var(--accent)' : 'var(--bg3)';
}
async function saveStripThinkingTags(checked) {
  setStripThinkingTrack(checked);
  try {
    await postJson('/api/config', { stripThinkingTags: checked }, { method: 'PATCH' });
    showToast(checked ? 'Thinking output will be hidden' : 'Thinking output will be shown', 2000);
  } catch (e) { setStripThinkingTrack(!checked); showToast(e.message || 'Failed to save setting'); }
}

// ── Reminder delivery channel (per-user) ──────────────────────────────────────
function _toggleReminderEmailRow(channel) {
  const row = $('reminderEmailRow');
  if (!row) return;
  row.style.display = (channel === 'email' || channel === 'all') ? '' : 'none';
}

function _toggleReminderVoiceRow(channel) {
  const row = $('reminderVoiceRow');
  if (!row) return;
  const show = channel === 'voice' || channel === 'all';
  row.style.display = show ? '' : 'none';
  // The preferred-device picker only affects the standalone 'voice' channel.
  // 'all' fans out to every paired device, so surface that caveat inline so
  // a user who sets the dropdown then switches to 'all' isn't confused that
  // both rooms speak.
  const note = $('reminderVoiceAllNote');
  if (note) note.style.display = (channel === 'all') ? '' : 'none';
}

async function loadReminderChannel() {
  const sel = $('reminderChannelSelect');
  const status = $('reminderChannelStatus');
  if (!sel || !_currentUser) return;
  try {
    const r = await fetch(`/api/users/${_currentUser.id}`);
    if (!r.ok) return;
    const u = await r.json();
    const channel = u.reminderChannel || 'websocket';
    sel.value = channel;
    if (status) status.textContent = '';
    _toggleReminderEmailRow(channel);
    _toggleReminderVoiceRow(channel);
    await loadReminderEmail(u.reminderEmailId);
    await loadReminderVoiceDevice(u.reminderVoiceDeviceId);
  } catch {}
}

async function saveReminderChannel(channel) {
  const status = $('reminderChannelStatus');
  if (!_currentUser) return;
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saving…'; }
  try {
    const r = await fetch(`/api/users/${_currentUser.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminderChannel: channel }),
    });
    if (!r.ok) {
      if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Failed to save.'; }
      return;
    }
    if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saved'; setTimeout(() => status.textContent = '', 1500); }
    showToast(`Reminder delivery: ${channel}`, 2000);
    _toggleReminderEmailRow(channel);
    _toggleReminderVoiceRow(channel);
    if (channel === 'email' || channel === 'all') await loadReminderEmail();
    if (channel === 'voice' || channel === 'all') await loadReminderVoiceDevice();
  } catch {
    if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Network error.'; }
  }
}

async function loadReminderEmail(currentSelection) {
  const sel = $('reminderEmailSelect');
  if (!sel || !_currentUser) return;
  try {
    const r = await fetch('/api/email-accounts');
    if (!r.ok) {
      sel.innerHTML = '<option value="">No accounts available</option>';
      return;
    }
    const accts = await r.json();
    if (!Array.isArray(accts) || !accts.length) {
      sel.innerHTML = '<option value="">No accounts connected</option>';
      return;
    }
    if (currentSelection === undefined) {
      const u = await fetch(`/api/users/${_currentUser.id}`).then(r => r.ok ? r.json() : null).catch(() => null);
      currentSelection = u?.reminderEmailId;
    }
    sel.innerHTML = accts.map(a => {
      const label = a.label || a.username || a.id;
      return `<option value="${a.id}">${label}${a.username ? ` (${a.username})` : ''}</option>`;
    }).join('');
    // Default to first by createdAt order if user hasn't chosen.
    const defaultId = currentSelection || accts.slice().sort((a, b) =>
      new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0]?.id;
    if (defaultId) sel.value = defaultId;
  } catch {
    sel.innerHTML = '<option value="">Failed to load</option>';
  }
}

async function saveReminderEmail(accountId) {
  const status = $('reminderEmailStatus');
  if (!_currentUser || !accountId) return;
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saving…'; }
  try {
    const r = await fetch(`/api/users/${_currentUser.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminderEmailId: accountId }),
    });
    if (!r.ok) {
      if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Failed to save.'; }
      return;
    }
    if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saved'; setTimeout(() => status.textContent = '', 1500); }
  } catch {
    if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Network error.'; }
  }
}

async function loadReminderVoiceDevice(currentSelection) {
  const sel = $('reminderVoiceSelect');
  if (!sel || !_currentUser) return;
  try {
    const r = await fetch('/api/devices');
    if (!r.ok) {
      sel.innerHTML = '<option value="">No devices available</option>';
      return;
    }
    const data = await r.json();
    const devices = Array.isArray(data?.devices) ? data.devices : [];
    if (!devices.length) {
      sel.innerHTML = '<option value="">No voice devices paired</option>';
      return;
    }
    if (currentSelection === undefined) {
      const u = await fetch(`/api/users/${_currentUser.id}`).then(r => r.ok ? r.json() : null).catch(() => null);
      currentSelection = u?.reminderVoiceDeviceId;
    }
    sel.innerHTML = devices.map(d => {
      const label = d.name || d.id;
      const status = d.online ? ' • online' : ' • offline';
      return `<option value="${d.id}">${label}${status}</option>`;
    }).join('');
    // Default to the first device if the user hasn't chosen one yet, matching
    // the email-account default behavior.
    const defaultId = currentSelection || devices[0]?.id;
    if (defaultId) sel.value = defaultId;
  } catch {
    sel.innerHTML = '<option value="">Failed to load</option>';
  }
}

async function saveReminderVoiceDevice(deviceId) {
  const status = $('reminderVoiceStatus');
  if (!_currentUser || !deviceId) return;
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saving…'; }
  try {
    const r = await fetch(`/api/users/${_currentUser.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminderVoiceDeviceId: deviceId }),
    });
    if (!r.ok) {
      if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Failed to save.'; }
      return;
    }
    if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saved'; setTimeout(() => status.textContent = '', 1500); }
  } catch {
    if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Network error.'; }
  }
}

// ── Active Sessions ───────────────────────────────────────────────────────────
// Inserts the "Log out everywhere" controls once, as a sibling BEFORE the
// sessions list container — loadActiveSessions() below fully replaces
// el.innerHTML on every refresh, so these can't live inside `el` itself.
function ensureSessionsRevokeAllControls(sessionsEl) {
  if ($('sessionsRevokeAllBlock')) return;
  const block = document.createElement('div');
  block.id = 'sessionsRevokeAllBlock';
  block.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:10px;padding:10px;border:1px solid var(--border);border-radius:6px';
  block.innerHTML = `
    <label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--muted);cursor:pointer">
      <input type="checkbox" id="revokeAllIncludeHardware" style="margin-top:2px">
      <span>Also sign out voice devices &amp; nodes — they will stop working immediately and must be <b>re-paired</b> afterwards.</span>
    </label>
    <div style="display:flex;align-items:center;gap:10px">
      <button id="btnRevokeAllSessions" class="btn-sm" style="background:var(--red,#e05c5c);border:none;color:#fff">Log out everywhere</button>
      <span id="revokeAllStatus" style="font-size:11px;color:var(--muted)"></span>
    </div>
  `;
  sessionsEl.parentElement.insertBefore(block, sessionsEl);
  $('btnRevokeAllSessions').onclick = handleRevokeAllSessions;
}

async function handleRevokeAllSessions() {
  const includeHardware = $('revokeAllIncludeHardware')?.checked === true;
  const status = $('revokeAllStatus');
  // The checkbox is the "first step"; this confirm is the second — together
  // they keep the destructive hardware wipe from being a single casual click.
  const msg = includeHardware
    ? 'This signs out every OTHER browser session AND permanently removes every paired voice device and node from your account.\n\n'
      + 'Voice devices and nodes will stop responding immediately and must be RE-PAIRED (new pairing code) before they work again. This cannot be undone.\n\nContinue?'
    : 'Sign out of every OTHER browser session? This device stays signed in.';
  if (!confirm(msg)) return;
  const btn = $('btnRevokeAllSessions');
  btn.disabled = true;
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Working…'; }
  try {
    const rr = await fetch('/api/sessions/revoke-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeHardware }),
    });
    const data = await rr.json();
    if (!rr.ok) throw new Error(data.error || 'revoke-all failed');
    if (status) {
      status.style.color = 'var(--muted)';
      status.textContent = includeHardware
        ? `Signed out ${data.browsers || 0} browser session(s), removed ${data.devices || 0} device(s) and ${data.nodes || 0} node(s).`
        : `Signed out ${data.browsers || 0} browser session(s).`;
    }
    const cb = $('revokeAllIncludeHardware'); if (cb) cb.checked = false;
    loadActiveSessions();
  } catch (e) {
    if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Failed: ' + e.message; }
  } finally {
    btn.disabled = false;
  }
}

async function loadActiveSessions() {
  const el = $('sessionsList');
  if (!el) return;
  ensureSessionsRevokeAllControls(el);
  el.innerHTML = `<div style="color:var(--muted)">Loading...</div>`;
  try {
    // includeDevices=1 so this view is a complete picture (browser + node +
    // voice-device sessions) — see routes/misc.mjs. Hardware-kind rows are
    // read-only here (no per-row Revoke): a bare session revoke on a node or
    // voice device is silently undone by the device's own auto-revive on
    // its next reconnect, so removal for those MUST go through their device
    // registry (the Devices / Nodes pages, or "Log out everywhere" above).
    const r = await fetch('/api/sessions?includeDevices=1');
    if (!r.ok) throw new Error('fetch failed');
    const list = await r.json();
    if (!Array.isArray(list) || !list.length) {
      el.innerHTML = `<div style="color:var(--muted)">No active sessions</div>`;
      return;
    }
    const fmt = iso => {
      if (!iso) return '—';
      const d = new Date(iso);
      return isNaN(d) ? '—' : d.toLocaleString();
    };
    const kindLabel = k => k === 'node' ? '🖥️ Node' : k === 'voice-device' ? '🔊 Voice device' : '💻 Browser';
    el.innerHTML = list.map(s => {
      const isHardware = s.kind === 'node' || s.kind === 'voice-device';
      const descBits = [escHtml(kindLabel(s.kind))];
      if (s.deviceName) descBits.push(escHtml(s.deviceName));
      if (s.label) descBits.push(escHtml(s.label));
      if (s.ua) descBits.push(escHtml(s.ua));
      return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <div style="font-family:monospace">${s.tokenPrefix} ${s.current ? '<span style="color:var(--accent)">(this device)</span>' : ''}</div>
          <div style="color:var(--muted)">${descBits.join(' · ')}</div>
          <div style="color:var(--muted)">last activity: ${fmt(s.lastActivity)} · expires: ${fmt(s.expiresAt)}</div>
        </div>
        ${s.current ? '' : isHardware
          ? `<span style="font-size:11px;color:var(--muted);white-space:nowrap">manage on Devices/Nodes page</span>`
          : `<button class="btn-sm" data-revoke="${s.tokenPrefix}">Revoke</button>`}
      </div>
    `;
    }).join('');
    el.querySelectorAll('[data-revoke]').forEach(btn => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const rr = await fetch('/api/sessions/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tokenPrefix: btn.dataset.revoke }),
          });
          if (!rr.ok) throw new Error((await rr.json()).error || 'revoke failed');
          loadActiveSessions();
        } catch (e) {
          btn.disabled = false;
          alert('Revoke failed: ' + e.message);
        }
      };
    });
  } catch (e) {
    el.innerHTML = `<div style="color:var(--warn,#c00)">Failed to load: ${e.message}</div>`;
  }
}

// ── Restart server ────────────────────────────────────────────────────────────
async function restartServer() {
  if (!confirm('Restart OpenEnsemble? All in-flight chats and WebSocket connections will be dropped, and the server will be unreachable for a few seconds.')) return;
  const btn = $('btnRestartServer');
  const status = $('restartServerStatus');
  if (btn) { btn.disabled = true; btn.textContent = 'Restarting…'; btn.style.opacity = '0.6'; }
  if (status) { status.style.display = 'block'; status.textContent = 'Sending restart request…'; }
  try {
    const r = await fetch('/api/admin/restart', { method: 'POST' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${r.status}`);
    }
    if (status) status.textContent = 'Server is shutting down. Waiting for it to come back up…';

    // Poll /health until the server responds again, then reload. The poll
    // tolerates network errors AND non-200 responses (e.g., a 502 from the
    // tunnel during the brief gap, or a 503 if the server is still booting).
    // Important: many tunnels return slow / hung connections during the
    // restart window, so each poll has its own short timeout — without
    // that, a single hung connection blocks the whole loop.
    const deadline = Date.now() + 60_000;
    let up = false;
    // Initial wait — restart cycle is ~3-4s under systemd. Start polling
    // sooner than before so we catch the come-back as quickly as possible.
    await new Promise(r => setTimeout(r, 1500));
    while (Date.now() < deadline) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const h = await fetch('/health', { cache: 'no-store', signal: ctrl.signal });
        clearTimeout(t);
        if (h.ok) { up = true; break; }
      } catch { /* network error / abort / timeout — keep polling */ }
      await new Promise(r => setTimeout(r, 800));
    }
    if (up) {
      if (status) status.textContent = 'Server is back up. Reloading…';
      setTimeout(() => location.reload(), 500);
    } else {
      if (status) status.textContent = 'Timed out waiting for server. Try reloading manually.';
      if (btn) { btn.disabled = false; btn.textContent = 'Restart'; btn.style.opacity = '1'; }
    }
  } catch (e) {
    if (status) status.textContent = 'Restart failed: ' + (e.message || 'unknown error');
    if (btn) { btn.disabled = false; btn.textContent = 'Restart'; btn.style.opacity = '1'; }
  }
}

// ── Session expiry setting ────────────────────────────────────────────────────
async function saveSessionExpiry() {
  const hours = parseInt($('sessionExpiryInput')?.value ?? '0');
  try {
    await postJson('/api/config', { sessionExpiryHours: hours }, { method: 'PATCH' });
    showToast('Session expiry saved!', 2000);
  } catch (e) { showToast(e.message || 'Failed to save setting'); }
}

// ── Brave Search API key (admin/owner only) ──────────────────────────────────
// Server-wide setting; the row is hidden for non-privileged users by openSettingsDrawer().
async function loadBraveApiKeyStatus() {
  const status = $('braveApiKeyStatus');
  const clearBtn = $('braveApiKeyClearBtn');
  if (!status) return;
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  if (!isPriv) return;
  try {
    const cfg = await fetch('/api/provider-config').then(r => r.json());
    if (cfg.braveKeySet) {
      status.textContent = 'API key is set.';
      if (clearBtn) clearBtn.style.display = '';
    } else {
      status.textContent = 'No API key configured.';
      if (clearBtn) clearBtn.style.display = 'none';
    }
  } catch { status.textContent = 'Status check failed.'; }
}

async function saveBraveApiKey() {
  const input = $('braveApiKeyInput');
  const key = input?.value.trim();
  if (!key) { showToast('Enter a Brave API key'); return; }
  try {
    const r = await fetch('/api/provider-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ braveApiKey: key }),
    });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      showToast(error || `Failed to save Brave key (${r.status})`);
      return;
    }
    input.value = '';
    showToast('Brave API key saved');
    loadBraveApiKeyStatus();
  } catch { showToast('Failed to save Brave key'); }
}

async function clearBraveApiKey() {
  if (!confirm('Remove the Brave Search API key? Web search and news will stop working until a new key is set.')) return;
  try {
    const r = await fetch('/api/provider-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ braveApiKey: '' }),
    });
    if (!r.ok) { showToast('Failed to clear Brave key'); return; }
    showToast('Brave API key cleared');
    loadBraveApiKeyStatus();
  } catch { showToast('Failed to clear Brave key'); }
}

// ── Drawers ───────────────────────────────────────────────────────────────────
async function loadDrawers() {
  try {
    drawers = await fetch('/api/drawers').then(r => r.json());
    const newsDr = drawers.find(p => p.id === 'news');
    if (newsDr?.settings?.topics?.length) NEWS_TOPICS = newsDr.settings.topics;
    if (newsDr && typeof newsDr.settings?.defaultTopic === 'number') newsTopic = newsDr.settings.defaultTopic;
    mountCustomDrawers();
    applyDrawerVisibility();
  } catch {}
}

// Tracks initJs execution state for custom drawers so we only run it once per open.
window._customDrawerInitJs = window._customDrawerInitJs ?? {};
window._customDrawerInitialized = window._customDrawerInitialized ?? {};

// Build DOM for any custom (skill-builder) drawer that isn't already mounted.
function mountCustomDrawers() {
  const workspace = document.getElementById('workspace');
  const strip     = document.getElementById('sidebarStrip');
  if (!workspace || !strip) return;

  for (const p of drawers) {
    if (!p.custom || !p.drawer) continue;
    const drawerId = p.drawerId;
    const btnId    = p.btnId;
    if (!drawerId || !btnId) continue;

    // Prefer a lucide icon (consistent with built-in drawers). Fall back to
    // emoji. A plugin manifest can set `lucideIcon: "receipt"` etc.
    const lucideName = typeof p.lucideIcon === 'string' && p.lucideIcon.trim()
      ? p.lucideIcon.trim()
      : null;
    const iconMarkup = lucideName
      ? `<i data-lucide="${escHtml(lucideName)}"></i>`
      : `<span style="font-size:20px;line-height:1">${p.icon ?? '🔧'}</span>`;
    const hdrIconMarkup = lucideName
      ? `<span class="drawer-icon"><i data-lucide="${escHtml(lucideName)}"></i></span>`
      : `<span class="drawer-icon" style="font-size:18px">${p.icon ?? '🔧'}</span>`;

    // Sidebar button
    if (!document.getElementById(btnId)) {
      const btn = document.createElement('button');
      btn.className = 'strip-btn';
      btn.id = btnId;
      btn.title = p.name;
      // data-action, not an inline onclick attribute: CSP (script-src 'self',
      // no unsafe-inline) blocks inline handlers, which left custom drawer
      // buttons dead on desktop. Delegation matches the built-in strip buttons
      // and the mobile menu reads the same attributes.
      btn.dataset.action = 'toggleDrawer';
      btn.dataset.args = JSON.stringify([drawerId, btnId]);
      btn.innerHTML = `${iconMarkup}<span class="strip-tooltip">${escHtml(p.name)}</span>`;
      // Insert before the strip spacer so it sits with the other feature buttons.
      const spacer = strip.querySelector('.strip-spacer');
      if (spacer) strip.insertBefore(btn, spacer);
      else strip.appendChild(btn);
    }

    // Drawer panel
    if (!document.getElementById(drawerId)) {
      const div = document.createElement('div');
      div.className = 'desk-drawer';
      div.id = drawerId;
      div.innerHTML = `
        <div class="desk-drawer-hdr">
          ${hdrIconMarkup}
          <span class="drawer-label">${escHtml(p.name)}</span>
          <button class="btn-drawer-x" data-action="closeAllDrawers">✕</button>
        </div>
        <div class="desk-drawer-body">${p.html ?? ''}</div>
      `;
      workspace.appendChild(div);
    }

    if (p.initJs) window._customDrawerInitJs[drawerId] = p.initJs;
  }

  // Materialize any new lucide icons we just injected.
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Called by drawers.js toggleDrawer when a custom drawer is opened.
// Executes initJs the first time the drawer is opened (idempotent).
function runCustomDrawerInit(drawerId) {
  if (window._customDrawerInitialized[drawerId]) return;
  const code = window._customDrawerInitJs[drawerId];
  if (!code) return;
  window._customDrawerInitialized[drawerId] = true;
  try {
    // AsyncFunction so the init body may use top-level await (fetch, etc.)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(code);
    Promise.resolve(fn())
      .then(() => {
        // Materialize any `data-lucide` icons the init code rendered.
        if (typeof lucide !== 'undefined') lucide.createIcons();
      })
      .catch(e => console.error(`[custom drawer ${drawerId}] initJs error:`, e));
  } catch (e) {
    console.error(`[custom drawer ${drawerId}] initJs compile error:`, e);
  }
}

function applyDrawerVisibility() {
  for (const p of drawers) {
    if (!p.drawer) continue;
    const drawerId = p.drawerId ?? `drawer${p.id.charAt(0).toUpperCase() + p.id.slice(1)}`;
    const btnId    = p.btnId    ?? `sbtn${p.id.charAt(0).toUpperCase() + p.id.slice(1)}`;
    const drawer = $(drawerId), btn = $(btnId);
    if (drawer) drawer.style.display = p.enabled ? '' : 'none';
    if (btn)    btn.style.display    = p.enabled ? '' : 'none';
    if (!p.enabled && activeDrawerId === drawerId) closeAllDrawers();
    // Hide the matching settings tab when the feature is disabled
    const tabBtn = $(`stab-${p.id}`);
    if (tabBtn) tabBtn.style.display = p.enabled ? '' : 'none';
  }
  // Tasks tab also shows when inbox (email role) is enabled — for Gmail auto-label
  const inboxEnabled = drawers.some(p => p.id === 'inbox' && p.enabled);
  const tasksTabBtn = $('stab-tasks');
  if (tasksTabBtn && inboxEnabled) tasksTabBtn.style.display = '';
}

function renderDrawersSettings() {
  const el = $('pluginsList');
  if (!el || !drawers.length) return;
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  el.innerHTML = drawers.filter(p => isPriv || !p.adminBlocked).map(p => {
    const inner = p.enabled && p.id === 'news' ? `
      <div style="display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--border);padding-top:10px;margin-top:8px">
        ${renderNewsTopicsEditor(p)}
      </div>` : '';
    return `<div style="background:var(--bg3);border-radius:10px;padding:12px">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:20px;flex-shrink:0">${p.icon ?? '🔌'}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--text)">${escHtml(p.name)}</div>
          ${p.description ? `<div style="font-size:11px;color:var(--muted)">${escHtml(p.description)}</div>` : ''}
        </div>
        <label style="display:flex;align-items:center;gap:6px;flex-shrink:0;cursor:pointer">
          <input type="checkbox" ${p.enabled ? 'checked' : ''} data-change-action="toggleDrawerPlugin" data-change-args='${JSON.stringify([p.id, "$checked"]).replace(/'/g, "&#39;")}'
            style="width:16px;height:16px;cursor:pointer;accent-color:var(--accent)">
        </label>
      </div>
      ${inner}
    </div>`;
  }).join('');
}

function renderNewsTopicsEditor(p) {
  const topics = p.settings?.topics ?? [];
  const def    = p.settings?.defaultTopic ?? 0;
  const topicOpts = topics.map((t, i) =>
    `<option value="${i}" ${i === def ? 'selected' : ''}>${escHtml(t.label)}</option>`).join('');
  const rows = topics.map((t, i) => `
    <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)">
      <input value="${escHtml(t.label)}" placeholder="Label"
        style="width:80px;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 6px;font-size:11px"
        data-change-action="updateDrawerTopic" data-change-args='${JSON.stringify(['news', i, 'label', "$value"]).replace(/'/g, "&#39;")}'>
      <input value="${escHtml(t.q)}" placeholder="Search query"
        style="flex:1;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 6px;font-size:11px"
        data-change-action="updateDrawerTopic" data-change-args='${JSON.stringify(['news', i, 'q', "$value"]).replace(/'/g, "&#39;")}'>
      <button data-action="removeDrawerTopic" data-args='${JSON.stringify(['news', i]).replace(/'/g, "&#39;")}'
        style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:0 4px">×</button>
    </div>`).join('');
  return `
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:11px;color:var(--muted);width:100px;flex-shrink:0">Default tab</span>
        <select id="newsDefaultTopicSelect" data-change-action="_saveNewsTopicPrefInt" data-change-args='["$value"]'
          style="flex:1;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 8px;font-size:12px">
          ${topicOpts}
        </select>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Topics</div>
      <div id="newsTopicsRows">${rows}</div>
      <button data-action="addDrawerTopic" data-args='["news"]'
        style="margin-top:8px;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer">+ Add Topic</button>
    </div>`;
}

// Wrapper for the news default-topic select — original inline handler did
// `saveNewsTopicPref(parseInt(this.value))`, but data-args resolves $value
// to a string. parseInt at the boundary keeps the called fn unchanged.
function _saveNewsTopicPrefInt(value) { saveNewsTopicPref(parseInt(value, 10)); }

async function toggleDrawerPlugin(drawerId, enabled) {
  try {
    await postJson('/api/drawers/toggle', { pluginId: drawerId, enabled });
    const idx = drawers.findIndex(p => p.id === drawerId);
    if (idx !== -1) drawers[idx].enabled = enabled;
    applyDrawerVisibility();
    renderDrawersSettings();
  } catch (e) {
    showToast(e.message || 'Failed to update plugin');
    renderDrawersSettings(); // revert the checkbox to the persisted state
  }
}

async function saveDrawerSetting(drawerId, key, value) {
  const p = drawers.find(pl => pl.id === drawerId);
  if (p) { p.settings = p.settings ?? {}; p.settings[key] = value; }
  if (drawerId === 'news' && key === 'defaultTopic') newsTopic = value;
  if (drawerId === 'news' && key === 'topics') NEWS_TOPICS = value;
  try {
    await fetch(`/api/drawers/${drawerId}/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    });
  } catch {}
}

function updateDrawerTopic(drawerId, idx, field, value) {
  const p = drawers.find(pl => pl.id === drawerId);
  if (!p?.settings?.topics) return;
  p.settings.topics[idx][field] = value;
  clearTimeout(updateDrawerTopic._t);
  updateDrawerTopic._t = setTimeout(() => saveDrawerSetting(drawerId, 'topics', p.settings.topics), 600);
}

function removeDrawerTopic(drawerId, idx) {
  const p = drawers.find(pl => pl.id === drawerId);
  if (!p?.settings?.topics) return;
  p.settings.topics.splice(idx, 1);
  saveDrawerSetting(drawerId, 'topics', p.settings.topics);
  renderDrawersSettings();
}

function addDrawerTopic(drawerId) {
  const p = drawers.find(pl => pl.id === drawerId);
  if (!p) return;
  p.settings = p.settings ?? {};
  p.settings.topics = p.settings.topics ?? [];
  p.settings.topics.push({ label: 'New', q: 'news today' });
  saveDrawerSetting(drawerId, 'topics', p.settings.topics);
  renderDrawersSettings();
}

// ── TV Video Sources (admin/owner only) ───────────────────────────────────────
// System-tab row (index.html #tvVideoSourcesRow, revealed by
// openSettingsDrawer) backed by the admin-gated proxy routes in
// routes/tv.mjs: GET/POST /api/tv/video-sources and DELETE
// /api/tv/video-sources/:name, which forward to the TV video sidecar's
// loopback admin API (oe-tv-assistant/PROTOCOL-TV.md, "Video library v2").

async function loadTvVideoSources() {
  const body = $('tvVideoSourcesBody');
  if (!body) return;
  try {
    const r = await fetch('/api/tv/video-sources');
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error ?? `load failed (${r.status})`);
    renderTvVideoSources(data.sources ?? []);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">${escHtml(e.message)}</div>`;
  }
}

function renderTvVideoSources(sources) {
  const body = $('tvVideoSourcesBody');
  if (!body) return;
  const statusBadge = (s) => s.status === 'ok'
    ? `<span style="font-size:11px;color:var(--green, #4caf50);font-weight:600">✓ available</span>`
    : `<span style="font-size:11px;color:var(--red,#e05c5c);font-weight:600">⚠ unavailable</span>`;
  const locationOf = (s) => s.type === 'smb'
    ? `share ${s.share}${s.subpath ? `/${s.subpath}` : ''}${s.port ? ` (port ${s.port})` : ''}`
    : `folder ${s.path}${s.subpath ? `/${s.subpath}` : ''}`;

  const listHtml = sources.length === 0
    ? `<div style="font-size:12px;color:var(--muted);padding:10px 0">No video sources configured yet.</div>`
    : `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${sources.map(s => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <div style="font-size:13px;font-weight:600">${escHtml(s.name)}</div>
            <div style="display:flex;gap:6px;align-items:center">${statusBadge(s)}
              <button data-action="removeTvVideoSource" data-args='${escHtml(JSON.stringify([s.name]))}' style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer">Remove</button>
            </div>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">${escHtml(s.type === 'smb' ? 'Network' : 'Local')} ${escHtml(locationOf(s))}</div>
          ${s.error ? `<div style="font-size:11px;color:var(--red,#e05c5c);margin-top:4px">${escHtml(s.error)}</div>` : ''}
        </div>
      `).join('')}</div>`;

  const formHtml = `
    <details style="border:1px dashed var(--border);border-radius:8px;padding:10px">
      <summary style="cursor:pointer;font-size:12px;font-weight:600">+ Add a video source</summary>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
        <label style="font-size:11px;color:var(--muted)">Name (shown as a folder on the TV)</label>
        <input id="tvSrcAddName" placeholder="NAS" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">Folder path on this server, or SMB share as //host/share</label>
        <input id="tvSrcAddLocation" placeholder="/srv/media/Movies or //nas/media" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">Subfolder (optional)</label>
        <input id="tvSrcAddSubfolder" placeholder="movies" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">SMB port (optional, default 445)</label>
        <input id="tvSrcAddPort" type="number" min="1" max="65535" placeholder="445" style="width:100px;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <button data-action="addTvVideoSource" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600;margin-top:6px;align-self:flex-start">Add source</button>
        <div id="tvSrcAddStatus" style="font-size:11px;color:var(--muted);min-height:14px"></div>
      </div>
    </details>`;
  body.innerHTML = listHtml + formHtml;
}

async function addTvVideoSource() {
  const status = $('tvSrcAddStatus');
  const name = $('tvSrcAddName')?.value.trim();
  let loc = $('tvSrcAddLocation')?.value.trim() ?? '';
  if (loc.startsWith('\\\\')) loc = loc.replace(/\\/g, '/');  // \\host\share → //host/share
  if (!name || !loc) { if (status) status.textContent = 'Name and folder/share are required.'; return; }
  const body = { name };
  if (loc.startsWith('//')) { body.type = 'smb'; body.share = loc; }
  else if (loc.startsWith('/')) { body.type = 'local'; body.path = loc; }
  else { if (status) status.textContent = 'Enter an absolute folder path (/srv/media/Movies) or an SMB share (//host/share).'; return; }
  const sub = $('tvSrcAddSubfolder')?.value.trim();
  if (sub) body.subpath = sub;
  const port = $('tvSrcAddPort')?.value.trim();
  if (port) body.port = Number(port);
  if (status) status.textContent = 'Adding… (a network share can take a few seconds to mount)';
  try {
    const r = await fetch('/api/tv/video-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error ?? `add failed (${r.status})`);
    loadTvVideoSources();
  } catch (e) {
    if (status) status.textContent = `Add failed: ${e.message}`;
  }
}

async function removeTvVideoSource(name) {
  if (!confirm(`Remove video source "${name}" from the TV library? The folder's files are not deleted.`)) return;
  try {
    const r = await fetch(`/api/tv/video-sources/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(`Remove failed: ${data.error ?? r.status}`);
      return;
    }
    loadTvVideoSources();
  } catch (e) {
    alert(`Remove failed: ${e.message}`);
  }
}
