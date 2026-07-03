/**
 * Routine proposer — learn HA entity aliases from corrections.
 *
 * Pattern this catches:
 *   user: "<wake-word>, turn off kitchen"
 *   coordinator: (HA fast-path misses on ambiguous "kitchen", router routes to the HA specialist)
 *   HA specialist: calls ha_call_service { domain:'homeassistant', service:'turn_off',
 *           data:{ entity_id:'group.kitchen' } }
 *   helen:  "Kitchen group off."
 *
 * The LLM resolved a phrase that the deterministic fast-path couldn't —
 * exactly the kind of round-trip that should turn into a routine so it
 * fires in ~200 ms next time. We stash a candidate; next turn (if not a
 * correction) we emit a proposal: "Bind 'turn off kitchen' to group.kitchen?"
 *
 * Mirrors lib/skill-proposer.mjs's defer-one-turn pattern so a follow-up
 * "no I meant the lights, not the group" drops the candidate cleanly.
 */
// Deliberately alias-only: an alias binds the NOUN ("kitchen" → entity) so one
// learning covers every verb, where a routine would bind one verb+phrase. The
// routine_proposal kind still exists in proposals.mjs for future shapes
// (scenes/scripts) but nothing emits it today.
import { proposeAlias } from './proposals.mjs';
import { classifyRoutineIntent, normalizePhrase } from './routines.mjs';
import { resolveAlias, normalizeAliasPhrase } from './ha-aliases.mjs';
import { getRoleAssignments } from '../roles.mjs';

// No defer-one-turn pattern here, unlike skill-proposer. For routines the
// signal is unambiguous (single ha_call_service on one entity for a clean
// "turn X" command), so propose immediately. If the user dismisses, the
// per-trigger cooldown in proposals.mjs handles "don't ask again".
const RATE_LIMIT_MS = 30 * 60 * 1000;
const _lastProposedPerUser = new Map(); // userId → ts

// Correction patterns — same shape as skill-proposer. Drop candidates when
// the next user message looks like "no, I meant…".
const CORRECTION_RE = /\b(?:wrong|incorrect|not (?:what|right|correct|like that|that)|that'?s? (?:not|wrong)|don'?t (?:do|need|want)|undo|redo|i (?:said|wanted|meant)|you didn'?t|you missed)\b/i;

// Only propose for cleanly-shaped commands. The fast-path regex is similar
// — we want the routine to fire on the same shape that triggered the LLM
// round-trip in the first place. Lenient on filler ("the", "my", "please").
// Capturing the verb (group 1) so the ha_get_state fallback path can map it
// to a service. Trailing match isn't captured because we use the user's
// normalized full message as the trigger, not the entity phrase.
const COMMAND_RE = /^(turn\s+on|turn\s+off|toggle|activate|dim|brighten|lock|unlock|open|close)\s+(?:the\s+|my\s+)?\S+/i;

const HA_SERVICE_TOOLS = new Set(['ha_call_service']);
const CONTROL_SERVICES = new Set(['turn_on', 'turn_off', 'toggle']);
// Verb → service mapping used when we can only infer the entity from a
// ha_get_state lookup (idempotent case: Helen checked the state, decided
// nothing to do, didn't call the service). The user's verb tells us what
// the routine SHOULD bind to.
const VERB_TO_SERVICE = {
  'turn on':  'turn_on',
  'turn off': 'turn_off',
  'toggle':   'toggle',
};

export function _resetForTests() {
  _lastProposedPerUser.clear();
}

// Resolve the user's chat-facing agent so the proposal bubble lands in
// the session they actually see. When a turn was routed through an
// ephemeral specialist (Helen, etc.), agent.id is an "ephemeral_router_*"
// throwaway whose session jsonl is never rendered to the user. Map it
// back to their coordinator (or first non-ephemeral agent in the roster)
// so the bubble shows up in the chat they're actually looking at.
async function resolveDisplayAgentId(userId, fallbackAgentId) {
  try {
    const { getRoleAssignments } = await import('../roles.mjs');
    const assignments = getRoleAssignments(userId) || {};
    if (assignments.coordinator) return assignments.coordinator;
  } catch (e) {
    console.warn('[routine-proposer] coordinator resolve failed:', e.message);
  }
  // Fallback: strip the ephemeral prefix if present (id shape is
  // "ephemeral_router_<ts>_<rand>_<realAgentId>") to land on the
  // delegate's real id, which IS a renderable session.
  if (typeof fallbackAgentId === 'string') {
    const m = fallbackAgentId.match(/^ephemeral_(?:router|deleg)_\d+_[^_]+_(.+)$/);
    if (m) return m[1];
  }
  return fallbackAgentId;
}

/**
 * Inspect a turn's tools for a single, unambiguous HA control call against a
 * specific entity_id. Returns the candidate descriptor or null.
 *
 * "Single" matters: a routine with one ha_scene action can't faithfully
 * replay a turn that fired three different services. Skip those — the user
 * can build them via the Routines UI explicitly.
 */
function extractCandidate({ userMessage, toolsUsed }) {
  if (typeof userMessage !== 'string') return null;
  const trimmed = userMessage.trim();
  const verbMatch = trimmed.match(COMMAND_RE);
  if (!verbMatch) return null;

  const tu = toolsUsed || [];

  // Primary signal: a single ha_call_service with a control verb.
  // entity_id may live at args.entity_id (Helen's preferred shape per the
  // ha_call_service tool schema) OR nested in args.data.entity_id — accept
  // either. Also strip the optional "<domain>." prefix from `service` so
  // "light.turn_on" is treated as the control verb "turn_on".
  const serviceCalls = tu.filter(t => HA_SERVICE_TOOLS.has(t?.name));
  if (serviceCalls.length === 1) {
    const args = serviceCalls[0].args || {};
    let service = typeof args.service === 'string' ? args.service.toLowerCase() : '';
    if (service.includes('.')) service = service.split('.').pop();
    if (CONTROL_SERVICES.has(service)) {
      const entityIdRaw = (typeof args.entity_id === 'string' && args.entity_id) ||
                          (args.data && typeof args.data === 'object' ? args.data.entity_id : null);
      const entityId = typeof entityIdRaw === 'string' ? entityIdRaw.trim() : null;
      if (entityId && /^[a-z_]{1,32}\.[a-z0-9_]{1,64}$/i.test(entityId)) {
        const text = (serviceCalls[0].text || '').toLowerCase();
        if (!/\b(error|failed|not found|unauthor|forbid|unavailable|404|401)\b/.test(text)) {
          return { trigger: normalizePhrase(trimmed), entityId, service, originalPhrase: trimmed };
        }
      }
    }
  }

  // Fallback signal: Helen called ha_get_state on exactly one entity (the
  // idempotent path — kitchen was already on, she checked then declined to
  // call the service). The verb from the user's message tells us which
  // service to bind. Only fire when (a) the verb is unambiguous and (b)
  // exactly one ha_get_state happened — multiple state checks mean she was
  // exploring, not resolving.
  if (serviceCalls.length === 0) {
    const stateCalls = tu.filter(t => t?.name === 'ha_get_state');
    if (stateCalls.length === 1) {
      const verb = verbMatch[1].toLowerCase().replace(/\s+/g, ' ');
      const service = VERB_TO_SERVICE[verb];
      if (service) {
        const args = stateCalls[0].args || {};
        const entityIdRaw = args.entity_id;
        const entityId = typeof entityIdRaw === 'string' ? entityIdRaw.trim() : null;
        if (entityId && /^[a-z_]{1,32}\.[a-z0-9_]{1,64}$/i.test(entityId)) {
          return { trigger: normalizePhrase(trimmed), entityId, service, originalPhrase: trimmed };
        }
      }
    }
  }

  return null;
}

export async function maybeProposeRoutine({ userId, agentId, agentName, userMessage, toolsUsed, voiceCtx = null }) {
  if (!userId || !agentId) return null;

  const haCalls = (toolsUsed || []).filter(t => t?.name === 'ha_call_service');
  console.log(`[routine-proposer] eval: user="${(userMessage || '').slice(0, 60)}" tools=${(toolsUsed || []).map(t => t.name).join(',')} ha_calls=${haCalls.length}`);

  const last = _lastProposedPerUser.get(userId);
  if (last && (Date.now() - last) < RATE_LIMIT_MS) {
    console.log(`[routine-proposer] skip: rate-limited (last proposal ${Math.round((Date.now() - last) / 60000)} min ago)`);
    return null;
  }

  const candidate = extractCandidate({ userMessage, toolsUsed });
  if (!candidate) {
    if (haCalls.length === 1) {
      console.log(`[routine-proposer] skip: extract failed (args=${JSON.stringify(haCalls[0].args)})`);
    }
    return null;
  }

  if (classifyRoutineIntent(candidate.trigger, userId)) {
    console.log(`[routine-proposer] skip: existing routine matches "${candidate.trigger}"`);
    return null;
  }

  // Derive the phrase being aliased ("turn off kitchen" → "kitchen") so the
  // proposal binds the entity to that NOUN, not the full verb+phrase. One
  // alias works for every verb (turn on/off, set N%, toggle, …) — that's
  // the whole reason aliases exist instead of per-verb routines.
  const phrase = candidate.trigger.replace(/^(?:turn\s+(?:on|off)|toggle|activate|dim|brighten|lock|unlock|open|close)\s+(?:the\s+|my\s+)?/i, '').trim();
  if (!phrase) {
    console.log(`[routine-proposer] skip: could not extract noun from "${candidate.trigger}"`);
    return null;
  }
  // Don't re-propose what's already aliased to this entity.
  const existingAlias = resolveAlias(userId, phrase);
  if (existingAlias === candidate.entityId) {
    console.log(`[routine-proposer] skip: alias "${normalizeAliasPhrase(phrase)}" already → ${candidate.entityId}`);
    return null;
  }

  const displayAgentId = await resolveDisplayAgentId(userId, agentId);
  console.log(`[routine-proposer] proposing alias: "${phrase}" → ${candidate.entityId} on agent ${displayAgentId}`);
  const proposed = await proposeAlias({
    userId,
    agentId: displayAgentId,
    agentName: agentName ?? '',
    phrase,
    entityId: candidate.entityId,
    originalPhrase: candidate.originalPhrase,
    existingAlias: existingAlias || null,
  });
  if (!proposed) {
    console.log(`[routine-proposer] proposeAlias returned null (dismiss cooldown?)`);
    return null;
  }
  _lastProposedPerUser.set(userId, Date.now());

  // Voice surface: if the turn came from a voice device, speak the proposal
  // and open a follow-up listening window so the user can answer yes/no
  // without saying the wake word again. The pre-pipeline yes/no detector in
  // chat-dispatch.mjs catches their answer and accepts/dismisses.
  if (voiceCtx?.source === 'voice-device' && voiceCtx.deviceId) {
    try {
      const { sendToDevice } = await import('../ws-handler.mjs');
      const { notePendingVoiceProposal } = await import('./voice-proposal-queue.mjs');
      // Short, conversational phrasing — voice messages need to be terse
      // and end with a question mark so the firmware opens the listen window.
      const friendly = phrase.replace(/_/g, ' ');
      const sentence = `Want me to remember that "${friendly}" means ${candidate.entityId}? Say yes or no.`;
      // Fallback agent: the user's coordinator-role assignment. A bare
      // string fallback would only work on installs where an agent happens
      // to be named that exact string — resolve from role-assignments instead.
      const fallbackAgent = agentName || getRoleAssignments(userId)?.coordinator || 'coordinator';
      sendToDevice(voiceCtx.deviceId, { type: 'token', text: ' ' + sentence, agent: fallbackAgent });
      sendToDevice(voiceCtx.deviceId, { type: 'done', agent: fallbackAgent });
      sendToDevice(voiceCtx.deviceId, { type: 'await_followup', windowMs: 8000 });
      notePendingVoiceProposal(voiceCtx.deviceId, proposed.id);
      console.log(`[routine-proposer] spoke proposal to device ${voiceCtx.deviceId} (proposal ${proposed.id})`);
    } catch (e) {
      console.warn(`[routine-proposer] voice surface failed: ${e.message}`);
    }
  }

  return proposed;
}

// Kept exported for the chat.mjs callsite that already wires it in; it's a
// no-op now that maybeProposeRoutine fires synchronously. Safe to leave —
// removing it would require touching streamChat too.
export async function flushPendingRoutineCandidate() { return null; }
