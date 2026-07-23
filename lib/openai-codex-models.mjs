import fs from 'fs';
import path from 'path';
import { OPENAI_OAUTH_BASE } from '../chat/providers/_shared.mjs';
import { ensureFreshToken } from './openai-codex-auth.mjs';
import { getUserDir, withLock, atomicWriteSync } from '../routes/_helpers.mjs';
import { modelCapabilities, supportsImageGeneration, supportsVision } from './model-capabilities.mjs';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RELEASE_VERSION_TTL_MS = 6 * 60 * 60 * 1000;
const CODEX_RELEASE_URL = 'https://api.github.com/repos/openai/codex/releases/latest';

// OpenAI gates newly released models by the Codex client_version query
// parameter. Resolve the latest stable release at runtime so OE does not need
// a source-code bump for every model rollout. This floor keeps offline and
// GitHub-blocked installs on the newest catalog known when this build shipped.
export const CODEX_CLIENT_VERSION_FLOOR = '0.145.0';

let releaseVersion = null;
let releaseVersionCheckedAt = 0;
let releaseVersionPromise = null;

export const OPENAI_OAUTH_FALLBACK_MODELS = [
  { id: 'gpt-5.6-sol',         name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra',       name: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna',        name: 'GPT-5.6 Luna' },
  { id: 'gpt-5.5',             name: 'GPT-5.5' },
  { id: 'gpt-5.4',             name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini',        name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark' },
];

function parseCodexVersion(value) {
  const match = String(value ?? '').match(/(?:^|[^\d])(\d+\.\d+\.\d+)(?:$|[^\d])/);
  return match?.[1] ?? null;
}

function compareCodexVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function newestCodexVersion(...values) {
  return values
    .map(parseCodexVersion)
    .filter(Boolean)
    .reduce((best, value) => !best || compareCodexVersions(value, best) > 0 ? value : best, null);
}

export async function resolveCodexClientVersion({ refresh = false, cachedVersion = null } = {}) {
  const override = parseCodexVersion(process.env.OE_CODEX_CLIENT_VERSION);
  if (override) return override;

  const offlineVersion = newestCodexVersion(CODEX_CLIENT_VERSION_FLOOR, cachedVersion);
  const now = Date.now();
  if (!refresh && releaseVersion && now - releaseVersionCheckedAt < RELEASE_VERSION_TTL_MS) {
    return newestCodexVersion(offlineVersion, releaseVersion);
  }

  if (!releaseVersionPromise) {
    releaseVersionPromise = (async () => {
      try {
        const res = await fetch(CODEX_RELEASE_URL, {
          headers: {
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'OpenEnsemble',
          },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`GitHub releases ${res.status}`);
        const latest = parseCodexVersion((await res.json()).tag_name);
        if (!latest) throw new Error('latest Codex release did not contain a semantic version');
        releaseVersion = newestCodexVersion(releaseVersion, latest);
      } catch (e) {
        releaseVersion = newestCodexVersion(releaseVersion, offlineVersion);
        console.warn(`[openai-oauth-models] latest Codex version lookup failed; using ${releaseVersion}:`, e.message);
      } finally {
        releaseVersionCheckedAt = Date.now();
      }
      return releaseVersion;
    })().finally(() => { releaseVersionPromise = null; });
  }

  return newestCodexVersion(offlineVersion, await releaseVersionPromise);
}

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

function writeCache(userId, clientVersion, models) {
  const p = cachePath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify({
    fetchedAt: Date.now(),
    clientVersion,
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

async function fetchLiveModels(userId, clientVersion) {
  const auth = await ensureFreshToken(userId);
  const headers = {
    'Accept':        'application/json',
    'Authorization': `Bearer ${auth.access_token}`,
    'OpenAI-Beta':   'responses=experimental',
    'Originator':    'codex_cli_rs',
  };
  if (auth.account_id) headers['chatgpt-account-id'] = auth.account_id;

  const url = `${OPENAI_OAUTH_BASE}/models?client_version=${encodeURIComponent(clientVersion)}`;
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
    const override = parseCodexVersion(process.env.OE_CODEX_CLIENT_VERSION);
    const minimumVersion = override
      ?? newestCodexVersion(CODEX_CLIENT_VERSION_FLOOR, releaseVersion);
    if (!refresh
        && parseCodexVersion(cached?.clientVersion)
        && compareCodexVersions(cached.clientVersion, minimumVersion) >= 0
        && Date.now() - (cached.fetchedAt ?? 0) < CACHE_TTL_MS) {
      return cached.models.map(annotate);
    }
    const clientVersion = await resolveCodexClientVersion({
      refresh,
      cachedVersion: cached?.clientVersion,
    });
    try {
      const models = await fetchLiveModels(userId, clientVersion);
      writeCache(userId, clientVersion, models);
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
