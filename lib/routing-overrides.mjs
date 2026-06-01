// @ts-check
/**
 * Per-user routing overrides.
 *
 * When the chat dispatcher hits a user message, it asks `matchOverride` if a
 * stored pattern wants to FORCE the dispatch to a specific agent (bypassing
 * the specialist router's intent classifier). Overrides are populated via
 * the proposal accept flow — Phase 6 router-as-learner — never inline.
 *
 * Match semantics (v1): substring (case-insensitive) on normalized text.
 * Regex mode is allowed but the proposer only ever generates substring
 * patterns. First-match wins.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

function overridesPath(userId) {
  return path.join(USERS_DIR, userId, 'routing-overrides.json');
}
function firesPath(userId) {
  return path.join(USERS_DIR, userId, 'routing-fires.jsonl');
}
function deletedLogPath(userId) {
  return path.join(USERS_DIR, userId, 'routing-overrides.deleted.log');
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function normalize(text) {
  return String(text || '').trim().toLowerCase()
    .replace(/[''']/g, '')
    .replace(/\s+/g, ' ');
}

export function loadOverrides(userId) {
  if (!userId) return [];
  const arr = readJsonSafe(overridesPath(userId));
  return Array.isArray(arr) ? arr : [];
}

async function saveOverrides(userId, arr) {
  const p = overridesPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(arr, null, 2));
  });
}

/**
 * Match a user message against the user's stored overrides. Returns the
 * first match or null. Match is case-insensitive substring on normalized
 * text; regex mode supported but currently unused by the proposer.
 */
export function matchOverride(userId, message) {
  if (!userId || !message) return null;
  const norm = normalize(message);
  if (!norm) return null;
  const all = loadOverrides(userId);
  for (const o of all) {
    if (!o?.pattern || !o?.forcedAgent) continue;
    try {
      if (o.mode === 'regex') {
        if (new RegExp(o.pattern, 'i').test(norm)) return o;
      } else {
        if (norm.includes(String(o.pattern).toLowerCase())) return o;
      }
    } catch { /* bad regex — skip */ }
  }
  return null;
}

export async function addOverride(userId, { pattern, forcedAgent, mode = 'contains', addedBy = 'manual', examples = [] }) {
  if (!userId || !pattern || !forcedAgent) return { ok: false, error: 'bad args' };
  const all = loadOverrides(userId);
  const id = 'rovr_' + randomUUID().slice(0, 12);
  const entry = {
    id,
    pattern: String(pattern),
    forcedAgent: String(forcedAgent),
    mode: mode === 'regex' ? 'regex' : 'contains',
    addedAt: Date.now(),
    addedBy: addedBy || 'manual',
    examples: Array.isArray(examples) ? examples.slice(0, 5) : [],
  };
  all.push(entry);
  await saveOverrides(userId, all);
  return { ok: true, id, entry };
}

export async function removeOverride(userId, id) {
  if (!userId || !id) return { ok: false, error: 'bad args' };
  const all = loadOverrides(userId);
  const idx = all.findIndex(o => o.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  const removed = all[idx];
  try {
    fs.appendFileSync(deletedLogPath(userId), JSON.stringify({ ts: Date.now(), entry: removed }) + '\n');
  } catch (e) {
    console.warn('[routing-overrides] deleted-log write failed:', e.message);
  }
  all.splice(idx, 1);
  await saveOverrides(userId, all);
  return { ok: true, removed };
}

export async function logFire(userId, overrideId, message) {
  if (!userId || !overrideId) return;
  const p = firesPath(userId);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({
      ts: Date.now(),
      overrideId,
      message: String(message || '').slice(0, 200),
    }) + '\n');
  } catch (e) {
    console.warn('[routing-overrides] fire-log write failed:', e.message);
  }
}

export function countFiresForOverride(userId, overrideId, from, to) {
  const p = firesPath(userId);
  if (!fs.existsSync(p)) return 0;
  let n = 0;
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.overrideId !== overrideId) continue;
        if (rec.ts < from || rec.ts >= to) continue;
        n++;
      } catch { /* bad line */ }
    }
  } catch { /* nada */ }
  return n;
}
