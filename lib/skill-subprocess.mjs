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
 * Fail-closed: if bwrap is unavailable we refuse to run a custom skill rather
 * than fall back to the in-process path — an un-sandboxed custom skill is the
 * exact thing this module exists to prevent.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { BWRAP_BIN, buildSandboxArgs, sandboxAvailable } from './skill-sandbox.mjs';
import { BASE_DIR, USERS_DIR, getUserFilesDir, userSkillsDir } from './paths.mjs';

const HOST_SCRIPT = path.join(BASE_DIR, 'lib', 'skill-host.mjs');

// Custom skills may write only to these output kinds (research/code are
// reserved for trusted tooling and stay unmounted). Matches the blueprint
// contract custom skills are authored against.
export const CUSTOM_SKILL_WRITABLE_KINDS = ['documents', 'images', 'videos', 'audio'];

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
    path.join(BASE_DIR, 'lib'),
    path.join(BASE_DIR, 'node_modules'),
    path.join(BASE_DIR, 'memory'),
    skillDir,
  ];
  return { writableDirs, roDirs, skillDir, stateDir, execPath: path.join(skillDir, 'execute.mjs') };
}

/**
 * Run one tool call of a custom skill in the sandbox.
 * @param {{ userId: string, agentId?: string|null, skillId: string, toolName: string,
 *           args?: any, net?: boolean, timeoutMs?: number }} job
 * @returns {Promise<{ ok: true, result?: any, stream?: any[] } | { ok: false, error: string }>}
 */
export function runCustomSkillSandboxed(job) {
  const { userId, agentId = null, skillId, toolName, args = {}, net = true, timeoutMs = 60_000 } = job;
  return new Promise((resolve, reject) => {
    if (!sandboxAvailable()) {
      reject(new Error('bubblewrap (bwrap) is not installed — refusing to run a custom skill unsandboxed. Install: sudo apt install bubblewrap'));
      return;
    }
    if (!userId || !skillId || !toolName) { reject(new Error('runCustomSkillSandboxed: userId, skillId, toolName required')); return; }

    const { writableDirs, roDirs, execPath } = customSkillBindings(userId, skillId);
    if (!fs.existsSync(execPath)) { reject(new Error(`custom skill execute.mjs not found: ${execPath}`)); return; }

    const payload = JSON.stringify({ skillExecPath: execPath, toolName, args, userId, agentId });
    // env is deliberately empty — no provider keys, no secrets leak via env into
    // the jail (buildSandboxArgs only sets PATH/LANG/HOME otherwise).
    const bwrapArgs = buildSandboxArgs(process.execPath, [HOST_SCRIPT], { writableDirs, roDirs, net, env: {} });

    let child;
    try {
      child = spawn(BWRAP_BIN, bwrapArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }

    let out = '', err = '', settled = false, killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done(reject, e));
    child.on('close', (code) => {
      if (killed) { done(reject, new Error(`custom skill '${skillId}.${toolName}' timed out after ${timeoutMs}ms`)); return; }
      let parsed;
      try { parsed = JSON.parse(out); }
      catch {
        done(reject, new Error(`custom skill '${skillId}.${toolName}' produced no valid result (exit ${code}). stderr: ${err.slice(0, 800)}`));
        return;
      }
      done(resolve, parsed);
    });

    try { child.stdin.write(payload); child.stdin.end(); }
    catch (e) { done(reject, e); }
  });
}
