// @ts-check
/**
 * Per-kind salience gate — closes the proposal feedback loop.
 *
 * For every kind, we read its rolling outcome stats from proposal-outcomes
 * and ask: are accepted proposals of this kind correlating with reduced
 * friction (semantic-aware "improvement")? If a kind has enough samples AND
 * a bad improvement rate, we PAUSE it: createProposal returns null when the
 * detector fires, no new card lands in the inbox.
 *
 * Why pause instead of throttle? Throttling (requiring more evidence) hides
 * the problem; the proposals still come, just slower. Pausing makes the
 * user notice: "rule_promotion is paused" is a hint that recent learnings
 * of this kind didn't help. They can read what happened and either reset
 * (resume emission) or accept the system's signal that this kind shouldn't
 * fire automatically anymore.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';
import { summarizeByKind } from './proposal-outcomes.mjs';
import { proposalFeedbackSummary, targetKeyForProposal } from './learning-policy.mjs';

const MIN_SAMPLES = 3;                                    // floor before judging
const PAUSE_THRESHOLD = 0.5;                              // improvement rate below → paused
const DISMISS_PAUSE_THRESHOLD = 0.67;                     // recent dismiss/block rate below → paused
const TARGET_DISMISS_SUPPRESS_COUNT = 2;                  // same target dismissed twice → suppressed
const RESET_DURATION_MS = 7 * 24 * 60 * 60 * 1000;        // manual-reset grace window

function overridesPath(userId) {
  return path.join(USERS_DIR, userId, 'salience-overrides.json');
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function loadResetOverrides(userId) {
  return readJsonSafe(overridesPath(userId));
}

async function saveResetOverrides(userId, data) {
  const p = overridesPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  });
}

/**
 * Compute the salience verdict for a single kind. Returns:
 *   { allow: true, reason: 'insufficient-data' | 'healthy' | 'reset-grace', ...stats }
 *   { allow: false, reason: 'paused' | 'dismiss-paused' | 'target-dismissed', ...stats }
 *
 * "insufficient-data" means we don't yet have enough measured outcomes to
 * judge — always allow. "reset-grace" means the user explicitly unpaused
 * recently — allow for the grace window even if the underlying rate is bad.
 */
export function getKindStatus(userId, kind, record = null) {
  if (!userId || !kind) return { allow: true, reason: 'no-args' };

  // Manual reset override — short-circuit any computed pause for the grace
  // window. After expiry, we re-check normally.
  const overrides = loadResetOverrides(userId);
  const reset = overrides[kind];
  if (reset?.resetAt && Date.now() - reset.resetAt < RESET_DURATION_MS) {
    return { allow: true, reason: 'reset-grace', resetAt: reset.resetAt };
  }

  const targetKey = record ? targetKeyForProposal(record) : null;
  if (targetKey) {
    const target = proposalFeedbackSummary(userId, { targetKey });
    const targetDismisses = target.dismissed + (target.blocked * 2);
    if (targetDismisses >= TARGET_DISMISS_SUPPRESS_COUNT) {
      return {
        allow: false,
        reason: 'target-dismissed',
        targetKey,
        dismissed: target.dismissed,
        blocked: target.blocked,
      };
    }
  }

  const feedback = proposalFeedbackSummary(userId, { kind });
  const judged = feedback.accepted + feedback.dismissed + feedback.blocked;
  if (judged >= MIN_SAMPLES) {
    const dismissRate = (feedback.dismissed + feedback.blocked) / judged;
    if (dismissRate >= DISMISS_PAUSE_THRESHOLD) {
      return {
        allow: false,
        reason: 'dismiss-paused',
        rate: dismissRate,
        measured: judged,
        accepted: feedback.accepted,
        dismissed: feedback.dismissed,
        blocked: feedback.blocked,
      };
    }
  }

  // Compute current outcome stats for this kind (last 30d window).
  const summary = summarizeByKind(userId).find(s => s.kind === kind);
  if (!summary || summary.measured < MIN_SAMPLES) {
    return { allow: true, reason: 'insufficient-data', measured: summary?.measured ?? 0 };
  }
  const rate = summary.measured > 0 ? summary.improved / summary.measured : 0;
  if (rate < PAUSE_THRESHOLD) {
    return {
      allow: false, reason: 'paused',
      rate, measured: summary.measured, improved: summary.improved,
      semantic: summary.semantic || 'lower-better',
    };
  }
  return { allow: true, reason: 'healthy', rate, measured: summary.measured };
}

/**
 * Aggregate verdict across ALL kinds present in the user's outcomes — used
 * by /api/learnings to surface paused kinds in the panel.
 */
export function getAllStatuses(userId) {
  const out = [];
  const seen = new Set();
  const summary = summarizeByKind(userId);
  for (const s of summary) {
    seen.add(s.kind);
    const status = getKindStatus(userId, s.kind);
    out.push({ kind: s.kind, ...status });
  }
  const p = path.join(USERS_DIR, userId, 'proposals.json');
  const data = readJsonSafe(p);
  for (const rec of Array.isArray(data?.proposals) ? data.proposals : []) {
    if (!rec?.kind || seen.has(rec.kind)) continue;
    const status = getKindStatus(userId, rec.kind);
    if (status.reason === 'dismiss-paused') {
      seen.add(rec.kind);
      out.push({ kind: rec.kind, ...status });
    }
  }
  return out;
}

/**
 * Manual reset — user clicked "resume emission" on a paused kind in the
 * panel. We set resetAt to now; for the next 7 days, getKindStatus returns
 * allow=true for this kind regardless of outcome stats. After 7d the gate
 * re-evaluates from real data.
 */
export async function resetKind(userId, kind) {
  if (!userId || !kind) return { ok: false, error: 'bad args' };
  const overrides = loadResetOverrides(userId);
  overrides[kind] = { resetAt: Date.now() };
  await saveResetOverrides(userId, overrides);
  return { ok: true };
}

export const SALIENCE = {
  MIN_SAMPLES, PAUSE_THRESHOLD, DISMISS_PAUSE_THRESHOLD, TARGET_DISMISS_SUPPRESS_COUNT, RESET_DURATION_MS,
};
