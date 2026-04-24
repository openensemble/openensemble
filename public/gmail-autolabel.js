// ── Gmail Auto-Label ──────────────────────────────────────────────────────────
let _autoLabelData = null;  // cached server response { enabled, rulesByAccount, accountId }
let _autoLabelGmailAccounts = [];

async function loadGmailAutoLabel() {
  const toggle  = document.getElementById('autoLabelToggle');
  const panel   = document.getElementById('autoLabelContent');
  const section = document.getElementById('autoLabelSection');
  if (!toggle || !panel) return;
  const hasEmail = _currentUser?.allowedSkills == null || _currentUser.allowedSkills.includes('email');
  if (section) section.style.display = hasEmail ? '' : 'none';
  if (!hasEmail) return;
  try {
    const [data, allAccounts] = await Promise.all([
      fetch('/api/gmail/autolabel').then(r => r.json()),
      fetch('/api/email-accounts').then(r => r.json()).catch(() => []),
    ]);
    _autoLabelGmailAccounts = (Array.isArray(allAccounts) ? allAccounts : []).filter(a => a.provider === 'gmail');
    _autoLabelData = data;
    toggle.checked = data.enabled;
    // Use server's active accountId, fallback to first Gmail account
    const selectedId = data.accountId ?? _autoLabelGmailAccounts[0]?.id ?? null;
    renderAutoLabelPanel(panel, data.enabled, selectedId);
  } catch (e) {
    panel.innerHTML = `<div style="font-size:11px;color:var(--red)">${escHtml(e.message)}</div>`;
  }
}

function renderAutoLabelPanel(panel, enabled, selectedAccountId) {
  const accounts = _autoLabelGmailAccounts;
  const acctKey  = selectedAccountId ?? '__default__';
  const rules    = (_autoLabelData?.rulesByAccount ?? {})[acctKey] ?? [];

  const accountSelector = accounts.length > 0 ? `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <span style="font-size:11px;color:var(--muted);flex-shrink:0">Account:</span>
      <select id="alAccountId" onchange="renderAutoLabelPanel(document.getElementById('autoLabelContent'),_autoLabelData?.enabled??false,this.value)"
        style="font-size:11px;padding:3px 6px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);flex:1">
        ${accounts.map(a =>
          `<option value="${escHtml(a.id)}" ${a.id === selectedAccountId ? 'selected' : ''}>${escHtml(a.label)}</option>`
        ).join('')}
      </select>
    </div>` : '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">No Gmail accounts connected.</div>';

  if (!enabled) { panel.innerHTML = accountSelector; return; }

  const rulesHtml = rules.length
    ? rules.map(r => `
        <div style="display:flex;align-items:center;gap:8px;background:var(--bg2);border-radius:6px;padding:5px 10px;margin-bottom:4px">
          <span style="font-size:11px;flex:1;color:var(--text)">
            <b>${escHtml(r.field)}</b> ${{ equals: '=', domain: '@' }[r.op] ?? '~'} "${escHtml(r.value)}"
            <span style="color:var(--muted)">→</span>
            <span style="color:var(--accent)">${escHtml(r.label)}</span>
          </span>
          <button onclick="deleteAutoLabelRule('${r.id}')"
            style="background:none;border:none;color:var(--red,#e05c5c);cursor:pointer;font-size:16px;line-height:1;padding:0 2px">×</button>
        </div>`).join('')
    : '<div style="font-size:11px;color:var(--muted);margin-bottom:6px">No rules yet.</div>';
  panel.innerHTML = `
    ${accountSelector}
    <div style="margin-bottom:6px">${rulesHtml}</div>
    <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center">
      <select id="alField" style="font-size:11px;padding:3px 6px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text)">
        <option value="from">From</option>
        <option value="subject">Subject</option>
        <option value="to">To</option>
      </select>
      <select id="alOp" style="font-size:11px;padding:3px 6px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text)">
        <option value="contains">contains</option>
        <option value="equals">equals</option>
        <option value="domain">domain</option>
      </select>
      <input id="alValue" placeholder="value" style="font-size:11px;padding:3px 6px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);width:110px">
      <span style="font-size:11px;color:var(--muted)">→</span>
      <input id="alLabel" placeholder="label" style="font-size:11px;padding:3px 6px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);width:90px">
      <button onclick="addAutoLabelRule()" style="font-size:11px;padding:3px 10px;background:var(--accent);color:#fff;border:none;border-radius:5px;cursor:pointer">Add</button>
    </div>`;
}

async function toggleGmailAutoLabel(enabled) {
  await fetch('/api/gmail/autolabel/toggle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  await loadGmailAutoLabel();
}

async function addAutoLabelRule() {
  const accountId = document.getElementById('alAccountId')?.value ?? null;
  const field = document.getElementById('alField')?.value;
  const op    = document.getElementById('alOp')?.value;
  const value = document.getElementById('alValue')?.value?.trim();
  const label = document.getElementById('alLabel')?.value?.trim();
  if (!value || !label) return;
  const res = await fetch('/api/gmail/autolabel/rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, field, op, value, label }),
  }).then(r => r.json());
  // Update local cache and re-render without a full reload
  const key = accountId ?? '__default__';
  if (_autoLabelData) {
    _autoLabelData.rulesByAccount = _autoLabelData.rulesByAccount ?? {};
    _autoLabelData.rulesByAccount[key] = res.rules;
  }
  renderAutoLabelPanel(document.getElementById('autoLabelContent'), true, accountId);
}

async function deleteAutoLabelRule(id) {
  const accountId = document.getElementById('alAccountId')?.value ?? null;
  const res = await fetch('/api/gmail/autolabel/rules', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, id }),
  }).then(r => r.json());
  const key = accountId ?? '__default__';
  if (_autoLabelData) {
    _autoLabelData.rulesByAccount = _autoLabelData.rulesByAccount ?? {};
    _autoLabelData.rulesByAccount[key] = res.rules;
  }
  renderAutoLabelPanel(document.getElementById('autoLabelContent'), true, accountId);
}

