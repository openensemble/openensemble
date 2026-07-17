// ── Migrate legacy localStorage keys ─────────────────────────────────────────
// (Keys other than the session token; oe_token is no longer stored client-side.)
for (const [o, n] of [['clawd_user_id','oe_user_id'],
  ['clawd_layout','oe_layout'],['clawd_custom_models','oe_custom_models'],
  ['clawd_reminder_board','oe_reminder_board']]) {
  const v = localStorage.getItem(o);
  if (v !== null && localStorage.getItem(n) === null) {
    localStorage.setItem(n, v); localStorage.removeItem(o);
  }
}
// Drop any legacy oe_token / clawd_token left in storage from before the
// HttpOnly-cookie migration. The cookie is the only token now; leaving the
// stale localStorage value around just gives XSS a target.
localStorage.removeItem('oe_token');
localStorage.removeItem('clawd_token');

// ── Auth ──────────────────────────────────────────────────────────────────────
// Session auth lives in an HttpOnly cookie set by /api/login. JavaScript can't
// read it (which is the point), so getToken/setToken are stubs kept only for
// the few call sites that still reference them — they no-op safely. The fetch
// wrapper below uses cookie credentials; the WS first-message auth sends an
// empty token and lets the server's cookie-at-upgrade auth do the work.
function getToken() { return null; }
function setToken(t) {
  if (!t) { _mediaTok = null; _mediaTokExpiresAt = 0; }
  // intentionally no localStorage write
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

// Intercept all fetch calls to attach auth and handle 401.
//
// Auth is the HttpOnly cookie set by /api/login — `credentials: 'same-origin'`
// makes the browser send it on every same-origin /api request. JavaScript
// can't read or forge the cookie, so even an injected XSS payload can't
// exfiltrate the session token (it can only call APIs as the user from
// within the page it's already injected into).
const _origFetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (typeof url === 'string' && url.startsWith('/api') && url !== '/api/login') {
    opts = { ...opts, credentials: opts.credentials ?? 'same-origin' };
  }
  return _origFetch(url, opts).then(r => {
    if (r.status === 401 && typeof url === 'string' && url !== '/api/login') {
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
      return `<button class="login-user-btn" data-id="${u.id}" data-action="selectLoginUser" data-args='${JSON.stringify([u.id, u.name]).replace(/'/g, "&#39;")}'>
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
    const password = document.getElementById('setupRestorePassword')?.value ?? '';
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (password) headers['X-Restore-Password'] = password;
    const r = await _origFetch('/api/admin/restore-initial', {
      method: 'POST',
      headers,
      body: buf,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (data?.encrypted && !password) {
        status.style.color = 'var(--muted)';
        status.textContent = 'This backup is encrypted — enter the password and try again.';
        btn.disabled = false; btn.textContent = 'Restore from Backup';
        return;
      }
      throw new Error(data.error || `Restore failed (${r.status})`);
    }
    status.style.color = 'var(--green,#43b89c)';
    if (data.restarting) {
      // Server is auto-restarting — poll /health until it's back, then reload.
      // The 800ms delay-and-reload approach raced the restart and often
      // showed an "unreachable" page for ~15s before the SPA recovered.
      status.textContent = `Restored ${data.restored} item(s). Restarting server…`;
      const deadline = Date.now() + 90_000;
      const tick = async () => {
        if (Date.now() > deadline) {
          status.style.color = 'var(--red,#e05c5c)';
          status.textContent = 'Server didn\'t come back within 90s. Reload the page manually.';
          return;
        }
        try {
          const h = await _origFetch('/health', { cache: 'no-store' });
          if (h.ok) {
            status.textContent = 'Server back — reloading…';
            setTimeout(() => location.reload(), 600);
            return;
          }
        } catch {}
        setTimeout(tick, 1000);
      };
      setTimeout(tick, 3000);
    } else {
      status.textContent = `Restored ${data.restored} item(s). Reloading…`;
      setTimeout(() => location.reload(), 800);
    }
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

// Per-role/per-skill execution overrides. These are account-scoped server
// settings; the manifest itself stays immutable. Empty values mean "inherit
// the agent that is handling this request", while explicit `auto` remains a
// real effort choice rather than being overloaded as inheritance.
const _SKILL_EXECUTION_EFFORT_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];
const _skillExecutionSaved = new Map();
const _skillExecutionEffortRequests = new Map();

function _normalizeSkillExecution(execution) {
  const raw = execution && typeof execution === 'object' ? execution : {};
  const provider = typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : null;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : null;
  const reasoningEffort = typeof raw.reasoningEffort === 'string' && raw.reasoningEffort.trim()
    ? raw.reasoningEffort.trim().toLowerCase()
    : null;
  return {
    provider: provider && model ? provider : null,
    model: provider && model ? model : null,
    reasoningEffort,
  };
}

function _skillExecutionTextCapableModel(model) {
  if (!model || model.provider === 'fireworks') return false;
  if ((model.provider === 'grok' || model.provider === 'xai')
      && /^grok-imagine-(?:image|video)/i.test(String(model.name || ''))) return false;
  return true;
}

function _skillExecutionModelValue(provider, model) {
  return provider && model ? JSON.stringify([provider, model]) : '';
}

function _parseSkillExecutionModelValue(value) {
  if (!value) return { provider: null, model: null };
  try {
    const pair = JSON.parse(value);
    if (!Array.isArray(pair) || pair.length !== 2
        || typeof pair[0] !== 'string' || !pair[0]
        || typeof pair[1] !== 'string' || !pair[1]) throw new Error('invalid model selection');
    return { provider: pair[0], model: pair[1] };
  } catch {
    return { provider: null, model: null };
  }
}

function _skillExecutionProviderLabel(provider) {
  const labels = {
    anthropic: 'Anthropic', openai: 'OpenAI', 'openai-oauth': 'OpenAI (ChatGPT login)',
    gemini: 'Google Gemini', deepseek: 'DeepSeek', mistral: 'Mistral AI', groq: 'Groq',
    together: 'Together AI', perplexity: 'Perplexity', ollama: 'Ollama',
    lmstudio: 'LM Studio', grok: 'xAI Grok', xai: 'xAI Grok',
    openrouter: 'OpenRouter', zai: 'Z.AI',
  };
  if (labels[provider]) return labels[provider];
  const dynamic = typeof window.getCompatProviderMeta === 'function'
    ? window.getCompatProviderMeta().find(p => p.id === provider)
    : null;
  return dynamic?.label || dynamic?.displayName || provider;
}

function _skillExecutionModels() {
  const models = typeof allAvailableModels === 'function' ? allAvailableModels() : [];
  return models.filter(_skillExecutionTextCapableModel);
}

function _skillExecutionModelOptionsHtml(execution) {
  const current = _normalizeSkillExecution(execution);
  const currentValue = _skillExecutionModelValue(current.provider, current.model);
  const groups = new Map();
  let currentAvailable = !currentValue;
  for (const model of _skillExecutionModels()) {
    if (!model?.provider || !model?.name) continue;
    const value = _skillExecutionModelValue(model.provider, model.name);
    if (value === currentValue) currentAvailable = true;
    if (!groups.has(model.provider)) groups.set(model.provider, []);
    groups.get(model.provider).push({ ...model, value });
  }
  let html = `<option value=""${!currentValue ? ' selected' : ''}>Inherit requesting agent</option>`;
  if (currentValue && !currentAvailable) {
    html += `<option value="${escHtml(currentValue)}" selected>${escHtml(current.model)} (unavailable)</option>`;
  }
  for (const [provider, models] of groups) {
    html += `<optgroup label="${escHtml(_skillExecutionProviderLabel(provider))}">`;
    html += models.map(model => `<option value="${escHtml(model.value)}"${model.value === currentValue ? ' selected' : ''}>${escHtml(model.displayName ?? model.name)}</option>`).join('');
    html += '</optgroup>';
  }
  return html;
}

function _skillExecutionEffortOptionsHtml(current, supported = _SKILL_EXECUTION_EFFORT_OPTIONS) {
  const selected = typeof current === 'string' && current ? current : null;
  const seen = new Set();
  const options = [];
  for (const option of Array.isArray(supported) ? supported : []) {
    const value = typeof option?.value === 'string' ? option.value.toLowerCase() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: option.label || value });
  }
  if (selected && !seen.has(selected)) {
    options.push({ value: selected, label: `${selected[0].toUpperCase()}${selected.slice(1)} (not supported for this model)` });
  }
  return `<option value=""${selected ? '' : ' selected'}>Inherit requesting agent</option>`
    + options.map(option => `<option value="${escHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escHtml(option.label)}</option>`).join('');
}

function _skillExecutionSummary(execution) {
  const value = _normalizeSkillExecution(execution);
  if (!value.model && !value.reasoningEffort) return 'Inherit agent';
  const effort = value.reasoningEffort
    ? `${value.reasoningEffort[0].toUpperCase()}${value.reasoningEffort.slice(1)}`
    : 'Agent effort';
  return `${value.model || 'Agent model'} · ${effort}`;
}

function _skillExecutionInheritedAgent(skill, allAgents) {
  const roster = (allAgents ?? []).filter(agent => !agent.archived);
  const assigned = skill.assignment ? roster.find(agent => agent.id === skill.assignment) : null;
  if (assigned) return assigned;
  const inheritedId = typeof skill.inheritedAgentId === 'string' ? skill.inheritedAgentId : null;
  return roster.find(agent => agent.id === inheritedId) || roster[0] || null;
}

function _renderSkillExecutionControls(skill, allAgents) {
  const execution = _normalizeSkillExecution(skill.execution);
  _skillExecutionSaved.set(skill.id, execution);
  const inheritedAgent = _skillExecutionInheritedAgent(skill, allAgents);
  const inheritedModel = _skillExecutionModelValue(inheritedAgent?.provider, inheritedAgent?.model);
  const args = escHtml(JSON.stringify([skill.id]));
  return `<details class="skill-execution-settings" data-skill-id="${escHtml(skill.id)}" data-inherited-model="${escHtml(inheritedModel)}"
      data-toggle-action="refreshSkillExecutionEfforts" data-toggle-args='${args}'>
    <summary class="skill-execution-summary">
      <span>Execution</span>
      <span class="skill-execution-current">${escHtml(_skillExecutionSummary(execution))}</span>
    </summary>
    <div class="skill-execution-body">
      <div class="skill-execution-grid">
        <label>Model
          <select class="skill-execution-model" data-change-action="saveSkillExecution" data-change-args='${args}'>
            ${_skillExecutionModelOptionsHtml(execution)}
          </select>
        </label>
        <label>Reasoning effort
          <select class="skill-execution-effort" data-change-action="saveSkillExecution" data-change-args='${args}'>
            ${_skillExecutionEffortOptionsHtml(execution.reasoningEffort)}
          </select>
        </label>
      </div>
      <div class="skill-execution-hint">Applies to model calls routed to this role or skill. A multi-skill turn freezes one profile: strongest effort, with the model from the strongest model-specific match. Local shortcuts and tool execution may not call a model.</div>
      <div class="skill-execution-status" role="status" aria-live="polite"></div>
    </div>
  </details>`;
}

function _skillExecutionCard(skillId, event) {
  const fromEvent = event?.target?.closest?.('.skill-execution-settings');
  if (fromEvent?.dataset?.skillId === String(skillId)) return fromEvent;
  return [...document.querySelectorAll('.skill-execution-settings')]
    .find(card => card.dataset.skillId === String(skillId)) || null;
}

function _setSkillExecutionStatus(card, state, text) {
  const status = card?.querySelector('.skill-execution-status');
  if (!status) return;
  status.dataset.state = state || '';
  status.textContent = text || '';
}

function _setSkillExecutionDisabled(card, disabled) {
  card?.querySelectorAll('select').forEach(select => { select.disabled = disabled; });
}

function _applySkillExecutionToCard(card, execution) {
  if (!card) return;
  const normalized = _normalizeSkillExecution(execution);
  const modelSelect = card.querySelector('.skill-execution-model');
  const effortSelect = card.querySelector('.skill-execution-effort');
  if (modelSelect) modelSelect.innerHTML = _skillExecutionModelOptionsHtml(normalized);
  if (effortSelect) {
    effortSelect.innerHTML = _skillExecutionEffortOptionsHtml(
      normalized.reasoningEffort,
      card._supportedExecutionEfforts || _SKILL_EXECUTION_EFFORT_OPTIONS,
    );
  }
  const summary = card.querySelector('.skill-execution-current');
  if (summary) summary.textContent = _skillExecutionSummary(normalized);
}

function _skillExecutionPayloadFromCard(card) {
  const pair = _parseSkillExecutionModelValue(card?.querySelector('.skill-execution-model')?.value || '');
  const effort = card?.querySelector('.skill-execution-effort')?.value || null;
  return { provider: pair.provider, model: pair.model, reasoningEffort: effort };
}

async function _reloadSkillExecution(skillId) {
  const response = await fetch('/api/roles');
  if (!response.ok) throw new Error('Could not reload execution setting');
  const skills = await response.json();
  const skill = Array.isArray(skills) ? skills.find(item => item.id === skillId) : null;
  if (!skill) throw new Error('Role or skill is no longer available');
  return _normalizeSkillExecution(skill.execution);
}

async function saveSkillExecution(skillId, event) {
  const card = _skillExecutionCard(skillId, event);
  if (!card) return;
  const prior = _skillExecutionSaved.get(skillId) || _normalizeSkillExecution(null);
  const changedModel = event?.target?.classList?.contains('skill-execution-model');
  const payload = _skillExecutionPayloadFromCard(card);
  _setSkillExecutionDisabled(card, true);
  _setSkillExecutionStatus(card, 'saving', 'Saving…');
  try {
    const response = await fetch(`/api/roles/${encodeURIComponent(skillId)}/execution`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Save failed');
    const saved = _normalizeSkillExecution(result.execution);
    _skillExecutionSaved.set(skillId, saved);
    _applySkillExecutionToCard(card, saved);
    _setSkillExecutionStatus(card, 'saved', 'Saved');
    if (changedModel) refreshSkillExecutionEfforts(skillId, { target: card });
    setTimeout(() => {
      const status = card.querySelector('.skill-execution-status');
      if (status?.dataset.state === 'saved') _setSkillExecutionStatus(card, '', '');
    }, 1800);
  } catch (error) {
    _setSkillExecutionStatus(card, 'saving', 'Save failed — restoring…');
    let restored = prior;
    try { restored = await _reloadSkillExecution(skillId); } catch {}
    _skillExecutionSaved.set(skillId, restored);
    _applySkillExecutionToCard(card, restored);
    _setSkillExecutionStatus(card, 'error', `Failed: ${error.message || 'save failed'}`);
  } finally {
    _setSkillExecutionDisabled(card, false);
  }
}

async function refreshSkillExecutionEfforts(skillId, event) {
  const card = _skillExecutionCard(skillId, event);
  if (!card) return;
  if (event?.type === 'toggle' && !event.target?.open) return;
  const selected = card.querySelector('.skill-execution-model')?.value || card.dataset.inheritedModel || '';
  const { provider, model } = _parseSkillExecutionModelValue(selected);
  if (!provider || !model) return;
  const effortSelect = card.querySelector('.skill-execution-effort');
  const current = effortSelect?.value || null;
  const requestId = (_skillExecutionEffortRequests.get(skillId) || 0) + 1;
  _skillExecutionEffortRequests.set(skillId, requestId);
  effortSelect?.setAttribute('aria-busy', 'true');
  try {
    const params = new URLSearchParams({ provider, model });
    const response = await fetch(`/api/reasoning-efforts?${params}`);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(result.options)) return;
    if (_skillExecutionEffortRequests.get(skillId) !== requestId) return;
    card._supportedExecutionEfforts = result.options;
    if (effortSelect) effortSelect.innerHTML = _skillExecutionEffortOptionsHtml(current, result.options);
  } catch {
    // The generic list remains usable if capability discovery is temporarily unavailable.
  } finally {
    if (_skillExecutionEffortRequests.get(skillId) === requestId) effortSelect?.removeAttribute('aria-busy');
  }
}

function refreshSkillExecutionModelSelects() {
  document.querySelectorAll('.skill-execution-settings').forEach(card => {
    const saved = _skillExecutionSaved.get(card.dataset.skillId) || _normalizeSkillExecution(null);
    _applySkillExecutionToCard(card, saved);
  });
}

async function loadSkillsList() {
  const rolesEl = $('rolesList');
  const skillsEl = $('skillsList');
  const customEl = $('customSkillsList');
  if (!rolesEl && !skillsEl && !customEl) return;
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  try {
    const [skills, allAgents, cfg] = await Promise.all([
      fetch('/api/roles').then(r => r.json()),
      fetch('/api/agents').then(r => r.json()),
      fetch('/api/config-public').then(r => r.json()).catch(() => ({})),
    ]);
    const roles = skills.filter(s => s.service);
    // A skill is "custom" iff it was installed under users/<id>/skills/ — the
    // API surfaces that as userScope=<id>. The manifest's `custom` field is
    // unreliable (some built-in role manifests historically set it too), so
    // we trust userScope as the single source of truth. Service roles are
    // always shown in the Roles section, never duplicated under Custom.
    const isCustom = (s) => !!s.userScope && !s.service && s.category !== 'delegate';
    const tools = skills.filter(s => !s.service && s.category !== 'delegate' && !isCustom(s));
    const customSkills = skills.filter(isCustom);
    const assignableAgents = (allAgents ?? []).filter(a => !a.archived);

    function roleCard(s) {
      const owner = s.assignment ? (allAgents.find(a => a.id === s.assignment) ?? null) : null;
      const delegationHtml = owner
        ? `<div style="font-size:10px;color:var(--muted);margin-top:3px">${escHtml(owner.emoji ?? '')} ${escHtml(owner.name)}</div>`
        : `<div style="font-size:10px;color:var(--muted);margin-top:3px;font-style:italic">Unassigned</div>`;
      const deleteBtn = isPriv
        ? `<button data-action="deleteRole" data-args='${JSON.stringify([s.id]).replace(/'/g, "&#39;")}' title="Delete"
             class="role-delete-btn"
             style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:14px;padding:4px 2px;flex-shrink:0;line-height:1">✕</button>`
        : '';
      return `<div class="skill-settings-card">
        <div class="skill-settings-card-head">
          <span style="font-size:20px;flex-shrink:0;margin-top:1px">${s.icon ?? '🎯'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text)">${escHtml(s.name)}</div>
            ${s.description ? `<div style="font-size:11px;color:var(--muted)">${escHtml(s.description)}</div>` : ''}
            ${delegationHtml}
          </div>
          ${deleteBtn}
        </div>
        ${_renderSkillExecutionControls(s, allAgents)}
      </div>`;
    }

    function toolCard(s) {
      return `<div class="skill-settings-card">
        <div class="skill-settings-card-head">
          <span style="font-size:18px;flex-shrink:0">${s.icon ?? '🔧'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text)">${escHtml(s.name)}</div>
            ${s.description ? `<div style="font-size:11px;color:var(--muted)">${escHtml(s.description)}</div>` : ''}
          </div>
        </div>
        ${_renderSkillExecutionControls(s, allAgents)}
      </div>`;
    }

    function customSkillCard(s) {
      const owner = s.assignment ? assignableAgents.find(a => a.id === s.assignment) : null;
      const ownerLabel = owner
        ? `${escHtml(owner.emoji ?? '')} ${escHtml(owner.name)}`
        : `<span style="color:var(--red)">Unassigned — no agent can use this</span>`;
      const options = ['<option value="">— Unassigned —</option>']
        .concat(assignableAgents.map(a =>
          `<option value="${escHtml(a.id)}"${a.id === s.assignment ? ' selected' : ''}>${escHtml(a.emoji ?? '')} ${escHtml(a.name)}</option>`
        )).join('');
      return `<div class="skill-settings-card">
        <div class="skill-settings-card-head">
          <span style="font-size:18px;flex-shrink:0;margin-top:1px">${s.icon ?? '🧩'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text)">${escHtml(s.name)}</div>
            ${s.description ? `<div style="font-size:11px;color:var(--muted)">${escHtml(s.description)}</div>` : ''}
            <div style="font-size:10px;color:var(--muted);margin-top:4px">Assigned to: ${ownerLabel}</div>
            <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
              <select data-change-action="assignCustomSkill" data-args='${JSON.stringify([s.id]).replace(/'/g, "&#39;")}'
                style="flex:1;min-width:0;background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 7px;font-size:11px">
                ${options}
              </select>
            </div>
          </div>
        </div>
        ${_renderSkillExecutionControls(s, allAgents)}
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
          html += `<button data-action="openNewRoleModal"
            class="new-role-btn"
            style="width:100%;background:var(--bg3);border:1px dashed var(--border);color:var(--muted);border-radius:8px;padding:9px;font-size:12px;cursor:pointer;margin-top:8px;font-weight:500">+ New Role</button>`;
        }
        rolesEl.innerHTML = html;
      }
    }

    // ── Custom skills panel ──
    if (customEl) {
      if (!isPriv && customSkills.length === 0) {
        customEl.innerHTML = `<div style="color:var(--muted);font-size:12px;font-style:italic">No custom skills yet. Ask the coordinator: "create a skill that …" to build one.</div>`;
      } else if (customSkills.length === 0) {
        customEl.innerHTML = `<div style="color:var(--muted);font-size:12px">No custom skills installed. Ask the coordinator to create one, or install one from the community catalog.</div>`;
      } else {
        customEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">` + customSkills.map(customSkillCard).join('') + `</div>`;
      }
    }

    // ── Tools panel — built-in (non-custom) tools only ──
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

function _closeNewRoleModal() { $('newRoleModal')?.remove(); }

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

async function assignCustomSkill(skillId, ev) {
  const agentId = ev?.target?.value || null;
  try {
    const r = await fetch('/api/roles/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId, agentId }),
    });
    if (!r.ok) throw new Error((await r.json()).error ?? 'Assignment failed');
    showToast(agentId ? 'Skill assigned' : 'Skill unassigned');
    _skillsCache = null;
    loadSkillsList();
  } catch (e) { showToast(e.message || 'Failed to assign'); loadSkillsList(); }
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
          <button data-action="_closeNewRoleModal"
            style="background:none;border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:8px 16px;font-size:12px;cursor:pointer">Cancel</button>
          <button data-action="submitNewRole"
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
