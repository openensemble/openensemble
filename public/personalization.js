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
let _pzProviders = [];   // server-authoritative configured provider targets
let _pzPolicies = [];    // automatic / muted offer-kind policies
let _pzInbox = [];       // durable proactive delivery events
let _pzHistory = [];     // privacy-bounded decision timeline
let _pzCoordinatorLabel = null;
let _pzCoordinatorUsable = null;
let _pzAllowedModels = null; // null = unrestricted; array = same-user account allowlist
let _pzProvidersError = null;
let _pzReflectionHealth = null; // privacy-safe server summary; never carries provider exception text
let _pzErrors = {};      // per-section load errors; never render an outage as "empty"
let _pzLoading = false;  // guards overlapping renderPersonalizationPanel() calls
let _pzMutation = false;
let _pzRefs = new Map();
let _pzModelChoices = new Map();

function _pzResetRefs() {
  _pzRefs = new Map();
  _pzModelChoices = new Map();
}
function _pzRef(value) {
  const key = `pz_${_pzRefs.size + 1}`;
  _pzRefs.set(key, value);
  return key;
}
function _pzRefFromEl(el) {
  return _pzRefs.get(el?.dataset?.pzKey);
}

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

// ── model picker ─────────────────────────────────────────────────────────────
// The server response is authoritative for configured providers and the local
// endpoint's live model names. allAvailableModels() only supplies friendly
// cloud labels/catalogs. This prevents image-only/unconfigured providers from
// leaking into the reflection picker.
function _pzTextCapableModel(m) {
  if (!m || m.provider === 'fireworks') return false;
  if (m.provider === 'grok' && /^grok-imagine-(image|video)/i.test(m.name || '')) return false;
  return true;
}
function _pzModelAllowed(name) {
  return !Array.isArray(_pzAllowedModels) || _pzAllowedModels.includes(name);
}
function _pzBuildModelGroups() {
  const catalog = (typeof allAvailableModels === 'function') ? allAvailableModels() : [];
  const groups = [];
  for (const provider of _pzProviders) {
    if (!provider?.configured || provider.supportsText === false || provider.id === 'fireworks') continue;
    const exactNames = Array.isArray(provider.models) ? provider.models : [];
    let choices = catalog.filter(m => m.provider === provider.id && _pzTextCapableModel(m) && _pzModelAllowed(m.name));
    if (exactNames.length) {
      const allowed = new Set(exactNames.filter(_pzModelAllowed));
      choices = choices.filter(m => allowed.has(m.name));
      const present = new Set(choices.map(m => m.name));
      for (const name of allowed) {
        if (!present.has(name)) choices.push({ name, displayName: name, provider: provider.id });
      }
    }
    const deduped = [...new Map(choices.map(m => [m.name, m])).values()];
    if (deduped.length) groups.push({
      label: provider.label || provider.id,
      kind: provider.kind === 'local' ? 'local' : 'cloud',
      provider: provider.id,
      models: deduped,
    });
  }
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
      const model = { model: m.name, provider: m.provider };
      const raw = `${model.model}||${model.provider}`;
      const token = `model_${_pzModelChoices.size + 1}`;
      _pzModelChoices.set(token, model);
      const sel = raw === current;
      if (sel) matched = true;
      return `<option value="${token}" ${sel ? 'selected' : ''}>${escHtml(m.displayName ?? m.name)}</option>`;
    }).join('');
    optionsHtml += `<optgroup label="${escHtml(g.label)}">${opts}</optgroup>`;
  }
  // The saved pick may point at a provider/model no longer enumerated (disabled
  // provider, model removed, etc.) — surface it instead of silently defaulting
  // the dropdown to something the user didn't choose.
  let fallbackOpt = '';
  if (!matched && current !== 'off' && current !== 'coordinator' && cfg?.model && typeof cfg.model === 'object') {
    if (_pzModelAllowed(cfg.model.model)) {
      const token = `model_${_pzModelChoices.size + 1}`;
      _pzModelChoices.set(token, { model: cfg.model.model, provider: cfg.model.provider });
      fallbackOpt = `<option value="${token}" selected>${escHtml(cfg.model.model)} (unavailable)</option>`;
    } else {
      fallbackOpt = '<option value="" selected disabled>Current model is no longer available</option>';
    }
  }
  return `<select id="pzModelSelect" ${_pzMutation ? 'disabled' : ''} data-change-action="setPersonalizationModel" data-change-args='["$value"]'
      style="width:100%;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 10px;font-size:13px">
    <option value="off" ${current === 'off' ? 'selected' : ''}>Off</option>
    <option value="coordinator" ${current === 'coordinator' ? 'selected' : ''} ${_pzCoordinatorUsable === false ? 'disabled' : ''}>Same as coordinator (default)</option>
    ${fallbackOpt}
    ${optionsHtml}
  </select>`;
}
function _pzModelHintText(cfg, groups) {
  const current = _pzCurrentModelValue(cfg);
  if (current === 'off') return 'Reflection is turned off. The "Learn about me" switch above separately controls whether activity is even recorded.';
  if (current === 'coordinator' && _pzCoordinatorUsable === false) {
    return _pzCoordinatorLabel
      ? `Your coordinator's ${_pzCoordinatorLabel} model cannot be used for text reflection. Choose another model.`
      : 'Your coordinator does not have a usable text model yet. Choose another model or configure the coordinator first.';
  }
  if (current === 'coordinator') return _pzCoordinatorLabel
    ? `Uses your coordinator's ${_pzCoordinatorLabel} model — including its privacy posture.`
    : "Inherits your coordinator agent's current model and provider — including its privacy posture.";
  const provider = cfg?.model && typeof cfg.model === 'object'
    ? _pzProviders.find(item => item?.id === cfg.model.provider)
    : null;
  if (provider) {
    return provider.kind === 'local'
      ? 'Stays on this machine — nothing about your activity leaves this box.'
      : `Reflection summaries are sent to ${provider.label || provider.id}. For an automatic follow-up you requested, a bounded read-only re-check result may also be sent so the model can judge whether it succeeded.`;
  }
  return 'Reflection summaries are sent to this provider. Requested automatic follow-ups may also send a bounded read-only re-check result for judging.';
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
  if (lastRun.tokensIn != null || lastRun.tokensOut != null) {
    parts.push(`${lastRun.tokensIn ?? 'n/a'}→${lastRun.tokensOut ?? 'n/a'} tokens`);
  }
  const counts = [];
  if (lastRun.inferences != null) counts.push(`${lastRun.inferences} insight${lastRun.inferences === 1 ? '' : 's'}`);
  if (lastRun.offers != null) counts.push(`${lastRun.offers} offer${lastRun.offers === 1 ? '' : 's'}`);
  if (lastRun.leads != null) counts.push(`${lastRun.leads} lead${lastRun.leads === 1 ? '' : 's'}`);
  if (counts.length) parts.push(counts.join(', '));
  return `<div style="font-size:11px;color:var(--muted)">${parts.map(escHtml).join(' · ')}</div>`;
}

function _pzHealthDate(value) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Not yet';
}

function _pzReflectionHealthHtml(health) {
  if (!health || typeof health !== 'object') return '';
  const status = ['healthy', 'idle', 'paused', 'model_unavailable'].includes(health.status)
    ? health.status : 'paused';
  const copy = {
    healthy: {
      title: 'Pattern learning is active',
      detail: 'The selected reflection model completed its latest run.',
    },
    idle: {
      title: health.reason === 'no_new_signal' ? 'No new activity to reflect on' : 'Pattern learning is ready',
      detail: health.reason === 'no_new_signal'
        ? 'The latest check found no new personalization signal, so no model call was needed.'
        : 'The selected reflection model is ready for its first run.',
    },
    paused: {
      title: 'Pattern learning is paused',
      detail: health.reason === 'personalization_off'
        ? 'Learn about me is off.'
        : health.reason === 'setup_incomplete'
          ? 'Personalization setup has not been completed.'
          : health.reason === 'model_off'
            ? 'The Reflection model selector is set to Off.'
            : health.reason === 'provider_error'
              ? 'The latest run could not complete with your selected provider.'
              : 'The latest reflection attempt could not complete safely.',
    },
    model_unavailable: {
      title: 'Pattern learning is paused',
      detail: health.reason === 'provider_not_configured'
        ? 'The selected provider is no longer configured.'
        : 'The selected reflection model is currently unavailable.',
    },
  }[status];
  const canChooseFallback = status === 'model_unavailable'
    || (status === 'paused' && ['model_off', 'provider_error', 'reflection_error'].includes(health.reason));
  const explicitLine = health.patternLearningPaused && health.explicitPreferencesAvailable
    && ['model_off', 'provider_error', 'model_unavailable', 'provider_not_configured'].includes(health.reason)
    ? '<div class="pz-health-note">Explicit preferences you state still work; only model-based pattern discovery is paused.</div>'
    : '';
  const fallbackLine = canChooseFallback
    ? '<div class="pz-health-note">If you want a fallback, choose it yourself in the Reflection model selector above. OpenEnsemble never switches models or providers automatically.</div>'
    : '';
  return `<section class="pz-health pz-health-${escHtml(status)}" role="status" aria-live="polite" aria-atomic="true">
    <div class="pz-health-title">${escHtml(copy.title)}</div>
    <div class="pz-health-detail">${escHtml(copy.detail)}</div>
    <div class="pz-health-times"><span>Last successful run: ${escHtml(_pzHealthDate(health.lastSuccessfulAt))}</span><span>Last attempt: ${escHtml(_pzHealthDate(health.lastAttemptAt))}</span></div>
    ${explicitLine}${fallbackLine}
  </section>`;
}

// ── leads ("Keeping an eye on") ──────────────────────────────────────────────
function _pzLeadsHtml() {
  if (_pzErrors.leads) return _pzSectionErrorHtml('watch list', _pzErrors.leads);
  if (!_pzLeads.length) {
    return `<div class="pz-empty">Nothing being tracked right now.</div>`;
  }
  return _pzLeads.map(l => {
    const next = l.nextCheckAt ? _pzFmtDate(l.nextCheckAt) : 'not scheduled';
    const key = _pzRef(l.id);
    return `<div class="pz-row">
      <div class="pz-row-main">
        <div class="pz-row-text">${escHtml(l.query ?? '')}</div>
        <div class="pz-row-meta"><span class="pz-chip">next check ${escHtml(next)}</span></div>
      </div>
      <div class="pz-row-actions">
        <button class="pz-btn pz-btn-small pz-btn-danger" data-action="dismissPersonalizationLead" data-args='["$el"]' data-pz-key="${key}">Dismiss</button>
      </div>
    </div>`;
  }).join('');
}

function _pzTitleKind(kind) {
  return String(kind || 'suggestion').replace(/[-_.]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _pzBehaviorsHtml() {
  if (_pzErrors.policies) return _pzSectionErrorHtml('behaviors', _pzErrors.policies);
  const active = _pzPolicies.filter(p => p.autoApproved || p.suppressed || p.safeAutoBlocked);
  if (!active.length) return '<div class="pz-empty">No automatic, ask-first, or muted suggestion types yet.</div>';
  return active.map(policy => {
    const key = _pzRef(policy.kind);
    const state = policy.suppressed
      ? (policy.autoApproved ? 'Muted · automatic when resumed' : 'Suggestions muted')
      : policy.autoApproved ? 'Runs automatically' : 'Ask first';
    const detail = policy.suppressed
      ? policy.suppressedAt
      : policy.autoApproved ? policy.autoApprovedAt : policy.autoApprovalRevokedAt;
    const expiry = policy.suppressed ? policy.suppressionExpiresAt : null;
    const controls = policy.suppressed
      ? `<button class="pz-btn pz-btn-small" data-action="resumePersonalizationKind" data-args='["$el"]' data-pz-key="${key}">${policy.safeAutoBlocked ? 'Resume · ask first' : 'Resume'}</button>
         ${policy.autoApproved ? `<button class="pz-btn pz-btn-small" data-action="revokePersonalizationAuto" data-args='["$el"]' data-pz-key="${key}">Ask first</button>` : ''}`
      : policy.autoApproved
        ? `<button class="pz-btn pz-btn-small" data-action="revokePersonalizationAuto" data-args='["$el"]' data-pz-key="${key}">Ask first</button>
           <button class="pz-btn pz-btn-small pz-btn-danger" data-action="mutePersonalizationKind" data-args='["$el"]' data-pz-key="${key}">Mute</button>`
        : `<button class="pz-btn pz-btn-small pz-btn-danger" data-action="mutePersonalizationKind" data-args='["$el"]' data-pz-key="${key}">Mute</button>`;
    return `<div class="pz-row">
      <div class="pz-row-main">
        <div class="pz-row-text">${escHtml(_pzTitleKind(policy.kind))}</div>
        <div class="pz-row-meta"><span class="pz-chip">${escHtml(state)}</span>${detail ? `<span class="pz-chip">since ${escHtml(_pzFmtDate(detail))}</span>` : ''}${expiry ? `<span class="pz-chip">until ${escHtml(_pzFmtDate(expiry))}</span>` : ''}</div>
      </div>
      <div class="pz-row-actions">${controls}</div>
    </div>`;
  }).join('');
}

function _pzInboxHtml() {
  if (_pzErrors.inbox) return _pzSectionErrorHtml('proactive activity', _pzErrors.inbox);
  if (!_pzInbox.length) return '<div class="pz-empty">No proactive activity yet.</div>';
  // Never page an active Stop/Undo receipt out of reach. Show every currently
  // controllable monitor, then fill the remainder with recent history.
  const controllable = _pzInbox.filter(event => Array.isArray(event?.metadata?.control?.actions)
    && event.metadata.control.actions.length > 0);
  const controllableIds = new Set(controllable.map(event => event.id));
  const recent = _pzInbox.filter(event => !controllableIds.has(event.id)).slice(0, 20);
  const display = [...controllable, ...recent];
  return display.map(event => {
    const eventKey = _pzRef(event.id);
    const controlEventId = typeof event?.metadata?.control?.eventId === 'string'
      && event.metadata.control.eventId ? event.metadata.control.eventId : event.id;
    const controlKey = controlEventId === event.id ? eventKey : _pzRef(controlEventId);
    const unread = event.status !== 'read';
    const controlActions = Array.isArray(event?.metadata?.control?.actions)
      ? event.metadata.control.actions : [];
    const preferenceId = typeof event?.why?.preferenceId === 'string' && event.why.preferenceId
      ? event.why.preferenceId : null;
    const editKey = preferenceId ? _pzRef(preferenceId) : null;
    const controls = [
      controlActions.includes('useful')
        ? `<button class="pz-btn pz-btn-small" data-action="feedbackPersonalizationEvent" data-args='["$el","useful"]' data-pz-key="${eventKey}">Useful</button>` : '',
      controlActions.includes('acted')
        ? `<button class="pz-btn pz-btn-small" data-action="feedbackPersonalizationEvent" data-args='["$el","acted"]' data-pz-key="${eventKey}">I used this</button>` : '',
      controlActions.includes('not_useful')
        ? `<button class="pz-btn pz-btn-small" data-action="feedbackPersonalizationEvent" data-args='["$el","not_useful"]' data-pz-key="${eventKey}">Not useful · ask next time</button>` : '',
      controlActions.includes('snooze')
        ? `<button class="pz-btn pz-btn-small" data-action="feedbackPersonalizationEvent" data-args='["$el","snooze"]' data-pz-key="${eventKey}">Snooze 7d</button>` : '',
      controlActions.includes('edit_preference') && editKey
        ? `<button class="pz-btn pz-btn-small" data-action="editPersonalizationPreference" data-args='["$el"]' data-pz-key="${editKey}">Edit preference</button>` : '',
      controlActions.includes('undo')
        ? `<button class="pz-btn pz-btn-small" data-action="controlPersonalizationEvent" data-args='["$el","undo"]' data-pz-key="${controlKey}">Undo · ask next time</button>` : '',
      controlActions.includes('stop')
        ? `<button class="pz-btn pz-btn-small pz-btn-danger" data-action="controlPersonalizationEvent" data-args='["$el","stop"]' data-pz-key="${controlKey}">Stop updates</button>` : '',
      unread
        ? `<button class="pz-btn pz-btn-small" data-action="readPersonalizationEvent" data-args='["$el"]' data-pz-key="${eventKey}">Mark read</button>` : '',
    ].filter(Boolean).join('');
    const explanation = _pzInboxExplanation(event);
    const mode = _pzInboxMode(event);
    return `<div class="pz-row ${unread ? 'pz-row-unread' : ''}">
      <div class="pz-row-main">
        <div class="pz-row-text">${escHtml(event.title || _pzTitleKind(event.kind))}</div>
        ${event.text ? `<div class="pz-row-detail">${escHtml(event.text)}</div>` : ''}
        <div class="pz-row-why"><b>Why this appeared:</b> ${escHtml(explanation)}</div>
        <div class="pz-row-meta"><span class="pz-chip">${escHtml(mode)}</span><span class="pz-chip">${escHtml(event.status || 'pending')}</span><span class="pz-chip">${escHtml(_pzFmtDate(event.createdAt))}</span></div>
      </div>
      ${controls ? `<div class="pz-row-actions">${controls}</div>` : ''}
    </div>`;
  }).join('');
}

function _pzInboxMode(event) {
  if (event?.kind === 'preference_monitor_activation' || event?.kind === 'preference_monitor_update') {
    if (event?.kind === 'preference_monitor_update'
      && event?.metadata?.executionState === 'uncertain') return 'Delivery uncertain';
    if (event?.kind === 'preference_monitor_update'
      && event?.metadata?.executionState === 'failed') return 'Delivery failed';
    return event?.metadata?.autonomy === 'approved' ? 'You approved this' : 'Safe initiative';
  }
  if (event?.kind === 'personalization_auto_offer') return 'Previously approved';
  if (event?.kind === 'lead_hit') return 'Requested follow-up';
  return 'Personalization';
}

function _pzInboxExplanation(event) {
  if (event?.why?.source === 'confirmed preference' && typeof event?.why?.statement === 'string'
    && event.why.statement.trim()) {
    return `You confirmed: “${event.why.statement.trim()}”`;
  }
  if (event?.kind === 'preference_monitor_activation') {
    const state = event?.metadata?.executionState;
    const approved = event?.metadata?.autonomy === 'approved';
    if (['failed', 'rolled_back', 'canceled'].includes(state)) {
      return 'A preference matched a skill, but its safety contract could not be verified, so the behavior remains ask-first.';
    }
    if (state === 'started') {
      return approved
        ? 'You approved this preference-based monitor; OpenEnsemble is verifying its exact private contract before it can run.'
        : 'A confirmed preference matched a reviewed informational skill; Safe initiative is verifying the private monitor before it can run.';
    }
    return approved
      ? 'You approved a skill to use this confirmed preference for one exact, private monitor. Its receipt and Stop/Undo controls remain available here.'
      : 'A confirmed preference matched a reviewed informational skill, so Safe initiative started this private, reversible monitor and recorded a receipt.';
  }
  if (event?.kind === 'preference_monitor_update') {
    if (event?.metadata?.executionState === 'uncertain') {
      return 'The external channel may already have accepted this update, so OpenEnsemble will not automatically resend the same occurrence. A distinct future update can still be delivered.';
    }
    if (event?.metadata?.executionState === 'failed') {
      return 'The external channel did not accept this update. OpenEnsemble will not loop on the same failed occurrence, but a distinct future update can still be delivered.';
    }
    return event?.metadata?.autonomy === 'approved'
      ? 'A private monitor you approved found an update relevant to its exact confirmed preference.'
      : 'A private monitor previously started through Safe initiative found an update relevant to a confirmed preference.';
  }
  if (event?.kind === 'personalization_auto_offer') {
    return 'You previously approved this suggestion type for automatic handling; this receipt records what it did.';
  }
  if (event?.kind === 'lead_hit') {
    return 'You asked OpenEnsemble to keep checking an earlier request, and it found an update.';
  }
  return 'Personalization surfaced this from a behavior or follow-up you enabled.';
}

function _pzHistoryHtml() {
  if (_pzErrors.history) return _pzSectionErrorHtml('decision history', _pzErrors.history);
  if (!_pzHistory.length) return '<div class="pz-empty">No decision history yet.</div>';
  return _pzHistory.slice(0, 12).map(event => `<div class="pz-history-row">
    <div>${escHtml(event.summary || _pzTitleKind(event.type))}</div>
    <div class="pz-history-meta">${escHtml(_pzFmtDate(event.at))} · ${escHtml(event.type || 'event')}</div>
  </div>`).join('');
}

function _pzSectionErrorHtml(label, message) {
  return `<div class="pz-empty pz-section-error">Couldn't load ${escHtml(label)} (${escHtml(message || 'unknown error')}).
    <button class="pz-link-btn" data-action="retryPersonalizationPanel">Retry</button></div>`;
}

function _pzProviderErrorHtml() {
  return _pzProvidersError
    ? `<div class="pz-notice">${escHtml(_pzProvidersError)} <button class="pz-link-btn" data-action="retryPersonalizationPanel">Retry</button></div>`
    : '';
}

function _pzSourceControlsHtml(cfg) {
  const sources = cfg.sources || {};
  const disabled = _pzMutation ? 'disabled' : '';
  const row = (key, title, detail) => `<label class="pz-control-row">
    <span><b>${escHtml(title)}</b><small>${escHtml(detail)}</small></span>
    <input type="checkbox" ${disabled} data-pz-source="${key}" ${sources[key] !== false ? 'checked' : ''} data-change-action="setPersonalizationSource" data-change-args='["${key}","$checked"]'>
  </label>`;
  return row('tools', 'Tool activity', 'Shape-only by default; a skill may retain up to three declared, bounded, secret-redacted lookup terms per call as weak interest evidence.')
    + row('calendar', 'Calendar', 'Upcoming event patterns; no full event bodies are stored here.')
    + row('sessions', 'Conversation summaries', 'The gist of recent coordinator conversations.');
}

function _pzRetentionHtml(cfg) {
  const value = Number(cfg.retentionDays) || 30;
  const choices = [7, 30, 90, 365];
  if (!choices.includes(value)) choices.push(value);
  choices.sort((a, b) => a - b);
  return choices.map(n => `<option value="${n}" ${n === value ? 'selected' : ''}>${n === 365 ? '1 year' : `${n} days`}</option>`).join('');
}

function _pzSetupHtml(cfg, groups) {
  return `<div class="pz-setup">
    <div class="pz-setup-kicker">First-time setup</div>
    <h3>Make personalization yours</h3>
    <p>OpenEnsemble can keep short activity summaries and use your chosen model to notice useful patterns. You control every source and can review or delete every fact.</p>
    <div class="settings-section-title">What may contribute</div>
    <div class="pz-controls">${_pzSourceControlsHtml(cfg)}</div>
    <div class="settings-section-title pz-section-gap">Reflection model</div>
    ${_pzModelSelectHtml(cfg, groups)}
    ${_pzProviderErrorHtml()}
    <div class="pz-hint">${escHtml(_pzModelHintText(cfg, groups))}</div>
    <div class="settings-section-title pz-section-gap">Engagement</div>
    <select id="pzSetupEngagement" class="pz-select" ${_pzMutation ? 'disabled' : ''} data-change-action="setPersonalizationEngagement" data-change-args='["$value"]'>
      <option value="quiet" ${_pzEngagement(cfg) === 'quiet' ? 'selected' : ''}>Quiet — learn for context only, no unsolicited offers</option>
      <option value="helpful" ${_pzEngagement(cfg) === 'helpful' ? 'selected' : ''}>Helpful — careful assistant; ask before standing watches</option>
      <option value="proactive" ${_pzEngagement(cfg) === 'proactive' ? 'selected' : ''}>Proactive — notice patterns, soft-confirm likes, engage when things change</option>
    </select>
    <div class="settings-section-title pz-section-gap">Safe initiative</div>
    <select id="pzSetupInitiative" class="pz-select" ${_pzMutation ? 'disabled' : ''}>
      <option value="suggest" ${cfg.initiativeMode !== 'safe_auto' ? 'selected' : ''}>Suggest first — always ask before starting something</option>
      <option value="safe_auto" ${cfg.initiativeMode === 'safe_auto' ? 'selected' : ''}>Act when safe — reviewed, informational, exactly reversible actions only</option>
    </select>
    <div class="pz-setup-actions">
      <button class="pz-btn" ${_pzMutation ? 'disabled' : ''} data-action="skipPersonalizationSetup">Not now</button>
      <button class="pz-btn pz-btn-accent" ${_pzMutation ? 'disabled' : ''} data-action="completePersonalizationSetup">Turn on personalization</button>
    </div>
  </div>`;
}

// ── full panel render ────────────────────────────────────────────────────────
function _pzRenderPanelHtml() {
  _pzResetRefs();
  const cfg = _pzConfig ?? {};
  const enabled = cfg.enabled !== false;
  const groups = _pzBuildModelGroups();
  if (cfg.setupComplete === false) return _pzSetupHtml(cfg, groups);
  const quiet = cfg.quietHours || { start: '22:00', end: '08:00' };
  const disabled = _pzMutation ? 'disabled' : '';
  return `
    <div style="font-size:11px;color:var(--muted);margin-bottom:14px">
      The coordinator quietly learns from your activity — tool results, calendar, and session
      history — then reflects every 6 hours to notice patterns, remember facts, and offer to help.
      <b>Engagement</b> chooses the relationship style: Quiet (context only), Helpful (careful
      assistant), or Proactive (notices repeated interest, soft-confirms preferences, and can
      propose standing watches). Ask-first suggestions appear in chat and run only after you
      approve them. If you enable Safe initiative, only reviewed, private, informational,
      exactly reversible monitors may start automatically; each one explains why it appeared
      and includes a receipt with Stop/Undo.
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:16px">
      <div>
        <div style="font-weight:600;font-size:13px">Learn about me</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">Master switch — turns off activity recording, reflection, and use of personalization-owned facts.</div>
      </div>
      <label class="provider-toggle"><input type="checkbox" ${enabled ? 'checked' : ''} ${disabled} data-change-action="togglePersonalization" data-change-args='["$checked"]'><span class="provider-toggle-slider"></span></label>
    </div>

    <div class="settings-section-title" style="margin-bottom:6px">Reflection model</div>
    <div class="settings-section-desc" style="margin-bottom:8px">Which model reflects on your activity every 6 hours.</div>
    ${_pzModelSelectHtml(cfg, groups)}
    ${_pzProviderErrorHtml()}
    <div class="pz-hint">${escHtml(_pzModelHintText(cfg, groups))}</div>

    ${_pzReflectionHealthHtml(_pzReflectionHealth)}
    <div style="margin-top:10px">${_pzLastRunHtml(cfg.lastRun)}</div>

    <div style="display:flex;gap:8px;margin:14px 0 20px">
      <button class="pz-btn pz-btn-accent" ${disabled} data-action="runPersonalizationNow">Run now</button>
      <button class="pz-btn pz-btn-danger" ${disabled} data-action="startFreshPersonalization">Start fresh</button>
    </div>

    <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Everything it has learned about you lives in the <b>Learn</b> drawer — see <b>About you</b> there to review, confirm, correct, or forget individual facts.</div>

    <div class="settings-section-title pz-section-heading">Learning sources</div>
    <div class="pz-controls">${_pzSourceControlsHtml(cfg)}</div>

    <div class="pz-settings-grid">
      <label><span>Keep activity summaries</span><select class="pz-select" ${disabled} data-change-action="setPersonalizationRetention" data-change-args='["$value"]'>${_pzRetentionHtml(cfg)}</select></label>
      <label><span>Engagement</span><select class="pz-select" ${disabled} data-change-action="setPersonalizationEngagement" data-change-args='["$value"]'>
        <option value="quiet" ${_pzEngagement(cfg) === 'quiet' ? 'selected' : ''}>Quiet</option>
        <option value="helpful" ${_pzEngagement(cfg) === 'helpful' ? 'selected' : ''}>Helpful</option>
        <option value="proactive" ${_pzEngagement(cfg) === 'proactive' ? 'selected' : ''}>Proactive</option>
      </select></label>
      <label><span>Safe initiative</span><select class="pz-select" ${disabled} data-change-action="setPersonalizationInitiative" data-change-args='["$value"]'>
        <option value="suggest" ${cfg.initiativeMode !== 'safe_auto' ? 'selected' : ''}>Suggest first</option>
        <option value="safe_auto" ${cfg.initiativeMode === 'safe_auto' ? 'selected' : ''}>Act when safe + show receipt</option>
      </select></label>
      <label><span>Delivery</span><select class="pz-select" ${disabled} data-change-action="setPersonalizationDelivery" data-change-args='["$value"]'>
        <option value="immediate" ${!cfg.deliveryMode || cfg.deliveryMode === 'immediate' ? 'selected' : ''}>Immediate</option>
        <option value="briefing" ${cfg.deliveryMode === 'briefing' ? 'selected' : ''}>Hold for briefing / activity</option>
      </select></label>
    </div>
    <div class="pz-settings-hint">
      <div><b>Engagement</b> — Quiet: context only. Helpful: careful assistant. Proactive: soft-confirm repeated interests and prefer standing watches once you confirm.</div>
      <div><b>Safe initiative</b> — may start only a reviewed, informational, exactly reversible private monitor (with Stop/Undo). Everything else stays ask-first.</div>
    </div>

    <div class="settings-section-title pz-section-heading">Quiet hours</div>
    <div class="pz-quiet-row">
      <input id="pzQuietStart" type="time" ${disabled} value="${escHtml(quiet.start || '22:00')}">
      <span>to</span>
      <input id="pzQuietEnd" type="time" ${disabled} value="${escHtml(quiet.end || '08:00')}">
      <button class="pz-btn pz-btn-small" ${disabled} data-action="savePersonalizationQuietHours">Save</button>
      <button class="pz-btn pz-btn-small" ${disabled} data-action="useBrowserPersonalizationTimezone">Use this browser’s timezone</button>
    </div>
    <div class="pz-hint">${cfg.timezone
      ? `Quiet hours and daily notification limits use ${escHtml(cfg.timezone)}. Update it after travel if needed.`
      : 'Quiet hours and daily notification limits currently use the server’s timezone. Save this browser’s timezone for accurate local timing.'}</div>

    <div class="settings-section-title pz-section-heading">Automatic and muted behaviors</div>
    <div class="pz-list">${_pzBehaviorsHtml()}</div>

    <div class="settings-section-title pz-section-heading">Keeping an eye on</div>
    <div class="pz-list">${_pzLeadsHtml()}</div>

    <div class="settings-section-title pz-section-heading pz-heading-actions"><span>Proactive activity</span>${_pzInbox.some(e => e.status !== 'read') ? '<button class="pz-link-btn" data-action="readAllPersonalizationEvents">Mark all read</button>' : ''}</div>
    <div class="pz-list">${_pzInboxHtml()}</div>

    <div class="settings-section-title pz-section-heading pz-heading-actions"><span>Decision history</span>${_pzHistory.length ? '<button class="pz-link-btn" data-action="clearPersonalizationHistory">Clear</button>' : ''}</div>
    <div class="pz-history">${_pzHistoryHtml()}</div>
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
    _pzErrors = {};
    const optional = (key, url) => _pzGetJson(url).catch(e => {
      _pzErrors[key] = e?.message || 'unknown error';
      return null;
    });
    const [configData, leadsData, policyData, inboxData, historyData] = await Promise.all([
      _pzGetJson('/api/personalization/config'),
      optional('leads', '/api/personalization/leads'),
      optional('policies', '/api/personalization/policies'),
      optional('inbox', '/api/personalization/inbox?limit=100'),
      optional('history', '/api/personalization/history?limit=20'),
    ]);
    _pzConfig = _pzExtractConfig(configData);
    _pzProviders = _pzExtractArray(configData, ['providers']);
    _pzCoordinatorLabel = typeof configData?.coordinatorLabel === 'string' ? configData.coordinatorLabel : null;
    _pzCoordinatorUsable = typeof configData?.coordinatorUsable === 'boolean' ? configData.coordinatorUsable : null;
    _pzProvidersError = typeof configData?.providersError === 'string' ? configData.providersError : null;
    _pzReflectionHealth = configData?.reflectionHealth && typeof configData.reflectionHealth === 'object'
      ? configData.reflectionHealth : null;
    _pzAllowedModels = Array.isArray(configData?.allowedModels)
      ? configData.allowedModels.filter(model => typeof model === 'string')
      : null;
    _pzLeads  = _pzExtractArray(leadsData, ['leads', 'rows', 'items']);
    _pzPolicies = _pzExtractArray(policyData, ['policies', 'rows', 'items']);
    _pzInbox = _pzExtractArray(inboxData, ['events', 'rows', 'items']);
    _pzHistory = _pzExtractArray(historyData, ['history', 'events', 'items']);
    root.innerHTML = _pzRenderPanelHtml();
  } catch (e) {
    console.error('[personalization] failed to load panel:', e);
    root.innerHTML = `<div style="font-size:12px;color:var(--red,#e05c5c)">Couldn't load personalization settings (${escHtml(e?.message || 'unknown error')}). Try reopening this tab.</div>`;
  } finally {
    _pzLoading = false;
  }
}

function retryPersonalizationPanel() {
  return renderPersonalizationPanel();
}

// ── action handlers (global — wired via data-action / data-change-action) ──
function _pzPaint() {
  const root = $('stab-panel-personalization');
  if (root && _pzConfig) root.innerHTML = _pzRenderPanelHtml();
}

async function _pzPatchConfig(patch, failureLabel = 'Failed to update') {
  if (_pzMutation) return false;
  _pzMutation = true;
  _pzPaint();
  try {
    const data = await _pzMutate('/api/personalization/config', 'PATCH', patch);
    _pzConfig = _pzExtractConfig(data);
    // Health is derived server-side from live model resolution. Avoid showing
    // a stale outage after a settings change; the next panel refresh obtains
    // a fresh authenticated summary.
    _pzReflectionHealth = null;
    return true;
  } catch (e) {
    showToast(`${failureLabel}: ${e.message}`);
    return false;
  } finally {
    _pzMutation = false;
    _pzPaint();
  }
}

function _pzModelFromValue(value) {
  if (value === 'off' || value === 'coordinator') return value;
  return _pzModelChoices.get(value) || null;
}

async function togglePersonalization(checked) {
  await _pzPatchConfig({ enabled: !!checked });
}

async function setPersonalizationModel(val) {
  const model = _pzModelFromValue(val);
  if (!model) { showToast('Invalid model selection'); _pzPaint(); return; }
  if (model === 'coordinator' && _pzCoordinatorUsable === false) {
    showToast('Your coordinator does not have a usable text model');
    _pzPaint();
    return;
  }
  await _pzPatchConfig({ model }, 'Failed to update model');
}

async function completePersonalizationSetup() {
  const model = _pzModelFromValue($('pzModelSelect')?.value || '');
  if (!model || (model === 'coordinator' && _pzCoordinatorUsable === false)) {
    showToast('Choose an available text model before turning on personalization');
    return;
  }
  const engagement = $('pzSetupEngagement')?.value || 'helpful';
  const initiativeMode = $('pzSetupInitiative')?.value || 'suggest';
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  const ok = await _pzPatchConfig({ setupComplete: true, enabled: true, model, engagement, initiativeMode, timezone }, 'Setup failed');
  if (ok) showToast('Personalization is ready');
}

async function skipPersonalizationSetup() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  const ok = await _pzPatchConfig({ setupComplete: true, enabled: false, timezone }, 'Could not save your choice');
  if (ok) showToast('Personalization is off. You can turn it on here anytime.');
}

async function setPersonalizationSource(source, checked) {
  if (!['tools', 'calendar', 'sessions'].includes(source)) return;
  const sources = { ...(_pzConfig?.sources || {}), [source]: !!checked };
  await _pzPatchConfig({ sources }, 'Failed to update learning source');
}

async function setPersonalizationRetention(value) {
  const retentionDays = Number(value);
  if (!Number.isInteger(retentionDays)) return;
  await _pzPatchConfig({ retentionDays }, 'Failed to update retention');
}

function _pzEngagement(cfg) {
  if (cfg?.engagement === 'quiet' || cfg?.engagement === 'helpful' || cfg?.engagement === 'proactive') {
    return cfg.engagement;
  }
  if (cfg?.engagement === 'companion') return 'proactive';
  if (cfg?.proactivity === 'quiet') return 'quiet';
  // Old volume-only "proactive" was not friend-mode; map to Helpful.
  if (cfg?.proactivity === 'proactive') return 'helpful';
  return 'helpful';
}

async function setPersonalizationEngagement(engagement) {
  if (engagement === 'companion') engagement = 'proactive';
  if (!['quiet', 'helpful', 'proactive'].includes(engagement)) return;
  await _pzPatchConfig({ engagement }, 'Failed to update engagement');
}

/** @deprecated legacy name kept for any stale UI bindings */
async function setPersonalizationProactivity(proactivity) {
  const map = { quiet: 'quiet', balanced: 'helpful', proactive: 'helpful' };
  const engagement = map[proactivity];
  if (!engagement) return;
  await setPersonalizationEngagement(engagement);
}

async function setPersonalizationInitiative(initiativeMode) {
  if (!['suggest', 'safe_auto'].includes(initiativeMode)) return;
  await _pzPatchConfig({ initiativeMode }, 'Failed to update safe initiative');
}

async function setPersonalizationDelivery(deliveryMode) {
  if (!['immediate', 'briefing'].includes(deliveryMode)) return;
  await _pzPatchConfig({ deliveryMode }, 'Failed to update delivery');
}

async function savePersonalizationQuietHours() {
  const start = $('pzQuietStart')?.value;
  const end = $('pzQuietEnd')?.value;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start || '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end || '')) {
    showToast('Choose valid start and end times');
    return;
  }
  const ok = await _pzPatchConfig({ quietHours: { start, end } }, 'Failed to update quiet hours');
  if (ok) showToast('Quiet hours saved');
}

async function useBrowserPersonalizationTimezone() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  if (!timezone) { showToast('This browser did not report a timezone'); return; }
  const ok = await _pzPatchConfig({ timezone }, 'Failed to update timezone');
  if (ok) showToast(`Timezone set to ${timezone}`);
}

// Ledger row actions (confirm/forget) live in learn.js — the ledger renders
// in the Learn drawer as of 2026-07-07, not in this panel.

async function dismissPersonalizationLead(el) {
  const id = _pzRefFromEl(el);
  if (!id) return;
  try {
    await _pzMutate(`/api/personalization/leads/${encodeURIComponent(id)}`, 'DELETE');
  } catch (e) {
    showToast(`Failed to dismiss: ${e.message}`);
  }
  await renderPersonalizationPanel();
}

async function controlPersonalizationEvent(el, action) {
  const id = _pzRefFromEl(el);
  if (!id || !['stop', 'undo'].includes(action)) return;
  try {
    await _pzMutate(`/api/personalization/inbox/${encodeURIComponent(id)}/${action}`, 'POST');
    showToast(action === 'stop'
      ? 'Updates stopped. This behavior will not be suggested again.'
      : 'Undone. This behavior will ask first next time.');
  } catch (e) {
    showToast(`Could not ${action === 'stop' ? 'stop updates' : 'undo'}: ${e.message}`);
  }
  await renderPersonalizationPanel();
}

async function feedbackPersonalizationEvent(el, outcome) {
  const id = _pzRefFromEl(el);
  if (!id || !['useful', 'not_useful', 'acted', 'snooze'].includes(outcome)) return;
  try {
    await _pzMutate(`/api/personalization/inbox/${encodeURIComponent(id)}/feedback`, 'POST', { outcome });
    const message = {
      useful: 'Thanks — this was marked useful.',
      acted: 'Thanks — OpenEnsemble learned that you used this.',
      not_useful: 'Marked not useful. This behavior will ask first next time.',
      snooze: 'Updates snoozed for 7 days.',
    }[outcome];
    showToast(message);
  } catch (e) {
    showToast(`Could not save feedback: ${e.message}`);
  }
  await renderPersonalizationPanel();
}

function editPersonalizationPreference(el) {
  const id = _pzRefFromEl(el);
  if (!id) return;
  if (typeof openLearnFactEditor === 'function') return openLearnFactEditor(id);
  showToast('Open Learn to edit this preference.');
}

async function runPersonalizationNow(ev) {
  const btn = ev?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
  try {
    const result = await _pzMutate('/api/personalization/run', 'POST');
    if (result?.skipped || result?.ok === false) showToast(result?.notice || 'This run was skipped.');
    else if (result?.partial) showToast(result?.notice || 'Run completed with retryable errors.');
    else showToast(`Run complete — ${result?.inferences ?? 0} insight${result?.inferences === 1 ? '' : 's'}, ${result?.offers ?? 0} offer${result?.offers === 1 ? '' : 's'}`);
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
    const result = await _pzMutate('/api/personalization/start-fresh', 'POST');
    if (result?.failed > 0) showToast(`Cleared ${result.removed ?? 0}; ${result.failed} could not be removed and were kept.`);
    else showToast(`Cleared ${result?.removed ?? 0} inferred memor${result?.removed === 1 ? 'y' : 'ies'}`);
  } catch (e) {
    showToast(`Failed: ${e.message}`);
  }
  await renderPersonalizationPanel();
}

async function _pzPolicyAction(el, action, success) {
  const kind = _pzRefFromEl(el);
  if (!kind) return;
  try {
    const result = await _pzMutate(`/api/personalization/policies/${encodeURIComponent(kind)}/${action}`, 'POST');
    showToast(typeof success === 'function' ? success(result) : success);
  } catch (e) {
    showToast(`Failed: ${e.message}`);
  }
  await renderPersonalizationPanel();
}
function revokePersonalizationAuto(el) { return _pzPolicyAction(el, 'revoke-auto', 'This behavior will ask first again'); }
function mutePersonalizationKind(el) { return _pzPolicyAction(el, 'mute', 'Suggestions of this type are muted'); }
function resumePersonalizationKind(el) {
  return _pzPolicyAction(el, 'resume', result => result?.askFirst
    ? 'Suggestions of this type can appear again and will ask first'
    : 'Suggestions of this type can appear again');
}

async function readPersonalizationEvent(el) {
  const id = _pzRefFromEl(el);
  if (!id) return;
  try { await _pzMutate(`/api/personalization/inbox/${encodeURIComponent(id)}/read`, 'POST'); }
  catch (e) { showToast(`Failed: ${e.message}`); }
  await renderPersonalizationPanel();
}

async function readAllPersonalizationEvents() {
  try { await _pzMutate('/api/personalization/inbox/read-all', 'POST'); }
  catch (e) { showToast(`Failed: ${e.message}`); }
  await renderPersonalizationPanel();
}

async function clearPersonalizationHistory() {
  if (!confirm('Clear the personalization decision history? Learned facts and behaviors are kept.')) return;
  try {
    await _pzMutate('/api/personalization/history', 'DELETE');
    showToast('Decision history cleared');
  } catch (e) { showToast(`Failed: ${e.message}`); }
  await renderPersonalizationPanel();
}
