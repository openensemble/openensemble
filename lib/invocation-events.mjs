// @ts-check
/**
 * Timestamped tool-invocation events. The skill_proposal outcome measurer
 * needs to count invocations of a specific skill's tools in the 7d post-
 * accept window — skill-telemetry's cumulative counters can't answer that
 * since they're not per-event.
 *
 * Same bounded-retention pattern as correction-events.mjs.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function eventsPath(userId) {
  return path.join(USERS_DIR, userId, 'invocation-events.jsonl');
}

export async function appendInvocationEvents(userId, entries) {
  if (!userId || !Array.isArray(entries) || !entries.length) return;
  const now = Date.now();
  const lines = entries.map(e => JSON.stringify({
    ts: e.ts || now,
    toolName: e.toolName || null,
    skillId: e.skillId || null,
  }));
  const p = eventsPath(userId);
  try {
    await withLock(p, () => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const cutoff = now - RETENTION_MS;
      let kept = [];
      if (fs.existsSync(p)) {
        const fileLines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        for (const line of fileLines) {
          try {
            const rec = JSON.parse(line);
            if (rec.ts > cutoff) kept.push(line);
          } catch { /* drop bad lines */ }
        }
      }
      kept.push(...lines);
      fs.writeFileSync(p, kept.join('\n') + '\n');
    });
  } catch (e) {
    console.warn('[invocation-events] append failed:', e.message);
  }
}

export function loadInvocationEvents(userId) {
  if (!userId) return [];
  const p = eventsPath(userId);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

export function countInvocationsInWindow(userId, filter, from, to) {
  const events = loadInvocationEvents(userId);
  let n = 0;
  for (const e of events) {
    if (e.ts < from || e.ts >= to) continue;
    if (filter.skillId && e.skillId !== filter.skillId) continue;
    if (filter.toolName && e.toolName !== filter.toolName) continue;
    n++;
  }
  return n;
}
