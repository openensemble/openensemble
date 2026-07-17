// @ts-check
/**
 * Personalization REST API — Settings → Personalization panel.
 *
 *   GET    /api/personalization/config          — {config, providers, coordinatorLabel,
 *                                                  coordinatorUsable, allowedModels,
 *                                                  reflectionHealth}
 *                                                  (one fetch is enough for the whole panel)
 *   PATCH  /api/personalization/config          — shallow-merge patch; a `model` field is
 *                                                  validated against the provider enumeration
 *                                                  or the 'coordinator'/'off' sentinels first
 *   GET    /api/personalization/ledger          — "what I've learned about you" rows
 *   POST   /api/personalization/ledger/:id/confirm — mark an inferred row as user-confirmed
 *   PATCH  /api/personalization/ledger/:id      — correct a fact and re-embed it
 *   POST   /api/personalization/ledger/:id/feedback — not-true/outdated/too-personal feedback
 *   DELETE /api/personalization/ledger/:id      — soft-forget one row (any tier)
 *   GET    /api/personalization/leads           — open "keeping an eye on" leads
 *   DELETE /api/personalization/leads/:id       — dismiss a lead
 *   GET    /api/personalization/policies        — automatic/muted offer-kind controls
 *   POST   /api/personalization/policies/:kind/:action — ask-first/mute/resume
 *   GET    /api/personalization/inbox           — durable proactive activity
 *   POST   /api/personalization/inbox/:id/read  — mark proactive activity read
 *   POST   /api/personalization/inbox/:id/feedback — useful/not-useful/acted/snooze feedback
 *   POST   /api/personalization/inbox/:id/undo  — stop an automatic monitor; ask next time
 *   POST   /api/personalization/inbox/:id/stop  — stop and mute its exact monitor contract
 *   GET    /api/personalization/history         — privacy-bounded decision timeline
 *   DELETE /api/personalization/history         — clear only the timeline
 *   POST   /api/personalization/run             — force a reflection run now (self only)
 *   POST   /api/personalization/start-fresh     — soft-forget every tier:'inferred' row,
 *                                                  keep tier:'confirmed' rows
 *
 * All routes are per-user scoped from session auth (requireAuth) — there is
 * no admin override; a user can only ever act on their own personalization
 * data, matching every other per-user route module in routes/.
 *
 * Ledger storage and mutations are owned by lib/personalization/ledger.mjs.
 * Keeping the route out of direct sidecar CRUD gives confirm/correct/delete/
 * reset one shared transaction boundary with Cortex and prevents an unreadable
 * ledger from being mistaken for an empty one and destructively rewritten.
 */

import { requireAuth, readBody, getUserCoordinatorAgentId, getAgentsForUser, getUser } from './_helpers.mjs';
import { getConfig, saveConfig } from '../lib/personalization/config.mjs';
import {
  enumerateProviders,
  isReflectionModelAllowed,
  isReflectionTextModel,
  resolveReflectionModel,
} from '../lib/personalization/providers.mjs';
import { runReflection } from '../lib/personalization/reflect.mjs';
import {
  listLedger,
  confirmLedgerRow,
  correctLedgerRow,
  forgetLedgerRow,
  resetInferredRows,
} from '../lib/personalization/ledger.mjs';
import { listLeads, dismissLead } from '../lib/personalization/leads.mjs';

const MEMORY_ID_RE = /^[a-zA-Z0-9_-]{3,120}$/;
const OPAQUE_ID_RE = /^[a-zA-Z0-9_-]{3,160}$/;
const PROFILE_TYPES = new Set(['pattern', 'fact', 'relationship', 'preference', 'constraint', 'goal', 'routine']);
const PUBLIC_CONFIG_FIELDS = new Set([
  'enabled', 'setupComplete', 'model', 'retentionDays', 'engagement', 'proactivity',
  'initiativeMode', 'deliveryMode', 'timezone', 'quietHours', 'sources',
]);
const SOURCE_FIELDS = new Set(['tools', 'calendar', 'sessions']);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PRIVATE_JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function decodeMemoryId(raw) {
  try {
    const id = decodeURIComponent(raw);
    return MEMORY_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function decodeOpaqueId(raw) {
  try {
    const id = decodeURIComponent(raw);
    return OPAQUE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function proactiveEventPreferenceId(event) {
  const candidates = [
    event?.metadata?.control?.source?.preferenceMemoryId,
    event?.metadata?.control?.preferenceMemoryId,
    event?.metadata?.preferenceMemoryId,
  ];
  return candidates.find(value => typeof value === 'string' && MEMORY_ID_RE.test(value)) || null;
}

// Receipt storage intentionally keeps only an opaque ledger id. Resolve the
// current wording when the same user reads the inbox so edits and deletion take
// effect immediately and stale preference prose is never retained in receipts.
async function enrichProactiveEventWhy(userId, events) {
  const sanitized = (Array.isArray(events) ? events : []).map(event => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
    const copy = { ...event };
    delete copy.why; // never trust or expose persisted explanation prose
    return copy;
  });
  const referencedIds = new Set(sanitized.map(proactiveEventPreferenceId).filter(Boolean));
  if (!referencedIds.size) return sanitized;

  let rows;
  try {
    rows = await listLedger(userId);
  } catch (e) {
    console.warn(`[personalization] proactive explanation lookup failed for ${userId}: ${e.message}`);
    return sanitized;
  }
  const preferences = new Map((Array.isArray(rows) ? rows : [])
    .filter(row => row?.tier === 'confirmed' && row?.type === 'preference'
      && referencedIds.has(row.id) && typeof row.statement === 'string'
      && row.statement.trim().length >= 3 && row.statement.trim().length <= 300)
    .map(row => [row.id, row.statement.trim()]));

  return sanitized.map(event => {
    const preferenceId = proactiveEventPreferenceId(event);
    const statement = preferenceId ? preferences.get(preferenceId) : null;
    return statement
      ? { ...event, why: { preferenceId, statement, source: 'confirmed preference' } }
      : event;
  });
}

async function refreshPreferenceAutomation(userId) {
  try {
    const { refreshPreferenceOpportunitiesForProfileChange } = await import('../lib/personalization/preference-opportunities.mjs');
    await refreshPreferenceOpportunitiesForProfileChange(userId, { limit: 1 });
  } catch (e) {
    // The profile/config mutation is already durable. Keep the user-facing
    // edit successful and let the scheduled reconciler retry, while avoiding
    // any stale automatic execution in the meantime (ticks reauthorize too).
    console.warn(`[personalization] immediate preference automation refresh deferred for ${userId}: ${e.message}`);
  }
}

// ── Coordinator label (for the "Same as coordinator (default)" option) ─────
// Same lookup pattern as lib/task-label.mjs:75-78. Best-effort only — the UI
// falls back to a generic label if this fails, it never blocks the response.
function safeCoordinatorInfo(userId) {
  try {
    const coordId = getUserCoordinatorAgentId(userId);
    if (!coordId) return { label: null, usable: false };
    const agent = getAgentsForUser(userId).find(a => a.id === coordId);
    if (!agent?.provider || !agent?.model) {
      return { label: agent?.provider || null, usable: false };
    }
    return {
      label: `${agent.model} (${agent.provider})`,
      usable: isReflectionTextModel(agent.provider, agent.model)
        && isReflectionModelAllowed(userId, agent.model),
    };
  } catch (e) {
    console.warn(`[personalization] coordinator label lookup failed for ${userId}: ${e.message}`);
    return { label: null, usable: false };
  }
}

// `null` means unrestricted. An array is safe to return to the same user and
// lets the browser filter catalog-backed cloud providers whose server
// enumeration intentionally has no live models[] listing. Never return any
// other account/profile fields from this endpoint.
function safeAllowedModels(userId) {
  try {
    const user = getUser(userId);
    if (!user) return [];
    const allowed = user.allowedModels;
    if (!Array.isArray(allowed)) return null;
    return [...new Set(allowed.filter(model => typeof model === 'string' && model.length > 0
      && model.length <= 300 && model === model.trim() && !/[\x00-\x1f\x7f]/.test(model)))].slice(0, 500);
  } catch (e) {
    console.warn(`[personalization] model allowlist lookup failed for ${userId}: ${e.message}`);
    // Fail closed in the picker if the account record says it is restricted
    // but cannot be read. PATCH still performs the authoritative check.
    return [];
  }
}

// ── Reflection health (privacy-safe Settings status) ───────────────────────
// lastRun.notice is useful internal diagnostics, but it can include a provider
// label/error code and is not a stable UI contract.  Return only bounded enums
// and normalized timestamps here; never pass exception text through this
// summary.  analyzedThroughTs is deliberately retained by reflect.mjs across a
// failed attempt, so it is the best available "last successful" watermark.
function safeIso(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function isNoNewSignalRun(lastRun) {
  if (lastRun?.skipped !== true || typeof lastRun?.notice !== 'string') return false;
  return /^(?:No new personalization signal since the previous run\.|Already ran recently)/i.test(lastRun.notice.trim());
}

function providerIdsMatch(left, right) {
  const normalize = value => value === 'xai' ? 'grok' : value;
  return normalize(String(left || '').toLowerCase()) === normalize(String(right || '').toLowerCase());
}

async function safeReflectionHealth(userId, config, providers, providersAvailable) {
  const lastRun = config?.lastRun && typeof config.lastRun === 'object' && !Array.isArray(config.lastRun)
    ? config.lastRun : null;
  const lastAttemptAt = safeIso(lastRun?.at);
  const noNewSignal = isNoNewSignalRun(lastRun);
  const lastSuccessfulAt = lastRun?.skipped === false || noNewSignal
    ? lastAttemptAt
    : safeIso(lastRun?.analyzedThroughTs);
  const explicitPreferencesAvailable = config?.enabled === true
    && config?.setupComplete !== false
    && config?.sources?.sessions !== false;
  const result = (status, reason) => ({
    status,
    reason,
    patternLearningPaused: status === 'paused' || status === 'model_unavailable',
    explicitPreferencesAvailable,
    lastAttemptAt,
    lastSuccessfulAt,
  });

  if (config?.enabled !== true) return result('paused', 'personalization_off');
  if (config?.setupComplete === false) return result('paused', 'setup_incomplete');
  if (config?.model === 'off') return result('paused', 'model_off');

  let resolved = null;
  try { resolved = await resolveReflectionModel(userId); }
  catch (e) {
    console.warn(`[personalization] reflection health model resolution failed for ${userId}: ${e?.message || e}`);
  }
  if (!resolved) return result('model_unavailable', 'model_unavailable');

  // When provider enumeration succeeded, a known-but-unconfigured selected
  // provider is unavailable now even if its provider/model pair is otherwise
  // syntactically resolvable.  An enumeration outage itself is not evidence
  // that the selected model is down, so it never changes health classification.
  if (providersAvailable) {
    const provider = providers.find(item => providerIdsMatch(item?.id, resolved.providerId));
    if (provider?.configured === false) return result('model_unavailable', 'provider_not_configured');
  }

  if (!lastRun || !lastAttemptAt) return result('idle', 'awaiting_first_run');
  if (noNewSignal) return result('idle', 'no_new_signal');
  if (lastRun.skipped !== true) return result('healthy', 'ok');

  // A failed record for a previously selected model must not make a newly
  // selected model look unhealthy before its first attempt.
  if (lastRun.provider && lastRun.model
    && (!providerIdsMatch(lastRun.provider, resolved.providerId) || lastRun.model !== resolved.model)) {
    return result('idle', 'awaiting_selected_model_run');
  }
  return result('paused', lastRun.provider ? 'provider_error' : 'reflection_error');
}

// ── Model-pick validation (PATCH /config) ───────────────────────────────────
// Accepts the two sentinel strings, or {provider, model} matched against the
// live provider enumeration. Anything else is rejected with a 400 rather
// than silently saved and failing at reflection time.
//
// lib/personalization/providers.mjs's own documented contract: cloud
// providers have no cheap universal "list models" call, so `models` comes
// back empty for them — an empty models[] means "any non-empty model string
// is acceptable", NOT "no models exist" (only ollama/lmstudio ever get a
// populated, exact-match-checkable list). Requiring `p.models.includes(...)`
// unconditionally made it impossible to ever save a cloud provider pick.
// `configured:true` is still required either way, so an unconfigured
// provider (no API key, not connected) can never be picked just because its
// models array happens to be empty.
function isValidModelPick(model, providers) {
  if (model === 'coordinator' || model === 'off') return true;
  if (!model || typeof model !== 'object') return false;
  if (Object.keys(model).some(key => key !== 'provider' && key !== 'model')) return false;
  const { provider, model: modelName } = model;
  if (typeof provider !== 'string' || !provider || provider !== provider.trim() || provider.length > 100
    || /[\x00-\x1f\x7f]/.test(provider) || typeof modelName !== 'string'
    || !modelName.trim() || modelName !== modelName.trim() || modelName.length > 300
    || /[\x00-\x1f\x7f]/.test(modelName)) return false;
  const p = providers.find(pr => pr.id === provider);
  if (!p || !p.configured || p.supportsText === false) return false;
  if (!isReflectionTextModel(provider, modelName)) return false;
  const models = Array.isArray(p.models) ? p.models : [];
  return models.length > 0 ? models.includes(modelName) : true;
}

function validatePublicConfigPatch(body) {
  const unknown = Object.keys(body).find(key => !PUBLIC_CONFIG_FIELDS.has(key));
  if (unknown) return `unsupported config field: ${unknown}`;
  if ('enabled' in body && typeof body.enabled !== 'boolean') return 'enabled must be a boolean';
  if ('setupComplete' in body && typeof body.setupComplete !== 'boolean') return 'setupComplete must be a boolean';
  if ('retentionDays' in body
    && (!Number.isInteger(body.retentionDays) || body.retentionDays < 1 || body.retentionDays > 365)) {
    return 'retentionDays must be an integer from 1 to 365';
  }
  if ('engagement' in body && !['quiet', 'helpful', 'proactive', 'companion'].includes(body.engagement)) {
    return 'engagement must be quiet, helpful, or proactive';
  }
  // Legacy clients may still send proactivity; map is applied in saveConfig.
  if ('proactivity' in body && !['quiet', 'balanced', 'proactive'].includes(body.proactivity)) {
    return 'proactivity must be quiet, balanced, or proactive';
  }
  if ('initiativeMode' in body && !['suggest', 'safe_auto'].includes(body.initiativeMode)) {
    return 'initiativeMode must be suggest or safe_auto';
  }
  if ('deliveryMode' in body && !['immediate', 'briefing'].includes(body.deliveryMode)) {
    return 'deliveryMode must be immediate or briefing';
  }
  if ('timezone' in body) {
    if (body.timezone !== null && body.timezone !== '') {
      if (typeof body.timezone !== 'string' || body.timezone.length > 64) return 'timezone must be a valid IANA timezone';
      try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }); }
      catch { return 'timezone must be a valid IANA timezone'; }
    }
  }
  if ('quietHours' in body) {
    if (!body.quietHours || typeof body.quietHours !== 'object' || Array.isArray(body.quietHours)) {
      return 'quietHours must be an object';
    }
    const unknownQuiet = Object.keys(body.quietHours).find(key => key !== 'start' && key !== 'end');
    if (unknownQuiet) return `unsupported quietHours field: ${unknownQuiet}`;
    for (const key of ['start', 'end']) {
      if (key in body.quietHours && (typeof body.quietHours[key] !== 'string' || !TIME_RE.test(body.quietHours[key]))) {
        return `quietHours.${key} must be HH:MM`;
      }
    }
  }
  if ('sources' in body) {
    if (!body.sources || typeof body.sources !== 'object' || Array.isArray(body.sources)) return 'sources must be an object';
    const unknownSource = Object.keys(body.sources).find(key => !SOURCE_FIELDS.has(key));
    if (unknownSource) return `unsupported source: ${unknownSource}`;
    for (const [key, value] of Object.entries(body.sources)) {
      if (typeof value !== 'boolean') return `sources.${key} must be a boolean`;
    }
  }
  return null;
}

// The shared model catalog is still subject to each account's allowedModels
// policy. The frontend filters the picker too, but the route is the authority:
// children/restricted users can call PATCH directly, and the coordinator
// sentinel must not become a back door to a model their account cannot use.
function isModelAllowedForUser(userId, model) {
  if (model === 'off') return true;
  if (model === 'coordinator') {
    const coordinatorId = getUserCoordinatorAgentId(userId);
    if (!coordinatorId) return true; // no model will resolve yet
    const coordinator = getAgentsForUser(userId).find(a => a.id === coordinatorId);
    return !coordinator?.model || isReflectionModelAllowed(userId, coordinator.model);
  }
  return !!(model && typeof model === 'object' && isReflectionModelAllowed(userId, model.model));
}

function isModelTextCapableForUser(userId, model) {
  if (model === 'off') return true;
  if (model === 'coordinator') {
    const coordinatorId = getUserCoordinatorAgentId(userId);
    if (!coordinatorId) return true;
    const coordinator = getAgentsForUser(userId).find(a => a.id === coordinatorId);
    return !coordinator?.provider || !coordinator?.model
      || isReflectionTextModel(coordinator.provider, coordinator.model);
  }
  return !!(model && typeof model === 'object' && isReflectionTextModel(model.provider, model.model));
}

async function enumerateProvidersForUser(userId) {
  const list = await enumerateProviders(userId);
  if (!Array.isArray(list)) throw new Error('provider enumeration returned an invalid response');
  return list;
}

// Personalization never serves browser-native media. Refuse the broad,
// short-lived media URL token on every endpoint so a token leaked from an
// <img>/<video> URL cannot be reused to read the fact ledger or watch list.
function requirePersonalizationAuth(req, res) {
  return requireAuth(req, res, { allowMediaToken: false });
}

export async function handle(req, res) {
  const url = req.url.split('?')[0];

  // ── GET /api/personalization/config ───────────────────────────────────────
  if (url === '/api/personalization/config' && req.method === 'GET') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    let config;
    try {
      config = await getConfig(userId);
    } catch (e) {
      console.error(`[personalization] getConfig failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load personalization config' }));
      return true;
    }
    let providers = [];
    let providersError = null;
    try {
      providers = await enumerateProvidersForUser(userId);
    } catch (e) {
      console.error(`[personalization] enumerateProviders failed for ${userId}: ${e.message}`);
      providersError = 'Provider options are temporarily unavailable. Existing privacy controls still work.';
    }
    const coordinator = safeCoordinatorInfo(userId);
    const allowedModels = safeAllowedModels(userId);
    const reflectionHealth = await safeReflectionHealth(userId, config, providers, providersError === null);
    res.writeHead(200, PRIVATE_JSON_HEADERS);
    res.end(JSON.stringify({
      config, providers, coordinatorLabel: coordinator.label,
      coordinatorUsable: coordinator.usable, allowedModels, providersError, reflectionHealth,
    }));
    return true;
  }

  // ── PATCH /api/personalization/config ─────────────────────────────────────
  if (url === '/api/personalization/config' && req.method === 'PATCH') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body must be an object' }));
      return true;
    }
    const patchError = validatePublicConfigPatch(body);
    if (patchError) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: patchError }));
      return true;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'model')) {
      let providers = [];
      if (body.model !== 'off' && body.model !== 'coordinator') {
        try {
          providers = await enumerateProvidersForUser(userId);
        } catch (e) {
          console.error(`[personalization] enumerateProviders failed while saving for ${userId}: ${e.message}`);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Personalization provider options are temporarily unavailable' }));
          return true;
        }
      }
      if (!isValidModelPick(body.model, providers)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "model must be 'coordinator', 'off', or a {provider, model} pair from the enumeration" }));
        return true;
      }
      if (!isModelTextCapableForUser(userId, body.model)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Personalization reflection requires a text-capable model' }));
        return true;
      }
      if (!isModelAllowedForUser(userId, body.model)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'That model is not available for your account. Ask an admin to grant access.' }));
        return true;
      }
    }
    let saved;
    try {
      saved = await saveConfig(userId, body);
    } catch (e) {
      console.error(`[personalization] saveConfig failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to save personalization config' }));
      return true;
    }
    await refreshPreferenceAutomation(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config: saved }));
    return true;
  }

  // ── GET /api/personalization/ledger ────────────────────────────────────────
  if (url === '/api/personalization/ledger' && req.method === 'GET') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    try {
      const rows = await listLedger(userId, { includeContradicted: true });
      res.writeHead(200, PRIVATE_JSON_HEADERS);
      res.end(JSON.stringify({ ledger: rows }));
    } catch (e) {
      console.error(`[personalization] ledger read failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Personalization facts are temporarily unreadable. No data was changed.' }));
    }
    return true;
  }

  // ── POST /api/personalization/ledger/:id/confirm ──────────────────────────
  const confirmMatch = url.match(/^\/api\/personalization\/ledger\/([^/]+)\/confirm$/);
  if (confirmMatch && req.method === 'POST') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    const id = decodeMemoryId(confirmMatch[1]);
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid ledger row id' }));
      return true;
    }
    let row;
    try {
      row = await confirmLedgerRow(userId, id);
    } catch (e) {
      console.error(`[personalization] confirmLedgerRow failed for ${userId}/${id}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not confirm this fact. No data was changed.' }));
      return true;
    }
    if (!row) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ledger row not found' }));
      return true;
    }
    await refreshPreferenceAutomation(userId);
    res.writeHead(200, PRIVATE_JSON_HEADERS);
    res.end(JSON.stringify({ ok: true, row }));
    return true;
  }

  // ── PATCH /api/personalization/ledger/:id — user correction ───────────────
  const ledgerPatchMatch = url.match(/^\/api\/personalization\/ledger\/([^/]+)$/);
  if (ledgerPatchMatch && req.method === 'PATCH') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    const id = decodeMemoryId(ledgerPatchMatch[1]);
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid ledger row id' }));
      return true;
    }
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    const statement = typeof body?.statement === 'string' ? body.statement.trim() : '';
    const type = body?.type == null ? null : body.type;
    if (statement.length < 3 || statement.length > 300) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'statement must be 3-300 characters' }));
      return true;
    }
    if (type != null && !PROFILE_TYPES.has(type)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid fact category' }));
      return true;
    }
    try {
      const row = await correctLedgerRow(userId, id, { statement, reason: 'edit', type });
      if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ledger row not found' }));
      } else {
        await refreshPreferenceAutomation(userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, row }));
      }
    } catch (e) {
      console.error(`[personalization] correctLedgerRow failed for ${userId}/${id}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not update this fact. No data was changed.' }));
    }
    return true;
  }

  // ── POST /api/personalization/ledger/:id/feedback ─────────────────────────
  const ledgerFeedbackMatch = url.match(/^\/api\/personalization\/ledger\/([^/]+)\/feedback$/);
  if (ledgerFeedbackMatch && req.method === 'POST') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    const id = decodeMemoryId(ledgerFeedbackMatch[1]);
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid ledger row id' }));
      return true;
    }
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }
    const reason = body?.reason;
    if (!['not_true', 'outdated', 'too_personal'].includes(reason)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'reason must be not_true, outdated, or too_personal' }));
      return true;
    }
    try {
      const result = await correctLedgerRow(userId, id, { reason });
      if (!result) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ledger row not found' }));
      } else {
        await refreshPreferenceAutomation(userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      }
    } catch (e) {
      console.error(`[personalization] fact feedback failed for ${userId}/${id}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not apply that feedback. No data was changed.' }));
    }
    return true;
  }

  // ── DELETE /api/personalization/ledger/:id ────────────────────────────────
  const ledgerDeleteMatch = url.match(/^\/api\/personalization\/ledger\/([^/]+)$/);
  if (ledgerDeleteMatch && req.method === 'DELETE') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    const id = decodeMemoryId(ledgerDeleteMatch[1]);
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid ledger row id' }));
      return true;
    }
    try {
      const rows = await listLedger(userId, { includeContradicted: true });
      if (!rows.some(row => row.id === id)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ledger row not found' }));
        return true;
      }
    } catch (e) {
      console.error(`[personalization] pre-delete ledger read failed for ${userId}/${id}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Personalization facts are temporarily unreadable. No data was changed.' }));
      return true;
    }
    let ok;
    try {
      ok = await forgetLedgerRow(userId, id, { reason: 'forgotten' });
    } catch (e) {
      console.error(`[personalization] forgetLedgerRow failed for ${userId}/${id}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'memory delete failed — no data was changed' }));
      return true;
    }
    if (!ok) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'memory delete failed — no data was changed' }));
      return true;
    }
    await refreshPreferenceAutomation(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── GET /api/personalization/leads ─────────────────────────────────────────
  if (url === '/api/personalization/leads' && req.method === 'GET') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    let leads = [];
    try {
      leads = await listLeads(userId, { activeOnly: true });
    } catch (e) {
      console.error(`[personalization] listLeads failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load active personalization leads' }));
      return true;
    }
    // Replay args can contain private search terms or connector-specific
    // identifiers and are not needed by the settings UI. Keep them server-
    // side; expose only the fields required to explain/dismiss tracking.
    const publicLeads = leads.map(lead => ({
      id: lead.id,
      query: lead.query,
      toolName: lead.toolName,
      skillId: lead.skillId || null,
      createdAt: lead.createdAt || null,
      nextCheckAt: lead.nextCheckAt || null,
      expiresAt: lead.expiresAt || null,
      checksLeft: lead.checksLeft,
      status: lead.status,
      lastCheckedAt: lead.lastCheckedAt || null,
    }));
    res.writeHead(200, PRIVATE_JSON_HEADERS);
    res.end(JSON.stringify({ leads: publicLeads }));
    return true;
  }

  // ── DELETE /api/personalization/leads/:id ─────────────────────────────────
  const leadsDeleteMatch = url.match(/^\/api\/personalization\/leads\/([^/]+)$/);
  if (leadsDeleteMatch && req.method === 'DELETE') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    const id = decodeOpaqueId(leadsDeleteMatch[1]);
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid lead id' }));
      return true;
    }
    let ok;
    try {
      ok = await dismissLead(userId, id);
    } catch (e) {
      console.error(`[personalization] dismissLead failed for ${userId}/${id}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to dismiss personalization lead' }));
      return true;
    }
    if (!ok) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'lead not found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── Proactive behavior controls ───────────────────────────────────────────
  if (url === '/api/personalization/policies' && req.method === 'GET') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    try {
      const { listOfferPolicies } = await import('../lib/personalization/graduation.mjs');
      const policies = await listOfferPolicies(userId);
      res.writeHead(200, PRIVATE_JSON_HEADERS);
      res.end(JSON.stringify({ policies: Array.isArray(policies) ? policies : [] }));
    } catch (e) {
      console.error(`[personalization] listOfferPolicies failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load personalization behaviors' }));
    }
    return true;
  }

  const policyActionMatch = url.match(/^\/api\/personalization\/policies\/([^/]+)\/(revoke-auto|mute|resume)$/);
  if (policyActionMatch && req.method === 'POST') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    let kind;
    try { kind = decodeURIComponent(policyActionMatch[1]); } catch { kind = ''; }
    try {
      const policy = await import('../lib/personalization/graduation.mjs');
      if (!policy.isCanonicalOfferKind(kind)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid personalization behavior kind' }));
        return true;
      }
      let result;
      if (policyActionMatch[2] === 'revoke-auto') result = await policy.revokeKindAutoApproval(userId, kind);
      else if (policyActionMatch[2] === 'mute') result = await policy.setKindSuppressed(userId, kind, true);
      else {
        // Stop / Not useful outcomes are keyed to the exact opaque preference
        // contract. Lift that utility shadow into a durable ask-first boundary
        // before making suggestions visible again. Non-preference kinds are a
        // no-op here and retain their existing graduation policy.
        const utility = await import('../lib/personalization/opportunity-utility.mjs');
        const opportunity = await utility.resumePreferenceOpportunityKindAsAskFirst(userId, kind);
        // Keep the second, independent unattended-execution gate aligned with
        // utility. This also removes a legacy generated standing rule if an
        // older build left one behind for the same exact kind.
        if (opportunity.found === true) await policy.revokeKindAutoApproval(userId, kind);
        result = await policy.resumeKindOffers(userId, kind);
        result = { ...result, askFirst: opportunity.found === true, opportunityPolicyChanged: opportunity.changed === true };
      }
      if (result?.ok !== false) {
        const { recordHistory } = await import('../lib/personalization/history.mjs');
        const action = policyActionMatch[2];
        recordHistory(userId, {
          type: `policy.${action.replace('-', '_')}`,
          summary: `${action === 'revoke-auto' ? 'Returned to ask-first' : action === 'mute' ? 'Muted' : result?.askFirst ? 'Resumed ask-first' : 'Resumed'}: ${kind}`,
          details: { kind, action },
        }).catch(() => {});
      }
      res.writeHead(result?.ok === false ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result?.ok === false ? { error: 'personalization behavior not found' } : { ok: true, ...result }));
    } catch (e) {
      console.error(`[personalization] policy ${policyActionMatch[2]} failed for ${userId}/${kind}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to update personalization behavior' }));
    }
    return true;
  }

  // ── Proactive inbox ────────────────────────────────────────────────────────
  if (url === '/api/personalization/inbox' && req.method === 'GET') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    const parsed = new URL(req.url, 'http://localhost');
    const status = parsed.searchParams.get('status');
    const rawLimit = Number(parsed.searchParams.get('limit') || 50);
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 50;
    if (status && !['pending', 'delivered', 'read'].includes(status)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'status must be pending, delivered, or read' }));
      return true;
    }
    try {
      const { listProactiveEvents } = await import('../lib/personalization/proactive-inbox.mjs');
      const events = await listProactiveEvents(userId, { status: status || null, limit, includeRead: true });
      const enrichedEvents = await enrichProactiveEventWhy(userId, events);
      res.writeHead(200, PRIVATE_JSON_HEADERS);
      res.end(JSON.stringify({ events: enrichedEvents }));
    } catch (e) {
      console.error(`[personalization] proactive inbox read failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load proactive activity' }));
    }
    return true;
  }

  if (url === '/api/personalization/inbox/read-all' && req.method === 'POST') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    try {
      const { markAllProactiveEventsRead } = await import('../lib/personalization/proactive-inbox.mjs');
      const updated = await markAllProactiveEventsRead(userId);
      res.writeHead(200, PRIVATE_JSON_HEADERS);
      res.end(JSON.stringify({ ok: true, updated }));
    } catch (e) {
      console.error(`[personalization] proactive inbox mark-all failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to mark proactive activity read' }));
    }
    return true;
  }

  const inboxFeedbackMatch = url.match(/^\/api\/personalization\/inbox\/([^/]+)\/feedback$/);
  if (inboxFeedbackMatch && req.method === 'POST') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    const id = decodeOpaqueId(inboxFeedbackMatch[1]);
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid proactive event id' }));
      return true;
    }
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return true;
    }
    const allowedOutcomes = new Set(['useful', 'not_useful', 'acted', 'snooze']);
    const validObject = body && typeof body === 'object' && !Array.isArray(body);
    const unknownField = validObject
      ? Object.keys(body).find(key => key !== 'outcome' && key !== 'snoozeDays')
      : null;
    if (!validObject || unknownField || !allowedOutcomes.has(body.outcome)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'outcome must be useful, not_useful, acted, or snooze' }));
      return true;
    }
    if ('snoozeDays' in body && (body.outcome !== 'snooze' || !Number.isInteger(body.snoozeDays)
      || body.snoozeDays < 1 || body.snoozeDays > 30)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'snoozeDays must be an integer from 1 to 30 and is only valid with snooze' }));
      return true;
    }
    try {
      const { feedbackPreferenceAutomationReceipt } = await import('../lib/personalization/preference-opportunities.mjs');
      const options = 'snoozeDays' in body ? { snoozeDays: body.snoozeDays } : {};
      const result = await feedbackPreferenceAutomationReceipt(userId, id, body.outcome, options);
      if (result?.ok) {
        res.writeHead(200, PRIVATE_JSON_HEADERS);
        res.end(JSON.stringify(result));
      } else {
        const notFound = result?.error === 'receipt not found' || result?.error === 'proactive item not found';
        res.writeHead(notFound ? 404 : 409, PRIVATE_JSON_HEADERS);
        res.end(JSON.stringify({ error: notFound
          ? 'proactive event not found'
          : 'This proactive activity can no longer receive feedback' }));
      }
    } catch (e) {
      console.error(`[personalization] proactive inbox feedback failed for ${userId}/${id}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to save proactive feedback' }));
    }
    return true;
  }

  const inboxControlMatch = url.match(/^\/api\/personalization\/inbox\/([^/]+)\/(stop|undo)$/);
  if (inboxControlMatch && req.method === 'POST') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    const id = decodeOpaqueId(inboxControlMatch[1]);
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid proactive event id' }));
      return true;
    }
    const action = inboxControlMatch[2];
    try {
      const { controlPreferenceAutomationReceipt } = await import('../lib/personalization/preference-opportunities.mjs');
      const result = await controlPreferenceAutomationReceipt(userId, id, action);
      if (result?.ok) {
        res.writeHead(200, PRIVATE_JSON_HEADERS);
        res.end(JSON.stringify(result));
      } else {
        const notFound = result?.error === 'receipt not found';
        res.writeHead(notFound ? 404 : 409, PRIVATE_JSON_HEADERS);
        res.end(JSON.stringify({ error: notFound ? 'proactive event not found' : 'This automatic monitor can no longer be controlled' }));
      }
    } catch (e) {
      console.error(`[personalization] proactive inbox ${action} failed for ${userId}/${id}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to update automatic monitor' }));
    }
    return true;
  }

  const inboxReadMatch = url.match(/^\/api\/personalization\/inbox\/([^/]+)\/read$/);
  if (inboxReadMatch && req.method === 'POST') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    const id = decodeOpaqueId(inboxReadMatch[1]);
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid proactive event id' }));
      return true;
    }
    try {
      const { markProactiveEventRead } = await import('../lib/personalization/proactive-inbox.mjs');
      const event = await markProactiveEventRead(userId, id);
      res.writeHead(event ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(event ? { ok: true, event } : { error: 'proactive event not found' }));
    } catch (e) {
      console.error(`[personalization] proactive inbox mark-read failed for ${userId}/${id}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to mark proactive activity read' }));
    }
    return true;
  }

  // ── Decision history ───────────────────────────────────────────────────────
  if (url === '/api/personalization/history' && req.method === 'GET') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    const parsed = new URL(req.url, 'http://localhost');
    const rawLimit = Number(parsed.searchParams.get('limit') || 50);
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 50;
    try {
      const { listHistory } = await import('../lib/personalization/history.mjs');
      const history = await listHistory(userId, { limit });
      res.writeHead(200, PRIVATE_JSON_HEADERS);
      res.end(JSON.stringify({ history }));
    } catch (e) {
      console.error(`[personalization] history read failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load personalization history' }));
    }
    return true;
  }

  if (url === '/api/personalization/history' && req.method === 'DELETE') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    try {
      const { clearHistory } = await import('../lib/personalization/history.mjs');
      await clearHistory(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error(`[personalization] history clear failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to clear personalization history' }));
    }
    return true;
  }

  // ── POST /api/personalization/run ─────────────────────────────────────────
  // Self-only: always the requesting session's own userId, force:true bypasses
  // the "already ran recently" gate so the Settings "Run now" button (and the
  // orchestrator's live-verify hook) sees an immediate result.
  if (url === '/api/personalization/run' && req.method === 'POST') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    let stats;
    try {
      stats = await runReflection(userId, { force: true });
    } catch (e) {
      console.error(`[personalization] runReflection failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'reflection run failed' }));
      return true;
    }
    const ok = stats?.skipped !== true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, ...stats }));
    return true;
  }

  // ── POST /api/personalization/start-fresh ─────────────────────────────────
  // Soft-forgets every tier:'inferred' row; tier:'confirmed' rows are left
  // untouched. The ledger module owns the cross-store transaction.
  if (url === '/api/personalization/start-fresh' && req.method === 'POST') {
    const userId = requirePersonalizationAuth(req, res);
    if (!userId) return true;
    try {
      // resetInferredRows owns the shared ledger lock for the whole snapshot →
      // cortex-forget → sidecar-write transaction and removes only ids whose
      // cortex update succeeded. Rows added after its snapshot are preserved.
      const result = await resetInferredRows(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: result.failed === 0, ...result }));
    } catch (e) {
      console.error(`[personalization] start-fresh failed for ${userId}: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Could not reset learned facts. No sidecar data was discarded.' }));
    }
    return true;
  }

  return false;
}
