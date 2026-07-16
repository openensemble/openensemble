// @ts-check
/**
 * Sandboxed runner for copied first-party CUSTOM skills. Trusted global skills
 * keep running in-process; this is for `users/<uid>/skills/*`, where a separate
 * runtime keeps lab execution and files isolated. It runs execute.mjs in a jail (via
 * lib/skill-host.mjs) where the only mounted user data is the OWNER's media/doc
 * folders + the skill's own state dir.
 *
 * Binding policy (the security boundary):
 *   writable : users/<uid>/{documents,images,videos,audio} + users/<uid>/skills/<id>/state
 *   readonly : <repo>/lib, <repo>/node_modules, <repo>/memory, the skill's own dir
 *   NOT bound: config.json, users/_system (master key), this user's token files,
 *              and every OTHER user's directory → those paths simply don't exist
 *              inside the jail, so accidental cross-profile reads get ENOENT.
 *
 * Two entry points share one jail + one NDJSON RPC loop (runSandboxedJob):
 *   - runCustomSkillSandboxed  → a tool call, ctx.* brokered by skill-ctx-broker
 *   - watcher firing           → scheduler/watchers.mjs passes its own handleRpc
 *
 * If bwrap is unavailable, execution stops rather than silently leaving the
 * lab's separate custom-skill runtime boundary.
 */
import { spawn } from 'child_process';
import { createConnection } from 'net';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { BWRAP_BIN, buildSandboxArgs, sandboxAvailable } from './skill-sandbox.mjs';
import {
  SKILL_SANDBOX_MAX_FRAME_BYTES,
  SKILL_SANDBOX_PROTOCOL_VERSION,
  attachSandboxWireReader,
  createSandboxWireWriter,
  isSafeSandboxPathSegment,
} from './skill-sandbox-wire.mjs';
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
export const SKILL_SANDBOX_SOCKET_ENV = 'OE_SKILL_SANDBOX_SOCKET';

// Custom skills may write only to these output kinds (research/code are
// reserved for trusted tooling and stay unmounted). Matches the blueprint
// contract custom skills are authored against.
export const CUSTOM_SKILL_WRITABLE_KINDS = ['documents', 'images', 'videos', 'audio', 'research'];

function createPlainFrameSender(stream, onError) {
  let tail = Promise.resolve();
  let closed = false;
  return {
    send(message) {
      if (closed) return;
      let frame;
      try { frame = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'); }
      catch (error) { onError(error); return; }
      if (frame.length > SKILL_SANDBOX_MAX_FRAME_BYTES) {
        onError(new Error(
          `skill sandbox protocol frame exceeds ${SKILL_SANDBOX_MAX_FRAME_BYTES} bytes`,
        ));
        return;
      }
      const operation = tail.then(() => new Promise((resolve, reject) => {
        try { stream.write(frame, error => error ? reject(error) : resolve(undefined)); }
        catch (error) { reject(error); }
      }));
      tail = operation.catch(() => {});
      operation.catch(onError);
    },
    close() { closed = true; },
  };
}

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
  // Reject traversal-shaped persisted/caller identities before any helper can
  // create output/state directories. The runner repeats this check at its
  // socket boundary, but app-side callers reach this function first.
  if (!isSafeSandboxPathSegment(userId) || !isSafeSandboxPathSegment(skillId)) {
    throw new Error('invalid custom-skill sandbox identity');
  }
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
 *           execSnapshotPath?: string|null, signal?: AbortSignal|null,
 *           procMount?: boolean }} opts
 * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string }>}
 */
export function runSandboxedJobLocal({
  userId, skillId, jobPayload, handleRpc, onEvent = null, net = true,
  timeoutMs = 60_000, execSnapshotPath = null, signal = null, procMount = true,
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

    // Approved snapshots use Node's capability gate in the same process that
    // imports execute.mjs. Bubblewrap remains the filesystem/network boundary.
    const nodeArgs = reviewedSnapshotRoot
      ? [
        '--permission', '--allow-fs-read=*', '--allow-fs-write=*',
        '--disallow-code-generation-from-strings', HOST_SCRIPT,
      ]
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
      procMount,
    });
    let child;
    // A separate process group lets cancellation kill bwrap and every process
    // it launched. Killing only the immediate child could leave an orphaned
    // jailed Node process continuing direct network activity after Stop/Undo.
    const detached = process.platform !== 'win32';
    try { child = spawn(BWRAP_BIN, bwrapArgs, { stdio: ['pipe', 'pipe', 'pipe'], detached }); }
    catch (e) { reject(e); return; }

    let settled = false, timedOut = false, aborted = false;
    const stderrChunks = [];
    const capturedStderr = () => Buffer.concat(stderrChunks).toString('utf8');
    let detachProtocolReader = () => {};
    let inputSender = null;
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
      detachProtocolReader();
      inputSender?.close();
      killProcessGroup();
      fn(v);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // Close the tiny race between the pre-spawn check and listener install.
    if (signal?.aborted) { onAbort(); return; }
    inputSender = createPlainFrameSender(child.stdin, error => done(reject, error));
    const sendToChild = message => inputSender.send(message);
    // A jail that exits during setup can close stdin before the initial job is
    // flushed. Swallow the stream-level EPIPE here; the child close handler
    // below still returns the actionable bwrap error to the caller.
    child.stdin.on('error', () => {});

    const handleMessage = (msg) => {
      if (settled || signal?.aborted) return;
      if (msg.t === 'rpc') {
        Promise.resolve().then(() => handleRpc(msg.method, msg.args)).then(
          value => {
            if (!settled && !signal?.aborted) {
              sendToChild({ t: 'rpc-result', id: msg.id, ok: true, value });
            }
          },
          error => {
            if (!settled && !signal?.aborted) {
              sendToChild({
                t: 'rpc-result', id: msg.id, ok: false,
                error: error?.message || String(error),
              });
            }
          },
        );
      } else if (msg.t === 'event') {
        if (onEvent) { try { onEvent(msg.event); } catch {} }
      } else if (msg.t === 'result') {
        // `stderr` carries the child's captured console.*/diagnostic output
        // (lib/skill-host.mjs reroutes console.* to stderr so it can't corrupt
        // the NDJSON stdout protocol). Surfaced on BOTH outcomes — previously
        // dropped entirely on success, which is what made a successful-but-
        // wrong run undebuggable (see lib/skill-logger.mjs appendSkillConsoleOutput,
        // which runCustomSkillSandboxed below forwards this into).
        const stderr = capturedStderr();
        done(resolve, msg.ok
          ? { ok: true, result: msg.result ?? null, stderr }
          : { ok: false, error: msg.error || 'skill failed', stderr });
      }
    };

    detachProtocolReader = attachSandboxWireReader(child.stdout, {
      onMessage: message => { handleMessage(message); },
      onError: error => done(reject, error),
    });
    child.stderr.on('data', (d) => {
      const bytes = Buffer.isBuffer(d) ? d : Buffer.from(d);
      if (bytes.length) stderrChunks.push(Buffer.from(bytes));
    });
    child.on('error', (e) => done(reject, e));
    child.on('close', (code) => {
      if (aborted) {
        done(reject, abortError());
        return;
      }
      if (timedOut) {
        const e = /** @type {Error & {stderr?: string}} */ (new Error(`sandboxed job (${skillId}) timed out after ${timeoutMs}ms`));
        e.stderr = capturedStderr();
        done(reject, e);
        return;
      }
      const stderr = capturedStderr();
      const e = /** @type {Error & {stderr?: string}} */ (new Error(`sandboxed job (${skillId}) exited (${code}) without a result. stderr: ${stderr.slice(0, 800)}`));
      e.stderr = stderr;
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
 * Refuse a missing, shared, foreign-owned, or symlinked runner endpoint. The
 * launcher mounts the containing volume only into OE and the runner, and the
 * runner creates this socket mode 0600 as the same uid as OE.
 * @param {string} candidate
 */
export function validateSandboxRunnerSocket(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error(`${SKILL_SANDBOX_SOCKET_ENV} must be an absolute Unix socket path`);
  }
  const resolved = path.resolve(candidate);
  const parent = path.dirname(resolved);
  let parentStat;
  try { parentStat = fs.lstatSync(parent); }
  catch { throw new Error('custom-skill sandbox runner directory is missing'); }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) {
    throw new Error('custom-skill sandbox runner directory must be a real directory');
  }
  let stat;
  try { stat = fs.lstatSync(resolved); }
  catch { throw new Error('custom-skill sandbox runner socket is unavailable'); }
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    throw new Error('custom-skill sandbox runner endpoint is not a Unix socket');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid != null && stat.uid !== uid) {
    throw new Error('custom-skill sandbox runner socket has an unexpected owner');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('custom-skill sandbox runner socket permissions are too broad');
  }
  return resolved;
}

function sandboxAbortError(signal, skillId) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(`sandboxed job (${skillId || 'unknown'}) aborted`);
  error.name = 'AbortError';
  return error;
}

/**
 * Execute through the dedicated runner. Only process creation moves across the
 * socket: OE retains the ctx broker and authorizes each RPC under the original
 * user/skill identity. There is deliberately no local fallback after a runner
 * endpoint has been configured.
 *
 * @param {{ userId: string, skillId: string, jobPayload: any,
 *           handleRpc: (method: string, args: any[]) => Promise<any>,
 *           onEvent?: ((ev:any)=>void)|null, net?: boolean, timeoutMs?: number,
 *           execSnapshotPath?: string|null, signal?: AbortSignal|null }} opts
 * @param {string} socketCandidate
 * @returns {Promise<{ ok: true, result: any, stderr?: string } | { ok: false, error: string, stderr?: string }>}
 */
export function runSandboxedJobRemote({
  userId, skillId, jobPayload, handleRpc, onEvent = null, net = true,
  timeoutMs = 60_000, execSnapshotPath = null, signal = null,
}, socketCandidate) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(sandboxAbortError(signal, skillId)); return; }
    if (!userId || !skillId) { reject(new Error('runSandboxedJob: userId and skillId required')); return; }
    let socketPath;
    try { socketPath = validateSandboxRunnerSocket(socketCandidate); }
    catch (error) { reject(error); return; }
    const callerTimeout = Number(timeoutMs);
    if (!Number.isSafeInteger(callerTimeout) || callerTimeout < 1) {
      reject(new Error('custom-skill sandbox runner received an invalid caller timeout'));
      return;
    }

    const socket = createConnection({ path: socketPath });
    let settled = false;
    let detachReader = () => {};
    /** @type {ReturnType<typeof createSandboxWireWriter>|null} */
    let writer = null;
    const seenRpcIds = new Set();
    const timer = setTimeout(() => {
      done(reject, new Error(`custom-skill sandbox runner timed out after ${callerTimeout}ms`));
    }, callerTimeout + 5_000);

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      detachReader();
      writer?.detach();
      try { socket.destroy(); } catch {}
      fn(value);
    };
    const wireWriter = createSandboxWireWriter(socket, { onError: error => done(reject, error) });
    writer = wireWriter;
    const send = (message) => {
      if (settled) return;
      try { wireWriter.send(message); }
      catch (error) { done(reject, error); }
    };
    const onAbort = () => {
      send({ t: 'cancel' });
      done(reject, sandboxAbortError(signal, skillId));
    };

    detachReader = attachSandboxWireReader(socket, {
      onError: (error) => done(reject, error),
      onMessage: (message) => {
        if (settled || !message || typeof message !== 'object') return;
        if (message.t === 'rpc') {
          if (typeof message.id !== 'string' || typeof message.method !== 'string'
            || !Array.isArray(message.args)) {
            done(reject, new Error('custom-skill sandbox runner sent an invalid RPC request'));
            return;
          }
          if (seenRpcIds.has(message.id)) {
            done(reject, new Error('custom-skill sandbox runner repeated an RPC identity'));
            return;
          }
          seenRpcIds.add(message.id);
          Promise.resolve().then(() => handleRpc(message.method, message.args)).then(
            value => send({ t: 'rpc-result', id: message.id, ok: true, value }),
            error => send({
              t: 'rpc-result', id: message.id, ok: false,
              error: error?.message || String(error),
            }),
          );
          return;
        }
        if (message.t === 'event') {
          if (onEvent) {
            try { onEvent(message.event); }
            catch (error) {
              send({ t: 'cancel' });
              done(reject, error instanceof Error ? error : new Error(String(error)));
            }
          }
          return;
        }
        if (message.t === 'result' && typeof message.ok === 'boolean') {
          done(resolve, message.ok
            ? { ok: true, result: message.result ?? null, stderr: String(message.stderr || '') }
            : { ok: false, error: String(message.error || 'skill failed'), stderr: String(message.stderr || '') });
          return;
        }
        done(reject, new Error('custom-skill sandbox runner sent an unexpected message'));
      },
    });

    socket.once('connect', () => {
      send({
        t: 'run', version: SKILL_SANDBOX_PROTOCOL_VERSION,
        requestId: randomUUID(), userId, skillId, jobPayload,
        requestedNet: net === true, timeoutMs: callerTimeout,
        execSnapshotPath,
      });
    });
    socket.once('error', error => done(reject, error));
    socket.once('close', () => {
      if (!settled) done(reject, new Error('custom-skill sandbox runner disconnected without a result'));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/**
 * Select the dedicated runner when configured. Its failure is terminal: falling
 * back to the in-container namespace path would make deployment behavior
 * depend on timing and leave the configured lab isolation topology.
 * @param {Parameters<typeof runSandboxedJobLocal>[0]} opts
 */
export function runSandboxedJob(opts) {
  const socketPath = process.env[SKILL_SANDBOX_SOCKET_ENV];
  if (socketPath) return runSandboxedJobRemote(opts, socketPath);
  return runSandboxedJobLocal(opts);
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
  const emit = (ev) => {
    events.push(ev);
    if (onEvent) { try { onEvent(ev); } catch {} }
  };
  const collectAudit = (method, summary) => {
    audit.push({ method, ...summary });
  };
  const broker = makeCtxBroker({
    userId,
    agentId,
    skillId,
    onEvent: emit,
    audit: collectAudit,
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
  if (!r.ok) {
    throw new Error(/** @type {any} */ (r).error || `custom skill export ${functionName} failed`);
  }
  return r.result;
}
