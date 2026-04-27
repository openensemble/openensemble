// ── Shared Documents ───────────────────────────────────────────────────────────

let _docUsers        = [];
let _docShareSel     = new Set();
let _docPendingFile  = null;
let _docAskId        = null;
let _docAskMime      = '';
let _docFilter       = 'all'; // 'all' | 'photos' | 'videos' | 'code'
let _docAllDocs      = [];
let _docShareModalId  = null;
let _docShareModalSel = new Set();

// Called by drawers.js when drawerNotes opens
async function openNotesDrawer() {
  switchDocTab('docs');
  _docFilter = 'all';
  loadDocList();
  if (!_docUsers.length) {
    try { _docUsers = await fetch('/api/users').then(r => r.json()); } catch {}
  }
}

function switchDocTab(tab) {
  const isDocs = tab === 'docs';
  $('docViewDocs').style.display  = isDocs ? 'flex' : 'none';
  $('docViewNotes').style.display = isDocs ? 'none' : 'flex';
  const activeStyle   = 'var(--accent)';
  const inactiveStyle = 'var(--muted)';
  $('docTabDocs').style.color              = isDocs ? activeStyle : inactiveStyle;
  $('docTabDocs').style.borderBottomColor  = isDocs ? activeStyle : 'transparent';
  $('docTabNotes').style.color             = isDocs ? inactiveStyle : activeStyle;
  $('docTabNotes').style.borderBottomColor = isDocs ? 'transparent' : activeStyle;
  if (!isDocs) _loadNotesTab();
}

async function _loadNotesTab() {
  $('notesMetaRow').textContent = 'Loading…';
  $('notesTextarea').value = '';
  try {
    const notes = await fetch('/api/notes').then(r => r.json());
    $('notesTextarea').value = notes.content ?? '';
    if (notes.updatedAt) {
      const when = new Date(notes.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      $('notesMetaRow').textContent = `Last updated ${when}${notes.updatedByName ? ' by ' + notes.updatedByName : ''}`;
    } else {
      $('notesMetaRow').textContent = '';
    }
  } catch { $('notesMetaRow').textContent = 'Failed to load notes'; }
}

// ── Document list ─────────────────────────────────────────────────────────────

async function loadDocList() {
  const list = $('docList');
  list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;text-align:center">Loading…</div>';
  try {
    const [uploadedDocs, aiImages, aiVideos, researchDocs, shares, codeResp] = await Promise.all([
      fetch('/api/shared-docs').then(r => r.json()).catch(() => []),
      fetch('/api/desktop/images').then(r => r.json()).catch(() => []),
      fetch('/api/desktop/videos').then(r => r.json()).catch(() => []),
      fetch('/api/research').then(r => r.json()).catch(() => []),
      fetch('/api/sharing').then(r => r.json()).catch(() => []),
      fetch('/api/coder/projects').then(r => r.json()).catch(() => ({ projects: [] })),
    ]);
    const codeProjects = Array.isArray(codeResp?.projects) ? codeResp.projects : [];

    // Track uploaded doc filenames to avoid duplicates
    const seen = new Set(uploadedDocs.map(d => d.id));

    // Build a lookup of share info so we can show shared-with state on AI items
    const _sharesByFileId = {};
    for (const s of shares) {
      _sharesByFileId[s.fileId] = s;
    }

    // Normalize AI-generated images into the same shape
    const imgDocs = aiImages.map(img => {
      const fileId = 'ai_img_' + img.filename;
      const share = _sharesByFileId[fileId];
      return {
        id: fileId,
        filename: img.filename,
        ext: '.' + (img.filename.split('.').pop() || 'jpg'),
        mimeType: 'image/' + (img.filename.split('.').pop() || 'jpeg').replace('jpg', 'jpeg'),
        size: img.size,
        uploadedBy: null,
        uploadedByName: img.agentName ? `${img.agentEmoji ?? ''} ${img.agentName}`.trim() : 'AI Generated',
        sharedWith: share?.sharedWith ?? [],
        createdAt: img.createdAt,
        isOwn: true,
        _source: 'ai-image',
        _agentId: img.agentId,
      };
    }).filter(d => !seen.has(d.id));

    // Normalize AI-generated videos
    const vidDocs = aiVideos.map(vid => {
      const fileId = 'ai_vid_' + vid.filename;
      const share = _sharesByFileId[fileId];
      return {
        id: fileId,
        filename: vid.filename,
        ext: '.' + (vid.filename.split('.').pop() || 'mp4'),
        mimeType: 'video/' + (vid.filename.split('.').pop() || 'mp4'),
        size: vid.size,
        uploadedBy: null,
        uploadedByName: 'AI Generated',
        sharedWith: share?.sharedWith ?? [],
        createdAt: vid.createdAt,
        isOwn: true,
        _source: 'ai-video',
      };
    }).filter(d => !seen.has(d.id));

    // Normalize research documents
    const resDocs = researchDocs.map(doc => {
      const share = _sharesByFileId[doc.id];
      return {
        id: doc.id,
        filename: doc.title || doc.filename || doc.id,
        ext: '.md',
        mimeType: 'text/markdown',
        size: 0,
        uploadedBy: null,
        uploadedByName: 'Deep Research',
        sharedWith: share?.sharedWith ?? [],
        createdAt: doc.createdAt || doc.date,
        isOwn: true,
        _source: 'research',
        description: doc.description || (doc.tags || []).join(', '),
      };
    }).filter(d => !seen.has(d.id));

    // Items shared with me from other users (AI images/videos/research)
    const myId = getCurrentUserId?.() ?? null;
    const sharedWithMe = shares
      .filter(s => !s.isOwn && s.sharedWith?.includes?.(myId))
      .map(s => {
        const isImg = s.fileType === 'image';
        const isVid = s.fileType === 'video';
        const isRes = s.fileType === 'research';
        const ext = '.' + (s.filename?.split('.').pop() || 'bin');
        return {
          id: s.fileId,
          filename: s.filename ?? s.fileId,
          ext,
          mimeType: isImg ? 'image/' + (ext.slice(1) || 'jpeg').replace('jpg', 'jpeg')
                  : isVid ? 'video/' + (ext.slice(1) || 'mp4')
                  : isRes ? 'text/markdown'
                  : 'application/octet-stream',
          size: 0,
          uploadedBy: s.ownerId,
          uploadedByName: s.ownerName ?? 'Unknown',
          sharedWith: s.sharedWith ?? [],
          createdAt: s.sharedAt,
          isOwn: false,
          _source: isImg ? 'ai-image' : isVid ? 'ai-video' : isRes ? 'research' : null,
          _sharedOwnerId: s.ownerId,
        };
      })
      .filter(d => !seen.has(d.id) && !imgDocs.some(x => x.id === d.id) && !vidDocs.some(x => x.id === d.id) && !resDocs.some(x => x.id === d.id));

    // Coder projects (users/{id}/documents/code/). Render as folder-like entries
    // in the Documents tab so users can download/delete them without leaving the
    // drawer. Size is the whole project; _source = 'code' drives the special
    // actions + viewer below.
    const codeDocs = codeProjects.map(p => ({
      id: 'code_' + p.name,
      filename: p.name,
      ext: '',
      mimeType: 'application/x-code-project',
      size: p.size ?? 0,
      uploadedBy: null,
      uploadedByName: 'Code Project',
      sharedWith: [],
      createdAt: p.mtime,
      isOwn: true,
      _source: 'code',
      _projectName: p.name,
      _fileCount: p.fileCount ?? 0,
    }));

    _docAllDocs = [...uploadedDocs, ...imgDocs, ...vidDocs, ...resDocs, ...codeDocs, ...sharedWithMe];
    applyDocFilter(_docFilter);
  } catch {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;text-align:center">Failed to load documents</div>';
  }
}

function switchDocFilter(filter) {
  _docFilter = filter;
  // Update tab styles
  ['all','photos','videos','code'].forEach(f => {
    const btn = $('docFilter-' + f);
    if (!btn) return;
    const active = f === filter;
    btn.style.color            = active ? 'var(--accent)' : 'var(--muted)';
    btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    btn.style.fontWeight       = active ? '600' : '400';
  });
  // Code projects are created through the Coder agent, not uploaded — hide
  // the upload trigger while that tab is active.
  const uploader = $('docUploadTrigger');
  if (uploader) uploader.style.display = filter === 'code' ? 'none' : '';
  applyDocFilter(filter);
}

function applyDocFilter(filter) {
  let docs = _docAllDocs;
  if (filter === 'photos')      docs = docs.filter(d => d.mimeType.startsWith('image/'));
  else if (filter === 'videos') docs = docs.filter(d => d.mimeType.startsWith('video/'));
  else if (filter === 'code')   docs = docs.filter(d => d._source === 'code');
  else docs = docs.filter(d => d._source !== 'code' && !d.mimeType.startsWith('image/') && !d.mimeType.startsWith('video/'));
  renderDocList(docs, filter);
}

function _docIcon(mimeType, filename) {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.includes('pdf') || ext === 'pdf') return '📄';
  if (['csv','xlsx','xls'].includes(ext) || mimeType.includes('spreadsheet')) return '📊';
  if (['doc','docx'].includes(ext) || mimeType.includes('word')) return '📝';
  if (['txt','md'].includes(ext)) return '📃';
  return '📎';
}

function _fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function _viewUrl(doc) {
  // Accept either a string id (legacy) or a doc object. The token query
  // param is a short-lived media token (see auth.js::getMediaTokenSync),
  // not the session token.
  const token = encodeURIComponent(getMediaTokenSync());
  if (typeof doc === 'string') return `/api/shared-docs/${doc}/view?token=${token}`;
  if (doc._source === 'ai-image') return `/api/desktop/images/${encodeURIComponent(doc.filename)}?token=${token}${doc._agentId ? '&agent=' + encodeURIComponent(doc._agentId) : ''}`;
  if (doc._source === 'ai-video') return `/api/desktop/videos/${encodeURIComponent(doc.filename)}?token=${token}`;
  return `/api/shared-docs/${doc.id}/view?token=${token}`;
}

function renderDocList(docs, filter) {
  const list = $('docList');
  if (!docs.length) {
    const msg = filter === 'photos' ? 'No images yet.'
              : filter === 'videos' ? 'No videos yet.'
              : filter === 'code'   ? 'No code projects yet.'
              : 'No documents yet.';
    const hint = filter === 'code' ? 'Start one from the Coder agent.' : 'Upload one above to get started.';
    list.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:30px 20px;text-align:center;line-height:1.8">${msg}<br>${hint}</div>`;
    return;
  }
  const cards = docs.map(doc => {
    const icon    = _docIcon(doc.mimeType, doc.filename);
    const when    = fmtRelTime(doc.createdAt);
    const isImage = doc.mimeType.startsWith('image/');
    const isVideo = doc.mimeType.startsWith('video/');
    const isAi    = !!doc._source;
    const viewUrl = _viewUrl(doc);
    let sharedLabel, sharedColor;
    if (isAi && doc.isOwn) {
      const src = escHtml(doc.uploadedByName);
      if (doc.sharedWith?.includes('*')) { sharedLabel = `${src} · Shared with everyone`; sharedColor = 'var(--accent)'; }
      else if (doc.sharedWith?.length)   { sharedLabel = `${src} · Shared with ${doc.sharedWith.length}`; sharedColor = 'var(--accent)'; }
      else                               { sharedLabel = src; sharedColor = 'var(--muted)'; }
    } else if (isAi && !doc.isOwn) {
      sharedLabel = `From ${escHtml(doc.uploadedByName)}`;
      sharedColor = 'var(--muted)';
    } else if (doc.isOwn) {
      if (doc.sharedWith.includes('*')) { sharedLabel = 'Everyone'; sharedColor = 'var(--accent)'; }
      else if (doc.sharedWith.length)  { sharedLabel = `${doc.sharedWith.length} user${doc.sharedWith.length > 1 ? 's' : ''}`; sharedColor = 'var(--accent)'; }
      else                             { sharedLabel = 'Private'; sharedColor = 'var(--muted)'; }
    } else {
      sharedLabel = `From ${escHtml(doc.uploadedByName)}`;
      sharedColor = 'var(--muted)';
    }
    const safeId   = escHtml(doc.id);
    const safeName = escHtml(doc.filename).replace(/'/g, '&#39;');
    const safeMime = escHtml(doc.mimeType).replace(/'/g, '&#39;');
    const safeSource = escHtml(doc._source ?? '');
    const clickAttr = `onclick="openDocViewer('${safeId}','${safeName}','${safeMime}','${safeSource}')"`;

    let thumbHtml;
    if (isImage) {
      thumbHtml = `<div ${clickAttr} style="width:100%;aspect-ratio:4/3;overflow:hidden;cursor:pointer;background:var(--bg2);display:flex;align-items:center;justify-content:center">
        <img src="${viewUrl}" style="width:100%;height:100%;object-fit:cover" loading="lazy"
          onerror="this.parentElement.innerHTML='<span style=\\'font-size:36px\\'>🖼️</span>'">
      </div>`;
    } else if (isVideo) {
      thumbHtml = `<div ${clickAttr} style="width:100%;aspect-ratio:4/3;overflow:hidden;cursor:pointer;background:#000;position:relative;display:flex;align-items:center;justify-content:center">
        <video src="${viewUrl}" style="width:100%;height:100%;object-fit:cover" preload="metadata" muted playsinline></video>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
          <div style="width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff">▶</div>
        </div>
      </div>`;
    } else if (doc._source === 'research') {
      thumbHtml = `<div ${clickAttr} data-research-preview="${safeId}" style="width:100%;aspect-ratio:4/3;overflow:hidden;cursor:pointer;background:var(--bg2);padding:8px;box-sizing:border-box">
        <pre style="margin:0;font-size:8px;font-family:monospace;line-height:1.45;color:var(--muted);white-space:pre-wrap;word-break:break-all;overflow:hidden;height:100%">Loading…</pre>
      </div>`;
    } else if (doc._source === 'code') {
      const fileWord = doc._fileCount === 1 ? 'file' : 'files';
      thumbHtml = `<div ${clickAttr} style="width:100%;aspect-ratio:4/3;overflow:hidden;cursor:pointer;background:var(--bg2);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px">
        <span style="font-size:44px">💻</span>
        <span style="font-size:11px;color:var(--muted)">${doc._fileCount} ${fileWord}</span>
      </div>`;
    } else {
      const ext2    = (doc.filename.split('.').pop() ?? '').toLowerCase();
      const isText  = ['txt','md','csv'].includes(ext2) || doc.mimeType.startsWith('text/');
      const thumbUrl = `/api/shared-docs/${doc.id}/thumbnail?token=${encodeURIComponent(getMediaTokenSync())}`;
      if (isText) {
        thumbHtml = `<div ${clickAttr} data-text-preview="${safeId}" style="width:100%;aspect-ratio:4/3;overflow:hidden;cursor:pointer;background:var(--bg2);padding:8px;box-sizing:border-box">
          <pre style="margin:0;font-size:8px;font-family:monospace;line-height:1.45;color:var(--muted);white-space:pre-wrap;word-break:break-all;overflow:hidden;height:100%">Loading…</pre>
        </div>`;
      } else {
        thumbHtml = `<div ${clickAttr} style="width:100%;aspect-ratio:4/3;overflow:hidden;cursor:pointer;background:var(--bg2);display:flex;align-items:center;justify-content:center;position:relative">
          <img src="${thumbUrl}" style="width:100%;height:100%;object-fit:cover" loading="lazy"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
          <div style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;font-size:40px">${icon}</div>
        </div>`;
      }
    }

    // Action buttons — all items get share; download/delete/ask vary by source
    const shareBtn = doc.isOwn ? `<button onclick="openDocShareModal('${safeId}')" title="Share" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🔗</button>` : '';
    let actions;
    if (doc._source === 'ai-image') {
      actions = `<button onclick="downloadAiFile('images','${safeName}')" title="Download" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">⬇</button>
        ${shareBtn}
        <button onclick="deleteAiImage('${safeName}')" title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>`;
    } else if (doc._source === 'ai-video') {
      actions = `<button onclick="downloadAiFile('videos','${safeName}')" title="Download" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">⬇</button>
        ${shareBtn}
        <button onclick="deleteAiVideo('${safeName}')" title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>`;
    } else if (doc._source === 'research') {
      actions = `<button onclick="openDocAskModal('${safeId}','${safeName}','${safeMime}')" title="Ask Agent" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🤖</button>
        ${shareBtn}
        <button onclick="deleteResearchDoc('${safeId}','${safeName}')" title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>`;
    } else if (doc._source === 'code') {
      actions = `<button onclick="downloadCodeProject('${safeName}')" title="Download zip" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">⬇</button>
        <button onclick="deleteCodeProjectFromDocs('${safeName}')" title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>`;
    } else {
      actions = `<button onclick="downloadDoc('${safeId}','${safeName}')" title="Download" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">⬇</button>
        <button onclick="openDocAskModal('${safeId}','${safeName}','${safeMime}')" title="Ask Agent" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🤖</button>
        ${shareBtn}
        ${doc.isOwn ? `<button onclick="deleteDoc('${safeId}','${safeName}')" title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>` : ''}`;
    }

    return `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;background:var(--bg3);display:flex;flex-direction:column">
      ${thumbHtml}
      <div style="padding:7px 9px;flex:1;display:flex;flex-direction:column;gap:4px">
        <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3" title="${escHtml(doc.filename)}">${escHtml(doc.filename)}</div>
        <div style="font-size:10px;color:${sharedColor}">${sharedLabel} · ${when}</div>
        <div style="display:flex;gap:4px;margin-top:2px;flex-wrap:wrap">${actions}</div>
      </div>
    </div>`;
  }).join('');

  list.innerHTML = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">${cards}</div>`;

  // Populate text previews after render
  list.querySelectorAll('[data-text-preview]').forEach(async el => {
    try {
      const data = await fetch(`/api/shared-docs/${el.dataset.textPreview}/content`).then(r => r.json());
      const pre = el.querySelector('pre');
      if (pre) pre.textContent = data.text?.slice(0, 400) ?? '(empty)';
    } catch {}
  });

  // Populate research doc previews after render
  list.querySelectorAll('[data-research-preview]').forEach(async el => {
    try {
      const data = await fetch(`/api/research/${el.dataset.researchPreview}`).then(r => r.json());
      const pre = el.querySelector('pre');
      if (pre) pre.textContent = (data.content ?? '').replace(/^#+ /gm, '').slice(0, 400) || '(empty)';
    } catch {}
  });
}

// ── Upload ────────────────────────────────────────────────────────────────────

function _fileCategory(file) {
  if (file.type.startsWith('image/')) return 'photos';
  if (file.type.startsWith('video/')) return 'videos';
  return 'all';
}

function _tabLabel(filter) {
  return filter === 'photos' ? 'Images'
       : filter === 'videos' ? 'Videos'
       : filter === 'code'   ? 'Code'
       : 'Documents';
}

function handleDocFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';

  const category = _fileCategory(file);

  // Enforce: file type must match the active tab
  if (category !== _docFilter) {
    const correctTab = _tabLabel(category);
    const currentTab = _tabLabel(_docFilter);
    if (confirm(`"${file.name}" is a${category === 'photos' ? 'n image' : ' ' + correctTab.toLowerCase().slice(0, -1)} file.\n\nIt belongs under ${correctTab}, not ${currentTab}.\nSwitch to ${correctTab} and upload there?`)) {
      switchDocFilter(category);
      _docPendingFile = file;
      _docShareSel = new Set();
      $('docUploadFilename').textContent = file.name;
      $('docUploadIcon').textContent = _docIcon(file.type, file.name);
      renderDocSharePicker();
      $('docUploadForm').style.display = 'flex';
      $('docUploadTrigger').style.display = 'none';
    }
    return;
  }

  _docPendingFile = file;
  _docShareSel = new Set();
  $('docUploadFilename').textContent = file.name;
  $('docUploadIcon').textContent = _docIcon(file.type, file.name);
  renderDocSharePicker();
  $('docUploadForm').style.display = 'flex';
  $('docUploadTrigger').style.display = 'none';
}

function cancelDocUpload() {
  _docPendingFile = null;
  $('docUploadForm').style.display = 'none';
  $('docUploadTrigger').style.display = '';
  $('docUploadDesc').value = '';
  const btn = $('docUploadForm').querySelector('button[onclick="uploadDoc()"]');
  if (btn) { btn.textContent = 'Upload'; btn.disabled = false; }
  _docShareSel.clear();
}

function renderDocSharePicker() {
  const picker = $('docSharePicker');
  const others = _docUsers.filter(u => u.id !== (getCurrentUserId?.() ?? null));
  if (!others.length) {
    picker.innerHTML = '<span style="font-size:12px;color:var(--muted)">No other users to share with</span>';
    return;
  }
  const everyoneSel = _docShareSel.has('*');
  picker.innerHTML =
    `<button onclick="toggleDocShare('*')" style="background:${everyoneSel ? 'var(--accent)' : 'var(--bg2)'};border:1px solid ${everyoneSel ? 'var(--accent)' : 'var(--border)'};color:${everyoneSel ? '#fff' : 'var(--text)'};border-radius:20px;padding:4px 11px;font-size:12px;cursor:pointer;transition:all .15s">🌐 Everyone</button>` +
    others.map(u => {
      const sel = _docShareSel.has(u.id);
      return `<button onclick="toggleDocShare('${escHtml(u.id)}')" style="background:${sel ? 'var(--accent)' : 'var(--bg2)'};border:1px solid ${sel ? 'var(--accent)' : 'var(--border)'};color:${sel ? '#fff' : 'var(--text)'};border-radius:20px;padding:4px 11px;font-size:12px;cursor:pointer;transition:all .15s">${escHtml(u.emoji ?? '🧑')} ${escHtml(u.name)}</button>`;
    }).join('');
}

function toggleDocShare(id) {
  if (id === '*') {
    if (_docShareSel.has('*')) _docShareSel.clear();
    else { _docShareSel.clear(); _docShareSel.add('*'); }
  } else {
    _docShareSel.delete('*');
    if (_docShareSel.has(id)) _docShareSel.delete(id);
    else _docShareSel.add(id);
  }
  renderDocSharePicker();
}

async function uploadDoc() {
  if (!_docPendingFile) return;
  const btn = $('docUploadForm').querySelector('button[onclick="uploadDoc()"]');
  const origText = btn.textContent;
  btn.textContent = 'Uploading…';
  btn.disabled = true;
  try {
    const params = new URLSearchParams();
    const sharedWith = [..._docShareSel].join(',');
    if (sharedWith) params.set('sharedWith', sharedWith);
    const desc = $('docUploadDesc').value.trim();
    if (desc) params.set('description', desc);

    const form = new FormData();
    form.append('file', _docPendingFile, _docPendingFile.name);

    const r = await fetch(`/api/shared-docs?${params}`, { method: 'POST', body: form }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    showToast('Document uploaded!', 2000);
    cancelDocUpload();
    loadDocList();
  } catch (e) {
    showToast('Upload failed: ' + e.message);
    btn.textContent = origText;
    btn.disabled = false;
  }
}

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadDoc(id, filename) {
  try {
    const resp = await fetch(`/api/shared-docs/${id}/download`);
    if (!resp.ok) throw new Error('Server error ' + resp.status);
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { showToast('Download failed: ' + e.message); }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteDoc(id, filename) {
  if (!confirm(`Delete "${filename}"?`)) return;
  try {
    const r = await fetch(`/api/shared-docs/${id}`, { method: 'DELETE' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    showToast('Deleted', 1500);
    loadDocList();
  } catch (e) { showToast('Delete failed: ' + e.message); }
}

// ── Document viewer ───────────────────────────────────────────────────────────

let _docViewId       = null;
let _docViewFilename = '';

function openDocViewer(id, filename, mimeType, source) {
  _docViewId       = id;
  _docViewFilename = filename;
  $('docViewTitle').textContent = filename;

  // Find the doc object for proper URL resolution
  const doc = _docAllDocs.find(d => d.id === id) || { id, filename, mimeType, _source: source || null };
  const viewUrl = _viewUrl(doc);

  // Set download button based on source
  if (source === 'ai-image') {
    $('docViewDownloadBtn').onclick = () => downloadAiFile('images', filename);
  } else if (source === 'ai-video') {
    $('docViewDownloadBtn').onclick = () => downloadAiFile('videos', filename);
  } else if (source === 'code') {
    $('docViewDownloadBtn').onclick = () => downloadCodeProject(filename);
  } else {
    $('docViewDownloadBtn').onclick = () => downloadDoc(id, filename);
  }

  const content  = $('docViewContent');
  const isImage  = mimeType.startsWith('image/');
  const isVideo  = mimeType.startsWith('video/');
  const isPdf    = mimeType.includes('pdf') || /\.pdf$/i.test(filename);
  const isText   = /^text\//.test(mimeType) || /\.(txt|md|csv)$/i.test(filename);

  // Reset padding for non-iframe content
  content.style.padding = '16px';

  if (isImage) {
    content.innerHTML = `<img src="${viewUrl}" style="max-width:100%;max-height:72vh;object-fit:contain;border-radius:6px;display:block;margin:auto">`;
  } else if (isVideo) {
    content.innerHTML = `<video src="${viewUrl}" controls autoplay style="max-width:100%;max-height:72vh;border-radius:6px;display:block;margin:auto"></video>`;
  } else if (isPdf) {
    content.style.padding = '0';
    content.innerHTML = `<iframe src="${viewUrl}" style="width:100%;height:75vh;border:none;display:block"></iframe>`;
  } else if (source === 'research') {
    content.innerHTML = '<div style="color:var(--muted);font-size:13px">Loading…</div>';
    fetch(`/api/research/${id}`).then(r => r.json()).then(data => {
      content.innerHTML = `<div style="max-height:70vh;overflow:auto;background:var(--bg3);border-radius:8px;padding:14px;box-sizing:border-box">${renderMarkdown?.(data.content ?? '') ?? escHtml(data.content ?? '')}</div>`;
    }).catch(() => { content.innerHTML = '<div style="color:var(--muted);font-size:13px">Failed to load</div>'; });
  } else if (isText) {
    content.innerHTML = '<div style="color:var(--muted);font-size:13px">Loading…</div>';
    fetch(`/api/shared-docs/${id}/content`).then(r => r.json()).then(data => {
      content.innerHTML = `<pre style="margin:0;width:100%;max-height:70vh;overflow:auto;font-size:12px;font-family:monospace;white-space:pre-wrap;word-break:break-word;background:var(--bg3);border-radius:8px;padding:14px;box-sizing:border-box">${escHtml(data.text ?? '')}</pre>`;
    }).catch(() => { content.innerHTML = '<div style="color:var(--muted);font-size:13px">Failed to load</div>'; });
  } else if (source === 'code') {
    const doc2 = _docAllDocs.find(d => d.id === id);
    const fileWord = doc2?._fileCount === 1 ? 'file' : 'files';
    const safeNameJs = escHtml(filename).replace(/'/g, "&#39;");
    content.innerHTML = `<div style="text-align:center;padding:20px 0">
      <div style="font-size:52px;margin-bottom:12px">💻</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">${escHtml(filename)}</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:18px">${doc2?._fileCount ?? 0} ${fileWord} · ${_fmtSize(doc2?.size ?? 0)}</div>
      <button onclick="downloadCodeProject('${safeNameJs}')" style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:9px 22px;font-size:13px;font-weight:600;cursor:pointer">⬇ Download as zip</button>
    </div>`;
  } else {
    content.innerHTML = `<div style="text-align:center;padding:20px 0">
      <div style="font-size:52px;margin-bottom:12px">${_docIcon(mimeType, filename)}</div>
      <div style="font-size:14px;color:var(--muted);margin-bottom:18px">No preview available for this file type</div>
      <button onclick="downloadDoc('${escHtml(id)}','${escHtml(filename).replace(/'/g,"&#39;")}')" style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:9px 22px;font-size:13px;font-weight:600;cursor:pointer">⬇ Download</button>
    </div>`;
  }

  $('docViewModal').style.display = 'flex';
}

function closeDocViewer() {
  // Pause any playing video before clearing
  const vid = $('docViewContent').querySelector('video');
  if (vid) { vid.pause(); vid.src = ''; }
  $('docViewContent').innerHTML = '';
  $('docViewModal').style.display = 'none';
  _docViewId = null;
}

// ── Ask Agent modal ───────────────────────────────────────────────────────────

function openDocAskModal(id, filename, mimeType) {
  _docAskId   = id;
  _docAskMime = mimeType;
  $('docAskFilename').textContent = filename;
  const sel = $('docAskAgent');
  sel.innerHTML = (typeof agents !== 'undefined' ? agents : [])
    .map(a => `<option value="${escHtml(a.id)}"${a.id === activeAgent ? ' selected' : ''}>${escHtml(a.emoji ?? '')} ${escHtml(a.name)}</option>`)
    .join('');
  $('docAskPrompt').value = 'Please summarize this document.';
  $('docAskModal').style.display = 'flex';
}

function closeDocAskModal() {
  $('docAskModal').style.display = 'none';
  _docAskId = null;
}

async function submitDocAsk() {
  if (!_docAskId) return;
  const agentId = $('docAskAgent').value;
  const prompt  = $('docAskPrompt').value.trim();
  if (!agentId || !prompt) return;
  const btn = $('docAskModal').querySelector('button[onclick="submitDocAsk()"]');
  const origText = btn.textContent;
  btn.textContent = 'Loading…';
  btn.disabled = true;
  try {
    const content = await fetch(`/api/shared-docs/${_docAskId}/content`).then(r => r.json());
    if (content.error) throw new Error(content.error);
    closeDocAskModal();
    closeAllDrawers();
    if (agentId !== activeAgent) switchAgent(agentId);
    // Brief pause to let agent switch settle before sending
    await new Promise(r => setTimeout(r, 250));
    if (content.isImage) {
      ws?.send(JSON.stringify({ type: 'chat', agent: agentId, text: prompt,
        attachment: { name: content.name, mimeType: content.mimeType, isImage: true, base64: content.base64 } }));
    } else {
      const fullText = content.text
        ? `${prompt}\n\n[Document: ${content.name}]\n${content.text}`
        : prompt;
      ws?.send(JSON.stringify({ type: 'chat', agent: agentId, text: fullText }));
    }
  } catch (e) {
    showToast('Failed: ' + e.message);
    btn.textContent = origText;
    btn.disabled = false;
  }
}

// ── Share modal (update sharing on existing doc) ───────────────────────────

function openDocShareModal(id) {
  const doc = _docAllDocs.find(d => d.id === id);
  if (!doc) return;
  _docShareModalId  = id;
  _docShareModalSel = new Set(doc.sharedWith ?? []);
  $('docShareModalFilename').textContent = doc.filename;
  renderDocShareModalPicker();
  $('docShareModal').style.display = 'flex';
}

function closeDocShareModal() {
  $('docShareModal').style.display = 'none';
  _docShareModalId  = null;
  _docShareModalSel = new Set();
  const btn = $('docShareModal').querySelector('button[onclick="saveDocShare()"]');
  if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
}

function renderDocShareModalPicker() {
  const picker = $('docShareModalPicker');
  const others = _docUsers.filter(u => u.id !== (getCurrentUserId?.() ?? null));
  if (!others.length) {
    picker.innerHTML = '<span style="font-size:12px;color:var(--muted)">No other users to share with</span>';
    return;
  }
  const everyoneSel = _docShareModalSel.has('*');
  picker.innerHTML =
    `<button onclick="toggleDocShareModal('*')" style="background:${everyoneSel ? 'var(--accent)' : 'var(--bg2)'};border:1px solid ${everyoneSel ? 'var(--accent)' : 'var(--border)'};color:${everyoneSel ? '#fff' : 'var(--text)'};border-radius:20px;padding:4px 11px;font-size:12px;cursor:pointer;transition:all .15s">🌐 Everyone</button>` +
    others.map(u => {
      const sel = _docShareModalSel.has(u.id);
      return `<button onclick="toggleDocShareModal('${escHtml(u.id)}')" style="background:${sel ? 'var(--accent)' : 'var(--bg2)'};border:1px solid ${sel ? 'var(--accent)' : 'var(--border)'};color:${sel ? '#fff' : 'var(--text)'};border-radius:20px;padding:4px 11px;font-size:12px;cursor:pointer;transition:all .15s">${escHtml(u.emoji ?? '🧑')} ${escHtml(u.name)}</button>`;
    }).join('');
}

function toggleDocShareModal(id) {
  if (id === '*') {
    if (_docShareModalSel.has('*')) _docShareModalSel.clear();
    else { _docShareModalSel.clear(); _docShareModalSel.add('*'); }
  } else {
    _docShareModalSel.delete('*');
    if (_docShareModalSel.has(id)) _docShareModalSel.delete(id);
    else _docShareModalSel.add(id);
  }
  renderDocShareModalPicker();
}

async function saveDocShare() {
  if (!_docShareModalId) return;
  const btn = $('docShareModal').querySelector('button[onclick="saveDocShare()"]');
  const origText = btn.textContent;
  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    const doc = _docAllDocs.find(d => d.id === _docShareModalId);
    const sharedWith = [..._docShareModalSel];

    if (doc?._source) {
      // AI-sourced items use the /api/sharing endpoint
      const fileType = doc._source === 'ai-image' ? 'image'
                     : doc._source === 'ai-video' ? 'video'
                     : doc._source === 'research' ? 'research'
                     : 'document';
      const r = await fetch('/api/sharing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileType, fileId: doc.id, filename: doc.filename, sharedWith }),
      }).then(r => r.json());
      if (r.error) throw new Error(r.error);
    } else {
      // Uploaded docs use the /api/shared-docs PATCH endpoint
      const r = await fetch(`/api/shared-docs/${_docShareModalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sharedWith }),
      }).then(r => r.json());
      if (r.error) throw new Error(r.error);
    }

    showToast('Sharing updated!', 2000);
    closeDocShareModal();
    loadDocList();
  } catch (e) {
    showToast('Failed: ' + e.message);
    btn.textContent = origText;
    btn.disabled = false;
  }
}

// ── AI-sourced file helpers ──────────────────────────────────────────────────

async function downloadAiFile(type, filename) {
  try {
    const resp = await fetch(`/api/desktop/${type}/${encodeURIComponent(filename)}`);
    if (!resp.ok) throw new Error('Server error ' + resp.status);
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { showToast('Download failed: ' + e.message); }
}

async function deleteAiImage(filename) {
  if (!confirm(`Delete "${filename}"?`)) return;
  try {
    const r = await fetch(`/api/desktop/images/${encodeURIComponent(filename)}`, { method: 'DELETE' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    showToast('Deleted', 1500);
    loadDocList();
  } catch (e) { showToast('Delete failed: ' + e.message); }
}

async function deleteAiVideo(filename) {
  if (!confirm(`Delete "${filename}"?`)) return;
  try {
    const r = await fetch(`/api/desktop/videos/${encodeURIComponent(filename)}`, { method: 'DELETE' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    showToast('Deleted', 1500);
    loadDocList();
  } catch (e) { showToast('Delete failed: ' + e.message); }
}

// ── Code project helpers ──────────────────────────────────────────────────────
// Docs drawer entries for _source === 'code' route through these; keeps the
// existing Desktop → Code Projects pane handlers (code-projects.js) intact.

async function downloadCodeProject(name) {
  try {
    // Fetch as a blob and save via an object URL instead of navigating the
    // browser to the zip URL directly. Chromium-family browsers show an
    // "insecure content" pre-dialog with "File Size: Unknown" for any HTTP
    // (non-HTTPS) download, because the dialog fires before the request is
    // even made. Blob URLs sidestep that entirely — the size is known up
    // front and the download just completes. The auth.js fetch wrapper
    // already adds the Authorization header, so no URL token is needed.
    const r = await fetch(`/api/coder/projects/${encodeURIComponent(name)}/download`);
    if (!r.ok) {
      let msg = `Download failed (${r.status})`;
      try { const j = await r.json(); if (j?.error) msg = j.error; } catch {}
      showToast(msg);
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { showToast('Download failed: ' + e.message); }
}

async function deleteCodeProjectFromDocs(name) {
  if (!confirm(`Delete project "${name}"? This removes all its files and cannot be undone.`)) return;
  try {
    const r = await fetch(`/api/coder/projects/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) {
      let msg = 'Delete failed';
      try { const j = await r.json(); if (j?.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    showToast('Project deleted', 1500);
    loadDocList();
  } catch (e) { showToast('Delete failed: ' + e.message); }
}

async function deleteResearchDoc(id, filename) {
  if (!confirm(`Delete "${filename}"?`)) return;
  try {
    const r = await fetch(`/api/research/${id}`, { method: 'DELETE' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    showToast('Deleted', 1500);
    loadDocList();
  } catch (e) { showToast('Delete failed: ' + e.message); }
}
