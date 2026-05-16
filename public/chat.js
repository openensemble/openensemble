// ── Attachment state ──────────────────────────────────────────────────────────
let pendingAttachment = null; // { id, name, mimeType, base64, extractedText, isImage, isFinanceFile }

function clearAttachment() {
  pendingAttachment = null;
  const p = $('attachPreview');
  p.style.display = 'none';
  p.innerHTML = '';
  $('chatFileInput').value = '';
}

async function handleChatFileSelect(file) {
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const r = await fetch('/api/chat-upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    pendingAttachment = data;
    // Show preview
    const p = $('attachPreview');
    p.style.display = 'flex';
    const thumb = data.isImage && data.base64
      ? `<img src="data:${data.mimeType};base64,${data.base64}" alt="">`
      : `<span style="font-size:20px">${data.mimeType.includes('pdf') ? icon('file-text', 20) : icon('bar-chart-2', 20)}</span>`;
    p.innerHTML = `${thumb}<span class="attach-preview-name">${escHtml(data.name)}</span><button class="attach-preview-remove" data-action="clearAttachment">✕</button>`;
  } catch (e) {
    alert('Upload failed: ' + e.message);
  }
}

// ── Send ──────────────────────────────────────────────────────────────────────
async function send() {
  const text = $('input').value.trim();
  if ((!text && !pendingAttachment) || (streaming && !awaitingPermission) || !ws || ws.readyState !== WebSocket.OPEN) return;

  const attachment = pendingAttachment;
  const displayText = text || (attachment ? `[${attachment.name}]` : '');

  if (!sessions[activeAgent]) sessions[activeAgent] = [];
  sessions[activeAgent].push({ role: 'user', content: displayText, ts: Date.now(), attachment });
  updateSessionWarning();
  appendUserBubble(displayText, Date.now(), true, attachment);
  $('input').value = '';
  resizeTextarea();
  clearAttachment();
  toolPillsEl = null; toolStreamBubbleEl = null; toolStreamBubbleTool = null;
  if (awaitingPermission) {
    awaitingPermission = false;
    // Don't reset streaming — Ada is still running; just show typing indicator
    setTyping(true);
  } else {
    setStreaming(true); setTyping(true);
  }

  const payload = { type: 'chat', agent: activeAgent, text };
  if (attachment) payload.attachment = attachment;
  ws.send(JSON.stringify(payload));
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderSession() {
  const msgs = $('messages');
  [...msgs.children].forEach(el => { if (!el.id) el.remove(); });
  (sessions[activeAgent] ?? []).forEach(m => {
    if (m.scheduled)                 appendTaskHeader(m.content, m.ts, false);
    else if (m.role === 'notification') appendNotification({ agent: activeAgent, content: m.content, from: m.from, ts: m.ts });
    else if (m.role === 'user' && !m.hidden)        appendUserBubble(m.content, m.ts, false, m.attachment ?? null);
    else if (m.role === 'assistant' && m.image)    appendImageBubble(m.image, m.ts, false);
    else if (m.role === 'assistant' && m.video)    appendVideoBubble(m.video, m.ts, false);
    else if (m.role === 'status' && m.status)     appendStatusBubble(m.status, m.ts, false);
    else if (m.role === 'proposal' && m.proposalId) appendProposalBubble(m, false);
    else if (m.role === 'proposal_outcome' && m.proposalId) applyProposalOutcome(m.proposalId, m.status, m.outcome);
    else if (m.role === 'assistant' && !m.hidden) appendAssistantBubble(m.content, m.ts, false);
  });
  const headers = $('messages').querySelectorAll('.task-header[data-ts]');
  if (headers.length) {
    const today = new Date().toDateString();
    let latest = null;
    headers.forEach(h => { if (new Date(+h.dataset.ts).toDateString() === today) latest = h; });
    if (latest) latest.scrollIntoView({ block: 'start' });
    else scrollToBottom();
  } else {
    scrollToBottom();
  }
}

function appendUserBubble(text, ts = Date.now(), scroll = true, attachment = null) {
  const el = msgEl('user');
  const bubble = el.querySelector('.msg-bubble');
  if (attachment) {
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
  if (text && text !== `[${attachment?.name}]`) {
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
// Watcher status updates — muted/italic, distinct from assistant bubbles.
// Sourced from scheduler/watchers.mjs supervisor pushing WS type='status'
// messages. The `📡` prefix marks these as poll-driven, not agent-spoken.
//
// Update-in-place: each watcher gets ONE bubble that mutates as new statuses
// arrive. Looked up by data-watcher-id. New watchers append a fresh bubble;
// repeat updates for the same watcherId rewrite the existing one in place.
function appendStatusBubble(status, ts = Date.now(), scroll = true) {
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
  el.style.cssText = 'padding:10px 12px;margin:6px 0;font-size:13px;border-left:3px solid var(--accent, #6c8cff);background:rgba(108,140,255,0.06);border-radius:4px';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:4px';
  const icon = document.createElement('span');
  icon.textContent = '💡';
  header.appendChild(icon);
  const label = document.createElement('span');
  label.style.cssText = 'font-weight:600';
  label.textContent = proposal.kind === 'watch' ? 'Set up a monitor?' : 'Make this a recurring task?';
  header.appendChild(label);
  el.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = 'color:var(--muted);font-size:12px;margin-bottom:8px';
  body.textContent = `You've asked this a few times: "${proposal.message}"`;
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
  } else if (status === 'dismissed') {
    el.style.opacity = '0.6';
    outcomeEl.textContent = '✕ Dismissed';
  } else if (status === 'failed') {
    el.style.borderLeftColor = 'var(--red, #f44336)';
    el.style.background = 'rgba(244,67,54,0.06)';
    outcomeEl.textContent = `⚠ ${outcome || 'Failed'}`;
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

function appendVideoBubble(video, ts = Date.now(), scroll = true) {
  const el = msgEl('assistant');
  const bubble = el.querySelector('.msg-bubble');

  const videoEl = document.createElement('video');
  videoEl.src = video.url;
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
    dlBtn.href = video.url;
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
// Pull the most informative arg for a tool into a one-line subtitle.
// Returns '' if nothing useful is available — the pill stays as just the name.
function toolPillSubtitle(name, args) {
  if (!args || typeof args !== 'object') return '';
  // Tools where the headline arg is the user-visible action.
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
  return '';
}

function showToolPill(name, args) {
  if (!toolPillsEl) {
    toolPillsEl = document.createElement('div');
    toolPillsEl.className = 'tool-pills';
    toolPillsEl.addEventListener('click', onToolPillClick);
    toolPillsEl.addEventListener('keydown', onToolPillKey);
    insertBefore(toolPillsEl);
  }
  const pill = document.createElement('span');
  pill.className = 'tool-pill';
  pill.dataset.tool = name;
  pill.innerHTML = `${icon('settings', 13)} ${escHtml(name)}`;
  const subtitle = toolPillSubtitle(name, args);
  if (subtitle) {
    pill._argSubtitle = subtitle;
    const sub = document.createElement('span');
    sub.className = 'tool-pill-subtitle';
    sub.textContent = subtitle.length > 100 ? subtitle.slice(0, 100) + '…' : subtitle;
    sub.title = subtitle;
    pill.appendChild(sub);
  }
  toolPillsEl.appendChild(pill);
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
  if (!toolPillsEl) return null;
  const pills = toolPillsEl.querySelectorAll('.tool-pill');
  for (let i = pills.length - 1; i >= 0; i--) {
    if (pills[i].dataset.tool === name && !pills[i].classList.contains('tool-done')) {
      return pills[i];
    }
  }
  return null;
}

function _ensureStreamBubble(name, argSubtitle) {
  if (toolStreamBubbleEl && toolStreamBubbleTool === name) return toolStreamBubbleEl;
  // Different tool (or none yet) — rebuild the bubble.
  if (toolStreamBubbleEl) toolStreamBubbleEl.remove();
  toolStreamBubbleEl = document.createElement('div');
  toolStreamBubbleEl.className = 'tool-stream-bubble';
  const head = document.createElement('div');
  head.className = 'tool-pill-head';
  head.innerHTML = `${icon('settings', 13)} ${escHtml(name)}`;
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
  const pendingPill = _findLatestPendingPill(name);
  if (!pendingPill) return; // nothing to attach progress to (already finished)
  const argSub = pendingPill._argSubtitle || '';
  const bubble = _ensureStreamBubble(name, argSub);
  const stream = bubble.querySelector('.tool-pill-stream');
  stream._buf = (stream._buf + text).slice(-PROGRESS_BUF_CAP);
  stream.textContent = stream._buf;
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
  const pills = toolPillsEl.querySelectorAll('.tool-pill');
  for (let i = pills.length - 1; i >= 0; i--) {
    if (pills[i].dataset.tool === name && !pills[i].classList.contains('tool-done')) {
      // innerHTML reassign drops the arg subtitle.
      pills[i].innerHTML = `${icon('check', 13)} ${escHtml(name)}`;
      if (summary) {
        const sum = document.createElement('span');
        sum.className = 'tool-pill-summary';
        sum.textContent = summary.length > 80 ? summary.slice(0, 80) + '...' : summary;
        pills[i].appendChild(sum);
      }
      pills[i].classList.add('tool-done');
      if (fullText) {
        pills[i]._toolFullText = fullText;
        pills[i].classList.add('clickable');
        pills[i].setAttribute('role', 'button');
        pills[i].setAttribute('tabindex', '0');
        pills[i].title = 'Click to view full output';
      }
      break;
    }
  }
}

function onToolPillClick(e) {
  const pill = e.target.closest('.tool-pill.clickable');
  if (!pill || !pill._toolFullText) return;
  openToolModal(pill.dataset.tool, pill._toolFullText);
}
function onToolPillKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const pill = e.target.closest('.tool-pill.clickable');
  if (!pill || !pill._toolFullText) return;
  e.preventDefault();
  openToolModal(pill.dataset.tool, pill._toolFullText);
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
  body.textContent = text;
  backdrop.classList.add('open');
}
function appendError(msg) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="msg-bubble" style="color:#f44336;border:1px solid #f44336">⚠ ${escHtml(msg)}</div>`;
  insertBefore(el); scrollToBottom();
}
function appendNotification(msg) {
  const agentId = msg.agent;
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
// ── Agent Activity Panel ───────────────────────────────────────────────────────
const _activityTasks  = new Map(); // taskId -> { agentName, status, summary, content, startedAt, el, intervalId }

function handleTaskUpdate(msg) {
  const { taskId, agentName, status, summary, content } = msg;
  const panel = document.getElementById('agentActivityPanel');
  if (!panel) return;

  let task = _activityTasks.get(taskId);

  if (!task) {
    // Create new row
    const el = document.createElement('div');
    el.className = `activity-row ${status}`;
    el.title = 'Click to expand result';
    el.addEventListener('click', () => {
      const t = _activityTasks.get(taskId);
      if (!t || t.status === 'running') return;
      el.classList.toggle('expanded');
    });
    panel.appendChild(el);
    task = { agentName, status, summary: summary ?? '', content: content ?? '', startedAt: Date.now(), el, intervalId: null };
    _activityTasks.set(taskId, task);
  }

  task.status  = status;
  task.content = content ?? task.content;
  task.summary = summary ?? task.summary;

  _renderActivityRow(taskId, task);

  // Show panel
  panel.style.display = _activityTasks.size > 0 ? 'flex' : 'none';

  // Auto-fade done rows after 8s
  if (status === 'done') {
    if (task.intervalId) clearInterval(task.intervalId);
    task.intervalId = setTimeout(() => {
      task.el?.classList.add('fading');
      setTimeout(() => _dismissActivity(taskId), 400);
    }, 8000);
  }
}

function _renderActivityRow(taskId, task) {
  const { agentName, status, summary, content, startedAt, el } = task;
  const elapsed = _formatElapsed(Date.now() - startedAt);
  const statusIcon = status === 'running' ? '' : status === 'done' ? '✓' : '✗';
  el.className = `activity-row ${status}`;
  el.innerHTML = `
    <div class="activity-dot"></div>
    <div class="activity-label">
      <strong>${statusIcon ? statusIcon + ' ' : ''}${escHtml(agentName)}</strong>
      <span class="activity-summary">${escHtml(summary.slice(0, 60))}</span>
      ${content && status !== 'running' ? `<div class="activity-detail">${escHtml(content)}</div>` : ''}
    </div>
    <span class="activity-elapsed">${elapsed}</span>
    <button class="activity-dismiss" title="Dismiss" data-action="_dismissActivity" data-args='${JSON.stringify([taskId]).replace(/'/g, "&#39;")}' data-stop-propagation>×</button>
  `;
}

function _dismissActivity(taskId) {
  const task = _activityTasks.get(taskId);
  if (!task) return;
  if (task.intervalId) clearTimeout(task.intervalId);
  task.el?.remove();
  _activityTasks.delete(taskId);
  const panel = document.getElementById('agentActivityPanel');
  if (panel && _activityTasks.size === 0) panel.style.display = 'none';
}

function _formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  return `${m}:${String(rs).padStart(2, '0')}`;
}

// Keep elapsed timers ticking for running tasks
setInterval(() => {
  for (const [taskId, task] of _activityTasks) {
    if (task.status === 'running') _renderActivityRow(taskId, task);
  }
}, 5000);

// Render a direct report card from a background agent, inline in the current chat
function handleAgentReport(msg) {
  const { agentName, agentEmoji, content, ts } = msg;
  const timeStr = new Date(ts ?? Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const el = document.createElement('div');
  el.className = 'msg agent-report';
  el.innerHTML = `
    <div class="agent-report-header">
      <span class="agent-report-who">${escHtml(agentEmoji ?? '')} <strong>${escHtml(agentName)}</strong></span>
      <span class="agent-report-time">${timeStr}</span>
    </div>
    <div class="agent-report-body msg-bubble">${renderMarkdown(content ?? '')}</div>
  `;
  insertBefore(el);
  scrollToBottom();
}

function appendTaskHeader(label, ts = Date.now(), scroll = true) {
  const timeStr = new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const el = document.createElement('div');
  el.className = 'task-header';
  el.dataset.ts = ts;
  el.innerHTML = `<span class="task-header-label">📋 ${escHtml(label)} — ${timeStr}</span>`;
  insertBefore(el);
  if (scroll) { el.scrollIntoView({ block: 'start' }); }
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
function insertBefore(el) { $('messages').insertBefore(el, $('typing')); }
function scrollToBottom() { const m = $('messages'); m.scrollTop = m.scrollHeight; }
// escHtml defined below in Shared helpers section (with full quote escaping)

// ── Slash Command Menu ─────────────────────────────────────────────────────
let slashMenuIdx = 0, slashMenuItems = [];
let _skillsCache = null;
async function _loadSkills() {
  try { _skillsCache = await fetch('/api/roles').then(r => r.json()); } catch { _skillsCache = _skillsCache || []; }
  return _skillsCache;
}

const SLASH_COMMANDS = [
  { cmd: '/clear',     icon: 'trash-2',    desc: 'Clear the current chat session',
    action: () => { hideSlashMenu(); $('input').value = ''; clearSession(); } },
  { cmd: '/model',     icon: 'brain',      desc: 'Change the active model' },
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
  // /claim <filter> → roles only (same filter as Roles tab: s.service === true)
  if (/^\/claim\s/.test(val)) {
    const f = val.slice(7).toLowerCase();
    const cached = _skillsCache || [];
    if (!_skillsCache) { _loadSkills().then(() => updateSlashMenu()); }
    return cached
      .filter(s => s.service && (!f || s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f)))
      .map(s => ({
        label: s.name, desc: (s.assignment ? `claimed by ${agents.find(a=>a.id===s.assignment)?.name ?? s.assignment}` : 'unclaimed') + (s.description ? ' · ' + s.description : ''),
        action: () => { hideSlashMenu(); $('input').value = `/claim ${s.id}`; _skillsCache = null; send(); }
      }));
  }
  // /release <filter> → roles only
  if (/^\/release\s/.test(val)) {
    const f = val.slice(9).toLowerCase();
    const cached = _skillsCache || [];
    if (!_skillsCache) { _loadSkills().then(() => updateSlashMenu()); }
    return cached
      .filter(s => s.service && (!f || s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f)))
      .map(s => ({
        label: s.name, desc: s.assignment ? `claimed by ${agents.find(a=>a.id===s.assignment)?.name ?? s.assignment}` : 'unclaimed',
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
function slashMenuNav(dir) {
  if (!slashMenuItems.length) return;
  slashMenuIdx = (slashMenuIdx + dir + slashMenuItems.length) % slashMenuItems.length;
  updateSlashMenu();
}
