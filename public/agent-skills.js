// ── Agents & Skills (dashboard tool) ───────────────────────────────────────────
// Read-only view: every agent and EVERY tool it carries, grouped by the skill
// that owns the tool. Backed by GET /api/agent-skills.

let _agSkillsData = null;
let _agSkillsExpanded = false;

async function loadAgentSkills(targetId) {
  const body = $(targetId || 'dashboardAgentSkillsBody');
  if (!body) return;
  body.innerHTML = '<div class="cdraw-empty">Loading…</div>';
  let data;
  try {
    data = await fetch('/api/agent-skills').then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
  } catch (e) {
    body.innerHTML = `<div class="cdraw-empty" style="color:var(--red)">Failed to load: ${escHtml(e.message)}</div>`;
    return;
  }
  _agSkillsData = data;
  renderAgentSkills(body);
}

const _AG_SRC_STYLE = {
  primary:      { label: 'primary',   color: 'var(--accent)' },
  assigned:     { label: 'assigned',  color: 'var(--green,#43b89c)' },
  bundled:      { label: 'bundled',   color: '#d6a85f' },
  'always-on':  { label: 'always-on', color: 'var(--muted)' },
  shared:       { label: 'shared',    color: 'var(--muted)' },
  delegate:     { label: 'delegate',  color: '#b58cff' },
  core:         { label: 'core',      color: 'var(--muted)' },
  other:        { label: 'other',     color: 'var(--muted)' },
};

function _agSrcBadge(source) {
  const s = _AG_SRC_STYLE[source] || _AG_SRC_STYLE.other;
  return `<span style="font-size:9px;text-transform:uppercase;letter-spacing:.5px;color:${s.color};border:1px solid ${s.color}55;border-radius:4px;padding:0 5px;white-space:nowrap">${s.label}</span>`;
}

function _agGroupHtml(g) {
  const rows = g.tools.map(t => `
    <div style="display:flex;gap:8px;padding:3px 0;border-top:1px solid var(--border)">
      <code style="font-size:11px;color:var(--text);white-space:nowrap">${escHtml(t.name)}</code>
      <span style="font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(t.description)}">${escHtml(t.description)}</span>
    </div>`).join('');
  return `<div style="margin:8px 0 2px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
      <span style="font-size:12px;font-weight:600">${escHtml(g.skillName)}</span>
      ${_agSrcBadge(g.source)}
      <span style="font-size:10px;color:var(--muted)">${g.tools.length} tool${g.tools.length !== 1 ? 's' : ''}</span>
    </div>
    ${rows}
  </div>`;
}

function _agAgentCard(a) {
  const coordBadge = a.isCoordinator
    ? ' <span style="font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:4px;padding:0 5px;vertical-align:middle">coordinator</span>'
    : '';
  const dangling = a.danglingPrimary
    ? `<div style="font-size:11px;color:var(--red,#e05c5c);margin:6px 0">⚠ assigned skill <code>${escHtml(a.danglingPrimary)}</code> no longer exists (dangling assignment)</div>`
    : '';
  const groupsHtml = (a.groups || []).map(_agGroupHtml).join('') || '<div style="font-size:11px;color:var(--muted);padding:6px 0">No tools.</div>';
  return `<details class="ag-card" ${_agSkillsExpanded ? 'open' : ''} style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:8px">
    <summary style="display:flex;align-items:center;gap:10px;cursor:pointer;list-style:none">
      <span style="font-size:22px">${a.emoji || '🤖'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px">${escHtml(a.name)}${coordBadge}</div>
        <div style="font-size:11px;color:var(--muted)">${a.role ? escHtml(a.role) + ' · ' : ''}${escHtml(a.model || '')}</div>
      </div>
      <span style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap">${a.totalTools} tools</span>
      <span style="font-size:11px;color:var(--muted)">▸</span>
    </summary>
    ${dangling}
    ${groupsHtml}
  </details>`;
}

function toggleAgentSkillsExpand() {
  _agSkillsExpanded = !_agSkillsExpanded;
  const body = $('dashboardAgentSkillsBody');
  if (body && _agSkillsData) renderAgentSkills(body);
}

function renderAgentSkills(body) {
  // The shared .dash-tool-panel clips overflow and expects each tool view to
  // own its scroll. Make this panel itself the scroll container (it already has
  // a bounded height via flex:1/min-height:0), so all tools are reachable.
  body.style.overflowY = 'auto';
  body.style.padding = '14px';
  const agents = (_agSkillsData && _agSkillsData.agents) || [];
  const totalTools = agents.reduce((n, a) => n + (a.totalTools || 0), 0);
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <div style="flex:1;font-size:12px;color:var(--muted);line-height:1.5">
        Every tool each agent carries, grouped by the skill that owns it. This is the full resolved toolset <i>before</i> the per-turn router trims it per message. <b>${agents.length}</b> agents · <b>${totalTools}</b> tool slots total.
      </div>
      <button class="dash-tool-btn" style="width:auto;padding:6px 12px;white-space:nowrap" data-action="toggleAgentSkillsExpand">${_agSkillsExpanded ? 'Collapse all' : 'Expand all'}</button>
    </div>
    ${agents.map(_agAgentCard).join('') || '<div class="cdraw-empty">No agents.</div>'}
  `;
  body.querySelectorAll('summary').forEach(s => { s.style.listStyle = 'none'; });
  if (window.lucide) lucide.createIcons();
}
