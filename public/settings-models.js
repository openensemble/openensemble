// Extracted from settings.js — pure move. Globals intentional.
// Section loaded via index.html before/after settings core as needed.

// ── Models (Settings drawer) ───────────────────────────────────────────────────
let allModels = [];
let drawers = [];

async function loadModels() {
  try { const r = await fetch('/api/models'); allModels = await r.json(); } catch { allModels = []; }
}

// Populated by loadFireworksModels(). Empty until the server confirms an API key
// is present — otherwise the dropdown would advertise Flux models the user can't
// actually call, and the "new agent" modal would default to Fireworks.
let fireworksModels = [];

// Anthropic chat models — populated dynamically from /api/anthropic-models so
// the UI reflects whatever models Anthropic currently exposes on the account's
// key, instead of a stale hardcoded list.
let anthropicModels = [];

async function loadAnthropicModels() {
  try {
    const data = await fetch('/api/anthropic-models').then(r => r.json());
    if (Array.isArray(data) && data.length) {
      anthropicModels = data.map(m => ({ name: m.id, provider: 'anthropic', displayName: m.displayName, supportsVision: m.supportsVision === true, supportsImageGeneration: m.supportsImageGeneration === true, capabilities: m.capabilities ?? [] }));
    }
  } catch {}
}

// Chat/reasoning models are populated dynamically from /api/grok-models so the list
// tracks whatever xAI currently exposes. Media (image/video) models don't appear on
// xAI's /v1/models, so we keep those as static slugs.
let grokChatModels = [];
const grokMediaModels = [
  { name: 'grok-imagine-image',     provider: 'grok', displayName: 'Grok Imagine (image)',     supportsImageGeneration: true, capabilities: ['image_generation'] },
  { name: 'grok-imagine-image-quality', provider: 'grok', displayName: 'Grok Imagine Quality (image)', supportsImageGeneration: true, capabilities: ['image_generation'] },
  { name: 'grok-imagine-video',     provider: 'grok', displayName: 'Grok Imagine (video)' },
];
function getGrokModels() {
  return [...grokChatModels, ...grokMediaModels];
}

async function loadGrokModels() {
  try {
    const data = await fetch('/api/grok-models').then(r => r.json());
    if (Array.isArray(data) && data.length) {
      grokChatModels = data.map(m => ({
        name: m.id,
        provider: 'grok',
        displayName: `${m.displayName ?? m.id} (chat)`,
        supportsVision: m.supportsVision === true,
        supportsImageGeneration: m.supportsImageGeneration === true,
        capabilities: m.capabilities ?? [],
      }));
    }
  } catch {}
}

let openrouterModels = [];

// OpenAI-compatible cloud providers — populated lazily by loadCompatProviderModels()
// (defined in oauth.js) which writes into window._compatProviderModels[provider].
// The list of provider IDs is sourced from window.getCompatProviderMeta() (also
// in oauth.js, refreshed by loadProviderConfig) so runtime-added providers via
// oe-admin's add_provider show up in the model picker without any code change.
function getCompatProviderIds() {
  const meta = typeof window.getCompatProviderMeta === 'function' ? window.getCompatProviderMeta() : [];
  return meta.map(p => p.id);
}
function getCompatProviderModels() {
  const out = [];
  const store = window._compatProviderModels ?? {};
  for (const p of getCompatProviderIds()) {
    for (const m of store[p] ?? []) {
      out.push({ name: m.id, provider: p, displayName: m.name ?? m.id, contextLen: m.contextLen ?? null, supportsVision: m.supportsVision === true, supportsImageGeneration: m.supportsImageGeneration === true, capabilities: m.capabilities ?? [] });
    }
  }
  return out;
}

async function loadFireworksModels() {
  try {
    const data = await fetch('/api/fireworks-models').then(r => r.json());
    if (Array.isArray(data) && data.length) {
      fireworksModels = data.map(m => ({ name: m.id, provider: 'fireworks', displayName: m.displayName, supportsVision: m.supportsVision === true, supportsImageGeneration: m.supportsImageGeneration === true, capabilities: m.capabilities ?? [] }));
    }
  } catch {}
}

async function loadOpenRouterModels() {
  try {
    const data = await fetch('/api/openrouter-models').then(r => r.json());
    if (Array.isArray(data) && data.length) {
      openrouterModels = data.map(m => ({ name: m.id, provider: 'openrouter', displayName: m.name, contextLen: m.contextLen, supportsVision: m.supportsVision === true, supportsImageGeneration: m.supportsImageGeneration === true, capabilities: m.capabilities ?? [] }));
    }
  } catch {}
}

// System-internal model names that show up via Ollama / built-in providers but
// aren't chat-capable (embedding, salience scoring, the reason GGUF). They power
// memory + cortex behind the scenes and must never appear in any user-facing
// model picker — picking one for an agent would render the agent unusable.
function _isSystemInternalModel(m) {
  if (m.provider === 'builtin') return true;
  const n = m.name ?? '';
  return n.startsWith('nomic-embed-text')
      || n.startsWith('openensemble-reason');
}

function allAvailableModels({ unfiltered = false } = {}) {
  const seen = new Set(), merged = [];
  const compatModels = getCompatProviderModels();
  for (const m of [...anthropicModels, ...allModels, ...fireworksModels, ...getGrokModels(), ...openrouterModels, ...compatModels]) {
    // Dedupe on provider+name so the same model ID from different providers coexists
    const key = `${m.provider}::${m.name}`;
    if (!seen.has(key)) { seen.add(key); merged.push(m); }
  }
  // Filter out disabled providers. Ollama is special: cloud and local share
  // m.provider==='ollama' but each has its own toggle (`ollama` for cloud,
  // `ollama-local` for local), so map per tier before checking.
  const providerKey = (m) => {
    if (m.provider !== 'ollama') return m.provider;
    return m.tier === 'local' ? 'ollama-local' : 'ollama';
  };
  const filtered = merged
    .filter(m => typeof isProviderEnabled !== 'function' || isProviderEnabled(providerKey(m)))
    .filter(m => !_isSystemInternalModel(m));
  // Unless unfiltered requested (admin UI), restrict to user's allowed models.
  if (!unfiltered && _currentUser?.allowedModels != null) {
    const allowed = new Set(_currentUser.allowedModels);
    return filtered.filter(m => allowed.has(m.name));
  }
  return filtered;
}

function groupModelsByProvider(models, { splitOllamaTier = false } = {}) {
  const out = {};
  for (const m of models) {
    let key = m.provider ?? 'other';
    if (splitOllamaTier && key === 'ollama') key = m.tier === 'cloud' ? 'ollama-cloud' : 'ollama-local';
    (out[key] ??= []).push(m);
  }
  return out;
}

function renderModelBrowser() {
  const el = $('modelBrowser'); if (!el) return;
  const models = allAvailableModels();
  const byProvider = groupModelsByProvider(models, { splitOllamaTier: true });
  // Built-in providers come first in a canonical order; runtime-added compat
  // providers (via oe-admin's add_provider) are appended at the end, after
  // the static entries, using their server-supplied displayName as the label.
  const compatMeta = (typeof window.getCompatProviderMeta === 'function' ? window.getCompatProviderMeta() : []);
  const compatLabels = Object.fromEntries(compatMeta.map(p => [p.id, p.label]));
  const compatIds = compatMeta.map(p => p.id);
  const staticOrder = ['anthropic', ...compatIds, 'ollama-local', 'ollama-cloud', 'ollama', 'lmstudio', 'fireworks', 'grok', 'openrouter'];
  const order = [...new Set(staticOrder)];
  const labels = {
    anthropic: 'Anthropic',
    ollama: 'Ollama',
    'ollama-local': 'Ollama (local)',
    'ollama-cloud': 'Ollama (cloud)',
    lmstudio: 'LM Studio',
    fireworks: 'Fireworks AI',
    grok: 'xAI Grok',
    openrouter: 'OpenRouter',
    ...compatLabels,
  };
  let html = '';
  for (const prov of order) {
    const list = byProvider[prov]; if (!list?.length) continue;
    html += `<div class="model-provider-label">${labels[prov]}</div>`;
    for (const m of list) {
      const meta = [];
      if (m.contextLen) meta.push(`${Math.round(m.contextLen/1000)}k ctx`);
      if (Array.isArray(m.capabilities) && m.capabilities.includes('tool_use')) meta.push('tools');
      if (m.supportsImageGeneration || (Array.isArray(m.capabilities) && m.capabilities.includes('image_generation'))) meta.push('image gen');
      if (m.loaded) meta.push('● loaded');
      const metaStr = meta.length ? `<span style="color:var(--muted);font-size:11px;margin-left:6px">${meta.join(' · ')}</span>` : '';
      const label = m.displayName && m.displayName !== m.name
        ? `${escHtml(m.displayName)} <span style="color:var(--muted);font-size:11px">(${escHtml(m.name)})</span>`
        : escHtml(m.name);
      html += `<div class="model-option"><span class="provider-dot dot-${m.provider}"></span>${label}${metaStr}</div>`;
    }
  }
  el.innerHTML = html || '<div style="padding:12px;color:var(--muted);font-size:13px">No models found.</div>';
}

// Pretty labels (with emoji) for the built-in compat providers in the agent
// model picker. Runtime-added compat providers (via oe-admin's add_provider)
// fall back to their plain server-supplied displayName.
const COMPAT_OPTGROUP_LABELS = {
  openai:        'OpenAI ✨',
  'openai-oauth':'OpenAI (ChatGPT login) 🔐',
  'xai-oauth':   'xAI Grok (SuperGrok) 🔐',
  gemini:        'Google Gemini 💎',
  deepseek:      'DeepSeek 🧠',
  mistral:       'Mistral AI 🌬',
  groq:          'Groq ⚡',
  together:      'Together AI 👥',
  perplexity:    'Perplexity 🔍',
  zai:           'Z.AI ⚡',
};

let _orchestrationSettings = null;
let _orchestrationSaving = false;
let _orchestrationLoadError = null;

function renderOrchestrationSettings() {
  const modeSel = $('orchestrationModeSelect');
  const primarySel = $('orchestrationPrimarySelect');
  const primaryRow = $('orchestrationPrimaryRow');
  const desc = $('orchestrationModeDescription');
  const status = $('orchestrationModeStatus');
  if (!modeSel || !primarySel || !primaryRow || !desc || !status) return;

  const data = _orchestrationSettings;
  if (!data) {
    modeSel.disabled = true;
    primarySel.disabled = true;
    desc.textContent = _orchestrationLoadError ? 'Agent setup is temporarily unavailable.' : 'Loading your setup…';
    status.textContent = _orchestrationLoadError || '';
    return;
  }
  const available = Array.isArray(data.availableAgents) ? data.availableAgents : [];
  const managed = data.managed === true || _currentUser?.role === 'child';
  const pendingPrimary = available.length === 0
    && (_currentUser?.orchestration?.pendingPrimary === true || data.pendingPrimary === true);
  const displayedMode = pendingPrimary || data.mode === 'single' ? 'single' : 'ensemble';
  modeSel.value = displayedMode;
  const singleOption = [...modeSel.options].find(option => option.value === 'single');
  if (singleOption) singleOption.disabled = available.length === 0;
  modeSel.disabled = managed || _orchestrationSaving;
  const preferredPrimary = data.primaryAgentId || data.recommendedPrimaryAgentId || null;
  primarySel.innerHTML = available.map(agent =>
    `<option value="${escHtml(agent.id)}"${agent.id === preferredPrimary ? ' selected' : ''}>${escHtml(agent.emoji || '')} ${escHtml(agent.name || agent.id)}</option>`
  ).join('');
  primarySel.disabled = managed || _orchestrationSaving || available.length < 2;
  primaryRow.style.display = displayedMode === 'single' && available.length ? 'flex' : 'none';

  if (pendingPrimary) {
    desc.textContent = 'Single-assistant setup is ready. Create and name the first assistant to finish setup.';
  } else if (managed) {
    desc.textContent = 'Your parent or administrator manages whether this account uses one assistant or an ensemble.';
  } else if (data.mode === 'single') {
    desc.textContent = 'One primary assistant handles every enabled skill. Your other agents, assignments, and histories stay parked and return unchanged if you switch back.';
  } else {
    desc.textContent = 'Your classic ensemble is active: separate agents keep their assigned roles and delegate work between them.';
  }
  status.textContent = _orchestrationSaving
    ? 'Saving…'
    : (pendingPrimary
      ? 'The first assistant becomes the primary automatically.'
      : (available.length === 0 ? 'Create an agent before enabling single-assistant mode.' : 'Changes apply to the next message.'));
}

async function loadOrchestrationSettings() {
  const userId = getCurrentUserId();
  if (!userId) return;
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(userId)}/orchestration`, {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    _orchestrationSettings = await response.json();
    if (_currentUser && Object.prototype.hasOwnProperty.call(_orchestrationSettings, 'pendingPrimary')) {
      _currentUser.orchestration = _orchestrationSettings.pendingPrimary === true
        ? { mode: 'single', pendingPrimary: true }
        : {
            mode: _orchestrationSettings.mode === 'single' ? 'single' : 'ensemble',
            ...(_orchestrationSettings.primaryAgentId
              ? { primaryAgentId: _orchestrationSettings.primaryAgentId }
              : {}),
          };
    } else if (_currentUser?.orchestration?.pendingPrimary === true) {
      if ((_orchestrationSettings.availableAgents || []).length > 0) {
        _currentUser.orchestration = {
          mode: _orchestrationSettings.mode === 'single' ? 'single' : 'ensemble',
          ...(_orchestrationSettings.primaryAgentId
            ? { primaryAgentId: _orchestrationSettings.primaryAgentId }
            : {}),
        };
      } else {
        // Backward-compatible fallback for servers that predate the explicit
        // pendingPrimary response field. The profile route exposes the raw
        // onboarding marker to its owner.
        const profileResponse = await fetch(`/api/users/${encodeURIComponent(userId)}`, { cache: 'no-store' });
        if (profileResponse.ok) {
          const profile = await profileResponse.json();
          if (profile?.orchestration) _currentUser.orchestration = profile.orchestration;
        }
      }
    }
    _orchestrationLoadError = null;
  } catch (e) {
    _orchestrationSettings = null;
    _orchestrationLoadError = `Couldn't load agent setup (${e.message}).`;
  }
  renderOrchestrationSettings();
}

async function _saveOrchestration(mode, primaryAgentId = null) {
  const userId = getCurrentUserId();
  if (!userId || _orchestrationSaving) return;
  if (typeof streaming !== 'undefined' && streaming) {
    showToast('Wait for the active reply to finish (or stop it) before switching modes.');
    renderOrchestrationSettings();
    return;
  }
  _orchestrationSaving = true;
  renderOrchestrationSettings();
  try {
    const response = await fetch(`/api/users/${encodeURIComponent(userId)}/orchestration`, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, ...(primaryAgentId ? { primaryAgentId } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    const availableAgents = _orchestrationSettings?.availableAgents || [];
    _orchestrationSettings = {
      ...body,
      availableAgents,
      managed: _orchestrationSettings?.managed === true,
      recommendedPrimaryAgentId: body.recommendedPrimaryAgentId
        || _orchestrationSettings?.recommendedPrimaryAgentId
        || null,
    };
    if (_currentUser) _currentUser.orchestration = { mode: body.mode, primaryAgentId: body.primaryAgentId ?? null };
    const projected = await fetch('/api/agents', { credentials: 'same-origin', cache: 'no-store' });
    if (projected.ok) {
      agents = await projected.json();
      if (typeof buildTabs === 'function') buildTabs();
      if (typeof buildAgentDrawer === 'function') buildAgentDrawer();
      renderAgentModelRows();
    }
    showToast(body.mode === 'single' ? 'Single-assistant mode enabled' : 'Agent ensemble restored');
  } catch (e) {
    showToast(e.message || 'Could not change agent setup');
  } finally {
    _orchestrationSaving = false;
    await loadOrchestrationSettings();
  }
}

async function saveOrchestrationMode(mode) {
  const normalized = mode === 'single' ? 'single' : 'ensemble';
  const primary = normalized === 'single'
    ? (_orchestrationSettings?.primaryAgentId || _orchestrationSettings?.recommendedPrimaryAgentId
      || $('orchestrationPrimarySelect')?.value
      || _orchestrationSettings?.availableAgents?.[0]?.id || null)
    : null;
  await _saveOrchestration(normalized, primary);
}

async function saveOrchestrationPrimary(primaryAgentId) {
  if (_orchestrationSettings?.mode !== 'single' || !primaryAgentId) return;
  await _saveOrchestration('single', primaryAgentId);
}

function renderAgentModelRows() {
  const models = allAvailableModels();
  if (!agents.length) { $('agentModelRows').innerHTML = '<div style="color:var(--muted)">No agents loaded.</div>'; return; }
  const anthropicOpts    = models.filter(m => m.provider === 'anthropic');
  const ollamaAll        = models.filter(m => m.provider === 'ollama');
  const ollamaLocalOpts  = ollamaAll.filter(m => (m.tier ?? 'local') === 'local');
  const ollamaCloudOpts  = ollamaAll.filter(m => m.tier === 'cloud');
  const lmsOpts          = models.filter(m => m.provider === 'lmstudio');
  const fireworksOpts    = models.filter(m => m.provider === 'fireworks');
  const grokOpts         = models.filter(m => m.provider === 'grok');
  const openrouterOpts   = models.filter(m => m.provider === 'openrouter');
  // Compat providers — driven by the server-supplied list so runtime-added
  // providers via oe-admin's add_provider appear here without any code change.
  const compatMeta = (typeof window.getCompatProviderMeta === 'function' ? window.getCompatProviderMeta() : []);
  function makeAgentModelSelect(a) {
    if (!models.length) return `<select data-change-action="assignModelToAgentFromSelect" data-change-args='${JSON.stringify([a.id, "$value"]).replace(/'/g, "&#39;")}'><option value="${escHtml(a.model)}||${a.provider ?? 'ollama'}" selected>${escHtml(a.model)}</option></select>`;
    const mkOpt = m => `<option value="${escHtml(m.name)}||${m.provider}" ${m.name === a.model && m.provider === a.provider ? 'selected' : ''}>${escHtml(m.displayName ?? m.name)}</option>`;
    const compatGroups = compatMeta.map(p => {
      const opts = models.filter(m => m.provider === p.id);
      if (!opts.length) return '';
      const label = COMPAT_OPTGROUP_LABELS[p.id] || p.label;
      return `<optgroup label="${escHtml(label)}">${opts.map(mkOpt).join('')}</optgroup>`;
    }).join('');
    return `<select data-change-action="assignModelToAgentFromSelect" data-change-args='${JSON.stringify([a.id, "$value"]).replace(/'/g, "&#39;")}'>
      ${anthropicOpts.length  ? `<optgroup label="Anthropic">${anthropicOpts.map(mkOpt).join('')}</optgroup>`          : ''}
      ${compatGroups}
      ${ollamaLocalOpts.length? `<optgroup label="Ollama (local)">${ollamaLocalOpts.map(mkOpt).join('')}</optgroup>`   : ''}
      ${ollamaCloudOpts.length? `<optgroup label="Ollama (cloud) ☁">${ollamaCloudOpts.map(mkOpt).join('')}</optgroup>` : ''}
      ${lmsOpts.length        ? `<optgroup label="LM Studio">${lmsOpts.map(mkOpt).join('')}</optgroup>`                : ''}
      ${fireworksOpts.length  ? `<optgroup label="Fireworks AI 🎨">${fireworksOpts.map(mkOpt).join('')}</optgroup>`    : ''}
      ${grokOpts.length         ? `<optgroup label="xAI Grok ⚡">${grokOpts.map(mkOpt).join('')}</optgroup>`           : ''}
      ${openrouterOpts.length   ? `<optgroup label="OpenRouter 🔀">${openrouterOpts.map(mkOpt).join('')}</optgroup>`   : ''}
    </select>`;
  }
  const roleLabel = sc => ({ general: 'Coordinator', email: 'Email', finance: 'Finance',
    web: 'Assistant', coding: 'Coder', code: 'Coder', coder: 'Coder', image_generator: 'Image Generator', role_video_generator: 'Video Generator', role_tutor: 'Tutor', role_home_assistant: 'Home Assistant' }[sc] ?? (sc ? sc.charAt(0).toUpperCase() + sc.slice(1) : ''));
  $('agentModelRows').innerHTML = agents.map(a => {
    const role = roleLabel(a.skillCategory ?? a.toolSet);
    return `<div class="agent-model-row">
      <div style="min-width:80px"><div class="agent-name">${a.emoji} ${escHtml(a.name)}</div>${role ? `<div class="agent-role">${escHtml(role)}</div>` : ''}</div>
      ${makeAgentModelSelect(a)}
    </div>`;
  }).join('');
}


async function assignModelToAgent(agentId, model, provider) {
  // PATCH /api/agents/:id is auth-gated and ownership-checked, so it works for
  // any user editing an agent they own. The legacy POST /api/agent-model/:id
  // path is admin-only (requirePrivileged) and 403s for regular users — which
  // looked like a UI revert because the row re-painted from the unchanged
  // server state.
  const r = await fetch(`/api/agents/${agentId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, provider }),
  });
  if (!r.ok) { showToast('Failed to update model'); return; }
  // The agent_list WS broadcast will refresh `agents` shortly; do an immediate
  // GET so the row reflects the change without waiting for the round-trip.
  agents = await fetch('/api/agents').then(r => r.json());
  renderAgentModelRows();
}
function assignModelToAgentFromSelect(agentId, val) {
  const [model, provider] = val.split('||');
  assignModelToAgent(agentId, model, provider);
}

let cortexCfg = {};
let cortexHealth = { embed: null, salience: null, signals: null };
let reasonRuntimeStatus = null;

async function loadCortexConfig() {
  try { const r = await fetch('/api/cortex-config'); cortexCfg = await r.json(); } catch { cortexCfg = {}; }
}

async function checkCortexHealth() {
  try { const r = await fetch('/api/cortex-health'); cortexHealth = await r.json(); }
  catch { cortexHealth = { embed: false, salience: false, signals: false }; }
}

async function loadReasonRuntimeStatus() {
  try {
    const r = await fetch('/api/reason-runtime/status');
    reasonRuntimeStatus = r.ok ? await r.json() : null;
  } catch { reasonRuntimeStatus = null; }
}

function cortexStatusDot(ok) {
  if (ok === null) return '<span style="color:var(--muted);font-size:11px">…</span>';
  return ok
    ? '<span style="color:#4caf50;font-size:13px" title="Reachable">●</span>'
    : '<span style="color:#f44336;font-size:13px" title="Unreachable — memory scoring disabled">●</span>';
}

// Memory lane is hard-wired to our fine-tuned model. The user's choice isn't
// "which model" (there's only one) — it's "which runtime runs it":
//   built-in  — in-process via node-llama-cpp (CPU, always available)
//   ollama    — their existing Ollama install (typically GPU)
//   lmstudio  — their existing LM Studio install (typically GPU)
// The last two require a one-time transfer of our GGUF into that runtime,
// which is what the "Install" button triggers via /api/reason-runtime/*.

const BUILTIN_EMBED_NAME  = 'nomic-embed-text-v1';
const BUILTIN_REASON_NAME = 'openensemble-reason-v3.q8_0.gguf';

function reasonRuntimeState(runtime) {
  const s = reasonRuntimeStatus;
  if (!s) return { available: false, installed: false, note: 'checking…' };
  if (runtime === 'builtin') {
    return {
      available: true,
      installed: s.builtin?.ggufPresent,
      note: s.builtin?.ggufPresent ? 'ready' : 'model file missing — re-run npm install',
    };
  }
  if (runtime === 'ollama') {
    const configured = s.ollama?.localConfigured;
    const reachable = s.ollama?.reachable;
    return {
      available: configured && reachable,
      installed: cortexCfg.reasonProvider === 'ollama' && cortexCfg.reasonModel === s.ollama?.tag,
      note: !configured
        ? 'Set Ollama (local) URL under Providers first'
        : (!reachable ? 'Local Ollama not responding' : ''),
    };
  }
  if (runtime === 'lmstudio') {
    return {
      available: s.lmstudio?.installed,
      installed: cortexCfg.reasonProvider === 'lmstudio' && cortexCfg.reasonModel === s.lmstudio?.modelId,
      note: s.lmstudio?.installed ? '' : 'LM Studio not detected',
    };
  }
  return { available: false, installed: false, note: '' };
}

function reasonRuntimeRow({ runtime, label, hint, selected }) {
  const st = reasonRuntimeState(runtime);
  const disabled = !st.available;
  const id = `reasonrt-${runtime}`;
  const installBtn = (runtime !== 'builtin' && st.available && !st.installed)
    ? `<button type="button" data-action="installReasonRuntime" data-args='${JSON.stringify([runtime]).replace(/'/g, "&#39;")}' style="font-size:11px;padding:3px 8px">Install our model</button>`
    : '';
  const note = st.note
    ? `<span style="font-size:11px;color:var(--muted)">${escHtml(st.note)}</span>`
    : '';
  const hintLine = hint
    ? `<span style="font-size:11px;color:var(--muted);display:block;line-height:1.2">${escHtml(hint)}</span>`
    : '';
  // LM Studio's Just-In-Time loading is off by default — without it, our model
  // 404s silently and reason degrades. Inline tip when the user picks lmstudio.
  const jitTip = (runtime === 'lmstudio' && selected)
    ? `<div style="font-size:11px;color:var(--muted);margin:0 0 4px 22px;line-height:1.3">
         💡 In LM Studio, enable <strong>Just-In-Time Model Loading</strong> (Developer settings) so the model auto-loads on demand — otherwise reason calls fail until you load it manually.
       </div>`
    : '';
  return `
    <label for="${id}" style="display:flex;align-items:center;gap:8px;padding:6px 0;opacity:${disabled ? 0.55 : 1};cursor:${disabled ? 'not-allowed' : 'pointer'}">
      <input type="radio" name="reasonRuntime" id="${id}" value="${runtime}"
             ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}
             data-change-action="selectReasonRuntime" data-change-args='${JSON.stringify([runtime]).replace(/'/g, "&#39;")}'>
      <span style="flex:1;display:flex;flex-direction:column;gap:2px">
        ${hintLine}
        <span style="font-weight:500">${escHtml(label)}</span>
      </span>
      ${note}
      ${installBtn}
    </label>
    ${jitTip}`;
}

// ── Local llama.cpp GPU server picker (cortex + plan) ────────────────────────
// One radio option ("Run on GPU (llama.cpp)") + a GPU dropdown, mirroring the
// STT GPU picker. Backed by /api/{plan,reason}-runtime/llamacpp* endpoints.
let _gpus = null;   // null = not loaded; [] = loaded (maybe empty)
async function ensureGpus() {
  if (_gpus !== null) return _gpus;
  try { const r = await fetch('/api/hardware/gpus').then(x => x.json()); _gpus = Array.isArray(r?.gpus) ? r.gpus : []; }
  catch { _gpus = []; }
  return _gpus;
}
function llamaGpuOptionsHtml(currentGpuId) {
  if (_gpus === null) {
    // Lazy-load on first render, then re-render once (null→[] guards against a loop).
    ensureGpus().then(() => { try { renderPlanModelRows(); } catch {} try { renderCortexModelRows(); } catch {} });
    return '<option>loading GPUs…</option>';
  }
  if (!_gpus.length) return '<option value="0">GPU 0</option>';
  // Pre-select the GPU the server is ACTUALLY pinned to (from status), not the
  // first card — otherwise the dropdown lies after a refresh and a stray change
  // could silently re-pin the model to the wrong GPU.
  return _gpus.map(g =>
    `<option value="${g.index}"${Number.isInteger(currentGpuId) && Number(g.index) === currentGpuId ? ' selected' : ''}>GPU ${g.index}: ${escHtml(g.name)}${g.memFreeMiB != null ? ` — ${(g.memFreeMiB / 1024).toFixed(1)} GB free` : ''}</option>`
  ).join('');
}
function llamaRuntimeRowHtml(kind, selected) {
  const radioName = kind === 'plan' ? 'planRuntime' : 'reasonRuntime';
  const a = JSON.stringify([kind]).replace(/'/g, '&#39;');
  // Live status for THIS model's llama.cpp server (running + pinned GPU).
  const lc = (kind === 'plan' ? planRuntimeStatus : reasonRuntimeStatus)?.llamacpp ?? {};
  // Running dot, mirroring the cortex reachability dot — green when the pinned
  // GPU server actually answers, red when selected but not responding.
  const runDot = selected
    ? (lc.running
        ? ' <span style="color:#4caf50;font-size:12px" title="Running on the GPU">●</span>'
        : ' <span style="color:#f44336;font-size:12px" title="Not responding">●</span>')
    : '';
  const gpuBlock = selected ? `
    <div style="margin:2px 0 4px 22px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-size:11px;color:var(--muted)">GPU</span>
      <select data-change-action="onLlamaGpuChange" data-change-args='${a}' style="font-size:12px;padding:3px 6px">${llamaGpuOptionsHtml(lc.gpuId)}</select>
      <button type="button" data-action="removeLlamaRuntime" data-args='${a}' style="font-size:11px;padding:3px 8px">Remove</button>
    </div>` : '';
  return `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer">
      <input type="radio" name="${radioName}" value="llamacpp" ${selected ? 'checked' : ''}
             data-change-action="selectLlamaRuntime" data-change-args='${a}'>
      <span style="flex:1;display:flex;flex-direction:column;gap:2px">
        <span style="font-weight:500">Run on GPU (llama.cpp)${runDot}</span>
        <span style="font-size:11px;color:var(--muted)">local GPU server — no Ollama/LM Studio needed; pick the card</span>
      </span>
    </label>
    ${gpuBlock}`;
}
async function selectLlamaRuntime(kind, ev) {
  const radio = ev?.target; if (radio) radio.disabled = true;
  const base = kind === 'plan' ? '/api/plan-runtime' : '/api/reason-runtime';
  try {
    await ensureGpus();
    const gpuId = (_gpus && _gpus.length) ? _gpus[0].index : 0;
    showToast(`Installing ${kind} GPU server (GPU ${gpuId})…`, 6000);
    const r = await fetch(`${base}/llamacpp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gpuId }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) alert(`Install failed: ${body.error ?? r.status}`);
    else showToast(`${kind === 'plan' ? 'Plan' : 'Cortex'} now on GPU ${gpuId} (llama.cpp)`);
  } catch (e) { alert(`Failed: ${e.message}`); }
  finally { if (radio) radio.disabled = false; }
  await loadPlanRuntimeStatus(); await loadCortexConfig();
  renderPlanModelRows(); renderCortexModelRows();
}
async function onLlamaGpuChange(kind, ev) {
  const gpuId = Number(ev?.target?.value);
  if (!Number.isInteger(gpuId)) return;
  const base = kind === 'plan' ? '/api/plan-runtime' : '/api/reason-runtime';
  try {
    const r = await fetch(`${base}/llamacpp-gpu`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gpuId }) });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error ?? r.status); }
    showToast(`${kind === 'plan' ? 'Plan' : 'Cortex'} moved to GPU ${gpuId} (~2s restart)`);
  } catch (e) { showToast(`GPU switch failed: ${e.message}`); }
}
async function removeLlamaRuntime(kind, ev) {
  if (!confirm('Remove the GPU server and switch this model back to CPU (built-in)?')) return;
  const base = kind === 'plan' ? '/api/plan-runtime' : '/api/reason-runtime';
  try {
    const r = await fetch(`${base}/llamacpp-uninstall`, { method: 'POST' });
    if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error ?? r.status); }
    showToast(`${kind === 'plan' ? 'Plan' : 'Cortex'} switched back to CPU`);
  } catch (e) { alert(`Remove failed: ${e.message}`); }
  await loadPlanRuntimeStatus(); await loadCortexConfig();
  renderPlanModelRows(); renderCortexModelRows();
}

function renderCortexModelRows() {
  // 'auto' resolves to 'builtin' at the backend; treat it the same in the UI.
  const reasonProv = (cortexCfg.reasonProvider === 'auto' || !cortexCfg.reasonProvider)
    ? 'builtin'
    : cortexCfg.reasonProvider;

  const embedDown  = cortexHealth.embed  === false;
  const reasonDown = cortexHealth.reason === false;
  const warning = (embedDown || reasonDown)
    ? `<div style="background:#f443361a;border:1px solid #f4433640;border-radius:6px;padding:8px 10px;font-size:12px;color:#f44336;margin-top:6px">
        ⚠ ${embedDown && reasonDown ? 'Embed and reason runtimes are' : embedDown ? 'Embed runtime is' : 'Reason runtime is'} unreachable.
        Memory scoring and signal detection are disabled until it's back online.
       </div>` : '';

  const externalHeader =
    `<div style="font-size:11px;color:var(--muted);margin:8px 0 2px 0;padding-top:6px;border-top:1px dashed var(--border-subtle)">
       Or run on GPU via an external runtime you already have · ~450 MB VRAM
     </div>`;
  const reasonRows =
      reasonRuntimeRow({ runtime: 'builtin',  label: 'Built-in (CPU)', hint: 'in-process via llama.cpp — no external runtime', selected: reasonProv === 'builtin' })
    + llamaRuntimeRowHtml('cortex', reasonProv === 'llamacpp')
    + externalHeader
    + reasonRuntimeRow({ runtime: 'ollama',   label: 'Via Ollama',     hint: '',                                                selected: reasonProv === 'ollama' })
    + reasonRuntimeRow({ runtime: 'lmstudio', label: 'Via LM Studio',  hint: '',                                                selected: reasonProv === 'lmstudio' });

  $('cortexModelRows').innerHTML = `
    <div class="agent-model-row" style="align-items:flex-start">
      <span class="agent-name" title="Converts text to vectors for semantic search">🔢 Embed</span>
      <span style="flex:1">
        <span style="font-weight:500">Nomic Embed (built-in)</span>
        <span style="font-size:11px;color:var(--muted);margin-left:6px">${escHtml(BUILTIN_EMBED_NAME)}</span>
      </span>
      ${cortexStatusDot(cortexHealth.embed)}
    </div>
    <div class="agent-model-row" style="align-items:flex-start;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:10px;width:100%">
        <span class="agent-name" title="Our fine-tuned multi-task adapter: salience/contradiction/signals/friction/summary">🧠 Reason</span>
        <span style="flex:1;font-weight:500">OpenEnsemble Reason
          <span style="font-size:11px;color:var(--muted);margin-left:6px;font-weight:400">pick where to run it</span>
        </span>
        ${cortexStatusDot(cortexHealth.reason)}
      </div>
      <div style="width:100%;padding-left:90px">${reasonRows}</div>
    </div>
    ${warning}`;
}

async function selectReasonRuntime(runtime) {
  const status = reasonRuntimeStatus;
  const update = { reasonProvider: runtime };
  if (runtime === 'builtin') {
    update.reasonModel = BUILTIN_REASON_NAME;
  } else if (runtime === 'ollama') {
    update.reasonModel = status?.ollama?.tag ?? 'openensemble-reason:v1';
  } else if (runtime === 'lmstudio') {
    update.reasonModel = status?.lmstudio?.modelId ?? 'openensemble/reason-v1';
  }
  try {
    await postJson('/api/cortex-config', update);
    cortexCfg = { ...cortexCfg, ...update };
    renderCortexModelRows();
  } catch (e) {
    showToast(e.message || 'Failed to switch reason runtime');
    renderCortexModelRows(); // re-render from unchanged cortexCfg to revert the pick
  }
}

async function installReasonRuntime(runtime) {
  const btn = event?.target; if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  try {
    const r = await fetch(`/api/reason-runtime/${runtime}`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(`Install failed: ${body.error ?? r.status}`);
      return;
    }
    // LM Studio caches its model list — without a rescan the file we just
    // dropped into its model tree won't show up. Tell the user so they don't
    // think the install silently failed.
    if (runtime === 'lmstudio') {
      alert('Installed. If LM Studio is running, click the 🔄 Refresh button in its "My Models" tab (or restart LM Studio) so it picks up the new model.');
    }
    // Surface the post-install smoke-call result. Catches the most common
    // silent-failure path: LM Studio JIT loading off → model file on disk
    // but not loaded → reason 404s. See lib/runtime-warn.mjs for the runtime
    // detection of the same case.
    if (body.smoke && !body.smoke.ok) alert(body.smoke.message);
    else if (body.smoke?.ok) showToast(body.smoke.message, 4000);
    await loadReasonRuntimeStatus();
    await loadCortexConfig();
    renderCortexModelRows();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Scheduler (plan) model runtime ────────────────────────────────────────────
// Parallel to reason runtime: our fine-tuned plan GGUF is the only valid model
// (it knows the <parse>/<decide>/<decompose>/<classify> prefix tokens), so the
// user's choice is which runtime hosts it. Same builtin/ollama/lmstudio split.

// Disk size = on-disk q8_0 GGUF; RAM ≈ disk size + KV cache + activation overhead
// (measured loaded size at idle from OE startup). cpuLatency is the average
// per-parse round-trip through node-llama-cpp on the builtin runtime,
// measured 2026-04-29 on a dev box; YMMV depending on CPU. Through LM
// Studio (GPU) or Ollama, latency is roughly half.
const PLAN_TIER_LABELS = {
  accurate: { name: 'Accurate', base: 'SmolLM2-360M', sizeMb: 370, ramMb: 700, cpuLatencyS: 5,  accNote: '95.6% smoke / 87.5% holdout', desc: 'best accuracy' },
};
let planRuntimeStatus = null;

async function loadPlanRuntimeStatus() {
  try {
    const r = await fetch('/api/plan-runtime/status');
    planRuntimeStatus = r.ok ? await r.json() : null;
  } catch { planRuntimeStatus = null; }
}

function planRuntimeState(runtime) {
  const s = planRuntimeStatus;
  if (!s) return { available: false, installed: false, note: 'checking…' };
  if (runtime === 'builtin') {
    return {
      available: true,
      installed: s.builtin?.ggufPresent,
      note: s.builtin?.ggufPresent ? 'ready' : 'model file missing — run scripts/fetch-plan-model.mjs',
    };
  }
  if (runtime === 'ollama') {
    const configured = s.ollama?.localConfigured;
    const reachable = s.ollama?.reachable;
    return {
      available: configured && reachable,
      installed: s.current === 'ollama',
      note: !configured
        ? 'Set Ollama (local) URL under Providers first'
        : (!reachable ? 'Local Ollama not responding' : ''),
    };
  }
  if (runtime === 'lmstudio') {
    return {
      available: s.lmstudio?.installed,
      installed: s.current === 'lmstudio',
      note: s.lmstudio?.installed ? '' : 'LM Studio not detected',
    };
  }
  return { available: false, installed: false, note: '' };
}

function planRuntimeRow({ runtime, label, hint, selected }) {
  const st = planRuntimeState(runtime);
  const disabled = !st.available;
  const id = `planrt-${runtime}`;
  const installBtn = (runtime !== 'builtin' && st.available && !st.installed)
    ? `<button type="button" data-action="installPlanRuntime" data-args='${JSON.stringify([runtime]).replace(/'/g, "&#39;")}' style="font-size:11px;padding:3px 8px">Install our model</button>`
    : '';
  const note = st.note
    ? `<span style="font-size:11px;color:var(--muted)">${escHtml(st.note)}</span>`
    : '';
  const hintLine = hint
    ? `<span style="font-size:11px;color:var(--muted);display:block;line-height:1.2">${escHtml(hint)}</span>`
    : '';
  const jitTip = (runtime === 'lmstudio' && selected)
    ? `<div style="font-size:11px;color:var(--muted);margin:0 0 4px 22px;line-height:1.3">
         💡 In LM Studio, enable <strong>Just-In-Time Model Loading</strong> (Developer settings) so the plan model auto-loads on demand — otherwise scheduling calls fail until you load it manually.
       </div>`
    : '';
  return `
    <label for="${id}" style="display:flex;align-items:center;gap:8px;padding:6px 0;opacity:${disabled ? 0.55 : 1};cursor:${disabled ? 'not-allowed' : 'pointer'}">
      <input type="radio" name="planRuntime" id="${id}" value="${runtime}"
             ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}
             data-change-action="selectPlanRuntime" data-change-args='${JSON.stringify([runtime]).replace(/'/g, "&#39;")}'>
      <span style="flex:1;display:flex;flex-direction:column;gap:2px">
        ${hintLine}
        <span style="font-weight:500">${escHtml(label)}</span>
      </span>
      ${note}
      ${installBtn}
    </label>
    ${jitTip}`;
}

function planHealthFor(current) {
  const s = planRuntimeStatus;
  if (!s) return null;
  if (current === 'builtin')  return !!s.builtin?.ggufPresent;
  if (current === 'ollama')   return !!(s.ollama?.localConfigured && s.ollama?.reachable);
  if (current === 'lmstudio') return !!s.lmstudio?.installed;
  return null;
}

function renderPlanModelRows() {
  const container = $('planModelRows');
  if (!container) return;
  const current = planRuntimeStatus?.current ?? 'builtin';
  const useBuiltin = planRuntimeStatus?.useBuiltinPlan !== false;
  const health = planHealthFor(current);

  const runtimeLabel = current === 'ollama' ? 'Ollama'
                      : current === 'lmstudio' ? 'LM Studio'
                      : 'built-in runtime';
  const warning = (useBuiltin && health === false)
    ? `<div style="background:#f443361a;border:1px solid #f4433640;border-radius:6px;padding:8px 10px;font-size:12px;color:#f44336;margin-top:6px">
        ⚠ Scheduler model is unreachable via ${escHtml(runtimeLabel)}.
        Scheduling requests (reminders, recurring tasks) will fail until it's back online.
       </div>` : '';

  // Toggle to bypass the plan model entirely. When off, scheduling routes
  // through the agent's set_reminder/schedule_task tools (~2s extra latency,
  // costs cloud tokens, but handles phrasings the plan model misses).
  const toggleId = 'usebuiltinplan-toggle';
  const toggleBlock = `
    <div style="margin:0 0 10px 0;padding:8px 10px;border:1px solid var(--border-subtle);border-radius:6px;background:rgba(0,0,0,0.02)">
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px;line-height:1.4">
        Fine-tuned model that interprets scheduling requests
        (&ldquo;remind me to&hellip;&rdquo;, &ldquo;every morning&hellip;&rdquo;).
        Picking Ollama or LM Studio pushes our model into that runtime.
      </div>
      <label for="${toggleId}" style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="${toggleId}" ${useBuiltin ? 'checked' : ''} data-change-action="setUseBuiltinPlan" data-change-args='["$checked"]'>
        <span style="flex:1;display:flex;flex-direction:column;gap:1px">
          <span style="font-weight:500">Use the built-in plan model</span>
          <span style="font-size:11px;color:var(--muted)">
            ${useBuiltin
              ? 'On — scheduling runs locally. Faster, free, and private. Disable to route scheduling through the agent&rsquo;s LLM instead.'
              : 'Off — scheduling routes through the agent&rsquo;s LLM. Slower (~2s extra), uses cloud tokens, but handles unusual phrasings better.'}
          </span>
        </span>
      </label>
    </div>`;

  const externalHeader =
    `<div style="font-size:11px;color:var(--muted);margin:8px 0 2px 0;padding-top:6px;border-top:1px dashed var(--border-subtle)">
       Or run on a GPU via an external runtime
     </div>`;
  // Tier picker is always visible — it controls which GGUF gets used across
  // all three runtimes. Switching tier while on an external runtime auto-
  // reinstalls the new GGUF into that runtime.
  // When useBuiltin is off, gray out the runtime/tier rows since they have no
  // effect (interceptor is bypassed entirely).
  const dimWrap = useBuiltin ? '' : 'opacity:0.4;pointer-events:none;';
  const tierBlock = planTierPicker(current);
  const rows = `<div style="${dimWrap}">`
    + tierBlock
    + planRuntimeRow({ runtime: 'builtin',  label: 'Built-in (CPU)', hint: 'in-process via llama.cpp — no external runtime', selected: current === 'builtin' })
    + llamaRuntimeRowHtml('plan', current === 'llamacpp')
    + externalHeader
    + planRuntimeRow({ runtime: 'ollama',   label: 'Via Ollama',     hint: '',                                                selected: current === 'ollama' })
    + planRuntimeRow({ runtime: 'lmstudio', label: 'Via LM Studio',  hint: '',                                                selected: current === 'lmstudio' })
    + '</div>';

  const headerLabel = (() => {
    const t = planRuntimeStatus?.builtin?.tier;
    if (current === 'builtin' && t && PLAN_TIER_LABELS[t]) return `OpenEnsemble Plan · ${PLAN_TIER_LABELS[t].name} (${PLAN_TIER_LABELS[t].base})`;
    return 'OpenEnsemble Plan';
  })();
  container.innerHTML = `
    <div class="agent-model-row" style="align-items:flex-start;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:10px;width:100%">
        <span class="agent-name" title="Fine-tuned adapter for scheduling: parse/decide/decompose/classify">📅 Plan</span>
        <span style="flex:1;font-weight:500">${escHtml(headerLabel)}
          <span style="font-size:11px;color:var(--muted);margin-left:6px;font-weight:400">pick where to run it</span>
        </span>
        ${cortexStatusDot(health)}
      </div>
      <div style="width:100%;padding-left:90px">${toggleBlock}${rows}</div>
    </div>
    ${warning}`;
}

async function setUseBuiltinPlan(enabled) {
  try {
    const res = await fetch('/api/plan-runtime/use-builtin-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (planRuntimeStatus) planRuntimeStatus.useBuiltinPlan = enabled;
    renderPlanModelRows();
  } catch (e) {
    alert(`Failed to update setting: ${e.message}`);
    // Re-render to revert the checkbox state on failure.
    renderPlanModelRows();
  }
}

// Tier picker (Fast vs Accurate). Indented under the Built-in row when
// builtin is the selected runtime. Switching downloads the chosen GGUF if
// not already on disk and hot-reloads the in-process model.
function planTierPicker(currentRuntime) {
  const tiers = planRuntimeStatus?.builtin?.tiers ?? {};
  const active = planRuntimeStatus?.builtin?.tier ?? 'accurate';
  const rows = Object.entries(PLAN_TIER_LABELS).map(([tier, meta]) => {
    const t = tiers[tier] ?? {};
    const id = `plantier-${tier}`;
    const sizeNote = t.present ? `${t.sizeMb} MB on disk` : `${meta.sizeMb} MB download`;
    const stats = `RAM ~${meta.ramMb} MB · CPU ~${meta.cpuLatencyS}s/parse · ${meta.accNote}`;
    return `
      <label for="${id}" style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer">
        <input type="radio" name="planTier" id="${id}" value="${tier}" ${tier === active ? 'checked' : ''}
               data-change-action="selectPlanTier" data-change-args='${JSON.stringify([tier]).replace(/'/g, "&#39;")}'>
        <span style="flex:1;display:flex;flex-direction:column;gap:1px">
          <span style="font-weight:500">${escHtml(meta.name)} <span style="font-size:11px;color:var(--muted);font-weight:400">— ${escHtml(meta.base)}, ${escHtml(meta.desc)}</span></span>
          <span style="font-size:11px;color:var(--muted)">${escHtml(sizeNote)} · ${escHtml(stats)}</span>
        </span>
      </label>`;
  }).join('');
  // Hint reflects what happens on switch: hot-reload for builtin, re-install
  // into the active external runtime for ollama/lmstudio.
  const switchNote = currentRuntime === 'builtin'
    ? 'Switching tier hot-reloads the in-process model.'
    : `Switching tier re-installs the GGUF into ${currentRuntime === 'ollama' ? 'Ollama' : 'LM Studio'}.`;
  return `
    <div style="margin:0 0 8px 22px;padding:6px 10px;border-left:2px solid var(--border-subtle);background:rgba(0,0,0,0.02)">
      <div style="font-size:11px;color:var(--muted);margin-bottom:2px">Model tier — affects every runtime below. ${escHtml(switchNote)}</div>
      ${rows}
    </div>`;
}

async function selectPlanTier(tier) {
  const currentProvider = planRuntimeStatus?.current ?? 'builtin';
  const tierName = PLAN_TIER_LABELS[tier]?.name ?? tier;
  const action = currentProvider === 'builtin'
    ? 'reload the in-process model'
    : currentProvider === 'ollama'
      ? 're-install the GGUF into Ollama (creates a new tag)'
      : 're-install the GGUF into LM Studio (creates a new model dir)';
  if (!confirm(`Switch plan model to "${tierName}"? Download if needed, then ${action}.`)) {
    await loadPlanRuntimeStatus();
    renderPlanModelRows();
    return;
  }
  const r = await fetch('/api/plan-runtime/builtin-tier', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(`Tier switch failed: ${body.error ?? r.status}`);
  } else if (body.externalPush && body.externalPush.ok === false) {
    alert(`Tier saved + builtin reloaded, but ${currentProvider} push failed: ${body.externalPush.error}`);
  }
  await loadPlanRuntimeStatus();
  renderPlanModelRows();
}

async function selectPlanRuntime(runtime) {
  if (runtime !== 'builtin') {
    // ollama/lmstudio require the install flow (transfer of GGUF) — the install
    // endpoint is what writes the provider config. Re-render so the radio
    // doesn't appear to have switched until the install actually finishes.
    renderPlanModelRows();
    return;
  }
  const r = await fetch('/api/plan-runtime/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'builtin' }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    alert(`Switch failed: ${body.error ?? r.status}`);
  }
  await loadPlanRuntimeStatus();
  renderPlanModelRows();
}

async function installPlanRuntime(runtime) {
  const btn = event?.target; if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  try {
    const r = await fetch(`/api/plan-runtime/${runtime}`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(`Install failed: ${body.error ?? r.status}`);
      return;
    }
    if (runtime === 'lmstudio') {
      alert('Installed. If LM Studio is running, click the 🔄 Refresh button in its "My Models" tab (or restart LM Studio) so it picks up the new model.');
    }
    if (body.smoke && !body.smoke.ok) alert(body.smoke.message);
    else if (body.smoke?.ok) showToast(body.smoke.message, 4000);
    await loadPlanRuntimeStatus();
    renderPlanModelRows();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function switchSettingsTab(name) {
  document.querySelectorAll('.stab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.stab-panel').forEach(p => p.classList.remove('active'));
  $(`stab-${name}`)?.classList.add('active');
  $(`stab-panel-${name}`)?.classList.add('active');
  if (name === 'agents') loadOrchestrationSettings();
  if (name === 'profile') { loadOAuthStatus(); loadActiveSessions(); if (typeof loadTelegramUser === 'function') loadTelegramUser(); if (typeof renderAvatarPicker === 'function') renderAvatarPicker($('avatarPickerContainer')); if (typeof renderMirrorStatus === 'function') renderMirrorStatus(); if (typeof loadBraveApiKeyStatus === 'function') loadBraveApiKeyStatus(); }
  if (name === 'skills') loadSkillsList();
  if (name === 'plugins') renderDrawersSettings();
  if (name === 'tasks') {
    $('stAgent').innerHTML = agents.map(a => `<option value="${escHtml(a.id)}">${escHtml(a.emoji)} ${escHtml(a.name)}</option>`).join('');
    loadTaskList();
    loadGmailAutoLabel();
    loadReminderChannel();
  }
  if (name === 'system') {
    loadPlanRuntimeStatus().then(renderPlanModelRows);
    if (typeof loadTunnelStatus === 'function') loadTunnelStatus();
    if (typeof loadTailscaleStatus === 'function') loadTailscaleStatus();
  }
  if (name === 'mcp' && typeof loadMcpServers === 'function') { loadMcpServers(); loadMcpTokens(); }
  if (name === 'browser' && typeof loadBrowserBridge === 'function') loadBrowserBridge();
  if (name === 'personalization' && typeof renderPersonalizationPanel === 'function') renderPersonalizationPanel();
}

