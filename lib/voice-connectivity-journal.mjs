// @ts-check
/**
 * Voice-device link history: connect, disconnect, and server-side termination.
 *
 * app.log already carries a bare 'client connected' / 'client disconnected'
 * pair, but neither line records how long the session lasted or whether a turn
 * died with it — so a device that silently reconnects every ninety seconds and
 * one that stays up for a week produce the same shaped evidence. Reconnect
 * churn is a leading cause of "it stopped answering" (the device is briefly
 * absent when the wake lands) and it is currently uncountable.
 *
 * One row per link event. `sessionMs` on a disconnect, plus `code`, is what
 * separates a clean user-initiated close from a network drop (1006) from OE's
 * own heartbeat giving up on the device.
 */
import path from 'path';
import { BASE_DIR } from './paths.mjs';
import { appendJsonlRow, readJsonlRows } from './jsonl-journal.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function journalPath() {
  return path.join(BASE_DIR, 'logs', 'voice-connectivity.jsonl');
}

/**
 * @param {string} event 'connect' | 'disconnect' | 'terminated_unresponsive' | 'superseded'
 */
export function recordLinkEvent(event, fields = {}) {
  // Voice devices only. Browser/desktop sockets churn by design (tab focus,
  // navigation) and would bury the device signal this journal exists for.
  if (!fields.deviceId) return;
  const ts = Date.now();
  void appendJsonlRow(journalPath(), {
    ts,
    iso: new Date(ts).toISOString(),
    event,
    ...fields,
  }, RETENTION_MS);
}

export function loadLinkEvents({ limit = 500 } = {}) {
  return readJsonlRows(journalPath(), { limit });
}

/**
 * Per-device rollup over a window: session count, total/median uptime, the
 * close-code histogram, and how many disconnects killed a live turn. This is
 * the shape you want when asking "is this device's link healthy" rather than
 * reading individual rows.
 */
export function summarizeLinkHealth({ sinceMs = 24 * 60 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - sinceMs;
  const rows = loadLinkEvents({ limit: 0 }).filter(r => r.ts > cutoff);
  /** @type {Record<string, any>} */
  const byDevice = {};
  for (const r of rows) {
    const d = (byDevice[r.deviceId] ??= {
      deviceId: r.deviceId, connects: 0, disconnects: 0, terminated: 0,
      turnsKilled: 0, codes: {}, sessionsMs: [],
    });
    if (r.event === 'connect') d.connects++;
    else if (r.event === 'terminated_unresponsive') d.terminated++;
    else if (r.event === 'disconnect') {
      d.disconnects++;
      if (r.code != null) d.codes[r.code] = (d.codes[r.code] ?? 0) + 1;
      if (typeof r.sessionMs === 'number') d.sessionsMs.push(r.sessionMs);
      if (r.hadActiveTurn) d.turnsKilled++;
    }
  }
  for (const d of Object.values(byDevice)) {
    const s = d.sessionsMs.slice().sort((a, b) => a - b);
    d.medianSessionMs = s.length ? s[Math.floor(s.length / 2)] : null;
    d.shortestSessionMs = s.length ? s[0] : null;
    delete d.sessionsMs;
  }
  return Object.values(byDevice);
}
