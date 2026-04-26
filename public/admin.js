// ── User Management (owner/admin) ─────────────────────────────────────────────
async function loadUserManagement() {
  const el = $('manageUsersList');
  if (!el) return;
  try {
    // Ensure provider model lists are loaded for the allowed-models UI
    if (!allModels.length) await loadModels();
    const [users, skills] = await Promise.all([
      fetch('/api/users').then(r => r.json()),
      fetch('/api/roles').then(r => r.json()),
    ]);
    // Master model list from all providers (unfiltered so admin sees everything)
    const masterModels = allAvailableModels({ unfiltered: true }).sort((a, b) => a.name.localeCompare(b.name));
    // allFeatures: drawer features from admin's (unrestricted) plugins list
    const allFeatures = drawers.filter(p => p.drawer);
    const myId = getCurrentUserId();
    const myRole = _currentUser?.role;
    el.innerHTML = '';
    for (const u of users) {
      const roleLabel = { owner: '👑 Owner', admin: '🔑 Admin', user: '👤 User', child: '🧒 Child' }[u.role] ?? '👤 User';
      const roleColor = { owner: 'var(--accent)', admin: '#f5a623', user: 'var(--muted)', child: '#43b89c' }[u.role] ?? 'var(--muted)';
      const isSelf = u.id === myId;
      const isOwner = u.role === 'owner';
      // Roles + Skills checkboxes split — checked = granted access; null = unrestricted (all checked)
      const allowedSkills = u.allowedSkills ?? null;
      const roleSkills  = skills.filter(s => s.service);
      const toolSkills  = skills.filter(s => !s.service && s.category !== 'delegate');
      function skillCheck(s) {
        const checked = allowedSkills == null || allowedSkills.includes(s.id);
        return `<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text);cursor:pointer">
          <input type="checkbox" ${checked ? 'checked' : ''} data-uid="${u.id}" data-skillid="${s.id}" class="skill-allow-chk"
            style="accent-color:var(--accent);cursor:pointer">
          ${escHtml(s.icon ?? '🔧')} ${escHtml(s.name)}
        </label>`;
      }
      const roleChecks = roleSkills.map(skillCheck).join('');
      const toolChecks = toolSkills.map(skillCheck).join('');

      // Enabled features checkboxes — null = all (owner/admin); [] = none; [...] = explicit list
      const allowedFeatures = u.allowedFeatures ?? null;
      const featureChecks = allFeatures.map(f => {
        const checked = allowedFeatures === null || allowedFeatures.includes(f.id);
        return `<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text);cursor:pointer">
          <input type="checkbox" ${checked ? 'checked' : ''} data-uid="${u.id}" data-fid="${f.id}" class="feature-allow-chk"
            style="accent-color:var(--accent);cursor:pointer">
          ${escHtml(f.icon ?? '🔲')} ${escHtml(f.name)}
        </label>`;
      }).join('');

      const lockChecked = u.skillsLocked ? 'checked' : '';
      const roleSelect = (myRole === 'owner' && !isSelf && !isOwner) ? `
        <select onchange="adminSetRole('${u.id}',this.value)" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:3px 6px;font-size:11px">
          <option value="user" ${u.role==='user'?'selected':''}>👤 User</option>
          <option value="child" ${u.role==='child'?'selected':''}>🧒 Child</option>
          <option value="admin" ${u.role==='admin'?'selected':''}>🔑 Admin</option>
        </select>` : `<span style="font-size:11px;padding:2px 7px;border-radius:20px;background:var(--bg2);color:${roleColor};border:1px solid ${roleColor}">${roleLabel}</span>`;
      const deleteBtn = (!isSelf && !isOwner) ? `<button onclick="adminDeleteUser('${u.id}','${escHtml(u.name)}')" style="background:none;border:1px solid var(--red,#e05c5c);color:var(--red,#e05c5c);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer">Delete</button>` : '';

      // Child safety prompt (editable per child account) — saved via global Save
      const childSafetySection = (u.role === 'child' && !isSelf) ? `
        <details style="margin-bottom:6px">
          <summary style="font-size:11px;color:var(--muted);cursor:pointer;user-select:none">🛡️ Child safety prompt (persona wrapper)</summary>
          <div style="margin-top:6px">
            <textarea id="childSafetyPrompt_${u.id}" rows="5" placeholder="Custom child safety prompt (leave empty for default)" style="width:100%;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:8px;font-size:11px;font-family:inherit;resize:vertical;box-sizing:border-box">${escHtml(u.childSafetyPrompt ?? '')}</textarea>
          </div>
        </details>` : '';

      // OAuth provider logins — admin-grantable capabilities (the user still
      // has to complete the connect flow themselves; this just unhides the button).
      let allowedOAuthSection = '';
      if ((u.role === 'child' || u.role === 'user') && !isSelf) {
        const OAUTH_PROVIDERS = [
          { id: 'openai-oauth', label: 'OpenAI (ChatGPT login)', icon: '🔐' },
        ];
        const allowedOAuth = Array.isArray(u.allowedOAuthProviders) ? u.allowedOAuthProviders : [];
        const oauthChecks = OAUTH_PROVIDERS.map(p => {
          const checked = allowedOAuth.includes(p.id);
          return `<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text);cursor:pointer">
            <input type="checkbox" ${checked ? 'checked' : ''} data-oauth="${escHtml(p.id)}" class="oauth-allow-chk" style="accent-color:var(--accent);cursor:pointer">
            ${p.icon} ${escHtml(p.label)}
          </label>`;
        }).join('');
        allowedOAuthSection = `
          <details style="margin-bottom:6px">
            <summary style="font-size:11px;color:var(--muted);cursor:pointer;user-select:none">🔐 OAuth logins (let user connect their own account)</summary>
            <div style="margin-top:6px;padding:6px;display:flex;flex-direction:column;gap:4px" id="oauthCheckboxes_${u.id}">
              ${oauthChecks}
            </div>
          </details>`;
      }

      // Allowed models (for child and user accounts) — grouped by provider
      let allowedModelsSection = '';
      if ((u.role === 'child' || u.role === 'user') && !isSelf) {
        const providerOrder = ['anthropic', 'openai-oauth', 'ollama-local', 'ollama-cloud', 'lmstudio', 'fireworks', 'grok'];
        const provLabels = { anthropic: 'Anthropic', 'openai-oauth': 'OpenAI (ChatGPT login)', 'ollama-local': 'Ollama (local)', 'ollama-cloud': 'Ollama (cloud)', lmstudio: 'LM Studio', fireworks: 'Fireworks', grok: 'Grok' };
        const grouped = {};
        for (const m of masterModels) {
          // Bundled core models (embedding, reasoning) are always-on for every
          // user — they're not user-configurable, so don't pollute the picker.
          if (m.provider === 'builtin') continue;
          // Split Ollama into local vs cloud tiers so admins can grant access
          // by where the model actually runs.
          let prov = m.provider ?? 'other';
          if (prov === 'ollama') prov = m.tier === 'cloud' ? 'ollama-cloud' : 'ollama-local';
          if (!grouped[prov]) grouped[prov] = [];
          grouped[prov].push(m);
        }
        const sortedProviders = [
          ...providerOrder.filter(p => grouped[p]),
          ...Object.keys(grouped).filter(p => !providerOrder.includes(p)).sort(),
        ];
        const allowedModels = u.allowedModels ?? null;
        const modelGroupsHtml = sortedProviders.map(prov => {
          const label = provLabels[prov] ?? prov;
          const checksHtml = grouped[prov].map(m => {
            const checked = allowedModels === null || allowedModels.includes(m.name);
            return `<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text);cursor:pointer">
              <input type="checkbox" ${checked ? 'checked' : ''} data-model="${escHtml(m.name)}" class="model-allow-chk" style="accent-color:var(--accent);cursor:pointer">
              ${escHtml(m.name)}
            </label>`;
          }).join('');
          return `<div style="margin-bottom:8px">
            <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;padding-bottom:2px;border-bottom:1px solid var(--border)">${escHtml(label)}</div>
            <div style="display:flex;flex-direction:column;gap:3px;padding-left:4px">${checksHtml}</div>
          </div>`;
        }).join('');
        allowedModelsSection = `
          <details style="margin-bottom:6px">
            <summary style="font-size:11px;color:var(--muted);cursor:pointer;user-select:none">🔒 Allowed models (unchecked = blocked)</summary>
            <div style="margin-top:6px;padding:6px;max-height:240px;overflow-y:auto" id="modelCheckboxes_${u.id}">
              ${modelGroupsHtml || '<div style="font-size:11px;color:var(--muted)">No models available</div>'}
            </div>
          </details>`;
      }

      // Access schedule — saved via global Save (empty fields = no schedule)
      const accessScheduleSection = (!isSelf && !isOwner) ? `
        <details style="margin-bottom:6px">
          <summary style="font-size:11px;color:var(--muted);cursor:pointer;user-select:none">⏰ Access schedule (block login during hours)</summary>
          <div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap" id="schedRow_${u.id}">
            <label style="font-size:11px;color:var(--muted)">Block from
              <input type="time" id="schedFrom_${u.id}" value="${u.accessSchedule?.blockedFrom ?? ''}" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 6px;font-size:11px">
            </label>
            <label style="font-size:11px;color:var(--muted)">until
              <input type="time" id="schedUntil_${u.id}" value="${u.accessSchedule?.blockedUntil ?? ''}" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 6px;font-size:11px">
            </label>
            <span style="font-size:10px;color:var(--muted)">(leave both empty for no schedule)</span>
          </div>
          ${u.accessSchedule ? `<div style="font-size:10px;color:var(--muted);margin-top:4px">Currently blocked ${u.accessSchedule.blockedFrom} – ${u.accessSchedule.blockedUntil}</div>` : ''}
        </details>` : '';

      // Parent link display
      const parentInfo = u.parentId ? (() => {
        const parent = users.find(p => p.id === u.parentId);
        return parent ? `<span style="font-size:10px;color:var(--muted);margin-left:4px">(managed by ${escHtml(parent.name)})</span>` : '';
      })() : '';

      const card = document.createElement('details');
      card.style.cssText = 'background:var(--bg3);border-radius:10px;padding:0';
      card.innerHTML = `
        <summary style="list-style:none;cursor:pointer;user-select:none;padding:10px 12px;display:flex;align-items:center;gap:8px">
          <span style="color:var(--muted);font-size:10px;width:10px;flex-shrink:0" class="card-toggle-caret">▸</span>
          <span style="font-size:18px">${escHtml(u.emoji ?? '🧑')}</span>
          <span style="font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(u.name)}${isSelf ? ' <span style="font-size:10px;color:var(--muted)">(you)</span>' : ''}${parentInfo}</span>
          <span style="font-size:10px;color:${roleColor};background:var(--bg2);border-radius:4px;padding:2px 6px;flex-shrink:0">${roleLabel}</span>
        </summary>
        <div style="padding:0 12px 12px 12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:11px;color:var(--muted)">Account:</span>
          ${roleSelect}
          ${deleteBtn}
        </div>
        <details style="margin-bottom:6px">
          <summary style="font-size:11px;color:var(--muted);cursor:pointer;user-select:none">Roles (unchecked = no access)</summary>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;padding:6px" id="roleAllowGrid_${u.id}">${roleChecks}</div>
        </details>
        <details style="margin-bottom:6px">
          <summary style="font-size:11px;color:var(--muted);cursor:pointer;user-select:none">Tools (unchecked = no access)</summary>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;padding:6px" id="skillAllowGrid_${u.id}">${toolChecks}</div>
        </details>
        <details style="margin-bottom:6px">
          <summary style="font-size:11px;color:var(--muted);cursor:pointer;user-select:none">Enabled drawers (unchecked = hidden)</summary>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;padding:6px" id="featureAllowGrid_${u.id}">${featureChecks}</div>
        </details>
        ${allowedOAuthSection}
        ${allowedModelsSection}
        ${accessScheduleSection}
        ${childSafetySection}
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);cursor:pointer;margin-top:8px">
          <input type="checkbox" ${lockChecked} id="lockToolsChk_${u.id}"
            style="accent-color:var(--red,#e05c5c);cursor:pointer">
          🔒 Lock tools (prevent user from changing)
        </label>
        ${!isSelf && !isOwner ? `
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);cursor:pointer;margin-top:4px">
          <input type="checkbox" ${u.telegramAllowed !== false ? 'checked' : ''} id="telegramAllowedChk_${u.id}"
            style="accent-color:var(--accent);cursor:pointer">
          <i data-lucide="send" style="width:12px;height:12px"></i> Allow Telegram bot setup
        </label>` : ''}
        <div style="margin-top:12px">
          <button onclick="adminSaveUser('${u.id}')" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 16px;font-size:12px;cursor:pointer;font-weight:600">Save changes</button>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
          <button onclick="openConvViewer('${u.id}','${escHtml(u.name)}')" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 10px;font-size:11px;cursor:pointer">💬 Conversations</button>
          ${!isSelf ? `<button onclick="adminResetSessions('${u.id}','${escHtml(u.name)}')" style="background:none;border:1px solid var(--yellow,#ffc107);color:var(--yellow,#ffc107);border-radius:6px;padding:5px 10px;font-size:11px;cursor:pointer">🔄 Reset Sessions</button>` : ''}
          ${!isSelf && !isOwner ? `<button onclick="adminResetPassword('${u.id}','${escHtml(u.name)}')" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 10px;font-size:11px;cursor:pointer">🔑 Reset Password</button>` : ''}
          ${!isSelf && !isOwner ? `<button onclick="adminToggleLock('${u.id}',${!!u.locked})" style="background:none;border:1px solid ${u.locked ? 'var(--green,#4caf50)' : 'var(--red,#e05c5c)'};color:${u.locked ? 'var(--green,#4caf50)' : 'var(--red,#e05c5c)'};border-radius:6px;padding:5px 10px;font-size:11px;cursor:pointer">${u.locked ? '🔓 Unlock Account' : '🔒 Lock Account'}</button>` : ''}
        </div>
        </div>`;
      card.addEventListener('toggle', () => {
        const caret = card.querySelector('.card-toggle-caret');
        if (caret) caret.textContent = card.open ? '▾' : '▸';
      });
      el.appendChild(card);

    }
  } catch (e) {
    el.innerHTML = `<div style="color:var(--red);font-size:12px">${escHtml(e.message)}</div>`;
  }
}


// Single save handler — collects every editable section in the user card and
// PATCHes them in one request. Sections that don't exist for this user's role
// (e.g. allowedModels for owner) are simply skipped.
async function adminSaveUser(userId) {
  const body = {};

  // Roles + Tools (combined into allowedSkills + skills mirror)
  const roleGrid  = $(`roleAllowGrid_${userId}`);
  const skillGrid = $(`skillAllowGrid_${userId}`);
  if (roleGrid || skillGrid) {
    const checkedRoles  = roleGrid  ? [...roleGrid.querySelectorAll('.skill-allow-chk:checked')].map(el => el.dataset.skillid)  : [];
    const checkedSkills = skillGrid ? [...skillGrid.querySelectorAll('.skill-allow-chk:checked')].map(el => el.dataset.skillid) : [];
    const allRoles  = roleGrid  ? [...roleGrid.querySelectorAll('.skill-allow-chk')].map(el => el.dataset.skillid)  : [];
    const allSkills = skillGrid ? [...skillGrid.querySelectorAll('.skill-allow-chk')].map(el => el.dataset.skillid) : [];
    const checked = [...checkedRoles, ...checkedSkills];
    const all     = [...allRoles, ...allSkills];
    body.allowedSkills = checked.length === all.length ? null : checked;
    body.skills = checked;
  }

  // Enabled drawers
  const featGrid = $(`featureAllowGrid_${userId}`);
  if (featGrid) {
    const checked = [...featGrid.querySelectorAll('.feature-allow-chk:checked')].map(el => el.dataset.fid);
    const all = [...featGrid.querySelectorAll('.feature-allow-chk')].map(el => el.dataset.fid);
    body.allowedFeatures = checked.length === all.length ? null : checked;
  }

  // OAuth logins
  const oauthGrid = document.getElementById(`oauthCheckboxes_${userId}`);
  if (oauthGrid) {
    body.allowedOAuthProviders = [...oauthGrid.querySelectorAll('.oauth-allow-chk:checked')].map(el => el.dataset.oauth);
  }

  // Allowed models
  const modelGrid = document.getElementById(`modelCheckboxes_${userId}`);
  if (modelGrid) {
    const checked = [...modelGrid.querySelectorAll('.model-allow-chk:checked')].map(el => el.dataset.model);
    const all = [...modelGrid.querySelectorAll('.model-allow-chk')].map(el => el.dataset.model);
    body.allowedModels = checked.length === all.length ? null : checked;
  }

  // Access schedule (both empty = clear; both set = save; partial = error)
  const schedFromEl  = document.getElementById(`schedFrom_${userId}`);
  const schedUntilEl = document.getElementById(`schedUntil_${userId}`);
  if (schedFromEl && schedUntilEl) {
    const from  = schedFromEl.value;
    const until = schedUntilEl.value;
    if (!from && !until) body.accessSchedule = null;
    else if (from && until) body.accessSchedule = { blockedFrom: from, blockedUntil: until };
    else { showToast('Access schedule needs both times (or both empty)'); return; }
  }

  // Child safety prompt
  const childPromptEl = document.getElementById(`childSafetyPrompt_${userId}`);
  if (childPromptEl) body.childSafetyPrompt = childPromptEl.value.trim() || null;

  // Lock tools + Telegram allowed (plain checkboxes — saved with the rest)
  const lockEl = document.getElementById(`lockToolsChk_${userId}`);
  if (lockEl) body.skillsLocked = lockEl.checked;
  const telEl = document.getElementById(`telegramAllowedChk_${userId}`);
  if (telEl) body.telegramAllowed = telEl.checked;

  try {
    const r = await fetch(`/api/users/${userId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); showToast(d.error ?? 'Failed to save'); return; }
    showToast('Saved', 2000);
    if (userId === getCurrentUserId() && 'skillsLocked' in body) {
      _currentUser = { ..._currentUser, skillsLocked: body.skillsLocked };
      if (typeof loadSkillsList === 'function') loadSkillsList();
    }
    loadUserManagement();
  } catch { showToast('Failed to save'); }
}

async function adminResetPassword(userId, name) {
  const pw = prompt(`Set new password for "${name}" (min 8 chars):`);
  if (pw === null) return;
  if (!pw || pw.length < 8) { showToast('Password must be at least 8 characters'); return; }
  try {
    const r = await fetch(`/api/users/${userId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: pw }),
    });
    if (!r.ok) { const d = await r.json(); showToast(d.error ?? 'Failed'); return; }
    showToast('Password reset', 2000);
  } catch { showToast('Failed to reset password'); }
}

async function adminToggleLock(userId, currentlyLocked) {
  try {
    const r = await fetch(`/api/users/${userId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked: !currentlyLocked }),
    });
    if (!r.ok) { const d = await r.json(); showToast(d.error ?? 'Failed'); return; }
    showToast(currentlyLocked ? 'Account unlocked' : 'Account locked', 2000);
    loadUserManagement();
  } catch { showToast('Failed to update'); }
}

async function adminResetSessions(userId, name) {
  if (!confirm(`Reset all sessions for "${name}"? This will log them out.`)) return;
  try {
    const r = await fetch(`/api/admin/sessions/${userId}`, { method: 'DELETE' }).then(r => r.json());
    showToast(`Cleared ${r.cleared ?? 0} session file(s)`, 3000);
  } catch { showToast('Failed to reset sessions'); }
}

async function adminToggleSkill(userId, skillId, enabled) {
  try {
    await fetch('/api/roles/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId, enabled, userId }),
    });
    // If modifying self, also refresh the skills list
    if (userId === getCurrentUserId()) { loadSkillsList(); const updated = await fetch('/api/agents').then(r => r.json()); agents = updated; buildTabs(); buildAgentDrawer(); }
  } catch {}
}

async function adminSetRole(userId, role) {
  try {
    await fetch(`/api/users/${userId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    loadUserManagement();
  } catch {}
}

async function adminDeleteUser(userId, name) {
  if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
  try {
    await fetch(`/api/users/${userId}`, { method: 'DELETE' });
    loadUserManagement();
  } catch {}
}

function updateAddUserRoleHint() {
  const role = $('addUserRole')?.value;
  const hint = $('addUserRoleHint');
  if (!hint) return;
  const hints = {
    user:  'Standard account. Can use tools you assign and manage their own settings.',
    child: 'Age-safe mode. All agents follow child-appropriate guidelines. Tools locked to safe defaults. Great for homework help.',
    admin: 'Can create and manage user/child accounts, and control their tools.',
  };
  hint.textContent = hints[role] ?? '';
  // Show child prompt row when role=child
  const childPromptRow = $('addUserChildPromptRow');
  if (childPromptRow) childPromptRow.style.display = role === 'child' ? 'flex' : 'none';
  updateAddUserFeaturesVisibility();
}

function openAddUserModal() {
  const modal = $('addUserModal');
  modal.classList.add('open');
  $('addUserName').value = '';
  $('addUserPassword').value = '';
  $('addUserError').textContent = '';
  const childPromptEl = $('addUserChildPrompt');
  if (childPromptEl) childPromptEl.value = '';
  const childPromptRow = $('addUserChildPromptRow');
  if (childPromptRow) childPromptRow.style.display = 'none';
  // Show role selector for owner/admin
  const roleRow = $('addUserRoleRow');
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  if (roleRow) {
    roleRow.style.display = isPriv ? 'flex' : 'none';
    // Admin can only create user/child; hide admin option for non-owners
    const roleSelect = $('addUserRole');
    if (roleSelect) {
      const adminOpt = roleSelect.querySelector('option[value="admin"]');
      if (adminOpt) adminOpt.style.display = _currentUser?.role === 'owner' ? '' : 'none';
      roleSelect.value = 'user';
    }
  }
  updateAddUserRoleHint();
  // Populate feature access checkboxes (only for non-admin roles)
  const featuresRow = $('addUserFeaturesRow');
  const featuresGrid = $('addUserFeaturesGrid');
  if (featuresRow && featuresGrid && isPriv) {
    const drawerFeatures = drawers.filter(p => p.drawer);
    featuresGrid.innerHTML = drawerFeatures.map(f =>
      `<label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text);cursor:pointer;white-space:nowrap">
        <input type="checkbox" data-fid="${f.id}" class="add-user-feature-chk" style="accent-color:var(--accent);cursor:pointer">
        ${escHtml(f.icon ?? '🔲')} ${escHtml(f.name)}
      </label>`
    ).join('');
    featuresRow.style.display = 'flex';
    updateAddUserFeaturesVisibility();
  }
}

function updateAddUserFeaturesVisibility() {
  const role = $('addUserRole')?.value ?? 'user';
  const featuresRow = $('addUserFeaturesRow');
  // Admin/owner get unrestricted access — no need to pick features
  if (featuresRow) featuresRow.style.display = (role === 'admin') ? 'none' : 'flex';
}

function closeAddUserModal() {
  $('addUserModal').classList.remove('open');
}

function getAllowedFeaturesFromModal(role) {
  if (role === 'admin') return null; // admin gets unrestricted access
  const grid = $('addUserFeaturesGrid');
  if (!grid) return [];
  return [...grid.querySelectorAll('.add-user-feature-chk:checked')].map(el => el.dataset.fid);
}

async function submitAddUser() {
  const name = $('addUserName').value.trim();
  const password = $('addUserPassword').value;
  const emoji = $('addUserEmoji').value;
  const role = $('addUserRole')?.value ?? 'user';
  const errEl = $('addUserError');
  if (!name) { errEl.textContent = 'Name required'; return; }
  if (!password || password.length < 4) { errEl.textContent = 'Password must be at least 4 characters'; return; }
  errEl.textContent = '';
  try {
    const r = await fetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, emoji, password, role,
        allowedFeatures: getAllowedFeaturesFromModal(role),
        childSafetyPrompt: role === 'child' ? ($('addUserChildPrompt')?.value?.trim() || null) : undefined,
      }),
    });
    const d = await r.json();
    if (!r.ok) { errEl.textContent = d.error ?? 'Failed to create user'; return; }
    closeAddUserModal();
    loadUserManagement();
  } catch (e) { errEl.textContent = e.message; }
}

async function changePassword() {
  const current = $('pwCurrent').value;
  const newPw = $('pwNew').value;
  const newPw2 = $('pwNew2').value;
  const errEl = $('pwChangeError');
  if (!current) { errEl.textContent = 'Current password required'; return; }
  if (!newPw || newPw.length < 4) { errEl.textContent = 'New password must be at least 4 characters'; return; }
  if (newPw !== newPw2) { errEl.textContent = 'Passwords do not match'; return; }
  errEl.textContent = '';
  const id = getCurrentUserId();
  if (!id) return;
  try {
    const r = await fetch(`/api/users/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: newPw }),
    });
    const d = await r.json();
    if (!r.ok) { errEl.textContent = d.error ?? 'Failed to update password'; return; }
    errEl.style.color = 'var(--green)'; errEl.textContent = 'Password updated!';
    $('pwCurrent').value = ''; $('pwNew').value = ''; $('pwNew2').value = '';
    setTimeout(() => { errEl.textContent = ''; errEl.style.color = ''; }, 3000);
  } catch (e) { errEl.textContent = e.message; }
}

async function openUserPicker() {
  const modal = $('userPickerModal');
  modal.classList.remove('hidden');
  const users = await fetch('/api/users').then(r => r.json()).catch(() => []);
  const currentId = getCurrentUserId();
  const list = $('userList');
  if (!users.length) {
    list.innerHTML = `<div style="color:var(--muted);font-size:13px;text-align:center;padding:12px">No profiles yet. Add one below.</div>`;
  } else {
    list.innerHTML = users.map(u => {
      const roleLabel = { owner: '👑', admin: '🔑', child: '🧒' }[u.role] ?? '';
      const avatarHtml = u.avatar
        ? `<div class="user-avatar"><img src="${u.avatar}" alt=""></div>`
        : `<div class="user-avatar" style="background:${u.color ?? 'var(--bg3)'}">${u.emoji ?? '🧑'}</div>`;
      return `<div class="user-card${u.id === currentId ? ' active' : ''}" onclick="switchToUser('${u.id}')">
        ${avatarHtml}
        <div><div class="user-card-name">${escHtml(u.name)} ${roleLabel}</div></div>
      </div>`;
    }).join('');
  }
}

function closeUserPicker() {
  $('userPickerModal').classList.add('hidden');
}

async function switchToUser(targetId) {
  try {
    const users = await fetch('/api/users').then(r => r.json());
    const targetUser = users.find(u => u.id === targetId);
    if (!targetUser) return;

    let password;

    // If switching to a different user, require their password
    if (targetId !== getCurrentUserId()) {
      try {
        password = await new Promise((resolve, reject) => {
          showPasswordModal(`Enter ${targetUser.name}'s password`, resolve, () => reject(new Error('cancelled')));
        });
      } catch (e) {
        if (e.message !== 'cancelled') showToast(e.message);
        return;
      }
    }

    // Call switch endpoint to get a new session token
    const resp = await fetch(`/api/users/${targetId}/switch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await resp.json();
    if (!resp.ok) { showToast(data.error ?? 'Switch failed'); return; }

    // Update auth token, then full-reload so every panel (agents, models,
    // provider state, drawers, settings) rebuilds against the new user.
    // A WS reconnect alone leaves all the DOM state from the previous user.
    setToken(data.token);
    setCurrentUser(data.user);
    closeUserPicker();
    location.reload();
  } catch (e) {
    if (e.message) showToast(e.message);
  }
}

