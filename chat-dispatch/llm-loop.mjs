// @ts-check
/**
 * chat-dispatch/llm-loop.mjs
 *
 * The LLM-facing half of a chat turn:
 *
 *   1. Specialist router    — when the user is on their coordinator and the
 *                             message clearly belongs to one specialist, run
 *                             the specialist directly and skip the
 *                             coordinator's reasoning turns.
 *   2. Scheduler note       — pre-LLM scheduler intent + a current-time hint
 *                             prepended as a system note for the LLM.
 *   3. LLM turn             — streamChat + provider failover; voice-device
 *                             follow-up listening window on a trailing "?".
 *
 * None of these call finalizeTurn() — that contract stays with the caller
 * (handleChatMessage), which owns the abort-controller / busy-slot registry
 * that finalizeTurn drains.
 */

import { streamChat } from '../chat.mjs';
import { appendToSession, writeStreamBuffer, loadSession } from '../sessions.mjs';
import { getRoleAssignments, listRoles, getRoleTools } from '../roles.mjs';
import {
  loadConfig, getAgentsForUser, recordActivity, recordTokenUsage,
} from '../routes/_helpers.mjs';
import { interceptScheduling } from '../lib/scheduler-intent.mjs';
import { sendToDevice } from '../ws-handler.mjs';
import { log } from '../logger.mjs';
import { getSpecialistTrim } from './slash-commands.mjs';

// ── Specialist router (pre-LLM) ───────────────────────────────────────────────
// Skip the coordinator's reasoning turn when the user's message clearly
// belongs to one specialist. Each skill manifest can declare `intent_patterns`
// (array of regex strings, case-insensitive); a single unique match against an
// ASSIGNED role triggers a direct delegation to that specialist's agent.
// Multi-match or no-match → null → falls through to the normal LLM pipeline so
// the coordinator can disambiguate or handle general queries.
//
// Only fires when the user is chatting with their coordinator. If they
// intentionally opened a specialist chat, leave them alone — they want that
// specific agent to handle everything in that session.

// A request is "compound" when the user is clearly asking for multiple steps
// or explicitly naming a delegation target. Routing those to a single
// specialist via embedding similarity is structurally wrong — the picked
// specialist can satisfy at most one of the asked-for steps, and the others
// either get hallucinated as completed or quietly dropped. (See the
// 2026-05-28 incident where "Compile briefing. Send via Telegram. Also
// delegate to email specialist to email it." routed to deep_research and
// the email step was narrated, not delegated.) Falls through to the
// coordinator's LLM loop instead.
const DELEGATION_VERB_RE = /\b(?:delegate(?:\s+to)?|have\s+\w+\s+(?:email|send|message|tell|do|handle|run|generate|create|compile)|tell\s+\w+\s+to|ask\s+\w+\s+to|have\s+(?:the\s+)?\w+\s+specialist|the\s+\w+\s+specialist|via\s+the\s+\w+\s+specialist)\b/i;
const COMPOUND_CONNECTIVE_RE = /\b(?:also\s+(?:delegate|have|email|send|tell|ask|make|create|generate|compile)|and\s+(?:also|then|email|send|tell|ask|delegate)|then\s+(?:email|send|tell|ask|delegate|have))\b/i;
export function looksCompoundOrDelegation(text) {
  if (!text) return false;
  if (DELEGATION_VERB_RE.test(text)) return true;
  if (COMPOUND_CONNECTIVE_RE.test(text)) return true;
  // Long compound: 3+ sentences AND at least two distinct imperative verbs.
  // Catches "X. Y. Z." multi-step requests that don't use a connective word.
  const sentences = text.split(/[.!?]+\s+/).filter(s => s.trim().length > 4);
  if (sentences.length >= 3) {
    const imperatives = sentences
      .map(s => s.trim().match(/^(?:please\s+)?(\w+)/i)?.[1]?.toLowerCase())
      .filter(Boolean);
    const unique = new Set(imperatives);
    if (unique.size >= 2) return true;
  }
  return false;
}

function classifySpecialistIntent(text, userId, currentAgentId) {
  if (!text) return null;
  // Normalize for matching: lowercase, strip apostrophes, collapse whitespace.
  // Lets patterns be written once for "what's"/"whats"/"what is" rather than
  // every author re-encoding the apostrophe variants in every regex.
  const t = String(text).trim().toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/\s+/g, ' ');
  if (!t) return null;
  const assignments = getRoleAssignments(userId);
  const coordAgentId = assignments?.coordinator;
  if (!coordAgentId || currentAgentId !== coordAgentId) return null;
  const matches = [];
  for (const m of listRoles(userId)) {
    if (!m.service || !Array.isArray(m.intent_patterns) || m.intent_patterns.length === 0) continue;
    const rawOwner = assignments[m.id];
    if (!rawOwner) continue;
    // The literal "coordinator" string is an alias meaning "whoever holds the
    // coordinator role" — resolve it before comparing so we don't try to
    // delegate to a phantom agentId nor accidentally bypass the
    // self-delegation guard below.
    const owner = rawOwner === 'coordinator' ? coordAgentId : rawOwner;
    if (owner === coordAgentId) continue;
    for (const pat of m.intent_patterns) {
      try {
        if (new RegExp(pat, 'i').test(t)) {
          matches.push({ skillId: m.id, agentId: owner, name: m.name });
          break; // one pattern per skill is enough
        }
      } catch (e) {
        console.warn(`[router] bad regex in ${m.id}: ${pat} — ${e.message}`);
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Run the specialist router. When the user is on their coordinator and the
 * message routes to a single specialist (regex or embedding match), run that
 * specialist ephemerally, persist its reply under the coordinator's session,
 * and return {handled:true}. On a miss, returns null so the caller continues
 * to the normal LLM turn.
 *
 * Saves ~3-5s per turn vs the coordinator's "decide → call list_roles → call
 * ask_agent" path.
 *
 * @returns {Promise<{ handled: true } | null>}
 */
export async function runSpecialistRoute({
  userText, userId, agentId, source, deviceId, attachment, ac, onEvent, onNotify,
}) {
  if (!userText) return null;
  // Compound multi-step requests and explicit delegation language (e.g.
  // "delegate to the email specialist", "have <agent> send …") must go through
  // the coordinator's LLM loop — single-specialist routing drops the steps
  // that aren't in the matched specialist's tool surface.
  if (looksCompoundOrDelegation(userText)) {
    console.log('[chat] specialist-router: skipped (compound/delegation message)');
    return null;
  }
  try {
    /** @type {{ skillId: string, agentId: string, name: string, strategy?: string, sim?: number, phrase?: string } | null} */
    let route = classifySpecialistIntent(userText, userId, agentId);
    // Embedding fallback: when regex misses, try semantic similarity against
    // the loaded intent_examples. Catches paraphrases regex can't enumerate.
    // ~20ms added cost only when we'd otherwise fall through to Sydney.
    if (!route && userText.length >= 6) {
      try {
        const { classifyByEmbedding } = await import('../lib/specialist-embed-router.mjs');
        const emb = await classifyByEmbedding(userText, userId, agentId);
        if (emb) {
          route = { skillId: emb.skillId, agentId: emb.agentId, name: emb.name, strategy: 'embed', sim: emb.sim };
          console.log(`[chat] embed-router: → ${emb.name} (${emb.skillId}) sim=${emb.sim.toFixed(3)} via "${emb.phrase}"`);
        }
      } catch (e) {
        console.warn('[chat] embed-router threw, falling through:', e.message);
      }
    }
    if (!route) return null;
    const target = getAgentsForUser(userId).find(a => a.id === route.agentId);
    if (!target) return null;

    // Ephemeral scoped agent for the specialist run — same pattern as
    // skills/delegate/execute.mjs so the specialist's own persistent
    // session isn't polluted with a one-shot coordinator delegation.
    const delegId = `ephemeral_router_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${route.agentId}`;
    const scopedSpec = { ...target, id: delegId, ephemeral: true };
    // Tool-surface reduction: a router-fired turn is a single intent matched
    // to one specialist — we know which skill should answer. Trim the
    // specialist's tool surface to that skill's own tools so gpt-5.x doesn't
    // reason through 70-80 unrelated tools per turn. Toggleable at runtime
    // via `/trim on|off` for A/B latency tests.
    const fullToolCount = target.tools?.length ?? 0;
    let usedToolCount = fullToolCount;
    const trimEnabled = getSpecialistTrim();
    if (trimEnabled) {
      const skillTools = getRoleTools(route.skillId, userId);
      if (skillTools.length) {
        scopedSpec.tools = skillTools;
        usedToolCount = skillTools.length;
      }
    }
    console.log(`[chat] specialist-router: trim=${trimEnabled ? 'on' : 'off'} tools=${usedToolCount} (full=${fullToolCount})`);
    const routerStart = Date.now();
    {
      const now = new Date();
      const todayStr   = now.toISOString().slice(0, 10);
      const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const yearStart  = `${now.getFullYear()}-01-01`;
      scopedSpec.systemPrompt = `${target.systemPrompt}\n\n## Current Date\nToday: ${todayStr}\nThis month: ${monthStart} to ${todayStr}\nThis year: ${yearStart} to ${todayStr}`;
    }
    console.log(`[chat] specialist-router: → ${route.name} (${route.skillId}) agent=${route.agentId}`);
    let routerBuf = '';
    try {
      for await (const event of streamChat(scopedSpec, userText, ac.signal, (e) => {
        onEvent({ ...e, agent: agentId });
      }, userId, attachment, null, false, { source, deviceId })) {
        if (event.type === '__notify') { onNotify(userId, agentId, event); continue; }
        if (event.type === '__usage')  { recordTokenUsage(userId, event.inputTokens, event.outputTokens, event.provider, event.model); continue; }
        if (event.type === 'token')    routerBuf += event.text;
        if (event.type === 'replace')  routerBuf = event.text;
        onEvent({ ...event, agent: agentId });
      }
      // Persist the turn under the coordinator's session so the user sees it
      // in the chat they actually typed into. The specialist ran ephemerally,
      // so this is the only durable record.
      //
      // Tag the assistant message with `via` so future history loads can tell
      // this turn came from a specialist, not from the coordinator itself.
      // Append a system note so the NEXT coordinator turn can read "what just
      // happened" without us having to filter on `via` everywhere — without
      // this, short follow-ups like "send" land on the coordinator with no
      // idea what the prior routed turn did, and it asks "send what, where?".
      const viaTs = Date.now();
      appendToSession(`${userId}_${agentId}`,
        { role: 'user', content: userText, ts: viaTs },
        { role: 'assistant', content: routerBuf, ts: viaTs, via: route.skillId, viaAgent: route.agentId, viaName: route.name },
        { role: 'system', content: `[routed to ${route.name} (${route.skillId}) — that specialist ran ephemerally and produced the assistant reply above; you (the coordinator) did not run a turn]`, ts: viaTs + 1, routerNote: true }
      );
      console.log(`[chat] specialist-router done: skill=${route.skillId} trim=${trimEnabled ? 'on' : 'off'} tools=${usedToolCount} durationMs=${Date.now() - routerStart} bytes=${routerBuf.length}`);
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('[chat] specialist-router stream failed:', e.message);
        onEvent({ type: 'error', message: e.message, agent: agentId });
      }
    } finally {
      recordActivity(userId, agentId, { apiCall: true });
    }
    return { handled: true };
  } catch (e) {
    console.warn('[chat] specialist-router threw, falling through:', e.message);
    return null;
  }
}

/**
 * Build the pre-LLM system note: current time + (optional) scheduler-intent
 * outcome. The scheduler interceptor runs the fine-tuned plan model on every
 * chat regardless of which agent the user is talking to, so scheduling works
 * system-wide without needing the tasks skill assigned. Misses fall through
 * with only the time note set.
 */
export async function buildSchedulerNote({ userId, agentId, userText }) {
  let schedulerNote = null;
  if (userText) {
    try {
      const recentHistory = loadSession(`${userId}_${agentId}`, 6);
      const intercept = await interceptScheduling({ userId, agentId, text: userText, history: recentHistory });
      if (intercept.matched) {
        schedulerNote = `<scheduler_result>\n${intercept.outcome}\n</scheduler_result>`;
      }
    } catch (e) {
      console.warn('[chat-dispatch] scheduler intercept threw:', e.message);
    }
  }
  const now = new Date();
  const timeNote = `<current_time>${now.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</current_time>`;
  return schedulerNote ? `${timeNote}\n${schedulerNote}` : timeNote;
}

// ── Retriable error patterns for provider failover ──────────────────────
const RETRIABLE_RE = /\b(5\d{2}|timeout|timed out|rate limit|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed)\b/i;

/**
 * Run the main LLM turn: streamChat with provider failover, voice-device
 * follow-up listening on a trailing "?", and apiCall activity recording.
 * Owns its own try/catch/finally — never throws. Does NOT call
 * finalizeTurn (the caller still owns the busy-slot lifecycle).
 */
export async function runLlmTurn({
  userId, agentId, scopedAgent, scopedSessionKey,
  userText, attachment, schedulerNote, source, deviceId,
  ac, onEvent, onNotify,
}) {
  let streamBuf = '';

  async function runStream(agentObj) {
    for await (const event of streamChat(agentObj, userText, ac.signal, (e) => {
      onEvent({ ...e, agent: agentId });
    }, userId ?? 'default', attachment, schedulerNote, false, { source, deviceId })) {
      if (event.type === '__notify') { onNotify(userId, agentId, event); continue; }
      if (event.type === '__usage')  { recordTokenUsage(userId, event.inputTokens, event.outputTokens, event.provider, event.model); continue; }
      // Check if this error is retriable — return it instead of emitting
      if (event.type === 'error' && RETRIABLE_RE.test(event.message ?? '')) {
        return event; // signal caller to attempt failover
      }
      // Accumulate stream content for persistence buffer
      if (event.type === 'token')   streamBuf += event.text;
      if (event.type === 'replace') streamBuf = event.text;
      if (streamBuf) writeStreamBuffer(scopedSessionKey, streamBuf);
      onEvent({ ...event, agent: agentId });
    }
    return null; // success
  }

  try {
    const failoverError = await runStream(scopedAgent);

    // ── Provider failover ──────────────────────────────────────────────────
    if (failoverError) {
      const cfg = loadConfig();
      const fo = cfg.providerFailover;
      if (fo?.enabled && fo?.fallbackProvider && fo?.fallbackModel) {
        console.log(`[failover] Primary ${scopedAgent.provider}/${scopedAgent.model} failed: ${failoverError.message} — trying ${fo.fallbackProvider}/${fo.fallbackModel}`);
        onEvent({ type: 'token', text: `_Retrying with ${fo.fallbackProvider}/${fo.fallbackModel}…_\n\n`, agent: agentId });

        const fallbackAgent = {
          ...scopedAgent,
          provider: fo.fallbackProvider,
          model: fo.fallbackModel,
        };
        const fallbackError = await runStream(fallbackAgent);
        if (fallbackError) {
          onEvent({ ...fallbackError, agent: agentId });
        }
      } else {
        // No failover configured — emit the original error
        onEvent({ ...failoverError, agent: agentId });
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      // Surface the underlying network reason when present — bare "fetch failed"
      // is useless to debug; "fetch failed (ECONNRESET)" is actionable.
      const causeTag = e?.cause?.code || e?.cause?.message;
      const enrichedMessage = causeTag && !e.message?.includes(causeTag)
        ? `${e.message} (${causeTag})`
        : e.message;
      log.error('chat', 'turn threw', {
        userId, agentId,
        provider: scopedAgent.provider,
        model: scopedAgent.model,
        err: enrichedMessage,
        causeCode: e?.cause?.code,
      });

      // Attempt failover on thrown errors too (e.g. fetch failures)
      const cfg = loadConfig();
      const fo = cfg.providerFailover;
      if (fo?.enabled && fo?.fallbackProvider && fo?.fallbackModel && RETRIABLE_RE.test(e.message ?? '')) {
        console.log(`[failover] Primary threw: ${enrichedMessage} — trying ${fo.fallbackProvider}/${fo.fallbackModel}`);
        onEvent({ type: 'token', text: `_Retrying with ${fo.fallbackProvider}/${fo.fallbackModel}…_\n\n`, agent: agentId });
        try {
          const fallbackAgent = { ...scopedAgent, provider: fo.fallbackProvider, model: fo.fallbackModel };
          const fallbackError = await runStream(fallbackAgent);
          if (fallbackError) onEvent({ ...fallbackError, agent: agentId });
        } catch (e2) {
          if (e2.name !== 'AbortError') {
            const cause2 = e2?.cause?.code || e2?.cause?.message;
            const msg2 = cause2 && !e2.message?.includes(cause2) ? `${e2.message} (${cause2})` : e2.message;
            onEvent({ type: 'error', message: msg2, agent: agentId });
          }
        }
      } else {
        onEvent({ type: 'error', message: enrichedMessage, agent: agentId });
      }
    }
  } finally {
    // Follow-up listening: if the reply contains a question OR an imperative
    // asking the user to say/tell/respond, open a short listen window so the
    // user can answer without saying the wake word again. The system prompt
    // instructs the LLM to use a trailing "?" — these imperatives are a
    // safety net for when it doesn't. Only sends for voice-device sources.
    if (source === 'voice-device' && deviceId) {
      const reply = (streamBuf || '').trim();
      const HAS_QUESTION = /[?？]/;
      // Patterns: "please say X", "say 'X'", "tell me X", "let me know",
      // "do you mean", "did you mean" — common LLM hedges that ask for
      // user input without a literal "?".
      const ASKS_FOR_REPLY = /\b(please\s+(say|tell|repeat)|say\s+["'“]|tell\s+me|let\s+me\s+know|d(o|id)\s+you\s+mean)\b/i;
      if (HAS_QUESTION.test(reply) || ASKS_FOR_REPLY.test(reply)) {
        sendToDevice(deviceId, { type: 'await_followup', windowMs: 5000 });
      }
    }
    recordActivity(userId, agentId, { apiCall: true });
  }
}
