// Chat render, scroll, and credential-prompt UI — extracted from chat.js.
// Globals intentional (same pattern as chat-send.js / chat-tool-run.js).

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
  applyMarkdown(el.querySelector('.msg-bubble'), content);
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
// Task chips / status: public/chat-task-ui.js (loaded before this file).
// Proposals / approvals: public/chat-decisions.js (loaded before this file).
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

// Tool-run UI lives in public/chat-tool-run.js (loaded before this file).

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
