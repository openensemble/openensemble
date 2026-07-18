/**
 * Local engine install/uninstall routes. Extracted from routes/config.mjs.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';
import {
  requireAuth, requirePrivileged, loadConfig, modifyConfig, readBody, safeError,
} from '../_helpers.mjs';
import {
  probePiperAvailable,
  probeKittenttsAvailable,
  probePocketTtsAvailable,
  probeFasterWhisperAvailable,
  invalidateVoiceDepsCache,
} from '../../lib/voice-deps.mjs';
import { log } from '../../logger.mjs';
import { PIPER_VOICE_CATALOG } from './speech.mjs';

export async function tryHandleProviderInstall(req, res) {
  const pinServiceGpu = async (...args) => (await import('../config.mjs')).pinServiceGpu(...args);

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
                                      '..', '..', 'scripts', 'install-piper.sh');
      if (!fs.existsSync(scriptPath)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `install-piper.sh not found at ${scriptPath}` }));
        return true;
      }

      // Optional body: { voice: "<id from catalog>" } picks which voice is
      // installed as the default. Empty body = libritts_r (legacy default,
      // matches the bare-install path from install.sh).
      let initialVoice = '';
      try {
        const raw = await readBody(req);
        if (raw) {
          const body = JSON.parse(raw);
          if (body && typeof body.voice === 'string' && body.voice) {
            if (!PIPER_VOICE_CATALOG.find(v => v.id === body.voice)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `unknown voice id: ${body.voice}` }));
              return true;
            }
            initialVoice = body.voice;
          }
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `bad request body: ${e.message}` }));
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
        env: {
          ...process.env,
          HOME: os.homedir(),
          ...(initialVoice ? { PIPER_VOICE: initialVoice } : {}),
        },
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
        // Successful install → drop the 60 s availability cache so the
        // next /api/provider-config GET reflects "running" immediately
        // instead of waiting up to a minute.
        if (code === 0) invalidateVoiceDepsCache();
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

    // POST /api/provider-config/uninstall-piper
    // POST /api/provider-config/uninstall-kittentts
    // Admin-only. Spawn the matching uninstall-*.sh, wait for completion,
    // return a JSON envelope with the captured stdout. Plain JSON (no SSE)
    // because uninstall runs in <1 s — streaming would be theater. The
    // voice-deps cache is invalidated on success so the next
    // /api/provider-config GET reflects the change immediately.
    {
      const uninstallMatch = req.url.match(/^\/api\/provider-config\/uninstall-(piper|kittentts|faster-whisper|pocket-tts)$/);
      if (uninstallMatch && req.method === 'POST') {
        const authId = requirePrivileged(req, res);
        if (!authId) return true;
        const which = uninstallMatch[1];
        const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                                        '..', '..', 'scripts', `uninstall-${which}.sh`);
        if (!fs.existsSync(scriptPath)) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `uninstall-${which}.sh not found at ${scriptPath}` }));
          return true;
        }
        const child = spawn('/usr/bin/env', ['bash', scriptPath], {
          env: { ...process.env, HOME: os.homedir() },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const chunks = [];
        child.stdout.on('data', c => chunks.push(c));
        child.stderr.on('data', c => chunks.push(c));
        child.on('exit', (code) => {
          const ok = code === 0;
          if (ok) invalidateVoiceDepsCache();
          res.writeHead(ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok, code, output: Buffer.concat(chunks).toString('utf8') }));
        });
        child.on('error', (err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
        return true;
      }
    }

    // POST /api/provider-config/install-faster-whisper  body: { profile: "cpu" | "cuda" }
    // Same SSE shape as install-piper/install-kittentts. profile picks the
    // installer's FW_DEVICE env: cpu = distil-large-v3 int8, cuda =
    // large-v3-turbo float16 (needs NVIDIA driver — the script bails early
    // if nvidia-smi isn't present so the failure is visible in the SSE log).
    if (req.url === '/api/provider-config/install-faster-whisper' && req.method === 'POST') {
      const authId = requirePrivileged(req, res);
      if (!authId) return true;

      const cfg = loadConfig();
      const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                                      '..', '..', 'scripts', 'install-faster-whisper.sh');
      if (!fs.existsSync(scriptPath)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `install-faster-whisper.sh not found at ${scriptPath}` }));
        return true;
      }

      let profile = 'cpu';
      try {
        const raw = await readBody(req);
        if (raw) {
          const body = JSON.parse(raw);
          if (body?.profile === 'cuda' || body?.profile === 'cpu') profile = body.profile;
          else if (body?.profile != null) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `profile must be "cpu" or "cuda", got ${body.profile}` }));
            return true;
          }
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `bad request body: ${e.message}` }));
        return true;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const child = spawn('/usr/bin/env', ['bash', scriptPath], {
        env: {
          ...process.env, HOME: os.homedir(), FW_DEVICE: profile,
          // Honor a previously-chosen GPU pin so reinstalling/switching profiles
          // doesn't silently move STT back onto the default GPU.
          ...(profile === 'cuda' && Number.isInteger(cfg.integrations?.faster_whisper?.gpuId)
            ? { FW_GPU_ID: String(cfg.integrations.faster_whisper.gpuId) } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
      };
      send('start', { script: scriptPath, profile });

      const onLine = (kind) => (chunk) => {
        const lines = chunk.toString('utf8').split(/\r?\n/);
        for (const line of lines) {
          if (line) send('log', { kind, line });
        }
      };
      child.stdout.on('data', onLine('stdout'));
      child.stderr.on('data', onLine('stderr'));

      child.on('exit', (code, signal) => {
        if (code === 0) {
          invalidateVoiceDepsCache();
          // Persist which profile is installed so /api/provider-config can
          // surface it in the UI without re-probing the systemd unit file.
          modifyConfig(cfg => {
            cfg.integrations ??= {};
            cfg.integrations.faster_whisper ??= {};
            cfg.integrations.faster_whisper.installed = true;
            cfg.integrations.faster_whisper.profile = profile;
          });
        }
        send('done', { code, signal: signal ?? null, ok: code === 0 });
        try { res.end(); } catch {}
      });
      child.on('error', (err) => {
        send('done', { code: -1, error: err.message, ok: false });
        try { res.end(); } catch {}
      });
      req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
      return true;
    }

    // POST /api/provider-config/install-kittentts
    // Same shape as install-piper: SSE-stream the install script's output.
    // KittenTTS is the no-GPU / no-API-key fallback tier; install is CPU-only,
    // ~50 MB, and finishes in under a minute on first run.
    // POST /api/provider-config/install-pocket-tts
    // Same SSE shape as install-kittentts. Pocket TTS (Kyutai 100M CPU TTS,
    // zero-shot voice cloning). Weights are mirrored non-gated (CC-BY-4.0) at
    // openensemble/pocket-tts so users never hit the upstream HF access gate.
    if (req.url === '/api/provider-config/install-pocket-tts' && req.method === 'POST') {
      const authId = requirePrivileged(req, res);
      if (!authId) return true;

      const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                                      '..', '..', 'scripts', 'install-pocket-tts.sh');
      if (!fs.existsSync(scriptPath)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `install-pocket-tts.sh not found at ${scriptPath}` }));
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const childP = spawn('/usr/bin/env', ['bash', scriptPath], {
        env: { ...process.env, HOME: os.homedir() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const sendP = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
      };
      sendP('start', { script: scriptPath });
      const onLineP = (kind) => (chunk) => {
        const lines = chunk.toString('utf8').split(/\r?\n/);
        for (const line of lines) { if (line) sendP('log', { kind, line }); }
      };
      childP.stdout.on('data', onLineP('stdout'));
      childP.stderr.on('data', onLineP('stderr'));
      childP.on('exit', (code, signal) => {
        if (code === 0) invalidateVoiceDepsCache();
        sendP('done', { code, signal: signal ?? null, ok: code === 0 });
        try { res.end(); } catch {}
      });
      childP.on('error', (err) => {
        sendP('done', { code: -1, error: err.message, ok: false });
        try { res.end(); } catch {}
      });
      req.on('close', () => { try { childP.kill('SIGTERM'); } catch {} });
      return true;
    }

    if (req.url === '/api/provider-config/install-kittentts' && req.method === 'POST') {
      const authId = requirePrivileged(req, res);
      if (!authId) return true;

      const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                                      '..', '..', 'scripts', 'install-kittentts.sh');
      if (!fs.existsSync(scriptPath)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `install-kittentts.sh not found at ${scriptPath}` }));
        return true;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const child = spawn('/usr/bin/env', ['bash', scriptPath], {
        env: { ...process.env, HOME: os.homedir() },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
      };

      send('start', { script: scriptPath });

      const onLine = (kind) => (chunk) => {
        const lines = chunk.toString('utf8').split(/\r?\n/);
        for (const line of lines) {
          if (line) send('log', { kind, line });
        }
      };
      child.stdout.on('data', onLine('stdout'));
      child.stderr.on('data', onLine('stderr'));

      child.on('exit', (code, signal) => {
        if (code === 0) invalidateVoiceDepsCache();
        send('done', { code, signal: signal ?? null, ok: code === 0 });
        try { res.end(); } catch {}
      });
      child.on('error', (err) => {
        send('done', { code: -1, error: err.message, ok: false });
        try { res.end(); } catch {}
      });

      req.on('close', () => { try { child.kill('SIGTERM'); } catch {} });
      return true;
    }
  return false;
}
