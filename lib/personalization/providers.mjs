// @ts-check
/**
 * Provider enumeration + one-shot JSON completion for Personalization.
 *
 * Mirrors lib/task-label.mjs's dispatch shape (anthropic / openai-compat /
 * ollama / openai-oauth), but generalized to run from a bare (providerId,
 * model) pair instead of an agent object, and to force+parse JSON output
 * since none of these providers support response_format/JSON mode natively.
 *
 * completeJSON is the ONLY place personalization talks to an LLM — reflect.mjs
 * (scheduled reflection) and lead-runner.mjs (hit/miss judging) both go through
 * it, so the privacy hard rule ("if the picked provider is unreachable, skip
 * the run — never substitute another provider") only needs to be enforced
 * once, at the call site, by treating ANY completeJSON rejection as "skip".
 */
import {
  ANTHROPIC_URL,
  OPENAI_OAUTH_BASE,
  OPENROUTER_URL,
  OPENAI_COMPAT_PROVIDERS,
  getLmstudioCompatUrl,
  getLmstudioKey,
  lmstudioAuthHeaders,
  getAnthropicKey,
  getCompatKey,
  getOpenRouterKey,
  getOllamaUrl,
  getOllamaKey,
  getFireworksKey,
  getGrokKey,
  readAnthropicSSE,
} from '../../chat/providers/_shared.mjs';
import { ensureFreshToken, isConnected } from '../openai-codex-auth.mjs';
import { getAgentsForUser, getUserCoordinatorAgentId } from '../../routes/_helpers.mjs';

// A network-level failure or non-2xx response is always fatal to the call —
// completions never retry across providers (that would cross the privacy
// boundary for a local pick). completeJSON DOES retry once on the SAME
// provider when the model's reply just wasn't parseable JSON (a prompting
// problem, not a reachability problem).
const COMPLETION_TIMEOUT_MS = 45_000;
const MODEL_LIST_TIMEOUT_MS = 2_500;

function providerError(code, message) {
  const e = new Error(message);
  // @ts-ignore — attaching a `code` field to a plain Error, same pattern the
  // rest of the codebase uses for classified errors (e.g. runtime-warn.mjs).
  e.code = code;
  return e;
}

// ── First-class providers (ADDENDUM F enumeration list) ─────────────────────
const FIRST_CLASS_META = {
  anthropic:      { label: 'Anthropic',             kind: 'cloud' },
  openrouter:     { label: 'OpenRouter',             kind: 'cloud' },
  'openai-oauth': { label: 'OpenAI (ChatGPT login)', kind: 'cloud' },
  ollama:         { label: 'Ollama',                 kind: 'local' },
  lmstudio:       { label: 'LM Studio',               kind: 'local' },
  // Fireworks is image-generation-only in this codebase (see chat.mjs's
  // agent.provider === 'fireworks' branch) — enumerated per ADDENDUM F for
  // picker parity with the rest of the app's provider lists, but
  // dispatchProvider() below has no text-completion adapter for it, so a
  // user who somehow picks it for personalization gets a clean
  // UNSUPPORTED_PROVIDER skip rather than a crash.
  fireworks:      { label: 'Fireworks AI',            kind: 'cloud' },
  grok:           { label: 'xAI Grok',                kind: 'cloud' },
};

function isFirstClassConfigured(id, userId) {
  switch (id) {
    case 'anthropic':      return !!getAnthropicKey();
    case 'openrouter':     return !!getOpenRouterKey();
    case 'openai-oauth':   return isConnected(userId);
    case 'ollama':         return true; // always has a default URL; reachability is checked at call time
    case 'lmstudio':       return true;
    case 'fireworks':      return !!getFireworksKey();
    case 'grok':           return !!getGrokKey();
    default:               return false;
  }
}

function providerLabel(providerId) {
  if (FIRST_CLASS_META[providerId]) return FIRST_CLASS_META[providerId].label;
  const compatKey = providerId === 'grok' ? 'xai' : providerId;
  return OPENAI_COMPAT_PROVIDERS[compatKey]?.displayName || providerId;
}

async function fetchOllamaModelNames() {
  try {
    const base = getOllamaUrl().replace(/\/chat$/, '');
    const res = await fetch(`${base}/tags`, { signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
    if (!res.ok) return [];
    const j = /** @type {any} */ (await res.json());
    return (Array.isArray(j?.models) ? j.models : []).map(m => m.name).filter(Boolean);
  } catch {
    return []; // best-effort — never blocks the picker on a down/slow local daemon
  }
}

async function fetchLmstudioModelNames() {
  try {
    const url = getLmstudioCompatUrl().replace(/\/chat\/completions$/, '/models');
    const res = await fetch(url, { signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS), headers: lmstudioAuthHeaders() });
    if (!res.ok) return [];
    const j = /** @type {any} */ (await res.json());
    return (Array.isArray(j?.data) ? j.data : []).map(m => m.id).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Enumerates every provider the Settings → Personalization model picker (and
 * PATCH /api/personalization/config's validation) can offer: the first-class
 * agent providers plus the OPENAI_COMPAT_PROVIDERS registry (which already
 * merges in any runtime-added provider via oe-admin's add_provider). `models`
 * is populated with a live (short-timeout) listing for local providers only —
 * cloud providers have no cheap universal "list models" call available at
 * this layer, so `models` comes back empty for them; callers should treat an
 * empty `models` array as "any non-empty model string is acceptable" rather
 * than "no models exist", the same way the rest of the app defers to
 * allAvailableModels() on the frontend for the actual cloud model catalogs.
 * `grok`/`xai` collide (dispatchProvider treats them as the same compat
 * provider) — 'xai' is skipped from the compat sweep so it isn't listed twice.
 *
 * @param {string} userId
 * @returns {Promise<Array<{id: string, label: string, kind: string, configured: boolean, models: string[]}>>}
 */
export async function enumerateProviders(userId) {
  const out = [];
  for (const [id, meta] of Object.entries(FIRST_CLASS_META)) {
    const configured = isFirstClassConfigured(id, userId);
    /** @type {string[]} */
    let models = [];
    if (id === 'ollama') models = await fetchOllamaModelNames();
    else if (id === 'lmstudio') models = await fetchLmstudioModelNames();
    out.push({ id, label: meta.label, kind: meta.kind, configured, models });
  }
  for (const [id, meta] of Object.entries(OPENAI_COMPAT_PROVIDERS)) {
    if (id === 'xai') continue; // covered by first-class 'grok' above
    out.push({ id, label: meta.displayName || id, kind: 'cloud', configured: !!getCompatKey(id), models: [] });
  }
  return out;
}

/**
 * Resolves what personalization should actually run reflection with, right
 * now, for this user: either the 'coordinator' sentinel (their coordinator
 * agent's own provider+model, resolved fresh at call time) or an explicit
 * {provider, model} pick from config. Returns null when personalization is
 * off, the model is explicitly set to 'off', or the pick can't be resolved
 * (e.g. no coordinator agent, or the coordinator has no provider/model set)
 * — callers must treat null as "nothing to run", never as "fall back to
 * something else".
 *
 * @param {string} userId
 * @returns {Promise<{providerId: string, model: string, isLocal: boolean, label: string} | null>}
 */
export async function resolveReflectionModel(userId) {
  if (!userId) return null;
  let cfg;
  try {
    const { getConfig } = await import('./config.mjs');
    cfg = await getConfig(userId);
  } catch (e) {
    console.warn(`[personalization] resolveReflectionModel: getConfig failed for ${userId}: ${e.message}`);
    return null;
  }
  if (!cfg || cfg.enabled === false) return null;
  const modelSetting = cfg.model;
  if (modelSetting === 'off') return null;

  if (!modelSetting || modelSetting === 'coordinator') {
    const coordId = getUserCoordinatorAgentId(userId);
    if (!coordId) return null;
    // getAgentsForUser is synchronous + heavy (composes tool sets across every
    // agent) — called exactly ONCE here per resolution, per ADDENDUM F.
    const agent = getAgentsForUser(userId).find(a => a.id === coordId);
    if (!agent?.provider || !agent?.model) return null;
    return {
      providerId: agent.provider,
      model: agent.model,
      isLocal: agent.provider === 'ollama' || agent.provider === 'lmstudio',
      label: providerLabel(agent.provider),
    };
  }

  if (typeof modelSetting === 'object' && typeof modelSetting.provider === 'string' && typeof modelSetting.model === 'string') {
    return {
      providerId: modelSetting.provider,
      model: modelSetting.model,
      isLocal: modelSetting.provider === 'ollama' || modelSetting.provider === 'lmstudio',
      label: providerLabel(modelSetting.provider),
    };
  }

  return null;
}

// ── Per-provider one-shot completions (pattern: lib/task-label.mjs) ─────────

async function callAnthropic(model, system, user, maxTokens) {
  const key = getAnthropicKey();
  if (!key) throw providerError('PROVIDER_NOT_CONFIGURED', 'Anthropic API key not configured');
  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model || 'claude-haiku-4-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
  } catch (e) {
    throw providerError('PROVIDER_UNREACHABLE', `Anthropic: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw providerError(res.status === 401 || res.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR', `Anthropic HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = /** @type {any} */ (await res.json());
  const text = j.content?.[0]?.text?.trim() ?? '';
  // Missing usage means genuinely unknown, not zero — nulls flow through to
  // lastRun so the UI can show "n/a" instead of a misleading 0.
  return { text, tokensIn: j.usage?.input_tokens ?? null, tokensOut: j.usage?.output_tokens ?? null };
}

async function callOpenAICompat(url, key, model, system, user, maxTokens, label) {
  if (!key) throw providerError('PROVIDER_NOT_CONFIGURED', `${label}: API key not configured`);
  if (!model) throw providerError('PROVIDER_ERROR', `${label}: no model specified`);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: maxTokens, stream: false,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
  } catch (e) {
    throw providerError('PROVIDER_UNREACHABLE', `${label}: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw providerError(res.status === 401 || res.status === 403 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR', `${label} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = /** @type {any} */ (await res.json());
  const text = j.choices?.[0]?.message?.content?.trim() ?? '';
  // Missing usage means genuinely unknown, not zero — see callAnthropic note above.
  return { text, tokensIn: j.usage?.prompt_tokens ?? null, tokensOut: j.usage?.completion_tokens ?? null };
}

async function callOllama(url, key, model, system, user, maxTokens) {
  if (!model) throw providerError('PROVIDER_ERROR', 'Ollama: no model specified');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      headers,
      body: JSON.stringify({
        model, stream: false, options: { num_predict: maxTokens },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
  } catch (e) {
    // The common case in practice: Ollama not running / wrong port. This is
    // exactly the case the privacy hard rule cares about — the caller must
    // skip, never silently retry against a cloud provider.
    throw providerError('PROVIDER_UNREACHABLE', `Ollama: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw providerError('PROVIDER_ERROR', `Ollama HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = /** @type {any} */ (await res.json());
  const text = j.message?.content?.trim() ?? '';
  // Missing usage means genuinely unknown, not zero — see callAnthropic note above.
  return { text, tokensIn: j.prompt_eval_count ?? null, tokensOut: j.eval_count ?? null };
}

// ChatGPT OAuth — /responses is streaming-only; drain output_text deltas and
// pull usage off the terminal response.completed event (same field the
// Responses provider adapter reads — chat/providers/openai-responses.mjs).
async function callOpenAIResponses(model, system, user, userId) {
  if (!model) throw providerError('PROVIDER_ERROR', 'openai-oauth: no model specified');
  const auth = await ensureFreshToken(userId).catch(() => null);
  if (!auth) throw providerError('PROVIDER_AUTH', 'openai-oauth: not connected, or token refresh failed');
  const headers = {
    'Content-Type':  'application/json',
    'Accept':        'text/event-stream',
    'Authorization': `Bearer ${auth.access_token}`,
    'OpenAI-Beta':   'responses=experimental',
    'Originator':    'codex_cli_rs',
  };
  if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id;
  let res;
  try {
    res = await fetch(`${OPENAI_OAUTH_BASE}/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      headers,
      body: JSON.stringify({
        model,
        instructions: system,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] }],
        reasoning: { effort: 'low' },
        store: false,
        stream: true,
      }),
    });
  } catch (e) {
    throw providerError('PROVIDER_UNREACHABLE', `openai-oauth: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw providerError(res.status === 401 ? 'PROVIDER_AUTH' : 'PROVIDER_ERROR', `openai-oauth HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  let acc = '';
  // null = "not yet known" — only set to a number once response.completed's
  // usage object is actually read; if the stream ends without ever reaching
  // response.completed, this stays null (genuinely unknown), never 0.
  let tokensIn = null, tokensOut = null;
  for await (const ev of readAnthropicSSE(res.body)) {
    if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') acc += ev.delta;
    if (ev.type === 'response.completed') {
      const usage = ev.response?.usage;
      if (usage) { tokensIn = usage.input_tokens ?? null; tokensOut = usage.output_tokens ?? null; }
      break;
    }
    if (ev.type === 'response.failed' || ev.type === 'error') break;
    // Deliberately NOT breaking on 'response.output_text.done' — in the real
    // Responses API stream that event fires BEFORE 'response.completed' (see
    // chat/providers/openai-responses.mjs's event loop, which has no handler
    // for it at all). Breaking here was the actual bug: it exited the loop
    // before 'response.completed' — and its usage — ever arrived, which is
    // why tokensIn/tokensOut always came back 0 for openai-oauth.
  }
  return { text: acc.trim(), tokensIn, tokensOut };
}

async function dispatchProvider({ providerId, model, system, user, maxTokens, userId }) {
  const p = providerId;
  if (p === 'anthropic')    return callAnthropic(model, system, user, maxTokens);
  if (p === 'openrouter')   return callOpenAICompat(OPENROUTER_URL, getOpenRouterKey(), model, system, user, maxTokens, 'OpenRouter');
  if (p === 'openai-oauth') return callOpenAIResponses(model, system, user, userId);
  if (p === 'lmstudio')     return callOpenAICompat(getLmstudioCompatUrl(), getLmstudioKey() || 'lmstudio', model, system, user, maxTokens, 'LM Studio');
  if (p === 'ollama')       return callOllama(getOllamaUrl(), getOllamaKey(), model, system, user, maxTokens);
  const compatKey = p === 'grok' ? 'xai' : p;
  const compatMeta = OPENAI_COMPAT_PROVIDERS[compatKey];
  if (compatMeta) {
    return callOpenAICompat(`${compatMeta.baseUrl}/chat/completions`, getCompatKey(compatKey), model, system, user, maxTokens, compatMeta.displayName || compatKey);
  }
  throw providerError('UNSUPPORTED_PROVIDER', `No text-completion adapter for provider "${p}" (e.g. fireworks is image-only in this codebase)`);
}

// Null-safe merge for the (rare) primary+retry token sum: treats null as "no
// info from this call" rather than 0, so the sum only comes back null when
// BOTH calls failed to surface usage — never fabricates a 0 out of a null.
function sumTokens(a, b) {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** First `{...}` block, parsed. Tolerates prose/markdown-fence wrapping around the JSON. */
function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/**
 * One-shot, JSON-forced completion. None of the adapters above support
 * response_format/JSON mode, so JSON-ness is enforced entirely by prompting
 * (schema appended verbatim to the system message) plus a regex-extract of
 * the model's reply; a reply that still doesn't parse gets exactly one retry
 * with a "JSON ONLY" nudge appended to the user message before giving up.
 *
 * `schema` may be a string (embedded verbatim) or a plain object (stringified)
 * — lead-runner.mjs's tiny hit/miss judge call passes an object.
 *
 * @param {{userId: string, providerId: string, model: string, system: string, user: string, schema?: string|object, maxTokens?: number}} args
 * @returns {Promise<{json: any, tokensIn: number|null, tokensOut: number|null}>}
 */
export async function completeJSON({ userId, providerId, model, system, user, schema, maxTokens = 1500 }) {
  if (!providerId || !model) throw providerError('PROVIDER_ERROR', 'completeJSON: providerId and model are required');
  const schemaText = schema == null ? null : (typeof schema === 'string' ? schema : JSON.stringify(schema, null, 2));
  const fullSystem = `${system || ''}\n\nRespond with JSON ONLY — no prose, no markdown fences, no commentary${schemaText ? `, matching exactly this shape:\n${schemaText}` : '.'}`;

  let { text, tokensIn, tokensOut } = await dispatchProvider({ providerId, model, system: fullSystem, user, maxTokens, userId });
  let json = extractJSON(text);
  if (!json) {
    const nudge = `${user}\n\n(Your previous reply was not valid JSON. Reply with JSON ONLY — no prose, no markdown fences — matching the schema exactly.)`;
    const retry = await dispatchProvider({ providerId, model, system: fullSystem, user: nudge, maxTokens, userId });
    tokensIn = sumTokens(tokensIn, retry.tokensIn);
    tokensOut = sumTokens(tokensOut, retry.tokensOut);
    json = extractJSON(retry.text);
  }
  if (!json) throw providerError('PARSE_FAILED', 'Model did not return parseable JSON after one retry');
  return { json, tokensIn, tokensOut };
}
