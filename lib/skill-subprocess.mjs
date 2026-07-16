// @ts-check
/**
 * Sandboxed runner for CUSTOM (user-authored) skills. Trusted global skills keep
 * running in-process; this is only for `users/<uid>/skills/*`, whose code we do
 * NOT trust. It runs the skill's execute.mjs inside a bwrap jail (via
 * lib/skill-host.mjs) where the only mounted user data is the OWNER's media/doc
 * folders + the skill's own state dir.
 *
 * Binding policy (the security boundary):
 *   writable : users/<uid>/{documents,images,videos,audio} + users/<uid>/skills/<id>/state
 *   readonly : <repo>/lib, <repo>/node_modules, <repo>/memory, the skill's own dir
 *   NOT bound: config.json, users/_system (master key), this user's token files,
 *              and every OTHER user's directory → those paths simply don't exist
 *              inside the jail, so a rogue skill reading them gets ENOENT.
 *
 * Two entry points share one jail + one NDJSON RPC loop (runSandboxedJob):
 *   - runCustomSkillSandboxed  → a tool call, ctx.* brokered by skill-ctx-broker
 *   - watcher firing           → scheduler/watchers.mjs passes its own handleRpc
 *
 * Fail-closed: if bwrap is unavailable we refuse rather than fall back to the
 * in-process path — an un-sandboxed custom skill is the exact thing this prevents.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { BWRAP_BIN, buildSandboxArgs, sandboxAvailable } from './skill-sandbox.mjs';
import { BASE_DIR, getUserFilesDir, userSkillsDir } from './paths.mjs';
import { makeCtxBroker } from './skill-ctx-broker.mjs';
import { inspectSkillCodeSnapshotPath } from './personalization/skill-code-integrity.mjs';

// CODE paths resolve from the install itself (this module's location), never
// from BASE_DIR: the BASE_DIR redirect exists for DATA isolation (vitest tmp
// dirs), and a redirected data dir has no lib/ or node_modules/ — the jail
// would fail to find its own host script. In production the two are the same
// directory, so this changes nothing there.
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_SCRIPT = path.join(INSTALL_ROOT, 'lib', 'skill-host.mjs');

// Custom skills may write only to these output kinds (research/code are
// reserved for trusted tooling and stay unmounted). Matches the blueprint
// contract custom skills are authored against.
export const CUSTOM_SKILL_WRITABLE_KINDS = ['documents', 'images', 'videos', 'audio', 'research'];

function requireRealDirectory(candidate, label) {
  const resolved = path.resolve(candidate);
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw new Error(`${label} is missing`); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error(`${label} must be a real, non-symlink directory`);
  }
  return resolved;
}

/**
 * Compute the bwrap bind sets + key paths for one (user, skill). Ensures every
 * writable source exists on the host first — bwrap --bind requires the source to
 * exist, and getUserFilesDir already mkdirs the data kinds.
 * @param {string} userId
 * @param {string} skillId
 */
export function customSkillBindings(userId, skillId) {
  const writableDirs = CUSTOM_SKILL_WRITABLE_KINDS.map((k) =>
    requireRealDirectory(getUserFilesDir(userId, k), `custom skill ${k} directory`));
  const skillDir = requireRealDirectory(
    path.join(userSkillsDir(userId), skillId), 'custom skill directory',
  );
  const stateDir = path.join(skillDir, 'state');
  if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { mode: 0o700 });
  const realStateDir = requireRealDirectory(stateDir, 'custom skill state directory');
  const stateRelative = path.relative(skillDir, realStateDir);
  if (!stateRelative || stateRelative.startsWith(`..${path.sep}`) || path.isAbsolute(stateRelative)) {
    throw new Error('custom skill state directory escapes its owning skill');
  }
  writableDirs.push(realStateDir);
  // Read-only code the skill imports. skillDir is bound RO; stateDir (a subpath)
  // is re-bound RW above — buildSandboxArgs applies writableDirs AFTER roDirs, so
  // the later RW bind wins for the state subtree inside an otherwise-RO skill dir.
  const roDirs = [
    // Code from the install (see INSTALL_ROOT above); data from BASE_DIR.
    path.join(INSTALL_ROOT, 'lib'),
    path.join(INSTALL_ROOT, 'node_modules'),
    path.join(BASE_DIR, 'memory'),
    skillDir,
  ];
  return {
    writableDirs, roDirs, skillDir, stateDir: realStateDir,
    execPath: path.join(skillDir, 'execute.mjs'),
  };
}

/** Pure path boundary for reviewed safe-auto executor overlays. */
export function validateReviewedExecSnapshotPath(skillDir, candidate) {
  return inspectSkillCodeSnapshotPath(skillDir, candidate)?.execPath || null;
}

/**
 * Generic jail runner: spawn the host, ship `jobPayload`, service the child's
 * ctx/helper RPCs via `handleRpc`, forward streamed events to `onEvent`, and
 * resolve with the final result. Callers own what the RPC surface means.
 * @param {{ userId: string, skillId: string, jobPayload: any,
 *           handleRpc: (method: string, args: any[]) => Promise<any>,
 *           onEvent?: ((ev:any)=>void)|null, net?: boolean, timeoutMs?: number,
 *           execSnapshotPath?: string|null, signal?: AbortSignal|null }} opts
 * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string }>}
 */
export function runSandboxedJob({
  userId, skillId, jobPayload, handleRpc, onEvent = null, net = true,
  timeoutMs = 60_000, execSnapshotPath = null, signal = null,
}) {
  return new Promise((resolve, reject) => {
    const abortError = () => {
      // Preserve a caller-supplied authorization error so the supervisor can
      // immediately revoke the managed watcher instead of treating the abort
      // as an ordinary transient failure. AbortController.abort() supplies a
      // standard AbortError when no explicit reason was provided.
      if (signal?.reason instanceof Error) return signal.reason;
      const error = new Error(`sandboxed job (${skillId || 'unknown'}) aborted`);
      error.name = 'AbortError';
      return error;
    };
    if (signal?.aborted) { reject(abortError()); return; }
    if (!sandboxAvailable()) {
      reject(new Error('bubblewrap (bwrap) is not installed — refusing to run a custom skill unsandboxed. Install: sudo apt install bubblewrap'));
      return;
    }
    if (!userId || !skillId) { reject(new Error('runSandboxedJob: userId and skillId required')); return; }
    const { writableDirs, roDirs, skillDir, execPath } = customSkillBindings(userId, skillId);
    if (!fs.existsSync(execPath)) { reject(new Error(`custom skill execute.mjs not found: ${execPath}`)); return; }
    let reviewedSnapshotPath = null;
    let reviewedSnapshotRoot = null;
    if (execSnapshotPath) {
      const inspected = inspectSkillCodeSnapshotPath(skillDir, execSnapshotPath);
      reviewedSnapshotPath = inspected?.execPath || null;
      reviewedSnapshotRoot = inspected?.snapshotRoot || null;
      if (!reviewedSnapshotPath || !reviewedSnapshotRoot) {
        reject(new Error('reviewed executor snapshot is invalid or outside the owning skill directory'));
        return;
      }
    }

    // Approved snapshots also use Node's capability gate. Bubblewrap remains
    // the filesystem/network boundary; this independently denies subprocesses,
    // workers, native addons/WASI, and string-to-code generation. Read/write
    // stays governed by the much narrower mounts already assembled below.
    const nodeArgs = reviewedSnapshotRoot
      ? ['--permission', '--allow-fs-read=*', '--allow-fs-write=*',
        '--disallow-code-generation-from-strings', HOST_SCRIPT]
      : [HOST_SCRIPT];
    // env deliberately empty — no provider keys / secrets via env into the jail.
    const bwrapArgs = buildSandboxArgs(process.execPath, nodeArgs, {
      writableDirs,
      roDirs: reviewedSnapshotRoot
        ? roDirs.filter(dir => path.resolve(dir) !== path.resolve(skillDir))
        : roDirs,
      ...(reviewedSnapshotRoot ? {
        roDirBinds: [{ source: reviewedSnapshotRoot, target: skillDir }],
      } : {}),
      net,
      env: {},
    });
    let child;
    // A separate process group lets cancellation kill bwrap and every process
    // it launched. Killing only the immediate child could leave an orphaned
    // jailed Node process continuing direct network activity after Stop/Undo.
    const detached = process.platform !== 'win32';
    try { child = spawn(BWRAP_BIN, bwrapArgs, { stdio: ['pipe', 'pipe', 'pipe'], detached }); }
    catch (e) { reject(e); return; }

    let err = '', outBuf = '', settled = false, timedOut = false, aborted = false;
    const killProcessGroup = () => {
      if (detached && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch {}
      }
      try { child.kill('SIGKILL'); } catch {}
    };
    const timer = setTimeout(() => { timedOut = true; killProcessGroup(); }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killProcessGroup();
      done(reject, abortError());
    };
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      killProcessGroup();
      fn(v);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Close the tiny race between the pre-spawn check and listener install.
    if (signal?.aborted) { onAbort(); return; }
    const sendToChild = (msg) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch {} };
    // A jail that exits during setup can close stdin before the initial job is
    // flushed. Swallow the stream-level EPIPE here; the child close handler
    // below still returns the actionable bwrap error to the caller.
    child.stdin.on('error', () => {});

    const handleLine = async (line) => {
      if (settled || signal?.aborted) return;
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.t === 'rpc') {
        try {
          const value = await handleRpc(msg.method, msg.args);
          if (!settled && !signal?.aborted) {
            sendToChild({ t: 'rpc-result', id: msg.id, ok: true, value });
          }
        } catch (e) {
          if (!settled && !signal?.aborted) {
            sendToChild({ t: 'rpc-result', id: msg.id, ok: false, error: e?.message || String(e) });
          }
        }
      } else if (msg.t === 'event') {
        if (onEvent) { try { onEvent(msg.event); } catch {} }
      } else if (msg.t === 'result') {
        // `stderr` carries the child's captured console.*/diagnostic output
        // (lib/skill-host.mjs reroutes console.* to stderr so it can't corrupt
        // the NDJSON stdout protocol). Surfaced on BOTH outcomes — previously
        // dropped entirely on success, which is what made a successful-but-
        // wrong run undebuggable (see lib/skill-logger.mjs appendSkillConsoleOutput,
        // which runCustomSkillSandboxed below forwards this into).
        done(resolve, msg.ok
          ? { ok: true, result: msg.result ?? null, stderr: err }
          : { ok: false, error: msg.error || 'skill failed', stderr: err });
      }
    };

    child.stdout.on('data', (d) => {
      outBuf += d;
      let nl;
      while ((nl = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, nl); outBuf = outBuf.slice(nl + 1);
        if (line.trim()) handleLine(line);
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done(reject, e));
    child.on('close', (code) => {
      if (aborted) {
        done(reject, abortError());
        return;
      }
      if (timedOut) {
        const e = /** @type {Error & {stderr?: string}} */ (new Error(`sandboxed job (${skillId}) timed out after ${timeoutMs}ms`));
        e.stderr = err;
        done(reject, e);
        return;
      }
      const e = /** @type {Error & {stderr?: string}} */ (new Error(`sandboxed job (${skillId}) exited (${code}) without a result. stderr: ${err.slice(0, 800)}`));
      e.stderr = err;
      done(reject, e);
    });

    // A reviewed snapshot is always imported at the canonical destination;
    // callers cannot smuggle an alternate payload path around the overlay.
    sendToChild(reviewedSnapshotPath
      ? { ...jobPayload, skillExecPath: execPath, immutableSnapshot: true }
      : jobPayload);
  });
}

/**
 * Run one TOOL call of a custom skill in the sandbox. ctx.* is brokered by the
 * allowlist (skill-ctx-broker.mjs) with the enforced userId/skillId; streamed
 * yields + brokered logs are collected (and forwarded via onEvent if given).
 * @param {{ userId: string, agentId?: string|null, skillId: string, toolName: string,
 *           args?: any, net?: boolean, timeoutMs?: number, onEvent?: (ev:any)=>void,
 *           execSnapshotPath?: string|null }} job
 * @returns {Promise<{ ok: true, result: any, events: any[], audit: any[], stderr: string }
 *                  | { ok: false, error: string, events: any[], audit: any[], stderr: string }>}
 */
export async function runCustomSkillSandboxed(job) {
  const {
    userId, agentId = null, skillId, toolName, args = {}, net = true,
    timeoutMs = 60_000, onEvent = null, execSnapshotPath = null,
  } = job;
  if (!toolName) throw new Error('runCustomSkillSandboxed: toolName required');
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const audit = [];
  const emit = (ev) => { events.push(ev); if (onEvent) { try { onEvent(ev); } catch {} } };
  const broker = makeCtxBroker({
    userId,
    agentId,
    skillId,
    onEvent: emit,
    audit: (method, summary) => audit.push({ method, ...summary }),
    // Reviewed and user-approved snapshots pin JavaScript bytes but do not pin
    // a live skill bin/ tree. Deny runtime RPCs so immutable code cannot invoke
    // an existing mutable binary outside its approved identity.
    allowRuntime: !execSnapshotPath,
  });
  const { execPath } = customSkillBindings(userId, skillId);
  const jobPayload = { t: 'job', mode: 'tool', skillExecPath: execPath, toolName, args, userId, agentId };
  try {
    const r = await runSandboxedJob({
      userId, skillId, jobPayload, handleRpc: broker.handle, onEvent: emit,
      net, timeoutMs, execSnapshotPath,
    });
    const stderr = /** @type {any} */ (r).stderr || '';
    if (r.ok) {
      // Stderr durability: forward the jail's captured console output into the
      // skill's durable per-skill log on a SUCCESSFUL run, so a run that
      // returned fine but did the wrong thing is still debuggable via
      // skill_read_logs. Best-effort — never lets logging break the tool call.
      if (stderr.trim()) {
        try {
          const { appendSkillConsoleOutput } = await import('./skill-logger.mjs');
          await appendSkillConsoleOutput({ userId, skillId, agentId, text: stderr });
        } catch { /* logging must never break a tool call */ }
      }
      return { ok: true, result: r.result, events, audit, stderr };
    }
    return { ok: false, error: /** @type {any} */ (r).error, events, audit, stderr };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), events, audit, stderr: e?.stderr || '' };
  }
}

/**
 * Invoke a named, read-only custom-skill export inside the jail. Alias
 * catalogs use this for `catalog_source.type='exported_function'`; importing
 * the module in the OE parent would execute user-authored top-level code with
 * the server's filesystem and environment privileges.
 */
export async function runCustomSkillExportedFunctionSandboxed({
  userId, skillId, functionName, net = false, timeoutMs = 30_000,
}) {
  if (!/^[A-Za-z_$][\w$]*$/.test(String(functionName || ''))) {
    throw new Error('invalid exported function name');
  }
  const { execPath } = customSkillBindings(userId, skillId);
  const jobPayload = {
    t: 'job', mode: 'exported_function', skillExecPath: execPath,
    functionName, userId, agentId: null,
  };
  const r = await runSandboxedJob({
    userId,
    skillId,
    jobPayload,
    handleRpc: async (method) => { throw new Error(`alias catalog rpc not allowed: ${method}`); },
    net,
    timeoutMs,
  });
  if (!r.ok) throw new Error(/** @type {any} */ (r).error || `custom skill export ${functionName} failed`);
  return r.result;
}
