/**
 * Canonical app identity and base paths.
 * Every module that needs the install directory should import from here
 * instead of hardcoding path.join(process.env.HOME, '.openensemble/...').
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export const APP_NAME     = 'OpenEnsemble';
export const APP_DIR_NAME = '.openensemble';

// Derived from actual file location — works regardless of where the repo lives.
const REAL_BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// When running under vitest or NODE_ENV=test, redirect BASE_DIR to a per-process
// tmp directory so tests can exercise session / users / notes / etc. writes
// without corrupting production data. config.json is seeded from the real
// install so readConfig() still returns real values. Cleaned up at process exit.
function makeTestBaseDir() {
  const tmp = path.join(os.tmpdir(), `openensemble-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try { fs.mkdirSync(tmp, { recursive: true }); } catch {}
  for (const sub of ['users', 'skills', 'logs', 'sessions', 'expenses', 'activity']) {
    try { fs.mkdirSync(path.join(tmp, sub), { recursive: true }); } catch {}
  }
  try { fs.copyFileSync(path.join(REAL_BASE, 'config.json'), path.join(tmp, 'config.json')); } catch {}
  process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  return tmp;
}

const IS_TEST = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
export const BASE_DIR   = IS_TEST ? makeTestBaseDir() : REAL_BASE;
export const CFG_PATH   = path.join(BASE_DIR, 'config.json');
export const USERS_DIR  = path.join(BASE_DIR, 'users');
export const SKILLS_DIR = path.join(BASE_DIR, 'skills');

/** Per-user custom skill directory: ~/.openensemble/users/{userId}/skills/ */
export function userSkillsDir(userId) {
  return path.join(USERS_DIR, userId, 'skills');
}

// ── Mtime-cached config reader (safe to import from any module — no app deps) ──
let _cfgCache = null;
let _cfgMtime = 0;

const ENV_MAP = {
  ANTHROPIC_API_KEY:  'anthropicApiKey',
  BRAVE_API_KEY:      'braveApiKey',
  FIREWORKS_API_KEY:  'fireworksApiKey',
  GROK_API_KEY:       'grokApiKey',
  OPENROUTER_API_KEY: 'openrouterApiKey',
  OLLAMA_API_KEY:     'ollamaApiKey',
};

export function readConfig() {
  let cfg;
  try {
    const stat = fs.statSync(CFG_PATH);
    if (_cfgCache && stat.mtimeMs === _cfgMtime) cfg = _cfgCache;
    else {
      cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      _cfgCache = cfg;
      _cfgMtime = stat.mtimeMs;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[config] Failed to load config.json:', e.message);
    cfg = {};
  }
  for (const [envKey, cfgKey] of Object.entries(ENV_MAP)) {
    if (process.env[envKey]) cfg[cfgKey] = process.env[envKey];
  }
  return cfg;
}
