// Chat send() path — extracted from chat.js. Globals intentional.

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

