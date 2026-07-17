// @ts-check
/**
 * Proposal salience gate — closes the proposal feedback loop.
 *
 * Homogeneous proposal kinds use rolling kind-level outcomes. Heterogeneous
 * learned-intent proposals are judged only at skillId + intentId scope so a
 * rejected mapping cannot silence every other mapping. Personalization has
 * its own authoritative per-offerKind policy in personalization/graduation
 * and therefore bypasses this generic gate entirely.
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
import { proposalFeedbackSummary, targetKeyForProposal, RETIRED_PROPOSAL_KINDS } from './learning-policy.mjs';

const MIN_SAMPLES = 3;                                    // floor before judging
const PAUSE_THRESHOLD = 0.5;                              // improvement rate below → paused
const DISMISS_PAUSE_THRESHOLD = 0.67;                     // recent dismiss/block rate at/above → paused
const TARGET_DISMISS_SUPPRESS_COUNT = 2;                  // same target dismissed twice → suppressed
const RESET_DURATION_MS = 7 * 24 * 60 * 60 * 1000;        // manual-reset grace window
const TARGET_SCOPED_KINDS = new Set(['learned_intent']);

function usesPersonalizationPolicy(kind) {
  return typeof kind === 'string' && kind.startsWith('personalization_');
}

// ── Pause-transition notices ────────────────────────────────────────────────
// getKindStatus() is called on every createProposal() attempt AND every
// /api/learnings panel load — without edge-detection, surfacing a notice
// inline here would re-fire continuously for as long as a kind stays paused.
// Track the last-notified reason per (userId, kind) and only notify when it
// actually CHANGES into a paused state; clear it when the kind becomes
// healthy again (or the user manually resets it) so a LATER pause is a fresh
// transition and notifies again.
//
// No event channel already reaches the browser from this low-level module
// (unlike the provider generators, which yield straight into an existing
// per-turn stream) — proposals.mjs's own WS push and lib/runtime-warn.mjs's
// cortex_warning broadcast both use the same DI-setter pattern for the same
// reason (this file sits low in the import graph; ws-handler.mjs sits at the
// top — a direct import would risk a require cycle). setSalienceNotifyBroadcast
// must be wired the same way at boot; until it is, this is a silent no-op.
/** @type {(userId: string, msg: {type: string, message: string}) => void} */
let _notifyFn = (_userId, _msg) => {};
export function setSalienceNotifyBroadcast(fn) { _notifyFn = typeof fn === 'function' ? fn : (_userId, _msg) => {}; }

const _pauseNotifyState = new Map(); // `${userId}:${kind}` -> last-notified reason

function _notifyPauseTransition(userId, kind, reason) {
  const key = `${userId}:${kind}`;
  if (_pauseNotifyState.get(key) === reason) return; // already notified this pause
  _pauseNotifyState.set(key, reason);
  _notifyFn(userId, {
    type: 'cortex_warning',
    message: `Paused suggesting ${kind} proposals — they weren't landing. Resume anytime in Learn.`,
  });
}

function _clearPauseNotifyState(userId, kind) {
  _pauseNotifyState.delete(`${userId}:${kind}`);
}

function overridesPath(userId) {
  return path.join(USERS_DIR, userId, 'salience-overrides.json');
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function targetDescriptor(record, targetKey) {
  if (record?.kind === 'learned_intent') {
    const skillId = String(record.skillId || '').trim();
    const intentId = String(record.intentId || '').trim();
    return {
      type: 'learned_intent',
      skillId: skillId || null,
      intentId: intentId || null,
      label: skillId && intentId ? `${skillId}/${intentId}` : targetKey,
    };
  }
  return { type: 'proposal', label: targetKey };
}

function targetDescriptorFromKey(kind, targetKey) {
  if (kind === 'learned_intent' && targetKey.startsWith('learned:')) {
    const [skillId, ...intentParts] = targetKey.slice('learned:'.length).split(':');
    const intentId = intentParts.join(':');
    if (skillId && intentId) {
      return { type: 'learned_intent', skillId, intentId, label: `${skillId}/${intentId}` };
    }
  }
  return { type: 'proposal', label: targetKey };
}

function permanentTargetBlocks(data, kind) {
  const blocked = Array.isArray(data?.blockedPatterns) ? data.blockedPatterns : [];
  if (kind === 'learned_intent') return new Set(blocked.filter(key => typeof key === 'string' && key.startsWith('learned:')));
  return new Set();
}

/** UI-facing inventory of exact targets currently suppressed by salience. */
function listSuppressedTargets(userId, kind) {
  const p = path.join(USERS_DIR, userId, 'proposals.json');
  const data = readJsonSafe(p);
  const records = Array.isArray(data?.proposals) ? data.proposals : [];
  const permanentBlocks = permanentTargetBlocks(data, kind);
  const targets = new Map();
  for (const record of records) {
    if (record?.kind !== kind) continue;
    const targetKey = targetKeyForProposal(record);
    if (!targetKey || targets.has(targetKey)) continue;
    targets.set(targetKey, targetDescriptor(record, targetKey));
  }
  for (const targetKey of permanentBlocks) {
    if (!targets.has(targetKey)) targets.set(targetKey, targetDescriptorFromKey(kind, targetKey));
  }

  const out = [];
  for (const [targetKey, target] of targets) {
    const feedback = proposalFeedbackSummary(userId, { targetKey });
    const permanentlyBlocked = permanentBlocks.has(targetKey);
    const weightedDismisses = feedback.dismissed + (feedback.blocked * 2);
    if (!permanentlyBlocked && weightedDismisses < TARGET_DISMISS_SUPPRESS_COUNT) continue;
    const blocked = Math.max(feedback.blocked, permanentlyBlocked ? 1 : 0);
    out.push({
      targetKey,
      target,
      reason: blocked > 0 ? 'target-blocked' : 'target-dismissed',
      accepted: feedback.accepted,
      dismissed: feedback.dismissed,
      blocked,
      measured: feedback.accepted + feedback.dismissed + blocked,
    });
  }
  return out.sort((a, b) => String(a.target?.label || a.targetKey).localeCompare(String(b.target?.label || b.targetKey)));
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
 *   { allow: true, reason: 'insufficient-data' | 'healthy' | 'reset-grace' |
 *       'personalization-own-gates' | 'target-healthy' | 'target-scoped', ...stats }
 *   { allow: false, reason: 'paused' | 'dismiss-paused' | 'target-dismissed' |
 *       'target-blocked', ...stats }
 *
 * "insufficient-data" means we don't yet have enough measured outcomes to
 * judge — always allow. "reset-grace" means the user explicitly unpaused
 * recently — allow for the grace window even if the underlying rate is bad.
 */
export function getKindStatus(userId, kind, record = null) {
  if (!userId || !kind) return { allow: true, reason: 'no-args' };

  // Personalization already maintains exact offer-kind accept/dismiss
  // counters, suppression TTLs, manual mute, and resume controls. Applying a
  // second generic kind gate here was what let three unrelated dismissals
  // silence every personalization offer.
  if (usesPersonalizationPolicy(kind)) {
    _clearPauseNotifyState(userId, kind);
    return { allow: true, reason: 'personalization-own-gates', scope: 'offer-kind' };
  }

  // Manual reset override — short-circuit any computed pause for the grace
  // window. After expiry, we re-check normally.
  const overrides = loadResetOverrides(userId);
  const reset = overrides[kind];
  if (!TARGET_SCOPED_KINDS.has(kind) && reset?.resetAt && Date.now() - reset.resetAt < RESET_DURATION_MS) {
    _clearPauseNotifyState(userId, kind); // user explicitly resumed — arm for a fresh pause notice later
    return { allow: true, reason: 'reset-grace', scope: 'kind', resetAt: reset.resetAt };
  }

  if (!record && TARGET_SCOPED_KINDS.has(kind)) {
    const pausedTargets = listSuppressedTargets(userId, kind);
    return {
      allow: true,
      reason: pausedTargets.length ? 'targets-dismissed' : 'target-scoped',
      scope: 'target',
      pausedTargetCount: pausedTargets.length,
      pausedTargets,
    };
  }

  const targetKey = record ? targetKeyForProposal(record) : null;
  if (targetKey) {
    const target = proposalFeedbackSummary(userId, { targetKey });
    const proposalData = readJsonSafe(path.join(USERS_DIR, userId, 'proposals.json'));
    const permanentlyBlocked = permanentTargetBlocks(proposalData, kind).has(targetKey);
    const targetDismisses = target.dismissed + (target.blocked * 2);
    if (permanentlyBlocked || targetDismisses >= TARGET_DISMISS_SUPPRESS_COUNT) {
      const blocked = Math.max(target.blocked, permanentlyBlocked ? 1 : 0);
      return {
        allow: false,
        reason: blocked > 0 ? 'target-blocked' : 'target-dismissed',
        scope: 'target',
        targetKey,
        target: targetDescriptor(record, targetKey),
        accepted: target.accepted,
        dismissed: target.dismissed,
        blocked,
        measured: target.accepted + target.dismissed + blocked,
      };
    }
  }

  // A learned intent is heterogeneous by construction. Once its exact target
  // is healthy, do not fall through to kind-wide dismissal or coarse outcome
  // gates that include unrelated skills and intents.
  if (TARGET_SCOPED_KINDS.has(kind)) {
    return {
      allow: true,
      reason: targetKey ? 'target-healthy' : 'target-missing',
      scope: 'target',
      ...(targetKey ? { targetKey, target: targetDescriptor(record, targetKey) } : {}),
    };
  }

  const feedback = proposalFeedbackSummary(userId, { kind });
  const judged = feedback.accepted + feedback.dismissed + feedback.blocked;
  if (judged >= MIN_SAMPLES) {
    const dismissRate = (feedback.dismissed + feedback.blocked) / judged;
    if (dismissRate >= DISMISS_PAUSE_THRESHOLD) {
      _notifyPauseTransition(userId, kind, 'dismiss-paused');
      return {
        allow: false,
        reason: 'dismiss-paused',
        scope: 'kind',
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
    return { allow: true, reason: 'insufficient-data', scope: 'kind', measured: summary?.measured ?? 0 };
  }
  const rate = summary.measured > 0 ? summary.improved / summary.measured : 0;
  if (rate < PAUSE_THRESHOLD) {
    _notifyPauseTransition(userId, kind, 'paused');
    return {
      allow: false, reason: 'paused', scope: 'kind',
      rate, measured: summary.measured, improved: summary.improved,
      semantic: summary.semantic || 'lower-better',
    };
  }
  _clearPauseNotifyState(userId, kind);
  return { allow: true, reason: 'healthy', scope: 'kind', rate, measured: summary.measured };
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
    if (RETIRED_PROPOSAL_KINDS.has(s.kind)) continue;
    seen.add(s.kind);
    const status = getKindStatus(userId, s.kind);
    out.push({ kind: s.kind, ...status });
  }
  const p = path.join(USERS_DIR, userId, 'proposals.json');
  const data = readJsonSafe(p);
  for (const rec of Array.isArray(data?.proposals) ? data.proposals : []) {
    if (!rec?.kind || seen.has(rec.kind) || RETIRED_PROPOSAL_KINDS.has(rec.kind)) continue;
    const status = getKindStatus(userId, rec.kind);
    if (status.reason === 'dismiss-paused' || status.reason === 'targets-dismissed') {
      seen.add(rec.kind);
      out.push({ kind: rec.kind, ...status });
    }
  }
  // A permanent exact-target block can outlive both its proposal record and
  // the rolling outcome window. Keep it visible in Learn by deriving the
  // target-scoped kind from the durable blocked-pattern inventory as well.
  if (!seen.has('learned_intent') && permanentTargetBlocks(data, 'learned_intent').size > 0) {
    out.push({ kind: 'learned_intent', ...getKindStatus(userId, 'learned_intent') });
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
  if (usesPersonalizationPolicy(kind)) {
    return { ok: false, error: 'personalization offer types are resumed from Personalization settings' };
  }
  if (TARGET_SCOPED_KINDS.has(kind)) {
    return { ok: false, error: 'target-scoped suggestions cannot be resumed as a whole category' };
  }
  const overrides = loadResetOverrides(userId);
  overrides[kind] = { resetAt: Date.now() };
  await saveResetOverrides(userId, overrides);
  return { ok: true };
}

export const SALIENCE = {
  MIN_SAMPLES, PAUSE_THRESHOLD, DISMISS_PAUSE_THRESHOLD, TARGET_DISMISS_SUPPRESS_COUNT, RESET_DURATION_MS,
};
