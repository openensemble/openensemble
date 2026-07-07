// ── Settings → Personalization tab ──────────────────────────────────────────
// Classic script (not a module) — public/ scripts share one global scope, so
// every entry point the HTML wires up via data-action/data-change-action is a
// bare `function` declaration (becomes a `window` property). Internal helpers
// and cached state are prefixed `_pz` to avoid colliding with the many other
// globals declared across public/*.js.
//
// Server contract: routes/personalization.mjs. This file deliberately does
// NOT assume a fixed JSON envelope for the GET responses (wrapped vs bare
// array) — it unwraps defensively so a shape choice on the route side doesn't
// break the panel. All calls are raw fetch (no wrapper exists in this repo).

let _pzConfig  = null;   // last-fetched config.json (defaults merged, per lib/personalization/config.mjs)
let _pzLeads   = [];     // open leads: {id, query, nextCheckAt, ...}
let _pzLoading = false;  // guards overlapping renderPersonalizationPanel() calls

// ── fetch helpers ────────────────────────────────────────────────────────────
async function _pzGetJson(url) {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
  let body = null;
  try { body = await r.json(); } catch { /* empty/non-JSON body */ }
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}
async function _pzMutate(url, method, payload) {
  const opts = { method, credentials: 'include' };
  if (payload !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(payload);
  }
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch { /* empty/non-JSON body */ }
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}

// Unwrap "{config: {...}, providers: [...]}" or a flattened response where
// config fields sit directly on the body — either way the config fields are
// readable off the returned object.
function _pzExtractConfig(data) {
  if (data && typeof data === 'object' && data.config && typeof data.config === 'object') return data.config;
  return (data && typeof data === 'object') ? data : {};
}
// Unwrap a bare array OR an object carrying the array under one of several
// plausible key names (route response shape isn't pinned down by the spec).
function _pzExtractArray(data, keys) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of keys) if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

// ── model picker (reuses settings.js's allAvailableModels(), same convention
// as the agent model picker) ─────────────────────────────────────────────────
function _pzGroupModels(models) {
  const groups = [];
  const push = (label, kind, list) => { if (list.length) groups.push({ label, kind, models: list }); };
  push('Anthropic', 'cloud', models.filter(m => m.provider === 'anthropic'));
  const compatMeta = (typeof window.getCompatProviderMeta === 'function') ? window.getCompatProviderMeta() : [];
  for (const p of compatMeta) push(p.label || p.id, 'cloud', models.filter(m => m.provider === p.id));
  const ollamaAll = models.filter(m => m.provider === 'ollama');
  push('Ollama (local)', 'local', ollamaAll.filter(m => (m.tier ?? 'local') === 'local'));
  push('Ollama (cloud)', 'cloud', ollamaAll.filter(m => m.tier === 'cloud'));
  push('LM Studio', 'local', models.filter(m => m.provider === 'lmstudio'));
  push('Fireworks AI', 'cloud', models.filter(m => m.provider === 'fireworks'));
  push('xAI Grok', 'cloud', models.filter(m => m.provider === 'grok'));
  push('OpenRouter', 'cloud', models.filter(m => m.provider === 'openrouter'));
  return groups;
}
function _pzCurrentModelValue(cfg) {
  const m = cfg?.model;
  if (m === 'off') return 'off';
  if (m == null || m === 'coordinator') return 'coordinator';
  if (typeof m === 'object' && m.model) return `${m.model}||${m.provider ?? ''}`;
  return 'coordinator';
}
function _pzModelSelectHtml(cfg, groups) {
  const current = _pzCurrentModelValue(cfg);
  let matched = current === 'off' || current === 'coordinator';
  let optionsHtml = '';
  for (const g of groups) {
    const opts = g.models.map(m => {
      const val = `${m.name}||${m.provider}`;
      const sel = val === current;
      if (sel) matched = true;
      return `<option value="${escHtml(val)}" ${sel ? 'selected' : ''}>${escHtml(m.displayName ?? m.name)}</option>`;
    }).join('');
    optionsHtml += `<optgroup label="${escHtml(g.label)}">${opts}</optgroup>`;
  }
  // The saved pick may point at a provider/model no longer enumerated (disabled
  // provider, model removed, etc.) — surface it instead of silently defaulting
  // the dropdown to something the user didn't choose.
  const fallbackOpt = (!matched && current !== 'off' && current !== 'coordinator')
    ? `<option value="${escHtml(current)}" selected>${escHtml(current.split('||')[0])} (unavailable)</option>`
    : '';
  return `<select id="pzModelSelect" data-change-action="setPersonalizationModel" data-change-args='["$value"]'
      style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:13px">
    <option value="off" ${current === 'off' ? 'selected' : ''}>Off</option>
    <option value="coordinator" ${current === 'coordinator' ? 'selected' : ''}>Same as coordinator (default)</option>
    ${fallbackOpt}
    ${optionsHtml}
  </select>`;
}
function _pzModelHintText(cfg, groups) {
  const current = _pzCurrentModelValue(cfg);
  if (current === 'off') return 'Reflection is turned off. The "Learn about me" switch above separately controls whether activity is even recorded.';
  if (current === 'coordinator') return "Inherits your coordinator agent's current model and provider — including its privacy posture.";
  for (const g of groups) {
    if (g.models.some(m => `${m.name}||${m.provider}` === current)) {
      return g.kind === 'local'
        ? 'Stays on this machine — nothing about your activity leaves this box.'
        : `Activity summaries — never raw content — are sent to ${g.label}.`;
    }
  }
  return 'Activity summaries — never raw content — are sent to this provider.';
}

// ── last-run line ────────────────────────────────────────────────────────────
function _pzFmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return String(iso); }
}
function _pzLastRunHtml(lastRun) {
  if (!lastRun || !lastRun.at) {
    return `<div style="font-size:11px;color:var(--muted)">Hasn't run yet — the next reflection (every 6 hours) will happen automatically, or click "Run now" below to try it right away.</div>`;
  }
  const modelLabel = lastRun.provider ? `${lastRun.model ?? '?'} (${lastRun.provider})` : (lastRun.model ?? '?');
  const parts = [`Last run: ${_pzFmtDate(lastRun.at)}`, modelLabel];
  if (lastRun.tokensIn != null || lastRun.tokensOut != null) parts.push(`${lastRun.tokensIn ?? 0}→${lastRun.tokensOut ?? 0} tokens`);
  const counts = [];
  if (lastRun.inferences != null) counts.push(`${lastRun.inferences} insight${lastRun.inferences === 1 ? '' : 's'}`);
  if (lastRun.offers != null) counts.push(`${lastRun.offers} offer${lastRun.offers === 1 ? '' : 's'}`);
  if (lastRun.leads != null) counts.push(`${lastRun.leads} lead${lastRun.leads === 1 ? '' : 's'}`);
  if (counts.length) parts.push(counts.join(', '));
  const line = `<div style="font-size:11px;color:var(--muted)">${parts.map(escHtml).join(' · ')}</div>`;
  const notice = lastRun.skipped || lastRun.notice
    ? `<div class="pz-notice">${escHtml(lastRun.notice || 'Last run was skipped.')}</div>`
    : '';
  return line + notice;
}

// ── leads ("Keeping an eye on") ──────────────────────────────────────────────
function _pzLeadsHtml() {
  if (!_pzLeads.length) {
    return `<div class="pz-empty">Nothing being tracked right now.</div>`;
  }
  return _pzLeads.map(l => {
    const next = l.nextCheckAt ? _pzFmtDate(l.nextCheckAt) : 'not scheduled';
    const idArg = JSON.stringify([l.id]).replace(/'/g, '&#39;');
    return `<div class="pz-row">
      <div class="pz-row-main">
        <div class="pz-row-text">${escHtml(l.query ?? '')}</div>
        <div class="pz-row-meta"><span class="pz-chip">next check ${escHtml(next)}</span></div>
      </div>
      <div class="pz-row-actions">
        <button class="pz-btn pz-btn-small pz-btn-danger" data-action="dismissPersonalizationLead" data-args='${idArg}'>Dismiss</button>
      </div>
    </div>`;
  }).join('');
}

// ── full panel render ────────────────────────────────────────────────────────
function _pzRenderPanelHtml() {
  const cfg = _pzConfig ?? {};
  const enabled = cfg.enabled !== false;
  const models = (typeof allAvailableModels === 'function') ? allAvailableModels() : [];
  const groups = _pzGroupModels(models);
  return `
    <div style="font-size:11px;color:var(--muted);margin-bottom:14px">
      The coordinator quietly learns from your activity — tool results, calendar, and session
      history — then reflects every 6 hours to notice patterns, remember facts, and offer to help.
      Offers are always ask-first; nothing runs automatically unless you say so.
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:16px">
      <div>
        <div style="font-weight:600;font-size:13px">Learn about me</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">Master switch — turns off both activity recording and reflection.</div>
      </div>
      <label class="provider-toggle"><input type="checkbox" ${enabled ? 'checked' : ''} data-change-action="togglePersonalization" data-change-args='["$checked"]'><span class="provider-toggle-slider"></span></label>
    </div>

    <div class="settings-section-title" style="margin-bottom:6px">Reflection model</div>
    <div class="settings-section-desc" style="margin-bottom:8px">Which model reflects on your activity every 6 hours.</div>
    ${_pzModelSelectHtml(cfg, groups)}
    <div class="pz-hint">${escHtml(_pzModelHintText(cfg, groups))}</div>

    <div style="margin-top:14px">${_pzLastRunHtml(cfg.lastRun)}</div>

    <div style="display:flex;gap:8px;margin:14px 0 20px">
      <button class="pz-btn pz-btn-accent" data-action="runPersonalizationNow">Run now</button>
      <button class="pz-btn pz-btn-danger" data-action="startFreshPersonalization">Start fresh</button>
    </div>

    <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Everything it has learned about you lives in the <b>Learn</b> drawer — see "What I've learned about you" there to review, confirm, or forget individual facts.</div>

    <div class="settings-section-title" style="border-top:1px solid var(--border);padding-top:14px;margin-top:16px;margin-bottom:8px">Keeping an eye on</div>
    <div class="pz-list">${_pzLeadsHtml()}</div>
  `;
}

// Loader branch entry point — switchSettingsTab('personalization') calls this.
async function renderPersonalizationPanel() {
  const root = $('stab-panel-personalization');
  if (!root) return;
  if (_pzLoading) return;
  _pzLoading = true;
  if (!_pzConfig) root.innerHTML = '<div style="font-size:12px;color:var(--muted)">Loading…</div>';
  try {
    const [configData, leadsData] = await Promise.all([
      _pzGetJson('/api/personalization/config'),
      _pzGetJson('/api/personalization/leads'),
    ]);
    _pzConfig = _pzExtractConfig(configData);
    _pzLeads  = _pzExtractArray(leadsData, ['leads', 'rows', 'items']);
    root.innerHTML = _pzRenderPanelHtml();
  } catch (e) {
    console.error('[personalization] failed to load panel:', e);
    root.innerHTML = `<div style="font-size:12px;color:var(--red,#e05c5c)">Couldn't load personalization settings (${escHtml(e?.message || 'unknown error')}). Try reopening this tab.</div>`;
  } finally {
    _pzLoading = false;
  }
}

// ── action handlers (global — wired via data-action / data-change-action) ──
async function togglePersonalization(checked) {
  try {
    await _pzMutate('/api/personalization/config', 'PATCH', { enabled: !!checked });
  } catch (e) {
    showToast(`Failed to update: ${e.message}`);
  }
  await renderPersonalizationPanel();
}

async function setPersonalizationModel(val) {
  let model;
  if (val === 'off' || val === 'coordinator') {
    model = val;
  } else {
    const idx = val.indexOf('||');
    if (idx === -1) { showToast('Invalid model selection'); await renderPersonalizationPanel(); return; }
    model = { model: val.slice(0, idx), provider: val.slice(idx + 2) };
  }
  try {
    await _pzMutate('/api/personalization/config', 'PATCH', { model });
  } catch (e) {
    showToast(`Failed to update model: ${e.message}`);
  }
  await renderPersonalizationPanel();
}

// Ledger row actions (confirm/forget) live in learn.js — the ledger renders
// in the Learn drawer as of 2026-07-07, not in this panel.

async function dismissPersonalizationLead(id) {
  try {
    await _pzMutate(`/api/personalization/leads/${encodeURIComponent(id)}`, 'DELETE');
  } catch (e) {
    showToast(`Failed to dismiss: ${e.message}`);
  }
  await renderPersonalizationPanel();
}

async function runPersonalizationNow(ev) {
  const btn = ev?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  try {
    await _pzMutate('/api/personalization/run', 'POST');
    showToast('Personalization run complete');
  } catch (e) {
    showToast(`Run failed: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Run now'; }
  }
  await renderPersonalizationPanel();
}

async function startFreshPersonalization() {
  if (!confirm("Forget everything the coordinator has inferred about you? Facts you've explicitly confirmed are kept.")) return;
  try {
    await _pzMutate('/api/personalization/start-fresh', 'POST');
    showToast('Inferred memories cleared');
  } catch (e) {
    showToast(`Failed: ${e.message}`);
  }
  await renderPersonalizationPanel();
}
