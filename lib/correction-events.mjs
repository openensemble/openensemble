// @ts-check
/**
 * Timestamped correction-event log per user. The cortex CORRECTION signal
 * head already classifies user turns; this is just a side-channel JSONL
 * append so outcome measurers can do windowed counts ("did corrections to
 * agent X drop in the 7d after I accepted a rule promotion?").
 *
 * Bounded retention: on each append we drop entries older than 30 days.
 * Keeps the file from growing without bound for high-volume users.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';
import { getTurn } from './turn-trace-context.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function eventsPath(userId) {
  return path.join(USERS_DIR, userId, 'correction-events.jsonl');
}

export async function appendCorrectionEvent(userId, { agentId, skillId, text }) {
  if (!userId) return;
  const ev = {
    ts: Date.now(),
    turnId: getTurn()?.turnId ?? null,
    agentId: agentId || null,
    skillId: skillId || null,
    text: (text || '').slice(0, 240),
  };
  const p = eventsPath(userId);
  try {
    await withLock(p, () => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      // Light retention sweep: cheap when the file is small; we accept a
      // rewrite on each append because the file is bounded to ~30d worth of
      // correction events and corrections aren't a hot path.
      let kept = [];
      if (fs.existsSync(p)) {
        const cutoff = Date.now() - RETENTION_MS;
        const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const rec = JSON.parse(line);
            if (rec.ts > cutoff) kept.push(line);
          } catch { /* drop bad lines */ }
        }
      }
      kept.push(JSON.stringify(ev));
      fs.writeFileSync(p, kept.join('\n') + '\n');
    });
  } catch (e) {
    console.warn('[correction-events] append failed:', e.message);
  }
}

export function loadCorrectionEvents(userId) {
  if (!userId) return [];
  const p = eventsPath(userId);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

export function countCorrectionsInWindow(userId, filter, from, to) {
  const events = loadCorrectionEvents(userId);
  let n = 0;
  for (const e of events) {
    if (e.ts < from || e.ts >= to) continue;
    if (filter.agentId && e.agentId !== filter.agentId) continue;
    if (filter.skillId && e.skillId !== filter.skillId) continue;
    n++;
  }
  return n;
}
