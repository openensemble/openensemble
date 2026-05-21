/**
 * Per-skill telemetry — counts invocations and corrections so we can spot
 * user-created skills that aren't pulling their weight, then propose
 * deprecation. The "OE-better-than-Hermes" half of the learning loop: Hermes
 * accumulates skills forever; OE prunes them when the user keeps overriding
 * the skill's behavior with raw tool calls or corrections.
 *
 * Storage: users/<uid>/skill-telemetry.json
 *   { "usr_research_email": {
 *       invocations: 12,
 *       corrections: 1,
 *       lastInvokedAt: 1715...,
 *       lastCorrectionAt: 1715...,
 *       deprecationProposedAt: 0
 *     }, ... }
 *
 * Attribution model: a correction "belongs to" the most recent user-skill
 * invocation within RECENT_WINDOW_MS. False positives are bounded because
 * (a) only signals classified as CORRECTION by the cortex head reach
 *     recordCorrection, and
 * (b) we reset the recent-invocations buffer after attributing.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR, userSkillsDir } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const RECENT_WINDOW_MS = 5 * 60 * 1000;
const MIN_INVOCATIONS_FOR_DEPRECATION = 5;
const DEPRECATION_THRESHOLD = 0.5;

// Mid-zone refine proposal — between "skill is fine" (<REFINE_LOWER) and
// "skill should be deleted" (>=DEPRECATION_THRESHOLD). Fires earlier (3
// invocations instead of 5) because catching a small problem early is much
// cheaper than letting it drift to deprecation. recentCorrections are stored
// per-skill so the accept handler can feed them to coder for skill_patch_code.
const MIN_INVOCATIONS_FOR_REFINE = 3;
const REFINE_LOWER_THRESHOLD = 0.20;
const REFINE_UPPER_THRESHOLD = DEPRECATION_THRESHOLD;
const MAX_RECENT_CORRECTIONS = 5;
const MAX_CORRECTION_TEXT_LEN = 240;

const _telemetryByUser = new Map();           // userId -> Map(skillId -> stats)
const _recentInvocations = new Map();         // userId -> [{ skillId, ts }]
const _toolIndexByUser = new Map();           // userId -> { toolName: skillId }
const _toolIndexMtime = new Map();            // userId -> last skills-dir mtime we indexed

function telemetryPath(userId) {
  return path.join(USERS_DIR, userId, 'skill-telemetry.json');
}

function loadUser(userId) {
  if (_telemetryByUser.has(userId)) return _telemetryByUser.get(userId);
  const map = new Map();
  const p = telemetryPath(userId);
  if (fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const [skillId, stats] of Object.entries(data)) map.set(skillId, stats);
    } catch { /* ignore — corrupt telemetry shouldn't break chat */ }
  }
  _telemetryByUser.set(userId, map);
  return map;
}

async function persistUser(userId) {
  const map = _telemetryByUser.get(userId);
  if (!map) return;
  const data = Object.fromEntries(map);
  const p = telemetryPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  });
}

// Rebuild the tool→skill index when the user's skills dir mtime changes.
// Cheaper than scanning every tool call and works fine even with skill-builder
// hot-loads since skill_create writes a new manifest.json which bumps the
// parent dir's mtime.
function getToolIndex(userId) {
  const dir = userSkillsDir(userId);
  if (!fs.existsSync(dir)) { _toolIndexByUser.set(userId, {}); return {}; }
  const dirMtime = fs.statSync(dir).mtimeMs;
  if (_toolIndexMtime.get(userId) === dirMtime && _toolIndexByUser.has(userId)) {
    return _toolIndexByUser.get(userId);
  }
  const idx = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillId = entry.name;
    const manifestPath = path.join(dir, skillId, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      for (const t of manifest.tools || []) {
        const name = t?.function?.name;
        if (name) idx[name] = skillId;
      }
    } catch { /* skip bad manifest */ }
  }
  _toolIndexByUser.set(userId, idx);
  _toolIndexMtime.set(userId, dirMtime);
  return idx;
}

function defaultStats() {
  return {
    invocations: 0, corrections: 0,
    lastInvokedAt: 0, lastCorrectionAt: 0,
    deprecationProposedAt: 0,
    refineProposedAt: 0,
    recentCorrections: [],
  };
}

// Called from chat.mjs persist(). Bumps invocation counters for any user-skill
// tools that fired this turn. Appends to the recent-invocations buffer so a
// subsequent correction can be attributed to the right skill.
export function recordToolInvocations({ userId, toolsUsed }) {
  if (!userId || !Array.isArray(toolsUsed) || !toolsUsed.length) return;
  const idx = getToolIndex(userId);
  if (Object.keys(idx).length === 0) return;
  const userMap = loadUser(userId);
  const now = Date.now();
  const recent = _recentInvocations.get(userId) || [];
  let changed = false;
  for (const t of toolsUsed) {
    const skillId = idx[t?.name];
    if (!skillId) continue;
    const stats = userMap.get(skillId) ?? defaultStats();
    stats.invocations++;
    stats.lastInvokedAt = now;
    userMap.set(skillId, stats);
    recent.push({ skillId, ts: now });
    changed = true;
  }
  if (changed) {
    const cutoff = now - RECENT_WINDOW_MS;
    _recentInvocations.set(userId, recent.filter(r => r.ts >= cutoff));
    persistUser(userId).catch(e => console.warn('[skill-telemetry] persist failed:', e.message));
  }
}

// Called from memory/signals.mjs when the cortex head classifies the user's
// turn as a CORRECTION. Attributes the correction to the most recently
// invoked user-skill within RECENT_WINDOW_MS (closest in time = most likely
// culprit). Resets the buffer after attribution so the same correction never
// double-counts against a different skill.
//
// correctionText is the parsed correction string (without the "CORRECTION: "
// prefix from cortex bookkeeping). Stored on the skill's stats so the refine
// accept handler can feed past corrections to coder for skill_patch_code.
export async function recordCorrection({ userId, agentId, correctionText }) {
  if (!userId) return null;
  const recent = _recentInvocations.get(userId);
  if (!recent || recent.length === 0) return null;
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const fresh = recent.filter(r => r.ts >= cutoff);
  if (fresh.length === 0) {
    _recentInvocations.set(userId, []);
    return null;
  }
  const last = fresh[fresh.length - 1];
  const userMap = loadUser(userId);
  const stats = userMap.get(last.skillId);
  if (!stats) return null;
  stats.corrections++;
  stats.lastCorrectionAt = Date.now();

  // Stash the correction text on the skill so a future refine proposal has
  // concrete content to feed coder. Keep the last MAX_RECENT_CORRECTIONS;
  // oldest dropped.
  if (correctionText && typeof correctionText === 'string') {
    if (!Array.isArray(stats.recentCorrections)) stats.recentCorrections = [];
    stats.recentCorrections.push({
      text: correctionText.slice(0, MAX_CORRECTION_TEXT_LEN),
      ts: Date.now(),
    });
    if (stats.recentCorrections.length > MAX_RECENT_CORRECTIONS) {
      stats.recentCorrections = stats.recentCorrections.slice(-MAX_RECENT_CORRECTIONS);
    }
  }

  userMap.set(last.skillId, stats);
  _recentInvocations.set(userId, []);
  await persistUser(userId).catch(e => console.warn('[skill-telemetry] persist failed:', e.message));

  const ratio = stats.corrections / stats.invocations;

  // Auto-deprecate proposal — emit at most once per skill. Checked FIRST
  // because deprecation strictly dominates refine: if a skill is in the
  // deprecation zone, refining is unlikely to help.
  if (stats.invocations >= MIN_INVOCATIONS_FOR_DEPRECATION
      && ratio >= DEPRECATION_THRESHOLD
      && !stats.deprecationProposedAt) {
    stats.deprecationProposedAt = Date.now();
    userMap.set(last.skillId, stats);
    await persistUser(userId).catch(() => {});
    try {
      const { proposeSkillDeprecation } = await import('./proposals.mjs');
      return proposeSkillDeprecation({
        userId, agentId, skillId: last.skillId,
        invocations: stats.invocations, corrections: stats.corrections,
      });
    } catch (e) {
      console.warn('[skill-telemetry] deprecation propose failed:', e.message);
    }
  }

  // Mid-zone refine proposal — fires earlier (3 invocations vs 5 for
  // deprecation) since catching drift early is cheaper than rebuilding from
  // scratch. refineProposedAt gates re-fire; the accept handler clears it via
  // resetAfterRefine() so future refines can fire when new corrections
  // accumulate.
  if (stats.invocations >= MIN_INVOCATIONS_FOR_REFINE
      && ratio >= REFINE_LOWER_THRESHOLD
      && ratio < REFINE_UPPER_THRESHOLD
      && !stats.refineProposedAt) {
    stats.refineProposedAt = Date.now();
    userMap.set(last.skillId, stats);
    await persistUser(userId).catch(() => {});
    try {
      const { proposeSkillRefine } = await import('./proposals.mjs');
      return proposeSkillRefine({
        userId, agentId, skillId: last.skillId,
        invocations: stats.invocations, corrections: stats.corrections,
        recentCorrections: (stats.recentCorrections || []).map(c => c.text),
      });
    } catch (e) {
      console.warn('[skill-telemetry] refine propose failed:', e.message);
    }
  }

  return null;
}

// Called by the refine proposal accept handler after coder successfully
// patches the skill. Resets the correction-rate clock so the skill gets a
// fair re-evaluation post-refinement — keeping the old counts would mean a
// successfully-refined skill could still hit deprecation threshold on its
// very next correction. The refineProposedAt timestamp is also cleared so
// future refines can fire if drift recurs.
export async function resetAfterRefine({ userId, skillId }) {
  if (!userId || !skillId) return;
  const userMap = loadUser(userId);
  const stats = userMap.get(skillId);
  if (!stats) return;
  stats.invocations = 0;
  stats.corrections = 0;
  stats.recentCorrections = [];
  stats.refineProposedAt = 0;
  // Intentionally leave deprecationProposedAt — if a skill was once on the
  // deprecation path and got refined back, don't auto-re-propose deletion
  // until much more evidence accumulates.
  userMap.set(skillId, stats);
  await persistUser(userId).catch(e => console.warn('[skill-telemetry] reset persist failed:', e.message));
}

export function getSkillStats(userId) {
  return Object.fromEntries(loadUser(userId));
}

export function _resetForTests() {
  _telemetryByUser.clear();
  _recentInvocations.clear();
  _toolIndexByUser.clear();
  _toolIndexMtime.clear();
}
