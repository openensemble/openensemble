// Drawer visibility UI — extracted from settings.js.
// Globals intentional.

// ── Drawers ───────────────────────────────────────────────────────────────────
let _drawerReloadTimer = null;
let _drawerReloadInFlight = null;
let _drawerReloadQueued = false;

async function loadDrawers() {
  if (_drawerReloadInFlight) {
    // Do not lose an invalidation that arrives while an earlier catalog fetch
    // is still in flight. Re-fetch once more after it settles so the browser
    // always converges on the latest committed drawer version.
    _drawerReloadQueued = true;
    return _drawerReloadInFlight;
  }
  _drawerReloadInFlight = (async () => {
    const requestedUserId = _currentUser?.id ?? null;
    const next = await fetch('/api/drawers', { cache: 'no-store' }).then(async r => {
      if (!r.ok) throw new Error(`Drawer catalog HTTP ${r.status}`);
      const value = await r.json();
      if (!Array.isArray(value)) throw new Error('Drawer catalog is not an array');
      return value;
    });
    if ((_currentUser?.id ?? null) !== requestedUserId) {
      _drawerReloadQueued = true;
      return;
    }
    await reconcileCustomDrawers(next);
    drawers = next;
    const newsDr = drawers.find(p => p.id === 'news');
    if (newsDr?.settings?.topics?.length) NEWS_TOPICS = newsDr.settings.topics;
    if (newsDr && typeof newsDr.settings?.defaultTopic === 'number') newsTopic = newsDr.settings.defaultTopic;
    mountCustomDrawers();
    applyDrawerVisibility();
    if (document.getElementById('pluginsList')) renderDrawersSettings();
  })();
  try {
    await _drawerReloadInFlight;
  } catch (e) {
    // Keep the currently-mounted, working catalog on a transient refresh
    // failure. A reconnect or later invalidation retries.
    console.warn('[drawers] catalog refresh failed:', e.message);
  } finally {
    _drawerReloadInFlight = null;
    if (_drawerReloadQueued) {
      _drawerReloadQueued = false;
      setTimeout(() => loadDrawers(), 0);
    }
  }
}

function scheduleDrawerReload({ immediate = false } = {}) {
  clearTimeout(_drawerReloadTimer);
  if (immediate) return loadDrawers();
  _drawerReloadTimer = setTimeout(() => loadDrawers(), 80);
}

// Tracks initJs execution state for custom drawers so we only run it once per open.
window._customDrawerInitJs = window._customDrawerInitJs ?? {};
window._customDrawerInitialized = window._customDrawerInitialized ?? {};
window._customDrawerCleanup = window._customDrawerCleanup ?? {};
window._customDrawerMounts = window._customDrawerMounts ?? {};
window._customDrawerAbort = window._customDrawerAbort ?? {};
window._customDrawerGeneration = window._customDrawerGeneration ?? {};
window._customDrawerInitPromise = window._customDrawerInitPromise ?? {};

function customDrawerSignature(p) {
  return JSON.stringify([
    p.version || '', p.name || '', p.icon || '', p.lucideIcon || '',
    p.drawerId || '', p.btnId || '', p.html || '', p.initJs || '',
  ]);
}

async function unmountCustomDrawer(pluginId, mounted) {
  const drawerId = mounted?.drawerId;
  const btnId = mounted?.btnId;
  if (drawerId && activeDrawerId === drawerId) closeAllDrawers();
  if (drawerId) {
    // Invalidate the old init before touching the DOM. Cooperative init code
    // receives this AbortSignal; the generation check also prevents a late
    // resolution from installing cleanup state over the replacement drawer.
    window._customDrawerGeneration[drawerId]
      = (window._customDrawerGeneration[drawerId] || 0) + 1;
    window._customDrawerAbort[drawerId]?.abort();
    const initPromise = window._customDrawerInitPromise[drawerId];
    if (initPromise) {
      try {
        await Promise.race([
          Promise.resolve(initPromise),
          new Promise(resolve => setTimeout(resolve, 1000)),
        ]);
      } catch {}
    }
  }
  const cleanup = drawerId && window._customDrawerCleanup[drawerId];
  if (typeof cleanup === 'function') {
    try { await Promise.race([Promise.resolve(cleanup()), new Promise(resolve => setTimeout(resolve, 1000))]); }
    catch (e) { console.warn(`[custom drawer ${drawerId}] cleanup error:`, e); }
  }
  if (drawerId) {
    document.getElementById(drawerId)?.remove();
    delete window._customDrawerInitJs[drawerId];
    delete window._customDrawerInitialized[drawerId];
    delete window._customDrawerCleanup[drawerId];
    delete window._customDrawerAbort[drawerId];
    delete window._customDrawerInitPromise[drawerId];
  }
  if (btnId) document.getElementById(btnId)?.remove();
  delete window._customDrawerMounts[pluginId];

  // An already-open mobile menu contains cloned sidebar buttons. Close it so
  // the next open rebuilds from the authoritative strip instead of retaining
  // a deleted or stale custom tile.
  if (typeof closeDrawer === 'function'
      && document.getElementById('drawer')?.classList.contains('open')) {
    closeDrawer();
  }
}

async function reconcileCustomDrawers(nextDrawers) {
  const nextById = new Map(
    nextDrawers.filter(p => p?.custom && p?.drawer).map(p => [p.id, p]),
  );
  for (const [pluginId, mounted] of Object.entries(window._customDrawerMounts)) {
    const next = nextById.get(pluginId);
    const domMissing = !document.getElementById(mounted.drawerId)
      || !document.getElementById(mounted.btnId);
    if (!next || mounted.signature !== customDrawerSignature(next) || domMissing) {
      await unmountCustomDrawer(pluginId, mounted);
    }
  }
}

// Build DOM for any custom (skill-builder) drawer that isn't already mounted.
function mountCustomDrawers() {
  const workspace = document.getElementById('workspace');
  const strip     = document.getElementById('sidebarStrip');
  if (!workspace || !strip) return;

  for (const p of drawers) {
    if (!p.custom || !p.drawer) continue;
    const drawerId = p.drawerId;
    const btnId    = p.btnId;
    if (!drawerId || !btnId) continue;
    const signature = customDrawerSignature(p);
    const existingMount = window._customDrawerMounts[p.id];
    if (existingMount?.signature === signature
        && document.getElementById(drawerId)
        && document.getElementById(btnId)) {
      continue;
    }

    // Prefer a lucide icon (consistent with built-in drawers). Fall back to
    // emoji. A plugin manifest can set `lucideIcon: "receipt"` etc.
    const lucideName = typeof p.lucideIcon === 'string' && p.lucideIcon.trim()
      ? p.lucideIcon.trim()
      : null;
    const iconMarkup = lucideName
      ? `<i data-lucide="${escHtml(lucideName)}"></i>`
      : `<span style="font-size:20px;line-height:1">${p.icon ?? '🔧'}</span>`;
    const hdrIconMarkup = lucideName
      ? `<span class="drawer-icon"><i data-lucide="${escHtml(lucideName)}"></i></span>`
      : `<span class="drawer-icon" style="font-size:18px">${p.icon ?? '🔧'}</span>`;

    // Sidebar button
    if (!document.getElementById(btnId)) {
      const btn = document.createElement('button');
      btn.className = 'strip-btn';
      btn.id = btnId;
      btn.title = p.name;
      // data-action, not an inline onclick attribute: CSP (script-src 'self',
      // no unsafe-inline) blocks inline handlers, which left custom drawer
      // buttons dead on desktop. Delegation matches the built-in strip buttons
      // and the mobile menu reads the same attributes.
      btn.dataset.action = 'toggleDrawer';
      btn.dataset.args = JSON.stringify([drawerId, btnId]);
      btn.innerHTML = `${iconMarkup}<span class="strip-tooltip">${escHtml(p.name)}</span>`;
      // Insert before the strip spacer so it sits with the other feature buttons.
      const spacer = strip.querySelector('.strip-spacer');
      if (spacer) strip.insertBefore(btn, spacer);
      else strip.appendChild(btn);
    }

    // Drawer panel
    if (!document.getElementById(drawerId)) {
      const div = document.createElement('div');
      div.className = 'desk-drawer';
      div.id = drawerId;
      div.innerHTML = `
        <div class="desk-drawer-hdr">
          ${hdrIconMarkup}
          <span class="drawer-label">${escHtml(p.name)}</span>
          <button class="btn-drawer-x" data-action="closeAllDrawers">✕</button>
        </div>
        <div class="desk-drawer-body">${p.html ?? ''}</div>
      `;
      workspace.appendChild(div);
    }

    if (p.initJs) window._customDrawerInitJs[drawerId] = p.initJs;
    else delete window._customDrawerInitJs[drawerId];
    window._customDrawerGeneration[drawerId]
      = (window._customDrawerGeneration[drawerId] || 0) + 1;
    window._customDrawerMounts[p.id] = { drawerId, btnId, signature };
  }

  // Materialize any new lucide icons we just injected.
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Called by drawers.js toggleDrawer when a custom drawer is opened.
// Executes initJs the first time the drawer is opened (idempotent).
function runCustomDrawerInit(drawerId) {
  if (window._customDrawerInitialized[drawerId]) return;
  const code = window._customDrawerInitJs[drawerId];
  if (!code) return;
  window._customDrawerInitialized[drawerId] = true;
  const generation = window._customDrawerGeneration[drawerId] || 0;
  const controller = new AbortController();
  window._customDrawerAbort[drawerId] = controller;
  try {
    // AsyncFunction so the init body may use top-level await (fetch, etc.)
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    // `signal` and `drawerId` are optional backwards-compatible arguments.
    // New drawers should pass signal to fetch and check signal.aborted after
    // awaits so a hot update cannot let stale work touch replacement DOM.
    const fn = new AsyncFunction('signal', 'drawerId', code);
    const initPromise = Promise.resolve(fn(controller.signal, drawerId))
      .then(cleanup => {
        if (window._customDrawerGeneration[drawerId] !== generation) {
          if (typeof cleanup === 'function') {
            return Promise.race([
              Promise.resolve(cleanup()),
              new Promise(resolve => setTimeout(resolve, 1000)),
            ]).catch(e => console.warn(`[custom drawer ${drawerId}] stale cleanup error:`, e));
          }
          return;
        }
        if (typeof cleanup === 'function') window._customDrawerCleanup[drawerId] = cleanup;
        // Materialize any `data-lucide` icons the init code rendered.
        if (typeof lucide !== 'undefined') lucide.createIcons();
      })
      .catch(e => {
        if (window._customDrawerGeneration[drawerId] === generation) {
          delete window._customDrawerInitialized[drawerId];
        }
        console.error(`[custom drawer ${drawerId}] initJs error:`, e);
      })
      .finally(() => {
        if (window._customDrawerInitPromise[drawerId] === initPromise) {
          delete window._customDrawerInitPromise[drawerId];
        }
      });
    window._customDrawerInitPromise[drawerId] = initPromise;
  } catch (e) {
    if (window._customDrawerGeneration[drawerId] === generation) {
      delete window._customDrawerInitialized[drawerId];
    }
    console.error(`[custom drawer ${drawerId}] initJs compile error:`, e);
  }
}

function applyDrawerVisibility() {
  for (const p of drawers) {
    if (!p.drawer) continue;
    const drawerId = p.drawerId ?? `drawer${p.id.charAt(0).toUpperCase() + p.id.slice(1)}`;
    const btnId    = p.btnId    ?? `sbtn${p.id.charAt(0).toUpperCase() + p.id.slice(1)}`;
    const drawer = $(drawerId), btn = $(btnId);
    if (drawer) drawer.style.display = p.enabled ? '' : 'none';
    if (btn)    btn.style.display    = p.enabled ? '' : 'none';
    if (!p.enabled && activeDrawerId === drawerId) closeAllDrawers();
    // Hide the matching settings tab when the feature is disabled
    const tabBtn = $(`stab-${p.id}`);
    if (tabBtn) tabBtn.style.display = p.enabled ? '' : 'none';
  }
  // Tasks tab also shows when inbox (email role) is enabled — for Gmail auto-label
  const inboxEnabled = drawers.some(p => p.id === 'inbox' && p.enabled);
  const tasksTabBtn = $('stab-tasks');
  if (tasksTabBtn && inboxEnabled) tasksTabBtn.style.display = '';
}

function renderDrawersSettings() {
  const el = $('pluginsList');
  if (!el || !drawers.length) return;
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  el.innerHTML = drawers.filter(p => isPriv || !p.adminBlocked).map(p => {
    const inner = p.enabled && p.id === 'news' ? `
      <div style="display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--border);padding-top:10px;margin-top:8px">
        ${renderNewsTopicsEditor(p)}
      </div>` : '';
    return `<div style="background:var(--bg3);border-radius:10px;padding:12px">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:20px;flex-shrink:0">${p.icon ?? '🔌'}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--text)">${escHtml(p.name)}</div>
          ${p.description ? `<div style="font-size:11px;color:var(--muted)">${escHtml(p.description)}</div>` : ''}
        </div>
        <label style="display:flex;align-items:center;gap:6px;flex-shrink:0;cursor:pointer">
          <input type="checkbox" ${p.enabled ? 'checked' : ''} data-change-action="toggleDrawerPlugin" data-change-args='${JSON.stringify([p.id, "$checked"]).replace(/'/g, "&#39;")}'
            style="width:16px;height:16px;cursor:pointer;accent-color:var(--accent)">
        </label>
      </div>
      ${inner}
    </div>`;
  }).join('');
}

function renderNewsTopicsEditor(p) {
  const topics = p.settings?.topics ?? [];
  const def    = p.settings?.defaultTopic ?? 0;
  const topicOpts = topics.map((t, i) =>
    `<option value="${i}" ${i === def ? 'selected' : ''}>${escHtml(t.label)}</option>`).join('');
  const rows = topics.map((t, i) => `
    <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border)">
      <input value="${escHtml(t.label)}" placeholder="Label"
        style="width:80px;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 6px;font-size:11px"
        data-change-action="updateDrawerTopic" data-change-args='${JSON.stringify(['news', i, 'label', "$value"]).replace(/'/g, "&#39;")}'>
      <input value="${escHtml(t.q)}" placeholder="Search query"
        style="flex:1;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 6px;font-size:11px"
        data-change-action="updateDrawerTopic" data-change-args='${JSON.stringify(['news', i, 'q', "$value"]).replace(/'/g, "&#39;")}'>
      <button data-action="removeDrawerTopic" data-args='${JSON.stringify(['news', i]).replace(/'/g, "&#39;")}'
        style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:0 4px">×</button>
    </div>`).join('');
  return `
    <div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:11px;color:var(--muted);width:100px;flex-shrink:0">Default tab</span>
        <select id="newsDefaultTopicSelect" data-change-action="_saveNewsTopicPrefInt" data-change-args='["$value"]'
          style="flex:1;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 8px;font-size:12px">
          ${topicOpts}
        </select>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Topics</div>
      <div id="newsTopicsRows">${rows}</div>
      <button data-action="addDrawerTopic" data-args='["news"]'
        style="margin-top:8px;background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer">+ Add Topic</button>
    </div>`;
}

// Wrapper for the news default-topic select — original inline handler did
// `saveNewsTopicPref(parseInt(this.value))`, but data-args resolves $value
// to a string. parseInt at the boundary keeps the called fn unchanged.
function _saveNewsTopicPrefInt(value) { saveNewsTopicPref(parseInt(value, 10)); }

async function toggleDrawerPlugin(drawerId, enabled) {
  try {
    await postJson('/api/drawers/toggle', { pluginId: drawerId, enabled });
    const idx = drawers.findIndex(p => p.id === drawerId);
    if (idx !== -1) drawers[idx].enabled = enabled;
    applyDrawerVisibility();
    renderDrawersSettings();
  } catch (e) {
    showToast(e.message || 'Failed to update plugin');
    renderDrawersSettings(); // revert the checkbox to the persisted state
  }
}

async function saveDrawerSetting(drawerId, key, value) {
  const p = drawers.find(pl => pl.id === drawerId);
  if (p) { p.settings = p.settings ?? {}; p.settings[key] = value; }
  if (drawerId === 'news' && key === 'defaultTopic') newsTopic = value;
  if (drawerId === 'news' && key === 'topics') NEWS_TOPICS = value;
  try {
    await fetch(`/api/drawers/${drawerId}/settings`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    });
  } catch {}
}

function updateDrawerTopic(drawerId, idx, field, value) {
  const p = drawers.find(pl => pl.id === drawerId);
  if (!p?.settings?.topics) return;
  p.settings.topics[idx][field] = value;
  clearTimeout(updateDrawerTopic._t);
  updateDrawerTopic._t = setTimeout(() => saveDrawerSetting(drawerId, 'topics', p.settings.topics), 600);
}

function removeDrawerTopic(drawerId, idx) {
  const p = drawers.find(pl => pl.id === drawerId);
  if (!p?.settings?.topics) return;
  p.settings.topics.splice(idx, 1);
  saveDrawerSetting(drawerId, 'topics', p.settings.topics);
  renderDrawersSettings();
}

function addDrawerTopic(drawerId) {
  const p = drawers.find(pl => pl.id === drawerId);
  if (!p) return;
  p.settings = p.settings ?? {};
  p.settings.topics = p.settings.topics ?? [];
  p.settings.topics.push({ label: 'New', q: 'news today' });
  saveDrawerSetting(drawerId, 'topics', p.settings.topics);
  renderDrawersSettings();
}
