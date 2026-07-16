// @ts-check
/**
 * External-binary helper used only when a dedicated runner already placed the
 * custom skill inside its final per-user Bubblewrap jail. Re-entering bwrap
 * from that child is both redundant and structurally impossible in Docker.
 *
 * This does not widen the jail: the child inherits the same empty environment,
 * filesystem mounts, PID namespace, and outer network decision. The binary is
 * still restricted to a real, non-symlink file under the owning skill's bin/.
 * `opts.net:false` cannot create a still-narrower namespace here; network
 * availability is inherited from the owning skill's manifest-selected
 * Bubblewrap namespace.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';

function realDirectory(candidate, label) {
  const resolved = path.resolve(String(candidate || ''));
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw new Error(`${label} is missing`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${label} must be a real, non-symlink directory`);
  }
  return resolved;
}

/**
 * @param {string} skillDir
 * @param {string} candidate
 */
export function validateJailedSkillBinary(skillDir, candidate) {
  const root = realDirectory(path.join(skillDir, 'bin'), 'custom skill bin directory');
  const resolved = path.resolve(String(candidate || ''));
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw new Error('custom skill binary is missing'); }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved
    || !(resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error("runSandboxed: refusing to run a binary outside the skill's own bin/ dir");
  }
  return resolved;
}

function cleanEnvironment(input, cwd) {
  /** @type {Record<string, string>} */
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8',
    ...(cwd ? { HOME: cwd } : {}),
  };
  if (input == null) return env;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('runSandboxed: env must be an object');
  }
  for (const [key, value] of Object.entries(input)) {
    env[key] = String(value);
  }
  return env;
}

/**
 * @param {string} skillDir
 * @param {string} bin
 * @param {string[]} binArgs
 * @param {{cwd?:string|null, env?:Record<string,string>, timeoutMs?:number,
 *   maxStdoutBytes?:number}} [opts]
 */
export function runBinaryInsideSkillJail(skillDir, bin, binArgs = [], opts = {}) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(binArgs)) {
      reject(new Error('runSandboxed: binArgs must be an array'));
      return;
    }
    let executable;
    let cwd = null;
    let env;
    try {
      executable = validateJailedSkillBinary(skillDir, bin);
      cwd = opts.cwd == null ? null : realDirectory(opts.cwd, 'runSandboxed cwd');
      env = cleanEnvironment(opts.env, cwd);
    } catch (error) { reject(error); return; }
    // Match the established trusted runSandboxed helper: no implicit timeout,
    // caller-selected timeouts are not clamped, and large yt-dlp JSON output is
    // allowed up to the existing 512 MiB default.
    const timeoutMs = opts.timeoutMs ?? 0;
    const maxStdoutBytes = opts.maxStdoutBytes ?? 512 * 1024 * 1024;
    const outputPath = path.join(os.tmpdir(), `oe-jailed-runtime-${crypto.randomUUID()}.out`);
    const output = fs.createWriteStream(outputPath, { mode: 0o600 });
    let child;
    const detached = process.platform !== 'win32';
    try {
      child = spawn(executable, binArgs.map(String), {
        cwd: cwd || undefined,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
      });
    } catch (error) {
      try { output.destroy(); fs.unlinkSync(outputPath); } catch {}
      reject(error);
      return;
    }

    let stderr = '';
    let stdoutBytes = 0;
    let timedOut = false;
    let tooBig = false;
    let settled = false;
    const killProcessGroup = () => {
      if (detached && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch {}
      }
      try { child.kill('SIGKILL'); } catch {}
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killProcessGroup();
    }, timeoutMs) : null;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      output.end(() => {
        let stdout = '';
        try { stdout = fs.readFileSync(outputPath, 'utf8'); } catch {}
        try { fs.unlinkSync(outputPath); } catch {}
        if (error) { reject(error); return; }
        if (timedOut) { reject(new Error(`sandboxed process timed out after ${timeoutMs}ms`)); return; }
        if (tooBig) { reject(new Error(`sandboxed process output exceeded ${maxStdoutBytes} bytes`)); return; }
        resolve({ code, stdout, stderr });
      });
    };
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        tooBig = true;
        killProcessGroup();
        return;
      }
      output.write(chunk);
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 1_000_000) stderr += String(chunk).slice(0, 1_000_000 - stderr.length);
    });
    output.once('error', error => finish(null, error));
    child.once('error', error => finish(null, error));
    child.once('close', code => finish(code, null));
  });
}
