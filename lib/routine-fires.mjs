// @ts-check
/**
 * Timestamped routine-fire events. The routine_proposal outcome measurer
 * uses these to count whether an accepted routine actually got triggered
 * via its fast-path in the 7d post-accept window.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function eventsPath(userId) {
  return path.join(USERS_DIR, userId, 'routine-fires.jsonl');
}

export async function appendRoutineFire(userId, { routineId, trigger }) {
  if (!userId || !routineId) return;
  const now = Date.now();
  const line = JSON.stringify({
    ts: now,
    routineId,
    trigger: trigger || null,
  });
  const p = eventsPath(userId);
  try {
    await withLock(p, () => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const cutoff = now - RETENTION_MS;
      let kept = [];
      if (fs.existsSync(p)) {
        const fileLines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        for (const ln of fileLines) {
          try {
            const rec = JSON.parse(ln);
            if (rec.ts > cutoff) kept.push(ln);
          } catch { /* drop bad lines */ }
        }
      }
      kept.push(line);
      fs.writeFileSync(p, kept.join('\n') + '\n');
    });
  } catch (e) {
    console.warn('[routine-fires] append failed:', e.message);
  }
}

export function loadRoutineFires(userId) {
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

export function countFiresInWindow(userId, routineId, from, to) {
  const events = loadRoutineFires(userId);
  let n = 0;
  for (const e of events) {
    if (e.routineId !== routineId) continue;
    if (e.ts < from || e.ts >= to) continue;
    n++;
  }
  return n;
}
