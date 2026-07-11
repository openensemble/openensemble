/**
 * Signal tracking — detects corrections, preferences, forget-requests, and
 * friction (same instruction repeated 3x → auto-pinned as immortal) and stores
 * them as memories on the active agent.
 */

import {
  generateCombined, safeParseJSON, providerHealthy,
} from './shared.mjs';
import { remember, pin, searchSimilar } from './lance.mjs';
import { forgetByText } from './recall.mjs';
import { embed } from './embedding.mjs';
import { handleProactiveNegativeFeedback } from '../lib/personalization/negative-feedback.mjs';
import {
  extractPreferenceStructure,
  hasAmbiguousPreferenceAction,
} from '../lib/personalization/preference-structure.mjs';

// Cortex was trained on the bare `User: "..." Agent: "..."` wrapper (per
// training/train.py format_record('signals')) — sending a verbose schema
// instruction at inference broke the head completely (fields missing,
// schema-violation outputs). The empty instruction tells generateCombined
// to send the bare format the model learned.

// If the agent's last response was about email/task operations, skip correction detection
const AGENT_ACTION_RESPONSE_RE = /\b(moved to trash|trashed|permanently deleted|found \d+|done!? all \d+|email(s)? (have been|were)|scheduled (to run|at)|task .{1,40} scheduled)\b/i;

// User turn that is purely a question ("what/which/who/...", "do/does/is/..."):
// a question asks about existing memory, it doesn't assert a new preference.
// When the user recalls ("what fruit do i like") and the agent answers ("you
// like pineapples"), the signals classifier otherwise sees the agent's echo
// and re-saves the same preference on every recall.
const QUESTION_ONLY_RE = /^(?:what'?s?|which|who'?s?|whose|when|where|why|how|do|does|did|is|are|was|were|can|could|should|would|will|am|have|has|had)\b[^.!]*\??\s*$/i;
const NAMED_NEGATIVE_SUBJECT_RE = /^[\p{Lu}][\p{L}\p{M}'’.-]{1,39}\s+(?=(?:no\b|do(?:es)?\s+not\b|don['’]?t\b|doesn['’]?t\b|dislikes?\b|hates?\b|avoids?\b|never\b|can(?:not|'t)\b|(?:am\s+)?allergic\b))/u;
const NEGATIVE_PREFERENCE_RE = /^(?:the user\s+)?(?:i\s+)?(?:no\b|do(?:es)?\s+not\b|don['’]?t\b|doesn['’]?t\b|dislikes?\b|hates?\b|avoids?\b|never\b|can(?:not|'t)\b|(?:am\s+)?allergic\b)/i;

// The shared structurizer deliberately accepts a very small grammar. Normalize
// the one common contraction whose expanded form is already in that grammar so
// "I'm allergic to peanuts" receives the same deterministic treatment as
// "I am allergic to peanuts". Do not generally rewrite user prose here: every
// other form must still pass the exact standalone-declaration grammar.
function normalizeDeterministicPreferenceText(text) {
  return String(text || '').replace(/^\s*i['’]m\s+allergic\s+to\b/i, 'I am allergic to');
}

async function extractPreferenceStructureForUser(userId, text) {
  let timeZone = null;
  try {
    const { getConfig } = await import('../lib/personalization/config.mjs');
    timeZone = (await getConfig(userId))?.timezone || null;
  } catch { /* server-local fallback */ }
  return extractPreferenceStructure(normalizeDeterministicPreferenceText(text), { timeZone });
}

async function detectSignals({ agentId, userMessage, agentLastResponse, userId = 'default' }) {
  if (!await providerHealthy()) return { correction: null, preference: null };

  const safeUser  = userMessage.slice(0, 300).replace(/"/g, "'");
  const safeAgent = (agentLastResponse || '').slice(0, 300).replace(/"/g, "'");
  const inputText = agentLastResponse
    ? `User: "${safeUser}"\nAgent: "${safeAgent}"`
    : `User: "${safeUser}"\nAgent: ""`;

  const raw = await generateCombined('', inputText, { caller: 'signals', userId, agentId });
  const s   = safeParseJSON(raw);
  if (!s) return { correction: null, preference: null };

  // A pure question from the user is a recall, not an assertion. Drop any
  // preference the classifier emits so we don't re-save the agent's echoed
  // answer on every "what fruit do i like" turn.
  if (QUESTION_ONLY_RE.test(userMessage.trim()) || /\?\s*$/.test(userMessage.trim())) {
    s.is_preference = false;
    s.preference = null;
  }

  let correctionRecord = null;
  let preferenceRecord = null;

  // Handle correction
  if (s.is_correction && s.correction && !AGENT_ACTION_RESPONSE_RE.test(agentLastResponse || '')) {
    const text = `CORRECTION: ${s.correction}`;
    correctionRecord = await remember({ agentId, type: 'params', source: 'correction',
      confidence: 0.99, text, metadata: { category: 'correction' }, userId });

    // Per-skill telemetry: attribute this correction to the most recent
    // user-skill invocation in the past few minutes (closest in time = most
    // likely culprit). Drives both the mid-zone refine proposal and the
    // auto-deprecation proposal. Pass the correction text so the refine
    // accept handler can feed it to coder for skill_patch_code. Fire-and-
    // forget; telemetry must never block signal storage.
    import('../lib/skill-telemetry.mjs')
      .then(m => m.recordCorrection({ userId, agentId, correctionText: s.correction }))
      .catch(e => console.warn('[skill-telemetry] correction attribution failed:', e.message));

    // Cortex automation #2: corrections-to-rules promotion. If the same
    // correction has fired before (vector-similarity match in this agent's
    // _params), surface a proposal to promote it to a per-user standing rule
    // on the agent's role. Fire-and-forget — the proposal flow handles
    // dismissal cooldown, role auto-detection, and the rule write itself.
    maybePromoteCorrection({ agentId, userId, correctionRecord, correctionText: s.correction })
      .catch(e => console.warn('[cortex] Correction promotion check failed:', e.message));

    // Feed the same high-confidence, user-authored signal into the typed
    // personalization consolidator. This is much stronger evidence than an
    // incidental tool call and avoids running a second classifier.
    import('../lib/personalization/recorder.mjs')
      .then(m => m.recordStructuredSignal({
        userId, agentId, type: 'correction', statement: s.correction,
        source: 'cortex_signal', metadata: { confidence: 0.99 },
      }))
      .catch(e => console.warn('[personalization] correction signal capture failed:', e.message));
  }

  // Handle a model-classified preference as reviewable inferred evidence.
  if (s.is_preference && s.preference) {
    const strength = s.preference_strength || 'moderate';
    // This branch is model-classified: deterministic, unmistakable user
    // statements already returned through the confirmed fast path above.
    // Keep uncertain model judgments inferred and non-immortal until the user
    // confirms them in About you.
    const strengthMap = { strong: { confidence: 0.8 }, moderate: { confidence: 0.7 }, weak: { confidence: 0.6 } };
    const { confidence } = strengthMap[strength] || strengthMap.moderate;
    // Never write this branch to the legacy agent params table. Params are
    // rendered as trusted remembered rules, while this is only a model
    // judgment. The typed ledger is the sole storage path: it labels the row
    // INFERRED, makes it reviewable, and keeps the personalization consent
    // switch authoritative.
    // Keep negative preferences from becoming positive deal/monitor matches.
    // Use a narrow leading-phrase test so mixed statements such as "I love
    // Honeycrisp, not Gala" retain their primary positive polarity.
    const preferenceText = String(s.preference).trim()
      .replace(NAMED_NEGATIVE_SUBJECT_RE, '');
    const preferencePolarity = NEGATIVE_PREFERENCE_RE.test(preferenceText)
      ? 'negative' : 'positive';
    try {
      const recorder = await import('../lib/personalization/recorder.mjs');
      const observation = await recorder.recordStructuredSignal({
        userId, agentId, type: 'preference', statement: s.preference,
        source: 'cortex_inference',
        metadata: {
          confidence, strength, polarity: preferencePolarity,
          classification: 'model',
        },
      });
      // recordStructuredSignal returns null when personalization is off,
      // onboarding consent is incomplete, or session learning is disabled.
      // Do not bypass that decision by writing directly to the typed ledger.
      if (observation) {
        const ledger = await import('../lib/personalization/ledger.mjs');
        const structure = await extractPreferenceStructureForUser(userId, String(s.preference));
        const inference = await ledger.applyInference(userId, {
          statement: s.preference, type: 'preference', verb: 'new',
          confidence, scope: 'global', polarity: preferencePolarity,
          subject: structure?.subject || null,
          structure: structure?.sentiment === preferencePolarity ? structure : null,
          evidence: observation?.id ? [observation.id] : [],
          evidenceDetails: observation?.id ? [{
            id: observation.id, source: 'model-classified preference', at: observation.ts,
            summary: observation.digest,
          }] : [],
        });
        if (inference?.action && inference.action !== 'skipped') preferenceRecord = inference;
      }
    } catch (e) {
      console.warn('[personalization] preference signal capture failed:', e.message);
    }
  }

  return { correction: correctionRecord, preference: preferenceRecord };
}

// ── Correction-to-rule promotion (cortex automation #2) ─────────────────────
//
// After a correction is stored, look back at this agent's prior CORRECTION
// rows. If we find at least one semantically-similar earlier correction (i.e.
// the user is correcting the same thing twice) AND the agent holds exactly
// one service role, surface a proposal to promote the correction into a
// per-user standing rule on that role. Per-user rules go to
// users/<uid>/role-rules/<roleId>.md and get injected unconditionally into
// the system prompt — escaping cortex recall flakiness.
//
// Why exactly one role:
//   - 0 service roles → no clear promotion target (agent is a generalist).
//   - 2+ service roles → ambiguous which role's prompt should carry the rule.
// Both cases fall through to the existing correction-storage behavior, which
// continues to work fine via cortex recall.
//
// Threshold reasoning:
//   - lance.mjs's immortal-dedup uses 0.12 — too tight for this use case.
//     That threshold answers "is this an exact paraphrase about to be
//     deduped on write?". Empirically, "never use semicolons in JavaScript"
//     vs "no semicolons in JS please" lands at ~0.30 in nomic-embed-text-v1
//     space — clearly the same correction but lexically distant.
//   - recall.mjs:forgetByText uses 0.35 for "semantically close enough to
//     act on" — that's the right range for our "same correction topic"
//     question. We err slightly tighter (0.30) since false-fires here
//     create user-facing proposal bubbles, not silent forgets.

const CORRECTION_SIMILARITY_THRESHOLD = 0.30;

export async function maybePromoteCorrection({ agentId, userId, correctionRecord, correctionText }) {
  if (!correctionRecord?.id || !correctionText) return null;

  // Search this agent's _params table for prior correction-source rows
  // semantically similar to the new one. searchSimilar already filters
  // forgotten=false; we filter the rest in JS since LanceDB SQL `WHERE` and
  // the vector pipeline don't compose cleanly through this helper.
  const tableName = `${agentId}_params`;
  const hits = await searchSimilar(tableName, correctionRecord.text, 8, userId).catch(() => []);
  const priors = hits.filter(r =>
    r.id !== correctionRecord.id &&
    r.source === 'correction' &&
    typeof r._distance === 'number' &&
    r._distance < CORRECTION_SIMILARITY_THRESHOLD
  );
  if (priors.length === 0) return null;

  // Determine which role to attach the rule to. Service-role-only filtering
  // is already inside getAgentRoles.
  const { getAgentRoles, getRoleManifest } = await import('../roles.mjs');
  const roles = getAgentRoles(agentId, userId);
  if (roles.length !== 1) return null;
  const roleId = roles[0];
  const manifest = getRoleManifest(roleId, userId);
  const roleName = manifest?.name ?? roleId;

  // Strip the "CORRECTION: " prefix (which is internal cortex bookkeeping)
  // before turning the correction into a user-facing rule line.
  const ruleText = correctionText.replace(/^CORRECTION:\s*/i, '').trim();
  if (!ruleText) return null;

  const { proposeRulePromotion } = await import('../lib/proposals.mjs');
  return proposeRulePromotion({
    userId, agentId, roleId, roleName, ruleText,
    sourceCorrectionIds: [correctionRecord.id, ...priors.map(p => p.id)],
  });
}

// Keep old exports in place for any direct callers — they now delegate to detectSignals
export async function detectAndStoreCorrection({ agentId, userMessage, agentLastResponse, userId = 'default' }) {
  const { correction } = await detectSignals({ agentId, userMessage, agentLastResponse, userId });
  return correction;
}

export async function detectAndStorePreference({ agentId, userMessage, userId = 'default' }) {
  const { preference } = await detectSignals({ agentId, userMessage, agentLastResponse: null, userId });
  return preference;
}

// ── Friction tracking — same instruction 3x → propose automation ─────────────
//
// In-process map keyed by `${agentId}_${createdAt}` → { text, count, lastSeenAt }.
// Two reaping forces keep it bounded:
//   1. Age sweep — entries with no activity for >FRICTION_TTL_MS are dropped
//      at the head of every trackFriction call.
//   2. Per-agent cap — if more than FRICTION_MAX_PER_AGENT entries survive,
//      the oldest are dropped. Bounds worst case even when traffic is heavy
//      enough that the age sweep doesn't keep up.
// Friction is a short-window pattern detector, not a long-term store, so a
// 30-minute TTL is generous and matches user intuition for "I keep saying
// this in this conversation."
const _frictionCounters = {};
const FRICTION_TTL_MS = 30 * 60 * 1000;
const FRICTION_MAX_PER_AGENT = 50;

function pruneFrictionCounters(agentId) {
  const cutoff = Date.now() - FRICTION_TTL_MS;
  const prefix = agentId + '_';
  const live = [];
  for (const [k, v] of Object.entries(_frictionCounters)) {
    if (!k.startsWith(prefix)) continue;
    if ((v.lastSeenAt ?? 0) < cutoff) {
      delete _frictionCounters[k];
    } else {
      live.push([k, v]);
    }
  }
  // If the agent still has too many, drop the oldest by lastSeenAt.
  if (live.length > FRICTION_MAX_PER_AGENT) {
    live.sort((a, b) => (a[1].lastSeenAt ?? 0) - (b[1].lastSeenAt ?? 0));
    for (let i = 0; i < live.length - FRICTION_MAX_PER_AGENT; i++) {
      delete _frictionCounters[live[i][0]];
    }
  }
}

// Friction-head cost control. The head is one serialized reason-LLM call per
// live counter, and there can be up to FRICTION_MAX_PER_AGENT (50) of them.
// A cosine prefilter over the (LRU-cached) embeddings is orders of magnitude
// cheaper, so we only pay for LLM confirmation on the closest few candidates.
const FRICTION_PREFILTER_MIN  = 0.35; // loose cosine gate — the head decides. Low
                                      // enough to admit paraphrase-repeats ("turn
                                      // off the lights" vs "the lights are still
                                      // on"); the FRICTION_LLM_CANDIDATES cap still
                                      // bounds LLM calls regardless of how many pass.
const FRICTION_LLM_CANDIDATES = 3;   // hard cap on LLM calls per turn

function _cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export async function trackFriction({ agentId, userMessage, userId = 'default' }) {
  if (!await providerHealthy()) return { promoted: false };
  pruneFrictionCounters(agentId);
  const safeMsg = userMessage.slice(0, 150).replace(/"/g, "'");
  const agentKeys = Object.keys(_frictionCounters).filter(k => k.startsWith(agentId + '_'));

  // Prefilter with cosine similarity so the friction head only runs on the
  // top few candidates above a loose threshold instead of once per counter.
  // Falls back to all keys if embedding is unavailable (preserves old behavior).
  let candidates = agentKeys;
  if (agentKeys.length > 1) {
    const msgVec = await embed(safeMsg).catch(() => null);
    if (msgVec?.length && !msgVec.every(v => v === 0)) {
      const scored = [];
      for (const key of agentKeys) {
        const vec = await embed(_frictionCounters[key].text.slice(0, 150)).catch(() => null);
        const sim = _cosineSim(msgVec, vec);
        if (sim >= FRICTION_PREFILTER_MIN) scored.push([key, sim]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      candidates = scored.slice(0, FRICTION_LLM_CANDIDATES).map(([k]) => k);
    }
  }

  for (const key of candidates) {
    const stored = _frictionCounters[key];
    if (!stored) continue;
    const safeStored = stored.text.slice(0, 150).replace(/"/g, "'");
    // Bare `First: "..." Second: "..."` matches training/train.py
    // format_record('friction'). Production previously used A/B field names
    // — wrong cue tokens for the trained head.
    const raw = await generateCombined('', `First: "${safeStored}" Second: "${safeMsg}"`, { caller: 'friction', userId, agentId });
    const parsed = safeParseJSON(raw);

    if (parsed?.same_instruction === true) {
      stored.count += 1;
      stored.lastSeenAt = Date.now();
      if (stored.count >= 3) {
        // Friction-as-proposer (cortex automation #1): instead of pinning the
        // literal repeated message (which over-promoted one-off commands —
        // see `[AUTO-PINNED]` cleanup history), classify the message and
        // surface a proposal bubble in chat. If the message isn't actionable
        // (not task-shaped or watch-shaped), do nothing — strict improvement
        // over verbatim auto-pinning since legitimate preferences are still
        // captured by the signals head's processSignals path.
        const { maybePropose } = await import('../lib/proposals.mjs');
        const proposed = await maybePropose({ userId, agentId, message: userMessage });
        delete _frictionCounters[key];
        return { promoted: false, proposed: !!proposed, count: stored.count };
      }
      return { promoted: false, count: stored.count };
    }
  }

  const now = Date.now();
  _frictionCounters[`${agentId}_${now}`] = { text: userMessage, count: 1, lastSeenAt: now };
  return { promoted: false, count: 1 };
}

// ── detectForgetRequest — returns the subject to forget, or null ─────────────
function detectForgetRequest(text) {
  // Must clearly refer to a memory/preference, not an email/task action.
  // Requires one of: "that i ...", "what i said", "that [preference/note/memory]",
  // "from memory", or just "forget X" (without email-action context).
  const m = text.match(
    /^(?:please\s+)?(?:forget|remove|delete|discard)\s+(?:that\s+(?:i\s+(?:said\s+|told you\s+)?(?:that\s+)?)?|what\s+i\s+(?:said|told)|(?:that|the|my|this)\s+(?:preference|memory|note|fact|rule)\s*(?:about\s+|that\s+|of\s+)?|from\s+memory\s*)(.+)/i
  );
  return m ? m[1].trim() : null;
}

// ── detectExplicitRemember — regex fast-path for "remember X" / "fact: X" ────
// Returns the fact text to pin, or null. Pins without hitting the LLM classifier.
const INTERROGATIVE_RE = /^(?:when|where|why|who|what|how|whether|if)\b/i;

function detectExplicitRemember(text) {
  const t = text.trim();

  // Pattern 1: "remember X" / "please remember X" / "remember that X"
  // Reject questions like "remember when we talked?" — these are reminiscences, not directives.
  let m = t.match(/^(?:please\s+)?remember\s+(?:that\s+)?(.{5,500})$/i);
  if (m) {
    const body = m[1].trim();
    if (INTERROGATIVE_RE.test(body) || body.endsWith('?')) return null;
    return body.replace(/[.!]+$/, '').trim();
  }

  // Pattern 2: "<prefix>: X" — explicit fact declaration with prefix marker
  m = t.match(/^(?:this is a fact|fact|for the record|note this|note that|save this(?:\s+(?:as\s+a\s+fact|in memory))?|keep\s+(?:this\s+)?in\s+mind)[:,]\s*(.{5,500})$/i);
  if (m) {
    const body = m[1].trim();
    if (body.endsWith('?')) return null;
    return body.replace(/[.!]+$/, '').trim();
  }

  // Pattern 3: "make/take a note (that|of) X" / "record (that|the fact that) X"
  // Requires a connector ("that"/"of"/"the fact that") so we don't pin "take a note"
  // or "record the meeting" as bare commands.
  m = t.match(/^(?:please\s+)?(?:make|take)\s+(?:a\s+)?note\s+(?:(?:of\s+)?(?:the\s+fact\s+)?that\s+|of\s+)(.{5,500})$/i);
  if (m) {
    const body = m[1].trim();
    if (INTERROGATIVE_RE.test(body) || body.endsWith('?')) return null;
    return body.replace(/[.!]+$/, '').trim();
  }

  // Pattern 4: "record (that|the fact that) X"
  m = t.match(/^(?:please\s+)?record\s+(?:the\s+fact\s+that\s+|that\s+)(.{5,500})$/i);
  if (m) {
    const body = m[1].trim();
    if (INTERROGATIVE_RE.test(body) || body.endsWith('?')) return null;
    return body.replace(/[.!]+$/, '').trim();
  }

  // Pattern 5: "save (that|the fact that) X" — narrow to avoid "save this file"
  m = t.match(/^(?:please\s+)?save\s+(?:the\s+fact\s+that\s+|that\s+)(.{5,500})$/i);
  if (m) {
    const body = m[1].trim();
    if (INTERROGATIVE_RE.test(body) || body.endsWith('?')) return null;
    return body.replace(/[.!]+$/, '').trim();
  }

  return null;
}

// High-confidence preference phrases should not depend on the learned signal
// head being available. This deliberately handles only unmistakable, standalone
// declarations; everything ambiguous still goes through the classifier below.
export function _testDetectExplicitPreference(text) {
  const t = normalizeDeterministicPreferenceText(text).trim().replace(/[.!]+$/, '').trim();
  if (!t || t.length > 300 || t.endsWith('?')) return null;
  // This fast path is intentionally for one standalone declaration. Reject
  // internal sentence/semicolon boundaries conservatively; decimal prices
  // remain valid because their period is not followed by whitespace + text.
  if (/[;!?]|\.(?=\s+[\p{L}\p{N}])/u.test(t)) return null;
  if (hasAmbiguousDeterministicPreferenceAction(t)) return null;

  let m = t.match(/^(?:i|we)\s+(?:(really|absolutely|especially)\s+)?(love|adore|like|enjoy|prefer)\s+(.{3,220})$/i);
  if (m) {
    let subject = m[3].trim();
    if (/^(?:that|how|when|what)\s+you\b|^your\b/i.test(subject)
      || /^(?:it|this|that|them|these|those)$/i.test(subject)
      || /\b(?:can|could|would|will)\s+you\b|[,;]\s*(?:find|search|look|show|get|tell|remind|schedule|check)\b/i.test(subject)) return null;
    subject = subject.split(/\s+(?:over|rather than|instead of)\s+/i)[0].trim();
    if (subject.length < 3) return null;
    if (!extractPreferenceStructure(t)) return null;
    return {
      statement: subject.slice(0, 220),
      polarity: 'positive',
      strength: /love|adore/i.test(m[2]) || /really|absolutely/i.test(m[1] || '') ? 'strong' : 'moderate',
    };
  }

  m = t.match(/^my\s+favou?rite\s+(.{2,70}?)\s+(?:is|are)\s+(.{3,160})$/i);
  if (m) {
    const category = m[1].trim();
    const favorite = m[2].trim();
    const statement = new RegExp(`\\b${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(favorite)
      ? favorite : `${favorite} ${category}`;
    if (!extractPreferenceStructure(t)) return null;
    return { statement: statement.slice(0, 220), polarity: 'positive', strength: 'strong' };
  }

  // Bounded first-person habits and constraints. These verbs exactly mirror
  // the structurizer's durable domains; open-ended verbs such as "always go"
  // remain model-only. The structurizer supplies the final action/question/
  // secret and subject safety gate.
  m = t.match(/^(?:i|we)\s+(only|always|never|do\s+not|don['’]?t)\s+(buy|purchase|order|choose|eat|drink|use|wear|want)\s+(.{3,245})$/i);
  if (m && extractPreferenceStructure(t)) {
    const quantifier = m[1].toLowerCase().replace(/\s+/g, ' ');
    const verb = ({
      buy: 'buys', purchase: 'purchases', order: 'orders', choose: 'chooses',
      eat: 'eats', drink: 'drinks', use: 'uses', wear: 'wears', want: 'wants',
    })[m[2].toLowerCase()];
    const subject = m[3].trim();
    // "I always want you to ..." is an instruction, not a profile fact.
    if (/^(?:you|the assistant)\b/i.test(subject)) return null;
    const negative = /^(?:never|do not|don['’]?t)$/i.test(quantifier);
    return {
      statement: (negative
        ? `Avoids ${subject}`
        : `${quantifier === 'always' ? 'Always' : 'Only'} ${verb} ${subject}`).slice(0, 220),
      polarity: negative ? 'negative' : 'positive',
      strength: 'strong',
    };
  }

  m = t.match(/^(?:i|we)\s+(?:(?:really|absolutely)\s+)?(?:do\s+not\s+like|don['’]?t\s+like|dislike|hate|avoid|can['’]?t\s+stand|am\s+allergic\s+to)\s+(.{3,200})$/i);
  if (m) {
    const subject = m[1].trim();
    if (/^(?:it|this|that|them|these|those)$/i.test(subject)) return null;
    if (!extractPreferenceStructure(t)) return null;
    return { statement: `Avoids ${subject}`.slice(0, 220), polarity: 'negative', strength: 'strong' };
  }
  return null;
}

async function storeDeterministicPreference({ userId, agentId, preference, structure }) {
  if (!structure || structure.sentiment !== preference.polarity) return null;
  try {
    const recorder = await import('../lib/personalization/recorder.mjs');
    const observation = await recorder.recordStructuredSignal({
      userId,
      agentId,
      type: 'preference',
      statement: preference.statement,
      source: 'explicit_phrase',
      metadata: { confidence: 0.99, strength: preference.strength, polarity: preference.polarity },
    });
    if (!observation) return null;
    const ledger = await import('../lib/personalization/ledger.mjs');
    const row = await ledger.upsertExplicitProfile(userId, {
      statement: preference.statement,
      type: 'preference',
      scope: 'global',
      subject: structure.subject,
      polarity: preference.polarity,
      structure,
      evidence: [observation.id],
      evidenceDetails: [{
        id: observation.id,
        source: 'explicit preference phrase',
        at: observation.ts,
        summary: observation.digest,
      }],
    });
    if (row) queuePreferenceOpportunityRefresh(userId);
    return row;
  } catch (e) {
    console.warn('[personalization] deterministic preference capture failed:', e.message);
    return null;
  }
}

function queuePreferenceOpportunityRefresh(userId) {
  import('../lib/personalization/preference-opportunities.mjs')
    .then(module => module.refreshPreferenceOpportunitiesForProfileChange?.(userId, { limit: 1 }))
    .catch(e => console.warn('[personalization] immediate preference opportunity check deferred:', e?.message || e));
}

// Messages that are action/task requests — not preferences, skip signal detection
const ACTION_REQUEST_RE = /\b(schedule|remind me|in \d+ (minute|hour|second|min|hr)s?|run .{1,40} in|set (up )?a task|create a task|check .{1,30} in \d+|search for|look up|find me|pull .{1,30} in|get me .{1,30} in \d+|delete|trash|archive|reply to|forward|unsubscribe|send (an? )?email|check my (email|inbox|mail)|show me (my )?(email|inbox|mail)|still (seeing|getting|receiving|have))\b.{0,60}(email|message|mail|inbox|\bfrom\b)/i;

const DETERMINISTIC_PREFERENCE_CUE_RE = /^(?:i|we)\s+(?:(?:really|absolutely|especially)\s+)?(?:(?:love|adore|like|enjoy|prefer|dislike|hate|avoid|can['’]?t\s+stand|am\s+allergic\s+to)\b|(?:only|always|never|do\s+not|don['’]?t)\s+(?:buy|purchase|order|choose|eat|drink|use|wear|want)\b)|^i['’]m\s+allergic\s+to\b|^my\s+favou?rite\b/i;
const MIXED_PREFERENCE_ACTION_RE = /(?:[.,;:!?&]|\s[-—]\s|\b(?:and|but|so|then)\b)\s*(?:(?:also|now|just|later|next|afterwards?|after\s+that|subsequently)\s+)*(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you|(?:i|we)\s+(?:want|need)\s+you\s+to)\s+(?:please\s+)?)?(?:buy|purchase|order|add|find|search|look|show|get|grab|pick\s+up|tell|check|remind|schedule|send|book|reserve|notify|alert|watch|monitor)\b|\bplease\s+(?:buy|purchase|order|add|find|search|look|show|get|grab|pick\s+up|tell|check|remind|schedule|send|book|reserve|notify|alert|watch|monitor)\b/i;
const PREFERENCE_DOMAIN_IMPERATIVE_RE = /^(?:please\s+)?(?:(?:do\s+not|don['’]?t|never)\s+)?(?:buy|purchase|order|choose|eat|drink|use|wear|want)\b/i;
const ASSISTANT_DIRECTED_ACTION_RE = /^(?:(?:i|we)\s+(?:would\s+like|want|need)\s+you\s+to|(?:i|we)['’]d\s+like\s+you\s+to)\s+(?:buy|purchase|order|choose|eat|drink|use|wear|find|search|check|remind|schedule|send|watch|monitor)\b/i;

function hasAmbiguousDeterministicPreferenceAction(text) {
  const value = String(text || '').trim();
  return DETERMINISTIC_PREFERENCE_CUE_RE.test(value)
    && MIXED_PREFERENCE_ACTION_RE.test(value);
}

function hasInternalPreferenceClauseBoundary(text) {
  const value = String(text || '').trim();
  if (!DETERMINISTIC_PREFERENCE_CUE_RE.test(value)) return false;
  // Standalone declarations may end in emphasis, but a second sentence,
  // semicolon clause, question, or dash clause is no longer deterministic
  // profile input. Short-circuit before the model classifier even when the
  // second clause uses an action synonym outside our bounded verb list.
  return /;|\?(?:\s|$)|[!?](?=\s+\S)|\.(?=\s+\S)|\s[-—]\s/u.test(value);
}

// Short confirmations/rejections — never meaningful for memory
const CONFIRMATION_RE = /^(yes|no|ok|okay|sure|confirm|cancel|go|stop|done|trash|delete|send|proceed|continue|skip|nope|yep|yup|aye|nah|please|thanks|thank you|got it|sounds good|do it|go ahead|abort)[\s!.]*$/i;

const SHORT_REACTION_RE = /^(?:o+h?\s|wait\b|huh\b|hmm+\b|really\??$|no way\b|i thought\b|i think it'?s\b|actually\b|whoops\b|oops\b|nvm\b|never mind\b)/i;

// ── pinFact — pin an explicit fact to shared user_facts (cross-agent) ───────
// Every agent's buildAgentContext recalls shared user_facts; role_scope gates
// which agents actually see the fact. If the pinning agent currently holds
// exactly one service role (e.g. an ops agent that holds "nodes"), we auto-scope the fact
// to that role so it only gets injected into agents holding that role. Pass
// `scope` explicitly to override — 'shared' (or '') forces global visibility,
// a role id forces that scope. If the agent holds zero or multiple service
// roles and no override is given, the fact stays shared.
export async function pinFact({ agentId, text, userId, scope = null }) {
  const factText = text.startsWith('FACT:') ? text : `FACT: ${text}`;

  let roleScope = '';
  if (scope === 'shared' || scope === '') {
    roleScope = '';
  } else if (typeof scope === 'string' && scope.length) {
    roleScope = scope;
  } else {
    // Auto-scope by the skill that produced this fact's evidence THIS turn —
    // tools are role-scoped, so the memory inherits the same scope, decoupled
    // from which agent wrote it. A node fact learned via node_* tools scopes to
    // 'nodes' even when the multi-role coordinator (which the old "sole role"
    // gate could never satisfy) is the one that called remember_fact. Scope is
    // the role, so the fact follows the role across reassignment.
    try {
      const { getTurnDomainSkills } = await import('../lib/memory-scope-context.mjs');
      const turnSkills = getTurnDomainSkills();
      // Most-recent domain skill is the best guess for what the fact is about.
      if (turnSkills.length) roleScope = turnSkills[turnSkills.length - 1];
    } catch (e) { console.debug('[cortex] turn-skill auto-scope skipped:', e.message); }
    // Fallback: no domain tool ran this turn (e.g. user stated a fact in plain
    // chat) — scope to the writing agent's sole assigned skill, else shared.
    if (!roleScope) {
      try {
        const { getAgentAssignedSkills } = await import('../roles.mjs');
        const roles = getAgentAssignedSkills(agentId, userId);
        if (roles.length === 1) roleScope = roles[0];
      } catch (e) { console.debug('[cortex] role auto-scope skipped:', e.message); }
    }
  }

  try {
    return await pin({
      agentId: 'shared', type: 'user_facts', text: factText,
      category: 'fact', userId, roleScope,
    });
  } catch (e) {
    console.warn('[cortex] Fact pin failed:', e.message);
    return null;
  }
}

// ── pinLocationFact — host-scoped fact about a specific machine ─────────────
// Used by the location-fact proposer's accept handler. Same path as pinFact
// (shared user_facts table, cross-agent) but stamps host_scope so the fact
// can later be filtered to recalls about that host. Fact text already names
// the host, so vector recall surfaces it even without explicit filtering.
export async function pinLocationFact({ text, userId, hostScope }) {
  if (!text || !userId || !hostScope) return null;
  const factText = text.startsWith('FACT:') ? text : `FACT: ${text}`;
  try {
    return await pin({
      agentId: 'shared', type: 'user_facts', text: factText,
      category: 'location_fact', userId, roleScope: '', hostScope,
    });
  } catch (e) {
    console.warn('[cortex] Location-fact pin failed:', e.message);
    return null;
  }
}

// ── processSignals — run after each turn, non-blocking ───────────────────────
export async function processSignals({ agentId, userMessage, agentLastResponse = null, userId = 'default' }) {
  // Skip very short confirmations — "yes", "trash", "ok", "confirm", etc.
  if (CONFIRMATION_RE.test(userMessage.trim())) {
    return { correction: false, preference: false };
  }

  const _trimmed = userMessage.trim();
  if (_trimmed.length <= 80 && SHORT_REACTION_RE.test(_trimmed)) {
    return { correction: false, preference: false };
  }

  // Terse negative feedback about a just-visible proactive receipt/watcher is
  // an instruction to stop that originating behavior, not a new user
  // preference or a correction to the assistant's prose. The deterministic
  // helper fails closed when no single user-owned target can be identified.
  // Recognized-but-ambiguous feedback still short-circuits the LLM signal head
  // so "not useful" is never accidentally stored as a durable preference.
  const proactiveFeedback = await handleProactiveNegativeFeedback({
    userId, agentId, userMessage, contextText: agentLastResponse,
  });
  if (proactiveFeedback.recognized) {
    return {
      correction: false,
      preference: false,
      proactiveFeedback: proactiveFeedback.handled,
      proactiveFeedbackResult: proactiveFeedback,
    };
  }

  // Check for explicit forget request first
  const forgetSubject = detectForgetRequest(userMessage);
  if (forgetSubject) {
    // Explicit user forget request: honor pinned/immortal facts too — those are
    // exactly the ones a user asking "forget that I…" most wants gone. Await the
    // result so the "forgotten" badge (chat.mjs emits memory_forgotten on
    // forgot:true) is truthful — set only when something was actually removed,
    // instead of unconditionally claiming success while pinned facts survive.
    const res = await forgetByText({ agentId, text: forgetSubject, userId, includeImmortal: true })
      .catch(e => { console.warn('[cortex] Forget request failed:', e.message); return { forgotten: 0 }; });
    return { correction: false, preference: false, forgot: (res?.forgotten ?? 0) > 0 };
  }

  // Explicit remember/fact — deterministic fast-path, no LLM required
  const factSubject = detectExplicitRemember(userMessage);
  if (factSubject) {
    const preference = _testDetectExplicitPreference(factSubject);
    if (preference) {
      const structure = await extractPreferenceStructureForUser(userId, factSubject);
      const stored = await storeDeterministicPreference({ userId, agentId, preference, structure });
      return { correction: false, preference: !!stored, remembered: !!stored };
    }
    pinFact({ agentId, text: factSubject, userId }).catch(e => console.warn('[cortex] Fact pin failed:', e.message));
    return { correction: false, preference: false, remembered: true, factText: factSubject };
  }

  // Skip preference/correction detection for action/scheduling requests
  if (ACTION_REQUEST_RE.test(userMessage)) {
    return { correction: false, preference: false };
  }

  // A bare domain verb addresses the assistant; only first-person standalone
  // declarations qualify for deterministic learning.
  if (PREFERENCE_DOMAIN_IMPERATIVE_RE.test(userMessage.trim())
    || ASSISTANT_DIRECTED_ACTION_RE.test(userMessage.trim())) {
    return { correction: false, preference: false };
  }

  // A statement plus a request ("I love apples, find me a sale") may still
  // be useful for the current task, but it is not an unambiguous instruction
  // to create durable personalization. Do not let the model reclassify it.
  if (hasAmbiguousPreferenceAction(userMessage)
    || hasAmbiguousDeterministicPreferenceAction(userMessage)
    || hasInternalPreferenceClauseBoundary(userMessage)
    || (DETERMINISTIC_PREFERENCE_CUE_RE.test(userMessage.trim()) && /\?\s*$/.test(userMessage.trim()))) {
    return { correction: false, preference: false };
  }

  const explicitPreference = _testDetectExplicitPreference(userMessage);
  if (explicitPreference) {
    const structure = await extractPreferenceStructureForUser(userId, userMessage);
    const stored = await storeDeterministicPreference({
      userId, agentId, preference: explicitPreference, structure,
    });
    return { correction: false, preference: !!stored };
  }

  // One combined model call for all signals
  const { correction, preference } = await detectSignals({ agentId, userMessage, agentLastResponse, userId });

  // Friction tracking is now called directly from chat.mjs persist() so it
  // runs on action-tool turns too — see the comment block there. Don't call
  // it here or it runs twice on no-tool turns.

  return { correction: !!correction, preference: !!preference };
}
