#!/usr/bin/env node
/**
 * Self-heal a stale systemd unit.
 *
 * The boot-safety scripts (ensure-deps.mjs, launch.mjs) ship via `git pull`,
 * but a unit written by an OLDER install.sh still runs `node server.mjs`
 * directly and never invokes them — so on an existing box they sit unused. The
 * `oe` CLI wrapper already dodges this by being re-rendered from a versioned
 * template at boot; this does the equivalent for the systemd unit.
 *
 * It PATCHES, rather than regenerates, to stay safe: it reads the installed
 * unit, changes only the ExecStart target (…/server.mjs → …/scripts/launch.mjs)
 * and adds the ensure-deps ExecStartPre if absent, preserving every other line
 * (the user's node path, cleanup pre-steps, env, kill settings) byte-for-byte.
 * It writes atomically and NEVER restarts — the change takes effect on the next
 * restart. If anything is unexpected it leaves the unit untouched.
 *
 * Called best-effort from server.mjs at boot; also runnable directly to repair
 * a unit by hand: `node scripts/heal-service-unit.mjs`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR_DEFAULT = path.resolve(SCRIPTS_DIR, '..');

export function defaultUnitPath() {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'openensemble.service');
}

/**
 * Patch a stale unit's ExecStart/ExecStartPre in place.
 * @returns {{changed:boolean, reason?:string, unitPath:string}}
 */
export function healServiceUnit({ unitPath = defaultUnitPath(), installDir = INSTALL_DIR_DEFAULT, reload = true } = {}) {
  if (!fs.existsSync(unitPath)) {
    return { changed: false, reason: 'no unit file', unitPath };
  }

  let content;
  try { content = fs.readFileSync(unitPath, 'utf8'); }
  catch (e) { return { changed: false, reason: `unreadable: ${e.message}`, unitPath }; }

  const lines = content.split('\n');
  const execStartIdx = lines.findIndex((l) => /^\s*ExecStart\s*=/.test(l));
  if (execStartIdx === -1) {
    return { changed: false, reason: 'no ExecStart line', unitPath };
  }

  const execStart = lines[execStartIdx];
  // ExecStart=<nodeBin> <target> [args…]. Preserve the exact node binary the
  // unit already uses (may differ from ours), so we only touch the target.
  const m = execStart.match(/^(\s*ExecStart\s*=\s*)(\S+)\s+(\S+)(.*)$/);
  if (!m) {
    return { changed: false, reason: 'unrecognized ExecStart format', unitPath };
  }
  const [, prefix, nodeBin, target, tail] = m;

  const launchTarget = path.join(installDir, 'scripts', 'launch.mjs');
  const ensureTarget = path.join(installDir, 'scripts', 'ensure-deps.mjs');

  // A unit runs with WorkingDirectory=installDir, so a relative ExecStart
  // target resolves against installDir, not our CWD.
  const resolvedTarget = path.isAbsolute(target) ? target : path.resolve(installDir, target);
  const targetsLaunch = resolvedTarget === launchTarget;
  const hasEnsurePre = lines.some((l) => /^\s*ExecStartPre\s*=.*ensure-deps\.mjs/.test(l));

  // Only patch a unit that points at server.mjs directly (or already at our
  // launcher). Anything else (a custom ExecStart) we leave alone.
  const targetsServer = /(^|\/)server\.mjs$/.test(target);
  if (!targetsLaunch && !targetsServer) {
    return { changed: false, reason: `ExecStart target not recognized (${target})`, unitPath };
  }

  if (targetsLaunch && hasEnsurePre) {
    return { changed: false, reason: 'already healed', unitPath };
  }

  const next = [...lines];
  if (!targetsLaunch) {
    next[execStartIdx] = `${prefix}${nodeBin} ${launchTarget}${tail}`;
  }
  if (!hasEnsurePre) {
    // Insert right before ExecStart so it runs immediately prior. `-` prefix:
    // its failure must never abort the start.
    const insertAt = next.findIndex((l) => /^\s*ExecStart\s*=/.test(l));
    next.splice(insertAt, 0, `ExecStartPre=-${nodeBin} ${ensureTarget}`);
  }

  const updated = next.join('\n');
  if (updated === content) {
    return { changed: false, reason: 'no change needed', unitPath };
  }

  try {
    const tmp = `${unitPath}.oe-heal.tmp`;
    fs.writeFileSync(tmp, updated);
    fs.renameSync(tmp, unitPath);
  } catch (e) {
    return { changed: false, reason: `write failed: ${e.message}`, unitPath };
  }

  // Register the change so the next restart uses it. daemon-reload does NOT
  // restart the running server. Best-effort — needs a reachable user manager.
  if (reload) {
    try {
      spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore', timeout: 10_000 });
    } catch { /* best-effort */ }
  }

  return { changed: true, unitPath };
}

// CLI mode — manual repair.
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = healServiceUnit();
  if (result.changed) {
    console.log(`[heal-service-unit] Patched ${result.unitPath} — takes effect on next restart (systemctl --user restart openensemble.service).`);
  } else {
    console.log(`[heal-service-unit] No change: ${result.reason}`);
  }
}
