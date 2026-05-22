/**
 * Config routes: /api/config, /api/config-public, /api/cortex-config,
 *                /api/cortex-health, /api/models
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import os from 'os';
import {
  requireAuth, requirePrivileged, loadConfig, modifyConfig, readBody, readBodyBuffer, CFG_PATH, safeError,
  getAuthToken,
} from './_helpers.mjs';
import { getSessionMeta } from './_helpers/auth-sessions.mjs';
import { getSlotAssignment } from '../lib/voice-devices.mjs';
import { getVoiceRef } from '../lib/voice-refs.mjs';
import {
  takeTestMp3,
  takeAmbientStream, registerAmbientResponse, unregisterAmbientResponse,
} from './devices.mjs';
import { ambientFilePath } from '../lib/routines.mjs';
import { supportsVision } from '../lib/model-capabilities.mjs';
import { log } from '../logger.mjs';

/**
 * Quick liveness probe for the local Piper TTS service. Used by GET
 * /api/provider-config to populate `piperAvailable` so the Settings UI
 * can hide the install button when Piper is already running and surface
 * it otherwise. 500 ms timeout keeps the config endpoint snappy.
 */
async function probePiperAvailable(cfg) {
  const url = cfg.piperUrl || 'http://127.0.0.1:5151/';
  try {
    const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(500) });
    // Piper's http_server responds with 405 to GET on /, 200 on /v1/info,
    // and 200/400 on POST /. Anything in 2xx-5xx means *something* is
    // listening on the port. Connection-refused throws.
    return r.status >= 200 && r.status < 600;
  } catch {
    return false;
  }
}

// Tailored URL gate for admin-writable provider endpoints (LM Studio, local
// Ollama). Looser than lib/url-guard.mjs:isUrlSafe — loopback and LAN ranges
// must remain valid (LM Studio normally runs on 127.0.0.1; Ollama may live on
// another box on the same VLAN). We do block link-local / cloud-metadata
// (169.254.x — IMDSv1, GCP metadata, etc.) and refuse non-http(s) schemes /
// malformed input so a typo can't end up in the config.
function validateProviderUrl(field, raw) {
  const v = String(raw ?? '').trim();
  if (!v) return ''; // empty = clear
  let u;
  try { u = new URL(v); } catch { throw new Error(`${field} is not a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${field} protocol ${u.protocol} not allowed (use http or https)`);
  }
  const host = u.hostname.toLowerCase();
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 169 && b === 254) throw new Error(`${field} points at link-local / cloud-metadata range`);
    if (a === 0)               throw new Error(`${field} points at unspecified-address range`);
    if (a >= 224)              throw new Error(`${field} points at multicast / reserved range`);
  } else if (net.isIPv6(host)) {
    if (host.startsWith('fe80:')) throw new Error(`${field} points at IPv6 link-local range`);
    if (host.startsWith('ff'))    throw new Error(`${field} points at IPv6 multicast range`);
  }
  return v;
}

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
      // Probe local Piper service (500 ms cap) so the UI can show "install"
      // vs "running" status without a separate round-trip.
      const piperAvailable = await probePiperAvailable(cfg);
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
        ttsProvider:  cfg.ttsProvider ?? 'openai',
        piperAvailable,
        elevenlabsKeySet: !!cfg.elevenlabsApiKey,
        elevenlabsModel:  cfg.elevenlabsModel ?? '',
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
        // Validate admin-writable provider URLs *before* the modifyConfig
        // transaction so a bad value 400s loudly instead of half-writing.
        // (POST is already gated to requirePrivileged at the dispatch above.)
        if (body.lmstudioUrl !== undefined) {
          body.lmstudioUrl = validateProviderUrl('lmstudioUrl', body.lmstudioUrl);
        }
        if (body.ollamaLocalUrl !== undefined) {
          body.ollamaLocalUrl = validateProviderUrl('ollamaLocalUrl', body.ollamaLocalUrl);
        }
        // Brave Search API key — validate against Brave before saving so a
        // mistyped or wrong-vendor key fails loudly instead of silently
        // breaking web search later. Empty string is an explicit clear.
        if (body.braveApiKey !== undefined && body.braveApiKey) {
          const probe = await fetch(
            'https://api.search.brave.com/res/v1/web/search?q=ping&count=1',
            { headers: { 'Accept': 'application/json', 'X-Subscription-Token': body.braveApiKey } },
          ).catch(e => ({ ok: false, status: 0, _err: e.message }));
          if (!probe.ok) {
            const detail = probe._err ?? (await probe.text().catch(() => '')).slice(0, 300);
            const hint = probe.status === 401 || probe.status === 403
              ? `That doesn't look like a valid Brave Search key. Get one at api.search.brave.com (Subscriptions → API keys).`
              : `Brave rejected the key (status ${probe.status}). ${detail}`;
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: hint }));
            return true;
          }
        }
        await modifyConfig(cfg => {
          if (body.anthropicApiKey)   cfg.anthropicApiKey   = body.anthropicApiKey;
          if (body.fireworksApiKey)   cfg.fireworksApiKey   = body.fireworksApiKey;
          if (body.grokApiKey)        cfg.grokApiKey        = body.grokApiKey;

          if (body.openrouterApiKey)  cfg.openrouterApiKey  = body.openrouterApiKey;
          // Brave Search API key — used by web/deep_research skills and news plugin.
          // Validated above; empty string clears.
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
          if (body.lmstudioUrl !== undefined) {
            const prev = cfg.cortex.lmstudioUrl ?? '';
            if (body.lmstudioUrl !== prev) log.warn('config', 'lmstudioUrl changed', { from: prev, to: body.lmstudioUrl, by: authId });
            cfg.cortex.lmstudioUrl = body.lmstudioUrl;
          }
          if (body.ollamaApiKey)                 cfg.cortex.ollamaApiKey   = body.ollamaApiKey;
          if (body.lmstudioApiKey)               cfg.cortex.lmstudioApiKey = body.lmstudioApiKey;
          if (body.ollamaLocalUrl !== undefined) {
            const prev = cfg.cortex.ollamaLocalUrl ?? '';
            if (body.ollamaLocalUrl !== prev) log.warn('config', 'ollamaLocalUrl changed', { from: prev, to: body.ollamaLocalUrl, by: authId });
            cfg.cortex.ollamaLocalUrl = body.ollamaLocalUrl;
          }
          if (body.ollamaLocalApiKey)               cfg.cortex.ollamaLocalApiKey = body.ollamaLocalApiKey;
          if (body.ttsApiKey)                      cfg.ttsApiKey   = body.ttsApiKey;
          if (body.ttsApiUrl   !== undefined)      cfg.ttsApiUrl   = body.ttsApiUrl;
          if (body.ttsModel    !== undefined)      cfg.ttsModel    = body.ttsModel;
          if (body.ttsVoice    !== undefined)      cfg.ttsVoice    = body.ttsVoice;
          if (body.ttsProvider !== undefined) {
            // f5-tts was removed 2026-05-15 — the UI no longer offers it and
            // the server-side handler below silently falls back to openai if
            // an old config still has it. The handler block for f5-tts is
            // kept as dead code for now in case we re-add it.
            const allowed = ['openai', 'piper', 'elevenlabs'];
            if (allowed.includes(body.ttsProvider)) cfg.ttsProvider = body.ttsProvider;
          }
          if (body.elevenlabsApiKey)               cfg.elevenlabsApiKey = body.elevenlabsApiKey;
          if (body.elevenlabsModel !== undefined)  cfg.elevenlabsModel  = body.elevenlabsModel;
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

  // POST /api/provider-config/install-piper
  // Admin-only. Spawns scripts/install-piper.sh, streams its stdout/stderr
  // to the client as Server-Sent Events so the UI can show live progress
  // ("Downloading model 40%…"). The same script is invoked non-interactively
  // by install.sh on fresh install, so the install path is identical for
  // CLI-bootstrapped users and post-install "Install Piper" UI clicks.
  if (req.url === '/api/provider-config/install-piper' && req.method === 'POST') {
    const authId = requirePrivileged(req, res);
    if (!authId) return true;

    // Resolve the install script path relative to this file (works whether
    // OE is run from /opt, ~/.openensemble, or a dev checkout).
    const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                                    '..', 'scripts', 'install-piper.sh');
    if (!fs.existsSync(scriptPath)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `install-piper.sh not found at ${scriptPath}` }));
      return true;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const child = spawn('/usr/bin/env', ['bash', scriptPath], {
      // Run as the OE process owner so systemctl --user targets the right
      // user manager (whoever runs OE is the user Piper installs for).
      env: { ...process.env, HOME: os.homedir() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const send = (event, data) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    send('start', { script: scriptPath });

    const onLine = (kind) => (chunk) => {
      // SSE doesn't tolerate raw newlines mid-event, so split and emit one
      // event per line. Empty trailing line from the final chunk is dropped.
      const lines = chunk.toString('utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line) send('log', { kind, line });
      }
    };
    child.stdout.on('data', onLine('stdout'));
    child.stderr.on('data', onLine('stderr'));

    child.on('exit', (code, signal) => {
      send('done', { code, signal: signal ?? null, ok: code === 0 });
      try { res.end(); } catch {}
    });
    child.on('error', (err) => {
      send('done', { code: -1, error: err.message, ok: false });
      try { res.end(); } catch {}
    });

    // Best-effort: kill the install if the client disconnects mid-stream.
    // Idempotent re-run from the UI picks up wherever the previous run left
    // off (venv exists / pip cached / model already downloaded).
    req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
    return true;
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
        .map(m => ({ id: m.id ?? m.name, displayName: m.id ?? m.name, supportsVision: supportsVision('grok', m.id ?? m.name) }))
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
        .map(m => ({ id: (m.name ?? '').split('/').pop(), displayName: m.displayName || m.name, supportsVision: false }));

      // SD/Playground models exist in the web UI but aren't returned by the listing API
      // They use a different inference endpoint (/inference/v1/image_generation/...)
      const legacyImageModels = [
        { id: 'stable-diffusion-xl-1024-v1-0',    displayName: 'Stable Diffusion XL',                supportsVision: false },
        { id: 'playground-v2-1024px-aesthetic',    displayName: 'Playground v2 1024',                supportsVision: false },
        { id: 'playground-v2-5-1024px-aesthetic',  displayName: 'Playground v2.5 1024',              supportsVision: false },
        { id: 'SSD-1B',                            displayName: 'Segmind Stable Diffusion 1B',       supportsVision: false },
        { id: 'japanese-stable-diffusion-xl',      displayName: 'Japanese Stable Diffusion XL',      supportsVision: false },
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
      const annotated = OPENAI_OAUTH_STATIC_MODELS.map(m => ({ ...m, supportsVision: supportsVision('openai-oauth', m.id ?? m.name) }));
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
      const annotated = PERPLEXITY_STATIC_MODELS.map(m => ({ ...m, supportsVision: supportsVision('perplexity', m.id ?? m.name) }));
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
          supportsVision: supportsVision('ollama', m.name),
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
            supportsVision: supportsVision('lmstudio', m.key ?? m.id, { capabilities: m.capabilities }),
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
      { name: 'nomic-embed-text-v1', provider: 'builtin', displayName: 'Nomic Embed (built-in)', tier: 'bundled', supportsVision: false },
      { name: builtinReasonId, provider: 'builtin', displayName: 'OpenEnsemble Reason v1 (built-in)', tier: 'bundled', supportsVision: false },
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
    const embedProvider = c.embedProvider ?? 'builtin';
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

  // Lightweight read-only info about the configured TTS provider. Used by
  // the Voice devices drawer to render the right voice-picker control
  // (numeric speaker ID for piper, named voice for openai). No secrets
  // returned; cheaper than re-fetching the full /api/config blob.
  if (req.url === '/api/tts/info' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    const ALLOWED = ['openai', 'piper', 'elevenlabs'];
    const provider = ALLOWED.includes(cfg.ttsProvider) ? cfg.ttsProvider : 'openai';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      provider,
      defaultVoice: cfg.ttsVoice ?? null,
      ...(provider === 'piper' ? { speakerCount: 904 } : {}),
      ...(provider === 'elevenlabs' ? { keySet: !!cfg.elevenlabsApiKey } : {}),
    }));
    return true;
  }

  // List ElevenLabs voices (pre-made + user-cloned). Proxies the EL
  // /v1/voices endpoint so the API key stays server-side; UI populates
  // its per-slot dropdown from the response. Cached in-memory for 60 s
  // to avoid hammering EL on every drawer reopen.
  if (req.url === '/api/tts/elevenlabs/voices' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    if (!cfg.elevenlabsApiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ElevenLabs API key not configured' }));
      return true;
    }
    try {
      const elRes = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': cfg.elevenlabsApiKey },
        signal: AbortSignal.timeout(8000),
      });
      if (!elRes.ok) throw new Error(`ElevenLabs returned ${elRes.status}`);
      const data = await elRes.json();
      const voices = (data.voices || []).map(v => ({
        id: v.voice_id,
        label: v.name,
        category: v.category,  // 'premade' / 'cloned' / 'generated' / 'professional'
        description: v.description ?? null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ voices }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // TTS endpoint — generates audio from text using configured TTS provider
  if (req.url === '/api/tts' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadConfig();
    // Three providers supported (f5-tts was removed 2026-05-15 — kept as
    // dead-code branch below for revert convenience; selecting it is no
    // longer possible from the UI and the config validator rejects it):
    //   'openai'      — remote OpenAI-compatible (named voice)
    //   'elevenlabs'  — remote ElevenLabs (voice_id, including user-cloned)
    //   'piper'       — local libritts_r multi-speaker via piper-tts.service:5151
    const ALLOWED = ['openai', 'piper', 'elevenlabs'];
    const provider = ALLOWED.includes(cfg.ttsProvider) ? cfg.ttsProvider : 'openai';
    if (provider === 'openai' && (!cfg.ttsApiKey || !cfg.ttsApiUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TTS provider not configured' }));
      return true;
    }
    if (provider === 'elevenlabs' && !cfg.elevenlabsApiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ElevenLabs API key not configured' }));
      return true;
    }
    try {
      const { text, lang, wake_slot, voice: explicitVoice } = JSON.parse(await readBody(req));
      if (!text) throw new Error('text is required');
      // Test-audio short-circuit: when the device echoes back a
      // `__test_audio_XXX__` marker (planted by POST /api/devices/<id>/play-mp3),
      // we return the cached MP3 directly without going through any TTS
      // provider. The cache entry is one-shot (deleted on first read).
      const trimmedText = text.trim();
      if (/^__test_audio_[a-f0-9]+__$/.test(trimmedText)) {
        const cached = takeTestMp3(trimmedText);
        if (cached) {
          console.log(`[tts] test-audio hit marker=${trimmedText} bytes=${cached.length}`);
          // Stream raw audio/mpeg — libhelix on the device decodes chunks
          // as they arrive over the wire. No JSON wrap, no base64 in
          // either direction; firmware oe_tts feeds HTTP_EVENT_ON_DATA
          // bytes straight into mp3_dec.
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': cached.length });
          res.end(cached);
          return true;
        }
        console.warn(`[tts] test-audio marker=${trimmedText} missed cache, falling through to TTS`);
        // Marker recognized but cache miss (expired or already consumed) —
        // fall through to normal TTS so the device still gets something
        // rather than hanging.
      }
      // Ambient marker — server streams ONE continuous MP3 via ffmpeg
      // `-stream_loop -1` so the device gets zero silence at loop seams.
      // The response holds open until either the device closes the socket
      // (wake fire / stop) OR a server-side dropAmbientForDevice ends it.
      if (/^__ambient_[a-f0-9]+__$/.test(trimmedText)) {
        const meta = takeAmbientStream(trimmedText);
        if (meta) {
          const sourcePath = ambientFilePath(meta.userId, meta.file);
          if (!sourcePath) {
            console.warn(`[tts] ambient marker=${trimmedText} resolved bad filename ${meta.file}`);
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ambient source missing' }));
            return true;
          }
          const { spawn } = await import('child_process');
          const args = ['-loglevel', 'error'];
          if (meta.loop !== false) args.push('-stream_loop', '-1');
          args.push('-i', sourcePath,
                    '-ac', '2', '-ar', '48000', '-b:a', '160k',
                    '-f', 'mp3', 'pipe:1');
          const ff = spawn('ffmpeg', args);
          res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked' });
          // Wire ffmpeg stdout → response; ffmpeg stderr → console (rarely
          // chatty since -loglevel error). Close cleanup is critical: we
          // must always kill the ffmpeg process when the response ends so
          // we don't leak a runaway child per stop-without-restart.
          ff.stdout.pipe(res);
          ff.stderr.on('data', d => console.warn(`[tts] ambient ffmpeg: ${d.toString().trim()}`));
          const cleanup = () => {
            try { ff.kill('SIGKILL'); } catch {}
            unregisterAmbientResponse(trimmedText);
          };
          ff.on('error', cleanup);
          ff.on('exit', cleanup);
          res.on('close', cleanup);
          res.on('error', cleanup);
          registerAmbientResponse(trimmedText, res, cleanup);
          console.log(`[tts] ambient stream started marker=${trimmedText} file=${meta.file} loop=${meta.loop !== false}`);
          return true;
        }
        console.warn(`[tts] ambient marker=${trimmedText} missed cache (TTL expired or never cached)`);
      }
      // Voice resolution order:
      //   1. explicit `voice` body param (used by Settings → voice preview
      //      to audition an unsaved value before committing it)
      //   2. slot_assignments[wake_slot].ttsVoice for the device making
      //      the request (voice-device + slot in body)
      //   3. cfg.ttsVoice (server-global default)
      //   4. 'alloy' for openai / '0' for piper (hardcoded fallback)
      const defaultVoice =
        provider === 'f5-tts' ? 'default-en' :
        provider === 'piper' ? '0' :
        provider === 'elevenlabs' ? '21m00Tcm4TlvDq8ikWAM' : // Rachel — EL stock voice id
        'alloy';
      let voice = cfg.ttsVoice || defaultVoice;
      if (Number.isInteger(wake_slot)) {
        const meta = getSessionMeta(getAuthToken(req));
        if (meta?.deviceId) {
          const a = getSlotAssignment(authId, meta.deviceId, wake_slot);
          if (a?.ttsVoice) voice = a.ttsVoice;
        }
      }
      if (typeof explicitVoice === 'string' && explicitVoice) voice = explicitVoice;
      if (provider === 'elevenlabs') {
        // ElevenLabs returns MP3 directly — no conversion step. voice is a
        // voice_id (UUID-ish string). Default model 'eleven_turbo_v2_5' is
        // their low-latency option; users can override via cfg.elevenlabsModel.
        const elModel = cfg.elevenlabsModel || 'eleven_turbo_v2_5';
        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`, {
          method: 'POST',
          headers: {
            'xi-api-key': cfg.elevenlabsApiKey,
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: elModel,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
          signal: AbortSignal.timeout(30000),
        });
        if (!elRes.ok) {
          const errBody = await elRes.text().catch(() => '');
          throw new Error(`ElevenLabs ${elRes.status}: ${errBody.slice(0, 200)}`);
        }
        const elMp3 = Buffer.from(await elRes.arrayBuffer());
        // ElevenLabs returns MP3 at 22050 or 44100 Hz. The device's I²S
        // playback runs at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE), so
        // anything higher plays slow + pitched-down. Resample via ffmpeg
        // before sending. Browser-side previews don't suffer this because
        // <audio> handles arbitrary sample rates; only the on-device
        // playback path needs the conversion. Could short-circuit when
        // the request is from a browser-auth session, but the savings
        // (~30 ms ffmpeg pass) aren't worth the branching.
        const { spawn: spawnEl } = await import('child_process');
        const ffEl = spawnEl('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'mp3', '-i', 'pipe:0',
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const elChunks = [];
        ffEl.stdout.on('data', c => elChunks.push(c));
        const ffElPromise = new Promise((resolve, reject) => {
          ffEl.on('error', reject);
          ffEl.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ffEl.stdin.end(elMp3);
        await ffElPromise;
        const elMp3_16k = Buffer.concat(elChunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': elMp3_16k.length });
        res.end(elMp3_16k);
        return true;
      }
      if (provider === 'f5-tts') {
        // Resolve `voice` (a refId string) to the WAV path + transcript.
        // The built-in 'default-en' lives under models/tts/refs/; user
        // uploads live under users/<owner>/voice-refs/. The owner for
        // refId lookup is the AUTH user, not the slot's effective user —
        // the device-paired user manages all voices for their device.
        let refPath, refText;
        if (voice === 'default-en') {
          refPath = '/home/shawn/.openensemble/models/tts/refs/default-en.wav';
          refText = 'Some call me nature, others call me mother nature.';
        } else {
          const ref = getVoiceRef(authId, voice);
          if (!ref) {
            // Fall back to default rather than 500 the device — better to
            // hear *some* voice than nothing.
            console.warn(`[tts] f5-tts: refId ${voice} not found, using default-en`);
            refPath = '/home/shawn/.openensemble/models/tts/refs/default-en.wav';
            refText = 'Some call me nature, others call me mother nature.';
          } else {
            refPath = ref.wavPath;
            refText = ref.transcript;
          }
        }
        const f5Url = cfg.f5ttsUrl || 'http://127.0.0.1:5152/tts';
        // F5-TTS clones cleanly on most short prompts but >40s of generation
        // gets slow on CPU; OE's voice replies are short so this is fine.
        const f5Res = await fetch(f5Url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, ref_path: refPath, ref_text: refText }),
          signal: AbortSignal.timeout(60000),
        });
        if (!f5Res.ok) {
          const errBody = await f5Res.text().catch(() => '');
          throw new Error(`F5-TTS returned ${f5Res.status}: ${errBody.slice(0, 200)}`);
        }
        const wavBuf = Buffer.from(await f5Res.arrayBuffer());
        const { spawn } = await import('child_process');
        const ff = spawn('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'wav', '-i', 'pipe:0',
          // Device I²S is fixed at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE).
          // Sending higher-rate MP3 → libhelix decodes at source rate →
          // played into a 16 kHz I²S pipeline → audio is slower + pitched
          // down. Resample server-side to match the bus.
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const chunks = [];
        ff.stdout.on('data', c => chunks.push(c));
        const ffPromise = new Promise((resolve, reject) => {
          ff.on('error', reject);
          ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ff.stdin.end(wavBuf);
        await ffPromise;
        const mp3Buf = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3Buf.length });
        res.end(mp3Buf);
        return true;
      }
      if (provider === 'piper') {
        // Piper HTTP server speaks {text, speaker_id} → WAV. We translate
        // OpenAI-shape, run through ffmpeg to get MP3 (matches the device's
        // existing decode path), and return base64 + audio/mpeg.
        const speakerId = Number.parseInt(voice, 10);
        const piperUrl = cfg.piperUrl || 'http://127.0.0.1:5151/';
        const pRes = await fetch(piperUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            speaker_id: Number.isFinite(speakerId) ? speakerId : 0,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!pRes.ok) throw new Error(`Piper returned ${pRes.status}`);
        const wavBuf = Buffer.from(await pRes.arrayBuffer());
        // WAV → MP3 via ffmpeg subprocess. Pipe in, pipe out. Avoids any
        // disk I/O. 64 kbps mono is fine for speech and keeps the base64
        // payload roughly the same size as OpenAI's tts-1 output.
        const { spawn } = await import('child_process');
        const ff = spawn('ffmpeg', [
          '-loglevel', 'error',
          '-f', 'wav', '-i', 'pipe:0',
          // Device I²S is fixed at 16 kHz (audio_io.h AUDIO_BUS_SAMPLE_RATE).
          // Sending higher-rate MP3 → libhelix decodes at source rate →
          // played into a 16 kHz I²S pipeline → audio is slower + pitched
          // down. Resample server-side to match the bus.
          '-ac', '1', '-ar', '16000', '-b:a', '48k',
          '-f', 'mp3', 'pipe:1',
        ]);
        const chunks = [];
        ff.stdout.on('data', c => chunks.push(c));
        const ffPromise = new Promise((resolve, reject) => {
          ff.on('error', reject);
          ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
        });
        ff.stdin.end(wavBuf);
        await ffPromise;
        const mp3Buf = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3Buf.length });
        res.end(mp3Buf);
        return true;
      }
      // OpenAI provider (default / legacy)
      const ttsRes = await fetch(cfg.ttsApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.ttsApiKey}`,
        },
        body: JSON.stringify({
          model: cfg.ttsModel || 'tts-1',
          voice,
          input: text,
          ...(lang ? { language: lang } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!ttsRes.ok) throw new Error(`TTS API returned ${ttsRes.status}`);
      const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
      const mimeType = ttsRes.headers.get('content-type') || 'audio/mpeg';
      res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': audioBuffer.length });
      res.end(audioBuffer);
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
      // Binary-safe read — readBody() would UTF-8-mangle the WAV bytes.
      const raw = await readBodyBuffer(req);
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

      // Debug dump: save the most recent upload so we can inspect malformed
      // WAVs / silence / clipped audio when STT rejects with "could not
      // process file". Overwrites previous /tmp/oe-stt-last.* every call.
      try {
        const fs = await import('fs');
        fs.writeFileSync(`/tmp/oe-stt-last-${audioName.replace(/[^\w.-]/g, '_')}`, audioBuf);
        console.log(`[stt] dump: ${audioBuf.length} bytes (${audioMime}) → /tmp/oe-stt-last-*`);
      } catch (e) { console.warn('[stt] dump failed:', e.message); }

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
      let transcript = data.text ?? data.transcript ?? '';
      // Whisper renders times like "11:02 AM" as "11.02 AM" or just "11.22"
      // — period instead of colon. Normalize any HH.MM in valid time range
      // (00-23 hours, 00-59 minutes) to HH:MM. The bounds keep prices
      // ("$1.99") and version numbers ("v1.2") from getting rewritten.
      transcript = transcript.replace(
        /\b([0-1]?\d|2[0-3])\.([0-5]\d)\b/g,
        '$1:$2',
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ transcript, raw: data }));
    } catch (e) { safeError(res, e); }
    return true;
  }

  return false;
}
