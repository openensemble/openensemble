// ── OAuth / Connected Accounts ────────────────────────────────────────────────
// Shared POST/PATCH helper. fetch() only rejects on network failure, so a
// bare `await fetch()` treats a 400/403/500 as success — save handlers would
// report "saved" and clear the pasted key even when the server refused it.
// postJson throws on !r.ok with the server's {error} message so callers only
// commit success (clear inputs, toast) inside the try after this resolves.
async function postJson(url, body, opts = {}) {
  const r = await fetch(url, {
    method: opts.method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d?.error || `Request failed (${r.status})`);
  }
  return r.json().catch(() => ({}));
}
window.postJson = postJson;

// Single retry timer so back-to-back calls (settings tab re-open, polling)
// don't stack.
let _oauthRetryTimer = null;
let _oauthRetryAttempts = 0;
const OAUTH_RETRY_MAX = 6;       // 6 × 5s = up to 30s of polling
const OAUTH_RETRY_DELAY_MS = 5_000;

async function loadOAuthStatus() {
  // Render the AI provider logins surface (Profile tab) every time the
  // Connected Accounts section refreshes — keeps connect/disconnect state
  // visible even when the user has no email skills (which short-circuits below).
  loadAiProviderLogins();
  const el = $('oauthStatusRows');
  if (!el) return;
  // Hide entire Connected Accounts section if user has no email/calendar roles
  const container = el.parentElement;
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  const skills = _currentUser?.skills ?? [];
  const hasEmailAccess = isPriv || skills.includes('email') || skills.includes('gmail') || skills.includes('gcal');
  if (container) container.style.display = hasEmailAccess ? '' : 'none';
  if (!hasEmailAccess) return;
  try {
    // ── Email accounts ────────────────────────────────────────────────────────
    const [accountsRaw, oauthStatusRaw, providerCfgRaw] = await Promise.all([
      fetch('/api/email-accounts', { cache: 'no-store' }).then(r => r.json()).catch(() => []),
      fetch('/api/oauth/status', {}).then(r => r.json()).catch(() => ({})),
      fetch('/api/provider-config').then(r => r.json()).catch(() => ({})),
    ]);
    // Bulletproof shape coercion. The fetch().catch() chain only catches the
    // promise rejection path — if any of these endpoints quietly resolves to
    // a non-shape (a redirect-followed HTML error body that happened to
    // parse, an upstream proxy injecting an envelope, an error JSON
    // {error:"..."}), .map / object property access downstream blows up.
    const accounts    = Array.isArray(accountsRaw) ? accountsRaw : [];
    const oauthStatus = (oauthStatusRaw && typeof oauthStatusRaw === 'object') ? oauthStatusRaw : {};
    const providerCfg = (providerCfgRaw && typeof providerCfgRaw === 'object') ? providerCfgRaw : {};
    const { gcal, gmailHealth, msHealth, imapHealth } = oauthStatus;
    const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
    const msCreds = providerCfg.msClientIdSet && providerCfg.msClientSecretSet;
    const providerIcon = p => p === 'gmail' ? icon('mail', 13) : p === 'microsoft' ? icon('building', 13) : icon('globe', 13);
    // Account post-restart, the server's first health-check pass takes
    // 10–20s (token refresh round-trips, IMAP STARTTLS handshake). During
    // that window oauth/status returns no health value for the account, so
    // we render a "Reconnecting…" badge instead of nothing AND queue a
    // retry until everything reports a terminal state.
    let pendingHealthCount = 0;
    const accountRows = accounts.map(a => {
      const health = a.provider === 'gmail' ? (gmailHealth ?? {})[a.id]
                   : a.provider === 'microsoft' ? (msHealth ?? {})[a.id]
                   : a.provider === 'imap' ? (imapHealth ?? {})[a.id]
                   : null;
      const needsReconnect = health === 'expired' || health === 'no_refresh' || health === 'missing' || health === 'error';
      const isPending = health == null;
      if (isPending) pendingHealthCount++;
      // IMAP can't be "reconnected" via OAuth — the user must edit/replace the
      // account, so label the failure differently to point at the right action.
      const failBadgeText = a.provider === 'imap' ? 'Auth failed' : 'Token expired';
      const statusBadge = health === 'ok' ? '<span style="font-size:10px;color:var(--green,#4caf50);margin-left:4px">Connected</span>'
        : needsReconnect ? `<span style="font-size:10px;color:var(--red,#e05c5c);margin-left:4px">${failBadgeText}</span>`
        : isPending ? '<span style="font-size:10px;color:var(--accent);margin-left:4px;font-style:italic">Reconnecting…</span>'
        : '';
      return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0">
        <div style="font-size:12px;display:flex;align-items:center;gap:6px;min-width:0">
          <span>${providerIcon(a.provider)}</span>
          <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(a.label)}</span>
          <span style="font-size:10px;color:var(--muted);text-transform:uppercase">${escHtml(a.provider)}</span>
          ${statusBadge}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          ${a.provider === 'gmail' ? `<button data-action="reconnectGmail" data-args='${JSON.stringify([a.id]).replace(/'/g, "&#39;")}' style="background:${needsReconnect ? 'var(--accent)' : 'none'};border:1px solid ${needsReconnect ? 'transparent' : 'var(--border)'};color:${needsReconnect ? '#fff' : 'var(--text)'};border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;font-weight:${needsReconnect ? '600' : '400'}">${needsReconnect ? 'Reconnect' : 'Re-auth'}</button>` : ''}
          ${a.provider === 'microsoft' ? `<button data-action="reconnectMicrosoft" data-args='${JSON.stringify([a.id]).replace(/'/g, "&#39;")}' style="background:${needsReconnect ? 'var(--accent)' : 'none'};border:1px solid ${needsReconnect ? 'transparent' : 'var(--border)'};color:${needsReconnect ? '#fff' : 'var(--text)'};border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;font-weight:${needsReconnect ? '600' : '400'}">${needsReconnect ? 'Reconnect' : 'Re-auth'}</button>` : ''}
          <button data-action="renameEmailAccount" data-args='${JSON.stringify([a.id, a.label]).replace(/'/g, "&#39;")}' style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">Rename</button>
          <button data-action="deleteEmailAccount" data-args='${JSON.stringify([a.id]).replace(/'/g, "&#39;")}' style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">Delete</button>
        </div>
      </div>`;
    }).join('');

    // ── Google Calendar row (grouped with other connected accounts) ───────────
    const gcalRow = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0">
        <div style="font-size:12px;display:flex;align-items:center;gap:6px;min-width:0">
          <span>📅</span>
          <span style="font-weight:600">Google Calendar</span>
          <span style="font-size:10px;color:var(--muted);text-transform:uppercase">gcal</span>
          ${gcal ? '<span style="font-size:10px;color:var(--green,#4caf50);margin-left:4px">Connected</span>' : ''}
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          ${gcal
            ? `<button data-action="disconnectGoogle" data-args='["gcal"]' style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">Disconnect</button>`
            : `<button data-action="connectGoogle" data-args='["gcal"]' style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;font-weight:600">Connect</button>`}
        </div>
      </div>`;
    const hasAnyAccount = accounts.length > 0 || gcal;
    el.innerHTML = `
      ${accountRows}
      ${gcalRow}
      ${!hasAnyAccount ? '<div style="color:var(--muted);font-size:12px;padding:4px 0">No accounts connected.</div>' : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button data-action="connectGoogle" data-args='["gmail"]' style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600">+ Connect Gmail</button>
        <button data-action="connectMicrosoft" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600">+ Connect Microsoft</button>
        ${isPriv && msCreds ? `<button data-action="clearMicrosoftCreds" style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer">Clear MS credentials</button>` : ''}
        <button data-action="showAddImapModal" style="background:none;border:1px solid var(--accent);color:var(--accent);border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600">+ Add IMAP…</button>
      </div>`;
    // Schedule a retry only when there are configured accounts whose health
    // hasn't reported yet (typical right after a server restart). Skip the
    // retry entirely when accounts.length === 0 — showing "Reconnecting…"
    // for a stranger with no configured accounts would just be confusing.
    if (_oauthRetryTimer) { clearTimeout(_oauthRetryTimer); _oauthRetryTimer = null; }
    if (pendingHealthCount > 0 && _oauthRetryAttempts < OAUTH_RETRY_MAX) {
      _oauthRetryAttempts++;
      _oauthRetryTimer = setTimeout(() => loadOAuthStatus(), OAUTH_RETRY_DELAY_MS);
    } else {
      _oauthRetryAttempts = 0; // reset for next page open
    }
  } catch (e) {
    console.error('[oauth] loadOAuthStatus failed', e);
    el.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">Connected accounts failed to load: ${escHtml(e?.message ?? String(e))}</div>`;
  }
}

async function connectMicrosoft() {
  // Default path: use OE's built-in multi-tenant Azure app. The server falls
  // back to it automatically when no user-configured creds exist AND the
  // redirect URI is loopback (Microsoft's localhost rule). Only show the
  // credentials modal if the user explicitly opts in via the override link.
  try {
    await _doMicrosoftOAuth();
  } catch (e) { alert(`Error: ${e.message}`); }
}

function showMicrosoftCredsModal() {
  $('msCredsModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'msCredsModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:24px;width:380px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;gap:12px">
      <div style="font-size:14px;font-weight:700">Connect Microsoft / Outlook</div>
      <div style="font-size:11px;color:var(--muted);line-height:1.5">Register an app at <strong>portal.azure.com → App registrations</strong> with redirect URI <code style="background:var(--bg3);padding:1px 4px;border-radius:3px">http://localhost:3737/api/oauth/microsoft/callback</code> and delegated scopes <code style="background:var(--bg3);padding:1px 4px;border-radius:3px">Mail.ReadWrite Mail.Send offline_access</code>, then paste the credentials below. Granting admin consent in Azure is required for organizational accounts (Office 365, GoDaddy 365, etc.).</div>
      <input id="msCrClientId" placeholder="Application (client) ID" autocomplete="off"
        style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <input id="msCrClientSecret" type="password" placeholder="Client secret value" autocomplete="new-password"
        style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <input id="msCrTenant" placeholder="Tenant (leave blank for personal + work accounts)" autocomplete="off"
        style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <div id="msCrError" style="color:var(--red,#e05c5c);font-size:11px;display:none"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button data-action="_closeMsCredsModal" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer">Cancel</button>
        <button id="msCrSubmitBtn" data-action="submitMicrosoftCreds" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600">Save &amp; Connect</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// Wrappers for the event-delegation harness — simple modal-close shortcuts
// previously inlined as `$('msCredsModal').remove()` etc.
function _closeMsCredsModal() { $('msCredsModal')?.remove(); }
function _closeImapModal()    { $('imapModal')?.remove(); }

async function submitMicrosoftCreds() {
  const clientId     = $('msCrClientId')?.value.trim();
  const clientSecret = $('msCrClientSecret')?.value.trim();
  const tenant       = $('msCrTenant')?.value.trim() || 'common';
  const errEl        = $('msCrError');
  const btn          = $('msCrSubmitBtn');
  if (!clientId || !clientSecret) {
    if (errEl) { errEl.textContent = 'Client ID and Secret are required.'; errEl.style.display = ''; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await postJson('/api/provider-config', { msClientId: clientId, msClientSecret: clientSecret, msTenant: tenant });
    $('msCredsModal')?.remove();
    await _doMicrosoftOAuth();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.style.display = ''; }
    if (btn) { btn.disabled = false; btn.textContent = 'Save & Connect'; }
  }
}

async function clearMicrosoftCreds() {
  if (!confirm('Delete saved Microsoft app credentials? Users will need to re-enter them to connect Microsoft accounts.')) return;
  try {
    await fetch('/api/provider-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearMicrosoftCreds: true }),
    });
    showToast('Microsoft credentials cleared');
    await loadOAuthStatus();
  } catch { showToast('Failed to clear credentials'); }
}

async function _doMicrosoftOAuth() {
  const acct = await fetch('/api/email-accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'microsoft', label: 'Work' }),
  }).then(r => r.json());
  if (acct.error) { alert(`Error: ${acct.error}`); return; }
  const res = await fetch(`/api/oauth/microsoft/connect?accountId=${encodeURIComponent(acct.id)}`).then(r => r.json());
  if (res.error) { alert(`Error: ${res.error}`); return; }
  // Deliberately WITHOUT noopener: _watchOAuthAccount needs popup.closed to
  // tell "consent in progress" from "abandoned" so it only reaps the pre-created
  // shell account on a real cancel (with noopener the handle is null → it would
  // reap mid-consent). Safe: this popup only ever loads first-party/Microsoft
  // consent pages, never attacker content, so the reverse-tabnabbing surface
  // noopener guards against isn't reachable here.
  const popup = window.open(res.url, '_blank');
  _watchOAuthAccount(acct.id, 'microsoft', popup);
}

async function renameEmailAccount(id, currentLabel) {
  const newLabel = window.prompt('Rename account:', currentLabel);
  if (!newLabel || newLabel === currentLabel) return;
  try {
    await fetch(`/api/email-accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: newLabel }),
    });
    _inboxAccounts = []; // force tab reload
    await loadOAuthStatus();
  } catch (e) { alert(`Error: ${e.message}`); }
}

async function deleteEmailAccount(id) {
  if (!confirm('Remove this email account?')) return;
  try {
    await fetch(`/api/email-accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    _inboxAccounts = [];
    if (_activeInboxAccountId === id) _activeInboxAccountId = null;
    await loadOAuthStatus();
  } catch (e) { alert(`Error: ${e.message}`); }
}

const IMAP_PRESETS = {
  '': { host: '', port: 993, tls: true, note: '' },
  'office365': {
    host: 'outlook.office365.com', port: 993, tls: true,
    smtpHost: 'smtp.office365.com', smtpPort: 587, smtpTls: true,
    note: 'Office 365 / Exchange Online disabled basic passwords in 2022. You need an <strong>app password</strong>: go to <em>account.microsoft.com → Security → Advanced security options → App passwords</em> and generate one, then use it here instead of your normal password.',
  },
  'gmail': {
    host: 'imap.gmail.com', port: 993, tls: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpTls: true,
    note: 'Gmail requires an <strong>app password</strong> (not your regular password). Go to <em>myaccount.google.com → Security → 2-Step Verification → App passwords</em> to generate one.',
  },
  'yahoo':    { host: 'imap.mail.yahoo.com', port: 993, tls: true, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 587, smtpTls: true, note: 'Yahoo requires an app password. Go to <em>Yahoo Account Security → Generate app password</em>.' },
  'fastmail': { host: 'imap.fastmail.com',   port: 993, tls: true, smtpHost: 'smtp.fastmail.com',   smtpPort: 465, smtpTls: true, note: '' },
  'icloud':   { host: 'imap.mail.me.com',    port: 993, tls: true, smtpHost: 'smtp.mail.me.com',    smtpPort: 587, smtpTls: true, note: 'iCloud requires an app-specific password from <em>appleid.apple.com → Sign-In and Security → App-Specific Passwords</em>.' },
  'custom':   { host: '', port: 993, tls: true, note: '' },
};

function imapPresetChanged() {
  const sel = $('imapPreset');
  const preset = IMAP_PRESETS[sel?.value ?? ''];
  if (!preset) return;
  if (preset.host) $('imapHost').value = preset.host;
  $('imapPort').value = preset.port;
  $('imapTls').checked = preset.tls;
  const noteEl = $('imapNote');
  if (noteEl) { noteEl.innerHTML = preset.note; noteEl.style.display = preset.note ? '' : 'none'; }
}

function showAddImapModal() {
  $('imapModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'imapModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:24px;width:360px;max-width:calc(100vw - 32px);display:flex;flex-direction:column;gap:12px;max-height:90vh;overflow-y:auto">
      <div style="font-size:14px;font-weight:700">Add IMAP Account</div>
      <div style="display:flex;flex-direction:column;gap:4px">
        <label style="font-size:11px;color:var(--muted)">Provider</label>
        <select id="imapPreset" data-change-action="imapPresetChanged" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
          <option value="">— Select a provider —</option>
          <option value="office365">Office 365 / Exchange Online</option>
          <option value="gmail">Gmail (IMAP)</option>
          <option value="yahoo">Yahoo Mail</option>
          <option value="fastmail">Fastmail</option>
          <option value="icloud">iCloud Mail</option>
          <option value="custom">Custom / Self-hosted</option>
        </select>
      </div>
      <div id="imapNote" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:9px 11px;font-size:11px;color:var(--muted);line-height:1.5;display:none"></div>
      <input id="imapLabel"    placeholder="Label (e.g. Work)"     style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <input id="imapHost"     placeholder="IMAP host" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <div style="display:flex;gap:8px">
        <input id="imapPort" placeholder="Port" value="993" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:80px;box-sizing:border-box">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer"><input type="checkbox" id="imapTls" checked> TLS</label>
      </div>
      <input id="imapUsername" placeholder="Username / email" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <input id="imapSmtpFrom" type="email" placeholder="SMTP From email (optional; defaults to username)" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <input id="imapPassword" type="password" placeholder="Password or app password" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <div id="imapError" style="color:var(--red,#e05c5c);font-size:11px;display:none"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button data-action="_closeImapModal" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer">Cancel</button>
        <button data-action="submitImapAccount" id="imapSubmitBtn" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600">Connect</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function submitImapAccount() {
  const label    = $('imapLabel')?.value.trim();
  const host     = $('imapHost')?.value.trim();
  const port     = parseInt($('imapPort')?.value ?? '993', 10);
  const tls      = $('imapTls')?.checked !== false;
  const username = $('imapUsername')?.value.trim();
  const smtpFrom = $('imapSmtpFrom')?.value.trim();
  const password = $('imapPassword')?.value;
  const errEl    = $('imapError');
  const btn      = $('imapSubmitBtn');

  if (!label || !host || !username || !password) {
    if (errEl) { errEl.textContent = 'All fields are required.'; errEl.style.display = ''; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
  if (errEl) errEl.style.display = 'none';

  try {
    const presetKey = $('imapPreset')?.value ?? '';
    const preset = IMAP_PRESETS[presetKey] ?? {};
    const payload = { provider: 'imap', label, host, port, tls, username, password };
    if (preset.smtpHost) {
      payload.smtpHost = preset.smtpHost;
      payload.smtpPort = preset.smtpPort;
      payload.smtpTls  = preset.smtpTls;
    }
    if (smtpFrom) payload.smtpFrom = smtpFrom;
    const res = await fetch('/api/email-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (res.error) throw new Error(res.error);
    $('imapModal')?.remove();
    _inboxAccounts = [];
    await loadOAuthStatus();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.style.display = ''; }
    if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
  }
}

async function reconnectMicrosoft(accountId) {
  try {
    const res = await fetch(`/api/oauth/microsoft/connect?accountId=${encodeURIComponent(accountId)}`).then(r => r.json());
    if (res.error) { alert(`Error: ${res.error}`); return; }
    window.open(res.url, '_blank', 'noopener');
  } catch (e) { alert(`Error: ${e.message}`); }
}

async function reconnectGmail(accountId) {
  try {
    const res = await fetch(`/api/oauth/google/connect?service=gmail&accountId=${encodeURIComponent(accountId)}`);
    if (!res.ok) { alert('Failed to start re-authorization. Check server logs.'); return; }
    const { url } = await res.json();
    window.open(url, '_blank', 'noopener');
  } catch (e) { alert(`Error: ${e.message}`); }
}

// Light poll to flip the Connected Accounts panel to "Connected" once a popup
// OAuth consent finishes (the callback lands on the server, not this page, so
// nothing refreshes on its own). Mirrors the ChatGPT flow's poll.
function _pollOAuthStatus(times = 12, everyMs = 5000) {
  let n = 0;
  const t = () => { loadOAuthStatus(); if (++n < times) setTimeout(t, everyMs); };
  setTimeout(t, everyMs);
}

// Gmail/Microsoft create a shell email account *before* OAuth. If the user
// closes the popup without consenting, that shell row lingers as an orphan.
// Poll the account's health to (a) refresh the panel on completion, and (b)
// delete the orphan once the popup is closed and no token was ever stored.
// Requires a popup handle (opened without noopener) to observe `.closed`.
function _watchOAuthAccount(accountId, provider, popup) {
  if (!accountId) { _pollOAuthStatus(); return; }
  let ticks = 0, orphanStreak = 0;
  const MAX = 20; // ~1 min at 3s
  const tick = async () => {
    ticks++;
    let st = {};
    try { st = await fetch('/api/oauth/status').then(r => r.json()); } catch {}
    const map = provider === 'microsoft' ? (st.msHealth || {}) : (st.gmailHealth || {});
    const h = map[accountId];
    await loadOAuthStatus(); // refresh the panel every tick
    if (h === 'ok') return;  // consent completed — done
    // Hard-failure health means no token is on disk. If the popup is gone and
    // we see this twice in a row (~6s, so a token written as the popup closed
    // isn't wiped by a stale probe), the shell row is an abandoned orphan.
    const failed = h === 'missing' || h === 'no_refresh' || h === 'expired' || h === 'error';
    if ((!popup || popup.closed) && failed) {
      if (++orphanStreak >= 2) {
        try { await fetch(`/api/email-accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }); } catch {}
        _inboxAccounts = [];
        await loadOAuthStatus();
        return;
      }
    } else {
      orphanStreak = 0;
    }
    if (ticks >= MAX) return; // give up; leave any still-in-progress account
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

async function connectGoogle(service) {
  try {
    let qs = `service=${service}`;
    let acctId = null;
    // For Gmail, create a shell account first so each connection gets its own token file
    if (service === 'gmail') {
      const acct = await fetch('/api/email-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'gmail', label: 'Gmail' }),
      }).then(r => r.json());
      if (acct.error) { alert(`Error: ${acct.error}`); return; }
      acctId = acct.id;
      qs += `&accountId=${encodeURIComponent(acct.id)}`;
    }
    const res = await fetch(`/api/oauth/google/connect?${qs}`, {});
    if (!res.ok) { alert('Failed to start authorization. Check server logs.'); return; }
    const { url } = await res.json();
    // Deliberately WITHOUT noopener: _watchOAuthAccount needs popup.closed to
    // tell "consent in progress" from "abandoned" so it only reaps the
    // pre-created shell account on a real cancel (with noopener the handle is
    // null → it would reap mid-consent). Safe: this popup only ever loads
    // first-party/Google consent pages, never attacker content, so the
    // reverse-tabnabbing surface noopener guards against isn't reachable here.
    const popup = window.open(url, '_blank');
    if (service === 'gmail') _watchOAuthAccount(acctId, 'gmail', popup);
    else _pollOAuthStatus();
  } catch (e) { alert(`Error: ${e.message}`); }
}

// ── OpenAI Codex (ChatGPT) OAuth ───────────────────────────────────────────
async function connectOpenAIOAuth() {
  try {
    const res = await fetch('/api/oauth/openai/connect');
    if (!res.ok) { alert('Failed to start ChatGPT authorization.'); return; }
    const { url } = await res.json();
    window.open(url, '_blank', 'noopener');

    // Show the inline paste fallback up-front so remote-server users don't
    // have to wait for the popup to fail. Local-machine installs will finish
    // via the :1455 callback and the poll below will hide the paste box.
    showOpenAIPasteBox();

    // Poll status so the UI flips to "connected" once auth finishes (either
    // via the :1455 callback on local installs, or via the paste submission).
    let tries = 0;
    const poll = async () => {
      if (tries++ > 60) return; // ~5 min
      try {
        const s = await fetch('/api/oauth/openai/status').then(r => r.json());
        if (s.connected) { hideOpenAIPasteBox(); refreshOpenAIOAuthStatus(); return; }
      } catch {}
      setTimeout(poll, 5000);
    };
    setTimeout(poll, 3000);
  } catch (e) { alert(`Error: ${e.message}`); }
}

function showOpenAIPasteBox() {
  const box = document.getElementById('providerPaste_openai-oauth');
  const input = document.getElementById('providerPasteInput_openai-oauth');
  const msg = document.getElementById('providerPasteMsg_openai-oauth');
  if (!box || !input) return;
  box.style.display = 'block';
  input.value = '';
  if (msg) msg.textContent = '';
  input.focus();
  // Auto-submit whenever the input holds a URL-shaped value, regardless of how
  // it got there (keyboard paste, right-click paste, drag-drop, typing). The
  // old onpaste-only handler missed right-click paste in some browsers, forcing
  // a second paste. Guarded so it only auto-fires once per Connect flow.
  let submitted = false;
  input.oninput = () => {
    const text = (input.value || '').trim();
    if (submitted) return;
    if (/[?&]code=/.test(text) && /[?&]state=/.test(text)) {
      submitted = true;
      submitOpenAIPasteCallback();
    }
  };
  // Enter as a manual fallback — also resets the guard so a corrected URL can
  // be re-submitted if the first attempt hit an error.
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitted = true;
      submitOpenAIPasteCallback();
    }
  };
}

function hideOpenAIPasteBox() {
  const box = document.getElementById('providerPaste_openai-oauth');
  const input = document.getElementById('providerPasteInput_openai-oauth');
  if (box) box.style.display = 'none';
  if (input) { input.value = ''; input.onpaste = null; input.onkeydown = null; }
}

async function submitOpenAIPasteCallback() {
  const input = document.getElementById('providerPasteInput_openai-oauth');
  const msg = document.getElementById('providerPasteMsg_openai-oauth');
  if (!input || !msg) return;
  const pasted = (input.value || '').trim();
  if (!pasted) return;
  msg.textContent = 'Completing…';
  try {
    const r = await fetch('/api/oauth/openai/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: pasted }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { msg.textContent = data?.error || 'Failed to complete OAuth.'; return; }
    hideOpenAIPasteBox();
    refreshOpenAIOAuthStatus();
  } catch (e) { msg.textContent = `Error: ${e.message}`; }
}

// Profile-tab surface for OAuth-based AI provider logins, shown only to
// non-privileged users who have been granted access by an admin. Owner/admin
// already get the full card under Settings > Providers, so we skip rendering
// here for them to avoid duplicate DOM IDs.
const AI_OAUTH_PROVIDER_META = [
  { id: 'openai-oauth', label: 'OpenAI (ChatGPT login)', icon: 'log-in', blurb: 'Sign in with your ChatGPT Plus/Pro account to use Codex models via OAuth.' },
];

function loadAiProviderLogins() {
  const section = $('aiProviderLoginsSection');
  const host = $('aiProviderLoginsRows');
  if (!section || !host) return;
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  const granted = Array.isArray(_currentUser?.allowedOAuthProviders) ? _currentUser.allowedOAuthProviders : [];
  const visible = AI_OAUTH_PROVIDER_META.filter(p => !isPriv && granted.includes(p.id));
  if (visible.length === 0) { section.style.display = 'none'; host.innerHTML = ''; return; }
  section.style.display = '';
  host.innerHTML = visible.map(p => `
    <div class="provider-card" id="providerCard_${p.id}" style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:13px;font-weight:600">
        <i data-lucide="${p.icon}" style="width:14px;height:14px"></i> ${p.label}
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px">${p.blurb}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button id="oauthConnect_${p.id}" data-action="connectOpenAIOAuth"
          style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600">Connect ChatGPT account</button>
        <button id="oauthRefresh_${p.id}" data-action="refreshOpenAIOAuthToken"
          title="Renew the login token without reconnecting"
          style="display:none;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer">Refresh token</button>
        <button id="oauthDisconnect_${p.id}" data-action="disconnectOpenAIOAuth"
          style="display:none;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer">Disconnect</button>
        <button data-action="refreshOpenAIOAuthStatus"
          style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer">Check status</button>
      </div>
      <div id="providerStatus_${p.id}" style="font-size:11px;color:var(--muted);margin-top:6px">Checking…</div>
      <div id="providerPaste_${p.id}" style="display:none;margin-top:10px;padding:10px;background:var(--bg3);border:1px solid var(--border);border-radius:8px">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px">If the ChatGPT page ended on a "could not connect" screen (URL starts with <code>http://localhost:1455/auth/callback?code=…</code>), paste that full URL here.</div>
        <input type="text" id="providerPasteInput_${p.id}" placeholder="http://localhost:1455/auth/callback?code=…"
          style="width:100%;box-sizing:border-box;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 10px;font-size:12px">
        <div id="providerPasteMsg_${p.id}" style="font-size:11px;color:var(--red,#e05c5c);margin-top:6px"></div>
      </div>
    </div>`).join('');
  if (window.lucide?.createIcons) try { window.lucide.createIcons(); } catch {}
  refreshOpenAIOAuthStatus().catch(() => {});
}

async function disconnectOpenAIOAuth() {
  if (!confirm('Disconnect your ChatGPT account? You will need to reconnect to use Codex OAuth models.')) return;
  const box = document.getElementById('providerStatus_openai-oauth');
  if (box) box.textContent = 'Disconnecting…';
  try {
    const r = await fetch('/api/oauth/openai', { method: 'DELETE' });
    if (!r.ok) {
      if (box) box.textContent = `Disconnect failed (${r.status}).`;
      return;
    }
    await refreshOpenAIOAuthStatus();
  } catch (e) {
    if (box) box.textContent = `Disconnect failed: ${e.message}`;
  }
}

async function refreshOpenAIOAuthStatus() {
  const box = document.getElementById('providerStatus_openai-oauth');
  if (!box) return;
  const connectBtn    = document.getElementById('oauthConnect_openai-oauth');
  const disconnectBtn = document.getElementById('oauthDisconnect_openai-oauth');
  const refreshBtn    = document.getElementById('oauthRefresh_openai-oauth');
  box.textContent = 'Checking…';
  try {
    const s = await fetch('/api/oauth/openai/status').then(r => r.json());
    if (s.connected) {
      const plan = s.plan ? ` (${s.plan})` : '';
      const acct = s.accountId ? ` · account ${s.accountId.slice(0, 8)}…` : '';
      const exp  = s.expiresAt ? ` · token valid until ${new Date(s.expiresAt).toLocaleDateString()}` : '';
      box.textContent = `Connected${plan}${acct}${exp}.`;
      if (connectBtn)    connectBtn.style.display    = 'none';
      if (disconnectBtn) disconnectBtn.style.display = '';
      if (refreshBtn)    refreshBtn.style.display    = '';
      // Load the static model list so the agent model picker shows Codex models
      loadCompatProviderModels('openai-oauth').catch(() => {});
    } else {
      box.textContent = 'Not connected.';
      if (connectBtn)    connectBtn.style.display    = '';
      if (disconnectBtn) disconnectBtn.style.display = 'none';
      if (refreshBtn)    refreshBtn.style.display    = 'none';
    }
  } catch {
    box.textContent = 'Status check failed.';
    if (connectBtn)    connectBtn.style.display    = '';
    if (disconnectBtn) disconnectBtn.style.display = 'none';
    if (refreshBtn)    refreshBtn.style.display    = 'none';
  }
}

// Renew the ChatGPT login token in place (no disconnect/reconnect). If the
// refresh_token itself is dead (account left idle too long), the server returns
// needsReconnect and we prompt a reconnect.
async function refreshOpenAIOAuthToken() {
  const box = document.getElementById('providerStatus_openai-oauth');
  const btn = document.getElementById('oauthRefresh_openai-oauth');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  if (box) box.textContent = 'Refreshing login token…';
  try {
    const res = await fetch('/api/oauth/openai/refresh', { method: 'POST' });
    const d = await res.json().catch(() => ({}));
    if (res.ok) {
      if (typeof showToast === 'function') showToast('ChatGPT login token refreshed', 'success');
    } else if (d.needsReconnect) {
      if (typeof showToast === 'function') showToast(d.error || 'Refresh failed — please reconnect.', 'error');
    } else {
      if (typeof showToast === 'function') showToast(d.error || 'Refresh failed.', 'error');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast(`Refresh failed: ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh token'; }
    refreshOpenAIOAuthStatus().catch(() => {});
  }
}

async function disconnectGoogle(service) {
  const label = service === 'gcal' ? 'Google Calendar' : 'Gmail';
  if (!confirm(`Disconnect ${label}? You will need to reconnect to use it again.`)) return;
  try {
    await fetch(`/api/oauth/google?service=${service}`, { method: 'DELETE', headers: authHeaders() });
    await loadOAuthStatus();
  } catch (e) { alert(`Error: ${e.message}`); }
}

function renderVisionModelSelect(currentProvider, currentModel) {
  const row = $('visionModelSelectRow');
  if (!row) return;
  // Reuse the agent model catalog as the single source of truth, filtered to
  // models that actually accept image input. supportsVision is annotated by
  // the server (lib/model-capabilities.mjs) per-provider. New providers
  // become available as soon as their entries flag supportsVision: true.
  const visionModels = allAvailableModels().filter(m => m.supportsVision === true);
  const currentVal   = currentModel && currentProvider ? `${currentModel}||${currentProvider}` : '';

  // Group by provider, label local/cloud Ollama tiers separately for clarity.
  const groups = {};
  const labelFor = (m) => {
    if (m.provider === 'ollama')   return m.tier === 'cloud' ? 'Ollama (cloud)' : 'Ollama (local)';
    if (m.provider === 'lmstudio') return 'LM Studio (local)';
    if (m.provider === 'anthropic')return 'Anthropic';
    if (m.provider === 'openai-oauth') return 'ChatGPT (OAuth)';
    if (m.provider === 'openai')   return 'OpenAI';
    if (m.provider === 'openrouter') return 'OpenRouter';
    if (m.provider === 'fireworks') return 'Fireworks';
    if (m.provider === 'grok' || m.provider === 'xai') return 'Grok / xAI';
    if (m.provider === 'gemini' || m.provider === 'google') return 'Google Gemini';
    return m.provider || 'Other';
  };
  for (const m of visionModels) (groups[labelFor(m)] ||= []).push(m);

  const mkOpt = m => {
    const val = `${m.name}||${m.provider}`;
    const display = m.displayName || m.name;
    return `<option value="${escHtml(val)}" ${val === currentVal ? 'selected' : ''}>${escHtml(display)}</option>`;
  };

  const groupHtml = Object.entries(groups)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, list]) => `<optgroup label="${escHtml(label)}">${list.map(mkOpt).join('')}</optgroup>`)
    .join('');

  const empty = visionModels.length === 0
    ? `<option value="" disabled selected>No vision-capable models found — pull a vision model (e.g. \`ollama pull llama3.2-vision\`) or enable a cloud provider with vision support.</option>`
    : '';

  row.innerHTML = `<select id="visionModelSelect" style="flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
    ${empty || (currentVal && !visionModels.some(m => `${m.name}||${m.provider}` === currentVal) ? `<option value="${escHtml(currentVal)}" selected>⚠ ${escHtml(currentModel)} (no longer available / not vision-capable)</option>` : '')}
    ${groupHtml}
  </select>
  <button data-action="saveVisionProvider" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600">Save</button>`;
}

async function openSettingsDrawer(openIt = true) {
  if (openIt) toggleDrawer('drawerSettings', 'sbtnSettings');
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  if (typeof loadOrchestrationSettings === 'function') loadOrchestrationSettings();

  // Show/hide admin-only tabs
  const usersTabBtn = $('stab-users');
  if (usersTabBtn) usersTabBtn.style.display = isPriv ? '' : 'none';
  const providersTabBtn = $('stab-providers');
  if (providersTabBtn) providersTabBtn.style.display = isPriv ? '' : 'none';
  const systemTabBtn = $('stab-system');
  if (systemTabBtn) systemTabBtn.style.display = isPriv ? '' : 'none';

  // Profile tab content
  const profileRow = $('profileInfoRow');
  const roleBadge  = $('profileRoleBadge');
  if (profileRow && _currentUser) profileRow.textContent = `Signed in as ${_currentUser.emoji ?? '🧑'} ${_currentUser.name}`;
  if (roleBadge && _currentUser?.role) {
    const roleLabel = { owner: '👑 Owner', admin: '🔑 Admin', user: '👤 User', child: '🧒 Child' }[_currentUser.role] ?? '👤 User';
    const roleColor = { owner: 'var(--accent)', admin: '#f5a623', user: 'var(--muted)', child: '#43b89c' }[_currentUser.role] ?? 'var(--muted)';
    roleBadge.style.display = 'inline-block';
    roleBadge.innerHTML = `<span style="font-size:11px;padding:2px 8px;border-radius:20px;background:var(--bg3);color:${roleColor};border:1px solid ${roleColor};font-weight:600">${roleLabel}</span>`;
  }

  // Kick off user management + provider config immediately (don't block behind model loading)
  if (isPriv) {
    loadUserManagement();
    loadProviderConfig();
    fetch('/api/config-public').then(r => r.json()).then(fullCfg => {
      renderVisionModelSelect(fullCfg.visionProvider, fullCfg.visionModel);
      if (fullCfg.sessionExpiryHours)    $('sessionExpiryInput').value          = fullCfg.sessionExpiryHours;
      const tog = $('stripThinkingToggle');
      if (tog) { tog.checked = fullCfg.stripThinkingTags !== false; setStripThinkingTrack(tog.checked); }
    }).catch(() => {});
    // Show admin-only system sections
    ['visionProviderRow','sessionExpiryRow','stripThinkingRow','stab-backup','braveApiKeyRow','homeAssistantRow','tvVideoSourcesRow'].forEach(id => {
      const el = $(id); if (el) el.style.display = '';
    });
    if (typeof loadBraveApiKeyStatus === 'function') loadBraveApiKeyStatus();
    if (typeof loadUpdateStatus === 'function') loadUpdateStatus();
    if (typeof loadTvVideoSources === 'function') loadTvVideoSources();
  } else {
    // Hide admin-only sections for regular users
    ['visionProviderRow','sessionExpiryRow','stripThinkingRow','stab-backup','braveApiKeyRow','homeAssistantRow','tvVideoSourcesRow'].forEach(id => {
      const el = $(id); if (el) el.style.display = 'none';
    });
  }

  // Load models — needed by Agents, Plugins, and System tabs (runs in parallel with user management)
  try {
    // Block the initial render only on fast endpoints. Fireworks' listing API
    // is paged and can stall for 10-15s when the upstream is flaky — fire it
    // in the background and just re-render the model browser/agent rows when
    // it returns.
    // Cortex/reason/plan runtime endpoints are admin-only (requirePrivileged)
    // and back the System tab which is hidden for non-admins; skip them for
    // regular users so the network tab doesn't pile up 403s.
    const adminOnlyLoads = isPriv
      ? [loadCortexConfig(), loadReasonRuntimeStatus(), loadPlanRuntimeStatus()]
      : [];
    await Promise.all([loadModels(), ...adminOnlyLoads]);
    renderModelBrowser(); renderAgentModelRows(); renderDrawersSettings();
    if (isPriv) { renderCortexModelRows(); renderPlanModelRows(); checkCortexHealth().then(renderCortexModelRows); }
    loadFireworksModels().then(() => { renderModelBrowser?.(); renderAgentModelRows?.(); refreshSkillExecutionModelSelects?.(); }).catch(() => {});
    loadAnthropicModels().then(() => { renderModelBrowser?.(); renderAgentModelRows?.(); refreshSkillExecutionModelSelects?.(); }).catch(() => {});
    loadGrokModels().then(() => { renderModelBrowser?.(); renderAgentModelRows?.(); refreshSkillExecutionModelSelects?.(); }).catch(() => {});
  } catch(e) {
    console.error('Failed to load models:', e);
  }

  loadSkillsList();
}

let _enabledProviders = {};
let _providerKeyStatus = {};

// UI metadata (icons, blurbs, placeholders) for the built-in OpenAI-compat
// providers. The list of providers IS the server's compatProviders array (so
// runtime-added providers via oe-admin show up too); this map only supplies
// the per-provider chrome the server doesn't know about. openai-oauth is the
// odd one out — it uses an OAuth connect flow rather than an API-key input.
const COMPAT_BUILTIN_META = {
  openai:        { icon: 'sparkles', placeholder: 'sk-…',    blurb: 'API key for OpenAI models (GPT-5, GPT-4.1, o-series, etc.).' },
  'openai-oauth':{ icon: 'log-in',   connectMode: 'oauth',   blurb: 'Sign in with your ChatGPT Plus/Pro account to use Codex models via OAuth.' },
  gemini:        { icon: 'gem',      placeholder: 'AIza…',   blurb: 'API key for Google Gemini via the OpenAI-compat endpoint.' },
  deepseek:      { icon: 'brain',    placeholder: 'sk-…',    blurb: 'API key for DeepSeek (deepseek-chat, deepseek-reasoner).' },
  mistral:       { icon: 'wind',     placeholder: 'API key', blurb: 'API key for Mistral AI (Mistral Large, Codestral, etc.).' },
  groq:          { icon: 'bolt',     placeholder: 'gsk_…',   blurb: 'API key for Groq ultra-fast inference (Llama, Mixtral, Qwen).' },
  together:      { icon: 'users',    placeholder: 'API key', blurb: 'API key for Together AI — hundreds of open-weight models.' },
  perplexity:    { icon: 'search',   placeholder: 'pplx-…',  blurb: 'API key for Perplexity Sonar models (search-grounded).' },
  zai:           { icon: 'zap',      placeholder: 'API key', blurb: 'API key for Z.AI (GLM-5.1, GLM-5V-Turbo — OpenAI-compatible).' },
};

// Mutable. Populated by loadProviderConfig() from /api/provider-config's
// `compatProviders` array. Shape per entry: { id, label, icon, placeholder,
// keyField, blurb, connectMode?, source: 'static'|'user' }. Other modules
// (settings.js) read this via getCompatProviderMeta() so they iterate the
// same merged list and never need to know which providers exist statically
// vs which were added via add_provider.
let COMPAT_PROVIDER_META = [];

// Frontend-only virtual entries — providers that don't live in the server's
// OPENAI_COMPAT_PROVIDERS map (no API key field, no shared compat flow) but
// still need a card + model-picker group in the UI. openai-oauth is the
// canonical example: it uses ChatGPT OAuth + a hardcoded model list, so the
// backend doesn't surface it through /api/provider-config's compatProviders.
// We splice it in here so the UI behaves the same as before the server-driven
// list landed.
const COMPAT_VIRTUAL_PROVIDERS = [
  {
    id: 'openai-oauth',
    displayName: 'OpenAI (ChatGPT login)',
    keyField: null,
    source: 'virtual',
    insertAfter: 'openai',
  },
];

// Server compat entries we DON'T want rendered by the dynamic UI because they
// already have a hardcoded card + separate model-picker pipeline elsewhere.
// `xai` shares grokApiKey with the legacy `grok` client (image/video). Showing
// both would duplicate the card AND the Grok optgroup in the agent model
// picker. The hardcoded grok card is the canonical UI surface; xai stays in
// the backend Proxy so chat dispatch can still hit /v1/chat/completions when
// it wants the OpenAI-compat path.
const COMPAT_FRONTEND_EXCLUDED = new Set(['xai']);

function buildCompatProviderMeta(compatProviders) {
  const raw = Array.isArray(compatProviders) ? compatProviders : [];
  // Drop entries the frontend deliberately doesn't render (see
  // COMPAT_FRONTEND_EXCLUDED comment).
  const list = raw.filter(p => !COMPAT_FRONTEND_EXCLUDED.has(p.id));
  // Splice virtual entries in right after their preferred neighbour (or
  // append if the neighbour isn't present). The result is a stable order
  // where every well-known compat provider sits in the same slot it did
  // when the list was hardcoded.
  for (const v of COMPAT_VIRTUAL_PROVIDERS) {
    if (list.some(p => p.id === v.id)) continue;
    const afterIdx = v.insertAfter ? list.findIndex(p => p.id === v.insertAfter) : -1;
    const insertAt = afterIdx >= 0 ? afterIdx + 1 : list.length;
    list.splice(insertAt, 0, v);
  }
  return list.map(p => {
    const built = COMPAT_BUILTIN_META[p.id] || {};
    return {
      id: p.id,
      label: p.displayName || p.id,
      keyField: p.keyField || null,
      source: p.source || 'static',
      icon: built.icon || 'globe',
      placeholder: built.placeholder || 'API key',
      connectMode: built.connectMode || null,
      blurb: built.blurb || `Custom OpenAI-compatible provider added via OE Admin (${p.baseUrl}).`,
    };
  });
}

// Exposed so settings.js can iterate the same merged list. Avoid re-deriving;
// loadProviderConfig() refreshes COMPAT_PROVIDER_META in place after every GET.
function getCompatProviderMeta() {
  return COMPAT_PROVIDER_META;
}
window.getCompatProviderMeta = getCompatProviderMeta;

function renderCompatProviderCards(cfg) {
  const host = $('providerCompatList');
  if (!host) return;
  host.innerHTML = COMPAT_PROVIDER_META.map(p => {
    const header = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="settings-section-title" style="margin:0"><i data-lucide="${p.icon}" style="width:14px;height:14px"></i> ${p.label}</div>
        <label class="provider-toggle"><input type="checkbox" id="providerToggle_${p.id}" ${cfg.enabledProviders?.[p.id] !== false ? 'checked' : ''} data-change-action="toggleProvider" data-change-args='${JSON.stringify([p.id, "$checked"]).replace(/'/g, "&#39;")}'><span class="provider-toggle-slider"></span></label>
      </div>`;
    if (p.connectMode === 'oauth') {
      return `
        <div class="provider-card" style="margin-bottom:16px" id="providerCard_${p.id}">
          ${header}
          <div id="providerBody_${p.id}">
            <div class="settings-section-desc" style="margin-bottom:8px">${p.blurb}</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button id="oauthConnect_${p.id}" data-action="connectOpenAIOAuth"
                style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600">Connect ChatGPT account</button>
              <button id="oauthDisconnect_${p.id}" data-action="disconnectOpenAIOAuth"
                style="display:none;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer">Disconnect</button>
              <button data-action="refreshOpenAIOAuthStatus"
                style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer">Check status</button>
              <button data-action="loadCompatProviderModels" data-args='${JSON.stringify([p.id, true]).replace(/'/g, "&#39;")}'
                style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer">Fetch models</button>
            </div>
            <div id="providerStatus_${p.id}" style="font-size:11px;color:var(--muted);margin-top:4px">Checking…</div>
            <div id="providerModels_${p.id}" style="font-size:11px;color:var(--muted);margin-top:6px;max-height:140px;overflow-y:auto"></div>
            <div id="providerPaste_${p.id}" style="display:none;margin-top:10px;padding:10px;background:var(--bg3);border:1px solid var(--border);border-radius:8px">
              <div style="font-size:11px;color:var(--muted);margin-bottom:6px">If the ChatGPT page ended on a "could not connect" screen (URL starts with <code>http://localhost:1455/auth/callback?code=…</code>), paste that full URL here.</div>
              <input type="text" id="providerPasteInput_${p.id}" placeholder="http://localhost:1455/auth/callback?code=…"
                style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;font-family:monospace">
              <div id="providerPasteMsg_${p.id}" style="font-size:11px;color:var(--muted);margin-top:6px"></div>
            </div>
          </div>
        </div>`;
    }
    return `
      <div class="provider-card" style="margin-bottom:16px" id="providerCard_${p.id}">
        ${header}
        <div id="providerBody_${p.id}">
          <div class="settings-section-desc" style="margin-bottom:8px">${p.blurb}</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="password" id="providerKey_${p.id}" placeholder="${p.placeholder}" autocomplete="new-password"
              style="flex:1;min-width:200px;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:12px">
            <button data-action="saveCompatProviderKey" data-args='${JSON.stringify([p.id, p.keyField]).replace(/'/g, "&#39;")}'
              style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600">Save</button>
            <button data-action="loadCompatProviderModels" data-args='${JSON.stringify([p.id]).replace(/'/g, "&#39;")}'
              style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer">Fetch models</button>
          </div>
          <div id="providerStatus_${p.id}" style="font-size:11px;color:var(--muted);margin-top:4px">${cfg[`${p.id}KeySet`] ? 'API key is set.' : 'No API key configured.'}</div>
          <div id="providerModels_${p.id}" style="font-size:11px;color:var(--muted);margin-top:6px;max-height:140px;overflow-y:auto"></div>
        </div>
      </div>`;
  }).join('');
  // Kick off an OAuth status refresh for every oauth-mode provider
  for (const p of COMPAT_PROVIDER_META) {
    if (p.connectMode === 'oauth') refreshOpenAIOAuthStatus().catch(() => {});
  }
  if (window.lucide?.createIcons) window.lucide.createIcons();
}

async function saveCompatProviderKey(providerId, keyField) {
  const key = $(`providerKey_${providerId}`)?.value.trim();
  if (!key) { showToast('Enter an API key'); return; }
  try {
    await postJson('/api/provider-config', { [keyField]: key, enabledProviders: { [providerId]: true } });
    $(`providerKey_${providerId}`).value = '';
    $(`providerStatus_${providerId}`).textContent = 'API key is set.';
    showToast(`${providerId} key saved`);
    loadCompatProviderModels(providerId).catch(() => {});
    _enableAndSync(providerId);
  } catch (e) { showToast(e.message || 'Failed to save key'); }
}

async function loadCompatProviderModels(providerId, refresh = false) {
  const box = $(`providerModels_${providerId}`);
  if (box) box.textContent = 'Loading models…';
  try {
    const models = await fetch(`/api/provider-models/${providerId}${refresh ? '?refresh=1' : ''}`).then(r => r.json());
    if (!Array.isArray(models) || models.length === 0) {
      if (box) box.textContent = 'No models returned. Check that the API key is valid.';
      return;
    }
    if (box) {
      box.innerHTML = `<div style="color:var(--muted);margin-bottom:4px">${models.length} model${models.length === 1 ? '' : 's'} available:</div>`
        + models.slice(0, 50).map(m => {
          const caps = [];
          if (m.supportsVision) caps.push('vision');
          if (m.supportsImageGeneration) caps.push('image gen');
          const meta = [
            ...(m.contextLen ? [`${m.contextLen.toLocaleString()} ctx`] : []),
            ...caps,
          ];
          return `<div style="font-family:monospace;color:var(--text)">${escHtml(m.id)}${meta.length ? ` <span style="color:var(--muted)">(${escHtml(meta.join(', '))})</span>` : ''}</div>`;
        }).join('')
        + (models.length > 50 ? `<div style="color:var(--muted);margin-top:4px">…and ${models.length - 50} more</div>` : '');
    }
    // Stash the list so the agent model picker can use it
    window._compatProviderModels = window._compatProviderModels || {};
    window._compatProviderModels[providerId] = models;
    renderModelBrowser?.(); renderAgentModelRows?.(); refreshSkillExecutionModelSelects?.();
    if (typeof checkEmptyState === 'function') checkEmptyState();
  } catch (e) {
    if (box) box.textContent = `Error: ${e.message}`;
  }
}

async function loadProviderConfig() {
  try {
    const cfg = await fetch('/api/provider-config').then(r => r.json());
    // Refresh the runtime compat provider list FIRST so renderCompatProviderCards
    // and the model picker (via settings.js) see the latest set, including any
    // providers added at runtime via oe-admin's add_provider tool.
    COMPAT_PROVIDER_META = buildCompatProviderMeta(cfg.compatProviders);
    $('providerAnthropicStatus').textContent  = cfg.anthropicKeySet  ? 'API key is set.' : 'No API key configured.';
    $('providerFireworksStatus').textContent  = cfg.fireworksKeySet  ? 'API key is set.' : 'No API key configured.';
    $('providerGrokStatus').textContent       = cfg.grokKeySet       ? 'API key is set (chat + image + video).' : 'No API key configured.';

    $('providerOllamaKeyStatus').textContent  = cfg.ollamaKeySet     ? 'API key is set.' : '';
    $('providerLmstudioKeyStatus').textContent = cfg.lmstudioKeySet  ? 'API key is set.' : '';
    // Cloud Ollama URL is fixed server-side — no input to populate.
    $('providerLmstudioUrl').value = cfg.lmstudioUrl ?? '';
    if ($('providerOllamaLocalUrl'))    $('providerOllamaLocalUrl').value = cfg.ollamaLocalUrl ?? '';
    if ($('providerOllamaLocalKeyStatus')) $('providerOllamaLocalKeyStatus').textContent = cfg.ollamaLocalKeySet ? 'API key is set.' : '';
    if ($('providerOpenrouterStatus')) $('providerOpenrouterStatus').textContent = cfg.openrouterKeySet ? 'API key is set.' : 'No API key configured.';
    $('providerTtsStatus').textContent = cfg.ttsKeySet ? 'TTS configured.' : '';
    $('providerTtsUrl').value   = cfg.ttsApiUrl ?? '';
    $('providerTtsModel').value = cfg.ttsModel  ?? '';
    $('providerTtsVoice').value = cfg.ttsVoice  ?? '';
    _ttsConfigured = !!cfg.ttsKeySet;
    if ($('providerTtsProvider')) $('providerTtsProvider').value = cfg.ttsProvider ?? 'openai';
    if ($('providerElevenlabsStatus')) $('providerElevenlabsStatus').textContent = cfg.elevenlabsKeySet ? 'ElevenLabs key is set.' : '';
    // Seed the ElevenLabs pace slider from server-reported elevenlabsSpeed
    // (default 0.85). The slider lives inside providerTtsFields_elevenlabs, so
    // updateTtsProviderFields() shows it only when ElevenLabs is selected.
    {
      const elPace = $('providerElevenlabsPace'), elPaceLbl = $('providerElevenlabsPaceValue');
      const sp = Number.isFinite(cfg.elevenlabsSpeed) ? cfg.elevenlabsSpeed : 0.85;
      if (elPace) elPace.value = sp;
      if (elPaceLbl) elPaceLbl.textContent = Number(sp).toFixed(2) + '×';
    }

    // Piper local-service detection. piperAvailable comes from the server's
    // GET /api/provider-config probe of 127.0.0.1:5151. Update the Piper
    // field block's status line + install-button visibility before we
    // call updateTtsProviderFields() (which only handles show/hide of the
    // whole block by provider).
    const piperStatus      = $('providerPiperStatus');
    const piperInstallBtn  = $('providerPiperInstallBtn');
    const piperUninstallBtn = $('providerPiperUninstallBtn');
    if (piperStatus && piperInstallBtn) {
      const piperVoicesWrap = $('providerPiperVoices');
      const piperFirstWrap  = $('providerPiperFirstVoiceWrap');
      const piperPaceWrap   = $('providerPiperPaceWrap');
      if (cfg.piperAvailable) {
        piperStatus.textContent = 'Piper is running on 127.0.0.1:5151 — no further setup needed.';
        piperStatus.style.color = 'var(--success, #4caf50)';
        piperInstallBtn.style.display = 'none';
        if (piperUninstallBtn) piperUninstallBtn.style.display = '';
        if (piperFirstWrap) piperFirstWrap.style.display = 'none';
        if (piperPaceWrap) piperPaceWrap.style.display = 'flex';
        // Seed slider from server-reported piperLengthScale (defaults to 1.1).
        const paceSlider = $('providerPiperPace');
        const paceLabel  = $('providerPiperPaceValue');
        if (paceSlider && Number.isFinite(cfg.piperLengthScale)) {
          paceSlider.value = cfg.piperLengthScale;
          if (paceLabel) paceLabel.textContent = Number(cfg.piperLengthScale).toFixed(2) + '×';
        }
        window.renderPiperVoiceCatalog?.();
      } else {
        piperStatus.textContent = 'Piper is not installed on this server. Install it locally (~80 MB download, no API key).';
        piperStatus.style.color = 'var(--muted)';
        piperInstallBtn.style.display = '';
        if (piperUninstallBtn) piperUninstallBtn.style.display = 'none';
        if (piperVoicesWrap) piperVoicesWrap.style.display = 'none';
        if (piperPaceWrap) piperPaceWrap.style.display = 'none';
        if (piperFirstWrap) piperFirstWrap.style.display = 'flex';
        window.populatePiperFirstVoiceDropdown?.();
      }
    }

    // Same shape as Piper — kittenttsAvailable from /api/provider-config
    // toggles the install/uninstall buttons + status line in the kittentts
    // field block.
    const kittenttsStatus      = $('providerKittenttsStatus');
    const kittenttsInstallBtn  = $('providerKittenttsInstallBtn');
    const kittenttsUninstallBtn = $('providerKittenttsUninstallBtn');
    if (kittenttsStatus && kittenttsInstallBtn) {
      if (cfg.kittenttsInstalled) {
        kittenttsInstallBtn.style.display = 'none';
        if (kittenttsUninstallBtn) kittenttsUninstallBtn.style.display = '';
        if (cfg.kittenttsAvailable) {
          kittenttsStatus.textContent = 'KittenTTS is installed and running on 127.0.0.1:5153.';
          kittenttsStatus.style.color = 'var(--success, #4caf50)';
        } else {
          kittenttsStatus.textContent = 'KittenTTS is installed but not running. Select KittenTTS above and click Save to start it.';
          kittenttsStatus.style.color = 'var(--muted)';
        }
      } else {
        kittenttsStatus.textContent = 'KittenTTS is not installed on this server. Install it locally (~50 MB, CPU only, no API key).';
        kittenttsStatus.style.color = 'var(--muted)';
        kittenttsInstallBtn.style.display = '';
        if (kittenttsUninstallBtn) kittenttsUninstallBtn.style.display = 'none';
      }
    }

    // Pocket TTS — same shape. pocketTtsAvailable toggles install/uninstall +
    // shows the cloned-voice upload UI only once the service is running.
    const pocketStatus       = $('providerPocketTtsStatus');
    const pocketInstallBtn   = $('providerPocketTtsInstallBtn');
    const pocketUninstallBtn = $('providerPocketTtsUninstallBtn');
    const pocketUploadBtn    = $('providerPocketTtsUploadBtn');
    if (pocketStatus && pocketInstallBtn) {
      if (cfg.pocketTtsInstalled) {
        pocketInstallBtn.style.display = 'none';
        if (pocketUninstallBtn) pocketUninstallBtn.style.display = '';
        if (pocketUploadBtn) pocketUploadBtn.style.display = '';
        if (cfg.pocketTtsAvailable) {
          pocketStatus.textContent = 'Pocket TTS is installed and running on 127.0.0.1:5155 — upload a voice clip below to clone it.';
          pocketStatus.style.color = 'var(--success, #4caf50)';
        } else {
          pocketStatus.textContent = 'Pocket TTS is installed but not running. Select Pocket TTS above and click Save to start it.';
          pocketStatus.style.color = 'var(--muted)';
        }
      } else {
        pocketStatus.textContent = 'Pocket TTS is not installed on this server. Install it locally (~400 MB, CPU only, no API key).';
        pocketStatus.style.color = 'var(--muted)';
        pocketInstallBtn.style.display = '';
        if (pocketUninstallBtn) pocketUninstallBtn.style.display = 'none';
        if (pocketUploadBtn) pocketUploadBtn.style.display = 'none';
      }
    }

    // STT mode dropdown — Remote API vs Local Faster-Whisper. Mode is
    // persisted as cfg.sttMode; remote URL/Key/Model and local install
    // state live independently so the user can switch between them
    // without losing the other's settings.
    const sttModeSel = $('providerSttMode');
    if (sttModeSel) sttModeSel.value = cfg.sttMode === 'local' ? 'local' : 'remote';
    const remoteFields = $('providerSttFields_remote');
    const localFields  = $('providerSttFields_local');
    if (remoteFields) remoteFields.style.display = sttModeSel?.value === 'remote' ? '' : 'none';
    if (localFields)  localFields.style.display  = sttModeSel?.value === 'local'  ? '' : 'none';

    // Faster-Whisper sub-state inside the Local section. Picker is ALWAYS
    // visible so the user can switch profiles even after install; when FW
    // is installed we pre-select the current profile + relabel the install
    // button to "Switch profile". Picker stays hidden via CSS until the user
    // picks an option that differs from what's already running.
    const fwStatus       = $('providerFwStatus');
    const fwPicker       = $('providerFwPicker');
    const fwUninstallBtn = $('providerFwUninstallBtn');
    const fwProfileSel   = $('providerFwProfile');
    const fwInstallBtn   = $('providerFwInstallBtn');
    if (fwStatus) {
      // Install state comes from the PERSISTED flag (fasterWhisperInstalled),
      // not the live probe — so a transient probe miss during cold-start /
      // restart (model load takes up to ~15 s) doesn't claim "not installed"
      // and prompt a needless reinstall. The probe (fasterWhisperAvailable)
      // only distinguishes "running now" from "installed but not responding".
      const fwInstalled = cfg.fasterWhisperInstalled || cfg.fasterWhisperAvailable;
      window._fwInstalledProfile = fwInstalled ? cfg.fasterWhisperProfile : null;
      if (fwInstalled) {
        const profile = cfg.fasterWhisperProfile || '?';
        if (cfg.fasterWhisperAvailable) {
          fwStatus.textContent = `Faster-Whisper is running on 127.0.0.1:5154 (${profile} profile). Pick a different profile below to switch.`;
          fwStatus.style.color = 'var(--success, #4caf50)';
        } else {
          fwStatus.textContent = `Faster-Whisper is installed (${profile} profile) but not responding yet — it may still be loading the model. Reload in a moment.`;
          fwStatus.style.color = 'var(--warning, #e0a030)';
        }
        if (fwPicker) fwPicker.style.display = 'flex';
        if (fwUninstallBtn) fwUninstallBtn.style.display = '';
        // Pre-select the currently-running profile so the user sees its info
        // card and can compare before switching.
        if (fwProfileSel && (cfg.fasterWhisperProfile === 'cpu' || cfg.fasterWhisperProfile === 'cuda')) {
          fwProfileSel.value = cfg.fasterWhisperProfile;
          window.onFwProfileChange?.();
        }
        // Populate + show the GPU pin selector (cuda profile + multi-GPU only).
        window._populateFwGpuPin?.(cfg);
      } else {
        fwStatus.textContent = 'Faster-Whisper is not installed.';
        fwStatus.style.color = 'var(--muted)';
        if (fwPicker) fwPicker.style.display = 'flex';
        if (fwUninstallBtn) fwUninstallBtn.style.display = 'none';
        // Reset the dropdown so the user picks fresh.
        if (fwProfileSel) fwProfileSel.value = '';
        window.onFwProfileChange?.();
        const gpuWrap = $('providerFwGpuWrap');
        if (gpuWrap) gpuWrap.style.display = 'none';
      }
    }

    // Gate provider <option>s by runtime availability. Every TTS branch
    // shells out to ffmpeg (resample to 16 kHz / encode to MP3), so if
    // ffmpeg is missing on the server we disable the whole dropdown and
    // surface a one-shot install hint. Otherwise each option is disabled
    // only when its own service/key is missing.
    window.updateTtsProviderAvailability?.(cfg);

    // Render only the input fields relevant to the selected TTS provider.
    window.updateTtsProviderFields?.();

    if ($('providerSttUrl')) {
      $('providerSttStatus').textContent = cfg.sttKeySet ? 'STT configured.' : '';
      $('providerSttUrl').value   = cfg.sttApiUrl ?? '';
      $('providerSttModel').value = cfg.sttModel  ?? '';
    }

    // Render the dynamic OpenAI-compat provider cards and auto-load their
    // model lists for any provider that has a key configured. Card rendering
    // is admin/owner-only — non-priv users can't reach the Providers tab, and
    // populating its (hidden) DOM here would create duplicate IDs that collide
    // with the Profile-tab AI Provider Logins surface.
    const _isPrivCfg = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
    if (_isPrivCfg) renderCompatProviderCards(cfg);
    for (const p of COMPAT_PROVIDER_META) {
      // openai-oauth has a static model list (no API key needed) — always load it
      // so admins can whitelist Codex models for users before anyone has connected,
      // and so users granted the OAuth provider see those models in pickers.
      if (cfg[`${p.id}KeySet`] || p.id === 'openai-oauth') loadCompatProviderModels(p.id).catch(() => {});
    }

    if (cfg.openrouterKeySet && typeof loadOpenRouterModels === 'function') loadOpenRouterModels().then(() => { renderModelBrowser?.(); renderAgentModelRows?.(); refreshSkillExecutionModelSelects?.(); });
    // Apply provider toggle states (default: all enabled)
    _enabledProviders = cfg.enabledProviders ?? {};
    // Mirror the *KeySet booleans into a global so _hasAnyProviderConfigured()
    // can spot providers whose keys were set directly in config.json without the
    // UI flipping the toggle. Compat providers expose <id>KeySet too.
    _providerKeyStatus = {
      anthropic:    !!cfg.anthropicKeySet,
      fireworks:    !!cfg.fireworksKeySet,
      grok:         !!cfg.grokKeySet,
      ollama:       !!cfg.ollamaKeySet,
      'ollama-local': !!cfg.ollamaLocalKeySet,
      lmstudio:     !!cfg.lmstudioKeySet,
      openrouter:   !!cfg.openrouterKeySet,
      ...Object.fromEntries(COMPAT_PROVIDER_META.map(p => [p.id, !!cfg[`${p.id}KeySet`]])),
    };
    const allProviders = ['anthropic', 'fireworks', 'ollama', 'ollama-local', 'grok', 'lmstudio', 'openrouter', 'tts', ...COMPAT_PROVIDER_META.map(p => p.id)];
    for (const prov of allProviders) {
      const enabled = _enabledProviders[prov] !== false;
      const toggle = $(`providerToggle_${prov}`);
      if (toggle) toggle.checked = enabled;
      const card = $(`providerCard_${prov}`);
      if (card) card.classList.toggle('disabled', !enabled);
      const body = $(`providerBody_${prov}`);
      if (body) body.style.display = enabled ? '' : 'none';
    }

    if (typeof checkEmptyState === 'function') checkEmptyState();
  } catch {}
  // Home Assistant lives behind its own admin-only endpoint; populates only
  // for owner/admin sessions, silent 401 for everyone else.
  loadProviderHa().catch(() => {});
}

async function toggleProvider(provider, enabled) {
  _enabledProviders[provider] = enabled;
  const card = $(`providerCard_${provider}`);
  if (card) card.classList.toggle('disabled', !enabled);
  const body = $(`providerBody_${provider}`);
  if (body) body.style.display = enabled ? '' : 'none';
  try {
    await fetch('/api/provider-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabledProviders: { [provider]: enabled } }),
    });
    // Re-render model lists so agent dropdowns reflect the change
    if (typeof renderModelBrowser === 'function') renderModelBrowser();
    if (typeof renderAgentModelRows === 'function') renderAgentModelRows();
    if (typeof renderCortexModelRows === 'function') renderCortexModelRows();
    if (typeof checkEmptyState === 'function') checkEmptyState();
    showToast(`${enabled ? 'Enabled' : 'Disabled'} ${provider}`);
  } catch { showToast('Failed to update provider'); }
}

function isProviderEnabled(provider) {
  return _enabledProviders[provider] !== false;
}

// Saving a key implies the admin wants to use that provider, so auto-flip its
// enabled toggle on. Otherwise the saved key sits there with the toggle off,
// the model picker stays empty, and the welcome card never advances. Mirrors
// the local _enabledProviders state too so checkEmptyState sees it instantly.
function _enableAndSync(provider) {
  _enabledProviders[provider] = true;
  const toggle = $(`providerToggle_${provider}`);
  if (toggle) toggle.checked = true;
  const card = $(`providerCard_${provider}`);
  if (card) card.classList.remove('disabled');
  const body = $(`providerBody_${provider}`);
  if (body) body.style.display = '';
  if (typeof checkEmptyState === 'function') checkEmptyState();
}

async function saveProviderFireworksKey() {
  const key = $('providerFireworksKey').value.trim();
  if (!key) { showToast('Enter an API key'); return; }
  try {
    await postJson('/api/provider-config', { fireworksApiKey: key, enabledProviders: { fireworks: true } });
    $('providerFireworksKey').value = '';
    $('providerFireworksStatus').textContent = 'API key is set.';
    showToast('Fireworks key saved');
    _enableAndSync('fireworks');
  } catch (e) { showToast(e.message || 'Failed to save key'); }
}


async function saveProviderGrokKey() {
  const key = $('providerGrokKey').value.trim();
  if (!key) { showToast('Enter an API key'); return; }
  try {
    await postJson('/api/provider-config', { grokApiKey: key, enabledProviders: { grok: true } });
    $('providerGrokKey').value = '';
    $('providerGrokStatus').textContent = 'Inference key is set.';
    showToast('Grok key saved');
    _enableAndSync('grok');
    // Auto-refresh the model list so the picker stops showing yesterday's
    // hardcoded fallback the moment a new key lands. Best-effort; the manual
    // "Fetch models" button next to Save is the user-visible way to retry.
    refreshGrokModels().catch(() => {});
  } catch (e) { showToast(e.message || 'Failed to save key'); }
}

// Manual model refresh — same shape as loadCompatProviderModels but routes
// through /api/grok-models since Grok doesn't ride the OpenAI-compat /models
// endpoint. Renders the result into providerGrokModels for parity with the
// other provider cards.
async function refreshGrokModels() {
  const box = $('providerGrokModels');
  if (box) box.textContent = 'Loading models…';
  try {
    await loadGrokModels();
    const models = getGrokModels();
    if (!models.length) {
      if (box) box.textContent = 'No models returned. Check that the inference key is valid.';
      return;
    }
    if (box) {
      box.innerHTML = `<div style="color:var(--muted);margin-bottom:4px">${models.length} model${models.length === 1 ? '' : 's'} available:</div>`
        + models.slice(0, 50).map(m => `<div style="font-family:monospace;color:var(--text)">${escHtml(m.name)}${m.displayName && m.displayName !== m.name ? ` <span style="color:var(--muted)">(${escHtml(m.displayName)})</span>` : ''}</div>`).join('')
        + (models.length > 50 ? `<div style="color:var(--muted);margin-top:4px">…and ${models.length - 50} more</div>` : '');
    }
    renderModelBrowser?.(); renderAgentModelRows?.();
  } catch (e) {
    if (box) box.textContent = `Error: ${e.message}`;
  }
}


async function saveProviderOpenRouterKey() {
  const key = $('providerOpenrouterKey').value.trim();
  if (!key) { showToast('Enter an API key'); return; }
  try {
    await postJson('/api/provider-config', { openrouterApiKey: key, enabledProviders: { openrouter: true } });
    $('providerOpenrouterKey').value = '';
    $('providerOpenrouterStatus').textContent = 'API key is set.';
    showToast('OpenRouter key saved');
    await loadOpenRouterModels();
    renderModelBrowser?.();
    renderAgentModelRows?.();
    _enableAndSync('openrouter');
  } catch (e) { showToast(e.message || 'Failed to save key'); }
}

async function saveProviderAnthropicKey() {
  const key = $('providerAnthropicKey').value.trim();
  if (!key) { showToast('Enter an API key'); return; }
  try {
    await postJson('/api/provider-config', { anthropicApiKey: key, enabledProviders: { anthropic: true } });
    $('providerAnthropicKey').value = '';
    $('providerAnthropicStatus').textContent = 'API key is set.';
    showToast('Anthropic key saved');
    _enableAndSync('anthropic');
  } catch (e) { showToast(e.message || 'Failed to save key'); }
}

async function saveProvider(provider) {
  // Ollama (cloud) is key-only — the endpoint is fixed server-side to
  // https://ollama.com/api, so there's no URL input to read.
  const sel = {
    'ollama':       { urlEl: null,                     keyEl: 'providerOllamaKey',      statusEl: 'providerOllamaKeyStatus',      urlField: null,             keyField: 'ollamaApiKey',      label: 'Ollama (cloud)' },
    'ollama-local': { urlEl: 'providerOllamaLocalUrl', keyEl: 'providerOllamaLocalKey', statusEl: 'providerOllamaLocalKeyStatus', urlField: 'ollamaLocalUrl', keyField: 'ollamaLocalApiKey', label: 'Ollama (local)' },
    'lmstudio':     { urlEl: 'providerLmstudioUrl',    keyEl: 'providerLmstudioKey',    statusEl: 'providerLmstudioKeyStatus',    urlField: 'lmstudioUrl',    keyField: 'lmstudioApiKey',    label: 'LM Studio' },
  }[provider];
  if (!sel) return;
  const url = sel.urlEl ? $(sel.urlEl).value.trim() : null;
  const key = $(sel.keyEl).value.trim();
  if (sel.urlEl && !url) { showToast('Enter a URL'); return; }
  if (!sel.urlEl && !key) { showToast('Enter an API key'); return; }
  const body = {
    ...(sel.urlField && url ? { [sel.urlField]: url } : {}),
    ...(key ? { [sel.keyField]: key } : {}),
    enabledProviders: { [provider]: true },
  };
  try {
    const r = await fetch('/api/provider-config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    if (!r.ok) { showToast(`Save failed (${r.status})`); return; }
    if (key) { $(sel.keyEl).value = ''; }
    showToast(`${sel.label} saved`);
    // Re-pull authoritative state so the URL field shows the persisted value,
    // status lines reflect whether a key is now set, and the welcome card
    // re-evaluates against the freshly-stored enabledProviders.
    await loadProviderConfig();
    if (provider === 'lmstudio' || provider === 'ollama-local') {
      await loadModels();
      renderModelBrowser?.();
      renderAgentModelRows?.();
      refreshSkillExecutionModelSelects?.();
    }
  } catch { showToast('Failed to save'); }
}

async function saveProviderMicrosoftCreds() {
  const clientId     = $('providerMsClientId')?.value.trim();
  const clientSecret = $('providerMsClientSecret')?.value.trim();
  const tenant       = $('providerMsTenant')?.value.trim() || 'common';
  if (!clientId || !clientSecret) { showToast('Client ID and Secret are required'); return; }
  try {
    await postJson('/api/provider-config', { msClientId: clientId, msClientSecret: clientSecret, msTenant: tenant });
    $('providerMsClientId').value = '';
    $('providerMsClientSecret').value = '';
    $('providerMicrosoftStatus').textContent = 'Credentials saved. Use "+ Connect Microsoft" in Profile to link accounts.';
    showToast('Microsoft credentials saved');
  } catch (e) { showToast(e.message || 'Failed to save credentials'); }
}

// Show the input block for the currently-selected TTS provider, hide the
// rest. Wired up via data-change-action on #providerTtsProvider in
// index.html and called once on initial config load to sync with the
// persisted ttsProvider value. Provider ids must match the field div
// suffixes: providerTtsFields_<provider>.
function updateTtsProviderFields() {
  const sel = document.getElementById('providerTtsProvider');
  if (!sel) return;
  const active = sel.value || 'openai';
  for (const p of ['openai', 'elevenlabs', 'piper', 'kittentts', 'pocket-tts']) {
    const block = document.getElementById(`providerTtsFields_${p}`);
    if (block) block.style.display = (p === active) ? '' : 'none';
  }
  if (active === 'pocket-tts') window.renderPocketVoices?.();
}
window.updateTtsProviderFields = updateTtsProviderFields;

// Disable provider <option>s whose runtime deps aren't satisfied, and
// annotate each label with the reason (so users see "Piper (local …) —
// install required" rather than a silently-broken pick). Called after
// /api/provider-config returns with ffmpegAvailable + piperAvailable +
// key-set flags. Pure DOM mutation — safe to call multiple times.
function updateTtsProviderAvailability(cfg) {
  const sel = document.getElementById('providerTtsProvider');
  if (!sel) return;
  const opts = {
    openai:     sel.querySelector('option[value="openai"]'),
    elevenlabs: sel.querySelector('option[value="elevenlabs"]'),
    piper:      sel.querySelector('option[value="piper"]'),
    kittentts:  sel.querySelector('option[value="kittentts"]'),
    'pocket-tts': sel.querySelector('option[value="pocket-tts"]'),
  };
  // Cache the original labels so we can re-decorate on every refresh
  // without compounding " — reason" suffixes.
  for (const [k, opt] of Object.entries(opts)) {
    if (opt && !opt.dataset.baseLabel) opt.dataset.baseLabel = opt.textContent;
  }
  const ffmpeg = !!cfg.ffmpegAvailable;
  const reasons = {
    openai:     !ffmpeg ? 'ffmpeg not installed' : (!cfg.ttsKeySet ? 'API key not set' : ''),
    elevenlabs: !ffmpeg ? 'ffmpeg not installed' : (!cfg.elevenlabsKeySet ? 'API key not set' : ''),
    // Selectable when INSTALLED (not necessarily running) — saving the provider
    // starts its service. piperAvailable/etc. (running) drive only the status line.
    piper:      !ffmpeg ? 'ffmpeg not installed' : (!cfg.piperInstalled ? 'install needed' : ''),
    kittentts:  !ffmpeg ? 'ffmpeg not installed' : (!cfg.kittenttsInstalled ? 'install needed' : ''),
    'pocket-tts': !ffmpeg ? 'ffmpeg not installed' : (!cfg.pocketTtsInstalled ? 'install needed' : ''),
  };
  // For locally-installable providers (piper, kittentts) the user MUST be able
  // to select the option in order to reach the install button inside the
  // provider's field block — so we never `disabled` them just for "service not
  // running". ffmpeg-missing is the one fatal condition that disables every
  // option (no TTS branch works without it). For remote providers, missing
  // key still leaves the fields panel reachable (the key input is in there).
  const fatal = (reason) => reason === 'ffmpeg not installed';
  for (const [k, opt] of Object.entries(opts)) {
    if (!opt) continue;
    const reason = reasons[k];
    opt.disabled    = fatal(reason);
    opt.textContent = reason ? `${opt.dataset.baseLabel} — ${reason}` : opt.dataset.baseLabel;
  }
  // Top-of-section banner — shown only when ffmpeg itself is missing,
  // since that breaks every provider and the per-option suffixes get
  // visually noisy without a headline. Keyed inside #providerBody_tts
  // so toggling the whole TTS card hides it too.
  const body = document.getElementById('providerBody_tts');
  if (body) {
    let banner = document.getElementById('providerTtsFfmpegBanner');
    if (!ffmpeg) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'providerTtsFfmpegBanner';
        banner.style.cssText = 'background:var(--bg3);border:1px solid var(--warning,#d97706);color:var(--warning,#d97706);border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:8px';
        body.insertBefore(banner, body.firstChild);
      }
      banner.textContent = 'ffmpeg is not installed on this server. All TTS providers need it for audio encoding. Install with: sudo apt install ffmpeg (or your distro equivalent), then restart OE.';
    } else if (banner) {
      banner.remove();
    }
  }
}
window.updateTtsProviderAvailability = updateTtsProviderAvailability;

// Install-Piper button handler. Posts to /api/provider-config/install-piper,
// reads the SSE response, appends progress lines into the log pane.
// On `done` with ok=true, refreshes provider config so the status line
// flips to "running" and the button hides.
async function installPiper() {
  const btn = document.getElementById('providerPiperInstallBtn');
  const log = document.getElementById('providerPiperLog');
  const status = document.getElementById('providerPiperStatus');
  if (!btn || !log) return;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  log.style.display = '';
  log.textContent = '';
  if (status) status.textContent = 'Installing Piper…';

  // Initial-voice picker: blank value falls back to the script's default
  // (en_US-libritts_r-medium); non-blank values must match an entry in the
  // server-side PIPER_VOICE_CATALOG or the route returns 400.
  const firstVoice = document.getElementById('providerPiperFirstVoice')?.value || '';
  let resp;
  try {
    resp = await fetch('/api/provider-config/install-piper', {
      method: 'POST',
      headers: firstVoice ? { 'Content-Type': 'application/json' } : undefined,
      body:    firstVoice ? JSON.stringify({ voice: firstVoice }) : undefined,
    });
  } catch (e) {
    log.textContent += `\n[error] ${e.message}\n`;
    btn.disabled = false;
    btn.textContent = 'Install Piper (~80 MB)';
    return;
  }
  if (!resp.ok || !resp.body) {
    log.textContent += `\n[error] HTTP ${resp.status}\n`;
    btn.disabled = false;
    btn.textContent = 'Install Piper (~80 MB)';
    return;
  }

  // Parse SSE: events look like "event: log\ndata: {...}\n\n".
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let success = false;
  // A mid-stream drop (server crash, network blip) rejects reader.read().
  // Without this guard the rejection is unhandled and the button stays stuck on
  // "Installing…"; catch it and fall through to the failure branch below.
  try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // Each event is terminated by a blank line.
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let evName = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) evName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      let data = {};
      try { data = JSON.parse(dataLines.join('\n')); } catch {}
      if (evName === 'log') {
        log.textContent += data.line + '\n';
        log.scrollTop = log.scrollHeight;
      } else if (evName === 'done') {
        success = !!data.ok;
        log.textContent += `\n[exit ${data.code ?? '?'}]${data.error ? ' ' + data.error : ''}\n`;
      }
    }
  }
  } catch (e) {
    log.textContent += `\n[error] stream interrupted: ${e.message}\n`;
  }

  if (success) {
    if (status) {
      status.textContent = 'Piper installed and running.';
      status.style.color = 'var(--success, #4caf50)';
    }
    btn.style.display = 'none';
    showToast?.('Piper installed');
    // Re-fetch config so piperAvailable + UI block stay in sync if the
    // user navigates away and comes back.
    loadProviderConfig();
  } else {
    btn.disabled = false;
    btn.textContent = 'Retry install';
    if (status) status.textContent = 'Piper install failed — see log below.';
  }
}
window.installPiper = installPiper;

// Render the Piper voice catalog under the Piper provider section. Called
// after the service-availability probe reports piperAvailable=true (the
// catalog only makes sense once the service is up). Cross-references
// /api/tts/piper/catalog (downloadable) against /api/tts/piper/voices
// (installed) and produces one row per catalog entry.
async function renderPiperVoiceCatalog() {
  const wrap = document.getElementById('providerPiperVoices');
  const list = document.getElementById('providerPiperVoicesList');
  if (!wrap || !list) return;
  try {
    const [catRes, instRes] = await Promise.all([
      fetch('/api/tts/piper/catalog'),
      fetch('/api/tts/piper/voices'),
    ]);
    const { voices: catalog } = await catRes.json();
    const { voices: installed = [] } = await instRes.json();
    const installedIds = new Set(installed.map(v => v.id));
    wrap.style.display = '';
    list.innerHTML = '';
    for (const v of catalog) {
      const isInstalled = installedIds.has(v.id);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:6px';
      const meta = document.createElement('div');
      meta.style.cssText = 'flex:1;min-width:0';
      const tags = [v.size_mb ? `${v.size_mb} MB` : null, v.multi_speaker ? 'multi-speaker' : null].filter(Boolean).join(' · ');
      meta.innerHTML =
        `<div style="font-weight:600;color:var(--text);font-size:12px">${v.label}</div>` +
        `<div style="color:var(--muted);font-size:10px;font-family:ui-monospace,monospace">${v.id}${tags ? ' · ' + tags : ''}</div>`;
      const action = document.createElement('div');
      action.style.cssText = 'flex-shrink:0';
      if (isInstalled) {
        action.innerHTML = '<span style="color:var(--success,#4caf50);font-weight:600;font-size:11px">✓ Installed</span>';
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.action = 'installPiperVoice';
        btn.dataset.args = JSON.stringify([v.id]);
        btn.style.cssText = 'background:var(--accent);border:none;color:#fff;border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600';
        btn.textContent = 'Download';
        action.appendChild(btn);
      }
      row.appendChild(meta);
      row.appendChild(action);
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = `<div style="color:var(--danger,#e53935);font-size:11px;padding:6px">Failed to load voice catalog: ${e.message}</div>`;
  }
}
window.renderPiperVoiceCatalog = renderPiperVoiceCatalog;

// Populate the install-time voice picker (shown only when Piper isn't yet
// installed). Idempotent — uses sel._populated to skip re-fetching once we
// have a list. Defaults to libritts_r so the bare "Install Piper" flow
// stays backward-compatible with pre-multivoice installs.
async function populatePiperFirstVoiceDropdown() {
  const sel = document.getElementById('providerPiperFirstVoice');
  if (!sel || sel._populated) return;
  try {
    const r = await fetch('/api/tts/piper/catalog');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { voices } = await r.json();
    sel.innerHTML = voices.map(v =>
      `<option value="${v.id}" ${v.id === 'en_US-libritts_r-medium' ? 'selected' : ''}>${v.label}${v.size_mb ? ` — ${v.size_mb} MB` : ''}</option>`
    ).join('');
    sel._populated = true;
  } catch (e) {
    // Hide the picker so the install button still works with default libritts_r.
    const wrap = document.getElementById('providerPiperFirstVoiceWrap');
    if (wrap) wrap.style.display = 'none';
  }
}
window.populatePiperFirstVoiceDropdown = populatePiperFirstVoiceDropdown;

// Speech-pace slider handlers. `input` fires every notch while dragging
// (live label update, no network), `change` fires on release (one POST).
// We could debounce input + POST, but Piper synth happens per-utterance so
// users hear the new pace on the next TTS call regardless — release-only
// save matches that mental model + saves a stack of cancelled requests.
window.onPiperPaceInput = function (ev) {
  const v = Number(ev.target.value);
  const label = document.getElementById('providerPiperPaceValue');
  if (label && Number.isFinite(v)) label.textContent = v.toFixed(2) + '×';
};
window.onPiperPaceChange = async function (ev) {
  const v = Number(ev.target.value);
  if (!Number.isFinite(v)) return;
  try {
    await fetch('/api/provider-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ piperLengthScale: v }),
    });
  } catch (e) {
    showToast?.(`Failed to save speech pace: ${e.message}`);
  }
};
// ElevenLabs pace — voice_settings.speed (0.7-1.2). Mirrors the Piper pair:
// live-update the label on input, save on release.
window.onElevenlabsPaceInput = function (ev) {
  const v = Number(ev.target.value);
  const label = document.getElementById('providerElevenlabsPaceValue');
  if (label && Number.isFinite(v)) label.textContent = v.toFixed(2) + '×';
};
window.onElevenlabsPaceChange = async function (ev) {
  const v = Number(ev.target.value);
  if (!Number.isFinite(v)) return;
  try {
    await fetch('/api/provider-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elevenlabsSpeed: v }),
    });
  } catch (e) {
    showToast?.(`Failed to save ElevenLabs pace: ${e.message}`);
  }
};

// Download a single Piper voice. The multivoice server hot-picks up new
// files on the next /voices request, so no service restart is needed —
// once this resolves we re-render the catalog and the row flips to ✓ Installed.
async function installPiperVoice(voiceId) {
  const list = document.getElementById('providerPiperVoicesList');
  const btn  = list?.querySelector(`button[data-args='${CSS.escape(JSON.stringify([voiceId]))}']`)
            ?? list?.querySelector(`button[data-args*='${voiceId}']`);
  const origText = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; btn.style.background = 'var(--muted)'; }
  try {
    const r = await fetch('/api/provider-config/install-piper-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: voiceId }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    await renderPiperVoiceCatalog();
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      btn.style.background = 'var(--danger,#e53935)';
      btn.title = `Failed: ${e.message}`;
    }
  }
}
window.installPiperVoice = installPiperVoice;

// Install-KittenTTS button handler. Identical SSE-streaming shape as installPiper
// — different endpoint + UI element ids. Two installers stayed parallel rather
// than abstracted into one helper because each handles its own status/log
// elements; pulling them apart would obscure how the UI updates land.
async function installKittentts() {
  const btn = document.getElementById('providerKittenttsInstallBtn');
  const log = document.getElementById('providerKittenttsLog');
  const status = document.getElementById('providerKittenttsStatus');
  if (!btn || !log) return;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  log.style.display = '';
  log.textContent = '';
  if (status) status.textContent = 'Installing KittenTTS…';

  let resp;
  try {
    resp = await fetch('/api/provider-config/install-kittentts', { method: 'POST' });
  } catch (e) {
    log.textContent += `\n[error] ${e.message}\n`;
    btn.disabled = false;
    btn.textContent = 'Install KittenTTS (~50 MB)';
    return;
  }
  if (!resp.ok || !resp.body) {
    log.textContent += `\n[error] HTTP ${resp.status}\n`;
    btn.disabled = false;
    btn.textContent = 'Install KittenTTS (~50 MB)';
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let success = false;
  // Guard against a mid-stream drop rejecting reader.read() (would otherwise
  // leave the button stuck on "Installing…"); fall through to the failure branch.
  try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let evName = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) evName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      let data = {};
      try { data = JSON.parse(dataLines.join('\n')); } catch {}
      if (evName === 'log') {
        log.textContent += data.line + '\n';
        log.scrollTop = log.scrollHeight;
      } else if (evName === 'done') {
        success = !!data.ok;
        log.textContent += `\n[exit ${data.code ?? '?'}]${data.error ? ' ' + data.error : ''}\n`;
      }
    }
  }
  } catch (e) {
    log.textContent += `\n[error] stream interrupted: ${e.message}\n`;
  }

  if (success) {
    if (status) {
      status.textContent = 'KittenTTS installed. Click Save to start it.';
      status.style.color = 'var(--muted)';
    }
    btn.style.display = 'none';
    showToast?.('KittenTTS installed — Save to start it');
    await loadProviderConfig();
    const ksel = document.getElementById('providerTtsProvider');
    if (ksel) { ksel.value = 'kittentts'; updateTtsProviderFields(); }
  } else {
    btn.disabled = false;
    btn.textContent = 'Retry install';
    if (status) status.textContent = 'KittenTTS install failed — see log below.';
  }
}
window.installKittentts = installKittentts;

// ── Pocket TTS install (SSE-streamed, mirrors installKittentts) ──────────────
async function installPocketTts() {
  const btn = document.getElementById('providerPocketTtsInstallBtn');
  const log = document.getElementById('providerPocketTtsLog');
  const status = document.getElementById('providerPocketTtsStatus');
  if (!btn || !log) return;
  btn.disabled = true;
  btn.textContent = 'Installing…';
  log.style.display = '';
  log.textContent = '';
  if (status) status.textContent = 'Installing Pocket TTS… (first run pulls CPU torch — a few minutes)';

  let resp;
  try {
    resp = await fetch('/api/provider-config/install-pocket-tts', { method: 'POST' });
  } catch (e) {
    log.textContent += `\n[error] ${e.message}\n`;
    btn.disabled = false; btn.textContent = 'Install Pocket TTS (~400 MB)'; return;
  }
  if (!resp.ok || !resp.body) {
    log.textContent += `\n[error] HTTP ${resp.status}\n`;
    btn.disabled = false; btn.textContent = 'Install Pocket TTS (~400 MB)'; return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', success = false;
  // Guard against a mid-stream drop rejecting reader.read() (would otherwise
  // leave the button stuck on "Installing…"); fall through to the failure branch.
  try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let evName = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) evName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      let data = {};
      try { data = JSON.parse(dataLines.join('\n')); } catch {}
      if (evName === 'log') { log.textContent += data.line + '\n'; log.scrollTop = log.scrollHeight; }
      else if (evName === 'done') { success = !!data.ok; log.textContent += `\n[exit ${data.code ?? '?'}]${data.error ? ' ' + data.error : ''}\n`; }
    }
  }
  } catch (e) {
    log.textContent += `\n[error] stream interrupted: ${e.message}\n`;
  }
  if (success) {
    if (status) { status.textContent = 'Pocket TTS installed. Click Save to start it.'; status.style.color = 'var(--muted)'; }
    btn.style.display = 'none';
    showToast?.('Pocket TTS installed — Save to start it');
    await loadProviderConfig();
    // loadProviderConfig() resets the dropdown to the saved provider; keep the
    // user on Pocket TTS so they can just hit Save to start it.
    const psel = document.getElementById('providerTtsProvider');
    if (psel) { psel.value = 'pocket-tts'; updateTtsProviderFields(); }
  } else {
    btn.disabled = false; btn.textContent = 'Retry install';
    if (status) status.textContent = 'Pocket TTS install failed — see log below.';
  }
}
window.installPocketTts = installPocketTts;

function uninstallPocketTts() { return _uninstallLocalTts('pocket-tts', 'Pocket TTS', 'providerPocketTts'); }
window.uninstallPocketTts = uninstallPocketTts;

// ── Pocket TTS: upload + name a voice clip (zero-shot clone) ──────────────────
async function uploadPocketVoice() {
  const nameEl = document.getElementById('providerPocketTtsVoiceName');
  const consentEl = document.getElementById('providerPocketTtsConsent');
  const label = (nameEl?.value || '').trim();
  if (!label) { showToast?.('Enter a voice name first'); return; }
  if (!consentEl?.checked) { showToast?.('Please confirm you have consent to clone this voice'); return; }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.wav,.mp3,audio/wav,audio/mpeg';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { showToast?.('Clip too large (5 MB max — ~15-20s is plenty)'); return; }
    const buf = await file.arrayBuffer();
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    let resp;
    try {
      resp = await fetch('/api/voice-refs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wav_b64: b64, label, transcript: '' }),
      });
    } catch (e) { showToast?.('Upload failed: ' + e.message); return; }
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.id) {
      showToast?.(`"${label}" added — select it as the device voice or save it as the default.`);
      if (nameEl) nameEl.value = '';
      if (consentEl) consentEl.checked = false;
      renderPocketVoices();
    } else {
      showToast?.('Upload failed: ' + (data.error || `HTTP ${resp.status}`));
    }
  };
  input.click();
}
window.uploadPocketVoice = uploadPocketVoice;

async function renderPocketVoices() {
  const host = document.getElementById('providerPocketTtsVoices');
  if (!host) return;
  let refs = [];
  try { const r = await fetch('/api/voice-refs'); refs = (await r.json()).refs || []; } catch {}
  if (!refs.length) { host.innerHTML = '<div style="font-size:11px;color:var(--muted)">No cloned voices yet — upload a clip below.</div>'; return; }
  host.innerHTML = '<div style="font-size:11px;color:var(--muted);margin-bottom:4px">Cloned voices (assign per-device in Settings → Devices, or save one as the default):</div>' +
    refs.map(r => {
      const dur = (typeof r.duration_s === 'number') ? r.duration_s.toFixed(1) + 's' : '';
      const label = (r.label || r.id).replace(/[<>&]/g, '');
      return `<div style="display:flex;gap:8px;align-items:center;font-size:12px;padding:3px 0">
      <span style="flex:1">${label}${dur ? `<span style="color:var(--muted)"> · ${dur}</span>` : ''}</span>
      <button type="button" onclick="deletePocketVoice('${r.id}')" title="Delete this cloned voice" style="background:transparent;border:1px solid var(--border);color:var(--red,#e05c5c);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer">Delete</button>
    </div>`;
    }).join('');
}
window.renderPocketVoices = renderPocketVoices;

async function deletePocketVoice(id) {
  if (!confirm('Delete this cloned voice? It will be removed from this server and from any voice device using it.')) return;
  try {
    const r = await fetch('/api/voice-refs/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) { const d = await r.json().catch(() => ({})); showToast?.('Delete failed: ' + (d.error || `HTTP ${r.status}`)); return; }
    showToast?.('Voice deleted');
    renderPocketVoices();
  } catch (e) { showToast?.('Delete failed: ' + e.message); }
}
window.deletePocketVoice = deletePocketVoice;

// Shared uninstall handler for the local-TTS providers. Each provider has its
// own status/log/button DOM ids but the flow is identical: confirm, POST,
// show the captured output, refresh the panel. Unlike install (which streams
// via SSE because it can take ~60 s on slow networks), uninstall runs in
// well under a second so a single POST + JSON response is plenty.
//
// `which` is the provider key as it appears in the route + DOM ids:
// 'piper' or 'kittentts'.
async function _uninstallLocalTts(which, displayName, idPrefix) {
  // Default ID convention: provider<CapitalizedSlug>{Uninstall,Log,Status}Btn.
  // Hyphenated slugs (e.g. "faster-whisper") don't capitalize cleanly so
  // callers can pass an explicit idPrefix that maps to the actual DOM ids.
  const prefix = idPrefix || `provider${which[0].toUpperCase()}${which.slice(1)}`;
  const btn    = document.getElementById(`${prefix}UninstallBtn`);
  const log    = document.getElementById(`${prefix}Log`);
  const status = document.getElementById(`${prefix}Status`);
  if (!btn) return;
  if (!confirm(`Uninstall ${displayName}? This stops the local service and removes the venv + model files. You can reinstall later from this same panel.`)) return;

  btn.disabled = true;
  btn.textContent = 'Uninstalling…';
  if (log) { log.style.display = ''; log.textContent = ''; }
  if (status) status.textContent = `Uninstalling ${displayName}…`;

  let resp;
  try {
    resp = await fetch(`/api/provider-config/uninstall-${which}`, { method: 'POST' });
  } catch (e) {
    if (log) log.textContent += `\n[error] ${e.message}\n`;
    btn.disabled = false;
    btn.textContent = 'Uninstall';
    return;
  }
  let data = {};
  try { data = await resp.json(); } catch {}
  if (log) log.textContent = (data.output || '') + (data.error ? `\n[error] ${data.error}\n` : '');

  if (resp.ok && data.ok) {
    showToast?.(`${displayName} uninstalled`);
    // loadProviderConfig flips the UI back into "install needed" state and
    // re-runs updateTtsProviderAvailability so the dropdown label reverts.
    loadProviderConfig();
  } else {
    btn.disabled = false;
    btn.textContent = 'Retry uninstall';
    if (status) status.textContent = `${displayName} uninstall failed — see log below.`;
  }
}

function uninstallPiper()     { return _uninstallLocalTts('piper',     'Piper'); }
function uninstallKittentts() { return _uninstallLocalTts('kittentts', 'KittenTTS'); }
window.uninstallPiper     = uninstallPiper;
window.uninstallKittentts = uninstallKittentts;

// Install-Faster-Whisper handler. Same SSE-stream shape as installPiper; the
// extra wrinkle is the CPU/GPU profile arg from data-args and auto-pointing
// OE's STT config at the local server when the install succeeds (no API key
// required — local server ignores the Authorization header but Express's
// /api/stt insists on one being non-empty, so we send "local").
async function installFasterWhisper(profile /* 'cpu' | 'cuda' */) {
  const btn    = document.getElementById('providerFwInstallBtn');
  const log    = document.getElementById('providerFwLog');
  const status = document.getElementById('providerFwStatus');
  if (!log) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Installing…';
    btn.style.cursor = 'not-allowed';
    btn.style.background = 'var(--muted)';
  }
  log.style.display = '';
  log.textContent = '';
  if (status) status.textContent = `Installing Faster-Whisper (${profile})…`;

  let resp;
  try {
    resp = await fetch('/api/provider-config/install-faster-whisper', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
  } catch (e) {
    log.textContent += `\n[error] ${e.message}\n`;
    if (btn) { btn.disabled = false; btn.textContent = 'Save & install'; btn.style.background = 'var(--accent)'; btn.style.cursor = 'pointer'; }
    return;
  }
  if (!resp.ok || !resp.body) {
    log.textContent += `\n[error] HTTP ${resp.status}\n`;
    if (btn) { btn.disabled = false; btn.textContent = 'Save & install'; btn.style.background = 'var(--accent)'; btn.style.cursor = 'pointer'; }
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let success = false;
  // Guard against a mid-stream drop rejecting reader.read() (would otherwise
  // leave the button stuck on "Installing…"); fall through to the failure branch.
  try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let evName = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) evName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      let data = {};
      try { data = JSON.parse(dataLines.join('\n')); } catch {}
      if (evName === 'log') {
        log.textContent += data.line + '\n';
        log.scrollTop = log.scrollHeight;
      } else if (evName === 'done') {
        success = !!data.ok;
        log.textContent += `\n[exit ${data.code ?? '?'}]${data.error ? ' ' + data.error : ''}\n`;
      }
    }
  }
  } catch (e) {
    log.textContent += `\n[error] stream interrupted: ${e.message}\n`;
  }

  if (success) {
    // Flip OE into Local STT mode. We persist the mode separately from the
    // remote sttApiUrl/Key/Model so the user's saved API credentials survive
    // a swap to Local (and back). /api/stt picks based on cfg.sttMode.
    try {
      await fetch('/api/provider-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sttMode: 'local' }),
      });
    } catch (e) {
      console.warn('[faster-whisper] sttMode update failed:', e);
    }
    if (status) {
      status.textContent = `Faster-Whisper installed (${profile}). STT is now routing locally.`;
      status.style.color = 'var(--success, #4caf50)';
    }
    showToast?.(`Faster-Whisper installed (${profile})`);
    loadProviderConfig();
  } else {
    if (status) status.textContent = `Faster-Whisper install failed — see log below.`;
    const pickBtn = document.getElementById('providerFwInstallBtn');
    if (pickBtn) {
      pickBtn.disabled = false;
      pickBtn.textContent = 'Save & install';
      pickBtn.style.background = 'var(--accent)';
      pickBtn.style.cursor = 'pointer';
    }
  }
}
window.installFasterWhisper = installFasterWhisper;

function uninstallFasterWhisper() { return _uninstallLocalTts('faster-whisper', 'Faster-Whisper', 'providerFw'); }
window.uninstallFasterWhisper = uninstallFasterWhisper;

// STT mode dropdown handler. Toggling between Remote API and Local
// Faster-Whisper persists the choice immediately so /api/stt routes
// correctly without waiting for a Save click. Local mode only takes effect
// for STT when the service is actually running — the route falls back to
// returning errors if cfg.sttMode='local' but the service is down.
window.updateSttModeFields = async function () {
  const mode = document.getElementById('providerSttMode')?.value || 'remote';
  const remoteFields = document.getElementById('providerSttFields_remote');
  const localFields  = document.getElementById('providerSttFields_local');
  if (remoteFields) remoteFields.style.display = mode === 'remote' ? '' : 'none';
  if (localFields)  localFields.style.display  = mode === 'local'  ? '' : 'none';
  try {
    await fetch('/api/provider-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sttMode: mode }),
    });
  } catch (e) {
    showToast?.(`Failed to save STT mode: ${e.message}`);
  }
};

// Profile dropdown inside the Local section. Toggles the matching info
// card, relabels the install button based on the current install state
// (Install / Switch / Already running), and disables it when there's
// nothing to do.
window.onFwProfileChange = function () {
  const profile = document.getElementById('providerFwProfile')?.value || '';
  const cpuInfo = document.getElementById('providerFwInfoCpu');
  const gpuInfo = document.getElementById('providerFwInfoGpu');
  const btn     = document.getElementById('providerFwInstallBtn');
  if (cpuInfo) cpuInfo.style.display = profile === 'cpu'  ? '' : 'none';
  if (gpuInfo) gpuInfo.style.display = profile === 'cuda' ? '' : 'none';
  if (!btn) return;
  const installed = window._fwInstalledProfile || null; // set by loadProviderConfig
  if (profile && installed && profile === installed) {
    btn.textContent = 'Already running';
    btn.disabled = true;
    btn.style.background = 'var(--muted)';
    btn.style.cursor = 'not-allowed';
  } else if (profile === 'cpu' || profile === 'cuda') {
    btn.textContent = installed
      ? `Switch to ${profile === 'cpu' ? 'CPU' : 'GPU'}`
      : 'Save & install';
    btn.disabled = false;
    btn.style.background = 'var(--accent)';
    btn.style.cursor = 'pointer';
  } else {
    btn.textContent = 'Save & install';
    btn.disabled = true;
    btn.style.background = 'var(--muted)';
    btn.style.cursor = 'not-allowed';
  }
};

// Save&install handler — reads profile dropdown and hands off to the
// existing installFasterWhisper (which streams SSE log into providerFwLog).
window.installFwFromPicker = function () {
  const profile = document.getElementById('providerFwProfile')?.value;
  if (profile !== 'cpu' && profile !== 'cuda') return;
  return window.installFasterWhisper(profile);
};

// Populate the "pin STT to a GPU" selector. Only meaningful on the cuda profile
// with more than one NVIDIA GPU — otherwise the wrapper stays hidden. Called by
// loadProviderConfig with the provider-config payload (for the current pin).
window._populateFwGpuPin = async function (cfg) {
  const wrap = document.getElementById('providerFwGpuWrap');
  const sel  = document.getElementById('providerFwGpuPin');
  if (!wrap || !sel) return;
  // Only the GPU profile can be pinned to a device.
  if (cfg?.fasterWhisperProfile !== 'cuda') { wrap.style.display = 'none'; return; }
  let gpus = [];
  try {
    const r = await fetch('/api/hardware/gpus').then(x => x.json());
    gpus = Array.isArray(r?.gpus) ? r.gpus : [];
  } catch { gpus = []; }
  // No selector for single-GPU (or no-GPU) boxes — nothing to choose.
  if (gpus.length < 2) { wrap.style.display = 'none'; return; }
  const current = Number.isInteger(cfg?.fasterWhisperGpuId) ? cfg.fasterWhisperGpuId : '';
  const fmtFree = g => (g.memFreeMiB != null ? ` — ${(g.memFreeMiB / 1024).toFixed(1)} GB free` : '');
  sel.innerHTML =
    `<option value="">Auto (CUDA default — usually GPU 0)</option>` +
    gpus.map(g => `<option value="${escHtml(g.index)}">GPU ${escHtml(g.index)}: ${escHtml(g.name)}${fmtFree(g)}</option>`).join('');
  sel.value = current === '' ? '' : String(current);
  wrap.style.display = 'flex';
};

// Persist the chosen GPU pin. Server rewrites the systemd unit + restarts STT.
window.onFwGpuPinChange = async function () {
  const sel = document.getElementById('providerFwGpuPin');
  const status = document.getElementById('providerFwGpuStatus');
  if (!sel) return;
  const raw = sel.value;
  const gpuId = raw === '' ? null : Number(raw);
  if (status) status.textContent = 'Applying… restarting STT service.';
  try {
    const res = await fetch('/api/provider-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fasterWhisperGpuId: gpuId }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`);
    showToast(gpuId === null ? 'STT GPU set to auto' : `STT pinned to GPU ${gpuId}`);
    if (status) status.textContent = 'Pin Faster-Whisper to a specific GPU. Changing this restarts the STT service (~15 s).';
  } catch (e) {
    showToast(`Failed to set STT GPU: ${e.message}`);
    if (status) status.textContent = `Failed: ${e.message}`;
  }
};

async function saveProviderTts() {
  const provider = $('providerTtsProvider')?.value || 'openai';
  const url   = $('providerTtsUrl').value.trim();
  const key   = $('providerTtsKey').value.trim();
  const model = $('providerTtsModel').value.trim();
  const voice = $('providerTtsVoice').value.trim();
  const elKey = $('providerElevenlabsKey')?.value.trim() || '';
  const elModel = $('providerElevenlabsModel')?.value.trim() || '';
  const body = {
    ttsProvider: provider,
    ...(url && { ttsApiUrl: url }),
    ...(key && { ttsApiKey: key }),
    ttsModel: model, ttsVoice: voice,
    ...(elKey && { elevenlabsApiKey: elKey }),
    ...(elModel && { elevenlabsModel: elModel }),
  };
  try {
    await postJson('/api/provider-config', body);
    if (key) { $('providerTtsKey').value = ''; }
    if (elKey && $('providerElevenlabsKey')) { $('providerElevenlabsKey').value = ''; }
    $('providerTtsStatus').textContent = `Saved (provider: ${provider}).`;
    if (elKey && $('providerElevenlabsStatus')) $('providerElevenlabsStatus').textContent = 'ElevenLabs key is set.';
    _ttsConfigured = !!(key || url || elKey);
    showToast('TTS settings saved');
  } catch (e) { showToast(e.message || 'Failed to save TTS settings'); }
}

async function loadProviderHa() {
  const urlEl = $('providerHaUrl');
  if (!urlEl) return;
  try {
    const r = await fetch('/api/home-assistant');
    if (!r.ok) return; // non-admin users get 401 silently; nothing to populate
    const cfg = await r.json();
    urlEl.value = cfg.url || '';
    if ($('providerHaAllowSelfSigned')) $('providerHaAllowSelfSigned').checked = !!cfg.allowSelfSigned;
    if ($('providerHaConnected')) {
      $('providerHaConnected').textContent = cfg.configured ? 'Connected' : '';
      $('providerHaConnected').style.color = cfg.configured ? 'var(--success, #4caf50)' : 'var(--muted)';
    }
    if ($('providerHaToken')) {
      $('providerHaToken').placeholder = cfg.hasToken
        ? '••••••••  (saved — leave blank to keep)'
        : 'Long-Lived Access Token';
    }
    if ($('providerHaStatus')) $('providerHaStatus').textContent = '';
  } catch {}
}

async function saveProviderHa() {
  const url   = $('providerHaUrl').value.trim();
  const token = $('providerHaToken').value;
  const allowSelfSigned = !!$('providerHaAllowSelfSigned')?.checked;
  const status = $('providerHaStatus');
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saving…'; }
  try {
    const r = await fetch('/api/home-assistant', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token, allowSelfSigned }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      if (status) { status.style.color = 'var(--red, #e05c5c)'; status.textContent = e.error || 'Save failed.'; }
      return;
    }
    if ($('providerHaToken')) $('providerHaToken').value = '';
    if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saved.'; }
    showToast('Home Assistant settings saved');
    await loadProviderHa();
  } catch {
    if (status) { status.style.color = 'var(--red, #e05c5c)'; status.textContent = 'Network error.'; }
  }
}

async function testProviderHa() {
  const url   = $('providerHaUrl').value.trim();
  const token = $('providerHaToken').value;
  const allowSelfSigned = !!$('providerHaAllowSelfSigned')?.checked;
  const status = $('providerHaStatus');
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Testing…'; }
  try {
    const r = await fetch('/api/home-assistant/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, token, allowSelfSigned }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.ok) {
      if (status) { status.style.color = 'var(--success, #4caf50)'; status.textContent = j.message || 'Connected.'; }
    } else {
      if (status) { status.style.color = 'var(--red, #e05c5c)'; status.textContent = j.error || 'Connection failed.'; }
    }
  } catch (e) {
    if (status) { status.style.color = 'var(--red, #e05c5c)'; status.textContent = 'Network error.'; }
  }
}

async function clearProviderHa() {
  if (!confirm('Disconnect Home Assistant? Saved URL and token will be removed.')) return;
  const status = $('providerHaStatus');
  try {
    await fetch('/api/home-assistant', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: '', token: '' }),
    });
    if ($('providerHaUrl')) $('providerHaUrl').value = '';
    if ($('providerHaToken')) $('providerHaToken').value = '';
    if ($('providerHaAllowSelfSigned')) $('providerHaAllowSelfSigned').checked = false;
    if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Disconnected.'; }
    showToast('Home Assistant disconnected');
    await loadProviderHa();
  } catch {
    if (status) { status.style.color = 'var(--red, #e05c5c)'; status.textContent = 'Failed to disconnect.'; }
  }
}

async function saveProviderStt() {
  const url   = $('providerSttUrl').value.trim();
  const key   = $('providerSttKey').value.trim();
  const model = $('providerSttModel').value.trim();
  const body = {
    ...(url && { sttApiUrl: url }),
    ...(key && { sttApiKey: key }),
    sttModel: model,
  };
  try {
    await postJson('/api/provider-config', body);
    if (key) { $('providerSttKey').value = ''; }
    $('providerSttStatus').textContent = key ? 'STT configured.' : (url ? 'Settings saved.' : '');
    showToast('STT settings saved');
  } catch (e) { showToast(e.message || 'Failed to save STT settings'); }
}
window.saveProviderStt = saveProviderStt;
