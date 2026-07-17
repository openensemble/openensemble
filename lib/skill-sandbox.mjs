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
 * @param {{ writableDirs?: string[], roDirs?: string[], roDirBinds?: Array<{source:string,target:string}>, roFileBinds?: Array<{source:string,target:string}>, cwd?: string|null, net?: boolean, env?: Record<string,string>, procMount?: boolean }} [opts]
 */
export function buildSandboxArgs(bin, binArgs = [], opts = {}) {
  const {
    writableDirs = [], roDirs = [], roDirBinds = [], roFileBinds = [],
    cwd = null, net = true, env = {}, procMount = true,
  } = opts;
  const args = [
    // Start from an empty environment so the OE server's process.env (provider
    // API keys, master-key material) never leaks into the jail. PATH/LANG/HOME
    // and any explicit per-skill env are re-set below.
    '--clearenv',
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
  // A dedicated Docker sandbox-runner can create an unprivileged user + PID
  // namespace once its narrowly scoped seccomp/AppArmor policy permits those
  // syscalls, but Docker still blocks mounting a fresh procfs without granting
  // the container CAP_SYS_ADMIN. The runner therefore omits /proc entirely;
  // the jailed process does not inherit the outer container's procfs. Normal
  // host execution keeps the existing private procfs profile by default.
  if (procMount) args.push('--proc', '/proc');
  args.push('--dev', '/dev', '--tmpfs', '/tmp');
  // Always make the binary's own directory reachable read-only.
  const binDir = path.dirname(path.resolve(bin));
  for (const d of [binDir, ...roDirs]) if (d) args.push('--ro-bind-try', d, d);
  // A preference snapshot replaces the complete live skill tree. This hides
  // uncaptured .cjs/assets/new files; the explicit state sub-bind below is the
  // only live subtree that remains writable/visible.
  for (const binding of roDirBinds) {
    if (binding?.source && binding?.target) {
      args.push('--ro-bind', path.resolve(binding.source), path.resolve(binding.target));
    }
  }
  for (const d of writableDirs) if (d) args.push('--bind', d, d);
  // Immutable code-closure overlays are applied last, after writable state.
  for (const binding of roFileBinds) {
    if (binding?.source && binding?.target) {
      args.push('--ro-bind', path.resolve(binding.source), path.resolve(binding.target));
    }
  }
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
 * @param {{ writableDirs?: string[], roDirs?: string[], roDirBinds?: Array<{source:string,target:string}>, roFileBinds?: Array<{source:string,target:string}>, cwd?: string|null, net?: boolean, env?: Record<string,string>, procMount?: boolean, timeoutMs?: number, maxStdoutBytes?: number, signal?: AbortSignal|null }} [opts]
 */
export function runSandboxed(bin, binArgs = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const signal = opts.signal ?? null;
    const abortError = () => {
      if (signal?.reason instanceof Error) return signal.reason;
      const error = new Error('sandboxed process aborted');
      error.name = 'AbortError';
      return error;
    };
    if (signal?.aborted) { reject(abortError()); return; }
    if (!BWRAP_BIN) {
      reject(new Error('bubblewrap (bwrap) is not installed — refusing to run an external binary unsandboxed. Install: sudo apt install bubblewrap'));
      return;
    }
    const { timeoutMs = 0, maxStdoutBytes = 512 * 1024 * 1024 } = opts;
    let child;
    // A private host process group lets cancellation reach bwrap and any
    // descendants it launched. Killing only bwrap can otherwise leave a
    // sandboxed subprocess alive until its parent-death handling catches up.
    const detached = process.platform !== 'win32';
    try {
      child = spawn(BWRAP_BIN, buildSandboxArgs(bin, binArgs, opts), {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached,
        ...(signal ? { signal } : {}),
      });
    } catch (e) { reject(e); return; }

    // Stream stdout to a host-side temp file instead of buffering it in memory.
    // yt-dlp --dump-json alone is 8–30 MB and an in-RAM cap would truncate/kill
    // it mid-run (this was the bug that made channel-resolution downloads fail).
    // The temp file is on the parent's pipe end, not inside the sandbox, so no
    // bind is needed. stderr stays in memory (small, bounded). A generous size
    // ceiling still guards against a runaway process filling the disk.
    const outPath = path.join(os.tmpdir(), `oe-sbx-${crypto.randomUUID()}.out`);
    const outStream = fs.createWriteStream(outPath);
    let stderr = '', wrote = 0, timedOut = false, aborted = false;
    let tooBig = false, settled = false, fatalError = null, killTimer = null;

    const signalProcessGroup = (processSignal) => {
      if (detached && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, processSignal); return; } catch {}
      }
      try { child.kill(processSignal); } catch {}
    };
    // Give well-behaved programs a short cleanup window, then guarantee that a
    // TERM-ignoring process cannot outlive the cancelled/timed-out tool call.
    const terminate = () => {
      signalProcessGroup('SIGTERM');
      if (killTimer) return;
      killTimer = setTimeout(() => signalProcessGroup('SIGKILL'), 2000);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs) : null;

    const finish = (code, err) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      outStream.end(() => {
        let stdout = '';
        try { stdout = fs.readFileSync(outPath, 'utf8'); } catch {}
        try { fs.unlinkSync(outPath); } catch {}
        if (aborted) return reject(abortError());
        if (err) return reject(err);
        if (timedOut) return reject(new Error(`sandboxed process timed out after ${timeoutMs}ms`));
        if (tooBig) return reject(new Error(`sandboxed process output exceeded ${maxStdoutBytes} bytes`));
        resolve({ code, stdout, stderr });
      });
    };

    child.stdout.on('data', d => {
      wrote += d.length;
      if (wrote > maxStdoutBytes) { tooBig = true; terminate(); return; }
      outStream.write(d);
    });
    child.stderr.on('data', d => { if (stderr.length < 1_000_000) stderr += String(d); });
    outStream.on('error', e => { fatalError = e; terminate(); });
    child.on('error', e => {
      // AbortSignal makes ChildProcess emit AbortError before close. Keep the
      // TERM→KILL escalation armed until close instead of settling early and
      // accidentally leaving a TERM-ignoring descendant alive.
      if (signal?.aborted || e?.name === 'AbortError') {
        aborted = true;
        terminate();
        return;
      }
      finish(null, e);
    });
    child.on('close', code => finish(code, fatalError));
    signal?.addEventListener('abort', onAbort, { once: true });
    // Close the small race between the pre-spawn check and listener install.
    if (signal?.aborted) onAbort();
  });
}
