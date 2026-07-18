// Chat send outbox / retry / reconnect reconciliation.
// Loaded before chat.js (see index.html). Globals are intentional — classic
// multi-script UI, no bundler.
// Extracted from chat.js — pure move.

// Retry/idempotency state. messageId identifies the logical user message;
// attemptId identifies one execution. A lost ACK may resend the same attempt
// safely, while an explicit Retry keeps messageId and mints a new attemptId.
let lastSentAttempt = null; // { agent, text, attachments, messageId, attemptId, userBubbleEl, sessionEntry }
let failedAttempt = null;   // same shape + errorEl — set once a turn has errored
const LEGACY_CHAT_OUTBOX_KEY = 'oe.chatOutbox.v1';
const CHAT_OUTBOX_PREFIX = 'oe.chatOutbox.v2:';
const CHAT_OUTBOX_TOMBSTONE_PREFIX = 'oe.chatOutboxDone.v2:';
const CHAT_OUTBOX_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const pendingSentAttempts = new Map();
let _outboxLoadedUserId = null;

function currentOutboxUserId() {
  return (typeof _currentUser !== 'undefined' && _currentUser?.id) ? String(_currentUser.id) : null;
}

function safeOutboxAttachments(attachments) {
  return (attachments || []).map(a => ({
    name: a?.name ?? null,
    mimeType: a?.mimeType ?? null,
    isImage: Boolean(a?.isImage),
    isFinanceFile: Boolean(a?.isFinanceFile),
    file_id: a?.file_id ?? null,
    extractedText: typeof a?.extractedText === 'string' ? a.extractedText.slice(0, 30_000) : null,
  })).filter(a => a.file_id);
}

function outboxUserPrefix(prefix, userId) {
  return `${prefix}${encodeURIComponent(userId)}:`;
}

function outboxAttemptKey(userId, attemptId) {
  return `${outboxUserPrefix(CHAT_OUTBOX_PREFIX, userId)}${attemptId}`;
}

function outboxTombstoneKey(userId, attemptId) {
  return `${outboxUserPrefix(CHAT_OUTBOX_TOMBSTONE_PREFIX, userId)}${attemptId}`;
}

function serializeOutboxAttempt(attempt) {
  return {
    agent: attempt.agent,
    text: attempt.text || '',
    attachments: safeOutboxAttachments(attempt.attachments),
    toolPlan: attempt.toolPlan || null,
    displayText: attempt.displayText || attempt.text || '',
    messageId: attempt.messageId,
    attemptId: attempt.attemptId,
    createdAt: attempt.createdAt || Date.now(),
    accepted: attempt.accepted === true,
  };
}

function isOutboxTombstoned(userId, attemptId) {
  try { return Boolean(localStorage.getItem(outboxTombstoneKey(userId, attemptId))); }
  catch { return false; }
}

function writeOutboxAttempt(attempt) {
  const userId = currentOutboxUserId();
  if (!userId || !attempt?.attemptId) return;
  try {
    if (isOutboxTombstoned(userId, attempt.attemptId)) {
      pendingSentAttempts.delete(attempt.attemptId);
      localStorage.removeItem(outboxAttemptKey(userId, attempt.attemptId));
      return;
    }
    localStorage.setItem(
      outboxAttemptKey(userId, attempt.attemptId),
      JSON.stringify(serializeOutboxAttempt(attempt)),
    );
  } catch {}
}

function tombstoneOutboxAttempt(attemptId) {
  const userId = currentOutboxUserId();
  if (!userId || !attemptId) return;
  try {
    // Tombstone first: another tab with a stale in-memory copy can never
    // recreate the entry after this terminal observation.
    localStorage.setItem(outboxTombstoneKey(userId, attemptId), JSON.stringify({ ts: Date.now() }));
    localStorage.removeItem(outboxAttemptKey(userId, attemptId));
  } catch {}
}

function ensureChatOutboxLoaded() {
  const userId = currentOutboxUserId();
  if (!userId || _outboxLoadedUserId === userId) return;
  pendingSentAttempts.clear();
  _outboxLoadedUserId = userId;
  const entryPrefix = outboxUserPrefix(CHAT_OUTBOX_PREFIX, userId);
  const tombstonePrefix = outboxUserPrefix(CHAT_OUTBOX_TOMBSTONE_PREFIX, userId);
  try {
    // One key per attempt avoids read/modify/write lost updates when two tabs
    // send concurrently. Tombstones are also per attempt for the same reason.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith(tombstonePrefix)) {
        try {
          const ts = Number(JSON.parse(localStorage.getItem(key) || '{}').ts) || 0;
          if (ts && Date.now() - ts > CHAT_OUTBOX_TOMBSTONE_TTL_MS) {
            const attemptId = key.slice(tombstonePrefix.length);
            // Delete any stale-tab resurrection before expiring its guard.
            localStorage.removeItem(outboxAttemptKey(userId, attemptId));
            localStorage.removeItem(key);
          }
        } catch {}
        continue;
      }
      if (!key.startsWith(entryPrefix)) continue;
      let row;
      try { row = JSON.parse(localStorage.getItem(key) || '{}'); }
      catch { continue; }
      if (!row?.attemptId || !row?.messageId || !row?.agent) continue;
      if (isOutboxTombstoned(userId, row.attemptId)) {
        localStorage.removeItem(key);
        continue;
      }
      pendingSentAttempts.set(row.attemptId, {
        ...row,
        attachments: safeOutboxAttachments(row.attachments),
        accepted: row.accepted === true,
        restoredFromOutbox: true,
      });
    }

    // One-time compatibility read for tabs that loaded the first stability
    // patch before v2's per-attempt keys.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_CHAT_OUTBOX_KEY) || '{}');
    for (const row of (Array.isArray(legacy[userId]) ? legacy[userId] : [])) {
      if (!row?.attemptId || !row?.messageId || !row?.agent) continue;
      if (pendingSentAttempts.has(row.attemptId) || isOutboxTombstoned(userId, row.attemptId)) continue;
      const migrated = {
        ...row, attachments: safeOutboxAttachments(row.attachments),
        accepted: row.accepted === true, restoredFromOutbox: true,
      };
      pendingSentAttempts.set(row.attemptId, migrated);
      writeOutboxAttempt(migrated);
    }
    // Remove only this user's migrated bucket, preserving any other signed-in
    // profiles on the same browser. Otherwise an expired v2 tombstone could let
    // the immutable v1 copy reappear and execute again days later.
    if (Object.prototype.hasOwnProperty.call(legacy, userId)) {
      delete legacy[userId];
      if (Object.keys(legacy).length) localStorage.setItem(LEGACY_CHAT_OUTBOX_KEY, JSON.stringify(legacy));
      else localStorage.removeItem(LEGACY_CHAT_OUTBOX_KEY);
    }
  } catch {}
}

function registerPendingAttempt(attempt) {
  ensureChatOutboxLoaded();
  const tracked = { createdAt: Date.now(), accepted: false, ...attempt };
  const userId = currentOutboxUserId();
  if (userId && isOutboxTombstoned(userId, tracked.attemptId)) return tracked;
  pendingSentAttempts.set(tracked.attemptId, tracked);
  writeOutboxAttempt(tracked);
  return tracked;
}

function pendingAttemptForId(attemptId) {
  ensureChatOutboxLoaded();
  return attemptId ? (pendingSentAttempts.get(attemptId) || null) : null;
}

function acceptPendingAttempt(attemptId) {
  ensureChatOutboxLoaded();
  const attempt = pendingSentAttempts.get(attemptId);
  if (!attempt) return null;
  attempt.accepted = true;
  writeOutboxAttempt(attempt);
  return attempt;
}

function finishPendingAttempt(attemptId) {
  if (!attemptId) return null;
  ensureChatOutboxLoaded();
  const attempt = pendingSentAttempts.get(attemptId) || null;
  tombstoneOutboxAttempt(attemptId);
  pendingSentAttempts.delete(attemptId);
  return attempt;
}

function clearPendingAttemptsForAgent(agent) {
  ensureChatOutboxLoaded();
  for (const [attemptId, attempt] of pendingSentAttempts) {
    if (attempt.agent !== agent) continue;
    tombstoneOutboxAttempt(attemptId);
    pendingSentAttempts.delete(attemptId);
  }
}

function replayPendingAttempt(attempt, connectionGeneration) {
  if (!attempt || attempt.lastReplayGeneration === connectionGeneration) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  attempt.lastReplayGeneration = connectionGeneration;
  const replay = {
    type: 'chat', agent: attempt.agent, text: attempt.text || '',
    message_id: attempt.messageId, attempt_id: attempt.attemptId,
  };
  if (attempt.attachments?.length) replay.attachments = attempt.attachments;
  if (attempt.toolPlan) replay.toolPlan = attempt.toolPlan;
  ws.send(JSON.stringify(replay));
}

// Called by websocket.js after an authoritative session load. The same attempt
// id is safe to replay repeatedly; one replay per connection avoids bursts from
// the initial all-agent load plus the active-agent safety-net load.
function reconcilePendingAttemptsFromSession(agent, serverMsgs, connectionGeneration, activeStream = null) {
  ensureChatOutboxLoaded();
  const rows = serverMsgs || [];
  for (const [attemptId, attempt] of pendingSentAttempts) {
    if (attempt.agent !== agent) continue;
    const matchingRows = rows.filter(row => row?.attemptId === attemptId || row?.turnId === attemptId);
    // Only the whole-turn marker proves assistant/failure + every post-turn
    // approval/attachment artifact are durable. A bare assistant/turn_error row
    // is still `finalizing` and the same attempt must remain replayable.
    if (matchingRows.some(row => row?.role === 'turn_terminal')) {
      finishPendingAttempt(attemptId);
      continue;
    }
    if (!matchingRows.length && attempt.lastError && attempt.lastError.retryable !== true) {
      finishPendingAttempt(attemptId);
      continue;
    }
    if (matchingRows.some(row => row?.role === 'user')) acceptPendingAttempt(attemptId);
    if (!sessions[agent]) sessions[agent] = [];
    if (!matchingRows.some(row => row?.role === 'user')) {
      const optimistic = {
        role: 'user', content: attempt.displayText || attempt.text || '',
        ts: attempt.createdAt || Date.now(), attachments: attempt.attachments || [],
        messageId: attempt.messageId, attemptId, turnId: attemptId, turnStatus: 'running',
      };
      if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[agent], optimistic))) {
        sessions[agent].push(optimistic);
      }
    }
    const activeAttemptId = activeStream?.attemptId || activeStream?.turnId || null;
    if (activeAttemptId !== attemptId) replayPendingAttempt(attempt, connectionGeneration);
  }
}

window.addEventListener('storage', event => {
  const userId = currentOutboxUserId();
  if (!userId || !event.key) return;
  const entryPrefix = outboxUserPrefix(CHAT_OUTBOX_PREFIX, userId);
  const tombstonePrefix = outboxUserPrefix(CHAT_OUTBOX_TOMBSTONE_PREFIX, userId);
  if (event.key.startsWith(tombstonePrefix) && event.newValue) {
    const attemptId = event.key.slice(tombstonePrefix.length);
    pendingSentAttempts.delete(attemptId);
    try { localStorage.removeItem(outboxAttemptKey(userId, attemptId)); } catch {}
    return;
  }
  if (!event.key.startsWith(entryPrefix)) return;
  const attemptId = event.key.slice(entryPrefix.length);
  if (!event.newValue || isOutboxTombstoned(userId, attemptId)) {
    pendingSentAttempts.delete(attemptId);
    if (event.newValue) {
      try { localStorage.removeItem(event.key); } catch {}
    }
    return;
  }
  try {
    const row = JSON.parse(event.newValue);
    if (row?.attemptId === attemptId && row?.messageId && row?.agent) {
      const prior = pendingSentAttempts.get(attemptId);
      pendingSentAttempts.set(attemptId, {
        ...row, attachments: safeOutboxAttachments(row.attachments),
        accepted: row.accepted === true, restoredFromOutbox: true,
        ...(prior?.lastReplayGeneration != null ? { lastReplayGeneration: prior.lastReplayGeneration } : {}),
        ...(prior?.lastError ? { lastError: prior.lastError } : {}),
      });
    }
  } catch {}
});

function makeChatCorrelationId(prefix) {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${id.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

