// @ts-check
/** Fail-closed, catalog-backed authorization for saved execution profiles. */

import fs from 'fs';
import path from 'path';
import {
  atomicWriteSync,
  getUser,
  getUserDir,
  loadConfig,
  withLock,
} from '../routes/_helpers.mjs';
import { OPENAI_COMPAT_PROVIDERS, getCompatKey, getAnthropicKey, getOpenRouterKey, getGrokKey } from '../chat/providers/_shared.mjs';
import { isConnected } from './openai-codex-auth.mjs';
import { isConnected as isXaiOAuthConnected } from './xai-oauth-auth.mjs';
import { listOpenAIOAuthModels } from './openai-codex-models.mjs';
import { listXaiOAuthModels } from './xai-oauth-models.mjs';
import { advertisedEffortValues, reasoningEffortOptions } from './reasoning-effort.mjs';
import { normalizeProviderModelsEndpoint } from './user-providers.mjs';
import { isGrokMultiAgentModel } from './provider-model-protocol.mjs';

const CATALOG_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const cache = new Map();
const capabilityCache = new Map();
const catalogLoads = new Map();

function denied(reason, error, status = 400) {
  return { ok: false, reason, error, status };
}

function modelId(value) {
  return typeof value === 'string' ? value : value?.id ?? value?.slug ?? value?.name ?? null;
}

function cleanCatalogLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  return label && label.length <= 300 && !/[\x00-\x1f\x7f]/.test(label) ? label : null;
}

function aliasValues(value, depth = 0) {
  if (depth > 2 || value == null) return [];
  const direct = cleanCatalogLabel(value);
  if (direct) return [direct];
  if (Array.isArray(value)) return value.slice(0, 64).flatMap(item => aliasValues(item, depth + 1));
  if (typeof value !== 'object') return [];
  const named = ['id', 'slug', 'name', 'value', 'title', 'displayName', 'display_name']
    .flatMap(key => aliasValues(value[key], depth + 1));
  // Some catalogs expose aliases as a map keyed by the public alias.
  const keys = Object.keys(value).slice(0, 64).map(cleanCatalogLabel).filter(Boolean);
  return [...named, ...keys];
}

function catalogEntry(value) {
  const id = cleanCatalogLabel(modelId(value));
  if (!id) return null;
  const displayName = typeof value === 'object' && value
    ? cleanCatalogLabel(value.displayName ?? value.display_name ?? value.title ?? value.name)
    : null;
  const candidates = typeof value === 'object' && value
    ? [...aliasValues(value.aliases), ...aliasValues(value.alias)]
    : [];
  const aliases = [...new Set(candidates.filter(alias => alias && alias !== id))];
  return { id, ...(displayName && displayName !== id ? { displayName } : {}), aliases };
}

function uniqueCatalogEntries(values) {
  const entries = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const entry = catalogEntry(value);
    if (!entry) continue;
    const prior = entries.get(entry.id);
    if (!prior) {
      entries.set(entry.id, entry);
      continue;
    }
    entries.set(entry.id, {
      ...prior,
      ...(prior.displayName ? {} : (entry.displayName ? { displayName: entry.displayName } : {})),
      aliases: [...new Set([...prior.aliases, ...entry.aliases])],
    });
  }
  return [...entries.values()];
}

function uniqueModelIds(values) {
  return uniqueCatalogEntries(values).map(entry => entry.id);
}

function normalizedMetadataWords(...values) {
  return values
    .flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

/** Conservative text-output filter for generic provider catalogs. */
function isTextCatalogModel(value) {
  if (typeof value === 'string') {
    return !/(?:^|[/_.:-])(?:text[-_]?embedding|embedding|embed|rerank|dall-e|gpt-image|whisper|tts|moderation)(?:$|[/_.:-])/i
      .test(value);
  }
  if (!value || typeof value !== 'object') return false;
  if (value.textModelKnown === true) return value.textModel === true;

  const outputModalities = value.output_modalities
    ?? value.outputModalities
    ?? value.architecture?.output_modalities
    ?? value.modalities?.output;
  if (Array.isArray(outputModalities) && outputModalities.length
      && !outputModalities.some(item => String(item).toLowerCase() === 'text')) return false;

  const architectureModality = String(value.architecture?.modality ?? '').toLowerCase();
  if (architectureModality.includes('->')) {
    const output = architectureModality.split('->').pop();
    if (output && !output.includes('text')) return false;
  }

  const category = normalizedMetadataWords(
    value.type, value.kind, value.task, value.mode, value.endpoint, value.category,
  );
  const explicitlyText = /\b(?:chat|completion|language|llm|text[-_ ]?generation)\b/.test(category);
  if (!explicitlyText
      && /\b(?:embed(?:ding)?s?|rerank(?:er|ing)?|image|video|audio|speech|tts|transcri(?:be|ption)|moderation)\b/.test(category)) {
    return false;
  }

  const capabilities = normalizedMetadataWords(value.capabilities);
  if (capabilities
      && /\b(?:embed(?:ding)?s?|rerank(?:er|ing)?|image_generation|video_generation|speech|tts|transcription)\b/.test(capabilities)
      && !/\b(?:chat|completion|language|llm|text_generation|text-output)\b/.test(capabilities)) {
    return false;
  }

  const id = String(modelId(value) ?? '');
  return isTextCatalogModel(id);
}

function capabilityPath(userId) {
  return path.join(getUserDir(userId), 'execution-model-capabilities.json');
}

function readCapabilityFile(userId) {
  const file = capabilityPath(userId);
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* first use */ }
  const hit = capabilityCache.get(userId);
  if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  let value = { version: 1, providers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) value = parsed;
  } catch { /* first use or invalid file */ }
  value.version = 1;
  if (!value.providers || typeof value.providers !== 'object') value.providers = {};
  capabilityCache.set(userId, { mtimeMs, data: value });
  return value;
}

const OPENROUTER_GATEWAY_EFFORTS = Object.freeze([
  'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none',
]);

function owns(value, key) {
  return value != null && typeof value === 'object' && Object.hasOwn(value, key);
}

function genericAdvertisedReasoningValue(model) {
  const candidates = [
    [model, 'supportedReasoningLevels'],
    [model, 'supported_reasoning_levels'],
    [model, 'reasoningEfforts'],
    [model, 'reasoning_efforts'],
    [model, 'effortLevels'],
    [model, 'effort_levels'],
    [model?.reasoning, 'efforts'],
    [model?.reasoning, 'levels'],
    [model?.reasoning, 'supported_efforts'],
    [model?.capabilities, 'reasoning_levels'],
    [model?.capabilities, 'reasoning_efforts'],
    [model?.capabilities?.reasoning, 'levels'],
    [model?.capabilities?.reasoning, 'efforts'],
    [model?.capabilities?.reasoning, 'allowed_options'],
    // Future/custom catalogs often expose the effort capability map directly
    // at capabilities.reasoning, for example
    // { reasoning: { low: { supported: true }, ultra_code: { supported: true } } }.
    [model?.capabilities, 'reasoning'],
  ];
  for (const [container, key] of candidates) {
    if (owns(container, key) && container[key] != null) {
      return { found: true, value: container[key] };
    }
  }
  return { found: false, value: null };
}

function openRouterEffortUniverse(values) {
  const seen = new Set();
  const levels = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (!owns(value?.reasoning, 'supported_efforts')
        || value.reasoning.supported_efforts == null) continue;
    for (const effort of advertisedEffortValues(value.reasoning.supported_efforts)) {
      if (seen.has(effort)) continue;
      seen.add(effort);
      levels.push(effort);
    }
  }
  return levels.length ? levels : [...OPENROUTER_GATEWAY_EFFORTS];
}

function reasoningCapabilityProfile(model, provider, providerEfforts = []) {
  if (!model || typeof model !== 'object') {
    return { known: false, reasoningEfforts: [], source: 'provider-default' };
  }
  if (provider === 'openrouter') {
    if (!owns(model, 'reasoning') || !model.reasoning
        || !owns(model.reasoning, 'supported_efforts')) {
      return { known: true, reasoningEfforts: [], source: 'provider-catalog' };
    }
    const advertised = model.reasoning.supported_efforts === null
      ? [...providerEfforts]
      : advertisedEffortValues(model.reasoning.supported_efforts);
    return {
      known: true,
      // OpenRouter's mandatory flag is per model. Even when null means the
      // gateway-wide effort universe, `none` is not valid for that model.
      reasoningEfforts: model.reasoning.mandatory === true
        ? advertised.filter(effort => effort !== 'none')
        : advertised,
      source: 'provider-catalog',
    };
  }
  if (provider === 'anthropic' && model.capabilities
      && typeof model.capabilities === 'object'
      && owns(model.capabilities, 'effort')
      && model.capabilities.effort != null) {
    return {
      known: true,
      reasoningEfforts: advertisedEffortValues(model.capabilities.effort ?? []),
      source: 'provider-catalog',
    };
  }
  if (provider === 'lmstudio' && owns(model, 'capabilities')) {
    return {
      known: true,
      reasoningEfforts: advertisedEffortValues(
        model.capabilities?.reasoning?.allowed_options ?? [],
      ),
      source: 'provider-catalog',
    };
  }
  if (model.reasoningCapabilitiesKnown === true) {
    return {
      known: true,
      reasoningEfforts: advertisedEffortValues(model.supportedReasoningLevels ?? []),
      source: 'provider-derived',
    };
  }
  const generic = genericAdvertisedReasoningValue(model);
  return generic.found
    ? {
        known: true,
        reasoningEfforts: advertisedEffortValues(generic.value),
        source: 'provider-catalog',
      }
    : { known: false, reasoningEfforts: [], source: 'provider-default' };
}

function advertisedReasoningLevels(model, provider = null, providerEfforts = []) {
  return reasoningCapabilityProfile(model, provider, providerEfforts).reasoningEfforts;
}

async function persistCatalogCapabilities(userId, provider, values) {
  const providerEfforts = provider === 'openrouter' ? openRouterEffortUniverse(values) : [];
  const profiles = (Array.isArray(values) ? values : [])
    .map(value => {
      const entry = catalogEntry(value);
      const capability = reasoningCapabilityProfile(value, provider, providerEfforts);
      return {
        id: entry?.id,
        displayName: entry?.displayName ?? null,
        aliases: entry?.aliases ?? [],
        ...capability,
        defaultReasoningEffort: (value && typeof value === 'object')
          ? (value.defaultReasoningLevel
            ?? value.default_reasoning_level
            ?? value.reasoning_effort
            ?? value.reasoning?.default_effort
            ?? value.capabilities?.reasoning?.default
            ?? null)
          : null,
      };
    })
    .filter(value => value.id);
  if (!profiles.length) return;
  const file = capabilityPath(userId);
  await withLock(file, () => {
    // Re-read inside the cross-process lock so a different provider refresh
    // cannot be overwritten by this one.
    capabilityCache.delete(userId);
    const data = readCapabilityFile(userId);
    const previous = data.providers[provider] && typeof data.providers[provider] === 'object'
      ? data.providers[provider]
      : {};
    const next = { ...previous };
    const now = Date.now();
    for (const profile of profiles) {
      const prior = previous[profile.id] && typeof previous[profile.id] === 'object'
        ? previous[profile.id]
        : null;
      const priorEfforts = advertisedEffortValues(prior?.reasoningEfforts);
      const generatedEfforts = Array.isArray(prior?.generatedReasoningEfforts)
        ? advertisedEffortValues(prior.generatedReasoningEfforts)
        : null;
      const generatedWasEdited = generatedEfforts !== null
        && JSON.stringify(priorEfforts) !== JSON.stringify(generatedEfforts);
      if (prior?.source === 'user'
          || (profile.source !== 'provider-catalog' && generatedWasEdited)) continue;
      if (!profile.known && prior && prior.source !== 'provider-default') continue;

      const reasoningEfforts = profile.known
        ? profile.reasoningEfforts
        : reasoningEffortOptions(provider, profile.id)
          .map(option => option.value)
          .filter(value => value !== 'auto');
      next[profile.id] = {
        ...(prior || {}),
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        aliases: [...profile.aliases],
        reasoningEfforts,
        reasoningEffortsKnown: profile.known,
        ...(profile.defaultReasoningEffort
          ? { defaultReasoningEffort: String(profile.defaultReasoningEffort) }
          : {}),
        source: profile.source,
        updatedAt: now,
      };
      if (!profile.defaultReasoningEffort) delete next[profile.id].defaultReasoningEffort;
      if (profile.source === 'provider-catalog') {
        delete next[profile.id].generatedReasoningEfforts;
      } else {
        next[profile.id].generatedReasoningEfforts = [...reasoningEfforts];
      }
    }
    data.providers = { ...data.providers, [provider]: next };
    data.updatedAt = now;
    atomicWriteSync(file, JSON.stringify(data, null, 2));
    capabilityCache.delete(userId);
  });
}

export function cachedExecutionModelCapabilities(userId, provider, model) {
  const profile = readCapabilityFile(userId)?.providers?.[provider]?.[model];
  if (!profile || typeof profile !== 'object') return null;
  const reasoningEfforts = advertisedEffortValues(profile.reasoningEfforts);
  return Object.hasOwn(profile, 'reasoningEfforts') || profile.reasoningEffortsKnown === true
    ? { ...profile, reasoningEfforts }
    : null;
}

/** @returns {Promise<any>} */
async function fetchJson(url, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200);
    throw new Error(`model catalog HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response.json();
}

function providerEnabled(cfg, provider) {
  const id = provider === 'xai' ? 'grok' : provider;
  return cfg.enabledProviders?.[id] !== false;
}

function configuredProvider(provider, cfg, userId) {
  if (provider === 'openai-oauth') return isConnected(userId);
  if (provider === 'xai-oauth') return isXaiOAuthConnected(userId);
  if (provider === 'anthropic') return !!getAnthropicKey();
  if (provider === 'openrouter') return !!getOpenRouterKey();
  if (provider === 'grok' || provider === 'xai') return !!getGrokKey();
  if (provider === 'ollama' || provider === 'ollama-local') {
    const sources = ollamaCatalogSources(cfg, provider);
    // Local/self-hosted Ollama may legitimately be unauthenticated. The
    // official cloud endpoint cannot execute without a Bearer API key, even
    // though its public catalog endpoints may still answer successfully.
    return sources.some(source => !isOfficialOllamaCloudBase(source.base)
      || typeof source.headers?.Authorization === 'string');
  }
  if (provider === 'lmstudio') return true;
  if (OPENAI_COMPAT_PROVIDERS[provider]) return !!getCompatKey(provider);
  return false;
}

function knownProvider(provider) {
  return provider === 'openai-oauth' || provider === 'xai-oauth' || provider === 'anthropic'
    || provider === 'openrouter' || provider === 'grok' || provider === 'xai'
    || provider === 'ollama' || provider === 'ollama-local' || provider === 'lmstudio'
    || !!OPENAI_COMPAT_PROVIDERS[provider];
}

async function listAnthropicModels() {
  const key = getAnthropicKey();
  let afterId = null;
  let pages = 0;
  const out = [];
  do {
    const suffix = afterId ? `&after_id=${encodeURIComponent(afterId)}` : '';
    const data = await fetchJson(`https://api.anthropic.com/v1/models?limit=1000${suffix}`, {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    });
    out.push(...(data?.data ?? []));
    afterId = data?.has_more ? data?.last_id : null;
    pages++;
  } while (afterId && pages < 10);
  return out;
}

async function listOpenRouterModels() {
  const data = await fetchJson('https://openrouter.ai/api/v1/models', {
    Authorization: `Bearer ${getOpenRouterKey()}`,
  });
  return (data?.data ?? []).filter(item => {
    const modality = item?.architecture?.modality;
    const inputs = item?.architecture?.input_modalities;
    return typeof modality !== 'string' || modality.includes('text')
      || (Array.isArray(inputs) && inputs.includes('text'));
  });
}

async function listGrokModels() {
  const headers = { Authorization: `Bearer ${getGrokKey()}` };
  let data;
  try { data = await fetchJson('https://api.x.ai/v1/language-models', headers); }
  catch { data = await fetchJson('https://api.x.ai/v1/models', headers); }
  // Grok 4.20 Multi-Agent requires Responses and rejects client-side custom
  // tools. OE workers depend on their coordination/function tools, so that
  // otherwise-text model is not a valid spawned-agent execution target.
  return (data?.models ?? data?.data ?? []).filter(value => !isGrokMultiAgentModel(modelId(value)));
}

function ollamaCatalogSources(cfg, provider = 'ollama') {
  if (provider === 'ollama-local') {
    if (cfg.enabledProviders?.['ollama-local'] === false) return [];
    const base = String(cfg.cortex?.ollamaLocalUrl || 'http://localhost:11434')
      .replace(/\/api\/?$/, '')
      .replace(/\/+$/, '');
    const key = cfg.cortex?.ollamaLocalApiKey ?? null;
    return [{ base, headers: key ? { Authorization: `Bearer ${key}` } : {} }];
  }
  if (cfg.enabledProviders?.ollama === false) return [];
  const base = String(cfg.cortex?.ollamaUrl ?? 'https://ollama.com/api')
    .replace(/\/api\/?$/, '')
    .replace(/\/+$/, '');
  const key = cfg.cortex?.ollamaApiKey ?? cfg.ollamaApiKey ?? null;
  return [{ base, headers: key ? { Authorization: `Bearer ${key}` } : {} }];
}

function isOfficialOllamaCloudBase(base) {
  try {
    const url = new URL(base);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'ollama.com'
      && (!url.port || url.port === '443');
  } catch {
    return false;
  }
}

async function verifyOllamaCloudCredential(source) {
  if (!isOfficialOllamaCloudBase(source.base)) return;
  if (typeof source.headers?.Authorization !== 'string') {
    throw new Error('Ollama Cloud API key is not configured');
  }
  const response = await fetch(`${source.base}/api/me`, {
    method: 'POST',
    headers: source.headers,
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) {
    throw new Error(`Ollama Cloud credential check HTTP ${response.status}`);
  }
}

async function listOllamaModels(cfg, provider = 'ollama') {
  const settled = await Promise.allSettled(ollamaCatalogSources(cfg, provider).map(async source => {
    await verifyOllamaCloudCredential(source);
    const data = await fetchJson(`${source.base}/api/tags`, source.headers, 4_000);
    return { source, models: data?.models ?? [] };
  }));
  const fulfilled = settled.filter(item => item.status === 'fulfilled').map(item => item.value);
  if (!fulfilled.length && settled.some(item => item.status === 'rejected')) {
    throw settled.find(item => item.status === 'rejected').reason;
  }
  const byId = new Map();
  for (const { source, models } of fulfilled) {
    for (const value of models) {
      const id = modelId(value);
      if (id && !byId.has(String(id))) byId.set(String(id), { value, source });
    }
  }

  const entries = [...byId.entries()];
  const enriched = [];
  // /api/tags does not expose thinking capabilities. /api/show is metadata
  // only (it does not run inference), so enrich in bounded batches.
  for (let offset = 0; offset < entries.length; offset += 12) {
    const batch = entries.slice(offset, offset + 12);
    enriched.push(...await Promise.all(batch.map(async ([id, { value, source }]) => {
      /** @type {any} */
      let detail = value && typeof value === 'object' ? value : {};
      let capabilities = Array.isArray(detail.capabilities) && detail.capabilities.length
        ? detail.capabilities
        : null;
      if (!capabilities) {
        try {
          const response = await fetch(`${source.base}/api/show`, {
            method: 'POST',
            headers: { ...source.headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: id }),
            signal: AbortSignal.timeout(4_000),
          });
          if (response.ok) {
            /** @type {any} */
            const shown = await response.json();
            detail = { ...detail, ...shown, details: shown?.details ?? detail.details };
            capabilities = Array.isArray(shown?.capabilities) && shown.capabilities.length
              ? shown.capabilities
              : null;
          }
        } catch { /* fail closed below when text capability cannot be verified */ }
      }
      // Spawned workers need a text-completion model. If /api/tags omitted
      // capabilities and /api/show could not attest them, do not authorize an
      // id based on a name heuristic.
      if (!capabilities) return [id, {
        ...detail,
        textModelKnown: true,
        textModel: false,
        reasoningCapabilitiesKnown: true,
        supportedReasoningLevels: [],
      }];
      const normalizedCapabilities = capabilities.map(value => String(value).toLowerCase());
      const family = String(detail?.details?.family ?? '').toLowerCase();
      const thinking = normalizedCapabilities.includes('thinking');
      const gptOss = family === 'gptoss' || /(?:^|[/_-])gpt-?oss(?:$|[:/_-])/i.test(id);
      return [id, {
        ...detail,
        capabilities,
        textModelKnown: true,
        textModel: normalizedCapabilities.includes('completion'),
        reasoningCapabilitiesKnown: true,
        supportedReasoningLevels: thinking
          ? (gptOss ? ['low', 'medium', 'high'] : ['off', 'high'])
          : [],
      }];
    })));
  }

  return enriched
    .filter(([, value]) => value.textModelKnown !== true || value.textModel === true)
    .map(([id, value]) => {
      const aliases = [];
      if (id.endsWith(':cloud')) aliases.push(id.slice(0, -':cloud'.length));
      if (id.endsWith('-cloud')) aliases.push(id.slice(0, -'-cloud'.length));
      return value && typeof value === 'object'
        ? {
            ...value,
            id,
            aliases: [...new Set([
              ...(Array.isArray(value.aliases) ? value.aliases : []),
              ...aliases,
            ])],
          }
        : { id, aliases };
    });
}

async function listLmstudioModels(cfg) {
  const base = String(cfg.cortex?.lmstudioUrl ?? cfg.lmstudioUrl ?? 'http://127.0.0.1:1234').replace(/\/+$/, '');
  const key = cfg.cortex?.lmstudioApiKey ?? cfg.lmstudioApiKey ?? null;
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  try {
    const data = await fetchJson(`${base}/api/v1/models`, headers, 4_000);
    return (data?.models ?? [])
      .filter(item => !item?.type || item.type === 'llm')
      .map(item => item && typeof item === 'object'
        ? { ...item, id: item.key ?? item.id }
        : item);
  } catch {
    const data = await fetchJson(`${base}/v1/models`, headers, 4_000);
    return data?.data ?? [];
  }
}

async function listCompatModels(userId, provider) {
  const meta = OPENAI_COMPAT_PROVIDERS[provider];
  const modelsEndpoint = normalizeProviderModelsEndpoint(meta?.modelsEndpoint);
  const data = await fetchJson(`${String(meta.baseUrl).replace(/\/+$/, '')}${modelsEndpoint}`, {
    Authorization: `Bearer ${getCompatKey(provider)}`,
  });
  return Array.isArray(data?.data) ? data.data : data?.models ?? [];
}

async function loadCatalog(userId, provider, cfg, { refresh = false } = {}) {
  const cacheKey = `${userId}\0${provider}`;
  const hit = cache.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.entries;
  // A mixed wave can target many models on one provider. Coalesce those
  // strict refreshes so every pair is authorized against the same snapshot
  // and one OpenRouter-sized catalog is not downloaded once per child.
  const pending = catalogLoads.get(cacheKey);
  if (pending) {
    // A normal caller may safely share a strict refresh, and strict callers
    // may share each other. A strict refresh must never be weakened by joining
    // an older non-refresh OAuth/cache lookup.
    if (!refresh || pending.refresh === true) return pending.promise;
    try { await pending.promise; } catch { /* the strict retry below decides */ }
    // Re-enter after the weaker load settles. The first strict waiter installs
    // a strong in-flight entry synchronously; all remaining strict waiters then
    // join it instead of each fanning out into their own refresh.
    if (catalogLoads.get(cacheKey) === pending) catalogLoads.delete(cacheKey);
    return loadCatalog(userId, provider, cfg, { refresh: true });
  }
  const load = (async () => {
    let values;
    if (provider === 'openai-oauth') {
      values = await listOpenAIOAuthModels(userId, { refresh, strict: true });
    } else if (provider === 'xai-oauth') {
      values = await listXaiOAuthModels(userId, { refresh, strict: true });
    } else if (provider === 'anthropic') {
      values = await listAnthropicModels();
    } else if (provider === 'openrouter') {
      values = await listOpenRouterModels();
    } else if (provider === 'grok' || provider === 'xai') {
      values = await listGrokModels();
    } else if (provider === 'ollama' || provider === 'ollama-local') {
      values = await listOllamaModels(cfg, provider);
    } else if (provider === 'lmstudio') {
      values = await listLmstudioModels(cfg);
    } else {
      values = await listCompatModels(userId, provider);
    }
    const textValues = (Array.isArray(values) ? values : []).filter(isTextCatalogModel);
    const entries = uniqueCatalogEntries(textValues);
    await persistCatalogCapabilities(userId, provider, textValues);
    cache.set(cacheKey, { at: Date.now(), entries });
    return entries;
  })();
  const loadEntry = { promise: load, refresh };
  catalogLoads.set(cacheKey, loadEntry);
  try {
    return await load;
  } finally {
    if (catalogLoads.get(cacheKey) === loadEntry) catalogLoads.delete(cacheKey);
  }
}

/**
 * Whether this account may use the provider at all (policy + connection),
 * without requiring a specific model id yet.
 */
export function canUseExecutionProvider(userId, provider) {
  const user = getUser(userId);
  if (!user) return denied('user-not-found', 'User no longer exists', 404);
  if (!knownProvider(provider)) return denied('unknown-provider', `Unknown provider "${provider}"`);
  if (provider === 'fireworks') return denied('not-text-model', 'That provider is not a text chat provider');

  const privileged = user.role === 'owner' || user.role === 'admin';
  if ((provider === 'openai-oauth' || provider === 'xai-oauth') && !privileged
      && (!Array.isArray(user.allowedOAuthProviders) || !user.allowedOAuthProviders.includes(provider))) {
    const label = provider === 'xai-oauth' ? 'xAI SuperGrok login' : 'OpenAI login';
    return denied('oauth-provider-not-allowed', `${label} models are not enabled for this account`, 403);
  }

  const cfg = loadConfig();
  if (provider === 'ollama' || provider === 'ollama-local') {
    if (!ollamaCatalogSources(cfg, provider).length) {
      return denied('provider-disabled', `Provider "${provider}" is disabled`);
    }
  } else if (!providerEnabled(cfg, provider)) {
    return denied('provider-disabled', `Provider "${provider}" is disabled`);
  }
  if (!configuredProvider(provider, cfg, userId)) {
    return denied('provider-not-connected', `Provider "${provider}" is not connected or configured`);
  }
  return { ok: true, reason: 'available', status: 200, user, cfg };
}

/**
 * List text models for a provider that this account can currently use.
 * Returns [] on any failure so callers can fail closed to inheritance.
 */
export async function listExecutionCatalog(userId, provider, { refreshCatalog = false } = {}) {
  const access = canUseExecutionProvider(userId, provider);
  if (!access.ok) return [];
  try {
    const entries = await loadCatalog(userId, provider, access.cfg, { refresh: refreshCatalog });
    const allowed = Array.isArray(access.user.allowedModels) ? new Set(access.user.allowedModels) : null;
    return entries.filter(entry => {
      if (allowed && !allowed.has(entry.id)) return false;
      if ((provider === 'grok' || provider === 'xai' || provider === 'xai-oauth')
          && (/^grok-imagine-(?:image|video)/i.test(entry.id)
            || isGrokMultiAgentModel(entry.id))) return false;
      return true;
    }).map(entry => entry.id);
  } catch {
    return [];
  }
}

async function listExecutionCatalogEntries(userId, provider, { refreshCatalog = false } = {}) {
  const access = canUseExecutionProvider(userId, provider);
  if (!access.ok) return [];
  try {
    const entries = await loadCatalog(userId, provider, access.cfg, { refresh: refreshCatalog });
    const allowed = Array.isArray(access.user.allowedModels) ? new Set(access.user.allowedModels) : null;
    return entries.filter(entry => (!allowed || allowed.has(entry.id))
      && !((provider === 'grok' || provider === 'xai' || provider === 'xai-oauth')
        && (/^grok-imagine-(?:image|video)/i.test(entry.id)
          || isGrokMultiAgentModel(entry.id))));
  } catch {
    return [];
  }
}

function executionProviderIds() {
  return [...new Set([
    'openai-oauth',
    'xai-oauth',
    'anthropic',
    'openrouter',
    'grok',
    'ollama',
    'ollama-local',
    'lmstudio',
    ...Object.keys(OPENAI_COMPAT_PROVIDERS).filter(id => id !== 'xai'),
  ])].sort((a, b) => a.localeCompare(b));
}

const DISCOVERY_QUERY_STOP_WORDS = new Set([
  'agent', 'agents', 'all', 'at', 'for', 'model', 'models', 'on', 'provider',
  'providers', 'the', 'use', 'using', 'with', 'worker', 'workers',
]);

function executionTargetMatchesQuery(provider, model, query, aliases = []) {
  if (!query) return true;
  const rawNeedle = query.toLowerCase();
  const rawHaystack = `${provider} ${model} ${(Array.isArray(aliases) ? aliases : []).join(' ')}`.toLowerCase();
  if (rawHaystack.includes(rawNeedle)) return true;
  const haystack = rawHaystack.replace(/[^a-z0-9]+/g, ' ');
  const tokens = rawNeedle
    .split(/[^a-z0-9]+/)
    .filter(token => token && !DISCOVERY_QUERY_STOP_WORDS.has(token));
  return tokens.length > 0 && tokens.every(token => haystack.includes(token));
}

/**
 * Discover exact account-available provider/model pairs for model-facing
 * delegation. Results are paged so large aggregators (for example
 * OpenRouter) cannot flood one tool response.
 */
export async function listExecutionTargets(userId, {
  query = '',
  provider = null,
  refreshCatalog = false,
  limit = 20,
  offset = 0,
} = {}) {
  const cleanQuery = typeof query === 'string' ? query.trim() : '';
  if (cleanQuery.length > 200 || /[\x00-\x1f\x7f]/.test(cleanQuery)) {
    return { ok: false, error: 'query must be 200 characters or fewer' };
  }
  const cleanProvider = provider == null || provider === ''
    ? null
    : (typeof provider === 'string' ? provider.trim() : '');
  if (cleanProvider !== null
      && (!cleanProvider || cleanProvider.length > 100 || /[\x00-\x1f\x7f]/.test(cleanProvider))) {
    return { ok: false, error: 'provider must be a valid configured provider id' };
  }

  const boundedLimit = Math.min(50, Math.max(1, Number.isSafeInteger(limit) ? limit : 20));
  const boundedOffset = Math.min(10_000, Math.max(0, Number.isSafeInteger(offset) ? offset : 0));
  const providers = cleanProvider ? [cleanProvider] : executionProviderIds();
  if (cleanProvider) {
    const access = canUseExecutionProvider(userId, cleanProvider);
    if (!access.ok) return { ok: false, error: access.error, reason: access.reason };
  }

  const catalogs = await Promise.all(providers.map(async providerId => {
    const access = canUseExecutionProvider(userId, providerId);
    if (!access.ok) return [];
    const entries = await listExecutionCatalogEntries(userId, providerId, { refreshCatalog });
    return entries.map(entry => ({
      provider: providerId,
      model: entry.id,
      displayName: entry.displayName ?? null,
      aliases: entry.aliases,
    }));
  }));
  const matches = catalogs.flat()
    .filter(target => executionTargetMatchesQuery(
      target.provider,
      target.model,
      cleanQuery,
      [target.displayName, ...target.aliases].filter(Boolean),
    ))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  const page = matches.slice(boundedOffset, boundedOffset + boundedLimit);
  const targets = await Promise.all(page.map(async ({
    provider: providerId, model, displayName, aliases,
  }) => ({
    provider: providerId,
    model,
    ...(displayName ? { display_name: displayName } : {}),
    ...(aliases.length ? { aliases } : {}),
    reasoning_efforts: (await listExecutionReasoningEfforts(
      userId, providerId, model,
    )).map(option => option.value),
  })));
  return {
    ok: true,
    query: cleanQuery,
    provider: cleanProvider,
    total: matches.length,
    offset: boundedOffset,
    limit: boundedLimit,
    has_more: boundedOffset + targets.length < matches.length,
    targets,
  };
}

/**
 * Return the effort values supported by one exact execution pair. OAuth model
 * catalogs advertise this per model; providers without that metadata use the
 * conservative pair-specific matrix in reasoning-effort.mjs.
 */
export async function listExecutionReasoningEfforts(
  userId,
  provider,
  model,
  { refreshCatalog = false } = {},
) {
  let profile = cachedExecutionModelCapabilities(userId, provider, model);
  let advertised = profile?.reasoningEfforts ?? null;
  try {
    const access = canUseExecutionProvider(userId, provider);
    if (access.ok && (!profile || refreshCatalog)) {
      await loadCatalog(userId, provider, access.cfg, { refresh: refreshCatalog });
      profile = cachedExecutionModelCapabilities(userId, provider, model);
      advertised = profile?.reasoningEfforts ?? advertised;
    }
  } catch {
    // Model access validation reports catalog failures separately. Falling
    // back here keeps this helper useful to settings/discovery while remaining
    // conservative about levels the provider did not advertise.
  }
  return reasoningEffortOptions(provider, model, advertised);
}

export async function validateExecutionModelAccess(userId, provider, model, { refreshCatalog = false } = {}) {
  const access = canUseExecutionProvider(userId, provider);
  if (!access.ok) return access;
  if (provider === 'fireworks'
      || ((provider === 'grok' || provider === 'xai' || provider === 'xai-oauth')
        && /^grok-imagine-(?:image|video)/i.test(model))) {
    return denied('not-text-model', 'That provider/model is not a text model');
  }
  if ((provider === 'grok' || provider === 'xai' || provider === 'xai-oauth')
      && isGrokMultiAgentModel(model)) {
    return denied(
      'execution-tools-unsupported',
      'That model does not support the custom coordination tools required by spawned agents',
    );
  }

  if (Array.isArray(access.user.allowedModels) && !access.user.allowedModels.includes(model)) {
    return denied('model-not-allowed', `Model "${model}" is not available for this account`, 403);
  }

  let catalog;
  try {
    catalog = await loadCatalog(userId, provider, access.cfg, { refresh: refreshCatalog });
  } catch (error) {
    return denied('provider-unavailable', `Could not verify ${provider}'s model catalog: ${error?.message || error}`, 503);
  }
  if (!catalog.some(entry => entry.id === model)) {
    return denied('model-unavailable', `Model "${model}" is not available from provider "${provider}"`);
  }
  return { ok: true, reason: 'available', status: 200 };
}

export const _internal = {
  uniqueModelIds,
  uniqueCatalogEntries,
  isTextCatalogModel,
  providerEnabled,
  knownProvider,
  ollamaCatalogSources,
  isOfficialOllamaCloudBase,
  cache,
  catalogLoads,
  capabilityCache,
  advertisedReasoningLevels,
  executionProviderIds,
  executionTargetMatchesQuery,
};
