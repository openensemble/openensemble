// Server ops UI: browser bridge, logs, sessions, restart — extracted from settings.js.
// Globals intentional.

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

