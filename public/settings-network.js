// Extracted from settings.js — pure move. Globals intentional.
// Section loaded via index.html before/after settings core as needed.

// ── Public Access (Cloudflare Tunnel) — owner/admin only ─────────────────────
let _tunnelPollTimer = null;

async function loadTunnelStatus() {
  const section = $('publicAccessSection');
  const body    = $('publicAccessBody');
  if (!section || !body) return;
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  if (!isPriv) { section.style.display = 'none'; return; }
  section.style.display = '';
  try {
    const s = await fetch('/api/tunnel/status').then(r => r.json());
    renderTunnelStatus(s);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">Failed to load tunnel status: ${e.message}</div>`;
  }
}

function renderTunnelStatus(s) {
  const body = $('publicAccessBody');
  if (!body) return;
  const stateColor = {
    running:  'var(--green, #4caf50)',
    starting: 'var(--accent)',
    stopped:  'var(--muted)',
    crashed:  'var(--red, #e05c5c)',
    error:    'var(--red, #e05c5c)',
  }[s.state] || 'var(--muted)';
  const stateText = {
    running:  '✓ Running',
    starting: '… Starting',
    stopped:  'Stopped',
    crashed:  '⚠ Crashed (give-up after 5 retries — click Start to retry)',
    error:    '⚠ Error',
  }[s.state] || s.state;
  const urlBlock = s.publicUrl
    ? `<div style="margin-top:8px;font-size:12px"><span style="opacity:0.6">Public URL:</span> <a href="${s.publicUrl}" target="_blank" style="color:var(--accent);word-break:break-all">${s.publicUrl}</a> <button data-action="copyToClipboard" data-args='${JSON.stringify([s.publicUrl]).replace(/'/g, "&#39;")}' title="Copy" style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;margin-left:6px">copy</button></div>`
    : '';
  const errBlock = s.lastError && s.state !== 'running'
    ? renderTunnelErrorBlock(s.lastError)
    : '';
  const binNote = !s.binaryPresent
    ? `<div style="margin-top:6px;font-size:11px;color:var(--muted);font-style:italic">cloudflared binary not present yet — will auto-download (~30 MB) on first start.</div>`
    : '';
  const isRunning = s.state === 'running' || s.state === 'starting';
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:${stateColor}">●&nbsp;${stateText}</span>
      <span style="opacity:0.4;font-size:11px">|</span>
      <span style="font-size:11px;opacity:0.7">mode: <b>${s.mode}</b></span>
      ${s.pid ? `<span style="opacity:0.4;font-size:11px">|</span><span style="font-size:11px;opacity:0.7">pid: ${s.pid}</span>` : ''}
    </div>
    ${urlBlock}
    ${errBlock}
    ${binNote}

    <div style="margin-top:14px;border:1px solid var(--border);border-radius:8px;padding:10px">
      <div style="font-size:12px;font-weight:600;margin-bottom:8px">Mode</div>
      <label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;margin-bottom:6px;cursor:pointer">
        <input type="radio" name="tunnelMode" value="off" ${s.mode === 'off' ? 'checked' : ''} style="margin-top:2px">
        <span><b>Off</b> — no public exposure (default).</span>
      </label>
      <label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;margin-bottom:8px;cursor:pointer">
        <input type="radio" name="tunnelMode" value="cloudflare" ${s.mode === 'cloudflare' ? 'checked' : ''} style="margin-top:2px">
        <span><b>Cloudflare Tunnel</b> — stable hostname via your own Cloudflare account. Create a tunnel in your <a href="https://one.dash.cloudflare.com/" target="_blank" style="color:var(--accent)">Zero Trust dashboard</a>, add a public hostname routed to <code>http://localhost:${s.localPort}</code>, then paste token + hostname below.</span>
      </label>

      <div id="tunnelCloudflareFields" style="margin-top:8px;${s.mode === 'cloudflare' ? '' : 'display:none'}">
        <label style="display:block;font-size:11px;opacity:0.7;margin-bottom:4px">CF Tunnel Token</label>
        <input type="password" id="tunnelTokenInput" autocomplete="new-password"
          placeholder="${s.hasToken ? '••••••••  (token saved — paste a new one to replace)' : 'eyJhIjoi…'}"
          style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:8px">
        <label style="display:block;font-size:11px;opacity:0.7;margin-bottom:4px">Public hostname (the one you mapped to this tunnel)</label>
        <input type="text" id="tunnelHostnameInput" placeholder="oe.example.com" value="${escHtml(s.hostname || '')}"
          style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:12px">
      </div>

      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button data-action="saveTunnelConfig" style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600">Save</button>
        <button data-action="tunnelStart" ${isRunning ? 'disabled' : ''} style="background:${isRunning ? 'var(--bg3)' : 'var(--green,#4caf50)'};border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:${isRunning ? 'not-allowed' : 'pointer'};font-weight:600;opacity:${isRunning ? '0.5' : '1'}">Start</button>
        <button data-action="tunnelStop" ${!isRunning ? 'disabled' : ''} style="background:${!isRunning ? 'var(--bg3)' : 'var(--red,#e05c5c)'};border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:${!isRunning ? 'not-allowed' : 'pointer'};font-weight:600;opacity:${!isRunning ? '0.5' : '1'}">Stop</button>
      </div>
    </div>
  `;
  // Show/hide CF fields when the radio toggles between off and cloudflare.
  body.querySelectorAll('input[name="tunnelMode"]').forEach(r => {
    r.addEventListener('change', (ev) => {
      const cf = $('tunnelCloudflareFields'); if (cf) cf.style.display = ev.target.value === 'cloudflare' ? '' : 'none';
    });
  });
  // Re-render Lucide icons if the framework is mounted.
  if (window.lucide?.createIcons) window.lucide.createIcons();
  // While running/starting, poll status every 5 s so the UI shows the URL
  // showing up after Quick-mode startup completes.
  if (_tunnelPollTimer) { clearTimeout(_tunnelPollTimer); _tunnelPollTimer = null; }
  // Poll only while transitioning. Once running/stopped/errored, stop —
  // re-rendering the panel every 5s wipes any input the user is typing
  // into the token field.
  if (s.state === 'starting') {
    _tunnelPollTimer = setTimeout(() => loadTunnelStatus(), 5000);
  }
}

async function saveTunnelConfig() {
  const mode  = document.querySelector('input[name="tunnelMode"]:checked')?.value || 'off';
  const token = $('tunnelTokenInput')?.value || undefined;
  const host  = $('tunnelHostnameInput')?.value || undefined;
  const body  = { mode };
  if (mode === 'cloudflare') {
    if (token) body.token = token;
    if (host !== undefined) body.hostname = host;
  }
  try {
    const r = await fetch('/api/tunnel/configure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      showToast(error || `Save failed (${r.status})`);
      return;
    }
    if ($('tunnelTokenInput')) $('tunnelTokenInput').value = '';
    showToast('Tunnel configuration saved');
    loadTunnelStatus();
  } catch (e) { showToast('Save failed: ' + e.message); }
}

// Render a persistent error panel for tunnel failures. Toasts disappear in
// 3s, but tunnel errors sometimes carry an actionable URL the user needs
// to copy/click — those have to live on screen until the user takes action.
function renderTunnelErrorBlock(rawError) {
  const text = String(rawError || '');
  const urlRe = /https?:\/\/[^\s<>"']+/g;
  const urls = text.match(urlRe) ?? [];
  // Linkify by splitting on URLs and reassembling.
  let html = '';
  let last = 0;
  for (const m of text.matchAll(urlRe)) {
    html += escHtml(text.slice(last, m.index));
    const u = m[0];
    html += `<a href="${escHtml(u)}" target="_blank" rel="noopener" style="color:var(--accent);word-break:break-all">${escHtml(u)}</a>`;
    last = m.index + u.length;
  }
  html += escHtml(text.slice(last));
  // If there's at least one URL, surface a prominent Copy button beneath the
  // text so the user can grab the link without having to highlight it.
  const copyRow = urls.length
    ? `<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${urls.map(u =>
        `<button data-action="copyToClipboard" data-args='${JSON.stringify([u]).replace(/'/g, "&#39;")}' title="Copy ${escHtml(u)}"
          style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;display:inline-flex;align-items:center;gap:4px">📋 Copy link</button>`
      ).join('')}</div>`
    : '';
  return `
    <div style="margin-top:10px;padding:10px 12px;background:rgba(244,67,54,0.06);border:1px solid var(--red,#e05c5c);border-radius:8px;color:var(--text);font-size:12px;line-height:1.5">
      <div style="font-weight:600;color:var(--red,#e05c5c);margin-bottom:4px">⚠ Last error</div>
      <div style="white-space:pre-wrap;word-break:break-word">${html}</div>
      ${copyRow}
    </div>`;
}

async function tunnelStart() {
  // Save first if the user changed mode but didn't click Save.
  await saveTunnelConfig();
  try {
    const r = await fetch('/api/tunnel/start', { method: 'POST' });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      // Surface a brief toast pointer, then refresh status so the persistent
      // error block (with linkified URL + Copy button) is rendered. Toasts
      // disappear in 3s — actionable URLs must live on screen.
      showToast(error ? 'Start failed — see error below for details' : `Start failed (${r.status})`, 5000);
      loadTunnelStatus();
      return;
    }
    showToast('Tunnel starting…');
    loadTunnelStatus();
  } catch (e) {
    showToast('Start failed: ' + e.message);
    loadTunnelStatus();
  }
}

async function tunnelStop() {
  if (!confirm('Stop the tunnel? The install will no longer be reachable from the public internet.')) return;
  try {
    const r = await fetch('/api/tunnel/stop', { method: 'POST' });
    if (!r.ok) { showToast(`Stop failed (${r.status})`); return; }
    showToast('Tunnel stopped');
    loadTunnelStatus();
  } catch (e) { showToast('Stop failed: ' + e.message); }
}

function copyToClipboard(text) {
  if (!text) return;
  try { navigator.clipboard.writeText(text); showToast('Copied'); }
  catch { showToast('Copy failed'); }
}

// ── Private Mesh (Tailscale) — owner/admin only ──────────────────────────────
// Mirrors the Cloudflare Tunnel panel: probe + render + per-button handler.
// Install goes through /api/integrations/tailscale/install which collects the
// auth key + sudo password inline (no chat-bubble round-trip) and runs the
// same recipe the oe-admin skill would.
async function loadTailscaleStatus() {
  const section = $('tailscaleAccessSection');
  const body    = $('tailscaleAccessBody');
  if (!section || !body) return;
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  if (!isPriv) { section.style.display = 'none'; return; }
  section.style.display = '';
  try {
    const s = await fetch('/api/integrations/tailscale/status').then(r => r.json());
    renderTailscaleStatus(s);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">Failed to load Tailscale status: ${e.message}</div>`;
  }
}

function renderTailscaleStatus(s) {
  const body = $('tailscaleAccessBody');
  if (!body) return;

  // Three coarse buckets the user cares about:
  //   active   — daemon running, joined to a tailnet, IP assigned
  //   needs    — binary present but daemon down or NeedsLogin
  //   missing  — binary not installed
  const bucket = !s.binaryPresent ? 'missing' : (s.running ? 'active' : 'needs');
  const stateColor = {
    active:  'var(--green, #4caf50)',
    needs:   'var(--accent)',
    missing: 'var(--muted)',
  }[bucket];
  const stateText = {
    active:  '✓ Joined to tailnet',
    needs:   s.state ? `⚠ ${s.state} — needs login or restart` : '⚠ Installed but not running',
    missing: 'Not installed',
  }[bucket];

  const ipBlock = s.ip
    ? `<div style="margin-top:8px;font-size:12px"><span style="opacity:0.6">Tailscale IP:</span> <code style="color:var(--accent)">${escHtml(s.ip)}</code> <button data-action="copyToClipboard" data-args='${JSON.stringify([s.ip]).replace(/'/g, "&#39;")}' title="Copy" style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;margin-left:6px">copy</button></div>`
    : '';
  const hostBlock = s.hostname && s.tailnet
    ? `<div style="margin-top:4px;font-size:11px;opacity:0.7">MagicDNS: <code>${escHtml(s.hostname)}.${escHtml(s.tailnet)}</code></div>`
    : (s.hostname ? `<div style="margin-top:4px;font-size:11px;opacity:0.7">Host: <code>${escHtml(s.hostname)}</code></div>` : '');

  // Two action surfaces. Manual path collects the authkey + sudo inline; the
  // coordinator path drops the user into chat with a prefilled prompt so the
  // oe-admin tool flow runs the same recipe but with the LLM handling any
  // ambiguity.
  const manualPanel = bucket === 'active' ? '' : `
    <div style="margin-top:14px;border:1px solid var(--border);border-radius:8px;padding:10px">
      <div style="font-size:12px;font-weight:600;margin-bottom:4px">Set up manually</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Paste a reusable auth key from your <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" style="color:var(--accent)">Tailscale admin → Keys</a>. The installer runs <code>tailscale up</code> using your key, then this server appears in your tailnet.</div>
      <label style="display:block;font-size:11px;opacity:0.7;margin-bottom:4px">Tailscale auth key</label>
      <input type="password" id="tailscaleAuthkeyInput" autocomplete="new-password"
        placeholder="tskey-auth-…"
        style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:8px">
      <label style="display:block;font-size:11px;opacity:0.7;margin-bottom:4px">sudo password (used once, not stored)</label>
      <input type="password" id="tailscaleSudoInput" autocomplete="new-password"
        placeholder="${process_geteuid_hint()}"
        style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:8px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button data-action="installTailscale" id="btnInstallTailscale" style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600">Install</button>
        <button data-action="askCoordinatorTailscale" style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600">Ask the coordinator instead</button>
      </div>
      <div id="tailscaleInstallStatus" style="margin-top:10px;font-size:12px;color:var(--muted);display:none"></div>
    </div>
  `;

  const uninstallPanel = bucket === 'active' ? `
    <div style="margin-top:14px;border:1px solid var(--border);border-radius:8px;padding:10px">
      <div style="font-size:12px;font-weight:600;margin-bottom:4px">Manage</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">Removing reverts the most recent install audit entry: brings the node down, disables the service, and clears the config flag.</div>
      <label style="display:block;font-size:11px;opacity:0.7;margin-bottom:4px">sudo password (used once, not stored)</label>
      <input type="password" id="tailscaleSudoInput" autocomplete="new-password"
        placeholder="${process_geteuid_hint()}"
        style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:8px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button data-action="uninstallTailscale" style="background:var(--red,#e05c5c);border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600">Uninstall</button>
      </div>
      <div id="tailscaleInstallStatus" style="margin-top:10px;font-size:12px;color:var(--muted);display:none"></div>
    </div>
  ` : '';

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:${stateColor}">●&nbsp;${stateText}</span>
      ${s.binaryPresent ? '<span style="opacity:0.4;font-size:11px">|</span><span style="font-size:11px;opacity:0.7">binary: present</span>' : ''}
      ${s.configFlag ? '<span style="opacity:0.4;font-size:11px">|</span><span style="font-size:11px;opacity:0.7">tracked by oe-admin</span>' : ''}
    </div>
    ${ipBlock}
    ${hostBlock}
    ${manualPanel}
    ${uninstallPanel}
  `;
  if (window.lucide?.createIcons) window.lucide.createIcons();
}

// Hint text only — the client can't actually probe the server's euid, so we
// show the install-time sudo hint generically. Centralised so both the
// install and uninstall panels stay in sync if we ever swap the wording.
function process_geteuid_hint() { return 'leave blank if OE runs as root'; }

async function installTailscale() {
  const authkey = $('tailscaleAuthkeyInput')?.value?.trim() || '';
  const sudoPw  = $('tailscaleSudoInput')?.value || '';
  if (!authkey) { showToast('Auth key required'); return; }
  const btn = $('btnInstallTailscale');
  const statusEl = $('tailscaleInstallStatus');
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  if (statusEl) { statusEl.style.display = ''; statusEl.textContent = 'Running install steps (curl → install.sh → systemctl enable → tailscale up). May take ~1 minute.'; }
  try {
    const r = await fetch('/api/integrations/tailscale/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authkey, sudoPassword: sudoPw }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--red,#e05c5c)">${escHtml(data.message || data.error || `Install failed (${r.status})`)}</span>`;
      showToast('Tailscale install failed');
    } else {
      if (statusEl) statusEl.innerHTML = `<span style="color:var(--green,#4caf50)">${escHtml(data.message || 'Installed.')}</span>`;
      showToast('Tailscale installed');
      // Clear secrets from the form, then refresh status.
      if ($('tailscaleAuthkeyInput')) $('tailscaleAuthkeyInput').value = '';
      if ($('tailscaleSudoInput'))    $('tailscaleSudoInput').value    = '';
      setTimeout(loadTailscaleStatus, 800);
    }
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--red,#e05c5c)">${escHtml(e.message)}</span>`;
    showToast('Install failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Install'; }
  }
}

async function uninstallTailscale() {
  if (!confirm('Uninstall Tailscale? This brings the node down and disables the system service.')) return;
  const sudoPw = $('tailscaleSudoInput')?.value || '';
  try {
    const r = await fetch('/api/integrations/tailscale/uninstall', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sudoPassword: sudoPw }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      showToast(data.error || `Uninstall failed (${r.status})`);
      return;
    }
    if ($('tailscaleSudoInput')) $('tailscaleSudoInput').value = '';
    showToast('Tailscale uninstalled');
    setTimeout(loadTailscaleStatus, 500);
  } catch (e) {
    showToast('Uninstall failed: ' + e.message);
  }
}

// "Ask the coordinator instead" — drop the user into chat with a prefilled
// prompt. The coordinator (whichever agent has oe-admin assigned, or just the
// default) handles the credential prompts via the chat-bubble widget.
function askCoordinatorTailscale() {
  try { closeAllDrawers?.(); } catch {}
  const composer = $('input');
  if (composer) {
    composer.value = 'Install Tailscale on this server.';
    composer.focus();
    // Move caret to the end so the user can append clarifications if needed.
    try { composer.setSelectionRange(composer.value.length, composer.value.length); } catch {}
  }
}

