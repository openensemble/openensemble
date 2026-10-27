// Local STT selection and service lifecycle. Old local configurations use Whisper.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const LOCAL_STT = Object.freeze({
  'faster-whisper': { id: 'faster-whisper', label: 'Faster-Whisper large-v3-turbo', key: 'faster_whisper', unit: 'faster-whisper.service', port: 5154, model: 'large-v3-turbo', profiles: ['cpu', 'cuda'] },
  'photon-ultra': { id: 'photon-ultra', label: 'Photon Ultra + Silero', key: 'photon_ultra', unit: 'photon-ultra.service', port: 5158, model: 'moondream/parakeet-ultra', profiles: ['cuda'] },
  'photon-redux': { id: 'photon-redux', label: 'Photon Redux + Silero', key: 'photon_redux', unit: 'photon-redux.service', port: 5159, model: 'moondream/parakeet-redux', profiles: ['cpu', 'cuda'] },
});

export function localSttProvider(cfg) {
  return Object.hasOwn(LOCAL_STT, cfg.sttLocalProvider) ? LOCAL_STT[cfg.sttLocalProvider] : LOCAL_STT['faster-whisper'];
}

export function localSttUrl(provider) {
  return `http://127.0.0.1:${provider.port}/v1/audio/transcriptions`;
}

export function localSttInstalled(provider) {
  return fs.existsSync(path.join(os.homedir(), '.config/systemd/user', provider.unit));
}

// The client names the model shown beside its checkbox. A stale settings page
// must never remove a different model another admin selected in the meantime.
export function previousSttToUninstall(previous, next, requested) {
  if (requested === undefined || requested === null) return null;
  if (typeof requested !== 'string' || !Object.hasOwn(LOCAL_STT, requested)) {
    throw new Error('Unknown previous STT model to uninstall.');
  }
  const old = localSttProvider(previous);
  if (previous.sttMode !== 'local' || next.sttMode !== 'local'
      || old.id !== requested || localSttProvider(next).id === old.id) {
    throw Object.assign(new Error('The active speech model changed. Reload settings before choosing which model to uninstall.'), { status: 409 });
  }
  return old;
}

export async function probeLocalStt(provider) {
  try {
    const response = await fetch(`http://127.0.0.1:${provider.port}/`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    if (provider.id === 'faster-whisper') return (await response.text()).trim() === 'faster-whisper';
    const health = await response.json();
    return health.ready === true && health.provider === provider.id && health.silero === true;
  } catch { return false; }
}

export function sttSystemctl(args) {
  return new Promise(resolve => {
    const child = spawn('systemctl', ['--user', ...args], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(false); }, 20_000);
    const done = ok => { clearTimeout(timer); resolve(ok); };
    child.once('error', () => done(false));
    child.once('close', code => done(code === 0));
  });
}

let busy = false;
export async function withSttOperation(work) {
  if (busy) throw Object.assign(new Error('Another local STT operation is in progress. Try again when it finishes.'), { status: 409 });
  busy = true;
  try { return await work(); } finally { busy = false; }
}

// Called inside withSttOperation. Do not route audio to a model until it is ready.
// Stop the others first to release VRAM; restore the old service on any failure.
export async function selectLocalStt(previous, next, persist, deps = {}) {
  const systemctl = deps.systemctl || sttSystemctl;
  const installed = deps.installed || localSttInstalled;
  const probe = deps.probe || probeLocalStt;
  const wait = deps.wait || (() => new Promise(resolve => setTimeout(resolve, 500)));
  const old = previous.sttMode === 'local' ? localSttProvider(previous) : null;
  const selected = next.sttMode === 'local' ? localSttProvider(next) : null;
  if (selected && !installed(selected)) throw new Error(`${selected.label} is not installed. Install it first.`);
  try {
    for (const provider of Object.values(LOCAL_STT)) {
      if (provider.id !== selected?.id && installed(provider)) {
        if (!await systemctl(['disable', '--now', provider.unit])) throw new Error(`Could not stop ${provider.label}.`);
      }
    }
    if (selected) {
      if (!await systemctl(['enable', '--now', selected.unit])) throw new Error(`Could not start ${selected.label}.`);
      let ready = false;
      for (let attempt = 0; attempt < (deps.attempts || 120); attempt++) {
        if (await probe(selected)) { ready = true; break; }
        await wait();
      }
      if (!ready) throw new Error(`${selected.label} did not become ready. Check its service log and available memory.`);
    }
    await persist();
  } catch (error) {
    if (selected && selected.id !== old?.id) await systemctl(['disable', '--now', selected.unit]);
    if (old && installed(old)) {
      const restored = await systemctl(['enable', '--now', old.unit]);
      let ready = false;
      if (restored) {
        for (let attempt = 0; attempt < (deps.attempts || 120); attempt++) {
          if (await probe(old)) { ready = true; break; }
          await wait();
        }
      }
      if (!ready) error.message += ` The previous ${old.label} service could not be restored; check its service log.`;
    }
    throw error;
  }
}
