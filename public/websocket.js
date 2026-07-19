// ── WebSocket ─────────────────────────────────────────────────────────────────
let _reconnectDelay = 1000;
let _pingTimer = null;
// Timestamp of the last pong we actually received. Used by the visibilitychange
// liveness probe: readyState===OPEN can lie after an iOS resume, so we require a
// fresh pong to prove the socket is really alive.
let _lastPongAt = 0;
// Agents whose history has been genuinely loaded from the server (via
// session_loaded). Distinct from `agent in sessions`, which is also true when a
// push (status / agent_report) merely seeded an empty array — those still need a
// real load_session so switching to them doesn't show only the stray push.
let sessionsLoaded = new Set();
const agentSessionEpochs = Object.create(null);
const terminalTurnIds = Object.create(null);
const agentLiveRevisions = Object.create(null);
const agentSnapshotGenerations = Object.create(null);
const agentCredentialPrompts = Object.create(null);
const _sessionLoadRequests = new Map();
const _latestSessionRequest = Object.create(null);
let _sessionLoadSeq = 0;
let _connectionGeneration = 0;
let _serverBootId = null;

const TURN_EVENT_TYPES = new Set([
  'turn_accepted', 'token', 'replace', 'tool_call', 'tool_progress', 'tool_result',
  'permission_request', 'hide_turn', 'done', 'error', 'image', 'video', 'perf',
  'approval_pending', 'approval_resolved', 'attachment_decision', 'document_response',
  'assistant_notification',
  'credential_prompt', 'credential_resolved', 'credential_error',
]);
const TURN_AUX_EVENT_TYPES = new Set([
  'approval_pending', 'approval_resolved', 'attachment_decision', 'document_response',
  'assistant_notification',
]);
const CREDENTIAL_EVENT_TYPES = new Set(['credential_prompt', 'credential_resolved', 'credential_error']);

function noteAgentLiveRevision(msg) {
  if (!msg?.agent || !Number.isFinite(msg.chat_revision)) return;
  const agent = clientSessionAgentId(msg.agent);
  agentLiveRevisions[agent] = Math.max(agentLiveRevisions[agent] ?? 0, msg.chat_revision);
}

function observeServerBootId(bootId) {
  if (typeof bootId !== 'string' || !bootId) return;
  if (_serverBootId && _serverBootId !== bootId) {
    for (const key of Object.keys(agentLiveRevisions)) delete agentLiveRevisions[key];
    for (const key of Object.keys(agentSnapshotGenerations)) delete agentSnapshotGenerations[key];
    for (const key of Object.keys(agentStreams)) delete agentStreams[key];
    for (const key of Object.keys(terminalTurnIds)) delete terminalTurnIds[key];
    for (const prompts of Object.values(agentCredentialPrompts)) prompts?.clear?.();
    for (const request of _sessionLoadRequests.values()) request.liveRevision = 0;
  }
  _serverBootId = bootId;
}

function requestAgentSession(agent) {
  if (!agent || ws?.readyState !== WebSocket.OPEN) return null;
  const requestId = `load_${Date.now()}_${++_sessionLoadSeq}`;
  const request = {
    requestId, agent,
    liveRevision: agentLiveRevisions[agent] ?? 0,
    startedAt: Date.now(),
    generation: _connectionGeneration,
    ordinal: _sessionLoadSeq,
  };
  _sessionLoadRequests.set(requestId, request);
  _latestSessionRequest[agent] = request;
  ws.send(JSON.stringify({ type: 'load_session', agent, request_id: requestId }));
  return requestId;
}

function credentialPromptMap(agent) {
  if (!agentCredentialPrompts[agent]) agentCredentialPrompts[agent] = new Map();
  return agentCredentialPrompts[agent];
}

function credentialPromptAgent(msg) {
  if (msg?.agent) return clientSessionAgentId(msg.agent);
  if (msg?.credentialId) {
    for (const [agent, prompts] of Object.entries(agentCredentialPrompts)) {
      if (prompts?.has(msg.credentialId)) return agent;
    }
  }
  return activeAgent;
}

function projectCredentialPrompts(agent) {
  if (agent !== activeAgent) return;
  for (const prompt of credentialPromptMap(agent).values()) {
    appendCredentialPromptBubble(prompt.credentialId, prompt.label, prompt.description, prompt.kind);
  }
}

function clientSessionAgentId(agent) {
  if (typeof agent !== 'string' || !agent) return agent;
  const uid = (typeof _currentUser !== 'undefined' && _currentUser?.id) ? String(_currentUser.id) : '';
  if (uid && agent.startsWith(`${uid}_`)) return agent.slice(uid.length + 1);
  // Fallback for the window before _currentUser is set: real user ids are
  // plain slugs ("default", "debug_user"), so match the tail against the
  // known agent list — an exact match means it's already raw (custom agent
  // ids like "agent_2df…" contain underscores and must not be stripped).
  const list = (typeof agents !== 'undefined' && Array.isArray(agents)) ? agents : [];
  if (list.some(a => a.id === agent)) return agent;
  const known = list.find(a => a.id && agent.endsWith(`_${a.id}`));
  if (known) return known.id;
  return agent.replace(/^user_[^_]+_/, '');
}

function freshAgentTurnState(agent, source = {}) {
  return {
    agent,
    buf: String(source.content ?? source.buf ?? ''),
    toolEvents: Array.isArray(source.toolEvents) ? source.toolEvents.map(ev => ({ ...ev })) : [],
    active: source.phase !== 'failed' && source.phase !== 'complete',
    phase: source.phase || 'running',
    turnId: source.turnId ?? source.turn_id ?? null,
    messageId: source.messageId ?? source.message_id ?? null,
    attemptId: source.attemptId ?? source.attempt_id ?? source.turnId ?? source.turn_id ?? null,
    lastSeq: Number(source.seq) || 0,
    liveRevision: Number(source.chatRevision ?? source.chat_revision) || 0,
    needsResync: source.needsResync === true,
    resyncRevision: Number(source.resyncRevision) || 0,
    sessionEpoch: source.sessionEpoch ?? source.session_epoch ?? agentSessionEpochs[agent] ?? null,
    hidden: source.hidden === true,
    permissionRequest: source.permissionRequest ? { ...source.permissionRequest } : null,
    startedAt: source.startTs ?? Date.now(),
  };
}

function activeBackgroundTaskStatus(task) {
  if (!task || !task.watcherId) return null;
  // New servers send a purpose-built state object. The top-level fallbacks
  // keep rolling restarts compatible with an older server that still sends
  // its raw (JSON-safe) active-task fields to a freshly loaded browser asset.
  const state = {
    taskId: task.taskId || null,
    rootTaskId: task.rootTaskId || task.taskId || null,
    rootWatcherId: task.rootWatcherId || task.watcherId,
    visibleAgentId: task.visibleAgentId || task.coordinatorAgentId || null,
    status: task.status || 'running',
    targetAgentId: task.agentId || null,
    targetAgentName: task.agentName || 'Background task',
    targetAgentEmoji: task.agentEmoji || '⟳',
    summary: task.summary || '',
    startedAt: task.startedAt || null,
    lastActivityAt: task.lastActivityAt || task.lastUpdateAt || task.startedAt || null,
    toolsUsed: Number(task.toolsUsed) || 0,
    currentTool: task.currentTool || null,
    phase: task.phase || task.status || 'running',
    canCancel: task.canCancel === true,
    ...(task.state && typeof task.state === 'object' ? task.state : {}),
  };
  return {
    kind: 'task_proxy',
    watcherId: task.watcherId,
    label: task.label || `${task.agentEmoji || '⟳'} ${task.agentName || 'Background task'}`,
    text: task.text || `${task.agentName || 'Background task'} is working on it…`,
    final: false,
    finalStatus: null,
    awaiting_input: false,
    pending_question: null,
    state: {
      ...state,
      canCancel: task.canCancel === true && state.canCancel !== false,
    },
    recentHistory: [],
  };
}

// active_streams is the authoritative reconnect frame. Restore one lightweight
// task_proxy row per running background job so a reload never turns real work
// into an unexplained idle screen. Live `status` frames replace these fallback
// rows as soon as richer progress arrives.
function reconcileActiveBackgroundTasks(tasks) {
  let activeAgentChanged = false;
  for (const [agent, rows] of Object.entries(sessions)) {
    const filtered = (rows || []).filter(row => row?._activeTaskSnapshot !== true);
    if (filtered.length !== (rows || []).length) {
      sessions[agent] = filtered;
      if (agent === activeAgent) activeAgentChanged = true;
    }
  }

  for (const task of (Array.isArray(tasks) ? tasks : [])) {
    const status = activeBackgroundTaskStatus(task);
    if (!status) continue;
    const agent = clientSessionAgentId(
      task.visibleAgentId || task.state?.visibleAgentId || task.agentId || activeAgent,
    );
    if (!agent) continue;
    if (!sessions[agent]) sessions[agent] = [];
    const rows = sessions[agent];
    const existingIdx = rows.findIndex(row =>
      row?.role === 'status' && row.status?.watcherId === status.watcherId);
    // A live status frame is newer and more descriptive than this reconnect
    // fallback. Only replace a prior fallback snapshot.
    if (existingIdx >= 0 && rows[existingIdx]?._activeTaskSnapshot !== true) continue;
    const entry = {
      role: 'status',
      status,
      content: `[Status: ${status.text}]`,
      ts: Number(task.lastActivityAt || task.state?.lastActivityAt || task.startedAt) || Date.now(),
      _activeTaskSnapshot: true,
    };
    if (existingIdx >= 0) rows[existingIdx] = entry;
    else rows.push(entry);
    if (agent === activeAgent) activeAgentChanged = true;
  }
  return activeAgentChanged;
}

// Validate the wire envelope before any handler touches DOM globals. Events for
// an old cleared generation, an old turn on the same agent, or a duplicate seq
// are dropped uniformly whether the agent is selected or in the background.
function acceptTurnEnvelope(msg) {
  if (!TURN_EVENT_TYPES.has(msg.type) || !msg.agent) return true;
  const agent = clientSessionAgentId(msg.agent);
  msg.agent = agent;
  const knownEpoch = agentSessionEpochs[agent] ?? null;
  if (msg.session_epoch && knownEpoch && msg.session_epoch !== knownEpoch) return false;

  let state = agentStreams[agent] ?? null;
  const incomingTurnId = msg.turn_id ?? null;
  // Credential cards have their own stable credentialId lifecycle. A prompt
  // from turn A must still be removable after turn B barges in; only the
  // session epoch, not current-turn ownership, gates these events.
  if (CREDENTIAL_EVENT_TYPES.has(msg.type)) return true;
  if (TURN_AUX_EVENT_TYPES.has(msg.type)) {
    // These rows carry their own stable operation/decision/request ids and are
    // durable independently of whichever turn currently owns the stream pane.
    // A later turn may barge in before an older turn's post-commit card arrives;
    // render/cache it, but do not advance the newer turn's sequence counter.
    const ownsCurrentState = state && (!incomingTurnId || !state.turnId || state.turnId === incomingTurnId);
    if (ownsCurrentState && Number.isFinite(msg.seq)) {
      if (Number.isFinite(msg.chat_revision)) {
        state.liveRevision = Math.max(state.liveRevision || 0, msg.chat_revision);
      }
      if (msg.seq > (state.lastSeq || 0) + 1 && ws?.readyState === WebSocket.OPEN) {
        state.needsResync = true;
        state.resyncRevision = Number(msg.chat_revision) || state.liveRevision || 0;
        requestAgentSession(agent);
      }
      if (msg.seq > (state.lastSeq || 0)) state.lastSeq = msg.seq;
    }
    return true;
  }
  if (msg.type === 'turn_accepted') {
    if (incomingTurnId) delete terminalTurnIds[agent];
    if (!state || (incomingTurnId && state.turnId !== incomingTurnId)) {
      // The current frame has not been reduced yet. Seeding lastSeq from it
      // made the generic duplicate guard below drop the first event for every
      // non-originating tab (which has no optimistic state).
      state = agentStreams[agent] = freshAgentTurnState(agent, { ...msg, seq: 0 });
    }
    state.active = !['failed', 'complete'].includes(msg.status);
    state.phase = msg.status === 'accepted' ? 'running' : (msg.status || state.phase);
  } else if (incomingTurnId) {
    if (!state && terminalTurnIds[agent] === incomingTurnId) return false;
    if (state && !state.active && terminalTurnIds[agent] === incomingTurnId) return false;
    if (!state) state = agentStreams[agent] = freshAgentTurnState(agent, { ...msg, seq: 0 });
    else if (state.turnId && state.turnId !== incomingTurnId) return false;
    else if (!state.turnId) state.turnId = incomingTurnId;
  }
  if (state) {
    if (Number.isFinite(msg.seq) && msg.seq <= (state.lastSeq || 0)) return false;
    if (Number.isFinite(msg.seq) && msg.seq > (state.lastSeq || 0) + 1
        && ws?.readyState === WebSocket.OPEN) {
      // A reconnect/suspension gap: ask for an authoritative active snapshot.
      // Continue reducing this event; the same-or-newer snapshot will replace
      // the incomplete local state when it arrives.
      state.needsResync = true;
      state.resyncRevision = Number(msg.chat_revision) || state.liveRevision || 0;
      requestAgentSession(agent);
    }
    if (Number.isFinite(msg.seq)) state.lastSeq = msg.seq;
    if (msg.message_id) state.messageId = msg.message_id;
    if (msg.attempt_id) state.attemptId = msg.attempt_id;
    if (msg.session_epoch) state.sessionEpoch = msg.session_epoch;
    if (Number.isFinite(msg.chat_revision)) {
      state.liveRevision = Math.max(state.liveRevision || 0, msg.chat_revision);
    }
  }
  return true;
}

function mergeActiveStreamSnapshot(agent, snapshot, sessionEpoch = null) {
  if (!snapshot) return null;
  const incoming = freshAgentTurnState(agent, { ...snapshot, sessionEpoch });
  const current = agentStreams[agent];
  if (current) {
    const currentRevision = Number(current.liveRevision) || 0;
    const incomingRevision = Number(incoming.liveRevision) || 0;
    // Revision is per-agent and stamped at the exact active-registry snapshot.
    // An older response must not replace a newer turn merely because the turn
    // ids differ; that was the reconnect path that resurrected old streams.
    const healsKnownGap = current.needsResync
      && incomingRevision >= (Number(current.resyncRevision) || 0);
    if (incomingRevision < currentRevision) return current;
    if (incomingRevision === currentRevision) {
      if (current.turnId && incoming.turnId && current.turnId !== incoming.turnId) return current;
      if (!healsKnownGap && current.turnId === incoming.turnId && (current.lastSeq || 0) > incoming.lastSeq) return current;
    }
  }
  agentStreams[agent] = incoming;
  return incoming;
}

// DOM is a projection of the selected agent's canonical turn state. Called
// after session rerenders, reconnect snapshots, and agent switches.
function projectAgentStreamState(agent) {
  if (agent !== activeAgent) return;
  const state = agentStreams[agent];
  streamEl = null;
  streamBuf = '';
  resetToolRun();
  awaitingPermission = false;
  projectCredentialPrompts(agent);
  if (!state?.active) {
    setStreaming(false); setTyping(false);
    return;
  }
  streamBuf = state.hidden ? '' : (state.buf || '');
  if (!state.hidden) {
    streamEl = appendStreamingBubble();
    if (streamBuf) applyMarkdown(streamEl, streamBuf);
  }
  if (typeof restoreToolRun === 'function') restoreToolRun(state.toolEvents || []);
  setStreaming(true);
  setTyping(!streamBuf && !state.permissionRequest);
  if (state.permissionRequest) {
    if (streamEl && !streamBuf) streamEl.closest('.msg')?.remove();
    streamEl = null;
    appendAssistantBubble(state.permissionRequest.text || 'Permission required', Date.now(), true);
    awaitingPermission = true;
    $('btnSend').disabled = false;
    $('input').disabled = false;
  }
  scrollToBottom();
}

function connect() {
  _connectionGeneration++;
  // Tear down any prior socket first. Signup/login/invite flows can call init()
  // — and thus connect() — multiple times; without this, old sockets keep their
  // onmessage handler wired to handleServerMessage and the same server event
  // renders N times into shared DOM globals.
  if (ws) {
    try {
      ws.onopen = null; ws.onclose = null; ws.onerror = null; ws.onmessage = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    } catch {}
  }
  clearTimeout(_pingTimer);
  // Match the page's protocol — wss:// over HTTPS (tunnel deploys), ws://
  // over plain HTTP (local dev). Hardcoding ws:// fails mixed-content when
  // OE is served over a secure tunnel — the browser blocks the upgrade and
  // every WS-dependent feature (chat send, streaming, drawers) goes silent.
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${wsProto}://${location.host}`);
  ws.onopen  = () => {
    sessionsLoaded.clear();
    // Authenticate via first message instead of URL query string
    ws.send(JSON.stringify({ type: 'auth', token: getToken() ?? '' }));
    // Safety net: explicitly request history for the currently active agent.
    // The server also sends a session_loaded burst for every agent after auth,
    // but on mobile (iOS PWA / backgrounded tab) that burst is easy to miss —
    // so we always re-fetch for the active agent on every successful connect.
    if (activeAgent) {
      requestAgentSession(activeAgent);
    }
    _reconnectDelay = 1000; if (!streaming) setStatus('online'); schedulePing();
  };
  ws.onclose = () => {
    clearTimeout(_pingTimer);
    // Preserve the live overlay under its agent/turn. Never commit a partial
    // into persisted-history cache: session_loaded + pendingStream used to
    // double/split that synthetic row on reconnect.
    const wasStreaming = streaming;
    if (wasStreaming && activeAgent) {
      const state = agentStreams[activeAgent] || freshAgentTurnState(activeAgent);
      state.buf = streamBuf || state.buf;
      state.toolEvents = currentLiveToolEvents() || state.toolEvents || [];
      state.active = true;
      agentStreams[activeAgent] = state;
    }
    streamEl = null; streamBuf = ''; resetToolRun();
    if (!wasStreaming) { setStreaming(false); setTyping(false); }
    setStatus('offline');
    const delay = _reconnectDelay;
    _reconnectDelay = Math.min(_reconnectDelay * 1.5, 15000);
    // Reconnect whenever a current user is set in the page state. Cookie-based
    // auth means there's no client-readable token to gate on; the server will
    // accept or 401 on the upgrade based on the cookie.
    setTimeout(() => { if (_currentUser) connect(); }, delay);
  };
  ws.onerror = () => {};
  ws.onmessage = ({ data }) => {
    let msg;
    try {
      msg = JSON.parse(data);
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        throw new Error('message must be a JSON object');
      }
    } catch (error) {
      // Do not log the raw frame: a valid server message can contain private
      // chat/tool data. Dropping one malformed frame leaves the socket usable.
      console.warn('[websocket] ignored malformed server message:', error.message);
      return;
    }
    // Handler failures are programming errors, not malformed wire data. Keep
    // them visible to the browser console instead of silently hiding them.
    handleServerMessage(msg);
  };
}
function schedulePing() {
  clearTimeout(_pingTimer);
  _pingTimer = setTimeout(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    schedulePing();
  }, 15000);
}

// ── iOS / mobile: reconnect when tab becomes visible again ────────────────────
// On iOS, Safari suspends JS timers when the app is backgrounded or the screen
// locks. The WebSocket drops silently — but readyState often still reports OPEN
// because the client never processed the close. So we can't trust readyState
// here: always tear down the old socket and reconnect fresh.
function forceReconnect() {
  // Preserve the in-flight overlay before reconnecting; authoritative history
  // and active-turn state arrive separately from the server.
  const wasStreaming = streaming;
  if (wasStreaming && activeAgent) {
    const state = agentStreams[activeAgent] || freshAgentTurnState(activeAgent);
    state.buf = streamBuf || state.buf;
    state.toolEvents = currentLiveToolEvents() || state.toolEvents || [];
    state.active = true;
    agentStreams[activeAgent] = state;
  }
  streamEl = null; streamBuf = ''; resetToolRun();
  // Don't reset the status dot yet — keep it busy until the server confirms
  // via active_streams whether the agent is still working.  This avoids the
  // green flash on reconnect when the agent is actually still thinking.
  if (!wasStreaming) { setStreaming(false); setTyping(false); }

  clearTimeout(_pingTimer);
  _reconnectDelay = 1000;
  if (ws) {
    try {
      // Suppress the reconnect storm from the old socket's onclose
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    } catch {}
  }
  if (_currentUser) connect();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // On desktop, the WS usually stays alive across tab switches — only
    // reconnect if it's actually dead.  Send a ping to verify; if it fails
    // or the socket is already closed, then force-reconnect.
    if (ws && ws.readyState === WebSocket.OPEN) {
      const before = _lastPongAt;
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch { forceReconnect(); return; }
      schedulePing();                   // reset the keep-alive timer
      // readyState lies after an iOS resume (green dot, no traffic). Require a
      // fresh pong within ~2s; if none arrives, the socket is half-dead — force
      // a clean reconnect instead of trusting readyState.
      setTimeout(() => {
        if (document.visibilityState === 'visible' && _lastPongAt <= before) forceReconnect();
      }, 2000);
    } else {
      forceReconnect();
    }
  }
});

// bfcache restore on iOS Safari: visibilitychange may not fire, but pageshow
// with event.persisted === true does. The WS is always closed by bfcache, so
// we unconditionally reconnect to repopulate history.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) forceReconnect();
});

// ── Streaming render batching ─────────────────────────────────────────────────
// Tokens can arrive hundreds of times per second; re-parsing the whole growing
// markdown buffer per token is O(n²) and kills text selection. Batch renders to
// one per animation frame. Commit points (done / permission_request / Stop)
// call flushStreamRender() so the final tokens are painted before the bubble
// is finalized.
let _streamRAF = 0;
function scheduleStreamRender() {
  if (_streamRAF) return;
  _streamRAF = requestAnimationFrame(() => {
    _streamRAF = 0;
    if (!streamEl) return; // turn ended/committed while the frame was queued
    applyMarkdown(streamEl, streamBuf);
    scrollToBottom();
  });
}
function flushStreamRender() {
  if (_streamRAF) { cancelAnimationFrame(_streamRAF); _streamRAF = 0; }
  if (streamEl) applyMarkdown(streamEl, streamBuf);
}

function finishDocumentStreamUi(agentId) {
  if (agentId !== activeAgent) return;
  flushStreamRender();
  if (streamEl) streamEl.closest('.msg')?.remove();
  streamEl = null;
  streamBuf = '';
  resetToolRun(true);
  setStreaming(false);
  setTyping(false);
}

function reloadDocumentSession(agentId) {
  if (agentId) requestAgentSession(agentId);
}

// ── Server messages ───────────────────────────────────────────────────────────
function handleServerMessage(msg) {
  observeServerBootId(msg?.boot_id);
  noteAgentLiveRevision(msg);
  if (!acceptTurnEnvelope(msg)) return;
  switch (msg.type) {
    case 'pong': _lastPongAt = Date.now(); break;
    case 'session_loaded': {
      const agent = clientSessionAgentId(msg.agent);
      const serverMsgs = msg.messages ?? [];
      const request = msg.request_id ? _sessionLoadRequests.get(msg.request_id) : null;
      if (msg.request_id) _sessionLoadRequests.delete(msg.request_id);
      const latestRequest = _latestSessionRequest[agent];
      // Multiple reconnect/switch requests may be in flight. Once a newer
      // request exists, its response is the only one allowed to reconcile.
      if (request && latestRequest && request.ordinal < latestRequest.ordinal) break;
      const snapshotGeneration = Number(msg.snapshotGeneration) || 0;
      if (snapshotGeneration && snapshotGeneration < (agentSnapshotGenerations[agent] ?? 0)) break;
      const knownEpoch = agentSessionEpochs[agent] ?? null;
      // Within one connection an epoch mismatch can only be an old response
      // racing a clear. Across reconnect, sessionsLoaded was cleared so the
      // first response is allowed to establish the server's current epoch.
      if (sessionsLoaded.has(agent) && knownEpoch && msg.sessionEpoch && msg.sessionEpoch !== knownEpoch) break;
      const snapshotRevision = Number.isFinite(msg.sessionRevision)
        ? msg.sessionRevision
        : (request?.liveRevision ?? 0);
      const hasExactActiveRevision = Number.isFinite(msg.activeSnapshotRevision);
      const activeSnapshotRevision = hasExactActiveRevision
        ? msg.activeSnapshotRevision
        : snapshotRevision;
      const currentLiveRevision = agentLiveRevisions[agent] ?? 0;
      sessionsLoaded.add(agent);
      if (snapshotGeneration) agentSnapshotGenerations[agent] = snapshotGeneration;
      if (msg.sessionEpoch) agentSessionEpochs[agent] = msg.sessionEpoch;
      const clientMsgs = sessions[agent] ?? [];
      // Merge: use server data as the authoritative base, but preserve any
      // client-only messages that haven't been persisted yet (e.g. a user
      // message sent just before the WS dropped, or a streamed reply that
      // was committed to sessions by forceReconnect).
      if (clientMsgs.length > 0 && serverMsgs.length >= 0) {
        // Stable turn/message/op ids win. Timestamp is only a legacy fallback
        // for optimistic rows created by pre-correlation clients.
        const clientOnly = clientMsgs.filter(m => {
          const equivalent = typeof sessionHasEquivalent === 'function'
            ? sessionHasEquivalent(serverMsgs, m)
            : serverMsgs.some(s => s.role === m.role && s.content === m.content);
          if (equivalent) return false;
          // Optimistic sends are retained until the server proves acceptance.
          if (m.role === 'user' && m.turnStatus === 'running') return true;
          // A snapshot begun before this live row/event cannot erase it.
          return currentLiveRevision > snapshotRevision
            && Number(m._liveRevision) > snapshotRevision;
        });
        sessions[agent] = clientOnly.length > 0
          ? [...serverMsgs, ...clientOnly]
          : serverMsgs;
      } else {
        sessions[agent] = serverMsgs;
      }
      if (typeof reconcilePendingAttemptsFromSession === 'function') {
        reconcilePendingAttemptsFromSession(agent, serverMsgs, _connectionGeneration, msg.activeStream);
      }
      const lastTerminal = [...serverMsgs].reverse().find(m =>
        (m.role === 'assistant' || m.role === 'turn_error') && m.turnId);
      if (lastTerminal?.turnId) terminalTurnIds[agent] = lastTerminal.turnId;
      if (msg.activeStream) {
        if (terminalTurnIds[agent] === msg.activeStream.turnId) delete terminalTurnIds[agent];
        mergeActiveStreamSnapshot(agent, msg.activeStream, msg.sessionEpoch);
      } else {
        const local = agentStreams[agent];
        const acceptedAfterSnapshot = local?.active && (
          (local.liveRevision || 0) > activeSnapshotRevision
          || (!hasExactActiveRevision && request && local.startedAt >= request.startedAt)
        );
        // Never let an older no-active response erase a turn accepted after
        // that load began. The short grace remains for legacy servers without
        // revision/request metadata.
        const legacyAcceptanceWindow = !hasExactActiveRevision && local?.active && local.phase === 'running'
          && Date.now() - local.startedAt < 3000;
        if (!acceptedAfterSnapshot && !legacyAcceptanceWindow) {
          delete agentStreams[agent];
        }
      }
      if (Array.isArray(msg.credentialPrompts)) {
        const prompts = credentialPromptMap(agent);
        prompts.clear();
        for (const prompt of msg.credentialPrompts) {
          if (prompt?.credentialId) prompts.set(prompt.credentialId, { ...prompt, agent });
        }
      }
      // A buffer with no live server turn is crash recovery, not an overlay.
      if (!msg.activeStream && msg.pendingStream?.content) {
        const already = sessions[agent].some(m =>
          (msg.pendingStream.turnId && m.turnId === msg.pendingStream.turnId)
          || (m.role === 'assistant' && m.ts === msg.pendingStream.ts));
        if (!already) {
          sessions[agent].push({
            role: 'assistant',
            content: msg.pendingStream.content,
            ts: msg.pendingStream.ts,
            partial: true,
            turnId: msg.pendingStream.turnId ?? null,
            messageId: msg.pendingStream.messageId ?? null,
            attemptId: msg.pendingStream.attemptId ?? null,
            toolEvents: msg.pendingStream.toolEvents ?? [],
          });
        }
      }
      if (agent === activeAgent) {
        renderSession();
        projectAgentStreamState(agent);
        // Page-load / reconnect draft restore. session_loaded is the first
        // point activeAgent's history is actually known to be settled — but
        // it also refires on every reconnect, so only populate when the
        // composer is empty; never clobber text the user is mid-typing
        // while a reconnect happens to land.
        if (typeof restoreDraftForAgent === 'function' && !$('input')?.value) {
          restoreDraftForAgent(activeAgent);
        }
      }
      break;
    }
    case 'turn_accepted': {
      if (msg.attempt_id && typeof acceptPendingAttempt === 'function') acceptPendingAttempt(msg.attempt_id);
      const state = agentStreams[msg.agent] || (agentStreams[msg.agent] = freshAgentTurnState(msg.agent, msg));
      if (msg.userMessage) {
        if (!sessions[msg.agent]) sessions[msg.agent] = [];
        const row = {
          ...msg.userMessage,
          role: 'user',
          turnId: msg.turn_id ?? msg.userMessage.turnId ?? null,
          messageId: msg.message_id ?? msg.userMessage.messageId ?? null,
          attemptId: msg.attempt_id ?? msg.userMessage.attemptId ?? null,
          turnStatus: 'running',
          ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}),
        };
        if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[msg.agent], row))) {
          sessions[msg.agent].push(row);
          if (msg.agent === activeAgent) renderSession();
        }
      }
      state.active = !['complete', 'failed', 'stopped'].includes(msg.status);
      if (msg.agent === activeAgent && state.active) {
        setStreaming(true); setTyping(true);
      }
      if (msg.duplicate && msg.status === 'complete') reloadDocumentSession(msg.agent);
      buildTabs(); buildAgentDrawer();
      break;
    }
    case 'token':
      if (typeof handleDocumentChatToken === 'function' && handleDocumentChatToken(msg.agent, msg.text, msg.documentRequest)) {
        setTyping(false);
        break;
      }
      {
        const isNew = !agentStreams[msg.agent];
        const state = agentStreams[msg.agent] || (agentStreams[msg.agent] = freshAgentTurnState(msg.agent, msg));
        state.buf += msg.text;
        state.active = true;
        state.phase = 'running';
        if (msg.agent !== activeAgent) {
        if (isNew) { buildTabs(); buildAgentDrawer(); }
        break;
        }
      }
      // Route to widget if active
      if (typeof widgetStreamAppend === 'function' && widgetStreamAppend(msg.text)) {
        setTyping(false);
        break;
      }
      if (!streamEl) { streamBuf = ''; streamEl = appendStreamingBubble(); setTyping(false); }
      streamBuf = agentStreams[msg.agent]?.buf ?? (streamBuf + msg.text);
      scheduleStreamRender();
      break;
    case 'permission_request':
      {
        const state = agentStreams[msg.agent] || (agentStreams[msg.agent] = freshAgentTurnState(msg.agent, msg));
        state.permissionRequest = { text: msg.text, permissionId: msg.permissionId ?? msg.permission_id ?? null };
        state.phase = 'awaiting_permission';
        state.active = true;
      }
      if (msg.agent !== activeAgent) { buildTabs(); buildAgentDrawer(); break; }
      // Commit any in-progress stream bubble
      flushStreamRender();
      streamEl = null; streamBuf = '';
      // appendMessage never existed — this threw a ReferenceError the moment
      // a permission request reached the active agent, killing the handler
      // before the input unlock below.
      appendAssistantBubble(msg.text, Date.now(), true);
      // Unlock input so user can type APPROVE or DENY (bypasses streaming guard)
      awaitingPermission = true;
      $('btnSend').disabled = false;
      $('input').disabled = false;
      scrollToBottom();
      break;
    case 'tool_call':
      if (typeof handleDocumentChatToolCall === 'function' && handleDocumentChatToolCall(msg.agent, msg.name, msg.args, msg.documentRequest)) break;
      if (msg.documentTurn && typeof handleRemoteDocumentToolCall === 'function'
          && handleRemoteDocumentToolCall(msg.agent, msg.documentRequest, msg.name)) break;
      {
        const isNew = !agentStreams[msg.agent];
        const state = agentStreams[msg.agent] || (agentStreams[msg.agent] = freshAgentTurnState(msg.agent, msg));
        state.toolEvents.push({
          name: msg.name, args: msg.args ?? null,
          callId: msg.toolCallId || msg.tool_call_id || msg.callId || null,
          startedAt: Date.now(), status: 'running',
        });
        state.active = true;
        if (msg.agent !== activeAgent) {
        if (isNew) { buildTabs(); buildAgentDrawer(); }
        break;
        }
      }
      if (getActiveWidgetTarget?.()) break; // Suppress tool pills when response is in widget
      showToolPill(msg.name, msg.args);
      break;
    case 'tool_progress':
      if (typeof handleDocumentChatToolProgress === 'function' && handleDocumentChatToolProgress(msg.agent, msg.name, msg.text, msg.documentRequest)) break;
      if (msg.documentTurn && typeof handleRemoteDocumentToolProgress === 'function'
          && handleRemoteDocumentToolProgress(msg.agent, msg.documentRequest)) break;
      {
        const state = agentStreams[msg.agent];
        const callId = msg.toolCallId || msg.tool_call_id || msg.callId || null;
        const target = state && [...state.toolEvents].reverse().find(ev =>
          ev.status !== 'done' && (callId ? ev.callId === callId : ev.name === msg.name));
        if (target) target.progressPreview = String(msg.text || '').slice(-1200);
      }
      if (msg.agent !== activeAgent) break;
      if (getActiveWidgetTarget?.()) break;
      appendToolPillProgress(msg.name, msg.text);
      break;
    case 'tool_result':
      if (typeof handleDocumentChatToolResult === 'function' && handleDocumentChatToolResult(msg.agent, msg.name, msg.text, msg.documentRequest)) break;
      if (msg.documentTurn && typeof handleRemoteDocumentToolResult === 'function'
          && handleRemoteDocumentToolResult(msg.agent, msg.documentRequest, msg.documentArtifact)) break;
      {
        const evs = agentStreams[msg.agent]?.toolEvents;
        const callId = msg.toolCallId || msg.tool_call_id || msg.callId || null;
        if (evs) {
          for (let i = evs.length - 1; i >= 0; i--) {
            const ev = evs[i];
            if (ev.status !== 'done' && (callId ? ev.callId === callId : ev.name === msg.name)) {
              ev.status = 'done';
              ev.endedAt = Date.now();
              ev.durationMs = ev.startedAt ? ev.endedAt - ev.startedAt : null;
              ev.preview = msg.preview || '';
              ev.text = msg.text || '';
              break;
            }
          }
        }
      }
      if (msg.agent !== activeAgent) {
        break;
      }
      updateToolPill(msg.name, msg.preview, msg.text);
      break;
    case 'credential_prompt':
      {
        const target = credentialPromptAgent(msg);
        if (target && msg.credentialId) credentialPromptMap(target).set(msg.credentialId, { ...msg, agent: target });
        if (target === activeAgent && typeof appendCredentialPromptBubble === 'function') {
        appendCredentialPromptBubble(msg.credentialId, msg.label, msg.description, msg.kind);
        }
      }
      break;
    case 'credential_resolved':
      {
        const targets = msg.agent
          ? [credentialPromptAgent(msg)]
          : Object.entries(agentCredentialPrompts)
              .filter(([, prompts]) => prompts?.has(msg.credentialId))
              .map(([agent]) => agent);
        for (const target of targets) {
          if (target && msg.credentialId) credentialPromptMap(target).delete(msg.credentialId);
        }
        if ((!targets.length || targets.includes(activeAgent)) && typeof resolveCredentialBubble === 'function') {
        resolveCredentialBubble(msg.credentialId, msg.cancelled === true);
        }
      }
      break;
    case 'credential_error':
      {
        const target = credentialPromptAgent(msg);
        if ((!msg.agent || target === activeAgent) && typeof markCredentialBubbleError === 'function') {
        markCredentialBubbleError(msg.credentialId, msg.error);
        }
      }
      break;
    case 'replace':
      if (typeof handleDocumentChatReplace === 'function' && handleDocumentChatReplace(msg.agent, msg.text, msg.documentRequest)) break;
      {
        const state = agentStreams[msg.agent] || (agentStreams[msg.agent] = freshAgentTurnState(msg.agent, msg));
        state.buf = msg.text || '';
        state.active = true;
      }
      if (msg.agent !== activeAgent) {
        break;
      }
      if (typeof widgetStreamReplace === 'function' && widgetStreamReplace(msg.text)) break;
      if (streamEl) {
        if (!msg.text) {
          if (streamBuf.trim()) {
            // Commit streamed text as a finished bubble rather than erasing it
            applyMarkdown(streamEl, streamBuf);
            streamEl = null;
          } else {
            streamEl.closest('.msg')?.remove();
            streamEl = null;
          }
        } else {
          streamBuf = msg.text;
          applyMarkdown(streamEl, streamBuf);
          scrollToBottom();
        }
      }
      break;
    case 'document_response':
      if (typeof handleDocumentChatReplace === 'function' && handleDocumentChatReplace(msg.agent, msg.text, msg.documentRequest)) break;
      if (msg.documentTurn && typeof handleRemoteDocumentResponse === 'function'
          && handleRemoteDocumentResponse(msg.agent, msg.text, msg.documentRequest)) break;
      if (msg.text) {
        if (!sessions[msg.agent]) sessions[msg.agent] = [];
        const row = {
          role: 'assistant', content: msg.text, ts: Date.now(),
          ...(msg.turn_id ? { turnId: msg.turn_id } : {}),
          ...(msg.message_id ? { messageId: msg.message_id } : {}),
          ...(msg.attempt_id ? { attemptId: msg.attempt_id } : {}),
          ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}),
        };
        if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[msg.agent], row))) sessions[msg.agent].push(row);
        if (msg.agent === activeAgent) appendAssistantBubble(msg.text, row.ts, true);
      }
      break;
    case 'assistant_notification': {
      // A buffered background completion is independent of the foreground
      // turn stream. Cache it without touching streamEl; the stable ids match
      // the already-durable session row and suppress live/reload duplicates.
      const target = clientSessionAgentId(msg.agent || activeAgent);
      if (!target || !msg.content) break;
      if (!sessions[target]) sessions[target] = [];
      const row = {
        role: msg.role === 'notification' ? 'notification' : 'assistant',
        content: msg.content, ts: msg.ts || Date.now(),
        ...(msg.from ? { from: msg.from } : {}),
        turnId: msg.turn_id || msg.notification_id || null,
        attemptId: msg.attempt_id || msg.turn_id || msg.notification_id || null,
        reportId: msg.reportId || null,
        taskId: msg.taskId || null,
        backgroundTaskId: msg.taskId || null,
        status: msg.status || 'done', asyncNotification: true,
        ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}),
      };
      if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[target], row))) {
        sessions[target].push(row);
      }
      const foregroundActive = Boolean(agentStreams[target]?.active || (target === activeAgent && streamEl));
      if (target === activeAgent && !foregroundActive) renderSession();
      else if (target === activeAgent) showToast('Background work finished.');
      else {
        const label = agents.find(agent => agent.id === target)?.name || 'Assistant';
        showToast(`${label} finished background work.`);
      }
      buildTabs(); buildAgentDrawer();
      break;
    }
    case 'perf':
      if (msg.agent !== activeAgent) break;
      if (streamEl) {
        const parts = [];
        if (msg.tps   != null) parts.push(`${parseFloat(msg.tps).toFixed(1)} tok/s`);
        if (msg.ttft  != null) parts.push(`${Math.round(msg.ttft)}ms to first token`);
        if (msg.tokens != null) parts.push(`${msg.tokens} tokens`);
        if (parts.length) {
          const bar = document.createElement('div');
          bar.className = 'perf-bar';
          bar.textContent = parts.join(' · ');
          streamEl.closest('.msg')?.appendChild(bar);
        }
      }
      break;
    case 'hide_turn':
      // Phase-14: server tells us this assistant turn's bubble should NOT
      // render — the task_proxy chip IS the user-visible reply. Drop the
      // in-flight streamEl from the chat and clear the buffer so the
      // subsequent 'done' doesn't persist the redundant text.
      if (agentStreams[msg.agent]) {
        agentStreams[msg.agent].hidden = true;
        agentStreams[msg.agent].buf = '';
      }
      if (msg.agent !== activeAgent) break;
      if (streamEl) {
        try { streamEl.closest('.msg')?.remove(); } catch {}
      }
      streamEl = null; streamBuf = ''; resetToolRun(true);
      setTyping(false);
      break;
    case 'done':
      {
      const finishingState = agentStreams[msg.agent] || null;
      if (typeof acceptPendingAttempt === 'function') acceptPendingAttempt(msg.attempt_id || msg.turn_id);
      if (msg.agent && (msg.attempt_id || msg.turn_id)) requestAgentSession(msg.agent);
      if (lastSentAttempt && (lastSentAttempt.attemptId === (msg.attempt_id || msg.turn_id))) lastSentAttempt = null;
      if (typeof finishDocumentChatTurn === 'function' && finishDocumentChatTurn(msg.agent, msg.documentRequest)) {
        finishDocumentStreamUi(msg.agent);
        if (msg.turn_id) terminalTurnIds[msg.agent] = msg.turn_id;
        delete agentStreams[msg.agent];
        buildTabs(); buildAgentDrawer();
        break;
      }
      if (msg.documentTurn && typeof finishRemoteDocumentTurns === 'function'
          && finishRemoteDocumentTurns(msg.agent, msg.documentRequest)) {
        finishDocumentStreamUi(msg.agent);
        delete agentStreams[msg.agent];
        reloadDocumentSession(msg.agent);
        buildTabs(); buildAgentDrawer();
        break;
      }
      if (msg.documentTurn && msg.documentRequest?.requestId) {
        // A reconnect can miss the mutation result but receive the terminal.
        // Persistence happens before done, so an authoritative reload restores
        // the artifact rather than leaving the completed edit invisible.
        finishDocumentStreamUi(msg.agent);
        delete agentStreams[msg.agent];
        reloadDocumentSession(msg.agent);
        buildTabs(); buildAgentDrawer();
        break;
      }
      if (msg.agent !== activeAgent) {
        // If this agent's reply was streaming into a tutor widget when the user
        // switched away, finalize that buffer here — otherwise the target stays
        // armed and silently swallows the next active-agent reply.
        if (typeof getActiveWidgetTargetAgent === 'function' && getActiveWidgetTargetAgent() === msg.agent) {
          const wbuf = widgetStreamFinish();
          if (wbuf && !finishingState?.needsResync) {
            if (!sessions[msg.agent]) sessions[msg.agent] = [];
            sessions[msg.agent].push({ role: 'assistant', content: wbuf, ts: Date.now(), hidden: true, ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}) });
          }
        }
        // Background agent finished — save to session, clear stream state.
        // Buffered tool events ride along (parity with the foreground commit
        // below) so the finished turn's tool activity survives a later
        // switch/re-render instead of being dropped with the buffer.
        const bg = agentStreams[msg.agent];
        if (bg?.buf && !bg.needsResync) {
          if (!sessions[msg.agent]) sessions[msg.agent] = [];
          const bgToolEvents = (bg.toolEvents || []).map(ev => ({
            ...ev,
            args: ev.args && typeof scrubToolArgsForSession === 'function' ? scrubToolArgsForSession(ev.args) : (ev.args ?? null),
            status: ev.status || 'done',
            text: ev.text ? String(ev.text).slice(0, 10000) : '',
          }));
          sessions[msg.agent].push({
            role: 'assistant', content: bg.buf, ts: Date.now(),
            ...(bg.turnId ? { turnId: bg.turnId } : {}),
            ...(bg.messageId ? { messageId: bg.messageId } : {}),
            ...(bg.attemptId ? { attemptId: bg.attemptId } : {}),
            ...(bgToolEvents.length ? { toolEvents: bgToolEvents } : {}),
            ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}),
          });
        }
        delete agentStreams[msg.agent];
        buildTabs(); buildAgentDrawer();
        break;
      }
      // Foreground turn completed successfully — forget the in-flight attempt so
      // a later stray error can't attach a Retry to an already-answered message.
      if (lastSentAttempt?.agent === msg.agent
          && (!msg.turn_id || lastSentAttempt.attemptId === msg.turn_id)) lastSentAttempt = null;
      // If response was routed to a widget, save as hidden and clear
      if (typeof getActiveWidgetTarget === 'function' && getActiveWidgetTarget() && msg.agent === activeAgent) {
        const finalBuf = widgetStreamFinish();
        if (finalBuf && !finishingState?.needsResync) {
          if (!sessions[msg.agent]) sessions[msg.agent] = [];
          const state = agentStreams[msg.agent];
          sessions[msg.agent].push({ role: 'assistant', content: finalBuf, ts: Date.now(), hidden: true, toolEvents: currentLiveToolEvents(), ...(state?.turnId ? { turnId: state.turnId } : {}), ...(state?.messageId ? { messageId: state.messageId } : {}), ...(state?.attemptId ? { attemptId: state.attemptId } : {}), ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}) });
        }
        streamEl = null; streamBuf = ''; resetToolRun();
        setStreaming(false);
        break;
      }
      flushStreamRender();
      if (finishingState?.needsResync && streamEl) {
        try { streamEl.closest('.msg')?.remove(); } catch {}
      } else if (streamEl && streamBuf) {
        if (!sessions[msg.agent]) sessions[msg.agent] = [];
        const state = agentStreams[msg.agent];
        updateToolRunHeader(liveToolRun, true);
        sessions[msg.agent].push({ role: 'assistant', content: streamBuf, ts: Date.now(), toolEvents: currentLiveToolEvents(), ...(state?.turnId ? { turnId: state.turnId } : {}), ...(state?.messageId ? { messageId: state.messageId } : {}), ...(state?.attemptId ? { attemptId: state.attemptId } : {}), ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}) });
        addTimestamp(streamEl.closest('.msg'));
        if (msg.agent === activeAgent) updateSessionWarning();
      } else if (liveToolRun?.events?.length) {
        updateToolRunHeader(liveToolRun, true);
      }
      streamEl = null; streamBuf = ''; resetToolRun();
      awaitingPermission = false;
      setStreaming(false); setTyping(false);
      if (msg.turn_id) terminalTurnIds[msg.agent] = msg.turn_id;
      delete agentStreams[msg.agent];
      if (agents.find(a => a.skillCategory === 'expenses')?.id === msg.agent && $('drawerExpenses')?.classList.contains('open')) loadExpTxns();
      break;
      }
    case 'image': {
      const target = clientSessionAgentId(msg.agent);
      if (target !== activeAgent) break;
      setTyping(false);
      appendImageBubble({ base64: msg.base64, mimeType: msg.mimeType, filename: msg.filename, savedPath: msg.savedPath }, Date.now());
      if (!sessions[target]) sessions[target] = [];
      sessions[target].push({ role: 'assistant', image: { base64: msg.base64, mimeType: msg.mimeType, filename: msg.filename, savedPath: msg.savedPath }, content: `[Image: ${msg.filename}]`, ts: Date.now(), ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}) });
      break;
    }
    case 'video': {
      const target = clientSessionAgentId(msg.agent);
      if (target !== activeAgent) break;
      setTyping(false);
      appendVideoBubble({ url: msg.url, filename: msg.filename, savedPath: msg.savedPath }, Date.now());
      if (!sessions[target]) sessions[target] = [];
      sessions[target].push({ role: 'assistant', video: { url: msg.url, filename: msg.filename, savedPath: msg.savedPath }, content: `[Video: ${msg.filename}]`, ts: Date.now(), ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}) });
      break;
    }
    case 'error':
      // Server-side auth rejection on the WS handshake — clear the stale
      // token and bail. Without this, ws.onclose's reconnect loop would keep
      // re-auth'ing with the same bad token and spawning a chat bubble per
      // attempt.
      if (msg.message === 'Unauthorized') {
        setToken(null);
        // Null the user so ws.onclose stops reconnecting — otherwise each
        // reconnect re-auths, gets Unauthorized, and re-shows the login screen
        // (re-fetching users + wiping any half-typed password) every 1–15s.
        _currentUser = null;
        showLoginScreen();
        break;
      }
      const intentionalStop = typeof isIntentionalTurnStop === 'function'
        && isIntentionalTurnStop(msg);
      if (typeof pendingAttemptForId === 'function') {
        const attemptId = msg.attempt_id || msg.turn_id;
        msg._clientAttempt = pendingAttemptForId(attemptId);
        if (msg._clientAttempt) {
          msg._clientAttempt.lastError = { retryable: msg.retryable === true, code: msg.code || null };
          if (msg._clientAttempt.accepted) acceptPendingAttempt(attemptId);
          if (msg.agent) requestAgentSession(msg.agent);
        }
      }
      const documentTurnHandled = intentionalStop
        ? (typeof cancelDocumentChatTurn === 'function'
          && cancelDocumentChatTurn(msg.agent || activeAgent, 'Stopped', msg.documentRequest))
        : (typeof failDocumentChatTurn === 'function'
          && failDocumentChatTurn(msg.agent || activeAgent, msg.message, msg.documentRequest));
      if (documentTurnHandled) {
        if (!msg.agent || msg.agent === activeAgent) {
          flushStreamRender();
          if (streamEl) streamEl.closest('.msg')?.remove();
          streamEl = null; streamBuf = '';
          resetToolRun(true);
          setStreaming(false); setTyping(false);
        }
        break;
      }
      const remoteDocumentTurnHandled = msg.documentTurn && (intentionalStop
        ? (typeof cancelRemoteDocumentTurns === 'function'
          && cancelRemoteDocumentTurns(msg.agent || activeAgent, 'Stopped', msg.documentRequest))
        : (typeof failRemoteDocumentTurns === 'function'
          && failRemoteDocumentTurns(msg.agent || activeAgent, msg.documentRequest)));
      if (remoteDocumentTurnHandled) {
        finishDocumentStreamUi(msg.agent || activeAgent);
        break;
      }
      if (msg.agent) {
        const state = agentStreams[msg.agent] || freshAgentTurnState(msg.agent, msg);
        state.active = false;
        state.phase = intentionalStop ? 'stopped' : 'failed';
        state.error = intentionalStop ? null : msg.message;
        agentStreams[msg.agent] = state;
        if (state.needsResync) requestAgentSession(msg.agent);
        if (msg.turn_id) terminalTurnIds[msg.agent] = msg.turn_id;
        if (!sessions[msg.agent]) sessions[msg.agent] = [];
        const errorRow = {
          role: 'turn_error', content: msg.message, error: msg.message,
          status: msg.status || (intentionalStop ? 'stopped' : 'failed'),
          retryable: msg.retryable === true, code: msg.code || 'turn_failed',
          assistantPartial: state.needsResync ? '' : (state.buf || (msg.agent === activeAgent ? streamBuf : '')),
          ts: Date.now(),
          ...(state.turnId ? { turnId: state.turnId } : {}),
          ...(state.messageId ? { messageId: state.messageId } : {}),
          ...(state.attemptId ? { attemptId: state.attemptId } : {}),
          ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}),
        };
        if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[msg.agent], errorRow))) {
          sessions[msg.agent].push(errorRow);
        }
        buildTabs(); buildAgentDrawer();
      }
      if (msg.agent && msg.agent !== activeAgent) break;
      // Finalize any partial stream so the NEXT reply gets a fresh bubble —
      // without this, its tokens concatenate onto the aborted reply's buffer.
      // The partial text stays visible; the server has already persisted a
      // terminal turn_error row before emitting this event.
      flushStreamRender();
      if (agentStreams[msg.agent]?.needsResync && streamEl) {
        try { streamEl.closest('.msg')?.remove(); } catch {}
      }
      streamEl = null; streamBuf = ''; resetToolRun();
      setStreaming(false); setTyping(false); showTurnError(msg.message, msg); break;
    case 'proposal':
      // Friction-tracker proposal — actionable repeat detected, two-button
      // bubble offering to set up the suggested automation. Persisted to
      // the agent's session jsonl so it survives reload.
      if (!msg.agent || msg.agent === activeAgent) {
        appendProposalBubble(msg);
      }
      if (msg.agent) {
        const target = clientSessionAgentId(msg.agent);
        if (!sessions[target]) sessions[target] = [];
        const row = { ...msg, type: undefined, role: 'proposal', ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}) };
        delete row.type;
        if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[target], row))) sessions[target].push(row);
      }
      break;
    case 'proposal_outcome':
      // Server pushes this when an accepted proposal's agent run completes
      // (success or retry-exhausted failure), or when dismiss persists.
      // The bubble mutates in place via applyProposalOutcome — no reload
      // needed. Status flow: pending → running → accepted | failed | dismissed.
      if (!msg.agent || msg.agent === activeAgent) {
        applyProposalOutcome(msg.proposalId, msg.status, msg.outcome);
      }
      if (msg.agent) {
        const target = clientSessionAgentId(msg.agent);
        if (!sessions[target]) sessions[target] = [];
        const row = { role: 'proposal_outcome', proposalId: msg.proposalId, status: msg.status, outcome: msg.outcome, ts: msg.ts || Date.now(), ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}) };
        if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[target], row))) sessions[target].push(row);
      }
      break;
    case 'approval_pending':
      // Post-turn pending-approval pill (see chat-dispatch.mjs
      // snapshotPendingApprovals). A destructive op staged behind a typed
      // confirmation phrase (APPROVE PURGE / CONFIRM DELETION / APPROVE
      // PROVEN / APPROVE WATCHER OP) — renders Approve/Cancel buttons that
      // send a normal chat message, reusing the existing text intercept
      // unchanged. Persisted to session jsonl so it survives reload.
      {
        const approvalAgent = clientSessionAgentId(msg.agent || activeAgent);
        if (!approvalAgent) break;
        if (!sessions[approvalAgent]) sessions[approvalAgent] = [];
        const row = {
          role: 'approval_pending', kind: msg.kind,
          phrase: msg.phrase, description: msg.description,
          expiresAt: msg.expiresAt ?? null, opId: msg.opId ?? null,
          ts: msg.ts ?? Date.now(),
          ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}),
        };
        if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[approvalAgent], row))) {
          sessions[approvalAgent].push(row);
        }
        if (approvalAgent === activeAgent) {
          appendApprovalPendingBubble(msg);
        }
      }
      break;
    case 'approval_resolved':
      // Server pushes this once the staged op is gone (approved-and-executed,
      // or cleared by "say anything else to cancel") — mutates the matching
      // pill in place rather than a fresh reload-only clear.
      {
        const approvalAgent = clientSessionAgentId(msg.agent || activeAgent);
        if (!approvalAgent) break;
        if (!sessions[approvalAgent]) sessions[approvalAgent] = [];
        const row = {
          role: 'approval_resolved', kind: msg.kind,
          opId: msg.opId ?? null, ts: msg.ts ?? Date.now(),
          ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}),
        };
        if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[approvalAgent], row))) {
          sessions[approvalAgent].push(row);
        }
        if (approvalAgent === activeAgent) {
          applyApprovalResolved(msg.kind, msg.opId ?? null, msg.ts ?? null);
        }
      }
      break;
    case 'session_cleared': {
      const agent = clientSessionAgentId(msg.agent);
      if (msg.sessionEpoch) agentSessionEpochs[agent] = msg.sessionEpoch;
      sessions[agent] = [];
      sessionsLoaded.add(agent);
      delete agentStreams[agent];
      delete terminalTurnIds[agent];
      credentialPromptMap(agent).clear();
      if (typeof clearPendingAttemptsForAgent === 'function') clearPendingAttemptsForAgent(agent);
      if (lastSentAttempt?.agent === agent) lastSentAttempt = null;
      if (failedAttempt?.agent === agent) failedAttempt = null;
      if (agent === activeAgent) {
        streamEl = null; streamBuf = ''; resetToolRun(true);
        awaitingPermission = false;
        setStreaming(false); setTyping(false);
        renderSession();
        updateSessionWarning();
      }
      buildTabs(); buildAgentDrawer();
      break;
    }
    case 'stop_ignored': {
      const agent = clientSessionAgentId(msg.agent);
      if (msg.requested_turn_id && sessions[agent]) {
        sessions[agent] = sessions[agent].filter(row => !(
          row?.role === 'turn_error' && row?.status === 'stopped'
          && (row.turnId === msg.requested_turn_id || row.attemptId === msg.requested_turn_id)
        ));
      }
      if (msg.activeStream) mergeActiveStreamSnapshot(agent, msg.activeStream, agentSessionEpochs[agent] ?? null);
      if (agent === activeAgent) {
        renderSession();
        projectAgentStreamState(agent);
        showToast(msg.activeStream
          ? 'That reply was already replaced by a newer turn; the newer turn is still running.'
          : 'That reply had already finished.');
      }
      buildTabs(); buildAgentDrawer();
      break;
    }
    case 'attachment_decision':
      // Post-turn save/discard prompt for a chat-upload. Renders Keep/Discard
      // buttons; the file is already on disk so 'keep' is a no-op and
      // 'discard' deletes via /api/chat-attachment-decision. Persisted to
      // session jsonl so reload preserves the choice.
      {
        const target = clientSessionAgentId(msg.agent || activeAgent);
        if (!sessions[target]) sessions[target] = [];
        const row = {
          role: 'attachment_decision', decisionId: msg.decisionId,
          file_id: msg.file_id, name: msg.name, mimeType: msg.mimeType, ts: msg.ts,
          ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}),
        };
        if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[target], row))) sessions[target].push(row);
        if (target === activeAgent) appendAttachmentDecisionBubble(msg);
      }
      break;
    case 'attachment_decision_outcome':
      // Fan-out from another tab (or this tab's click). Mutate the bubble
      // in place to the resolved state.
      {
        const target = clientSessionAgentId(msg.agent || activeAgent);
        if (!sessions[target]) sessions[target] = [];
        const row = { role: 'attachment_decision_outcome', decisionId: msg.decisionId, decision: msg.decision, ts: msg.ts, ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}) };
        if (!(typeof sessionHasEquivalent === 'function' && sessionHasEquivalent(sessions[target], row))) sessions[target].push(row);
        if (target === activeAgent) applyAttachmentDecisionOutcome(msg.decisionId, msg.decision);
      }
      break;
    case 'status':
      // Watcher supervisor pushes these — muted/italic bubble outside any
      // agent assistant turn. One bubble per watcherId, updated in place.
      // Session history is also deduped: we replace the existing entry for
      // this watcher rather than appending, so a page reload renders one
      // bubble instead of N stacked ones.
      //
      // Agent-match: msg.agent often arrives in scoped form ("user_X_coordinator")
      // while activeAgent is the raw id ("coordinator"). Compare both forms so
      // live updates land in the right tab regardless of which side scoped.
      {
        const agentKey = clientSessionAgentId(msg.agent);
        const matches = !msg.agent || msg.agent === activeAgent || agentKey === activeAgent;
        if (matches) {
          appendStatusBubble({ text: msg.text, label: msg.label, kind: msg.kind, watcherId: msg.watcherId, final: msg.final, finalStatus: msg.finalStatus, awaiting_input: msg.awaiting_input, pending_question: msg.pending_question, state: msg.state, recentHistory: msg.recentHistory }, msg.ts || Date.now());
        }
      }
      if (msg.agent) {
        const agentKey = clientSessionAgentId(msg.agent);
        if (!sessions[agentKey]) sessions[agentKey] = [];
        const statusEntry = { role: 'status', status: { text: msg.text, label: msg.label, kind: msg.kind, watcherId: msg.watcherId, final: msg.final, finalStatus: msg.finalStatus, awaiting_input: msg.awaiting_input, pending_question: msg.pending_question, state: msg.state, recentHistory: msg.recentHistory }, content: `[Status: ${msg.text}]`, ts: msg.ts || Date.now(), ...(Number.isFinite(msg.chat_revision) ? { _liveRevision: msg.chat_revision } : {}) };
        const arr = sessions[agentKey];
        const existingIdx = msg.watcherId
          ? arr.findIndex(m => m.role === 'status' && m.status?.watcherId === msg.watcherId)
          : -1;
        if (existingIdx >= 0) arr[existingIdx] = statusEntry;
        else arr.push(statusEntry);
      }
      // Refresh the tasks drawer so its watcher rows stay current. Debounced
      // — this fires per progress push; final transitions refresh immediately.
      if (typeof loadTaskListSoon === 'function') loadTaskListSoon({ immediate: !!msg.final });
      else if (typeof loadTaskList === 'function') loadTaskList();
      break;
    case 'memory_stored':
    case 'memory_forgotten': {
      if (msg.agent !== activeAgent) break;
      const bubbles = $('messages').querySelectorAll('.msg.assistant');
      if (bubbles.length) {
        const last = bubbles[bubbles.length - 1];
        const isForget = msg.type === 'memory_forgotten';
        last.classList.add(isForget ? 'memory-forgotten' : 'memory-stored');
        const badge = document.createElement('div');
        badge.className = isForget ? 'memory-badge memory-badge-forgotten' : 'memory-badge';
        badge.textContent = isForget ? '✦ memory forgotten' : '✦ saved to memory';
        last.appendChild(badge);
      }
      break;
    }
    case 'agent_list':
      // The roster broadcast carries the normalized STORED policy so picker
      // visibility updates for switches made in chat or another browser. Do
      // not infer mode from roster length: one-agent ensembles are valid.
      if (_currentUser && msg.orchestration && typeof msg.orchestration === 'object') {
        _currentUser.orchestration = msg.orchestration;
      }
      agents = msg.agents;
      if (agents.length > 0 && !agents.find(a => a.id === activeAgent)) {
        activeAgent = agents[0].id;
        if (!(activeAgent in sessions)) {
          sessions[activeAgent] = [];
          requestAgentSession(activeAgent);
        }
        renderSession();
      } else if (agents.length === 0) {
        activeAgent = null;
      }
      buildTabs();
      buildAgentDrawer();
      if (typeof renderToolPlanPicker === 'function') renderToolPlanPicker();
      // Keep Settings' per-agent model rows in sync if the panel is rendered
      if (document.getElementById('agentModelRows') && typeof renderAgentModelRows === 'function') {
        renderAgentModelRows();
      }
      const refreshPendingPolicy = _currentUser?.orchestration?.pendingPrimary === true
        && typeof loadOrchestrationSettings === 'function';
      if (refreshPendingPolicy) {
        loadOrchestrationSettings().then(() => {
          if (typeof checkEmptyState === 'function') checkEmptyState();
        });
      }
      // Mode changes can originate in chat or another browser. Keep an open
      // Settings surface synchronized with the roster broadcast instead of
      // leaving its mode/primary controls stale until the drawer is reopened.
      if (document.getElementById('drawerSettings')?.classList.contains('open')) {
        if (document.getElementById('stab-panel-agents')?.classList.contains('active')
            && typeof loadOrchestrationSettings === 'function'
            && !refreshPendingPolicy) {
          loadOrchestrationSettings();
        }
        if (document.getElementById('stab-panel-users')?.classList.contains('active')
            && typeof loadUserManagement === 'function') {
          loadUserManagement();
        }
      }
      updateSessionWarning();
      break;
    case 'task_complete':
      handleTaskComplete(msg); break;
    case 'task_created':
      if (typeof loadTaskList === 'function') loadTaskList();
      break;
    case 'doc_changed':
      if (typeof handleDocChanged === 'function') handleDocChanged(msg);
      break;
    case 'news_pref_saved':
      if (typeof msg.topic === 'number') {
        newsTopic = msg.topic;
        const p = drawers.find(pl => pl.id === 'news');
        if (p?.settings) { p.settings.defaultTopic = msg.topic; renderDrawersSettings(); }
      }
      break;
    case 'new_thread_message':
      if (typeof handleNewThreadMessage === 'function') handleNewThreadMessage(msg);
      break;
    case 'reminder':
      showReminder(msg);
      addBoardReminder(msg);
      break;
    case 'tutor_nudge':
      if (typeof showTutorNudge === 'function') showTutorNudge(msg);
      break;
    case 'tutor_celebration':
      if (typeof showCelebration === 'function') showCelebration(msg);
      break;
    case 'agent_notification':
      appendNotification(msg);
      // Profile health notifications also bump the nodes drawer's alert dot
      // so the badge appears immediately, not on the next 15s refresh.
      if (msg.event === 'profile_health_unhealthy' || msg.event === 'profile_health_action' || msg.event === 'profile_health_recovered') {
        if (typeof loadNodes === 'function') loadNodes();
      }
      break;
    case 'agent_report':
      if (typeof handleAgentReport === 'function') handleAgentReport(msg);
      break;
    case 'node_health':
      if (typeof window._nodeHealthHandler === 'function') window._nodeHealthHandler(msg);
      break;
    case 'admission_request':
    case 'admission_resolved':
      // Device join-request queue (owner/admin only — see public/nodes.js).
      if (typeof window._nodeAdmissionHandler === 'function') window._nodeAdmissionHandler(msg);
      break;
    case 'session_expired':
      // Server clears the cookie via Set-Cookie on the next API hit; nothing
      // to do client-side beyond returning the user to the login screen.
      // Null the user first so ws.onclose stops the reconnect loop (which would
      // otherwise re-show the login screen and reset the selection every 1–15s).
      _currentUser = null;
      showToast('Your session has expired. Please sign in again.');
      showLoginScreen();
      break;
    case 'update_available':
      if (typeof _updateState === 'object') {
        _updateState = { ..._updateState, available: true, currentSha: msg.currentSha, remoteSha: msg.remoteSha };
        if (typeof renderUpdateRow === 'function') renderUpdateRow();
      }
      if (typeof refreshUpdateBadge === 'function') refreshUpdateBadge();
      // Toast once per remoteSha so we don't re-spam on reconnect.
      if (window._lastUpdateToastSha !== msg.remoteSha) {
        window._lastUpdateToastSha = msg.remoteSha;
        showToast('Update available — open Settings → System to install', 6000);
      }
      break;
    case 'update_applying':
      if (msg.stage === 'restarting' && typeof _waitForServerBack === 'function') _waitForServerBack();
      else if (msg.stage === 'npm_install') showToast('Installing dependencies…', 4000);
      break;
    case 'update_failed':
      showToast('Update failed: ' + (msg.message || msg.code), 8000);
      if (typeof loadUpdateStatus === 'function') loadUpdateStatus();
      break;
    case 'ota_progress':
      // Voice-device firmware OTA status. Hand to devices.js if Settings →
      // Voice devices is open so it can update the in-place progress row.
      if (typeof window._handleOtaProgress === 'function') window._handleOtaProgress(msg);
      break;
    case 'cortex_warning':
      // Surfaced by lib/runtime-warn.mjs after 3 consecutive failures from a
      // local reason/plan runtime. Most common case: LM Studio's JIT loading
      // is off so reason calls 404 silently. Toast is rate-limited server-side.
      showToast(msg.message || 'Cortex runtime issue', 8000);
      break;
    case 'active_streams': {
      // Authoritative reconnect snapshot: full text/tool/permission state plus
      // per-turn seq. Remove stale local busy flags absent from the server.
      const activeIds = new Set((msg.agents ?? []).map(a => a.agentId));
      if (typeof reconcileDocumentChatTurns === 'function') reconcileDocumentChatTurns(activeIds);
      for (const snapshot of (msg.agents ?? [])) {
        mergeActiveStreamSnapshot(snapshot.agentId, snapshot, agentSessionEpochs[snapshot.agentId] ?? null);
      }
      for (const [agentId, state] of Object.entries(agentStreams)) {
        if (!state?.active || activeIds.has(agentId)) continue;
        const snapshotRevision = Number(msg.snapshotRevisions?.[agentId]) || 0;
        // A state accepted after this snapshot's watermark is newer than the
        // absence claim and must survive until a later authoritative snapshot.
        if ((state.liveRevision || 0) <= snapshotRevision) delete agentStreams[agentId];
      }
      const taskSnapshotChanged = reconcileActiveBackgroundTasks(msg.tasks);
      if (taskSnapshotChanged) renderSession();
      projectAgentStreamState(activeAgent);
      buildTabs();
      buildAgentDrawer();
      break;
    }
  }
}
