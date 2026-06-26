let _skillPerms = [];
let _skillPermFilter = 'all';

async function loadSkillPermissions() {
  const body = $('skillPermissionsBody');
  if (!body) return;
  body.innerHTML = '<div class="cdraw-empty">Loading permissions…</div>';
  try {
    const data = await fetch('/api/skill-permissions').then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    _skillPerms = data.skills || [];
    renderSkillPermissions();
  } catch (e) {
    body.innerHTML = `<div class="cdraw-empty" style="color:var(--red)">Failed to load permissions: ${escHtml(e.message)}</div>`;
  }
}

function setSkillPermissionFilter(filter) {
  _skillPermFilter = filter || 'all';
  renderSkillPermissions();
}

function skillPermMatches(skill) {
  if (_skillPermFilter === 'all') return true;
  if (_skillPermFilter === 'enabled') return skill.enabled;
  if (['high', 'medium', 'low'].includes(_skillPermFilter)) return skill.risk === _skillPermFilter;
  return (skill.flags || []).includes(_skillPermFilter);
}

function renderSkillPermissions() {
  const body = $('skillPermissionsBody');
  if (!body) return;
  const visible = _skillPerms.filter(skillPermMatches);
  const counts = {
    high: _skillPerms.filter(s => s.risk === 'high').length,
    medium: _skillPerms.filter(s => s.risk === 'medium').length,
    enabled: _skillPerms.filter(s => s.enabled).length,
    voice: _skillPerms.filter(s => s.voiceDevice).length,
  };
  const filters = [
    ['all', 'All'],
    ['enabled', `Enabled ${counts.enabled}`],
    ['high', `High ${counts.high}`],
    ['medium', `Medium ${counts.medium}`],
    ['send', 'Send'],
    ['control', 'Control'],
    ['admin', 'Admin'],
    ['credentials', 'Secrets'],
    ['voice', `Voice ${counts.voice}`],
  ];
  body.innerHTML = `
    <div class="perm-toolbar">
      <div class="perm-summary">
        <b>${_skillPerms.length}</b> skills
        <span>${counts.high} high risk</span>
        <span>${counts.medium} medium risk</span>
      </div>
      <div class="perm-filters">
        ${filters.map(([id, label]) => `<button class="perm-filter ${_skillPermFilter === id ? 'active' : ''}" data-action="setSkillPermissionFilter" data-args='[${JSON.stringify(id)}]'>${escHtml(label)}</button>`).join('')}
      </div>
    </div>
    <div class="perm-list">
      ${visible.length ? visible.map(renderSkillPermissionCard).join('') : '<div class="cdraw-empty">No skills match this filter.</div>'}
    </div>
  `;
  if (window.lucide) lucide.createIcons();
}

function riskLabel(risk) {
  return `<span class="perm-risk ${escHtml(risk || 'low')}">${escHtml(risk || 'low')}</span>`;
}

function flagPills(flags) {
  return (flags || []).map(f => `<span class="perm-flag">${escHtml(f)}</span>`).join('');
}

function renderSkillPermissionCard(s) {
  const assigned = s.assignedAgent
    ? `${s.assignedAgent.emoji || ''} ${s.assignedAgent.name || s.assignedAgent.id}`
    : s.bundledWithRole
      ? `bundled with ${s.bundledWithRole}`
      : 'unassigned';
  const toolRows = (s.tools || []).map(t => `
    <tr>
      <td><code>${escHtml(t.name || 'tool')}</code></td>
      <td>${riskLabel(t.risk)}</td>
      <td>${flagPills(t.flags)}</td>
      <td>${escHtml(t.description || '')}</td>
    </tr>
  `).join('');
  return `
    <details class="perm-card" ${s.risk === 'high' ? 'open' : ''}>
      <summary>
        <div class="perm-card-main">
          <div class="perm-card-title">
            ${riskLabel(s.risk)}
            <span>${escHtml(s.name)}</span>
            ${s.enabled ? '<span class="perm-enabled">enabled</span>' : '<span class="perm-disabled">disabled</span>'}
          </div>
          <div class="perm-card-desc">${escHtml(s.description || '')}</div>
          <div class="perm-card-meta">
            <span>${escHtml(assigned)}</span>
            <span>${s.toolCount} tools</span>
            <span>${s.mutatingTools} mutating</span>
            ${s.voiceDevice ? '<span>voice</span>' : ''}
            ${s.custom ? '<span>custom</span>' : ''}
          </div>
        </div>
        <div class="perm-card-flags">${flagPills(s.flags)}</div>
      </summary>
      <div class="perm-detail">
        <div class="perm-detail-grid">
          <div><span>Skill ID</span><b>${escHtml(s.id)}</b></div>
          <div><span>Category</span><b>${escHtml(s.category || 'none')}</b></div>
          <div><span>Assignment</span><b>${escHtml(assigned)}</b></div>
          <div><span>Default Tools</span><b>${s.defaultToolIds ? s.defaultToolIds.length : 'all declared'}</b></div>
        </div>
        <div class="perm-tools-wrap">
          <table class="perm-tools">
            <thead><tr><th>Tool</th><th>Risk</th><th>Flags</th><th>Description</th></tr></thead>
            <tbody>${toolRows || '<tr><td colspan="4">No declared tools.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </details>
  `;
}
