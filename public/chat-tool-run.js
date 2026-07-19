// Live tool-run UI (ensureToolRun, steps, etc.) — extracted from chat.js.

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
  applyMarkdown(body, text ?? '');
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

function isIntentionalTurnStop(terminal = {}) {
  const code = typeof terminal?.code === 'string' ? terminal.code : '';
  if (code) return code === 'stopped' && (!terminal?.status || terminal.status === 'stopped');
  return terminal?.status === 'stopped';
}

function appendStopped(scroll = true) {
  const el = document.createElement('div');
  el.className = 'msg assistant turn-stopped';
  el.innerHTML = '<div class="msg-bubble">Stopped</div>';
  insertBefore(el);
  if (scroll) scrollToBottom();
  return el;
}

function appendTurnErrorBubble(row) {
  if (row?.assistantPartial) {
    appendAssistantBubble(`${row.assistantPartial}\n\n_Reply incomplete_`, row.ts, false);
  }
  if (isIntentionalTurnStop(row)) {
    appendStopped(false);
    return;
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
  const stopped = isIntentionalTurnStop(event);
  const canRetry = Boolean(!stopped && forThisAgent && event.retryable === true);
  const terminalEl = stopped
    ? appendStopped()
    : appendError(message, canRetry ? retryFailedAttempt : null);
  if (forThisAgent) {
    if (attempt.sessionEntry) {
      attempt.sessionEntry.turnStatus = stopped ? 'stopped' : 'failed';
      attempt.sessionEntry.retryable = canRetry;
    }
    failedAttempt = canRetry ? { ...attempt, errorEl: terminalEl } : null;
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
    <div class="agent-report-body msg-bubble"></div>
  `;
  applyMarkdown(el.querySelector('.agent-report-body'), bodyContent ?? '');
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
