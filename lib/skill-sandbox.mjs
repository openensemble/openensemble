// @ts-check
/**
 * Shared bubblewrap sandbox for running an external binary a skill provisioned
 * (via ctx.ensureRuntime). Generalizes the coder skill's proven profile
 * (skills/coder/execute.mjs): system dirs READ-ONLY, only the caller's declared
 * dirs writable, isolated user/pid/ipc/uts/cgroup namespaces, dies with parent.
 *
 * Why: a downloaded third-party binary is the genuinely-untrusted element a skill
 * pulls in. This contains it so it can't read the OE config, credentials, other
 * users' files, or the rest of the disk — only what the skill explicitly binds.
 *
 * NOT a sandbox for the skill's own in-process execute.mjs (that runs in the OE
 * process with live ctx; sandboxing it would sever ctx and brick skills — see
 * project_skill_multitenant_isolation_todo). This sandboxes the SUBPROCESS only.
 */
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

export const BWRAP_BIN = (() => {
  try {
    const p = execSync('command -v bwrap', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return p || null;
  } catch { return null; }
})();

export function sandboxAvailable() { return !!BWRAP_BIN; }

// When Node came from nvm its bin dir is outside /usr and won't be on PATH inside
// the sandbox; bind the install root (bin+lib so npm/npx symlinks resolve) and
// prepend its bin/. Mirrors the coder skill.
const NODE_BIN_DIR = path.dirname(process.execPath);
const NODE_INSTALL_ROOT = path.dirname(NODE_BIN_DIR);
const NEEDS_NODE_BIND = NODE_BIN_DIR && !NODE_BIN_DIR.startsWith('/usr/') && NODE_BIN_DIR !== '/bin';
const SANDBOX_PATH = NEEDS_NODE_BIND
  ? `${NODE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin`
  : '/usr/local/bin:/usr/bin:/bin';

/**
 * Build bwrap args to run `bin binArgs...`. System is read-only; `roDirs` are
 * bound read-only (e.g. the dir holding the binary), `writableDirs` read-write
 * (e.g. an output folder). Network is allowed unless net:false.
 * @param {string} bin
 * @param {string[]} binArgs
 * @param {{ writableDirs?: string[], roDirs?: string[], cwd?: string|null, net?: boolean, env?: Record<string,string> }} [opts]
 */
export function buildSandboxArgs(bin, binArgs = [], opts = {}) {
  const { writableDirs = [], roDirs = [], cwd = null, net = true, env = {} } = opts;
  const args = [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/sbin', '/sbin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
    '--ro-bind-try', '/etc/ssl', '/etc/ssl',
    '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
    '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf',
    '--ro-bind-try', '/etc/hosts', '/etc/hosts',
    '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    '--ro-bind-try', '/etc/gai.conf', '/etc/gai.conf',
    '--ro-bind-try', '/etc/passwd', '/etc/passwd',
    '--ro-bind-try', '/etc/group', '/etc/group',
    '--ro-bind-try', '/etc/localtime', '/etc/localtime',
  ];
  if (NEEDS_NODE_BIND) args.push('--ro-bind-try', NODE_INSTALL_ROOT, NODE_INSTALL_ROOT);
  // Base special mounts FIRST, then explicit binds — so a writable/ro dir that
  // happens to live under /tmp isn't shadowed by the tmpfs (bwrap applies ops in
  // order; later binds mount into the earlier tmpfs).
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  // Always make the binary's own directory reachable read-only.
  const binDir = path.dirname(path.resolve(bin));
  for (const d of [binDir, ...roDirs]) if (d) args.push('--ro-bind-try', d, d);
  for (const d of writableDirs) if (d) args.push('--bind', d, d);
  args.push(
    '--setenv', 'PATH', SANDBOX_PATH,
    '--setenv', 'LANG', 'C.UTF-8',
  );
  if (cwd) args.push('--chdir', cwd, '--setenv', 'HOME', cwd);
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, String(v));
  if (!net) args.push('--unshare-net');
  args.push(
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
    '--die-with-parent', '--new-session',
    path.resolve(bin), ...binArgs.map(String),
  );
  return args;
}

/**
 * Run a binary under bwrap, buffering output. Resolves { code, stdout, stderr }.
 * Rejects only if bwrap itself can't spawn (not on a non-zero exit).
 * @param {string} bin
 * @param {string[]} binArgs
 * @param {{ writableDirs?: string[], roDirs?: string[], cwd?: string|null, net?: boolean, env?: Record<string,string>, timeoutMs?: number, maxStdoutBytes?: number }} [opts]
 */
export function runSandboxed(bin, binArgs = [], opts = {}) {
  return new Promise((resolve, reject) => {
    if (!BWRAP_BIN) {
      reject(new Error('bubblewrap (bwrap) is not installed — refusing to run an external binary unsandboxed. Install: sudo apt install bubblewrap'));
      return;
    }
    const { timeoutMs = 0, maxStdoutBytes = 512 * 1024 * 1024 } = opts;
    let child;
    try {
      child = spawn(BWRAP_BIN, buildSandboxArgs(bin, binArgs, opts), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }

    // Stream stdout to a host-side temp file instead of buffering it in memory.
    // yt-dlp --dump-json alone is 8–30 MB and an in-RAM cap would truncate/kill
    // it mid-run (this was the bug that made channel-resolution downloads fail).
    // The temp file is on the parent's pipe end, not inside the sandbox, so no
    // bind is needed. stderr stays in memory (small, bounded). A generous size
    // ceiling still guards against a runaway process filling the disk.
    const outPath = path.join(os.tmpdir(), `oe-sbx-${crypto.randomUUID()}.out`);
    const outStream = fs.createWriteStream(outPath);
    const timer = timeoutMs > 0 ? setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs) : null;
    let stderr = '', wrote = 0, killed = false, tooBig = false, settled = false;

    const finish = (code, err) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      outStream.end(() => {
        let stdout = '';
        try { stdout = fs.readFileSync(outPath, 'utf8'); } catch {}
        try { fs.unlinkSync(outPath); } catch {}
        if (err) return reject(err);
        if (killed) return reject(new Error(`sandboxed process timed out after ${timeoutMs}ms`));
        if (tooBig) return reject(new Error(`sandboxed process output exceeded ${maxStdoutBytes} bytes`));
        resolve({ code, stdout, stderr });
      });
    };

    child.stdout.on('data', d => {
      wrote += d.length;
      if (wrote > maxStdoutBytes) { tooBig = true; try { child.kill('SIGKILL'); } catch {} return; }
      outStream.write(d);
    });
    child.stderr.on('data', d => { if (stderr.length < 1_000_000) stderr += String(d); });
    outStream.on('error', e => finish(null, e));
    child.on('error', e => finish(null, e));
    child.on('close', code => finish(code, null));
  });
}
