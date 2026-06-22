// @ts-check
/**
 * Intent-as-learner (Phase 3) — the utterance→TOOL analogue of
 * lib/router-mistakes.mjs (which does utterance→AGENT). When the local tier
 * MISSED a turn (we only get here on the LLM-turn path) but the LLM then called
 * a tool that IS one of the user's localIntent tools, that utterance was a
 * phrasing the local tier should have caught. Log it as a candidate; after
 * THRESHOLD distinct misses for the same intent, emit a `learned_intent`
 * proposal. Accepting writes the phrasing to lib/learned-intents.mjs, which
 * collectLocalIntents merges into Tier-2 so it runs locally next time — no cloud.
 *
 * Fire-and-forget; gated by both the local-tier kill switch and the learning
 * sub-flag (cfg.localTier.learning). Never blocks a turn.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { withLock } from '../routes/_helpers/io-lock.mjs';
import { localTierEnabled, collectLocalIntents, learningEnabled } from './local-label.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const THRESHOLD = 2;   // distinct missed phrasings per intent before proposing

function candidatesPath(userId) {
  return path.join(USERS_DIR, userId, 'intent-miss-candidates.jsonl');
}
function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/[''']/g, '').replace(/\s+/g, ' ');
}
// Cheap compound-turn gate: a multi-step request is ambiguous about which step
// the utterance maps to, so don't learn it as a single-intent phrasing.
function looksCompound(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(and then|then|after that|also)\b/.test(t) || t.includes(';')) return true;
  return (t.match(/\band\b/g) || []).length >= 2;
}

async function appendCandidate(userId, entry) {
  const now = Date.now();
  const line = JSON.stringify({
    ts: now,
    utterance: String(entry.utterance || '').slice(0, 240),
    skillId: entry.skillId, intentId: entry.intentId, tool: entry.tool,
    args: entry.args || {},
  });
  const p = candidatesPath(userId);
  try {
    await withLock(p, () => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const cutoff = now - RETENTION_MS;
      const kept = [];
      if (fs.existsSync(p)) {
        for (const ln of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
          try { if (JSON.parse(ln).ts > cutoff) kept.push(ln); } catch { /* drop */ }
        }
      }
      kept.push(line);
      fs.writeFileSync(p, kept.join('\n') + '\n');
    });
  } catch (e) { console.warn('[intent-learner] append failed:', e.message); }
}

function loadCandidates(userId) {
  const p = candidatesPath(userId);
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * Examine the just-finished LLM turn. If exactly one called tool is a localIntent
 * tool (and the turn isn't compound), the utterance was a miss the local tier
 * should have caught → log a candidate and maybe propose. Fire-and-forget.
 */
export async function captureFromTurn({ userId, agentId, userText, scopedSessionKey }) {
  if (!userId || !userText) return;
  if (!localTierEnabled() || !learningEnabled()) return;   // cheap, no work when off
  const text = String(userText).trim();
  if (text.length < 4 || looksCompound(text)) return;

  try {
    // Tools the LLM/provider path ran this turn — coordinator-direct OR via a
    // delegated specialist (ask_agent). Read from the in-memory execution log,
    // NOT the session jsonl: delegated tool calls run in an ephemeral session
    // that isn't readable post-turn, so session-readback misses them entirely.
    // The local fastpath uses a different executor, so a tool the local tier
    // already handled is never in here — only genuine misses are.
    const { consumeToolsFor } = await import('./tool-exec-log.mjs');
    const toolNames = consumeToolsFor(userId);
    if (!toolNames.length) return;

    const intents = collectLocalIntents(userId);
    if (!intents.length) return;
    const byTool = new Map(intents.map(i => [i.tool, i]));

    // Exactly ONE localIntent tool in the turn — otherwise it's ambiguous which
    // intent the utterance maps to (a compound/multi-tool turn).
    const localCalls = [...new Set(toolNames)].filter(name => byTool.has(name));
    if (localCalls.length !== 1) return;
    const intent = byTool.get(localCalls[0]);

    // Already learned this exact phrasing? nothing to do.
    const { learnedUtterancesFor } = await import('./learned-intents.mjs');
    const already = new Set(learnedUtterancesFor(userId, intent.skillId, intent.intentId).map(normalize));
    if (already.has(normalize(text))) return;

    await appendCandidate(userId, {
      utterance: text, skillId: intent.skillId, intentId: intent.intentId,
      tool: intent.tool, args: {},   // learning the utterance→intent mapping; slots re-extract at dispatch
    });

    const signal = maybePropose(userId, intent.skillId, intent.intentId);
    if (signal.proposed) {
      const { proposeLearnedIntent } = await import('./proposals.mjs');
      await proposeLearnedIntent({
        userId, agentId,
        skillId: intent.skillId, intentId: intent.intentId, tool: intent.tool,
        utterances: signal.utterances,
      });
    }
  } catch (e) {
    console.warn('[intent-learner] capture failed:', e.message);
  }
}

/**
 * Enough distinct missed phrasings for (skillId,intentId) in the recent window
 * to propose teaching them? Returns { proposed, utterances:[...] }. The proposal
 * layer's per-intent cooldown dedups repeat proposals — not handled here.
 */
export function maybePropose(userId, skillId, intentId) {
  const cutoff = Date.now() - RECENT_MS;
  const recent = loadCandidates(userId).filter(c =>
    c.ts > cutoff && c.skillId === skillId && c.intentId === intentId);
  // Propose after THRESHOLD total misses for this intent — whether the user
  // repeated one phrasing or tried several. (Counting only *distinct* phrasings
  // would never fire for someone who keeps saying the same thing.)
  if (recent.length < THRESHOLD) return { proposed: false };
  const seen = new Map();   // normalized → original — dedupe for the proposal payload
  for (const c of recent) {
    const k = normalize(c.utterance);
    if (k && !seen.has(k)) seen.set(k, c.utterance);
  }
  return { proposed: true, utterances: [...seen.values()].slice(0, 5) };
}

export { THRESHOLD };
