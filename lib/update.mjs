/**
 * Self-update module — checks origin for new commits, applies fast-forward
 * pulls, runs npm install if dependencies changed, and triggers a graceful
 * restart via the same detached-child pattern used by /api/admin/restart.
 *
 * Refuses to update when the working tree is dirty or has unpushed commits;
 * never auto-stashes, never resets --hard. Designed for end-user installs
 * that are clean clones of the OpenEnsemble repo.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { log } from '../logger.mjs';
import { ensureRestartContinuationForCurrentTurn } from './restart-continuation.mjs';
import { verifyFirmwareAssets } from './firmware-assets.mjs';
import {
  dependencyFingerprint,
  markDependencyStateUncertain,
  recordInstalledDependencyState,
} from './dependency-state.mjs';

const BASE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GIT_DIR  = path.join(BASE_DIR, '.git');

// Cached state read by /api/admin/health and /api/admin/update/status.
let _state = {
  enabled: true,           // false if .git missing or `git` not on PATH
  currentSha: null,
  remoteSha: null,
  available: false,        // remoteSha differs from currentSha and is reachable
  lastCheckedAt: null,
  checking: false,
  error: null,             // last non-fatal error string (network, etc.)
};

let _checkInFlight  = null;
let _applyInFlight  = false;
let _intervalHandle = null;
let _onAvailableCb  = null;
let _lastBroadcastedRemoteSha = null;  // de-dupe transitions

// ── Process helpers ─────────────────────────────────────────────────────────
function runGit(args, { timeoutMs = 30_000 } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', timed = false;
    let proc;
    try {
      proc = spawn('git', args, { cwd: BASE_DIR, env: process.env });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message });
    }
    const timer = setTimeout(() => {
      timed = true;
      try { proc.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), timedOut: timed });
    });
    proc.on('error', e => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: e.message });
    });
  });
}

/**
 * Resolve npm from the same installation as the Node binary running OE.
 *
 * systemd units intentionally pin ExecStart to an absolute Node binary (often
 * one managed by nvm), while the user manager's PATH commonly omits that
 * binary's directory. Spawning a bare `npm` in that environment makes an
 * otherwise valid in-app update fail with ENOENT. Prefer Node's sibling npm and
 * prepend that directory to PATH so npm's lifecycle children can also find
 * Node. Fall back to PATH for distro layouts that do not colocate the two.
 */
export function resolveNpmInvocation(nodeExecPath = process.execPath, baseEnv = process.env) {
  const nodeDir = path.dirname(nodeExecPath);
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const localNpm = path.join(nodeDir, npmName);
  const cmd = fs.existsSync(localNpm) ? localNpm : npmName;
  const env = {
    ...baseEnv,
    PATH: `${nodeDir}${path.delimiter}${baseEnv.PATH || ''}`,
  };
  return { cmd, env };
}

function appendBounded(current, chunk, maxBytes = 4 * 1024 * 1024) {
  const next = current + chunk.toString();
  return next.length <= maxBytes ? next : next.slice(-maxBytes);
}

export function runNpmInstall({ timeoutMs = 30 * 60_000, invocation = null } = {}) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false, spawned = false, timedOut = false;
    let proc;
    const { cmd, env } = invocation || resolveNpmInvocation();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ stdout, stderr, spawned, timedOut, ...result });
    };
    try {
      proc = spawn(cmd, ['install', '--omit=dev', '--no-save', '--no-audit', '--no-fund'], {
        cwd: BASE_DIR,
        env,
        shell: process.platform === 'win32',
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message, spawned: false, timedOut: false });
      return;
    }
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    proc.once('spawn', () => { spawned = true; });
    proc.stdout.on('data', d => { stdout = appendBounded(stdout, d); });
    proc.stderr.on('data', d => { stderr = appendBounded(stderr, d); });
    proc.once('close', (code, signal) => finish({ code, signal }));
    proc.once('error', error => finish({ code: -1, signal: null, stderr: appendBounded(stderr, error.message) }));
  });
}

export function dependencyInputsChanged(beforeFingerprint, afterFingerprint) {
  // A missing fingerprint means we could not prove the inputs are unchanged.
  // Conservatively reconcile dependencies rather than restarting into a
  // potentially incomplete tree.
  return !beforeFingerprint || !afterFingerprint || beforeFingerprint !== afterFingerprint;
}

function trackedStatusLines(stdout) {
  if (!stdout) return [];
  return stdout.split('\n').filter(Boolean);
}

function statusLinePath(line) {
  // `git status --porcelain=v1` reserves the first two columns for status and
  // the third for a separator. package-lock.json contains no quoting-sensitive
  // characters, so an exact comparison is reliable for the only path we allow.
  // runGit trims the complete stdout string, so the leading space on the first
  // unstaged-only entry (` M path`) may arrive as `M path`. Account for both
  // that representation and the normal two-column porcelain form.
  if (line.length >= 3 && line[2] === ' ') return line.slice(3);
  if (line.length >= 2 && line[1] === ' ') return line.slice(2);
  return '';
}

async function verifyExpectedCleanHead(expectedSha) {
  const currentSha = await getCurrentSha();
  if (currentSha !== expectedSha) {
    return {
      ok: false,
      code: 'HEAD_MOVED',
      message: `HEAD changed during update (expected ${expectedSha}, found ${currentSha || 'unknown'}).`,
    };
  }
  const status = await runGit(['status', '--porcelain=v1', '-uno']);
  if (status.code !== 0) {
    return { ok: false, code: 'GIT_ERROR', message: status.stderr || 'git status failed' };
  }
  const changes = trackedStatusLines(status.stdout);
  if (changes.length) {
    return {
      ok: false,
      code: 'WORKTREE_CHANGED',
      message: `Tracked files changed while the update was running: ${changes.slice(0, 5).map(statusLinePath).join(', ')}`,
      changes,
    };
  }
  return { ok: true };
}

/**
 * npm versions/platforms occasionally rewrite package-lock.json even when the
 * committed lock is usable. The update began from a clean tree, so an
 * otherwise-clean post-install tree with only an unstaged package-lock change
 * is npm drift and can be restored to the target commit. Any other tracked
 * change is treated as concurrent user activity and left untouched.
 */
async function restoreNpmOnlyLockfileDrift(expectedSha) {
  const currentSha = await getCurrentSha();
  if (currentSha !== expectedSha) {
    return {
      ok: false,
      code: 'HEAD_MOVED',
      message: `HEAD changed during dependency installation (expected ${expectedSha}, found ${currentSha || 'unknown'}).`,
    };
  }

  const status = await runGit(['status', '--porcelain=v1', '-uno']);
  if (status.code !== 0) {
    return { ok: false, code: 'GIT_ERROR', message: status.stderr || 'git status failed' };
  }
  const changes = trackedStatusLines(status.stdout);
  if (!changes.length) return { ok: true, restored: false };

  const lockOnly = changes.every(line => statusLinePath(line) === 'package-lock.json');
  const lockPath = path.join(BASE_DIR, 'package-lock.json');
  if (!lockOnly || !fs.existsSync(lockPath)) {
    return {
      ok: false,
      code: 'WORKTREE_CHANGED',
      message: `Tracked files changed during dependency installation: ${changes.slice(0, 5).map(statusLinePath).join(', ')}`,
      changes,
    };
  }

  // Checkout from the index rather than reset --hard. A staged/concurrent edit
  // remains staged and is caught by the clean verification below.
  const restore = await runGit(['checkout', '--', 'package-lock.json']);
  if (restore.code !== 0) {
    return { ok: false, code: 'GIT_ERROR', message: restore.stderr || 'Could not restore package-lock.json' };
  }
  const clean = await verifyExpectedCleanHead(expectedSha);
  if (!clean.ok) return clean;
  log.info('update', 'Restored npm-only package-lock.json drift to committed version', { expectedSha });
  return { ok: true, restored: true };
}

function recordDependencyInstall(source) {
  try {
    recordInstalledDependencyState({ source, missing: [] }, BASE_DIR);
    return true;
  } catch (error) {
    // Dependencies are already installed. A missing marker only causes the
    // pre-start checker to reconcile again, so this is safe to treat as
    // best-effort rather than stranding an otherwise valid update.
    log.warn('update', 'Could not record installed dependency fingerprint', { error: error.message });
    return false;
  }
}

function invalidateDependencyInstall(source) {
  try {
    markDependencyStateUncertain({
      source,
      reason: 'Dependency installation started but has not completed successfully.',
    }, BASE_DIR);
    return true;
  } catch (error) {
    log.warn('update', 'Could not invalidate the installed dependency fingerprint', { error: error.message });
    return false;
  }
}

async function rollbackFailedDependencyUpdate({
  fromSha,
  toSha,
  failedInstall,
  broadcast = null,
  forced = false,
}) {
  if (broadcast) broadcast({ type: 'update_applying', stage: 'rolling_back', fromSha, toSha, ts: Date.now() });
  log.warn('update', 'Dependency install failed; attempting guarded rollback', { fromSha, toSha });

  // First discard only the one tracked file npm itself is allowed to have
  // changed. If anything else moved, refuse rollback rather than destroying a
  // concurrent user edit.
  const drift = await restoreNpmOnlyLockfileDrift(toSha);
  if (!drift.ok) {
    return {
      attempted: true,
      complete: false,
      sourceRestored: false,
      dependenciesRestored: false,
      preUpdateLocalChangesRestored: !forced,
      code: drift.code,
      message: `Automatic rollback refused: ${drift.message}`,
    };
  }

  const clean = await verifyExpectedCleanHead(toSha);
  if (!clean.ok) {
    return {
      attempted: true,
      complete: false,
      sourceRestored: false,
      dependenciesRestored: false,
      preUpdateLocalChangesRestored: !forced,
      code: clean.code,
      message: `Automatic rollback refused: ${clean.message}`,
    };
  }

  // --keep preserves any worktree change that races the final verification and
  // aborts if switching commits would overwrite it. Never escalate to --hard.
  const reset = await runGit(['reset', '--keep', fromSha], { timeoutMs: 30_000 });
  if (reset.code !== 0 || await getCurrentSha() !== fromSha) {
    return {
      attempted: true,
      complete: false,
      sourceRestored: false,
      dependenciesRestored: false,
      preUpdateLocalChangesRestored: !forced,
      code: 'ROLLBACK_FAILED',
      message: reset.stderr || 'git reset --keep did not restore the previous revision',
    };
  }

  try { refreshOeWrapper(); }
  catch (error) { log.warn('update', 'oe wrapper refresh after rollback failed', { error: error.message }); }

  // ENOENT means npm never started and therefore could not have changed
  // node_modules. Other failures may be partial, so reconcile against the old
  // manifest/lock before declaring rollback complete.
  let dependenciesRestored = !failedInstall.spawned;
  let repair = null;
  if (dependenciesRestored) {
    recordDependencyInstall('in-app-update-rollback');
  } else {
    repair = await runNpmInstall();
    if (repair.code === 0 && !repair.timedOut) {
      const repairDrift = await restoreNpmOnlyLockfileDrift(fromSha);
      dependenciesRestored = repairDrift.ok;
      if (dependenciesRestored) recordDependencyInstall('in-app-update-rollback');
    }
  }

  _state.currentSha = fromSha;
  _state.remoteSha = toSha;
  _state.available = true;
  _state.lastCheckedAt = Date.now();

  return {
    attempted: true,
    complete: dependenciesRestored,
    sourceRestored: true,
    dependenciesRestored,
    preUpdateLocalChangesRestored: !forced,
    code: dependenciesRestored ? null : 'DEPENDENCY_ROLLBACK_FAILED',
    message: dependenciesRestored
      ? `Previous committed source and dependency state restored.${forced ? ' Local changes explicitly discarded by Force update cannot be recovered.' : ''}`
      : `Previous committed source restored, but dependency repair failed${repair?.timedOut ? ' (timed out)' : ''}.${forced ? ' Local changes explicitly discarded by Force update cannot be recovered.' : ''}`,
  };
}

async function installDependenciesForUpdate({ fromSha, toSha, broadcast = null, source, forced = false }) {
  const ready = await verifyExpectedCleanHead(toSha);
  if (!ready.ok) {
    return {
      ok: false,
      code: ready.code,
      message: `${ready.message} Dependencies were not changed and the server was not restarted.`,
    };
  }

  if (broadcast) broadcast({ type: 'update_applying', stage: 'npm_install', fromSha, toSha, ts: Date.now() });
  // npm can leave a partially-mutated node_modules tree even when it exits
  // non-zero. Invalidate the last good marker before spawning it; only a
  // verified successful install (or rollback repair) marks the tree healthy.
  invalidateDependencyInstall(source);
  const npm = await runNpmInstall();
  if (npm.code !== 0 || npm.timedOut) {
    log.error('update', 'npm install failed after source update', {
      code: npm.code,
      signal: npm.signal,
      timedOut: npm.timedOut,
      stderr: npm.stderr.slice(-2000),
    });
    const rollback = await rollbackFailedDependencyUpdate({
      fromSha,
      toSha,
      failedInstall: npm,
      broadcast,
      forced,
    });
    const rollbackMessage = rollback.complete
      ? `${rollback.message} The server was not restarted.`
      : `${rollback.message} The server was not restarted; inspect the working tree and run npm install manually before restarting.`;
    return {
      ok: false,
      code: 'NPM_FAILED',
      message: `npm install failed${npm.timedOut ? ' (timed out)' : ''}. ${rollbackMessage}`,
      rollback,
    };
  }

  const drift = await restoreNpmOnlyLockfileDrift(toSha);
  if (!drift.ok) {
    log.error('update', 'Dependency install succeeded but tracked tree changed concurrently', {
      code: drift.code,
      message: drift.message,
    });
    return {
      ok: false,
      code: drift.code,
      message: `${drift.message} Dependencies installed, but the server was not restarted so no concurrent edit is overwritten.`,
    };
  }

  recordDependencyInstall(source);
  return { ok: true, npm };
}

// Render scripts/oe-cli.template.sh → ~/.local/bin/oe with __INSTALL_DIR__
// substituted to BASE_DIR. Atomic via rename so an in-flight `oe ...` call
// won't see a half-written file. No-op if the template or target dir is
// missing (zip installs, hand-placed binaries, packaged distros).
function refreshOeWrapper() {
  const template = path.join(BASE_DIR, 'scripts', 'oe-cli.template.sh');
  if (!fs.existsSync(template)) return;
  const home = process.env.HOME;
  if (!home) return;
  const targetDir = path.join(home, '.local', 'bin');
  const target = path.join(targetDir, 'oe');
  if (!fs.existsSync(targetDir)) return;
  // Only rewrite if the existing wrapper looks like ours (has the marker
  // line). Avoids clobbering a user's hand-rolled script that happens to
  // be named `oe`.
  if (fs.existsSync(target)) {
    const head = fs.readFileSync(target, 'utf8').slice(0, 200);
    if (!/OpenEnsemble server CLI/.test(head)) return;
  }
  const rendered = fs.readFileSync(template, 'utf8')
    .replace(/__INSTALL_DIR__/g, BASE_DIR);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, rendered, { mode: 0o755 });
  fs.renameSync(tmp, target);
  log.info('update', 'oe wrapper refreshed', { target });
}

/** Verify that the just-updated checkout contains its tracked firmware bundle. */
function verifyBundledFirmware() {
  try {
    const r = verifyFirmwareAssets();
    if (!r.ok) log.warn('update', 'bundled firmware is missing or corrupt after pull', { failures: r.failures });
  } catch (e) {
    log.warn('update', 'firmware bundle verification failed', { error: e.message });
  }
}

function classifyGitError(stderr) {
  const s = (stderr || '').toLowerCase();
  if (!s) return 'GIT_ERROR';
  if (s.includes('could not resolve host') || s.includes('network is unreachable') ||
      s.includes('connection refused')      || s.includes('connection timed out') ||
      s.includes('temporary failure in name resolution')) return 'NO_NETWORK';
  if (s.includes('authentication failed') || s.includes('permission denied') ||
      s.includes('could not read username') || s.includes('terminal prompts disabled')) return 'AUTH_FAILED';
  if (s.includes('not possible to fast-forward') || s.includes('not a fast-forward') ||
      s.includes('refusing to merge unrelated histories'))                          return 'DIVERGED';
  return 'GIT_ERROR';
}

// ── Public state accessors ──────────────────────────────────────────────────
export function getCachedState() {
  return { ..._state };
}

export async function getCurrentSha() {
  const r = await runGit(['rev-parse', 'HEAD']);
  if (r.code !== 0) return null;
  return r.stdout || null;
}

export async function getRemoteSha(remote = 'origin') {
  const r = await runGit(['ls-remote', remote, 'HEAD']);
  if (r.code !== 0) return { sha: null, error: classifyGitError(r.stderr), stderr: r.stderr };
  const first = (r.stdout.split('\n')[0] || '').trim();
  const sha = first.split(/\s+/)[0] || null;
  return { sha: sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null, error: null };
}

export async function isCleanForUpdate(remote = 'origin') {
  // -uno: ignore untracked files. Only modifications to tracked files would
  // conflict with a fast-forward merge; stray logs, editor swap files, and
  // user-created scripts in the install dir are harmless.
  const status = await runGit(['status', '--porcelain', '-uno']);
  const dirty = status.code === 0 && status.stdout.length > 0;
  // Parse the porcelain output into [{ status: 'M', path: 'file' }] so the UI
  // can show users exactly which tracked files were modified — telling them
  // to "run git status" is a dead end for non-developers.
  const dirtyFiles = dirty
    ? status.stdout.split('\n').map(line => {
        const m = line.match(/^\s*(\S{1,2})\s+(.+)$/);
        return m ? { status: m[1], path: m[2] } : null;
      }).filter(Boolean)
    : [];
  const unpushedRes = await runGit(['rev-list', '--count', `HEAD`, '--not', `--remotes=${remote}`]);
  const unpushed = unpushedRes.code === 0 ? parseInt(unpushedRes.stdout, 10) || 0 : 0;
  let reason = null;
  if (dirty) {
    const sample = dirtyFiles.slice(0, 5).map(f => f.path).join(', ');
    const more = dirtyFiles.length > 5 ? ` and ${dirtyFiles.length - 5} more` : '';
    reason = `Local changes to ${dirtyFiles.length} tracked file${dirtyFiles.length === 1 ? '' : 's'} (${sample}${more}). Use "Force update" to discard them and pull anyway, or resolve manually.`;
  }
  else if (unpushed > 0) reason = `Local commits not on ${remote} — update blocked. Push or remove them first.`;
  return { clean: !dirty && unpushed === 0, dirty, unpushed, reason, dirtyFiles };
}

/**
 * Force-update path: discards uncommitted changes to tracked files (`git
 * reset --hard origin/HEAD` + `git clean -fd`), then runs the normal apply
 * flow. Privileged + explicit-confirm only — irreversibly destroys local
 * changes. Designed for the "fresh install dirtied package-lock.json or
 * line-endings on a tracked file" recovery case where the user has no
 * intentional local edits.
 *
 * Untracked files OUTSIDE common protected dirs (config.json, users/,
 * sessions/, etc. — already in .gitignore so unaffected) are removed by
 * `git clean -fd`. The .gitignore rules protect user data.
 */
export async function forceApplyUpdate({
  remote = 'origin',
  broadcast = null,
  restart = true,
} = {}) {
  if (_applyInFlight) return { ok: false, code: 'BUSY', message: 'An update is already in progress.' };
  _applyInFlight = true;
  try {
    if (!gitAvailable())
      return { ok: false, code: 'NO_GIT', message: 'Not a git repository — auto-update unavailable.' };

    const fromSha = await getCurrentSha();
    if (!fromSha) return { ok: false, code: 'NO_GIT', message: 'git rev-parse HEAD failed' };

    log.warn('update', 'force-update: discarding local changes', { fromSha });
    if (broadcast) broadcast({ type: 'update_applying', stage: 'force_reset', fromSha, ts: Date.now() });

    const fetchRes = await runGit(['fetch', remote, '--prune'], { timeoutMs: 60_000 });
    if (fetchRes.code !== 0) {
      const code = classifyGitError(fetchRes.stderr);
      return { ok: false, code, message: fetchRes.stderr || 'git fetch failed' };
    }

    // Hard-reset to remote HEAD — wipes any modifications to tracked files.
    const resetRes = await runGit(['reset', '--hard', `${remote}/HEAD`], { timeoutMs: 30_000 });
    if (resetRes.code !== 0) {
      return { ok: false, code: 'GIT_ERROR', message: resetRes.stderr || 'git reset failed' };
    }
    // Remove untracked files in tracked dirs (stale .part downloads, editor
    // backups, etc.). .gitignore'd dirs (users/, sessions/, models/, config*)
    // are unaffected.
    const cleanRes = await runGit(['clean', '-fd'], { timeoutMs: 30_000 });
    if (cleanRes.code !== 0) {
      log.warn('update', 'git clean -fd had non-zero exit', { stderr: cleanRes.stderr });
      // Non-fatal — reset already succeeded, code is current.
    }

    const toSha = await getCurrentSha();
    if (!toSha) {
      return { ok: false, code: 'GIT_ERROR', message: 'Force-update reset succeeded, but the new HEAD could not be read. Server not restarted.' };
    }
    log.info('update', 'force-update: hard-reset complete', { fromSha, toSha });

    try { refreshOeWrapper(); }
    catch (e) { log.warn('update', 'oe wrapper refresh failed', { error: e.message }); }

    // The images are tracked, so the reset above restores them without a
    // separate release download. Verify packaging before restart.
    verifyBundledFirmware();

    // Force-update always reconciles dependencies. Besides repairing a dirty
    // lockfile, this closes the gap for an earlier update that pulled source
    // successfully but could not run npm.
    let npmRan = false;
    if (fs.existsSync(path.join(BASE_DIR, 'package.json'))) {
      npmRan = true;
      const installed = await installDependenciesForUpdate({
        fromSha,
        toSha,
        broadcast,
        source: 'in-app-force-update',
        forced: true,
      });
      if (!installed.ok) return { ...installed, fromSha, toSha, npmRan, forced: true };
    }

    _state.currentSha = toSha;
    _state.remoteSha = toSha;
    _state.available = false;
    _state.lastCheckedAt = Date.now();

    if (restart) {
      if (broadcast) broadcast({ type: 'update_applying', stage: 'restarting', fromSha, toSha, ts: Date.now() });
      setImmediate(() => {
        const accepted = restartProcess({
          reason: 'Force-apply OE self-update',
          op: 'oe_update_apply',
        });
        if (!accepted) {
          log.error('update', 'Update installed but restart could not be initiated', { fromSha, toSha, forced: true });
          if (broadcast) broadcast({
            type: 'update_failed',
            code: 'RESTART_FAILED',
            message: 'Update installed, but the server could not initiate its restart. Restart OpenEnsemble manually.',
            forced: true,
            ts: Date.now(),
          });
        }
      });
    }
    return { ok: true, fromSha, toSha, npmRan, forced: true };
  } finally {
    _applyInFlight = false;
  }
}

// ── Update detection ────────────────────────────────────────────────────────
function gitAvailable() {
  return _state.enabled && fs.existsSync(GIT_DIR);
}

async function gitBinaryPresent() {
  const r = await runGit(['--version'], { timeoutMs: 3000 });
  return r.code === 0;
}

export async function checkForUpdate({ remote = 'origin' } = {}) {
  if (_checkInFlight) return _checkInFlight;
  _state.checking = true;
  _checkInFlight = (async () => {
    try {
      if (!gitAvailable()) {
        _state.error = 'Not a git repo';
        return _state;
      }
      const [current, remoteRes] = await Promise.all([getCurrentSha(), getRemoteSha(remote)]);
      _state.currentSha   = current;
      _state.remoteSha    = remoteRes.sha ?? _state.remoteSha;
      _state.lastCheckedAt = Date.now();
      _state.error        = remoteRes.error || null;
      const wasAvailable  = _state.available;
      _state.available    = !!(current && remoteRes.sha && current !== remoteRes.sha);

      if (_state.available && !wasAvailable && _onAvailableCb &&
          remoteRes.sha !== _lastBroadcastedRemoteSha) {
        _lastBroadcastedRemoteSha = remoteRes.sha;
        try { _onAvailableCb({ ..._state }); } catch (e) {
          log.warn('update', 'onAvailable callback threw', { error: e.message });
        }
      }
      return _state;
    } finally {
      _state.checking = false;
      _checkInFlight = null;
    }
  })();
  return _checkInFlight;
}

// ── Apply update ────────────────────────────────────────────────────────────
/**
 * Pull + (optional) npm install + restart. Returns:
 *   { ok: true, fromSha, toSha, npmRan }
 * or on failure:
 *   { ok: false, code: 'DIRTY'|'DIVERGED'|'NO_GIT'|'NO_NETWORK'|'AUTH_FAILED'|'NPM_FAILED', message }
 *
 * `broadcast` is an optional callback invoked with WS-shaped messages so the
 * caller can push progress to admin browsers.
 */
export async function applyUpdate({
  remote = 'origin',
  broadcast = null,
  restart = true,
} = {}) {
  if (_applyInFlight) return { ok: false, code: 'BUSY', message: 'An update is already in progress.' };
  _applyInFlight = true;
  try {
    if (!gitAvailable())
      return { ok: false, code: 'NO_GIT', message: 'Not a git repository — auto-update unavailable.' };

    const fromSha = await getCurrentSha();
    if (!fromSha) return { ok: false, code: 'NO_GIT', message: 'git rev-parse HEAD failed' };

    const cleanCheck = await isCleanForUpdate(remote);
    if (!cleanCheck.clean) {
      return {
        ok: false,
        code: cleanCheck.dirty ? 'DIRTY' : 'DIVERGED',
        message: cleanCheck.reason,
      };
    }

    // Fingerprint both dependency inputs. package-lock-only changes (for
    // example a transitive security update) must reach existing installations
    // just as reliably as a newly-added top-level package.
    let dependenciesBefore;
    try {
      dependenciesBefore = dependencyFingerprint(BASE_DIR);
    } catch (error) {
      return {
        ok: false,
        code: 'DEPENDENCY_STATE_FAILED',
        message: `Could not read dependency manifests before update: ${error.message}`,
      };
    }

    log.info('update', 'Fetching from remote', { remote, fromSha });
    const fetchRes = await runGit(['fetch', remote, '--prune'], { timeoutMs: 60_000 });
    if (fetchRes.code !== 0) {
      const code = classifyGitError(fetchRes.stderr);
      log.warn('update', 'git fetch failed', { code, stderr: fetchRes.stderr });
      return { ok: false, code, message: fetchRes.stderr || 'git fetch failed' };
    }

    // Fast-forward only — refuses to silently merge divergent histories.
    log.info('update', 'Merging --ff-only', { remote });
    const mergeRes = await runGit(['merge', '--ff-only', `${remote}/HEAD`], { timeoutMs: 60_000 });
    if (mergeRes.code !== 0) {
      const code = classifyGitError(mergeRes.stderr) || 'DIVERGED';
      log.warn('update', 'git merge --ff-only failed', { code, stderr: mergeRes.stderr });
      return { ok: false, code, message: mergeRes.stderr || 'merge failed' };
    }

    const toSha = await getCurrentSha();
    if (!toSha) {
      return { ok: false, code: 'GIT_ERROR', message: 'Update merged, but the new HEAD could not be read. Server not restarted.' };
    }
    log.info('update', 'Pull successful', { fromSha, toSha });

    // Refresh the ~/.local/bin/oe wrapper from the versioned template so new
    // subcommands shipped in this pull (e.g., `oe bench`) are reachable
    // without forcing the user to re-run install.sh. Best-effort: any failure
    // is logged but does not abort the update.
    try { refreshOeWrapper(); }
    catch (e) { log.warn('update', 'oe wrapper refresh failed', { error: e.message }); }

    // Firmware ships in this checkout. Verify it before restarting so a bad
    // release is visible in the update log instead of failing mid-flash.
    verifyBundledFirmware();

    let dependenciesAfter = null;
    try {
      dependenciesAfter = dependencyFingerprint(BASE_DIR);
    } catch (error) {
      // Conservatively run npm if the post-pull fingerprint cannot be read.
      // npm will produce the actionable failure and guarded rollback path.
      log.warn('update', 'Could not fingerprint dependency manifests after pull; reconciling conservatively', {
        error: error.message,
      });
    }
    const dependenciesChanged = dependencyInputsChanged(dependenciesBefore, dependenciesAfter);
    let npmRan = false;
    if (dependenciesChanged) {
      log.info('update', 'Dependency manifest or lockfile changed — running npm install', {});
      npmRan = true;
      const installed = await installDependenciesForUpdate({
        fromSha,
        toSha,
        broadcast,
        source: 'in-app-update',
      });
      if (!installed.ok) return { ...installed, fromSha, toSha, npmRan };
    }

    // Refresh cached state so the UI reflects the new SHA before restart.
    _state.currentSha   = toSha;
    _state.remoteSha    = toSha;
    _state.available    = false;
    _state.lastCheckedAt = Date.now();

    if (restart) {
      if (broadcast) broadcast({ type: 'update_applying', stage: 'restarting', fromSha, toSha, ts: Date.now() });
      setImmediate(() => {
        const accepted = restartProcess({
          reason: 'Apply OE self-update',
          op: 'oe_update_apply',
        });
        if (!accepted) {
          log.error('update', 'Update installed but restart could not be initiated', { fromSha, toSha });
          if (broadcast) broadcast({
            type: 'update_failed',
            code: 'RESTART_FAILED',
            message: 'Update installed, but the server could not initiate its restart. Restart OpenEnsemble manually.',
            ts: Date.now(),
          });
        }
      });
    }
    return { ok: true, fromSha, toSha, npmRan };
  } finally {
    _applyInFlight = false;
  }
}

/**
 * Restart the running server. Two paths depending on launch context:
 *
 *   - Under systemd (INVOCATION_ID set): just SIGTERM ourselves and let
 *     systemd's `Restart=always` (or on-success) bring us back. The old
 *     detached-child respawn pattern was incompatible with the unit's
 *     `KillMode=control-group`, which kills the detached child as part of
 *     unit shutdown — net effect was "shut down, never restart". Systemd's
 *     own Restart= is the correct primitive.
 *
 *   - Standalone (no systemd): spawn a detached child that sleeps briefly
 *     so the parent releases port 3737, then re-execs the current node
 *     command, then SIGTERM ourselves.
 */
export function restartProcess({
  reason = 'OE server restart requested by the active task',
  op = 'restart_server',
} = {}) {
  // Agent-triggered restarts must never strand the turn that requested them.
  // AsyncLocalStorage survives the setImmediate/setTimeout scheduling used by
  // every sanctioned restart path, so this guard can bind the durable handoff
  // to the initiating user/session without accepting identity from tool args.
  // Admin UI and external lifecycle restarts have no active chat turn and are
  // intentionally unaffected.
  try {
    const checkpoint = ensureRestartContinuationForCurrentTurn({ reason, op });
    if (checkpoint?.op === 'oe_update_apply' && checkpoint.state === 'prepared') {
      log.error('update', 'restart cancelled: OE update checkpoint is not armed', {
        checkpointId: checkpoint.id,
      });
      return false;
    }
  } catch (error) {
    log.error('update', 'restart cancelled: continuation checkpoint failed', {
      error: String(error?.message || error).slice(0, 500),
    });
    return false;
  }

  // INVOCATION_ID is set on every systemd-managed process. SYSTEMD_EXEC_PID
  // is set on newer systemd. Either presence means we're under systemd.
  const underSystemd = !!(process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID);

  if (underSystemd) {
    log.info('update', 'restart: SIGTERM self; systemd Restart= will respawn');
    // Bigger delay than the prior 200ms — slow tunnels (Cloudflare, ngrok)
    // can take that long for a small JSON response to traverse the client
    // path. If we SIGTERM before the response reaches the browser, the
    // SPA's `await fetch` throws a network error and the user-visible
    // restart-button flow shows "Restart failed" even though the server
    // is restarting fine in the background.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 800);
    return true;
  }

  try {
    const nodeBin = process.execPath;
    const entry = process.argv[1] || path.join(BASE_DIR, 'server.mjs');
    const args = process.argv.slice(2);
    const cmd = [nodeBin, entry, ...args]
      .map(s => `'${String(s).replace(/'/g, `'\\''`)}'`).join(' ');
    const child = spawn('sh', ['-c',
      `sleep 2 && cd '${BASE_DIR.replace(/'/g, `'\\''`)}' && exec ${cmd}`,
    ], {
      cwd: BASE_DIR, detached: true, stdio: 'ignore',
    });
    child.unref();
  } catch (e) {
    log.error('update', 'Failed to spawn restart child', { error: e.message });
    return false;
  }
  process.kill(process.pid, 'SIGTERM');
  return true;
}

// ── Background checker ──────────────────────────────────────────────────────
/**
 * Start the periodic update check. Returns a stop() function.
 *
 *   onAvailable({currentSha, remoteSha, ...}) is invoked once per transition
 *   from "no update" → "update available", so we don't broadcast every hour.
 */
export function startUpdateChecker({ intervalMs, remote = 'origin', enabled = true, onAvailable } = {}) {
  // Cleanly absorb a re-call (e.g., config reload).
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
  _onAvailableCb = onAvailable || null;

  // Refresh the oe wrapper at boot. Closes the upgrade gap for users whose
  // currently-deployed wrapper predates the template (its `update` case
  // doesn't render scripts/oe-cli.template.sh). Their first `oe update` pulls
  // the new template + restarts the server; this hook then renders it so the
  // wrapper picks up new subcommands without a re-install.
  try { refreshOeWrapper(); }
  catch (e) { log.warn('update', 'oe wrapper refresh at boot failed', { error: e.message }); }

  if (!fs.existsSync(GIT_DIR)) {
    _state.enabled = false;
    _state.error = 'Install was not a git clone — auto-update unavailable. Re-install via `git clone` to enable.';
    log.info('update', 'Auto-update disabled: not a git repo (zip install?)', {});
    return () => {};
  }
  _state.enabled = true;

  if (!enabled) {
    log.info('update', 'Auto-update polling disabled by config', {});
    return () => {};
  }

  // Probe for the `git` binary asynchronously; if it's missing, disable
  // ourselves and surface a useful error in the UI without blocking startup.
  gitBinaryPresent().then(ok => {
    if (!ok) {
      _state.enabled = false;
      _state.error = '`git` binary not found on PATH — install git to enable auto-update';
      log.warn('update', 'Auto-update disabled: git binary missing', {});
      if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
    }
  }).catch(() => {});

  const ms = Math.max(60_000, intervalMs || 3_600_000);
  log.info('update', 'Auto-update checker started', { intervalMs: ms, remote });

  // Kick one off shortly after startup so the dashboard isn't blank.
  const initialTimer = setTimeout(() => {
    if (!_state.enabled) return;
    checkForUpdate({ remote }).catch(e => log.warn('update', 'Initial check failed', { error: e.message }));
  }, 10_000);
  initialTimer.unref();

  _intervalHandle = setInterval(() => {
    if (!_state.enabled) return;
    checkForUpdate({ remote }).catch(e => log.warn('update', 'Periodic check failed', { error: e.message }));
  }, ms);
  _intervalHandle.unref?.();

  return () => {
    clearTimeout(initialTimer);
    if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
    log.info('update', 'Auto-update checker stopped', {});
  };
}
