#!/usr/bin/env node
/**
 * Pre-start dependency check + auto-install.
 *
 * Runs as the systemd unit's ExecStartPre (and from start.sh) BEFORE the
 * server loads, so a box that pulled new code without a follow-up
 * `npm install` — the classic "added a dependency, forgot to install it"
 * case — repairs itself instead of crash-looping on a missing import.
 *
 * Reads package.json's `dependencies` and verifies each is present under
 * node_modules. If anything's missing it runs `npm install --prefer-offline`
 * once (cached versions reuse; only genuinely-new packages are fetched).
 *
 * Cheap on the happy path: an in-sync box just stats N directories (no fork)
 * and exits in ~30ms.
 *
 * ALWAYS exits 0 — it must never be the thing that aborts boot. What it CAN'T
 * fix (an npm failure, or a native module that won't compile because build
 * tools are missing) it records in dep-status.json, which scripts/launch.mjs
 * reads to show the operator a clear diagnostic page instead of a silent dead
 * server. See handoffs/DEVICE-DISCOVERY-ADMISSION-PLAN.md-era boot-safety work.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  dependencyFingerprint,
  markDependencyStateUncertain,
  readDependencyStatus,
  recordInstalledDependencyState,
  writeDependencyStatus,
} from '../lib/dependency-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOG_PATH = path.join(ROOT, 'last-dep-install.log');

// A generous but bounded ceiling: native modules in this project
// (node-llama-cpp, node-pty, lancedb) can take several minutes to compile on a
// slow box, but we must never hang boot forever waiting on a stuck npm.
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

function log(...a) { console.log('[ensure-deps]', ...a); }

function writeStatus(status) {
  try {
    writeDependencyStatus(status, ROOT);
  } catch (e) {
    log(`Could not write dep-status.json: ${e.message}`);
  }
}

// Resolve the npm that ships next to THIS node binary. Under systemd the unit
// runs a specific node (often an nvm path) with a bare PATH that may not
// include npm at all — so we point at the sibling npm explicitly and also add
// node's dir to PATH so npm's own child processes (node-gyp, prebuild) can
// find node during native builds.
function npmInvocation() {
  const nodeDir = path.dirname(process.execPath);
  const localNpm = path.join(nodeDir, 'npm');
  const cmd = fs.existsSync(localNpm) ? localNpm : 'npm';
  const env = { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}` };
  return { cmd, env };
}

function listMissing() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (e) {
    log(`Cannot read package.json: ${e.message}. Skipping dep check.`);
    return null; // signal "can't tell" — caller treats as no-op
  }
  const deps = pkg.dependencies || {};
  const missing = [];
  for (const name of Object.keys(deps)) {
    // Scoped packages (@scope/pkg) resolve under node_modules/@scope/pkg, so a
    // single package.json presence check per dep is enough.
    if (!fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json'))) {
      missing.push(name);
    }
  }
  return missing;
}

const markUncertainOnly = process.argv.includes('--mark-uncertain');
if (markUncertainOnly) {
  try {
    markDependencyStateUncertain({
      source: 'external-dependency-install',
      reason: 'Dependency installation started but has not completed successfully.',
    }, ROOT);
    log('Marked dependency state as pending reconciliation.');
  } catch (error) {
    // Like --record-installed, this marker is best-effort. The package manager
    // command still needs to run; a later pre-start check will retry if needed.
    log(`Could not mark dependency state as uncertain: ${error.message}`);
  }
  process.exit(0);
}

const missing = listMissing();
const expectedFingerprint = dependencyFingerprint(ROOT);
const previousStatus = readDependencyStatus(ROOT);
const recordOnly = process.argv.includes('--record-installed');

if (missing === null) {
  process.exit(0);
}

if (recordOnly) {
  if (missing.length) {
    writeStatus({
      ok: false,
      source: 'record-installed',
      failedAt: new Date().toISOString(),
      reason: 'Cannot record dependency state while direct dependencies are missing.',
      missing,
      dependencyFingerprint: previousStatus?.dependencyFingerprint ?? null,
      expectedDependencyFingerprint: expectedFingerprint,
    });
    // Installers and update wrappers use this mode after npm succeeds. The
    // marker is an optimization, not part of the installed dependency tree,
    // so a missing package or unwritable status file must not turn a successful
    // npm install into a failed upgrade. Pre-start will retry reconciliation.
    process.exit(0);
  }
  try {
    recordInstalledDependencyState({ recordedAt: new Date().toISOString(), missing: [] }, ROOT);
    log('Recorded installed dependency state.');
    process.exit(0);
  } catch (error) {
    log(`Could not record installed dependency state: ${error.message}`);
    process.exit(0);
  }
}

const fingerprintChanged = previousStatus?.dependencyFingerprint !== expectedFingerprint;
if (!missing.length && !fingerprintChanged && previousStatus?.ok === true) {
  writeStatus({
    ...previousStatus,
    ok: true,
    checkedAt: new Date().toISOString(),
    missing: [],
    dependencyFingerprint: expectedFingerprint,
  });
  process.exit(0);
}

if (missing.length) {
  log(`Missing ${missing.length} dependencies: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`);
}
if (fingerprintChanged) {
  log('Dependency manifests changed since the last successful install.');
}
if (previousStatus?.ok === false) {
  log('The previous dependency install was incomplete; reconciling again.');
}
log('Running npm install --prefer-offline --no-save --no-audit --no-fund…');

try {
  markDependencyStateUncertain({
    source: 'pre-start-reconciliation',
    reason: 'Dependency reconciliation started but has not completed successfully.',
  }, ROOT);
} catch (error) {
  log(`Could not mark dependency state as uncertain: ${error.message}`);
}

const { cmd, env } = npmInvocation();
const r = spawnSync(
  cmd,
  ['install', '--prefer-offline', '--no-save', '--no-audit', '--no-fund', '--no-progress'],
  { cwd: ROOT, env, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
);

// Surface npm's output to the journal AND keep a copy on disk for the
// diagnostic page (the operator won't necessarily have journalctl access).
const combined = `${r.stdout || ''}${r.stderr || ''}`;
if (combined.trim()) process.stdout.write(combined.endsWith('\n') ? combined : combined + '\n');
try { fs.writeFileSync(LOG_PATH, combined); } catch { /* best-effort */ }

const timedOut = r.error && r.error.code === 'ETIMEDOUT';
const stillMissing = listMissing() || [];

if (r.status === 0 && stillMissing.length === 0) {
  log('Dependencies installed.');
  try {
    recordInstalledDependencyState({ installed: missing, missing: [] }, ROOT);
  } catch (error) {
    log(`Dependencies installed, but state could not be recorded: ${error.message}`);
    writeStatus({
      ok: false,
      source: 'pre-start-reconciliation',
      failedAt: new Date().toISOString(),
      reason: `Dependencies installed, but state could not be recorded: ${error.message}`,
      missing: [],
      dependencyFingerprint: previousStatus?.dependencyFingerprint ?? null,
      expectedDependencyFingerprint: expectedFingerprint,
    });
  }
  process.exit(0);
}

// Couldn't fully resolve. Record why so launch.mjs can explain it. Boot still
// continues — if the missing dep is optional (e.g. the mDNS responder) the
// server loads fine; if it's critical, launch.mjs shows this instead of a
// silent crash loop.
const reason = timedOut
  ? `npm install timed out after ${Math.round(INSTALL_TIMEOUT_MS / 60000)} minutes`
  : r.error
    ? `npm could not be run: ${r.error.message}`
    : `npm install exited with code ${r.status}`;

log(`${reason}. ${stillMissing.length} dependencies still missing: ${stillMissing.slice(0, 6).join(', ')}${stillMissing.length > 6 ? '…' : ''}`);
writeStatus({
  ok: false,
  source: 'pre-start-reconciliation',
  failedAt: new Date().toISOString(),
  reason,
  npmExit: r.status ?? null,
  timedOut: !!timedOut,
  missing: stillMissing,
  dependencyFingerprint: previousStatus?.dependencyFingerprint ?? null,
  expectedDependencyFingerprint: expectedFingerprint,
  logTail: combined.split('\n').slice(-40).join('\n'),
});
process.exit(0);
