// Slash-command and @-mention menus — extracted from chat.js.
// Globals intentional.

// ── Slash Command Menu ─────────────────────────────────────────────────────
let slashMenuIdx = 0, slashMenuItems = [];
let _skillsCache = null;
let _effortCache = null;
async function _loadSkills() {
  try { _skillsCache = await fetch('/api/roles').then(r => r.json()); } catch { _skillsCache = _skillsCache || []; }
  return _skillsCache;
}
async function _loadEfforts() {
  const agent = agents.find(a => a.id === activeAgent);
  const key = `${activeAgent}|${agent?.provider || ''}|${agent?.model || ''}|${agent?.reasoningEffort || 'auto'}`;
  if (_effortCache?.key === key) return _effortCache.data;
  try {
    const data = await fetch(`/api/reasoning-efforts?agent=${encodeURIComponent(activeAgent)}`).then(r => r.json());
    _effortCache = { key, data };
  } catch {
    _effortCache = { key, data: { current: agent?.reasoningEffort || 'auto', options: [{ value: 'auto', label: 'Auto', description: 'Use OE defaults.' }] } };
  }
  return _effortCache.data;
}
async function assignEffortToAgent(agentId, reasoningEffort) {
  const r = await fetch(`/api/agents/${agentId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reasoningEffort }),
  });
  if (!r.ok) { showToast('Failed to update effort'); return; }
  try { agents = await fetch('/api/agents').then(r => r.json()); } catch {}
  _effortCache = null;
  showToast(`Effort → ${reasoningEffort}`);
}

const SLASH_COMMANDS = [
  { cmd: '/clear',     icon: 'trash-2',    desc: 'Clear the current chat session',
    action: () => { hideSlashMenu(); $('input').value = ''; clearSession(); } },
  { cmd: '/model',     icon: 'brain',      desc: 'Change the active model' },
  { cmd: '/effort',    icon: 'gauge',      desc: 'Change reasoning effort for this agent/model' },
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
  // /effort <filter> → reasoning-effort submenu for the active agent/model
  if (/^\/effort(?:\s|$)/.test(val)) {
    const f = val.replace(/^\/effort\s*/i, '').toLowerCase();
    const agent = agents.find(a => a.id === activeAgent);
    const cached = _effortCache?.data;
    if (!cached) { _loadEfforts().then(() => updateSlashMenu()); }
    const options = cached?.options || [{ value: 'auto', label: 'Auto', description: 'Loading supported efforts…' }];
    const current = cached?.current || agent?.reasoningEffort || 'auto';
    return options
      .filter(o => !f || o.value.toLowerCase().includes(f) || (o.label || '').toLowerCase().includes(f))
      .map(o => ({
        label: `${o.label || o.value}${o.value === current ? ' ✓' : ''}`,
        desc: `${agent?.provider || ''}/${agent?.model || ''} · ${o.description || ''}`,
        action: () => {
          hideSlashMenu(); $('input').value = '';
          assignEffortToAgent(activeAgent, o.value);
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
  // /claim and /release pickers — include both roles AND user-installed
  // custom skills. Custom skills are non-service utility-category, so the
  // old `s.service` filter excluded them; users couldn't see e.g. their
  // youtube-downloader in the picker. Same shape as Settings → Skills:
  // roles (service=true) + custom skills (userScope set, non-service).
  const isAssignable = (s) =>
    s.category !== 'delegate' && !s.hidden && (s.service || (!!s.userScope && !s.service));
  const kindLabel = (s) => s.service ? 'Role' : 'Custom skill';
  if (/^\/claim\s/.test(val)) {
    const f = val.slice(7).toLowerCase();
    const cached = _skillsCache || [];
    if (!_skillsCache) { _loadSkills().then(() => updateSlashMenu()); }
    return cached
      .filter(s => isAssignable(s) && (!f || s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f)))
      .map(s => ({
        label: s.name,
        desc: `${kindLabel(s)} · ` + (s.assignment ? `claimed by ${agents.find(a=>a.id===s.assignment)?.name ?? s.assignment}` : 'unclaimed') + (s.description ? ' · ' + s.description : ''),
        action: () => { hideSlashMenu(); $('input').value = `/claim ${s.id}`; _skillsCache = null; send(); }
      }));
  }
  if (/^\/release\s/.test(val)) {
    const f = val.slice(9).toLowerCase();
    const cached = _skillsCache || [];
    if (!_skillsCache) { _loadSkills().then(() => updateSlashMenu()); }
    return cached
      .filter(s => isAssignable(s) && (!f || s.id.toLowerCase().includes(f) || s.name.toLowerCase().includes(f)))
      .map(s => ({
        label: s.name,
        desc: `${kindLabel(s)} · ` + (s.assignment ? `claimed by ${agents.find(a=>a.id===s.assignment)?.name ?? s.assignment}` : 'unclaimed'),
        action: () => { hideSlashMenu(); $('input').value = `/release ${s.id}`; _skillsCache = null; send(); }
      }));
  }
  // top-level commands
  return SLASH_COMMANDS
    .filter(c => c.cmd.startsWith(lo))
    .filter(c => c.cmd !== '/new-agent'
      || typeof canCreateAgentForCurrentMode !== 'function'
      || canCreateAgentForCurrentMode())
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

// ── @-Mention Menu ─────────────────────────────────────────────────────────
// Two modes:
//   `@<handle>`       → agent picker, completes to "@<handle> "
//   `@<kind>/<file>`  → file picker (video/audio/image), completes to
//                       "@<kind>/<exact-filename> ". Server's chat-dispatch
//                       resolves the @-tokens to absolute filesystem paths
//                       and injects them as a system note so transcribe_file
//                       (and any other path-based tool) can act on them.
let atMenuIdx = 0, atMenuItems = [];

// File-menu cache — populated lazily from /api/desktop/{videos,audio,images}.
// Invalidated on agent switch (see switchAgent). Per-folder so a slow images
// list doesn't block videos.
const _atFileCache = {};
const _AT_KIND_MAP = {
  video: 'videos', videos: 'videos',
  audio: 'audio', audios: 'audio',
  image: 'images', images: 'images', photo: 'images', photos: 'images',
};
const _AT_KIND_ICON = { videos: '🎬', audio: '🎙️', images: '🖼️' };
window.invalidateAtFileCache = () => { for (const k of Object.keys(_atFileCache)) delete _atFileCache[k]; };

async function _atFetchFileList(folder) {
  try {
    const r = await fetch(`/api/desktop/${folder}`);
    _atFileCache[folder] = r.ok ? await r.json() : [];
  } catch { _atFileCache[folder] = []; }
}

function _atGetItems(val) {
  // File-reference branch: @<kind>/<partial>
  const fileMatch = val.match(/^@(video|audio|image|images|videos|photo|photos|audios)\/(\S*)$/i);
  if (fileMatch) {
    const rawKind = fileMatch[1].toLowerCase();
    const filter = fileMatch[2].toLowerCase();
    const folder = _AT_KIND_MAP[rawKind];
    if (!folder) return [];
    if (!_atFileCache[folder]) {
      // Trigger fetch; menu repopulates on the next keystroke or via a
      // direct re-render once the fetch resolves.
      _atFetchFileList(folder).then(() => updateAtMenu());
      return [];
    }
    const icon = _AT_KIND_ICON[folder] || '📎';
    return _atFileCache[folder]
      .filter(f => !filter || f.filename.toLowerCase().includes(filter))
      .slice(0, 10)
      .map(f => ({
        label: `${icon} ${f.filename}`,
        desc: f.size ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : '',
        action: () => {
          hideAtMenu();
          const completed = `@${rawKind}/${f.filename} `;
          $('input').value = completed;
          $('input').focus();
          resizeTextarea();
          $('input').setSelectionRange(completed.length, completed.length);
        },
      }));
  }

  // Agent branch: @<handle> (no slash yet). Also surface file-kind
  // shortcuts ("video/", "audio/", "image/") so users discover the file
  // mode by typing the first letter — e.g. `@a` shows both any agent
  // whose name starts with `a` and the `audio/` kind shortcut. Picking a
  // kind drills into its file list.
  const m = val.match(/^@(\S*)$/);
  if (!m) return [];
  const filter = m[1].toLowerCase();
  const KIND_SHORTCUTS = [
    { kind: 'video', icon: '🎬', desc: 'browse videos' },
    { kind: 'audio', icon: '🎙️', desc: 'browse audio'  },
    { kind: 'image', icon: '🖼️', desc: 'browse images' },
  ];
  const kindItems = KIND_SHORTCUTS
    .filter(k => !filter || k.kind.startsWith(filter))
    .map(k => ({
      label: `${k.icon} ${k.kind}/`,
      desc: k.desc,
      action: () => {
        const completed = `@${k.kind}/`;
        $('input').value = completed;
        $('input').focus();
        $('input').setSelectionRange(completed.length, completed.length);
        // Re-fire input handler so updateAtMenu repopulates with files.
        $('input').dispatchEvent(new Event('input', { bubbles: true }));
      },
    }));
  const agentItems = agents
    .filter(a => {
      const handle = String(a.name || '').toLowerCase().replace(/\s+/g, '');
      const idSuffix = String(a.id || '').split('_').pop().toLowerCase();
      return !filter || handle.includes(filter) || idSuffix.includes(filter);
    })
    .slice(0, 10)
    .map(a => {
      const handle = String(a.name || '').toLowerCase().replace(/\s+/g, '');
      return {
        label: `${a.emoji || '🤖'} ${a.name}`,
        desc: `@${handle}`,
        action: () => {
          hideAtMenu();
          $('input').value = `@${handle} `;
          $('input').focus();
          resizeTextarea();
          $('input').setSelectionRange(handle.length + 2, handle.length + 2);
        },
      };
    });
  return [...kindItems, ...agentItems];
}

function updateAtMenu() {
  const val = $('input').value;
  if (!val.startsWith('@')) { hideAtMenu(); return; }
  atMenuItems = _atGetItems(val);
  const menu = $('atMenu');
  if (!atMenuItems.length) { hideAtMenu(); return; }
  if (atMenuIdx >= atMenuItems.length) atMenuIdx = 0;
  menu.style.display = 'block';
  menu.innerHTML = atMenuItems.map((item, i) =>
    `<div class="slash-menu-item${i === atMenuIdx ? ' active' : ''}" data-idx="${i}">
       <span class="smi-label">${escHtml(item.label)}</span>
       <span class="smi-desc">${escHtml(item.desc)}</span>
     </div>`
  ).join('');
  menu.querySelectorAll('.slash-menu-item').forEach((el, i) => {
    el.addEventListener('mousedown', e => { e.preventDefault(); atMenuItems[i]?.action(); });
  });
}

function hideAtMenu() { $('atMenu').style.display = 'none'; atMenuItems = []; atMenuIdx = 0; }
function atMenuNav(dir) {
  if (!atMenuItems.length) return;
  atMenuIdx = (atMenuIdx + dir + atMenuItems.length) % atMenuItems.length;
  updateAtMenu();
}
window.updateAtMenu = updateAtMenu;
window.hideAtMenu = hideAtMenu;
window.atMenuNav = atMenuNav;
window._atMenuItems = () => atMenuItems;
window._atMenuIdx = () => atMenuIdx;
window._atMenuAction = () => atMenuItems[atMenuIdx]?.action();

function slashMenuNav(dir) {
  if (!slashMenuItems.length) return;
  slashMenuIdx = (slashMenuIdx + dir + slashMenuItems.length) % slashMenuItems.length;
  updateSlashMenu();
}
