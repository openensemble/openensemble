import fs from 'fs';
import path from 'path';
import { OPENAI_OAUTH_BASE } from '../chat/providers/_shared.mjs';
import { ensureFreshToken } from './openai-codex-auth.mjs';
import { getUserDir, withLock, atomicWriteSync } from '../routes/_helpers.mjs';
import { modelCapabilities, supportsImageGeneration, supportsVision } from './model-capabilities.mjs';

const CODEX_CLIENT_VERSION = process.env.OE_CODEX_CLIENT_VERSION || '0.142.4';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export const OPENAI_OAUTH_FALLBACK_MODELS = [
  { id: 'gpt-5.5',             name: 'GPT-5.5' },
  { id: 'gpt-5.4',             name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini',        name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
];

function cachePath(userId) {
  return path.join(getUserDir(userId), 'openai-codex-models.json');
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
  atomicWriteSync(p, JSON.stringify({
    fetchedAt: Date.now(),
    clientVersion: CODEX_CLIENT_VERSION,
    models,
  }, null, 2));
}

function annotate(model) {
  const id = model.id ?? model.slug ?? model.name;
  const displayName = model.name ?? model.displayName ?? model.display_name ?? id;
  const caps = modelCapabilities('openai-oauth', id, {
    capabilities: model.capabilities,
    output_modalities: model.output_modalities,
    tools: model.tools,
  });
  return {
    id,
    name: displayName,
    displayName,
    contextLen: model.contextLen ?? model.context_window ?? model.max_context_window ?? null,
    supportsVision: supportsVision('openai-oauth', id, { capabilities: model.capabilities }),
    supportsImageGeneration: supportsImageGeneration('openai-oauth', id, {
      capabilities: model.capabilities,
      output_modalities: model.output_modalities,
      tools: model.tools,
    }),
    capabilities: caps,
  };
}

function sanitizeCodexModel(model) {
  const id = model.slug ?? model.id ?? model.name;
  if (!id) return null;
  if (model.visibility === 'hide') return null;
  return annotate({
    id,
    name: model.display_name ?? id,
    contextLen: model.context_window ?? model.max_context_window ?? null,
    capabilities: [
      ...(model.input_modalities?.includes('image') ? ['image_input'] : []),
      ...(model.supports_parallel_tool_calls ? ['tool_use'] : []),
      ...(model.web_search_tool_type ? ['web_search'] : []),
    ],
  });
}

async function fetchLiveModels(userId) {
  const auth = await ensureFreshToken(userId);
  const headers = {
    'Accept':        'application/json',
    'Authorization': `Bearer ${auth.access_token}`,
    'OpenAI-Beta':   'responses=experimental',
    'Originator':    'codex_cli_rs',
  };
  if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id;

  const url = `${OPENAI_OAUTH_BASE}/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`OpenAI Codex models ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const models = (data.models ?? [])
    .map(sanitizeCodexModel)
    .filter(Boolean)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (!models.length) throw new Error('OpenAI Codex models endpoint returned no visible models');
  return models;
}

export async function listOpenAIOAuthModels(userId, { refresh = false, strict = false } = {}) {
  if (!userId) {
    return OPENAI_OAUTH_FALLBACK_MODELS.map(annotate);
  }
  const p = cachePath(userId);
  return withLock(p, async () => {
    const cached = readCache(userId);
    if (!refresh && cached?.clientVersion === CODEX_CLIENT_VERSION && Date.now() - (cached.fetchedAt ?? 0) < CACHE_TTL_MS) {
      return cached.models.map(annotate);
    }
    try {
      const models = await fetchLiveModels(userId);
      writeCache(userId, models);
      return models;
    } catch (e) {
      if (strict) throw e;
      if (cached?.models?.length) {
        console.warn('[openai-oauth-models] live fetch failed; using cached list:', e.message);
        return cached.models.map(annotate);
      }
      console.warn('[openai-oauth-models] live fetch failed; using fallback list:', e.message);
      return OPENAI_OAUTH_FALLBACK_MODELS.map(annotate);
    }
  });
}
