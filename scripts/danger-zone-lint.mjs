#!/usr/bin/env node
/**
 * Danger-zone lint — flags filesystem + user-data patterns that have a
 * track record of taking down OE installs. Run from CI on every push; if
 * you have a legitimate need to use one of these, opt out per-line with
 * a trailing comment: `// oe-allow: <reason>`.
 *
 * The rules here are deliberately blunt regex matches. They're meant to
 * catch the pattern at code-review time, not to be a perfect linter. False
 * positives are OK — that's what `oe-allow` is for.
 *
 * Rules (with their motivating incident):
 *
 *   saveUsers-orphan-cleanup
 *     `saveUsers(` outside the definition site, in routes/users.mjs (the
 *     legitimate delete path), or tests. Every other caller should reach
 *     for `modifyUser(userId, fn)` — the surgical primitive that locks
 *     one profile.json. Two incidents this year stemmed from "I'll just
 *     write the whole list to flip one field": 2026-05-12 (master-key
 *     wipe, root cause) and 2026-05-26 (root-cause confirmed).
 *
 *   bulk-users-rm
 *     `fs.rmSync` / `rmdirSync` / `fs.rm` against `USERS_DIR` or a path
 *     that contains `users/` without scoping to a specific user id. These
 *     can wipe `users/_system/.master-key` and orphan every encrypted
 *     secret in config.json.
 *
 *   raw-master-key-touch
 *     Direct writes / unlinks to `.master-key` outside `lib/crypto.mjs`
 *     and `lib/config-secrets.mjs`. Those two files are the only sanctioned
 *     master-key handlers; anything else is suspicious.
 *
 * Exit code: 0 if clean, 1 if any rule fired (CI fails the build).
 *
 * Run locally:  node scripts/danger-zone-lint.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Paths excluded from the scan. node_modules + vendor + binaries.
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'venv', 'models',
  'public/firmware', 'public/lucide.min',
  'logs', 'sessions', 'users', 'config',
]);

const EXCLUDE_FILE_REGEX = [
  /\.(png|jpg|jpeg|gif|webp|ico|svg|mp3|mp4|wav|tflite|bin|gguf|onnx|woff2?|ttf|otf|pdf|zip|tar|gz)$/i,
  /\.min\.(js|css)$/,
  /package-lock\.json$/,
  /\.gitignore$/,
];

// Files allowed to define / legitimately use each pattern. These are the
// sanctioned implementation sites; everything else is suspicious.
const RULES = [
  {
    id: 'saveUsers-orphan-cleanup',
    pattern: /\bsaveUsers\s*\(/,
    allowedFiles: [
      'routes/_helpers.mjs',                    // definition + modifyUsers helper
      'routes/users.mjs',                       // user delete path is the legitimate caller
      'routes/admin.mjs',                       // owner add-user path; also legitimate
      'routes/plugins.mjs',                     // bulk skill-set propagation
      'tests/save-users-system-dir.test.mjs',   // regression test for the orphan-cleanup fix
      'scripts/danger-zone-lint.mjs',           // this file
    ],
    message:
      'Use modifyUser(userId, fn) for single-user mutations. saveUsers ' +
      'rewrites every profile.json AND runs an orphan-cleanup sweep that ' +
      'has wiped users/_system/.master-key twice this year.',
  },
  {
    id: 'bulk-users-rm',
    // fs.rm{,Sync}({USERS_DIR or anything ending in /users}, ...) without a
    // userId interpolation right after. Reasonable shape:
    //   fs.rmSync(path.join(USERS_DIR, someUserId), ...)
    // Bad shape:
    //   fs.rmSync(USERS_DIR, { recursive: true })
    //   fs.rmSync(path.join(base, 'users'), { recursive: true })
    pattern: /\bfs\.(rm|rmSync|rmdir|rmdirSync)\s*\(\s*(USERS_DIR\b|[^)]*['"]users['"]\s*[),])/,
    allowedFiles: [
      'scripts/danger-zone-lint.mjs',
    ],
    message:
      'Whole-users-dir removal can wipe users/_system/.master-key. Scope ' +
      'the rm to a specific user id (path.join(USERS_DIR, userId)).',
  },
  {
    id: 'raw-master-key-touch',
    // Match fs operations or shell ops targeting `.master-key`. Documentation
    // mentions (guide/*.md, code comments) are fine — they say something is
    // dangerous, they don't do it. This regex looks for a verb (writeFile,
    // unlink, rm/rmSync, fs.X, rm -f, etc.) on the same line as `.master-key`.
    pattern: /(\bfs\.(write|unlink|rm|rmSync|rmdir|truncate|appendFile|writeFileSync|copyFile|rename|chmod)\w*\s*\([^)]*\.master-key|\brm\s+[^|]*\.master-key|>\s*[^|]*\.master-key)/,
    allowedFiles: [
      'lib/crypto.mjs',             // KEY_FILENAME constant + getUserKey
      'lib/config-secrets.mjs',     // bootstrap, getSystemKey
      'scripts/danger-zone-lint.mjs',
    ],
    message:
      'The master-key file is sacred (see feedback_master_key_never_overwrite). ' +
      'Touch it only from lib/crypto.mjs or lib/config-secrets.mjs.',
  },
];

function shouldScan(absPath) {
  const rel = path.relative(ROOT, absPath);
  for (const part of rel.split(path.sep)) {
    if (EXCLUDE_DIRS.has(part)) return false;
  }
  // Catch nested excludes (e.g. public/firmware/voice-device)
  for (const dir of EXCLUDE_DIRS) {
    if (rel === dir || rel.startsWith(dir + path.sep)) return false;
  }
  for (const re of EXCLUDE_FILE_REGEX) {
    if (re.test(rel)) return false;
  }
  // Only scan code. Docs (.md) are excluded — they mention dangerous
  // patterns descriptively without invoking them.
  return /\.(m?js|json|sh)$/i.test(rel);
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    if (EXCLUDE_DIRS.has(rel)) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && shouldScan(full)) out.push(full);
  }
}

function scan() {
  const files = [];
  walk(ROOT, files);
  const hits = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch { continue; }
    const lines = text.split('\n');
    for (const rule of RULES) {
      if (rule.allowedFiles.includes(rel)) continue;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!rule.pattern.test(line)) continue;
        if (/oe-allow\s*:/.test(line)) continue;
        hits.push({ rule: rule.id, message: rule.message, file: rel, lineNumber: i + 1, line: line.trim() });
      }
    }
  }
  return hits;
}

const hits = scan();
if (hits.length === 0) {
  console.log('[danger-zone-lint] clean — 0 hits across the scanned tree.');
  process.exit(0);
}

console.error(`[danger-zone-lint] ${hits.length} hit(s):\n`);
const byRule = new Map();
for (const h of hits) {
  if (!byRule.has(h.rule)) byRule.set(h.rule, []);
  byRule.get(h.rule).push(h);
}
for (const [rule, list] of byRule) {
  console.error(`  rule ${rule}`);
  console.error(`    ${list[0].message}`);
  for (const h of list) {
    console.error(`    • ${h.file}:${h.lineNumber}  ${h.line.slice(0, 100)}`);
  }
  console.error('');
}
console.error('To allow a specific line, append `// oe-allow: <reason>` to it.\n');
process.exit(1);
