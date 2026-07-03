// @ts-check
/**
 * Proposal outcome telemetry.
 *
 * For each accepted proposal we snapshot the user's recent-proposal-emission
 * rate at accept time, then re-measure 7d later. Delta tells us whether
 * accepting that learning correlated with falling/rising friction. The
 * outcomes feed a per-kind rolling average shown in the Learn panel so the
 * user (and we) can see which kinds of proposals are actually helping.
 *
 * Design choices:
 *  - Lazy post-snapshot: we don't schedule a 7d wakeup. The next read after
 *    `acceptedAt + 7d` computes the post count from the proposals log. Saves
 *    a scheduler entry per acceptance.
 *  - Coarse signal: "proposals emitted to this user in the 7d window." Per-
 *    kind correction-count or friction-cluster matching would be cleaner but
 *    requires NLI work; this gives us SOMETHING measurable today.
 *  - Per-user, append-only. Never grows unbounded (one entry per accept).
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock, atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { measureProposalOutcome, hasMeasurer } from './proposal-outcome-measurers.mjs';

const POST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;   // for summarizeByKind

function outcomesPath(userId) {
  return path.join(USERS_DIR, userId, 'proposal-outcomes.json');
}
function proposalsPath(userId) {
  return path.join(USERS_DIR, userId, 'proposals.json');
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadOutcomes(userId) {
  return readJsonSafe(outcomesPath(userId)) || {};
}

/**
 * All writes go through this locked load-mutate-save. Loading outside the
 * lock and saving the whole map (the old saveOutcomes shape) let a lazy
 * post-snapshot save and an accept-time updateOutcomePayload interleave and
 * lose one side — if the newSkillId patch lost, the measurer returned null
 * for that accept forever. `fn` mutates the fresh map in place; return
 * `false` to skip the write when nothing changed.
 */
async function modifyOutcomes(userId, fn) {
  const p = outcomesPath(userId);
  await withLock(p, () => {
    const all = readJsonSafe(p) || {};
    if (fn(all) === false) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    atomicWriteSync(p, JSON.stringify(all));
  });
}

// Count proposals (any kind, any status) emitted to this user within
// [from, to). Reads from the user's proposals.json — the canonical store.
function countProposalsInWindow(userId, from, to) {
  const data = readJsonSafe(proposalsPath(userId));
  const arr = Array.isArray(data?.proposals) ? data.proposals : [];
  let n = 0;
  for (const r of arr) {
    const ts = r.createdAt || 0;
    if (ts >= from && ts < to) n++;
  }
  return n;
}

/**
 * Called at accept time. Stashes enough of the proposal payload to let the
 * per-kind measurer run later (tool/arg/agentId/skillId — small set, never
 * grows). Also caches the coarse baseline so kinds without a measurer still
 * get a number.
 */
export async function recordPreAcceptSnapshot(proposal) {
  if (!proposal?.id || !proposal?.userId || !proposal?.acceptedAt) return;
  const userId = proposal.userId;
  const acceptedAt = proposal.acceptedAt;
  const coarsePreCount = countProposalsInWindow(userId, acceptedAt - POST_WINDOW_MS, acceptedAt);

  const entry = {
    kind: proposal.kind,
    acceptedAt,
    preCount: coarsePreCount,          // overwritten by measurer at post-check if kind has one
    postCount: null,
    delta: null,
    semantic: null,                    // filled by measurer
    note: null,                        // filled by measurer
    measurerUsed: hasMeasurer(proposal.kind) ? proposal.kind : null,
    checkAt: acceptedAt + POST_WINDOW_MS,
    // Stash the proposal payload the measurer needs. Keep it tight — only
    // the fields actually consumed by registered measurers.
    proposalPayload: {
      tool: proposal.tool || null,
      arg: proposal.arg || null,
      skillId: proposal.skillId || null,
      agentId: proposal.agentId || null,
      // newSkillId + routineId + overrideId + phrase start null — patched by
      // their accept handlers via updateOutcomePayload() once the
      // skill/routine/override/alias has been created.
      newSkillId: proposal.newSkillId || null,
      routineId: null,
      overrideId: null,
      phrase: proposal.phrase || null,
      hostname: proposal.hostname || null,
      failedPath: proposal.failedPath || null,
    },
  };
  try {
    await modifyOutcomes(userId, all => { all[proposal.id] = entry; });
  } catch (e) {
    console.warn('[proposal-outcomes] pre-snapshot persist failed:', e.message);
  }
}

/**
 * Lazy: for every outcome record whose `checkAt` has passed AND whose
 * postCount is still unmeasured, compute the post count and fill in. Returns
 * the full outcomes map ready for the reader.
 */
function _applyLazyPostSnapshots(userId) {
  const all = loadOutcomes(userId);
  const now = Date.now();
  const updates = {}; // pid → measured fields, re-applied on fresh data under the lock
  for (const [pid, rec] of Object.entries(all)) {
    if (rec.postCount !== null && rec.postCount !== undefined) continue;
    if (!rec.checkAt || now < rec.checkAt) continue;

    // Try the per-kind measurer first. Reconstruct the minimal proposal-shape
    // it expects from the stashed payload.
    const proposalShape = {
      kind: rec.kind,
      acceptedAt: rec.acceptedAt,
      ...(rec.proposalPayload || {}),
    };
    const measured = measureProposalOutcome(userId, proposalShape);
    let fields;
    if (measured) {
      fields = {
        preCount:  measured.preCount,
        postCount: measured.postCount,
        delta:     measured.delta,
        semantic:  measured.semantic || 'lower-better',
        note:      measured.note || null,
        measurerUsed: rec.kind,
      };
    } else {
      // Fallback: coarse "proposals emitted in window" count.
      const postCount = countProposalsInWindow(userId, rec.acceptedAt, rec.acceptedAt + POST_WINDOW_MS);
      fields = {
        postCount,
        delta: postCount - (rec.preCount || 0),
        semantic: rec.semantic || 'lower-better',   // coarse signal: fewer proposals = less friction
        note: rec.note || 'proposals to you (coarse)',
        measurerUsed: null,
      };
    }
    Object.assign(rec, fields);   // this reader's view
    updates[pid] = fields;
  }
  if (Object.keys(updates).length) {
    // Persist by re-applying on FRESH data under the lock — writing back the
    // map read above could clobber a concurrent accept-time write that landed
    // between our read and the save.
    modifyOutcomes(userId, fresh => {
      let any = false;
      for (const [pid, fields] of Object.entries(updates)) {
        const rec = fresh[pid];
        if (!rec) continue;
        if (rec.postCount !== null && rec.postCount !== undefined) continue; // measured concurrently
        Object.assign(rec, fields);
        any = true;
      }
      return any ? undefined : false;
    }).catch(() => {});
  }
  return all;
}

export function listProposalOutcomes(userId) {
  if (!userId) return [];
  const all = _applyLazyPostSnapshots(userId);
  return Object.entries(all).map(([proposalId, rec]) => ({ proposalId, ...rec }));
}

/**
 * Per-kind rolling average over the last 30 days. For each kind we report:
 *   measured   — how many accepts have completed their 7d post-window
 *   improved   — how many of those had delta <= 0 (friction same or down)
 *   sampleSize — total accepts including unmeasured-yet ones
 *
 * The UI uses these to show a tight one-liner per kind without exposing the
 * raw delta numbers (which are noisy at small sample sizes).
 */
export function summarizeByKind(userId) {
  const all = listProposalOutcomes(userId);
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  const byKind = {};
  for (const rec of all) {
    if ((rec.acceptedAt || 0) < cutoff) continue;
    const k = rec.kind || 'unknown';
    if (!byKind[k]) {
      byKind[k] = {
        kind: k, measured: 0, improved: 0, sampleSize: 0,
        semantic: rec.semantic || 'lower-better',
        usesMeasurer: !!rec.measurerUsed,
      };
    }
    byKind[k].sampleSize++;
    if (rec.postCount !== null && rec.postCount !== undefined) {
      byKind[k].measured++;
      // "improved" interpretation depends on semantic:
      //   lower-better:  delta <= 0 is improvement (the bad thing didn't happen)
      //   higher-better: delta >  0 is improvement (the good thing actually
      //     happened). NOT >= 0: these measurers report a raw post-window usage
      //     count with preCount 0, so >= 0 was always true — an accepted skill
      //     never invoked once still scored "improved", which then *loosened*
      //     the evidence gate (learning-policy) for that whole proposal kind.
      const semantic = rec.semantic || 'lower-better';
      const delta = rec.delta ?? 0;
      const isImproved = semantic === 'higher-better' ? (delta > 0) : (delta <= 0);
      if (isImproved) byKind[k].improved++;
    }
  }
  return Object.values(byKind).sort((a, b) => b.sampleSize - a.sampleSize);
}

/** Single-proposal lookup so the panel can decorate a specific card. */
export function getOutcome(userId, proposalId) {
  const all = _applyLazyPostSnapshots(userId);
  return all[proposalId] || null;
}

/**
 * Update fields inside the stashed proposalPayload of an outcome record.
 * Used by appliers that produce data AFTER the snapshot (e.g. the
 * skill_proposal applier creates a new skill and needs to record the
 * resulting newSkillId so the measurer can correlate later). No-op if
 * the outcome record doesn't exist.
 */
export async function updateOutcomePayload(userId, proposalId, patch) {
  if (!userId || !proposalId || !patch) return;
  try {
    await modifyOutcomes(userId, all => {
      const rec = all[proposalId];
      if (!rec) return false;
      rec.proposalPayload = { ...(rec.proposalPayload || {}), ...patch };
    });
  } catch (e) {
    console.warn('[proposal-outcomes] payload patch persist failed:', e.message);
  }
}
