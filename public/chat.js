// ── Attachment state ──────────────────────────────────────────────────────────
// Array, not a single slot — index.html's #chatFileInput now has `multiple`,
// and drag-drop/paste can each add one more on top. Each item is the raw
// /api/chat-upload response ({ name, mimeType, isImage, isFinanceFile,
// file_id, base64, extractedText }) plus a client-only `_localKey` (tray
// remove-button identity) and `_uploading` while its upload is in flight.
//
// send() puts the WHOLE tray on the wire as `attachments: [...]` (server-side
// entry-edge normalization lives in chat-dispatch.mjs's handleChatMessage —
// see normalizeAttachments in chat/providers/_shared.mjs — and threads through
// to chat.mjs's per-provider vision-message builder, which now accepts N
// images). MAX_CHAT_ATTACHMENTS_PER_MESSAGE below caps how many files one tray
// (and therefore one message) can hold; _uploadAndAddAttachment enforces it
// with a toast at the point a file would be added, so the cap is felt at
// upload time, not as a surprise at send time.
const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 6; // mirrors MAX_CHAT_ATTACHMENTS in chat/providers/_shared.mjs
let pendingAttachments = [];
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

// ── Per-agent draft persistence ──────────────────────────────────────────────
// The composer is one shared <textarea> — without this, a half-typed message
// silently follows the user across agent tabs and evaporates on reload.
// Keyed by agent id in localStorage so it survives reload. Saved debounced on
// every keystroke; switchAgent (public/agents.js) also calls saveDraftForAgent
// synchronously right before it swaps activeAgent, so a fast switch can't
// lose the last few keystrokes to a pending debounce timer. Cleared once a
// message actually sends (see send()); restored on agent switch (same
// switchAgent hook) and on page load / reconnect (websocket.js session_loaded).
const DRAFT_STORAGE_KEY = 'oe.composerDrafts.v1';
const DRAFT_SAVE_DEBOUNCE_MS = 400;
let _draftSaveTimer = null;

function _loadDrafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}'); } catch { return {}; }
}
function _writeDrafts(drafts) {
  // localStorage can throw (Safari private mode, quota exceeded) — a draft
  // failing to save must never interrupt typing or sending.
  try { localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(drafts)); } catch {}
}

function saveDraftForAgent(agentId) {
  if (!agentId) return;
  const text = $('input')?.value ?? '';
  const drafts = _loadDrafts();
  if (text) drafts[agentId] = text; else delete drafts[agentId];
  _writeDrafts(drafts);
}

function restoreDraftForAgent(agentId) {
  const input = $('input');
  if (!input || !agentId) return;
  input.value = _loadDrafts()[agentId] || '';
  resizeTextarea();
}

function clearDraftForAgent(agentId) {
  if (!agentId) return;
  const drafts = _loadDrafts();
  if (agentId in drafts) { delete drafts[agentId]; _writeDrafts(drafts); }
}

(function _initDraftPersistence() {
  const attach = () => {
    const input = $('input');
    if (!input) return;
    input.addEventListener('input', () => {
      clearTimeout(_draftSaveTimer);
      _draftSaveTimer = setTimeout(() => saveDraftForAgent(activeAgent), DRAFT_SAVE_DEBOUNCE_MS);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();

// ── Pre-send tool planning ───────────────────────────────────────────────────
const TOOL_PLAN_STORAGE_KEY = 'oe.toolPlanRecipes.v1';
const TOOL_PLAN_MIN_SCORE = 0.58;
const TOOL_PLAN_MAX_RECIPES = 80;
const TOOL_PLAN_CATALOG = [
  { name: 'email_list', label: 'Fetch recent emails', desc: 'Reads recent inbox messages for the selected/default account.', group: 'Email', re: /\b(?:show|check|read|list|summari[sz]e|triage|any|new|latest|recent)\b.{0,45}\b(?:emails?|mail|inbox|messages?)\b/i },
  { name: 'email_read', label: 'Read one email', desc: 'Opens the full body of a specific email when an ID is already known.', group: 'Email', re: /\b(?:read|open|show)\b.{0,25}\b(?:that|it|email|message)\b/i },
  { name: 'email_thread', label: 'Read email thread', desc: 'Gets the full conversation thread for an email.', group: 'Email', re: /\b(?:thread|conversation|full chain|whole email)\b/i },
  { name: 'email_batch_trash', label: 'Delete selected emails', desc: 'Moves multiple already-known email IDs to trash in one call.', group: 'Email', re: /\b(?:delete|trash|remove)\b.{0,35}\b(?:emails?|messages?|mail|ones?|them|\d)\b/i },
  { name: 'email_trash', label: 'Delete one email', desc: 'Moves one already-known email to trash.', group: 'Email', re: /\b(?:delete|trash|remove)\b.{0,20}\b(?:it|that|email|message)\b/i },
  { name: 'email_count', label: 'Count emails', desc: 'Gets an exact Gmail count, useful for “how many are left”.', group: 'Email', re: /\b(?:how many|count|left|remaining|to go|still need)\b.{0,50}\b(?:emails?|mail|labels?|labeling|unsorted)\b/i },
  { name: 'email_sort_local', label: 'Sort using learned rules', desc: 'Uses local learned sender rules before asking the model to judge emails.', group: 'Email', re: /\b(?:sort|organize|file|label)\b.{0,35}\b(?:emails?|mail|inbox)\b/i },
  { name: 'email_list_labels', label: 'List email labels', desc: 'Reads existing Gmail labels so the agent can reuse them.', group: 'Email', re: /\b(?:labels?|folders?)\b/i },
  { name: 'email_learned_labels', label: 'Show learned label rules', desc: 'Shows what OE has learned about sender-to-label mappings.', group: 'Email', re: /\b(?:learned|remembered|rules?|corrections?|mapping)\b.{0,45}\b(?:labels?|email|sender|budget)\b/i },
  { name: 'email_correct_label', label: 'Save label rule', desc: 'Stores a correction for how future mail from a sender should be labeled.', group: 'Email', re: /\b(?:should go|belongs?|label|file)\b.{0,65}\b(?:as|to|under|in)\b/i },
  { name: 'email_remove_label_correction', label: 'Delete learned label rule', desc: 'Removes explicit saved label corrections while keeping observed learning.', group: 'Email', re: /\b(?:delete|remove|forget|undo|clear)\b.{0,55}\b(?:learned|label|correction|rule|mapping|budget)\b/i },
  { name: 'email_label_query', label: 'Relabel matching emails', desc: 'Applies label changes to all Gmail messages matching a search.', group: 'Email', re: /\b(?:move|label|archive|relabel)\b.{0,55}\b(?:all|everything|from|matching)\b/i },
  { name: 'email_batch_label', label: 'Label selected emails', desc: 'Adds or removes labels on already-known email IDs.', group: 'Email', re: /\b(?:move|label|archive|file)\b.{0,35}\b(?:emails?|messages?|them|these|selected|\d)\b/i },
  { name: 'email_purge_sender', label: 'Bulk delete matching emails', desc: 'Finds all messages from a sender/query and trashes them in one operation.', group: 'Email', re: /\b(?:purge|delete all|trash all|get rid of|clean up)\b.{0,45}\b(?:from|sender|emails?|mail)\b/i },
  { name: 'email_list_accounts', label: 'List email accounts', desc: 'Only needed when the account is unknown or the user asks about accounts.', group: 'Email', re: /\b(?:email accounts?|which account|work email|personal email)\b/i },
  { name: 'email_compose', label: 'Send email', desc: 'Composes and sends an email when an email-capable agent has this tool.', group: 'Email', re: /\b(?:send|email|mail|forward)\b.{0,60}\b(?:to\s+my\s+email|to\s+me|me|myself|my\s+address)\b/i },
  { name: 'ask_agent', label: 'Ask another agent', desc: 'Delegates work to another agent, usually in the background.', group: 'Agents', re: /\b(?:(?:ask|delegate|have|tell)\b.{0,45}\b(?:agent|assistant|specialist|someone|email|send|mail)|(?:send|email|mail|forward)\b.{0,60}\b(?:to\s+my\s+email|to\s+me|me|myself|my\s+address))\b/i },
  { name: 'request_tools', label: 'Load more tools', desc: 'Lets the model request another tool group mid-turn if the first set is missing something.', group: 'System', re: /\b(?:tool|tools|access|available)\b/i },
  { name: 'web_search', label: 'Search the web', desc: 'Looks up current information on the web.', group: 'Web', re: /\b(?:search|look up|google|latest|news|current|today)\b/i },
  { name: 'fetch_url', label: 'Fetch a web page', desc: 'Reads a specific URL the user supplied.', group: 'Web', re: /https?:\/\/\S+/i },
  { name: 'set_reminder', label: 'Set reminder', desc: 'Creates a reminder.', group: 'Tasks', re: /\b(?:remind me|set a reminder|reminder)\b/i },
  { name: 'schedule_task', label: 'Schedule task', desc: 'Creates a scheduled or repeating task/watch.', group: 'Tasks', re: /\b(?:schedule|every day|every week|watch|monitor|check .* later)\b/i },
  { name: 'list_watches', label: 'List watches', desc: 'Shows active watches/monitors.', group: 'Tasks', re: /\b(?:list|show|what)\b.{0,35}\b(?:watches|monitors|scheduled)\b/i },
  { name: 'cancel_watch', label: 'Cancel watch', desc: 'Cancels an active watch/monitor.', group: 'Tasks', re: /\b(?:cancel|stop|delete)\b.{0,35}\b(?:watch|monitor)\b/i },
  { name: 'remember_fact', label: 'Remember fact', desc: 'Stores a durable user memory/fact.', group: 'Memory', re: /\b(?:remember|save this|keep in mind)\b/i },
  { name: 'recall_facts', label: 'Recall memory', desc: 'Searches stored memories/facts.', group: 'Memory', re: /\b(?:what do you remember|recall|memory|memories)\b/i },
  { name: 'forget_fact', label: 'Forget memory', desc: 'Removes a stored memory/fact.', group: 'Memory', re: /\b(?:forget|delete memory|remove memory)\b/i },
];

// ask_agent is a mode-gated control-plane capability, not an ordinary tool.
// Keep every picker path (suggestions, add menu, remembered recipes, manual
// exact-name entry, and the final send payload) aligned with the stored
// orchestration setting. Never infer this from `agents.length`: a one-agent
// ensemble still has ask_agent, while single mode does not.
function toolPlanToolAvailable(name, policy = (typeof _currentUser !== 'undefined' ? _currentUser?.orchestration : null)) {
  return name !== 'ask_agent' || policy?.mode !== 'single';
}

function availableToolPlanCatalog(policy = (typeof _currentUser !== 'undefined' ? _currentUser?.orchestration : null)) {
  return TOOL_PLAN_CATALOG.filter(tool => toolPlanToolAvailable(tool.name, policy));
}

function availableToolPlanNames(toolNames, policy = (typeof _currentUser !== 'undefined' ? _currentUser?.orchestration : null)) {
  const candidates = toolNames != null
    && typeof toolNames !== 'string'
    && typeof toolNames[Symbol.iterator] === 'function'
    ? Array.from(toolNames)
    : [];
  return [...new Set(candidates.filter(name => typeof name === 'string' && name && toolPlanToolAvailable(name, policy)))];
}

let toolPlanState = {
  mode: 'auto',
  expanded: false,
  selected: new Set(),
  suggestions: [],
  recipe: null,
  remember: false,
  dirty: false,
};

function normalizeToolPhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/[^\w@.]+/g, ' ')
    .replace(/\b\d+\b/g, ' number ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toolPhraseTokens(text) {
  const stop = new Set(['the', 'a', 'an', 'to', 'for', 'my', 'me', 'i', 'you', 'and', 'or', 'that', 'this', 'it', 'please']);
  return normalizeToolPhrase(text).split(' ').filter(t => t.length > 1 && !stop.has(t));
}

function tokenScore(a, b) {
  const at = new Set(toolPhraseTokens(a));
  const bt = new Set(toolPhraseTokens(b));
  if (!at.size || !bt.size) return 0;
  let overlap = 0;
  for (const t of at) if (bt.has(t)) overlap++;
  return overlap / Math.max(at.size, bt.size);
}

// Parsed once and reused — matchToolRecipe runs on every picker render
// (every composer keystroke) and used to JSON.parse the whole store each
// time. Invalidated on save and on cross-tab storage events.
let _toolRecipesCache = null;
window.addEventListener('storage', (e) => {
  if (e.key === TOOL_PLAN_STORAGE_KEY) _toolRecipesCache = null;
});
function loadToolRecipes() {
  if (_toolRecipesCache) return _toolRecipesCache;
  try {
    const parsed = JSON.parse(localStorage.getItem(TOOL_PLAN_STORAGE_KEY) || '[]');
    return (_toolRecipesCache = Array.isArray(parsed) ? parsed : []);
  } catch { return (_toolRecipesCache = []); }
}

function saveToolRecipes(recipes) {
  _toolRecipesCache = null;
  try { localStorage.setItem(TOOL_PLAN_STORAGE_KEY, JSON.stringify(recipes.slice(0, TOOL_PLAN_MAX_RECIPES))); } catch {}
}

function matchToolRecipe(text, agentId = activeAgent) {
  let best = null;
  for (const r of loadToolRecipes()) {
    if (r.agentId && r.agentId !== agentId) continue;
    const examples = Array.isArray(r.examples) ? r.examples : [];
    for (const ex of examples) {
      const score = tokenScore(text, ex);
      if (score >= TOOL_PLAN_MIN_SCORE && (!best || score > best.score)) best = { ...r, score };
    }
  }
  return best;
}

function rememberToolRecipe(text, selectedTools, mode = 'selected', agentId = activeAgent) {
  const cleanTools = availableToolPlanNames(selectedTools);
  if (!text?.trim()) return;
  if (mode === 'selected' && !cleanTools.length) return;
  const norm = normalizeToolPhrase(text);
  const recipes = loadToolRecipes();
  const targetAgentId = agentId || activeAgent;
  const existing = recipes.find(r => r.agentId === targetAgentId && (r.examples || []).some(ex => tokenScore(ex, norm) >= 0.8));
  const entry = existing || {
    id: `tool_recipe_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    agentId: targetAgentId,
    examples: [],
    createdAt: Date.now(),
  };
  entry.examples = [text.trim(), ...(entry.examples || []).filter(ex => normalizeToolPhrase(ex) !== norm)].slice(0, 6);
  entry.mode = mode;
  entry.selectedTools = cleanTools;
  entry.updatedAt = Date.now();
  if (!existing) recipes.unshift(entry);
  saveToolRecipes(recipes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
  try {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'tool_plan_remember',
        agentId: targetAgentId,
        phrase: text.trim(),
        selectedTools: cleanTools,
        mode,
        source: 'chat-ui',
      }));
    }
  } catch {}
}

function toolCatalogEntry(name) {
  return TOOL_PLAN_CATALOG.find(t => t.name === name) || {
    name,
    label: toolDisplayLabel(name, {}),
    desc: 'Tool used by this agent.',
    group: 'Other',
  };
}

function renderToolPlanAddOptions(excludedNames = new Set()) {
  const groups = new Map();
  for (const item of availableToolPlanCatalog()) {
    if (excludedNames.has(item.name)) continue;
    const group = item.group || 'Other';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  const html = ['<option value="">Add tool...</option>'];
  for (const [group, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    html.push(`<optgroup label="${escHtml(group)}">`);
    for (const item of items.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name))) {
      html.push(`<option value="${escHtml(item.name)}">${escHtml(item.label || item.name)} (${escHtml(item.name)})</option>`);
    }
    html.push('</optgroup>');
  }
  return html.join('');
}

function detectToolSuggestions(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('@')) return { suggestions: [], recipe: null };
  const recipe = matchToolRecipe(trimmed);
  const hits = [];
  for (const item of availableToolPlanCatalog()) {
    if (item.re?.test(trimmed)) hits.push({ ...item, source: 'suggested' });
  }
  if (/^\s*(?:ok|yes|do it|delete them|trash them|move them|label them)\s*$/i.test(trimmed)) {
    hits.push({ ...toolCatalogEntry('email_batch_trash'), source: 'context' });
    hits.push({ ...toolCatalogEntry('email_batch_label'), source: 'context' });
  }
  if (recipe?.selectedTools?.length) {
    for (const name of availableToolPlanNames(recipe.selectedTools)) {
      if (!hits.some(h => h.name === name)) hits.unshift({ ...toolCatalogEntry(name), source: 'remembered' });
    }
  }
  const byName = new Map();
  for (const h of hits) byName.set(h.name, h);
  return { suggestions: [...byName.values()].slice(0, 8), recipe };
}

function renderToolPlanPicker() {
  const el = $('toolPlanPicker');
  if (!el) return;
  const text = $('input')?.value?.trim() || '';
  const availableSelected = availableToolPlanNames(toolPlanState.selected);
  if (availableSelected.length !== toolPlanState.selected.size) {
    toolPlanState.selected = new Set(availableSelected);
    if (toolPlanState.mode === 'selected' && !toolPlanState.selected.size) toolPlanState.mode = 'auto';
  }
  const shouldShow = !!text && !text.startsWith('/') && !text.startsWith('@');
  if (!shouldShow) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const { suggestions, recipe } = detectToolSuggestions(text);
  if (!toolPlanState.dirty || toolPlanState._text !== text) {
    const textChanged = toolPlanState._text !== text;
    toolPlanState._text = text;
    toolPlanState.suggestions = suggestions;
    toolPlanState.recipe = recipe;
    toolPlanState.remember = false;
    if (textChanged) toolPlanState.dirty = false;
    // RESTORED DEFAULT: do NOT auto-pin tools. OE gets the full toolset and the
    // agent picks the right one — the way it worked before per-turn tool plans.
    // Auto-selecting from a saved recipe or keyword suggestion was sending a hard
    // tool constraint with every message, which stripped specialists of the tools
    // they actually needed (e.g. a research agent left without research tools) and
    // forced them to escalate via ask_agent. Suggestions and any saved recipe are
    // still shown below so the user can opt in MANUALLY, but nothing is
    // pre-selected; a manual pick sets dirty=true and is preserved as before.
    toolPlanState.mode = 'auto';
    toolPlanState.selected = new Set();
  }
  const selectedCount = toolPlanState.mode === 'selected' ? toolPlanState.selected.size : 0;
  const summary = toolPlanState.mode === 'none'
    ? 'No tools'
    : toolPlanState.mode === 'selected'
      ? `${selectedCount} selected`
      : 'OE decides';
  const source = recipe ? 'remembered' : suggestions.length ? 'suggested' : 'manual';
  const allVisible = [...suggestions];
  for (const name of toolPlanState.selected) {
    if (!allVisible.some(t => t.name === name)) allVisible.push(toolCatalogEntry(name));
  }
  const visibleNames = new Set(allVisible.map(t => t.name));
  el.style.display = 'block';
  el.innerHTML = `
    <div class="tool-plan-head">
      <button class="tool-plan-toggle" type="button" aria-expanded="${toolPlanState.expanded ? 'true' : 'false'}">
        ${icon('wrench', 14)}
        <span>Tools</span>
        <strong>${escHtml(summary)}</strong>
        <em>${escHtml(source)}</em>
        ${icon('chevron-down', 13)}
      </button>
      <div class="tool-plan-modes" role="group" aria-label="Tool mode">
        <button type="button" class="${toolPlanState.mode === 'selected' ? 'active' : ''}" data-tool-plan-mode="selected">Selected</button>
        <button type="button" class="${toolPlanState.mode === 'auto' ? 'active' : ''}" data-tool-plan-mode="auto">OE decides</button>
        <button type="button" class="${toolPlanState.mode === 'none' ? 'active' : ''}" data-tool-plan-mode="none">None</button>
      </div>
    </div>
    <div class="tool-plan-body" ${toolPlanState.expanded ? '' : 'hidden'}>
      ${allVisible.length ? allVisible.map(t => {
        const checked = toolPlanState.selected.has(t.name) ? 'checked' : '';
        return `<label class="tool-plan-row">
          <input type="checkbox" data-tool-plan-tool="${escHtml(t.name)}" ${checked}>
          <span class="tool-plan-row-main">
            <span class="tool-plan-row-label">${escHtml(t.label || t.name)}</span>
            <span class="tool-plan-row-desc">${escHtml(t.desc || '')}</span>
          </span>
          <code>${escHtml(t.name)}</code>
        </label>`;
      }).join('') : `<div class="tool-plan-empty">No obvious tools matched. Choose “OE decides” or type a clearer action.</div>`}
      <div class="tool-plan-add">
        <select id="toolPlanAddSelect" aria-label="Add a known tool">
          ${renderToolPlanAddOptions(visibleNames)}
        </select>
        <input id="toolPlanAddName" type="text" inputmode="text" autocomplete="off" placeholder="Exact tool name">
        <button type="button" data-tool-plan-add title="Add tool">${icon('plus', 13)}<span>Add</span></button>
      </div>
      <label class="tool-plan-remember">
        <input type="checkbox" id="toolPlanRemember" ${toolPlanState.remember ? 'checked' : ''}>
        <span>Remember this tool choice for similar wording</span>
      </label>
    </div>`;
  el.querySelector('.tool-plan-toggle')?.addEventListener('click', () => {
    toolPlanState.expanded = !toolPlanState.expanded;
    renderToolPlanPicker();
  });
  el.querySelectorAll('[data-tool-plan-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      toolPlanState.mode = btn.dataset.toolPlanMode;
      toolPlanState.dirty = true;
      if (toolPlanState.mode === 'selected' && !toolPlanState.selected.size && toolPlanState.suggestions.length) {
        toolPlanState.selected = new Set(toolPlanState.suggestions.map(s => s.name));
      }
      renderToolPlanPicker();
    });
  });
  el.querySelectorAll('[data-tool-plan-tool]').forEach(input => {
    input.addEventListener('change', () => {
      const name = input.dataset.toolPlanTool;
      if (input.checked) toolPlanState.selected.add(name);
      else toolPlanState.selected.delete(name);
      toolPlanState.mode = toolPlanState.selected.size ? 'selected' : 'auto';
      toolPlanState.dirty = true;
      renderToolPlanPicker();
    });
  });
  const addTool = () => {
    const select = el.querySelector('#toolPlanAddSelect');
    const input = el.querySelector('#toolPlanAddName');
    const raw = (input?.value || select?.value || '').trim();
    if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(raw) || !toolPlanToolAvailable(raw)) {
      input?.focus();
      return;
    }
    toolPlanState.selected.add(raw);
    toolPlanState.mode = 'selected';
    toolPlanState.expanded = true;
    toolPlanState.dirty = true;
    renderToolPlanPicker();
  };
  el.querySelector('[data-tool-plan-add]')?.addEventListener('click', addTool);
  el.querySelector('#toolPlanAddSelect')?.addEventListener('change', (e) => {
    const input = el.querySelector('#toolPlanAddName');
    if (input) input.value = e.target.value || '';
  });
  el.querySelector('#toolPlanAddName')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTool();
    }
  });
  el.querySelector('#toolPlanRemember')?.addEventListener('change', (e) => {
    toolPlanState.remember = e.target.checked;
    toolPlanState.dirty = true;
  });
}

function selectedToolPlanForSend(text) {
  if (!text?.trim()) return null;
  const selectedTools = availableToolPlanNames(toolPlanState.selected);
  if (toolPlanState.remember && (toolPlanState.mode === 'none' || selectedTools.length)) {
    rememberToolRecipe(text, selectedTools, toolPlanState.mode);
  }
  if (toolPlanState.mode === 'none') return { mode: 'none', source: 'user', phrase: text.slice(0, 240), selectedTools: [] };
  if (toolPlanState.mode === 'selected' && selectedTools.length) {
    return { mode: 'selected', source: toolPlanState.recipe ? 'remembered' : 'user', phrase: text.slice(0, 240), selectedTools };
  }
  return null;
}

function resetToolPlanPicker() {
  toolPlanState = { mode: 'auto', expanded: false, selected: new Set(), suggestions: [], recipe: null, remember: false, dirty: false };
  renderToolPlanPicker();
}

// Mirrors MAX_UPLOAD in routes/expenses.mjs's /api/chat-upload handler — a
// client-side pre-check so an oversized file fails instantly with a clear
// message instead of uploading for a while first. Never raise this without
// also raising the server-side cap (see feedback_upload_caps_4_places).
const CHAT_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

function clearAttachment() {
  pendingAttachments = [];
  $('chatFileInput').value = '';
  renderAttachmentTray();
}

function removeAttachmentAt(localKey) {
  pendingAttachments = pendingAttachments.filter(a => a._localKey !== localKey);
  if (!pendingAttachments.length) $('chatFileInput').value = '';
  renderAttachmentTray();
}

function formatAttachmentSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderAttachmentTray() {
  const p = $('attachPreview');
  if (!pendingAttachments.length) {
    p.style.display = 'none';
    p.innerHTML = '';
    return;
  }
  p.style.display = 'flex';
  p.style.flexWrap = 'wrap';
  p.style.gap = '6px';
  p.innerHTML = '';
  // Every tray item goes out together on the next send (see send()) — no
  // "only the first" caveat anymore, so every row renders identically.
  pendingAttachments.forEach((a) => {
    const row = document.createElement('span');
    row.className = 'attach-preview-item';
    row.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);font-size:12px;max-width:220px';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'attach-preview-name';
    nameSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px';
    if (a._uploading) {
      row.innerHTML = '<span style="font-size:14px">⏳</span>';
      nameSpan.textContent = a.name || 'uploading…';
    } else {
      const thumbWrap = document.createElement('span');
      thumbWrap.innerHTML = a.isImage && a.base64
        ? `<img src="data:${a.mimeType};base64,${a.base64}" alt="" style="width:18px;height:18px;object-fit:cover;border-radius:3px;vertical-align:middle">`
        : `<span style="font-size:14px">${a.mimeType?.includes('pdf') ? icon('file-text', 14) : icon('paperclip', 14)}</span>`;
      row.appendChild(thumbWrap);
      nameSpan.textContent = a.name;
    }
    row.appendChild(nameSpan);
    const sizeLabel = formatAttachmentSize(a.size);
    if (sizeLabel && !a._uploading) {
      const sizeSpan = document.createElement('span');
      sizeSpan.style.cssText = 'color:var(--muted)';
      sizeSpan.textContent = sizeLabel;
      row.appendChild(sizeSpan);
    }
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'attach-preview-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeAttachmentAt(a._localKey));
    row.appendChild(removeBtn);
    p.appendChild(row);
  });
}

let _attachmentUploadSeq = 0;

// Upload one file and add it to the tray. Called once per file — see the
// #chatFileInput 'change' listener below and init.js's paste/drag-drop call
// sites (handleChatFileSelect stays a thin wrapper for compatibility with
// those existing single-file callers).
async function _uploadAndAddAttachment(file) {
  if (!file) return;
  // Count cap, not a size cap — per-file size limits are unchanged (see
  // CHAT_UPLOAD_MAX_BYTES below). Checked at add-time so the tray never grows
  // past the limit in the first place, rather than truncating silently at
  // send() — a friendly toast here is only guaranteed to be seen once, unlike
  // a note baked into a follow-up send.
  if (pendingAttachments.length >= MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
    showToast(`You can attach up to ${MAX_CHAT_ATTACHMENTS_PER_MESSAGE} files per message.`);
    return;
  }
  if (file.size > CHAT_UPLOAD_MAX_BYTES) {
    alert(`"${file.name}" is too large — limit is ${CHAT_UPLOAD_MAX_BYTES / 1024 / 1024} MB.`);
    return;
  }
  const localKey = `att_${Date.now()}_${_attachmentUploadSeq++}`;
  pendingAttachments.push({ _localKey: localKey, _uploading: true, name: file.name, size: file.size });
  renderAttachmentTray();
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/chat-upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const idx = pendingAttachments.findIndex(a => a._localKey === localKey);
    if (idx === -1) return; // removed from the tray while the upload was in flight
    pendingAttachments[idx] = { ...data, _localKey: localKey, size: file.size };
    renderAttachmentTray();
  } catch (e) {
    pendingAttachments = pendingAttachments.filter(a => a._localKey !== localKey);
    renderAttachmentTray();
    alert('Upload failed: ' + e.message);
  }
}

async function handleChatFileSelect(file) {
  await _uploadAndAddAttachment(file);
}

// #chatFileInput's 'change' listener (init.js) calls handleChatFileSelect
// with just `files[0]` for backward compatibility with its existing
// single-file call signature. index.html now sets `multiple` on that input,
// so a picker action can select several files at once — this second
// listener picks up files[1..] so every selection gets uploaded, not just
// the first. Index-disjoint with init.js's call (0 vs 1+), so registration
// order between the two listeners doesn't matter.
(function _initMultiFileAttach() {
  const attach = () => {
    const input = $('chatFileInput');
    if (!input) return;
    input.addEventListener('change', (e) => {
      const files = e.target.files;
      for (let i = 1; i < files.length; i++) _uploadAndAddAttachment(files[i]);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();

// ── Send ──────────────────────────────────────────────────────────────────────
async function send() {
  let text = $('input').value.trim();
  if (!text && !pendingAttachments.length) return;
  if (streaming && !awaitingPermission) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Not connected — try again in a moment'); return; }
  if (pendingAttachments.some(a => a._uploading)) { showToast('Still uploading — one moment'); return; }

  // A fresh send supersedes the local Retry affordance. The failed row itself
  // stays in durable history; only an explicit Retry reuses its messageId.
  clearFailedAttempt();

  // @-mention redirect: "@<agent> make me a skill" switches the active agent
  // BEFORE we push the user bubble so the message + reply both land in
  // that agent's chat panel. The server's chat-dispatch also handles the
  // prefix (strip + redirect) as defense for clients that don't pre-switch.
  const mention = text.match(/^@(\S+)\s+([\s\S]+)$/);
  let redirectedViaMention = false;
  if (mention) {
    const handle = mention[1].toLowerCase();
    const target = agents.find(a => {
      const nameKey = String(a.name || '').toLowerCase().replace(/\s+/g, '');
      const idSuffix = String(a.id || '').split('_').pop().toLowerCase();
      return nameKey === handle || idSuffix === handle;
    });
    if (target && target.id !== activeAgent) {
      // This composer text is being SENT (to the mention target), not parked
      // as a draft — empty the input and drop this agent's stored draft
      // BEFORE switching. switchAgent's save-on-switch would otherwise
      // persist "@helen …" as the ORIGINATING agent's draft and resurrect it
      // in that composer on every switch back. Emptying first also lets
      // restoreDraftForAgent(target) inside switchAgent behave normally, so
      // anything the user had parked on the TARGET agent's composer survives
      // (the post-send cleanup below is skipped for this redirect case —
      // the just-sent text was already cleared here, and what's in the input
      // now is the target's own untouched draft).
      clearTimeout(_draftSaveTimer);
      $('input').value = '';
      clearDraftForAgent(activeAgent);
      switchAgent(target.id);
      redirectedViaMention = true;
      text = mention[2];  // stripped body; server will see no @-prefix
    } else if (target) {
      text = mention[2];  // same agent, just strip the prefix
    }
  }

  const toolPlan = selectedToolPlanForSend(text);
  // The WHOLE tray goes out with this message. Rebuilt into clean objects so
  // client-only tray bookkeeping (_localKey, _uploading, size) never rides
  // over the wire — server-side shape is chat/providers/_shared.mjs's
  // normalizeAttachments input.
  const attachments = pendingAttachments.map(a => ({
    name: a.name, mimeType: a.mimeType, isImage: a.isImage,
    isFinanceFile: a.isFinanceFile, file_id: a.file_id,
    base64: a.base64, extractedText: a.extractedText,
  }));
  const displayText = text || (attachments.length ? attachments.map(a => `[${a.name}]`).join(' ') : '');
  const messageId = makeChatCorrelationId('msg');
  const attemptId = makeChatCorrelationId('att');

  if (!sessions[activeAgent]) sessions[activeAgent] = [];
  const sessionEntry = { role: 'user', content: displayText, ts: Date.now(), attachments, messageId, attemptId, turnId: attemptId, turnStatus: 'running' };
  sessions[activeAgent].push(sessionEntry);
  updateSessionWarning();
  const userBubbleEl = appendUserBubble(displayText, sessionEntry.ts, true, attachments);
  scrollToBottom(true); // sending always jumps to the bottom, even from scrollback
  // Remember this attempt so it can be cleared/retried if the turn errors.
  lastSentAttempt = registerPendingAttempt({
    agent: activeAgent, text, displayText, attachments, toolPlan,
    messageId, attemptId, userBubbleEl, sessionEntry,
  });
  agentStreams[activeAgent] = typeof freshAgentTurnState === 'function'
    ? freshAgentTurnState(activeAgent, { turnId: attemptId, messageId, attemptId, phase: 'running', seq: 0 })
    : { buf: '', toolEvents: [], active: true, turnId: attemptId, messageId, attemptId, lastSeq: 0 };
  // Composer/draft cleanup — skipped when an @-mention redirect already did
  // it for the ORIGINATING agent pre-switch: at this point activeAgent is
  // the mention TARGET, whose input holds their own restored draft (not the
  // just-sent text), and clearing it here would destroy a parked draft.
  if (!redirectedViaMention) {
    $('input').value = '';
    resizeTextarea();
    // Cancel any pending debounced draft-save (see _initDraftPersistence) —
    // without this, a save queued just before send fires ~400ms later and
    // re-populates a "draft" for a message that already went out.
    clearTimeout(_draftSaveTimer);
    clearDraftForAgent(activeAgent);
  }
  // Every tray item just went out on this message — clear it, rather than
  // the old shift-one-off-the-queue behavior (the wire now carries the
  // whole array in one message, so there's nothing left to queue).
  clearAttachment();
  resetToolPlanPicker();
  resetToolRun();
  if (awaitingPermission) {
    awaitingPermission = false;
    // Don't reset streaming — the agent is still running; just show typing indicator
    setTyping(true);
  } else {
    setStreaming(true); setTyping(true);
  }

  const payload = { type: 'chat', agent: activeAgent, text, message_id: messageId, attempt_id: attemptId };
  if (attachments.length) payload.attachments = attachments;
  if (toolPlan) payload.toolPlan = toolPlan;
  ws.send(JSON.stringify(payload));
}

// ── Render ────────────────────────────────────────────────────────────────────
// Cap how much history is rendered per pass — long-lived sessions otherwise
// grow the DOM without bound and make every re-render O(history). "Load
// earlier" expands the window and preserves the reading position. Reset to
// the base window on agent switch.
const HISTORY_RENDER_WINDOW = 150;
let _historyWindow = HISTORY_RENDER_WINDOW;

function _loadEarlierMessages() {
  const m = $('messages');
  const prevHeight = m.scrollHeight, prevTop = m.scrollTop;
  _historyWindow += HISTORY_RENDER_WINDOW;
  renderSession({ keepScroll: true });
  m.scrollTop = prevTop + (m.scrollHeight - prevHeight);
}

function renderSession(opts) {
  const keepScroll = Boolean(opts && opts.keepScroll === true);
  _renderingSession = true;
  try {
    renderSessionInner(keepScroll);
  } finally {
    _renderingSession = false;
  }
}
function renderSessionInner(keepScroll) {
  const msgs = $('messages');
  [...msgs.children].forEach(el => {
    if (el.id) return;
    if (el._approvalExpiryTimer) clearTimeout(el._approvalExpiryTimer);
    // Image bubbles hold object URLs — revoke before dropping the element or
    // every re-render leaks the decoded image memory for the tab's lifetime.
    el.querySelectorAll('img[src^="blob:"]').forEach(img => { try { URL.revokeObjectURL(img.src); } catch {} });
    el.remove();
  });
  // Hidden rows are model/private bookkeeping, not browser history. Remove
  // them before they can consume the render window or participate in document
  // request/assistant pairing.
  const ordered = orderSessionForRender(sessions[activeAgent] ?? []).filter(m => !m?.hidden);
  const start = Math.max(0, ordered.length - _historyWindow);
  if (start > 0) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'load-earlier-btn';
    btn.textContent = `Load earlier messages (${start} more)`;
    btn.style.cssText = 'display:block;margin:10px auto;padding:6px 14px;font-size:12px;border-radius:16px;border:1px solid var(--border);background:var(--bg2);color:var(--muted);cursor:pointer';
    btn.addEventListener('click', _loadEarlierMessages);
    insertBefore(btn);
  }
  const visibleMessages = ordered.slice(start);
  const documentAssistantByUser = new Map();
  const hiddenDocumentAssistants = new Set();
  const pairedDocumentAssistants = new Set();
  const documentAssistantsByRequestId = new Map(
    visibleMessages
      .filter(m => m?.role === 'assistant' && m.documentRequestId)
      .map(m => [m.documentRequestId, m]),
  );
  for (let i = 0; i < visibleMessages.length; i++) {
    const userMessage = visibleMessages[i];
    if (userMessage?.role !== 'user' || !userMessage.documentRequest) continue;
    const requestId = userMessage.documentRequest.requestId;
    const correlated = requestId ? documentAssistantsByRequestId.get(requestId) : null;
    if (correlated) {
      documentAssistantByUser.set(i, correlated);
      pairedDocumentAssistants.add(correlated);
      const persistedOutcome = typeof documentOutcomeFromAssistant === 'function'
        ? documentOutcomeFromAssistant(correlated)
        : null;
      if (persistedOutcome?.success || userMessage.documentRequest.outcome?.success) {
        hiddenDocumentAssistants.add(correlated);
      }
      continue;
    }
    for (let j = i + 1; j < visibleMessages.length; j++) {
      const candidate = visibleMessages[j];
      if (candidate?.role === 'user') break;
      if (candidate?.role !== 'assistant') continue;
      if (candidate.documentRequestId && requestId && candidate.documentRequestId !== requestId) continue;
      documentAssistantByUser.set(i, candidate);
      pairedDocumentAssistants.add(candidate);
      const persistedOutcome = typeof documentOutcomeFromAssistant === 'function'
        ? documentOutcomeFromAssistant(candidate)
        : null;
      if (persistedOutcome?.success || userMessage.documentRequest.outcome?.success) {
        hiddenDocumentAssistants.add(candidate);
      }
      break;
    }
  }

  visibleMessages.forEach((m, index) => {
    // Raw worker reports are durable private model context. Only the primary's
    // separately persisted completion is user-visible.
    if (m?.hidden) return;
    if (m.scheduled)                 appendTaskHeader(m.content, m.ts, false);
    else if (m.role === 'notification') appendNotification({ agent: activeAgent, content: m.content, from: m.from, ts: m.ts });
    else if (m.role === 'user' && !m.hidden && m.documentRequest && typeof renderDocumentSessionRequest === 'function') {
      const assistant = documentAssistantByUser.get(index) ?? null;
      const result = renderDocumentSessionRequest(m, assistant, false);
      if (assistant && !assistant.hidden && !result.hideAssistant && assistant.content) {
        appendAssistantBubble(assistant.content, assistant.ts, false);
      }
    }
    else if (m.role === 'user' && !m.hidden)        appendUserBubble(m.content, m.ts, false, m.attachments ?? m.attachment ?? null);
    else if (m.role === 'assistant' && m.documentArtifact && !pairedDocumentAssistants.has(m)
             && typeof renderStandaloneDocumentArtifact === 'function') {
      renderStandaloneDocumentArtifact(m, false);
    }
    else if (m.role === 'assistant' && m.image) {
      if (m.image.base64) appendImageBubble(m.image, m.ts, false);
      else appendReportImageBubble(m.image, m.ts, false); // saved-file row (no inline base64)
    }
    else if (m.role === 'assistant' && m.video)    appendVideoBubble(m.video, m.ts, false);
    else if (m.role === 'status' && m.status)     appendStatusBubble(m.status, m.ts, false);
    else if (m.role === 'proposal' && m.proposalId) appendProposalBubble(m, false);
    else if (m.role === 'proposal_outcome' && m.proposalId) applyProposalOutcome(m.proposalId, m.status, m.outcome);
    else if (m.role === 'attachment_decision' && m.decisionId) appendAttachmentDecisionBubble(m, false);
    else if (m.role === 'attachment_decision_outcome' && m.decisionId) applyAttachmentDecisionOutcome(m.decisionId, m.decision);
    else if (m.role === 'approval_pending' && m.kind) appendApprovalPendingBubble(m, false);
    else if (m.role === 'approval_resolved' && m.kind) applyApprovalResolved(m.kind, m.opId ?? null, m.ts ?? null);
    else if (m.role === 'turn_error') appendTurnErrorBubble(m);
    else if ((m.role === 'agent_report' || m.kind === 'agent_report') && isNodeExecTaskReport(m)) {
      appendNodeExecTaskReport(m, null, false);
      appendAgentReportImages(m, false);
    }
    else if ((m.role === 'agent_report' || m.kind === 'agent_report') && appendAgentReportTaskChip(m, false)) {
      appendAgentReportImages(m, false);
    }
    else if (m.role === 'agent_report' || m.kind === 'agent_report') {
      _renderAgentReportEl(m);
      appendAgentReportImages(m, false);
    }
    else if (m.role === 'assistant' && !m.hidden && _legacyAgentReportMatch(m.content)) {
      // Legacy entries persisted before the kind:'agent_report' field
      // shipped — content starts with "[<name> finished in background]\n"
      // or "[<name> replied — re: …]\n". Parse the prefix for the sender
      // name and render with the same fancy bubble we'd use for fresh
      // entries; strip the prefix from the body so it isn't displayed
      // twice (once in the header, once in the body).
      const { agentName, body } = _legacyAgentReportMatch(m.content);
      _renderAgentReportEl({ agentName, agentEmoji: '⏵', content: body, ts: m.ts });
    }
    else if (m.role === 'assistant' && !m.hidden) {
      if (pairedDocumentAssistants.has(m) || hiddenDocumentAssistants.has(m)) return;
      if (Array.isArray(m.toolEvents) && m.toolEvents.length) appendToolRun(m.toolEvents, m.ts, false, { persisted: true, toolResults: m.toolResults });
      if (Array.isArray(m._nodeExecTaskReports)) {
        for (const report of m._nodeExecTaskReports) appendNodeExecTaskReport(report, m, false);
      }
      appendAssistantBubble(m.content, m.ts, false);
    }
  });
  if (keepScroll) return;
  // Initial load / agent switch always lands at the most recent message —
  // matching the force path agent-switch already uses (agents.js) — rather
  // than jumping mid-history to today's last task-header. scrollToBottom(true)
  // also flips _autoScroll back on so live streaming keeps following.
  scrollToBottom(true);
}

function orderSessionForRender(messages) {
  const sourceMessages = messages || [];
  const orderedMessages = sourceMessages
    .map((m, i) => {
      const t = Number(m?.ts);
      return {
        m,
        i,
        t: Number.isFinite(t) && t > 0 ? t : Number.MAX_SAFE_INTEGER - (sourceMessages.length - i),
      };
    })
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map(x => x.m);
  const out = [];
  const pendingReports = new Map();
  let pendingLegacyReports = [];
  const seenHiddenTasks = new Set();
  const reportTaskId = (m) => {
    if (!(m?.role === 'agent_report' || m?.kind === 'agent_report')) return null;
    return typeof m.taskId === 'string' && m.taskId.startsWith('autobg_') ? m.taskId : null;
  };
  const isLegacyAutoBgReport = (m) => (
    (m?.role === 'agent_report' || m?.kind === 'agent_report')
    && !m.taskId
    && typeof m.content === 'string'
    && /^\[[^\]]+ finished in background\]\n/.test(m.content)
  );
  const legacyReportMatchesTurn = (report, turn) => {
    if (turn?.role !== 'assistant' || !Array.isArray(turn.toolEvents)) return false;
    const reportTs = Number(report.ts) || 0;
    return turn.toolEvents.some(ev => (
      ev?.name === report.agentName
      && Math.abs((Number(ev.endedAt) || Number(turn.ts) || 0) - reportTs) < 10000
    ));
  };
  const nodeExecReportTaskId = (m) => {
    if (!isNodeExecTaskReport(m)) return null;
    return m.taskId.slice('autobg_'.length);
  };
  const assistantOwnsNodeExecReport = (turn, taskId) => {
    if (turn?.role !== 'assistant' || turn.hidden || !Array.isArray(turn.toolEvents)) return false;
    const taskNeedle = taskId ? `task ${taskId}` : '';
    const resultText = Array.isArray(turn.toolResults)
      ? turn.toolResults.map(r => String(r?.text ?? '')).join('\n')
      : '';
    return turn.toolEvents.some(ev => ev?.name === 'node_exec')
      && (!taskNeedle || resultText.includes(taskNeedle));
  };
  const hiddenTaskId = (m) => {
    if (m?.role !== 'assistant' || !m.hidden || !m.hideTaskId) return null;
    return `autobg_${m.hideTaskId}`;
  };
  const hiddenTaskIds = new Set(orderedMessages.map(hiddenTaskId).filter(Boolean));

  for (const m of orderedMessages) {
    if (isLegacyAutoBgReport(m)) {
      pendingLegacyReports.push(m);
      continue;
    }

    const taskId = reportTaskId(m);
    if (taskId) {
      const nodeTaskId = nodeExecReportTaskId(m);
      if (nodeTaskId) {
        let attached = false;
        for (let i = out.length - 1; i >= 0; i--) {
          if (!assistantOwnsNodeExecReport(out[i], nodeTaskId)) continue;
          const copy = { ...out[i] };
          copy._nodeExecTaskReports = [...(copy._nodeExecTaskReports || []), m];
          out[i] = copy;
          attached = true;
          break;
        }
        if (attached) continue;
      }
      if (seenHiddenTasks.has(taskId)) {
        out.push(m);
        continue;
      }
      if (!hiddenTaskIds.has(taskId)) {
        out.push(m);
        continue;
      }
      if (!pendingReports.has(taskId)) pendingReports.set(taskId, []);
      pendingReports.get(taskId).push(m);
      continue;
    }

    out.push(m);
    const hiddenId = hiddenTaskId(m);
    if (hiddenId) seenHiddenTasks.add(hiddenId);
    if (hiddenId && pendingReports.has(hiddenId)) {
      out.push(...pendingReports.get(hiddenId));
      pendingReports.delete(hiddenId);
    }

    if (pendingLegacyReports.length) {
      const matched = [];
      pendingLegacyReports = pendingLegacyReports.filter(report => {
        if (!legacyReportMatchesTurn(report, m)) return true;
        matched.push(report);
        return false;
      });
      out.push(...matched);
    }
  }

  for (const reports of pendingReports.values()) out.push(...reports);
  out.push(...pendingLegacyReports);
  return out;
}

function chatSessionAgentId(agent) {
  if (typeof clientSessionAgentId === 'function') return clientSessionAgentId(agent);
  if (typeof agent !== 'string' || !agent) return agent;
  const uid = (typeof _currentUser !== 'undefined' && _currentUser?.id) ? String(_currentUser.id) : '';
  if (uid && agent.startsWith(`${uid}_`)) return agent.slice(uid.length + 1);
  return agent.replace(/^user_[^_]+_/, '');
}

function isNestedTaskProxyStatus(status) {
  const state = status?.state || {};
  return status?.kind === 'task_proxy'
    && typeof status.watcherId === 'string'
    && typeof state.rootWatcherId === 'string'
    && state.rootWatcherId
    && state.rootWatcherId !== status.watcherId;
}

function agentReportWatcherId(report) {
  if (!(report?.role === 'agent_report' || report?.kind === 'agent_report')) return '';
  if (typeof report.rootWatcherId === 'string' && report.rootWatcherId) return report.rootWatcherId;
  if (typeof report.watcherId === 'string' && report.watcherId) return report.watcherId;
  if (typeof report.taskId === 'string' && report.taskId.startsWith('autobg_')) {
    return report.taskId.slice('autobg_'.length);
  }
  return '';
}

function appendAgentReportTaskChip(report, scroll = true) {
  const watcherId = agentReportWatcherId(report);
  if (!watcherId) return false;
  const ownWatcherId = typeof report.watcherId === 'string' ? report.watcherId : '';
  // Fold whenever the DISPLAY watcher differs from the report's own —
  // including when the child has NO own watcherId (failed registration):
  // the old `ownWatcherId && …` predicate rendered such a report as a fresh
  // final chip under the ROOT's id, overwriting the still-running root
  // chip's header and marking it done.
  const foldedIntoRoot = watcherId !== ownWatcherId;
  const existing = document.querySelector(`.msg.task-chip[data-watcher-id="${CSS.escape(watcherId)}"]`);
  const existingAgent = existing?.querySelector('.task-chip-header span')?.textContent?.trim() || '';
  const existingTask = existing?.querySelector('.task-chip-task')?.textContent?.trim() || '';
  const body = String(_agentReportBody(report.content, report.displayContent) || report.content || `${report.agentName || report.tool || 'Agent'} completed.`);
  const agentName = report.agentName || report.tool || 'Agent';
  const agentEmoji = report.agentEmoji || '⏵';
  const status = report.status === 'error'
    ? 'error'
    : report.status === 'cancelled'
      ? 'cancelled'
      : 'done';
  const statusText = foldedIntoRoot ? `${agentEmoji} ${agentName}: ${body}` : body;
  if (foldedIntoRoot && existing) {
    const statusLine = existing.querySelector('.task-chip-status');
    if (statusLine) {
      const wasAtBottom = statusLine.scrollHeight - statusLine.scrollTop - statusLine.clientHeight < 4;
      statusLine.textContent = statusText;
      if (wasAtBottom) statusLine.scrollTop = statusLine.scrollHeight;
    }
    if (scroll) scrollToBottom();
    return true;
  }
  return appendTaskChip({
    kind: 'task_proxy',
    watcherId,
    label: foldedIntoRoot && existingAgent ? existingAgent : `${agentEmoji} ${agentName}`,
    text: statusText,
    final: true,
    finalStatus: status,
    state: {
      status,
      targetAgentName: foldedIntoRoot && existingAgent ? existingAgent : agentName,
      targetAgentEmoji: foldedIntoRoot ? '' : agentEmoji,
      summary: foldedIntoRoot && existingTask ? existingTask : (report.originalTask || report.tool || ''),
      tool: report.tool || '',
      phase: status,
      startedAt: report.startedAt || null,
      lastActivityAt: report.ts || Date.now(),
      currentTool: null,
      canCancel: false,
      finalReportPreview: body.slice(0, 800),
    },
  }, report.ts || Date.now(), scroll) !== false;
}

function appendNodeExecTaskReport(report, turn, scroll = true) {
  const taskId = typeof report?.taskId === 'string' && report.taskId.startsWith('autobg_')
    ? report.taskId.slice('autobg_'.length)
    : '';
  const nodeEvent = Array.isArray(turn?.toolEvents)
    ? turn.toolEvents.find(ev => ev?.name === 'node_exec')
    : null;
  const output = String(report?.content ?? '');
  const commandMatch = output.match(/^Command:\s*(.+)$/mi);
  const label = nodeEvent?.args?.label || nodeEvent?.args?.command || commandMatch?.[1] || 'node_exec';
  const exitMatch = output.match(/Exit code:\s*(-?\d+)/i);
  const ok = report?.status === 'error' ? false : (exitMatch ? Number(exitMatch[1]) === 0 : true);
  return appendTaskChip({
    kind: 'task_proxy',
    watcherId: taskId || report?.taskId || `node_exec_${report?.ts || Date.now()}`,
    label: `🖥 node_exec`,
    text: output,
    final: true,
    finalStatus: ok ? 'done' : 'error',
    state: {
      status: ok ? 'done' : 'error',
      targetAgentName: report?.agentName || 'node_exec',
      targetAgentEmoji: '🖥',
      summary: label,
      startedAt: nodeEvent?.startedAt || turn?.ts || report?.ts,
      lastActivityAt: report?.ts || nodeEvent?.endedAt || turn?.ts,
      currentTool: null,
      canCancel: false,
    },
    recentHistory: [],
  }, report?.ts || turn?.ts || Date.now(), scroll);
}

function isNodeExecTaskReport(m) {
  return (m?.role === 'agent_report' || m?.kind === 'agent_report')
    && (m.tool === 'node_exec' || m.agentName === 'node_exec')
    && typeof m.taskId === 'string'
    && m.taskId.startsWith('autobg_');
}

// `attachments` accepts the new array shape, OR a single legacy attachment
// object (old persisted single-attachment session rows use `m.attachment` —
// see websocket.js's session_loaded handling in renderSessionInner — and
// must still render). Each attachment with inline base64 (the live-send
// case — the tray's own upload response) shows as an image; anything
// reloaded from a persisted session row never carries base64 (see chat.mjs
// persist(): no inline data in the session log, only name/mimeType/file_id)
// so it degrades to the same filename badge non-image attachments already use.
function appendUserBubble(text, ts = Date.now(), scroll = true, attachments = null) {
  const list = Array.isArray(attachments) ? attachments.filter(Boolean) : (attachments ? [attachments] : []);
  const el = msgEl('user');
  const bubble = el.querySelector('.msg-bubble');
  for (const attachment of list) {
    const div = document.createElement('div');
    div.className = 'msg-attachment';
    if (attachment.isImage && attachment.base64) {
      div.innerHTML = `<img src="data:${attachment.mimeType};base64,${attachment.base64}" alt="${escHtml(attachment.name)}">`;
    } else {
      const fileIcon = attachment.mimeType?.includes('pdf') ? icon('file-text', 14) : icon('bar-chart-2', 14);
      div.innerHTML = `<span class="msg-attachment-badge">${fileIcon} ${escHtml(attachment.name)}</span>`;
    }
    bubble.appendChild(div);
  }
  // Skip the text span when it's exactly the auto-generated "[name] [name2]"
  // placeholder send() falls back to for an attachments-only message (see
  // send()'s displayText) — matches both the single- and multi-file join.
  const placeholderText = list.length ? list.map(a => `[${a.name}]`).join(' ') : null;
  if (text && text !== placeholderText) {
    const span = document.createElement('span');
    span.textContent = text;
    bubble.appendChild(span);
  }
  addTimestamp(el, ts); insertBefore(el);
  if (scroll) scrollToBottom();
  return el;
}
function appendAssistantBubble(content, ts = Date.now(), scroll = true) {
  const el = msgEl('assistant');
  el.querySelector('.msg-bubble').innerHTML = renderMarkdown(content);
  addTimestamp(el, ts); insertBefore(el);
  if (scroll) scrollToBottom();
  return el;
}
function appendImageBubble(image, ts = Date.now(), scroll = true) {
  const el = msgEl('assistant');
  const bubble = el.querySelector('.msg-bubble');

  // Decode base64 → Blob → object URL (avoids large data URL in DOM)
  const byteChars = atob(image.base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: image.mimeType });
  const blobUrl = URL.createObjectURL(blob);

  const img = document.createElement('img');
  img.src = blobUrl;
  img.alt = image.filename;
  img.style.cssText = 'max-width:100%;border-radius:8px;display:block';
  bubble.appendChild(img);

  const meta = document.createElement('div');
  meta.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--muted)';
  if (image.savedPath) {
    const saved = document.createElement('span');
    saved.innerHTML = `${icon('save', 12)} Saved to ${escHtml(image.savedPath)}`;
    saved.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    meta.appendChild(saved);
  } else {
    const dlBtn = document.createElement('a');
    dlBtn.innerHTML = `${icon('download', 12)} Download`;
    dlBtn.style.cssText = 'color:var(--accent);text-decoration:none;cursor:pointer;flex-shrink:0';
    dlBtn.addEventListener('click', e => {
      e.preventDefault();
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = image.filename;
      a.click();
    });
    meta.appendChild(dlBtn);
  }
  bubble.appendChild(meta);

  addTimestamp(el, ts); insertBefore(el);
  if (scroll) scrollToBottom();
  return el;
}

function reportImageFilename(image, idx = 0, ts = Date.now()) {
  if (image?.filename) return image.filename;
  if (image?.savedPath) {
    const parts = String(image.savedPath).split(/[\\/]/);
    const base = parts[parts.length - 1];
    if (base) return base;
  }
  const mime = String(image?.mimeType || image?.mediaType || 'image/png');
  const ext = mime.includes('jpeg') ? 'jpg' : mime.split('/').pop() || 'png';
  return `agent-report-image-${ts}-${idx + 1}.${ext}`;
}

function appendReportImageBubble(image, ts = Date.now(), scroll = true, idx = 0) {
  if (!image) return null;
  const normalized = {
    ...image,
    mimeType: image.mimeType || image.mediaType || 'image/png',
    filename: reportImageFilename(image, idx, ts),
  };
  if (normalized.base64) return appendImageBubble(normalized, ts, scroll);

  const token = typeof getMediaTokenSync === 'function' ? getMediaTokenSync() : '';
  const src = normalized.url || (normalized.filename
    ? `/api/desktop/images/${encodeURIComponent(normalized.filename)}${token ? `?token=${encodeURIComponent(token)}` : ''}`
    : '');
  if (!src) return null;

  const el = msgEl('assistant');
  const bubble = el.querySelector('.msg-bubble');
  const img = document.createElement('img');
  img.src = src;
  img.alt = normalized.filename;
  img.style.cssText = 'max-width:100%;border-radius:8px;display:block';
  bubble.appendChild(img);

  const meta = document.createElement('div');
  meta.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--muted)';
  const dl = document.createElement('a');
  dl.innerHTML = `${icon('download', 12)} Download`;
  dl.href = src;
  dl.download = normalized.filename;
  dl.style.cssText = 'color:var(--accent);text-decoration:none;cursor:pointer;flex-shrink:0';
  meta.appendChild(dl);
  if (normalized.savedPath) {
    const saved = document.createElement('span');
    saved.innerHTML = `${icon('save', 12)} Saved to ${escHtml(normalized.savedPath)}`;
    saved.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    meta.appendChild(saved);
  }
  bubble.appendChild(meta);

  addTimestamp(el, ts);
  insertBefore(el);
  if (scroll) scrollToBottom();
  return el;
}

function appendAgentReportImages(report, scroll = true) {
  const images = Array.isArray(report?.images) ? report.images : [];
  if (!images.length) return false;
  const ts = report.ts || Date.now();
  let rendered = false;
  // Skip images that already exist as their own session image rows (the live
  // tool-image event persists one for visible turns) — an adopted delegation's
  // report carrying the same file used to render it twice.
  const sessionImageFiles = new Set((sessions[activeAgent] ?? [])
    .filter(m => m.role === 'assistant' && m.image?.filename)
    .map(m => m.image.filename));
  images.forEach((image, idx) => {
    if (image?.filename && sessionImageFiles.has(image.filename)) return;
    if (appendReportImageBubble(image, ts + idx, false, idx)) rendered = true;
  });
  if (rendered && scroll) scrollToBottom();
  return rendered;
}
// Watcher status updates — muted/italic, distinct from assistant bubbles.
// Sourced from scheduler/watchers.mjs supervisor pushing WS type='status'
// messages. The `📡` prefix marks these as poll-driven, not agent-spoken.
//
// Update-in-place: each watcher gets ONE bubble that mutates as new statuses
// arrive. Looked up by data-watcher-id. New watchers append a fresh bubble;
// repeat updates for the same watcherId rewrite the existing one in place.
function taskChipTime(ts) {
  const d = new Date(ts || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function taskChipPhase(status) {
  const phase = status.state?.phase;
  if (status.awaiting_input) return 'awaiting reply';
  if (status.final && status.finalStatus === 'done') return 'done';
  if (status.final && status.finalStatus === 'error') return 'error';
  if (status.final && status.finalStatus === 'cancelled') return 'cancelled';
  if (phase === 'cancelling') return 'cancelling';
  if (phase === 'cancelled') return 'cancelled';
  if (phase === 'queued') return 'queued';
  if (phase === 'tool') return 'using tool';
  if (phase === 'streaming') return 'streaming';
  if (phase === 'result') return 'reviewing result';
  if (phase === 'backgrounded') return 'background';
  return status.final ? 'finished' : 'running';
}

function taskChipElapsed(startedAt, nowTs = Date.now()) {
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0) return null;
  const sec = Math.max(0, Math.round((nowTs - start) / 1000));
  if (sec < 60) return `${sec}s elapsed`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s elapsed` : `${min}m elapsed`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${hr}h ${m}m elapsed` : `${hr}h elapsed`;
}

async function cancelTaskChip(watcherId, btn) {
  if (!watcherId || !btn) return;
  btn.disabled = true;
  btn.textContent = 'Stopping...';
  try {
    const r = await fetch(`/api/watchers/${encodeURIComponent(watcherId)}`, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) {
      const err = await r.json().catch(() => ({}));
      btn.disabled = false;
      btn.textContent = 'Stop';
      alert(`Stop failed: ${err.error || r.statusText}`);
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Stop';
    alert(`Stop failed: ${e.message}`);
  }
}

// ── Task chip (Phase 14) — card-style bubble for in-flight background tasks
// One chip per task_proxy watcher. Survives multiple status updates by
// updating in place via data-watcher-id. Renders:
//   - Header: agent emoji + name + status badge (running/awaiting/done/error)
//   - Subhead: task summary (the original prompt)
//   - Progress line: latest status text (current tool, last result, etc)
//   - Reply input (only when awaiting_input=true)
//   - Final outcome text (when done/error)
function appendTaskChip(status, ts = Date.now(), scroll = true) {
  const watcherId = status.watcherId || '';
  if (isNestedTaskProxyStatus(status)) {
    if (watcherId) document.querySelector(`.msg.task-chip[data-watcher-id="${CSS.escape(watcherId)}"]`)?.remove();
    return;
  }
  let el = watcherId ? document.querySelector(`.msg.task-chip[data-watcher-id="${CSS.escape(watcherId)}"]`) : null;
  const isUpdate = !!el;
  const final = !!status.final;
  const finalStatus = status.finalStatus;

  if (!el) {
    el = document.createElement('div');
    el.className = 'msg task-chip';
    el.dataset.watcherId = watcherId;
    el.style.cssText = 'padding:10px 12px;margin:6px 0;border:1px solid var(--border);border-left:3px solid var(--accent,#6c8cff);background:rgba(108,140,255,0.04);border-radius:6px;font-size:13px';
  }

  // Pull agent + task from the label (format: "<emoji> <agent name>: <task>")
  const label = status.label || '';
  const dashIdx = label.indexOf(': ');
  const state = status.state || {};
  const fallbackAgentPart = dashIdx > 0 ? label.slice(0, dashIdx) : label;
  const fallbackTaskPart  = dashIdx > 0 ? label.slice(dashIdx + 2) : '';
  const agentPart = `${state.targetAgentEmoji || ''} ${state.targetAgentName || fallbackAgentPart || 'Task'}`.trim();
  const taskPart  = state.summary || fallbackTaskPart || '';
  const phaseText = taskChipPhase(status);

  // Status badge color/text based on phase
  let badge, badgeColor;
  if (status.awaiting_input) {
    badge = '⏳ awaiting reply';
    badgeColor = 'var(--orange,#c80)';
  } else if (final && finalStatus === 'done') {
    badge = '✓ done';
    badgeColor = 'var(--green,#3a7)';
  } else if (final && finalStatus === 'error') {
    badge = '⚠ error';
    badgeColor = 'var(--red,#c33)';
  } else if (final && finalStatus === 'cancelled') {
    badge = '■ cancelled';
    badgeColor = 'var(--orange,#c80)';
  } else if (final) {
    badge = '· finished';
    badgeColor = 'var(--muted)';
  } else if (state.cancelling || state.status === 'cancelling') {
    badge = '■ stopping';
    badgeColor = 'var(--orange,#c80)';
  } else {
    badge = `⏵ ${phaseText}`;
    badgeColor = 'var(--accent,#6c8cff)';
  }

  // Rebuild header + body on every update (preserve any reply input form)
  let header = el.querySelector('.task-chip-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'task-chip-header';
    header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;cursor:pointer';
    header.title = 'Click to view progress history';
    if (watcherId) {
      header.addEventListener('click', (ev) => {
        if (window.getSelection?.().toString()) return;
        toggleWatcherHistory(el, watcherId);
        ev.stopPropagation();
      });
    }
    el.appendChild(header);
  }
  header.innerHTML = '';

  const agentEl = document.createElement('span');
  agentEl.style.cssText = 'font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  agentEl.textContent = agentPart || 'Task';
  header.appendChild(agentEl);

  const badgeEl = document.createElement('span');
  badgeEl.textContent = badge;
  badgeEl.style.cssText = `font-size:11px;color:${badgeColor};font-weight:600;white-space:nowrap`;
  header.appendChild(badgeEl);

  let cancelBtn = el.querySelector('.task-chip-cancel');
  const canCancel = !!state.canCancel && !final && !status.awaiting_input;
  if (canCancel) {
    if (!cancelBtn) {
      cancelBtn = document.createElement('button');
      cancelBtn.className = 'task-chip-cancel';
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Stop';
      cancelBtn.title = 'Stop this background task';
      cancelBtn.style.cssText = 'border:1px solid var(--border);background:var(--bg2);color:var(--muted);border-radius:4px;padding:2px 7px;font-size:11px;cursor:pointer;line-height:1.5';
      cancelBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        cancelTaskChip(watcherId, cancelBtn);
      });
    }
    cancelBtn.disabled = false;
    cancelBtn.textContent = 'Stop';
    header.appendChild(cancelBtn);
  } else if (cancelBtn) {
    cancelBtn.remove();
  }

  // Task summary (the prompt) — shown only when present
  let taskLine = el.querySelector('.task-chip-task');
  if (!taskLine) {
    taskLine = document.createElement('div');
    taskLine.className = 'task-chip-task';
    taskLine.style.cssText = 'font-size:12px;color:var(--muted);margin-bottom:6px;line-height:1.4';
    el.insertBefore(taskLine, header.nextSibling);
  }
  if (taskPart) {
    taskLine.textContent = taskPart;
    taskLine.style.display = '';
  } else {
    taskLine.style.display = 'none';
  }

  let metaLine = el.querySelector('.task-chip-meta');
  if (!metaLine) {
    metaLine = document.createElement('div');
    metaLine.className = 'task-chip-meta';
    metaLine.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px;font-size:11px;color:var(--muted);line-height:1.35';
    el.insertBefore(metaLine, taskLine.nextSibling);
  }
  const metaBits = [];
  if (state.currentTool) metaBits.push(`Tool: ${state.currentTool}`);
  if (Number.isFinite(state.toolsUsed) && state.toolsUsed > 0) metaBits.push(`${state.toolsUsed} tool${state.toolsUsed === 1 ? '' : 's'} used`);
  const elapsed = taskChipElapsed(state.startedAt, ts);
  if (elapsed) metaBits.push(elapsed);
  if (state.startedAt) metaBits.push(`Started ${taskChipTime(state.startedAt)}`);
  if (state.lastActivityAt) metaBits.push(`Updated ${taskChipTime(state.lastActivityAt)}`);
  metaLine.textContent = metaBits.join(' · ');
  metaLine.style.display = metaBits.length ? '' : 'none';

  let childrenEl = el.querySelector('.task-chip-children');
  if (!childrenEl) {
    childrenEl = document.createElement('div');
    childrenEl.className = 'task-chip-children';
    childrenEl.style.cssText = 'display:grid;gap:4px;margin-bottom:6px;font-size:11px;color:var(--text)';
    el.insertBefore(childrenEl, metaLine.nextSibling);
  }
  if (Array.isArray(state.childTasks)) {
    const childRows = state.childTasks.filter(c => c?.taskId || c?.name).slice(-6);
    if (childRows.length) {
      childrenEl.innerHTML = '';
      for (const child of childRows) {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:rgba(127,127,127,0.04)';
        const left = document.createElement('div');
        left.style.cssText = 'min-width:0;display:grid;gap:1px';
        const name = document.createElement('div');
        name.textContent = child.name || 'Agent';
        name.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const detail = document.createElement('div');
        detail.textContent = child.summary || child.finalReportPreview || '';
        detail.style.cssText = 'color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        left.appendChild(name);
        if (detail.textContent) left.appendChild(detail);
        const stateEl = document.createElement('div');
        stateEl.textContent = child.currentTool ? `using ${child.currentTool}` : (child.status || 'running');
        stateEl.style.cssText = 'color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums';
        row.appendChild(left);
        row.appendChild(stateEl);
        childrenEl.appendChild(row);
      }
      childrenEl.style.display = '';
    } else {
      childrenEl.innerHTML = '';
      childrenEl.style.display = 'none';
    }
  } else if (!childrenEl.children.length) {
    childrenEl.style.display = 'none';
  }

  // Latest status line (current tool, last result, awaiting question, final
  // output). Fixed-height with internal scrollbar so streaming node_exec
  // output doesn't repeatedly resize the chat while apt/dpkg prints.
  // white-space:pre-wrap preserves newlines; monospace for shell-output
  // legibility; overscroll-contain isolates the scroll so the outer chat
  // doesn't scroll when you wheel inside the chip.
  let statusLine = el.querySelector('.task-chip-status');
  if (!statusLine) {
    statusLine = document.createElement('div');
    statusLine.className = 'task-chip-status';
    statusLine.style.cssText = 'font-size:12px;color:var(--text);padding:6px 8px;background:var(--bg1);border-radius:4px;line-height:1.4;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all;height:14em;overflow-y:auto;overscroll-behavior:contain';
    el.appendChild(statusLine);
  }
  // Track scroll-anchoring: if user has scrolled away from the bottom, don't
  // auto-jump on each new status push. If they're AT the bottom (live tail),
  // keep them there.
  const wasAtBottom = statusLine.scrollHeight - statusLine.scrollTop - statusLine.clientHeight < 4;
  statusLine.textContent = status.text || '';
  if (wasAtBottom) statusLine.scrollTop = statusLine.scrollHeight;

  let recent = el.querySelector('.task-chip-recent');
  if (!recent) {
    recent = document.createElement('div');
    recent.className = 'task-chip-recent';
    recent.style.cssText = 'margin-top:6px;font-size:11px;color:var(--muted);line-height:1.4;display:grid;gap:3px;max-height:4.2em;overflow:hidden';
    el.appendChild(recent);
  }
  const history = Array.isArray(status.recentHistory) ? status.recentHistory.slice(-4) : null;
  const rows = history ? history.filter(h => h?.text && h.text !== status.text) : null;
  if (rows?.length) {
    recent.innerHTML = '';
    for (const h of rows) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;min-width:0';
      const t = document.createElement('span');
      t.textContent = taskChipTime(h.ts);
      t.style.cssText = 'flex:0 0 auto;opacity:0.6;font-variant-numeric:tabular-nums';
      const txt = document.createElement('span');
      txt.textContent = h.text || '';
      txt.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      row.appendChild(t);
      row.appendChild(txt);
      recent.appendChild(row);
    }
    recent.style.display = '';
  } else if (history) {
    recent.style.display = 'none';
  }

  // Final-state border + background tint
  if (final) {
    if (finalStatus === 'done') {
      el.style.borderLeftColor = 'var(--green, #4caf50)';
      el.style.background = 'rgba(76,175,80,0.06)';
    } else if (finalStatus === 'error') {
      el.style.borderLeftColor = 'var(--red, #f44336)';
      el.style.background = 'rgba(244,67,54,0.06)';
    } else if (finalStatus === 'cancelled') {
      el.style.borderLeftColor = 'var(--orange, #c80)';
      el.style.background = 'rgba(204,136,0,0.06)';
    } else {
      el.style.opacity = '0.75';
    }
  }

  // Reply input — appears ONLY when awaiting_input, removed otherwise.
  // Multi-tab: when the server WS reports awaiting_input=false (another tab
  // already replied), this branch removes the form so neither tab can
  // submit again. First-write-wins is enforced server-side too.
  let replyBox = el.querySelector('.task-chip-reply');
  if (status.awaiting_input) {
    if (!replyBox) {
      replyBox = document.createElement('div');
      replyBox.className = 'task-chip-reply';
      replyBox.style.cssText = 'margin-top:8px;display:flex;gap:6px;align-items:center';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Your reply…';
      input.style.cssText = 'flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:5px 8px;font-size:12px;color:var(--text)';
      const btn = document.createElement('button');
      btn.textContent = 'Send';
      btn.style.cssText = 'background:var(--accent,#4f82ff);color:#fff;border:none;border-radius:4px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:500';
      const send = async () => {
        const reply = input.value.trim();
        if (!reply) return;
        input.disabled = true; btn.disabled = true; btn.textContent = '…';
        try {
          const r = await fetch(`/api/watchers/${encodeURIComponent(watcherId)}/reply`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reply }),
          });
          if (!r.ok && r.status !== 409) {
            input.disabled = false; btn.disabled = false; btn.textContent = 'Send';
            const err = await r.json().catch(() => ({}));
            alert(`Reply failed: ${err.error || r.statusText}`);
          }
          // On success the server broadcasts a new status with
          // awaiting_input=false; the next applyStatus tick will remove
          // the reply box from BOTH tabs.
        } catch (e) {
          input.disabled = false; btn.disabled = false; btn.textContent = 'Send';
          alert(`Reply failed: ${e.message}`);
        }
      };
      btn.addEventListener('click', send);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); send(); } });
      replyBox.appendChild(input);
      replyBox.appendChild(btn);
      el.appendChild(replyBox);
      // Focus the input so the user can just type and Enter
      setTimeout(() => input.focus(), 50);
    }
  } else if (replyBox) {
    replyBox.remove();
  }

  if (!isUpdate) {
    insertBefore(el);
    if (scroll) scrollToBottom();
  }
}

function appendStatusBubble(status, ts = Date.now(), scroll = true) {
  // Phase-14: task_proxy watchers get their own richer card treatment
  // (agent header + task line + reply input when awaiting), distinct from
  // the muted-italic generic watcher status.
  if (status.kind === 'task_proxy') {
    return appendTaskChip(status, ts, scroll);
  }
  const watcherId = status.watcherId || '';
  let el = watcherId ? document.querySelector(`.msg.watcher-status[data-watcher-id="${CSS.escape(watcherId)}"]`) : null;
  const isUpdate = !!el;

  if (!el) {
    el = document.createElement('div');
    el.className = 'msg watcher-status';
    el.dataset.watcherId = watcherId;
    el.style.cssText = 'padding:6px 12px;margin:4px 0;font-size:12px;color:var(--muted);font-style:italic;border-left:2px solid var(--border);background:rgba(127,127,127,0.04);border-radius:4px;transition:background 200ms ease,border-color 200ms ease';
  }

  // Header (icon + label + latest text + expand caret) — rebuilt on every
  // update. History panel is a sibling that survives across updates.
  let header = el.querySelector('.watcher-header');
  if (!header) {
    header = document.createElement('div');
    header.className = 'watcher-header';
    header.style.cssText = 'display:flex;gap:8px;align-items:flex-start;cursor:pointer';
    header.title = 'Click to view progress history';
    if (watcherId) {
      header.addEventListener('click', (ev) => {
        if (window.getSelection?.().toString()) return; // don't toggle while user is selecting text
        toggleWatcherHistory(el, watcherId);
        ev.stopPropagation();
      });
    }
    el.appendChild(header);
  }
  header.innerHTML = '';

  const icon = document.createElement('span');
  icon.textContent = status.final ? (status.finalStatus === 'done' ? '✓' : status.finalStatus === 'error' ? '⚠' : '⏰') : '📡';
  icon.style.cssText = 'flex-shrink:0;font-style:normal';
  header.appendChild(icon);

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0';
  if (status.label) {
    const labelEl = document.createElement('div');
    labelEl.style.cssText = 'font-weight:500;font-style:normal;font-size:11px;opacity:0.7;margin-bottom:2px';
    labelEl.textContent = status.label;
    body.appendChild(labelEl);
  }
  const text = document.createElement('div');
  text.textContent = status.text || '';
  body.appendChild(text);
  header.appendChild(body);

  if (watcherId) {
    const caret = document.createElement('span');
    caret.className = 'watcher-caret';
    caret.textContent = el.dataset.historyOpen === '1' ? '▾' : '▸';
    caret.style.cssText = 'flex-shrink:0;font-style:normal;opacity:0.5;font-size:10px;align-self:center';
    header.appendChild(caret);
  }

  // Final-state styling: brighten/dim per outcome so a finished bubble is
  // visually distinct from a still-ticking one.
  if (status.final) {
    if (status.finalStatus === 'done') {
      el.style.borderLeftColor = 'var(--green, #4caf50)';
      el.style.background = 'rgba(76,175,80,0.06)';
    } else if (status.finalStatus === 'error') {
      el.style.borderLeftColor = 'var(--red, #f44336)';
      el.style.background = 'rgba(244,67,54,0.06)';
    } else {
      el.style.borderLeftColor = 'var(--muted)';
      el.style.opacity = '0.7';
    }
  }

  // Phase-14b: when a task_proxy watcher is awaiting input, render an
  // inline reply form on the chip. Multi-tab dedup: when the server WS
  // reports awaiting_input=false (because another tab replied), clear the
  // form. First-write-wins is enforced server-side.
  let replyBox = el.querySelector('.watcher-reply-box');
  if (status.awaiting_input && status.kind === 'task_proxy') {
    if (!replyBox) {
      replyBox = document.createElement('div');
      replyBox.className = 'watcher-reply-box';
      replyBox.style.cssText = 'margin-top:6px;display:flex;gap:6px;align-items:center';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Your reply…';
      input.style.cssText = 'flex:1;background:var(--bg1);border:1px solid var(--border);border-radius:4px;padding:4px 8px;font-size:12px;color:var(--text);font-style:normal';
      const btn = document.createElement('button');
      btn.textContent = 'Send';
      btn.style.cssText = 'background:var(--accent,#4f82ff);color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer';
      const send = async () => {
        const reply = input.value.trim();
        if (!reply) return;
        input.disabled = true; btn.disabled = true; btn.textContent = '…';
        try {
          const r = await fetch(`/api/watchers/${encodeURIComponent(watcherId)}/reply`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reply }),
          });
          if (!r.ok && r.status !== 409) {
            input.disabled = false; btn.disabled = false; btn.textContent = 'Send';
            const err = await r.json().catch(() => ({}));
            alert(`Reply failed: ${err.error || r.statusText}`);
          }
          // On success the server broadcasts a new status with awaiting_input=false;
          // the next applyStatus tick will remove the reply box.
        } catch (e) {
          input.disabled = false; btn.disabled = false; btn.textContent = 'Send';
          alert(`Reply failed: ${e.message}`);
        }
      };
      btn.addEventListener('click', send);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); send(); } });
      replyBox.appendChild(input);
      replyBox.appendChild(btn);
      el.appendChild(replyBox);
    }
  } else if (replyBox) {
    // No longer awaiting — server-side state cleared (replied, timed out,
    // task finalized). Remove the input form so neither tab can submit again.
    replyBox.remove();
  }

  if (!isUpdate) {
    insertBefore(el);
    if (scroll) scrollToBottom();
  } else {
    // Subtle flash so the user notices the update without yanking scroll.
    el.style.background = 'rgba(127,127,127,0.12)';
    setTimeout(() => {
      // Restore the resting background unless we just set a final-state one.
      if (!status.final) el.style.background = 'rgba(127,127,127,0.04)';
    }, 200);
    // If history panel is currently open, refresh it so the new update shows.
    if (el.dataset.historyOpen === '1') refreshWatcherHistory(el, watcherId);
  }
  return el;
}

// Friction-tracker proposal bubble — rendered when the cortex friction head
// detects a 3rd repetition of an actionable phrasing and proposes an
// automation (recurring task or watch). Two action buttons; click one and
// the bubble mutates in place to the outcome. Transient — not persisted to
// the session today, so reloading the chat removes pending bubbles.
function appendProposalBubble(proposal, scroll = true) {
  const id = proposal.proposalId;
  if (!id) return;
  // De-dupe: if a bubble already exists for this proposal id, leave it alone.
  if (document.querySelector(`.msg.proposal[data-proposal-id="${CSS.escape(id)}"]`)) return;

  const el = document.createElement('div');
  el.className = 'msg proposal';
  el.dataset.proposalId = id;
  // Phase-11a: stash the kind so applyProposalOutcome can render a
  // kind-specific "Learned: X" chip distinct from generic accept.
  if (proposal.kind) el.dataset.proposalKind = proposal.kind;
  el.style.cssText = 'padding:10px 12px;margin:6px 0;font-size:13px;border-left:3px solid var(--accent, #6c8cff);background:rgba(108,140,255,0.06);border-radius:4px';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:4px';
  const icon = document.createElement('span');
  icon.textContent = '💡';
  header.appendChild(icon);
  const label = document.createElement('span');
  label.style.cssText = 'font-weight:600';
  const HEADER_BY_KIND = {
    watch:              'Set up a monitor?',
    recurring_task:     'Make this a recurring task?',
    rule_promotion:     'Promote this correction to a standing rule?',
    skill_proposal:     'Bundle this workflow into a skill?',
    skill_refine:       'Refine this skill based on your corrections?',
    skill_deprecation:  'This skill keeps getting corrected — delete it?',
    routine_proposal:   'Save this as a voice routine?',
    alias_proposal:     'Remember this phrase shortcut?',
    personalization_offer:    'A suggestion based on what I\'ve noticed',
    personalization_graduate: 'Always do this from now on?',
  };
  label.textContent = HEADER_BY_KIND[proposal.kind] || 'Proposal';
  header.appendChild(label);
  el.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = 'color:var(--muted);font-size:12px;margin-bottom:8px;white-space:pre-wrap';
  // Friction proposals (watch / recurring_task) are the only kinds whose
  // server-side message text is the bare user phrasing — they need the
  // "You've asked this a few times" preamble for context. All other kinds
  // already build a self-contained body server-side, so render their message
  // verbatim.
  const isFrictionKind = proposal.kind === 'watch' || proposal.kind === 'recurring_task';
  body.textContent = isFrictionKind
    ? `You've asked this a few times: "${proposal.message}"`
    : (proposal.message || '');
  el.appendChild(body);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px';

  const acceptBtn = document.createElement('button');
  acceptBtn.textContent = proposal.accept_label || 'Set it up';
  acceptBtn.style.cssText = 'padding:6px 12px;border:1px solid var(--accent, #6c8cff);background:var(--accent, #6c8cff);color:#fff;border-radius:4px;cursor:pointer;font-size:12px';
  acceptBtn.addEventListener('click', () => respondToProposal(el, id, 'accept', acceptBtn, dismissBtn));
  actions.appendChild(acceptBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = proposal.dismiss_label || 'No thanks';
  dismissBtn.style.cssText = 'padding:6px 12px;border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:4px;cursor:pointer;font-size:12px';
  dismissBtn.addEventListener('click', () => respondToProposal(el, id, 'dismiss', acceptBtn, dismissBtn));
  actions.appendChild(dismissBtn);

  // Permanent opt-out — dismiss only snoozes this pattern for 24h; this one
  // records it so it's never proposed again.
  const neverBtn = document.createElement('button');
  neverBtn.textContent = "Don't propose again";
  neverBtn.title = 'Never suggest this again (a normal dismiss only hides it for 24h)';
  neverBtn.style.cssText = 'padding:6px 12px;border:none;background:transparent;color:var(--muted);border-radius:4px;cursor:pointer;font-size:12px;text-decoration:underline;opacity:0.75';
  neverBtn.addEventListener('click', () => respondToProposal(el, id, 'never', acceptBtn, dismissBtn));
  actions.appendChild(neverBtn);

  el.appendChild(actions);
  insertBefore(el);
  if (scroll) scrollToBottom();
}

// Apply a proposal_outcome event against an already-rendered proposal
// bubble — mutates the bubble in place. Three sources call this:
//   1. session-load render pass (replay of persisted proposal_outcome entries)
//   2. WS push of type 'proposal_outcome' (live update from server)
//   3. respondToProposal local optimism on click (best-effort — the WS push
//      will overwrite with the authoritative server state)
//
// Status progression: pending → running → (accepted | dismissed | failed).
// Idempotent within a status: re-applying the same status leaves the bubble
// unchanged. Earlier statuses are also safe to apply but get overwritten on
// the next call. Buttons are removed once the bubble leaves the pending
// state — re-clicking would call /accept on a non-pending proposal.
function applyProposalOutcome(proposalId, status, outcome) {
  const el = document.querySelector(`.msg.proposal[data-proposal-id="${CSS.escape(proposalId)}"]`);
  if (!el) return;
  if (el.dataset.appliedStatus === status) return;
  el.dataset.appliedStatus = status;

  // Strip any previous footer (buttons or outcome line) and rebuild.
  const footer = el.querySelector('.proposal-footer');
  if (footer) footer.remove();
  const buttonRow = [...el.children].find(c => c.querySelector?.('button'));
  if (buttonRow && status !== 'pending') buttonRow.remove();

  const outcomeEl = document.createElement('div');
  outcomeEl.className = 'proposal-footer';
  outcomeEl.style.cssText = 'font-size:12px;color:var(--muted);font-style:italic;margin-top:6px';

  if (status === 'running') {
    // Don't overwrite color — keep it the original accent so it reads as
    // "in flight" rather than completed.
    outcomeEl.textContent = `… ${outcome || 'Setting it up…'}`;
  } else if (status === 'accepted') {
    el.style.borderLeftColor = 'var(--green, #4caf50)';
    el.style.background = 'rgba(76,175,80,0.06)';
    outcomeEl.textContent = `✓ Accepted${outcome ? ` — ${outcome}` : ''}`;
    // Phase-13: inline undo button for kinds we can revoke. Visible for 24h
    // after acceptance; after that the user uses the Learn drawer's revoke.
    const UNDOABLE_KINDS = new Set(['rule_promotion', 'alias_proposal', 'routine_proposal', 'default_arg', 'routing_override']);
    if (UNDOABLE_KINDS.has(el.dataset.proposalKind)) {
      const undoBtn = document.createElement('button');
      undoBtn.textContent = 'Undo';
      undoBtn.style.cssText = 'margin-left:8px;background:transparent;border:1px solid var(--border);border-radius:3px;padding:1px 8px;font-size:11px;color:var(--muted);cursor:pointer;vertical-align:middle';
      undoBtn.title = 'Revert within 24h';
      undoBtn.onclick = async () => {
        undoBtn.disabled = true; undoBtn.textContent = '…';
        try {
          const r = await fetch(`/api/proposals/${encodeURIComponent(el.dataset.proposalId)}/undo`, { method: 'POST' });
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            alert(`Undo failed: ${e.error || r.statusText}`);
            undoBtn.disabled = false; undoBtn.textContent = 'Undo';
          }
        } catch (e) { alert(`Undo failed: ${e.message}`); undoBtn.disabled = false; undoBtn.textContent = 'Undo'; }
      };
      outcomeEl.appendChild(undoBtn);
    }
    // Phase-11a: NL chip — kind-specific badge for accepted learnings. Tells
    // the user at a glance what category of customization just stuck.
    const LEARNING_KIND_LABELS = {
      rule_promotion:   'Rule learned',
      alias_proposal:   'Alias learned',
      routine_proposal: 'Routine learned',
      default_arg:      'Default pinned',
      routing_override: 'Routing learned',
      location_fact:    'Location learned',
      skill_proposal:   'Skill built',
    };
    const kind = el.dataset.proposalKind;
    const label = LEARNING_KIND_LABELS[kind];
    if (label && !el.querySelector('.learning-chip')) {
      const chip = document.createElement('span');
      chip.className = 'learning-chip';
      chip.textContent = label;
      chip.style.cssText = 'display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;background:var(--green,#4caf50);color:#fff;padding:1px 6px;border-radius:3px;margin-left:8px;vertical-align:middle';
      const header = el.querySelector('div');   // first <div> = bubble header row
      if (header) header.appendChild(chip);
    }
  } else if (status === 'done') {
    // Terminal status used by the personalization kinds (offer/graduate) —
    // render like 'accepted' and keep the receipt text ('Done — Reminder ...').
    el.style.borderLeftColor = 'var(--green, #4caf50)';
    el.style.background = 'rgba(76,175,80,0.06)';
    outcomeEl.textContent = outcome ? `✓ ${outcome}` : '✓ Done';
  } else if (status === 'dismissed') {
    el.style.opacity = '0.6';
    outcomeEl.textContent = '✕ Dismissed';
  } else if (status === 'failed') {
    el.style.borderLeftColor = 'var(--red, #f44336)';
    el.style.background = 'rgba(244,67,54,0.06)';
    outcomeEl.textContent = `⚠ ${outcome || 'Failed'}`;
  } else if (status === 'undone') {
    el.style.borderLeftColor = 'var(--border)';
    el.style.background = 'transparent';
    el.style.opacity = '0.55';
    // Remove any prior learning-chip badge — the learning has been reverted
    const chip = el.querySelector('.learning-chip');
    if (chip) chip.remove();
    outcomeEl.textContent = `↩ ${outcome || 'Reverted'}`;
  } else {
    outcomeEl.textContent = `· ${status}`;
  }
  el.appendChild(outcomeEl);
}

async function respondToProposal(el, id, action, acceptBtn, dismissBtn) {
  acceptBtn.disabled = true; dismissBtn.disabled = true;
  acceptBtn.style.opacity = '0.5'; dismissBtn.style.opacity = '0.5';
  try {
    const r = await fetch(`/api/proposals/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    const data = await r.json().catch(() => ({}));
    if (action === 'accept') {
      // Server accepted asynchronously — render the in-flight state. The
      // authoritative final outcome arrives via WS 'proposal_outcome' push
      // when the agent run completes (success or retry-exhausted failure).
      applyProposalOutcome(id, data.ok ? 'running' : 'failed', data.ok ? 'Setting it up…' : `Couldn’t set it up: ${data.error || 'unknown'}`);
    } else {
      // Dismiss is fast (no agent run) — apply final state immediately.
      applyProposalOutcome(id, 'dismissed', null);
    }
  } catch (e) {
    acceptBtn.disabled = false; dismissBtn.disabled = false;
    acceptBtn.style.opacity = '1'; dismissBtn.style.opacity = '1';
    alert('Proposal action failed: ' + e.message);
  }
}

// Attachment save/discard prompt. Emitted by chat-dispatch at the end of any
// turn that had a file attachment (drag-drop, paste, or attach button). The
// upload always lands in users/<id>/profile-files/{kind}/ — this bubble is
// the only "did you mean to keep that?" gate so casual one-shot uploads don't
// silently pile up in Docs. Persisted as role:'attachment_decision' so a
// reload still shows the choice; outcome arrives as role:'attachment_decision_outcome'.
function appendAttachmentDecisionBubble(decision, scroll = true) {
  const id = decision.decisionId;
  if (!id) return;
  if (document.querySelector(`.msg.attachment-decision[data-decision-id="${CSS.escape(id)}"]`)) return;

  const el = document.createElement('div');
  el.className = 'msg attachment-decision';
  el.dataset.decisionId = id;
  el.dataset.fileId = decision.file_id || '';
  el.style.cssText = 'padding:8px 12px;margin:6px 0;font-size:13px;border-left:3px solid var(--muted, #888);background:rgba(128,128,128,0.06);border-radius:4px;display:flex;align-items:center;gap:10px;flex-wrap:wrap';

  const label = document.createElement('span');
  label.style.cssText = 'flex:1;min-width:0;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  const safeName = escHtml(decision.name || 'attachment');
  label.innerHTML = `Keep <strong style="color:var(--text)">${safeName}</strong> in your files?`;
  el.appendChild(label);

  const keepBtn = document.createElement('button');
  keepBtn.textContent = 'Keep';
  keepBtn.style.cssText = 'padding:4px 12px;border:1px solid var(--accent, #6c8cff);background:var(--accent, #6c8cff);color:#fff;border-radius:4px;cursor:pointer;font-size:12px';
  keepBtn.addEventListener('click', () => respondToAttachmentDecision(el, id, decision.file_id, 'keep', keepBtn, discardBtn));
  el.appendChild(keepBtn);

  const discardBtn = document.createElement('button');
  discardBtn.textContent = 'Discard';
  discardBtn.style.cssText = 'padding:4px 12px;border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:4px;cursor:pointer;font-size:12px';
  discardBtn.addEventListener('click', () => respondToAttachmentDecision(el, id, decision.file_id, 'discard', keepBtn, discardBtn));
  el.appendChild(discardBtn);

  insertBefore(el);
  if (scroll) scrollToBottom();
}

function applyAttachmentDecisionOutcome(decisionId, decision) {
  const el = document.querySelector(`.msg.attachment-decision[data-decision-id="${CSS.escape(decisionId)}"]`);
  if (!el) return;
  if (el.dataset.appliedOutcome === decision) return;
  el.dataset.appliedOutcome = decision;
  // Strip the buttons, leave a one-line resolved note.
  [...el.querySelectorAll('button')].forEach(b => b.remove());
  const label = el.querySelector('span');
  if (label) {
    const name = label.querySelector('strong')?.textContent || 'attachment';
    label.innerHTML = decision === 'keep'
      ? `✓ Kept <strong style="color:var(--text)">${escHtml(name)}</strong> in your files.`
      : `✕ Discarded <strong style="color:var(--text)">${escHtml(name)}</strong>.`;
  }
  el.style.borderLeftColor = decision === 'keep' ? 'var(--green, #4caf50)' : 'var(--border)';
}

async function respondToAttachmentDecision(el, decisionId, fileId, decision, keepBtn, discardBtn) {
  keepBtn.disabled = true; discardBtn.disabled = true;
  keepBtn.style.opacity = '0.5'; discardBtn.style.opacity = '0.5';
  try {
    const r = await fetch('/api/chat-attachment-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisionId, file_id: fileId, decision, agent: activeAgent }),
    });
    if (!r.ok) throw new Error(await r.text());
    applyAttachmentDecisionOutcome(decisionId, decision);
  } catch (e) {
    keepBtn.disabled = false; discardBtn.disabled = false;
    keepBtn.style.opacity = '1'; discardBtn.style.opacity = '1';
    alert('Couldn’t save your choice: ' + e.message);
  }
}

// Pending-approval pill. Emitted by chat-dispatch's post-turn diff (see
// snapshotPendingApprovals in chat-dispatch.mjs) whenever one of the four
// staged destructive-op families — email purge/batch-trash, expense delete,
// profile trust-state promotion, cross-agent watcher op — is pending after a
// turn. Approve sends the exact confirmation phrase as a normal chat message
// (the server's existing tryApprovalIntercept text match executes it
// unchanged, so the keyboard path keeps working too); modern Cancel buttons
// send a targeted CANCEL APPROVAL #opId phrase so a stale card cannot clear a
// newer operation (legacy cards without an id retain the old fallback).
// Persisted as role:'approval_pending' so a reload still shows it; the
// resolution arrives as role:'approval_resolved' (applyApprovalResolved).
function appendApprovalPendingBubble(pending, scroll = true) {
  const kind = pending.kind;
  if (!kind) return;
  // De-dupe by kind — at most one staged op per family. A re-emit for a kind
  // that's already showing (e.g. persisted-session replay racing a live
  // push) refreshes the existing pill's text instead of stacking a second.
  const existing = document.querySelector(`.msg.approval-pending[data-approval-kind="${CSS.escape(kind)}"]`);
  const el = existing || document.createElement('div');
  if (el._approvalExpiryTimer) {
    clearTimeout(el._approvalExpiryTimer);
    el._approvalExpiryTimer = null;
  }
  if (!existing) {
    el.className = 'msg approval-pending';
    el.dataset.approvalKind = kind;
  }
  // Operation id minted at stage time (lib/pending-approvals.mjs). Sent as a
  // "#<opId>" suffix on Approve so the server can refuse a stale card — one
  // describing an op that was since replaced by a newer staging of the same
  // kind. Absent on legacy rows; those fall back to the bare phrase.
  if (pending.opId) el.dataset.opId = pending.opId;
  else delete el.dataset.opId;
  if (pending.ts != null && Number.isFinite(Number(pending.ts))) el.dataset.approvalTs = String(Number(pending.ts));
  else delete el.dataset.approvalTs;
  delete el.dataset.appliedStatus; // re-pending clears any prior resolved marker
  el.style.cssText = 'padding:10px 12px;margin:6px 0;font-size:13px;border-left:3px solid var(--red, #f44336);background:rgba(244,67,54,0.06);border-radius:4px';
  el.innerHTML = '';

  const label = document.createElement('div');
  label.style.cssText = 'margin-bottom:8px';
  label.innerHTML = `⚠️ <strong>Waiting for approval:</strong> ${escHtml(pending.description || 'a staged action needs your confirmation')}`;
  el.appendChild(label);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px';

  const phrase = pending.phrase || 'APPROVE';
  const approveBtn = document.createElement('button');
  approveBtn.textContent = `Approve (${phrase})`;
  approveBtn.style.cssText = 'padding:6px 12px;border:1px solid var(--red, #f44336);background:var(--red, #f44336);color:#fff;border-radius:4px;cursor:pointer;font-size:12px';
  // Read the opId off the element at click time (not capture time) so a
  // re-staged pill that refreshed this bubble in place sends the CURRENT id.
  approveBtn.addEventListener('click', () => respondToApproval(el.dataset.opId ? `${phrase} #${el.dataset.opId}` : phrase, approveBtn, cancelBtn));
  actions.appendChild(approveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:6px 12px;border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:4px;cursor:pointer;font-size:12px';
  cancelBtn.addEventListener('click', () => {
    const currentOpId = el.dataset.opId;
    respondToApproval(currentOpId ? `CANCEL APPROVAL #${currentOpId}` : 'cancel', approveBtn, cancelBtn);
  });
  actions.appendChild(cancelBtn);

  el.appendChild(actions);
  if (!existing) insertBefore(el);

  // Watcher approvals currently carry a five-minute expiry. Disable the card
  // at that deadline (including immediately on replay of an already-expired
  // persisted row) so it cannot look actionable after the server has dropped
  // the staged operation. The expected id guard prevents an old timer from
  // disabling a refreshed card for a newer staging of the same kind.
  const expiresAt = typeof pending.expiresAt === 'number'
    ? pending.expiresAt
    : Date.parse(pending.expiresAt || '');
  if (Number.isFinite(expiresAt)) {
    el.dataset.expiresAt = String(expiresAt);
    const expectedOpId = el.dataset.opId || '';
    const expire = () => {
      if ((el.dataset.opId || '') !== expectedOpId) return;
      if (el.dataset.appliedStatus === 'resolved') return;
      const remaining = expiresAt - Date.now();
      if (remaining > 0) {
        el._approvalExpiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        return;
      }
      el._approvalExpiryTimer = null;
      el.dataset.appliedStatus = 'expired';
      [...el.querySelectorAll('button')].forEach(b => {
        b.disabled = true;
        b.style.opacity = '0.5';
        b.style.cursor = 'default';
      });
      el.style.borderLeftColor = 'var(--border)';
      el.style.opacity = '0.6';
      const footer = document.createElement('div');
      footer.className = 'approval-status';
      footer.style.cssText = 'font-size:12px;color:var(--muted);font-style:italic;margin-top:6px';
      footer.textContent = '· Expired';
      el.appendChild(footer);
    };
    expire();
  } else {
    delete el.dataset.expiresAt;
  }
  if (scroll) scrollToBottom();
}

// Apply an approval_resolved push (or persisted-session replay of one)
// against an already-rendered pill — mutates in place, mirroring
// applyProposalOutcome / applyAttachmentDecisionOutcome. Fires once the
// staged op is gone: approved-and-executed, or cleared by the "say anything
// else to cancel" rule (any non-matching message clears it server-side).
function applyApprovalResolved(kind, opId = null, resolvedTs = null) {
  if (!kind) return;
  const el = document.querySelector(`.msg.approval-pending[data-approval-kind="${CSS.escape(kind)}"]`);
  if (!el) return;
  const renderedOpId = el.dataset.opId || null;
  // New resolution events must match exactly. For pre-upgrade resolution rows
  // that lack an id, timestamps are the safe migration fallback: only a row at
  // or after this card's staging may resolve it. An older delayed row cannot
  // collapse a newer operation, and rows with no usable correlation stay put.
  if (opId) {
    if (renderedOpId !== opId) return;
  } else if (renderedOpId !== null) {
    const pendingTs = Number(el.dataset.approvalTs);
    const eventTs = resolvedTs == null ? NaN : Number(resolvedTs);
    if (!Number.isFinite(pendingTs) || !Number.isFinite(eventTs) || eventTs < pendingTs) return;
  }
  if (el.dataset.appliedStatus === 'resolved') return;
  if (el._approvalExpiryTimer) {
    clearTimeout(el._approvalExpiryTimer);
    el._approvalExpiryTimer = null;
  }
  el.dataset.appliedStatus = 'resolved';
  [...el.querySelectorAll('button')].forEach(b => b.remove());
  el.querySelector('.approval-status')?.remove();
  el.style.borderLeftColor = 'var(--border)';
  el.style.opacity = '0.6';
  const footer = document.createElement('div');
  footer.className = 'approval-status';
  footer.style.cssText = 'font-size:12px;color:var(--muted);font-style:italic;margin-top:6px';
  footer.textContent = '· Resolved';
  el.appendChild(footer);
}

// Approve/Cancel click handler: sends the given text through the existing
// send() pipeline — the same code path as if the user had typed the phrase
// themselves — so the server's text-match intercept handles it. Mirrors
// send()'s guards and restores a half-written composer draft after the action.
function respondToApproval(text, approveBtn, cancelBtn) {
  if (streaming && !awaitingPermission) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Not connected — try again in a moment'); return; }
  if (pendingAttachments.length) { showToast('Send or remove attachments before responding to an approval'); return; }
  approveBtn.disabled = true; cancelBtn.disabled = true;
  approveBtn.style.opacity = '0.5'; cancelBtn.style.opacity = '0.5';
  const input = $('input');
  const prevValue = input.value;
  input.value = text;
  send();
  // send() clears input.value on success. Either way, put back the user's
  // draft; approval buttons should not silently destroy unrelated typing.
  const sent = input.value !== text;
  input.value = prevValue;
  resizeTextarea();
  saveDraftForAgent(activeAgent);
  if (!sent) {
    approveBtn.disabled = false; cancelBtn.disabled = false;
    approveBtn.style.opacity = '1'; cancelBtn.style.opacity = '1';
  }
}

async function toggleWatcherHistory(el, watcherId) {
  let panel = el.querySelector('.watcher-history');
  if (panel && el.dataset.historyOpen === '1') {
    panel.style.display = 'none';
    el.dataset.historyOpen = '0';
    const caret = el.querySelector('.watcher-caret'); if (caret) caret.textContent = '▸';
    return;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'watcher-history';
    panel.style.cssText = 'margin-top:6px;padding:6px 8px 4px 26px;border-top:1px dashed var(--border);font-size:11px;font-style:normal;max-height:240px;overflow-y:auto';
    panel.textContent = 'Loading…';
    el.appendChild(panel);
  }
  panel.style.display = 'block';
  el.dataset.historyOpen = '1';
  const caret = el.querySelector('.watcher-caret'); if (caret) caret.textContent = '▾';
  await refreshWatcherHistory(el, watcherId);
}

async function refreshWatcherHistory(el, watcherId) {
  const panel = el.querySelector('.watcher-history');
  if (!panel) return;
  try {
    const r = await fetch(`/api/watchers/${encodeURIComponent(watcherId)}`, { credentials: 'same-origin' });
    if (!r.ok) {
      panel.textContent = r.status === 404 ? 'No history available (watcher reaped).' : `Failed to load history (${r.status}).`;
      return;
    }
    const w = await r.json();
    const entries = Array.isArray(w.history) ? w.history : [];
    if (!entries.length) {
      panel.textContent = 'No progress entries yet.';
      return;
    }
    panel.innerHTML = '';
    for (const entry of entries) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;padding:2px 0;line-height:1.4';
      const t = new Date(entry.ts || 0);
      const hh = String(t.getHours()).padStart(2,'0');
      const mm = String(t.getMinutes()).padStart(2,'0');
      const ss = String(t.getSeconds()).padStart(2,'0');
      const time = document.createElement('span');
      time.textContent = `${hh}:${mm}:${ss}`;
      time.style.cssText = 'flex-shrink:0;opacity:0.55;font-variant-numeric:tabular-nums';
      const txt = document.createElement('span');
      txt.textContent = entry.text || '';
      txt.style.cssText = 'flex:1;min-width:0;white-space:pre-wrap;word-break:break-word';
      if (entry.final) {
        if (entry.finalStatus === 'done') txt.style.color = 'var(--green, #4caf50)';
        else if (entry.finalStatus === 'error') txt.style.color = 'var(--red, #f44336)';
      }
      row.appendChild(time); row.appendChild(txt);
      panel.appendChild(row);
    }
  } catch (e) {
    panel.textContent = `Failed to load history: ${e.message}`;
  }
}

function authenticatedVideoUrl(rawUrl) {
  const value = typeof rawUrl === 'string' ? rawUrl : '';
  if (!value.startsWith('/api/desktop/videos/')) return value;
  const token = typeof getMediaTokenSync === 'function' ? getMediaTokenSync() : '';
  if (!token) return value;
  const hashAt = value.indexOf('#');
  const hash = hashAt >= 0 ? value.slice(hashAt) : '';
  const withoutHash = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const queryAt = withoutHash.indexOf('?');
  const pathname = queryAt >= 0 ? withoutHash.slice(0, queryAt) : withoutHash;
  const params = new URLSearchParams(queryAt >= 0 ? withoutHash.slice(queryAt + 1) : '');
  params.set('token', token);
  return `${pathname}?${params.toString()}${hash}`;
}

function appendVideoBubble(video, ts = Date.now(), scroll = true) {
  const el = msgEl('assistant');
  const bubble = el.querySelector('.msg-bubble');
  const videoUrl = authenticatedVideoUrl(video.url);

  const videoEl = document.createElement('video');
  videoEl.src = videoUrl;
  videoEl.controls = true;
  videoEl.style.cssText = 'max-width:100%;border-radius:8px;display:block';
  bubble.appendChild(videoEl);

  const meta = document.createElement('div');
  meta.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--muted)';
  if (video.savedPath) {
    const saved = document.createElement('span');
    saved.innerHTML = `${icon('save', 12)} Saved to ${escHtml(video.savedPath)}`;
    saved.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    meta.appendChild(saved);
  } else {
    const dlBtn = document.createElement('a');
    dlBtn.innerHTML = `${icon('download', 12)} Download`;
    dlBtn.href = videoUrl;
    dlBtn.download = video.filename;
    dlBtn.target = '_blank';
    dlBtn.style.cssText = 'color:var(--accent);text-decoration:none;cursor:pointer;flex-shrink:0';
    meta.appendChild(dlBtn);
  }
  bubble.appendChild(meta);

  addTimestamp(el, ts); insertBefore(el);
  if (scroll) scrollToBottom();
  return el;
}
function appendStreamingBubble() {
  const el = msgEl('assistant'); insertBefore(el);
  return el.querySelector('.msg-bubble');
}
function formatToolDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)}ms`;
  const sec = n / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return rem ? `${min}m ${rem}s` : `${min}m`;
}
// Resolve an agent id (or an already-a-name string) to its human display name,
// so delegation pills read "Asking Coordinator" instead of "ask_agent → agent_2df…".
function friendlyAgentName(idOrName) {
  if (!idOrName) return 'agent';
  const needle = String(idOrName).toLowerCase();
  const list = (typeof agents !== 'undefined' && Array.isArray(agents)) ? agents : [];
  const a = list.find(x => x.id === idOrName
    || x.name?.toLowerCase() === needle
    || x.role?.toLowerCase() === needle);
  if (a?.name) return a.name;
  if (needle === 'coordinator') return 'Coordinator';
  return String(idOrName);
}

// Human-readable label for a tool pill. Most tools just show their raw name; the
// jargon-y delegation tools get a plain-language label so the user can tell what
// is happening without reading internal code names.
function toolDisplayLabel(name, args) {
  if (name === 'ask_agent' && args?.agent_id) return `Asking ${friendlyAgentName(args.agent_id)}`;
  if (name === 'waiting_for_agent')           return `Waiting for ${friendlyAgentName(args?.agent)}`;
  if (name === 'request_tools')               return 'Loading tools';
  // Email tools get plain-language labels so a long sort reads as a running
  // narration ("Auto-sorting inbox", "Labeling email → Promotions · 12") instead
  // of a row of identical "email_batch_label" pills.
  if (name === 'email_sort_local')     return 'Auto-sorting inbox';
  if (name === 'email_batch_label')    return 'Labeling email';
  if (name === 'email_list')           return 'Reading inbox';
  if (name === 'email_list_labels')    return 'Reading labels';
  if (name === 'email_learned_labels') return 'Checking learned labels';
  if (name === 'email_correct_label')  return 'Saving label rule';
  if (name === 'email_remove_label_correction') return 'Removing label rule';
  return name;
}

function toolGroupLabel(name) {
  if (!name) return 'Tools';
  if (name.startsWith('email_')) return 'Email';
  if (name.startsWith('node_')) return 'Node';
  if (name.startsWith('ha_')) return 'Home';
  if (name.startsWith('task_') || name === 'set_reminder' || name === 'schedule_task') return 'Tasks';
  if (name === 'ask_agent' || name === 'waiting_for_agent') return 'Delegation';
  if (name === 'web_search' || name === 'fetch_url') return 'Web';
  return 'Tools';
}

function toolUiHidden(name) {
  return name === 'request_tools';
}

// Pull the most informative arg for a tool into a one-line subtitle.
// Returns '' if nothing useful is available — the pill stays as just the name.
function toolPillSubtitle(name, args) {
  if (!args || typeof args !== 'object') return '';
  // Delegation: the label already names the target agent, so the subtitle carries
  // the actual task being handed off — this is the "what is she doing?" the user
  // was missing when an ask_agent call just showed "ask_agent → coordinator".
  if (name === 'ask_agent') {
    return typeof args.task === 'string' ? args.task : '';
  }
  // Email tools — narrate the actual work so a multi-call sort shows progress.
  if (name === 'email_batch_label') {
    const add = Array.isArray(args.addLabels) ? args.addLabels.join(', ') : '';
    const n   = Array.isArray(args.messageIds) ? args.messageIds.length : 0;
    const arch = Array.isArray(args.removeLabels) && args.removeLabels.includes('INBOX') ? ' · archived' : '';
    return `${add ? '→ ' + add : ''}${n ? ` · ${n} email${n === 1 ? '' : 's'}` : ''}${arch}`.trim();
  }
  if (name === 'email_sort_local') {
    return `latest ${args.maxResults || 50}${args.apply === false ? ' (preview)' : ''}${args.archive === false ? ' · keep in inbox' : ''}`;
  }
  if (name === 'email_correct_label' && args.sender) {
    const labels = Array.isArray(args.labels) ? args.labels.join('+') : (args.label || '');
    return `${args.sender} → ${labels}`;
  }
  if (name === 'email_remove_label_correction' && args.sender) return args.sender;
  if (name === 'email_list' && typeof args.query === 'string' && args.query) return args.query;
  if (name === 'node_exec' && typeof args.command === 'string') return args.command;
  if (name === 'node_push_project' && typeof args.dest_path === 'string') {
    return `${args.node_id || ''} → ${args.dest_path}`.trim();
  }
  if (name === 'node_start_service' && typeof args.command === 'string') {
    const cwd = args.cwd ? `(${args.cwd}) ` : '';
    return `${cwd}${args.command}`;
  }
  if (name === 'node_stop_service') return `pid ${args.pid} on ${args.node_id || ''}`.trim();
  if (name === 'node_status' || name === 'node_list') return args.node_id || '';
  if (name === 'request_tools') return args.reason || '';
  return '';
}

let liveToolRun = null;

function resetToolRun(removeRun = false) {
  if (toolStreamBubbleEl) {
    try { toolStreamBubbleEl.remove(); } catch {}
  }
  if (removeRun && liveToolRun?.el) {
    try { liveToolRun.el.remove(); } catch {}
  }
  toolPillsEl = null;
  toolStreamBubbleEl = null;
  toolStreamBubbleTool = null;
  liveToolRun = null;
}

function scrubToolArgsForSession(value) {
  if (Array.isArray(value)) return value.map(scrubToolArgsForSession);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|password|api[_-]?key|authorization|credential/i.test(k)) out[k] = '[redacted]';
    else out[k] = scrubToolArgsForSession(v);
  }
  return out;
}

function currentLiveToolEvents() {
  return liveToolRun?.events?.map(ev => ({
    name: ev.name,
    args: ev.args ? scrubToolArgsForSession(ev.args) : null,
    startedAt: ev.startedAt,
    endedAt: ev.endedAt ?? null,
    durationMs: ev.durationMs ?? (ev.endedAt && ev.startedAt ? ev.endedAt - ev.startedAt : null),
    status: ev.status || 'running',
    preview: ev.preview || '',
    text: ev.text ? String(ev.text).slice(0, 10000) : '',
    progressPreview: ev.progressPreview || '',
  })) ?? [];
}

function ensureToolRun() {
  if (liveToolRun?.el && document.body.contains(liveToolRun.el)) return liveToolRun;
  const el = document.createElement('div');
  el.className = 'tool-run';
  el.innerHTML = `
    <button class="tool-run-head" type="button" aria-expanded="false">
      <span class="pill-spinner tool-run-spinner"></span>
      <span class="tool-run-title">Using tools</span>
      <span class="tool-run-meta"></span>
      <span class="tool-run-chev">${icon('chevron-down', 13)}</span>
    </button>
    <div class="tool-run-steps" hidden></div>`;
  const head = el.querySelector('.tool-run-head');
  head.addEventListener('click', () => {
    const steps = el.querySelector('.tool-run-steps');
    const open = steps.hasAttribute('hidden');
    steps.toggleAttribute('hidden', !open);
    if (open) flushStaleToolRunSteps(steps);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    el.classList.toggle('open', open);
  });
  insertBefore(el);
  liveToolRun = { el, events: [], startedAt: Date.now() };
  toolPillsEl = el;
  return liveToolRun;
}

// Snapshot/restore of the in-flight tool run across agent switches
// (agents.js switchAgent). Full event objects, not just names — args,
// status, previews and results all survive the round-trip, so a restored
// run keeps ticking (tool_result events find their pending entries) instead
// of spinning forever on name-only stubs.
function snapshotLiveToolRun() {
  return liveToolRun ? liveToolRun.events.map(ev => ({ ...ev })) : null;
}

function restoreToolRun(events) {
  if (!events?.length) return;
  const run = ensureToolRun();
  run.events = events;
  updateToolRunHeader(run, events.every(ev => ev.status === 'done'));
}

function visibleToolEvents(events) {
  return (events || []).filter(ev => !toolUiHidden(ev.name));
}

function summarizeToolRun(events, done = false) {
  const visible = visibleToolEvents(events);
  const count = visible.length || events.length;
  const groups = [...new Set(visible.map(ev => toolGroupLabel(ev.name)))].filter(Boolean);
  const running = events.some(ev => ev.status !== 'done');
  const elapsedStart = Math.min(...events.map(ev => Number(ev.startedAt)).filter(Number.isFinite));
  const elapsedEnd = Math.max(...events.map(ev => Number(ev.endedAt || Date.now())).filter(Number.isFinite));
  const duration = Number.isFinite(elapsedStart) && Number.isFinite(elapsedEnd) ? formatToolDuration(elapsedEnd - elapsedStart) : '';
  const title = groups.length === 1 ? `${groups[0]} activity` : 'Tool activity';
  const meta = [
    count ? `${count} step${count === 1 ? '' : 's'}` : '',
    done && duration ? duration : (running && duration ? `${duration} elapsed` : ''),
  ].filter(Boolean).join(' · ');
  return { title, meta };
}

function renderToolRunSteps(container, events) {
  container.innerHTML = '';
  for (const ev of events) {
    const row = document.createElement('div');
    row.className = `tool-run-step ${toolUiHidden(ev.name) ? 'is-internal' : ''}`;
    const args = ev.args ?? {};
    const label = toolDisplayLabel(ev.name, args);
    const subtitle = toolPillSubtitle(ev.name, args);
    const summary = ev.preview || ev.progressPreview || '';
    const duration = formatToolDuration(ev.durationMs ?? (ev.endedAt && ev.startedAt ? ev.endedAt - ev.startedAt : null));
    row.innerHTML = `
      <div class="tool-run-step-main">
        <span class="tool-run-step-icon">${ev.status === 'done' ? icon('check', 13) : '<span class="pill-spinner"></span>'}</span>
        <span class="tool-run-step-label">${escHtml(label)}</span>
        ${duration ? `<span class="tool-run-step-time">${escHtml(duration)}</span>` : ''}
      </div>
      ${subtitle ? `<div class="tool-run-step-sub">${escHtml(subtitle)}</div>` : ''}
      ${summary ? `<div class="tool-run-step-preview">${escHtml(summary.length > 160 ? summary.slice(0, 160) + '...' : summary)}</div>` : ''}`;
    if (ev.text) {
      row.classList.add('clickable');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.title = 'Open full tool output';
      const open = () => openToolModal(label, ev.text);
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    }
    container.appendChild(row);
  }
}

function recentUserTextForToolRecipe() {
  const msgs = sessions[activeAgent] || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === 'user' && !m.hidden && typeof m.content === 'string' && m.content.trim()) return m.content.trim();
  }
  return $('input')?.value?.trim() || '';
}

function attachToolRunRecipeActions(run, events, { recipeAgentId = null, recipePhrase = null } = {}) {
  if (!run || run.querySelector('.tool-run-actions')) return;
  const toolNames = [...new Set(visibleToolEvents(events).map(ev => ev.name).filter(Boolean))];
  if (!toolNames.length) return;
  const targetAgentId = recipeAgentId || events.find(ev => ev.targetAgentId)?.targetAgentId || activeAgent;
  const toolChips = toolNames
    .map(name => {
      const ev = events.find(e => e.name === name) || {};
      const label = toolDisplayLabel(name, ev.args || {});
      const display = label && label !== name ? `${label} (${name})` : name;
      return `<span class="tool-run-action-chip" title="${escHtml(display)}">${escHtml(display)}</span>`;
    })
    .join('');
  const actions = document.createElement('div');
  actions.className = 'tool-run-actions';
  actions.innerHTML = `
    <div class="tool-run-actions-summary">
      <span>Tools used</span>
      <div class="tool-run-actions-tools">${toolChips}</div>
    </div>
    <div class="tool-run-actions-buttons">
      <button type="button" data-tool-run-save>${icon('save', 12)} Remember these tools</button>
      <button type="button" data-tool-run-edit>${icon('sliders-horizontal', 12)} Edit before next send</button>
    </div>`;
  actions.querySelector('[data-tool-run-save]')?.addEventListener('click', () => {
    const phrase = recipePhrase || recentUserTextForToolRecipe();
    rememberToolRecipe(phrase, toolNames, 'selected', targetAgentId);
    actions.querySelector('[data-tool-run-save]').textContent = 'Remembered';
  });
  actions.querySelector('[data-tool-run-edit]')?.addEventListener('click', () => {
    const input = $('input');
    if (input && !input.value.trim()) input.value = recipePhrase || recentUserTextForToolRecipe();
    toolPlanState.mode = 'selected';
    toolPlanState.selected = new Set(toolNames);
    toolPlanState.expanded = true;
    toolPlanState.remember = true;
    toolPlanState.dirty = true;
    toolPlanState._text = input?.value?.trim() || '';
    renderToolPlanPicker();
    input?.focus();
  });
  run.appendChild(actions);
}

function hydrateToolEvents(events, toolResults = null) {
  return (events || []).map(ev => {
    if (ev.text || !Array.isArray(toolResults)) return { ...ev };
    const idx = Number(ev.resultIndex);
    const result = Number.isInteger(idx) && idx >= 0 ? toolResults[idx] : null;
    if (!result?.text) return { ...ev };
    return { ...ev, text: result.text };
  });
}

// Coalesced step rendering. updateToolRunHeader fires per tool start /
// progress chunk / result, and renderToolRunSteps rebuilds every row (with
// listeners) from scratch each time. Collapsed panels — the default state —
// defer the rebuild until the user actually expands (see the head click
// handlers); visible panels batch to at most one rebuild per frame.
function scheduleToolRunSteps(stepsEl, events) {
  if (!stepsEl) return;
  if (stepsEl.hasAttribute('hidden')) { stepsEl._staleEvents = events; return; }
  stepsEl._staleEvents = null;
  if (stepsEl._stepsRaf) return;
  stepsEl._stepsRaf = requestAnimationFrame(() => {
    stepsEl._stepsRaf = null;
    renderToolRunSteps(stepsEl, events);
  });
}

// Render deferred step rows when a collapsed panel is expanded.
function flushStaleToolRunSteps(stepsEl) {
  if (stepsEl?._staleEvents) {
    renderToolRunSteps(stepsEl, stepsEl._staleEvents);
    stepsEl._staleEvents = null;
  }
}

function updateToolRunHeader(run, done = false) {
  if (!run?.el) return;
  const { title, meta } = summarizeToolRun(run.events, done);
  run.el.querySelector('.tool-run-title').textContent = title;
  run.el.querySelector('.tool-run-meta').textContent = meta;
  run.el.classList.toggle('tool-run-done', done);
  const spinner = run.el.querySelector('.tool-run-spinner');
  if (spinner) spinner.outerHTML = done ? icon('check', 13) : '<span class="pill-spinner tool-run-spinner"></span>';
  scheduleToolRunSteps(run.el.querySelector('.tool-run-steps'), run.events);
  if (done) attachToolRunRecipeActions(run.el, run.events);
}

function appendToolRun(events, ts = Date.now(), scroll = true, { persisted = false, toolResults = null, recipeAgentId = null, recipePhrase = null } = {}) {
  const cleanEvents = hydrateToolEvents(events, toolResults).map(ev => ({ ...ev, status: ev.status || 'done' }));
  if (!cleanEvents.length) return null;
  const run = document.createElement('div');
  run.className = `tool-run tool-run-done ${persisted ? 'tool-run-persisted' : ''}`;
  const { title, meta } = summarizeToolRun(cleanEvents, true);
  run.innerHTML = `
    <button class="tool-run-head" type="button" aria-expanded="false">
      ${icon('check', 13)}
      <span class="tool-run-title">${escHtml(title)}</span>
      <span class="tool-run-meta">${escHtml(meta)}</span>
      <span class="tool-run-chev">${icon('chevron-down', 13)}</span>
    </button>
    <div class="tool-run-steps" hidden></div>`;
  const head = run.querySelector('.tool-run-head');
  head.addEventListener('click', () => {
    const steps = run.querySelector('.tool-run-steps');
    const open = steps.hasAttribute('hidden');
    steps.toggleAttribute('hidden', !open);
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    run.classList.toggle('open', open);
  });
  renderToolRunSteps(run.querySelector('.tool-run-steps'), cleanEvents);
  attachToolRunRecipeActions(run, cleanEvents, { recipeAgentId, recipePhrase });
  insertBefore(run);
  if (scroll) scrollToBottom();
  return run;
}

function showToolPill(name, args) {
  const run = ensureToolRun();
  run.events.push({ name, args: args ?? null, startedAt: Date.now(), status: 'running' });
  updateToolRunHeader(run, false);
  scrollToBottom();
}

// One streaming bubble at a time, rendered as a separate element below the
// small-pill row. The currently-streaming tool's output goes here; the small
// pill above it stays small. On tool_result, the bubble vanishes and the small
// pill flips to its done state in place. If a different tool starts streaming
// before the current one finishes, the bubble switches to the newer tool.
const PROGRESS_BUF_CAP = 16 * 1024;
let toolStreamBubbleEl = null;
let toolStreamBubbleTool = null;

function _findLatestPendingPill(name) {
  if (!liveToolRun) return null;
  for (let i = liveToolRun.events.length - 1; i >= 0; i--) {
    const ev = liveToolRun.events[i];
    if (ev.name === name && ev.status !== 'done') return ev;
  }
  return null;
}

function _ensureStreamBubble(name, argSubtitle, displayLabel) {
  if (toolStreamBubbleEl && toolStreamBubbleTool === name) return toolStreamBubbleEl;
  // Different tool (or none yet) — rebuild the bubble.
  if (toolStreamBubbleEl) toolStreamBubbleEl.remove();
  toolStreamBubbleEl = document.createElement('div');
  toolStreamBubbleEl.className = 'tool-stream-bubble';
  const head = document.createElement('div');
  head.className = 'tool-pill-head';
  head.innerHTML = `${icon('settings', 13)} ${escHtml(displayLabel || name)}`;
  if (argSubtitle) {
    const cmdEl = document.createElement('span');
    cmdEl.className = 'tool-pill-cmd';
    cmdEl.textContent = argSubtitle;
    cmdEl.title = argSubtitle;
    head.appendChild(cmdEl);
  }
  const stream = document.createElement('pre');
  stream.className = 'tool-pill-stream';
  stream._buf = '';
  toolStreamBubbleEl.appendChild(head);
  toolStreamBubbleEl.appendChild(stream);
  // Insert directly after the pills row so it always lives just below.
  toolPillsEl.parentNode.insertBefore(toolStreamBubbleEl, toolPillsEl.nextSibling);
  toolStreamBubbleTool = name;
  return toolStreamBubbleEl;
}

function appendToolPillProgress(name, text) {
  if (!toolPillsEl || !text) return;
  const pending = _findLatestPendingPill(name);
  if (!pending) return; // nothing to attach progress to (already finished)
  // Cap the accumulated preview the same way the display buffer is capped —
  // it's copied verbatim into every session commit via currentLiveToolEvents,
  // so an unbounded chatty tool would bloat the session indefinitely.
  pending.progressPreview = ((pending.progressPreview || '') + text).slice(-PROGRESS_BUF_CAP);
  pending.updatedAt = Date.now();
  const argSub = toolPillSubtitle(name, pending.args);
  const bubble = _ensureStreamBubble(name, argSub, toolDisplayLabel(name, pending.args));
  const stream = bubble.querySelector('.tool-pill-stream');
  stream._buf = (stream._buf + text).slice(-PROGRESS_BUF_CAP);
  stream.textContent = stream._buf;
  updateToolRunHeader(liveToolRun, false);
  stream.scrollTop = stream.scrollHeight;
  scrollToBottom();
}

function _dismissStreamBubbleIf(name) {
  if (toolStreamBubbleEl && toolStreamBubbleTool === name) {
    toolStreamBubbleEl.remove();
    toolStreamBubbleEl = null;
    toolStreamBubbleTool = null;
  }
}
function updateToolPill(name, summary, fullText) {
  if (!toolPillsEl) return;
  // If this tool was streaming into the bubble, dismiss it — the small pill below takes over.
  _dismissStreamBubbleIf(name);
  const ev = _findLatestPendingPill(name);
  if (ev) {
    ev.status = 'done';
    ev.endedAt = Date.now();
    ev.durationMs = ev.endedAt - ev.startedAt;
    ev.preview = summary || '';
    ev.text = fullText || '';
  } else if (liveToolRun) {
    liveToolRun.events.push({
      name, args: null, status: 'done', startedAt: Date.now(), endedAt: Date.now(),
      durationMs: 0, preview: summary || '', text: fullText || '',
    });
  }
  updateToolRunHeader(liveToolRun, liveToolRun?.events?.every(e => e.status === 'done'));
}

let _toolModalEls = null;
function ensureToolModal() {
  if (_toolModalEls) return _toolModalEls;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0';
  const title = document.createElement('h2');
  title.style.cssText = 'font-family:monospace';
  const close = document.createElement('button');
  close.className = 'btn-modal-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close');
  header.appendChild(title);
  header.appendChild(close);
  const body = document.createElement('pre');
  body.className = 'tool-modal-body';
  const footer = document.createElement('div');
  footer.className = 'modal-footer';
  footer.style.gap = '8px';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn-modal-close';
  copyBtn.textContent = 'Copy';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn-modal-close';
  closeBtn.textContent = 'Close';
  footer.appendChild(copyBtn);
  footer.appendChild(closeBtn);
  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const hide = () => backdrop.classList.remove('open');
  close.addEventListener('click', hide);
  closeBtn.addEventListener('click', hide);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) hide(); });
  modal.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop.classList.contains('open')) hide();
  });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(body.textContent);
      const prev = copyBtn.textContent;
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = prev; }, 1200);
    } catch {}
  });

  _toolModalEls = { backdrop, title, body };
  return _toolModalEls;
}
function openToolModal(name, text) {
  const { backdrop, title, body } = ensureToolModal();
  title.textContent = name;
  // MCP tool results can include markdown images and resource links —
  // render through the markdown pipeline so `![](data:image/png;base64,...)`
  // becomes an actual <img>. For non-MCP tools we still want markdown
  // rendering for things like code fences and headings the LLM might
  // include; if a tool emits raw output that markdown would mangle, the
  // tool can wrap its result in ``` code fences. renderMarkdown is the
  // same HTML-escaping renderer used everywhere else in chat.
  body.innerHTML = renderMarkdown(text ?? '');
  backdrop.classList.add('open');
}
function sessionMessageKey(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.role === 'user' && m.messageId) return `user:${m.messageId}`;
  if (m.role === 'assistant' && m.turnId) return `assistant:${m.turnId}`;
  if (m.role === 'turn_error' && (m.attemptId || m.turnId)) return `turn_error:${m.attemptId || m.turnId}`;
  if (m.role === 'turn_terminal' && (m.attemptId || m.turnId)) return `turn_terminal:${m.attemptId || m.turnId}`;
  if (m.role === 'agent_report' || m.kind === 'agent_report') {
    if (m.reportId) return `agent_report:${m.reportId}`;
    if (m.spanId) return `agent_report:${m.spanId}`;
    if (m.watcherId) return `agent_report:${m.watcherId}:${m.targetAgentId || ''}`;
    if (m.taskId) return `agent_report:${m.taskId}:${m.targetAgentId || ''}`;
  }
  if (m.role === 'proposal' && m.proposalId) return `proposal:${m.proposalId}`;
  if (m.role === 'proposal_outcome' && m.proposalId) return `proposal_outcome:${m.proposalId}:${m.status || ''}`;
  if (m.role === 'attachment_decision' && m.decisionId) return `attachment_decision:${m.decisionId}`;
  if (m.role === 'attachment_decision_outcome' && m.decisionId) return `attachment_decision_outcome:${m.decisionId}`;
  if (m.role === 'approval_pending' && m.kind) return `approval_pending:${m.kind}:${m.opId || m.ts || 'legacy'}`;
  if (m.role === 'approval_resolved' && m.kind) return `approval_resolved:${m.kind}:${m.opId || m.ts || 'legacy'}`;
  return null;
}
function sameSessionMessage(a, b) {
  const ak = sessionMessageKey(a);
  const bk = sessionMessageKey(b);
  if (ak && bk) return ak === bk;
  return a?.role === b?.role && a?.content === b?.content;
}
function sessionHasEquivalent(messages, msg) {
  return (messages || []).some(m => sameSessionMessage(m, msg));
}
function appendError(msg, onRetry = null) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  const retryBtn = onRetry
    ? ` <button class="retry-failed-btn" style="margin-left:8px;padding:2px 10px;font-size:0.85em;background:transparent;border:1px solid #f44336;color:#f44336;border-radius:5px;cursor:pointer;vertical-align:middle;">↻ Retry</button>`
    : '';
  el.innerHTML = `<div class="msg-bubble" style="color:#f44336;border:1px solid #f44336">⚠ ${escHtml(msg)}${retryBtn}</div>`;
  if (onRetry) el.querySelector('.retry-failed-btn').addEventListener('click', onRetry);
  insertBefore(el); scrollToBottom();
  return el;
}

function appendTurnErrorBubble(row) {
  if (row?.assistantPartial) {
    appendAssistantBubble(`${row.assistantPartial}\n\n_Reply incomplete_`, row.ts, false);
  }
  appendError(
    row?.error || row?.content || 'Turn failed',
    row?.retryable === true ? () => retryPersistedTurn(row) : null,
  );
}

function retryPersistedTurn(errorRow) {
  if (streaming && !awaitingPermission) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Not connected — try again in a moment'); return; }
  const arr = sessions[activeAgent] || [];
  const user = [...arr].reverse().find(m =>
    m.role === 'user' && (errorRow.messageId ? m.messageId === errorRow.messageId : m.turnId === errorRow.turnId));
  if (!user) { showToast('The original message is no longer available'); return; }
  const messageId = user.messageId || makeChatCorrelationId('msg');
  if (typeof finishPendingAttempt === 'function') finishPendingAttempt(errorRow.attemptId || errorRow.turnId);
  const attemptId = makeChatCorrelationId('att');
  const attachments = user.attachments || [];
  sessions[activeAgent] = arr.filter(m => m !== errorRow && !(m.role === 'turn_error' && m.messageId === messageId));
  Object.assign(user, { messageId, attemptId, turnId: attemptId, turnStatus: 'running', retryable: undefined });
  renderSession();
  lastSentAttempt = registerPendingAttempt({
    agent: activeAgent, text: user.content || '', attachments,
    displayText: user.content || '',
    messageId, attemptId, userBubbleEl: null, sessionEntry: user,
  });
  agentStreams[activeAgent] = typeof freshAgentTurnState === 'function'
    ? freshAgentTurnState(activeAgent, { turnId: attemptId, messageId, attemptId, phase: 'running', seq: 0 })
    : { buf: '', toolEvents: [], active: true, turnId: attemptId, messageId, attemptId, lastSeq: 0 };
  setStreaming(true); setTyping(true);
  const payload = { type: 'chat', agent: activeAgent, text: user.content || '', message_id: messageId, attempt_id: attemptId };
  if (attachments.length) payload.attachments = attachments;
  ws.send(JSON.stringify(payload));
}

// A terminal failure is already durable server-side. Keep the user row in the
// cache and offer Retry only when the server proves no side-effecting tool ran.
function showTurnError(message, event = {}) {
  const attempt = event._clientAttempt
    || (lastSentAttempt && (!event.turn_id || lastSentAttempt.attemptId === event.turn_id)
      ? lastSentAttempt : null);
  const forThisAgent = attempt && attempt.agent === activeAgent;
  const canRetry = Boolean(forThisAgent && event.retryable === true);
  const errorEl = appendError(message, canRetry ? retryFailedAttempt : null);
  if (forThisAgent) {
    if (attempt.sessionEntry) {
      attempt.sessionEntry.turnStatus = 'failed';
      attempt.sessionEntry.retryable = canRetry;
    }
    failedAttempt = canRetry ? { ...attempt, errorEl } : null;
    if (lastSentAttempt?.attemptId === attempt.attemptId) lastSentAttempt = null;
  }
}

// Remove the on-screen failed message + its error bubble. Called before any
// fresh send (Retry button or a newly-typed message).
function clearFailedAttempt() {
  if (!failedAttempt) return;
  // A new message supersedes a pre-acceptance retryable send; do not let that
  // abandoned outbox entry execute on a later reconnect. Accepted attempts stay
  // until their durable turn_terminal is observed.
  if (!failedAttempt.accepted) finishPendingAttempt(failedAttempt.attemptId);
  try { failedAttempt.errorEl?.remove(); } catch {}
  failedAttempt = null;
}

// Retry button: resend the exact text/attachments that failed, as a fresh turn.
// Self-contained (doesn't touch the composer, so a half-typed draft survives).
function retryFailedAttempt() {
  if (!failedAttempt) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Not connected — try again in a moment'); return; }
  const prior = failedAttempt;
  const { agent, text, attachments, toolPlan, messageId } = prior;
  finishPendingAttempt(prior.attemptId);
  clearFailedAttempt();
  if (agent !== activeAgent) return;
  const list = attachments || [];
  const attemptId = makeChatCorrelationId('att');
  if (!sessions[activeAgent]) sessions[activeAgent] = [];
  sessions[activeAgent] = sessions[activeAgent].filter(m =>
    !(m.role === 'turn_error' && m.messageId === messageId));
  let sessionEntry = sessions[activeAgent].find(m => m.role === 'user' && m.messageId === messageId);
  if (!sessionEntry) {
    sessionEntry = prior.sessionEntry;
    sessions[activeAgent].push(sessionEntry);
  }
  Object.assign(sessionEntry, { attemptId, turnId: attemptId, turnStatus: 'running', retryable: undefined });
  updateSessionWarning();
  lastSentAttempt = registerPendingAttempt({
    agent: activeAgent, text, displayText: sessionEntry.content || text,
    attachments: list, toolPlan, messageId, attemptId,
    userBubbleEl: prior.userBubbleEl, sessionEntry,
  });
  agentStreams[activeAgent] = typeof freshAgentTurnState === 'function'
    ? freshAgentTurnState(activeAgent, { turnId: attemptId, messageId, attemptId, phase: 'running', seq: 0 })
    : { buf: '', toolEvents: [], active: true, turnId: attemptId, messageId, attemptId, lastSeq: 0 };
  setStreaming(true); setTyping(true);
  const payload = { type: 'chat', agent: activeAgent, text, message_id: messageId, attempt_id: attemptId };
  if (list.length) payload.attachments = list;
  if (toolPlan) payload.toolPlan = toolPlan;
  ws.send(JSON.stringify(payload));
}
function appendNotification(msg) {
  // Watcher/scheduler events use server-scoped session ids
  // (`user_<id>_<agent>`), while the browser stores the active tab as the raw
  // registry id. Normalize before deciding inline-vs-toast so notifications
  // projected onto a single-mode primary land in that primary's chat.
  const agentId = typeof clientSessionAgentId === 'function'
    ? clientSessionAgentId(msg.agent)
    : chatSessionAgentId(msg.agent);
  const fromName = msg.from?.userName ?? 'Someone';
  const timeStr = new Date(msg.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit' });
  // If notification is for the active agent, render inline
  if (agentId === activeAgent) {
    const el = document.createElement('div');
    el.className = 'msg notification';
    el.innerHTML = `<div class="msg-bubble" style="background:rgba(33,150,243,0.08);border:1px solid rgba(33,150,243,0.25);color:var(--fg);font-size:0.88em;padding:8px 12px;">
      <strong>${icon('megaphone', 13)} ${escHtml(fromName)}</strong> ${escHtml(msg.content)} <span style="opacity:0.5;font-size:0.85em;margin-left:6px">${timeStr}</span>
    </div>`;
    insertBefore(el); scrollToBottom();
  } else {
    // Show a toast for notifications on other agents
    const agentName = agents.find(a => a.id === agentId)?.name ?? agentId;
    showToast(`${fromName} via ${agentName}: ${msg.content}`);
  }
}
// Render a direct report card from a background agent, inline in the current chat
function handleAgentReport(msg) {
  const { agent, reportId, agentName, agentEmoji, content, displayContent, ts, toolEvents, images, targetAgentId, originalTask, taskId, rootTaskId, parentTaskId, watcherId, rootWatcherId, spanId, tool, status } = msg;
  const report = { role: 'agent_report', reportId, agentName, agentEmoji, content, displayContent, toolEvents, images, targetAgentId, originalTask, taskId, rootTaskId, parentTaskId, watcherId, rootWatcherId, spanId, tool, status, ts, ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}) };
  const agentKey = chatSessionAgentId(agent);
  // Push into the target coordinator's session cache so the report survives
  // agent-tab switches. Without this, the DOM bubble is the only copy
  // browser-side and it gets wiped on the next renderSession (e.g. when
  // the user switches agents and switches back).
  let addedToSession = false;
  if (agentKey) {
    if (!sessions[agentKey]) sessions[agentKey] = [];
    // Use role:'agent_report' so renderSession can route this back through
    // _renderAgentReportEl below. Keep the same shape we just received so
    // the renderer can reconstruct identical DOM.
    const equivalentIdx = sessions[agentKey].findIndex(m => sameSessionMessage(m, report));
    if (equivalentIdx < 0) {
      sessions[agentKey].push(report);
      addedToSession = true;
    } else if (Array.isArray(images) && images.length && !Array.isArray(sessions[agentKey][equivalentIdx].images)) {
      sessions[agentKey][equivalentIdx] = { ...sessions[agentKey][equivalentIdx], images };
      addedToSession = true;
    }
  }
  // Only paint into the visible chat panel when the report's target
  // coordinator is the agent currently being viewed. A report fired while
  // the user is on a different agent's tab should NOT appear there.
  if (!agentKey || agentKey === activeAgent) {
    if (agentKey && typeof renderSession === 'function' && !streamEl) {
      renderSession();
      // renderSession() replays the whole history (insertBefore's own
      // per-item counting is suppressed during that replay), so when this
      // call actually added a new report to the session, count it here —
      // but not when it only patched an existing entry (e.g. images arriving
      // for a report already rendered).
      if (addedToSession && !_autoScroll) { _newMessageCount++; _updateJumpPill(); }
      return;
    }
    if (agentKey && !addedToSession) return;
    if (isNodeExecTaskReport(report)) {
      appendNodeExecTaskReport(report, null, true);
      appendAgentReportImages(report, true);
    }
    else if (appendAgentReportTaskChip(report, true)) {
      appendAgentReportImages(report, true);
    }
    else {
      _renderAgentReportEl(report);
      appendAgentReportImages(report, true);
    }
  }
}

// Parse pre-kind:'agent_report' background-completion messages so they
// render as a tagged bubble on reload. Two historical formats:
//   "[<name> finished in background]\n<body>"
//   "[<name> replied — re: \"<task>…\"]\n<body>"
// Returns { agentName, body } on match, null otherwise.
function _legacyAgentReportMatch(content) {
  if (typeof content !== 'string') return null;
  const m = content.match(/^\[([^\]]+?)\s+(?:finished in background|replied(?:\s+—\s+re:[^\]]*)?)\]\n([\s\S]*)$/);
  if (!m) return null;
  return { agentName: m[1].trim(), body: m[2] };
}

function _agentReportBody(content, displayContent = null) {
  if (typeof displayContent === 'string') return displayContent;
  if (typeof content !== 'string') return content;
  return content
    .replace(/^\[[^\]]+ finished in background\]\n/, '')
    .replace(/^\[[^\]]+ (?:replied|ran into a problem)(?:\s+—\s+re:[^\]]*)?\]\n/, '');
}

function _renderAgentReportEl({ agentName, agentEmoji, content, displayContent = null, toolEvents = null, targetAgentId = null, originalTask = '', ts }) {
  const timeStr = new Date(ts ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const bodyContent = _agentReportBody(content, displayContent);
  const el = document.createElement('div');
  el.className = 'msg agent-report';
  el.innerHTML = `
    <div class="agent-report-header">
      <span class="agent-report-who">${escHtml(agentEmoji ?? '')} <strong>${escHtml(agentName)}</strong></span>
      <span class="agent-report-time">${timeStr}</span>
    </div>
    <div class="agent-report-body msg-bubble">${renderMarkdown(bodyContent ?? '')}</div>
  `;
  insertBefore(el);
  if (Array.isArray(toolEvents) && toolEvents.length) {
    appendToolRun(toolEvents, ts ?? Date.now(), false, {
      persisted: true,
      recipeAgentId: targetAgentId,
      recipePhrase: originalTask || displayContent || content || '',
    });
  }
  scrollToBottom();
}

function appendTaskHeader(label, ts = Date.now(), scroll = true) {
  const timeStr = new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const el = document.createElement('div');
  el.className = 'task-header';
  el.dataset.ts = ts;
  el.innerHTML = `<span class="task-header-label">📋 ${escHtml(label)} — ${timeStr}</span>`;
  insertBefore(el);
  // Guarded scroll (respects _autoScroll) rather than an unguarded
  // scrollIntoView — a future live caller passing scroll=true can't yank a
  // scrolled-up reader. The only caller today passes false, so this is a
  // no-op change in practice.
  if (scroll) scrollToBottom();
  return el;
}
function msgEl(role) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="msg-bubble"></div><div class="msg-time"></div>`;
  return el;
}
function addTimestamp(el, ts = Date.now()) {
  const t = el.querySelector('.msg-time');
  if (t) t.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
// _renderingSession is true for the duration of a full renderSession() replay
// (initial load, agent switch, "Load earlier") so insertBefore() below can
// tell a bulk historical redraw apart from a single freshly-arrived message —
// otherwise re-rendering old history while scrolled up would inflate the
// "N new" counter for messages the user has already seen.
let _renderingSession = false;
function insertBefore(el) {
  $('messages').insertBefore(el, $('typing'));
  if (!_renderingSession && !_autoScroll) { _newMessageCount++; _updateJumpPill(); }
}

// ── Scroll management ─────────────────────────────────────────────────────────
// Auto-scroll follows new content only while the user is at (or near) the
// bottom. Scrolling up pauses following and shows a "Jump to latest" pill;
// scrolling back down, clicking the pill, or sending a message resumes it.
// Without this, per-token scrollToBottom() yanks the viewport while reading
// scrollback — several times a second during streaming.
let _autoScroll = true;
let _jumpPillEl = null;
// Counts message-level bubbles inserted (via insertBefore) while scrolled up.
// Streaming tokens mutate an existing bubble's innerHTML rather than calling
// insertBefore again, so per-token updates never bump this — only genuinely
// new user/assistant/tool-report/etc. items do.
let _newMessageCount = 0;

function _isNearBottom() {
  const m = $('messages');
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}

function _updateJumpPill() {
  if (!_jumpPillEl) {
    _jumpPillEl = document.createElement('button');
    _jumpPillEl.type = 'button';
    // z-index must beat .workspace (a stacking context at 60, styles.css) or
    // the pill shows through the transparent chat background but hit-testing
    // sends every click to .messages — visible yet unclickable. Stay below
    // drawers (200) and modals (1100+).
    _jumpPillEl.style.cssText = 'position:fixed;transform:translateX(-50%);z-index:150;padding:6px 14px;font-size:12px;border-radius:16px;border:1px solid var(--border);background:var(--bg2);color:var(--fg);cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);display:none';
    _jumpPillEl.addEventListener('click', () => scrollToBottom(true));
    document.body.appendChild(_jumpPillEl);
  }
  if (_autoScroll) {
    // Reached bottom (scroll, pill click, or a forced scrollToBottom) —
    // clear the tally so the next time the pill appears it starts fresh.
    _newMessageCount = 0;
    _jumpPillEl.style.display = 'none';
    return;
  }
  _jumpPillEl.textContent = _newMessageCount > 0 ? `↓ ${_newMessageCount} new` : '↓ Jump to latest';
  const r = $('messages').getBoundingClientRect();
  _jumpPillEl.style.left = `${r.left + r.width / 2}px`;
  _jumpPillEl.style.bottom = `${Math.max(0, window.innerHeight - r.bottom) + 12}px`;
  _jumpPillEl.style.display = 'block';
}

(function _initScrollTracking() {
  const attach = () => {
    const m = $('messages');
    if (!m) return;
    m.addEventListener('scroll', () => {
      const nb = _isNearBottom();
      if (nb !== _autoScroll) { _autoScroll = nb; _updateJumpPill(); }
    }, { passive: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();

function scrollToBottom(force = false) {
  if (force && !_autoScroll) { _autoScroll = true; _updateJumpPill(); }
  if (!_autoScroll) return;
  const m = $('messages'); m.scrollTop = m.scrollHeight;
}
// escHtml defined below in Shared helpers section (with full quote escaping)

// ── Slash Command Menu ─────────────────────────────────────────────────────
let slashMenuIdx = 0, slashMenuItems = [];
let _skillsCache = null;
let _effortCache = null;
async function _loadSkills() {
  try { _skillsCache = await fetch('/api/roles').then(r => r.json()); } catch { _skillsCache = _skillsCache || []; }
  return _skillsCache;
}
async function _loadEfforts() {
  const agent = agents.find(a => a.id === activeAgent);
  const key = `${activeAgent}|${agent?.provider || ''}|${agent?.model || ''}|${agent?.reasoningEffort || 'auto'}`;
  if (_effortCache?.key === key) return _effortCache.data;
  try {
    const data = await fetch(`/api/reasoning-efforts?agent=${encodeURIComponent(activeAgent)}`).then(r => r.json());
    _effortCache = { key, data };
  } catch {
    _effortCache = { key, data: { current: agent?.reasoningEffort || 'auto', options: [{ value: 'auto', label: 'Auto', description: 'Use OE defaults.' }] } };
  }
  return _effortCache.data;
}
async function assignEffortToAgent(agentId, reasoningEffort) {
  const r = await fetch(`/api/agents/${agentId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reasoningEffort }),
  });
  if (!r.ok) { showToast('Failed to update effort'); return; }
  try { agents = await fetch('/api/agents').then(r => r.json()); } catch {}
  _effortCache = null;
  showToast(`Effort → ${reasoningEffort}`);
}

const SLASH_COMMANDS = [
  { cmd: '/clear',     icon: 'trash-2',    desc: 'Clear the current chat session',
    action: () => { hideSlashMenu(); $('input').value = ''; clearSession(); } },
  { cmd: '/model',     icon: 'brain',      desc: 'Change the active model' },
  { cmd: '/effort',    icon: 'gauge',      desc: 'Change reasoning effort for this agent/model' },
  { cmd: '/agent',     icon: 'bot',        desc: 'Switch to a different agent' },
  { cmd: '/claim',     icon: 'wrench',     desc: 'Claim a role for this agent' },
  { cmd: '/release',   icon: 'unlock',     desc: 'Release a role from this agent' },
  { cmd: '/trim',      icon: 'scissors',   desc: 'Toggle specialist-router tool trimming (on/off/status)' },
  { cmd: '/threshold', icon: 'sliders',    desc: 'Tune embed-router cosine threshold (e.g. /threshold 0.7)' },
  { cmd: '/new-agent', icon: 'sparkles',   desc: 'Create a new agent',
    action: () => { hideSlashMenu(); $('input').value = ''; openNewAgentModal(); } },
];

function _slashGetItems(val) {
  const lo = val.toLowerCase();
  // /model <filter> → model submenu
  if (/^\/model\s/.test(val)) {
    const f = val.slice(7).toLowerCase();
    return allAvailableModels()
      .filter(m => !f || m.name.toLowerCase().includes(f) || (m.displayName||'').toLowerCase().includes(f))
      .map(m => ({
        label: m.displayName || m.name, desc: m.provider || '',
        action: () => {
          hideSlashMenu(); $('input').value = '';
          assignModelToAgent(activeAgent, m.name, m.provider);
          showToast(`Model → ${m.displayName || m.name}`);
        }
      }));
  }
  // /effort <filter> → reasoning-effort submenu for the active agent/model
  if (/^\/effort(?:\s|$)/.test(val)) {
    const f = val.replace(/^\/effort\s*/i, '').toLowerCase();
    const agent = agents.find(a => a.id === activeAgent);
    const cached = _effortCache?.data;
    if (!cached) { _loadEfforts().then(() => updateSlashMenu()); }
    const options = cached?.options || [{ value: 'auto', label: 'Auto', description: 'Loading supported efforts…' }];
    const current = cached?.current || agent?.reasoningEffort || 'auto';
    return options
      .filter(o => !f || o.value.toLowerCase().includes(f) || (o.label || '').toLowerCase().includes(f))
      .map(o => ({
        label: `${o.label || o.value}${o.value === current ? ' ✓' : ''}`,
        desc: `${agent?.provider || ''}/${agent?.model || ''} · ${o.description || ''}`,
        action: () => {
          hideSlashMenu(); $('input').value = '';
          assignEffortToAgent(activeAgent, o.value);
        }
      }));
  }
  // /agent <filter> → agent submenu
  if (/^\/agent\s/.test(val)) {
    const f = val.slice(7).toLowerCase();
    return agents
      .filter(a => !f || a.id.toLowerCase().includes(f) || a.name.toLowerCase().includes(f))
      .map(a => ({
        label: `${a.emoji} ${a.name}`, desc: a.model || '',
        action: () => { hideSlashMenu(); $('input').value = ''; switchAgent(a.id); closeAllDrawers(); }
      }));
  }
  // /claim and /release pickers — include both roles AND user-installed
  // custom skills. Custom skills are non-service utility-category, so the
  // old `s.service` filter excluded them; users couldn't see e.g. their
  // youtube-downloader in the picker. Same shape as Settings → Skills:
  // roles (service=true) + custom skills (userScope set, non-service).
  const isAssignable = (s) =>
    s.category !== 'delegate' && !s.hidden && (s.service || (!!s.userScope && !s.service));
  const kindLabel = (s) => s.service ? 'Role' : 'Custom skill';
  if (/^\/claim\s/.test(val)) {
    const f = val.slice(7).toLowerCase();
    const cached = _skillsCache || [];
    if (!_skillsCache) { _loadSkills().then(() => updateSlashMenu()); }
    return cached
      .filter(s => isAssignable(s) && (!f || s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f)))
      .map(s => ({
        label: s.name,
        desc: `${kindLabel(s)} · ` + (s.assignment ? `claimed by ${agents.find(a=>a.id===s.assignment)?.name ?? s.assignment}` : 'unclaimed') + (s.description ? ' · ' + s.description : ''),
        action: () => { hideSlashMenu(); $('input').value = `/claim ${s.id}`; _skillsCache = null; send(); }
      }));
  }
  if (/^\/release\s/.test(val)) {
    const f = val.slice(9).toLowerCase();
    const cached = _skillsCache || [];
    if (!_skillsCache) { _loadSkills().then(() => updateSlashMenu()); }
    return cached
      .filter(s => isAssignable(s) && (!f || s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f)))
      .map(s => ({
        label: s.name,
        desc: `${kindLabel(s)} · ` + (s.assignment ? `claimed by ${agents.find(a=>a.id===s.assignment)?.name ?? s.assignment}` : 'unclaimed'),
        action: () => { hideSlashMenu(); $('input').value = `/release ${s.id}`; _skillsCache = null; send(); }
      }));
  }
  // top-level commands
  return SLASH_COMMANDS
    .filter(c => c.cmd.startsWith(lo))
    .map(c => ({
      label: c.cmd, desc: c.desc, iconName: c.icon,
      action: c.action || (() => { $('input').value = c.cmd + ' '; updateSlashMenu(); $('input').focus(); })
    }));
}

function updateSlashMenu() {
  const val = $('input').value;
  if (!val.startsWith('/')) { hideSlashMenu(); return; }
  slashMenuItems = _slashGetItems(val);
  const menu = $('slashMenu');
  if (!slashMenuItems.length) { hideSlashMenu(); return; }
  if (slashMenuIdx >= slashMenuItems.length) slashMenuIdx = 0;
  menu.style.display = 'block';
  menu.innerHTML = slashMenuItems.map((item, i) =>
    `<div class="slash-menu-item${i === slashMenuIdx ? ' active' : ''}" data-idx="${i}">
       ${item.iconName ? `<span class="smi-icon">${icon(item.iconName, 14)}</span>` : ''}
       <span class="smi-label">${escHtml(item.label)}</span>
       <span class="smi-desc">${escHtml(item.desc)}</span>
     </div>`
  ).join('');
  menu.querySelectorAll('.slash-menu-item').forEach(el => {
    el.addEventListener('mousedown', e => { e.preventDefault(); slashMenuItems[+el.dataset.idx]?.action(); });
  });
}

function hideSlashMenu() { $('slashMenu').style.display = 'none'; slashMenuItems = []; slashMenuIdx = 0; }

// ── @-Mention Menu ─────────────────────────────────────────────────────────
// Two modes:
//   `@<handle>`       → agent picker, completes to "@<handle> "
//   `@<kind>/<file>`  → file picker (video/audio/image), completes to
//                       "@<kind>/<exact-filename> ". Server's chat-dispatch
//                       resolves the @-tokens to absolute filesystem paths
//                       and injects them as a system note so transcribe_file
//                       (and any other path-based tool) can act on them.
let atMenuIdx = 0, atMenuItems = [];

// File-menu cache — populated lazily from /api/desktop/{videos,audio,images}.
// Invalidated on agent switch (see switchAgent). Per-folder so a slow images
// list doesn't block videos.
const _atFileCache = {};
const _AT_KIND_MAP = {
  video: 'videos', videos: 'videos',
  audio: 'audio', audios: 'audio',
  image: 'images', images: 'images', photo: 'images', photos: 'images',
};
const _AT_KIND_ICON = { videos: '🎬', audio: '🎙️', images: '🖼️' };
window.invalidateAtFileCache = () => { for (const k of Object.keys(_atFileCache)) delete _atFileCache[k]; };

async function _atFetchFileList(folder) {
  try {
    const r = await fetch(`/api/desktop/${folder}`);
    _atFileCache[folder] = r.ok ? await r.json() : [];
  } catch { _atFileCache[folder] = []; }
}

function _atGetItems(val) {
  // File-reference branch: @<kind>/<partial>
  const fileMatch = val.match(/^@(video|audio|image|images|videos|photo|photos|audios)\/(\S*)$/i);
  if (fileMatch) {
    const rawKind = fileMatch[1].toLowerCase();
    const filter = fileMatch[2].toLowerCase();
    const folder = _AT_KIND_MAP[rawKind];
    if (!folder) return [];
    if (!_atFileCache[folder]) {
      // Trigger fetch; menu repopulates on the next keystroke or via a
      // direct re-render once the fetch resolves.
      _atFetchFileList(folder).then(() => updateAtMenu());
      return [];
    }
    const icon = _AT_KIND_ICON[folder] || '📎';
    return _atFileCache[folder]
      .filter(f => !filter || f.filename.toLowerCase().includes(filter))
      .slice(0, 10)
      .map(f => ({
        label: `${icon} ${f.filename}`,
        desc: f.size ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : '',
        action: () => {
          hideAtMenu();
          const completed = `@${rawKind}/${f.filename} `;
          $('input').value = completed;
          $('input').focus();
          resizeTextarea();
          $('input').setSelectionRange(completed.length, completed.length);
        },
      }));
  }

  // Agent branch: @<handle> (no slash yet). Also surface file-kind
  // shortcuts ("video/", "audio/", "image/") so users discover the file
  // mode by typing the first letter — e.g. `@a` shows both any agent
  // whose name starts with `a` and the `audio/` kind shortcut. Picking a
  // kind drills into its file list.
  const m = val.match(/^@(\S*)$/);
  if (!m) return [];
  const filter = m[1].toLowerCase();
  const KIND_SHORTCUTS = [
    { kind: 'video', icon: '🎬', desc: 'browse videos' },
    { kind: 'audio', icon: '🎙️', desc: 'browse audio'  },
    { kind: 'image', icon: '🖼️', desc: 'browse images' },
  ];
  const kindItems = KIND_SHORTCUTS
    .filter(k => !filter || k.kind.startsWith(filter))
    .map(k => ({
      label: `${k.icon} ${k.kind}/`,
      desc: k.desc,
      action: () => {
        const completed = `@${k.kind}/`;
        $('input').value = completed;
        $('input').focus();
        $('input').setSelectionRange(completed.length, completed.length);
        // Re-fire input handler so updateAtMenu repopulates with files.
        $('input').dispatchEvent(new Event('input', { bubbles: true }));
      },
    }));
  const agentItems = agents
    .filter(a => {
      const handle = String(a.name || '').toLowerCase().replace(/\s+/g, '');
      const idSuffix = String(a.id || '').split('_').pop().toLowerCase();
      return !filter || handle.includes(filter) || idSuffix.includes(filter);
    })
    .slice(0, 10)
    .map(a => {
      const handle = String(a.name || '').toLowerCase().replace(/\s+/g, '');
      return {
        label: `${a.emoji || '🤖'} ${a.name}`,
        desc: `@${handle}`,
        action: () => {
          hideAtMenu();
          $('input').value = `@${handle} `;
          $('input').focus();
          resizeTextarea();
          $('input').setSelectionRange(handle.length + 2, handle.length + 2);
        },
      };
    });
  return [...kindItems, ...agentItems];
}

function updateAtMenu() {
  const val = $('input').value;
  if (!val.startsWith('@')) { hideAtMenu(); return; }
  atMenuItems = _atGetItems(val);
  const menu = $('atMenu');
  if (!atMenuItems.length) { hideAtMenu(); return; }
  if (atMenuIdx >= atMenuItems.length) atMenuIdx = 0;
  menu.style.display = 'block';
  menu.innerHTML = atMenuItems.map((item, i) =>
    `<div class="slash-menu-item${i === atMenuIdx ? ' active' : ''}" data-idx="${i}">
       <span class="smi-label">${escHtml(item.label)}</span>
       <span class="smi-desc">${escHtml(item.desc)}</span>
     </div>`
  ).join('');
  menu.querySelectorAll('.slash-menu-item').forEach((el, i) => {
    el.addEventListener('mousedown', e => { e.preventDefault(); atMenuItems[i]?.action(); });
  });
}

function hideAtMenu() { $('atMenu').style.display = 'none'; atMenuItems = []; atMenuIdx = 0; }
function atMenuNav(dir) {
  if (!atMenuItems.length) return;
  atMenuIdx = (atMenuIdx + dir + atMenuItems.length) % atMenuItems.length;
  updateAtMenu();
}
window.updateAtMenu = updateAtMenu;
window.hideAtMenu = hideAtMenu;
window.atMenuNav = atMenuNav;
window._atMenuItems = () => atMenuItems;
window._atMenuIdx = () => atMenuIdx;
window._atMenuAction = () => atMenuItems[atMenuIdx]?.action();

function slashMenuNav(dir) {
  if (!slashMenuItems.length) return;
  slashMenuIdx = (slashMenuIdx + dir + slashMenuItems.length) % slashMenuItems.length;
  updateSlashMenu();
}

// ── Credential prompt bubble ─────────────────────────────────────────────────
// A tool (or the oe-admin skill) asked the user for a secret. The value is
// pasted into a password-style input and submitted via a NEW WS frame
// (`submit_credential`), bypassing the normal chat input pipeline so it
// never enters the LLM message history. The bubble morphs into a "Provided"
// indicator on submit — the actual value is never rendered to the DOM.
function appendCredentialPromptBubble(credentialId, label, description, kind) {
  if (!credentialId) return;
  if (document.querySelector(`.msg.credential-prompt[data-credential-id="${CSS.escape(credentialId)}"]`)) return;

  const el = document.createElement('div');
  el.className = 'msg credential-prompt';
  el.dataset.credentialId = credentialId;
  el.dataset.credentialKind = kind || 'api_key';
  el.style.cssText = 'padding:10px 12px;margin:6px 0;font-size:13px;border-left:3px solid #f0b400;background:rgba(240,180,0,0.06);border-radius:4px';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px';
  const icon = document.createElement('span');
  icon.textContent = kind === 'sudo' ? '🔐' : kind === 'confirm' ? '⚠️' : '🔑';
  header.appendChild(icon);
  const labelEl = document.createElement('span');
  labelEl.style.cssText = 'font-weight:600';
  labelEl.textContent = label || 'Enter credential';
  header.appendChild(labelEl);
  el.appendChild(header);

  if (description) {
    const desc = document.createElement('div');
    desc.style.cssText = 'color:var(--muted);font-size:12px;margin-bottom:8px;white-space:pre-wrap';
    desc.textContent = description;
    el.appendChild(desc);
  }
  if (kind === 'sudo') {
    const note = document.createElement('div');
    note.style.cssText = 'color:var(--muted);font-size:11px;margin-bottom:8px';
    note.textContent = 'Used once for this operation. Not stored.';
    el.appendChild(note);
  } else if (kind === 'confirm') {
    const note = document.createElement('div');
    note.style.cssText = 'color:var(--muted);font-size:11px;margin-bottom:8px';
    note.textContent = 'Type the exact confirmation phrase shown above.';
    el.appendChild(note);
  }

  const form = document.createElement('form');
  form.style.cssText = 'display:flex;gap:6px;align-items:center';

  const input = document.createElement('input');
  input.type = kind === 'confirm' ? 'text' : 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.style.cssText = 'flex:1;padding:6px 8px;border:1px solid var(--border);background:var(--bg-input, #111);color:var(--fg);border-radius:4px;font-family:inherit;font-size:13px';
  input.placeholder = kind === 'sudo' ? 'sudo password' : kind === 'confirm' ? 'type here…' : 'paste secret here';
  form.appendChild(input);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.textContent = 'Submit';
  submitBtn.style.cssText = 'padding:6px 12px;border:1px solid var(--accent, #6c8cff);background:var(--accent, #6c8cff);color:#fff;border-radius:4px;cursor:pointer;font-size:12px';
  form.appendChild(submitBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:6px 12px;border:1px solid var(--border);background:transparent;color:var(--muted);border-radius:4px;cursor:pointer;font-size:12px';
  form.appendChild(cancelBtn);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = input.value;
    if (!value) return;
    // Clear input immediately — the value lives only on the wire from here.
    input.value = '';
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    try {
      ws.send(JSON.stringify({ type: 'submit_credential', credentialId, value }));
    } catch (e) {
      markCredentialBubbleError(credentialId, 'send_failed');
    }
  });
  cancelBtn.addEventListener('click', () => {
    submitBtn.disabled = true;
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelled';
    try { ws.send(JSON.stringify({ type: 'cancel_credential', credentialId })); } catch {}
  });

  el.appendChild(form);
  insertBefore(el);
  scrollToBottom();
}

function resolveCredentialBubble(credentialId, cancelled) {
  const el = document.querySelector(`.msg.credential-prompt[data-credential-id="${CSS.escape(credentialId)}"]`);
  if (!el) return;
  const form = el.querySelector('form');
  if (form) form.remove();
  const status = document.createElement('div');
  status.style.cssText = 'color:var(--muted);font-size:12px';
  status.textContent = cancelled ? 'Cancelled.' : 'Provided.';
  el.appendChild(status);
}

function markCredentialBubbleError(credentialId, error) {
  const el = document.querySelector(`.msg.credential-prompt[data-credential-id="${CSS.escape(credentialId)}"]`);
  if (!el) return;
  const err = document.createElement('div');
  err.style.cssText = 'color:#f55;font-size:12px;margin-top:6px';
  err.textContent = 'Error: ' + (error || 'unknown');
  el.appendChild(err);
}
