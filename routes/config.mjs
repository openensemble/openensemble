/**
 * Config routes: /api/config, /api/config-public, /api/cortex-config,
 *                /api/cortex-health, /api/models
 */

import fs from 'fs';
import path from 'path';
import {
  requireAuth, requirePrivileged, loadConfig, modifyConfig, readBody, CFG_PATH, safeError,
} from './_helpers.mjs';

// This is the default for the "Ollama (cloud)" provider field — the Ollama
// (local) field has its own separate OLLAMA_LOCAL_DEFAULT below. Historically
// this defaulted to localhost even though the UI labels it "cloud", which made
// the pre-filled value look wrong to any new user.
const OLLAMA_DEFAULT = 'https://ollama.com/api';
const LMS_DEFAULT    = 'http://127.0.0.1:1234';
const GROK_BASE      = 'https://api.x.ai/v1';
const GROK_MGMT_BASE = 'https://management-api.x.ai/v1';

// OpenAI-compatible providers: base URL + config field name for the API key.
// Add new providers here to auto-wire /api/provider-config and /api/provider-models/:provider.
const COMPAT_PROVIDERS = {
  openai:      { baseUrl: 'https://api.openai.com/v1',                               keyField: 'openaiApiKey',     displayName: 'OpenAI' },
  deepseek:    { baseUrl: 'https://api.deepseek.com/v1',                             keyField: 'deepseekApiKey',   displayName: 'DeepSeek' },
  mistral:     { baseUrl: 'https://api.mistral.ai/v1',                               keyField: 'mistralApiKey',    displayName: 'Mistral' },
  groq:        { baseUrl: 'https://api.groq.com/openai/v1',                          keyField: 'groqApiKey',       displayName: 'Groq' },
  together:    { baseUrl: 'https://api.together.xyz/v1',                             keyField: 'togetherApiKey',   displayName: 'Together AI' },
  perplexity:  { baseUrl: 'https://api.perplexity.ai',                               keyField: 'perplexityApiKey', displayName: 'Perplexity' },
  gemini:      { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyField: 'geminiApiKey',     displayName: 'Google Gemini' },
  xai:         { baseUrl: 'https://api.x.ai/v1',                                     keyField: 'grokApiKey',       displayName: 'xAI Grok' },
  zai:         { baseUrl: 'https://api.z.ai/api/paas/v4',                            keyField: 'zaiApiKey',        displayName: 'Z.AI' },
};

// ChatGPT backend (OAuth) — the Codex /responses endpoint accepts these model
// slugs against a ChatGPT Plus/Pro account. There's no /models endpoint, and
// the backend rejects every -pro/-codex/-mini/-nano variant of 5.5/5.3 plus
// the entire o-series and 4o/4.1 families with: "The '<slug>' model is not
// supported when using Codex with a ChatGPT account." Verified by probing
// /responses with each slug (scripts/probe-oauth-models.mjs, 2026-04-25).
const OPENAI_OAUTH_STATIC_MODELS = [
  { id: 'gpt-5.5',       name: 'GPT-5.5' },
  { id: 'gpt-5.4',       name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini',  name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  { id: 'gpt-5.2',       name: 'GPT-5.2' },
];

// Perplexity doesn't expose GET /models — hardcode the current Sonar family.
const PERPLEXITY_STATIC_MODELS = [
  { id: 'sonar',                 name: 'Sonar' },
  { id: 'sonar-pro',             name: 'Sonar Pro' },
  { id: 'sonar-reasoning',       name: 'Sonar Reasoning' },
  { id: 'sonar-reasoning-pro',   name: 'Sonar Reasoning Pro' },
  { id: 'sonar-deep-research',   name: 'Sonar Deep Research' },
];

export async function handle(req, res) {
  // Provider config: GET is readable by any authed user (so non-admin clients
  // can see which providers are enabled and populate the agent model picker);
  // POST stays admin-only since it writes API keys and toggle state.
  if (req.url === '/api/provider-config') {
    const authId = req.method === 'POST'
      ? requirePrivileged(req, res)
      : requireAuth(req, res);
    if (!authId) return true;
    if (req.method === 'GET') {
      const cfg = loadConfig();
      // Dynamic OpenAI-compat provider key flags (openaiKeySet, deepseekKeySet, …)
      const compatFlags = {};
      for (const [prov, { keyField }] of Object.entries(COMPAT_PROVIDERS)) {
        compatFlags[`${prov}KeySet`] = !!cfg[keyField];
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        anthropicKeySet:   !!cfg.anthropicApiKey,
        fireworksKeySet:   !!cfg.fireworksApiKey,
        grokKeySet:        !!cfg.grokApiKey,

        ollamaKeySet:      !!cfg.cortex?.ollamaApiKey,
        lmstudioKeySet:    !!cfg.cortex?.lmstudioApiKey,
        openrouterKeySet:  !!cfg.openrouterApiKey,
        ollamaUrl:    OLLAMA_DEFAULT,
        lmstudioUrl:  cfg.cortex?.lmstudioUrl  ?? LMS_DEFAULT,
        // Secondary, local-only Ollama endpoint. Users with Ollama Cloud for
        // chat still need a local Ollama to host the memory-lane GGUF (Cloud
        // refuses /api/create). Kept separate so they can have both.
        ollamaLocalUrl:    cfg.cortex?.ollamaLocalUrl    ?? '',
        ollamaLocalKeySet: !!cfg.cortex?.ollamaLocalApiKey,
        braveKeySet:  !!cfg.braveApiKey,
        ttsKeySet:    !!cfg.ttsApiKey,
        ttsApiUrl:    cfg.ttsApiUrl   ?? '',
        ttsModel:     cfg.ttsModel    ?? '',
        ttsVoice:     cfg.ttsVoice    ?? '',
        sttKeySet:    !!cfg.sttApiKey,
        sttApiUrl:    cfg.sttApiUrl   ?? '',
        sttModel:     cfg.sttModel    ?? '',
        enabledProviders: cfg.enabledProviders ?? {},
        msClientIdSet:     !!cfg.msClientId,
        msClientSecretSet: !!cfg.msClientSecret,
        msTenant:          cfg.msTenant ?? '',
        providerFailover: cfg.providerFailover ?? { enabled: false, fallbackProvider: '', fallbackModel: '' },
        ...compatFlags,
      }));
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        await modifyConfig(cfg => {
          if (body.anthropicApiKey)   cfg.anthropicApiKey   = body.anthropicApiKey;
          if (body.fireworksApiKey)   cfg.fireworksApiKey   = body.fireworksApiKey;
          if (body.grokApiKey)        cfg.grokApiKey        = body.grokApiKey;

          if (body.openrouterApiKey)  cfg.openrouterApiKey  = body.openrouterApiKey;
          // Brave Search API key — used by web/deep_research skills and news plugin.
          // Accept empty string as an explicit clear.
          if (body.braveApiKey !== undefined) {
            if (body.braveApiKey) cfg.braveApiKey = body.braveApiKey;
            else delete cfg.braveApiKey;
          }

          // OpenAI-compat provider keys (openaiApiKey, deepseekApiKey, …)
          for (const { keyField } of Object.values(COMPAT_PROVIDERS)) {
            if (body[keyField]) cfg[keyField] = body[keyField];
          }
          cfg.cortex = cfg.cortex ?? {};
          // Cloud Ollama endpoint is fixed (OLLAMA_DEFAULT) and not user-editable;
          // ignore any ollamaUrl the client sends and keep the canonical value.
          cfg.cortex.ollamaUrl = OLLAMA_DEFAULT;
          if (body.lmstudioUrl    !== undefined) cfg.cortex.lmstudioUrl    = body.lmstudioUrl;
          if (body.ollamaApiKey)                 cfg.cortex.ollamaApiKey   = body.ollamaApiKey;
          if (body.lmstudioApiKey)               cfg.cortex.lmstudioApiKey = body.lmstudioApiKey;
          if (body.ollamaLocalUrl    !== undefined) cfg.cortex.ollamaLocalUrl    = body.ollamaLocalUrl;
          if (body.ollamaLocalApiKey)               cfg.cortex.ollamaLocalApiKey = body.ollamaLocalApiKey;
          if (body.ttsApiKey)                      cfg.ttsApiKey   = body.ttsApiKey;
          if (body.ttsApiUrl   !== undefined)      cfg.ttsApiUrl   = body.ttsApiUrl;
          if (body.ttsModel    !== undefined)      cfg.ttsModel    = body.ttsModel;
          if (body.ttsVoice    !== undefined)      cfg.ttsVoice    = body.ttsVoice;
          if (body.sttApiKey)                      cfg.sttApiKey   = body.sttApiKey;
          if (body.sttApiUrl   !== undefined)      cfg.sttApiUrl   = body.sttApiUrl;
          if (body.sttModel    !== undefined)      cfg.sttModel    = body.sttModel;
          if (body.enabledProviders !== undefined) cfg.enabledProviders = { ...(cfg.enabledProviders ?? {}), ...body.enabledProviders };
          if (body.providerFailover !== undefined) cfg.providerFailover = body.providerFailover;
          if (body.clearMicrosoftCreds) { delete cfg.msClientId; delete cfg.msClientSecret; delete cfg.msTenant; }
          else {
            if (body.msClientId)             cfg.msClientId     = body.msClientId;
            if (body.msClientSecret)         cfg.msClientSecret = body.msClientSecret;
            if (body.msTenant !== undefined) cfg.msTenant       = body.msTenant;
          }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      return true;
    }
  }


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
        .map(m => ({ id: m.id ?? m.name, displayName: m.id ?? m.name }))
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
        .map(m => ({ id: m.id, displayName: m.display_name ?? m.id, createdAt: m.created_at ?? null }))
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

      // FLUMINA = Fireworks-native image models (Flux)
      const fluminaModels = allModels
        .filter(m => m.kind?.startsWith('FLUMINA'))
        .map(m => ({ id: (m.name ?? '').split('/').pop(), displayName: m.displayName || m.name }));

      // SD/Playground models exist in the web UI but aren't returned by the listing API
      // They use a different inference endpoint (/inference/v1/image_generation/...)
      const legacyImageModels = [
        { id: 'stable-diffusion-xl-1024-v1-0',    displayName: 'Stable Diffusion XL' },
        { id: 'playground-v2-1024px-aesthetic',    displayName: 'Playground v2 1024' },
        { id: 'playground-v2-5-1024px-aesthetic',  displayName: 'Playground v2.5 1024' },
        { id: 'SSD-1B',                            displayName: 'Segmind Stable Diffusion 1B' },
        { id: 'japanese-stable-diffusion-xl',      displayName: 'Japanese Stable Diffusion XL' },
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
    const prov = req.url.slice('/api/provider-models/'.length).split('?')[0];
    // OAuth-backed ChatGPT provider: no key field, no /models endpoint — static list.
    if (prov === 'openai-oauth') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(OPENAI_OAUTH_STATIC_MODELS));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(PERPLEXITY_STATIC_MODELS));
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
        id:         m.id ?? m.name,
        name:       m.id ?? m.name,
        contextLen: m.context_length ?? m.context_window ?? null,
        created:    m.created ?? null,
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
        })));

    const ollamaFetches = [];
    // Configured URL (may be local OR cloud)
    ollamaFetches.push(fetchOllamaTags(configuredOllamaBase, ollamaHeaders, isCloudUrl));
    // Localhost probe (only when configured URL wasn't already localhost)
    if (probeLocal) ollamaFetches.push(fetchOllamaTags(LOCAL, {}, false));

    const [lmRes, ...ollamaResults] = await Promise.allSettled([
      fetch(`${lmsBase}/api/v1/models`, { signal: AbortSignal.timeout(3000) }).then(r => r.json())
        .then(d => (d.models ?? [])
          .filter(m => m.type === 'llm' || !m.type)
          .map(m => ({
            name:        m.key ?? m.id,
            provider:    'lmstudio',
            displayName: m.display_name ?? m.key,
            contextLen:  m.max_context_length,
            loaded:      (m.loaded_instances?.length ?? 0) > 0,
            capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
          }))
        ),
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
      const { getBuiltinReasonModelId } = await import('../memory/builtin-reason.mjs');
      builtinReasonId = getBuiltinReasonModelId();
    } catch { /* fall back to default name */ }

    const models = [
      // Bundled models — always available, no external runtime required.
      { name: 'nomic-embed-text-v1', provider: 'builtin', displayName: 'Nomic Embed (built-in)', tier: 'bundled' },
      { name: builtinReasonId, provider: 'builtin', displayName: 'OpenEnsemble Reason v1 (built-in)', tier: 'bundled' },
      ...ollamaMerged,
      ...(lmRes.status === 'fulfilled' ? lmRes.value : []),
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(models));
    return true;
  }

  // Cortex config
  if (req.url === '/api/cortex-config') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    if (req.method === 'GET') {
      const cfg = loadConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cfg.cortex ?? {}));
      return true;
    }
    if (req.method === 'POST') {
      try {
        const update = JSON.parse(await readBody(req));
        await modifyConfig(cfg => {
          cfg.cortex = cfg.cortex ?? {};
          for (const [k, v] of Object.entries(update)) {
            if (v === null) delete cfg.cortex[k]; // null = delete (used to clear stale URL overrides)
            else cfg.cortex[k] = v;
          }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      return true;
    }
  }

  // Cortex health
  if (req.url === '/api/cortex-health') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const c = cfg.cortex ?? {};
    const lmsBase    = c.lmstudioUrl ?? 'http://127.0.0.1:1234';
    const ollamaBase = (c.ollamaUrl ?? 'http://localhost:11434').replace(/\/api\/?$/, '');
    const ollamaKey  = c.ollamaApiKey ?? null;
    const embedProvider = c.embedProvider ?? 'ollama';
    const reasonProvider = c.reasonProvider ?? 'auto';
    const check = async (url, headers = {}) => {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(2000), headers }); return r.ok; }
      catch (e) { console.debug('[cortex] Health check failed for', url + ':', e.message); return false; }
    };
    const ollamaAuthHeaders = ollamaKey ? { Authorization: `Bearer ${ollamaKey}` } : {};
    const [ollamaOk, lmsOk] = await Promise.all([
      check(`${ollamaBase}/api/tags`, ollamaAuthHeaders),
      check(`${lmsBase}/v1/models`),
    ]);
    // Cloud providers are "reachable" as long as their API key is configured —
    // probing them costs rate-limit headroom. getProviderSpec returns the
    // authoritative header set (with api key or without).
    const { getProviderSpec } = await import('../memory/shared.mjs');
    const cloudReady = prov => {
      const spec = getProviderSpec(prov);
      return !!(spec && (spec.headers?.Authorization || spec.headers?.['x-api-key']));
    };
    const providerOk = (prov, needEmbed) => {
      if (prov === 'builtin')  return false; // handled specially below for embed
      if (prov === 'ollama')   return ollamaOk;
      if (prov === 'lmstudio') return lmsOk;
      if (prov === 'auto')     return ollamaOk || lmsOk;
      const spec = getProviderSpec(prov);
      if (!spec) return false;
      if (needEmbed && !spec.supportsEmbed) return false;
      return cloudReady(prov);
    };
    let embedOk;
    if (embedProvider === 'builtin') {
      const { isBuiltinReady } = await import('../memory/builtin-embed.mjs');
      embedOk = isBuiltinReady();
    } else {
      embedOk = providerOk(embedProvider, true);
    }
    // Reason has its own in-process (llama.cpp) tier. `providerOk()` returns
    // false for 'builtin' by design; handle it here, and also let 'auto' count
    // the built-in runtime as a valid fallback before trying external ones.
    const { isBuiltinReasonReady } = await import('../memory/builtin-reason.mjs');
    const builtinReasonOk = isBuiltinReasonReady();
    const reasonOk = reasonProvider === 'builtin'
      ? builtinReasonOk
      : reasonProvider === 'auto'
        ? (builtinReasonOk || ollamaOk || lmsOk)
        : providerOk(reasonProvider, false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ embed: embedOk, reason: reasonOk, salience: reasonOk, signals: reasonOk }));
    return true;
  }

  // Public config — readable by any authed user. Returns only non-secret UI
  // settings (vision model, session expiry, strip-thinking toggle); safe to
  // expose to regular users so loadSkillsList() and similar non-admin paths
  // don't 403 trying to fetch it.
  if (req.url === '/api/config-public' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      visionProvider: cfg.visionProvider, visionModel: cfg.visionModel,
      sessionExpiryHours: cfg.sessionExpiryHours,
      stripThinkingTags: cfg.stripThinkingTags !== false,
    }));
    return true;
  }

  // Config PATCH
  if (req.url === '/api/config' && req.method === 'PATCH') {
    const authId = requirePrivileged(req, res); if (!authId) return true;
    try {
      const changes = JSON.parse(await readBody(req));
      const allowed = ['sessionExpiryHours', 'visionProvider', 'visionModel', 'stripThinkingTags', 'providerFailover'];
      await modifyConfig(cfg => { for (const key of allowed) { if (key in changes) cfg[key] = changes[key]; } });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // TTS endpoint — generates audio from text using configured TTS provider
  if (req.url === '/api/tts' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    if (!cfg.ttsApiKey || !cfg.ttsApiUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TTS provider not configured' }));
      return true;
    }
    try {
      const { text, lang } = JSON.parse(await readBody(req));
      if (!text) throw new Error('text is required');
      const ttsRes = await fetch(cfg.ttsApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.ttsApiKey}`,
        },
        body: JSON.stringify({
          model: cfg.ttsModel || 'tts-1',
          voice: cfg.ttsVoice || 'alloy',
          input: text,
          ...(lang ? { language: lang } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!ttsRes.ok) throw new Error(`TTS API returned ${ttsRes.status}`);
      const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
      const mimeType = ttsRes.headers.get('content-type') || 'audio/mp3';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ audio: audioBuffer.toString('base64'), mimeType }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  if (req.url === '/api/stt' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    if (!cfg.sttApiKey || !cfg.sttApiUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'STT provider not configured', configured: false }));
      return true;
    }
    try {
      const ctype = req.headers['content-type'] || '';
      const match = ctype.match(/boundary=(?:"?)([^";]+)/);
      if (!match) throw new Error('Expected multipart/form-data with a boundary');
      const raw = await readBody(req);
      // Walk parts, pick the first file part named audio/* or the first audio part
      const boundary = match[1];
      const sep = Buffer.from('--' + boundary);
      let audioBuf = null, audioName = 'speech.webm', audioMime = 'audio/webm';
      let lang = '';
      let cursor = 0;
      while (cursor < raw.length) {
        const sepIdx = raw.indexOf(sep, cursor);
        if (sepIdx === -1) break;
        const nextSep = raw.indexOf(sep, sepIdx + sep.length);
        const part = raw.slice(sepIdx + sep.length, nextSep === -1 ? raw.length : nextSep);
        cursor = sepIdx + sep.length;
        if (part.length < 4) continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4, part.length - 2);
        const nameMatch = headers.match(/name="([^"]+)"/);
        const name = nameMatch?.[1];
        if (!name) continue;
        if (headers.includes('filename=')) {
          if (!audioBuf) {
            audioBuf = body;
            audioName = (headers.match(/filename="([^"]+)"/) ?? [])[1] ?? audioName;
            audioMime = (headers.match(/Content-Type:\s*([^\r\n]+)/) ?? [])[1]?.trim() ?? audioMime;
          }
        } else if (name === 'lang') {
          lang = body.toString().trim();
        }
      }
      if (!audioBuf) throw new Error('No audio part in request');

      // Send to configured STT provider (OpenAI-compatible multipart)
      const form = new FormData();
      form.append('file', new Blob([audioBuf], { type: audioMime }), audioName);
      form.append('model', cfg.sttModel || 'whisper-1');
      if (lang) form.append('language', lang);
      const sttRes = await fetch(cfg.sttApiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.sttApiKey}` },
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!sttRes.ok) throw new Error(`STT API returned ${sttRes.status}: ${await sttRes.text()}`);
      const data = await sttRes.json();
      const transcript = data.text ?? data.transcript ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transcript, raw: data }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  return false;
}
