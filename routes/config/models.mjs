/**
 * Model listing routes. Extracted from routes/config.mjs.
 */
import {
  requireAuth, loadConfig, modifyConfig, safeError,
} from '../_helpers.mjs';
import { modelCapabilityFields } from '../../lib/model-capabilities.mjs';
import { mergeModelMetadata } from '../../lib/model-metadata.mjs';
import { enrichOpenAIModelMetadata } from '../../lib/openai-model-metadata.mjs';
import { listOpenAIOAuthModels } from '../../lib/openai-codex-models.mjs';
import { listXaiOAuthModels } from '../../lib/xai-oauth-models.mjs';
import { OPENAI_COMPAT_PROVIDERS, getCompatKey, getGrokKey, getAnthropicKey, getFireworksKey, getOpenRouterKey } from '../../chat/providers/_shared.mjs';
import { normalizeProviderModelsEndpoint } from '../../lib/user-providers.mjs';
import { log } from '../../logger.mjs';
import { checkOllamaCloudKey, isOfficialOllamaCloudBase, resolveOllamaKey } from '../../lib/ollama-cloud.mjs';
import { annotateProviderModel, readAnthropicModelCatalog, readOpenRouterModelCatalog, readGrokModelCatalog, readGeminiModelCatalog, enrichOllamaModelCatalog, readLmstudioModelCatalog } from '../../lib/provider-model-catalog.mjs';

const GROK_BASE = 'https://api.x.ai/v1';
const OLLAMA_DEFAULT = 'https://ollama.com/api';
const LMS_DEFAULT = 'http://127.0.0.1:1234';
const COMPAT_PROVIDERS = OPENAI_COMPAT_PROVIDERS;
// Settings refreshes update the same account-scoped records used by chat.
async function rememberModels(userId, provider, models) {
  const { recordModelCatalogCapabilities, cachedExecutionModelCapabilities } = await import('../../lib/execution-model-policy.mjs');
  await recordModelCatalogCapabilities(userId, provider, models);
  return models.map(model => ({ ...model,
    modelMetadata: cachedExecutionModelCapabilities(userId, provider, model.id ?? model.name)?.modelMetadata
      ?? model.modelMetadata,
  }));
}

// A provider REJECTING our credentials (401/403) is a configuration state, not
// a server fault: the honest model list for a key that cannot authenticate is
// an empty one, which is exactly what the no-key and provider-disabled paths
// already return. Throwing instead turned every Settings load into a 500 and
// filled error.log with identical stack traces — a stored key that is blank,
// malformed, or unentitled (an xAI SuperGrok login carries no api.x.ai access)
// produced thousands of them. Network faults and 5xx still surface, because
// those are transient and genuinely actionable.
const AUTH_REJECTION_STATUSES = new Set([401, 403]);

function respondEmptyOnAuthRejection(res, provider, status) {
  if (!AUTH_REJECTION_STATUSES.has(status)) return false;
  log.warn('config', 'provider rejected our credentials for its model list', {
    provider,
    status,
    hint: 'Stored API key is missing, malformed, or not entitled for API access. Re-enter it in Settings → Providers.',
  });
  res.writeHead(200, {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-OE-Provider-Status': 'authentication_failed',
    'X-OE-Provider-Message': status === 401
      ? 'API key rejected (HTTP 401). Replace it in Settings > Providers.'
      : 'API access rejected (HTTP 403). Check the API key, billing, and account permissions in Settings > Providers.',
  });
  res.end(JSON.stringify([]));
  return true;
}

export async function tryHandleModelRoutes(req, res) {

    // Media has its own live catalog. Never advertise invented/static slugs.
    if (req.url === '/api/grok-media-models' && req.method === 'GET') {
      const authId = requireAuth(req, res); if (!authId) return true;
      const cfg = loadConfig();
      const key = getGrokKey();
      if (cfg.enabledProviders?.grok === false || !key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return true;
      }
      try {
        const models = [];
        for (const kind of ['image', 'video']) {
          const r = await fetch(`${GROK_BASE}/${kind}-generation-models`, {
            headers: { Authorization: `Bearer ${key}` }, redirect: 'error',
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) {
            if (respondEmptyOnAuthRejection(res, 'grok', r.status)) return true;
            throw new Error(`xAI ${kind} catalog HTTP ${r.status}`);
          }
          const data = await r.json();
          for (const model of data.models ?? data.data ?? []) {
            const id = model.id ?? model.name;
            if (typeof id !== 'string' || !id) continue;
            const entry = annotateProviderModel('grok', { ...model, id,
              modelMetadata: mergeModelMetadata({ capabilities: [`${kind}_generation`], output_modalities: [kind] }, model),
            }, `${GROK_BASE}/${kind}-generation-models`);
            models.push({ id, displayName: `${id} (${kind})`,
              ...modelCapabilityFields('grok', id, entry),
              // Image input to a media endpoint is not a vision-chat endpoint.
              supportsVision: false,
            });
          }
        }
        await rememberModels(authId, 'grok', models);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(models));
      } catch (e) { safeError(res, e); }
      return true;
    }


    // List available chat models from xAI Grok (authoritative — no hardcoding).
    // Image/video models live on separate catalog endpoints.
    if (req.url === '/api/grok-models' && req.method === 'GET') {
      const authId = requireAuth(req, res); if (!authId) return true;
      const cfg = loadConfig();
      if (cfg.enabledProviders?.grok === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      const key = getGrokKey();
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      try {
        const list = await rememberModels(authId, 'grok', await readGrokModelCatalog({ Authorization: `Bearer ${key}` }));
        const models = list
          .map(m => {
            const id = m.id ?? m.name;
            return {
              id,
              displayName: id,
              ...modelCapabilityFields('grok', id, m),
            };
          })
          .filter(m => m.id)
          .sort((a, b) => a.id.localeCompare(b.id));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (e) { if (!respondEmptyOnAuthRejection(res, 'grok', e.status)) safeError(res, e); }
      return true;
    }

    // List available chat models from Anthropic (authoritative — no hardcoding)
    if (req.url === '/api/anthropic-models' && req.method === 'GET') {
      const authId = requireAuth(req, res); if (!authId) return true;
      const cfg = loadConfig();
      if (cfg.enabledProviders?.anthropic === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      const key = getAnthropicKey();
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      try {
        const allModels = await rememberModels(authId, 'anthropic', await readAnthropicModelCatalog({
          'x-api-key': key, 'anthropic-version': '2023-06-01',
        }));

        const models = allModels
          .map(m => ({
            id: m.id,
            displayName: m.display_name ?? m.id,
            createdAt: m.created_at ?? null,
            contextLen: m.modelMetadata?.limits?.contextWindow ?? null,
            ...modelCapabilityFields('anthropic', m.id, m),
          }))
          .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (e) { if (!respondEmptyOnAuthRejection(res, 'anthropic', e.status)) safeError(res, e); }
      return true;
    }

    // List available Fireworks image generation models
    if (req.url === '/api/fireworks-models' && req.method === 'GET') {
      const authId = requireAuth(req, res); if (!authId) return true;
      const cfg = loadConfig();
      if (cfg.enabledProviders?.fireworks === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      const key = getFireworksKey();
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      try {
        let allModels = [], pageToken = null, pagesFetched = 0;
        do {
          const url = `https://api.fireworks.ai/v1/accounts/fireworks/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
          const r = await fetch(url, { headers: { 'Authorization': `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
          if (!r.ok) {
            if (respondEmptyOnAuthRejection(res, 'fireworks', r.status)) return true;
            throw new Error(`Fireworks API ${r.status}`);
          }
          const data = await r.json();
          allModels = allModels.concat(data.models ?? []);
          pageToken = data.nextPageToken ?? null;
          pagesFetched++;
          // Safety cap in case the upstream returns a non-terminating cursor.
          if (pagesFetched > 20) break;
        } while (pageToken);

        // Preserve image-edit/input declarations while keeping these dedicated
        // media endpoints out of the vision-chat picker.
        const fluminaModels = allModels
          .filter(m => m.kind?.startsWith('FLUMINA'))
          .map(m => ({
            id: (m.name ?? '').split('/').pop(),
            displayName: m.displayName || m.name,
            ...modelCapabilityFields('fireworks', (m.name ?? '').split('/').pop(), annotateProviderModel('fireworks', {
              ...m, modelMetadata: mergeModelMetadata({ capabilities: ['image_generation'], output_modalities: ['image'] }, m),
            }, 'https://api.fireworks.ai/v1/accounts/fireworks/models')),
            supportsVision: false,
          }));
        await rememberModels(authId, 'fireworks', fluminaModels);

        // Fireworks deprecated image generation in June 2026. Only models
        // actually returned by its catalog remain selectable.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fluminaModels));
      } catch (e) { safeError(res, e); }
      return true;
    }

    // List available chat models from OpenRouter
    if (req.url === '/api/openrouter-models' && req.method === 'GET') {
      const authId = requireAuth(req, res); if (!authId) return true;
      const cfg = loadConfig();
      if (cfg.enabledProviders?.openrouter === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      const key = getOpenRouterKey();
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      try {
        const catalog = await rememberModels(authId, 'openrouter', await readOpenRouterModelCatalog({ Authorization: `Bearer ${key}` }));
        const models = catalog
          .filter(m => !m.architecture?.output_modalities?.length || m.architecture.output_modalities.includes('text'))
          .map(m => ({
            id:          m.id,
            name:        m.name ?? m.id,
            contextLen:  m.context_length ?? null,
            inputPrice:  m.pricing?.prompt  != null ? parseFloat(m.pricing.prompt)  * 1_000_000 : null,
            outputPrice: m.pricing?.completion != null ? parseFloat(m.pricing.completion) * 1_000_000 : null,
            ...modelCapabilityFields('openrouter', m.id, m),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        // Cache pricing in config.json so estimateCost can use it without an API call
        const pricing = {};
        for (const m of models) {
          if (m.inputPrice != null || m.outputPrice != null) {
            pricing[m.id] = { input: m.inputPrice ?? 0, output: m.outputPrice ?? 0 };
          }
        }
        await modifyConfig(cfg => { cfg.openrouterPricing = pricing; });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (e) { if (!respondEmptyOnAuthRejection(res, 'openrouter', e.status)) safeError(res, e); }
      return true;
    }

    // Generic per-provider model listing for OpenAI-compat providers.
    //   GET /api/provider-models/:provider
    // Returns [{ id, name, contextLen?, created? }] sorted by name.
    if (req.url?.startsWith('/api/provider-models/') && req.method === 'GET') {
      const authId = requireAuth(req, res); if (!authId) return true;
      const urlObj = new URL(req.url, 'http://x');
      const prov = urlObj.pathname.slice('/api/provider-models/'.length);
      // OAuth-backed ChatGPT provider: pull the account-visible Codex model list
      // when connected; fall back inside the helper for disconnected setup/admin UI.
      if (prov === 'openai-oauth') {
        const refresh = urlObj.searchParams.get('refresh') === '1';
        try {
          const annotated = await rememberModels(authId, prov, await listOpenAIOAuthModels(authId, { refresh, strict: refresh }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(annotated));
        } catch (e) {
          console.warn('[openai-oauth-models] explicit refresh failed:', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: e.providerUpdateMessage || 'Could not refresh OpenAI models. Check the ChatGPT connection and try again.',
          }));
        }
        return true;
      }
      if (prov === 'xai-oauth') {
        const annotated = await rememberModels(authId, prov, await listXaiOAuthModels(authId, { refresh: urlObj.searchParams.get('refresh') === '1' }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(annotated));
        return true;
      }
      const provCfg = COMPAT_PROVIDERS[prov];
      if (!provCfg) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown provider: ${prov}` }));
        return true;
      }
      const cfg = loadConfig();
      if (cfg.enabledProviders?.[prov] === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      const key = getCompatKey(prov);
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      try {
        let catalog;
        const refresh = urlObj.searchParams.get('refresh') === '1';
        if (prov === 'gemini') {
          catalog = await readGeminiModelCatalog(key, { refresh });
        } else {
          const modelsEndpoint = normalizeProviderModelsEndpoint(provCfg.modelsEndpoint);
          const url = `${provCfg.baseUrl.replace(/\/$/, '')}${modelsEndpoint}`;
          const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
          if (!r.ok) {
            if (respondEmptyOnAuthRejection(res, provCfg.displayName, r.status)) return true;
            throw new Error(`${provCfg.displayName} model catalog HTTP ${r.status}`);
          }
          const data = await r.json();
          const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
          catalog = prov === 'openai' ? await enrichOpenAIModelMetadata(raw, { refresh })
            : raw.map(model => annotateProviderModel(prov, model, url));
        }
        catalog = await rememberModels(authId, prov, catalog);
        catalog = catalog.filter(model => model.textModelKnown !== true || model.textModel === true);
        const models = catalog.map(m => ({
          id:             m.id ?? m.name,
          name:           m.id ?? m.name,
          contextLen:     m.modelMetadata?.limits?.contextWindow ?? m.context_length ?? m.context_window ?? null,
          created:        m.created ?? null,
          ...modelCapabilityFields(prov, m.id ?? m.name, m),
        })).filter(m => m.id).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (e) { if (!respondEmptyOnAuthRejection(res, provCfg.displayName, e.status)) safeError(res, e); }
      return true;
    }

    // List available models from all providers
    if (req.url === '/api/models') {
      const authId = requireAuth(req, res); if (!authId) return true;
      const cfg = loadConfig();
      const ollamaBase = raw => String(raw).replace(/\/+$/, '').replace(/\/api$/i, '');
      const configuredOllamaBase = ollamaBase(cfg.cortex?.ollamaUrl || OLLAMA_DEFAULT);
      const localOllamaBase = ollamaBase(cfg.cortex?.ollamaLocalUrl || 'http://localhost:11434');
      const ollamaKey  = resolveOllamaKey(cfg);
      const ollamaHeaders = ollamaKey ? { Authorization: `Bearer ${ollamaKey}` } : {};
      const localOllamaKey = resolveOllamaKey(cfg, 'ollama-local');
      const localOllamaHeaders = localOllamaKey ? { Authorization: `Bearer ${localOllamaKey}` } : {};
      const lmsBase    = cfg.cortex?.lmstudioUrl ?? LMS_DEFAULT;
      const lmsKey     = cfg.cortex?.lmstudioApiKey ?? cfg.lmstudioApiKey ?? null;
      const lmsHeaders = lmsKey ? { Authorization: `Bearer ${lmsKey}` } : {};

      let isCloudUrl = false;
      try { isCloudUrl = new URL(configuredOllamaBase).hostname.toLowerCase() === 'ollama.com'; }
      catch { /* A malformed cloud URL must not prevent local discovery. */ }

      // Classify an Ollama model as local or cloud. Local daemon proxies cloud
      // models via a `:cloud` tag or `remote_host` field — those are still cloud.
      const classifyOllama = (m, sourceIsCloud) => {
        if (sourceIsCloud) return 'cloud';
        if (m.remote_host) return 'cloud';
        if (typeof m.name === 'string' && /[:-]cloud$/.test(m.name)) return 'cloud';
        return 'local';
      };

      const fetchOllamaTags = (base, headers, provider, sourceIsCloud) =>
        fetch(`${base}/api/tags`, { headers, signal: AbortSignal.timeout(3000) })
          .then(r => r.ok ? r.json() : { models: [] })
          .then(d => (Array.isArray(d.models) ? d.models : []).filter(m => m?.name))
          .then(models => enrichOllamaModelCatalog(base, headers, models))
          .then(models => rememberModels(authId, provider, models))
          .then(models => models.map(m => ({
            name: m.name, provider, tier: classifyOllama(m, sourceIsCloud),
            ...(provider === 'ollama-local' && classifyOllama(m, sourceIsCloud) === 'cloud'
              ? { displayName: `${m.name} (cloud via local Ollama)` } : {}),
            ...modelCapabilityFields(provider, m.name, m),
          })));

      const ollamaFetches = [];
      // Provider identifies the endpoint, even for cloud models proxied by a
      // local daemon. Never send a local selection (or its key) to the cloud.
      // The default cloud URL is saved even on local-only installs; only a
      // cloud key makes that catalog configured.
      if (cfg.enabledProviders?.ollama !== false && ollamaKey) {
        ollamaFetches.push((async () => {
          if (isOfficialOllamaCloudBase(configuredOllamaBase)) {
            const connection = await checkOllamaCloudKey(ollamaKey);
            if (!connection.ok) return [];
          }
          return fetchOllamaTags(configuredOllamaBase, ollamaHeaders, 'ollama', isCloudUrl);
        })());
      }
      if (cfg.enabledProviders?.['ollama-local'] !== false) {
        ollamaFetches.push(fetchOllamaTags(localOllamaBase, localOllamaHeaders, 'ollama-local', false));
      }

      const fetchLmstudioModels = async () => {
        if (cfg.enabledProviders?.lmstudio === false) return [];
        try {
          const catalog = await rememberModels(authId, 'lmstudio', await readLmstudioModelCatalog(lmsBase, lmsHeaders));
          return catalog.map(model => ({
            name: model.id, provider: 'lmstudio', displayName: model.display_name ?? model.id,
            contextLen: model.modelMetadata?.limits?.contextWindow ?? model.modelMetadata?.limits?.maxContextWindow ?? null,
            loaded: (model.loaded_instances?.length ?? 0) > 0,
            ...modelCapabilityFields('lmstudio', model.id, model),
          }));
        } catch (e) { console.warn('[models] LM Studio model listing failed:', e.message); return []; }
      };

      const [lmRes, ...ollamaResults] = await Promise.allSettled([
        fetchLmstudioModels(),
        ...ollamaFetches,
      ]);

      // Merge Ollama results and dedupe on provider + canonical name. The cloud catalog
      // exposes the same model under both a bare name (`glm-4.7`, `cogito-2.1:671b`)
      // and a suffixed alias (`glm-4.7:cloud`, `cogito-2.1:671b-cloud`); without
      // canonicalization the picker shows duplicates. Local-server entries keep
      // their exact names, including aliases that the daemon forwards to cloud.
      const canonicalCloudName = (name) => {
        if (typeof name !== 'string') return name;
        if (name.endsWith(':cloud')) return name.slice(0, -':cloud'.length);
        if (name.endsWith('-cloud')) return name.slice(0, -'-cloud'.length);
        return name;
      };
      const ollamaSeen = new Set();
      const ollamaMerged = [];
      for (const r of ollamaResults) {
        if (r.status !== 'fulfilled') continue;
        for (const m of r.value) {
          const canonical = m.provider === 'ollama' && isCloudUrl ? canonicalCloudName(m.name) : m.name;
          const key = `${m.provider}::${canonical}`;
          if (ollamaSeen.has(key)) continue;
          ollamaSeen.add(key);
          // Prefer the bare canonical form so the picker shows e.g. `glm-4.7`
          // instead of `glm-4.7:cloud` even if the suffixed variant arrived first.
          ollamaMerged.push(canonical !== m.name ? { ...m, name: canonical } : m);
        }
      }

      // Bundled reason model filename — imported lazily so config routes don't
      // eagerly load node-llama-cpp on machines where it's not installed yet.
      let builtinReasonId = 'openensemble-reason-v3.q8_0.gguf';
      try {
        const { getBuiltinReasonModelId } = await import('../../memory/builtin-reason.mjs');
        builtinReasonId = getBuiltinReasonModelId();
      } catch { /* fall back to default name */ }

      const models = [
        // Bundled models — always available, no external runtime required.
        { name: 'nomic-embed-text-v1', provider: 'builtin', displayName: 'Nomic Embed (built-in)', tier: 'bundled', supportsVision: false, supportsImageGeneration: false, capabilities: [] },
        { name: builtinReasonId, provider: 'builtin', displayName: 'OpenEnsemble Reason v1 (built-in)', tier: 'bundled', supportsVision: false, supportsImageGeneration: false, capabilities: [] },
        ...ollamaMerged,
        ...(lmRes.status === 'fulfilled' ? lmRes.value : []),
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(models));
      return true;
    }
  return false;
}
