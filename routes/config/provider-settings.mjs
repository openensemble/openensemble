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
import { OPENAI_COMPAT_PROVIDERS } from '../../chat/providers/_shared.mjs';
import { log } from '../../logger.mjs';

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
        keySet: !!cfg[p.keyField],
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
        // sttMode controls where /api/stt sends audio. 'remote' uses
        // sttApiUrl + sttApiKey (the default OpenAI-compat path). 'local'
        // forces 127.0.0.1:5154 (the Faster-Whisper service) regardless of
        // the URL field, so users can keep their remote credentials saved
        // while flipping between local and remote without losing either.
        sttMode:      cfg.sttMode === 'local' ? 'local' : 'remote',
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
        // Set inside the modifyConfig closure when sttMode actually flips, so
        // the systemd side-effect below only runs on a real transition.
        let fwServiceAction = null; // 'stop' (→ remote) | 'start' (→ local)
        // Set when the STT GPU pin changes, applied (unit rewrite + restart)
        // after the config save. undefined = unchanged; null = clear pin.
        let fwGpuPinToApply;
        // Set when the TTS provider is (re)saved. After the save we enforce
        // "one local TTS service at a time": stop the others, start the selected
        // one. undefined = ttsProvider not in this request → leave services alone.
        let ttsProviderToApply;
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
          if (body.sttMode === 'remote' || body.sttMode === 'local') {
            // Stop the local Faster-Whisper systemd unit when switching to a
            // remote STT API (it'd otherwise keep holding GPU/VRAM for nothing);
            // restart it when switching back to local. Only when it's actually
            // installed — we stop, never uninstall, so the swap back is instant.
            const prevMode = cfg.sttMode === 'local' ? 'local' : 'remote';
            if (body.sttMode !== prevMode && cfg.integrations?.faster_whisper?.installed === true) {
              fwServiceAction = body.sttMode === 'remote' ? 'stop' : 'start';
            }
            cfg.sttMode = body.sttMode;
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
        // Apply the Faster-Whisper service transition AFTER the config save.
        // `--now` does stop+disable / start+enable in one call, so the choice
        // also survives reboots (no point auto-starting whisper on boot while
        // the user is on a remote API). Non-fatal: log on failure; never block
        // the config save on a systemd hiccup.
        if (fwServiceAction) {
          const verb = fwServiceAction === 'stop' ? 'disable' : 'enable';
          const child = spawn('systemctl', ['--user', verb, '--now', 'faster-whisper.service'], {
            env: { ...process.env, HOME: os.homedir() },
            stdio: 'ignore',
          });
          child.on('error', (e) => log.warn('config', 'faster-whisper service control failed', { action: fwServiceAction, error: e.message }));
          child.on('exit', (code) => {
            if (code === 0) { invalidateVoiceDepsCache(); log.info('config', `faster-whisper ${fwServiceAction === 'stop' ? 'stopped (switched to remote STT)' : 'started (switched to local STT)'}`); }
            else log.warn('config', 'faster-whisper service control non-zero exit', { action: fwServiceAction, code });
          });
        }
        // Apply the GPU pin (rewrite unit + restart if running). Skipped when we
        // also just toggled the service on/off above — that path already wrote
        // CUDA env via the installer/enable and a double restart is pointless.
        if (fwGpuPinToApply !== undefined && !fwServiceAction) {
          pinServiceGpu('faster-whisper.service', fwGpuPinToApply)
            .then(r => { if (!r.ok) log.warn('config', 'STT GPU pin failed', r); })
            .catch(e => log.warn('config', 'STT GPU pin error', { error: e.message }));
        }
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
        res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
      return true;
    }
  }

  return false;
}
