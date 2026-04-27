#!/usr/bin/env node
/**
 * Pre-start dep check.
 *
 * Reads package.json's `dependencies` and verifies each is present in
 * node_modules. If anything's missing — typical after a `git pull` that
 * landed a new dep without a follow-up `npm install` — runs npm install
 * once with --prefer-offline so cached versions reuse, only fetching
 * what's actually new.
 *
 * Designed to be cheap on the happy path: a fresh box already in sync
 * just stats N package.json files (no fork) and exits ~30ms.
 *
 * Always exits 0. If npm install fails, the failure is logged and we
 * still proceed to start the server — server import will fail loudly
 * if the missing dep is critical, which is more debuggable than this
 * script aborting the whole boot.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function log(...a) { console.log('[ensure-deps]', ...a); }

const pkgPath = path.join(ROOT, 'package.json');
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (e) {
  log(`Cannot read ${pkgPath}: ${e.message}. Skipping dep check.`);
  process.exit(0);
}

const deps = pkg.dependencies || {};
const missing = [];
for (const name of Object.keys(deps)) {
  const dir = path.join(ROOT, 'node_modules', name);
  // Scoped packages live under node_modules/@scope/pkg; the path Node uses
  // to resolve them mirrors the scoped layout, so we just need that dir.
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    missing.push(name);
  }
}

if (!missing.length) process.exit(0);

log(`Missing ${missing.length} dependencies: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''}`);
log('Running npm install --prefer-offline --no-audit --no-fund...');
const r = spawnSync(
  'npm',
  ['install', '--prefer-offline', '--no-audit', '--no-fund', '--no-progress'],
  { cwd: ROOT, stdio: 'inherit' },
);
if (r.status !== 0) {
  log(`npm install exited ${r.status}. Server start will continue; if the missing dep is needed, the import will fail loudly.`);
} else {
  log('Dependencies installed.');
}
process.exit(0);
