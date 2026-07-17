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
import { appendToSession, loadSession, failPendingTurn } from '../sessions.mjs';
import { getRoleAssignments, listRoles, getRoleTools } from '../roles.mjs';
import { matchOverride as matchRoutingOverride, logFire as logRoutingFire } from '../lib/routing-overrides.mjs';
import {
  loadConfig, getAgentsForUser, recordActivity, recordTokenUsage,
} from '../routes/_helpers.mjs';
import { interceptScheduling } from '../lib/scheduler-intent.mjs';
import { armFollowupAfterDrain } from '../ws-handler.mjs';
import { runWithTurnContext } from '../lib/turn-abort-context.mjs';
import { log } from '../logger.mjs';
import { getSpecialistTrim } from './slash-commands.mjs';
import { buildVoiceSystemAddition } from '../lib/voice-context.mjs';
import { getTurn, recordRouting } from '../lib/turn-trace-context.mjs';

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
  userText, userId, agentId, source, deviceId, attachment, attachments, toolPlan, ac, onEvent, onNotify,
  conversationMode = false, suppressLearning = false, verifierAllowedTools = null,
  verifierLeaseRequired = false, verifierLeaseToken = null,
}) {
  if (!userText) return null;
  // `attachments` (the composer's full multi-file array) is the preferred
  // shape; `attachment` (singular) is kept for any caller that still only
  // sends one. Not re-using chat-dispatch.mjs's normalizeAttachments here —
  // this file is `// @ts-check`'d and imported by heavily-mocked tests that
  // replace chat.mjs's entire module with `{ streamChat }` only, so pulling
  // in another shared helper here would be one more thing to keep in sync
  // with those mocks for no real benefit (chat-dispatch.mjs, the only real
  // caller, already normalizes once at the top of handleChatMessage).
  const _attachments = Array.isArray(attachments) ? attachments : (attachment ? [attachment] : []);
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
    let route = null;

    // Phase-6 routing overrides: take precedence over the classifier. These
    // are populated via the proposal accept flow when the user has
    // redirected similar phrasings to a specific agent enough times. Skip
    // override when it targets the current agent (no-op routing) or when the
    // forced agent isn't visible to this user.
    const override = matchRoutingOverride(userId, userText);
    if (override?.forcedAgent && override.forcedAgent !== agentId) {
      const forced = getAgentsForUser(userId).find(a => a.id === override.forcedAgent);
      if (forced) {
        route = {
          skillId: null,
          agentId: override.forcedAgent,
          name: forced.name || override.forcedAgent,
          strategy: 'override',
        };
        if (!suppressLearning) logRoutingFire(userId, override.id, userText).catch(() => {});
        console.log(`[chat] routing-override: → ${forced.name || override.forcedAgent} (pattern: "${override.pattern}")`);
      }
    }

    if (!route) route = classifySpecialistIntent(userText, userId, agentId);
    // Embedding fallback: when regex misses, try semantic similarity against
    // the loaded intent_examples. Catches paraphrases regex can't enumerate.
    // ~20ms added cost only when we'd otherwise fall through to the coordinator.
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
    // If the router would route to the agent the user is ALREADY on, skip
    // the specialist hop entirely. Without this guard, every message in a
    // direct chat with a specialist (e.g. on a specialist's chat tab) got dispatched
    // through a fresh `ephemeral_router_*` session — losing the persistent
    // history entirely. Follow-ups like "delete it" then have no context
    // because the prior turn lived in a different (ephemeral) session.
    // Fall through to null so chat-dispatch hands the message to the normal
    // LLM-turn path on the user's actual agent, which has persistent
    // session history.
    if (route.agentId === agentId) {
      console.log(`[chat] specialist-router: skipped (already on ${route.agentId})`);
      return null;
    }
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
    if (trimEnabled && route.skillId) {
      // Override-driven routes don't carry a specialist skill — keep the
      // forced agent's full tool surface so it can answer the actual query.
      const authorizedTargetNames = new Set((target.tools ?? []).map(tool => tool?.function?.name).filter(Boolean));
      const skillTools = getRoleTools(route.skillId, userId)
        .filter(tool => authorizedTargetNames.has(tool?.function?.name));
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
      scopedSpec.systemPrompt = `${target.systemPrompt}\n\n## Current Date\nToday: ${todayStr}\nThis month: ${monthStart} to ${todayStr}\nThis year: ${yearStart} to ${todayStr}${buildVoiceSystemAddition(source)}`;
    }

    // Alias-framework hint propagation. The specialist router bypasses
    // chat-dispatch.mjs:handleChatMessage's resolver, so without this block
    // the embed-routed specialist (email agent for email, coder agent for
    // code, etc.) never sees the user's resolved entity references. Without
    // it, "whats my latest email in <account-label>" still chains
    // email_list_accounts → email_list inside the email specialist because
    // it has no idea which account id the label maps to. This block runs
    // the same buildContextHints used on the coordinator path and prepends
    // the hints to the spec agent's ephemeral system prompt so it goes
    // straight to the right tool args.
    try {
      const { buildContextHints } = await import('../lib/context-resolvers.mjs');
      const { hints } = await buildContextHints(userId, userText, { suppressLearning });
      if (hints) {
        scopedSpec.systemPrompt = `${scopedSpec.systemPrompt}\n\n## Pre-resolved references\n${hints}`;
      }
    } catch (_) { /* best-effort */ }
    console.log(`[chat] specialist-router: → ${route.name} (${route.skillId}) agent=${route.agentId}`);
    // Tag the turn trace — the specialist's own span is added by its nested
    // streamChat (it inherits the dispatcher's turn store via ALS).
    recordRouting({ mode: 'specialist', specialist: route.skillId ?? null, redirectedTo: route.agentId ?? null, strategy: route.strategy ?? 'regex', llmAvoided: false });
    let routerBuf = '';
    let sawInnerDone = false;
    let sawInnerError = false;
    let routeCompleted = false;
    /** @type {Record<string, any> | null} */
    let innerDoneEvent = null;
    /** @type {Record<string, any> | null} */
    let routeErrorEvent = null;
    const emitRouteTerminalError = async (code, message) => {
      let durable = false;
      try {
        durable = await failPendingTurn(`${userId}_${agentId}`, message, {
          status: ac.signal.aborted ? 'stopped' : 'failed',
          retryable: false,
          partial: routerBuf,
        });
      } catch (e) {
        console.warn('[chat] specialist failure status persist failed:', e.message);
      }
      if (ac.signal.aborted) return;
      onEvent({
        type: 'error',
        code: durable ? code : 'persistence_failed',
        message: durable ? message : `Storage error while recording the specialist failure: ${message}`,
        retryable: false,
        agent: agentId,
      });
    };
    try {
      // runWithTurnContext: tools executed inside this stream (incl. ask_agent
      // sync delegations) link their own AbortControllers to this turn's
      // signal, so a user stop unwinds the whole delegation chain; the voice
      // origin lets backgrounded work announce its completion on the device.
      await runWithTurnContext({
        signal: ac.signal, deviceId, conversationMode, suppressLearning, verifierAllowedTools,
        verifierLeaseRequired, verifierLeaseToken,
      }, async () => {
      for await (const event of streamChat(scopedSpec, userText, ac.signal, (e) => {
        // The routed specialist is ephemeral, so its terminal event is only an
        // inner-run boundary — it does NOT mean the coordinator session is on
        // disk. Hold it until the coordinator write below succeeds. streamChat
        // currently uses this callback for auxiliary events, but suppress a
        // callback terminal defensively so this remains a one-done contract if
        // that event surface grows later.
        if (e?.type === 'done') {
          sawInnerDone = true;
          innerDoneEvent = { ...e };
          return;
        }
        if (e?.type === 'error') { sawInnerError = true; routeErrorEvent = { ...e }; return; }
        onEvent({ ...e, agent: agentId });
      }, userId, _attachments, null, false, { source, deviceId }, { toolPlan })) {
        if (event.type === '__notify') { onNotify(userId, agentId, event); continue; }
        if (event.type === '__usage')  { recordTokenUsage(userId, event.inputTokens, event.outputTokens, event.provider, event.model); continue; }
        if (event.type === 'token')    routerBuf += event.text;
        if (event.type === 'replace')  routerBuf = event.text;
        if (event.type === 'done') {
          sawInnerDone = true;
          innerDoneEvent = { ...event };
          continue;
        }
        if (event.type === 'error') { sawInnerError = true; routeErrorEvent = { ...event }; continue; }
        onEvent({ ...event, agent: agentId });
      }
      });

      // A stop/abort or provider error must leave the send-time pending user
      // row intact. Persisting routerBuf here would turn a partial (or empty)
      // stream into a completed assistant reply and router note.
      if (ac.signal.aborted) {
        await failPendingTurn(`${userId}_${agentId}`, 'Stopped by user', {
          status: 'stopped', retryable: false, partial: routerBuf,
        }).catch(() => {});
        return { handled: true };
      }
      if (sawInnerError) {
        await emitRouteTerminalError(
          routeErrorEvent?.code || 'specialist_failed',
          routeErrorEvent?.message || 'The specialist reply failed before completion.',
        );
        return { handled: true };
      }
      if (!sawInnerDone) {
        console.error('[chat] specialist-router ended without a terminal done');
        await emitRouteTerminalError(
          'specialist_incomplete',
          'The specialist reply ended before it could be completed. Nothing was marked complete; please reload before trying again.',
        );
        return { handled: true };
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
      try {
        await appendToSession(`${userId}_${agentId}`,
          { role: 'user', content: userText, ts: viaTs },
          { role: 'assistant', content: routerBuf, ts: viaTs, via: route.skillId, viaAgent: route.agentId, viaName: route.name },
          { role: 'system', content: `[routed to ${route.name} (${route.skillId}) — that specialist ran ephemerally and produced the assistant reply above; you (the coordinator) did not run a turn]`, ts: viaTs + 1, routerNote: true }
        );
      } catch (e) {
        console.error('[chat] specialist persist failed:', e.message);
        await emitRouteTerminalError(
          'persistence_failed',
          'The specialist finished, but its reply could not be saved. It was not marked complete; reload before retrying to avoid repeating any actions.',
        );
        return { handled: true };
      }

      // Release exactly one terminal event only after the coordinator session
      // is durable. Preserve any future metadata carried by streamChat's inner
      // done while forcing the visible agent back to the coordinator.
      routeCompleted = true;
      onEvent({ ...(innerDoneEvent ?? {}), type: 'done', agent: agentId });
      console.log(`[chat] specialist-router done: skill=${route.skillId} trim=${trimEnabled ? 'on' : 'off'} tools=${usedToolCount} durationMs=${Date.now() - routerStart} bytes=${routerBuf.length}`);
      // Local-tier learning also applies to ROUTED turns — they never reach
      // chat-dispatch's post-LLM learn block (the interceptor chain returns
      // here first), yet they're exactly where single-tool custom-skill turns
      // live (field: every localweather ask was specialist-routed, so the
      // auto-proposer never saw them). Fire-and-forget; never blocks return.
      if (!suppressLearning) (async () => {
        try {
          const il = await import('../lib/intent-learner.mjs');
          await il.captureFromTurn({ userId, agentId, userText, scopedSessionKey: `${userId}_${agentId}` });
        } catch (e) { console.warn('[chat] specialist post-turn learn failed:', e.message); }
      })();
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('[chat] specialist-router stream failed:', e.message);
        await emitRouteTerminalError('specialist_failed', e.message);
      } else {
        await failPendingTurn(`${userId}_${agentId}`, 'Stopped by user', {
          status: 'stopped', retryable: false, partial: routerBuf,
        }).catch(() => {});
      }
    } finally {
      // Specialist-routed turns are LLM turns that happen to be routed — they
      // get the SAME follow-up re-arm semantics as runLlmTurn's finally (see
      // armFollowupForReply). Without this, every routed voice turn silently
      // ended the conversation even with conversation_mode:true, because
      // runLlmTurn's finally never runs for interceptor-handled turns.
      if (routeCompleted) armFollowupForReply({ source, deviceId, conversationMode, reply: routerBuf, ac });
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
export async function buildSchedulerNote({ userId, agentId, userText, skipIntercept = false }) {
  let schedulerNote = null;
  // skipIntercept: never run the scheduler-intent interceptor on an autonomous
  // turn (scheduled run / barrier reaction / background continuation). It calls
  // addTask directly, so a task whose prompt contains scheduling language
  // ("daily ... briefing") would re-create itself. A task must never create a
  // task. The time note below is still emitted.
  if (userText && !skipIntercept) {
    try {
      const recentHistory = (await loadSession(`${userId}_${agentId}`, 10))
        .filter(m => m.excludeFromModel !== true)
        .slice(-6);
      const intercept = await interceptScheduling({ userId, agentId, text: userText, history: recentHistory });
      if (intercept.matched) {
        schedulerNote = `<scheduler_result>\n${intercept.outcome}\n</scheduler_result>`;
        if (intercept.sideEffectCommitted === true) {
          const turn = getTurn();
          if (turn) turn.preLlmSideEffectCommitted = true;
        }
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
const RETRIABLE_RE = /\b(5\d{2}|timeout|timed out|rate limit|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|overloaded(?:_error)?)\b/i;

// Only arm when the reply actually ENDS by asking the user something — a "?"
// earlier in the reply is usually rhetorical or embedded and would open a
// needless listen window (a false-listen vector). The LLM is prompted to end
// a genuine question with "?"; allow trailing quotes/brackets/emoji-free
// punctuation after it.
const ENDS_WITH_QUESTION = /[?？]["'”’)\]]*$/;
// Patterns: "please say X", "say 'X'", "tell me X", "let me know", "do you
// mean", "did you mean" — common LLM hedges that ask for user input without a
// literal "?".
const ASKS_FOR_REPLY = /\b(please\s+(say|tell|repeat)|say\s+["'“]|tell\s+me|let\s+me\s+know|d(o|id)\s+you\s+mean)\b/i;

/**
 * Re-arm the voice-device conversation-mode follow-up listening window after
 * a completed reply. Shared by runLlmTurn's finally (direct/coordinator
 * turns) and runSpecialistRoute (embed/regex-routed turns) — before this was
 * extracted, only runLlmTurn armed the window, so ANY specialist-routed voice
 * turn (e.g. "what's on my calendar" → gcal specialist) silently ended the
 * conversation even with conversation_mode:true (field: chat-dispatch.mjs's
 * specialist interceptor is an inline arrow, so the named-fastpath
 * CONVERSATION_REARM_FASTPATHS set could never match it by reference).
 *
 * Conversation mode re-arms unconditionally on every completed reply, question
 * or not — the exchange continues until the user goes silent (window expiry),
 * says a stop/that's-all phrase (handled earlier in the fastpath chain, never
 * reaches here), or a different slot wakes. Outside conversation mode, only
 * arm when the reply reads as a genuine question or asks the user to respond.
 *
 * Never arms for non-voice sources, without a deviceId, or on an aborted turn
 * — a barged-in/stopped reply must not open a phantom listen window.
 * armFollowupAfterDrain itself only fires on a clean TTS-drain close, so
 * calling it after an abort would be harmless anyway; the `ac` check here
 * just mirrors runLlmTurn's original guard exactly.
 */
export function armFollowupForReply({ source, deviceId, conversationMode, reply, ac }) {
  if (source !== 'voice-device' || !deviceId || ac?.signal?.aborted) return;
  if (conversationMode) {
    armFollowupAfterDrain(deviceId, { windowMs: 8000, conversation: true });
    return;
  }
  const text = (reply || '').trim();
  if (ENDS_WITH_QUESTION.test(text) || ASKS_FOR_REPLY.test(text)) {
    // Armed at reply DRAIN (streamer close), not LLM-done — the old direct
    // send raced the audio and could expire mid-reply.
    armFollowupAfterDrain(deviceId, { windowMs: 5000 });
  }
}

/**
 * Run the main LLM turn: streamChat with provider failover, voice-device
 * follow-up listening on a trailing "?", and apiCall activity recording.
 * Owns its own try/catch/finally — never throws. Does NOT call
 * finalizeTurn (the caller still owns the busy-slot lifecycle).
 */
export async function runLlmTurn({
  userId, agentId, scopedAgent, scopedSessionKey,
  userText, sessionUserText = userText, attachment, attachments, toolPlan, documentRequest, schedulerNote, source, deviceId,
  conversationMode = false,
  ac, onEvent, onNotify, hiddenUser = false, isolatedTaskRun = false, readOnlyTurn = false,
  suppressLearning = false, verifierAllowedTools = null,
  verifierLeaseRequired = false, verifierLeaseToken = null,
}) {
  // See the matching comment in runSpecialistRoute above — same fallback,
  // no shared import, for the same test-mock reasons.
  const _attachments = Array.isArray(attachments) ? attachments : (attachment ? [attachment] : []);
  let streamBuf = '';
  // Once a tool has been invoked this attempt, a side effect (email_send, an HA
  // service call, a purchase) may already have executed — so we must NOT re-run
  // the whole turn on a fallback provider, or that tool fires twice. Tracked on
  // both the emit callback and the yielded stream to be robust to either path.
  let toolInvoked = false;
  // The built-in scheduler can create/cancel/reschedule before narration starts.
  // Provider failover within this attempt is safe (the scheduler note is reused),
  // but a user Retry would execute that mutation again, so terminal failures
  // must be nonretryable even though no model-visible tool_call was emitted.
  const preLlmSideEffectCommitted = getTurn()?.preLlmSideEffectCommitted === true;
  let callbackError = null;

  async function emitTurnFailure(event, retryable = !toolInvoked) {
    const message = String(event?.message || 'The turn failed before completion.');
    retryable = retryable === true && !preLlmSideEffectCommitted;
    let durable = false;
    try {
      durable = await failPendingTurn(scopedSessionKey, message, {
        status: ac.signal.aborted ? 'stopped' : 'failed',
        retryable: retryable === true,
        partial: streamBuf,
      });
    } catch (e) {
      console.warn('[chat] failed to persist terminal turn status:', e.message);
    }
    if (ac.signal.aborted) return;
    onEvent({
      ...event,
      type: 'error',
      message: durable ? message : `Storage error while recording the failed turn: ${message}`,
      code: durable ? (event?.code || 'turn_failed') : 'persistence_failed',
      retryable: durable ? retryable === true : false,
      agent: agentId,
    });
  }

  async function runStream(agentObj) {
    callbackError = null;
    let streamError = null;
    // runWithTurnContext: skill executors reached from this stream's tool loop
    // (notably ask_agent's sync delegations) link their own AbortControllers
    // to this turn's signal via getTurnSignal() — without it, a user stop
    // killed the coordinator but a delegated specialist ran to completion.
    // deviceId/conversationMode ride along so auto-backgrounded work can
    // announce its completion on the originating voice device.
    return runWithTurnContext({
      signal: ac.signal, deviceId, conversationMode, suppressLearning, verifierAllowedTools,
      verifierLeaseRequired, verifierLeaseToken,
    }, async () => {
    for await (const event of streamChat(agentObj, userText, ac.signal, (e) => {
      if (e.type === 'tool_call') toolInvoked = true;
      if (e.type === 'error') { callbackError = e; return; }
      onEvent({ ...e, agent: agentId });
    }, userId ?? 'default', _attachments, schedulerNote, false, { source, deviceId }, {
      toolPlan, documentRequest, hiddenUser, isolatedTaskRun,
      readOnlyTurn, sessionUserText,
    })) {
      if (event.type === '__usage')  { recordTokenUsage(userId, event.inputTokens, event.outputTokens, event.provider, event.model); continue; }
      // Retain the first terminal error, but keep draining streamChat. Its
      // errored path persists the provider span/run-inspector record only after
      // the error yield resumes; returning here closed the generator early and
      // erased request/token evidence for failed turns. Nothing after a
      // terminal error is exposed outward or allowed to mutate turn state;
      // only internal usage accounting and generator finalizers still run.
      if (event.type === 'error') { streamError ??= { ...event }; continue; }
      if (streamError) continue;
      if (event.type === '__notify') { onNotify(userId, agentId, event); continue; }
      if (event.type === 'tool_call') toolInvoked = true;
      // Accumulate stream content for persistence buffer
      if (event.type === 'token')   streamBuf += event.text;
      if (event.type === 'replace') streamBuf = event.text;
      onEvent({ ...event, agent: agentId });
    }
    if (streamError) return streamError;
    if (callbackError) { const error = callbackError; callbackError = null; return error; }
    return null; // success
    });
  }

  try {
    const failoverError = await runStream(scopedAgent);

    // ── Provider failover ──────────────────────────────────────────────────
    if (failoverError) {
      const cfg = loadConfig();
      const fo = cfg.providerFailover;
      if (fo?.enabled && fo?.fallbackProvider && fo?.fallbackModel
          && RETRIABLE_RE.test(failoverError.message ?? '') && !toolInvoked) {
        console.log(`[failover] Primary ${scopedAgent.provider}/${scopedAgent.model} failed: ${failoverError.message} — trying ${fo.fallbackProvider}/${fo.fallbackModel}`);
        // Voice devices TTS every token — never speak provider/model names
        // (spoken errors are provider-agnostic by rule). Web keeps the
        // informative version.
        onEvent({ type: 'token', text: source === 'voice-device' ? 'One moment — retrying. ' : `_Retrying with ${fo.fallbackProvider}/${fo.fallbackModel}…_\n\n`, agent: agentId });

        const fallbackAgent = {
          ...scopedAgent,
          provider: fo.fallbackProvider,
          model: fo.fallbackModel,
        };
        const fallbackError = await runStream(fallbackAgent);
        if (fallbackError) await emitTurnFailure(fallbackError, !toolInvoked && fallbackError.retryable !== false);
      } else {
        // No failover (not configured, or a tool already ran this turn — re-running
        // would double-execute its side effects). Emit the original error.
        if (toolInvoked && fo?.enabled && fo?.fallbackProvider && fo?.fallbackModel) {
          console.log(`[failover] skipped — a tool already ran this turn; re-running on ${fo.fallbackProvider}/${fo.fallbackModel} could double-execute side effects`);
        }
        await emitTurnFailure(failoverError, !toolInvoked && failoverError.retryable !== false);
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
      if (fo?.enabled && fo?.fallbackProvider && fo?.fallbackModel && RETRIABLE_RE.test(e.message ?? '') && !toolInvoked) {
        console.log(`[failover] Primary threw: ${enrichedMessage} — trying ${fo.fallbackProvider}/${fo.fallbackModel}`);
        // Voice devices TTS every token — never speak provider/model names
        // (spoken errors are provider-agnostic by rule). Web keeps the
        // informative version.
        onEvent({ type: 'token', text: source === 'voice-device' ? 'One moment — retrying. ' : `_Retrying with ${fo.fallbackProvider}/${fo.fallbackModel}…_\n\n`, agent: agentId });
        try {
          const fallbackAgent = { ...scopedAgent, provider: fo.fallbackProvider, model: fo.fallbackModel };
          const fallbackError = await runStream(fallbackAgent);
          if (fallbackError) await emitTurnFailure(fallbackError, !toolInvoked && fallbackError.retryable !== false);
        } catch (e2) {
          if (e2.name !== 'AbortError') {
            const cause2 = e2?.cause?.code || e2?.cause?.message;
            const msg2 = cause2 && !e2.message?.includes(cause2) ? `${e2.message} (${cause2})` : e2.message;
            await emitTurnFailure({ type: 'error', message: msg2 }, !toolInvoked);
          }
        }
      } else {
        const storageFailure = e?.code === 'SESSION_CLEARED' || /persist|session.*clear|storage/i.test(enrichedMessage || '');
        await emitTurnFailure({ type: 'error', message: enrichedMessage, ...(storageFailure ? { code: 'persistence_failed' } : {}) }, !toolInvoked && !storageFailure);
      }
    } else {
      await failPendingTurn(scopedSessionKey, 'Stopped by user', {
        status: 'stopped', retryable: false, partial: streamBuf,
      }).catch(() => {});
    }
  } finally {
    // Follow-up listening — see armFollowupForReply for the full comment on
    // conversation-mode vs. question-heuristic semantics and the guards
    // (voice-device only, requires deviceId, never on an aborted turn).
    armFollowupForReply({ source, deviceId, conversationMode, reply: streamBuf, ac });
    recordActivity(userId, agentId, { apiCall: true });
  }
}
