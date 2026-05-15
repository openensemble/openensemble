/**
 * chat-dispatch.mjs
 * Platform-agnostic chat handler — used by WebSocket (server.mjs) and Telegram (routes/telegram.mjs).
 */

import { getAgent, updateCustomAgent, loadCustomAgents } from './agents.mjs';
import { streamChat } from './chat.mjs';
import { appendToSession, writeStreamBuffer, clearStreamBuffer, loadSession } from './sessions.mjs';
import { extractTransactions, getPendingDelete, clearPendingDelete, executePendingDelete } from './skills/expenses/execute.mjs';
import { getPendingEmail, clearPendingEmail, executePendingEmail } from './skills/email/execute.mjs';
import { getPendingProven, clearPendingProven, executePendingProven } from './skills/profiles/execute.mjs';
import { getRoleManifest, getRoleAssignments, setRoleAssignment, listRoles } from './roles.mjs';
import { interceptScheduling } from './lib/scheduler-intent.mjs';
import { getSlotAssignment } from './lib/voice-devices.mjs';
import { sendToDevice } from './ws-handler.mjs';
import { log } from './logger.mjs';
import {
  loadConfig, loadUsers, saveUsers, getAgentsForUser, detectNewsPref, detectRenameCommand,
  saveUserAgentOverride, getUser, getUserCoordinatorAgentId, recordActivity, recordTokenUsage,
  isUserTimeBlocked,
} from './routes/_helpers.mjs';

// Track active AbortControllers so in-progress runs can be cancelled.
// Keyed by `${userId}_${agentId}` so one user's chat can't abort another user's
// concurrent chat on the same agent id (cross-user DoS).
const abortControllers = new Map();

// Track which agents are actively streaming, so reconnecting clients can be told.
// Same scoped key as abortControllers.
const activeStreams = new Map(); // `${userId}_${agentId}` → { userId, agentId, startTs }

// Track in-flight work per agent (WS *and* delegate) so ask_agent can queue
// behind an active run instead of colliding with it.
const busyPromises = new Map(); // agentId → Promise (resolves when current run ends)

export function isAgentBusy(agentId) {
  return busyPromises.has(agentId);
}

export function waitForAgentIdle(agentId) {
  return busyPromises.get(agentId) ?? Promise.resolve();
}

// Register an in-flight run. Returns a release() fn the caller must invoke on finish.
export function markAgentBusy(agentId) {
  // Serialize: if something is already in flight, chain onto it.
  const prev = busyPromises.get(agentId) ?? Promise.resolve();
  let release;
  const slot = new Promise(res => { release = res; });
  const chained = prev.then(() => slot);
  busyPromises.set(agentId, chained);
  chained.finally(() => {
    if (busyPromises.get(agentId) === chained) busyPromises.delete(agentId);
  });
  return { waitTurn: () => prev, release };
}

export function getActiveStreams(userId) {
  const result = [];
  for (const info of activeStreams.values()) {
    if (info.userId === userId) result.push({ agentId: info.agentId, startTs: info.startTs });
  }
  return result;
}

export function abortChat(userId, agentId) {
  if (!userId || !agentId) return;
  const key = `${userId}_${agentId}`;
  abortControllers.get(key)?.abort();
  abortControllers.delete(key);
  activeStreams.delete(key);
}

export function abortAllChats() {
  for (const [id, ac] of abortControllers) {
    ac.abort();
    abortControllers.delete(id);
  }
  activeStreams.clear();
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
  'list_tasks',
  'create_task',
]);

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
function classifyVoiceIntent(text) {
  if (typeof text !== 'string') return null;
  const t = text.toLowerCase().trim().replace(/[.,!?]+$/, '');
  if (!t) return null;

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

  if (/^pause\b/.test(t))                 return { type: 'pause' };
  if (/^(resume|continue|unpause)\b/.test(t)) return { type: 'resume' };

  // Stop / cancel — barge-in firmware has already killed local audio; we
  // mark this `replaces` so the chat pipeline doesn't generate a reply.
  if (/^(stop|cancel|never\s*mind|shut\s+up|that('s|s)\s+enough)\b/.test(t)) {
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
function executeVoiceIntent(intent, deviceId) {
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
    case 'pause':
      sendToDevice(deviceId, { type: 'pause_playback' });
      return { replaces: true };
    case 'resume':
      sendToDevice(deviceId, { type: 'resume_playback' });
      return { replaces: true };
    case 'stop':
      // Local audio was already stopped by the barge-in handler in
      // firmware when the wake fired. Nothing else to do; just suppress
      // generating a reply.
      return { replaces: true };
  }
  return { replaces: false };
}

export async function handleChatMessage({
  userId,
  agentId: rawAgentId,
  text: rawText,
  attachment: rawAttachment,
  source = null,
  deviceId = null,
  wakeSlot = null,
  onEvent,
  onBroadcast = () => {},
  onNotify    = () => {},
}) {
  // Wake-slot routing — household-shared voice device.
  //
  // When a voice device fires a wake word, the slot index identifies which
  // *user* the resulting chat belongs to. slot 0 might be the admin saying
  // "Sydney" → admin's coordinator; slot 1 might be a roommate saying
  // "Hey Ensemble" → roommate's coordinator. Per-user data isolation comes
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
  userId = effectiveUserId;
  agentId = agentId ?? getUserCoordinatorAgentId(userId);

  // Fast-path: voice-device control intents bypass the LLM entirely.
  // "sydney, volume up" / "pause" / "stop" → regex match → WS message
  // sent to the device, no chat dispatched. Runs only for source ===
  // 'voice-device' so a typed "stop" in a browser chat is still treated
  // as a normal message. Returns immediately on match.
  if (source === 'voice-device' && typeof rawText === 'string') {
    const intent = classifyVoiceIntent(rawText);
    if (intent) {
      const { replaces } = executeVoiceIntent(intent, deviceId);
      console.log(`[chat] voice-intent: ${intent.type}${intent.pct != null ? `=${intent.pct}` : ''} device=${deviceId ?? '?'} replaces=${replaces}`);
      if (replaces) {
        // Short audible confirmation so the user hears that the device
        // got it. Without this, "sydney stop" / "sydney volume 50" applies
        // silently and the user can't tell if anything happened. Routes
        // through the standard chat-event path → accumulator → sentence
        // queue → tts_worker_task → MP3 over the same /api/tts pipeline
        // a normal reply uses.
        //
        // Pause is the one place this is slightly awkward: the pause WS
        // message arrives at the device on a separate path and may apply
        // before the "okay" TTS finishes — accept the rough edge for v1
        // rather than reordering or per-intent confirmation strings.
        const confirmation = intent.type === 'pause' || intent.type === 'resume'
          ? null  // self-evident audio cue — no spoken confirmation needed
          : 'okay.';
        if (confirmation) {
          onEvent({ type: 'token', text: confirmation, agent: agentId });
        }
        onEvent({ type: 'done', agent: agentId });
        return;
      }
    }
  }

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
  // is it" round-trip from 61 s to ~3 s on sydney; dropping reasoning to
  // low was tested but caused the model to skip useful tool calls.
  if (source === 'voice-device' && Array.isArray(agent.tools) && agent.tools.length) {
    const originalCount = agent.tools.length;
    const slim = agent.tools.filter(t => VOICE_DEVICE_TOOL_ALLOWLIST.has(t.function?.name));
    agent = { ...agent, tools: slim };
    console.log(`[chat] voice-device source: tools ${originalCount} → ${slim.length}`);
  }

  // Model restriction check
  if (chatUser?.allowedModels != null && agent.model && !chatUser.allowedModels.includes(agent.model)) {
    onEvent({ type: 'error', message: `Model "${agent.model}" is not available for your account. Ask your admin to grant access.`, agent: agentId });
    return;
  }

  if (!rawText?.trim() && !rawAttachment) return;
  recordActivity(userId, agentId, { message: true });

  // Detect news preference commands
  const newsPrefIdx = detectNewsPref(rawText);
  if (newsPrefIdx !== null) {
    try {
      const list = loadUsers();
      const idx = list.findIndex(u => u.id === userId);
      if (idx !== -1) { list[idx].newsDefaultTopic = newsPrefIdx; saveUsers(list); }
    } catch (e) { console.warn('[chat] Failed to save news preference:', e.message); }
    onEvent({ type: 'news_pref_saved', topic: newsPrefIdx });
  }

  // Detect rename/re-emoji commands
  const rename = detectRenameCommand(rawText);
  if (rename) {
    // Strip null values so we only update what was actually specified
    const changes = Object.fromEntries(Object.entries(rename).filter(([, v]) => v != null));
    // If this is a custom agent owned by the user, update the agent itself
    const customAgent = loadCustomAgents().find(a => a.id === agentId && a.ownerId === userId);
    if (customAgent) {
      updateCustomAgent(agentId, changes);
      // Clear any stale per-user overrides for fields now canonical on the agent
      const list = loadUsers();
      const u = list.find(u => u.id === userId);
      if (u?.agentOverrides?.[agentId]) {
        for (const k of Object.keys(changes)) delete u.agentOverrides[agentId][k];
        saveUsers(list);
      }
    } else {
      saveUserAgentOverride(userId, agentId, changes);
    }
    onBroadcast();
    const newName  = changes.name  ?? agent.name;
    const newEmoji = changes.emoji ?? agent.emoji ?? '';
    const reply = `Got it — I'll go by **${newName}**${newEmoji ? ` ${newEmoji}` : ''} from now on.`;
    onEvent({ type: 'token', text: reply, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: rawText, ts: Date.now() },
      { role: 'assistant', content: reply, ts: Date.now() }
    );
    return;
  }

  const scopedSessionKey = `${userId}_${agentId}`;
  abortControllers.get(scopedSessionKey)?.abort();
  const ac = new AbortController();
  abortControllers.set(scopedSessionKey, ac);
  activeStreams.set(scopedSessionKey, { userId, agentId, startTs: Date.now() });
  // Register this WS run so concurrent delegate calls queue behind it.
  // Key matches the scopedAgent.id used in streamChat (userId-scoped).
  const busySlot = markAgentBusy(scopedSessionKey);

  const scopedAgent = { ...agent, id: `${userId}_${agentId}` };
  {
    const now = new Date();
    const todayStr   = now.toISOString().slice(0, 10);
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const yearStart  = `${now.getFullYear()}-01-01`;
    const financeExtra = agent.skillCategory === 'finance'
      ? `\nUser ID: ${userId ?? 'default'}\nAlways pass this exact User ID to every expense tool call.`
      : '';
    scopedAgent.systemPrompt = `${agent.systemPrompt}\n\n## Current Date\nToday: ${todayStr}\nThis month: ${monthStart} to ${todayStr}\nThis year: ${yearStart} to ${todayStr}${financeExtra}`;
  }

  let userText   = rawText?.trim() ?? '';
  let attachment = rawAttachment ?? null;

  // Intercept "CONFIRM DELETION" — execute staged delete without hitting the model
  if (userText.toUpperCase() === 'CONFIRM DELETION' && getPendingDelete(userId)) {
    const result = await executePendingDelete(userId);
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: result, ts: Date.now() }
    );
    onEvent({ type: 'token', text: result, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    return;
  }
  if (getPendingDelete(userId)) clearPendingDelete(userId);

  // Intercept "APPROVE PURGE" — execute staged destructive email op
  if (userText.toUpperCase() === 'APPROVE PURGE' && getPendingEmail(userId)) {
    const result = await executePendingEmail(userId);
    const text = typeof result === 'string' ? result : (result?.text ?? String(result));
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: text, ts: Date.now() }
    );
    onEvent({ type: 'token', text, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    return;
  }
  if (getPendingEmail(userId)) clearPendingEmail(userId);

  // Intercept "APPROVE PROVEN" — execute staged trust-state promotion to proven
  if (userText.toUpperCase() === 'APPROVE PROVEN' && getPendingProven(userId)) {
    const result = await executePendingProven(userId);
    const text = typeof result === 'string' ? result : (result?.text ?? String(result));
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: text, ts: Date.now() }
    );
    onEvent({ type: 'token', text, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    return;
  }
  if (getPendingProven(userId)) clearPendingProven(userId);

  // /claim <skillId> and /release <skillId>
  const claimMatch = userText.match(/^\/?(claim|release)\s+(\S+)/i);
  if (claimMatch) {
    const action  = claimMatch[1].toLowerCase();
    const skillId = claimMatch[2].toLowerCase();
    const manifest = getRoleManifest(skillId, userId);
    let result;
    if (!manifest) {
      const available = listRoles(userId).filter(m => m.category !== 'delegate' && !m.hidden).map(m => m.id).join(', ');
      result = `No role found with id "${skillId}". Available roles: ${available}`;
    } else if (manifest.category === 'delegate') {
      result = `${manifest.name} is a system role and cannot be assigned.`;
    } else if (action === 'release') {
      const assignments = getRoleAssignments(userId);
      if (assignments[skillId] !== agentId) {
        result = assignments[skillId]
          ? `${manifest.name} is owned by "${assignments[skillId]}", not this agent.`
          : `${manifest.name} isn't assigned to anyone.`;
      } else {
        setRoleAssignment(skillId, null, userId);
        result = `✓ Released **${manifest.name}** — now available to all agents.`;
      }
    } else {
      const assignments = getRoleAssignments(userId);
      const current = assignments[skillId];
      if (current === agentId) {
        result = `${manifest.name} is already assigned to this agent.`;
      } else {
        if (current) result = `✓ **${manifest.name}** transferred from "${current}" to **${agent.name}**.`;
        else result = `✓ **${manifest.name}** is now assigned to **${agent.name}**.`;
        setRoleAssignment(skillId, agentId, userId);
        try {
          const userList = loadUsers();
          const uIdx = userList.findIndex(u => u.id === userId);
          if (uIdx !== -1 && userList[uIdx].skills && !userList[uIdx].skills.includes(skillId)) {
            userList[uIdx].skills.push(skillId);
            saveUsers(userList);
          }
        } catch {}
      }
    }
    appendToSession(`${userId}_${agentId}`,
      { role: 'user', content: userText, ts: Date.now() },
      { role: 'assistant', content: result, ts: Date.now() }
    );
    onEvent({ type: 'token', text: result, agent: agentId });
    onEvent({ type: 'done', agent: agentId });
    return;
  }

  // Finance file upload pre-processing
  const financeAgentId = getRoleAssignments(userId)?.['expenses'];
  if (financeAgentId && agentId === financeAgentId && attachment?.isFinanceFile) {
    try {
      const cfg  = loadConfig();
      const txns = (await extractTransactions(cfg, attachment)).filter(t => parseFloat(t.amount) > 0);
      const block = txns.length ? JSON.stringify(txns, null, 2) : '[]';
      userText = (userText || 'I uploaded a financial statement.') +
        `\n\n<uploaded_statement filename="${attachment.name}">\n${block}\n</uploaded_statement>`;
      const wantsSave = /\b(save|add|store|import|record|put)\b/i.test(userText);
      userText += wantsSave
        ? `\n\n${txns.length} transaction(s) were extracted. The user wants them saved — call expense_add_batch NOW with all transactions, then show a summary table.`
        : `\n\n${txns.length} transaction(s) were extracted. Show them in a table and ask the user if they'd like to save them.`;
    } catch (e) {
      userText = (userText || '') + `\n\n[File upload: ${attachment.name} — extraction failed: ${e.message}]`;
    }
    attachment = null;
  }

  // ── Scheduler-intent interceptor ─────────────────────────────────────────
  // Runs before the LLM on every chat regardless of which agent the user is
  // talking to, so scheduling works system-wide without needing the tasks
  // skill assigned. Matches are routed through the fine-tuned plan model;
  // misses fall through unchanged. The outcome line is prepended as a
  // system note so the agent can narrate success/failure in its reply
  // rather than us sending a canned message.
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

  {
    const _now = new Date();
    const _timeNote = `<current_time>${_now.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</current_time>`;
    schedulerNote = schedulerNote ? `${_timeNote}\n${schedulerNote}` : _timeNote;
  }

  // ── Retriable error patterns for provider failover ──────────────────────
  const RETRIABLE_RE = /\b(5\d{2}|timeout|timed out|rate limit|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed)\b/i;

  let _streamBuf = '';
  async function runStream(agentObj) {
    for await (const event of streamChat(agentObj, userText, ac.signal, (e) => {
      onEvent({ ...e, agent: agentId });
    }, userId ?? 'default', attachment, schedulerNote)) {
      if (event.type === '__notify') { onNotify(userId, agentId, event); continue; }
      if (event.type === '__usage')  { recordTokenUsage(userId, event.inputTokens, event.outputTokens, event.provider, event.model); continue; }
      // Check if this error is retriable — return it instead of emitting
      if (event.type === 'error' && RETRIABLE_RE.test(event.message ?? '')) {
        return event; // signal caller to attempt failover
      }
      // Accumulate stream content for persistence buffer
      if (event.type === 'token')   _streamBuf += event.text;
      if (event.type === 'replace') _streamBuf = event.text;
      if (_streamBuf) writeStreamBuffer(scopedSessionKey, _streamBuf);
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
    recordActivity(userId, agentId, { apiCall: true });
    abortControllers.delete(scopedSessionKey);
    activeStreams.delete(scopedSessionKey);
    clearStreamBuffer(scopedSessionKey);
    busySlot.release();
  }
}
