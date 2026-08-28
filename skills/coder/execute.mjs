/**
 * Coder skill executor.
 * Provides file I/O, shell execution, and project management tools
 * sandboxed to a configurable workspace directory.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmdirSync,
  readdirSync, statSync, appendFileSync, rmSync, realpathSync, openSync, closeSync,
  readSync, writeSync, fstatSync, chmodSync, lstatSync, constants as fsConstants,
} from 'fs';
import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn, execSync } from 'child_process';
import { createHash } from 'crypto';
import { getLanAddress } from '../../discovery.mjs';
import { stableAgentRef } from '../../lib/agent-ref.mjs';
import { withFileLock, withFileLockSync } from '../../lib/file-lock.mjs';
import { atomicWriteSync } from '../../routes/_helpers/io-lock.mjs';

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── Sandbox detection (bubblewrap) ───────────────────────────────────────────
// Shell commands are wrapped in bwrap so the coder process can only see its
// own project directory — it can't read ~/.ssh, the OE config, or other users'
// files. Network is still allowed (needed for npm install / git clone / pip).
const BWRAP_BIN = (() => {
  try {
    const p = execSync('command -v bwrap', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return p || null;
  } catch { return null; }
})();
if (!BWRAP_BIN) {
  console.warn('[coder] bubblewrap (bwrap) not found — coder shell commands will be refused. Install with: sudo apt install bubblewrap');
}

// When Node was installed via nvm (the installer's default), its bin dir is
// outside /usr (e.g. /root/.nvm/versions/node/v22.11.0/bin) and won't be on
// PATH inside the sandbox — every coder shell command then fails with
// `node: command not found`. Bind-mount the node install root (which contains
// both bin/ and lib/ — npm/npx are symlinks into lib/node_modules/, so binding
// only bin/ leaves them dangling) and prepend its bin/ to PATH.
const NODE_BIN_DIR = path.dirname(process.execPath);
const NODE_INSTALL_ROOT = path.dirname(NODE_BIN_DIR);
const NEEDS_NODE_BIND = NODE_BIN_DIR && !NODE_BIN_DIR.startsWith('/usr/') && NODE_BIN_DIR !== '/bin';
const SANDBOX_PATH = NEEDS_NODE_BIND
  ? `${NODE_BIN_DIR}:/usr/local/bin:/usr/bin:/bin`
  : '/usr/local/bin:/usr/bin:/bin';

const PROCESS_TERM_GRACE_MS = 2000;

function cancellationError(signal, fallback = 'Coder operation cancelled.') {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(fallback);
  error.name = 'AbortError';
  return error;
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationError(signal);
}

function validatedSignalPid(value) {
  return Number.isSafeInteger(value) && value > 1 && value <= 2_147_483_647
    ? value
    : null;
}

export function signalProcessTree(child, detached, processSignal) {
  const pid = validatedSignalPid(child?.pid);
  // Never let an ambiguous PID reach process.kill or ChildProcess.kill. In
  // particular, negating 0 or -1 would turn a group signal into kill(0/1).
  if (pid == null) return false;
  if (detached) {
    try { process.kill(-pid, processSignal); return true; } catch {}
  }
  try { return child.kill(processSignal) !== false; } catch {}
  return false;
}

function buildSandboxArgs(projectDir, command) {
  const args = [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/sbin', '/sbin',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
    '--ro-bind-try', '/etc/ssl', '/etc/ssl',
    '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
    '--ro-bind-try', '/etc/pki', '/etc/pki',
    '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf',
    '--ro-bind-try', '/etc/hosts', '/etc/hosts',
    '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
    '--ro-bind-try', '/etc/gai.conf', '/etc/gai.conf',
    '--ro-bind-try', '/etc/passwd', '/etc/passwd',
    '--ro-bind-try', '/etc/group', '/etc/group',
    '--ro-bind-try', '/etc/localtime', '/etc/localtime',
  ];
  if (NEEDS_NODE_BIND) {
    // Bind the install root (bin + lib) so npm/npx symlinks resolve.
    args.push('--ro-bind-try', NODE_INSTALL_ROOT, NODE_INSTALL_ROOT);
  }
  args.push(
    '--bind', projectDir, projectDir,
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--chdir', projectDir,
    '--setenv', 'HOME', projectDir,
    '--setenv', 'PATH', SANDBOX_PATH,
    '--setenv', 'LANG', 'C.UTF-8',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup',
    '--die-with-parent',
    '--new-session',
    '/bin/bash', '-c', command,
  );
  return args;
}

// ── Per-AGENT active project tracking ────────────────────────────────────────
// Keyed by (user, agent) rather than by user alone: a household can run several
// coder agents (a front-end one and a back-end one), and a single user-wide
// pointer meant whichever agent switched last silently owned every subsequent
// file write. Ephemeral delegation sessions collapse onto the agent they were
// spawned for (see lib/agent-ref.mjs), so a Coordinator delegation to coder1
// lands in coder1's project, not in a blank one.
const _activeProject = new Map();
const _pointerUpdatedAt = new Map();
// Retained for migration/UI context. Cross-agent deploy selection does not use
// this value: it now resolves an explicit source or fails closed on ambiguity.
const _lastActiveProject = new Map();

function projectKey(userId, agentId) {
  const ref = agentId ? stableAgentRef(userId, agentId) : '__user__';
  return `${userId}\u0000${ref}`;
}

// ── Pointer persistence ──────────────────────────────────────────────────────
// The pointers used to live only in memory, so every server restart left every
// coder agent with "No active project" until it switched again — mid-task, with
// no indication why. They are cheap, per-user, and rewritten only when an agent
// creates/switches/deletes, so persist them.
function _pointerPath(userId) {
  return path.join(BASE_DIR, 'users', _safeUserId(userId), 'coder-active-projects.json');
}

function _pointerLockPath(userId) {
  return `${_pointerPath(userId)}.lock`;
}

function _clearPointerCacheForUser(userId) {
  const prefix = `${userId}\u0000`;
  for (const key of _activeProject.keys()) {
    if (key.startsWith(prefix)) _activeProject.delete(key);
  }
  for (const key of _pointerUpdatedAt.keys()) {
    if (key.startsWith(prefix)) _pointerUpdatedAt.delete(key);
  }
  _lastActiveProject.delete(userId);
}

// Always reload the tiny pointer document. This avoids a second OE process
// overwriting another agent's newer pointer with a stale in-memory snapshot.
function _loadPointersFresh(userId) {
  _clearPointerCacheForUser(userId);
  try {
    const raw = JSON.parse(readFileSync(_pointerPath(userId), 'utf8'));
    for (const [ref, project] of Object.entries(raw?.agents ?? {})) {
      if (typeof project !== 'string') continue;
      try { validateProjectName(project); } catch { continue; }
      const key = `${userId}\u0000${ref}`;
      _activeProject.set(key, project);
      const at = Number(raw?.updatedAt?.[ref]);
      _pointerUpdatedAt.set(key, Number.isFinite(at) && at >= 0 ? at : 0);
    }
    if (typeof raw?.last === 'string') _lastActiveProject.set(userId, raw.last);
  } catch { /* absent or corrupt — start empty, same as a cold process */ }
}

function _savePointersUnlocked(userId) {
  const prefix = `${userId}\u0000`;
  const agents = {};
  const updatedAt = {};
  for (const [key, project] of _activeProject) {
    if (!key.startsWith(prefix)) continue;
    const ref = key.slice(prefix.length);
    agents[ref] = project;
    updatedAt[ref] = _pointerUpdatedAt.get(key) ?? 0;
  }
  const p = _pointerPath(userId);
  mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify({
    version: 2,
    agents,
    updatedAt,
    last: _lastActiveProject.get(userId) ?? null,
  }, null, 2));
}

function _validPointerProject(userId, project) {
  try {
    validateProjectName(project);
    const dir = path.join(getDefaultWorkspace(userId), project);
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch { return false; }
}

function _recomputeLastPointerUnlocked(userId) {
  const prefix = `${userId}\u0000`;
  const candidates = [];
  for (const [key, project] of _activeProject) {
    if (!key.startsWith(prefix) || !_validPointerProject(userId, project)) continue;
    candidates.push({
      ref: key.slice(prefix.length),
      project,
      updatedAt: _pointerUpdatedAt.get(key) ?? 0,
    });
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt
    || a.ref.localeCompare(b.ref)
    || a.project.localeCompare(b.project));
  if (candidates.length) _lastActiveProject.set(userId, candidates[0].project);
  else _lastActiveProject.delete(userId);
}

function getPointer(userId, agentId) {
  _loadPointersFresh(userId);
  return _activeProject.get(projectKey(userId, agentId)) ?? null;
}

function setPointer(userId, agentId, name) {
  validateProjectName(name);
  return withFileLockSync(_pointerLockPath(userId), () => {
    _loadPointersFresh(userId);
    const key = projectKey(userId, agentId);
    const latest = Math.max(0, ...[..._pointerUpdatedAt.entries()]
      .filter(([candidate]) => candidate.startsWith(`${userId}\u0000`))
      .map(([, at]) => Number(at) || 0));
    _activeProject.set(key, name);
    _pointerUpdatedAt.set(key, Math.max(Date.now(), latest + 1));
    _lastActiveProject.set(userId, name);
    _savePointersUnlocked(userId);
  });
}

// A deleted project clears it for EVERY agent pointing at it, not just the
// caller — the directory is gone for all of them.
function clearPointersForProject(userId, name) {
  return withFileLockSync(_pointerLockPath(userId), () => {
    _loadPointersFresh(userId);
    const prefix = `${userId}\u0000`;
    for (const [key, project] of _activeProject) {
      if (project !== name || !key.startsWith(prefix)) continue;
      _activeProject.delete(key);
      _pointerUpdatedAt.delete(key);
    }
    _recomputeLastPointerUnlocked(userId);
    _savePointersUnlocked(userId);
  });
}

/** Remove durable per-agent coder state after an agent is deleted. */
export function clearActiveProjectForAgent(userId, agentId) {
  if (!userId || !agentId) return false;
  return withFileLockSync(_pointerLockPath(userId), () => {
    _loadPointersFresh(userId);
    const key = projectKey(userId, agentId);
    const removed = _activeProject.delete(key);
    _pointerUpdatedAt.delete(key);
    if (removed) {
      _recomputeLastPointerUnlocked(userId);
      _savePointersUnlocked(userId);
    }
    return removed;
  });
}

// ── Dangerous command patterns ───────────────────────────────────────────────
const BLOCKED_COMMANDS = [
  /\brm\s+.*-\w*r\w*.*\//,                                    // rm with -r targeting any absolute path
  /\brm\s+-\w*f\w*\s+\//,                                     // rm -f targeting root paths
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /:\s*\(\)\s*\{/,                                             // fork bomb
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsystemctl\s+(start|stop|restart|disable|enable|mask)\b/,
  /\bsudo\b/,
  /\bsu\s+-?\s*\w/,                                            // su to another user
  /\bcurl\b.*\|\s*(ba)?sh/,                                    // curl | bash
  /\bwget\b.*\|\s*(ba)?sh/,                                    // wget | bash
  /\bcurl\b.*\|\s*python/,                                     // curl | python
  /\bchmod\s+(-\w+\s+)*[0-7]*7[0-7]*\s+\//,                  // chmod 777 on system paths
  /\bchown\s+.*\s+\//,                                         // chown on system paths
  /\bnc\s+(-\w+\s+)*-[el]/,                                   // netcat listeners (reverse shells)
  /\beval\s*\$\(/,                                             // eval $(...)  obfuscation
  /\bbase64\s+-d\b.*\|\s*(ba)?sh/,                             // base64 -d | bash
  />\s*\/etc\//,                                               // redirect to /etc/
  />\s*\/boot\//,                                              // redirect to /boot/
];

const BLOCKED_PATHS = ['/boot', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
                       '/proc', '/sys', '/dev', '/var/run', '/run'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function _safeUserId(userId) {
  if (!userId) throw new Error('userId is required for workspace resolution.');
  return userId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function getDefaultWorkspace(userId) {
  return path.join(BASE_DIR, 'users', _safeUserId(userId), 'documents', 'code');
}

function getWorkspace(userId) {
  const resolved = getDefaultWorkspace(userId);
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true });
  return resolved;
}

function getProjectContext(userId, agentId) {
  const project = getPointer(userId, agentId);
  if (!project) throw new Error('No active project. Use coder_create_project or coder_switch_project first.');
  try {
    const { workspace, dir, identity } = resolveUserProjectDir(userId, project);
    return { project, workspace, dir, identity };
  } catch {
    throw new Error(`Project "${project}" not found in workspace. Switch to an existing project first.`);
  }
}

function getProjectDir(userId, agentId) {
  return getProjectContext(userId, agentId).dir;
}

function safePath(base, userPath) {
  if (!userPath) throw new Error('Path is required.');
  const resolved = path.resolve(base, userPath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Path "${userPath}" is outside the allowed directory.`);
  }
  // Symlink-escape guard: the lexical check above is fooled by a project-local
  // symlink pointing outside the workspace — readFile/writeFile/unlink would
  // follow it out of the sandbox. Walk up to the deepest EXISTING component,
  // resolve symlinks, and require the real location to stay under the real base
  // before any I/O. (Don't blanket-reject symlinks — that'd break node_modules.)
  const realBase = realpathSync(base);
  let probe = resolved;
  while (probe !== base && !existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (existsSync(probe)) {
    const real = realpathSync(probe);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) {
      throw new Error(`Path "${userPath}" resolves outside the allowed directory (symlink).`);
    }
  }
  return resolved;
}

export function validateProjectName(name) {
  if (!name || typeof name !== 'string') throw new Error('Project name is required.');
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
    throw new Error('Invalid project name. No slashes, "..", or leading dots.');
  }
  if (name.length > 100) throw new Error('Project name too long (max 100 chars).');
}

const PROJECT_LOCK_TIMEOUT_MS = 310_000;
const PROJECT_LOCK_STALE_MS = 10 * 60_000;
const SERVER_CONTROL_LOCK_TIMEOUT_MS = 30_000;

function coderLockPath(userId, name, kind) {
  validateProjectName(name);
  const digest = createHash('sha256').update(name).digest('hex');
  return path.join(BASE_DIR, 'users', _safeUserId(userId), '.coder-locks', `${kind}-${digest}.lock`);
}

function projectMutationLockPath(userId, name) {
  return coderLockPath(userId, name, 'project');
}

function serverControlLockPath(userId, name) {
  return coderLockPath(userId, name, 'server');
}

function assertProjectIdentity(userId, name, expectedIdentity) {
  const current = resolveUserProjectDir(userId, name);
  if (current.identity !== expectedIdentity) {
    throw new Error(`Project "${name}" was deleted or replaced while this operation was waiting. Retry against the current project.`);
  }
  return current;
}

/**
 * Exclusive project lock shared by coder mutations and deployment snapshots.
 * The lock lives outside the project so project deletion cannot remove it.
 */
export function withCoderProjectLock(userId, name, fn, opts = {}) {
  const signal = opts.signal ?? null;
  return withFileLock(projectMutationLockPath(userId, name), async () => {
    throwIfCancelled(signal);
    if (opts.expectedIdentity) {
      assertProjectIdentity(userId, name, opts.expectedIdentity);
    }
    return fn();
  }, {
    timeoutMs: opts.timeoutMs ?? PROJECT_LOCK_TIMEOUT_MS,
    staleMs: opts.staleMs ?? PROJECT_LOCK_STALE_MS,
    signal,
  });
}

/**
 * Serialize only persistent-server lifecycle state for a project. This lock is
 * deliberately separate from the broad project mutation lock so status and
 * stop remain available while a build or test command owns the checkout.
 */
export function withCoderServerLock(userId, name, fn, opts = {}) {
  const signal = opts.signal ?? null;
  return withFileLock(serverControlLockPath(userId, name), () => {
    throwIfCancelled(signal);
    return fn();
  }, {
    timeoutMs: opts.timeoutMs ?? SERVER_CONTROL_LOCK_TIMEOUT_MS,
    staleMs: opts.staleMs ?? PROJECT_LOCK_STALE_MS,
    signal,
  });
}

function withProjectContextLock(userId, context, fn, signal = null) {
  return withCoderProjectLock(userId, context.project, fn, {
    expectedIdentity: context.identity,
    signal,
  });
}

function withProjectContextServerLock(userId, context, fn, signal = null) {
  return withCoderServerLock(userId, context.project, () => {
    throwIfCancelled(signal);
    const current = assertProjectIdentity(userId, context.project, context.identity);
    return fn(current.dir);
  }, { signal });
}

// Resolve the absolute directory for a user's project, with ownership +
// path-traversal guards so HTTP routes can safely expose it. Throws on invalid
// name or missing directory; the caller decides how to surface the error.
export function resolveUserProjectDir(userId, name) {
  validateProjectName(name);
  const ws = getWorkspace(userId);
  const dir = path.join(ws, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Project "${name}" not found.`);
  }
  // Defense-in-depth: resolve the real paths and require the project dir to
  // stay inside the workspace even if someone slipped a symlink in.
  const realWs = realpathSync(ws);
  const realDir = realpathSync(dir);
  if (realDir !== realWs && !realDir.startsWith(realWs + path.sep)) {
    throw new Error('Project path escapes workspace.');
  }
  const projectStat = statSync(realDir);
  const identity = `${projectStat.dev}:${projectStat.ino}:${projectStat.birthtimeMs}`;
  return { workspace: realWs, dir: realDir, identity };
}

function _projectInfo(userId, project, selection, selectionNotice, extra = {}) {
  try {
    const { workspace, dir, identity } = resolveUserProjectDir(userId, project);
    return {
      ok: true,
      info: {
        project,
        workspace,
        dir,
        identity,
        selection,
        fallback: selection === 'single-project-fallback',
        selectionNotice,
        ...extra,
      },
    };
  } catch (e) {
    return { ok: false, reason: 'not_found', message: e.message, projects: [] };
  }
}

/**
 * Resolve a project for a cross-skill operation such as node_push_project.
 * Never guesses between agents: an unpointed caller receives a compatibility
 * fallback only when all valid pointers collapse to one distinct project.
 */
export function resolveActiveProjectInfo(userId, {
  agentId = null,
  project = null,
  sourceAgentId = null,
  allowSingleFallback = true,
} = {}) {
  try {
    if (project != null && sourceAgentId != null) {
      return {
        ok: false,
        reason: 'invalid_selection',
        projects: [],
        message: 'Specify either project or source_agent_id, not both.',
      };
    }

    if (project != null) {
      validateProjectName(project);
      return _projectInfo(
        userId,
        project,
        'explicit-project',
        `explicit project "${project}"`,
      );
    }

    _loadPointersFresh(userId);
    const prefix = `${userId}\u0000`;
    if (sourceAgentId != null) {
      const sourceRef = stableAgentRef(userId, sourceAgentId);
      if (!sourceRef) {
        return { ok: false, reason: 'invalid_selection', projects: [], message: 'source_agent_id is empty.' };
      }
      const selected = _activeProject.get(`${prefix}${sourceRef}`);
      if (!selected) {
        return {
          ok: false,
          reason: 'no_pointer',
          projects: [],
          message: `Agent "${sourceRef}" has no active coder project. Switch that agent to a project or specify project explicitly.`,
        };
      }
      const result = _projectInfo(
        userId,
        selected,
        'explicit-agent',
        `active project of agent "${sourceRef}"`,
        { sourceAgentRef: sourceRef },
      );
      if (!result.ok) {
        result.message = `Agent "${sourceRef}" points to missing project "${selected}". Switch it to an existing project first.`;
      }
      return result;
    }

    const callerKey = projectKey(userId, agentId);
    const callerRef = callerKey.slice(prefix.length);
    const callerProject = _activeProject.get(callerKey);
    if (callerProject) {
      const result = _projectInfo(
        userId,
        callerProject,
        'caller',
        `calling agent "${callerRef}"`,
        { sourceAgentRef: callerRef },
      );
      if (!result.ok) {
        result.message = `Your active coder project "${callerProject}" no longer exists. Switch to an existing project before deploying.`;
      }
      return result;
    }

    const candidates = new Map();
    for (const [key, candidateProject] of _activeProject) {
      if (!key.startsWith(prefix) || !_validPointerProject(userId, candidateProject)) continue;
      const ref = key.slice(prefix.length);
      if (!candidates.has(candidateProject)) candidates.set(candidateProject, []);
      candidates.get(candidateProject).push(ref);
    }
    const projects = [...candidates.keys()].sort((a, b) => a.localeCompare(b));
    if (allowSingleFallback && projects.length === 1) {
      const selected = projects[0];
      const refs = candidates.get(selected).sort((a, b) => a.localeCompare(b));
      return _projectInfo(
        userId,
        selected,
        'single-project-fallback',
        `automatic single-project fallback to "${selected}" (active for ${refs.join(', ')})`,
        { sourceAgentRefs: refs },
      );
    }
    if (projects.length > 1) {
      const details = projects.map(name => `- ${name} (agents: ${candidates.get(name).sort().join(', ')})`).join('\n');
      return {
        ok: false,
        reason: 'ambiguous',
        projects,
        message: `Multiple active coder projects are available; refusing to guess which one to deploy. Specify project or source_agent_id.\n${details}`,
      };
    }
    return {
      ok: false,
      reason: 'none',
      projects: [],
      message: 'No active coder project. Use coder_create_project or coder_switch_project first, then try again.',
    };
  } catch (e) {
    return { ok: false, reason: 'error', projects: [], message: e.message };
  }
}

// Compatibility wrapper for older internal consumers. Ambiguity is represented
// as null instead of reviving the former "most recently selected" guess.
export function getActiveProjectInfo(userId, agentId = null) {
  const result = resolveActiveProjectInfo(userId, { agentId });
  return result.ok ? result.info : null;
}

// List all top-level projects in this user's workspace with cheap metadata
// (file count, total size, mtime). Honors the same skip-segments as the
// client-side mirror so node_modules / .venv don't inflate the sizes we
// advertise in the Code Projects pane.
//
// Async + memoized (30s TTL per project): the walk used to stat every file
// of every project synchronously on the event loop per GET — a few large
// repos froze the whole server for the duration. The totals feed a UI pane,
// so ≤30s staleness is fine.
const PROJECT_META_TTL_MS = 30_000;
const _projectMetaCache = new Map(); // dir -> { at, meta }
export async function listUserProjects(userId) {
  const ws = getWorkspace(userId);
  const entries = (await readdir(ws, { withFileTypes: true })).filter(e => e.isDirectory());
  const projects = [];
  for (const e of entries) {
    const dir = path.join(ws, e.name);
    const hit = _projectMetaCache.get(dir);
    if (hit && Date.now() - hit.at < PROJECT_META_TTL_MS) {
      projects.push({ name: e.name, ...hit.meta });
      continue;
    }
    let fileCount = 0;
    let totalSize = 0;
    let latestMtime = 0;
    const walk = async (d) => {
      let children;
      try { children = await readdir(d, { withFileTypes: true }); }
      catch { return; }
      for (const c of children) {
        if (WALK_SKIP_SEGMENTS.has(c.name)) continue;
        const abs = path.join(d, c.name);
        if (c.isDirectory()) { await walk(abs); continue; }
        if (!c.isFile()) continue;
        try {
          const st = await stat(abs);
          fileCount += 1;
          totalSize += st.size;
          if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
        } catch {}
      }
    };
    await walk(dir);
    // Fall back to the project dir's own mtime if we found no files (empty project).
    if (latestMtime === 0) {
      try { latestMtime = (await stat(dir)).mtimeMs; } catch {}
    }
    const meta = {
      fileCount,
      size: totalSize,
      mtime: latestMtime ? new Date(latestMtime).toISOString() : null,
    };
    _projectMetaCache.set(dir, { at: Date.now(), meta });
    projects.push({ name: e.name, ...meta });
  }
  return { workspace: ws, projects };
}

// Delete a project — thin wrapper around the existing deleteProject() so HTTP
// routes don't have to reach into the tool dispatch layer.
export async function deleteUserProject(userId, name) {
  return deleteProject(name, userId);
}

const PROJECT_LOG_READ_MAX_BYTES = 256 * 1024;

function openProjectLogNoFollow(projectDir, flags, mode = undefined) {
  let dirFd = null;
  let fileFd = null;
  let transferred = false;
  try {
    // Anchor the lookup to an already-open project directory. O_NOFOLLOW on
    // both components prevents a project-controlled symlink from turning OE's
    // host-side activity log into an arbitrary read or append primitive.
    dirFd = openSync(projectDir,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if (!fstatSync(dirFd).isDirectory()) return null;
    fileFd = openSync(
      `/proc/self/fd/${dirFd}/PROJECT_LOG.md`,
      flags | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      mode,
    );
    const fileStat = fstatSync(fileFd);
    if (!fileStat.isFile()) return null;
    transferred = true;
    return { fd: fileFd, stat: fileStat };
  } catch {
    return null;
  } finally {
    if (dirFd != null) try { closeSync(dirFd); } catch {}
    if (fileFd != null && !transferred) try { closeSync(fileFd); } catch {}
  }
}

function readProjectLog(projectDir, { tail = false } = {}) {
  const opened = openProjectLogNoFollow(projectDir, fsConstants.O_RDONLY);
  if (!opened) return '';
  try {
    if (opened.stat.size <= 0) return '';
    const bytes = Math.min(opened.stat.size, PROJECT_LOG_READ_MAX_BYTES);
    const buffer = Buffer.alloc(bytes);
    const offset = tail ? Math.max(0, opened.stat.size - bytes) : 0;
    const read = readSync(opened.fd, buffer, 0, bytes, offset);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    try { closeSync(opened.fd); } catch {}
  }
}

function appendLog(projectDir, entry) {
  const opened = openProjectLogNoFollow(
    projectDir,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT,
    0o600,
  );
  if (!opened) return false;
  try {
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
    const line = `\n- **${ts}** — ${entry}\n`;
    writeSync(opened.fd, line);
    return true;
  } catch {
    // Activity logging is audit context, not the operation's commit point. A
    // failed append must not turn a completed mutation or server stop into a
    // misleading tool failure.
    return false;
  } finally {
    try { closeSync(opened.fd); } catch {}
  }
}

function appendWorkspaceLog(entry, userId) {
  try {
    const lockPath = path.join(BASE_DIR, 'users', _safeUserId(userId), '.coder-locks', 'workspace-log.lock');
    withFileLockSync(lockPath, () => {
      const ws = getWorkspace(userId);
      const logPath = path.join(ws, 'WORKSPACE_LOG.md');
      const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
      if (!existsSync(logPath)) atomicWriteSync(logPath, '# Workspace Log\n');
      appendFileSync(logPath, `\n- **${ts}** — ${entry}\n`);
    });
  } catch { /* don't fail the operation over logging */ }
}

function fileRevision(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function isCommandBlocked(command) {
  // Normalize: collapse whitespace, strip surrounding quotes for inner check
  const normalized = command.replace(/\s+/g, ' ').trim();
  // Check both original and normalized forms
  for (const form of [command, normalized]) {
    for (const re of BLOCKED_COMMANDS) {
      if (re.test(form)) return true;
    }
    for (const p of BLOCKED_PATHS) {
      // Block commands that explicitly target system paths (rm, mv, cp to/from them)
      const destructive = new RegExp(`\\b(rm|mv|cp|chmod|chown)\\b.*${p.replace('/', '\\/')}(\\/|\\s|$)`);
      if (destructive.test(form)) return true;
    }
  }
  return false;
}

// Directories the project-stat walker skips so size/file-count totals reflect
// source — not node_modules, build output, virtualenvs, or runtime caches.
const WALK_SKIP_SEGMENTS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next',
  'dist', 'build', '.cache', '.turbo', '.parcel-cache', '.pytest_cache',
  '.run', // legacy coder_start_server runtime state — not source
]);

// ── Tool implementations ─────────────────────────────────────────────────────

async function listProjects(userId, agentId) {
  const ws = getWorkspace(userId);
  // Pointers are per-agent now, so an agent has to be able to see whether it
  // holds one at all — otherwise "no active project" errors look arbitrary.
  const active = getPointer(userId, agentId);
  const entries = readdirSync(ws, { withFileTypes: true }).filter(e => e.isDirectory());
  if (!entries.length) return `Workspace: ${ws}\nNo projects yet. Use coder_create_project to create one.`;

  const lines = [];
  for (const e of entries) {
    let summary = '';
    const content = readProjectLog(path.join(ws, e.name));
    if (content) {
      const firstLines = content.split('\n').slice(0, 5).join('\n');
      summary = '\n  ' + firstLines.replace(/\n/g, '\n  ');
    }
    lines.push(`📁 ${e.name}${e.name === active ? '  ← your active project' : ''}${summary}`);
  }
  return `Workspace: ${ws}\n\n` + lines.join('\n\n');
}

async function createProject(name, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  validateProjectName(name);
  return withCoderProjectLock(userId, name, async () => {
    throwIfCancelled(signal);
    const ws = getWorkspace(userId);
    const dir = path.join(ws, name);
    if (existsSync(dir)) throw new Error(`Project "${name}" already exists.`);

    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
    const logContent = `# ${name}\n\nCreated: ${ts}\n`;
    atomicWriteSync(path.join(dir, 'PROJECT_LOG.md'), logContent);
    setPointer(userId, agentId, name);
    appendWorkspaceLog(`Created project "${name}"`, userId);
    return `Created project "${name}" and set it as active.\nWorkspace: ${dir}`;
  }, { signal });
}

async function switchProject(name, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  validateProjectName(name);
  return withCoderProjectLock(userId, name, async () => {
    throwIfCancelled(signal);
    const { dir } = resolveUserProjectDir(userId, name);
    setPointer(userId, agentId, name);
    appendLog(dir, 'Switched to this project');

    // Return recent log entries for context.
    let logTail = '';
    const logContent = readProjectLog(dir, { tail: true });
    if (logContent) {
      const lines = logContent.split('\n');
      logTail = '\n\nRecent activity:\n' + lines.slice(-10).join('\n');
    }

    // Include this durable agent's pending todos first. The unlocked helper is
    // used because this function already holds the project mutation lock.
    const todos = _readTodosUnlocked(dir, userId, agentId, signal);
    const pending = todos.filter(t => t.status !== 'completed');
    const todoBlock = pending.length
      ? '\n\nPending todos (resume from here):\n' + _renderTodos(pending)
      : todos.length
        ? '\n\nAll todos completed.'
        : '';

    return `Switched to project "${name}".${todoBlock}${logTail}`;
  }, { signal });
}

async function deleteProject(name, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  validateProjectName(name);
  return withCoderProjectLock(userId, name, async () => {
    throwIfCancelled(signal);
    const current = resolveUserProjectDir(userId, name);
    const context = { project: name, ...current };
    // Lock order is always project -> server. Stop/status take only the server
    // lock, so they can remain responsive during commands without racing this
    // destructive lifecycle transition.
    return withCoderServerLock(userId, name, async () => {
      throwIfCancelled(signal);
      const runtimePaths = assertServerInactiveForDeletion(userId, context);
      rmSync(context.dir, { recursive: true, force: true });
      rmSync(runtimePaths.dir, { recursive: true, force: true });
      clearPointersForProject(userId, name);
      _projectMetaCache.delete(context.dir);
      appendWorkspaceLog(`Deleted project "${name}"`, userId);
      // Alias cascade-delete: handled by skill-alias-framework via manifest's
      // cascade_on_tools entry on coder_delete_project. No explicit call here.
      return `Deleted project "${name}" and all its contents.`;
    }, { signal });
  }, { signal });
}

async function readProjectFile(filePath, offset, limit, userId, agentId) {
  const dir = getProjectDir(userId, agentId);
  const abs = safePath(dir, filePath);
  if (!existsSync(abs)) throw new Error(`File not found: ${filePath}`);

  const content = await readFile(abs, 'utf8');
  const lines = content.split('\n');
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = start + (limit ?? 2000);
  const slice = lines.slice(start, end);

  const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(5)} │ ${l}`).join('\n');
  return `Revision: ${fileRevision(content)}\n${numbered}`;
}

async function writeProjectFile(filePath, content, expectedRevision, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  if (typeof content !== 'string') throw new Error('content must be a string.');
  const context = getProjectContext(userId, agentId);
  return withProjectContextLock(userId, context, async () => {
    throwIfCancelled(signal);
    const abs = safePath(context.dir, filePath);
    const exists = existsSync(abs);
    const previous = exists ? readFileSync(abs, 'utf8') : null;
    const currentRevision = exists ? fileRevision(previous) : null;
    const expected = typeof expectedRevision === 'string' ? expectedRevision.trim() : null;

    if (!exists && expected) {
      throw new Error(`Revision conflict for ${filePath}: the file no longer exists. Re-read project state before writing.`);
    }
    if (exists && previous !== content) {
      if (!expected) {
        throw new Error(`Refusing to overwrite existing file ${filePath} without expected_revision. Read the file first and pass its Revision value, or use coder_edit_file.`);
      }
      if (expected !== currentRevision) {
        throw new Error(`Revision conflict for ${filePath}: expected ${expected}, current ${currentRevision}. Re-read the file and merge your changes.`);
      }
    }
    if (exists && previous === content) {
      return `No change to ${filePath} (revision ${currentRevision})`;
    }

    mkdirSync(path.dirname(abs), { recursive: true });
    atomicWriteSync(abs, content);
    const revision = fileRevision(content);
    appendLog(context.dir, `Wrote \`${filePath}\` (${content.split('\n').length} lines)`);
    return `Wrote ${filePath} (revision ${revision})`;
  }, signal);
}

async function editProjectFile(filePath, oldStr, newStr, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  const context = getProjectContext(userId, agentId);
  return withProjectContextLock(userId, context, async () => {
    throwIfCancelled(signal);
    const abs = safePath(context.dir, filePath);
    if (!existsSync(abs)) throw new Error(`File not found: ${filePath}`);

    const content = readFileSync(abs, 'utf8');
    const count = content.split(oldStr).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${filePath}.`);
    if (count > 1) throw new Error(`old_string found ${count} times in ${filePath} — must be unique. Provide more context.`);

    const updated = content.replace(oldStr, newStr);
    atomicWriteSync(abs, updated);
    const preview = oldStr.length > 60 ? oldStr.slice(0, 60) + '…' : oldStr;
    appendLog(context.dir, `Edited \`${filePath}\` — replaced "${preview}"`);
    return `Edited ${filePath} (revision ${fileRevision(updated)})`;
  }, signal);
}

async function deleteProjectFile(filePath, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  const context = getProjectContext(userId, agentId);
  return withProjectContextLock(userId, context, async () => {
    throwIfCancelled(signal);
    const abs = safePath(context.dir, filePath);
    if (!existsSync(abs)) throw new Error(`Not found: ${filePath}`);

    const s = statSync(abs);
    if (s.isDirectory()) {
      const entries = readdirSync(abs);
      if (entries.length > 0) throw new Error(`Directory "${filePath}" is not empty. Remove its contents first.`);
      rmdirSync(abs);
      appendLog(context.dir, `Deleted empty directory \`${filePath}\``);
      return `Deleted directory ${filePath}`;
    }
    unlinkSync(abs);
    appendLog(context.dir, `Deleted file \`${filePath}\``);
    return `Deleted ${filePath}`;
  }, signal);
}

// Streaming shell executor: yields `{type:'token'}` chunks live and a final
// `{type:'result'}` event with the full (capped) output for the tool loop.
async function* runCommandUnlocked(command, timeout, dir, signal = null) {
  throwIfCancelled(signal);
  if (isCommandBlocked(command)) {
    yield { type: 'result', text: 'BLOCKED: This command was rejected by safety filters. Dangerous system operations are not allowed.' };
    return;
  }

  const timeoutSec = Math.min(Math.max(timeout ?? 30, 1), 300);
  const timeoutMs = timeoutSec * 1000;
  const CAP = 64 * 1024;

  if (!BWRAP_BIN) {
    yield { type: 'result', text: 'Shell execution unavailable: sandbox (bwrap) not installed on server. Install bubblewrap (e.g. `sudo apt install bubblewrap`) or disable the coder shell tool.' };
    return;
  }
  const detached = process.platform !== 'win32';
  const proc = spawn(BWRAP_BIN, buildSandboxArgs(dir, command), {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    detached,
    ...(signal ? { signal } : {}),
  });

  let full = '';
  let capped = false;
  let totalBytes = 0;
  const append = (chunk) => {
    totalBytes += chunk.length;
    if (capped) return;
    const room = CAP - full.length;
    if (chunk.length <= room) { full += chunk; return; }
    full += chunk.slice(0, room);
    capped = true;
  };

  // Queue of events produced outside of the generator by stream callbacks.
  const queue = [];
  let resolveWait;
  let done = false;
  let exitCode = null;
  let timedOut = false;
  let cancelled = false;
  let errored = null;
  let killTimer = null;

  const wake = () => { if (resolveWait) { resolveWait(); resolveWait = null; } };
  const wait = () => new Promise(r => { resolveWait = r; });
  const terminate = () => {
    if (done) return;
    signalProcessTree(proc, detached, 'SIGTERM');
    if (killTimer) return;
    killTimer = setTimeout(() => {
      if (!done) signalProcessTree(proc, detached, 'SIGKILL');
    }, PROCESS_TERM_GRACE_MS);
  };
  const onAbort = () => {
    cancelled = true;
    if (!done) terminate();
    wake();
  };

  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => { append(chunk); queue.push({ type: 'token', text: chunk }); wake(); });
  proc.stderr.on('data', (chunk) => { append(chunk); queue.push({ type: 'token', text: chunk }); wake(); });
  proc.on('error', (e) => {
    // ChildProcess emits AbortError as soon as its signal fires. Keep waiting
    // for close so the bounded SIGKILL fallback remains armed if TERM is ignored.
    if (signal?.aborted || e?.name === 'AbortError') {
      cancelled = true;
      terminate();
      wake();
      return;
    }
    errored = e;
    done = true;
    wake();
  });
  proc.on('close', (code) => {
    exitCode = code;
    done = true;
    if (killTimer) { clearTimeout(killTimer); killTimer = null; }
    wake();
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  // Close the small race between the pre-spawn check and listener install.
  if (signal?.aborted) onAbort();

  const timer = setTimeout(() => {
    if (done) return;
    timedOut = true;
    terminate();
  }, timeoutMs);

  try {
    while (!done || queue.length > 0) {
      while (queue.length > 0) yield queue.shift();
      if (done) break;
      await wait();
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // iterator.return() is also a cancellation boundary. If the consumer stops
    // reading without an AbortSignal, do not leave the command running unseen.
    if (!done) terminate();
    else if (killTimer) { clearTimeout(killTimer); killTimer = null; }
  }

  if (cancelled) throw cancellationError(signal);

  const finalCode = errored ? 1 : (timedOut ? 124 : (exitCode ?? 0));
  const tail = [
    capped ? `\n… (truncated, ${totalBytes - full.length} more bytes)` : '',
    `\nexit code: ${finalCode}`,
    timedOut ? '\n(killed: timeout exceeded)' : '',
    errored ? `\n(spawn error: ${errored.message})` : '',
  ].filter(Boolean).join('');

  appendLog(dir, `Ran \`${command.length > 80 ? command.slice(0, 80) + '…' : command}\` → exit ${finalCode}`);
  yield { type: 'result', text: (full || '(no output)') + tail };
}

// Hold the project lock for the full lifetime of the child while preserving
// live token streaming to the tool loop. Commands, git, builds, and file tools
// therefore cannot mutate the same checkout concurrently.
async function* runCommand(command, timeout, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  let context;
  try { context = getProjectContext(userId, agentId); }
  catch (e) { yield { type: 'result', text: `Error: ${e.message}` }; return; }

  const queue = [];
  let wakeWaiter = null;
  let producerDone = false;
  let producerError = null;
  const controller = new AbortController();
  const wake = () => { if (wakeWaiter) { wakeWaiter(); wakeWaiter = null; } };
  const wait = () => new Promise(resolve => { wakeWaiter = resolve; });
  const forwardAbort = () => controller.abort(cancellationError(signal));
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();

  const producer = withProjectContextLock(userId, context, async () => {
    throwIfCancelled(controller.signal);
    for await (const event of runCommandUnlocked(command, timeout, context.dir, controller.signal)) {
      queue.push(event);
      wake();
    }
  }, controller.signal).catch(e => {
    producerError = e;
  }).finally(() => {
    producerDone = true;
    wake();
  });

  try {
    while (!producerDone || queue.length) {
      while (queue.length) yield queue.shift();
      if (!producerDone) await wait();
    }
    await producer;
    if (producerError) {
      if (signal?.aborted || producerError?.name === 'AbortError') throw cancellationError(signal);
      yield { type: 'result', text: `Error: ${producerError.message}` };
    }
  } finally {
    signal?.removeEventListener('abort', forwardAbort);
    // A consumer that stops reading is a cancellation boundary.
    if (!producerDone && !controller.signal.aborted) {
      const error = new Error('Coder command stream closed before completion.');
      error.name = 'AbortError';
      controller.abort(error);
    }
  }
}

// ── Long-running processes (dev servers) ─────────────────────────────────────
// coder_run_command's sandbox uses --unshare-pid, so its PID namespace collapses
// when the tool call returns — any backgrounded process dies with it. To run a
// persistent dev server (node/python/whatever), start it in its own long-lived
// bwrap that we detach from OE's event loop. One server per project. PID,
// process-incarnation metadata, and logs live outside the project bind so code
// inside the sandbox can never choose which host process OE will signal.

const SERVER_STATE_VERSION = 3;
const SERVER_STATE_MAX_BYTES = 64 * 1024;
const SERVER_COMMAND_MAX_BYTES = 16 * 1024;
const SERVER_LOG_TAIL_MAX_BYTES = 256 * 1024;
const SERVER_STOP_GRACE_MS = 2_000;
const SERVER_KILL_WAIT_MS = 2_000;
const LINUX_BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getCoderServerRuntimePaths(userId, project) {
  validateProjectName(project);
  const digest = createHash('sha256').update(project).digest('hex');
  const dir = path.join(
    BASE_DIR, 'users', _safeUserId(userId), '.coder-runtime', 'servers', digest,
  );
  return {
    dir,
    statePath: path.join(dir, 'server-state.json'),
    logPath: path.join(dir, 'server.log'),
  };
}

function ensureServerRuntimeDir(paths) {
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dir, 0o700);
}

function legacyServerPaths(projectDir) {
  const dir = path.join(projectDir, '.run');
  return {
    pidPath: path.join(dir, 'server.pid'),
    metaPath: path.join(dir, 'server.meta.json'),
    logPath: path.join(dir, 'server.log'),
  };
}

function legacyServerState(projectDir) {
  const paths = legacyServerPaths(projectDir);
  const hasEntry = value => {
    try { lstatSync(value); return true; } catch { return false; }
  };
  return {
    paths,
    present: hasEntry(paths.pidPath) || hasEntry(paths.metaPath),
  };
}

function legacyServerRefusal(projectDir) {
  const legacy = legacyServerState(projectDir);
  if (!legacy.present) return null;
  return 'Untrusted legacy server state exists in .run. OE did not signal its PID because project files are sandbox-writable. Restart OpenEnsemble to terminate any legacy sandbox, remove the old .run/server.pid and .run/server.meta.json files, then retry.';
}

function strictServerPid(value) {
  return validatedSignalPid(value);
}

function readLinuxBootId() {
  if (process.platform !== 'linux') {
    return { kind: 'unverified', reason: 'Linux boot identity is unavailable.' };
  }
  try {
    const id = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase();
    if (!LINUX_BOOT_ID_RE.test(id)) {
      return { kind: 'unverified', reason: 'Malformed Linux boot identity.' };
    }
    return { kind: 'present', id };
  } catch (e) {
    return { kind: 'unverified', reason: `Could not read Linux boot identity: ${e.message}` };
  }
}

function readLinuxProcessStartTicks(pid) {
  if (process.platform !== 'linux' || strictServerPid(pid) == null) {
    return { kind: 'unverified', reason: 'Linux /proc process identity is unavailable.' };
  }
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return { kind: 'unverified', reason: 'Malformed /proc process metadata.' };
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const ticks = fields[19];
    if (!/^\d{1,32}$/.test(ticks || '')) {
      return { kind: 'unverified', reason: 'Malformed /proc process start time.' };
    }
    return { kind: 'present', ticks };
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ESRCH') return { kind: 'missing' };
    return { kind: 'unverified', reason: `Could not read /proc process identity: ${e.message}` };
  }
}

function validateServerState(raw, context) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'state is not an object' };
  }
  const pid = strictServerPid(raw.pid);
  if (raw.version !== SERVER_STATE_VERSION) return { ok: false, reason: 'unsupported state version' };
  if (pid == null) return { ok: false, reason: 'PID is not a safe integer greater than 1' };
  if (typeof raw.processStartTicks !== 'string' || !/^\d{1,32}$/.test(raw.processStartTicks)) {
    return { ok: false, reason: 'process start ticks are missing or malformed' };
  }
  if (typeof raw.bootId !== 'string' || !LINUX_BOOT_ID_RE.test(raw.bootId)) {
    return { ok: false, reason: 'Linux boot identity is missing or malformed' };
  }
  if (typeof raw.project !== 'string' || typeof raw.projectIdentity !== 'string') {
    return { ok: false, reason: 'project identity is missing' };
  }
  if (typeof raw.command !== 'string' || typeof raw.startedAt !== 'string') {
    return { ok: false, reason: 'server metadata is incomplete' };
  }
  if (Buffer.byteLength(raw.command, 'utf8') > SERVER_COMMAND_MAX_BYTES) {
    return { ok: false, reason: 'server command exceeds the safe metadata limit' };
  }
  if (raw.port !== null && (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65_535)) {
    return { ok: false, reason: 'port is malformed' };
  }
  const state = {
    version: SERVER_STATE_VERSION,
    project: raw.project,
    projectIdentity: raw.projectIdentity,
    pid,
    processStartTicks: raw.processStartTicks,
    bootId: raw.bootId.toLowerCase(),
    command: raw.command,
    port: raw.port,
    startedAt: raw.startedAt,
  };
  if (state.project !== context.project || state.projectIdentity !== context.identity) {
    return { ok: true, kind: 'project-mismatch', state };
  }
  return { ok: true, kind: 'valid', state };
}

function readAuthoritativeServerState(userId, context) {
  const paths = getCoderServerRuntimePaths(userId, context.project);
  let st;
  try { st = statSync(paths.statePath); }
  catch (e) {
    if (e?.code === 'ENOENT') return { kind: 'missing', paths };
    return { kind: 'corrupt', paths, reason: e.message };
  }
  if (!st.isFile() || st.size > SERVER_STATE_MAX_BYTES) {
    return { kind: 'corrupt', paths, reason: 'state file is not a bounded regular file' };
  }
  let raw;
  try { raw = JSON.parse(readFileSync(paths.statePath, 'utf8')); }
  catch (e) { return { kind: 'corrupt', paths, reason: e.message }; }
  const validated = validateServerState(raw, context);
  if (!validated.ok) return { kind: 'corrupt', paths, reason: validated.reason };
  return { kind: validated.kind, paths, state: validated.state };
}

function inspectServerProcess(state) {
  const boot = readLinuxBootId();
  if (boot.kind === 'unverified') return boot;
  if (boot.id !== state.bootId) {
    return { kind: 'boot-changed', observedBootId: boot.id };
  }
  const observed = readLinuxProcessStartTicks(state.pid);
  if (observed.kind === 'missing') return { kind: 'exited' };
  if (observed.kind === 'unverified') return observed;
  if (observed.ticks !== state.processStartTicks) {
    return { kind: 'pid-reused', observedTicks: observed.ticks };
  }
  return { kind: 'running' };
}

function serializeServerState(state) {
  const serialized = JSON.stringify(state, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > SERVER_STATE_MAX_BYTES) {
    throw new Error(`server metadata exceeds ${SERVER_STATE_MAX_BYTES} bytes`);
  }
  return serialized;
}

function validateServerStartInputs(command, port, context) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error('Server command must be a non-empty string.');
  }
  const commandBytes = Buffer.byteLength(command, 'utf8');
  if (commandBytes > SERVER_COMMAND_MAX_BYTES) {
    throw new Error(`Server command is too large (max ${SERVER_COMMAND_MAX_BYTES} UTF-8 bytes).`);
  }
  const normalizedPort = port == null ? null : port;
  if (normalizedPort !== null
      && (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65_535)) {
    throw new Error('Server port must be an integer from 1 through 65535.');
  }

  // Check the worst-sized dynamic fields before spawning. This guarantees the
  // authoritative document produced after spawn always fits the reader's cap,
  // including JSON escaping within the command.
  serializeServerState({
    version: SERVER_STATE_VERSION,
    project: context.project,
    projectIdentity: context.identity,
    command,
    port: normalizedPort,
    pid: 2_147_483_647,
    processStartTicks: '9'.repeat(32),
    bootId: '00000000-0000-0000-0000-000000000000',
    startedAt: '9999-12-31T23:59:59.999Z',
  });
  return { command, port: normalizedPort };
}

function clearAuthoritativeServerState(paths, { removeLog = false } = {}) {
  // A corrupt state path may be a directory or symlink. It is inside OE's
  // host-only runtime root, so remove the entry without following it.
  try { rmSync(paths.statePath, { recursive: true, force: true }); } catch {}
  if (removeLog) {
    try { rmSync(paths.logPath, { recursive: true, force: true }); } catch {}
  }
}

function readLogTail(logPath, logLines = 20) {
  const wantedLines = Math.max(1, Math.min(Number(logLines) || 20, 500));
  let fd = null;
  try {
    const st = statSync(logPath);
    if (!st.isFile() || st.size <= 0) return '';
    const bytes = Math.min(st.size, SERVER_LOG_TAIL_MAX_BYTES);
    const buffer = Buffer.alloc(bytes);
    fd = openSync(logPath, 'r');
    const read = readSync(fd, buffer, 0, bytes, st.size - bytes);
    const text = buffer.subarray(0, read).toString('utf8');
    const lines = text.split(/\r?\n/);
    return lines.slice(-wantedLines).join('\n');
  } catch {
    return '';
  } finally {
    if (fd != null) try { closeSync(fd); } catch {}
  }
}

function signalVerifiedServerProcess(state, processSignal) {
  const before = inspectServerProcess(state);
  if (before.kind !== 'running') return { sent: false, status: before };
  try {
    // coder_start_server uses detached:true, so the sandbox is its own process
    // group. Signal the group only after verifying the leader incarnation.
    process.kill(-state.pid, processSignal);
    return { sent: true, status: before };
  } catch (e) {
    if (e?.code === 'ESRCH') return { sent: false, status: inspectServerProcess(state) };
    return { sent: false, status: { kind: 'unverified', reason: e.message } };
  }
}

async function waitForServerProcessExit(state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = inspectServerProcess(state);
    if (status.kind !== 'running') return status;
    if (Date.now() >= deadline) return status;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function freshChildHasExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}

function waitForFreshChildExit(child, timeoutMs) {
  if (freshChildHasExited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = exited => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    child.once('close', onExit);
    timer = setTimeout(() => finish(freshChildHasExited(child)), timeoutMs);
    // Close the event-registration race if the child exited synchronously.
    if (freshChildHasExited(child)) finish(true);
  });
}

async function terminateFreshServerChild(child) {
  if (freshChildHasExited(child)) return { kind: 'exited' };
  if (validatedSignalPid(child?.pid) == null) return { kind: 'unverified' };
  // Before state is committed this ChildProcess is freshly spawned and owned by
  // this call. It is safe to use the handle/process group directly even when
  // /proc identity collection failed; persisted PIDs never get this treatment.
  signalProcessTree(child, true, 'SIGTERM');
  if (await waitForFreshChildExit(child, SERVER_STOP_GRACE_MS)) return { kind: 'exited' };
  signalProcessTree(child, true, 'SIGKILL');
  if (await waitForFreshChildExit(child, SERVER_KILL_WAIT_MS)) return { kind: 'exited' };
  return { kind: 'unverified' };
}

function freshCleanupNote(result, pid) {
  const safePid = validatedSignalPid(pid);
  return result.kind === 'exited'
    ? ' The spawned process was terminated and reaped.'
    : ` Cleanup could not verify that${safePid == null ? ' the spawned process' : ` pid ${safePid}`} exited.`;
}

function inactiveServerState(userId, context, { action }) {
  let record = readAuthoritativeServerState(userId, context);
  if (record.kind === 'missing') {
    const legacyRefusal = legacyServerRefusal(context.dir);
    if (legacyRefusal) throw new Error(`${legacyRefusal} Refusing to ${action}.`);
    return record;
  }
  if (record.kind === 'corrupt') {
    throw new Error(`Authoritative server state is invalid (${record.reason}); refusing to ${action}.`);
  }
  const processState = inspectServerProcess(record.state);
  if (processState.kind === 'running') {
    const ownership = record.kind === 'valid'
      ? `project "${context.project}"`
      : 'a replaced project incarnation';
    throw new Error(`A server is already running for ${ownership} (pid ${record.state.pid}). Stop it before you ${action}.`);
  }
  if (processState.kind === 'unverified') {
    throw new Error(`Server process identity could not be verified (${processState.reason}); refusing to ${action}.`);
  }
  clearAuthoritativeServerState(record.paths);
  record = { kind: 'missing', paths: record.paths };
  const legacyRefusal = legacyServerRefusal(context.dir);
  if (legacyRefusal) throw new Error(`${legacyRefusal} Refusing to ${action}.`);
  return record;
}

function assertServerInactiveForDeletion(userId, context) {
  const record = inactiveServerState(userId, context, { action: 'delete the project' });
  return record.paths;
}

async function startServerUnlocked(command, port, userId, context, signal = null) {
  // Admission is cancellable, but the persistent child is deliberately not
  // wired to the task signal. Once spawned it is project-owned and remains up
  // until coder_stop_server, even if the launching turn later gets cancelled.
  throwIfCancelled(signal);
  if (!BWRAP_BIN) {
    throw new Error('Shell execution unavailable: sandbox (bwrap) not installed on server.');
  }
  if (isCommandBlocked(command)) {
    throw new Error('BLOCKED: This command was rejected by safety filters.');
  }
  // Without a Linux process-incarnation token OE must never persist a PID that
  // a later turn could signal after reuse.
  const managerProcess = readLinuxProcessStartTicks(process.pid);
  const boot = readLinuxBootId();
  if (managerProcess.kind !== 'present' || boot.kind !== 'present') {
    const reason = managerProcess.kind !== 'present'
      ? managerProcess.reason
      : boot.reason;
    throw new Error(`Cannot safely manage server processes: ${reason || 'Linux process identity is unavailable.'}`);
  }

  const prior = inactiveServerState(userId, context, { action: 'start another server' });
  const paths = prior.paths;
  ensureServerRuntimeDir(paths);

  // Truncate previous log so status/logs views start fresh for this run.
  writeFileSync(paths.logPath, '', { mode: 0o600 });
  chmodSync(paths.logPath, 0o600);
  const logFd = openSync(paths.logPath, 'a', 0o600);

  let child;
  try {
    child = spawn(BWRAP_BIN, buildSandboxArgs(context.dir, command), {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { PATH: SANDBOX_PATH, HOME: context.dir, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    });
  } finally {
    try { closeSync(logFd); } catch {}
  }

  // If bwrap fails to spawn at all we get an 'error' event; catch the first
  // one synchronously-ish so we don't leave stale state behind.
  let spawnErr = null;
  child.once('error', (e) => { spawnErr = e; });
  // unref so the node event loop doesn't keep waiting on the sandbox.
  try {
    child.unref();
  } catch (e) {
    const cleanup = await terminateFreshServerChild(child);
    throw new Error(`Failed to detach spawned server: ${e.message}.${freshCleanupNote(cleanup, child.pid)}`);
  }
  await new Promise(r => setTimeout(r, 50));
  if (spawnErr) {
    // Node reports an OS-level spawn failure with no PID; there is no process
    // to reap in that case. A rare post-spawn error with a PID still gets the
    // same bounded cleanup as every other pre-commit failure.
    if (strictServerPid(child.pid) == null) {
      throw new Error(`Failed to start server: ${spawnErr.message}.`);
    }
    const cleanup = await terminateFreshServerChild(child);
    throw new Error(`Failed to start server: ${spawnErr.message}.${freshCleanupNote(cleanup, child.pid)}`);
  }

  const pid = strictServerPid(child.pid);
  const observed = readLinuxProcessStartTicks(pid);
  if (pid == null) {
    const cleanup = await terminateFreshServerChild(child);
    throw new Error(`Spawned server returned an invalid host PID.${freshCleanupNote(cleanup, child.pid)}`);
  }
  if (observed.kind === 'missing') {
    await terminateFreshServerChild(child);
    const tail = readLogTail(paths.logPath, 20);
    throw new Error(`Server exited before its process identity could be recorded.${tail ? `\n${tail}` : ''}`);
  }
  if (observed.kind !== 'present') {
    const cleanup = await terminateFreshServerChild(child);
    throw new Error(`Spawned server identity could not be verified (${observed.reason || 'unknown /proc error'}).${freshCleanupNote(cleanup, pid)}`);
  }

  const meta = {
    version: SERVER_STATE_VERSION,
    project: context.project,
    projectIdentity: context.identity,
    command,
    port,
    pid,
    processStartTicks: observed.ticks,
    bootId: boot.id,
    startedAt: new Date().toISOString(),
  };
  try {
    atomicWriteSync(paths.statePath, serializeServerState(meta), { mode: 0o600 });
  } catch (e) {
    const final = await terminateFreshServerChild(child);
    clearAuthoritativeServerState(paths);
    throw new Error(`Failed to persist authoritative server state: ${e.message}.${freshCleanupNote(final, pid)}`);
  }
  appendLog(context.dir, `Started server \`${command.length > 80 ? command.slice(0, 80) + '…' : command}\` (pid ${pid}${port ? `, port ${port}` : ''})`);

  // Report the server's LAN IP, not "localhost" — the browser user is on a
  // different machine than the OE server, so "localhost" resolves to their
  // desktop instead of here and yields connection refused.
  let lanIp = null;
  try { lanIp = getLanAddress(); } catch {}
  const url = port && lanIp ? `http://${lanIp}:${port}` : null;
  const urlNote = url ? ` at ${url}` : '';
  return `Started server${urlNote} (pid ${pid}). Use coder_server_status to view logs or coder_stop_server to stop it.`;
}

async function startServer(command, port, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  const context = getProjectContext(userId, agentId);
  const validated = validateServerStartInputs(command, port, context);
  // Starting changes both checkout-owned runtime files and server lifecycle
  // state, so it takes the locks in the canonical project -> server order.
  return withProjectContextLock(userId, context, () => {
    throwIfCancelled(signal);
    return withProjectContextServerLock(userId, context, () => {
      throwIfCancelled(signal);
      return startServerUnlocked(validated.command, validated.port, userId, context, signal);
    }, signal);
  }, signal);
}

async function stopServerUnlocked(userId, context) {
  const record = readAuthoritativeServerState(userId, context);
  if (record.kind === 'missing') {
    const legacyRefusal = legacyServerRefusal(context.dir);
    if (legacyRefusal) return legacyRefusal;
    return 'No server is running for this project.';
  }
  if (record.kind === 'corrupt') {
    throw new Error(`Authoritative server state is invalid (${record.reason}); no PID was signaled.`);
  }
  if (record.kind === 'project-mismatch') {
    throw new Error('Authoritative server state belongs to a replaced project incarnation; no PID was signaled.');
  }

  let processState = inspectServerProcess(record.state);
  if (processState.kind === 'exited' || processState.kind === 'pid-reused' || processState.kind === 'boot-changed') {
    clearAuthoritativeServerState(record.paths);
    const detail = processState.kind === 'pid-reused'
      ? 'its PID was reused'
      : processState.kind === 'boot-changed'
        ? 'the host rebooted'
        : 'it already exited';
    return `No running server (recorded process ${detail}; stale state cleaned up).`;
  }
  if (processState.kind === 'unverified') {
    throw new Error(`Server process identity could not be verified (${processState.reason}); no PID was signaled.`);
  }

  const term = signalVerifiedServerProcess(record.state, 'SIGTERM');
  processState = term.sent
    ? await waitForServerProcessExit(record.state, SERVER_STOP_GRACE_MS)
    : term.status;
  if (processState.kind === 'running') {
    const killed = signalVerifiedServerProcess(record.state, 'SIGKILL');
    processState = killed.sent
      ? await waitForServerProcessExit(record.state, SERVER_KILL_WAIT_MS)
      : killed.status;
  }
  if (processState.kind === 'running' || processState.kind === 'unverified') {
    const reason = processState.reason ? `: ${processState.reason}` : '';
    throw new Error(`Could not verify that server pid ${record.state.pid} stopped${reason}. State was retained.`);
  }

  clearAuthoritativeServerState(record.paths);
  appendLog(context.dir, `Stopped server (pid ${record.state.pid})`);
  return `Stopped server (pid ${record.state.pid}).`;
}

async function stopServer(userId, agentId) {
  const context = getProjectContext(userId, agentId);
  return withProjectContextServerLock(userId, context,
    () => stopServerUnlocked(userId, context));
}

async function serverStatusUnlocked(userId, context, logLines = 20) {
  const record = readAuthoritativeServerState(userId, context);
  if (record.kind === 'missing') {
    const legacy = legacyServerState(context.dir);
    if (legacy.present) {
      // Never open project-writable legacy paths here: server.log could itself
      // be a symlink chosen to make the host read outside the project.
      return legacyServerRefusal(context.dir);
    }
    const tail = readLogTail(record.paths.logPath, logLines);
    return `No server is running for this project.${tail ? `\n--- last log lines ---\n${tail}` : ''}`;
  }
  if (record.kind === 'corrupt') {
    throw new Error(`Authoritative server state is invalid (${record.reason}); refusing to trust its PID.`);
  }
  if (record.kind === 'project-mismatch') {
    throw new Error('Authoritative server state belongs to a replaced project incarnation; refusing to trust its PID.');
  }

  const processState = inspectServerProcess(record.state);
  if (processState.kind === 'exited' || processState.kind === 'pid-reused' || processState.kind === 'boot-changed') {
    clearAuthoritativeServerState(record.paths);
    const detail = processState.kind === 'pid-reused'
      ? 'its PID was reused'
      : processState.kind === 'boot-changed'
        ? 'the host rebooted'
        : 'it exited';
    const tail = readLogTail(record.paths.logPath, logLines);
    return `No server is running for this project (recorded process ${detail}; stale state cleaned up).${tail ? `\n--- last log lines ---\n${tail}` : ''}`;
  }
  if (processState.kind === 'unverified') {
    throw new Error(`Server process identity could not be verified (${processState.reason}); refusing to report it as running.`);
  }

  const { pid, command, port, startedAt } = record.state;
  const tail = readLogTail(record.paths.logPath, logLines);

  const portLine = port ? `port: ${port}` : '';
  const urlLine = port ? `url: http://${getLanAddress()}:${port}` : '';
  return [
    `Server running:`,
    `pid: ${pid}`,
    `command: ${command}`,
    portLine,
    urlLine,
    `started: ${startedAt}`,
    ``,
    `--- last ${logLines} log lines ---`,
    tail || '(no output yet)',
  ].filter(Boolean).join('\n');
}

async function serverStatus(userId, agentId, logLines = 20) {
  const context = getProjectContext(userId, agentId);
  return withProjectContextServerLock(userId, context,
    () => serverStatusUnlocked(userId, context, logLines));
}

// Apply a list of {old_string, new_string, replace_all?} edits to a single file
// atomically — every edit must succeed against the staged buffer or nothing is
// written. Mirrors Claude Code's MultiEdit semantics.
async function multiEditProjectFile(filePath, edits, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('edits must be a non-empty array.');
  }
  const context = getProjectContext(userId, agentId);
  return withProjectContextLock(userId, context, async () => {
    throwIfCancelled(signal);
    const abs = safePath(context.dir, filePath);
    if (!existsSync(abs)) throw new Error(`File not found: ${filePath}`);

    let content = readFileSync(abs, 'utf8');
    for (let i = 0; i < edits.length; i++) {
      const { old_string, new_string, replace_all } = edits[i];
      if (typeof old_string !== 'string' || typeof new_string !== 'string') {
        throw new Error(`Edit #${i + 1}: old_string and new_string must be strings.`);
      }
      if (old_string === new_string) {
        throw new Error(`Edit #${i + 1}: old_string and new_string are identical.`);
      }
      if (replace_all) {
        if (!content.includes(old_string)) throw new Error(`Edit #${i + 1}: old_string not found.`);
        content = content.split(old_string).join(new_string);
      } else {
        const count = content.split(old_string).length - 1;
        if (count === 0) throw new Error(`Edit #${i + 1}: old_string not found.`);
        if (count > 1) throw new Error(`Edit #${i + 1}: old_string found ${count} times — must be unique or set replace_all:true.`);
        content = content.replace(old_string, new_string);
      }
    }
    atomicWriteSync(abs, content);
    appendLog(context.dir, `Multi-edited \`${filePath}\` (${edits.length} edits)`);
    return `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${filePath} (revision ${fileRevision(content)})`;
  }, signal);
}

// TODOs are scoped to (project, durable agent). A shared legacy todos.json is
// copied into each agent's namespace on first read so upgrades do not strand
// existing plans and one agent cannot consume the migration for another.
function _todoAgentRef(userId, agentId) {
  return stableAgentRef(userId, agentId) || '__user__';
}

function _todosPathForDir(projectDir, userId, agentId) {
  const ref = _todoAgentRef(userId, agentId);
  const safeRef = ref.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'agent';
  const suffix = createHash('sha256').update(ref).digest('hex').slice(0, 12);
  return path.join(projectDir, '.openensemble', 'todos', `${safeRef}-${suffix}.json`);
}

function _legacyTodosPath(projectDir) {
  return path.join(projectDir, '.openensemble', 'todos.json');
}

function _parseTodosFile(p) {
  try {
    const value = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(value) ? value : null;
  } catch { return null; }
}

function _readTodosUnlocked(projectDir, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  const p = _todosPathForDir(projectDir, userId, agentId);
  if (existsSync(p)) return _parseTodosFile(p) ?? [];

  const legacyPath = _legacyTodosPath(projectDir);
  if (!existsSync(legacyPath)) return [];
  const legacy = _parseTodosFile(legacyPath);
  if (!legacy) return [];
  // Preserve even an empty legacy list as proof that this agent migrated.
  throwIfCancelled(signal);
  mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteSync(p, JSON.stringify(legacy, null, 2));
  return legacy;
}

function _renderTodos(todos) {
  if (!todos.length) return '(no todos)';
  const icon = (s) => s === 'completed' ? '✓' : s === 'in_progress' ? '▶' : '○';
  return todos.map(t => `${icon(t.status)} [${t.id}] ${t.content}`).join('\n');
}

async function todoWrite(todos, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  // Models sometimes serialize the array as a JSON string — parse it transparently.
  if (typeof todos === 'string') {
    try { todos = JSON.parse(todos); } catch { throw new Error('todos must be an array.'); }
  }
  if (!Array.isArray(todos)) throw new Error('todos must be an array.');
  const valid = ['pending', 'in_progress', 'completed'];
  for (const t of todos) {
    if (!t || typeof t.id !== 'string' || typeof t.content !== 'string' || !valid.includes(t.status)) {
      throw new Error('Each todo needs id (string), content (string), and status (pending|in_progress|completed).');
    }
  }
  const context = getProjectContext(userId, agentId);
  return withProjectContextLock(userId, context, async () => {
    throwIfCancelled(signal);
    const p = _todosPathForDir(context.dir, userId, agentId);
    mkdirSync(path.dirname(p), { recursive: true });
    atomicWriteSync(p, JSON.stringify(todos, null, 2));
    return _renderTodos(todos);
  }, signal);
}

async function todoRead(userId, agentId, signal = null) {
  throwIfCancelled(signal);
  const context = getProjectContext(userId, agentId);
  return withProjectContextLock(userId, context, async () => {
    throwIfCancelled(signal);
    return _renderTodos(_readTodosUnlocked(context.dir, userId, agentId, signal));
  }, signal);
}

async function listFiles(directory, pattern, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  const dir = getProjectDir(userId, agentId);
  const base = directory ? safePath(dir, directory) : dir;
  if (!existsSync(base)) throw new Error(`Directory not found: ${directory ?? '.'}`);

  if (pattern) {
    // Use find with glob-like pattern
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/find', [base, '-name', pattern, '-type', 'f', '-not', '-path', '*/.git/*'],
        { timeout: 10000, maxBuffer: 512 * 1024, ...(signal ? { signal } : {}) },
        (err, stdout) => {
          if (signal?.aborted || err?.name === 'AbortError') return reject(cancellationError(signal));
          if (!stdout?.trim()) return resolve('No files matched.');
          const lines = stdout.trim().split('\n').map(f => path.relative(dir, f)).sort();
          resolve(lines.join('\n'));
        });
    });
  }

  // Recursive listing (skip .git, node_modules)
  const results = [];
  async function walk(d, depth = 0) {
    throwIfCancelled(signal);
    if (depth > 8) return;
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      throwIfCancelled(signal);
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const rel = path.relative(dir, path.join(d, e.name));
      if (e.isDirectory()) {
        results.push(`📁 ${rel}/`);
        await walk(path.join(d, e.name), depth + 1);
      } else {
        results.push(`   ${rel}`);
      }
    }
  }
  await walk(base);
  return results.length ? results.join('\n') : 'Empty directory.';
}

async function searchFiles(pattern, searchPath, glob, userId, agentId, signal = null) {
  throwIfCancelled(signal);
  const dir = getProjectDir(userId, agentId);
  const base = searchPath ? safePath(dir, searchPath) : dir;

  const args = ['--no-heading', '--line-number', '--color', 'never', '-e', pattern];
  if (glob) args.push('--glob', glob);
  args.push(base);

  return new Promise((resolve, reject) => {
    execFile('rg', args, {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      ...(signal ? { signal } : {}),
    }, (err, stdout) => {
      if (signal?.aborted || err?.name === 'AbortError') return reject(cancellationError(signal));
      if (!stdout?.trim()) return resolve('No matches found.');
      // Make paths relative to project
      const lines = stdout.trim().split('\n').map(l => {
        if (l.startsWith(dir)) return l.slice(dir.length + 1);
        return l;
      });
      resolve(lines.slice(0, 200).join('\n') + (lines.length > 200 ? `\n... (${lines.length - 200} more)` : ''));
    });
  });
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

// Async generator dispatcher. Tools that need to stream output (currently just
// `coder_run_command`) yield `{type:'token'}` chunks live and finish with a
// single `{type:'result'}` event. Plain async tools are wrapped into one final
// `{type:'result'}` event so the caller (`roles.mjs::executeToolStreaming`)
// can relay them uniformly.
export async function* executeSkillTool(name, args, userId = 'default', agentId, ctx) {
  const signal = ctx?.signal ?? null;
  if (name === 'coder_run_command') {
    yield* runCommand(args.command, args.timeout, userId, agentId, signal);
    return;
  }
  let text;
  try {
    switch (name) {
      case 'coder_list_projects':  text = await listProjects(userId, agentId); break;
      case 'coder_create_project': text = await createProject(args.name, userId, agentId, signal); break;
      case 'coder_switch_project': text = await switchProject(args.name, userId, agentId, signal); break;
      case 'coder_delete_project': text = await deleteProject(args.name, userId, agentId, signal); break;
      case 'coder_read_file':      text = await readProjectFile(args.path, args.offset, args.limit, userId, agentId); break;
      case 'coder_write_file':     text = await writeProjectFile(args.path, args.content, args.expected_revision, userId, agentId, signal); break;
      case 'coder_edit_file':      text = await editProjectFile(args.path, args.old_string, args.new_string, userId, agentId, signal); break;
      case 'coder_multi_edit':     text = await multiEditProjectFile(args.file_path, args.edits, userId, agentId, signal); break;
      case 'coder_delete_file':    text = await deleteProjectFile(args.path, userId, agentId, signal); break;
      case 'coder_list_files':     text = await listFiles(args.directory, args.pattern, userId, agentId, signal); break;
      case 'coder_search':         text = await searchFiles(args.pattern, args.path, args.glob, userId, agentId, signal); break;
      case 'coder_todo_write':     text = await todoWrite(args.todos, userId, agentId, signal); break;
      case 'coder_todo_read':      text = await todoRead(userId, agentId, signal); break;
      case 'coder_start_server':   text = await startServer(args.command, args.port, userId, agentId, signal); break;
      case 'coder_stop_server':    text = await stopServer(userId, agentId); break;
      case 'coder_server_status':  text = await serverStatus(userId, agentId, args.lines); break;
      default: text = null;
    }
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw cancellationError(signal);
    text = `Error: ${e.message}`;
  }
  yield { type: 'result', text: String(text ?? '') };
}

export default executeSkillTool;

/**
 * Catalog source for the alias framework. Lists projects under the user's
 * workspace as `{name}` entries (project name is both id and display).
 */
export async function listAliasEntries(userId) {
  try {
    const ws = getWorkspace(userId);
    if (!existsSync(ws)) return [];
    return readdirSync(ws, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name }));
  } catch (e) {
    console.warn('[coder] listAliasEntries failed:', e.message);
    return [];
  }
}
