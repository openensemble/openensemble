/**
 * chat-dispatch.mjs
 * Platform-agnostic chat handler — used by WebSocket (server.mjs) and Telegram (routes/telegram.mjs).
 */

import { getAgent, updateCustomAgent, loadCustomAgents } from './agents.mjs';
import { streamChat } from './chat.mjs';
import { appendToSession, writeStreamBuffer, clearStreamBuffer } from './sessions.mjs';
import { extractTransactions, getPendingDelete, clearPendingDelete, executePendingDelete } from './skills/expenses/execute.mjs';
import { getRoleManifest, getRoleAssignments, setRoleAssignment, listRoles } from './roles.mjs';
import { interceptScheduling } from './lib/scheduler-intent.mjs';
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
export async function handleChatMessage({
  userId,
  agentId: rawAgentId,
  text: rawText,
  attachment: rawAttachment,
  onEvent,
  onBroadcast = () => {},
  onNotify    = () => {},
}) {
  const agentId = rawAgentId ?? getUserCoordinatorAgentId(userId);
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
  const agent = getAgentsForUser(userId).find(a => a.id === agentId);
  if (!agent) {
    onEvent({ type: 'error', message: `Unknown agent: ${agentId}`, agent: agentId });
    return;
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
      const intercept = await interceptScheduling({ userId, agentId, text: userText });
      if (intercept.matched) {
        schedulerNote = `<scheduler_result>\n${intercept.outcome}\n</scheduler_result>`;
      }
    } catch (e) {
      console.warn('[chat-dispatch] scheduler intercept threw:', e.message);
    }
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
      // Attempt failover on thrown errors too (e.g. fetch failures)
      const cfg = loadConfig();
      const fo = cfg.providerFailover;
      if (fo?.enabled && fo?.fallbackProvider && fo?.fallbackModel && RETRIABLE_RE.test(e.message ?? '')) {
        console.log(`[failover] Primary threw: ${e.message} — trying ${fo.fallbackProvider}/${fo.fallbackModel}`);
        onEvent({ type: 'token', text: `_Retrying with ${fo.fallbackProvider}/${fo.fallbackModel}…_\n\n`, agent: agentId });
        try {
          const fallbackAgent = { ...scopedAgent, provider: fo.fallbackProvider, model: fo.fallbackModel };
          const fallbackError = await runStream(fallbackAgent);
          if (fallbackError) onEvent({ ...fallbackError, agent: agentId });
        } catch (e2) {
          if (e2.name !== 'AbortError') onEvent({ type: 'error', message: e2.message, agent: agentId });
        }
      } else {
        onEvent({ type: 'error', message: e.message, agent: agentId });
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
