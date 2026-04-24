/**
 * Coder skill executor.
 * Provides file I/O, shell execution, and project management tools
 * sandboxed to a configurable workspace directory.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmdirSync,
         readdirSync, statSync, appendFileSync, rmSync, realpathSync, openSync, closeSync } from 'fs';
import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile, spawn, execSync } from 'child_process';
import { broadcastToUsers } from '../../routes/_helpers/broadcast.mjs';
import { getLanAddress } from '../../discovery.mjs';

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

// ── Per-user active project tracking ─────────────────────────────────────────
const _activeProject = new Map();

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

function getProjectDir(userId) {
  const ws = getWorkspace(userId);
  const project = _activeProject.get(userId);
  if (!project) throw new Error('No active project. Use coder_create_project or coder_switch_project first.');
  const dir = path.join(ws, project);
  if (!existsSync(dir)) throw new Error(`Project "${project}" not found in workspace.`);
  return dir;
}

// Full file listing for a project — used by the client-side mirror to seed its
// local folder on first open. Honors the same skip-list as live mirroring and
// enforces a per-file + total size cap so the response stays bounded.
export function getProjectSnapshot(userId, projectName) {
  validateProjectName(projectName);
  const ws = getWorkspace(userId);
  const dir = path.join(ws, projectName);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Project "${projectName}" not found.`);
  }

  const FILE_CAP_BYTES = 5 * 1024 * 1024;
  const TOTAL_CAP_BYTES = 50 * 1024 * 1024;

  const files = [];
  const skipped = [];
  let total = 0;
  let truncated = false;

  const walk = (d) => {
    if (truncated) return;
    const entries = readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs);
      if (!_shouldMirrorPath(rel)) continue;
      if (e.isDirectory()) { walk(abs); if (truncated) return; continue; }
      if (!e.isFile()) continue;
      let bytes;
      try { bytes = readFileSync(abs); }
      catch { continue; }
      if (bytes.length > FILE_CAP_BYTES) {
        skipped.push({ path: rel.split(path.sep).join('/'), size: bytes.length, reason: 'file_too_large' });
        continue;
      }
      if (total + bytes.length > TOTAL_CAP_BYTES) { truncated = true; return; }
      total += bytes.length;
      files.push({
        path: rel.split(path.sep).join('/'),
        contentBase64: bytes.toString('base64'),
      });
    }
  };
  walk(dir);

  return { project: projectName, files, skipped, truncated, totalBytes: total };
}

// Snapshot of the current coder state for a user — used by the nodes skill to
// deploy whatever Ada is currently working on. Returns null if no project is
// active yet. Never throws: callers handle the "nothing to push" case.
export function getActiveProjectInfo(userId) {
  try {
    const project = _activeProject.get(userId);
    if (!project) return null;
    const workspace = getWorkspace(userId);
    const dir = path.join(workspace, project);
    if (!existsSync(dir)) return null;
    return { project, workspace, dir };
  } catch { return null; }
}

function safePath(base, userPath) {
  if (!userPath) throw new Error('Path is required.');
  const resolved = path.resolve(base, userPath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`Path "${userPath}" is outside the allowed directory.`);
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
  return { workspace: realWs, dir: realDir };
}

// List all top-level projects in this user's workspace with cheap metadata
// (file count, total size, mtime). Honors the same skip-segments as the
// client-side mirror so node_modules / .venv don't inflate the sizes we
// advertise in the Code Projects pane.
export function listUserProjects(userId) {
  const ws = getWorkspace(userId);
  const entries = readdirSync(ws, { withFileTypes: true }).filter(e => e.isDirectory());
  const projects = [];
  for (const e of entries) {
    const dir = path.join(ws, e.name);
    let fileCount = 0;
    let totalSize = 0;
    let latestMtime = 0;
    const walk = (d) => {
      let children;
      try { children = readdirSync(d, { withFileTypes: true }); }
      catch { return; }
      for (const c of children) {
        if (MIRROR_SKIP_SEGMENTS.has(c.name)) continue;
        const abs = path.join(d, c.name);
        if (c.isDirectory()) { walk(abs); continue; }
        if (!c.isFile()) continue;
        try {
          const st = statSync(abs);
          fileCount += 1;
          totalSize += st.size;
          if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
        } catch {}
      }
    };
    walk(dir);
    // Fall back to the project dir's own mtime if we found no files (empty project).
    if (latestMtime === 0) {
      try { latestMtime = statSync(dir).mtimeMs; } catch {}
    }
    projects.push({
      name: e.name,
      fileCount,
      size: totalSize,
      mtime: latestMtime ? new Date(latestMtime).toISOString() : null,
    });
  }
  return { workspace: ws, projects };
}

// Delete a project — thin wrapper around the existing deleteProject() so HTTP
// routes don't have to reach into the tool dispatch layer.
export async function deleteUserProject(userId, name) {
  return deleteProject(name, userId);
}

function appendLog(projectDir, entry) {
  const logPath = path.join(projectDir, 'PROJECT_LOG.md');
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
  const line = `\n- **${ts}** — ${entry}\n`;
  appendFileSync(logPath, line);
}

function appendWorkspaceLog(entry, userId) {
  try {
    const ws = getWorkspace(userId);
    const logPath = path.join(ws, 'WORKSPACE_LOG.md');
    const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
    if (!existsSync(logPath)) writeFileSync(logPath, '# Workspace Log\n');
    appendFileSync(logPath, `\n- **${ts}** — ${entry}\n`);
  } catch { /* don't fail the operation over logging */ }
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

// ── Client-side mirror ───────────────────────────────────────────────────────
// When the user has opted into a local folder mirror (File System Access API),
// every file mutation here is echoed to their browser over WS so the browser
// can write it into the user-picked folder. The browser is responsible for the
// directory handle + permissions; the server just pushes the bytes.

// Files that are pointless to mirror — bulky, regenerable, or noisy.
const MIRROR_SKIP_SEGMENTS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next',
  'dist', 'build', '.cache', '.turbo', '.parcel-cache', '.pytest_cache',
  '.run', // coder_start_server runtime state (pid/log/meta) — not source
]);

function _shouldMirrorPath(relPath) {
  if (!relPath) return false;
  const parts = relPath.split(path.sep).filter(Boolean);
  return !parts.some(p => MIRROR_SKIP_SEGMENTS.has(p));
}

function _mirrorWrite(userId, project, relPath, content) {
  if (!project || !_shouldMirrorPath(relPath)) return;
  try {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    // 5 MB per-file cap — larger files get skipped (client sees no update).
    if (bytes.length > 5 * 1024 * 1024) return;
    broadcastToUsers([userId], {
      type: 'coder_mirror',
      op: 'write',
      project,
      path: relPath.split(path.sep).join('/'),
      contentBase64: bytes.toString('base64'),
    });
  } catch { /* mirror is best-effort — never fail the tool */ }
}

function _mirrorDelete(userId, project, relPath) {
  if (!project) return;
  try {
    broadcastToUsers([userId], {
      type: 'coder_mirror',
      op: 'delete',
      project,
      path: relPath.split(path.sep).join('/'),
    });
  } catch {}
}

function _mirrorDeleteProject(userId, project) {
  if (!project) return;
  try {
    broadcastToUsers([userId], { type: 'coder_mirror', op: 'delete_project', project });
  } catch {}
}

function _mirrorResync(userId, project) {
  if (!project) return;
  try {
    broadcastToUsers([userId], { type: 'coder_mirror', op: 'resync', project });
  } catch {}
}

// ── Tool implementations ─────────────────────────────────────────────────────

async function listProjects(userId) {
  const ws = getWorkspace(userId);
  const entries = readdirSync(ws, { withFileTypes: true }).filter(e => e.isDirectory());
  if (!entries.length) return `Workspace: ${ws}\nNo projects yet. Use coder_create_project to create one.`;

  const lines = [];
  for (const e of entries) {
    const logPath = path.join(ws, e.name, 'PROJECT_LOG.md');
    let summary = '';
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, 'utf8');
      const firstLines = content.split('\n').slice(0, 5).join('\n');
      summary = '\n  ' + firstLines.replace(/\n/g, '\n  ');
    }
    lines.push(`📁 ${e.name}${summary}`);
  }
  return `Workspace: ${ws}\n\n` + lines.join('\n\n');
}

async function createProject(name, userId) {
  validateProjectName(name);
  const ws = getWorkspace(userId);
  const dir = path.join(ws, name);
  if (existsSync(dir)) throw new Error(`Project "${name}" already exists.`);

  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
  const logContent = `# ${name}\n\nCreated: ${ts}\n`;
  writeFileSync(path.join(dir, 'PROJECT_LOG.md'), logContent);
  _activeProject.set(userId, name);
  appendWorkspaceLog(`Created project "${name}"`, userId);
  _mirrorWrite(userId, name, 'PROJECT_LOG.md', logContent);
  return `Created project "${name}" and set it as active.\nWorkspace: ${dir}`;
}

async function switchProject(name, userId) {
  validateProjectName(name);
  const ws = getWorkspace(userId);
  const dir = path.join(ws, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Project "${name}" not found in workspace.`);
  }
  _activeProject.set(userId, name);
  appendLog(dir, 'Switched to this project');

  // Return recent log entries for context
  const logPath = path.join(dir, 'PROJECT_LOG.md');
  let logTail = '';
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, 'utf8').split('\n');
    logTail = '\n\nRecent activity:\n' + lines.slice(-10).join('\n');
  }

  // Include pending todos FIRST so they aren't cut off by context truncation.
  // The model needs to see what's still pending before anything else.
  const todos = _readTodos(userId);
  const pending = todos.filter(t => t.status !== 'completed');
  const todoBlock = pending.length
    ? '\n\nPending todos (resume from here):\n' + _renderTodos(pending)
    : todos.length
      ? '\n\nAll todos completed.'
      : '';

  return `Switched to project "${name}".${todoBlock}${logTail}`;
}

async function deleteProject(name, userId) {
  validateProjectName(name);
  const ws = getWorkspace(userId);
  const dir = path.join(ws, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Project "${name}" not found in workspace.`);
  }
  rmSync(dir, { recursive: true, force: true });
  // Clear active project if it was the one deleted
  if (_activeProject.get(userId) === name) _activeProject.delete(userId);
  appendWorkspaceLog(`Deleted project "${name}"`, userId);
  _mirrorDeleteProject(userId, name);
  return `Deleted project "${name}" and all its contents.`;
}

async function readProjectFile(filePath, offset, limit, userId) {
  const dir = getProjectDir(userId);
  const abs = safePath(dir, filePath);
  if (!existsSync(abs)) throw new Error(`File not found: ${filePath}`);

  const content = await readFile(abs, 'utf8');
  const lines = content.split('\n');
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = start + (limit ?? 2000);
  const slice = lines.slice(start, end);

  return slice.map((l, i) => `${String(start + i + 1).padStart(5)} │ ${l}`).join('\n');
}

async function writeProjectFile(filePath, content, userId) {
  const dir = getProjectDir(userId);
  const abs = safePath(dir, filePath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  appendLog(dir, `Wrote \`${filePath}\` (${content.split('\n').length} lines)`);
  _mirrorWrite(userId, _activeProject.get(userId), filePath, content);
  return `Wrote ${filePath}`;
}

async function editProjectFile(filePath, oldStr, newStr, userId) {
  const dir = getProjectDir(userId);
  const abs = safePath(dir, filePath);
  if (!existsSync(abs)) throw new Error(`File not found: ${filePath}`);

  const content = readFileSync(abs, 'utf8');
  const count = content.split(oldStr).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${filePath}.`);
  if (count > 1) throw new Error(`old_string found ${count} times in ${filePath} — must be unique. Provide more context.`);

  const updated = content.replace(oldStr, newStr);
  writeFileSync(abs, updated);
  const preview = oldStr.length > 60 ? oldStr.slice(0, 60) + '…' : oldStr;
  appendLog(dir, `Edited \`${filePath}\` — replaced "${preview}"`);
  _mirrorWrite(userId, _activeProject.get(userId), filePath, updated);
  return `Edited ${filePath}`;
}

async function deleteProjectFile(filePath, userId) {
  const dir = getProjectDir(userId);
  const abs = safePath(dir, filePath);
  if (!existsSync(abs)) throw new Error(`Not found: ${filePath}`);

  const s = statSync(abs);
  if (s.isDirectory()) {
    const entries = readdirSync(abs);
    if (entries.length > 0) throw new Error(`Directory "${filePath}" is not empty. Remove its contents first.`);
    rmdirSync(abs);
    appendLog(dir, `Deleted empty directory \`${filePath}\``);
    _mirrorDelete(userId, _activeProject.get(userId), filePath);
    return `Deleted directory ${filePath}`;
  }
  unlinkSync(abs);
  appendLog(dir, `Deleted file \`${filePath}\``);
  _mirrorDelete(userId, _activeProject.get(userId), filePath);
  return `Deleted ${filePath}`;
}

// Streaming shell executor: yields `{type:'token'}` chunks live and a final
// `{type:'result'}` event with the full (capped) output for the tool loop.
async function* runCommand(command, timeout, userId) {
  let dir;
  try { dir = getProjectDir(userId); }
  catch (e) { yield { type: 'result', text: `Error: ${e.message}` }; return; }

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
  const proc = spawn(BWRAP_BIN, buildSandboxArgs(dir, command), {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
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
  let errored = null;

  const wake = () => { if (resolveWait) { resolveWait(); resolveWait = null; } };
  const wait = () => new Promise(r => { resolveWait = r; });

  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => { append(chunk); queue.push({ type: 'token', text: chunk }); wake(); });
  proc.stderr.on('data', (chunk) => { append(chunk); queue.push({ type: 'token', text: chunk }); wake(); });
  proc.on('error', (e) => { errored = e; done = true; wake(); });
  proc.on('close', (code) => { exitCode = code; done = true; wake(); });

  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 2000);
  }, timeoutMs);

  try {
    while (!done || queue.length > 0) {
      while (queue.length > 0) yield queue.shift();
      if (done) break;
      await wait();
    }
  } finally {
    clearTimeout(timer);
  }

  const finalCode = errored ? 1 : (timedOut ? 124 : (exitCode ?? 0));
  const tail = [
    capped ? `\n… (truncated, ${totalBytes - full.length} more bytes)` : '',
    `\nexit code: ${finalCode}`,
    timedOut ? '\n(killed: timeout exceeded)' : '',
    errored ? `\n(spawn error: ${errored.message})` : '',
  ].filter(Boolean).join('');

  appendLog(dir, `Ran \`${command.length > 80 ? command.slice(0, 80) + '…' : command}\` → exit ${finalCode}`);
  // Shell commands can create/modify/delete arbitrary files inside the project.
  // Tracking every change is infeasible — ask the client to re-snapshot.
  _mirrorResync(userId, _activeProject.get(userId));
  yield { type: 'result', text: (full || '(no output)') + tail };
}

// ── Long-running processes (dev servers) ─────────────────────────────────────
// coder_run_command's sandbox uses --unshare-pid, so its PID namespace collapses
// when the tool call returns — any backgrounded process dies with it. To run a
// persistent dev server (node/python/whatever), start it in its own long-lived
// bwrap that we detach from OE's event loop. One server per project; state
// lives in <project>/.run/ so we can stop/status it across tool calls.

function serverStateDir(projectDir) {
  const d = path.join(projectDir, '.run');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
function serverPidPath(projectDir)  { return path.join(serverStateDir(projectDir), 'server.pid'); }
function serverLogPath(projectDir)  { return path.join(serverStateDir(projectDir), 'server.log'); }
function serverMetaPath(projectDir) { return path.join(serverStateDir(projectDir), 'server.meta.json'); }

function readServerPid(projectDir) {
  try {
    const raw = readFileSync(serverPidPath(projectDir), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function clearServerState(projectDir) {
  for (const p of [serverPidPath(projectDir), serverMetaPath(projectDir)]) {
    try { unlinkSync(p); } catch {}
  }
}

async function startServer(command, port, userId) {
  const dir = getProjectDir(userId);
  if (!BWRAP_BIN) {
    throw new Error('Shell execution unavailable: sandbox (bwrap) not installed on server.');
  }
  if (isCommandBlocked(command)) {
    throw new Error('BLOCKED: This command was rejected by safety filters.');
  }

  const existingPid = readServerPid(dir);
  if (existingPid && isPidAlive(existingPid)) {
    throw new Error(`A server is already running for this project (pid ${existingPid}). Stop it first with coder_stop_server.`);
  }
  // Stale pid file — process died on its own. Clean up before re-starting.
  if (existingPid) clearServerState(dir);

  // Truncate previous log so status/logs views start fresh for this run.
  const logPath = serverLogPath(dir);
  writeFileSync(logPath, '');
  const logFd = openSync(logPath, 'a');

  const child = spawn(BWRAP_BIN, buildSandboxArgs(dir, command), {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { PATH: SANDBOX_PATH, HOME: dir, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
  });
  closeSync(logFd);
  // unref so the node event loop doesn't keep waiting on the sandbox.
  child.unref();

  // If bwrap fails to spawn at all we get an 'error' event; catch the first
  // one synchronously-ish so we don't leave stale state behind.
  let spawnErr = null;
  child.once('error', (e) => { spawnErr = e; });
  await new Promise(r => setTimeout(r, 50));
  if (spawnErr) throw new Error(`Failed to start server: ${spawnErr.message}`);

  const meta = {
    command,
    port: port != null ? Number(port) : null,
    pid: child.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(serverMetaPath(dir), JSON.stringify(meta, null, 2));
  writeFileSync(serverPidPath(dir), String(child.pid));
  appendLog(dir, `Started server \`${command.length > 80 ? command.slice(0, 80) + '…' : command}\` (pid ${child.pid}${port ? `, port ${port}` : ''})`);

  // Report the server's LAN IP, not "localhost" — the browser user is on a
  // different machine than the OE server, so "localhost" resolves to their
  // desktop instead of here and yields connection refused.
  const lanIp = getLanAddress();
  const url = port ? `http://${lanIp}:${port}` : null;
  const urlNote = url ? ` at ${url}` : '';
  return `Started server${urlNote} (pid ${child.pid}). Logs at .run/server.log. Use coder_server_status or coder_stop_server.`;
}

async function stopServer(userId) {
  const dir = getProjectDir(userId);
  const pid = readServerPid(dir);
  if (!pid) return 'No server is running for this project.';
  if (!isPidAlive(pid)) {
    clearServerState(dir);
    return `No running server (pid ${pid} was stale — cleaned up).`;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
  // Grace period; if still alive, SIGKILL.
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!isPidAlive(pid)) break;
  }
  if (isPidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  clearServerState(dir);
  appendLog(dir, `Stopped server (pid ${pid})`);
  return `Stopped server (pid ${pid}).`;
}

async function serverStatus(userId, logLines = 20) {
  const dir = getProjectDir(userId);
  const pid = readServerPid(dir);
  let meta = null;
  try { meta = JSON.parse(readFileSync(serverMetaPath(dir), 'utf8')); } catch {}

  if (!pid || !isPidAlive(pid)) {
    if (pid) clearServerState(dir);
    // Still show tail of previous log if available — often the interesting bit.
    let tail = '';
    try {
      const log = readFileSync(serverLogPath(dir), 'utf8');
      const lines = log.split(/\r?\n/);
      const slice = lines.slice(-Math.max(1, Math.min(logLines, 500)));
      if (slice.some(Boolean)) tail = `\n--- last log lines ---\n${slice.join('\n')}`;
    } catch {}
    return `No server is running for this project.${tail}`;
  }

  const { command = '(unknown)', port = null, startedAt = '(unknown)' } = meta ?? {};
  let tail = '';
  try {
    const log = readFileSync(serverLogPath(dir), 'utf8');
    const lines = log.split(/\r?\n/);
    const slice = lines.slice(-Math.max(1, Math.min(logLines, 500)));
    tail = slice.join('\n');
  } catch {}

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

// Apply a list of {old_string, new_string, replace_all?} edits to a single file
// atomically — every edit must succeed against the staged buffer or nothing is
// written. Mirrors Claude Code's MultiEdit semantics.
async function multiEditProjectFile(filePath, edits, userId) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('edits must be a non-empty array.');
  }
  const dir = getProjectDir(userId);
  const abs = safePath(dir, filePath);
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
  writeFileSync(abs, content);
  appendLog(dir, `Multi-edited \`${filePath}\` (${edits.length} edits)`);
  _mirrorWrite(userId, _activeProject.get(userId), filePath, content);
  return `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${filePath}`;
}

// Project-local TODO list. Lives at <project>/.openensemble/todos.json so it survives
// across turns and is scoped per-project.
function _todosPath(userId) {
  const dir = getProjectDir(userId);
  return path.join(dir, '.openensemble', 'todos.json');
}

function _readTodos(userId) {
  const p = _todosPath(userId);
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')) || []; } catch { return []; }
}

function _renderTodos(todos) {
  if (!todos.length) return '(no todos)';
  const icon = (s) => s === 'completed' ? '✓' : s === 'in_progress' ? '▶' : '○';
  return todos.map(t => `${icon(t.status)} [${t.id}] ${t.content}`).join('\n');
}

async function todoWrite(todos, userId) {
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
  const p = _todosPath(userId);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(todos, null, 2));
  return _renderTodos(todos);
}

async function todoRead(userId) {
  return _renderTodos(_readTodos(userId));
}

async function listFiles(directory, pattern, userId) {
  const dir = getProjectDir(userId);
  const base = directory ? safePath(dir, directory) : dir;
  if (!existsSync(base)) throw new Error(`Directory not found: ${directory ?? '.'}`);

  if (pattern) {
    // Use find with glob-like pattern
    return new Promise((resolve) => {
      execFile('/usr/bin/find', [base, '-name', pattern, '-type', 'f', '-not', '-path', '*/.git/*'],
        { timeout: 10000, maxBuffer: 512 * 1024 },
        (err, stdout) => {
          if (!stdout?.trim()) return resolve('No files matched.');
          const lines = stdout.trim().split('\n').map(f => path.relative(dir, f)).sort();
          resolve(lines.join('\n'));
        });
    });
  }

  // Recursive listing (skip .git, node_modules)
  const results = [];
  async function walk(d, depth = 0) {
    if (depth > 8) return;
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
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

async function searchFiles(pattern, searchPath, glob, userId) {
  const dir = getProjectDir(userId);
  const base = searchPath ? safePath(dir, searchPath) : dir;

  const args = ['--no-heading', '--line-number', '--color', 'never', '-e', pattern];
  if (glob) args.push('--glob', glob);
  args.push(base);

  return new Promise((resolve) => {
    execFile('rg', args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
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
export async function* executeSkillTool(name, args, userId = 'default') {
  if (name === 'coder_run_command') {
    yield* runCommand(args.command, args.timeout, userId);
    return;
  }
  let text;
  try {
    switch (name) {
      case 'coder_list_projects':  text = await listProjects(userId); break;
      case 'coder_create_project': text = await createProject(args.name, userId); break;
      case 'coder_switch_project': text = await switchProject(args.name, userId); break;
      case 'coder_delete_project': text = await deleteProject(args.name, userId); break;
      case 'coder_read_file':      text = await readProjectFile(args.path, args.offset, args.limit, userId); break;
      case 'coder_write_file':     text = await writeProjectFile(args.path, args.content, userId); break;
      case 'coder_edit_file':      text = await editProjectFile(args.path, args.old_string, args.new_string, userId); break;
      case 'coder_multi_edit':     text = await multiEditProjectFile(args.file_path, args.edits, userId); break;
      case 'coder_delete_file':    text = await deleteProjectFile(args.path, userId); break;
      case 'coder_list_files':     text = await listFiles(args.directory, args.pattern, userId); break;
      case 'coder_search':         text = await searchFiles(args.pattern, args.path, args.glob, userId); break;
      case 'coder_todo_write':     text = await todoWrite(args.todos, userId); break;
      case 'coder_todo_read':      text = await todoRead(userId); break;
      case 'coder_start_server':   text = await startServer(args.command, args.port, userId); break;
      case 'coder_stop_server':    text = await stopServer(userId); break;
      case 'coder_server_status':  text = await serverStatus(userId, args.lines); break;
      default: text = null;
    }
  } catch (e) {
    text = `Error: ${e.message}`;
  }
  yield { type: 'result', text: String(text ?? '') };
}

export default executeSkillTool;
