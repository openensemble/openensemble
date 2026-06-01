// ── Learn drawer ─────────────────────────────────────────────────────────────
// Unified surface for proposals (pending inbox) + audit of accepted learnings
// (rules, aliases, routines, custom skills). Read endpoints:
//   GET  /api/proposals?status=pending|snoozed   (snoozed via add-on below)
//   GET  /api/learnings
// Write endpoints:
//   POST /api/proposals/:id/accept|dismiss|snooze
//   DELETE /api/learnings/rules/:roleId/:idx
//   DELETE /api/learnings/aliases/:phrase
//   DELETE /api/learnings/routines/:id

let _learnState = { pending: [], learnings: null, busy: new Set() };

function _learnAgo(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000)      return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000)   return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000)  return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

async function loadLearnDrawer() {
  const body = $('learnBody');
  if (!body) return;
  body.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:24px;text-align:center">Loading…</div>`;
  try {
    const [propsRes, learnRes] = await Promise.all([
      fetch('/api/proposals', { cache: 'no-store' }).then(r => r.json()),
      fetch('/api/learnings', { cache: 'no-store' }).then(r => r.json()),
    ]);
    _learnState.pending = propsRes.pending ?? [];
    _learnState.learnings = learnRes ?? null;
    _renderLearnDrawer();
    _updateLearnBadge();
  } catch (e) {
    body.innerHTML = `<div style="color:var(--err,#c33);font-size:13px;padding:20px">${escHtml(e.message)}</div>`;
  }
}

function _updateLearnBadge() {
  const badge = $('learnBadge');
  if (!badge) return;
  const n = (_learnState.pending || []).length;
  if (n > 0) {
    badge.textContent = String(n);
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function _renderLearnDrawer() {
  const body = $('learnBody');
  if (!body) return;
  const L = _learnState.learnings || {};
  body.innerHTML = [
    _renderPendingSection(_learnState.pending),
    _renderRulesSection(L.rules || []),
    _renderDefaultsSection(L.defaults || []),
    _renderRoutingOverridesSection(L.routingOverrides || []),
    _renderAliasesSection(L.aliases || []),
    _renderRoutinesSection(L.routines || []),
    _renderSkillsSection(L.skills || []),
    _renderSkillOverridesSection(L.skillOverrides || []),
    _renderFailuresSection(L.failures || []),
    _renderRecentSection(L.recentAccepted || []),
  ].join('');
}

function _renderSectionHdr(title, count) {
  const badge = count > 0 ? ` <span style="color:var(--muted);font-weight:normal">(${count})</span>` : '';
  return `<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);padding:14px 16px 6px;border-top:1px solid var(--border)">${escHtml(title)}${badge}</div>`;
}

function _renderEmptyHint(text) {
  return `<div style="color:var(--muted);font-size:12px;font-style:italic;padding:6px 16px 12px">${escHtml(text)}</div>`;
}

// ── Pending proposals ───────────────────────────────────────────────────────

function _renderPendingSection(items) {
  let body = '';
  if (!items.length) {
    body = _renderEmptyHint('Nothing waiting. As you use OE, suggestions land here.');
  } else {
    // Phase-13: bulk action bar above the pending list when there are 2+ items
    if (items.length >= 2) {
      body += `<div style="padding:4px 12px;display:flex;gap:8px;align-items:center;font-size:11px;color:var(--muted)">
        <span>Bulk:</span>
        <button data-action="learnBulkAccept" style="background:transparent;border:1px solid var(--border);border-radius:3px;padding:1px 8px;font-size:11px;color:var(--muted);cursor:pointer">Accept all</button>
        <button data-action="learnBulkDismiss" style="background:transparent;border:1px solid var(--border);border-radius:3px;padding:1px 8px;font-size:11px;color:var(--muted);cursor:pointer">Dismiss all</button>
      </div>`;
    }
    body += items.map(_renderPendingCard).join('');
  }
  return _renderSectionHdr('Pending suggestions', items.length) + body;
}

async function learnBulkAccept() {
  const ids = (_learnState.pending || []).map(p => p.id);
  if (!ids.length) return;
  if (!confirm(`Accept all ${ids.length} pending suggestions?`)) return;
  try {
    const r = await fetch('/api/proposals/bulk/accept', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) { alert(`Failed: ${r.statusText}`); return; }
  } catch (e) { alert(`Failed: ${e.message}`); return; }
  loadLearnDrawer();
}

async function learnBulkDismiss() {
  const ids = (_learnState.pending || []).map(p => p.id);
  if (!ids.length) return;
  if (!confirm(`Dismiss all ${ids.length} pending suggestions?`)) return;
  try {
    const r = await fetch('/api/proposals/bulk/dismiss', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) { alert(`Failed: ${r.statusText}`); return; }
  } catch (e) { alert(`Failed: ${e.message}`); return; }
  loadLearnDrawer();
}

function _renderPendingCard(p) {
  const busy = _learnState.busy.has(p.id);
  const ageNote = p.createdAt ? `<span style="color:var(--muted);font-size:11px">${_learnAgo(p.createdAt)}</span>` : '';
  const kindBadge = `<span style="font-size:10px;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted)">${escHtml(p.kind || '')}</span>`;
  const message = escHtml(p.message || '').replace(/\n/g, '<br>');
  const accept = escHtml(p.accept_label || 'Accept');
  const dismiss = escHtml(p.dismiss_label || 'Dismiss');
  const disabled = busy ? 'disabled' : '';
  const btnArgs = JSON.stringify([p.id]).replace(/"/g, '&quot;');
  return `<div style="margin:8px 12px;padding:10px 12px;border:1px solid var(--border);border-left:3px solid var(--accent,#4f82ff);border-radius:6px;background:var(--bg1)">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
      ${kindBadge}${ageNote}
    </div>
    <div style="font-size:13px;line-height:1.45;margin-bottom:10px">${message}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn-small" data-action="learnAcceptProposal" data-args='${btnArgs}' ${disabled} style="background:var(--accent,#4f82ff);color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer">${accept}</button>
      <button class="btn-small" data-action="learnSnoozeProposal" data-args='${btnArgs}' ${disabled} style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;color:var(--text)">Snooze 7d</button>
      <button class="btn-small" data-action="learnDismissProposal" data-args='${btnArgs}' ${disabled} style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer;color:var(--muted)">${dismiss}</button>
    </div>
  </div>`;
}

async function _proposalAction(id, action) {
  if (_learnState.busy.has(id)) return;
  _learnState.busy.add(id);
  _renderLearnDrawer();
  try {
    const r = await fetch(`/api/proposals/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Failed: ${err.error || r.statusText}`);
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
  } finally {
    _learnState.busy.delete(id);
    // Reload to pick up status transitions + any new learnings written by the
    // accept handler (rule added, alias bound, etc.).
    loadLearnDrawer();
  }
}

function learnAcceptProposal(id)  { return _proposalAction(id, 'accept'); }
function learnDismissProposal(id) { return _proposalAction(id, 'dismiss'); }
function learnSnoozeProposal(id)  { return _proposalAction(id, 'snooze'); }

// ── Rules (per-role standing instructions) ──────────────────────────────────

function _renderRulesSection(roles) {
  let count = 0;
  for (const r of roles) count += (r.rules || []).length;
  let body = '';
  if (!roles.length) {
    body = _renderEmptyHint('No standing rules yet. When you correct an agent twice the same way, OE will offer to make it a rule here.');
  } else {
    body = roles.map(_renderRulesPerRole).join('');
  }
  return _renderSectionHdr('Standing rules', count) + body;
}

function _renderRulesPerRole(role) {
  const items = role.rules.map(rule => {
    const args = JSON.stringify([role.roleId, rule.idx, rule.text]).replace(/"/g, '&quot;');
    return `<div style="display:flex;align-items:flex-start;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;font-size:12px;line-height:1.4">${escHtml(rule.text)}</div>
      <button class="btn-small" data-action="learnRevokeRule" data-args='${args}' title="Remove this rule" style="background:transparent;border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--muted);cursor:pointer">Revoke</button>
    </div>`;
  }).join('');
  return `<div style="margin:6px 12px 10px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg1)">
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">${escHtml(role.roleId)}</div>
    ${items}
  </div>`;
}

async function learnRevokeRule(roleId, idx, ruleText) {
  if (!confirm(`Remove this rule from ${roleId}?\n\n${ruleText}`)) return;
  try {
    const r = await fetch(`/api/learnings/rules/${encodeURIComponent(roleId)}/${idx}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Failed: ${err.error || r.statusText}`);
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
  loadLearnDrawer();
}

// ── Pinned tool defaults ────────────────────────────────────────────────────

function _renderDefaultsSection(defaults) {
  let body = '';
  if (!defaults.length) {
    body = _renderEmptyHint('No pinned defaults yet. When you pass the same value to a tool repeatedly, OE will offer to make it a default.');
  } else {
    body = defaults.map(d => {
      const args = JSON.stringify([d.tool, d.arg, d.value]).replace(/"/g, '&quot;');
      const display = typeof d.value === 'string' ? `"${escHtml(d.value)}"` : escHtml(String(d.value));
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border);font-size:12px">
        <code style="font-size:11px;background:var(--bg1);padding:1px 5px;border-radius:3px">${escHtml(d.tool)}</code>
        <span style="color:var(--muted)">·</span>
        <span style="font-weight:600">${escHtml(d.arg)}</span>
        <span style="color:var(--muted)">=</span>
        <span>${display}</span>
        <button class="btn-small" data-action="learnRevokeDefault" data-args='${args}' style="margin-left:auto;background:transparent;border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--muted);cursor:pointer">Unpin</button>
      </div>`;
    }).join('');
  }
  return _renderSectionHdr('Pinned defaults', defaults.length) + body;
}

async function learnRevokeDefault(tool, arg, value) {
  const display = typeof value === 'string' ? `"${value}"` : String(value);
  if (!confirm(`Unpin ${tool}.${arg} = ${display}?`)) return;
  try {
    const r = await fetch(`/api/learnings/defaults/${encodeURIComponent(tool)}/${encodeURIComponent(arg)}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Failed: ${err.error || r.statusText}`);
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
  loadLearnDrawer();
}

// ── Routing overrides ───────────────────────────────────────────────────────

function _renderRoutingOverridesSection(overrides) {
  // Phase-11b: a manual add form lets power users skip the wait for two
  // organic redirects. The form posts to /api/learnings/routing-overrides
  // and reloads the panel on success.
  const addForm = `<div style="padding:6px 12px;border-bottom:1px solid var(--border);background:var(--bg1)">
    <div style="display:flex;gap:6px;align-items:center;font-size:11px;color:var(--muted);margin-bottom:4px">Add a manual routing override:</div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input id="rovrAddPattern" type="text" placeholder="text contained in message" style="flex:1;min-width:140px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:12px;color:var(--text)">
      <span style="color:var(--muted);font-size:11px">→</span>
      <input id="rovrAddAgent" type="text" placeholder="agent id (e.g. ada)" style="width:140px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;font-size:12px;color:var(--text)">
      <button data-action="learnManualAddRoutingOverride" style="background:var(--accent,#4f82ff);color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer">Add</button>
    </div>
  </div>`;

  let body = addForm;
  if (!overrides.length) {
    body += _renderEmptyHint('No routing overrides yet. When you redirect similar messages to the same agent (e.g. "@ada" or "use coder") twice, OE will offer to make it a permanent route. Or add one manually above.');
  } else {
    body += overrides.map(o => {
      const args = JSON.stringify([o.id, o.pattern]).replace(/"/g, '&quot;');
      const examples = (o.examples || []).slice(0, 1).map(e => escHtml(e)).join('');
      const addedBy = o.addedBy === 'manual' ? ' <span style="font-size:10px;color:var(--muted)">(manual)</span>' : '';
      return `<div style="padding:6px 12px;border-bottom:1px solid var(--border);font-size:12px">
        <div style="display:flex;align-items:center;gap:8px">
          <span>messages containing</span>
          <code style="font-size:11px;background:var(--bg1);padding:1px 5px;border-radius:3px">${escHtml(o.pattern)}</code>
          <span style="color:var(--muted)">→</span>
          <strong>${escHtml(o.forcedAgent)}</strong>${addedBy}
          <button class="btn-small" data-action="learnRevokeRoutingOverride" data-args='${args}' style="margin-left:auto;background:transparent;border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--muted);cursor:pointer">Revoke</button>
        </div>
        ${examples ? `<div style="color:var(--muted);font-size:11px;margin-top:2px;font-style:italic">e.g. "${examples}"</div>` : ''}
      </div>`;
    }).join('');
  }
  return _renderSectionHdr('Routing overrides', overrides.length) + body;
}

async function learnManualAddRoutingOverride() {
  const pattern = document.getElementById('rovrAddPattern')?.value?.trim();
  const forcedAgent = document.getElementById('rovrAddAgent')?.value?.trim();
  if (!pattern || !forcedAgent) {
    alert('Both pattern and agent id are required.');
    return;
  }
  try {
    const r = await fetch('/api/learnings/routing-overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, forcedAgent, mode: 'contains' }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Failed: ${err.error || r.statusText}`);
      return;
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
    return;
  }
  loadLearnDrawer();
}

async function learnRevokeRoutingOverride(id, pattern) {
  if (!confirm(`Remove routing override for "${pattern}"?`)) return;
  try {
    const r = await fetch(`/api/learnings/routing-overrides/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Failed: ${err.error || r.statusText}`);
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
  loadLearnDrawer();
}

// ── HA aliases ──────────────────────────────────────────────────────────────

function _renderAliasesSection(aliases) {
  let body = '';
  if (!aliases.length) {
    body = _renderEmptyHint('No aliases yet. When you say a noun and OE has to resolve it ("kitchen" → light.kitchen), it will offer to remember the binding.');
  } else {
    body = aliases.map(a => {
      const args = JSON.stringify([a.phrase]).replace(/"/g, '&quot;');
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border);font-size:12px">
        <span style="font-weight:600">"${escHtml(a.phrase)}"</span>
        <span style="color:var(--muted)">→</span>
        <code style="font-size:11px;background:var(--bg1);padding:1px 5px;border-radius:3px;color:var(--text)">${escHtml(a.entityId)}</code>
        <button class="btn-small" data-action="learnRevokeAlias" data-args='${args}' style="margin-left:auto;background:transparent;border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--muted);cursor:pointer">Revoke</button>
      </div>`;
    }).join('');
  }
  return _renderSectionHdr('HA aliases', aliases.length) + body;
}

async function learnRevokeAlias(phrase) {
  if (!confirm(`Remove alias "${phrase}"?`)) return;
  try {
    const r = await fetch(`/api/learnings/aliases/${encodeURIComponent(phrase)}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Failed: ${err.error || r.statusText}`);
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
  loadLearnDrawer();
}

// ── Routines ────────────────────────────────────────────────────────────────

function _renderRoutinesSection(routines) {
  let body = '';
  if (!routines.length) {
    body = _renderEmptyHint('No routines yet. Phrase shortcuts to multi-step actions will land here as you build them.');
  } else {
    body = routines.map(r => {
      const args = JSON.stringify([r.id, r.trigger]).replace(/"/g, '&quot;');
      const aliasesNote = r.aliases?.length ? ` <span style="color:var(--muted);font-size:11px">(also: ${r.aliases.map(escHtml).join(', ')})</span>` : '';
      const actionNote = r.firstAction
        ? `${escHtml(r.firstAction)}${r.actionCount > 1 ? ` + ${r.actionCount - 1} more` : ''}`
        : `${r.actionCount} action${r.actionCount === 1 ? '' : 's'}`;
      return `<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border);font-size:12px">
        <div style="flex:1">
          <div style="font-weight:600">"${escHtml(r.trigger)}"${aliasesNote}</div>
          <div style="color:var(--muted);font-size:11px">${actionNote}</div>
        </div>
        <button class="btn-small" data-action="learnRevokeRoutine" data-args='${args}' style="background:transparent;border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--muted);cursor:pointer">Revoke</button>
      </div>`;
    }).join('');
  }
  return _renderSectionHdr('Routines', routines.length) + body;
}

async function learnRevokeRoutine(id, trigger) {
  if (!confirm(`Remove routine "${trigger}"?`)) return;
  try {
    const r = await fetch(`/api/learnings/routines/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Failed: ${err.error || r.statusText}`);
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
  loadLearnDrawer();
}

// ── Custom skills (read-only, link to settings) ─────────────────────────────

function _renderSkillsSection(skills) {
  let body = '';
  if (!skills.length) {
    body = _renderEmptyHint('No custom skills yet. Ask Sydney or your coder agent to "make a skill that…" to build one.');
  } else {
    body = skills.map(s => {
      return `<div style="padding:6px 12px;border-bottom:1px solid var(--border);font-size:12px">
        <div style="font-weight:600">${escHtml(s.icon || '')} ${escHtml(s.name)}</div>
        ${s.description ? `<div style="color:var(--muted);font-size:11px;margin-top:2px">${escHtml(s.description)}</div>` : ''}
        <div style="color:var(--muted);font-size:11px;margin-top:2px">${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}</div>
      </div>`;
    }).join('');
  }
  return _renderSectionHdr('Your custom skills', skills.length) + body;
}

// ── Per-user skill overrides (disable / hide tools) ─────────────────────────

function _renderSkillOverridesSection(overrides) {
  let body = '';
  if (!overrides.length) {
    body = _renderEmptyHint('No skill overrides yet. You can disable a whole skill or hide specific tools from a skill. Manage via the agent settings (or PUT /api/learnings/skill-overrides/<skillId>).');
  } else {
    body = overrides.map(o => {
      const args = JSON.stringify([o.skillId]).replace(/"/g, '&quot;');
      const disabled = o.disabled
        ? `<span style="font-size:10px;background:var(--orange,#c80);color:#fff;padding:1px 6px;border-radius:3px">disabled</span>`
        : '';
      const hidden = o.hiddenTools?.length
        ? `<span style="color:var(--muted);font-size:11px">· ${o.hiddenTools.length} tool${o.hiddenTools.length === 1 ? '' : 's'} hidden</span>`
        : '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border);font-size:12px">
        <code style="font-size:11px;background:var(--bg1);padding:1px 5px;border-radius:3px">${escHtml(o.skillId)}</code>
        ${disabled}
        ${hidden}
        <button class="btn-small" data-action="learnRevokeSkillOverride" data-args='${args}' style="margin-left:auto;background:transparent;border:1px solid var(--border);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--muted);cursor:pointer">Clear</button>
      </div>`;
    }).join('');
  }
  return _renderSectionHdr('Skill customizations', overrides.length) + body;
}

async function learnRevokeSkillOverride(skillId) {
  if (!confirm(`Clear customizations for skill "${skillId}"? It will return to defaults.`)) return;
  try {
    const r = await fetch(`/api/learnings/skill-overrides/${encodeURIComponent(skillId)}`, { method: 'DELETE' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Failed: ${err.error || r.statusText}`);
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
  loadLearnDrawer();
}

// ── Tools with recent failures (read-only, diagnostic) ─────────────────────

function _renderFailuresSection(failures) {
  if (!failures.length) return '';   // hide entirely when none — no friction noise
  const body = failures.slice(0, 10).map(f => {
    const unique = f.uniqueErrorCount > 1
      ? ` <span style="color:var(--muted);font-size:11px">(${f.uniqueErrorCount} unique)</span>`
      : '';
    return `<div style="padding:6px 12px;border-bottom:1px solid var(--border);font-size:12px">
      <div><code style="font-size:11px;background:var(--bg1);padding:1px 5px;border-radius:3px">${escHtml(f.tool)}</code> · ${f.count} failure${f.count === 1 ? '' : 's'}${unique} · <span style="color:var(--muted)">${_learnAgo(f.lastTs)}</span></div>
      <div style="color:var(--muted);font-size:11px;margin-top:2px;font-family:ui-monospace,monospace;overflow-wrap:break-word">${escHtml(f.lastError)}</div>
    </div>`;
  }).join('');
  return _renderSectionHdr('Tools with recent failures', failures.length) + body;
}

// ── Recent accepted activity ───────────────────────────────────────────────

function _renderRecentSection(recent) {
  let body = '';
  const summary = _renderOutcomeSummary(_learnState.learnings?.outcomesByKind || []);
  if (!recent.length) {
    body = summary + _renderEmptyHint('No recent activity in the last 30 days.');
  } else {
    body = summary + recent.slice(0, 20).map(r => {
      const deltaBadge = r.deltaMeasured ? _renderDeltaBadge(r.delta, r.semantic, r.note) : '';
      return `<div style="padding:5px 12px;border-bottom:1px solid var(--border);font-size:12px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <span>${escHtml(r.summary)}</span>
          ${deltaBadge}
        </div>
        <div style="color:var(--muted);font-size:11px">${_learnAgo(r.endedAt)}</div>
      </div>`;
    }).join('');
  }
  return _renderSectionHdr('Recently accepted', recent.length) + body;
}

function _renderOutcomeSummary(byKind) {
  const measured = (byKind || []).filter(k => k.measured > 0);
  if (!measured.length) return '';
  const salience = _learnState.learnings?.salienceStatus || [];
  const kindStatus = (k) => salience.find(s => s.kind === k) || { allow: true };
  const items = measured.map(k => {
    const ratio = `${k.improved} of ${k.measured}`;
    const semantic = k.semantic || 'lower-better';
    const isGood = k.improved >= k.measured / 2;
    const dir = (semantic === 'higher-better') ? (isGood ? '↑' : '↓') : (isGood ? '↓' : '↑');
    const color = isGood ? 'var(--green,#3a7)' : 'var(--orange,#c80)';
    const measurerHint = k.usesMeasurer ? '' : '*';
    const status = kindStatus(k.kind);
    const pausedBadge = !status.allow
      ? ` <span style="color:var(--orange,#c80);font-weight:600;font-size:10px"> · paused</span> <button data-action="learnResetSalience" data-args='${JSON.stringify([k.kind]).replace(/"/g, '&quot;')}' style="font-size:10px;background:transparent;border:1px solid var(--border);border-radius:3px;padding:1px 5px;color:var(--muted);cursor:pointer">resume</button>`
      : '';
    return `<span style="white-space:nowrap"><code style="font-size:11px;background:var(--bg1);padding:0 4px;border-radius:3px">${escHtml(k.kind)}${measurerHint}</code> <span style="color:${color}">${dir}</span> on ${ratio}${pausedBadge}</span>`;
  }).join(' &nbsp;·&nbsp; ');
  const footnote = measured.some(k => !k.usesMeasurer)
    ? `<span style="color:var(--muted);font-size:10px"> · * = coarse signal (per-kind measurer pending)</span>`
    : '';
  return `<div style="padding:6px 12px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border);line-height:1.6">
    Friction after acceptance (30d): ${items}${footnote}
  </div>`;
}

async function learnResetSalience(kind) {
  if (!confirm(`Resume emitting "${kind}" proposals? It'll re-evaluate from outcome data after 7 days.`)) return;
  try {
    const r = await fetch(`/api/learnings/salience/${encodeURIComponent(kind)}/reset`, { method: 'POST' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(`Failed: ${err.error || r.statusText}`);
    }
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
  loadLearnDrawer();
}

function _renderDeltaBadge(delta, semantic, note) {
  if (delta === null || delta === undefined) return '';
  semantic = semantic || 'lower-better';
  // "isGood" interprets delta against the kind's semantic:
  //   lower-better:  delta <= 0 is good (post is same/less than pre)
  //   higher-better: delta >= 0 is good
  const isGood = semantic === 'higher-better' ? (delta >= 0) : (delta <= 0);
  // Arrow points in the OBSERVED direction (down if delta<=0, up otherwise).
  const arrow = delta <= 0 ? '↓' : '↑';
  const color = isGood ? 'var(--green,#3a7)' : 'var(--orange,#c80)';
  const abs = Math.abs(delta);
  const title = note ? escHtml(note) : 'pre vs post 7d window';
  return `<span style="font-size:10px;color:${color};white-space:nowrap" title="${title}">${arrow} ${abs}</span>`;
}

// ── WS hook — auto-refresh on inbound proposal events ───────────────────────
// Listens for proposal / proposal_outcome envelopes pushed via the chat WS so
// the drawer badge updates without manual refresh when a new card lands.

(function () {
  // websocket.js owns the global onmessage and dispatches via
  // handleServerMessage(msg). Top-level functions in /public are window-scoped,
  // so we can wrap by reading + reassigning window.handleServerMessage.
  const orig = window.handleServerMessage;
  if (typeof orig !== 'function') return;
  window.handleServerMessage = function (msg) {
    try {
      if (msg && (msg.type === 'proposal' || msg.type === 'proposal_outcome')) {
        fetch('/api/proposals', { cache: 'no-store' })
          .then(r => r.json())
          .then(d => {
            _learnState.pending = d.pending ?? [];
            _updateLearnBadge();
            if (activeDrawerId === 'drawerLearn') loadLearnDrawer();
          })
          .catch(() => {});
      }
    } catch (_) { /* swallow — never block other WS handlers */ }
    return orig.apply(this, arguments);
  };
})();

// Prime the badge once on page load so the dot shows up without opening
// the drawer first.
window.addEventListener('load', () => {
  fetch('/api/proposals', { cache: 'no-store' })
    .then(r => r.json())
    .then(d => { _learnState.pending = d.pending ?? []; _updateLearnBadge(); })
    .catch(() => {});
});
