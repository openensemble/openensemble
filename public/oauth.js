// ── OAuth / Connected Accounts ────────────────────────────────────────────────
async function loadOAuthStatus() {
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
    const [accounts, oauthStatus, providerCfg] = await Promise.all([
      fetch('/api/email-accounts', { cache: 'no-store' }).then(r => r.json()).catch(() => []),
      fetch('/api/oauth/status', {}).then(r => r.json()).catch(() => ({})),
      fetch('/api/provider-config').then(r => r.json()).catch(() => ({})),
    ]);
    const { gcal, gmailHealth } = oauthStatus;
    const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
    const msCreds = providerCfg.msClientIdSet && providerCfg.msClientSecretSet;
    const providerIcon = p => p === 'gmail' ? icon('mail', 13) : p === 'microsoft' ? icon('building', 13) : icon('globe', 13);
    const accountRows = (accounts ?? []).map(a => {
      const health = a.provider === 'gmail' ? (gmailHealth ?? {})[a.id] : null;
      const needsReconnect = health === 'expired' || health === 'no_refresh' || health === 'missing' || health === 'error';
      const statusBadge = health === 'ok' ? '<span style="font-size:10px;color:var(--green,#4caf50);margin-left:4px">Connected</span>'
        : needsReconnect ? '<span style="font-size:10px;color:var(--red,#e05c5c);margin-left:4px">Token expired</span>'
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
          ${a.provider === 'gmail' ? `<button onclick="reconnectGmail('${escHtml(a.id)}')" style="background:${needsReconnect ? 'var(--accent)' : 'none'};border:1px solid ${needsReconnect ? 'transparent' : 'var(--border)'};color:${needsReconnect ? '#fff' : 'var(--text)'};border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;font-weight:${needsReconnect ? '600' : '400'}">${needsReconnect ? 'Reconnect' : 'Re-auth'}</button>` : ''}
          <button onclick="renameEmailAccount('${escHtml(a.id)}','${escHtml(a.label.replace(/'/g,"\\'"))}')" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">Rename</button>
          <button onclick="deleteEmailAccount('${escHtml(a.id)}')" style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">Delete</button>
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
            ? `<button onclick="disconnectGoogle('gcal')" style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">Disconnect</button>`
            : `<button onclick="connectGoogle('gcal')" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;font-weight:600">Connect</button>`}
        </div>
      </div>`;
    const hasAnyAccount = (accounts ?? []).length > 0 || gcal;
    el.innerHTML = `
      ${accountRows}
      ${gcalRow}
      ${!hasAnyAccount ? '<div style="color:var(--muted);font-size:12px;padding:4px 0">No accounts connected.</div>' : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
        <button onclick="connectGoogle('gmail')" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600">+ Connect Gmail</button>
        <button onclick="connectMicrosoft()" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600">+ Connect Microsoft</button>
        ${isPriv && msCreds ? `<button onclick="clearMicrosoftCreds()" style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer">Clear MS credentials</button>` : ''}
        <button onclick="showAddImapModal()" style="background:none;border:1px solid var(--accent);color:var(--accent);border-radius:6px;padding:5px 12px;font-size:11px;cursor:pointer;font-weight:600">+ Add IMAP…</button>
      </div>`;
  } catch { el.innerHTML = '<div style="color:var(--muted);font-size:12px">Not available</div>'; }
}

async function connectMicrosoft() {
  // Check if credentials are already configured
  try {
    const cfg = await fetch('/api/provider-config').then(r => r.json()).catch(() => ({}));
    if (cfg.msClientIdSet && cfg.msClientSecretSet) {
      await _doMicrosoftOAuth();
    } else {
      const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
      if (!isPriv) {
        alert('Microsoft connection is not configured yet. Ask your OpenEnsemble admin to set it up.');
        return;
      }
      showMicrosoftCredsModal();
    }
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
      <div style="font-size:11px;color:var(--muted);line-height:1.5">Register an app at <strong>portal.azure.com → App registrations</strong> with redirect URI <code style="background:var(--bg3);padding:1px 4px;border-radius:3px">http://localhost:3737/api/oauth/microsoft/callback</code> and scopes <code style="background:var(--bg3);padding:1px 4px;border-radius:3px">Mail.Read offline_access</code>, then paste the credentials below.</div>
      <input id="msCrClientId" placeholder="Application (client) ID" autocomplete="off"
        style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <input id="msCrClientSecret" type="password" placeholder="Client secret value" autocomplete="new-password"
        style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <input id="msCrTenant" placeholder="Tenant (leave blank for personal + work accounts)" autocomplete="off"
        style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <div id="msCrError" style="color:var(--red,#e05c5c);font-size:11px;display:none"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="$('msCredsModal').remove()" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer">Cancel</button>
        <button id="msCrSubmitBtn" onclick="submitMicrosoftCreds()" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600">Save &amp; Connect</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

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
    await fetch('/api/provider-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msClientId: clientId, msClientSecret: clientSecret, msTenant: tenant }),
    });
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
  window.open(res.url, '_blank', 'noopener');
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
    note: 'Office 365 / Exchange Online disabled basic passwords in 2022. You need an <strong>app password</strong>: go to <em>account.microsoft.com → Security → Advanced security options → App passwords</em> and generate one, then use it here instead of your normal password.',
  },
  'gmail': {
    host: 'imap.gmail.com', port: 993, tls: true,
    note: 'Gmail requires an <strong>app password</strong> (not your regular password). Go to <em>myaccount.google.com → Security → 2-Step Verification → App passwords</em> to generate one.',
  },
  'yahoo': { host: 'imap.mail.yahoo.com', port: 993, tls: true, note: 'Yahoo requires an app password. Go to <em>Yahoo Account Security → Generate app password</em>.' },
  'fastmail': { host: 'imap.fastmail.com', port: 993, tls: true, note: '' },
  'icloud': { host: 'imap.mail.me.com', port: 993, tls: true, note: 'iCloud requires an app-specific password from <em>appleid.apple.com → Sign-In and Security → App-Specific Passwords</em>.' },
  'custom': { host: '', port: 993, tls: true, note: '' },
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
        <select id="imapPreset" onchange="imapPresetChanged()" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
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
      <input id="imapPassword" type="password" placeholder="Password or app password" style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font-size:12px;color:var(--text);width:100%;box-sizing:border-box">
      <div id="imapError" style="color:var(--red,#e05c5c);font-size:11px;display:none"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="$('imapModal').remove()" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer">Cancel</button>
        <button onclick="submitImapAccount()" id="imapSubmitBtn" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600">Connect</button>
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
    const res = await fetch('/api/email-accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'imap', label, host, port, tls, username, password }),
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

async function reconnectGmail(accountId) {
  try {
    const res = await fetch(`/api/oauth/google/connect?service=gmail&accountId=${encodeURIComponent(accountId)}`);
    if (!res.ok) { alert('Failed to start re-authorization. Check server logs.'); return; }
    const { url } = await res.json();
    window.open(url, '_blank', 'noopener');
  } catch (e) { alert(`Error: ${e.message}`); }
}

async function connectGoogle(service) {
  try {
    let qs = `service=${service}`;
    // For Gmail, create a shell account first so each connection gets its own token file
    if (service === 'gmail') {
      const acct = await fetch('/api/email-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'gmail', label: 'Gmail' }),
      }).then(r => r.json());
      if (acct.error) { alert(`Error: ${acct.error}`); return; }
      qs += `&accountId=${encodeURIComponent(acct.id)}`;
    }
    const res = await fetch(`/api/oauth/google/connect?${qs}`, {});
    if (!res.ok) { alert('Failed to start authorization. Check server logs.'); return; }
    const { url } = await res.json();
    window.open(url, '_blank', 'noopener');
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
  if (!box || !input) return;
  box.style.display = 'block';
  input.value = '';
  input.focus();
  // Auto-submit the moment the user pastes something URL-shaped — no extra
  // click needed. The paste event fires before the input's value updates,
  // so read from the clipboard data directly.
  input.onpaste = (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    if (/[?&]code=/.test(text) && /[?&]state=/.test(text)) {
      e.preventDefault();
      input.value = text.trim();
      submitOpenAIPasteCallback();
    }
  };
  // Fallback: Enter to submit manually.
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitOpenAIPasteCallback(); } };
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

async function disconnectOpenAIOAuth() {
  if (!confirm('Disconnect your ChatGPT account? You will need to reconnect to use Codex OAuth models.')) return;
  try {
    await fetch('/api/oauth/openai', { method: 'DELETE' });
    refreshOpenAIOAuthStatus();
  } catch (e) { alert(`Error: ${e.message}`); }
}

async function refreshOpenAIOAuthStatus() {
  const box = document.getElementById('providerStatus_openai-oauth');
  if (!box) return;
  try {
    const s = await fetch('/api/oauth/openai/status').then(r => r.json());
    if (s.connected) {
      const plan = s.plan ? ` (${s.plan})` : '';
      const acct = s.accountId ? ` · account ${s.accountId.slice(0, 8)}…` : '';
      box.textContent = `Connected${plan}${acct}.`;
      // Load the static model list so the agent model picker shows Codex models
      loadCompatProviderModels('openai-oauth').catch(() => {});
    } else {
      box.textContent = 'Not connected.';
    }
  } catch { box.textContent = 'Status check failed.'; }
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
  const models = allAvailableModels();
  const anthropicOpts = models.filter(m => m.provider === 'anthropic');
  const ollamaOpts    = models.filter(m => m.provider === 'ollama');
  const lmsOpts       = models.filter(m => m.provider === 'lmstudio');
  const currentVal    = currentModel && currentProvider ? `${currentModel}||${currentProvider}` : '';
  const mkOpt = m => {
    const val = `${m.name}||${m.provider}`;
    return `<option value="${escHtml(val)}" ${val === currentVal ? 'selected' : ''}>${escHtml(m.name)}</option>`;
  };
  row.innerHTML = `<select id="visionModelSelect" style="flex:1;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
    ${anthropicOpts.length ? `<optgroup label="Anthropic">${anthropicOpts.map(mkOpt).join('')}</optgroup>` : ''}
    ${ollamaOpts.length    ? `<optgroup label="Ollama">${ollamaOpts.map(mkOpt).join('')}</optgroup>`    : ''}
    ${lmsOpts.length       ? `<optgroup label="LM Studio">${lmsOpts.map(mkOpt).join('')}</optgroup>`   : ''}
  </select>
  <button onclick="saveVisionProvider()" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600">Save</button>`;
}

async function openSettingsDrawer(openIt = true) {
  if (openIt) toggleDrawer('drawerSettings', 'sbtnSettings');
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';

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
      if (fullCfg.claudeCodeDailyLimit)  $('claudeCodeDailyLimitInput').value  = fullCfg.claudeCodeDailyLimit;
      if (fullCfg.claudeCodeWeeklyLimit) $('claudeCodeWeeklyLimitInput').value = fullCfg.claudeCodeWeeklyLimit;
      if (fullCfg.sessionExpiryHours)    $('sessionExpiryInput').value          = fullCfg.sessionExpiryHours;
      const tog = $('stripThinkingToggle');
      if (tog) { tog.checked = fullCfg.stripThinkingTags !== false; setStripThinkingTrack(tog.checked); }
    }).catch(() => {});
    // Show admin-only system sections
    ['visionProviderRow','sessionExpiryRow','stripThinkingRow','claudeCodeLimitsRow','stab-backup','customModelRow'].forEach(id => {
      const el = $(id); if (el) el.style.display = '';
    });
  } else {
    // Hide admin-only sections for regular users
    ['visionProviderRow','sessionExpiryRow','stripThinkingRow','claudeCodeLimitsRow','stab-backup','customModelRow'].forEach(id => {
      const el = $(id); if (el) el.style.display = 'none';
    });
  }

  // Load models — needed by Agents, Plugins, and System tabs (runs in parallel with user management)
  try {
    // Block the initial render only on fast endpoints. Fireworks' listing API
    // is paged and can stall for 10-15s when the upstream is flaky — fire it
    // in the background and just re-render the model browser/agent rows when
    // it returns.
    await Promise.all([loadModels(), loadCortexConfig(), loadReasonRuntimeStatus(), loadPlanRuntimeStatus()]);
    renderModelBrowser(); renderAgentModelRows(); renderCortexModelRows(); renderPlanModelRows(); renderDrawersSettings();
    checkCortexHealth().then(renderCortexModelRows);
    loadFireworksModels().then(() => { renderModelBrowser?.(); renderAgentModelRows?.(); }).catch(() => {});
    loadAnthropicModels().then(() => { renderModelBrowser?.(); renderAgentModelRows?.(); }).catch(() => {});
    loadGrokModels().then(() => { renderModelBrowser?.(); renderAgentModelRows?.(); }).catch(() => {});
  } catch(e) {
    console.error('Failed to load models:', e);
  }

  loadSkillsList();
}

let _enabledProviders = {};

// Metadata for OpenAI-compatible cloud LLM providers. Adding a new provider
// is a one-line change: it auto-renders a card and wires up save + fetch-models.
const COMPAT_PROVIDER_META = [
  { id: 'openai',     label: 'OpenAI',        icon: 'sparkles',    placeholder: 'sk-…',              keyField: 'openaiApiKey',     blurb: 'API key for OpenAI models (GPT-5, GPT-4.1, o-series, etc.).' },
  { id: 'openai-oauth', label: 'OpenAI (ChatGPT login)', icon: 'log-in', connectMode: 'oauth',      blurb: 'Sign in with your ChatGPT Plus/Pro account to use Codex models via OAuth.' },
  { id: 'gemini',     label: 'Google Gemini', icon: 'gem',         placeholder: 'AIza…',             keyField: 'geminiApiKey',     blurb: 'API key for Google Gemini via the OpenAI-compat endpoint.' },
  { id: 'deepseek',   label: 'DeepSeek',      icon: 'brain',       placeholder: 'sk-…',              keyField: 'deepseekApiKey',   blurb: 'API key for DeepSeek (deepseek-chat, deepseek-reasoner).' },
  { id: 'mistral',    label: 'Mistral AI',    icon: 'wind',        placeholder: 'API key',           keyField: 'mistralApiKey',    blurb: 'API key for Mistral AI (Mistral Large, Codestral, etc.).' },
  { id: 'groq',       label: 'Groq',          icon: 'bolt',        placeholder: 'gsk_…',             keyField: 'groqApiKey',       blurb: 'API key for Groq ultra-fast inference (Llama, Mixtral, Qwen).' },
  { id: 'together',   label: 'Together AI',   icon: 'users',       placeholder: 'API key',           keyField: 'togetherApiKey',   blurb: 'API key for Together AI — hundreds of open-weight models.' },
  { id: 'perplexity', label: 'Perplexity',    icon: 'search',      placeholder: 'pplx-…',            keyField: 'perplexityApiKey', blurb: 'API key for Perplexity Sonar models (search-grounded).' },
  { id: 'zai',        label: 'Z.AI',          icon: 'zap',         placeholder: 'API key',           keyField: 'zaiApiKey',        blurb: 'API key for Z.AI (GLM-5.1, GLM-5V-Turbo — OpenAI-compatible).' },
];

function renderCompatProviderCards(cfg) {
  const host = $('providerCompatList');
  if (!host) return;
  host.innerHTML = COMPAT_PROVIDER_META.map(p => {
    const header = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="settings-section-title" style="margin:0"><i data-lucide="${p.icon}" style="width:14px;height:14px"></i> ${p.label}</div>
        <label class="provider-toggle"><input type="checkbox" id="providerToggle_${p.id}" ${cfg.enabledProviders?.[p.id] !== false ? 'checked' : ''} onchange="toggleProvider('${p.id}',this.checked)"><span class="provider-toggle-slider"></span></label>
      </div>`;
    if (p.connectMode === 'oauth') {
      return `
        <div class="provider-card" style="margin-bottom:16px" id="providerCard_${p.id}">
          ${header}
          <div id="providerBody_${p.id}">
            <div class="settings-section-desc" style="margin-bottom:8px">${p.blurb}</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <button onclick="connectOpenAIOAuth()"
                style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600">Connect ChatGPT account</button>
              <button onclick="disconnectOpenAIOAuth()"
                style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer">Disconnect</button>
              <button onclick="refreshOpenAIOAuthStatus()"
                style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 12px;font-size:12px;cursor:pointer">Check status</button>
            </div>
            <div id="providerStatus_${p.id}" style="font-size:11px;color:var(--muted);margin-top:4px">Checking…</div>
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
            <button onclick="saveCompatProviderKey('${p.id}','${p.keyField}')"
              style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:8px 14px;font-size:12px;cursor:pointer;font-weight:600">Save</button>
            <button onclick="loadCompatProviderModels('${p.id}')"
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
    await fetch('/api/provider-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [keyField]: key }),
    });
    $(`providerKey_${providerId}`).value = '';
    $(`providerStatus_${providerId}`).textContent = 'API key is set.';
    showToast(`${providerId} key saved`);
    loadCompatProviderModels(providerId).catch(() => {});
  } catch { showToast('Failed to save key'); }
}

async function loadCompatProviderModels(providerId) {
  const box = $(`providerModels_${providerId}`);
  if (box) box.textContent = 'Loading models…';
  try {
    const models = await fetch(`/api/provider-models/${providerId}`).then(r => r.json());
    if (!Array.isArray(models) || models.length === 0) {
      if (box) box.textContent = 'No models returned. Check that the API key is valid.';
      return;
    }
    if (box) {
      box.innerHTML = `<div style="color:var(--muted);margin-bottom:4px">${models.length} model${models.length === 1 ? '' : 's'} available:</div>`
        + models.slice(0, 50).map(m => `<div style="font-family:monospace;color:var(--text)">${m.id}${m.contextLen ? ` <span style="color:var(--muted)">(${m.contextLen.toLocaleString()} ctx)</span>` : ''}</div>`).join('')
        + (models.length > 50 ? `<div style="color:var(--muted);margin-top:4px">…and ${models.length - 50} more</div>` : '');
    }
    // Stash the list so the agent model picker can use it
    window._compatProviderModels = window._compatProviderModels || {};
    window._compatProviderModels[providerId] = models;
    renderModelBrowser?.(); renderAgentModelRows?.();
  } catch (e) {
    if (box) box.textContent = `Error: ${e.message}`;
  }
}

async function loadProviderConfig() {
  try {
    const cfg = await fetch('/api/provider-config').then(r => r.json());
    $('providerAnthropicStatus').textContent  = cfg.anthropicKeySet  ? 'API key is set.' : 'No API key configured.';
    $('providerFireworksStatus').textContent  = cfg.fireworksKeySet  ? 'API key is set.' : 'No API key configured.';
    $('providerGrokStatus').textContent       = cfg.grokKeySet       ? 'API key is set (chat + image + video).' : 'No API key configured.';

    $('providerOllamaKeyStatus').textContent  = cfg.ollamaKeySet     ? 'API key is set.' : '';
    $('providerLmstudioKeyStatus').textContent = cfg.lmstudioKeySet  ? 'API key is set.' : '';
    $('providerOllamaUrl').value   = cfg.ollamaUrl   ?? '';
    $('providerLmstudioUrl').value = cfg.lmstudioUrl ?? '';
    if ($('providerOllamaLocalUrl'))    $('providerOllamaLocalUrl').value = cfg.ollamaLocalUrl ?? '';
    if ($('providerOllamaLocalKeyStatus')) $('providerOllamaLocalKeyStatus').textContent = cfg.ollamaLocalKeySet ? 'API key is set.' : '';
    if ($('providerOpenrouterStatus')) $('providerOpenrouterStatus').textContent = cfg.openrouterKeySet ? 'API key is set.' : 'No API key configured.';
    $('providerTtsStatus').textContent = cfg.ttsKeySet ? 'TTS configured.' : '';
    $('providerTtsUrl').value   = cfg.ttsApiUrl ?? '';
    $('providerTtsModel').value = cfg.ttsModel  ?? '';
    $('providerTtsVoice').value = cfg.ttsVoice  ?? '';
    _ttsConfigured = !!cfg.ttsKeySet;

    // Render the dynamic OpenAI-compat provider cards and auto-load their
    // model lists for any provider that has a key configured.
    renderCompatProviderCards(cfg);
    for (const p of COMPAT_PROVIDER_META) {
      if (cfg[`${p.id}KeySet`]) loadCompatProviderModels(p.id).catch(() => {});
    }

    if (cfg.openrouterKeySet && typeof loadOpenRouterModels === 'function') loadOpenRouterModels().then(() => { renderModelBrowser?.(); renderAgentModelRows?.(); });
    // Apply provider toggle states (default: all enabled)
    _enabledProviders = cfg.enabledProviders ?? {};
    const allProviders = ['anthropic', 'fireworks', 'ollama', 'grok', 'lmstudio', 'openrouter', 'tts', ...COMPAT_PROVIDER_META.map(p => p.id)];
    for (const prov of allProviders) {
      const enabled = _enabledProviders[prov] !== false;
      const toggle = $(`providerToggle_${prov}`);
      if (toggle) toggle.checked = enabled;
      const card = $(`providerCard_${prov}`);
      if (card) card.classList.toggle('disabled', !enabled);
      const body = $(`providerBody_${prov}`);
      if (body) body.style.display = enabled ? '' : 'none';
    }
  } catch {}
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
    showToast(`${enabled ? 'Enabled' : 'Disabled'} ${provider}`);
  } catch { showToast('Failed to update provider'); }
}

function isProviderEnabled(provider) {
  return _enabledProviders[provider] !== false;
}

async function saveProviderFireworksKey() {
  const key = $('providerFireworksKey').value.trim();
  if (!key) { showToast('Enter an API key'); return; }
  try {
    await fetch('/api/provider-config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fireworksApiKey: key }) });
    $('providerFireworksKey').value = '';
    $('providerFireworksStatus').textContent = 'API key is set.';
    showToast('Fireworks key saved');
  } catch { showToast('Failed to save key'); }
}


async function saveProviderGrokKey() {
  const key = $('providerGrokKey').value.trim();
  if (!key) { showToast('Enter an API key'); return; }
  try {
    await fetch('/api/provider-config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grokApiKey: key }) });
    $('providerGrokKey').value = '';
    $('providerGrokStatus').textContent = 'Inference key is set.';
    showToast('Grok key saved');
  } catch { showToast('Failed to save key'); }
}


async function saveProviderOpenRouterKey() {
  const key = $('providerOpenrouterKey').value.trim();
  if (!key) { showToast('Enter an API key'); return; }
  try {
    await fetch('/api/provider-config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openrouterApiKey: key }) });
    $('providerOpenrouterKey').value = '';
    $('providerOpenrouterStatus').textContent = 'API key is set.';
    showToast('OpenRouter key saved');
    await loadOpenRouterModels();
    renderModelBrowser?.();
    renderAgentModelRows?.();
  } catch { showToast('Failed to save key'); }
}

async function saveProviderAnthropicKey() {
  const key = $('providerAnthropicKey').value.trim();
  if (!key) { showToast('Enter an API key'); return; }
  try {
    await fetch('/api/provider-config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anthropicApiKey: key }) });
    $('providerAnthropicKey').value = '';
    $('providerAnthropicStatus').textContent = 'API key is set.';
    showToast('Anthropic key saved');
  } catch { showToast('Failed to save key'); }
}

async function saveProvider(provider) {
  const sel = {
    'ollama':       { urlEl: 'providerOllamaUrl',      keyEl: 'providerOllamaKey',      statusEl: 'providerOllamaKeyStatus',      urlField: 'ollamaUrl',      keyField: 'ollamaApiKey',      label: 'Ollama (cloud)' },
    'ollama-local': { urlEl: 'providerOllamaLocalUrl', keyEl: 'providerOllamaLocalKey', statusEl: 'providerOllamaLocalKeyStatus', urlField: 'ollamaLocalUrl', keyField: 'ollamaLocalApiKey', label: 'Ollama (local)' },
    'lmstudio':     { urlEl: 'providerLmstudioUrl',    keyEl: 'providerLmstudioKey',    statusEl: 'providerLmstudioKeyStatus',    urlField: 'lmstudioUrl',    keyField: 'lmstudioApiKey',    label: 'LM Studio' },
  }[provider];
  if (!sel) return;
  const url = $(sel.urlEl).value.trim();
  const key = $(sel.keyEl).value.trim();
  if (!url) { showToast('Enter a URL'); return; }
  const body = { [sel.urlField]: url, ...(key && { [sel.keyField]: key }) };
  try {
    await fetch('/api/provider-config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    if (key) {
      $(sel.keyEl).value = '';
      $(sel.statusEl).textContent = 'API key is set.';
    }
    showToast(`${sel.label} saved`);
  } catch { showToast('Failed to save'); }
}

async function saveProviderMicrosoftCreds() {
  const clientId     = $('providerMsClientId')?.value.trim();
  const clientSecret = $('providerMsClientSecret')?.value.trim();
  const tenant       = $('providerMsTenant')?.value.trim() || 'common';
  if (!clientId || !clientSecret) { showToast('Client ID and Secret are required'); return; }
  try {
    await fetch('/api/provider-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msClientId: clientId, msClientSecret: clientSecret, msTenant: tenant }),
    });
    $('providerMsClientId').value = '';
    $('providerMsClientSecret').value = '';
    $('providerMicrosoftStatus').textContent = 'Credentials saved. Use "+ Connect Microsoft" in Profile to link accounts.';
    showToast('Microsoft credentials saved');
  } catch { showToast('Failed to save credentials'); }
}

async function saveProviderTts() {
  const url   = $('providerTtsUrl').value.trim();
  const key   = $('providerTtsKey').value.trim();
  const model = $('providerTtsModel').value.trim();
  const voice = $('providerTtsVoice').value.trim();
  const body = {
    ...(url && { ttsApiUrl: url }),
    ...(key && { ttsApiKey: key }),
    ttsModel: model, ttsVoice: voice,
  };
  try {
    await fetch('/api/provider-config', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    if (key) { $('providerTtsKey').value = ''; }
    $('providerTtsStatus').textContent = key ? 'TTS configured.' : (url ? 'Settings saved.' : '');
    _ttsConfigured = !!(key || url);
    showToast('TTS settings saved');
  } catch { showToast('Failed to save TTS settings'); }
}

async function saveClaudeCodeLimits() {
  const daily  = parseInt($('claudeCodeDailyLimitInput')?.value  || '0') || null;
  const weekly = parseInt($('claudeCodeWeeklyLimitInput')?.value || '0') || null;
  try {
    await fetch('/api/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeCodeDailyLimit: daily, claudeCodeWeeklyLimit: weekly }) });
    showToast('Limits saved');
  } catch { showToast('Failed to save limits'); }
}

