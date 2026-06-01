// @ts-check
/**
 * Verbosity calibration. Tracks user reply length per (user, agent) over a
 * rolling window. When the user consistently sends very short messages,
 * they're signaling "stop being long-winded" — propose a standing rule
 * on the agent so subsequent prompts include "be concise."
 *
 * Threshold (tuned to avoid false positives):
 *  - Need at least 10 samples in the agent's window
 *  - Average length < 25 chars
 *  - We haven't already proposed this within COOLDOWN
 *
 * Sample storage: ring buffer of last 30 user message lengths per
 * (user, agent). Tiny disk footprint. Reset when accepted to give the
 * rule time to take effect.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const RING_SIZE = 30;
const MIN_SAMPLES = 10;
const AVG_LEN_THRESHOLD = 25;
const PROPOSAL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function statsPath(userId) {
  return path.join(USERS_DIR, userId, 'verbosity-stats.json');
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function loadStats(userId) {
  return readJsonSafe(statsPath(userId));
}

async function saveStats(userId, data) {
  const p = statsPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  });
}

/**
 * Record a user message length. Returns a signal if the threshold is
 * tripped on this call:
 *   { proposed: false }
 *   { proposed: true, agentId, avgLen, samples }
 *
 * Fire-and-forget from chat-dispatch. The caller invokes
 * proposeVerbosityRule when proposed=true.
 */
export async function recordUserMessageLength(userId, agentId, length) {
  if (!userId || !agentId || typeof length !== 'number') return { proposed: false };
  if (length < 0) return { proposed: false };
  // Skip empty / 1-char messages — those are usually noise, not preference.
  if (length < 2) return { proposed: false };

  const all = loadStats(userId);
  const rec = all[agentId] || { lens: [], lastProposedAt: 0 };
  rec.lens.push(length);
  if (rec.lens.length > RING_SIZE) rec.lens = rec.lens.slice(-RING_SIZE);
  all[agentId] = rec;
  try { await saveStats(userId, all); } catch (e) {
    console.warn('[verbosity] persist failed:', e.message);
    return { proposed: false };
  }

  if (rec.lens.length < MIN_SAMPLES) return { proposed: false };
  const avg = rec.lens.reduce((a, b) => a + b, 0) / rec.lens.length;
  if (avg >= AVG_LEN_THRESHOLD) return { proposed: false };

  // Cooldown: only one verbosity proposal per 7d per agent
  if (Date.now() - (rec.lastProposedAt || 0) < PROPOSAL_COOLDOWN_MS) {
    return { proposed: false };
  }
  rec.lastProposedAt = Date.now();
  try { await saveStats(userId, all); } catch (_) { /* best-effort */ }

  return { proposed: true, agentId, avgLen: Math.round(avg), samples: rec.lens.length };
}

/**
 * Resets the sample window — called after the user accepts a verbosity
 * proposal so the new rule has a clean re-evaluation window.
 */
export async function resetSamples(userId, agentId) {
  if (!userId || !agentId) return;
  const all = loadStats(userId);
  if (!all[agentId]) return;
  all[agentId].lens = [];
  try { await saveStats(userId, all); } catch {}
}

export function loadVerbosityStats(userId) {
  return loadStats(userId);
}
