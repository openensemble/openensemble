import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { requirePrivileged, readBody, loadConfig, modifyConfig } from '../_helpers.mjs';
import { invalidateVoiceDepsCache } from '../../lib/voice-deps.mjs';
import { LOCAL_STT, localSttProvider, withSttOperation, selectLocalStt, sttSystemctl, previousSttToUninstall } from '../../lib/local-stt.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function runInstaller(script, env, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/env', ['bash', path.join(root, 'scripts', script)], {
      env: { ...process.env, OE_HOME: root, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    let timedOut = false;
    let forceKill;
    const stop = signal => { try { process.kill(-child.pid, signal); } catch {} };
    const timer = setTimeout(() => {
      timedOut = true; stop('SIGTERM');
      forceKill = setTimeout(() => stop('SIGKILL'), 5000);
    }, 20 * 60_000);
    for (const kind of ['stdout', 'stderr']) child[kind].on('data', chunk => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line) onLine(kind, line);
    });
    child.once('error', error => { clearTimeout(timer); clearTimeout(forceKill); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(forceKill);
      if (timedOut) reject(new Error('Installation timed out. Retry to resume cached downloads.'));
      else code === 0 ? resolve() : reject(new Error(`Installer exited with code ${code}. See the log above.`));
    });
  });
}

// Run only after the replacement has passed readiness and its selection is saved.
// Cleanup failure must not roll back a working replacement or hide its success.
export async function uninstallPreviousLocalStt(provider, onLine = () => {}) {
  if (!provider) return {};
  try {
    const current = loadConfig();
    if (current.sttMode === 'local' && localSttProvider(current).id === provider.id) {
      throw new Error('it is still the selected speech model');
    }
    onLine('stdout', `Uninstalling the previous ${provider.label} installation. Cached models are kept.`);
    await runInstaller(`uninstall-${provider.id === 'faster-whisper' ? 'faster-whisper' : 'photon-stt'}.sh`,
      { PHOTON_VARIANT: provider.id === 'photon-ultra' ? 'ultra' : 'redux' }, onLine);
    await modifyConfig(cfg => {
      cfg.integrations ??= {};
      cfg.integrations[provider.key] ??= {};
      cfg.integrations[provider.key].installed = false;
    });
    invalidateVoiceDepsCache();
    return { uninstalledPreviousStt: provider.id };
  } catch (error) {
    const warning = `The new speech model is running, but ${provider.label} could not be uninstalled: ${error.message}`;
    onLine('stderr', warning);
    return { warning };
  }
}

export async function tryHandleLocalSttInstall(req, res) {
  const install = ['/api/provider-config/install-local-stt', '/api/provider-config/install-faster-whisper'].includes(req.url);
  const uninstall = ['/api/provider-config/uninstall-local-stt', '/api/provider-config/uninstall-faster-whisper'].includes(req.url);
  if (req.method !== 'POST' || (!install && !uninstall)) return false;
  if (!requirePrivileged(req, res)) return true;
  let streaming = false;
  let heartbeat;
  const send = (event, data) => {
    if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const id = req.url.endsWith('-faster-whisper') ? 'faster-whisper' : body.provider;
    if (!Object.hasOwn(LOCAL_STT, id)) throw new Error('Unknown local STT provider.');
    const provider = LOCAL_STT[id];
    const profile = body.profile || (id === 'photon-ultra' ? 'cuda' : 'cpu');
    if (install && !provider.profiles.includes(profile)) throw new Error(`${provider.label} does not support the ${profile} profile.`);
    await withSttOperation(async () => {
      const previous = loadConfig();
      const next = { ...previous, sttMode: 'local', sttLocalProvider: id };
      const removePrevious = install ? previousSttToUninstall(previous, next, body.uninstallPreviousStt) : null;
      if (uninstall && previous.sttMode === 'local' && localSttProvider(previous).id === id) {
        throw new Error('Select another STT provider or Remote API before uninstalling the active service.');
      }
      if (install) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
        streaming = true;
        heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': installing\n\n'); }, 15_000);
        send('start', { provider: id, profile });
      }
      const gpuId = previous.integrations?.[provider.key]?.gpuId;
      const env = {
        FW_INSTALL_ONLY: '1', FW_DEVICE: profile,
        PHOTON_VARIANT: id === 'photon-ultra' ? 'ultra' : 'redux', PHOTON_DEVICE: profile,
        ...(Number.isInteger(gpuId) ? { FW_GPU_ID: String(gpuId), PHOTON_GPU_ID: String(gpuId) } : {}),
      };
      const script = `${install ? 'install' : 'uninstall'}-${id === 'faster-whisper' ? 'faster-whisper' : 'photon-stt'}.sh`;
      const lines = [];
      await runInstaller(script, env, (kind, line) => {
        if (streaming) send('log', { kind, line });
        else lines.push(line);
      });
      await modifyConfig(cfg => {
        cfg.integrations ??= {};
        cfg.integrations[provider.key] ??= {};
        cfg.integrations[provider.key].installed = install;
        if (install) cfg.integrations[provider.key].profile = profile;
      });
      if (install) {
        send('log', { kind: 'stdout', line: `Starting ${provider.label}; other local STT services will be stopped.` });
        // A rewritten profile/unit must be reloaded even if it was already active.
        if (!await sttSystemctl(['stop', provider.unit])) throw new Error(`Could not stop ${provider.label} before reloading its installed profile.`);
        await selectLocalStt(previous, next, () => modifyConfig(cfg => {
          cfg.sttMode = 'local';
          cfg.sttLocalProvider = id;
        }));
        const cleanup = await uninstallPreviousLocalStt(removePrevious, (kind, line) => send('log', { kind, line }));
        invalidateVoiceDepsCache();
        send('done', { ok: true, code: 0, provider: id, ...cleanup });
        res.end();
      } else {
        invalidateVoiceDepsCache();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, output: lines.join('\n') }));
      }
    });
  } catch (error) {
    if (streaming) { send('done', { ok: false, code: -1, error: error.message }); res.end(); }
    else { res.writeHead(error.status || 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  } finally { clearInterval(heartbeat); }
  return true;
}
