// Task chips, status bubbles, cancel — extracted from chat-render.js.
// Globals intentional.

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
  if (phase === 'waiting_children') return 'waiting on tasks';
  if (phase === 'finalizing') return 'finishing';
  if (phase === 'stalled') return 'needs attention';
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
