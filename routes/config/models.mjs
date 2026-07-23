/**
 * Model listing routes. Extracted from routes/config.mjs.
 */
import {
  requireAuth, loadConfig, modifyConfig, safeError,
} from '../_helpers.mjs';
import { supportsImageGeneration, supportsVision } from '../../lib/model-capabilities.mjs';
import { listOpenAIOAuthModels } from '../../lib/openai-codex-models.mjs';
import { listXaiOAuthModels } from '../../lib/xai-oauth-models.mjs';
import { OPENAI_COMPAT_PROVIDERS } from '../../chat/providers/_shared.mjs';
import { log } from '../../logger.mjs';

const GROK_BASE = 'https://api.x.ai/v1';
const OLLAMA_DEFAULT = 'https://ollama.com/api';
const LMS_DEFAULT = 'http://127.0.0.1:1234';
const COMPAT_PROVIDERS = OPENAI_COMPAT_PROVIDERS;
const PERPLEXITY_STATIC_MODELS = [
  { id: 'sonar', name: 'Sonar' },
  { id: 'sonar-pro', name: 'Sonar Pro' },
  { id: 'sonar-reasoning', name: 'Sonar Reasoning' },
  { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro' },
  { id: 'sonar-deep-research', name: 'Sonar Deep Research' },
];

export async function tryHandleModelRoutes(req, res) {


    // List available chat models from xAI Grok (authoritative — no hardcoding).
    // Image/video models live on separate endpoints and are handled client-side as static slugs.
    if (req.url === '/api/grok-models' && req.method === 'GET') {
      const authId = requireAuth(req, res); if (!authId) return true;
      const cfg = loadConfig();
      if (cfg.enabledProviders?.grok === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      const key = cfg.grokApiKey || process.env.GROK_API_KEY || process.env.XAI_API_KEY;
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      try {
        const r = await fetch(`${GROK_BASE}/language-models`, {
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        });
        // Fall back to /models if /language-models isn't available on the account
        const resp = r.ok ? r : await fetch(`${GROK_BASE}/models`, {
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) throw new Error(`xAI API ${resp.status}`);
        const data = await resp.json();
        const list = data.models ?? data.data ?? [];
        const models = list
          .map(m => {
            const id = m.id ?? m.name;
            return {
              id,
              displayName: id,
              supportsVision: supportsVision('grok', id),
              supportsImageGeneration: supportsImageGeneration('grok', id),
              capabilities: [
                ...(supportsVision('grok', id) ? ['image_input'] : []),
                ...(supportsImageGeneration('grok', id) ? ['image_generation'] : []),
              ],
            };
          })
          .filter(m => m.id)
          .sort((a, b) => a.id.localeCompare(b.id));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (e) { safeError(res, e); }
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
      const key = cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      try {
        let allModels = [], afterId = null, pagesFetched = 0;
        do {
          const url = `https://api.anthropic.com/v1/models?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`;
          const r = await fetch(url, {
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            signal: AbortSignal.timeout(10000),
          });
          if (!r.ok) throw new Error(`Anthropic API ${r.status}`);
          const data = await r.json();
          allModels = allModels.concat(data.data ?? []);
          afterId = data.has_more ? data.last_id : null;
          pagesFetched++;
          if (pagesFetched > 10) break;
        } while (afterId);

        const models = allModels
          .map(m => ({
            id: m.id,
            displayName: m.display_name ?? m.id,
            createdAt: m.created_at ?? null,
            supportsVision: supportsVision('anthropic', m.id),
            supportsImageGeneration: supportsImageGeneration('anthropic', m.id),
            capabilities: supportsVision('anthropic', m.id) ? ['image_input'] : [],
          }))
          .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (e) { safeError(res, e); }
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
      const key = cfg.fireworksApiKey || process.env.FIREWORKS_API_KEY;
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
          if (!r.ok) throw new Error(`Fireworks API ${r.status}`);
          const data = await r.json();
          allModels = allModels.concat(data.models ?? []);
          pageToken = data.nextPageToken ?? null;
          pagesFetched++;
          // Safety cap in case the upstream returns a non-terminating cursor.
          if (pagesFetched > 20) break;
        } while (pageToken);

        // FLUMINA = Fireworks-native image models (Flux). Image-generation, not vision input.
        const fluminaModels = allModels
          .filter(m => m.kind?.startsWith('FLUMINA'))
          .map(m => ({
            id: (m.name ?? '').split('/').pop(),
            displayName: m.displayName || m.name,
            supportsVision: false,
            supportsImageGeneration: true,
            capabilities: ['image_generation'],
          }));

        // SD/Playground models exist in the web UI but aren't returned by the listing API
        // They use a different inference endpoint (/inference/v1/image_generation/...)
        const legacyImageModels = [
          { id: 'stable-diffusion-xl-1024-v1-0',    displayName: 'Stable Diffusion XL',                supportsVision: false, supportsImageGeneration: true, capabilities: ['image_generation'] },
          { id: 'playground-v2-1024px-aesthetic',    displayName: 'Playground v2 1024',                supportsVision: false, supportsImageGeneration: true, capabilities: ['image_generation'] },
          { id: 'playground-v2-5-1024px-aesthetic',  displayName: 'Playground v2.5 1024',              supportsVision: false, supportsImageGeneration: true, capabilities: ['image_generation'] },
          { id: 'SSD-1B',                            displayName: 'Segmind Stable Diffusion 1B',       supportsVision: false, supportsImageGeneration: true, capabilities: ['image_generation'] },
          { id: 'japanese-stable-diffusion-xl',      displayName: 'Japanese Stable Diffusion XL',      supportsVision: false, supportsImageGeneration: true, capabilities: ['image_generation'] },
        ];

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([...fluminaModels, ...legacyImageModels]));
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
      const key = cfg.openrouterApiKey || process.env.OPENROUTER_API_KEY;
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      try {
        const r = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`OpenRouter API ${r.status}`);
        const data = await r.json();
        const models = (data.data ?? [])
          .filter(m => m.architecture?.modality?.includes('text'))
          .map(m => ({
            id:          m.id,
            name:        m.name ?? m.id,
            contextLen:  m.context_length ?? null,
            inputPrice:  m.pricing?.prompt  != null ? parseFloat(m.pricing.prompt)  * 1_000_000 : null,
            outputPrice: m.pricing?.completion != null ? parseFloat(m.pricing.completion) * 1_000_000 : null,
            // OpenRouter exposes input modality on each model — image input means vision-capable.
            supportsVision: Array.isArray(m.architecture?.input_modalities)
              ? m.architecture.input_modalities.includes('image')
              : supportsVision('openrouter', m.id),
            supportsImageGeneration: Array.isArray(m.architecture?.output_modalities)
              ? m.architecture.output_modalities.includes('image')
              : supportsImageGeneration('openrouter', m.id),
            capabilities: [
              ...(Array.isArray(m.architecture?.input_modalities) && m.architecture.input_modalities.includes('image') ? ['image_input'] : []),
              ...(Array.isArray(m.architecture?.output_modalities) && m.architecture.output_modalities.includes('image') ? ['image_generation'] : []),
            ],
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
      } catch (e) { safeError(res, e); }
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
          const annotated = await listOpenAIOAuthModels(authId, { refresh, strict: refresh });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(annotated));
        } catch (e) {
          console.warn('[openai-oauth-models] explicit refresh failed:', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Could not refresh OpenAI models. Refresh the ChatGPT login token or reconnect, then try again.',
          }));
        }
        return true;
      }
      if (prov === 'xai-oauth') {
        const annotated = await listXaiOAuthModels(authId, { refresh: urlObj.searchParams.get('refresh') === '1' });
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
      const key = cfg[provCfg.keyField] || process.env[provCfg.keyField.replace(/ApiKey$/, '').toUpperCase() + '_API_KEY'];
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return true;
      }
      // Perplexity has no /models endpoint — return the hardcoded Sonar family.
      if (prov === 'perplexity') {
        const annotated = PERPLEXITY_STATIC_MODELS.map(m => ({
          ...m,
          supportsVision: supportsVision('perplexity', m.id ?? m.name),
          supportsImageGeneration: supportsImageGeneration('perplexity', m.id ?? m.name),
          capabilities: supportsVision('perplexity', m.id ?? m.name) ? ['image_input'] : [],
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(annotated));
        return true;
      }
      try {
        const url = `${provCfg.baseUrl.replace(/\/$/, '')}/models`;
        const r = await fetch(url, {
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error(`${provCfg.displayName} API ${r.status}: ${await r.text()}`);
        const data = await r.json();
        // Handle both OpenAI shape ({ data: [...] }) and alternate ({ models: [...] })
        const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
        const models = raw.map(m => ({
          id:             m.id ?? m.name,
          name:           m.id ?? m.name,
          contextLen:     m.context_length ?? m.context_window ?? null,
          created:        m.created ?? null,
          supportsVision: supportsVision(prov, m.id ?? m.name, { capabilities: m.capabilities }),
          supportsImageGeneration: supportsImageGeneration(prov, m.id ?? m.name, { capabilities: m.capabilities }),
          capabilities: [
            ...(supportsVision(prov, m.id ?? m.name, { capabilities: m.capabilities }) ? ['image_input'] : []),
            ...(supportsImageGeneration(prov, m.id ?? m.name, { capabilities: m.capabilities }) ? ['image_generation'] : []),
          ],
        })).filter(m => m.id).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(models));
      } catch (e) { safeError(res, e); }
      return true;
    }

    // List available models from all providers
    if (req.url === '/api/models') {
      const authId = requireAuth(req, res); if (!authId) return true;
      const cfg = loadConfig();
      const configuredOllamaBase = (cfg.cortex?.ollamaUrl ?? OLLAMA_DEFAULT).replace(/\/api\/?$/, '');
      const ollamaKey  = cfg.cortex?.ollamaApiKey ?? null;
      const ollamaHeaders = ollamaKey ? { Authorization: `Bearer ${ollamaKey}` } : {};
      const lmsBase    = cfg.cortex?.lmstudioUrl ?? LMS_DEFAULT;
      const lmsKey     = cfg.cortex?.lmstudioApiKey ?? cfg.lmstudioApiKey ?? null;
      const lmsHeaders = lmsKey ? { Authorization: `Bearer ${lmsKey}` } : {};

      // Always probe localhost for local Ollama, even when cortex.ollamaUrl points
      // at the cloud — so users running both see both sets. Skip localhost if the
      // configured URL already *is* localhost (avoid duplicate fetch).
      const LOCAL = 'http://localhost:11434';
      const probeLocal = !configuredOllamaBase.startsWith('http://localhost') && !configuredOllamaBase.startsWith('http://127.0.0.1');
      const isCloudUrl = /ollama\.com/i.test(configuredOllamaBase);

      // Classify an Ollama model as local or cloud. Local daemon proxies cloud
      // models via a `:cloud` tag or `remote_host` field — those are still cloud.
      const classifyOllama = (m, sourceIsCloud) => {
        if (sourceIsCloud) return 'cloud';
        if (m.remote_host) return 'cloud';
        if (typeof m.name === 'string' && m.name.endsWith(':cloud')) return 'cloud';
        return 'local';
      };

      const fetchOllamaTags = (base, headers, sourceIsCloud) =>
        fetch(`${base}/api/tags`, { headers, signal: AbortSignal.timeout(3000) })
          .then(r => r.json())
          .then(d => (d.models ?? []).map(m => ({
            name: m.name, provider: 'ollama', tier: classifyOllama(m, sourceIsCloud),
            supportsVision: supportsVision('ollama', m.name),
            supportsImageGeneration: supportsImageGeneration('ollama', m.name),
            capabilities: [
              ...(supportsVision('ollama', m.name) ? ['image_input'] : []),
              ...(supportsImageGeneration('ollama', m.name) ? ['image_generation'] : []),
            ],
          })));

      const ollamaFetches = [];
      // Configured URL (may be local OR cloud)
      ollamaFetches.push(fetchOllamaTags(configuredOllamaBase, ollamaHeaders, isCloudUrl));
      // Localhost probe (only when configured URL wasn't already localhost)
      if (probeLocal) ollamaFetches.push(fetchOllamaTags(LOCAL, {}, false));

      const normalizeLmstudioCapabilities = (caps) => {
        if (Array.isArray(caps)) return caps;
        if (!caps || typeof caps !== 'object') return [];
        const out = [];
        if (caps.vision === true) out.push('vision');
        if (caps.trained_for_tool_use === true || caps.tool_use === true) out.push('tool_use');
        if (caps.reasoning) out.push('reasoning');
        return out;
      };

      const fetchLmstudioModels = async () => {
        const nativeUrl = `${lmsBase}/api/v1/models`;
        const compatUrl = `${lmsBase}/v1/models`;
        const attempts = [
          { url: nativeUrl, headers: lmsHeaders, shape: 'native' },
          ...(Object.keys(lmsHeaders).length ? [{ url: nativeUrl, headers: {}, shape: 'native' }] : []),
          { url: compatUrl, headers: lmsHeaders, shape: 'compat' },
          ...(Object.keys(lmsHeaders).length ? [{ url: compatUrl, headers: {}, shape: 'compat' }] : []),
        ];
        let lastErr = null;
        for (const a of attempts) {
          try {
            const r = await fetch(a.url, { headers: a.headers, signal: AbortSignal.timeout(3000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
            const d = await r.json();
            if (a.shape === 'native') {
              return (d.models ?? [])
                .filter(m => m.type === 'llm' || !m.type)
                .map(m => {
                  const caps = normalizeLmstudioCapabilities(m.capabilities);
                  const id = m.key ?? m.id;
                  return {
                    name:        id,
                    provider:    'lmstudio',
                    displayName: m.display_name ?? id,
                    contextLen:  m.max_context_length,
                    loaded:      (m.loaded_instances?.length ?? 0) > 0,
                    capabilities: caps,
                    supportsVision: supportsVision('lmstudio', id, { capabilities: caps }),
                    supportsImageGeneration: supportsImageGeneration('lmstudio', id, { capabilities: caps }),
                  };
                })
                .filter(m => m.name);
            }
            return (d.data ?? [])
              .filter(m => m.id && !String(m.id).startsWith('text-embedding-'))
              .map(m => ({
                name:        m.id,
                provider:    'lmstudio',
                displayName: m.id,
                contextLen:  null,
                loaded:      false,
                capabilities: [],
                supportsVision: supportsVision('lmstudio', m.id),
                supportsImageGeneration: supportsImageGeneration('lmstudio', m.id),
              }));
          } catch (e) {
            lastErr = e;
          }
        }
        if (lastErr) console.warn('[models] LM Studio model listing failed:', lastErr.message);
        return [];
      };

      const [lmRes, ...ollamaResults] = await Promise.allSettled([
        fetchLmstudioModels(),
        ...ollamaFetches,
      ]);

      // Merge Ollama results and dedupe on canonical-name + tier. The cloud catalog
      // exposes the same model under both a bare name (`glm-4.7`, `cogito-2.1:671b`)
      // and a suffixed alias (`glm-4.7:cloud`, `cogito-2.1:671b-cloud`); without
      // canonicalization the picker shows duplicates. Local-tier entries skip the
      // strip so a real `something-cloud` local pull (rare) wouldn't collapse.
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
          const canonical = m.tier === 'cloud' ? canonicalCloudName(m.name) : m.name;
          const key = `${canonical}::${m.tier}`;
          if (ollamaSeen.has(key)) continue;
          ollamaSeen.add(key);
          // Prefer the bare canonical form so the picker shows e.g. `glm-4.7`
          // instead of `glm-4.7:cloud` even if the suffixed variant arrived first.
          ollamaMerged.push(m.tier === 'cloud' && canonical !== m.name ? { ...m, name: canonical } : m);
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
