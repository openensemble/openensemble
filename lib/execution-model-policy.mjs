// @ts-check
/** Fail-closed, catalog-backed authorization for saved execution profiles. */

import { getUser, loadConfig } from '../routes/_helpers.mjs';
import { OPENAI_COMPAT_PROVIDERS, getCompatKey, getAnthropicKey, getOpenRouterKey, getGrokKey } from '../chat/providers/_shared.mjs';
import { isConnected } from './openai-codex-auth.mjs';
import { listOpenAIOAuthModels } from './openai-codex-models.mjs';

const CATALOG_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const cache = new Map();

const PERPLEXITY_MODELS = Object.freeze([
  'sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro', 'sonar-deep-research',
]);

function denied(reason, error, status = 400) {
  return { ok: false, reason, error, status };
}

function modelId(value) {
  return typeof value === 'string' ? value : value?.id ?? value?.slug ?? value?.name ?? null;
}

function uniqueModelIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(modelId).filter(Boolean).map(String))];
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
  if (provider === 'anthropic') return !!getAnthropicKey();
  if (provider === 'openrouter') return !!getOpenRouterKey();
  if (provider === 'grok' || provider === 'xai') return !!getGrokKey();
  if (provider === 'ollama' || provider === 'lmstudio') return true;
  if (OPENAI_COMPAT_PROVIDERS[provider]) return !!getCompatKey(provider);
  return false;
}

function knownProvider(provider) {
  return provider === 'openai-oauth' || provider === 'anthropic'
    || provider === 'openrouter' || provider === 'grok' || provider === 'xai'
    || provider === 'ollama' || provider === 'lmstudio'
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
  return uniqueModelIds(out);
}

async function listOpenRouterModels() {
  const data = await fetchJson('https://openrouter.ai/api/v1/models', {
    Authorization: `Bearer ${getOpenRouterKey()}`,
  });
  return uniqueModelIds((data?.data ?? []).filter(item => {
    const modality = item?.architecture?.modality;
    const inputs = item?.architecture?.input_modalities;
    return typeof modality !== 'string' || modality.includes('text')
      || (Array.isArray(inputs) && inputs.includes('text'));
  }));
}

async function listGrokModels() {
  const headers = { Authorization: `Bearer ${getGrokKey()}` };
  let data;
  try { data = await fetchJson('https://api.x.ai/v1/language-models', headers); }
  catch { data = await fetchJson('https://api.x.ai/v1/models', headers); }
  return uniqueModelIds(data?.models ?? data?.data ?? []);
}

function ollamaCatalogSources(cfg) {
  const configured = String(cfg.cortex?.ollamaUrl ?? 'https://ollama.com/api').replace(/\/api\/?$/, '');
  const key = cfg.cortex?.ollamaApiKey ?? cfg.ollamaApiKey ?? null;
  const isConfiguredLocal = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(configured);
  const sources = [];
  if (isConfiguredLocal) {
    if (cfg.enabledProviders?.['ollama-local'] !== false) {
      sources.push({ base: configured, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    }
  } else {
    if (cfg.enabledProviders?.ollama !== false) {
      sources.push({ base: configured, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    }
    if (cfg.enabledProviders?.['ollama-local'] !== false) {
      sources.push({ base: 'http://localhost:11434', headers: {} });
    }
  }
  return sources;
}

async function listOllamaModels(cfg) {
  const settled = await Promise.allSettled(ollamaCatalogSources(cfg).map(async source => {
    const data = await fetchJson(`${source.base}/api/tags`, source.headers, 4_000);
    return data?.models ?? [];
  }));
  const fulfilled = settled.filter(item => item.status === 'fulfilled').flatMap(item => item.value);
  if (!fulfilled.length && settled.some(item => item.status === 'rejected')) {
    throw settled.find(item => item.status === 'rejected').reason;
  }
  return uniqueModelIds(fulfilled).flatMap(id => {
    const values = [id];
    if (id.endsWith(':cloud')) values.push(id.slice(0, -':cloud'.length));
    if (id.endsWith('-cloud')) values.push(id.slice(0, -'-cloud'.length));
    return values;
  });
}

async function listLmstudioModels(cfg) {
  const base = String(cfg.cortex?.lmstudioUrl ?? cfg.lmstudioUrl ?? 'http://127.0.0.1:1234').replace(/\/+$/, '');
  const key = cfg.cortex?.lmstudioApiKey ?? cfg.lmstudioApiKey ?? null;
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  try {
    const data = await fetchJson(`${base}/api/v1/models`, headers, 4_000);
    return uniqueModelIds((data?.models ?? []).filter(item => !item?.type || item.type === 'llm').map(item => ({
      id: item?.key ?? item?.id,
    })));
  } catch {
    const data = await fetchJson(`${base}/v1/models`, headers, 4_000);
    return uniqueModelIds(data?.data ?? []);
  }
}

async function listCompatModels(provider) {
  if (provider === 'perplexity') return [...PERPLEXITY_MODELS];
  const meta = OPENAI_COMPAT_PROVIDERS[provider];
  const data = await fetchJson(`${String(meta.baseUrl).replace(/\/+$/, '')}/models`, {
    Authorization: `Bearer ${getCompatKey(provider)}`,
  });
  return uniqueModelIds(Array.isArray(data?.data) ? data.data : data?.models ?? []);
}

async function loadCatalog(userId, provider, cfg, { refresh = false } = {}) {
  const cacheKey = `${userId}\0${provider}`;
  const hit = cache.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.models;

  let models;
  if (provider === 'openai-oauth') {
    models = uniqueModelIds(await listOpenAIOAuthModels(userId, { refresh, strict: true }));
  } else if (provider === 'anthropic') {
    models = await listAnthropicModels();
  } else if (provider === 'openrouter') {
    models = await listOpenRouterModels();
  } else if (provider === 'grok' || provider === 'xai') {
    models = await listGrokModels();
  } else if (provider === 'ollama') {
    models = await listOllamaModels(cfg);
  } else if (provider === 'lmstudio') {
    models = await listLmstudioModels(cfg);
  } else {
    models = await listCompatModels(provider);
  }
  cache.set(cacheKey, { at: Date.now(), models });
  return models;
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
  if (provider === 'openai-oauth' && !privileged
      && (!Array.isArray(user.allowedOAuthProviders) || !user.allowedOAuthProviders.includes(provider))) {
    return denied('oauth-provider-not-allowed', 'OpenAI login models are not enabled for this account', 403);
  }

  const cfg = loadConfig();
  if (provider === 'ollama') {
    if (!ollamaCatalogSources(cfg).length) return denied('provider-disabled', 'Provider "ollama" is disabled');
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
    const models = await loadCatalog(userId, provider, access.cfg, { refresh: refreshCatalog });
    const allowed = Array.isArray(access.user.allowedModels) ? new Set(access.user.allowedModels) : null;
    return models.filter(id => {
      if (allowed && !allowed.has(id)) return false;
      if ((provider === 'grok' || provider === 'xai') && /^grok-imagine-(?:image|video)/i.test(id)) return false;
      return true;
    });
  } catch {
    return [];
  }
}

export async function validateExecutionModelAccess(userId, provider, model, { refreshCatalog = false } = {}) {
  const access = canUseExecutionProvider(userId, provider);
  if (!access.ok) return access;
  if (provider === 'fireworks'
      || ((provider === 'grok' || provider === 'xai') && /^grok-imagine-(?:image|video)/i.test(model))) {
    return denied('not-text-model', 'That provider/model is not a text model');
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
  if (!catalog.includes(model)) {
    return denied('model-unavailable', `Model "${model}" is not available from provider "${provider}"`);
  }
  return { ok: true, reason: 'available', status: 200 };
}

export const _internal = { uniqueModelIds, providerEnabled, knownProvider, ollamaCatalogSources, cache };
