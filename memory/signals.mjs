/**
 * Signal tracking — detects corrections, preferences, forget-requests, and
 * friction (same instruction repeated 3x → auto-pinned as immortal) and stores
 * them as memories on the active agent.
 */

import {
  assertId, queuedWrite, generateCombined, safeParseJSON, providerHealthy,
} from './shared.mjs';
import { getTable, remember, pin } from './lance.mjs';
import { forgetByText } from './recall.mjs';

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
  if (QUESTION_ONLY_RE.test(userMessage.trim())) {
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
  }

  // Handle preference — strength determines confidence and immortality
  if (s.is_preference && s.preference) {
    const strength = s.preference_strength || 'moderate';
    const strengthMap = { strong: { confidence: 0.99, immortal: true }, moderate: { confidence: 0.92, immortal: false }, weak: { confidence: 0.75, immortal: false } };
    const { confidence, immortal } = strengthMap[strength] || strengthMap.moderate;
    const text = `PREFERENCE: ${s.preference}`;
    preferenceRecord = await remember({ agentId, type: 'params', source: 'preference',
      confidence, text, metadata: { category: 'preference', strength }, userId });
    // Strong preferences get pinned as immortal
    if (immortal && preferenceRecord?.id) {
      const tableName = `${agentId}_params`;
      queuedWrite(tableName, async () => {
        const table = await getTable(tableName, userId);
        await table.update({
          where: `id = '${assertId(preferenceRecord.id)}'`,
          values: { immortal: true, stability: 999999 },
        }).catch(e => console.debug('[cortex] Preference pin error:', e.message));
      });
    }
    // Cross-agent: also store as shared user fact
    remember({ agentId: 'shared', type: 'user_facts', source: 'preference',
      confidence, text, metadata: { category: 'preference', strength }, userId }).catch(() => {});
  }

  return { correction: correctionRecord, preference: preferenceRecord };
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

// ── Friction tracking — same instruction 3x → auto-pinned as immortal ────────
const _frictionCounters = {};

export async function trackFriction({ agentId, userMessage, userId = 'default' }) {
  if (!await providerHealthy()) return { promoted: false };
  const safeMsg = userMessage.slice(0, 150).replace(/"/g, "'");
  const agentKeys = Object.keys(_frictionCounters).filter(k => k.startsWith(agentId + '_'));

  for (const key of agentKeys) {
    const stored = _frictionCounters[key];
    const safeStored = stored.text.slice(0, 150).replace(/"/g, "'");
    // Bare `First: "..." Second: "..."` matches training/train.py
    // format_record('friction'). Production previously used A/B field names
    // — wrong cue tokens for the trained head.
    const raw = await generateCombined('', `First: "${safeStored}" Second: "${safeMsg}"`, { caller: 'friction', userId, agentId });
    const parsed = safeParseJSON(raw);

    if (parsed?.same_instruction === true) {
      stored.count += 1;
      if (stored.count >= 3) {
        const pinnedText = `[AUTO-PINNED after ${stored.count} repetitions] ${userMessage}`;
        await pin({ agentId, text: pinnedText, category: 'friction_promoted', userId });
        delete _frictionCounters[key];
        return { promoted: true, count: stored.count };
      }
      return { promoted: false, count: stored.count };
    }
  }

  _frictionCounters[`${agentId}_${Date.now()}`] = { text: userMessage, count: 1 };
  return { promoted: false, count: 1 };
}

// ── detectForgetRequest — returns the subject to forget, or null ─────────────
function detectForgetRequest(text) {
  // Must clearly refer to a memory/preference, not an email/task action.
  // Requires one of: "that i ...", "what i said", "that [preference/note/memory]",
  // "from memory", or just "forget X" (without email-action context).
  const m = text.match(
    /^(?:please\s+)?(?:forget|remove|delete|discard)\s+(?:that\s+(?:i\s+(?:said\s+|told you\s+)?(?:that\s+)?)?|what\s+i\s+(?:said|told)|that\s+(?:preference|memory|note|fact)|from\s+memory\s*)(.+)/i
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

// Messages that are action/task requests — not preferences, skip signal detection
const ACTION_REQUEST_RE = /\b(schedule|remind me|in \d+ (minute|hour|second|min|hr)s?|run .{1,40} in|set (up )?a task|create a task|check .{1,30} in \d+|search for|look up|find me|pull .{1,30} in|get me .{1,30} in \d+|delete|trash|archive|reply to|forward|unsubscribe|send (an? )?email|check my (email|inbox|mail)|show me (my )?(email|inbox|mail)|still (seeing|getting|receiving|have))\b.{0,60}(email|message|mail|inbox|\bfrom\b)/i;

// Short confirmations/rejections — never meaningful for memory
const CONFIRMATION_RE = /^(yes|no|ok|okay|sure|confirm|cancel|go|stop|done|trash|delete|send|proceed|continue|skip|nope|yep|yup|aye|nah|please|thanks|thank you|got it|sounds good|do it|go ahead|abort)[\s!.]*$/i;

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
    // Auto-detect: scope to the agent's sole service role, if any
    try {
      const { getAgentRoles } = await import('../roles.mjs');
      const roles = getAgentRoles(agentId, userId);
      if (roles.length === 1) roleScope = roles[0];
    } catch (e) { console.debug('[cortex] role auto-scope skipped:', e.message); }
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

// ── processSignals — run after each turn, non-blocking ───────────────────────
export async function processSignals({ agentId, userMessage, agentLastResponse = null, userId = 'default' }) {
  // Skip very short confirmations — "yes", "trash", "ok", "confirm", etc.
  if (CONFIRMATION_RE.test(userMessage.trim())) {
    return { correction: false, preference: false };
  }

  // Check for explicit forget request first
  const forgetSubject = detectForgetRequest(userMessage);
  if (forgetSubject) {
    forgetByText({ agentId, text: forgetSubject, userId }).catch(e => console.warn('[cortex] Forget request failed:', e.message));
    return { correction: false, preference: false, forgot: true };
  }

  // Explicit remember/fact — deterministic fast-path, no LLM required
  const factSubject = detectExplicitRemember(userMessage);
  if (factSubject) {
    pinFact({ agentId, text: factSubject, userId }).catch(e => console.warn('[cortex] Fact pin failed:', e.message));
    return { correction: false, preference: false, remembered: true, factText: factSubject };
  }

  // Skip preference/correction detection for action/scheduling requests
  if (ACTION_REQUEST_RE.test(userMessage)) {
    return { correction: false, preference: false };
  }

  // One combined model call for all signals
  const { correction, preference } = await detectSignals({ agentId, userMessage, agentLastResponse, userId });

  // Friction tracking runs separately (needs message similarity, not signal detection)
  trackFriction({ agentId, userMessage, userId }).catch(e => console.warn('[cortex] Friction tracking failed:', e.message));

  return { correction: !!correction, preference: !!preference };
}
