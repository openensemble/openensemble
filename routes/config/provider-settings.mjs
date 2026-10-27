/**
 * /api/provider-config GET/POST — extracted from routes/config.mjs.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import {
  requireAuth, requirePrivileged, loadConfig, modifyConfig, readBody, safeError,
} from '../_helpers.mjs';
import { loadUserProviders } from '../../lib/user-providers.mjs';
import { supportsImageGeneration, supportsVision } from '../../lib/model-capabilities.mjs';
import { listOpenAIOAuthModels } from '../../lib/openai-codex-models.mjs';
import { listXaiOAuthModels } from '../../lib/xai-oauth-models.mjs';
import {
  probePiperAvailable,
  probeKittenttsAvailable,
  probePocketTtsAvailable,
  probeFasterWhisperAvailable,
  probeFfmpegAvailable,
  invalidateVoiceDepsCache,
} from '../../lib/voice-deps.mjs';
import { OPENAI_COMPAT_PROVIDERS, getCompatKey, getGrokKey, getAnthropicKey, getFireworksKey, getOpenRouterKey } from '../../chat/providers/_shared.mjs';
import { log } from '../../logger.mjs';
import { LOCAL_STT, localSttProvider, localSttInstalled, probeLocalStt, selectLocalStt, withSttOperation, previousSttToUninstall } from '../../lib/local-stt.mjs';
import { uninstallPreviousLocalStt } from './local-stt-install.mjs';
import { checkOllamaCloudKey, resolveOllamaKey } from '../../lib/ollama-cloud.mjs';
import { refreshProviderFeeds, providerFeedStatus } from '../../lib/provider-update-feeds.mjs';
import { listProviderUpdateResults, providerUpdateMessage } from '../../lib/provider-update-status.mjs';

const COMPAT_PROVIDERS = OPENAI_COMPAT_PROVIDERS;
const OLLAMA_DEFAULT = 'https://ollama.com/api';
const LMS_DEFAULT = 'http://127.0.0.1:1234';

// Bound from parent (pin GPU helpers + URL validation live with config).
let validateProviderUrl = (field, raw) => String(raw ?? '').trim();
let listNvidiaGpus = async () => [];
let pinServiceGpu = async () => {};

export function bindProviderSettingsDeps(deps) {
  if (deps.validateProviderUrl !== undefined) validateProviderUrl = deps.validateProviderUrl;
  if (deps.listNvidiaGpus !== undefined) listNvidiaGpus = deps.listNvidiaGpus;
  if (deps.pinServiceGpu !== undefined) pinServiceGpu = deps.pinServiceGpu;
}

export async function tryHandleProviderSettings(req, res) {

  if (req.url === '/api/provider-updates' && ['GET', 'POST'].includes(req.method)) {
    const authId = requirePrivileged(req, res);
    if (!authId) return true;
    if (req.method === 'POST') await refreshProviderFeeds({ force: true });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ sources: providerFeedStatus(), results: listProviderUpdateResults(authId)
      .map(row => ({ ...row, message: providerUpdateMessage(row) })) }));
    return true;
  }

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
      for (const prov of Object.keys(COMPAT_PROVIDERS)) {
        compatFlags[`${prov}KeySet`] = !!getCompatKey(prov);
      }
      // Self-describing compat provider list. The UI uses this to render the
      // Providers panel + the agent model-picker optgroups so that providers
      // added at runtime via oe-admin's add_provider (saved to the
      // config/user-providers.json overlay) appear in the UI just like the
      // built-in ones — without the UI shipping a hardcoded list of names.
      const userProviderIds = new Set(Object.keys(loadUserProviders() || {}));
      const compatProviders = Object.entries(COMPAT_PROVIDERS).map(([id, p]) => ({
        id,
        displayName: p.displayName || id,
        baseUrl: p.baseUrl,
        keyField: p.keyField,
        keySet: !!getCompatKey(id),
        enabled: cfg.enabledProviders?.[id] !== false,
        source: userProviderIds.has(id) ? 'user' : 'static',
      }));
      // Probe local Piper service (500 ms cap) so the UI can show "install"
      // vs "running" status without a separate round-trip. ffmpegAvailable
      // gates every TTS provider (we always resample/encode through ffmpeg)
      // so Settings → Providers can disable options when ffmpeg is missing.
      const [piperAvailable, kittenttsAvailable, pocketTtsAvailable, fasterWhisperAvailable, ffmpegAvailable] = await Promise.all([
        probePiperAvailable(cfg),
        probeKittenttsAvailable(cfg),
        probePocketTtsAvailable(cfg),
        probeFasterWhisperAvailable(cfg),
        probeFfmpegAvailable(),
      ]);
      const localSttProviders = await Promise.all(Object.values(LOCAL_STT).map(async provider => ({
        id: provider.id, label: provider.label, profiles: provider.profiles,
        installed: localSttInstalled(provider), available: await probeLocalStt(provider),
        profile: cfg.integrations?.[provider.key]?.profile ?? null,
        gpuId: cfg.integrations?.[provider.key]?.gpuId ?? null,
      })));
      const ollamaKey = resolveOllamaKey(cfg);
      const ollamaConnection = cfg.enabledProviders?.ollama === false
        ? { ok: false, code: 'disabled', message: 'Ollama Cloud is disabled.' }
        : await checkOllamaCloudKey(ollamaKey);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        anthropicKeySet:   !!getAnthropicKey(),
        fireworksKeySet:   !!getFireworksKey(),
        grokKeySet:        !!getGrokKey(),

        ollamaKeySet:      !!ollamaKey,
        ollamaConnection,
        lmstudioKeySet:    !!cfg.cortex?.lmstudioApiKey,
        openrouterKeySet:  !!getOpenRouterKey(),
        ollamaUrl:    OLLAMA_DEFAULT,
        lmstudioUrl:  cfg.cortex?.lmstudioUrl  ?? LMS_DEFAULT,
        // Secondary, local-only Ollama endpoint. Users with Ollama Cloud for
        // chat still need a local Ollama to host the memory-lane GGUF (Cloud
        // refuses /api/create). Kept separate so they can have both.
        ollamaLocalUrl:    cfg.cortex?.ollamaLocalUrl    ?? '',
        ollamaLocalKeySet: !!cfg.cortex?.ollamaLocalApiKey,
        braveKeySet:  !!cfg.braveApiKey,
        // 'auto' = model's built-in web search when the provider supports it,
        // Brave otherwise. 'native-only' = never call Brave (built-in search
        // still works; models without it lose web search).
        webSearchMode: cfg.webSearchMode === 'native-only' ? 'native-only' : 'auto',
        ttsKeySet:    !!cfg.ttsApiKey,
        ttsApiUrl:    cfg.ttsApiUrl   ?? '',
        ttsModel:     cfg.ttsModel    ?? '',
        ttsVoice:     cfg.ttsVoice    ?? '',
        ttsProvider:  cfg.ttsProvider ?? 'openai',
        // sttMode controls where /api/stt sends audio. 'remote' uses
        // sttApiUrl + sttApiKey (the default OpenAI-compat path). 'local'
        // routes to the selected local speech service regardless of
        // the URL field, so users can keep their remote credentials saved
        // while flipping between local and remote without losing either.
        sttMode:      cfg.sttMode === 'local' ? 'local' : 'remote',
        sttLocalProvider: localSttProvider(cfg).id,
        localSttProviders,
        piperLengthScale: Number.isFinite(cfg.piperLengthScale) ? cfg.piperLengthScale : 1.1,
        piperAvailable,
        kittenttsAvailable,
        pocketTtsAvailable,
        // Installed (unit file present) vs available (service responding). Local
        // TTS installers no longer auto-start; selecting + saving starts the
        // service. The UI keys selectability off *Installed so an installed-but-
        // stopped provider can still be picked (Save then starts it).
        piperInstalled:     fs.existsSync(path.join(os.homedir(), '.config/systemd/user/piper-tts.service')),
        kittenttsInstalled: fs.existsSync(path.join(os.homedir(), '.config/systemd/user/kittentts.service')),
        pocketTtsInstalled: fs.existsSync(path.join(os.homedir(), '.config/systemd/user/pocket-tts.service')),
        fasterWhisperAvailable,
        // Persisted install state — set true at profile-install time. The UI
        // keys "installed vs pick-a-profile" off THIS (not the live probe), so
        // a transient probe miss during cold-start/restart (model load takes up
        // to ~15 s) doesn't wrongly tell the user to reinstall. The probe still
        // drives the "running now" sub-state.
        fasterWhisperInstalled: cfg.integrations?.faster_whisper?.installed === true,
        fasterWhisperProfile: cfg.integrations?.faster_whisper?.profile ?? null,
        // Which GPU the STT service is pinned to (CUDA_VISIBLE_DEVICES index,
        // with CUDA_DEVICE_ORDER=PCI_BUS_ID so it matches nvidia-smi's index).
        // null = no explicit pin (CUDA's default, usually device 0). Only
        // meaningful on the cuda profile + a multi-GPU box. Lets users keep STT
        // off a GPU they want free for e.g. local training.
        fasterWhisperGpuId: Number.isInteger(cfg.integrations?.faster_whisper?.gpuId)
          ? cfg.integrations.faster_whisper.gpuId : null,
        ffmpegAvailable,
        elevenlabsKeySet: !!cfg.elevenlabsApiKey,
        elevenlabsModel:  cfg.elevenlabsModel ?? '',
        // ElevenLabs speaking-pace control (voice_settings.speed). 1.0 = the
        // model's brisk default; <1 slows it. Default 0.85 fixes the turbo
        // model's rushed cadence. UI exposes a slider like Piper's pace.
        elevenlabsSpeed:  Number.isFinite(cfg.elevenlabsSpeed) ? cfg.elevenlabsSpeed : 0.85,
        sttKeySet:    !!cfg.sttApiKey,
        sttApiUrl:    cfg.sttApiUrl   ?? '',
        sttModel:     cfg.sttModel    ?? '',
        enabledProviders: cfg.enabledProviders ?? {},
        msClientIdSet:     !!cfg.msClientId,
        msClientSecretSet: !!cfg.msClientSecret,
        msTenant:          cfg.msTenant ?? '',
        providerFailover: cfg.providerFailover ?? { enabled: false, fallbackProvider: '', fallbackModel: '' },
        ...compatFlags,
        compatProviders,
      }));
      return true;
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        if (body.sttMode !== undefined && !['local', 'remote'].includes(body.sttMode)) throw new Error('Invalid STT mode.');
        if (body.sttLocalProvider !== undefined && !Object.hasOwn(LOCAL_STT, body.sttLocalProvider)) throw new Error('Unknown local STT provider.');
        if (body.sttGpuProvider !== undefined && !Object.hasOwn(LOCAL_STT, body.sttGpuProvider)) throw new Error('Unknown STT GPU provider.');
        const changesStt = body.sttMode !== undefined || body.sttLocalProvider !== undefined;
        if (body.uninstallPreviousStt != null && !changesStt) throw new Error('Choose the replacement speech model before uninstalling the previous one.');
        let sttCleanup = {};
        // Validate admin-writable provider URLs *before* the modifyConfig
        // transaction so a bad value 400s loudly instead of half-writing.
        // (POST is already gated to requirePrivileged at the dispatch above.)
        if (body.lmstudioUrl !== undefined) {
          body.lmstudioUrl = validateProviderUrl('lmstudioUrl', body.lmstudioUrl);
        }
        if (body.ollamaLocalUrl !== undefined) {
          body.ollamaLocalUrl = validateProviderUrl('ollamaLocalUrl', body.ollamaLocalUrl);
        }
        if (body.ollamaApiKey !== undefined && body.ollamaApiKey !== '') {
          if (typeof body.ollamaApiKey !== 'string' || !body.ollamaApiKey.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Enter an Ollama Cloud API key.' }));
            return true;
          }
          body.ollamaApiKey = body.ollamaApiKey.trim();
          const connection = await checkOllamaCloudKey(body.ollamaApiKey, { refresh: true });
          if (!connection.ok) {
            res.writeHead(connection.code === 'authentication_failed' ? 422 : 502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `${connection.message} The new key was not saved.`, code: connection.code }));
            return true;
          }
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
        // Validate the STT GPU pin against actually-present GPUs *before* the
        // transaction, so a bad index 400s loudly instead of silently writing a
        // unit that fails to start. null clears the pin.
        if (body.fasterWhisperGpuId !== undefined && body.fasterWhisperGpuId !== null) {
          const g = Number(body.fasterWhisperGpuId);
          const gpus = await listNvidiaGpus();
          if (!Number.isInteger(g) || g < 0 || !gpus.some(d => d.index === g)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `fasterWhisperGpuId must be the index of a detected GPU (have: ${gpus.map(d => d.index).join(', ') || 'none'})` }));
            return true;
          }
        }
        if (body.sttGpuId !== undefined && body.sttGpuId !== null) {
          const gpus = await listNvidiaGpus();
          if (!Number.isInteger(body.sttGpuId) || !gpus.some(g => g.index === body.sttGpuId)) throw new Error('STT GPU must be a detected GPU index or null.');
        }
        let sttGpuPin;
        // Set when the STT GPU pin changes, applied (unit rewrite + restart)
        // after the config save. undefined = unchanged; null = clear pin.
        let fwGpuPinToApply;
        // Set when the TTS provider is (re)saved. After the save we enforce
        // "one local TTS service at a time": stop the others, start the selected
        // one. undefined = ttsProvider not in this request → leave services alone.
        let ttsProviderToApply;
        const persist = () => modifyConfig(cfg => {
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
          // Web search mode — 'auto' (Brave fallback allowed) or 'native-only'
          // (never call Brave; models with built-in search still search).
          if (body.webSearchMode === 'auto' || body.webSearchMode === 'native-only') {
            cfg.webSearchMode = body.webSearchMode;
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
          if (body.piperLengthScale !== undefined) {
            // Clamp to [0.7, 1.6]: below 0.7 sounds chipmunked, above 1.6
            // sounds drunk. UI slider exposes 0.8-1.5 inside this safe band.
            const n = Number(body.piperLengthScale);
            if (Number.isFinite(n) && n >= 0.7 && n <= 1.6) cfg.piperLengthScale = n;
          }
          if (body.ttsProvider !== undefined) {
            const allowed = ['openai', 'piper', 'kittentts', 'elevenlabs', 'pocket-tts'];
            if (allowed.includes(body.ttsProvider)) {
              cfg.ttsProvider = body.ttsProvider;
              // Enforce one-local-TTS-at-a-time after the save (below).
              ttsProviderToApply = body.ttsProvider;
            }
          }
          if (body.elevenlabsApiKey)               cfg.elevenlabsApiKey = body.elevenlabsApiKey;
          if (body.elevenlabsModel !== undefined)  cfg.elevenlabsModel  = body.elevenlabsModel;
          if (body.elevenlabsSpeed !== undefined) {
            const n = Number(body.elevenlabsSpeed);
            if (Number.isFinite(n) && n >= 0.7 && n <= 1.2) cfg.elevenlabsSpeed = n;
          }
          if (body.sttApiKey)                      cfg.sttApiKey   = body.sttApiKey;
          if (body.sttApiUrl   !== undefined)      cfg.sttApiUrl   = body.sttApiUrl;
          if (body.sttModel    !== undefined)      cfg.sttModel    = body.sttModel;
          if (body.sttMode !== undefined) cfg.sttMode = body.sttMode;
          if (body.sttLocalProvider !== undefined) cfg.sttLocalProvider = body.sttLocalProvider;
          if (body.sttGpuId !== undefined) {
            const provider = body.sttGpuProvider ? LOCAL_STT[body.sttGpuProvider] : localSttProvider(cfg);
            cfg.integrations ??= {};
            cfg.integrations[provider.key] ??= {};
            cfg.integrations[provider.key].gpuId = body.sttGpuId;
            sttGpuPin = { provider, gpuId: body.sttGpuId };
          }
          // Pin (or clear) which GPU the local STT service runs on. Accepts a
          // non-negative integer (GPU index) or null (clear). Only applied when
          // faster-whisper is installed; persisted either way so a later install
          // honors it. Validated against detected GPUs above.
          if (body.fasterWhisperGpuId !== undefined) {
            const g = body.fasterWhisperGpuId;
            const val = (g === null) ? null : Number(g);
            cfg.integrations ??= {};
            cfg.integrations.faster_whisper ??= {};
            if (val === null) delete cfg.integrations.faster_whisper.gpuId;
            else cfg.integrations.faster_whisper.gpuId = val;
            if (cfg.integrations.faster_whisper.installed === true) fwGpuPinToApply = val;
          }
          if (body.enabledProviders !== undefined) cfg.enabledProviders = { ...(cfg.enabledProviders ?? {}), ...body.enabledProviders };
          if (body.providerFailover !== undefined) cfg.providerFailover = body.providerFailover;
          if (body.clearMicrosoftCreds) { delete cfg.msClientId; delete cfg.msClientSecret; delete cfg.msTenant; }
          else {
            if (body.msClientId)             cfg.msClientId     = body.msClientId;
            if (body.msClientSecret)         cfg.msClientSecret = body.msClientSecret;
            if (body.msTenant !== undefined) cfg.msTenant       = body.msTenant;
          }
        });
        if (changesStt || body.sttGpuId !== undefined || body.fasterWhisperGpuId !== undefined) {
          await withSttOperation(async () => {
            const previous = loadConfig();
            const next = { ...previous, ...(body.sttMode !== undefined ? { sttMode: body.sttMode } : {}),
              ...(body.sttLocalProvider !== undefined ? { sttLocalProvider: body.sttLocalProvider } : {}) };
            const removePrevious = previousSttToUninstall(previous, next, body.uninstallPreviousStt);
            if (changesStt) await selectLocalStt(previous, next, persist);
            else await persist();
            if (sttGpuPin && localSttInstalled(sttGpuPin.provider)) {
              const result = await pinServiceGpu(sttGpuPin.provider.unit, sttGpuPin.gpuId);
              if (!result.ok) throw new Error(`Could not apply STT GPU: ${result.reason}`);
            }
            if (fwGpuPinToApply !== undefined) await pinServiceGpu('faster-whisper.service', fwGpuPinToApply);
            sttCleanup = await uninstallPreviousLocalStt(removePrevious);
            invalidateVoiceDepsCache();
          });
        } else await persist();
        // One-local-TTS-at-a-time. Installers no longer auto-start their service;
        // selecting + saving a provider is what starts it. Here we stop+disable
        // every local TTS unit except the selected, then start+enable the
        // selected one (if it's a local service) and wait for it to accept
        // requests so the post-save UI reflects "running". Remote providers
        // (openai, elevenlabs) just stop all local TTS. STT is untouched.
        if (ttsProviderToApply !== undefined) {
          const TTS_UNITS = {
            piper:        { unit: 'piper-tts.service', port: 5151 },
            kittentts:    { unit: 'kittentts.service', port: 5153 },
            'pocket-tts': { unit: 'pocket-tts.service', port: 5155 },
          };
          const sel = TTS_UNITS[ttsProviderToApply] || null;
          const sysctl = (args) => new Promise(resolve => {
            const c = spawn('systemctl', ['--user', ...args], { env: { ...process.env, HOME: os.homedir() }, stdio: 'ignore' });
            c.on('error', () => resolve(-1));
            c.on('exit', code => resolve(code ?? -1));
          });
          try {
            for (const { unit } of Object.values(TTS_UNITS)) {
              if (!sel || unit !== sel.unit) await sysctl(['disable', '--now', unit]);
            }
            if (sel) {
              await sysctl(['enable', '--now', sel.unit]);
              for (let i = 0; i < 12; i++) { // up to ~6s for model load
                try {
                  const r = await fetch(`http://127.0.0.1:${sel.port}/`, { signal: AbortSignal.timeout(500) });
                  if (r.status >= 200 && r.status < 600) break;
                } catch {}
                await new Promise(r => setTimeout(r, 500));
              }
            }
            invalidateVoiceDepsCache();
            log.info('config', `TTS provider → ${ttsProviderToApply}${sel ? ` (started ${sel.unit}, others stopped)` : ' (remote — local TTS stopped)'}`);
          } catch (e) {
            log.warn('config', 'TTS service switch failed', { provider: ttsProviderToApply, error: e.message });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...sttCleanup }));
      } catch (e) { res.writeHead(e.status || 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      return true;
    }
  }

  return false;
}
