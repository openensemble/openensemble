// Proposals, attachment decisions, approvals, watcher history — extracted from chat-render.js.
// Globals intentional.

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

