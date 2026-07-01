// @ts-check
/**
 * First-week sweep — the stranger-onboarding moment.
 *
 * Day 7 of a user's existence, we re-run the proposal detectors against
 * accumulated signals with RELAXED thresholds. The goal: catch likely
 * customizations from the user's first impressions, when normal runtime
 * thresholds (3 occurrences, 2 router-mistakes, etc.) may not have tripped
 * yet but enough signal exists to ask "want this set up?"
 *
 * Trigger: lazy, on GET /api/learnings. We never schedule a wakeup — the
 * user's next opening of the Learn panel after day-7 carries the sweep.
 *
 * Safeguards:
 *  - Existing users (user-dir mtime > 30d at first observation): marked
 *    skipped with reason 'late-init'. We didn't see them in week 1.
 *  - Phase-7 salience gate still applies — sweep emissions go through
 *    createProposal which respects kind-level pauses.
 *  - Idempotency: once `done`, never re-runs.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const SWEEP_DELAY_MS    = 7 * 24 * 60 * 60 * 1000;
const LATE_INIT_AGE_MS  = 30 * 24 * 60 * 60 * 1000;

// Default-arg learning used to mine agent-authored tool calls. Runtime now
// requires a user-authored value from the live turn, which a day-7 sweep cannot
// reconstruct from old counters, so the sweep no longer emits default_arg.
const SWEEP_FAILURE_UNIQUE_PREFIX = 2;     // runtime: 3
const SWEEP_ROUTER_MISTAKE_THRESHOLD = 1;  // runtime: 2

function statusPath(userId) {
  return path.join(USERS_DIR, userId, 'week1-sweep.json');
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadSweepStatus(userId) {
  const p = statusPath(userId);
  if (fs.existsSync(p)) {
    const existing = readJsonSafe(p);
    if (existing) return existing;
  }
  // First time we're looking at this user — stamp firstSeen, decide if
  // they're "late-init" (pre-existing). Use birthtimeMs (dir creation time)
  // because mtimeMs is bumped on every file write inside the dir, which
  // misclassifies long-time users as new.
  const userDir = path.join(USERS_DIR, userId);
  let dirBirth = Date.now();
  try {
    const st = fs.statSync(userDir);
    // birthtime support is fs-dependent; on filesystems where it's not
    // available (e.g. some virtualised mounts) it falls back to mtime.
    // 0 / NaN / future-dated birthtime → trust mtime, then now.
    const b = st.birthtimeMs;
    if (Number.isFinite(b) && b > 0 && b <= Date.now()) dirBirth = b;
    else if (Number.isFinite(st.mtimeMs)) dirBirth = st.mtimeMs;
  } catch {}
  const dirAge = Date.now() - dirBirth;
  if (dirAge > LATE_INIT_AGE_MS) {
    const status = { firstSeenAt: dirBirth, done: true, skipped: true, reason: 'late-init' };
    // Persist now so the second call reads it back without re-walking.
    saveSweepStatus(userId, status).catch(() => {});
    return status;
  }
  const fresh = { firstSeenAt: Date.now(), done: false };
  saveSweepStatus(userId, fresh).catch(() => {});
  return fresh;
}

async function saveSweepStatus(userId, status) {
  const p = statusPath(userId);
  await withLock(p, () => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(status, null, 2));
  });
}

export function getSweepStatus(userId) {
  return loadSweepStatus(userId);
}

/**
 * Force a sweep run regardless of timing. Used by the manual test trigger;
 * not called from the lazy hook. Backdates firstSeenAt so the elapsed
 * check passes, then runs the sweep normally.
 */
export async function forceRun(userId) {
  const status = loadSweepStatus(userId);
  if (status.done) return { ran: false, reason: 'already-done', status };
  status.firstSeenAt = Date.now() - (SWEEP_DELAY_MS + 1000);
  await saveSweepStatus(userId, status);
  return runSweep(userId, status);
}

/**
 * Public: called lazily from GET /api/learnings. Side-effect free unless the
 * gate conditions are met. Fire-and-forget — never blocks the GET.
 */
export async function maybeRunSweep(userId) {
  if (!userId) return { ran: false, reason: 'no-user' };
  const status = loadSweepStatus(userId);
  if (status.done) return { ran: false, reason: status.skipped ? 'skipped' : 'already-done' };

  const elapsed = Date.now() - (status.firstSeenAt || Date.now());
  if (elapsed < SWEEP_DELAY_MS) {
    // Save initial first-seen so we don't lose it next call
    if (!status.firstSeenAt) {
      status.firstSeenAt = Date.now();
      await saveSweepStatus(userId, status);
    }
    return { ran: false, reason: 'too-soon', daysLeft: Math.ceil((SWEEP_DELAY_MS - elapsed) / 86400000) };
  }

  return runSweep(userId, status);
}

async function runSweep(userId, status) {
  const emitted = [];
  try {
    await _sweepToolFailures(userId, emitted);
    await _sweepRouterMistakes(userId, emitted);
  } catch (e) {
    console.warn('[week1-sweep] sweep threw:', e.message);
  }
  status.done = true;
  status.ranAt = Date.now();
  status.proposalsEmitted = emitted.length;
  status.emittedKinds = emitted.map(e => e.kind);
  await saveSweepStatus(userId, status);
  console.log(`[week1-sweep] user=${userId} emitted=${emitted.length} kinds=[${status.emittedKinds.join(',')}]`);
  return { ran: true, count: emitted.length, emitted };
}

async function _sweepToolFailures(userId, emitted) {
  const failPath = path.join(USERS_DIR, userId, 'tool-failures.json');
  const data = readJsonSafe(failPath) || {};
  const { proposeToolFailure } = await import('./proposals.mjs');
  const cutoff = Date.now() - SWEEP_DELAY_MS;

  for (const [tool, rec] of Object.entries(data)) {
    if (!rec?.msgs || !Array.isArray(rec.msgs)) continue;
    const recent = rec.msgs.filter(m => m.ts > cutoff);
    const unique = new Set(recent.map(m => m.error));
    if (unique.size < SWEEP_FAILURE_UNIQUE_PREFIX) continue;
    const lastErrors = [...unique].slice(-3);
    try {
      const p = await proposeToolFailure({
        userId, agentId: 'week1-sweep',
        tool, skillId: null,
        recentErrors: lastErrors, count: recent.length,
      });
      if (p) emitted.push(p);
    } catch (e) { console.warn('[week1-sweep] tool_failure propose failed:', e.message); }
  }
}

async function _sweepRouterMistakes(userId, emitted) {
  // Reuse maybePropose logic from router-mistakes.mjs but with a relaxed
  // local check — runtime requires THRESHOLD=2 + Jaccard ≥0.4. Sweep
  // accepts THRESHOLD=1 (any single mistake with a meaningful pattern).
  const { loadMistakes } = await import('./router-mistakes.mjs');
  const all = loadMistakes(userId);
  const cutoff = Date.now() - SWEEP_DELAY_MS;
  const recent = all.filter(m => m.ts > cutoff && m.correctedAgent);
  if (recent.length < SWEEP_ROUTER_MISTAKE_THRESHOLD) return;

  // For sweep: emit one proposal per (correctedAgent, derived-pattern). Use
  // the longest non-trivial token from the prev message as the pattern.
  const { proposeRoutingOverride } = await import('./proposals.mjs');
  const seen = new Set();
  for (const m of recent) {
    const pattern = _patternFromMessage(m.prevMessage);
    // Reject patterns shorter than 8 chars OR matching generic command words
    // ("delete", "download", "sentence" → would route every message).
    if (!_isUsefulSweepPattern(pattern)) continue;
    const key = `${m.correctedAgent}:${pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const p = await proposeRoutingOverride({
        userId, agentId: 'week1-sweep',
        correctedAgent: m.correctedAgent,
        correctedAgentName: m.correctedAgent,
        pattern,
        examples: [m.prevMessage],
      });
      if (p) emitted.push(p);
    } catch (e) { console.warn('[week1-sweep] routing_override propose failed:', e.message); }
  }
}

function _patternFromMessage(msg) {
  const lower = String(msg || '').toLowerCase().trim();
  if (!lower) return null;
  // Prefer multi-word phrases — way more selective than single tokens
  const words = lower.split(/\s+/).filter(Boolean);
  for (const wlen of [4, 3, 2]) {
    for (let i = 0; i + wlen <= words.length; i++) {
      const phrase = words.slice(i, i + wlen).join(' ');
      if (phrase.length >= 12) return phrase;     // takes first reasonably long phrase
    }
  }
  // Fallback: longest single token >=6 chars
  const tokens = lower.split(/\W+/).filter(t => t.length >= 6);
  if (!tokens.length) return null;
  return tokens.sort((a, b) => b.length - a.length)[0];
}

const SWEEP_GENERIC_WORDS = new Set([
  'download','delete','update','search','find','look','tell','show','make','get',
  'check','run','start','stop','create','add','remove','set','open','close','list',
  'send','email','message','please','sentence','capital','capitals','word','words',
  'phrase','number','file','code','image','video','channel','user','users','agent',
  'agents','task','tasks',
]);
function _isUsefulSweepPattern(p) {
  if (!p || p.length < 8) return false;
  const words = p.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return true;
  return !SWEEP_GENERIC_WORDS.has(words[0]);
}
