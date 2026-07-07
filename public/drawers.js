// ── Desk drawers ──────────────────────────────────────────────────────────────
let activeDrawerId = null;

function toggleDrawer(drawerId, btnId) {
  if (activeDrawerId === drawerId) {
    closeAllDrawers();
    return;
  }
  closeAllDrawers(false);
  activeDrawerId = drawerId;
  $(drawerId).classList.add('open');
  $('drawerOverlay').classList.add('open');
  if (btnId) $(btnId).classList.add('active');

  // Side effects when opening specific drawers
  if (drawerId === 'drawerInbox') loadInboxPreview();
  if (drawerId === 'drawerNews') loadNews();
  if (drawerId === 'drawerMarkets') loadMarkets();
  if (drawerId === 'drawerTutorToday' && typeof loadTutorToday === 'function') loadTutorToday();
  if (drawerId === 'drawerSettings') openSettingsDrawer(false);
  if (drawerId === 'drawerTasks') openTasksDrawer(false);
  if (drawerId === 'drawerLearn' && typeof loadLearnDrawer === 'function') loadLearnDrawer();
  if (drawerId === 'drawerRunInspector' && typeof loadRunInspector === 'function') loadRunInspector();
  if (drawerId === 'drawerMemoryControl' && typeof loadMemoryControl === 'function') loadMemoryControl();
  if (drawerId === 'drawerSkillPermissions' && typeof loadSkillPermissions === 'function') loadSkillPermissions();
  if (drawerId === 'drawerNotes') openNotesDrawer();
  if (drawerId === 'drawerMessages') openMessagesDrawer();
  if (drawerId === 'drawerExpenses') openExpensesDrawer();
  if (drawerId === 'drawerDashboard') loadDashboard();
  if (drawerId === 'drawerNodes') loadNodes();
  if (drawerId === 'drawerDevices' && typeof loadDevices === 'function') loadDevices();
  if (drawerId === 'drawerGuide') openGuideDrawer();

  // Custom (skill-builder) drawers: run the manifest's initJs once per session.
  if (drawerId.startsWith('drawer_') && typeof runCustomDrawerInit === 'function') {
    runCustomDrawerInit(drawerId);
  }
}

function closeAllDrawers(resetActive = true) {
  const wasMessages = activeDrawerId === 'drawerMessages';
  document.querySelectorAll('.desk-drawer.open').forEach(d => d.classList.remove('open'));
  $('drawerOverlay').classList.remove('open');
  document.querySelectorAll('.strip-btn.active').forEach(b => b.classList.remove('active'));
  if (resetActive) activeDrawerId = null;
  if (wasMessages && typeof closeMessagesDrawer === 'function') closeMessagesDrawer();
}

// ── Mobile menu (bottom sheet) ────────────────────────────────────────────────
// Rebuilt from the sidebar strip on every open so mobile always mirrors
// desktop exactly: feature gating (applyDrawerVisibility), custom skill
// drawers (mountCustomDrawers), badges and alert dots all carry over without
// a second hand-maintained list that can drift.

// Utility strip buttons that get their own dedicated rows in the sheet.
const MOBILE_MENU_SKIP = new Set(['sbtnClear', 'sbtnSearch', 'sbtnLayout']);

function _stripBtnLabel(btn) {
  return btn.dataset.tipLabel
    || btn.querySelector('.strip-tooltip')?.textContent?.trim()
    || btn.getAttribute('title') || '';
}

function buildMobileMenu() {
  const body = $('mobileMenuBody');
  if (!body) return;
  body.innerHTML = '';

  // Profile row — mirrors the strip user button (emoji or avatar image).
  const prof = document.createElement('button');
  prof.className = 'mm-profile';
  const avatar = document.createElement('span');
  avatar.className = 'mm-avatar';
  avatar.innerHTML = $('stripUserEmoji')?.innerHTML || '🧑';
  const userBg = $('stripUserBtn')?.style.background;
  if (userBg) avatar.style.background = userBg;
  const profName = document.createElement('span');
  profName.className = 'mm-profile-name';
  profName.textContent = (typeof _currentUser !== 'undefined' && _currentUser?.name) || 'Profile';
  const profHint = document.createElement('span');
  profHint.className = 'mm-profile-hint';
  profHint.textContent = 'Switch profile';
  prof.append(avatar, profName, profHint);
  prof.dataset.action = '_closeDrawerThen';
  prof.dataset.args = '["openUserPicker"]';
  body.appendChild(prof);

  // Feature grid mirrored from the sidebar strip (built-in + custom drawers).
  const grid = document.createElement('div');
  grid.className = 'mm-grid';
  document.querySelectorAll('#sidebarStrip .strip-btn').forEach(btn => {
    if (MOBILE_MENU_SKIP.has(btn.id)) return;
    if (btn.style.display === 'none') return; // feature disabled or role-gated
    const tile = document.createElement('button');
    tile.className = 'mm-tile';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'mm-tile-icon';
    const icon = btn.querySelector('svg, [data-lucide], span:not(.strip-tooltip):not(.strip-badge):not(.strip-btn-alert):not(.session-dot)');
    if (icon) iconWrap.appendChild(icon.cloneNode(true));
    const label = document.createElement('span');
    label.className = 'mm-tile-label';
    label.textContent = _stripBtnLabel(btn);
    tile.append(iconWrap, label);
    const srcBadge = btn.querySelector('.strip-badge');
    if (srcBadge && srcBadge.style.display !== 'none' && srcBadge.textContent) {
      const b = document.createElement('span');
      b.className = 'mm-tile-badge';
      b.textContent = srcBadge.textContent;
      tile.appendChild(b);
    }
    const srcAlert = btn.querySelector('.strip-btn-alert');
    if (srcAlert && srcAlert.style.display !== 'none') {
      const a = document.createElement('span');
      a.className = 'mm-tile-alert';
      tile.appendChild(a);
    }
    // Tiles carry data-action so the document-level delegation handles the
    // tap — same proven path as the strip buttons themselves. A real tap's
    // click can land on a re-rendered node or a container; attributes are
    // read wherever it lands, unlike .onclick properties on dead nodes.
    if (btn.dataset.action === 'toggleDrawer' && btn.dataset.args) {
      tile.dataset.action = '_closeAndToggleDrawer';
      tile.dataset.args = btn.dataset.args;
      if (btn.id) tile.dataset.srcBtn = btn.id;
    } else {
      // Custom skill drawers mount with onclick="toggleDrawer('id','btnId')".
      const m = (btn.getAttribute('onclick') || '').match(/toggleDrawer\('([^']+)'\s*,\s*'([^']+)'\)/);
      if (m) {
        tile.dataset.action = '_closeAndToggleDrawer';
        tile.dataset.args = JSON.stringify([m[1], m[2]]);
        tile.dataset.srcBtn = m[2];
      } else {
        tile.onclick = () => { closeDrawer(); btn.click(); }; // last resort
      }
    }
    grid.appendChild(tile);
  });
  body.appendChild(grid);

  // Quick actions — all data-action driven (see tile comment above).
  const rows = document.createElement('div');
  rows.className = 'mm-rows';
  const addRow = (iconName, text, action, args, cls = '') => {
    const r = document.createElement('button');
    r.className = 'mm-row' + (cls ? ' ' + cls : '');
    r.innerHTML = `<span class="mm-row-icon"><i data-lucide="${iconName}"></i></span><span class="mm-row-label">${escHtml(text)}</span>`;
    r.dataset.action = action;
    if (args) r.dataset.args = args;
    rows.appendChild(r);
    return r;
  };
  addRow('search', 'Search conversations', '_closeDrawerThen', '["openSearch"]');
  addRow('sparkles', 'New agent', '_closeDrawerThen', '["openNewAgentModal"]');
  const upd = $('updateBadge');
  if (upd && upd.style.display !== 'none') {
    addRow('download-cloud', 'Update available — install', '_sheetOpenUpdate', null, 'update');
  }
  const clearRow = addRow('trash-2', 'Clear session', '_closeDrawerThen', '["clearSession"]', 'danger');
  const srcDot = $('sessionDot');
  if (srcDot && /warn|alert/.test(srcDot.className)) {
    const d = document.createElement('span');
    d.className = srcDot.className; // session-dot warn|alert
    d.style.cssText = 'position:static;margin-left:auto';
    clearRow.appendChild(d);
    clearRow.title = srcDot.title || '';
  }
  addRow('log-out', 'Sign out', '_closeDrawerThen', '["logout"]', 'danger');
  body.appendChild(rows);

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// data-action targets for sheet rows that need more than one call.
function _sheetOpenUpdate() {
  closeDrawer();
  if (typeof _openSettingsTab === 'function') _openSettingsTab('system');
}
function _sheetSwitchAgent(id) {
  closeDrawer();
  if (typeof switchAgent === 'function') switchAgent(id);
}

// Agent switcher — same bottom sheet, different content: a grid of agents to
// jump between, opened from the bottom bar.
function buildAgentSheet() {
  const body = $('mobileMenuBody');
  if (!body) return;
  body.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'mm-sheet-title';
  title.textContent = 'Switch agent';
  body.appendChild(title);

  const grid = document.createElement('div');
  grid.className = 'mm-grid mm-agent-grid';
  const list = (typeof agents !== 'undefined' && Array.isArray(agents)) ? agents : [];
  list.forEach(a => {
    const tile = document.createElement('button');
    tile.className = 'mm-tile mm-agent' + (a.id === activeAgent ? ' active' : '');
    tile.dataset.action = '_sheetSwitchAgent';
    tile.dataset.args = JSON.stringify([a.id]);
    tile.dataset.agentId = a.id;
    const em = document.createElement('span');
    em.className = 'mm-agent-emoji';
    em.textContent = a.emoji ?? '🤖';
    const label = document.createElement('span');
    label.className = 'mm-tile-label';
    label.textContent = a.name;
    tile.append(em, label);
    if (typeof agentStreams !== 'undefined' && agentStreams[a.id]?.active) {
      const busy = document.createElement('span');
      busy.className = 'busy-dot';
      tile.appendChild(busy);
    }
    grid.appendChild(tile);
  });
  body.appendChild(grid);

  const rows = document.createElement('div');
  rows.className = 'mm-rows';
  const addRow = (iconName, text, action, args) => {
    const r = document.createElement('button');
    r.className = 'mm-row';
    r.innerHTML = `<span class="mm-row-icon"><i data-lucide="${iconName}"></i></span><span class="mm-row-label">${escHtml(text)}</span>`;
    r.dataset.action = action;
    if (args) r.dataset.args = args;
    rows.appendChild(r);
  };
  addRow('sparkles', 'New agent', '_closeDrawerThen', '["openNewAgentModal"]');
  addRow('bot', 'Manage agents', '_closeAndToggleDrawer', '["drawerAgents","sbtnAgents"]');
  body.appendChild(rows);

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ── Sheet open/close + touch dismissal ────────────────────────────────────────
// _sheetBuilder remembers what the sheet is showing so live refreshes (badge
// changes, agent stream updates) rebuild the right content.
let _sheetBuilder = null;

function _openSheet(builder) {
  _sheetBuilder = builder;
  builder();
  $('drawer').classList.add('open');
  $('drawerBackdrop').classList.add('open');
}
function openDrawer()     { _openSheet(buildMobileMenu); }
function openAgentSheet() { _openSheet(buildAgentSheet); }
function closeDrawer() {
  _sheetBuilder = null;
  $('drawer').classList.remove('open');
  $('drawerBackdrop').classList.remove('open');
}
// In-place patches for an OPEN sheet. Never rebuild while open: replacing
// nodes mid-tap breaks the browser's tap→click synthesis (touchstart and
// touchend must land on the same node), which reads as dead buttons.
function refreshAgentSheetIfOpen() {
  if (_sheetBuilder !== buildAgentSheet || !$('drawer').classList.contains('open')) return;
  document.querySelectorAll('#mobileMenuBody .mm-agent').forEach(tile => {
    const id = tile.dataset.agentId;
    tile.classList.toggle('active', typeof activeAgent !== 'undefined' && id === activeAgent);
    const busy = typeof agentStreams !== 'undefined' && agentStreams[id]?.active;
    const dot = tile.querySelector('.busy-dot');
    if (busy && !dot) {
      const d = document.createElement('span');
      d.className = 'busy-dot';
      tile.appendChild(d);
    } else if (!busy && dot) dot.remove();
  });
}

function _syncMenuBadges() {
  if (_sheetBuilder !== buildMobileMenu || !$('drawer').classList.contains('open')) return;
  document.querySelectorAll('#mobileMenuBody .mm-tile[data-src-btn]').forEach(tile => {
    const btn = $(tile.dataset.srcBtn);
    if (!btn) return;
    const srcBadge = btn.querySelector('.strip-badge');
    const want = (srcBadge && srcBadge.style.display !== 'none' && srcBadge.textContent) ? srcBadge.textContent : null;
    let b = tile.querySelector('.mm-tile-badge');
    if (want && !b) {
      b = document.createElement('span');
      b.className = 'mm-tile-badge';
      tile.appendChild(b);
    }
    if (want) b.textContent = want;
    else if (b) b.remove();
    const srcAlert = btn.querySelector('.strip-btn-alert');
    const alertOn = srcAlert && srcAlert.style.display !== 'none';
    let a = tile.querySelector('.mm-tile-alert');
    if (alertOn && !a) {
      a = document.createElement('span');
      a.className = 'mm-tile-alert';
      tile.appendChild(a);
    } else if (!alertOn && a) a.remove();
  });
}

$('btnMenu').addEventListener('click', openDrawer);

// Dismissal has to survive real fingers, not just perfect clicks: a tap that
// drifts a few pixels never becomes a `click`, so the backdrop closes on
// pointerdown (preventDefault suppresses the compatibility click that would
// otherwise ghost-hit whatever is underneath), and the grabber supports both
// tap and drag-to-dismiss.
$('drawerBackdrop').addEventListener('pointerdown', e => { e.preventDefault(); closeDrawer(); });
$('drawerBackdrop').addEventListener('click', closeDrawer); // keyboard/AT fallback
$('btnDrawerClose').addEventListener('click', closeDrawer); // keyboard/AT fallback

(function () {
  const sheet = $('drawer');
  const grabber = $('btnDrawerClose');
  if (!sheet || !grabber) return;
  let startY = null, dragY = 0;
  grabber.addEventListener('pointerdown', e => {
    e.preventDefault(); // suppress the trailing click; pointerup decides
    startY = e.clientY; dragY = 0;
    try { grabber.setPointerCapture(e.pointerId); } catch {}
    sheet.style.transition = 'none';
  });
  grabber.addEventListener('pointermove', e => {
    if (startY === null) return;
    dragY = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dragY}px)`;
  });
  const finish = commit => {
    if (startY === null) return;
    sheet.style.transition = '';
    sheet.style.transform = '';
    // A still tap (<8px) or a decisive pull (>72px) closes; between springs back.
    if (commit && (dragY < 8 || dragY > 72)) closeDrawer();
    startY = null; dragY = 0;
  };
  grabber.addEventListener('pointerup', () => finish(true));
  grabber.addEventListener('pointercancel', () => finish(false));
})();

// Aggregate attention dot on the ⋮ button: lights up when any strip badge or
// alert is visible, the session is running long, or an update is available —
// signals that desktop shows in the (mobile-hidden) strip and status bar.
(function () {
  const menuDot = $('menuAttentionDot');
  if (!menuDot) return;
  function refresh() {
    let on = false;
    document.querySelectorAll('#sidebarStrip .strip-badge, #sidebarStrip .strip-btn-alert').forEach(el => {
      if (el.style.display !== 'none' && el.closest('.strip-btn')?.style.display !== 'none') on = true;
    });
    const upd = $('updateBadge');
    if (upd && upd.style.display !== 'none') on = true;
    const sd = $('sessionDot');
    if (sd && /warn|alert/.test(sd.className)) on = true;
    menuDot.style.display = on ? '' : 'none';
    // Patch badges into the open sheet in place — never rebuild it (see
    // refreshAgentSheetIfOpen comment).
    _syncMenuBadges();
  }
  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; refresh(); });
  });
  const strip = $('sidebarStrip');
  if (strip) obs.observe(strip, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class'] });
  const upd = $('updateBadge');
  if (upd) obs.observe(upd, { attributes: true, attributeFilter: ['style'] });
  refresh();
})();



// ── Sidebar strip tooltips (body-level, bypasses all z-index stacking issues) ──
(function () {
  const tip = document.createElement('div');
  tip.style.cssText = [
    'position:fixed', 'z-index:9999', 'pointer-events:none',
    'background:var(--bg3)', 'border:1px solid var(--border)',
    'border-radius:6px', 'padding:4px 8px', 'font-size:12px',
    'color:var(--text)', 'white-space:nowrap',
    'opacity:0', 'transition:opacity .15s',
  ].join(';');
  document.body.appendChild(tip);

  function showTip(btn) {
    const text = btn.dataset.tipLabel;
    if (!text) return;
    const r = btn.getBoundingClientRect();
    tip.textContent = text;
    tip.style.left = (r.right + 8) + 'px';
    tip.style.top  = Math.round(r.top + r.height / 2) + 'px';
    tip.style.transform = 'translateY(-50%)';
    tip.style.opacity = '1';
  }
  function hideTip() { tip.style.opacity = '0'; }

  document.querySelectorAll('.strip-btn, .strip-user-btn').forEach(btn => {
    // Stash label from .strip-tooltip span or title attr, then remove title so
    // the browser's native tooltip doesn't double-show alongside ours.
    const label = btn.querySelector('.strip-tooltip')?.textContent?.trim() || btn.getAttribute('title') || '';
    btn.dataset.tipLabel = label;
    btn.removeAttribute('title');
    btn.addEventListener('mouseenter', () => showTip(btn));
    btn.addEventListener('mouseleave', hideTip);
    btn.addEventListener('click', hideTip);
  });
})();
