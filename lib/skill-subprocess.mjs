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

/**
 * Compute the bwrap bind sets + key paths for one (user, skill). Ensures every
 * writable source exists on the host first — bwrap --bind requires the source to
 * exist, and getUserFilesDir already mkdirs the data kinds.
 * @param {string} userId
 * @param {string} skillId
 */
export function customSkillBindings(userId, skillId) {
  const writableDirs = CUSTOM_SKILL_WRITABLE_KINDS.map((k) => getUserFilesDir(userId, k));
  const skillDir = path.join(userSkillsDir(userId), skillId);
  const stateDir = path.join(skillDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  writableDirs.push(stateDir);
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
  return { writableDirs, roDirs, skillDir, stateDir, execPath: path.join(skillDir, 'execute.mjs') };
}

/**
 * Generic jail runner: spawn the host, ship `jobPayload`, service the child's
 * ctx/helper RPCs via `handleRpc`, forward streamed events to `onEvent`, and
 * resolve with the final result. Callers own what the RPC surface means.
 * @param {{ userId: string, skillId: string, jobPayload: any,
 *           handleRpc: (method: string, args: any[]) => Promise<any>,
 *           onEvent?: ((ev:any)=>void)|null, net?: boolean, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: true, result: any } | { ok: false, error: string }>}
 */
export function runSandboxedJob({ userId, skillId, jobPayload, handleRpc, onEvent = null, net = true, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    if (!sandboxAvailable()) {
      reject(new Error('bubblewrap (bwrap) is not installed — refusing to run a custom skill unsandboxed. Install: sudo apt install bubblewrap'));
      return;
    }
    if (!userId || !skillId) { reject(new Error('runSandboxedJob: userId and skillId required')); return; }
    const { writableDirs, roDirs, execPath } = customSkillBindings(userId, skillId);
    if (!fs.existsSync(execPath)) { reject(new Error(`custom skill execute.mjs not found: ${execPath}`)); return; }

    // env deliberately empty — no provider keys / secrets via env into the jail.
    const bwrapArgs = buildSandboxArgs(process.execPath, [HOST_SCRIPT], { writableDirs, roDirs, net, env: {} });
    let child;
    try { child = spawn(BWRAP_BIN, bwrapArgs, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { reject(e); return; }

    let err = '', outBuf = '', settled = false, killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} fn(v); };
    const sendToChild = (msg) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch {} };

    const handleLine = async (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.t === 'rpc') {
        try { sendToChild({ t: 'rpc-result', id: msg.id, ok: true, value: await handleRpc(msg.method, msg.args) }); }
        catch (e) { sendToChild({ t: 'rpc-result', id: msg.id, ok: false, error: e?.message || String(e) }); }
      } else if (msg.t === 'event') {
        if (onEvent) { try { onEvent(msg.event); } catch {} }
      } else if (msg.t === 'result') {
        done(resolve, msg.ok ? { ok: true, result: msg.result ?? null } : { ok: false, error: msg.error || 'skill failed' });
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
      if (killed) { done(reject, new Error(`sandboxed job (${skillId}) timed out after ${timeoutMs}ms`)); return; }
      done(reject, new Error(`sandboxed job (${skillId}) exited (${code}) without a result. stderr: ${err.slice(0, 800)}`));
    });

    sendToChild(jobPayload);
  });
}

/**
 * Run one TOOL call of a custom skill in the sandbox. ctx.* is brokered by the
 * allowlist (skill-ctx-broker.mjs) with the enforced userId/skillId; streamed
 * yields + brokered logs are collected (and forwarded via onEvent if given).
 * @param {{ userId: string, agentId?: string|null, skillId: string, toolName: string,
 *           args?: any, net?: boolean, timeoutMs?: number, onEvent?: (ev:any)=>void }} job
 * @returns {Promise<{ ok: true, result: any, events: any[], audit: any[] }
 *                  | { ok: false, error: string, events: any[], audit: any[] }>}
 */
export async function runCustomSkillSandboxed(job) {
  const { userId, agentId = null, skillId, toolName, args = {}, net = true, timeoutMs = 60_000, onEvent = null } = job;
  if (!toolName) throw new Error('runCustomSkillSandboxed: toolName required');
  /** @type {any[]} */ const events = [];
  /** @type {any[]} */ const audit = [];
  const emit = (ev) => { events.push(ev); if (onEvent) { try { onEvent(ev); } catch {} } };
  const broker = makeCtxBroker({ userId, agentId, skillId, onEvent: emit, audit: (method, summary) => audit.push({ method, ...summary }) });
  const { execPath } = customSkillBindings(userId, skillId);
  const jobPayload = { t: 'job', mode: 'tool', skillExecPath: execPath, toolName, args, userId, agentId };
  try {
    const r = await runSandboxedJob({ userId, skillId, jobPayload, handleRpc: broker.handle, onEvent: emit, net, timeoutMs });
    return r.ok ? { ok: true, result: r.result, events, audit } : { ok: false, error: /** @type {any} */ (r).error, events, audit };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), events, audit };
  }
}
