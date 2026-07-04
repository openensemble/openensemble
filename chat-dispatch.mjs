// @ts-check
/**
 * chat-dispatch.mjs
 * Platform-agnostic chat handler — used by WebSocket (server.mjs) and Telegram (routes/telegram.mjs).
 *
 * Type-checked via `// @ts-check` above. JSDoc on the public surface
 * (`handleChatMessage`) is the canonical signature; everything internal
 * relies on inference plus `@type` casts at native-binding boundaries
 * (provider streams, skill manifests with dynamic shapes). To opt other
 * files in, add `// @ts-check` and run `npm run typecheck`.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { USERS_DIR } from './lib/paths.mjs';
import { appendToSession } from './sessions.mjs';
import {
  markAgentBusy, openTurn, finalizeTurn,
  isAgentBusy, waitForAgentIdle, getActiveStreams, abortChat, abortAllChats,
} from './chat-dispatch/slot-registry.mjs';
// Re-export the slot-registry surface so external importers
// (ws-handler, routes/telegram, skills/delegate, server) keep working
// without each switching to the new module path.
export {
  isAgentBusy, waitForAgentIdle, markAgentBusy, getActiveStreams,
  abortChat, abortAllChats,
} from './chat-dispatch/slot-registry.mjs';
import { tryHandleSlashCommand } from './chat-dispatch/slash-commands.mjs';
import {
  tryVoiceProposalReply,
  tryVoiceTimerIntent,
  tryVoiceControlIntent,
  tryApprovalIntercept,
  wasRecentStopIntent,
} from './chat-dispatch/voice-preprocess.mjs';
import {
  tryHaFastpath,
  tryRoutineFastpath,
  tryTriviaFastpath,
  tryCalendarFastpath,
  tryVoiceEmptyFastpath,
  tryTranscribeAttachmentFastpath,
} from './chat-dispatch/fastpaths.mjs';
import { tryLocalIntentFastpath } from './chat-dispatch/local-intent-fastpath.mjs';
import {
  runSpecialistRoute,
  buildSchedulerNote,
  runLlmTurn,
} from './chat-dispatch/llm-loop.mjs';
import {
  tryNewsPrefIntercept,
  tryRenameIntercept,
} from './chat-dispatch/profile-intercepts.mjs';
import { extractTransactions } from './skills/expenses/execute.mjs';
import { getRoleAssignments, listRoles } from './roles.mjs';
import { getDevice, getSlotAssignment } from './lib/voice-devices.mjs';
import { log } from './logger.mjs';
import { turnTraceContext, beginTurn, finishTurn, recordRouting, getTurn, setTurnAgent } from './lib/turn-trace-context.mjs';
import { getAmbientForDevice } from './routes/devices.mjs';
import { resumeAmbientOnDevice } from './lib/ambient-playback.mjs';

// Pending ambient-restore timers, keyed by deviceId. A burst of wakes seconds
// apart (e.g. a real command immediately followed by a false wake) would each
// queue a restore and fire overlapping play_ambient messages — the device then
// stacks concurrent ambient fetchers and the playback path tears down underneath
// them, leaving ambient "running" but silent (pcm_rb=0, ~3× bandwidth). Trailing-
// edge debounce: each new turn cancels the prior pending restore and re-arms one,
// so exactly ONE restore fires ~3s after the LAST interruption settles.
const _ambientRestoreTimers = new Map();
import { buildVoiceSystemAddition } from './lib/voice-context.mjs';
import {
  loadConfig, getAgentsForUser,
  getUser, getUserCoordinatorAgentId, recordActivity,
  isUserTimeBlocked,
} from './routes/_helpers.mjs';

const SERVER_CODER_TOOL_NAMES = new Set([
  'coder_list_projects',
  'coder_create_project',
  'coder_switch_project',
  'coder_delete_project',
  'coder_read_file',
  'coder_write_file',
  'coder_edit_file',
  'coder_multi_edit',
  'coder_delete_file',
  'coder_run_command',
  'coder_start_server',
  'coder_stop_server',
  'coder_server_status',
  'coder_list_files',
  'coder_search',
]);

function isDesktopToolName(name) {
  return typeof name === 'string' && name.startsWith('desktop_');
}

function explicitlyWantsServerCoderStorage(text) {
  return /\b(?:server-side|oe-hosted|openensemble-hosted|inside\s+oe|in\s+oe|oe\s+project|coder\s+project|code\s+projects|\.openensemble|server\s+workspace|server\s+project)\b/i.test(String(text || ''));
}

function explicitlyWantsLocalDesktopStorage(text) {
  return /\b(?:local(?:ly)?|my\s+(?:computer|desktop|laptop|pc|machine)|desktop\s+(?:app|folder|sandbox|coder)|local\s+(?:folder|sandbox|file|project)|openensemble\/coder|openensemble\s+coder)\b/i.test(String(text || ''));
}

/**
 * Keep the conversation going after a fast-path reply. runLlmTurn's finally
 * owns the conversation-mode re-arm for LLM turns ("EVERY completed reply"),
 * but fast-paths return from the interceptor chain before reaching it — so an
 * instant answer silently ended the conversation (field: calendar fast-path
 * answered in ~1s and the device stopped listening). Mirrors llm-loop's call
 * exactly: armFollowupAfterDrain waits for the TTS streamer to drain, so the
 * window opens when the device finishes speaking, never on an aborted turn.
 *
 * Deliberately NOT armed for: control intents (stop / volume / "goodbye" —
 * conversation_end must end the conversation), the empty-transcript guard
 * (TV noise → empty STT → re-arm would ping-pong with the room), routines
 * (ambient/cross-device semantics own their audio flow), and approval/slash
 * intercepts. Dynamic import: chat-dispatch ↔ ws-handler already cycle via
 * llm-loop, but keeping this one lazy avoids tightening the module graph.
 */
async function armConversationFollowup({ source, deviceId, conversationMode, ac = null }) {
  if (source !== 'voice-device' || !deviceId || !conversationMode) return;
  if (ac?.signal?.aborted) return;
  try {
    const { armFollowupAfterDrain } = await import('./ws-handler.mjs');
    armFollowupAfterDrain(deviceId, { windowMs: 8000, conversation: true });
  } catch (e) {
    console.warn('[chat] fast-path conversation re-arm failed:', e.message);
  }
}

function appendSystemStable(agent, note) {
  if (!note) return agent;
  if (agent._promptTiers) {
    const stable = [agent._promptTiers.stable, note].filter(Boolean).join('\n\n');
    const next = {
      ...agent,
      _promptTiers: { ...agent._promptTiers, stable },
    };
    next.systemPrompt = [next._promptTiers.stable, next._promptTiers.context, next._promptTiers.volatile].filter(Boolean).join('\n\n');
    return next;
  }
  return { ...agent, systemPrompt: [agent.systemPrompt, note].filter(Boolean).join('\n\n') };
}

/**
 * Handle an incoming chat message from any transport.
 *
 * @param {object} opts
 * @param {string} opts.userId        - OpenEnsemble user ID
 * @param {string} [opts.agentId]     - Target agent ID (defaults to coordinator)
 * @param {string} [opts.text]        - User message text
 * @param {object} [opts.attachment]  - File attachment object
 * @param {function} opts.onEvent     - Callback(event) for all chat events
 * @param {function} [opts.onBroadcast] - Called when agent list may have changed (e.g. rename)
 * @param {function} [opts.onNotify]  - Called for __notify cross-user events
 */
// Slim tool subset used when source === 'voice-device'. The voice-device
// firmware (XVF3800 + ESP32-S3) chats over WS and waits synchronously for
// the agent reply — with the full ~80-tool web role catalog and gpt-5.5,
// a "what time is it" round-trip takes 60+ seconds because the model
// reasons through every tool. Voice queries are short and shouldn't need
// the full surface, so we clamp to a minimal allowlist: web search, memory
// recall, agent delegation, basic notes.
//
// LONGER-TERM REPLACEMENT (see project_smart_tool_selection memory):
// run the Cortex plan classifier on rawText, map intent → tool subset, and
// drop this hardcoded allowlist. Until then, voice-device chats use this
// to stay snappy.
const VOICE_DEVICE_TOOL_ALLOWLIST = new Set([
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_save',
  'ask_agent',
  // Scheduler family — actual tool names per skills/tasks/manifest.json.
  // The previous entry "create_task" was wrong (no such tool exists), which
  // is why the coordinator told users "the alarm tool isn't available to me
  // in this turn" on voice-device requests like "set an alarm for 11:22 AM".
  'set_reminder',
  'set_alarm',
  'schedule_task',
  'list_tasks',
  'list_reminders',
  'delete_task',
  'cancel_reminder',
  'ha_list_devices',
  'ha_get_state',
  'ha_call_service',
  'ha_list_areas',
  'ha_list_services',
  // Calendar READS — "what's on my calendar" is a top voice query, and
  // without these the router leaves only web_search+ask_agent, forcing a
  // pointless delegation detour through whichever agent holds the calendar
  // role (field: the coordinator asked the specialist to read a calendar she could have read
  // herself). Writes stay off voice deliberately.
  'gcal_list',
  'gcal_list_calendars',
  // One-call mirror read for fuzzy calendar questions the fast-path can't
  // answer ("when am I free 2h next week") — replaces the 7-call gcal loop.
  'calendar_snapshot',
  // "When I say X, run skill Y" — users teach fast-path trigger phrases by
  // voice as naturally as by chat.
  'teach_fastpath_phrase',
  'forget_fastpath_phrase',
  // Voice routines — let users bind/edit/delete routines by speaking
  // ("<wake-word>, when I say goodnight, turn off the lights and play
  // thunderstorm sounds"). Fast-path executes matched routines pre-LLM;
  // these tools are the AUTHORING path that lands on the same store.
  'create_routine',
  'list_routines',
  'delete_routine',
  'list_ambient_files',
]);

/**
 * Tools that voice turns are allowed to use = the hardcoded built-ins above
 * UNION every tool belonging to a skill the user has that declares
 * `"voice_device": true` in its manifest. This lets the skill-builder opt a
 * skill into voice-device control (e.g. youtube-music-controller) without
 * editing this file — the manifest flag IS the registration. Per-user because
 * custom skills are user-scoped; computed per turn (cheap — listRoles reads an
 * in-memory registry).
 */
function voiceToolAllowlistFor(userId) {
  const allow = new Set(VOICE_DEVICE_TOOL_ALLOWLIST);
  for (const m of listRoles(userId)) {
    if (m?.voice_device !== true || !Array.isArray(m.tools)) continue;
    for (const t of m.tools) {
      const name = t?.function?.name || t?.name;
      if (name) allow.add(name);
    }
  }
  return allow;
}

function normalizeToolPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const mode = plan.mode === 'none' ? 'none' : plan.mode === 'selected' ? 'selected' : 'auto';
  if (mode === 'auto') return null;
  const selectedTools = Array.isArray(plan.selectedTools)
    ? [...new Set(plan.selectedTools
        .filter(t => typeof t === 'string')
        .map(t => t.trim())
        .filter(t => /^[A-Za-z0-9_.:-]{1,120}$/.test(t)))]
    : [];
  if (mode === 'selected' && !selectedTools.length) return null;
  return {
    mode,
    selectedTools,
    source: typeof plan.source === 'string' ? plan.source.slice(0, 40) : null,
    phrase: typeof plan.phrase === 'string' ? plan.phrase.slice(0, 240) : null,
  };
}

/**
 * Platform-agnostic chat entrypoint. WS (server.mjs) and Telegram
 * (routes/telegram.mjs) both call this with a small adapter for their
 * own event surface — onEvent for token/done/error pushes, onBroadcast
 * for "agent list changed" fan-out, onNotify for toasts.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.agentId
 * @param {string} opts.text
 * @param {object|null} [opts.attachment]
 * @param {{mode?: string, selectedTools?: string[], source?: string, phrase?: string}|null} [opts.toolPlan]
 * @param {'voice-device'|'web'|'telegram'|'desktop-app'|null} [opts.source]
 * @param {string|null} [opts.deviceId]              voice-device id if applicable
 * @param {number|null} [opts.wakeSlot]              voice-device slot index (0–5)
 * @param {boolean} [opts.conversationMode]          voice-device conversation mode (re-arm follow-up windows after every reply)
 * @param {boolean} [opts.bargeIn]                   voice-device speech-barge turn (transcript may carry reply-bleed prefix)
 * @param {boolean} [opts.recentReplyStop]           a reply was just stopped — stop intents spare the ambient/AirPlay bed
 * @param {(ev: {type: string, [k: string]: any}) => void} opts.onEvent
 * @param {() => void} [opts.onBroadcast]
 * @param {(fromUserId: string, agentId: string, notify: object) => void} [opts.onNotify]
 * @param {boolean} [opts._isRoutineFollowup]        internal recursion guard
 * @param {boolean} [opts._hiddenUser]               internal turn; persist user prompt hidden from UI
 * @param {boolean} [opts._isBackgroundContinuation] internal guard for completed background-task wakeups
 * @param {boolean} [opts._isolatedTaskRun]          internal scheduled/background task turn with no chat history
 * @returns {Promise<void>}
 */
export async function handleChatMessage({
  userId,
  agentId: rawAgentId,
  text: rawText,
  attachment: rawAttachment,
  toolPlan: rawToolPlan = null,
  source = null,
  deviceId = null,
  wakeSlot = null,
  // Device-level conversation mode (voice devices): after each spoken reply
  // the server re-arms a follow-up listen window unconditionally, so the
  // exchange continues without repeated wake words. Resolved by ws-handler
  // from the device record and threaded to runLlmTurn's follow-up emitter.
  conversationMode = false,
  // True when the utterance interrupted the device's own reply (speech barge,
  // fw ≥ 0.2.66). The transcript may be prefixed with reply bleed, so the
  // control-intent matcher relaxes its bare-word anchors for this turn.
  bargeIn = false,
  // True when this utterance arrived as/just after a reply was stopped — a
  // "stop" intent then targets the reply and SPARES the ambient/AirPlay bed.
  recentReplyStop = false,
  onEvent,
  onBroadcast = () => {},
  onNotify    = () => {},
  _isRoutineFollowup = false,
  _hiddenUser = false,
  _isBackgroundContinuation = false,
  _isolatedTaskRun = false,
}) {
  // Wake-slot routing — household-shared voice device.
  //
  // When a voice device fires a wake word, the slot index identifies which
  // *user* the resulting chat belongs to. slot 0 might be the admin saying
  // "Hey Ensemble" → admin's coordinator; slot 1 might be a roommate saying
  // "Computer" → roommate's coordinator. Per-user data isolation comes
  // for free because every downstream call (memory, sessions, agents,
  // persist) is keyed off `userId`, so swapping it here is enough.
  //
  // Security: the assignment is set by the device-owner (admin) and lives
  // in their voice-devices.json. ownerUserId in the assignment can be any
  // user on this OE install. Trust model: same-install household admin.
  //
  // Fallback: when the slot is unassigned, run as the WS-authed user (the
  // device's pairing user) and use the message's agent field.
  let effectiveUserId = userId;
  let agentId = rawAgentId ?? null;
  if (deviceId && Number.isInteger(wakeSlot)) {
    const assignment = getSlotAssignment(userId, deviceId, wakeSlot);
    if (assignment) {
      effectiveUserId = assignment.ownerUserId;
      agentId = assignment.agentId ?? null;
      console.log(`[chat] voice-device slot=${wakeSlot} device=${deviceId} auth_user=${userId} acting_as=${effectiveUserId} agent=${agentId ?? '(coordinator)'}`);
    }
  }
  if (!agentId && deviceId && effectiveUserId === userId) {
    const deviceDefault = getDevice(userId, deviceId)?.default_agent_id ?? null;
    if (deviceDefault) agentId = deviceDefault;
  }
  userId = effectiveUserId;
  agentId = agentId ?? getUserCoordinatorAgentId(userId);

  const toolPlan = normalizeToolPlan(rawToolPlan);

  // Turn trace (correlation spine). One record per top-level turn; nested
  // streamChat runs (specialist-router, ask_agent delegation) inherit this store
  // via ALS and push their own spans. Wrapped in turnTraceContext.run() — NOT
  // bare enterWith — so the store is scoped to THIS turn and restored after: on a
  // long-lived WS connection enterWith leaks the store into the next message,
  // which chained unrelated turns under one rootId (depth climbing 0,1,2…). run()
  // also lets a routine-followup re-entry (await handleChatMessage below) nest as
  // a child turn and unwind without corrupting this one. beginTurn/recorders
  // fail-open, so nothing here can break a turn.
  return turnTraceContext.run(undefined, async () => {
  beginTurn({ userId, agentId, source: source ?? 'web' });
  recordRouting({ toolPlan: toolPlan?.mode || 'auto' });

  // Snapshot ambient state for voice-device turns. The firmware kills any
  // playing ambient when a wake fires (s_ambient_stop in main.c — barge-in
  // behavior). If this turn doesn't deliberately start a new ambient or
  // stop the existing one, the user is left in silence even though the
  // ambient stream is still cached server-side. The finally below re-emits
  // play_ambient after a short delay to restore the experience.
  const _ambientAtStart = (source === 'voice-device' && deviceId)
    ? (getAmbientForDevice(deviceId)?.marker || null)
    : null;

  // Snapshot the upload (file_id + display name) BEFORE the interceptor
  // chain mutates ctx.attachment. financePreprocess clears it; transcribe
  // fast-path consumes it; the file itself stays on disk regardless. After
  // the turn lands, ask the user whether to keep or discard it (see the
  // attachment_decision emit in the finally block below).
  const _attachmentForDecision = (rawAttachment?.file_id && source !== 'voice-device' && !_isRoutineFollowup)
    ? { file_id: rawAttachment.file_id, name: rawAttachment.name, mimeType: rawAttachment.mimeType }
    : null;

  // Hoisted above the outer try so the finally can always release the agent's
  // busy-slot. finalizeTurnOnce() is idempotent and a no-op until busySlot is
  // assigned (markAgentBusy below), so early returns before that are safe.
  let busySlot = null;
  // This turn's AbortController. Passed to finalizeTurn so that when a barge-in
  // (a second interactive message) has already replaced the controller under our
  // key, our cleanup doesn't tear down the newer turn's controller/stream/buffer.
  let turnAc = null;
  let _turnFinalized = false;
  const finalizeTurnOnce = () => {
    if (_turnFinalized || !busySlot) return;
    _turnFinalized = true;
    finalizeTurn(`${userId}_${agentId}`, busySlot, turnAc);
  };

  try {

  // @-mention redirect (typed chat only): "@<agent> make me a skill" routes
  // to that agent regardless of which agent's chat panel the user is in.
  // Match handle against agent name (lowercased, whitespace stripped) or
  // the trailing segment of the agent id. Voice STT can't reliably
  // transcribe the @ symbol, so skip for voice — verbal redirects
  // ("ask <name>", "use <name>") go through router-mistakes instead.
  if (source !== 'voice-device' && typeof rawText === 'string') {
    const mention = rawText.match(/^@(\S+)\s+([\s\S]+)$/);
    if (mention) {
      const handle = mention[1].toLowerCase();
      const rest = mention[2];
      const target = getAgentsForUser(userId).find(a => {
        const nameKey = String(a.name || '').toLowerCase().replace(/\s+/g, '');
        const idSuffix = String(a.id || '').split('_').pop().toLowerCase();
        return nameKey === handle || idSuffix === handle;
      });
      if (target) {
        if (target.id !== agentId) {
          console.log(`[chat] @-mention redirect: @${handle} → ${target.id} (was ${agentId})`);
          agentId = target.id;
          recordRouting({ mode: 'redirect', redirectedTo: target.id });
          setTurnAgent(target.id);
        }
        // Strip the @-handle whether or not the agent changed — it's a
        // routing directive, not part of the conversation content. Without
        // this, a client that pre-switched agents would persist
        // "@<name> foo" verbatim into the destination session.
        rawText = rest;
      }
    }
  }

  // @-file references handled inside the transcribe fast-path (see
  // tryTranscribeAttachmentFastpath in chat-dispatch/fastpaths.mjs). That
  // fast-path now also covers the "@video/foo transcribe this" case in
  // addition to the bare-attachment case, AND falls through to the LLM
  // when no STT backend is configured (after injecting the resolved paths
  // as a system note). Centralizing both flows there keeps STT-availability
  // and intent-matching in one place.

  // Voice-device pre-LLM detectors — yes/no on a pending proposal, timer
  // create/cancel/extend, and the volume / pause / stop control regex.
  // Each returns {handled} on match; we just return.
  //
  // Per-interceptor trace lines for voice-device turns so silent fall-throughs
  // are visible — without these, a missed regex (e.g. "Volume 70" not matching
  // the volume_set pattern) just goes straight to LLM dispatch with no
  // breadcrumb showing which interceptor passed it on.
  const _vTrace = source === 'voice-device';
  if (await tryVoiceProposalReply({ source, deviceId, rawText, agentId, onEvent })) {
    if (_vTrace) console.log(`[voice-trace] proposal-reply: HANDLED device=${deviceId} text="${(rawText || '').slice(0, 60)}"`);
    return;
  }
  if (_vTrace) console.log(`[voice-trace] proposal-reply: miss device=${deviceId}`);
  if (await tryVoiceTimerIntent({ source, deviceId, rawText, userId, agentId, onEvent })) {
    if (_vTrace) console.log(`[voice-trace] timer-intent: HANDLED device=${deviceId} text="${(rawText || '').slice(0, 60)}"`);
    // "Set a timer for ten minutes" mid-conversation is an answer, not an
    // exit — keep listening like any other completed reply.
    await armConversationFollowup({ source, deviceId, conversationMode });
    return;
  }
  if (_vTrace) console.log(`[voice-trace] timer-intent: miss device=${deviceId}`);
  if (tryVoiceControlIntent({ source, rawText, deviceId, userId, agentId, onEvent, conversationMode, bargeIn, recentReplyStop })) {
    if (_vTrace) console.log(`[voice-trace] control-intent: HANDLED device=${deviceId} text="${(rawText || '').slice(0, 60)}"`);
    return;
  }
  if (_vTrace) console.log(`[voice-trace] control-intent: miss device=${deviceId} text="${(rawText || '').slice(0, 60)}" — falling through to LLM`);

  const chatUser = getUser(userId);
  const isChild = chatUser?.role === 'child';

  // Honor accessSchedule on every incoming message — a session opened during
  // allowed hours cannot keep chatting past curfew.
  if (isUserTimeBlocked(userId)) {
    onEvent({ type: 'error', message: 'Access is restricted at this time. Please try again later.', agent: agentId ?? 'system' });
    return;
  }

  // Strict: the target agent must be in the caller's roster. No global-registry
  // fallback — that path let any authed user chat with another user's agents so
  // long as the model passed their allowedModels gate, consuming the agent
  // owner's API credits. getAgentsForUser is the canonical visibility list.
  let agent = getAgentsForUser(userId).find(a => a.id === agentId);
  if (!agent) {
    onEvent({ type: 'error', message: `Unknown agent: ${agentId}`, agent: agentId });
    return;
  }

  // Voice-device source → slim tool subset. Reasoning effort kept at the
  // agent default (typically 'high' for gpt-5.x — required for reliable
  // custom tool calling). The tool reduction alone trimmed a "what time
  // is it" round-trip from 61 s to ~3 s on the coordinator; dropping reasoning
  // to low was tested but caused the model to skip useful tool calls.
  if (source === 'voice-device' && Array.isArray(agent.tools) && agent.tools.length) {
    const originalCount = agent.tools.length;
    const voiceAllow = voiceToolAllowlistFor(userId);
    const slim = agent.tools.filter(t => voiceAllow.has(t.function?.name));
    agent = { ...agent, tools: slim };
    console.log(`[chat] voice-device source: tools ${originalCount} → ${slim.length}`);
  }

  if (
    agent.skillCategory === 'coder' &&
    Array.isArray(agent.tools) &&
    agent.tools.some(t => t.function?.name === 'desktop_write_file')
  ) {
    if (source === 'desktop-app' && !explicitlyWantsServerCoderStorage(rawText)) {
      const originalCount = agent.tools.length;
      const desktopFirst = agent.tools.filter(t => {
        const name = t.function?.name;
        return !SERVER_CODER_TOOL_NAMES.has(name);
      });
      agent = appendSystemStable(
        { ...agent, tools: desktopFirst },
        '## Desktop Coder Mode\nThis turn came from the OpenEnsemble Desktop app. Server-side coder_* project tools are intentionally hidden for this turn. Use desktop_write_file or desktop_save_file in the `coder` sandbox for code files. Keep delegation available only for genuinely separate work; do not delegate simple file creation just because coder_* tools are unavailable.'
      );
      console.log(`[chat] desktop-app coder source: tools ${originalCount} → ${desktopFirst.length}; server coder storage hidden for local-output turn`);
    } else if (source !== 'desktop-app' && !explicitlyWantsLocalDesktopStorage(rawText)) {
      const originalCount = agent.tools.length;
      const serverFirst = agent.tools.filter(t => !isDesktopToolName(t.function?.name));
      agent = { ...agent, tools: serverFirst };
      console.log(`[chat] web coder source: tools ${originalCount} → ${serverFirst.length}; desktop storage hidden for server-output turn`);
    }
  }

  // Model restriction check
  if (chatUser?.allowedModels != null && agent.model && !chatUser.allowedModels.includes(agent.model)) {
    onEvent({ type: 'error', message: `Model "${agent.model}" is not available for your account. Ask your admin to grant access.`, agent: agentId });
    return;
  }

  if (!rawText?.trim() && !rawAttachment) {
    // Terminal event even for a no-op — a client showing a pending state on
    // send otherwise hangs until its own timeout.
    onEvent({ type: 'done', agent: agentId });
    return;
  }
  recordActivity(userId, agentId, { message: true });

  // Profile intercepts: news-topic preference (side-effect; pipeline continues)
  // and agent rename / re-emoji (short-circuits with a spoken confirmation).
  tryNewsPrefIntercept({ rawText, userId, onEvent });
  if (tryRenameIntercept({ rawText, userId, agentId, agent, onEvent, onBroadcast })) return;

  const scopedSessionKey = `${userId}_${agentId}`;
  // Register this WS run so concurrent delegate calls queue behind it.
  // Key matches the scopedAgent.id used in streamChat (userId-scoped).
  busySlot = markAgentBusy(scopedSessionKey);
  // Background-task continuations queue behind any in-flight turn so they can't
  // clobber each other or an active user turn. Interactive turns keep the
  // openTurn() barge-in semantics: a new user message interrupts the prior
  // stream rather than waiting for it.
  if (_isBackgroundContinuation) await busySlot.waitTurn();
  const ac = openTurn(scopedSessionKey, userId, agentId);
  turnAc = ac;

  const scopedAgent = { ...agent, id: `${userId}_${agentId}` };
  {
    const now = new Date();
    const todayStr   = now.toISOString().slice(0, 10);
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const yearStart  = `${now.getFullYear()}-01-01`;
    const dateBlock  = `## Current Date\nToday: ${todayStr}\nThis month: ${monthStart} to ${todayStr}\nThis year: ${yearStart} to ${todayStr}`;
    const financeExtra = agent.skillCategory === 'finance'
      ? `\nUser ID: ${userId ?? 'default'}\nAlways pass this exact User ID to every expense tool call.`
      : '';
    // Voice-device chats: inject formatting + follow-up-listening rules.
    // Centralised in lib/voice-context.mjs so the specialist-router path
    // (chat-dispatch/llm-loop.mjs) gets the identical block.
    const voiceExtra = buildVoiceSystemAddition(source);
    // Three-tier wiring for prompt caching:
    //   - finance / voice modifiers don't change per turn for a given
    //     (agent, source) pair → stay in the stable tier.
    //   - date changes daily → goes in volatile so cache doesn't bust at
    //     midnight (or every turn if pre-volatile got rebuilt fresh).
    // Other per-turn notes (scheduler, resolved hints, attachment) get
    // appended to volatile later by chat.mjs.
    if (scopedAgent._promptTiers) {
      scopedAgent._promptTiers = {
        ...scopedAgent._promptTiers,
        stable: [scopedAgent._promptTiers.stable, financeExtra && financeExtra.trim(), voiceExtra && voiceExtra.trim()].filter(Boolean).join('\n\n'),
        // Seed volatile with the date block — chat.mjs will append further
        // per-turn additions onto this string.
        volatile: dateBlock,
      };
      // Rebuild the legacy flat systemPrompt to match what providers that
      // don't read tiers expect.
      scopedAgent.systemPrompt = [scopedAgent._promptTiers.stable, scopedAgent._promptTiers.context, scopedAgent._promptTiers.volatile].filter(Boolean).join('\n\n');
    } else {
      // Old-shape agent (no tier metadata) — preserve original behavior.
      scopedAgent.systemPrompt = `${agent.systemPrompt}\n\n${dateBlock}${financeExtra}${voiceExtra}`;
    }
  }

  // Shared interceptor context. Mutable: financePreprocess rewrites
  // ctx.userText / ctx.attachment in place when the user uploads a finance
  // file, so every subsequent interceptor (and the LLM turn below) sees
  // the augmented text.
  const ctx = {
    userId, agentId, agent, source, deviceId, ac,
    userText: rawText?.trim() ?? '',
    attachment: rawAttachment ?? null,
    toolPlan,
    _isRoutineFollowup,
    onEvent, onBroadcast, onNotify,
  };

  // Phase-6 router-as-learner: explicit redirects ("@<name>", "use coder",
  // "ask <name>") in the incoming user message are logged against the
  // previous turn's pickedAgent so we can propose a routing override after
  // threshold. Fire-and-forget — detection never blocks dispatch.
  if (ctx.userText && !_isBackgroundContinuation) {
    import('./lib/router-mistakes.mjs').then(m =>
      m.detectAndLog({ userId, currentAgentId: agentId, userText: ctx.userText })
    ).catch(e => console.warn('[router-mistakes] hook failed:', e.message));
  }

  // Interceptor chain. Each handler returns:
  //   - { handled: true, ... }  → emit/persist already done; dispatcher
  //     calls finalizeTurn() and returns to the caller. Routine may also
  //     set `followupPrompt` (run_prompt action) to ask the dispatcher to
  //     re-enter handleChatMessage with that prompt as the new user message.
  //   - null                    → continue to the next handler. May mutate
  //     ctx (financePreprocess does this) without short-circuiting.
  //
  // Ordering matters: approval+slash run on the RAW userText (so
  // "CONFIRM DELETION" matches verbatim), finance augments userText for the
  // LLM, then the natural-language fast-paths and the specialist router get
  // their crack. Anything not handled falls through to runLlmTurn.
  const planConstrained = toolPlan?.mode === 'selected' || toolPlan?.mode === 'none';
  const allowIntentFastpaths = !planConstrained && !_isBackgroundContinuation;
  // Answer-type fast-paths whose handled reply should keep a conversation-mode
  // exchange open (see armConversationFollowup). Everything else in the chain
  // ends or owns its own flow.
  const CONVERSATION_REARM_FASTPATHS = new Set([
    tryHaFastpath, tryTriviaFastpath, tryCalendarFastpath, tryLocalIntentFastpath,
  ]);
  const INTERCEPTORS = [
    // Voice-only: catch empty / 1-char STT transcripts before they reach the
    // LLM and cause the device to hang in THINKING. Must run before every
    // other interceptor because the others assume a non-empty userText.
    tryVoiceEmptyFastpath,
    // Audio/video attachment + "transcribe this" (or bare attachment) goes
    // straight to STT — no LLM round-trip needed. Falls through to the
    // coordinator when the user's text suggests something else (e.g. "what's
    // the duration", "extract the chords") so the LLM can pick the right tool.
    tryTranscribeAttachmentFastpath,
    // Staged-approval intercepts act on — and on any miss, CLEAR — pending
    // destructive ops, so only a real user turn may run them. A background
    // continuation or hidden internal turn arriving between "stage" and the
    // user's APPROVE used to wipe the staged op before they could confirm.
    ...((_isBackgroundContinuation || _hiddenUser) ? [] : [tryApprovalIntercept]),
    slashAdapter,
    financePreprocess,
    ...(allowIntentFastpaths ? [tryHaFastpath, tryRoutineFastpath, tryTriviaFastpath, tryCalendarFastpath] : []),
    // Skill-agnostic local cognition tier (dispatch face). Runs after the
    // bespoke fast-paths and before the embedding specialist router, so a
    // confident local-intent match never escalates to the cloud coordinator.
    // Inert unless cfg.localTier.enabled (kill switch). Falls through on miss.
    ...(allowIntentFastpaths ? [tryLocalIntentFastpath] : []),
    ...(_isBackgroundContinuation ? [] : [c => runSpecialistRoute({ ...c, attachment: c.attachment, conversationMode })]),
  ];

  for (const handler of INTERCEPTORS) {
    const r = await handler(ctx);
    if (!r?.handled) continue;
    // Tag routing for the trace. The specialist router sets its own mode
    // ('specialist'); for the named fast-paths record which one handled it.
    if (!getTurn()?.routing?.mode) {
      // A named fast-path handled the turn → the coordinator's LLM/cloud call
      // was avoided entirely. Tag the local win so turn-metrics can count it
      // (specialist routing sets its own mode above, so it never lands here).
      recordRouting({ mode: 'fastpath', fastPath: handler.name || null, localHandler: handler.name || null, llmAvoided: true, cloudCall: false });
    }
    finalizeTurnOnce();
    // followupPrompt re-enters handleChatMessage and runs an LLM turn, whose
    // own finally re-arms — arming here too would double-send the window.
    if (!r.followupPrompt && CONVERSATION_REARM_FASTPATHS.has(handler)) {
      await armConversationFollowup({ source, deviceId, conversationMode, ac });
    }
    if (r.followupPrompt) {
      // Routine's run_prompt action: the trigger phrase set the scene (lights
      // dimmed, sound playing), the followup is what the user actually wants
      // the LLM to answer. _isRoutineFollowup is a defensive bypass so the
      // followup can't itself match a routine trigger and recurse. Target
      // device may differ — push the LLM reply to the room where the routine
      // is playing rather than the originating mic.
      await handleChatMessage({
        userId, agentId, text: r.followupPrompt,
        attachment: null, source, deviceId: r.targetDeviceId, wakeSlot,
        onEvent, onBroadcast, onNotify,
        _isRoutineFollowup: true,
      });
    }
    return;
  }

  // ── Default handler: LLM turn ───────────────────────────────────────────
  // schedulerNote prepends current_time + (optional) scheduler-intent outcome
  // as a system note so the agent can narrate success/failure in its reply.
  // runLlmTurn owns the streamChat + provider failover + voice-device
  // follow-up listening window. It never throws; finalizeTurn cleans up the
  // busy-slot / abort-controller / active-stream registry afterwards.
  // Autonomous turns (scheduled run, barrier reaction, background continuation)
  // must NOT run the scheduler-intent interceptor — it calls addTask directly,
  // so a scheduled briefing whose reaction prompt echoes "daily ... briefing"
  // would spawn a duplicate of itself. A task must never create a task.
  const _schedulerNotePromise = buildSchedulerNote({
    userId, agentId, userText: ctx.userText,
    skipIntercept: _isBackgroundContinuation || _isolatedTaskRun,
  });

  // Pre-LLM alias learning: if the previous turn ended with a "did you mean X?"
  // and this turn is a short affirmation ("yes"), consume the pending
  // clarification and persist the alias before we run the next turn. Runs
  // BEFORE the resolver so the next call already benefits from the new alias.
  //
  // Context resolvers — skill-aliases, agent-aliases, etc. Each scans the
  // user's text for entity references (e.g. "the youtube downloader skill",
  // "ask <agent>"), resolves to a concrete id via stored aliases + catalog
  // fallback, and contributes a one-line system note so the LLM can call
  // the right tool without enumerating. First-time fallback hits auto-save
  // as new aliases. See lib/context-resolvers.mjs to add new entity types.
  //
  // The affirmation→hints chain must stay ordered, but it touches only alias
  // stores while buildSchedulerNote touches only scheduler state — so the two
  // run concurrently to cut serial pre-LLM latency.
  const _hintsPromise = (async () => {
    try {
      const { maybeConsumeAffirmation } = await import('./lib/alias-learner.mjs');
      await maybeConsumeAffirmation(userId, ctx.userText);
    } catch (e) { console.warn('[chat-dispatch] consume-affirmation failed:', e.message); }
    try {
      const { buildContextHints } = await import('./lib/context-resolvers.mjs');
      return (await buildContextHints(userId, ctx.userText)).hints || '';
    } catch (e) {
      console.warn('[chat-dispatch] context-resolvers failed:', e.message);
      return '';
    }
  })();
  const schedulerNote = await _schedulerNotePromise;
  let resolvedNote = schedulerNote;
  const _hints = await _hintsPromise;
  if (_hints) resolvedNote = resolvedNote ? `${resolvedNote}\n${_hints}` : _hints;
  // Capture the assistant's final reply so the learner can scan it for
  // "did you mean X?" patterns and stash a pending clarification.
  let finalAssistantText = '';
  const wrappedOnEvent = (ev) => {
    if (ev?.type === 'token' && typeof ev.text === 'string') finalAssistantText += ev.text;
    if (typeof onEvent === 'function') return onEvent(ev);
  };
  // 'direct' = the addressed agent ran its own LLM turn (no fast-path, no
  // specialist reroute, no @-redirect). Applies to ANY agent the user is
  // chatting with — coordinator or specialist — so it must NOT be labelled
  // 'coordinator' (that wrongly implied the agent's role in the trace).
  recordRouting({ mode: 'direct', llmAvoided: false });
  try {
    await runLlmTurn({
      userId, agentId, scopedAgent, scopedSessionKey,
      userText: ctx.userText, attachment: ctx.attachment,
      toolPlan: ctx.toolPlan,
      schedulerNote: resolvedNote, source, deviceId,
      conversationMode,
      ac, onEvent: wrappedOnEvent, onNotify,
      hiddenUser: _hiddenUser,
      isolatedTaskRun: _isolatedTaskRun,
    });
  } finally {
    finalizeTurnOnce();
  }

  // Post-turn alias learning — fire-and-forget, never blocks return.
  //   Path A: if the LLM called ask_agent or any skill-owned tool and the
  //           user message had a name-like phrase that didn't pre-resolve,
  //           learn the new alias.
  //   Path B: if the LLM's reply asked "did you mean X?", stash a pending
  //           clarification keyed by userId. The next turn's affirmation
  //           check (above) consumes it.
  (async () => {
    try {
      const learner = await import('./lib/alias-learner.mjs');
      await learner.observeTurnAndLearn(userId, ctx.userText, scopedSessionKey);
      if (finalAssistantText) {
        await learner.maybeStashClarification(userId, ctx.userText, finalAssistantText);
      }
      // Phase-3 local-tier learning: reaching this block means every interceptor
      // (incl. the local fastpath) missed. If the LLM then called a localIntent
      // tool, the utterance was a miss the tier should learn. Gated internally by
      // localTier.learning; fully self-guarded; never throws into this IIFE.
      const il = await import('./lib/intent-learner.mjs');
      await il.captureFromTurn({ userId, agentId, userText: ctx.userText, scopedSessionKey });
    } catch (e) { console.warn('[chat-dispatch] post-turn learn failed:', e.message); }
  })();

  } finally {
    // Always release the agent's busy-slot — even if an interceptor above threw
    // before the normal finalize ran. Idempotent; a no-op if the turn already
    // finalized. Without this, an interceptor exception would leave the slot
    // held forever and deadlock the next turn (continuations await the prior).
    finalizeTurnOnce();

    // Flush the turn trace — one greppable `tag:"turn"` record carrying every
    // span (incl. delegated sub-agents) + the delegation chain + routing. Wrapped
    // so a trace bug can never break the turn.
    try {
      const trace = finishTurn();
      if (trace) log.info('turn', 'summary', trace);
    } catch { /* never throw from the finalizer */ }

    // Post-turn attachment save/discard prompt. Chat-upload always persists
    // to users/<id>/profile-files/{images,videos,audio,documents}/ — the
    // ✕ on the preview pill clears client state but not the on-disk file.
    // Ask the user once the turn lands whether to keep or discard, so casual
    // "ask about this image" uploads don't silently accumulate. Skipped for
    // voice-device (no screen) and routine follow-ups (the original turn
    // already showed the prompt).
    if (_attachmentForDecision) {
      try {
        const decisionId = 'att_' + randomBytes(6).toString('hex');
        const ts = Date.now();
        const entry = {
          role: 'attachment_decision',
          decisionId,
          file_id: _attachmentForDecision.file_id,
          name: _attachmentForDecision.name,
          mimeType: _attachmentForDecision.mimeType,
          ts,
        };
        appendToSession(`${userId}_${agentId}`, entry);
        onEvent({
          type: 'attachment_decision',
          decisionId,
          agent: agentId,
          file_id: _attachmentForDecision.file_id,
          name: _attachmentForDecision.name,
          mimeType: _attachmentForDecision.mimeType,
          ts,
        });
      } catch (e) {
        console.warn('[chat-dispatch] attachment_decision emit failed:', e.message);
      }
    }

    // Ambient auto-restore backstop: current firmware pauses/resumes ambient
    // locally around a wake turn. Keep this server-side marker check only as
    // a recovery nudge for older or wedged devices; the same-marker send is
    // intentionally conservative and must never resurrect an ambient session
    // the user stopped or a routine replaced.
    if (_ambientAtStart && deviceId) {
      // Trailing-edge debounce (see _ambientRestoreTimers): cancel any restore
      // already queued for this device so back-to-back wakes coalesce into a
      // single restore instead of stacking overlapping play_ambient sends.
      const prevTimer = _ambientRestoreTimers.get(deviceId);
      if (prevTimer) clearTimeout(prevTimer);
      const restoreTimer = setTimeout(async () => {
        _ambientRestoreTimers.delete(deviceId);
        try {
          // If the user said "stop" in the last 15s — even on a different
          // (later) turn — don't resurrect ambient. Without this guard, a
          // burst of TV-driven wakes can queue several restore timers; the
          // stop that finally lands silences ambient, then the queued
          // timers fire and bring it back. Pair to the markStopIntent call
          // in voice-preprocess executeVoiceIntent('stop').
          if (wasRecentStopIntent(deviceId)) {
            console.log(`[chat-dispatch] ambient auto-restore SUPPRESSED on ${deviceId} (recent stop intent)`);
            return;
          }
          const now = getAmbientForDevice(deviceId);
          if (now?.marker === _ambientAtStart && now.meta) {
            // Reuse the existing marker so the device's new HTTP request
            // reattaches to the warm ffmpeg in the server's grace window
            // (config.mjs _ambientStreams). Eliminates the cold-restart
            // decode errors that minted-a-fresh-marker would produce.
            await resumeAmbientOnDevice({
              deviceId,
              marker: now.marker,
              loop: now.meta.loop,
            });
            console.log(`[chat-dispatch] auto-restored ambient on ${deviceId} after wake (file=${now.meta.file}, marker reused)`);
          }
        } catch (e) {
          console.warn('[chat-dispatch] ambient auto-restore failed:', e.message);
        }
      }, 3000);
      _ambientRestoreTimers.set(deviceId, restoreTimer);
    }
  }
  });
}

// ── Interceptor adapters ──────────────────────────────────────────────────────

/**
 * Slash command adapter. tryHandleSlashCommand is a pure transform that
 * returns `{handled, reply}` — this adapter does the emit + session
 * persistence so the chain sees a uniform `{handled}` return.
 */
async function slashAdapter({ userText, userId, agentId, agent, onEvent }) {
  const r = await tryHandleSlashCommand({ userText, userId, agentId, agent });
  if (!r) return null;
  appendToSession(`${userId}_${agentId}`,
    { role: 'user', content: userText, ts: Date.now() },
    { role: 'assistant', content: r.reply, ts: Date.now() }
  );
  onEvent({ type: 'token', text: r.reply, agent: agentId });
  onEvent({ type: 'done', agent: agentId });
  return { handled: true };
}

/**
 * Finance file upload preprocessing. Runs as a mutator interceptor — never
 * returns `handled`, but rewrites `ctx.userText` and clears `ctx.attachment`
 * when the user has uploaded a finance file to the finance-role agent.
 * Extracts transactions, inlines them as XML in the prompt, and nudges the
 * LLM toward saving or summarizing based on user intent words in the message.
 */
async function financePreprocess(ctx) {
  const financeAgentId = getRoleAssignments(ctx.userId)?.['expenses'];
  if (!(financeAgentId && ctx.agentId === financeAgentId && ctx.attachment?.isFinanceFile)) return null;
  try {
    const cfg  = loadConfig();
    const txns = (await extractTransactions(cfg, ctx.attachment)).filter(t => parseFloat(t.amount) > 0);
    const block = txns.length ? JSON.stringify(txns, null, 2) : '[]';
    // Intent test runs on the ORIGINAL user text only. Testing after the
    // extracted JSON was appended meant merchant names ("APPLE STORE",
    // "RECORD SHOP") or a filename like import.csv flipped view-only uploads
    // into an auto-import.
    const originalText = ctx.userText || '';
    ctx.userText = (originalText || 'I uploaded a financial statement.') +
      `\n\n<uploaded_statement filename="${ctx.attachment.name}">\n${block}\n</uploaded_statement>`;
    const wantsSave = /\b(save|add|store|import|record|put)\b/i.test(originalText);
    ctx.userText += wantsSave
      ? `\n\n${txns.length} transaction(s) were extracted. The user wants them saved — call expense_add_batch NOW with all transactions, then show a summary table.`
      : `\n\n${txns.length} transaction(s) were extracted. Show them in a table and ask the user if they'd like to save them.`;
  } catch (e) {
    ctx.userText = (ctx.userText || '') + `\n\n[File upload: ${ctx.attachment.name} — extraction failed: ${e.message}]`;
  }
  ctx.attachment = null;
  return null;
}
