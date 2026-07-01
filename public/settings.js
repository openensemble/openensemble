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
  { name: 'grok-imagine-image-pro', provider: 'grok', displayName: 'Grok Imagine Pro (image)', supportsImageGeneration: true, capabilities: ['image_generation'] },
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
  gemini:        'Google Gemini 💎',
  deepseek:      'DeepSeek 🧠',
  mistral:       'Mistral AI 🌬',
  groq:          'Groq ⚡',
  together:      'Together AI 👥',
  perplexity:    'Perplexity 🔍',
  zai:           'Z.AI ⚡',
};

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
  await fetch('/api/cortex-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  cortexCfg = { ...cortexCfg, ...update };
  renderCortexModelRows();
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
// measured 2026-04-29 on Shawn's dev box; YMMV depending on CPU. Through LM
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
  if (name === 'profile') { loadOAuthStatus(); loadActiveSessions(); if (typeof loadTelegramUser === 'function') loadTelegramUser(); if (typeof renderAvatarPicker === 'function') renderAvatarPicker($('avatarPickerContainer')); if (typeof renderMirrorStatus === 'function') renderMirrorStatus(); if (typeof loadBraveApiKeyStatus === 'function') loadBraveApiKeyStatus(); }
  if (name === 'skills') loadSkillsList();
  if (name === 'plugins') renderDrawersSettings();
  if (name === 'tasks') {
    $('stAgent').innerHTML = agents.map(a => `<option value="${a.id}">${a.emoji} ${a.name}</option>`).join('');
    loadTaskList();
    loadGmailAutoLabel();
    loadReminderChannel();
  }
  if (name === 'system') {
    loadPlanRuntimeStatus().then(renderPlanModelRows);
    if (typeof loadTunnelStatus === 'function') loadTunnelStatus();
    if (typeof loadTailscaleStatus === 'function') loadTailscaleStatus();
  }
  if (name === 'mcp' && typeof loadMcpServers === 'function') loadMcpServers();
  if (name === 'browser' && typeof loadBrowserBridge === 'function') loadBrowserBridge();
}

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
              <div style="font-weight:600;font-size:13px">${b.name || '(unnamed)'}${b.version ? ` <span style="color:var(--muted);font-weight:400;font-size:11px">v${b.version}</span>` : ''}</div>
              <div style="font-size:11px;color:var(--muted);font-family:monospace;margin-top:2px">extId: ${b.extId}</div>
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
    await fetch('/api/config', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visionProvider: provider, visionModel: model || undefined }),
    });
    showToast('Vision model saved', 2000);
  } catch { showToast('Failed to save'); }
}

// ── Strip thinking tags setting ───────────────────────────────────────────────
function setStripThinkingTrack(checked) {
  const track = $('stripThinkingTrack');
  if (track) track.style.background = checked ? 'var(--accent)' : 'var(--bg3)';
}
async function saveStripThinkingTags(checked) {
  setStripThinkingTrack(checked);
  try {
    await fetch('/api/config', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stripThinkingTags: checked }),
    });
    showToast(checked ? 'Thinking output will be hidden' : 'Thinking output will be shown', 2000);
  } catch { showToast('Failed to save setting'); }
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
async function loadActiveSessions() {
  const el = $('sessionsList');
  if (!el) return;
  el.innerHTML = `<div style="color:var(--muted)">Loading...</div>`;
  try {
    const r = await fetch('/api/sessions');
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
    el.innerHTML = list.map(s => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <div style="font-family:monospace">${s.tokenPrefix} ${s.current ? '<span style="color:var(--accent)">(this device)</span>' : ''}</div>
          <div style="color:var(--muted)">last activity: ${fmt(s.lastActivity)} · expires: ${fmt(s.expiresAt)}</div>
        </div>
        ${s.current ? '' : `<button class="btn-sm" data-revoke="${s.tokenPrefix}">Revoke</button>`}
      </div>
    `).join('');
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
    await fetch('/api/config', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionExpiryHours: hours }),
    });
    showToast('Session expiry saved!', 2000);
  } catch { showToast('Failed to save setting'); }
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
      btn.setAttribute('onclick', `toggleDrawer('${drawerId}','${btnId}')`);
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
    await fetch('/api/drawers/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pluginId: drawerId, enabled }),
    });
    const idx = drawers.findIndex(p => p.id === drawerId);
    if (idx !== -1) drawers[idx].enabled = enabled;
    applyDrawerVisibility();
    renderDrawersSettings();
  } catch {}
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

// ── MCP Servers panel ─────────────────────────────────────────────────────────
// Lists user's MCP servers with live status, lets the user add/remove and
// assign to agents. Mutations require non-child role (server enforces too).
async function loadMcpServers() {
  const body = $('mcpServersBody');
  if (!body) return;
  try {
    const r = await fetch('/api/mcp/servers').then(r => r.json());
    renderMcpServers(r.servers ?? []);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">Failed to load MCP servers: ${escHtml(e.message)}</div>`;
  }
}

function renderMcpServers(servers) {
  const body = $('mcpServersBody');
  if (!body) return;
  const statusBadge = (s) => {
    const colorMap = {
      ready:      'var(--green, #4caf50)',
      connecting: 'var(--accent)',
      idle:       'var(--muted)',
      unknown:    'var(--muted)',
      error:      'var(--red, #e05c5c)',
    };
    const labelMap = {
      ready:      '✓ ready',
      connecting: '… connecting',
      idle:       'idle',
      unknown:    'not connected',
      error:      '⚠ error',
    };
    const color = colorMap[s.status] ?? 'var(--muted)';
    const label = labelMap[s.status] ?? s.status;
    return `<span style="font-size:11px;color:${color};font-weight:600">${escHtml(label)}</span>`;
  };
  // `agents` is declared in core.js (let-scoped, module-level), reachable
  // directly here without a window. prefix.
  const agentList = (typeof agents !== 'undefined' && Array.isArray(agents) ? agents : []).filter(a => a.id);

  const listHtml = servers.length === 0
    ? `<div style="font-size:12px;color:var(--muted);padding:10px 0">No MCP servers registered. Browse the catalog or add one manually below.</div>`
    : `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${servers.map(s => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:4px;flex-wrap:wrap">
            <div style="font-size:13px;font-weight:600">${escHtml(s.displayName ?? s.id)}</div>
            <div style="display:flex;gap:6px;align-items:center">${statusBadge(s)}
              <button data-action="openMcpEditDialog" data-args='${escHtml(JSON.stringify([s.id]))}' title="Edit this server's command/url" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer">Edit</button>
              ${s.status !== 'connecting' ? `<button data-action="reconnectMcpServer" data-args='${escHtml(JSON.stringify([s.id]))}' title="Disconnect and respawn this server" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer">Reconnect</button>` : ''}
              <button data-action="removeMcpServer" data-args='${escHtml(JSON.stringify([s.id]))}' style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer">Remove</button>
            </div>
          </div>
          ${s.transport === 'http'
            ? `<div style="font-size:11px;color:var(--muted);font-family:'Fira Code',monospace;word-break:break-all">${escHtml(s.url ?? '')}</div>${s.auth === 'oauth' ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">Auth: OAuth ${s.oauthScope ? `(scope: ${escHtml(s.oauthScope)})` : ''}</div>` : ''}`
            : `<div style="font-size:11px;color:var(--muted);font-family:'Fira Code',monospace;word-break:break-all">${escHtml(s.command ?? '')} ${escHtml((s.args ?? []).join(' '))}</div>`}
          ${s.transport === 'http' && s.auth === 'oauth' ? `
          <div style="margin-top:6px">
            <button data-action="authorizeMcpOAuth" data-args='${escHtml(JSON.stringify([s.id]))}' style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:4px 12px;font-size:11px;cursor:pointer;font-weight:600">${s.status === 'error' ? 'Re-authorize' : 'Authorize'}</button>
          </div>` : ''}
          ${s.toolCount != null ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">${s.toolCount} tools exposed</div>` : ''}
          ${s.lastError ? `<div style="font-size:11px;color:var(--red,#e05c5c);margin-top:4px">Last error: ${escHtml(s.lastError)}</div>` : ''}
          <div style="font-size:11px;color:var(--muted);margin-top:6px">Assigned to:
            ${(s.assignedToAgents ?? []).length === 0
              ? '<span style="opacity:0.6">none</span>'
              : (s.assignedToAgents ?? []).map(aid => `<span style="margin-left:4px;padding:1px 6px;background:var(--bg3);border-radius:4px">${escHtml(aid)} <button data-action="unassignMcpServer" data-args='${escHtml(JSON.stringify([s.id, aid]))}' title="Remove" style="background:none;border:none;color:var(--muted);cursor:pointer">×</button></span>`).join('')}
          </div>
          <div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <select id="mcpAssignSelect-${escHtml(s.id)}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:2px 6px;font-size:11px">
              <option value="">+ assign agent…</option>
              ${agentList.filter(a => !(s.assignedToAgents ?? []).includes(a.id)).map(a => `<option value="${escHtml(a.id)}">${escHtml(a.name ?? a.id)}</option>`).join('')}
            </select>
            <button data-action="assignMcpServer" data-args='${escHtml(JSON.stringify([s.id]))}' style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:600">Assign</button>
          </div>
        </div>
      `).join('')}</div>`;

  const formHtml = `
    <div style="display:flex;gap:8px;margin-bottom:10px;align-items:center">
      <button data-action="openMcpCatalog" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600">Browse catalog</button>
      <button data-action="refreshMcpServers" title="Reconnect to every server (use after fixing a config or starting a server that was offline)" style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer">Reconnect all</button>
      <span style="font-size:11px;color:var(--muted)">or add manually:</span>
    </div>
    <details style="border:1px dashed var(--border);border-radius:8px;padding:10px">
      <summary style="cursor:pointer;font-size:12px;font-weight:600">+ Add a server manually</summary>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
        <label style="font-size:11px;color:var(--muted)">Server id (alphanumeric + hyphen, no underscores)</label>
        <input id="mcpAddId" placeholder="github" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">Transport</label>
        <select id="mcpAddTransport" data-change-action="onMcpTransportChange" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <option value="stdio">stdio (local subprocess)</option>
          <option value="http">http (remote server)</option>
        </select>
        <div id="mcpStdioFields" style="display:flex;flex-direction:column;gap:6px">
          <label style="font-size:11px;color:var(--muted)">Command</label>
          <input id="mcpAddCommand" placeholder="npx" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <label style="font-size:11px;color:var(--muted)">Args (one per line)</label>
          <textarea id="mcpAddArgs" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-github" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;font-family:'Fira Code',monospace"></textarea>
          <label style="font-size:11px;color:var(--muted)">Environment variables (KEY=value, one per line — encrypted on disk)</label>
          <textarea id="mcpAddEnv" rows="3" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..." style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;font-family:'Fira Code',monospace"></textarea>
        </div>
        <div id="mcpHttpFields" style="display:none;flex-direction:column;gap:6px">
          <label style="font-size:11px;color:var(--muted)">URL</label>
          <input id="mcpAddUrl" placeholder="https://mcp.example.com/sse" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <label style="font-size:11px;color:var(--muted)">Authentication</label>
          <select id="mcpAddAuth" data-change-action="onMcpAuthChange" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
            <option value="headers">Static headers (PAT, API key)</option>
            <option value="oauth">OAuth (server runs the flow)</option>
          </select>
          <div id="mcpAuthHeadersFields" style="display:flex;flex-direction:column;gap:6px">
            <label style="font-size:11px;color:var(--muted)">Headers (HeaderName: value, one per line — encrypted on disk)</label>
            <textarea id="mcpAddHeaders" rows="3" placeholder="Authorization: Bearer xxx" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;font-family:'Fira Code',monospace"></textarea>
          </div>
          <div id="mcpAuthOauthFields" style="display:none;flex-direction:column;gap:6px">
            <label style="font-size:11px;color:var(--muted)">OAuth scope (optional — leave blank to use the server's default)</label>
            <input id="mcpAddOauthScope" placeholder="e.g. read write" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
            <div style="font-size:10px;color:var(--muted);line-height:1.4">After you save, an <strong>Authorize</strong> button appears on the server card. Click it to open the provider's consent screen in a new tab; tokens are stored encrypted under your account.</div>
          </div>
        </div>
        <button data-action="addMcpServer" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600;margin-top:6px;align-self:flex-start">Add server</button>
        <div id="mcpAddStatus" style="font-size:11px;color:var(--muted);min-height:14px"></div>
      </div>
    </details>`;
  body.innerHTML = listHtml + formHtml;
}

function onMcpTransportChange() {
  const t = $('mcpAddTransport')?.value ?? 'stdio';
  const stdioFields = $('mcpStdioFields');
  const httpFields = $('mcpHttpFields');
  if (stdioFields) stdioFields.style.display = t === 'stdio' ? 'flex' : 'none';
  if (httpFields)  httpFields.style.display  = t === 'http'  ? 'flex' : 'none';
}

function onMcpAuthChange() {
  const a = $('mcpAddAuth')?.value ?? 'headers';
  const hdr = $('mcpAuthHeadersFields');
  const oa  = $('mcpAuthOauthFields');
  if (hdr) hdr.style.display = a === 'headers' ? 'flex' : 'none';
  if (oa)  oa.style.display  = a === 'oauth'   ? 'flex' : 'none';
}

async function addMcpServer() {
  const id = $('mcpAddId')?.value.trim();
  const transport = $('mcpAddTransport')?.value ?? 'stdio';
  const status = $('mcpAddStatus');
  if (!id) {
    if (status) status.textContent = 'id is required.';
    return;
  }
  const body = { id, transport };
  if (transport === 'stdio') {
    const command = $('mcpAddCommand')?.value.trim();
    if (!command) { if (status) status.textContent = 'command is required for stdio.'; return; }
    body.command = command;
    body.args = ($('mcpAddArgs')?.value ?? '').split('\n').map(s => s.trim()).filter(Boolean);
    const envObj = {};
    for (const line of ($('mcpAddEnv')?.value ?? '').split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1);
      if (k) envObj[k] = v;
    }
    body.env = envObj;
  } else if (transport === 'http') {
    const url = $('mcpAddUrl')?.value.trim();
    if (!url) { if (status) status.textContent = 'url is required for http.'; return; }
    body.url = url;
    const authMode = $('mcpAddAuth')?.value ?? 'headers';
    if (authMode === 'oauth') {
      body.auth = 'oauth';
      const scope = $('mcpAddOauthScope')?.value.trim();
      if (scope) body.oauthScope = scope;
      body.headers = {};
    } else {
      const hdrs = {};
      for (const line of ($('mcpAddHeaders')?.value ?? '').split('\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const k = line.slice(0, colon).trim();
        const v = line.slice(colon + 1).trim();
        if (k) hdrs[k] = v;
      }
      body.headers = hdrs;
    }
  }
  if (status) status.textContent = 'Saving…';
  try {
    const r = await fetch('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error ?? 'add failed');
    if (status) status.textContent = `Added "${id}". Watching for connection…`;
    setTimeout(loadMcpServers, 800);
    setTimeout(loadMcpServers, 5000);
    setTimeout(loadMcpServers, 20000);
  } catch (e) {
    if (status) status.textContent = `Add failed: ${e.message}`;
  }
}

async function removeMcpServer(id) {
  if (!confirm(`Remove MCP server "${id}"? Its tools will disappear from all assigned agents.`)) return;
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(`Remove failed: ${data.error ?? r.status}`);
      return;
    }
    loadMcpServers();
  } catch (e) {
    alert(`Remove failed: ${e.message}`);
  }
}

async function assignMcpServer(serverId) {
  const sel = $(`mcpAssignSelect-${serverId}`);
  const agentId = sel?.value;
  if (!agentId) return;
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(`Assign failed: ${data.error ?? r.status}`);
      return;
    }
    loadMcpServers();
  } catch (e) {
    alert(`Assign failed: ${e.message}`);
  }
}

async function authorizeMcpOAuth(serverId) {
  // Start the flow via the server, then open the returned authorization
  // URL in a popup. The callback page will postMessage on success.
  let authUrl;
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/oauth/start`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
    if (data.alreadyAuthorized) { alert('Already authorized — no action needed.'); return; }
    authUrl = data.authUrl;
  } catch (e) {
    alert(`Couldn’t start OAuth: ${e.message}`);
    return;
  }
  const popup = window.open(authUrl, 'mcp-oauth', 'width=560,height=720');
  if (!popup) { alert('Pop-up blocked. Allow popups for this site and try again.'); return; }
  const onMessage = (ev) => {
    if (ev?.data?.type === 'mcp-oauth-done' && ev.data.serverId === serverId) {
      window.removeEventListener('message', onMessage);
      setTimeout(loadMcpServers, 400);
    }
  };
  window.addEventListener('message', onMessage);
  // Safety: poll the panel a few times in case postMessage was blocked.
  setTimeout(loadMcpServers, 3000);
  setTimeout(loadMcpServers, 8000);
}



async function openMcpEditDialog(serverId) {
  // Pull fresh server data to pre-fill the form. Secrets (env values,
  // header values) come back redacted from the API — don't pre-fill
  // those; the user can remove + re-add the server if they need to
  // rotate them. Editing covers the common cases: "I typo'd the URL"
  // or "let me change the args."
  let cur;
  try {
    const r = await fetch('/api/mcp/servers').then(r => r.json());
    cur = (r.servers ?? []).find(s => s.id === serverId);
    if (!cur) { alert(`Server "${serverId}" not found.`); return; }
  } catch (e) {
    alert(`Couldn't load server: ${e.message}`); return;
  }
  const existing = document.getElementById('mcpEditModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'mcpEditModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  const stdioVis = cur.transport === 'stdio' ? 'flex' : 'none';
  const httpVis  = cur.transport === 'http'  ? 'flex' : 'none';
  const oauthVis = (cur.transport === 'http' && cur.auth === 'oauth') ? 'flex' : 'none';
  const headersVis = (cur.transport === 'http' && cur.auth !== 'oauth') ? 'flex' : 'none';
  modal.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;max-width:500px;width:100%;max-height:80vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0;font-size:14px">Edit "${escHtml(serverId)}"</h3>
        <button data-action="closeMcpEditModal" style="background:transparent;border:none;color:var(--muted);font-size:18px;cursor:pointer">×</button>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:12px">Secrets (env vars, auth headers, OAuth tokens) keep their current values automatically — only the fields you fill in get updated. To rotate a secret, remove and re-add the server.</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <label style="font-size:11px;color:var(--muted)">Display name</label>
        <input id="mcpEditDisplayName" value="${escHtml(cur.displayName ?? '')}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">Transport</label>
        <select id="mcpEditTransport" data-change-action="onMcpEditTransportChange" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <option value="stdio" ${cur.transport === 'stdio' ? 'selected' : ''}>stdio (local subprocess)</option>
          <option value="http" ${cur.transport === 'http' ? 'selected' : ''}>http (remote server)</option>
        </select>
        <div id="mcpEditStdioFields" style="display:${stdioVis};flex-direction:column;gap:6px">
          <label style="font-size:11px;color:var(--muted)">Command</label>
          <input id="mcpEditCommand" value="${escHtml(cur.command ?? '')}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <label style="font-size:11px;color:var(--muted)">Args (one per line)</label>
          <textarea id="mcpEditArgs" rows="3" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;font-family:'Fira Code',monospace">${escHtml((cur.args ?? []).join('\n'))}</textarea>
        </div>
        <div id="mcpEditHttpFields" style="display:${cur.transport === 'http' ? 'flex' : 'none'};flex-direction:column;gap:6px">
          <label style="font-size:11px;color:var(--muted)">URL</label>
          <input id="mcpEditUrl" value="${escHtml(cur.url ?? '')}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          <label style="font-size:11px;color:var(--muted)">Authentication</label>
          <select id="mcpEditAuth" data-change-action="onMcpEditAuthChange" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
            <option value="headers" ${cur.auth !== 'oauth' ? 'selected' : ''}>Static headers (PAT, API key)</option>
            <option value="oauth"   ${cur.auth === 'oauth' ? 'selected' : ''}>OAuth</option>
          </select>
          <div id="mcpEditOauthScopeWrap" style="display:${oauthVis};flex-direction:column;gap:6px">
            <label style="font-size:11px;color:var(--muted)">OAuth scope (optional)</label>
            <input id="mcpEditOauthScope" value="${escHtml(cur.oauthScope ?? '')}" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
          </div>
        </div>
        <button data-action="confirmMcpEdit" data-args='${escHtml(JSON.stringify([serverId]))}' style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600;margin-top:6px;align-self:flex-start">Save & reconnect</button>
        <div id="mcpEditStatus" style="font-size:11px;color:var(--muted);min-height:14px"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function closeMcpEditModal() { document.getElementById('mcpEditModal')?.remove(); }

function onMcpEditTransportChange() {
  const t = $('mcpEditTransport')?.value ?? 'stdio';
  const stdio = $('mcpEditStdioFields');
  const http  = $('mcpEditHttpFields');
  if (stdio) stdio.style.display = t === 'stdio' ? 'flex' : 'none';
  if (http)  http.style.display  = t === 'http'  ? 'flex' : 'none';
}

function onMcpEditAuthChange() {
  const a = $('mcpEditAuth')?.value ?? 'headers';
  const scopeWrap = $('mcpEditOauthScopeWrap');
  if (scopeWrap) scopeWrap.style.display = a === 'oauth' ? 'flex' : 'none';
}

async function confirmMcpEdit(serverId) {
  const transport = $('mcpEditTransport')?.value ?? 'stdio';
  const patch = {
    displayName: $('mcpEditDisplayName')?.value.trim() ?? '',
    transport,
  };
  if (transport === 'stdio') {
    patch.command = $('mcpEditCommand')?.value.trim() ?? '';
    patch.args = ($('mcpEditArgs')?.value ?? '').split('\n').map(s => s.trim()).filter(Boolean);
  } else {
    patch.url = $('mcpEditUrl')?.value.trim() ?? '';
    const authMode = $('mcpEditAuth')?.value ?? 'headers';
    if (authMode === 'oauth') {
      patch.auth = 'oauth';
      const scope = $('mcpEditOauthScope')?.value.trim();
      if (scope) patch.oauthScope = scope;
    } else {
      patch.auth = undefined;
    }
  }
  const status = $('mcpEditStatus');
  if (status) status.textContent = 'Saving…';
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
    closeMcpEditModal();
    setTimeout(loadMcpServers, 400);
    setTimeout(loadMcpServers, 3000);
  } catch (e) {
    if (status) status.textContent = `Save failed: ${e.message}`;
  }
}

function flashMcpBanner(text, kind = 'ok', ttlMs = 4000) {
  const body = $('mcpServersBody'); if (!body) return;
  let banner = document.getElementById('mcpRefreshBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mcpRefreshBanner';
    banner.style.cssText = 'font-size:11px;margin-bottom:8px;padding:6px 10px;border-radius:6px;transition:opacity 0.3s';
    body.prepend(banner);
  }
  banner.style.color = kind === 'err' ? 'var(--red, #e05c5c)' : 'var(--accent)';
  banner.style.background = kind === 'err' ? 'rgba(224,92,92,0.08)' : 'rgba(137,180,250,0.08)';
  banner.style.opacity = '1';
  banner.textContent = text;
  clearTimeout(banner._fadeTimer);
  banner._fadeTimer = setTimeout(() => {
    banner.style.opacity = '0';
    setTimeout(() => { try { banner.remove(); } catch {} }, 300);
  }, ttlMs);
}

async function reconnectMcpServer(serverId) {
  flashMcpBanner(`Reconnecting "${serverId}"…`, 'ok', 60000);
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/reconnect`, { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      flashMcpBanner(`Reconnect failed: ${data.error ?? r.status}`, 'err');
      return;
    }
    flashMcpBanner(`✓ Reconnected "${serverId}"`, 'ok');
    loadMcpServers();
  } catch (e) {
    flashMcpBanner(`Reconnect failed: ${e.message}`, 'err');
  }
}

async function refreshMcpServers() {
  flashMcpBanner('Reconnecting all servers…', 'ok', 60000);
  try {
    const r = await fetch('/api/mcp/refresh', { method: 'POST' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data?.error ?? `HTTP ${r.status}`);
    }
    flashMcpBanner('✓ Reconnected all servers', 'ok');
    await loadMcpServers();
  } catch (e) {
    flashMcpBanner(`Refresh failed: ${e.message}`, 'err');
  }
}

async function unassignMcpServer(serverId, agentId) {
  try {
    const r = await fetch(`/api/mcp/servers/${encodeURIComponent(serverId)}/unassign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(`Unassign failed: ${data.error ?? r.status}`);
      return;
    }
    loadMcpServers();
  } catch (e) {
    alert(`Unassign failed: ${e.message}`);
  }
}

// ── MCP catalog browser ───────────────────────────────────────────────────────
let _mcpCatalogCache = null;
async function openMcpCatalog() {
  if (!_mcpCatalogCache) {
    try {
      const r = await fetch('/api/mcp/catalog').then(r => r.json());
      _mcpCatalogCache = r.catalog ?? [];
    } catch (e) {
      alert(`Could not load catalog: ${e.message}`);
      return;
    }
  }
  // Render as a lightweight modal overlay anchored to the MCP panel.
  const existing = document.getElementById('mcpCatalogModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'mcpCatalogModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;max-width:680px;width:100%;max-height:80vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:14px">MCP server catalog</h3>
        <button data-action="closeMcpCatalog" style="background:transparent;border:none;color:var(--muted);font-size:18px;cursor:pointer">×</button>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:14px">Pick a template to pre-fill the Add form. You can edit anything before saving.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">
        ${_mcpCatalogCache.map(e => `
          <div style="border:1px solid var(--border);border-radius:8px;padding:10px;cursor:pointer" data-action="pickMcpCatalogEntry" data-args='${escHtml(JSON.stringify([e.id]))}'>
            <div style="font-size:18px;margin-bottom:4px">${escHtml(e.icon ?? '🔌')}</div>
            <div style="font-size:13px;font-weight:600;margin-bottom:2px">${escHtml(e.displayName)}</div>
            <div style="font-size:11px;color:var(--muted);line-height:1.4">${escHtml(e.description)}</div>
            <div style="font-size:10px;color:var(--muted);margin-top:6px">${escHtml(e.transport)} ${e.requiredEnv?.length ? ` · needs ${e.requiredEnv.length} secret(s)` : ''}</div>
          </div>
        `).join('')}
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function closeMcpCatalog() {
  document.getElementById('mcpCatalogModal')?.remove();
}

function pickMcpCatalogEntry(id) {
  const entry = (_mcpCatalogCache ?? []).find(e => e.id === id);
  if (!entry) return;
  closeMcpCatalog();
  // Open the manual-add details element if it's closed.
  const detailsBlocks = document.querySelectorAll('#mcpServersBody details');
  detailsBlocks.forEach(d => { d.open = true; });
  // Pre-fill the form fields.
  if ($('mcpAddId')) $('mcpAddId').value = entry.defaultServerId ?? entry.id;
  if ($('mcpAddTransport')) {
    $('mcpAddTransport').value = entry.transport;
    onMcpTransportChange();
  }
  if (entry.transport === 'stdio') {
    if ($('mcpAddCommand')) $('mcpAddCommand').value = entry.command ?? '';
    if ($('mcpAddArgs'))    $('mcpAddArgs').value    = (entry.args ?? []).join('\n');
    if ($('mcpAddEnv')) {
      const envLines = (entry.requiredEnv ?? []).map(e => `${e.key}=`).join('\n');
      $('mcpAddEnv').value = envLines;
    }
  } else if (entry.transport === 'http') {
    if ($('mcpAddUrl'))     $('mcpAddUrl').value     = entry.url ?? '';
    if ($('mcpAddHeaders')) {
      const hdrLines = (entry.requiredHeaders ?? []).map(h => `${h.key}: `).join('\n');
      $('mcpAddHeaders').value = hdrLines;
    }
  }
  // Status nudge so the user sees what to do next.
  const st = $('mcpAddStatus');
  if (st) {
    const needs = entry.requiredEnv?.length || entry.requiredHeaders?.length || 0;
    st.textContent = needs
      ? `Pre-filled. Fill in the ${needs} secret(s) above, then click Add.`
      : 'Pre-filled. Click Add to install.';
    st.style.color = 'var(--accent)';
  }
  // Scroll the form into view.
  $('mcpAddId')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('mcpAddId')?.focus();
}
