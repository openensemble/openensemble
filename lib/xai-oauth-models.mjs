/**
 * Model catalog for the SuperGrok / xAI OAuth provider (xai-oauth).
 *
 * Prefer a live list from the Grok CLI proxy when a token is present; fall back
 * to a curated static list so the Settings UI works during setup.
 */

import fs from 'fs';
import path from 'path';
import { ensureFreshToken, GROK_CLI_PROXY_BASE, GROK_CLI_HEADERS, isConnected } from './xai-oauth-auth.mjs';
import { getUserDir, atomicWriteSync } from '../routes/_helpers.mjs';
import { modelCapabilities, supportsImageGeneration, supportsVision } from './model-capabilities.mjs';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Curated defaults when live catalog is unavailable. Text chat models only. */
export const XAI_OAUTH_FALLBACK_MODELS = [
  { id: 'grok-4.5', name: 'Grok 4.5' },
  { id: 'grok-4.3', name: 'Grok 4.3' },
  { id: 'grok-build-0.1', name: 'Grok Build 0.1' },
  { id: 'grok-4.20-0309-reasoning', name: 'Grok 4.20 Reasoning' },
  { id: 'grok-4.20-0309-non-reasoning', name: 'Grok 4.20 Fast' },
];

function cachePath(userId) {
  return path.join(getUserDir(userId), 'xai-oauth-models.json');
}

function readCache(userId) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(userId), 'utf8'));
    if (!Array.isArray(raw.models)) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(userId, models) {
  const p = cachePath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify({ fetchedAt: Date.now(), models }, null, 2));
}

function isMediaOnly(id) {
  return /^grok-imagine-(?:image|video)/i.test(id)
    || /\b(?:image|video)\b/i.test(id) && /imagine/i.test(id);
}

function annotate(model) {
  const id = model.id ?? model.slug ?? model.name;
  if (!id || isMediaOnly(String(id))) return null;
  const displayName = model.name ?? model.displayName ?? model.display_name ?? id;
  const caps = modelCapabilities('xai-oauth', id, {
    capabilities: model.capabilities,
    output_modalities: model.output_modalities,
  });
  return {
    id,
    name: displayName,
    displayName,
    contextLen: model.contextLen ?? model.context_window ?? model.max_context_window ?? null,
    supportsVision: supportsVision('xai-oauth', id, { capabilities: model.capabilities }),
    supportsImageGeneration: supportsImageGeneration('xai-oauth', id, {
      capabilities: model.capabilities,
      output_modalities: model.output_modalities,
    }),
    capabilities: caps,
  };
}

async function fetchLiveModels(userId) {
  const auth = await ensureFreshToken(userId);
  const headers = {
    'Accept': 'application/json',
    'Authorization': `Bearer ${auth.access_token}`,
    ...GROK_CLI_HEADERS,
  };
  const url = `${GROK_CLI_PROXY_BASE.replace(/\/$/, '')}/models`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    // Some proxy builds have no /models — fall through to static.
    throw new Error(`xAI OAuth models ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const raw = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
    : Array.isArray(data) ? data
    : [];
  const models = raw.map(annotate).filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!models.length) throw new Error('xAI OAuth models list empty');
  return models;
}

function fallbackAnnotated() {
  return XAI_OAUTH_FALLBACK_MODELS.map(m => annotate(m)).filter(Boolean);
}

/**
 * @param {string} userId
 * @param {{ refresh?: boolean, strict?: boolean }} [opts]
 * @returns {Promise<Array<{id, name, displayName, ...}>>}
 */
export async function listXaiOAuthModels(userId, { refresh = false, strict = false } = {}) {
  if (!isConnected(userId)) {
    if (strict) return [];
    return fallbackAnnotated();
  }

  if (!refresh) {
    const cached = readCache(userId);
    if (cached && Array.isArray(cached.models) && cached.models.length
        && (Date.now() - (cached.fetchedAt || 0)) < CACHE_TTL_MS) {
      return cached.models.map(annotate).filter(Boolean);
    }
  }

  try {
    const models = await fetchLiveModels(userId);
    writeCache(userId, models);
    return models;
  } catch (e) {
    const cached = readCache(userId);
    if (cached?.models?.length) return cached.models.map(annotate).filter(Boolean);
    if (strict) throw e;
    return fallbackAnnotated();
  }
}
