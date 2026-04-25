// ── Models (Settings drawer) ───────────────────────────────────────────────────
let allModels = [];
let customModels = JSON.parse(localStorage.getItem('oe_custom_models') || '[]');
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
      anthropicModels = data.map(m => ({ name: m.id, provider: 'anthropic', displayName: m.displayName }));
    }
  } catch {}
}

// Chat/reasoning models are populated dynamically from /api/grok-models so the list
// tracks whatever xAI currently exposes. Media (image/video) models don't appear on
// xAI's /v1/models, so we keep those as static slugs.
let grokChatModels = [];
const grokMediaModels = [
  { name: 'grok-imagine-image',     provider: 'grok', displayName: 'Grok Imagine (image)' },
  { name: 'grok-imagine-image-pro', provider: 'grok', displayName: 'Grok Imagine Pro (image)' },
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
      }));
    }
  } catch {}
}

let openrouterModels = [];

// OpenAI-compatible cloud providers — each populated lazily by loadCompatProviderModels()
// (defined in oauth.js) which writes into window._compatProviderModels[provider].
const COMPAT_PROVIDER_IDS = ['openai', 'openai-oauth', 'gemini', 'deepseek', 'mistral', 'groq', 'together', 'perplexity', 'zai'];
function getCompatProviderModels() {
  const out = [];
  const store = window._compatProviderModels ?? {};
  for (const p of COMPAT_PROVIDER_IDS) {
    for (const m of store[p] ?? []) {
      out.push({ name: m.id, provider: p, displayName: m.name ?? m.id, contextLen: m.contextLen ?? null });
    }
  }
  return out;
}

async function loadFireworksModels() {
  try {
    const data = await fetch('/api/fireworks-models').then(r => r.json());
    if (Array.isArray(data) && data.length) {
      fireworksModels = data.map(m => ({ name: m.id, provider: 'fireworks', displayName: m.displayName }));
    }
  } catch {}
}

async function loadOpenRouterModels() {
  try {
    const data = await fetch('/api/openrouter-models').then(r => r.json());
    if (Array.isArray(data) && data.length) {
      openrouterModels = data.map(m => ({ name: m.id, provider: 'openrouter', displayName: m.name, contextLen: m.contextLen }));
    }
  } catch {}
}

function allAvailableModels({ unfiltered = false } = {}) {
  const seen = new Set(), merged = [];
  const compatModels = getCompatProviderModels();
  for (const m of [...anthropicModels, ...allModels, ...customModels, ...fireworksModels, ...getGrokModels(), ...openrouterModels, ...compatModels]) {
    // Dedupe on provider+name so the same model ID from different providers coexists
    const key = `${m.provider}::${m.name}`;
    if (!seen.has(key)) { seen.add(key); merged.push(m); }
  }
  // Filter out disabled providers
  const filtered = merged.filter(m => typeof isProviderEnabled !== 'function' || isProviderEnabled(m.provider));
  // Unless unfiltered requested (admin UI), restrict to user's allowed models
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
  const order = ['anthropic', 'openai', 'openai-oauth', 'gemini', 'deepseek', 'mistral', 'groq', 'together', 'perplexity', 'zai', 'ollama-local', 'ollama-cloud', 'ollama', 'lmstudio', 'fireworks', 'grok', 'openrouter'];
  const labels = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    'openai-oauth': 'OpenAI (ChatGPT login)',
    gemini: 'Google Gemini',
    deepseek: 'DeepSeek',
    mistral: 'Mistral AI',
    groq: 'Groq',
    together: 'Together AI',
    perplexity: 'Perplexity',
    zai: 'Z.AI',
    ollama: 'Ollama',
    'ollama-local': 'Ollama (local)',
    'ollama-cloud': 'Ollama (cloud)',
    lmstudio: 'LM Studio',
    fireworks: 'Fireworks AI',
    grok: 'xAI Grok',
    openrouter: 'OpenRouter',
  };
  let html = '';
  for (const prov of order) {
    const list = byProvider[prov]; if (!list?.length) continue;
    html += `<div class="model-provider-label">${labels[prov]}</div>`;
    for (const m of list) {
      const meta = [];
      if (m.contextLen) meta.push(`${Math.round(m.contextLen/1000)}k ctx`);
      if (Array.isArray(m.capabilities) && m.capabilities.includes('tool_use')) meta.push('tools');
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

function renderAgentModelRows() {
  const models = allAvailableModels();
  if (!agents.length) { $('agentModelRows').innerHTML = '<div style="color:var(--muted)">No agents loaded.</div>'; return; }
  const anthropicOpts    = models.filter(m => m.provider === 'anthropic');
  const openaiOpts       = models.filter(m => m.provider === 'openai');
  const openaiOauthOpts  = models.filter(m => m.provider === 'openai-oauth');
  const geminiOpts       = models.filter(m => m.provider === 'gemini');
  const deepseekOpts     = models.filter(m => m.provider === 'deepseek');
  const mistralOpts      = models.filter(m => m.provider === 'mistral');
  const groqOpts         = models.filter(m => m.provider === 'groq');
  const togetherOpts     = models.filter(m => m.provider === 'together');
  const perplexityOpts   = models.filter(m => m.provider === 'perplexity');
  const zaiOpts          = models.filter(m => m.provider === 'zai');
  const ollamaAll        = models.filter(m => m.provider === 'ollama');
  const ollamaLocalOpts  = ollamaAll.filter(m => (m.tier ?? 'local') === 'local');
  const ollamaCloudOpts  = ollamaAll.filter(m => m.tier === 'cloud');
  const lmsOpts          = models.filter(m => m.provider === 'lmstudio');
  const fireworksOpts    = models.filter(m => m.provider === 'fireworks');
  const grokOpts         = models.filter(m => m.provider === 'grok');
  const openrouterOpts   = models.filter(m => m.provider === 'openrouter');
  function makeAgentModelSelect(a) {
    if (!models.length) return `<select onchange="assignModelToAgentFromSelect('${a.id}', this.value)"><option value="${escHtml(a.model)}||${a.provider ?? 'ollama'}" selected>${escHtml(a.model)}</option></select>`;
    const mkOpt = m => `<option value="${escHtml(m.name)}||${m.provider}" ${m.name === a.model && m.provider === a.provider ? 'selected' : ''}>${escHtml(m.displayName ?? m.name)}</option>`;
    return `<select onchange="assignModelToAgentFromSelect('${a.id}', this.value)">
      ${anthropicOpts.length  ? `<optgroup label="Anthropic">${anthropicOpts.map(mkOpt).join('')}</optgroup>`          : ''}
      ${openaiOpts.length     ? `<optgroup label="OpenAI ✨">${openaiOpts.map(mkOpt).join('')}</optgroup>`             : ''}
      ${openaiOauthOpts.length? `<optgroup label="OpenAI (ChatGPT login) 🔐">${openaiOauthOpts.map(mkOpt).join('')}</optgroup>` : ''}
      ${geminiOpts.length     ? `<optgroup label="Google Gemini 💎">${geminiOpts.map(mkOpt).join('')}</optgroup>`      : ''}
      ${deepseekOpts.length   ? `<optgroup label="DeepSeek 🧠">${deepseekOpts.map(mkOpt).join('')}</optgroup>`         : ''}
      ${mistralOpts.length    ? `<optgroup label="Mistral AI 🌬">${mistralOpts.map(mkOpt).join('')}</optgroup>`        : ''}
      ${groqOpts.length       ? `<optgroup label="Groq ⚡">${groqOpts.map(mkOpt).join('')}</optgroup>`                  : ''}
      ${togetherOpts.length   ? `<optgroup label="Together AI 👥">${togetherOpts.map(mkOpt).join('')}</optgroup>`      : ''}
      ${perplexityOpts.length ? `<optgroup label="Perplexity 🔍">${perplexityOpts.map(mkOpt).join('')}</optgroup>`     : ''}
      ${zaiOpts.length        ? `<optgroup label="Z.AI ⚡">${zaiOpts.map(mkOpt).join('')}</optgroup>`                  : ''}
      ${ollamaLocalOpts.length? `<optgroup label="Ollama (local)">${ollamaLocalOpts.map(mkOpt).join('')}</optgroup>`   : ''}
      ${ollamaCloudOpts.length? `<optgroup label="Ollama (cloud) ☁">${ollamaCloudOpts.map(mkOpt).join('')}</optgroup>` : ''}
      ${lmsOpts.length        ? `<optgroup label="LM Studio">${lmsOpts.map(mkOpt).join('')}</optgroup>`                : ''}
      ${fireworksOpts.length  ? `<optgroup label="Fireworks AI 🎨">${fireworksOpts.map(mkOpt).join('')}</optgroup>`    : ''}
      ${grokOpts.length         ? `<optgroup label="xAI Grok ⚡">${grokOpts.map(mkOpt).join('')}</optgroup>`           : ''}
      ${openrouterOpts.length   ? `<optgroup label="OpenRouter 🔀">${openrouterOpts.map(mkOpt).join('')}</optgroup>`   : ''}
    </select>`;
  }
  const roleLabel = sc => ({ general: 'Coordinator', email: 'Email', finance: 'Finance',
    web: 'Assistant', coding: 'Coder', code: 'Coder', coder: 'Coder', image_generator: 'Image Generator', role_video_generator: 'Video Generator', role_tutor: 'Tutor' }[sc] ?? (sc ? sc.charAt(0).toUpperCase() + sc.slice(1) : ''));
  $('agentModelRows').innerHTML = agents.map(a => {
    const role = roleLabel(a.skillCategory ?? a.toolSet);
    const isFireworks = a.provider === 'fireworks' || a.provider === 'grok';
    const outputDirRow = isFireworks ? `
      <div style="width:100%;display:flex;align-items:center;gap:6px;margin-top:2px">
        <span style="font-size:11px;color:var(--muted);white-space:nowrap;min-width:48px">Save to</span>
        <input type="text" id="outdir_${a.id}" value="${escHtml(a.outputDir ?? '')}" placeholder="e.g. /path/to/output/dir"
          style="flex:1;font-size:12px;font-family:monospace;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:5px 8px"
          onchange="saveAgentOutputDir('${a.id}', this.value)">
        <button onclick="openDirPicker('${a.id}')" title="Browse folders"
          style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:5px 8px;cursor:pointer;font-size:13px;flex-shrink:0">📁</button>
      </div>` : '';
    return `<div class="agent-model-row" style="flex-direction:column;align-items:stretch">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="min-width:80px"><div class="agent-name">${a.emoji} ${escHtml(a.name)}</div>${role ? `<div class="agent-role">${escHtml(role)}</div>` : ''}</div>
        ${makeAgentModelSelect(a)}
      </div>
      ${outputDirRow}
    </div>`;
  }).join('');
}

async function saveAgentOutputDir(agentId, val) {
  await fetch(`/api/agents/${agentId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outputDir: val.trim() || null }),
  });
  const r = await fetch('/api/agents');
  agents = await r.json();
}

// ── Directory Picker ──────────────────────────────────────────────────────────
let _dirPickerAgentId = null;
let _dirPickerCurrent = null;
let _dirPickerCallback = null; // generic callback override for non-agent dir picks

async function openDirPicker(agentId, opts = {}) {
  _dirPickerAgentId = agentId;
  _dirPickerCallback = opts.onSelect ?? null;
  const startPath = opts.startPath || (agentId ? $(`outdir_${agentId}`)?.value?.trim() : null)
    || (await fetch('/api/browse-dir').then(r => r.json()).catch(() => ({ path: '/home' }))).path;
  $('dirPickerOverlay').style.display = 'flex';
  await browseTo(startPath);
}

function closeDirPicker() {
  $('dirPickerOverlay').style.display = 'none';
  _dirPickerAgentId = null;
}

async function browseTo(dirPath) {
  _dirPickerCurrent = dirPath;
  $('dirPickerPath').textContent = dirPath;
  $('dirPickerList').innerHTML = '<div style="padding:12px 14px;color:var(--muted);font-size:13px">Loading…</div>';
  try {
    const data = await fetch(`/api/browse-dir?path=${encodeURIComponent(dirPath)}`).then(r => r.json());
    _dirPickerCurrent = data.path;
    $('dirPickerPath').textContent = data.path;
    let html = '';
    if (data.parent) {
      html += `<div class="dir-picker-item" onclick="browseTo('${escHtml(data.parent)}')">
        <span style="margin-right:8px">⬆️</span><span style="color:var(--muted)">..</span></div>`;
    }
    if (!data.entries?.length) {
      html += `<div style="padding:10px 14px;color:var(--muted);font-size:12px">${data.error ? '⚠ ' + escHtml(data.error) : 'No subfolders here.'}</div>`;
    } else {
      html += data.entries.map(e => {
        const full = data.path.replace(/\/$/, '') + '/' + e;
        return `<div class="dir-picker-item" onclick="browseTo('${escHtml(full)}')">
          <span style="margin-right:8px">📁</span>${escHtml(e)}</div>`;
      }).join('');
    }
    $('dirPickerList').innerHTML = html;
  } catch (e) {
    $('dirPickerList').innerHTML = `<div style="padding:12px 14px;color:var(--red,#e05c5c);font-size:12px">Error: ${escHtml(e.message)}</div>`;
  }
}

async function selectCurrentDir() {
  if (!_dirPickerCurrent) return;
  if (_dirPickerCallback) {
    await _dirPickerCallback(_dirPickerCurrent);
    closeDirPicker();
    return;
  }
  if (!_dirPickerAgentId) return;
  const input = $(`outdir_${_dirPickerAgentId}`);
  if (input) input.value = _dirPickerCurrent;
  await saveAgentOutputDir(_dirPickerAgentId, _dirPickerCurrent);
  closeDirPicker();
  showToast('Output folder saved');
}


async function assignModelToAgent(agentId, model, provider) {
  await fetch(`/api/agent-model/${agentId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, provider }),
  });
  const r = await fetch('/api/agents');
  agents = await r.json();
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
const BUILTIN_REASON_NAME = 'openensemble-reason-v1.q8_0.gguf';

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
    ? `<button type="button" onclick="installReasonRuntime('${runtime}')" style="font-size:11px;padding:3px 8px">Install our model</button>`
    : '';
  const note = st.note
    ? `<span style="font-size:11px;color:var(--muted)">${escHtml(st.note)}</span>`
    : '';
  const hintLine = hint
    ? `<span style="font-size:11px;color:var(--muted);display:block;line-height:1.2">${escHtml(hint)}</span>`
    : '';
  return `
    <label for="${id}" style="display:flex;align-items:center;gap:8px;padding:6px 0;opacity:${disabled ? 0.55 : 1};cursor:${disabled ? 'not-allowed' : 'pointer'}">
      <input type="radio" name="reasonRuntime" id="${id}" value="${runtime}"
             ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}
             onchange="selectReasonRuntime('${runtime}')">
      <span style="flex:1;display:flex;flex-direction:column;gap:2px">
        ${hintLine}
        <span style="font-weight:500">${escHtml(label)}</span>
      </span>
      ${note}
      ${installBtn}
    </label>`;
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
        <span style="flex:1;font-weight:500">OpenEnsemble Reason v1
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

const BUILTIN_PLAN_NAME = 'openensemble-plan-v12.q8_0.gguf';
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
    ? `<button type="button" onclick="installPlanRuntime('${runtime}')" style="font-size:11px;padding:3px 8px">Install our model</button>`
    : '';
  const note = st.note
    ? `<span style="font-size:11px;color:var(--muted)">${escHtml(st.note)}</span>`
    : '';
  const hintLine = hint
    ? `<span style="font-size:11px;color:var(--muted);display:block;line-height:1.2">${escHtml(hint)}</span>`
    : '';
  return `
    <label for="${id}" style="display:flex;align-items:center;gap:8px;padding:6px 0;opacity:${disabled ? 0.55 : 1};cursor:${disabled ? 'not-allowed' : 'pointer'}">
      <input type="radio" name="planRuntime" id="${id}" value="${runtime}"
             ${selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}
             onchange="selectPlanRuntime('${runtime}')">
      <span style="flex:1;display:flex;flex-direction:column;gap:2px">
        ${hintLine}
        <span style="font-weight:500">${escHtml(label)}</span>
      </span>
      ${note}
      ${installBtn}
    </label>`;
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
  const health = planHealthFor(current);

  const runtimeLabel = current === 'ollama' ? 'Ollama'
                      : current === 'lmstudio' ? 'LM Studio'
                      : 'built-in runtime';
  const warning = health === false
    ? `<div style="background:#f443361a;border:1px solid #f4433640;border-radius:6px;padding:8px 10px;font-size:12px;color:#f44336;margin-top:6px">
        ⚠ Scheduler model is unreachable via ${escHtml(runtimeLabel)}.
        Scheduling requests (reminders, recurring tasks) will fail until it's back online.
       </div>` : '';

  const externalHeader =
    `<div style="font-size:11px;color:var(--muted);margin:8px 0 2px 0;padding-top:6px;border-top:1px dashed var(--border-subtle)">
       Or run on GPU via an external runtime you already have · ~300 MB VRAM
     </div>`;
  const rows =
      planRuntimeRow({ runtime: 'builtin',  label: 'Built-in (CPU)', hint: 'in-process via llama.cpp — no external runtime', selected: current === 'builtin' })
    + externalHeader
    + planRuntimeRow({ runtime: 'ollama',   label: 'Via Ollama',     hint: '',                                                selected: current === 'ollama' })
    + planRuntimeRow({ runtime: 'lmstudio', label: 'Via LM Studio',  hint: '',                                                selected: current === 'lmstudio' });

  container.innerHTML = `
    <div class="agent-model-row" style="align-items:flex-start;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:10px;width:100%">
        <span class="agent-name" title="Fine-tuned adapter for scheduling: parse/decide/decompose/classify">📅 Plan</span>
        <span style="flex:1;font-weight:500">OpenEnsemble Plan v4
          <span style="font-size:11px;color:var(--muted);margin-left:6px;font-weight:400">pick where to run it</span>
        </span>
        ${cortexStatusDot(health)}
      </div>
      <div style="width:100%;padding-left:90px">${rows}</div>
    </div>
    ${warning}`;
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
  }
  if (name === 'system') {
    refreshLogs();
    loadReminderChannel();
    loadPlanRuntimeStatus().then(renderPlanModelRows);
  }
}

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
async function loadReminderChannel() {
  const sel = $('reminderChannelSelect');
  const status = $('reminderChannelStatus');
  if (!sel || !_currentUser) return;
  try {
    const r = await fetch(`/api/users/${_currentUser.id}`);
    if (!r.ok) return;
    const u = await r.json();
    sel.value = u.reminderChannel || 'websocket';
    if (status) status.textContent = '';
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

    // Poll /health until the server responds again, then reload.
    // The respawn script waits ~2s before starting node, so give it time.
    const deadline = Date.now() + 60_000;
    let up = false;
    await new Promise(r => setTimeout(r, 3000));
    while (Date.now() < deadline) {
      try {
        const h = await fetch('/health', { cache: 'no-store' });
        if (h.ok) { up = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 1000));
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
    if (!r.ok) { showToast('Failed to save Brave key'); return; }
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
          <button class="btn-drawer-x" onclick="closeAllDrawers()">✕</button>
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
          <input type="checkbox" ${p.enabled ? 'checked' : ''} onchange="toggleDrawerPlugin('${p.id}',this.checked)"
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
        onchange="updateDrawerTopic('news',${i},'label',this.value)">
      <input value="${escHtml(t.q)}" placeholder="Search query"
        style="flex:1;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 6px;font-size:11px"
        onchange="updateDrawerTopic('news',${i},'q',this.value)">
      <button onclick="removeDrawerTopic('news',${i})"
        style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:0 4px">×</button>
    </div>`).join('');
  return `
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:11px;color:var(--muted);width:100px;flex-shrink:0">Default tab</span>
        <select id="newsDefaultTopicSelect" onchange="saveNewsTopicPref(parseInt(this.value))"
          style="flex:1;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 8px;font-size:12px">
          ${topicOpts}
        </select>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Topics</div>
      <div id="newsTopicsRows">${rows}</div>
      <button onclick="addDrawerTopic('news')"
        style="margin-top:8px;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer">+ Add Topic</button>
    </div>`;
}

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

