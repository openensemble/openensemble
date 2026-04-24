// ── WebSocket ─────────────────────────────────────────────────────────────────
let _reconnectDelay = 1000;
let _pingTimer = null;

function connect() {
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
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen  = () => {
    // Authenticate via first message instead of URL query string
    ws.send(JSON.stringify({ type: 'auth', token: getToken() ?? '' }));
    // Safety net: explicitly request history for the currently active agent.
    // The server also sends a session_loaded burst for every agent after auth,
    // but on mobile (iOS PWA / backgrounded tab) that burst is easy to miss —
    // so we always re-fetch for the active agent on every successful connect.
    if (activeAgent) {
      ws.send(JSON.stringify({ type: 'load_session', agent: activeAgent }));
    }
    _reconnectDelay = 1000; if (!streaming) setStatus('online'); schedulePing();
  };
  ws.onclose = () => {
    clearTimeout(_pingTimer);
    setStatus('offline');
    const delay = _reconnectDelay;
    _reconnectDelay = Math.min(_reconnectDelay * 1.5, 15000);
    setTimeout(() => { if (getToken()) connect(); }, delay);
  };
  ws.onerror = () => {};
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
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
  // Commit any in-progress stream to the session before reconnecting,
  // so it survives the session_loaded overwrite from the server.
  const wasStreaming = streaming;
  if (streamEl && streamBuf && activeAgent) {
    if (!sessions[activeAgent]) sessions[activeAgent] = [];
    sessions[activeAgent].push({ role: 'assistant', content: streamBuf, ts: Date.now() });
  }
  streamEl = null; streamBuf = ''; toolPillsEl = null;
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
  if (getToken()) connect();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // On desktop, the WS usually stays alive across tab switches — only
    // reconnect if it's actually dead.  Send a ping to verify; if it fails
    // or the socket is already closed, then force-reconnect.
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch { forceReconnect(); }
      schedulePing();                   // reset the keep-alive timer
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

// ── Server messages ───────────────────────────────────────────────────────────
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'pong': break;
    case 'session_loaded': {
      const serverMsgs = msg.messages ?? [];
      const clientMsgs = sessions[msg.agent] ?? [];
      // Merge: use server data as the authoritative base, but preserve any
      // client-only messages that haven't been persisted yet (e.g. a user
      // message sent just before the WS dropped, or a streamed reply that
      // was committed to sessions by forceReconnect).
      if (clientMsgs.length > 0 && serverMsgs.length >= 0) {
        const lastServerTs = serverMsgs.length > 0
          ? Math.max(...serverMsgs.map(m => m.ts || 0))
          : 0;
        const clientOnly = clientMsgs.filter(m => (m.ts || 0) > lastServerTs);
        sessions[msg.agent] = clientOnly.length > 0
          ? [...serverMsgs, ...clientOnly]
          : serverMsgs;
      } else {
        sessions[msg.agent] = serverMsgs;
      }
      // If the server has a partial stream buffer (tab closed mid-stream),
      // append it so the user sees what was captured before disconnect.
      if (msg.pendingStream?.content) {
        const already = sessions[msg.agent].some(m =>
          m.role === 'assistant' && m.ts === msg.pendingStream.ts);
        if (!already) {
          sessions[msg.agent].push({
            role: 'assistant',
            content: msg.pendingStream.content,
            ts: msg.pendingStream.ts,
            partial: true,
          });
        }
      }
      if (msg.agent === activeAgent) renderSession();
      break;
    }
    case 'token':
      if (msg.agent !== activeAgent) {
        // Buffer tokens for background agents
        const isNew = !agentStreams[msg.agent];
        if (isNew) agentStreams[msg.agent] = { buf: '', toolNames: [], active: true };
        agentStreams[msg.agent].buf += msg.text;
        agentStreams[msg.agent].active = true;
        if (isNew) { buildTabs(); buildAgentDrawer(); }
        break;
      }
      // Route to widget if active
      if (typeof widgetStreamAppend === 'function' && widgetStreamAppend(msg.text)) {
        setTyping(false);
        break;
      }
      if (!streamEl) { streamBuf = ''; streamEl = appendStreamingBubble(); setTyping(false); }
      streamBuf += msg.text;
      if (streamEl) { streamEl.innerHTML = renderMarkdown(streamBuf); scrollToBottom(); }
      break;
    case 'permission_request':
      if (msg.agent !== activeAgent) break;
      // Commit any in-progress stream bubble
      if (streamEl && streamBuf) {
        if (!sessions[msg.agent]) sessions[msg.agent] = [];
        sessions[msg.agent].push({ role: 'assistant', content: streamBuf, ts: Date.now() });
      }
      streamEl = null; streamBuf = '';
      appendMessage('assistant', msg.text, { agent: msg.agent });
      // Unlock input so user can type APPROVE or DENY (bypasses streaming guard)
      awaitingPermission = true;
      $('btnSend').disabled = false;
      $('input').disabled = false;
      scrollToBottom();
      break;
    case 'tool_call':
      if (msg.agent !== activeAgent) {
        const isNew = !agentStreams[msg.agent];
        if (isNew) agentStreams[msg.agent] = { buf: '', toolNames: [], active: true };
        agentStreams[msg.agent].toolNames.push(msg.name);
        agentStreams[msg.agent].active = true;
        if (isNew) { buildTabs(); buildAgentDrawer(); }
        break;
      }
      if (getActiveWidgetTarget?.()) break; // Suppress tool pills when response is in widget
      showToolPill(msg.name);
      break;
    case 'tool_result':
      if (msg.agent !== activeAgent) break;
      updateToolPill(msg.name, msg.preview, msg.text);
      break;
    case 'replace':
      if (msg.agent !== activeAgent) {
        if (agentStreams[msg.agent]) agentStreams[msg.agent].buf = msg.text;
        break;
      }
      if (typeof widgetStreamReplace === 'function' && widgetStreamReplace(msg.text)) break;
      if (streamEl) {
        if (!msg.text) {
          if (streamBuf.trim()) {
            // Commit streamed text as a finished bubble rather than erasing it
            streamEl.innerHTML = renderMarkdown(streamBuf);
            streamEl = null;
          } else {
            streamEl.closest('.msg')?.remove();
            streamEl = null;
          }
        } else {
          streamBuf = msg.text;
          streamEl.innerHTML = renderMarkdown(streamBuf);
          scrollToBottom();
        }
      }
      break;
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
    case 'done':
      if (msg.agent !== activeAgent) {
        // Background agent finished — save to session, clear stream state
        const bg = agentStreams[msg.agent];
        if (bg?.buf) {
          if (!sessions[msg.agent]) sessions[msg.agent] = [];
          sessions[msg.agent].push({ role: 'assistant', content: bg.buf, ts: Date.now() });
        }
        delete agentStreams[msg.agent];
        buildTabs(); buildAgentDrawer();
        break;
      }
      // If response was routed to a widget, save as hidden and clear
      if (typeof getActiveWidgetTarget === 'function' && getActiveWidgetTarget() && msg.agent === activeAgent) {
        const finalBuf = widgetStreamFinish();
        if (finalBuf) {
          if (!sessions[msg.agent]) sessions[msg.agent] = [];
          sessions[msg.agent].push({ role: 'assistant', content: finalBuf, ts: Date.now(), hidden: true });
        }
        streamEl = null; streamBuf = ''; toolPillsEl = null;
        setStreaming(false);
        break;
      }
      if (streamEl && streamBuf) {
        if (!sessions[msg.agent]) sessions[msg.agent] = [];
        sessions[msg.agent].push({ role: 'assistant', content: streamBuf, ts: Date.now() });
        addTimestamp(streamEl.closest('.msg'));
        if (msg.agent === activeAgent) updateSessionWarning();
      }
      streamEl = null; streamBuf = ''; toolPillsEl = null;
      setStreaming(false); setTyping(false);
      delete agentStreams[msg.agent];
      if (agents.find(a => a.skillCategory === 'expenses')?.id === msg.agent && $('drawerExpenses')?.classList.contains('open')) loadExpTxns();
      break;
    case 'image':
      if (msg.agent !== activeAgent) break;
      setTyping(false);
      appendImageBubble({ base64: msg.base64, mimeType: msg.mimeType, filename: msg.filename, savedPath: msg.savedPath }, Date.now());
      if (!sessions[msg.agent]) sessions[msg.agent] = [];
      sessions[msg.agent].push({ role: 'assistant', image: { base64: msg.base64, mimeType: msg.mimeType, filename: msg.filename, savedPath: msg.savedPath }, content: `[Image: ${msg.filename}]`, ts: Date.now() });
      break;
    case 'video':
      if (msg.agent !== activeAgent) break;
      setTyping(false);
      appendVideoBubble({ url: msg.url, filename: msg.filename, savedPath: msg.savedPath }, Date.now());
      if (!sessions[msg.agent]) sessions[msg.agent] = [];
      sessions[msg.agent].push({ role: 'assistant', video: { url: msg.url, filename: msg.filename, savedPath: msg.savedPath }, content: `[Video: ${msg.filename}]`, ts: Date.now() });
      break;
    case 'error':
      if (msg.agent && msg.agent !== activeAgent) break;
      setStreaming(false); appendError(msg.message); break;
    case 'memory_stored':
    case 'memory_forgotten': {
      if (msg.agent !== activeAgent) break;
      const bubbles = $('messages').querySelectorAll('.msg.assistant');
      if (bubbles.length) {
        const last = bubbles[bubbles.length - 1];
        last.classList.add('memory-stored');
        const badge = document.createElement('div');
        badge.className = 'memory-badge';
        badge.textContent = msg.type === 'memory_forgotten' ? '✦ memory forgotten' : '✦ saved to memory';
        last.appendChild(badge);
      }
      break;
    }
    case 'agent_list':
      agents = msg.agents;
      if (agents.length > 0 && !agents.find(a => a.id === activeAgent)) {
        activeAgent = agents[0].id;
        if (!(activeAgent in sessions)) {
          sessions[activeAgent] = [];
          ws?.send(JSON.stringify({ type: 'load_session', agent: activeAgent }));
        }
        renderSession();
      } else if (agents.length === 0) {
        activeAgent = null;
      }
      buildTabs();
      buildAgentDrawer();
      // Keep Settings' per-agent model rows in sync if the panel is rendered
      if (document.getElementById('agentModelRows') && typeof renderAgentModelRows === 'function') {
        renderAgentModelRows();
      }
      updateSessionWarning();
      break;
    case 'task_complete':
      handleTaskComplete(msg); break;
    case 'task_created':
      if (typeof loadTaskList === 'function') loadTaskList();
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
      break;
    case 'coder_mirror':
      if (typeof applyMirrorMessage === 'function') applyMirrorMessage(msg);
      break;
    case 'task_update':
      if (typeof handleTaskUpdate === 'function') handleTaskUpdate(msg);
      break;
    case 'agent_report':
      if (typeof handleAgentReport === 'function') handleAgentReport(msg);
      break;
    case 'node_health':
      if (typeof window._nodeHealthHandler === 'function') window._nodeHealthHandler(msg);
      break;
    case 'session_expired':
      localStorage.removeItem('oe_token');
      showToast('Your session has expired. Please sign in again.');
      showLoginScreen();
      break;
    case 'active_streams': {
      // Restore streaming state for agents that are still working
      const activeIds = new Set((msg.agents ?? []).map(a => a.agentId));
      for (const { agentId } of (msg.agents ?? [])) {
        if (agentId === activeAgent) {
          setStreaming(true);
          setTyping(true);
        } else {
          if (!agentStreams[agentId]) agentStreams[agentId] = { buf: '', toolNames: [], active: true };
          agentStreams[agentId].active = true;
        }
      }
      // If the active agent is NOT in the list, it finished while we were away
      if (!activeIds.has(activeAgent)) {
        setStreaming(false); setTyping(false);
      }
      // Restore background task activity panel
      for (const task of (msg.tasks ?? [])) {
        if (typeof handleTaskUpdate === 'function') {
          handleTaskUpdate({ ...task, status: 'running' });
        }
      }
      buildTabs();
      buildAgentDrawer();
      break;
    }
  }
}

