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
import {
  appendToSession, appendUserTurnPending, failPendingTurn,
  appendTurnArtifactOnce, getSessionEpoch, markTurnTerminal,
} from './sessions.mjs';
import {
  markAgentBusy, openTurn, finalizeTurn, recordStreamEvent,
  isAgentBusy, waitForAgentIdle, getActiveStreams, getActiveStream, abortChat, abortAllChats,
  tryAcquireUserTurnLease, runWithUserTopologyLease,
} from './chat-dispatch/slot-registry.mjs';
// Re-export the slot-registry surface so external importers
// (ws-handler, routes/telegram, skills/delegate, server) keep working
// without each switching to the new module path.
export {
  isAgentBusy, waitForAgentIdle, markAgentBusy, getActiveStreams, getActiveStream,
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
import { normalizeAttachments } from './chat/providers/_shared.mjs';
import { compactDocumentFallback, normalizeDocumentRequest, parseDocumentMutationResult } from './lib/document-artifacts.mjs';

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
  getUser, getUserCoordinatorAgentId, resolveRuntimeAgentId, recordActivity,
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

// ── Pending-approval pill (post-turn snapshot) ───────────────────────────────
// Four skill families stage a destructive/sensitive op behind a typed
// confirmation phrase and return a *plain-text* warning that the LLM relays
// as its reply: email purge/batch-trash ("APPROVE PURGE"), expense delete
// ("CONFIRM DELETION"), profile trust-state promotion ("APPROVE PROVEN"),
// and cross-agent watcher ops ("APPROVE WATCHER OP") — see tryApprovalIntercept
// in chat-dispatch/voice-preprocess.mjs for the exact-match execute/clear
// logic. None of that state was ever surfaced as structured UI, so a typo'd
// approval silently discarded the staged op with no visual cue.
//
// This reads all four in-memory pending maps read-only (never mutates them)
// so handleChatMessage can diff "pending before this turn" vs "after" and
// emit approval_pending / approval_resolved uniformly, without each skill
// needing its own event-emitting code. Dynamic imports avoid adding four new
// static import edges (and any circular-import risk) to a file already many
// modules deep; Node caches the module after the first load so the repeat
// cost per turn is a map lookup, not a re-import.
const APPROVAL_KIND_ORDER = ['email_purge', 'expense_delete', 'trust_promotion', 'watcher_op'];

/**
 * @param {string} userId
 * @param {string|null} [agentId]  scope the snapshot to ops staged from this
 *   agent's chat (null-agent legacy entries still match — see
 *   lib/pending-approvals.mjs wildcard semantics). Omitting it (tests,
 *   out-of-turn callers) matches any staging agent.
 * @returns {Promise<Record<string, {phrase: string, description: string, expiresAt?: number|null, opId?: string|null}>>}
 */
export async function snapshotPendingApprovals(userId, agentId = null) {
  const out = /** @type {Record<string, {phrase: string, description: string, expiresAt?: number|null, opId?: string|null}>} */ ({});
  try {
    const { getPendingEmail } = await import('./skills/email/execute.mjs');
    const p = getPendingEmail(userId, agentId);
    if (p) out.email_purge = { phrase: 'APPROVE PURGE', description: p.desc || 'perform a destructive email operation', expiresAt: p.expiresAt ?? null, opId: p.opId ?? null };
  } catch (e) { console.warn('[chat-dispatch] approval snapshot (email) failed:', e.message); }
  try {
    const { getPendingDelete } = await import('./skills/expenses/execute.mjs');
    const p = getPendingDelete(userId, agentId);
    if (p) {
      const desc = p.name === 'expense_delete_all'
        ? 'delete ALL transactions'
        : p.name === 'expense_delete_batch'
          ? `delete ${(p.args?.ids || []).length} transaction(s)`
          : `delete transaction ${p.args?.id ?? ''}`;
      out.expense_delete = { phrase: 'CONFIRM DELETION', description: desc, expiresAt: p.expiresAt ?? null, opId: p.opId ?? null };
    }
  } catch (e) { console.warn('[chat-dispatch] approval snapshot (expenses) failed:', e.message); }
  try {
    const { getPendingProven } = await import('./skills/profiles/execute.mjs');
    const p = getPendingProven(userId, agentId);
    if (p) out.trust_promotion = { phrase: 'APPROVE PROVEN', description: `promote "${p.service_id}" on "${p.node_id}" to proven`, expiresAt: p.expiresAt ?? null, opId: p.opId ?? null };
  } catch (e) { console.warn('[chat-dispatch] approval snapshot (profiles) failed:', e.message); }
  try {
    const { getPendingWatcherOp } = await import('./skills/tasks/execute.mjs');
    const p = getPendingWatcherOp(userId, agentId);
    if (p) {
      out.watcher_op = {
        phrase: 'APPROVE WATCHER OP',
        description: p.action === 'cancel'
          ? `cancel watcher "${p.watcherLabel}"`
          : `update watcher "${p.watcherLabel}"${p.changes?.length ? ` (${p.changes.join('; ')})` : ''}`,
        expiresAt: p.expiresAt ?? null,
        opId: p.opId ?? null,
      };
    }
  } catch (e) { console.warn('[chat-dispatch] approval snapshot (tasks) failed:', e.message); }
  return out;
}

/**
 * Pure diff between two snapshotPendingApprovals() results — no I/O, no
 * Maps, no side effects, so this is unit-testable without staging a real
 * destructive op or mocking a WS connection. Exported for tests.
 *
 * For each of the four kind families: a family that's pending in `after`
 * and either wasn't pending in `before` or has a different description
 * (a fresh re-stage) yields an `approval_pending` entry; a family that was
 * pending in `before` but is gone in `after` yields `approval_resolved`.
 * A family pending in both with an unchanged description yields nothing —
 * this is what keeps a background-task tick (which never touches the
 * pending maps) from re-announcing an already-shown pill every cycle.
 *
 * @param {Record<string, {phrase: string, description: string, expiresAt?: number|null, opId?: string|null}>} before
 * @param {Record<string, {phrase: string, description: string, expiresAt?: number|null, opId?: string|null}>} after
 * @returns {Array<{type: 'approval_pending'|'approval_resolved', kind: string, phrase?: string, description?: string, expiresAt?: number|null, opId?: string|null}>}
 */
export function diffPendingApprovals(before, after) {
  const entries = /** @type {Array<{type: 'approval_pending'|'approval_resolved', kind: string, phrase?: string, description?: string, expiresAt?: number|null, opId?: string|null}>} */ ([]);
  for (const kind of APPROVAL_KIND_ORDER) {
    const b = before?.[kind] || null;
    const a = after?.[kind] || null;
    // Re-stage detection: prefer opId (unique per staging, so an identical
    // description re-staged still yields a fresh pill); description compare
    // remains as the legacy-row fallback.
    const restaged = b && a && ((a.opId || b.opId) ? a.opId !== b.opId : b.description !== a.description);
    if (a && (!b || restaged)) {
      entries.push({ type: 'approval_pending', kind, phrase: a.phrase, description: a.description, expiresAt: a.expiresAt ?? null, ...(a.opId ? { opId: a.opId } : {}) });
    } else if (!a && b) {
      // Carry the id of the operation that actually disappeared. A delayed
      // resolution for op X must not collapse a freshly re-staged op Y card
      // of the same family in another tab.
      entries.push({ type: 'approval_resolved', kind, ...(b.opId ? { opId: b.opId } : {}) });
    }
  }
  return entries;
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
 * @param {object} [opts.attachment]  - File attachment object (legacy singular; wrapped into an array when opts.attachments is absent)
 * @param {Array<object>} [opts.attachments] - File attachments (preferred wire shape; normalizeAttachments reduces this + opts.attachment to one ordered array)
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
 * @param {object|null} [opts.attachment]  legacy singular attachment (see normalizeAttachments)
 * @param {Array<object>|null} [opts.attachments]  preferred multi-attachment array — ws-handler/telegram/scheduler/background-tasks/ask_agent all funnel through here
 * @param {{mode?: string, selectedTools?: string[], source?: string, phrase?: string}|null} [opts.toolPlan]
 * @param {{id?: string, filename?: string, mimeType?: string, source?: string, requestId?: string}|null} [opts.documentRequest]
 * @param {'voice-device'|'web'|'telegram'|'desktop-app'|'document-drawer'|null} [opts.source]
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
 * @param {boolean} [opts._readOnlyTurn]             internal untrusted-context turn; no interceptors, tools, or learning
 * @param {string|null} [opts._untrustedContext]     current-turn-only data appended for the model, never persisted
 * @param {string|null} [opts.turnId]                external correlation id (voice/legacy clients)
 * @param {string|null} [opts.messageId]             logical browser message id (stable across explicit retries)
 * @param {string|null} [opts.attemptId]             idempotency key for one execution attempt
 * @returns {Promise<void>}
 */
export async function handleChatMessage({
  userId,
  agentId: rawAgentId,
  text: rawText,
  attachment: rawAttachment,
  attachments: rawAttachments = null,
  toolPlan: rawToolPlan = null,
  documentRequest: rawDocumentRequest = null,
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
  _readOnlyTurn = false,
  _untrustedContext = null,
  turnId = null,
  messageId = null,
  attemptId = null,
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
  const topologyLease = tryAcquireUserTurnLease(userId, {
    allowUpgrade: !_hiddenUser && !_isBackgroundContinuation && !_isolatedTaskRun && !_readOnlyTurn,
    label: source === 'voice-device' ? 'voice-turn' : 'chat-turn',
  });
  if (!topologyLease) {
    onEvent({
      type: 'error',
      code: 'orchestration_busy',
      retryable: true,
      agent: agentId ?? 'system',
      message: 'Your agent setup is changing. Wait a moment, then send that again.',
    });
    return;
  }
  try {
  const requestedAgentId = agentId ?? getUserCoordinatorAgentId(userId);
  // Stored browser/device/task references may name an agent parked by a mode
  // switch. Single mode redirects those references to the current primary;
  // ensemble keeps invalid explicit ids invalid so normal error handling and
  // isolation semantics are unchanged.
  agentId = resolveRuntimeAgentId(userId, requestedAgentId, { fallbackUnknown: !!deviceId }) ?? requestedAgentId;

  const toolPlan = normalizeToolPlan(rawToolPlan);
  const documentRequest = normalizeDocumentRequest(rawDocumentRequest);
  const documentEventMeta = documentRequest ? { documentRequest, documentTurn: true } : {};

  // Entry-edge attachment normalization — the ONE place the wire's two
  // shapes (new `attachments` array from the composer's multi-file tray;
  // legacy singular `attachment` still sent by ws-handler.mjs pass-through,
  // routes/telegram.mjs, scheduler.mjs, background-tasks.mjs, roles.mjs
  // ask_agent, and public/docs.js's "ask about this doc") reduce to one
  // ordered, capped array. Everything below reads `attachmentList`;
  // `rawAttachment`/`rawAttachments` are not touched again.
  const attachmentList = normalizeAttachments(rawAttachments, rawAttachment)
    .map(attachment => ({ ...attachment }));

  // Turn trace (correlation spine). One record per top-level turn; nested
  // streamChat runs (specialist-router, ask_agent delegation) inherit this store
  // via ALS and push their own spans. Wrapped in turnTraceContext.run() — NOT
  // bare enterWith — so the store is scoped to THIS turn and restored after: on a
  // long-lived WS connection enterWith leaks the store into the next message,
  // which chained unrelated turns under one rootId (depth climbing 0,1,2…). run()
  // also lets a routine-followup re-entry (await handleChatMessage below) nest as
  // a child turn and unwind without corrupting this one. beginTurn/recorders
  // fail-open, so nothing here can break a turn.
  return await runWithUserTopologyLease(topologyLease, () => turnTraceContext.run(undefined, async () => {
  const turnStore = beginTurn({
    userId,
    agentId,
    source: source ?? 'web',
    turnId: attemptId ?? turnId,
    messageId,
    attemptId: attemptId ?? turnId,
  });
  recordRouting({ toolPlan: toolPlan?.mode || 'auto' });

  // Correlate every outward event before it reaches WS/Telegram adapters. The
  // browser reducer uses (turn_id, seq) to drop late/duplicate events after an
  // agent switch or reconnect. `done` is deliberately held until the outer
  // finalizer has persisted approval/attachment rows too, making it a genuine
  // whole-turn durability barrier rather than merely "the model stopped".
  const rawOnEvent = onEvent;
  const wireTurnId = turnStore?.turnId ?? attemptId ?? turnId ?? null;
  const wireMessageId = messageId ?? null;
  const wireAttemptId = attemptId ?? turnId ?? wireTurnId;
  let eventSeq = 0;
  let eventScopedSessionKey = `${userId}_${agentId}`;
  /** @type {Record<string, any>|null} */
  let heldDoneEvent = null;
  /** @type {Record<string, any>|null} */
  let heldErrorEvent = null;
  let terminalErrorEmitted = false;
  let postCommitFailed = false;
  let skipPostTurnArtifacts = false;
  const replayedArtifactSignatures = new Set();
  let outwardText = '';
  onEvent = (event) => {
    if (!event || typeof event !== 'object') return rawOnEvent(event);
    if (event.type === 'token' && typeof event.text === 'string') outwardText += event.text;
    if (event.type === 'replace' && typeof event.text === 'string') outwardText = event.text;
    if (event.type === 'done') {
      heldDoneEvent = { ...event };
      return;
    }
    if (event.type === 'error') {
      terminalErrorEmitted = true;
      heldErrorEvent = { ...event };
      return;
    }
    // A nested/internal dispatcher may already have its own trace id, but the
    // outer browser attempt remains the wire owner. Re-envelope here so one
    // visible turn never switches ids mid-stream.
    const tagged = {
      ...event,
      ...(wireTurnId ? { turn_id: wireTurnId } : {}),
      ...(wireMessageId ? { message_id: wireMessageId } : {}),
      ...(wireAttemptId ? { attempt_id: wireAttemptId } : {}),
      ...(turnStore?.sessionEpoch ? { session_epoch: turnStore.sessionEpoch } : {}),
      seq: ++eventSeq,
    };
    recordStreamEvent(eventScopedSessionKey, tagged);
    return rawOnEvent(tagged);
  };

  // Snapshot ambient state for voice-device turns. The firmware kills any
  // playing ambient when a wake fires (s_ambient_stop in main.c — barge-in
  // behavior). If this turn doesn't deliberately start a new ambient or
  // stop the existing one, the user is left in silence even though the
  // ambient stream is still cached server-side. The finally below re-emits
  // play_ambient after a short delay to restore the experience.
  const _ambientAtStart = (source === 'voice-device' && deviceId)
    ? (getAmbientForDevice(deviceId)?.marker || null)
    : null;

  // Snapshot the upload(s) (file_id + display name) BEFORE the interceptor
  // chain mutates ctx.attachment/ctx.attachments. financePreprocess clears
  // the first slot; transcribe fast-path consumes the first slot; the files
  // themselves stay on disk regardless. After the turn lands, ask the user
  // whether to keep or discard EACH one (see the attachment_decision emit
  // in the finally block below — one decision bubble per file_id).
  let _attachmentsForDecision = (source !== 'voice-device' && !_isRoutineFollowup)
    ? attachmentList.filter(a => a?.file_id).map(a => ({ file_id: a.file_id, name: a.name, mimeType: a.mimeType }))
    : [];

  // Snapshot staged destructive-op approvals BEFORE the interceptor chain
  // runs — tryApprovalIntercept executes-and-clears or clears-on-any-miss
  // inside that chain. Diffed against the post-turn state in the finally
  // below to drive the approval_pending / approval_resolved pill events.
  // Assigned AFTER the @-mention redirect (inside the try) so both snapshots
  // are scoped to the agent the turn actually ran on; null means the turn
  // returned before approvals could possibly change → the finally skips the
  // diff entirely.
  let _pendingApprovalsBefore = null;

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

  const chatUser = getUser(userId);
  if (isUserTimeBlocked(userId)) {
    onEvent({ type: 'error', message: 'Access is restricted at this time. Please try again later.', agent: agentId ?? 'system', ...documentEventMeta });
    return;
  }

  // Resolve the final agent before ANY side-effecting voice/browser fastpath.
  // This lets the send-time pending row protect timer/control/proposal turns as
  // well as normal LLM turns.
  let agent = getAgentsForUser(userId).find(a => a.id === agentId);
  if (!agent) {
    onEvent({ type: 'error', message: `Unknown agent: ${agentId}`, agent: agentId, ...documentEventMeta });
    return;
  }

  const scopedSessionKey = `${userId}_${agentId}`;
  eventScopedSessionKey = scopedSessionKey;
  if (turnStore) {
    turnStore.sessionKey = scopedSessionKey;
    // Capture before the first await. appendUserTurnPending compare-and-sets
    // this generation under the writer lock, so Clear cannot be crossed by a
    // paused pre-open request that later adopts the new epoch.
    turnStore.sessionEpoch = getSessionEpoch(scopedSessionKey);
  }

  // False-positive wake/noise turns are deliberately ephemeral. Handle them
  // before the send-time durability write so a one-character STT fragment
  // cannot leave a permanent `running` row (and so these non-commands still
  // do not pollute chat history).
  if (await tryVoiceEmptyFastpath({
    source, userText: rawText, userId, agentId, onEvent,
  })) return;

  if (!_hiddenUser && !_isolatedTaskRun && (rawText?.trim() || attachmentList.length)) {
    try {
      const pendingUserEntry = {
        role: 'user',
        content: rawText?.trim() || attachmentList.map(a => `[Attached: ${a?.name ?? 'file'}]`).join('\n'),
        ts: Date.now(),
        ...(wireMessageId ? { messageId: wireMessageId } : {}),
        ...(wireAttemptId ? { attemptId: wireAttemptId } : {}),
        ...(documentRequest ? { documentRequest } : {}),
        ...(attachmentList.length ? {
          attachments: attachmentList.map(a => ({
            name: a?.name ?? null, mimeType: a?.mimeType ?? null,
            isImage: Boolean(a?.isImage), file_id: a?.file_id ?? null,
          })),
        } : {}),
      };
      const pendingResult = await appendUserTurnPending(scopedSessionKey, pendingUserEntry);
      if (pendingResult?.duplicate) {
        onEvent({ type: 'turn_accepted', agent: agentId, duplicate: true, status: pendingResult.status || 'accepted' });

        const replayArtifacts = Array.isArray(pendingResult.artifacts) ? pendingResult.artifacts : [];
        const persistedApprovalState = {};
        const decidedFileIds = new Set();
        for (const row of replayArtifacts) {
          if ((row?.role === 'approval_pending' || row?.role === 'approval_resolved') && row.kind) {
            replayedArtifactSignatures.add(`${row.role}:${row.kind}:${row.opId ?? ''}`);
          }
          if (row?.role === 'approval_pending' && row.kind) {
            persistedApprovalState[row.kind] = {
              phrase: row.phrase, description: row.description,
              expiresAt: row.expiresAt ?? null, opId: row.opId ?? null,
            };
          } else if (row?.role === 'approval_resolved' && row.kind) {
            const prior = persistedApprovalState[row.kind];
            if (!row.opId || !prior?.opId || prior.opId === row.opId) delete persistedApprovalState[row.kind];
          } else if (row?.role === 'attachment_decision' && row.file_id) {
            decidedFileIds.add(row.file_id);
          }
          const { role, turnId: _turnId, messageId: _messageId, attemptId: _attemptId,
            hidden: _hidden, excludeFromModel: _exclude, ...fields } = row || {};
          if (role) onEvent({ type: role, agent: agentId, ...fields, replay: true });
        }

        if (pendingResult.status === 'complete') {
          skipPostTurnArtifacts = true;
          onEvent({ type: 'done', agent: agentId, replay: true });
        } else if (pendingResult.status === 'failed' || pendingResult.status === 'stopped') {
          skipPostTurnArtifacts = true;
          const terminal = pendingResult.terminal || {};
          onEvent({
            type: 'error', agent: agentId, replay: true,
            code: terminal.code || 'duplicate_attempt',
            retryable: terminal.retryable === true,
            message: terminal.message || 'That execution attempt already ended. Use Retry to create a new attempt.',
          });
        } else if (pendingResult.status === 'finalizing' && pendingResult.recoverable) {
          // The prior process durably wrote the reply/failure but died before
          // the whole-turn marker. Re-run ONLY the idempotent artifact finalizer;
          // never re-enter interceptors, tools, or the model.
          busySlot = markAgentBusy(scopedSessionKey);
          await busySlot.waitTurn();
          const currentActive = getActiveStream(userId, agentId);
          if (currentActive) {
            // Another reconnect won recovery ownership while this duplicate was
            // queued. Its broadcast will carry the authoritative artifacts and
            // terminal; do not abort or race it.
            busySlot.release();
            busySlot = null;
            skipPostTurnArtifacts = true;
            return;
          }
          turnAc = openTurn(scopedSessionKey, userId, agentId, {
            turnId: wireTurnId,
            messageId: wireMessageId,
            attemptId: wireAttemptId,
            seq: eventSeq,
          });
          _pendingApprovalsBefore = pendingResult.approvalBefore || persistedApprovalState;
          const replayAttachments = Array.isArray(pendingResult.userMessage?.attachments)
            ? pendingResult.userMessage.attachments
            : [];
          _attachmentsForDecision = replayAttachments
            .filter(att => att?.file_id && !decidedFileIds.has(att.file_id))
            .map(att => ({ file_id: att.file_id, name: att.name, mimeType: att.mimeType }));
          const terminal = pendingResult.terminal || {};
          if (terminal.terminalType === 'done') heldDoneEvent = { type: 'done', agent: agentId, replay: true };
          else {
            terminalErrorEmitted = true;
            heldErrorEvent = {
              type: 'error', agent: agentId, replay: true,
              code: terminal.code || 'turn_failed', retryable: terminal.retryable === true,
              message: terminal.message || 'The prior turn failed before completion.',
            };
          }
        } else {
          // A live owner is still finalizing this attempt. Its broadcast carries
          // the one authoritative terminal; this duplicate must not race it.
          skipPostTurnArtifacts = true;
        }
        return;
      }
      onEvent({ type: 'turn_accepted', agent: agentId, status: 'accepted', userMessage: pendingUserEntry });
    } catch (e) {
      skipPostTurnArtifacts = true;
      const cleared = e?.code === 'SESSION_CLEARED';
      onEvent({
        type: 'error', agent: agentId,
        code: cleared ? 'session_cleared' : 'persistence_failed',
        retryable: !cleared,
        message: cleared
          ? 'This turn was not executed because the session was cleared.'
          : 'Your message could not be saved, so it was not executed. Please check storage and try again.',
      });
      console.warn('[chat-dispatch] send-time user persist failed:', e.message);
      return;
    }
  }

  if (!rawText?.trim() && !attachmentList.length) {
    onEvent({ type: 'done', agent: agentId, ...documentEventMeta });
    return;
  }

  // Register synchronously after acceptance, before attachment hydration or
  // any other await. Stop/Clear can now abort a large image re-read as well as
  // every pre-LLM fastpath. Duplicate attempts returned above without replacing
  // the live original owner.
  busySlot = markAgentBusy(scopedSessionKey);
  if (_isBackgroundContinuation) {
    await busySlot.waitTurn();
    if (turnStore?.sessionEpoch && getSessionEpoch(scopedSessionKey) !== turnStore.sessionEpoch) {
      busySlot.release();
      busySlot = null;
      onEvent({ type: 'error', agent: agentId, code: 'session_cleared', retryable: false, message: 'This turn was not executed because the session was cleared.' });
      return;
    }
  }
  const ac = openTurn(scopedSessionKey, userId, agentId, {
    turnId: wireTurnId,
    messageId: wireMessageId,
    attemptId: wireAttemptId,
    seq: eventSeq,
  });
  turnAc = ac;

  // The browser's crash-safe outbox intentionally does not put large image
  // base64 blobs in localStorage. A replay carries the already-uploaded
  // profile `file_id`; restore the vision payload from that user-scoped path
  // after idempotent acceptance and before any interceptor/model can run.
  for (const attachment of attachmentList) {
    if (!attachment?.isImage || attachment.base64 || !attachment.file_id) continue;
    try {
      const { getProfileFilePath } = await import('./lib/profile-files.mjs');
      const filePath = getProfileFilePath(userId, attachment.file_id);
      if (!filePath) throw new Error('uploaded image is no longer available');
      attachment.base64 = (await fs.promises.readFile(filePath)).toString('base64');
    } catch (e) {
      skipPostTurnArtifacts = true;
      await failPendingTurn(scopedSessionKey, 'The attached image is no longer available', {
        retryable: false,
      }).catch(() => {});
      onEvent({
        type: 'error', agent: agentId, code: 'attachment_missing', retryable: false,
        message: 'The attached image could not be reopened, so this turn was not executed. Attach it again to retry.',
      });
      console.warn('[chat-dispatch] attachment replay hydration failed:', e.message);
      return;
    }
  }

  // Attachment hydration is asynchronous. Clear may land after the pending
  // row was accepted but before those reads finish; recheck immediately before
  // interceptors so no side effect can cross the generation boundary.
  if (ac.signal.aborted) return;
  if (turnStore?.sessionEpoch && getSessionEpoch(scopedSessionKey) !== turnStore.sessionEpoch) {
    skipPostTurnArtifacts = true;
    onEvent({ type: 'error', agent: agentId, code: 'session_cleared', retryable: false, message: 'This turn was not executed because the session was cleared.' });
    return;
  }

  _pendingApprovalsBefore = await snapshotPendingApprovals(userId, agentId);

  const persistEarlyHandledTurn = async () => {
    try {
      await appendToSession(scopedSessionKey,
        { role: 'user', content: rawText?.trim() || '(voice command)', ts: Date.now() },
        { role: 'assistant', content: outwardText || '(completed)', ts: Date.now() });
      return true;
    } catch (e) {
      await failPendingTurn(scopedSessionKey, 'Persistence failed after the voice action', { retryable: false }).catch(() => {});
      onEvent({ type: 'error', agent: agentId, code: 'persistence_failed', retryable: false, message: 'The action finished, but its chat record could not be saved. Do not retry automatically.' });
      return false;
    }
  };

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
    await persistEarlyHandledTurn();
    return;
  }
  if (_vTrace) console.log(`[voice-trace] proposal-reply: miss device=${deviceId}`);
  const timerResult = await tryVoiceTimerIntent({ source, deviceId, rawText, userId, agentId, onEvent });
  if (timerResult) {
    if (_vTrace) console.log(`[voice-trace] timer-intent: HANDLED device=${deviceId} text="${(rawText || '').slice(0, 60)}"`);
    await persistEarlyHandledTurn();
    if (timerResult.awaitReplyMs && deviceId) {
      // Disambiguation question ("the 5 or 10 minute one?") — the pending pick
      // expires server-side, so the mic must reopen for the full TTL even when
      // conversation mode is off; a wake word can't be required to answer.
      try {
        const { armFollowupAfterDrain } = await import('./ws-handler.mjs');
        armFollowupAfterDrain(deviceId, { windowMs: timerResult.awaitReplyMs });
      } catch (e) {
        console.warn('[chat] timer-disambig follow-up arm failed:', e.message);
      }
    } else {
      // "Set a timer for ten minutes" mid-conversation is an answer, not an
      // exit — keep listening like any other completed reply.
      await armConversationFollowup({ source, deviceId, conversationMode });
    }
    return;
  }
  if (_vTrace) console.log(`[voice-trace] timer-intent: miss device=${deviceId}`);
  if (tryVoiceControlIntent({ source, rawText, deviceId, userId, agentId, onEvent, conversationMode, bargeIn, recentReplyStop })) {
    if (_vTrace) console.log(`[voice-trace] control-intent: HANDLED device=${deviceId} text="${(rawText || '').slice(0, 60)}"`);
    await persistEarlyHandledTurn();
    return;
  }
  if (_vTrace) console.log(`[voice-trace] control-intent: miss device=${deviceId} text="${(rawText || '').slice(0, 60)}" — falling through to LLM`);

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
    await failPendingTurn(scopedSessionKey, `Model "${agent.model}" is not available for this account`, { retryable: false });
    onEvent({ type: 'error', message: `Model "${agent.model}" is not available for your account. Ask your admin to grant access.`, agent: agentId, ...documentEventMeta });
    return;
  }

  recordActivity(userId, agentId, { message: true });

  // Profile intercepts: news-topic preference (side-effect; pipeline continues)
  // and agent rename / re-emoji (short-circuits with a spoken confirmation).
  if (!documentRequest && !_readOnlyTurn) {
    tryNewsPrefIntercept({ rawText, userId, onEvent });
    if (await tryRenameIntercept({ rawText, userId, agentId, agent, onEvent, onBroadcast })) return;
  }

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
  // ctx.userText / ctx.attachment / ctx.attachments in place when the user
  // uploads a finance file, so every subsequent interceptor (and the LLM
  // turn below) sees the augmented text.
  //
  // ctx.attachment stays the FIRST attachment only — every interceptor that
  // predates multi-attachment support (tryTranscribeAttachmentFastpath,
  // tryHaFastpath, etc. — chat-dispatch/fastpaths.mjs and friends) reads only
  // this singular field and was never touched for this change, so they keep
  // acting on "the" attachment exactly as before. ctx.attachments carries the
  // full ordered array through to the specialist router / LLM turn below,
  // which DO thread every attachment to streamChat (see chat.mjs
  // buildCurrentUserTurn). See the note-the-rest block below for how a
  // second+ file is surfaced to a single-attachment interceptor anyway.
  const ctx = {
    userId, agentId, agent, source, deviceId, ac,
    userText: rawText?.trim() ?? '',
    attachment: attachmentList[0] ?? null,
    attachments: attachmentList,
    toolPlan,
    documentRequest,
    _isRoutineFollowup,
    // Profile is threaded through so the HA fast-path can enforce the same
    // child-account gate executeRoleTool applies (mirrors the disabled/hidden
    // checks it also runs) — without a redundant profile read on the hot path.
    chatUser,
    onEvent, onBroadcast, onNotify,
  };

  // "Note the rest": single-attachment interceptors (transcribe fast-path,
  // finance preprocessor) only ever see ctx.attachment (the first file), so
  // a second+ upload would otherwise vanish with no trace anywhere in the
  // turn. Fold their names into ctx.userText up front — before any
  // interceptor runs — so the note travels with the turn regardless of which
  // handler (or the default LLM turn) ultimately answers it, and the LLM can
  // at least narrate "I also see photo2.jpg, photo3.jpg" instead of silently
  // ignoring them. Full pixel/text access to every attachment still happens
  // downstream via ctx.attachments (runSpecialistRoute / runLlmTurn → chat.mjs).
  // Voice-device turns never carry more than zero attachments today (no tray
  // UI on the firmware) — skipped defensively anyway so a future voice
  // multi-attachment source can't have this text note corrupt the
  // anchored control-intent regexes (tryVoiceControlIntent etc. match on the
  // bare transcript).
  if (source !== 'voice-device' && attachmentList.length > 1) {
    const extraNames = attachmentList.slice(1).map(a => a?.name).filter(Boolean);
    if (extraNames.length) {
      ctx.userText = `${ctx.userText}\n\n[${extraNames.length} additional file(s) attached: ${extraNames.join(', ')}]`.trim();
    }
  }

  // Phase-6 router-as-learner: explicit redirects ("@<name>", "use coder",
  // "ask <name>") in the incoming user message are logged against the
  // previous turn's pickedAgent so we can propose a routing override after
  // threshold. Fire-and-forget — detection never blocks dispatch.
  if (ctx.userText && !_isBackgroundContinuation && !_readOnlyTurn) {
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
  const allowIntentFastpaths = !planConstrained && !_isBackgroundContinuation && !documentRequest;
  // Answer-type fast-paths whose handled reply should keep a conversation-mode
  // exchange open (see armConversationFollowup). Everything else in the chain
  // ends or owns its own flow.
  const CONVERSATION_REARM_FASTPATHS = new Set([
    tryHaFastpath, tryTriviaFastpath, tryCalendarFastpath, tryLocalIntentFastpath,
  ]);
  const INTERCEPTORS = (documentRequest || _readOnlyTurn) ? [] : [
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
    ...(_isBackgroundContinuation ? [] : [c => runSpecialistRoute({ ...c, attachment: c.attachment, attachments: c.attachments, conversationMode })]),
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
    // followupPrompt re-enters handleChatMessage and runs an LLM turn, whose
    // own finally re-arms — arming here too would double-send the window.
    if (!r.followupPrompt && CONVERSATION_REARM_FASTPATHS.has(handler)) {
      await armConversationFollowup({ source, deviceId, conversationMode, ac });
    }
    if (r.followupPrompt) {
      // The nested prompt becomes the active owner for the same agent. Release
      // this setup phase immediately before re-entry; the nested turn retains
      // ownership through its own artifact+terminal barrier.
      finalizeTurnOnce();
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
    skipIntercept: _readOnlyTurn || _isBackgroundContinuation || _isolatedTaskRun || !!documentRequest,
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
  const _hintsPromise = _readOnlyTurn ? Promise.resolve('') : (async () => {
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
  let documentMutation = null;
  const wrappedOnEvent = (ev) => {
    if (ev?.type === 'token' && typeof ev.text === 'string') finalAssistantText += ev.text;
    if (ev?.type === 'replace' && typeof ev.text === 'string') finalAssistantText = ev.text;
    let outwardEvent = documentRequest && ['tool_call', 'tool_progress', 'tool_result', 'done', 'error'].includes(ev?.type)
      ? { ...ev, documentRequest, documentTurn: true }
      : ev;
    if (documentRequest && ev?.type === 'tool_result') {
      const mutation = parseDocumentMutationResult(ev.name, ev.text);
      documentMutation = mutation ?? documentMutation;
      if (mutation) outwardEvent = { ...outwardEvent, documentArtifact: mutation };
    }
    if (documentRequest && (ev?.type === 'token' || ev?.type === 'replace')) return;
    if (documentRequest && ev?.type === 'done' && !documentMutation && finalAssistantText.trim()) {
      if (typeof onEvent === 'function') {
        onEvent({
          type: 'document_response', agent: agentId,
          text: compactDocumentFallback(finalAssistantText),
          documentRequest, documentTurn: true,
        });
      }
    }
    if (typeof onEvent === 'function') return onEvent(outwardEvent);
  };
  // 'direct' = the addressed agent ran its own LLM turn (no fast-path, no
  // specialist reroute, no @-redirect). Applies to ANY agent the user is
  // chatting with — coordinator or specialist — so it must NOT be labelled
  // 'coordinator' (that wrongly implied the agent's role in the trace).
  recordRouting({ mode: 'direct', llmAvoided: false });
  const modelUserText = _readOnlyTurn && typeof _untrustedContext === 'string' && _untrustedContext.trim()
    ? `${ctx.userText}\n\n${_untrustedContext.slice(0, 50_000)}`
    : ctx.userText;
  try {
    await runLlmTurn({
      userId, agentId, scopedAgent, scopedSessionKey,
      userText: modelUserText, sessionUserText: ctx.userText,
      attachment: ctx.attachment, attachments: ctx.attachments,
      toolPlan: ctx.toolPlan,
      documentRequest: ctx.documentRequest,
      schedulerNote: resolvedNote, source, deviceId,
      conversationMode,
      ac, onEvent: wrappedOnEvent, onNotify,
      hiddenUser: _hiddenUser,
      isolatedTaskRun: _isolatedTaskRun,
      readOnlyTurn: _readOnlyTurn,
    });
  } catch (e) {
    const key = `${userId}_${agentId}`;
    await failPendingTurn(key, e?.message || 'Turn failed unexpectedly', {
      status: e?.code === 'SESSION_CLEARED' ? 'stopped' : 'failed',
      retryable: false,
    }).catch(() => {});
    if (!terminalErrorEmitted) {
      onEvent({
        type: 'error', agent: agentId,
        code: e?.code === 'SESSION_CLEARED' ? 'session_cleared' : 'turn_failed',
        retryable: false,
        message: e?.code === 'SESSION_CLEARED'
          ? 'This turn was stopped because the session was cleared.'
          : (e?.message || 'The turn failed unexpectedly.'),
      });
    }
  }

  // Post-turn alias learning — fire-and-forget, never blocks return.
  //   Path A: if the LLM called ask_agent or any skill-owned tool and the
  //           user message had a name-like phrase that didn't pre-resolve,
  //           learn the new alias.
  //   Path B: if the LLM's reply asked "did you mean X?", stash a pending
  //           clarification keyed by userId. The next turn's affirmation
  //           check (above) consumes it.
  if (!_readOnlyTurn) (async () => {
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

  } catch (e) {
    const key = `${userId}_${agentId}`;
    await failPendingTurn(key, e?.message || 'Turn failed unexpectedly', {
      status: e?.code === 'SESSION_CLEARED' ? 'stopped' : 'failed',
      retryable: false,
    }).catch(() => {});
    if (!terminalErrorEmitted) {
      onEvent({
        type: 'error', agent: agentId,
        code: e?.code === 'SESSION_CLEARED' ? 'session_cleared' : 'turn_failed',
        retryable: false,
        message: e?.code === 'SESSION_CLEARED'
          ? 'This turn was stopped because the session was cleared.'
          : (e?.message || 'The turn failed unexpectedly.'),
      });
    }
  } finally {
    const staleOrAborted = Boolean(turnAc?.signal?.aborted);
    if (staleOrAborted) skipPostTurnArtifacts = true;
    try {

    // Flush the turn trace — one greppable `tag:"turn"` record carrying every
    // span (incl. delegated sub-agents) + the delegation chain + routing. Wrapped
    // so a trace bug can never break the turn.
    try {
      const trace = finishTurn();
      if (trace) log.info('turn', 'summary', trace);
    } catch { /* never throw from the finalizer */ }

    // Post-turn approval-pill diff (see snapshotPendingApprovals above). A
    // family that's pending now — and wasn't already announced with this
    // exact description — gets an approval_pending push; a family that WAS
    // pending before this turn but is gone now (approved-and-executed, or
    // cleared by the "say anything else to cancel" rule) gets
    // approval_resolved so the frontend collapses that pill. Background/
    // hidden turns skip tryApprovalIntercept entirely (see INTERCEPTORS
    // above) so before === after for them and this is a silent no-op —
    // exactly one push per real staging/resolution, never a re-announce on
    // every background tick. New event types the firmware doesn't recognize
    // ride through ws-handler unspoken (it only TTS's token/done/error).
    try {
      if (!skipPostTurnArtifacts && _pendingApprovalsBefore) {
        const pendingAfter = await snapshotPendingApprovals(userId, agentId);
        for (const { type, kind, ...fields } of diffPendingApprovals(_pendingApprovalsBefore, pendingAfter)) {
          const entry = { kind, ts: Date.now(), ...fields };
          const signature = `${type}:${kind}:${fields.opId ?? ''}`;
          if (replayedArtifactSignatures.has(signature)) continue;
          // Awaited: the pill row must be durable before the event reaches the
          // client — a reload racing the write showed a card the session
          // couldn't replay (or vice versa for the resolution).
          const persisted = await appendTurnArtifactOnce(`${userId}_${agentId}`, { role: type, ...entry });
          const { role: _role, ...persistedFields } = persisted.row;
          onEvent({ type, agent: agentId, ...persistedFields });
        }
      }
    } catch (e) {
      postCommitFailed = true;
      console.warn('[chat-dispatch] approval-pill diff failed:', e.message);
      onEvent({
        type: 'error', agent: agentId, code: 'persistence_failed', retryable: false,
        message: 'The reply finished, but its approval state could not be saved. Do not retry the action until storage is healthy.',
      });
    }

    // Post-turn attachment save/discard prompt. Chat-upload always persists
    // to users/<id>/profile-files/{images,videos,audio,documents}/ — the
    // ✕ on the preview pill clears client state but not the on-disk file.
    // Ask the user once the turn lands whether to keep or discard EACH
    // uploaded file, so casual "ask about this image" uploads don't silently
    // accumulate. One independent decision (own decisionId) per file — a
    // 3-file turn shows 3 pills. Skipped for voice-device (no screen) and
    // routine follow-ups (the original turn already showed the prompt).
    for (const att of (skipPostTurnArtifacts ? [] : _attachmentsForDecision)) {
      try {
        const decisionId = 'att_' + randomBytes(6).toString('hex');
        const ts = Date.now();
        const entry = {
          role: 'attachment_decision',
          decisionId,
          file_id: att.file_id,
          name: att.name,
          mimeType: att.mimeType,
          ts,
        };
        const persisted = await appendTurnArtifactOnce(`${userId}_${agentId}`, entry);
        const artifact = persisted.row;
        onEvent({
          type: 'attachment_decision',
          decisionId: artifact.decisionId,
          agent: agentId,
          file_id: artifact.file_id,
          name: artifact.name,
          mimeType: artifact.mimeType,
          ts: artifact.ts,
        });
      } catch (e) {
        postCommitFailed = true;
        console.warn('[chat-dispatch] attachment_decision emit failed:', e.message);
        onEvent({
          type: 'error', agent: agentId, code: 'persistence_failed', retryable: false,
          message: 'The reply finished, but an attachment decision could not be saved. The chat turn will not be marked complete.',
        });
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

    // The only place a top-level terminal reaches the transport. Approval and
    // attachment events above therefore cannot arrive after done/error.
    const heldTerminal = heldErrorEvent || (!postCommitFailed ? heldDoneEvent : null);
    if (staleOrAborted) {
      // A replacement/Stop owns the visible surface now. Persist the old turn's
      // stopped boundary. When the epoch is unchanged this is Stop/barge-in,
      // and every tab still needs the correlated terminal so it can clear the
      // old busy state (a newer turn reducer drops it by turn_id). Clear rotates
      // the epoch and broadcasts session_cleared, so suppress the old terminal
      // in that case — the clear event is authoritative.
      const epochStillCurrent = !turnStore?.sessionEpoch
        || getSessionEpoch(eventScopedSessionKey) === turnStore.sessionEpoch;
      if (epochStillCurrent) {
        let stoppedCode = 'stopped';
        let stoppedMessage = 'Stopped before whole-turn finalization completed.';
        try {
          // Abort can land during pre-LLM attachment hydration, before
          // runLlmTurn has a chance to convert the pending user row. Persist a
          // visible stopped error when that row still exists; this is a no-op
          // when the LLM/error path already recorded it.
          await failPendingTurn(eventScopedSessionKey, 'Stopped by user', {
            status: 'stopped', retryable: false, partial: outwardText,
          });
          await markTurnTerminal(eventScopedSessionKey, {
            type: 'stopped', code: stoppedCode, retryable: false,
            message: stoppedMessage,
          });
        } catch (e) {
          console.warn('[chat-dispatch] stopped terminal persist failed:', e.message);
          stoppedCode = 'persistence_failed';
          stoppedMessage = 'The turn stopped, but its terminal state could not be saved. Reload before retrying.';
        }
        const terminal = {
          type: 'error', agent: agentId, code: stoppedCode,
          retryable: false, message: stoppedMessage, status: 'stopped',
          ...(wireTurnId ? { turn_id: wireTurnId } : {}),
          ...(wireMessageId ? { message_id: wireMessageId } : {}),
          ...(wireAttemptId ? { attempt_id: wireAttemptId } : {}),
          ...(turnStore?.sessionEpoch ? { session_epoch: turnStore.sessionEpoch } : {}),
          seq: ++eventSeq,
        };
        recordStreamEvent(eventScopedSessionKey, terminal);
        rawOnEvent(terminal);
      }
    } else if (heldTerminal) {
      try {
        await markTurnTerminal(eventScopedSessionKey, {
          ...heldTerminal,
          type: heldErrorEvent ? 'error' : 'done',
        });
      } catch (e) {
        console.warn('[chat-dispatch] whole-turn terminal persist failed:', e.message);
        heldErrorEvent = {
          type: 'error', agent: agentId, code: 'persistence_failed', retryable: false,
          message: 'The reply finished, but its terminal state could not be saved. Reload before taking another action.',
        };
      }
      // Turns intentionally without a session row (voice-empty/no-op/internal)
      // return false and still need their transport terminal. A thrown write is
      // surfaced as a fail-closed persistence error instead of a false done.
      const outboundTerminal = heldErrorEvent || heldTerminal;
      const terminal = /** @type {{type: string, [k: string]: any}} */ ({
        ...outboundTerminal,
        type: heldErrorEvent ? 'error' : 'done',
        ...(wireTurnId ? { turn_id: wireTurnId } : {}),
        ...(wireMessageId ? { message_id: wireMessageId } : {}),
        ...(wireAttemptId ? { attempt_id: wireAttemptId } : {}),
        ...(turnStore?.sessionEpoch ? { session_epoch: turnStore.sessionEpoch } : {}),
        seq: ++eventSeq,
      });
      recordStreamEvent(eventScopedSessionKey, terminal);
      rawOnEvent(terminal);
    }
    } finally {
      // Ownership lasts through artifact persistence, durable terminal marking,
      // and the actual terminal send. Releasing earlier let reconnect report no
      // active turn and let a second turn mutate approval state mid-finalizer.
      finalizeTurnOnce();
    }
  }
  }));
  } finally {
    // If this turn upgraded itself to a topology writer, release also runs its
    // deferred roster broadcast. This is deliberately after the terminal event
    // and every durable finalizer above.
    topologyLease.release();
  }
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
  try {
    await appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: r.reply, ts: Date.now() }
    );
  } catch (e) {
    console.warn('[chat-dispatch] slash persist failed:', e.message);
    await failPendingTurn(`${userId}_${agentId}`, 'Persistence failed after the command ran', { retryable: false }).catch(() => {});
    onEvent({ type: 'error', code: 'persistence_failed', retryable: false, message: 'The command finished, but the chat record could not be saved. Do not retry it automatically.', agent: agentId });
    return { handled: true };
  }
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
 *
 * Only ever looks at the FIRST attachment (ctx.attachment) — a finance
 * statement upload is a single-file feature (multi-statement import isn't
 * supported), same "singly sensible" rule as the transcribe fast-path. If
 * it fires, the consumed file is also dropped from ctx.attachments so the
 * LLM turn downstream doesn't ALSO get it re-attached as a vision image;
 * any OTHER attachments in the same turn are left in ctx.attachments and
 * still reach the LLM normally.
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
  if (Array.isArray(ctx.attachments) && ctx.attachments.length) ctx.attachments = ctx.attachments.slice(1);
  return null;
}
