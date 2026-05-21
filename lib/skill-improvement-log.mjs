/**
 * Per-skill improvement log — append-only history of what changed and when.
 * One entry per skill-builder code mutation (create, update, patch). Lives
 * next to the skill's manifest so it dies with the skill on delete.
 *
 * Storage: users/<uid>/skills/<skillId>/improvement-log.json
 *   [{ ts: number, kind: 'created'|'manual_update'|'manual_patch', summary: string }, ...]
 *
 * Capped at LOG_MAX_ENTRIES (oldest dropped). The kind field is descriptive
 * only — we don't currently branch on it in product code. Useful for
 * debugging "what's been done to this skill?" and for the eventual UI that
 * surfaces a skill's history.
 */
import fs from 'fs';
import path from 'path';
import { userSkillsDir } from './paths.mjs';

const LOG_MAX_ENTRIES = 50;
const LOG_FILENAME = 'improvement-log.json';
const MAX_SUMMARY_LEN = 240;

function logPath(userId, skillId) {
  return path.join(userSkillsDir(userId), skillId, LOG_FILENAME);
}

export function readLog(userId, skillId) {
  const p = logPath(userId, skillId);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

// Append a log entry. Silent no-op when the skill dir doesn't exist (e.g.,
// caller raced a delete). Returns the entry that was written, or null on
// no-op.
export function appendEntry(userId, skillId, { kind, summary }) {
  if (!userId || !skillId || !kind) return null;
  const dir = path.dirname(logPath(userId, skillId));
  if (!fs.existsSync(dir)) return null;
  const entry = {
    ts: Date.now(),
    kind,
    summary: (summary || '').toString().slice(0, MAX_SUMMARY_LEN),
  };
  let list = readLog(userId, skillId);
  list.push(entry);
  if (list.length > LOG_MAX_ENTRIES) list = list.slice(-LOG_MAX_ENTRIES);
  fs.writeFileSync(logPath(userId, skillId), JSON.stringify(list, null, 2));
  return entry;
}
