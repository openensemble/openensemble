/**
 * lib/voice-announcements.mjs — per-device queue of things the SERVER wants
 * to say that aren't a direct reply to an in-flight turn.
 *
 * Field bug that motivated it (2026-07-04): user asked for an image, the
 * delegation auto-backgrounded, the user ran a calendar turn meanwhile —
 * when the image finished, its "Done — Iris completed…" report posted to
 * chat but was never spoken; there was no path from a background completion
 * to the device's speaker. This queue is that path.
 *
 * Delivery is owned by ws-handler (it holds the sockets): an idle-gated
 * drain speaks one entry at a time through the normal TTS streamer. With
 * firmware ≥ 0.2.68 the announcement DUCKS any ambient/AirPlay bed (smooth
 * gain dip, speak, swell back) instead of pausing it.
 *
 * Deliberately in-memory: a stale "your image is ready" spoken after a
 * server restart or an hour late is worse than silence.
 */
import { log } from '../logger.mjs';

const TTL_MS = 10 * 60 * 1000;
const MAX_PER_DEVICE = 5;

const queues = new Map(); // deviceId -> [{ text, ts, kind }]

function prune(deviceId) {
  const q = queues.get(deviceId);
  if (!q) return null;
  const now = Date.now();
  const fresh = q.filter(e => now - e.ts < TTL_MS);
  if (fresh.length) queues.set(deviceId, fresh);
  else queues.delete(deviceId);
  return fresh.length ? fresh : null;
}

/** One-line spoken summary from a (possibly long / markdown) report. */
export function announcementLine(agentName, resultText, summary = '') {
  const clean = String(resultText || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>\[\]()]/g, ' ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s+/g, ' ')
    .trim();
  const first = clean.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? clean;
  const gist = first.slice(0, 160).trim();
  if (gist) return `${agentName} finished — ${gist}`;
  return summary
    ? `${agentName} finished: ${String(summary).slice(0, 120)}`
    : `${agentName} finished the background task.`;
}

export function enqueueVoiceAnnouncement(deviceId, text, { kind = 'task' } = {}) {
  if (!deviceId || !text) return false;
  const q = prune(deviceId) ?? [];
  if (q.length >= MAX_PER_DEVICE) q.shift();
  q.push({ text: String(text).slice(0, 300), ts: Date.now(), kind });
  queues.set(deviceId, q);
  log.info('voice', 'announcement queued', { deviceId, kind, queued: q.length });
  // Immediate delivery attempt — the ws-handler tick is only the retry path
  // for entries the idle gates defer. Lazy import (ws-handler ↔ this lib
  // would cycle at module eval).
  import('../ws-handler.mjs')
    .then(m => m.kickVoiceAnnouncementDrain())
    .catch(() => { /* tick retries */ });
  return true;
}

export function hasVoiceAnnouncements(deviceId) {
  return !!prune(deviceId);
}

/** Pop the oldest fresh entry, or null. */
export function nextVoiceAnnouncement(deviceId) {
  const q = prune(deviceId);
  if (!q) return null;
  const e = q.shift();
  if (!q.length) queues.delete(deviceId);
  return e;
}

export function dropVoiceAnnouncements(deviceId) {
  queues.delete(deviceId);
}
