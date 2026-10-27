// ── Workspace View ────────────────────────────────────────────────────────────
let _desktopLoaded = false;
let _currentDesktopView = 'chat'; // 'chat' or 'desktop'
let _desktopCategorySeq = 0;
let _desktopSelection = null;

// Dashboard has two entry points (the main view switcher and the left rail),
// but one canonical drawer/studio. Keep both view switchers aligned with that
// drawer while retaining the older files/widgets surface as Workspace.
function syncPrimaryViewToggle() {
  const dashboardOpen = typeof activeDrawerId !== 'undefined'
    && activeDrawerId === 'drawerDashboard';
  const mailOpen = typeof mailWorkspaceIsOpen === 'function' && mailWorkspaceIsOpen();
  const desktopActive = !dashboardOpen && !mailOpen && _currentDesktopView === 'desktop';
  const chatActive = !dashboardOpen && !desktopActive && !mailOpen;
  $('viewBtnChat')?.classList.toggle('active', chatActive);
  $('mViewChat')?.classList.toggle('active', chatActive);
  $('viewBtnDashboard')?.classList.toggle('active', dashboardOpen);
  $('mViewDashboard')?.classList.toggle('active', dashboardOpen);
  $('viewBtnDesktop')?.classList.toggle('active', desktopActive);
  $('mViewDesktop')?.classList.toggle('active', desktopActive);
}

function switchView(mode, keepMail = false) {
  if (mode !== 'chat' && mode !== 'desktop') return;
  if (!keepMail && typeof mailWorkspaceIsOpen === 'function' && mailWorkspaceIsOpen()) {
    closeMailWorkspace().then(() => { if (!mailWorkspaceIsOpen()) switchView(mode); }).catch(error => showToast(error.message));
    return;
  }
  _currentDesktopView = mode;
  if (typeof activeDrawerId !== 'undefined' && activeDrawerId === 'drawerDashboard') {
    closeAllDrawers();
  }
  const chatArea = document.querySelector('.chat-area');
  const inputArea = document.querySelector('.input-area');
  const desktopView = $('desktopView');

  if (mode === 'desktop') {
    if (typeof closeChatAgents === 'function') closeChatAgents(false);
    chatArea.style.display = 'none';
    inputArea.style.display = 'none';
    desktopView.style.display = 'block';
    const pill = $('agentPill'); if (pill) pill.style.display = 'none';
    // Always reset to the top-level categories+board view on entry, so the
    // previous session's "items" drawer (e.g. Code Projects list) doesn't leak
    // through when the user toggles back to desktop mode.
    _desktopLoaded = true;
    showDesktopCategories();
  } else {
    chatArea.style.display = '';
    inputArea.style.display = '';
    desktopView.style.display = 'none';
    const pill = $('agentPill'); if (pill) pill.style.display = '';
  }
  syncPrimaryViewToggle();
}

// ── Category definitions ─────────────────────────────────────────────────────
const DESKTOP_CATEGORIES = [
  { type: 'documents', icon: '📄', label: 'Documents', color: 'rgba(74,158,255,.12)', fetchCount: fetchDocCount },
  { type: 'images',    icon: '🖼️', label: 'Images',    color: 'rgba(255,152,0,.12)',  fetchCount: fetchImageCount },
  { type: 'videos',    icon: '🎬', label: 'Videos',    color: 'rgba(233,30,99,.12)',  fetchCount: fetchVideoCount },
  { type: 'tutoring',  icon: '🎓', label: 'Tutoring',  color: 'rgba(156,39,176,.12)', fetchCount: fetchTutorCount },
  { type: 'code',      icon: '💻', label: 'Code Projects', color: 'rgba(38,166,154,.12)', fetchCount: fetchCodeProjectCount },
];

async function fetchDocCount() {
  try { const r = await fetch('/api/research'); const d = await r.json(); return { count: d.length, items: d }; }
  catch { return { count: 0, items: [] }; }
}

async function fetchImageCount() {
  const items = await fetchDesktopMedia('images');
  return { count: items.length, items };
}

async function fetchVideoCount() {
  const items = await fetchDesktopMedia('videos');
  return { count: items.length, items };
}

async function fetchDesktopMedia(type) {
  const userId = getCurrentUserId();
  const response = await fetch(`/api/desktop/${type}`);
  if (!response.ok) throw new Error('Unable to load media.');
  const items = await response.json();
  let documents = [];
  // Shared uploads appear in the media gallery too, but their stored filenames
  // are document IDs. Preserve that identity for preview, download and delete.
  if (items.some(item => item.sharedBy)) {
    const uploaded = await fetch('/api/shared-docs');
    if (!uploaded.ok) throw new Error('Unable to identify uploaded media.');
    documents = await uploaded.json();
  }
  if (userId !== getCurrentUserId()) throw new Error('Account changed. Reopen this category.');
  const mime = type === 'images' ? 'image/' : 'video/';
  return items.map(item => {
    const doc = item.sharedBy && documents.find(doc => doc.filename === item.filename && doc.uploadedBy === item.sharedBy && doc.mimeType?.startsWith(mime));
    return { ...item, documentId: doc?.id, isOwn: doc ? doc.isOwn : !item.sharedBy || item.sharedBy === userId };
  });
}

function desktopMediaDocument(item, type) {
  return { ...item, id: item.documentId, _source: item.documentId ? 'document' : type === 'images' ? 'ai-image' : 'ai-video',
    isOwn: item.isOwn ?? (!item.sharedBy || item.sharedBy === getCurrentUserId()), _sharedOwnerId: item.sharedBy };
}

function desktopMediaUrl(item, type, download = false) {
  const token = encodeURIComponent(getMediaTokenSync());
  return item.documentId
    ? `/api/shared-docs/${encodeURIComponent(item.documentId)}/${download ? 'download' : 'view'}?token=${token}`
    : `/api/desktop/${type}/${encodeURIComponent(item.filename)}?token=${token}`;
}

async function fetchTutorCount() {
  try { const r = await fetch('/api/desktop/tutor-subjects'); const d = await r.json(); return { count: d.length, items: d }; }
  catch { return { count: 0, items: [] }; }
}

// ── Render categories ────────────────────────────────────────────────────────
async function loadDesktopCategories() {
  const container = $('desktopCategories');
  container.innerHTML = DESKTOP_CATEGORIES.map(c =>
    `<div class="desktop-cat-card" id="desktopCat_${c.type}" data-action="openDesktopCategory" data-args='${JSON.stringify([c.type]).replace(/'/g, "&#39;")}'>
      <div class="desktop-cat-icon" style="background:${c.color}">${c.icon}</div>
      <div class="desktop-cat-info">
        <div class="desktop-cat-name">${c.label}</div>
        <div class="desktop-cat-count" id="desktopCount_${c.type}">Loading…</div>
      </div>
    </div>`
  ).join('');
  lucide.createIcons();

  // Fetch counts in parallel
  const results = await Promise.allSettled(DESKTOP_CATEGORIES.map(c => c.fetchCount()));
  DESKTOP_CATEGORIES.forEach((c, i) => {
    const el = $(`desktopCount_${c.type}`);
    if (!el) return;
    const val = results[i].status === 'fulfilled' ? results[i].value : { count: 0 };
    el.textContent = `${val.count} item${val.count !== 1 ? 's' : ''}`;
  });
}

// ── Open a category ──────────────────────────────────────────────────────────
async function openDesktopCategory(type) {
  const cat = DESKTOP_CATEGORIES.find(c => c.type === type);
  if (!cat) return;
  resetDesktopSelection();
  const seq = _desktopCategorySeq;

  $('desktopCategories').style.display = 'none';
  $('desktopBoard').style.display = 'none';
  $('desktopItems').style.display = 'flex';
  $('desktopItemsTitle').textContent = cat.label;

  const grid = $('desktopItemsGrid');
  grid.innerHTML = '<div style="color:var(--muted);padding:20px">Loading…</div>';
  grid.className = 'desktop-items-grid ' + (type === 'images' ? 'gallery-mode' : 'list-mode');

  try {
    const data = await cat.fetchCount();
    if (seq !== _desktopCategorySeq) return;
    if (data.count === 0) {
      grid.innerHTML = `<div class="desktop-empty">
        <div class="empty-icon">${cat.icon}</div>
        <div>No ${cat.label.toLowerCase()} yet</div>
      </div>`;
      return;
    }

    switch (type) {
      case 'documents': renderDocumentItems(grid, data.items); break;
      case 'images':    renderImageItems(grid, data.items); break;
      case 'videos':    renderVideoItems(grid, data.items); break;
      case 'tutoring':  renderTutorItems(grid, data.items); break;
      case 'code':      renderCodeProjectItems(grid, data.items); break;
    }
  } catch (e) {
    console.error('Desktop category error:', type, e);
    grid.innerHTML = `<div style="color:var(--red);padding:20px">Failed to load ${cat.label.toLowerCase()}.</div>`;
  }
}

function showDesktopCategories() {
  resetDesktopSelection();
  $('desktopItems').style.display = 'none';
  $('desktopCategories').style.display = 'flex';
  $('desktopBoard').style.display = '';
  // Refresh counts + board
  loadDesktopCategories();
  loadDesktopBoard();
}

function resetDesktopSelection() {
  ++_desktopCategorySeq;
  _desktopSelection = null;
  if ($('desktopSelectionBar')) $('desktopSelectionBar').hidden = true;
}

// Use the rendered order for ranges, including both endpoints. Previews remain
// separate buttons so selecting files never requires opening a modal.
function setupDesktopSelection(grid, type, items) {
  const state = _desktopSelection = {
    type, items, selected: new Set(), anchor: null, busy: false, status: '',
    userId: getCurrentUserId(),
  };
  $('desktopSelectionBar').hidden = false;
  [...grid.children].forEach((card, index) => {
    const item = items[index];
    card.dataset.desktopIndex = index;
    const label = document.createElement('label');
    label.className = 'desktop-item-select';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.setAttribute('aria-label', `Select ${item.filename}`);
    label.append(check, document.createTextNode(' Select'));
    card.prepend(label);
    check.addEventListener('click', event => {
      event.stopPropagation();
      toggleDesktopItem(index, check.checked, event.shiftKey);
    });
    label.addEventListener('click', event => event.stopPropagation());
    const action = card.dataset.action;
    if (action) {
      const button = document.createElement('button');
      button.className = 'desktop-item-preview'; button.textContent = 'Preview';
      button.dataset.action = action; button.dataset.args = card.dataset.args;
      button.setAttribute('aria-label', `Preview ${item.filename}`);
      card.append(button);
    }
    card.addEventListener('click', event => {
      if (event.target.closest('button, a, input, label, audio')) return;
      if (state.busy) { event.preventDefault(); event.stopPropagation(); return; }
      if (event.shiftKey || event.ctrlKey || event.metaKey || state.selected.size) {
        event.preventDefault(); event.stopPropagation();
        toggleDesktopItem(index, !state.selected.has(index), event.shiftKey);
      } else if (action) state.anchor = index;
    });
  });
  syncDesktopSelection();
}

function toggleDesktopItem(index, checked, range = false) {
  const state = _desktopSelection;
  if (!state || state.busy || !state.items[index]) return;
  if (range && state.anchor !== null) {
    for (let i = Math.min(state.anchor, index); i <= Math.max(state.anchor, index); i++) if (state.items[i]) state.selected.add(i);
  } else if (checked) state.selected.add(index); else state.selected.delete(index);
  state.anchor = index; state.status = '';
  syncDesktopSelection();
}

function selectAllDesktopItems(checked) {
  const state = _desktopSelection;
  if (!state || state.busy) return;
  state.selected = new Set(checked ? state.items.flatMap((item, i) => item ? [i] : []) : []);
  state.anchor = null; state.status = '';
  syncDesktopSelection();
}

function clearDesktopSelection() { selectAllDesktopItems(false); }

function syncDesktopSelection() {
  const state = _desktopSelection;
  if (!state) return;
  const count = state.selected.size;
  const available = state.items.filter(Boolean).length;
  const shared = [...state.selected].some(i => !state.items[i].isOwn);
  const all = $('desktopSelectAll');
  all.checked = count > 0 && count === available;
  all.indeterminate = count > 0 && count < available;
  all.disabled = state.busy || !available;
  $('desktopSelectionCount').textContent = `${count} selected`;
  $('desktopDownloadSelected').disabled = state.busy || !count;
  $('desktopDeleteSelected').disabled = state.busy || !count || shared;
  $('desktopClearSelection').disabled = state.busy || !count;
  $('desktopSelectionStatus').textContent = state.status || (shared
    ? 'Shared files can be downloaded. Deselect them to delete your own files.'
    : 'Use checkboxes to select files. Shift-click selects a range. Downloads are saved together in a ZIP.');
  $('desktopSelectionBar').setAttribute('aria-busy', String(state.busy));
  for (const card of $('desktopItemsGrid').children) {
    const input = card.querySelector('.desktop-item-select input');
    if (!input) continue;
    input.checked = state.selected.has(Number(card.dataset.desktopIndex)); input.disabled = state.busy;
    card.classList.toggle('desktop-item-selected', input.checked);
    card.querySelectorAll('button').forEach(button => { button.disabled = state.busy; });
  }
}

async function downloadSelectedDesktopItems() {
  const state = _desktopSelection;
  if (!state || state.busy || !state.selected.size) return;
  const items = [...state.selected].map(i => state.items[i]);
  state.busy = true; state.status = `Preparing ${items.length} selected items…`; syncDesktopSelection();
  try {
    const response = await fetch('/api/document-batches', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items.map(item => ({ source: item._source, id: item.id, filename: item.filename, ownerId: item._sharedOwnerId })) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Server error ${response.status}`);
    if (state !== _desktopSelection || state.userId !== getCurrentUserId()) return;
    const token = getMediaTokenSync();
    _startBrowserDownload(`/api/document-batches/${encodeURIComponent(result.id)}/download${token ? '?token=' + encodeURIComponent(token) : ''}`, result.filename);
    state.status = `ZIP download started for ${items.length} selected items.`;
  } catch (error) { state.status = `Download failed: ${error.message}`; }
  finally { state.busy = false; if (state === _desktopSelection) syncDesktopSelection(); }
}

async function deleteSelectedDesktopItems() {
  const state = _desktopSelection;
  if (!state || state.busy || !state.selected.size) return;
  const indices = [...state.selected], items = indices.map(i => state.items[i]);
  if (items.some(item => !item.isOwn)) return;
  const names = items.slice(0, 8).map(item => item.filename).join('\n');
  if (!confirm(`Delete ${items.length} selected item${items.length === 1 ? '' : 's'}?\n\n${names}${items.length > 8 ? '\n…' : ''}\n\nThis permanently removes the selected files, including any selected code projects and document history. This cannot be undone.`)) return;
  state.busy = true; const failed = []; let deleted = 0;
  try {
    for (const index of indices) {
      if (state !== _desktopSelection || state.userId !== getCurrentUserId()) return;
      const item = state.items[index];
      state.status = `Deleting ${deleted + failed.length + 1} of ${items.length}…`; syncDesktopSelection();
      try {
        const response = await fetch(_docDeleteUrl(item), { method: 'DELETE' });
        if (state !== _desktopSelection || state.userId !== getCurrentUserId()) return;
        if (!response.ok) {
          let error = `Server error ${response.status}`;
          try { error = (await response.json()).error || error; } catch {}
          throw new Error(error);
        }
        state.selected.delete(index); deleted++;
        // Keep indices stable for preview callbacks and for the remaining items.
        state.items[index] = null;
        $('desktopItemsGrid').querySelector(`[data-desktop-index="${index}"]`)?.remove();
      } catch (error) { failed.push(`${item.filename}: ${error.message}`); }
    }
    state.anchor = null;
    state.status = `Deleted ${deleted} of ${items.length} selected items.${failed.length ? ` ${failed.length} failed and remain selected. ${failed.slice(0, 3).join('; ')}` : ''}`;
  } finally { state.busy = false; if (state === _desktopSelection) syncDesktopSelection(); }
}

// ── Render items: Documents ──────────────────────────────────────────────────
function renderDocumentItems(grid, items) {
  items.sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  grid.innerHTML = items.map(doc => {
    const date = new Date(doc.updatedAt || doc.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const rawTags = Array.isArray(doc.tags) ? doc.tags : [];
    const tags = rawTags.slice(0, 4).map(t => `<span class="desktop-item-tag">${escHtml(t)}</span>`).join('');
    return `<div class="desktop-item-row" data-action="openDesktopItem" data-args='${JSON.stringify(['documents', doc.id]).replace(/'/g, "&#39;")}'>
      <div class="desktop-item-icon">📄</div>
      <div class="desktop-item-info">
        <div class="desktop-item-title">${escHtml(doc.title)}</div>
        <div class="desktop-item-meta">${date}</div>
        ${tags ? `<div class="desktop-item-tags">${tags}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  setupDesktopSelection(grid, 'documents', items.map(doc => ({ ...doc, _source: 'research', filename: doc.title || doc.filename || doc.id, isOwn: true })));
}

// ── Render items: Images ─────────────────────────────────────────────────────
let _desktopImageCache = [];
function renderImageItems(grid, items) {
  _desktopImageCache = items;
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  grid.innerHTML = items.map((img, i) => {
    const src = desktopMediaUrl(img, 'images');
    const label = img.filename.replace(/\.\w+$/, '').replace(/_\d+$/, '').replace(/_/g, ' ');
    return `<div class="desktop-img-thumb" data-action="openDesktopItem" data-args='["images",${i}]'>
      <img src="${src}" alt="${escHtml(img.filename)}" loading="lazy">
      <div class="desktop-img-label">${escHtml(label)}</div>
    </div>`;
  }).join('');
  setupDesktopSelection(grid, 'images', items.map(img => desktopMediaDocument(img, 'images')));
}

// ── Render items: Videos ─────────────────────────────────────────────────────
let _desktopVideoCache = [];
function renderVideoItems(grid, items) {
  _desktopVideoCache = items;
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  grid.className = 'desktop-items-grid gallery-mode';
  grid.innerHTML = items.map((vid, i) => {
    const src = desktopMediaUrl(vid, 'videos');
    const label = vid.filename.replace(/\.\w+$/, '').replace(/_\d+$/, '').replace(/_/g, ' ');
    return `<div class="desktop-img-thumb" data-action="openDesktopItem" data-args='["videos",${i}]'>
      <video src="${src}" preload="metadata" style="width:100%;height:100%;object-fit:cover;border-radius:6px;pointer-events:none"></video>
      <div class="desktop-img-label">${escHtml(label)}</div>
    </div>`;
  }).join('');
  setupDesktopSelection(grid, 'videos', items.map(vid => desktopMediaDocument(vid, 'videos')));
}

// ── Render items: Tutoring ───────────────────────────────────────────────────
function renderTutorItems(grid, items) {
  items.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  grid.innerHTML = items.map(sub => {
    const date = sub.lastActivity ? new Date(sub.lastActivity).toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'No activity';
    const name = sub.subject.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return `<div class="desktop-item-row" data-action="openDesktopItem" data-args='${JSON.stringify(['tutoring', sub.subject]).replace(/'/g, "&#39;")}'>
      <div class="desktop-item-icon">🎓</div>
      <div class="desktop-item-info">
        <div class="desktop-item-title">${escHtml(name)}</div>
        <div class="desktop-item-meta">${sub.noteCount} note${sub.noteCount !== 1 ? 's' : ''} · Last active: ${date}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Item detail modal ────────────────────────────────────────────────────────
async function openDesktopItem(type, id) {
  const modal = $('desktopDetailModal');
  const content = $('desktopDetailContent');
  content.innerHTML = '<div style="color:var(--muted);padding:20px">Loading…</div>';
  modal.classList.add('open');

  try {
    switch (type) {
      case 'documents': await renderDocDetail(content, id); break;
      case 'images':    renderImageDetail(content, id); break;
      case 'videos':    renderVideoDetail(content, id); break;
      case 'tutoring':  await renderTutorDetail(content, id); break;
    }
  } catch (e) {
    content.innerHTML = `<div style="color:var(--red);padding:20px">Failed to load item.</div>`;
  }
}

function closeDesktopDetail() {
  const modal = $('desktopDetailModal');
  modal.querySelectorAll('video').forEach(v => { v.pause(); v.src = ''; });
  modal.classList.remove('open');
}

function resumeTutoring(subject) {
  closeDesktopDetail();
  switchView('chat');
  const tutorAgent = agents.find(a => a.skillCategory === 'role_tutor');
  if (tutorAgent) {
    switchAgent(tutorAgent.id);
    // Pre-fill the input with a resume message and send it
    const name = subject.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    $('input').value = `Let's continue learning ${name} from where we left off.`;
    setTimeout(() => send(), 300);
  }
}

async function deleteDesktopDoc(docId) {
  if (!confirm('Delete this document? This cannot be undone.')) return;
  const res = await fetch(`/api/research/${docId}`, { method: 'DELETE' });
  if (!res.ok) { alert('Failed to delete document.'); return; }
  closeDesktopDetail();
  openDesktopCategory('documents');
}

async function deleteDesktopImage(idx) {
  await deleteDesktopMedia(_desktopImageCache[idx], 'images');
}

async function deleteDesktopVideo(idx) {
  await deleteDesktopMedia(_desktopVideoCache[idx], 'videos');
}

async function deleteDesktopMedia(item, type) {
  if (!item || _desktopSelection?.busy) return;
  const doc = desktopMediaDocument(item, type), userId = getCurrentUserId();
  if (!doc.isOwn) { alert('Only the owner can delete this file.'); return; }
  if (!confirm(`Delete "${item.filename}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(_docDeleteUrl(doc), { method: 'DELETE' });
    if (!res.ok) throw new Error('The server could not delete this file. Refresh and try again.');
    if (userId !== getCurrentUserId()) return;
    closeDesktopDetail();
    openDesktopCategory(type);
  } catch (error) { alert(error.message); }
}

async function renderDocDetail(el, docId) {
  const res = await fetch(`/api/research/${docId}`);
  if (!res.ok) { el.innerHTML = '<div style="color:var(--red)">Document not found.</div>'; return; }
  const doc = await res.json();
  const date = new Date(doc.updatedAt || doc.createdAt).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  const tags = (doc.tags || []).map(t => `<span class="detail-tag">${escHtml(t)}</span>`).join('');
  el.innerHTML = `
    <h1>${escHtml(doc.title)}</h1>
    <div class="detail-meta">${date}</div>
    ${tags ? `<div class="detail-tags">${tags}</div>` : ''}
    <div class="detail-body">${renderMarkdown(doc.content || '')}</div>
    <div class="detail-actions">
      <button class="detail-delete-btn" data-action="deleteDesktopDoc" data-args='${JSON.stringify([doc.id]).replace(/'/g, "&#39;")}'>Delete</button>
      <button data-action="closeDesktopDetail">Close</button>
    </div>`;
}

function renderImageDetail(el, idx) {
  const img = _desktopImageCache[idx];
  if (!img) { el.innerHTML = '<div style="color:var(--red)">Image not found.</div>'; return; }
  const src = desktopMediaUrl(img, 'images');
  const label = img.filename.replace(/\.\w+$/, '').replace(/_\d+$/, '').replace(/_/g, ' ');
  const date = img.createdAt ? new Date(img.createdAt).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const agentName = img.agentName || img.agentId || '';
  el.innerHTML = `
    <h1>${escHtml(label)}</h1>
    <div class="detail-meta">${date}${agentName ? ` · Created by ${escHtml(agentName)}` : ''}</div>
    <img class="detail-image" src="${src}" alt="${escHtml(img.filename)}">
    <div class="detail-actions">
      <a href="${desktopMediaUrl(img, 'images', true)}" download="${escHtml(img.filename)}" style="text-decoration:none">
        <button>Download</button>
      </a>
      ${desktopMediaDocument(img, 'images').isOwn ? `<button class="detail-delete-btn" data-action="deleteDesktopImage" data-args='[${idx}]'>Delete</button>` : '<span class="detail-meta">Shared with you · Only the owner can delete</span>'}
      <button data-action="closeDesktopDetail">Close</button>
    </div>`;
}

function renderVideoDetail(el, idx) {
  const vid = _desktopVideoCache[idx];
  if (!vid) { el.innerHTML = '<div style="color:var(--red)">Video not found.</div>'; return; }
  const src = desktopMediaUrl(vid, 'videos');
  const label = vid.filename.replace(/\.\w+$/, '').replace(/_\d+$/, '').replace(/_/g, ' ');
  const date = vid.createdAt ? new Date(vid.createdAt).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : '';
  el.innerHTML = `
    <h1>${escHtml(label)}</h1>
    <div class="detail-meta">${date}</div>
    <video class="detail-image" src="${src}" controls style="max-width:100%;border-radius:8px;display:block"></video>
    <div class="detail-actions">
      <a href="${desktopMediaUrl(vid, 'videos', true)}" download="${escHtml(vid.filename)}" style="text-decoration:none">
        <button>Download</button>
      </a>
      ${desktopMediaDocument(vid, 'videos').isOwn ? `<button class="detail-delete-btn" data-action="deleteDesktopVideo" data-args='[${idx}]'>Delete</button>` : '<span class="detail-meta">Shared with you · Only the owner can delete</span>'}
      <button data-action="closeDesktopDetail">Close</button>
    </div>`;
}

// ── Widget System ────────────────────────────────────────────────────────────

let _widgetLayout = { widgets: [] };
let _widgetSaveTimer = null;

// Built-in widget types
const WIDGET_TYPES = {
  tasks: {
    label: 'Scheduled Tasks', icon: '⏰', description: 'Your recurring scheduled tasks',
    system: true, // cannot be added/removed by user — auto-shown when tasks exist
    render: renderTasksWidget,
  },
  reminders: {
    label: 'Reminders', icon: '🔔', description: 'Today\'s fired reminders',
    system: true,
    render: renderRemindersWidget,
  },
  notes: {
    label: 'Notes', icon: '📝', description: 'A simple text notepad',
    render: renderNotesWidget,
  },
  links: {
    label: 'Quick Links', icon: '🔗', description: 'Bookmarks and quick links',
    render: renderLinksWidget,
  },
  checklist: {
    label: 'Checklist', icon: '✅', description: 'A to-do checklist',
    render: renderChecklistWidget,
  },
};

async function loadWidgetLayout() {
  try {
    const r = await fetch('/api/desktop/widgets');
    if (r.ok) _widgetLayout = await r.json();
  } catch {}
  if (!_widgetLayout.widgets) _widgetLayout.widgets = [];
}

function saveWidgetLayout() {
  clearTimeout(_widgetSaveTimer);
  _widgetSaveTimer = setTimeout(() => saveWidgetLayoutNow(), 500);
}

function saveWidgetLayoutNow() {
  clearTimeout(_widgetSaveTimer);
  return fetch('/api/desktop/widgets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_widgetLayout),
  }).catch(() => {});
}

function genWidgetId() {
  return 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Reminders (kept for external callers like WebSocket) ─────────────────────

const BOARD_REMINDERS_KEY = 'oe_reminder_board';

function getBoardReminders() {
  try {
    const today = new Date().toDateString();
    const raw = JSON.parse(localStorage.getItem(BOARD_REMINDERS_KEY) || '[]');
    const fresh = raw.filter(r => new Date(r.firedAt).toDateString() === today);
    if (fresh.length !== raw.length) localStorage.setItem(BOARD_REMINDERS_KEY, JSON.stringify(fresh));
    return fresh;
  } catch { return []; }
}

function addBoardReminder(msg) {
  const reminders = getBoardReminders();
  if (!reminders.find(r => r.id === msg.id)) {
    reminders.push({ id: msg.id, label: msg.label, firedAt: new Date(msg.ts).toISOString(), dismissed: false });
    localStorage.setItem(BOARD_REMINDERS_KEY, JSON.stringify(reminders));
  }
  if (_currentDesktopView === 'desktop') loadDesktopBoard();
}

function dismissBoardReminder(id) {
  const reminders = getBoardReminders().map(r => r.id === id ? { ...r, dismissed: true } : r);
  localStorage.setItem(BOARD_REMINDERS_KEY, JSON.stringify(reminders));
  loadDesktopBoard();
}

// ── Main board render ────────────────────────────────────────────────────────

async function loadDesktopBoard() {
  await loadWidgetLayout();
  await renderWidgetGrid();
}

let _systemTaskData = [];
let _systemReminderData = [];

async function renderWidgetGrid() {
  const grid = $('desktopBoard');
  if (!grid) return;

  // Gather system widget data
  [_systemTaskData, _systemReminderData] = await Promise.all([fetchSystemTasks(), fetchSystemReminders()]);

  grid.innerHTML = '';
  grid.style.display = '';

  // Render system widgets first (only if they have data)
  if (_systemTaskData.length) {
    const el = document.createElement('div');
    el.className = 'desktop-widget widget-size-small';
    el.innerHTML = renderTasksWidget(_systemTaskData);
    grid.appendChild(el);
  }
  if (_systemReminderData.length) {
    const el = document.createElement('div');
    el.className = 'desktop-widget widget-size-small';
    el.innerHTML = renderRemindersWidget(_systemReminderData);
    grid.appendChild(el);
  }

  // Render user widgets
  for (const w of _widgetLayout.widgets) {
    const typeDef = WIDGET_TYPES[w.type];
    if (!typeDef || typeDef.system) continue;
    const el = document.createElement('div');
    el.className = `desktop-widget widget-size-${w.size || 'small'}`;
    el.dataset.widgetId = w.id;
    el.innerHTML = renderUserWidget(w);
    grid.appendChild(el);
  }

  // Add the "+" button
  const addBtn = document.createElement('div');
  addBtn.className = 'desktop-widget-add';
  addBtn.onclick = openWidgetPicker;
  addBtn.innerHTML = `<span class="widget-add-icon">+</span><span class="widget-add-label">Add Widget</span>`;
  grid.appendChild(addBtn);
}

async function fetchSystemTasks() {
  try {
    const r = await fetch('/api/tasks');
    const all = await r.json();
    return all.filter(t => t.type !== 'reminder' && t.enabled && t.repeat !== 'once');
  } catch { return []; }
}

function fetchSystemReminders() {
  return Promise.resolve(getBoardReminders().filter(r => !r.dismissed));
}

// ── System widget renderers ──────────────────────────────────────────────────

function renderTasksWidget(tasks) {
  return `<div class="widget-header"><span>⏰ Scheduled Tasks</span></div><div class="widget-body">` +
    tasks.map(t => {
      const lastRun = t.lastRun
        ? new Date(t.lastRun).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : null;
      // nextRunAt is persisted by the scheduler whenever it arms this task's
      // timer (see scheduler.mjs scheduleTask) — null-guarded since tasks
      // created/updated before that change won't have it yet.
      const nextRun = t.nextRunAt && !isNaN(new Date(t.nextRunAt))
        ? new Date(t.nextRunAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : null;
      const agentName = agents.find(a => a.id === t.agent)?.name ?? t.agent ?? '';
      const failing = Number(t.consecutiveFailures) > 0;
      const failBadge = failing
        ? ` <span style="color:var(--red,#e05c5c)" title="${escHtml(t.lastError || '')}">⚠ ${t.consecutiveFailures} failed in a row</span>`
        : '';
      return `<div class="board-task-card">
        <div class="board-task-icon">📋</div>
        <div class="board-task-info">
          <div class="board-task-label">${escHtml(t.label)}</div>
          <div class="board-task-meta">🔁 ${escHtml(formatTaskCadenceText(t))} · ${escHtml(agentName)}${lastRun ? ` · Last run: ${lastRun}` : ''}${nextRun ? ` · Next: ${nextRun}` : ''}${failBadge}</div>
        </div>
      </div>`;
    }).join('') + `</div>`;
}

function renderRemindersWidget(fired) {
  return `<div class="widget-header"><span>🔔 Reminders</span></div><div class="widget-body">` +
    fired.map(r => {
      const time = new Date(r.firedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `<div class="board-reminder-card">
        <div class="board-reminder-icon">🔔</div>
        <div class="board-reminder-info">
          <div class="board-reminder-label">${escHtml(r.label)}</div>
          <div class="board-reminder-meta">Today at ${time}</div>
        </div>
        <button class="board-reminder-dismiss" data-action="dismissBoardReminder" data-args='${JSON.stringify([r.id]).replace(/'/g, "&#39;")}' title="Dismiss">✕</button>
      </div>`;
    }).join('') + `</div>`;
}

// ── User widget renderer ─────────────────────────────────────────────────────

function renderUserWidget(w) {
  const typeDef = WIDGET_TYPES[w.type];
  const icon = typeDef?.icon || '📦';
  const sizeMenu = ['small', 'medium', 'large'].map(s =>
    `<div class="widget-menu-item ${w.size === s ? 'active' : ''}" data-action="resizeWidget" data-args='${JSON.stringify([w.id, s]).replace(/'/g, "&#39;")}'>${s === 'small' ? '▪ Small' : s === 'medium' ? '▪▪ Medium' : '▪▪▪ Large'}</div>`
  ).join('');

  let header = `<div class="widget-header">
    <span class="widget-title" ondblclick="renameWidget('${w.id}', this)">${icon} ${escHtml(w.title || typeDef?.label || 'Widget')}</span>
    <div class="widget-header-actions">
      <button class="widget-menu-btn" data-action="toggleWidgetMenu" data-args='${JSON.stringify([w.id]).replace(/'/g, "&#39;")}'>···</button>
      <div class="widget-menu" id="widgetMenu_${w.id}">
        ${sizeMenu}
        <div class="widget-menu-divider"></div>
        <div class="widget-menu-item widget-menu-danger" data-action="deleteWidget" data-args='${JSON.stringify([w.id]).replace(/'/g, "&#39;")}'>Delete</div>
      </div>
    </div>
  </div>`;

  let body = '';
  if (typeDef?.render) {
    body = typeDef.render(w);
  }
  return header + body;
}

// ── Notes widget ─────────────────────────────────────────────────────────────

function renderNotesWidget(w) {
  return `<div class="widget-body widget-body-notes">
    <textarea class="widget-notes-area" placeholder="Type your notes here…"
      data-input-action="updateWidgetContent" data-input-args='${JSON.stringify([w.id, "$value"]).replace(/'/g, "&#39;")}'>${escHtml(w.content || '')}</textarea>
  </div>`;
}

// ── Links widget ─────────────────────────────────────────────────────────────

function renderLinksWidget(w) {
  const links = w.content || [];
  const linksHtml = links.map((l, i) =>
    `<div class="widget-link-row">
      <a href="${escHtml(l.url)}" target="_blank" rel="noopener" class="widget-link-anchor">${escHtml(l.label || l.url)}</a>
      <button class="widget-link-remove" data-action="removeWidgetLink" data-args='${JSON.stringify([w.id, i]).replace(/'/g, "&#39;")}'>✕</button>
    </div>`
  ).join('');

  return `<div class="widget-body">
    ${linksHtml}
    <div class="widget-link-add" data-action="addWidgetLink" data-args='${JSON.stringify([w.id]).replace(/'/g, "&#39;")}'>+ Add link</div>
  </div>`;
}

function addWidgetLink(widgetId) {
  const url = prompt('URL:');
  if (!url) return;
  const label = prompt('Label (optional):', '') || url;
  const w = _widgetLayout.widgets.find(w => w.id === widgetId);
  if (!w) return;
  if (!Array.isArray(w.content)) w.content = [];
  w.content.push({ url, label });
  saveWidgetLayout();
  renderWidgetGrid();
}

function removeWidgetLink(widgetId, idx) {
  const w = _widgetLayout.widgets.find(w => w.id === widgetId);
  if (!w || !Array.isArray(w.content)) return;
  w.content.splice(idx, 1);
  saveWidgetLayout();
  renderWidgetGrid();
}

// ── Checklist widget ─────────────────────────────────────────────────────────

function renderChecklistWidget(w) {
  const items = w.content || [];
  const itemsHtml = items.map((item, i) =>
    `<div class="widget-check-row">
      <input type="checkbox" ${item.done ? 'checked' : ''} data-change-action="toggleCheckItem" data-change-args='${JSON.stringify([w.id, i]).replace(/'/g, "&#39;")}'>
      <span class="widget-check-label ${item.done ? 'done' : ''}">${escHtml(item.text)}</span>
      <button class="widget-link-remove" data-action="removeCheckItem" data-args='${JSON.stringify([w.id, i]).replace(/'/g, "&#39;")}'>✕</button>
    </div>`
  ).join('');

  return `<div class="widget-body">
    ${itemsHtml}
    <div class="widget-link-add" data-action="addCheckItem" data-args='${JSON.stringify([w.id]).replace(/'/g, "&#39;")}'>+ Add item</div>
  </div>`;
}

function addCheckItem(widgetId) {
  const text = prompt('Item:');
  if (!text) return;
  const w = _widgetLayout.widgets.find(w => w.id === widgetId);
  if (!w) return;
  if (!Array.isArray(w.content)) w.content = [];
  w.content.push({ text, done: false });
  saveWidgetLayout();
  renderWidgetGrid();
}

function toggleCheckItem(widgetId, idx) {
  const w = _widgetLayout.widgets.find(w => w.id === widgetId);
  if (!w || !Array.isArray(w.content)) return;
  w.content[idx].done = !w.content[idx].done;
  saveWidgetLayout();
}

function removeCheckItem(widgetId, idx) {
  const w = _widgetLayout.widgets.find(w => w.id === widgetId);
  if (!w || !Array.isArray(w.content)) return;
  w.content.splice(idx, 1);
  saveWidgetLayout();
  renderWidgetGrid();
}

// ── Widget actions ───────────────────────────────────────────────────────────

function updateWidgetContent(widgetId, value) {
  const w = _widgetLayout.widgets.find(w => w.id === widgetId);
  if (!w) return;
  w.content = value;
  saveWidgetLayout();
}

function toggleWidgetMenu(widgetId) {
  const menu = document.getElementById(`widgetMenu_${widgetId}`);
  if (!menu) return;
  // Close all other menus
  document.querySelectorAll('.widget-menu.open').forEach(m => { if (m !== menu) m.classList.remove('open'); });
  menu.classList.toggle('open');
}

function renameWidget(widgetId, el) {
  const w = _widgetLayout.widgets.find(w => w.id === widgetId);
  if (!w) return;
  const typeDef = WIDGET_TYPES[w.type];
  const icon = typeDef?.icon || '📦';
  const currentName = w.title || typeDef?.label || 'Widget';

  const input = document.createElement('input');
  input.className = 'widget-rename-input';
  input.value = currentName;
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();

  const finish = () => {
    const val = input.value.trim();
    w.title = val || currentName;
    el.textContent = icon + ' ' + (w.title);
    saveWidgetLayout();
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = currentName; input.blur(); }
  });
}

function resizeWidget(widgetId, size) {
  const w = _widgetLayout.widgets.find(w => w.id === widgetId);
  if (!w) return;
  w.size = size;
  saveWidgetLayout();
  // Update DOM class directly for instant feedback
  const el = document.querySelector(`[data-widget-id="${widgetId}"]`);
  if (el) {
    el.className = `desktop-widget widget-size-${size}`;
  }
  // Update menu active states
  const menu = document.getElementById(`widgetMenu_${widgetId}`);
  if (menu) {
    menu.querySelectorAll('.widget-menu-item').forEach(item => {
      const onclick = item.getAttribute('onclick') || '';
      const match = onclick.match(/resizeWidget\('[^']+','(\w+)'\)/);
      if (match) {
        item.classList.toggle('active', match[1] === size);
      }
    });
    menu.classList.remove('open');
  }
}

function deleteWidget(widgetId) {
  _widgetLayout.widgets = _widgetLayout.widgets.filter(w => w.id !== widgetId);
  saveWidgetLayout();
  const el = document.querySelector(`[data-widget-id="${widgetId}"]`);
  if (el) el.remove();
}

// ── Widget picker ────────────────────────────────────────────────────────────

function openWidgetPicker() {
  const picker = $('widgetPicker');
  if (!picker) return;

  const list = picker.querySelector('.widget-picker-list');
  const userTypes = Object.entries(WIDGET_TYPES).filter(([, v]) => !v.system);

  list.innerHTML = userTypes.map(([type, def]) =>
    `<div class="widget-picker-item" data-action="addWidget" data-args='${JSON.stringify([type]).replace(/'/g, "&#39;")}'>
      <div class="widget-picker-icon">${def.icon}</div>
      <div class="widget-picker-info">
        <div class="widget-picker-name">${escHtml(def.label)}</div>
        <div class="widget-picker-desc">${escHtml(def.description)}</div>
      </div>
    </div>`
  ).join('');

  picker.classList.add('open');
}

function closeWidgetPicker() {
  const picker = $('widgetPicker');
  if (picker) picker.classList.remove('open');
}

async function addWidget(type) {
  const typeDef = WIDGET_TYPES[type];
  if (!typeDef) return;
  const w = {
    id: genWidgetId(),
    type,
    title: typeDef.label,
    size: 'small',
    content: type === 'links' || type === 'checklist' ? [] : '',
  };
  _widgetLayout.widgets.push(w);
  closeWidgetPicker();
  await saveWidgetLayoutNow();
  renderWidgetGrid();
}

// Close widget menus when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.widget-menu-btn') && !e.target.closest('.widget-menu')) {
    document.querySelectorAll('.widget-menu.open').forEach(m => m.classList.remove('open'));
  }
});

async function renderTutorDetail(el, subject) {
  const res = await fetch(`/api/desktop/tutor-subject/${encodeURIComponent(subject)}`);
  if (!res.ok) { el.innerHTML = '<div style="color:var(--red)">Subject not found.</div>'; return; }
  const data = await res.json();
  const name = subject.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Group notes by category
  const groups = {};
  for (const note of data.notes || []) {
    const cat = note.category || 'general';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(note);
  }

  let notesHtml = '';
  const catLabels = { study_note: '📝 Study Notes', progress: '📈 Progress', quiz_result: '✅ Quiz Results', general: '📋 Notes' };
  for (const [cat, notes] of Object.entries(groups)) {
    const catLabel = catLabels[cat] || cat;
    const items = notes.map(n => {
      const d = n.createdAt ? new Date(n.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:11px;color:var(--muted)">${d}</div>
        <div style="font-size:13px;margin-top:2px">${escHtml(n.text || n.content || '')}</div>
      </div>`;
    }).join('');
    notesHtml += `<div style="margin-top:16px">
      <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">${catLabel}</div>
      ${items}
    </div>`;
  }

  // Find the tutor agent
  const tutorAgent = agents.find(a => a.skillCategory === 'role_tutor');
  const tutorName = tutorAgent ? `${tutorAgent.emoji || '👩‍🏫'} ${tutorAgent.name}` : 'Tutor';

  el.innerHTML = `
    <h1>🎓 ${escHtml(name)}</h1>
    <div class="detail-meta">${data.notes?.length || 0} notes${tutorAgent ? ` · ${escHtml(tutorName)}` : ''}</div>
    ${data.roadmap ? `<div class="detail-body" style="margin-bottom:12px"><h3>Roadmap</h3>${renderMarkdown(data.roadmap)}</div>` : ''}
    ${notesHtml || '<div style="color:var(--muted)">No notes yet for this subject.</div>'}
    <div class="detail-actions">
      <button class="desktop-resume-btn" data-action="resumeTutoring" data-args='${JSON.stringify([subject]).replace(/'/g, "&#39;")}'>Resume Learning</button>
      <button data-action="closeDesktopDetail">Close</button>
    </div>`;
}
