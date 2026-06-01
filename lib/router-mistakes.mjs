// @ts-check
/**
 * Router-as-learner: detect explicit redirects ("@ada", "ask sydney", "use
 * coder") and log them as labeled router-mistake events. After threshold
 * similar mistakes for the same correctedAgent, the dispatcher emits a
 * routing_override proposal — accepting writes a substring rule to
 * routing-overrides.json so the next matching message routes directly.
 *
 * Detection is INTENTIONALLY strict (only explicit agent-name redirects)
 * because false positives here are expensive — every false detection
 * eventually surfaces a proposal that misleads the user.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const THRESHOLD = 2;
const JACCARD_MIN = 0.4;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Strict-pattern detectors. Each yields the named agent if matched.
// All run on normalized (lowercased, trimmed) text.
const REDIRECT_PATTERNS = [
  /^@([a-z][a-z0-9_-]{1,30})\b/i,                       // "@ada something"
  /^(?:no,?\s+)?(?:use|ask|have|let|get)\s+([a-z][a-z0-9_-]{1,30})\b/i,  // "use ada", "ask sydney"
  /^(?:no,?\s+)?(?:try|switch to)\s+([a-z][a-z0-9_-]{1,30})\b/i,
];

/**
 * Run detection against a normalized user message. Returns the named-agent
 * string (lowercased) if any pattern matches, otherwise null.
 */
export function detectRedirect(normalizedText) {
  if (!normalizedText) return null;
  for (const re of REDIRECT_PATTERNS) {
    const m = normalizedText.match(re);
    if (m && m[1]) return m[1].toLowerCase();
  }
  return null;
}

function mistakesPath(userId) {
  return path.join(USERS_DIR, userId, 'router-mistakes.jsonl');
}

export async function appendMistake(userId, entry) {
  if (!userId) return;
  const now = Date.now();
  const line = JSON.stringify({
    ts: now,
    prevMessage: String(entry.prevMessage || '').slice(0, 240),
    prevAgent: entry.prevAgent || null,
    correctedAgent: entry.correctedAgent || null,
    evidenceMsg: String(entry.evidenceMsg || '').slice(0, 240),
  });
  const p = mistakesPath(userId);
  try {
    await withLock(p, () => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const cutoff = now - RETENTION_MS;
      let kept = [];
      if (fs.existsSync(p)) {
        const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
        for (const ln of lines) {
          try {
            const rec = JSON.parse(ln);
            if (rec.ts > cutoff) kept.push(ln);
          } catch { /* drop */ }
        }
      }
      kept.push(line);
      fs.writeFileSync(p, kept.join('\n') + '\n');
    });
  } catch (e) {
    console.warn('[router-mistakes] append failed:', e.message);
  }
}

export function loadMistakes(userId) {
  if (!userId) return [];
  const p = mistakesPath(userId);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function tokens(s) {
  return new Set(String(s || '').toLowerCase().split(/\W+/).filter(Boolean));
}
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * After appending a new mistake, ask: do we have enough evidence to propose
 * a routing override? Returns the proposal-ready payload or null.
 *
 * Criteria:
 *  - THRESHOLD+ recent mistakes (last 7d) with the SAME correctedAgent
 *  - At least one pair has Jaccard token overlap >= JACCARD_MIN on prevMessage
 *  - We haven't proposed an override for similar shapes in the last cooldown
 *    window (gated by proposal-layer cooldown — not duplicated here)
 *
 * Output:
 *   { proposed: true, correctedAgent, examples: [<prevMessage strings>],
 *     pattern: <substring derived from common tokens> }
 *   | { proposed: false }
 */
export function maybePropose(userId) {
  const all = loadMistakes(userId);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = all.filter(m => m.ts > cutoff && m.correctedAgent);
  if (recent.length < THRESHOLD) return { proposed: false };

  // Group by correctedAgent
  const byAgent = new Map();
  for (const m of recent) {
    if (!byAgent.has(m.correctedAgent)) byAgent.set(m.correctedAgent, []);
    byAgent.get(m.correctedAgent).push(m);
  }

  for (const [agent, list] of byAgent) {
    if (list.length < THRESHOLD) continue;
    // Find the densest pair by Jaccard. If max pair >= JACCARD_MIN, derive
    // a pattern from their common tokens.
    let best = { score: 0, a: null, b: null };
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const s = jaccard(list[i].prevMessage, list[j].prevMessage);
        if (s > best.score) best = { score: s, a: list[i].prevMessage, b: list[j].prevMessage };
      }
    }
    if (best.score < JACCARD_MIN) continue;

    // Build a substring pattern: longest contiguous lowercase word that
    // appears in both prevMessages. Fallback to the shortest common token.
    const pattern = _commonPattern(best.a, best.b);
    if (!pattern || pattern.length < 3) continue;

    return {
      proposed: true,
      correctedAgent: agent,
      examples: list.slice(0, 3).map(m => m.prevMessage),
      pattern,
    };
  }
  return { proposed: false };
}

function _commonPattern(a, b) {
  // Pick the longest token appearing in BOTH a and b. Bounded by the
  // shorter of the two; ignores tokens shorter than 4 chars.
  const A = [...tokens(a)];
  const B = new Set(tokens(b));
  let best = '';
  for (const t of A) {
    if (t.length >= 4 && B.has(t) && t.length > best.length) best = t;
  }
  return best;
}

/**
 * Full detection pipeline called from chat-dispatch on every incoming user
 * message. Fire-and-forget — never blocks dispatch. Steps:
 *   1. Normalize and run detectRedirect
 *   2. If a named agent is detected, resolve it against the user's roster
 *   3. Look up the previous turn's `viaAgent` (from session); if no via tag,
 *      the prev turn ran on the chat's own agentId
 *   4. If prevAgent !== correctedAgent (the redirect names a different one),
 *      append a router-mistake event
 *   5. Threshold check via maybePropose; on hit, emit a routing_override
 *      proposal through proposeRoutingOverride
 */
export async function detectAndLog({ userId, currentAgentId, userText }) {
  if (!userId || !userText) return { detected: false };
  const norm = String(userText).trim().toLowerCase().replace(/[''']/g, '').replace(/\s+/g, ' ');
  const namedAgent = detectRedirect(norm);
  if (!namedAgent) return { detected: false };

  // Resolve named agent to a real agent id. Lowercase name match (no fuzzy
  // for now — false positives are expensive).
  const { getAgentsForUser } = await import('../routes/_helpers.mjs');
  const roster = getAgentsForUser(userId) || [];
  const resolved = roster.find(a => (a.name || '').toLowerCase() === namedAgent || a.id === namedAgent);
  if (!resolved) return { detected: true, resolved: false };

  // Find prev turn's pickedAgent. Look at the last assistant message in the
  // current chat's session — its `viaAgent` tag (set by the specialist router)
  // names the agent that handled it. Absent tag means the chat's own agent
  // handled it directly.
  let prevAgent = currentAgentId;
  let prevMessage = '';
  try {
    const { loadSession } = await import('../sessions.mjs');
    const msgs = loadSession(`${userId}_${currentAgentId}`, 5) || [];
    // Walk back to find the latest assistant message + the user message that
    // preceded it.
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant') {
        if (msgs[i].viaAgent) prevAgent = msgs[i].viaAgent;
        // Find the user message before this assistant turn
        for (let j = i - 1; j >= 0; j--) {
          if (msgs[j].role === 'user') { prevMessage = msgs[j].content || ''; break; }
        }
        break;
      }
    }
  } catch (e) { /* tolerate missing session */ }

  // If the user is redirecting to the SAME agent that just handled the prev
  // turn, it's not a mistake — they're just continuing the same conversation.
  if (resolved.id === prevAgent) return { detected: true, sameAgent: true };

  await appendMistake(userId, {
    prevMessage, prevAgent, correctedAgent: resolved.id, evidenceMsg: userText,
  });

  // Threshold check + emit proposal
  const signal = maybePropose(userId);
  if (signal.proposed) {
    try {
      const { proposeRoutingOverride } = await import('./proposals.mjs');
      await proposeRoutingOverride({
        userId, agentId: currentAgentId,
        correctedAgent: resolved.id,
        correctedAgentName: resolved.name || resolved.id,
        pattern: signal.pattern,
        examples: signal.examples,
      });
    } catch (e) {
      console.warn('[router-mistakes] propose failed:', e.message);
    }
  }
  return { detected: true, sameAgent: false, mistake: true };
}

export { COOLDOWN_MS };
