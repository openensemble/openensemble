// @ts-check
/**
 * chat-dispatch/voice-preprocess.mjs
 *
 * Pre-LLM interceptors that bypass the chat pipeline entirely. Most gate on
 * `source === 'voice-device'`; the staged-approval intercepts
 * (CONFIRM DELETION / APPROVE PURGE / APPROVE PROVEN) fire on any source
 * because the user can also type them in a browser chat.
 *
 * Each `try*` returns `{handled: true}` on match (the caller returns
 * immediately) or `null` on miss. These interceptors run BEFORE the
 * abort-controller / busy-slot setup, so they don't go through
 * finalizeTurn — that contract starts later in handleChatMessage.
 *
 * Order matters and matches the original chat-dispatch flow:
 *   1. voice-proposal yes/no (only when pending)
 *   2. voice-timer disambig → extend → cancel → create
 *   3. voice-intent (volume / mute / pause / stop / unmute)
 *   4. CONFIRM DELETION       — staged destructive expense op
 *   5. APPROVE PURGE          — staged destructive email op
 *   6. APPROVE PROVEN         — staged trust-state promotion
 *   7. APPROVE WATCHER OP     — staged cross-agent watcher cancel/update
 *                                (coordinator deferred when a specialist
 *                                asked to touch another agent's watcher)
 */

import { appendToSession, failPendingTurn } from '../sessions.mjs';
import {
  classifyTimerIntent, createVoiceTimer,
  classifyTimerCancelIntent, cancelVoiceTimer,
  classifyTimerExtendIntent, extendVoiceTimer,
  resolveTimerDisambig, hasPendingDisambig, DISAMBIG_TTL_MS,
} from '../lib/voice-timer.mjs';
import { sendToDevice } from '../ws-handler.mjs';
import { updateDevice } from '../lib/voice-devices.mjs';
import { broadcastAlarmStop, hasActiveAlarms } from '../lib/alarms.mjs';
import { abortChat } from './slot-registry.mjs';
import { stopAmbientOnDevice } from '../lib/ambient-playback.mjs';
import { getAmbientForDevice } from '../routes/devices.mjs';

// Per-device "the user just said stop" marker. Used by chat-dispatch's
// ambient auto-restore so that 3-second restore setTimeouts queued by
// prior LLM turns don't resurrect ambient seconds after the user actually
// silenced it. 15s window covers the worst case where 4-5 TV-driven wakes
// stacked their finally-block timers before stop landed.
const _recentStopIntent = new Map(); // deviceId → ts (ms)
const STOP_INTENT_TTL_MS = 15_000;
function markStopIntent(deviceId) {
  if (deviceId) _recentStopIntent.set(deviceId, Date.now());
}
export function wasRecentStopIntent(deviceId, withinMs = STOP_INTENT_TTL_MS) {
  if (!deviceId) return false;
  const ts = _recentStopIntent.get(deviceId);
  if (!ts) return false;
  if (Date.now() - ts > withinMs) {
    _recentStopIntent.delete(deviceId);
    return false;
  }
  return true;
}
import {
  getPendingDelete, clearPendingDelete, executePendingDelete,
} from '../skills/expenses/execute.mjs';
import {
  getPendingEmail, clearPendingEmail, executePendingEmail,
} from '../skills/email/execute.mjs';
import {
  getPendingProven, clearPendingProven, executePendingProven,
} from '../skills/profiles/execute.mjs';
import {
  getPendingWatcherOp, clearPendingWatcherOp, executePendingWatcherOp,
} from '../skills/tasks/execute.mjs';

/**
 * Re-check the account and per-tool permission boundary at approval time.
 *
 * A destructive operation can sit in the pending store for several minutes.
 * The account's allowed-skills ceiling, disabled-skill state, or hidden-tools
 * override may change during that window, so authorization at stage time is
 * not sufficient. Keep this import lazy: roles.mjs loads the skill executors,
 * and importing it at module evaluation time would create a cycle.
 *
 * The automation helper deliberately fails closed for malformed override
 * storage. Any failure here cancels the staged approval instead of letting a
 * stale grant reach an executor.
 */
async function isPendingApprovalAuthorized(userId, skillId, toolName) {
  if (!userId || !skillId || !toolName) return false;
  try {
    const [roles, overrides] = await Promise.all([
      import('../roles.mjs'),
      import('../lib/skill-overrides.mjs'),
    ]);
    return roles.isSkillRuntimeEnabledForUser(skillId, userId) === true
      && overrides.assertSkillToolAutomationAllowed(userId, skillId, toolName) === true;
  } catch (e) {
    console.warn(`[approval] authorization re-check failed for ${skillId}.${toolName}:`, e?.message ?? e);
    return false;
  }
}

/**
 * Fast-path regex router for voice-device control intents. Runs BEFORE the
 * full LLM dispatch so common commands like "volume up" / "pause" / "stop"
 * complete in ~1 ms with no token cost.
 *
 * Returns null when nothing matches → caller falls through to the normal
 * chat pipeline. Returns an intent object on match; the executor below
 * acts on it and tells the caller whether to `replaces` the in-flight
 * agent reply (stop) or leave it alone (volume / pause / resume).
 *
 * Keep the regex set small and obvious — if natural-phrasing misses
 * become a real problem, layer a tiny LLM classifier on top, don't
 * inflate the regex set into something unreadable.
 */
function classifyVoiceIntent(text, { ambientActive = false, conversationEnabled = false, bargeIn = false } = {}) {
  if (typeof text !== 'string') return null;
  const t = text.toLowerCase().trim().replace(/[.,!?]+$/, '');
  if (!t) return null;

  // Conversation-mode closers. Only classified when the device is in
  // conversation mode — in normal mode "goodbye" should still reach the LLM
  // for a proper farewell instead of being swallowed by a canned ack. Bare
  // forms only; "that's all the milk we have" must not end anything.
  if (conversationEnabled &&
      /^(that('s| is| will be|'ll be)?\s+all(\s+for\s+now)?|(i('m| am)\s+)?(all\s+)?done|we('re| are)\s+done|no\s+than(ks|k you)(,?\s+that('s|s| is)\s+(all|it))?|than(ks|k you),?\s+that('s|s| is)\s+(all|it)|good\s*bye|bye(\s+bye)?|good\s*night)$/.test(t)) {
    return { type: 'conversation_end' };
  }

  // Loose stop during ambient OR on a speech-barge turn: STT often picks up
  // the user's "stop" surrounded by other audio — TV/room noise under
  // ambient, or (barge) a prefix of the interrupted reply bled into the
  // pre-roll ("…the capital is Paris. Stop."). The strict ^-anchored regex
  // below would miss those. In both situations "stop" anywhere in the
  // transcript almost certainly means stop — the cost of a false positive
  // is bounded, a missed stop is the worst UX in the system. Guarded against
  // explicit negation ("don't stop", "do not stop", "didn't stop").
  if ((ambientActive || bargeIn) && /\b(stop|shut\s+up|enough)\b/.test(t)
      && !/\b(do\s*n[o']?t|did\s*n[o']?t|never)\s+(stop|shut)/.test(t)) {
    return { type: 'stop' };
  }

  // Absolute "volume N%" / "set volume to N" — match before the bare
  // up/down regex so "volume 50" doesn't get swallowed as "volume … up".
  const setM = t.match(/^(?:set\s+)?volume(?:\s+to)?\s+(\d{1,3})\s*%?$/);
  if (setM) {
    const pct = Math.max(0, Math.min(100, Number(setM[1])));
    return { type: 'volume_set', pct };
  }
  if (/^(volume\s+up|louder|turn\s+(it\s+)?up)\b/.test(t))   return { type: 'volume_up' };
  if (/^(volume\s+down|quieter|softer|turn\s+(it\s+)?down)\b/.test(t)) return { type: 'volume_down' };

  if (/^(mute|be\s+quiet)\b/.test(t))     return { type: 'mute' };
  if (/^unmute\b/.test(t))                return { type: 'unmute' };

  if (/^(headphones?|headphone\s*mode)\s+(on|enable[d]?)\b/.test(t)) return { type: 'headphone_on' };
  if (/^(headphones?|headphone\s*mode)\s+(off|disable[d]?)\b/.test(t)) return { type: 'headphone_off' };

  // AirPlay track control. Sent unconditionally — the device-side wrappers
  // no-op when no AirPlay session is streaming, so we don't need to track
  // playback state server-side. Match the keyword *anywhere* in a short
  // utterance so STT prefixes ("uh skip", "go to the next song", "play the
  // previous track") still hit the fast-path instead of falling through to
  // the LLM. The 6-word ceiling keeps unrelated long sentences from being
  // mis-routed (e.g. "I'll do that next time you ask").
  const wordCount = t.split(/\s+/).length;
  if (wordCount <= 6) {
    if (/\b(skip|fast\s*forward)\b/.test(t)) return { type: 'airplay_next' };
    if (/\bnext\s+(song|track|one)\b/.test(t)) return { type: 'airplay_next' };
    if (/^next\.?$/.test(t)) return { type: 'airplay_next' };
    if (/\bprevious(\s+(song|track|one))?\b/.test(t)) return { type: 'airplay_prev' };
    if (/\b(go\s+back|back\s+(one|song|track))\b/.test(t)) return { type: 'airplay_prev' };
    if (/^(back|rewind)\.?$/.test(t)) return { type: 'airplay_prev' };
    if (/\bpause\s+(it|this|the\s+(song|music|track))\b/.test(t)) return { type: 'pause' };
    if (/\b(resume|unpause|keep\s+playing)\b/.test(t)) return { type: 'resume' };
  }

  if (/^pause\b/.test(t))                 return { type: 'pause' };
  if (/^(resume|continue|unpause)\b/.test(t)) return { type: 'resume' };
  // Bare "play" / "play music" / "play it" = resume the current playback. But
  // "play <something>" (e.g. "play Twice Fancy on YouTube Music") is a *new*
  // play request — let it fall through to the LLM/skill dispatch instead of
  // mis-firing a resume. Anchored at end so only contentless plays resume here.
  if (/^play(\s+(music|it|this|that|the\s+(song|music|track)))?[.!?]*$/.test(t)) {
    return { type: 'resume' };
  }

  // Stop / cancel — barge-in firmware has already killed local audio; we
  // mark this `replaces` so the chat pipeline doesn't generate a reply.
  // Only near-bare forms short-circuit: "cancel my 3pm reminder" is a real
  // request that must reach the LLM, not get swallowed by a false "okay".
  if (/^(stop|cancel|never\s*mind|shut\s+up|that('s|s)\s+enough)(\s+(it|that|this|everything|talking|playing|the\s+(music|song|audio|sound|alarm|timer|noise)|(playing\s+)?(music|audio)))?[.!?\s]*$/.test(t)) {
    return { type: 'stop' };
  }

  return null;
}

/**
 * Execute a matched voice intent against the device. Returns
 * { replaces: bool } — true means short-circuit the chat pipeline (don't
 * run the LLM, don't generate a reply); false means we already handled
 * the side effect but the caller can continue if desired (in practice
 * we still short-circuit for all of these because they're terminal).
 */
function executeVoiceIntent(intent, deviceId, userId, agentId = null, { spareBed = false } = {}) {
  if (!deviceId) return { replaces: false };
  switch (intent.type) {
    case 'volume_up':
      sendToDevice(deviceId, { type: 'set_volume', delta: 10 });
      return { replaces: true };
    case 'volume_down':
      sendToDevice(deviceId, { type: 'set_volume', delta: -10 });
      return { replaces: true };
    case 'volume_set':
      sendToDevice(deviceId, { type: 'set_volume', pct: intent.pct });
      return { replaces: true };
    case 'mute':
      sendToDevice(deviceId, { type: 'set_volume', pct: 0 });
      return { replaces: true };
    case 'unmute':
      // 80% matches the firmware default; if the user had a custom level
      // before muting we lose it. Acceptable for v1 — next iteration
      // could track pre-mute volume per device.
      sendToDevice(deviceId, { type: 'set_volume', pct: 80 });
      return { replaces: true };
    case 'headphone_on':
      sendToDevice(deviceId, { type: 'set_headphone_mode', enabled: true });
      if (userId) updateDevice(userId, deviceId, { headphone_mode: true });
      return { replaces: true };
    case 'headphone_off':
      sendToDevice(deviceId, { type: 'set_headphone_mode', enabled: false });
      if (userId) updateDevice(userId, deviceId, { headphone_mode: false });
      return { replaces: true };
    case 'pause':
      sendToDevice(deviceId, { type: 'pause_playback' });
      return { replaces: true };
    case 'resume':
      sendToDevice(deviceId, { type: 'resume_playback' });
      return { replaces: true };
    case 'stop':
      // spareBed: the stop arrived as (or right after) a reply interruption —
      // the user is stopping the ASSISTANT, not the rain/music underneath.
      // Field bug 2026-07-04: "that's enough" during a WW2 answer over
      // ambient killed both the reply AND the thunderstorm. When sparing,
      // also skip markStopIntent — it exists to suppress ambient auto-
      // restores, which is exactly what we don't want here.
      if (deviceId && !spareBed) markStopIntent(deviceId);
      // Abort the in-flight LLM turn too. This fast-path runs before
      // openTurn(), so "stop" during THINKING used to only silence audio —
      // the prior turn's tool calls (an email send, an HA action) kept
      // executing in the background with their tokens dropped as stale.
      if (userId && agentId) {
        try { abortChat(userId, agentId); } catch (e) { console.warn('[chat] voice-stop abort failed:', e.message); }
      }
      // Local audio was already stopped by the barge-in handler in
      // firmware when the wake fired. Also broadcast alarm_stop to every
      // device holding an active alarm for this user; the server removes
      // those registry entries immediately so stale alarms do not poison
      // future stop intents. The firmware's wake-while-alarm-firing path already
      // dismisses locally without an STT roundtrip, so this catches the
      // typed/UI-driven stops that don't go through the device's wake.
      if (userId && hasActiveAlarms(userId)) {
        const n = broadcastAlarmStop(userId);
        console.log(`[chat] voice-stop broadcasted alarm_stop to ${n} device(s) for ${userId}`);
      }
      // Also cancel any looped ambient playback on the originating device —
      // UNLESS this stop targets a just-interrupted reply (spareBed): then
      // the bed survives and the device's own idle logic resumes it.
      if (deviceId && !spareBed) stopAmbientOnDevice(deviceId);
      // Stop any AirPlay session, same spareBed rule. The device's
      // airplay_stop is a no-op when nothing is streaming.
      if (deviceId && !spareBed) sendToDevice(deviceId, { type: 'airplay_stop' });
      return { replaces: true };
    case 'airplay_next':
      sendToDevice(deviceId, { type: 'airplay_next' });
      return { replaces: true };
    case 'airplay_prev':
      sendToDevice(deviceId, { type: 'airplay_prev' });
      return { replaces: true };
    case 'conversation_end':
      // Nothing to tear down — the reply already finished (the user is
      // answering inside a follow-up window). Being a fastpath, this never
      // reaches llm-loop, so no new window is armed: the conversation just
      // ends. The caller speaks the short ack.
      return { replaces: true };
  }
  return { replaces: false };
}

/**
 * Voice proposal yes/no: if the prior turn spoke a proposal ("Want me to
 * remember that 'kitchen' means light.kitchen_group?") and the user is
 * now answering, accept or dismiss directly without going through any
 * LLM/router. Anything that ISN'T yes/no on a pending proposal clears
 * the pending state and continues into the normal pipeline.
 *
 * @returns {Promise<{ handled: true } | null>}
 */
export async function tryVoiceProposalReply({ source, deviceId, rawText, agentId, onEvent }) {
  if (!(source === 'voice-device' && deviceId && typeof rawText === 'string')) return null;
  try {
    const { peekPendingVoiceProposal, clearPendingVoiceProposal } =
      await import('../lib/voice-proposal-queue.mjs');
    const pending = peekPendingVoiceProposal(deviceId);
    if (!pending) return null;
    const t = rawText.trim().toLowerCase().replace(/[.,!?]+$/, '');
    const YES = /^(yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|sounds good|sure thing)\b/;
    const NO  = /^(no|nope|nah|don't|dont|cancel|skip|not now|never mind|nevermind)\b/;
    if (YES.test(t)) {
      clearPendingVoiceProposal(deviceId);
      const { acceptProposal } = await import('../lib/proposals.mjs');
      await acceptProposal(pending.proposalId);
      console.log(`[chat] voice-proposal accept: ${pending.proposalId}`);
      onEvent({ type: 'token', text: 'Saved.', agent: agentId });
      onEvent({ type: 'done', agent: agentId });
      return { handled: true };
    }
    if (NO.test(t)) {
      clearPendingVoiceProposal(deviceId);
      const { dismissProposal } = await import('../lib/proposals.mjs');
      await dismissProposal(pending.proposalId);
      console.log(`[chat] voice-proposal dismiss: ${pending.proposalId}`);
      onEvent({ type: 'token', text: 'Okay.', agent: agentId });
      onEvent({ type: 'done', agent: agentId });
      return { handled: true };
    }
    // Not yes/no — clear pending state so a later unrelated "yes" doesn't
    // get attributed to this proposal, then fall through to normal flow.
    clearPendingVoiceProposal(deviceId);
    console.log(`[chat] voice-proposal cleared (non-yes/no follow-up): ${pending.proposalId}`);
  } catch (e) {
    console.warn('[chat] voice-proposal check threw, falling through:', e.message);
  }
  return null;
}

/**
 * Voice-device countdown timer fast-path. Order matters:
 *   disambig (existing "5 or 10?" prompt) → extend → cancel → create.
 * "Cancel"/"stop" needs to win over the generic voice-intent stop below,
 * which is why this runs first.
 */
export async function tryVoiceTimerIntent({ source, deviceId, rawText, userId, agentId, onEvent }) {
  if (!(source === 'voice-device' && deviceId && typeof rawText === 'string')) return null;

  // Disambig response first: if we asked "the 5 or 10 minute one?" and
  // the user just said "5 minute", treat that as the pick — before the
  // create regex sees "5 minute timer"-shaped text and starts a new one.
  // Works for both pending-cancel and pending-extend prompts.
  try {
    const resolved = await resolveTimerDisambig(rawText, { deviceId });
    if (resolved) {
      console.log(`[chat] voice-timer disambig resolved device=${deviceId}`);
      onEvent({ type: 'token', text: resolved.confirmation, agent: agentId });
      onEvent({ type: 'done', agent: agentId });
      return { handled: true };
    }
  } catch (e) {
    console.warn(`[chat] voice-timer disambig failed: ${e.message}`);
  }

  const extend = classifyTimerExtendIntent(rawText);
  if (extend) {
    try {
      const confirmation = await extendVoiceTimer({ userId, deviceId, addSeconds: extend.addSeconds, targetSeconds: extend.targetSeconds });
      console.log(`[chat] voice-timer extend: +${extend.addSeconds}s target=${extend.targetSeconds ?? '?'} device=${deviceId}`);
      onEvent({ type: 'token', text: confirmation, agent: agentId });
      onEvent({ type: 'done', agent: agentId });
      // Ambiguous match → the confirmation is really a "which one?" question
      // with a hard server-side TTL; tell the dispatcher to hold the mic open.
      if (hasPendingDisambig(deviceId)) return { handled: true, awaitReplyMs: DISAMBIG_TTL_MS };
      return { handled: true };
    } catch (e) {
      console.warn(`[chat] voice-timer extend failed: ${e.message}`);
    }
  }

  const cancel = classifyTimerCancelIntent(rawText);
  if (cancel) {
    try {
      const confirmation = cancelVoiceTimer({ userId, deviceId, all: cancel.all, seconds: cancel.seconds });
      console.log(`[chat] voice-timer cancel: all=${cancel.all} seconds=${cancel.seconds ?? '?'} userId=${userId}`);
      onEvent({ type: 'token', text: confirmation, agent: agentId });
      onEvent({ type: 'done', agent: agentId });
      if (hasPendingDisambig(deviceId)) return { handled: true, awaitReplyMs: DISAMBIG_TTL_MS };
      return { handled: true };
    } catch (e) {
      console.warn(`[chat] voice-timer cancel failed: ${e.message}`);
    }
  }

  const timer = classifyTimerIntent(rawText);
  if (timer) {
    try {
      const confirmation = await createVoiceTimer({ userId, deviceId, seconds: timer.seconds });
      console.log(`[chat] voice-timer: ${timer.spoken} device=${deviceId}`);
      onEvent({ type: 'token', text: confirmation, agent: agentId });
      onEvent({ type: 'done', agent: agentId });
      return { handled: true };
    } catch (e) {
      console.warn(`[chat] voice-timer failed: ${e.message}`);
    }
  }

  return null;
}

/**
 * Voice-device control intent: volume up/down, mute/unmute, pause/resume,
 * stop/cancel. Regex-matched + executed as a WS message to the originating
 * device with no LLM round-trip.
 */
export function tryVoiceControlIntent({ source, rawText, deviceId, userId, agentId, onEvent, conversationMode = false, bargeIn = false, recentReplyStop = false }) {
  if (!(source === 'voice-device' && typeof rawText === 'string')) return null;
  const ambientActive = !!(deviceId && getAmbientForDevice(deviceId));
  const intent = classifyVoiceIntent(rawText, { ambientActive, conversationEnabled: conversationMode, bargeIn });
  if (!intent) return null;
  const { replaces } = executeVoiceIntent(intent, deviceId, userId, agentId, { spareBed: bargeIn || recentReplyStop });
  console.log(`[chat] voice-intent: ${intent.type}${intent.pct != null ? `=${intent.pct}` : ''} device=${deviceId ?? '?'} replaces=${replaces}`);
  if (!replaces) return null;
  // Short audible confirmation so the user hears that the device got it.
  // Without this, "<wake-word> stop" / "<wake-word> volume 50" applies silently and
  // the user can't tell if anything happened. Routes through the standard
  // chat-event path → accumulator → sentence queue → tts_worker_task →
  // MP3 over the same /api/tts pipeline a normal reply uses.
  //
  // Pause is the one place this is slightly awkward: the pause WS message
  // arrives at the device on a separate path and may apply before the
  // "okay" TTS finishes — accept the rough edge for v1 rather than
  // reordering or per-intent confirmation strings.
  const confirmation = intent.type === 'pause' || intent.type === 'resume'
    ? null  // self-evident audio cue — no spoken confirmation needed
    : 'okay.';
  if (confirmation) {
    onEvent({ type: 'token', text: confirmation, agent: agentId });
  }
  onEvent({ type: 'done', agent: agentId });
  return { handled: true };
}

/**
 * Staged-approval text intercepts:
 *   - "CONFIRM DELETION" → executePendingDelete (expenses)
 *   - "APPROVE PURGE"    → executePendingEmail (destructive email op)
 *   - "APPROVE PROVEN"   → executePendingProven (trust-state promotion)
 *   - "APPROVE WATCHER OP" → executePendingWatcherOp (cross-agent watcher op)
 *
 * These run AFTER agent setup but still BEFORE the busy-slot is acquired,
 * so they emit + persist + return without finalizeTurn. The caller is
 * responsible for clearing the pending-state flag on miss (see usage
 * sites in handleChatMessage).
 *
 * @returns {Promise<{ handled: true } | null>}
 */
export async function tryApprovalIntercept({ userText, userId, agentId, onEvent }) {
  // Every get/execute/clear below is scoped to (userId, agentId): an approval
  // phrase only matches an op staged from THIS agent's chat, and the
  // clear-on-any-miss rule only cancels THIS agent's staged ops. Typing
  // "CONFIRM DELETION" in agent B no longer executes agent A's delete (and
  // records it in B's session), and chatting with B no longer silently wipes
  // A's staged op behind its still-rendered approval card.
  //
  // The approval-card Approve button sends "<PHRASE> #<opId>" (the id minted
  // at stage time — see lib/pending-approvals.mjs). An id that no longer
  // matches the currently staged op means the card is stale: the op it
  // described was resolved, replaced, or expired. Stale clicks are refused
  // with a notice and have NO side effects — they neither execute the newer
  // op nor cancel it. Bare typed phrases (no #id) keep matching the current
  // op, exactly as before.
  //
  // appendToSession is awaited before the terminal `done` — emitting done
  // first let a reload land between the two and show an executed destructive
  // op with no record of it.
  const m = String(userText ?? '').trim().match(/^(.+?)\s*#([A-Za-z0-9_-]+)$/);
  const phrase = (m ? m[1] : String(userText ?? '').trim()).toUpperCase();
  const opId = m ? m[2] : null;

  /** @param {string} text @returns {Promise<{handled: true}>} */
  const finish = async (text) => {
    try {
      await appendToSession(`${userId}_${agentId}`,
        { role: 'user', content: userText, ts: Date.now() },
        { role: 'assistant', content: text, ts: Date.now() }
      );
    } catch (e) {
      console.warn('[approval] result persist failed:', e.message);
      await failPendingTurn(`${userId}_${agentId}`, 'Persistence failed after the approval action', { retryable: false }).catch(() => {});
      onEvent({
        type: 'error', code: 'persistence_failed', retryable: false, agent: agentId,
        message: 'The approval action finished, but its chat record could not be saved. Do not retry the approval until storage is healthy.',
      });
      return { handled: /** @type {true} */ (true) };
    }
    onEvent({ type: 'token', text, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    return { handled: /** @type {true} */ (true) };
  };

  const FAMILIES = [
    // "APPROVE WATCHER OP": staged cross-agent watcher cancel/update the
    // coordinator deferred when a specialist asked it to touch a watcher
    // owned by a different agent — see canActOnWatcher in skills/tasks.
    {
      phrase: 'CONFIRM DELETION', skillId: 'expenses',
      toolName: pending => ({
        expense_delete: 'expense_delete',
        expense_delete_batch: 'expense_delete_batch',
        expense_delete_all: 'expense_delete_all',
      })[pending?.name] ?? null,
      get: getPendingDelete, clear: clearPendingDelete, run: executePendingDelete,
    },
    {
      phrase: 'APPROVE PURGE', skillId: 'email',
      toolName: pending => ({
        email_purge_sender: 'email_purge_sender',
        email_batch_trash: 'email_batch_trash',
      })[pending?.name] ?? null,
      get: getPendingEmail, clear: clearPendingEmail, run: executePendingEmail,
    },
    {
      phrase: 'APPROVE PROVEN', skillId: 'profiles',
      toolName: () => 'profile_set_trust_state',
      get: getPendingProven, clear: clearPendingProven, run: executePendingProven,
    },
    {
      phrase: 'APPROVE WATCHER OP', skillId: 'tasks',
      toolName: pending => ({ cancel: 'cancel_watch', update: 'update_watch' })[pending?.action] ?? null,
      get: getPendingWatcherOp, clear: clearPendingWatcherOp, run: executePendingWatcherOp,
    },
  ];

  // Approval-card Cancel buttons use a targeted phrase rather than the old
  // generic "cancel" message. Match the exact staged operation id so a stale
  // card cannot cancel a newer operation of the same family. Bare phrases and
  // ordinary-message miss-clear behavior remain unchanged below for legacy
  // clients and keyboard users.
  if (phrase === 'CANCEL APPROVAL' && opId) {
    // Compare-and-remove happens atomically inside the store lock. Iterating
    // families is safe because opIds are globally unique; a concurrent re-stage
    // cannot make this stale card clear the replacement.
    const cancelled = FAMILIES.some(f => f.clear(userId, agentId, opId) === true);
    return cancelled
      ? finish('Cancelled that pending approval. Nothing was executed.')
      : finish('That approval is no longer pending — it was already resolved, cancelled, expired, or replaced. Nothing was executed.');
  }

  const matched = FAMILIES.find(f => f.phrase === phrase);
  if (matched) {
    const pending = matched.get(userId, agentId);
    if (opId && !pending) {
      return finish('That approval is no longer pending — it was already resolved, cancelled, or expired. Nothing was executed.');
    }
    if (opId && pending?.opId !== opId) {
      return finish('⚠️ That approval card is stale — a newer operation of the same type is now pending in this chat. Nothing was executed and the newer operation is still staged; review its approval card before confirming.');
    }
    if (pending) {
      // Revalidate immediately before handing control to the side-effecting
      // executor. A staged approval is not a durable capability grant: if the
      // skill/tool was revoked after staging, compare-and-clear this exact op
      // and refuse it. Never clear a concurrently staged replacement.
      const toolName = matched.toolName(pending);
      const authorized = await isPendingApprovalAuthorized(userId, matched.skillId, toolName);
      if (!authorized) {
        const cleared = matched.clear(userId, agentId, pending.opId ?? opId);
        return finish(cleared
          ? `That approval was cancelled because "${toolName ?? 'the requested action'}" is no longer permitted for this account. Nothing was executed.`
          : 'That approval changed while its permissions were being checked. Nothing was executed; review the current approval before trying again.');
      }
      // executors return either a string or an object with optional .text
      // The expected id is validated and consumed in ONE store transaction.
      // The pre-read above exists only for a clearer stale-card message; it is
      // not relied on for safety.
      const result = /** @type {string | { text?: string }} */ (await matched.run(userId, agentId, opId));
      const text = typeof result === 'string' ? result : (result?.text ?? String(result));
      return finish(text);
    }
    // Typed phrase with nothing staged of that kind: fall through to the LLM
    // (and the miss-clear below), same as any other message.
  }

  // Miss-clear ("say anything else to cancel"): an ordinary message cancels
  // every staged op in THIS agent's chat. Note the deliberate change from the
  // old walk: a message that successfully approves one family no longer
  // clears the families staged before it — an explicit approval is not
  // "anything else".
  for (const f of FAMILIES) {
    if (f.get(userId, agentId)) f.clear(userId, agentId);
  }

  return null;
}
