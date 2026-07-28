// Server ops UI: browser bridge, logs, sessions, restart — extracted from settings.js.
// Globals intentional.

// ── Browser Bridge tab ───────────────────────────────────────────────────────
const BROWSER_CAPABILITY_SKILL_ID = 'browser-ext';
let _browserBridgePollTimer = null;
let _browserBridgeLoadSeq = 0;

function browserCapabilityCardHtml(capability, { statusLoaded = true } = {}) {
  const available = capability?.available === true;
  const enabled = capability?.enabled === true;
  const managed = capability?.managed === true;
  const alwaysOn = capability?.alwaysOn === true;
  const controlDisabled = !statusLoaded || capability?.canToggle !== true;
  const stateLabel = !statusLoaded
    ? 'Status unavailable'
    : !available
      ? 'Not allowed'
      : managed
        ? (enabled ? 'Enabled · managed' : 'Disabled · managed')
      : enabled
        ? 'Enabled'
        : 'Disabled';
  const detail = !statusLoaded
    ? 'OE could not load your tool permissions. Refresh this page and try again.'
    : !available
      ? 'Browser tools are not available to this profile. Ask an administrator to allow the Browser Extension tool.'
      : managed
        ? 'Your tool access is managed by an administrator.'
        : alwaysOn
          ? 'Browser tools are managed by this OE installation.'
        : enabled
          ? 'Your assistants can request browser actions. Tab leases and “Allow once” confirmations still apply.'
          : 'Extension chat still works, but assistants cannot open, read, or control browser tabs until you enable this.';
  const toggleArgs = JSON.stringify(['$checked']).replace(/'/g, "&#39;");
  return `
    <div data-browser-capability-card style="background:var(--bg3);border:1px solid var(--border);border-radius:9px;padding:12px;margin-bottom:14px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px">
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:650;color:var(--text)">Agent browser access</div>
          <div data-browser-capability-state style="font-size:11px;color:${enabled ? 'var(--green,#43b89c)' : 'var(--muted)'};margin-top:2px">${stateLabel}</div>
        </div>
        <label style="display:flex;align-items:center;gap:7px;font-size:11px;color:var(--text);cursor:${controlDisabled ? 'not-allowed' : 'pointer'};white-space:nowrap">
          <input id="browserCapabilityToggle" type="checkbox" ${enabled ? 'checked' : ''} ${controlDisabled ? 'disabled' : ''}
            data-change-action="toggleBrowserCapability" data-change-args='${toggleArgs}'
            aria-label="Enable agent browser access"
            style="accent-color:var(--accent);cursor:${controlDisabled ? 'not-allowed' : 'pointer'}">
          <span>${enabled ? 'On' : 'Off'}</span>
        </label>
      </div>
      <div style="font-size:11px;color:var(--muted);line-height:1.5;margin-top:8px">${detail}</div>
    </div>`;
}

async function toggleBrowserCapability(enabled, event) {
  if (typeof toggleSkill !== 'function') {
    showToast('Browser settings are still loading. Try again in a moment.');
    if (event?.target) event.target.checked = !enabled;
    return;
  }
  // Invalidate any status request that started before this user action.
  _browserBridgeLoadSeq++;
  return toggleSkill.call(this, BROWSER_CAPABILITY_SKILL_ID, enabled, event);
}

function browserInstallHtml() {
  return `
    <details style="background:var(--bg3);border:1px solid var(--border);border-radius:9px;padding:11px 12px;margin-top:12px">
      <summary style="font-size:12px;font-weight:600;color:var(--text);cursor:pointer">Install OE Bridge on this computer</summary>
      <div style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:9px">
        <a class="btn-sm" href="/api/browser/extension.zip" download="openensemble-bridge.zip"
          style="display:inline-block;text-decoration:none;background:var(--accent);border:none;color:#fff;margin-bottom:7px">Download OE Bridge</a>
        <ol style="margin:3px 0 0 18px;padding:0">
          <li>Extract the downloaded ZIP.</li>
          <li>Open <code>chrome://extensions</code> or <code>edge://extensions</code>.</li>
          <li>Turn on <b>Developer mode</b>, choose <b>Load unpacked</b>, and select the extracted <code>openensemble-bridge</code> folder.</li>
          <li>Open the extension, choose <b>Pair this browser</b>, and approve its code in OE.</li>
        </ol>
        <div style="margin-top:7px">No command line or access to the OE server’s files is required.</div>
      </div>
    </details>`;
}

function browserPairedHtml(paired, connected, pairingError = null) {
  const liveCredentialIds = new Set(connected.map(item => item?.credentialId).filter(Boolean));
  let html = '<div style="font-size:12px;font-weight:650;color:var(--text);margin:14px 0 7px">Paired browsers</div>';
  if (pairingError) {
    return html + `<div style="font-size:11px;color:var(--red,#e05c5c)">${escHtml(pairingError)}</div>`;
  }
  if (!paired.length) {
    return html + '<div style="font-size:11px;color:var(--muted)">No browsers paired to this profile yet.</div>';
  }
  const fmtTime = (ts) => ts ? new Date(ts).toLocaleString() : 'Never';
  html += paired.map(browser => {
    const online = liveCredentialIds.has(browser.credentialId);
    const args = JSON.stringify([browser.credentialId, browser.browserName || 'this browser'])
      .replace(/'/g, '&#39;');
    return `
      <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:11px 12px;margin-bottom:8px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
          <div style="min-width:0">
            <div style="font-size:12px;font-weight:600;color:var(--text)">${escHtml(browser.browserName || 'Browser')}
              ${browser.extensionVersion ? `<span style="font-size:10px;font-weight:400;color:var(--muted)">v${escHtml(browser.extensionVersion)}</span>` : ''}
            </div>
            <div style="font-size:10px;color:${online ? 'var(--green,#43b89c)' : 'var(--muted)'};margin-top:2px">${online ? 'Connected now' : 'Paired · offline'}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:4px">Paired ${fmtTime(browser.createdAt)} · Last used ${fmtTime(browser.lastUsedAt)}</div>
          </div>
          <button class="btn-sm" data-action="revokeBrowserCredential" data-args='${args}'
            style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);flex-shrink:0">Revoke</button>
        </div>
      </div>`;
  }).join('');
  return html;
}

function browserConnectedHtml(connected) {
  const fmtTime = (ts) => ts ? new Date(ts).toLocaleString() : 'Unknown';
  const heading = '<div style="font-size:12px;font-weight:650;color:var(--text);margin:14px 0 7px">Live connections</div>';
  if (!connected.length) {
    return heading + `
      <div style="font-size:11px;color:var(--muted);line-height:1.5">
        No paired browser is connected right now. Open OE Bridge in the browser you want to use.
      </div>`;
  }
  return heading + connected.map(browser => `
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:11px 12px;margin-bottom:8px">
      <div style="font-size:12px;font-weight:600;color:var(--text)">${escHtml(browser.name || 'Browser')}
        ${browser.version ? `<span style="font-size:10px;font-weight:400;color:var(--muted)">v${escHtml(browser.version)}</span>` : ''}
      </div>
      <div style="font-size:10px;color:var(--green,#43b89c);margin-top:2px">Connected since ${fmtTime(browser.registeredAt)}</div>
    </div>`).join('') + `
    <div style="font-size:11px;color:var(--muted);line-height:1.5">
      A connection does not expose your tabs. Grant a 15-minute tab lease in OE Bridge when you want an assistant to read or control a page. Opening a URL still requires <b>Allow once</b>.
    </div>`;
}

async function revokeBrowserCredential(credentialId, browserName, event) {
  if (!credentialId) return;
  if (!confirm(`Revoke ${browserName}? It will disconnect immediately and must be paired again.`)) return;
  const button = event?.target?.closest?.('button');
  if (button) button.disabled = true;
  try {
    const response = await fetch(`/api/browser/pairing/credentials/${encodeURIComponent(credentialId)}`, {
      method: 'DELETE',
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Could not revoke this browser');
    showToast(`${browserName} revoked`);
    await loadBrowserBridge();
  } catch (e) {
    showToast(e?.message || 'Could not revoke this browser');
    if (button?.isConnected) button.disabled = false;
  }
}

async function loadBrowserBridge() {
  const body = document.getElementById('browserBridgeBody');
  if (!body) return;
  const requestSeq = ++_browserBridgeLoadSeq;
  try {
    const response = await fetch('/api/browser/status', {
      credentials: 'include',
      cache: 'no-store',
    });
    if (requestSeq !== _browserBridgeLoadSeq) return;
    if (!response.ok) {
      body.innerHTML = `${browserCapabilityCardHtml(null, { statusLoaded: false })}
        <div style="font-size:12px;color:var(--muted)">Couldn't fetch extension status (HTTP ${response.status}).</div>
        ${browserInstallHtml()}`;
      return;
    }
    const status = await response.json();
    if (requestSeq !== _browserBridgeLoadSeq) return;
    const connected = Array.isArray(status.connected) ? status.connected : [];
    const paired = Array.isArray(status.paired) ? status.paired : [];
    body.innerHTML = browserCapabilityCardHtml(status.capability)
      + browserPairedHtml(paired, connected, status.pairingError)
      + browserConnectedHtml(connected)
      + browserInstallHtml();
  } catch (e) {
    if (requestSeq !== _browserBridgeLoadSeq) return;
    body.innerHTML = `${browserCapabilityCardHtml(null, { statusLoaded: false })}
      <div style="font-size:12px;color:var(--red,#e05c5c)">Error: ${escHtml(e?.message || String(e))}</div>
      ${browserInstallHtml()}`;
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
