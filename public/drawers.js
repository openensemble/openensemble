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
  if (drawerId === 'drawerNotes') openNotesDrawer();
  if (drawerId === 'drawerMessages') openMessagesDrawer();
  if (drawerId === 'drawerExpenses') openExpensesDrawer();
  if (drawerId === 'drawerDashboard') loadDashboard();
  if (drawerId === 'drawerNodes') loadNodes();

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

// ── Mobile drawer ─────────────────────────────────────────────────────────────
function openDrawer()  { $('drawer').classList.add('open'); $('drawerBackdrop').classList.add('open'); }
function closeDrawer() { $('drawer').classList.remove('open'); $('drawerBackdrop').classList.remove('open'); }
$('btnMenu').addEventListener('click', openDrawer);
$('btnDrawerClose').addEventListener('click', closeDrawer);
$('drawerBackdrop').addEventListener('click', closeDrawer);



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
