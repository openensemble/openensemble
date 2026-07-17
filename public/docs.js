// ── Shared Documents ───────────────────────────────────────────────────────────

let _docUsers        = [];
let _docShareSel     = new Set();
let _docPendingFile  = null;
let _docFilter       = 'all'; // 'all' | 'photos' | 'videos' | 'audio' | 'code'
let _docAllDocs      = [];
let _docShareModalId  = null;
let _docShareModalSel = new Set();

// Called by drawers.js when drawerNotes opens
async function openNotesDrawer() {
  switchDocTab('docs');
  switchDocFilter('all');
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
    const [uploadedDocs, aiImages, aiVideos, audioFiles, researchDocs, shares, codeResp] = await Promise.all([
      fetch('/api/shared-docs').then(r => r.json()).catch(() => []),
      fetch('/api/desktop/images').then(r => r.json()).catch(() => []),
      fetch('/api/desktop/videos').then(r => r.json()).catch(() => []),
      fetch('/api/desktop/audio').then(r => r.json()).catch(() => []),
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

    // Normalize audio files (chat-uploaded or otherwise) into the same shape
    const audDocs = audioFiles.map(aud => {
      const ext = '.' + (aud.filename.split('.').pop() || 'wav');
      const mt = ext === '.mp3' ? 'audio/mpeg'
               : ext === '.wav' ? 'audio/wav'
               : ext === '.flac' ? 'audio/flac'
               : ext === '.ogg' || ext === '.oga' ? 'audio/ogg'
               : ext === '.m4a' || ext === '.aac' ? 'audio/mp4'
               : ext === '.opus' ? 'audio/opus'
               : 'audio/mpeg';
      const fileId = 'audio_' + aud.filename;
      const share = _sharesByFileId[fileId];
      return {
        id: fileId,
        filename: aud.filename,
        ext, mimeType: mt,
        size: aud.size,
        uploadedBy: null,
        uploadedByName: 'Audio',
        sharedWith: share?.sharedWith ?? [],
        createdAt: aud.createdAt,
        isOwn: true,
        _source: 'audio',
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
      .filter(d => !seen.has(d.id) && !imgDocs.some(x => x.id === d.id) && !vidDocs.some(x => x.id === d.id) && !audDocs.some(x => x.id === d.id) && !resDocs.some(x => x.id === d.id));

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

    _docAllDocs = [...uploadedDocs, ...imgDocs, ...vidDocs, ...audDocs, ...resDocs, ...codeDocs, ...sharedWithMe];
    applyDocFilter(_docFilter);
  } catch {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:20px;text-align:center">Failed to load documents</div>';
  }
}

function switchDocFilter(filter) {
  _docFilter = filter;
  // Update tab styles
  ['all','photos','videos','audio','code'].forEach(f => {
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
  else if (filter === 'audio')  docs = docs.filter(d => d.mimeType.startsWith('audio/'));
  else if (filter === 'code')   docs = docs.filter(d => d._source === 'code');
  else docs = docs.filter(d => d._source !== 'code' && !d.mimeType.startsWith('image/') && !d.mimeType.startsWith('video/') && !d.mimeType.startsWith('audio/'));
  renderDocList(docs, filter);
}

function _docIcon(mimeType, filename) {
  const ext = (filename.split('.').pop() ?? '').toLowerCase();
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('audio/')) return '🎙️';
  if (mimeType.startsWith('video/')) return '🎬';
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
  if (doc._source === 'audio')    return `/api/desktop/audio/${encodeURIComponent(doc.filename)}?token=${token}`;
  return `/api/shared-docs/${doc.id}/view?token=${token}`;
}

function renderDocList(docs, filter) {
  const list = $('docList');
  if (!docs.length) {
    const msg = filter === 'photos' ? 'No images yet.'
              : filter === 'videos' ? 'No videos yet.'
              : filter === 'audio'  ? 'No audio files yet.'
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
      if (doc.sharedWith?.includes('*'))  { sharedLabel = 'Everyone'; sharedColor = 'var(--accent)'; }
      else if (doc.sharedWith?.length)    { sharedLabel = `${doc.sharedWith.length} user${doc.sharedWith.length > 1 ? 's' : ''}`; sharedColor = 'var(--accent)'; }
      else                                { sharedLabel = 'Private'; sharedColor = 'var(--muted)'; }
    } else {
      sharedLabel = `From ${escHtml(doc.uploadedByName)}`;
      sharedColor = 'var(--muted)';
    }
    const safeId   = escHtml(doc.id);
    const safeName = escHtml(doc.filename).replace(/'/g, '&#39;');
    const safeMime = escHtml(doc.mimeType).replace(/'/g, '&#39;');
    const safeSource = escHtml(doc._source ?? '');
    const clickAttr = `data-action="openDocViewer" data-args='${JSON.stringify([doc.id, doc.filename, doc.mimeType, doc._source ?? '']).replace(/'/g, "&#39;")}'`;

    let thumbHtml;
    if (isImage) {
      thumbHtml = `<div ${clickAttr} style="width:100%;aspect-ratio:4/3;overflow:hidden;cursor:pointer;background:var(--bg2);display:flex;align-items:center;justify-content:center">
        <img src="${viewUrl}" style="width:100%;height:100%;object-fit:cover" loading="lazy"
          data-error-action="_imgFallbackEmoji">
      </div>`;
    } else if (isVideo) {
      thumbHtml = `<div ${clickAttr} style="width:100%;aspect-ratio:4/3;overflow:hidden;cursor:pointer;background:#000;position:relative;display:flex;align-items:center;justify-content:center">
        <video src="${viewUrl}" style="width:100%;height:100%;object-fit:cover" preload="metadata" muted playsinline></video>
        <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
          <div style="width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff">▶</div>
        </div>
      </div>`;
    } else if (doc.mimeType.startsWith('audio/')) {
      // Audio thumbnail: waveform glyph + inline mini-player. Compact card
      // that still lets the user preview the file without opening the viewer.
      thumbHtml = `<div ${clickAttr} style="width:100%;aspect-ratio:4/3;overflow:hidden;cursor:pointer;background:var(--bg2);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">
        <span style="font-size:44px">🎙️</span>
        <audio controls preload="none" src="${viewUrl}" style="width:90%;max-width:240px" data-stop-propagation="true"></audio>
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
            data-error-action="_imgShowFallbackSibling">
          <div style="display:none;position:absolute;inset:0;align-items:center;justify-content:center;font-size:40px">${icon}</div>
        </div>`;
      }
    }

    // Action buttons — all items get share; download/delete/ask vary by source
    const argsId      = JSON.stringify([doc.id]).replace(/'/g, "&#39;");
    const argsName    = JSON.stringify([doc.filename]).replace(/'/g, "&#39;");
    const argsAi      = JSON.stringify([doc.filename]).replace(/'/g, "&#39;");
    const argsAsk     = JSON.stringify([doc.id, doc.filename, doc.mimeType]).replace(/'/g, "&#39;");
    const argsIdName  = JSON.stringify([doc.id, doc.filename]).replace(/'/g, "&#39;");
    const shareBtn = doc.isOwn ? `<button data-action="openDocShareModal" data-args='${argsId}' title="Share" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🔗</button>` : '';
    let actions;
    if (doc._source === 'ai-image') {
      actions = `<button data-action="downloadAiFile" data-args='${JSON.stringify(['images', doc.filename]).replace(/'/g, "&#39;")}' title="Download" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">⬇</button>
        ${shareBtn}
        <button data-action="deleteAiImage" data-args='${argsAi}' title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>`;
    } else if (doc._source === 'ai-video') {
      actions = `<button data-action="downloadAiFile" data-args='${JSON.stringify(['videos', doc.filename]).replace(/'/g, "&#39;")}' title="Download" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">⬇</button>
        ${shareBtn}
        <button data-action="deleteAiVideo" data-args='${argsAi}' title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>`;
    } else if (doc._source === 'research') {
      actions = `${doc.isOwn ? `<button data-action="openDocAskModal" data-args='${argsAsk}' title="Ask Agent" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🤖</button>` : ''}
        ${shareBtn}
        ${doc.isOwn ? `<button data-action="deleteResearchDoc" data-args='${argsIdName}' title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>` : ''}`;
    } else if (doc._source === 'code') {
      actions = `<button data-action="downloadCodeProject" data-args='${argsName}' title="Download zip" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">⬇</button>
        <button data-action="deleteCodeProjectFromDocs" data-args='${argsName}' title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>`;
    } else if (doc._source === 'audio') {
      actions = `<button data-action="downloadAudioFile" data-args='${argsName}' title="Download" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">⬇</button>
        ${shareBtn}
        <button data-action="deleteAudioFile" data-args='${argsName}' title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>`;
    } else {
      actions = `<button data-action="downloadDoc" data-args='${argsIdName}' title="Download" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">⬇</button>
        <button data-action="openDocAskModal" data-args='${argsAsk}' title="Ask Agent" style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🤖</button>
        ${shareBtn}
        ${doc.isOwn ? `<button data-action="deleteDoc" data-args='${argsIdName}' title="Delete" style="background:var(--bg2);border:1px solid var(--border);color:var(--red,#e55);border-radius:5px;padding:3px 7px;font-size:11px;cursor:pointer">🗑</button>` : ''}`;
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

  // Populate previews after render. Run sequentially so a drawer with many
  // docs (10+ text + research items rendered together) doesn't fan out a burst
  // that hits the 120-req/min per-IP rate limit.
  (async () => {
    for (const el of list.querySelectorAll('[data-text-preview]')) {
      try {
        const data = await fetch(`/api/shared-docs/${el.dataset.textPreview}/content`).then(r => r.json());
        const pre = el.querySelector('pre');
        if (pre) pre.textContent = data.text?.slice(0, 400) ?? '(empty)';
      } catch {}
    }
    for (const el of list.querySelectorAll('[data-research-preview]')) {
      try {
        const data = await fetch(`/api/research/${el.dataset.researchPreview}`).then(r => r.json());
        const pre = el.querySelector('pre');
        if (pre) pre.textContent = (data.content ?? '').replace(/^#+ /gm, '').slice(0, 400) || '(empty)';
      } catch {}
    }
  })();
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
  const btn = $('docUploadForm').querySelector('button[data-action="uploadDoc"]');
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
    `<button data-action="toggleDocShare" data-args='["*"]' style="background:${everyoneSel ? 'var(--accent)' : 'var(--bg2)'};border:1px solid ${everyoneSel ? 'var(--accent)' : 'var(--border)'};color:${everyoneSel ? '#fff' : 'var(--text)'};border-radius:20px;padding:4px 11px;font-size:12px;cursor:pointer;transition:all .15s">🌐 Everyone</button>` +
    others.map(u => {
      const sel = _docShareSel.has(u.id);
      return `<button data-action="toggleDocShare" data-args='${JSON.stringify([u.id]).replace(/'/g, "&#39;")}' style="background:${sel ? 'var(--accent)' : 'var(--bg2)'};border:1px solid ${sel ? 'var(--accent)' : 'var(--border)'};color:${sel ? '#fff' : 'var(--text)'};border-radius:20px;padding:4px 11px;font-size:12px;cursor:pointer;transition:all .15s">${escHtml(u.emoji ?? '🧑')} ${escHtml(u.name)}</button>`;
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
  const btn = $('docUploadForm').querySelector('button[data-action="uploadDoc"]');
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

function _startBrowserDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadDoc(id, filename) {
  const token = getMediaTokenSync();
  const url = `/api/shared-docs/${encodeURIComponent(id)}/download`
    + (token ? `?token=${encodeURIComponent(token)}` : '');
  _startBrowserDownload(url, filename);
}

async function downloadResearchDoc(id, filename) {
  try {
    const response = await fetch(`/api/research/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error('Server error ' + response.status);
    const data = await response.json();
    if (data.error) throw new Error(data.error);
    const blob = new Blob([data.content ?? ''], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = /\.(?:md|markdown)$/i.test(filename) ? filename : `${filename}.md`;
    a.click();
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
let _docViewMime     = '';
let _docViewSource   = '';
let _docViewRequestedCompare = null;
let _docViewerReturnFocus = null;
let _docViewRenderSeq = 0;

const _DOC_EDITABLE_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml', 'yml', 'yaml',
  'toml', 'ini', 'log', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh',
  'css', 'sql', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp',
]);

function _isDocTextEditable(filename, mimeType, source = '') {
  if (source === 'research') return true;
  const ext = String(filename ?? '').split('.').pop().toLowerCase();
  return String(mimeType ?? '').toLowerCase().startsWith('text/') || _DOC_EDITABLE_EXTS.has(ext);
}

function _canAgentEditDocuments(agent) {
  if (!agent) return false;
  if (agent.provider === 'fireworks') return false;
  const model = String(agent.model ?? '').toLowerCase();
  if (agent.provider === 'grok' && /image|video|imagine/.test(model)) return false;
  return true;
}

function openDocViewer(id, filename, mimeType, source, compareVersion = null) {
  _docViewerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  _docViewId       = id;
  _docViewFilename = filename;
  _docViewMime     = mimeType;
  _docViewSource   = source || '';
  _docViewRequestedCompare = Number(compareVersion) || null;
  $('docViewTitle').textContent = filename;
  $('docViewVersionLabel').textContent = '';

  // Version history exists for uploaded docs and (own) research docs
  const _askMeta  = _docAllDocs.find(d => d.id === id);
  const _isOwn    = _askMeta?.isOwn !== false;
  const _editable = _isOwn && _isDocTextEditable(filename, mimeType, source);
  const _askable  = source === 'research'
    ? _isOwn
    : !source && !String(mimeType ?? '').startsWith('video/') && !String(mimeType ?? '').startsWith('audio/');
  _docViewVersions = [];
  _docViewIsOwn    = false;
  $('docViewHistoryBtn').style.display = 'none';
  $('docViewCompareBtn').style.display = 'none';
  const histPanel = $('docViewHistory');
  if (histPanel) { histPanel.style.display = 'none'; histPanel.innerHTML = ''; }
  $('docViewHistoryBtn').setAttribute('aria-expanded', 'false');
  document.querySelector('.doc-workspace-body')?.classList.remove('has-history', 'history-hidden');
  if (_editable) _loadDocVersionsUI(id);

  // Review + ask bars: ask makes sense for uploaded docs and own research docs
  // (the agent can read text and images; edits land back here via doc_changed)
  const reviewBar = $('docViewReviewBar');
  if (reviewBar) reviewBar.style.display = 'none';
  const askBar = $('docViewAskBar');
  if (askBar) {
    askBar.style.display = _askable ? 'flex' : 'none';
    if (_askable) {
      $('docViewAskAgent').innerHTML = (typeof agents !== 'undefined' ? agents : [])
        .filter(_canAgentEditDocuments)
        .map(a => `<option value="${escHtml(a.id)}"${a.id === activeAgent ? ' selected' : ''}>${escHtml(a.emoji ?? '')} ${escHtml(a.name)}</option>`)
        .join('');
      $('docViewAskInput').value = '';
      $('docViewAskStatus').textContent = '';
      const askSubmit = $('docViewAskSubmit');
      if (askSubmit) askSubmit.disabled = false;
    }
  }

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
  } else if (source === 'audio') {
    $('docViewDownloadBtn').onclick = () => downloadAudioFile(filename);
  } else if (source === 'research') {
    $('docViewDownloadBtn').onclick = () => downloadResearchDoc(id, filename);
  } else {
    $('docViewDownloadBtn').onclick = () => downloadDoc(id, filename);
  }

  const content  = $('docViewContent');
  const isImage  = mimeType.startsWith('image/');
  const isVideo  = mimeType.startsWith('video/');
  const isAudio  = mimeType.startsWith('audio/');
  const isPdf    = mimeType.includes('pdf') || /\.pdf$/i.test(filename);
  const isHtml   = /\.html?$/i.test(filename) || /text\/html/i.test(mimeType);
  const isText   = _isDocTextEditable(filename, mimeType, source);

  // Reset the stage after an iframe/media viewer changed its spacing.
  content.style.padding = '';

  if (isImage) {
    content.innerHTML = `<img src="${viewUrl}" style="max-width:100%;max-height:72vh;object-fit:contain;border-radius:6px;display:block;margin:auto">`;
  } else if (isVideo) {
    content.innerHTML = `<video src="${viewUrl}" controls autoplay style="max-width:100%;max-height:72vh;border-radius:6px;display:block;margin:auto"></video>`;
  } else if (isAudio) {
    content.innerHTML = `<div style="text-align:center;padding:24px 0">
      <div style="font-size:52px;margin-bottom:12px">🎙️</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:18px">${escHtml(filename)}</div>
      <audio src="${viewUrl}" controls autoplay style="width:100%;max-width:520px"></audio>
    </div>`;
  } else if (isPdf) {
    content.style.padding = '0';
    content.innerHTML = `<iframe src="${viewUrl}" title="${escHtml(filename)}" style="width:100%;height:100%;border:none;display:block"></iframe>`;
  } else if (isHtml) {
    // Never load HTML via /view URL (server forces attachment for XSS safety).
    // Fetch text content and render in a sandboxed iframe (no scripts).
    content.style.padding = '0';
    content.innerHTML = `
      <div class="doc-html-viewer" data-doc-html-mode="preview">
        <div class="doc-html-toolbar">
          <span class="doc-html-toolbar-label">HTML preview (scripts disabled)</span>
          <button type="button" class="html-preview-btn" data-action="toggleDocHtmlMode" data-doc-html-toggle>Show source</button>
        </div>
        <iframe class="doc-html-frame" sandbox="" referrerpolicy="no-referrer" title="${escHtml(filename)}"></iframe>
        <pre class="doc-html-source" hidden></pre>
      </div>`;
    _loadDocHtmlContent(id);
  } else if (source === 'research' || isText) {
    _loadDocTextContent(id);
  } else if (source === 'code') {
    const doc2 = _docAllDocs.find(d => d.id === id);
    const fileWord = doc2?._fileCount === 1 ? 'file' : 'files';
    const safeNameJs = escHtml(filename).replace(/'/g, "&#39;");
    content.innerHTML = `<div style="text-align:center;padding:20px 0">
      <div style="font-size:52px;margin-bottom:12px">💻</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">${escHtml(filename)}</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:18px">${doc2?._fileCount ?? 0} ${fileWord} · ${_fmtSize(doc2?.size ?? 0)}</div>
      <button data-action="downloadCodeProject" data-args='${JSON.stringify([filename]).replace(/'/g, "&#39;")}' style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:9px 22px;font-size:13px;font-weight:600;cursor:pointer">⬇ Download as zip</button>
    </div>`;
  } else {
    content.innerHTML = `<div style="text-align:center;padding:20px 0">
      <div style="font-size:52px;margin-bottom:12px">${_docIcon(mimeType, filename)}</div>
      <div style="font-size:14px;color:var(--muted);margin-bottom:18px">No preview available for this file type</div>
      <button data-action="downloadDoc" data-args='${JSON.stringify([id, filename]).replace(/'/g, "&#39;")}' style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:9px 22px;font-size:13px;font-weight:600;cursor:pointer">⬇ Download</button>
    </div>`;
  }

  $('docViewModal').style.display = 'flex';
  setTimeout(() => $('docViewCloseBtn')?.focus(), 0);
}

function closeDocViewer() {
  _docViewRenderSeq++;
  // Pause any playing video before clearing
  const vid = $('docViewContent').querySelector('video');
  if (vid) { vid.pause(); vid.src = ''; }
  // Drop sandboxed HTML previews so srcdoc doesn't linger
  const htmlFrame = $('docViewContent').querySelector('.doc-html-frame');
  if (htmlFrame) {
    htmlFrame.removeAttribute('srcdoc');
    htmlFrame.src = 'about:blank';
  }
  $('docViewContent').innerHTML = '';
  const histPanel = $('docViewHistory');
  if (histPanel) { histPanel.style.display = 'none'; histPanel.innerHTML = ''; }
  const reviewBar = $('docViewReviewBar');
  if (reviewBar) reviewBar.style.display = 'none';
  $('docViewModal').style.display = 'none';
  _docViewId = null;
  _docViewSource = '';
  _docViewVersions = [];
  _docViewRequestedCompare = null;
  const returnFocus = _docViewerReturnFocus;
  _docViewerReturnFocus = null;
  if (returnFocus?.isConnected) setTimeout(() => returnFocus.focus(), 0);
}

document.addEventListener('keydown', event => {
  const modal = $('docViewModal');
  if (!modal || modal.style.display === 'none') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDocViewer();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

// ── Ask Agent (in-viewer chat) ────────────────────────────────────────────────
// The Ask button opens the doc in the viewer with the ask bar focused: you see
// the doc, tell the agent what you want, and edits land in place (with a
// review bar to keep or revert). History is never lost either way.

function openDocAskModal(id, filename, mimeType) {
  const doc = _docAllDocs.find(d => d.id === id);
  openDocViewer(id, filename, mimeType, doc?._source ?? '');
  setTimeout(() => $('docViewAskInput')?.focus(), 50);
}

async function submitDocViewerAsk() {
  if (!_docViewId) return;
  const agentId = $('docViewAskAgent').value;
  const prompt  = $('docViewAskInput').value.trim();
  if (!agentId || !prompt) return;
  const status = $('docViewAskStatus');
  const docId  = _docViewId;
  const filename = _docViewFilename;
  const mimeType = _docViewMime;
  const source = _docViewSource;
  const btn = $('docViewAskSubmit');
  if (streaming) {
    status.textContent = 'Wait for the current response to finish.';
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    status.textContent = 'Not connected. Try again in a moment.';
    return;
  }
  status.textContent = 'Preparing document...';
  if (btn) btn.disabled = true;
  let beganDocumentTurn = false;
  try {
    let payloadText = prompt;
    let attachment = null;
    const isEditable = _isDocTextEditable(filename, mimeType, source);
    const requestId = `docreq_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    if (isEditable) {
      const idLabel = source === 'research' ? `research:${docId}` : docId;
      // The tool reads the authoritative file server-side. Keeping the body out
      // of chat avoids a huge visible/persisted user message and prevents the
      // drawer's 50k preview endpoint from becoming a destructive edit source.
      payloadText = `${prompt}\n\n[Document: ${filename} | id: ${idLabel}]`;
    } else if (String(mimeType ?? '').startsWith('image/')) {
      const content = await fetch(`/api/shared-docs/${docId}/content`).then(r => r.json());
      if (content.error) throw new Error(content.error);
      if (content.isImage) {
        attachment = { name: content.name, mimeType: content.mimeType, isImage: true, base64: content.base64 };
      }
    } else {
      payloadText = `${prompt}\n\n[Document reference: ${filename} | file_id: documents:${docId}]\nUse read_profile_file to read this document before answering.`;
    }
    if (agentId !== activeAgent) {
      switchAgent(agentId);
      // Brief pause to let agent switch settle before sending
      await new Promise(r => setTimeout(r, 250));
    }
    if (isEditable) {
      beginDocumentChatTurn({
        agentId,
        text: payloadText,
        prompt,
        documentRequest: { requestId, id: docId, filename, mimeType, source },
      });
      beganDocumentTurn = true;
    }
    const payload = {
      type: 'chat', agent: agentId, text: payloadText,
      source: isEditable ? 'document-drawer' : 'chat-ui',
    };
    if (isEditable) payload.documentRequest = { requestId, id: docId, filename, mimeType, source };
    if (attachment) payload.attachment = attachment;
    ws.send(JSON.stringify(payload));
    $('docViewAskInput').value = '';
    closeDocViewer();
    closeAllDrawers();
  } catch (e) {
    if (beganDocumentTurn) rollbackDocumentChatTurn(agentId);
    status.textContent = 'Failed: ' + e.message;
    if (btn) btn.disabled = false;
  }
}

// ── Document chat artifacts ─────────────────────────────────────────────────

const _documentChatTurns = new Map();
const _remoteDocumentTurns = new Map();
const _supersededDocumentRequests = new Set();
const _DOCUMENT_MUTATION_TOOLS = new Set([
  'update_document', 'create_document', 'restore_document_version',
]);

function _documentPromptFromText(text) {
  return String(text ?? '')
    .replace(/\n{0,2}\[Document:\s*[\s\S]*?\|\s*id:\s*[^\]]+\]\s*$/i, '')
    .trim();
}

function _documentOutcomeFromToolResult(name, text) {
  if (!_DOCUMENT_MUTATION_TOOLS.has(name) || !text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed?.success) return null;
    const rawId = String(parsed.docId ?? parsed.id ?? '').replace(/^research:/, '');
    if (!rawId) return null;
    return {
      success: true,
      action: parsed.action ?? (name === 'create_document' ? 'created' : name === 'restore_document_version' ? 'restored' : 'updated'),
      docId: rawId,
      filename: parsed.filename ?? '',
      mimeType: parsed.mimeType ?? '',
      source: parsed.source ?? (String(parsed.id ?? '').startsWith('research:') ? 'research' : ''),
      version: Number(parsed.version) || null,
      previousVersion: Number(parsed.previousVersion) || null,
      note: parsed.note ?? '',
    };
  } catch {
    return null;
  }
}

function documentOutcomeFromAssistant(message) {
  if (message?.documentArtifact?.success) return message.documentArtifact;
  const events = Array.isArray(message?.toolEvents) ? message.toolEvents : [];
  const results = Array.isArray(message?.toolResults) ? message.toolResults : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!_DOCUMENT_MUTATION_TOOLS.has(event?.name)) continue;
    const result = Number.isInteger(Number(event.resultIndex))
      ? results[Number(event.resultIndex)]?.text
      : event.text;
    const outcome = _documentOutcomeFromToolResult(event.name, result);
    if (outcome) return outcome;
  }
  return null;
}

function _paintDocumentArtifact(canvas, request, text, loading = false) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(20, 25, 35, .16)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 5;
  ctx.fillRect(54, 24, width - 108, height - 34);
  ctx.shadowColor = 'transparent';

  const left = 86;
  const maxWidth = width - 172;
  ctx.fillStyle = '#1f2937';
  ctx.font = '600 21px Inter, sans-serif';
  const title = String(request.filename ?? 'Document');
  ctx.fillText(title.length > 38 ? title.slice(0, 35) + '...' : title, left, 72, maxWidth);
  ctx.fillStyle = '#d8dde6';
  ctx.fillRect(left, 88, Math.min(maxWidth, 210), 3);

  if (loading) {
    const widths = [.94, .78, .88, .62, .91, .72, .84, .54];
    widths.forEach((ratio, index) => {
      ctx.fillStyle = index % 3 === 0 ? '#dfe4ec' : '#e7eaf0';
      ctx.fillRect(left, 116 + index * 27, maxWidth * ratio, 9);
    });
    return;
  }

  const clean = String(text ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>|\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const words = clean.split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  ctx.font = '15px Inter, sans-serif';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth) {
      if (line) lines.push(line);
      line = word;
      if (lines.length >= 9) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < 9) lines.push(line);
  ctx.fillStyle = '#4b5563';
  lines.forEach((value, index) => ctx.fillText(value, left, 122 + index * 28, maxWidth));
  if (!lines.length) {
    ctx.fillStyle = '#9ca3af';
    ctx.fillText('Open to view this document', left, 122, maxWidth);
  }
}

async function _loadDocumentArtifactPreview(card, request) {
  const canvas = card?.querySelector('canvas');
  if (!canvas) return;
  try {
    const version = Number(card.querySelector('.document-artifact-card')?.dataset.version) || null;
    const base = request.source === 'research'
      ? `/api/research/${encodeURIComponent(request.id)}`
      : `/api/shared-docs/${encodeURIComponent(request.id)}`;
    const url = version
      ? `${base}/versions/${version}`
      : request.source === 'research'
        ? base
        : `${base}/content?preview=1`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    _paintDocumentArtifact(canvas, request, version ? data.text : (request.source === 'research' ? data.content : data.text), false);
  } catch {
    _paintDocumentArtifact(canvas, request, '', false);
  }
}

const _documentPreviewQueue = new WeakMap();
const _documentPreviewObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const request = _documentPreviewQueue.get(entry.target);
        _documentPreviewObserver.unobserve(entry.target);
        if (request) _loadDocumentArtifactPreview(entry.target, request);
      }
    }, { rootMargin: '180px' })
  : null;

function _queueDocumentArtifactPreview(card, request) {
  if (!card) return;
  if (!_documentPreviewObserver) {
    _loadDocumentArtifactPreview(card, request);
    return;
  }
  _documentPreviewQueue.set(card, request);
  _documentPreviewObserver.observe(card);
}

function _documentArtifactStatus(outcome, fallback = 'Working on document...') {
  if (!outcome?.success) return fallback;
  const action = outcome.action === 'created' ? 'Created' : outcome.action === 'restored' ? 'Restored' : 'Updated';
  return `${action}${outcome.version ? ` to v${outcome.version}` : ''}`;
}

function appendDocumentArtifactCard(request, { prompt = '', ts = Date.now(), state = 'processing', outcome = null, scroll = true } = {}) {
  const el = document.createElement('div');
  el.className = `msg document-artifact-message ${state}`;
  el.dataset.documentRequestId = request.requestId ?? '';
  el.dataset.documentId = request.id;

  const card = document.createElement('article');
  card.className = 'document-artifact-card';
  card.setAttribute('aria-live', 'polite');

  const preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'document-artifact-preview';
  preview.disabled = state === 'processing' || state === 'failed';
  preview.setAttribute('aria-label', `Open ${request.filename}`);
  const canvas = document.createElement('canvas');
  canvas.width = 620;
  canvas.height = 360;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Preview of ${request.filename}`);
  preview.appendChild(canvas);
  const overlay = document.createElement('span');
  overlay.className = 'document-artifact-processing';
  overlay.innerHTML = `<span class="document-artifact-file-icon">${icon('file-pen-line', 26)}</span><span class="pill-spinner"></span>`;
  preview.appendChild(overlay);
  preview.addEventListener('click', () => {
    const compareVersion = Number(card.dataset.version) || null;
    openDocViewer(request.id, request.filename, request.mimeType, request.source, compareVersion);
  });
  card.appendChild(preview);

  const meta = document.createElement('div');
  meta.className = 'document-artifact-meta';
  meta.innerHTML = `<span class="document-artifact-kind">${icon('file-text', 15)}</span><span class="document-artifact-name"></span><span class="document-artifact-state" role="status"></span>`;
  meta.querySelector('.document-artifact-name').textContent = request.filename;
  card.appendChild(meta);
  if (prompt) {
    const instruction = document.createElement('div');
    instruction.className = 'document-artifact-instruction';
    instruction.textContent = prompt;
    card.appendChild(instruction);
  }
  el.appendChild(card);
  addTimestamp(el, ts);
  insertBefore(el);

  _setDocumentArtifactState(el, state, outcome);
  if (scroll) scrollToBottom();
  return el;
}

function _setDocumentArtifactState(el, state, outcome = null) {
  if (!el) return;
  const card = el.querySelector('.document-artifact-card');
  const preview = el.querySelector('.document-artifact-preview');
  const label = el.querySelector('.document-artifact-state');
  const request = {
    id: el.dataset.documentId,
    filename: el.querySelector('.document-artifact-name')?.textContent ?? 'Document',
  };
  el.classList.remove('processing', 'complete', 'ready', 'failed');
  el.classList.add(state);
  if (preview) preview.disabled = state === 'processing' || state === 'failed';
  if (label) {
    label.textContent = card?.dataset.statusLabel || (state === 'processing'
      ? (card?.dataset.stage || 'Editing...')
      : state === 'failed'
        ? 'Edit failed'
        : state === 'ready'
          ? 'No changes saved'
          : _documentArtifactStatus(outcome, 'Ready'));
  }
  if (outcome?.version && card) card.dataset.version = String(outcome.version);
  if (state === 'processing') {
    _paintDocumentArtifact(el.querySelector('canvas'), request, '', true);
  }
}

function beginDocumentChatTurn({ agentId, text, prompt, documentRequest }) {
  if (!sessions[agentId]) sessions[agentId] = [];
  const entry = {
    role: 'user', content: text, ts: Date.now(),
    documentRequest: { ...documentRequest, status: 'processing' },
  };
  sessions[agentId].push(entry);
  updateSessionWarning();
  const el = appendDocumentArtifactCard(documentRequest, { prompt, ts: entry.ts, state: 'processing' });
  _documentChatTurns.set(agentId, {
    agentId, request: documentRequest, entry, el, response: '', outcome: null,
  });
  resetToolRun(true);
  setStreaming(true);
  setTyping(false);
  scrollToBottom(true);
}

function rollbackDocumentChatTurn(agentId) {
  const turn = _documentChatTurns.get(agentId);
  if (!turn) return false;
  const entries = sessions[agentId] ?? [];
  const index = entries.indexOf(turn.entry);
  if (index >= 0) entries.splice(index, 1);
  turn.el?.remove();
  _documentChatTurns.delete(agentId);
  if (agentId === activeAgent) {
    setStreaming(false);
    setTyping(false);
  }
  return true;
}

function isDocumentChatTurnActive(agentId) {
  return _documentChatTurns.has(agentId);
}

function _matchesDocumentTurn(turn, documentRequest) {
  return !!(turn && documentRequest?.requestId && turn.request.requestId === documentRequest.requestId);
}

function handleDocumentChatToken(agentId, text, documentRequest) {
  const turn = _documentChatTurns.get(agentId);
  if (!_matchesDocumentTurn(turn, documentRequest)) return false;
  if (turn.response.length < 50_000) {
    turn.response = (turn.response + String(text ?? '')).slice(0, 50_000);
  }
  return true;
}

function handleDocumentChatReplace(agentId, text, documentRequest) {
  const turn = _documentChatTurns.get(agentId);
  if (!_matchesDocumentTurn(turn, documentRequest)) return false;
  turn.response = String(text ?? '');
  return true;
}

function handleDocumentChatToolCall(agentId, name, args, documentRequest) {
  const turn = _documentChatTurns.get(agentId);
  if (!_matchesDocumentTurn(turn, documentRequest)) return false;
  const card = turn.el?.querySelector('.document-artifact-card');
  if (card) {
    card.dataset.stage = name === 'read_document'
      ? 'Reading...'
      : _DOCUMENT_MUTATION_TOOLS.has(name)
        ? 'Saving changes...'
        : 'Working...';
    _setDocumentArtifactState(turn.el, 'processing');
  }
  return true;
}

function handleDocumentChatToolProgress(agentId, name, text, documentRequest) {
  return _matchesDocumentTurn(_documentChatTurns.get(agentId), documentRequest);
}

function handleDocumentChatToolResult(agentId, name, text, documentRequest) {
  const turn = _documentChatTurns.get(agentId);
  if (!_matchesDocumentTurn(turn, documentRequest)) return false;
  const outcome = _documentOutcomeFromToolResult(name, text);
  if (outcome) {
    turn.outcome = outcome;
    if (outcome.docId) {
      turn.request.id = outcome.docId;
      turn.el.dataset.documentId = outcome.docId;
    }
    if (outcome.filename) turn.request.filename = outcome.filename;
    if (outcome.mimeType) turn.request.mimeType = outcome.mimeType;
    if (outcome.source != null) turn.request.source = outcome.source;
    turn.entry.documentRequest = { ...turn.request, status: 'complete', outcome };
    _setDocumentArtifactState(turn.el, 'complete', outcome);
    _queueDocumentArtifactPreview(turn.el, turn.request);
  } else if (/^(?:Error:|Tool error)/i.test(String(text ?? '').trim())) {
    turn.toolError = String(text).trim();
  }
  return true;
}

function _remoteDocumentTurnKey(agentId, request) {
  return `${agentId}:${request?.requestId || request?.id || 'document'}`;
}

function _rememberSupersededDocumentRequest(requestId) {
  if (!requestId) return;
  _supersededDocumentRequests.add(requestId);
  while (_supersededDocumentRequests.size > 100) {
    _supersededDocumentRequests.delete(_supersededDocumentRequests.values().next().value);
  }
}

function _settleRemoteDocumentTurn(turn, state = 'ready', label = '') {
  if (!turn) return;
  if (turn.outcome?.success) {
    _setDocumentArtifactState(turn.el, 'complete', turn.outcome);
    _queueDocumentArtifactPreview(turn.el, turn.request);
    return;
  }
  const card = turn.el?.querySelector('.document-artifact-card');
  if (card && label) card.dataset.statusLabel = label;
  _setDocumentArtifactState(turn.el, state);
  if (state === 'ready') _queueDocumentArtifactPreview(turn.el, turn.request);
}

function _remoteDocumentTurnForEvent(agentId, documentRequest) {
  if (!documentRequest?.id || !documentRequest?.requestId) return { handled: false, turn: null };
  if (_supersededDocumentRequests.has(documentRequest.requestId)) return { handled: true, turn: null };

  const local = _documentChatTurns.get(agentId);
  if (local) {
    if (_matchesDocumentTurn(local, documentRequest)) return { handled: true, turn: null };
    _rememberSupersededDocumentRequest(local.request.requestId);
    cancelDocumentChatTurn(agentId, 'Replaced by another request');
  }

  const key = _remoteDocumentTurnKey(agentId, documentRequest);
  for (const [otherKey, other] of _remoteDocumentTurns) {
    if (other.agentId !== agentId || otherKey === key) continue;
    _rememberSupersededDocumentRequest(other.request.requestId);
    _settleRemoteDocumentTurn(other, 'ready', 'Replaced by another request');
    _remoteDocumentTurns.delete(otherKey);
  }

  let turn = _remoteDocumentTurns.get(key);
  if (!turn) {
    const el = agentId === activeAgent
      ? appendDocumentArtifactCard(documentRequest, { state: 'processing', scroll: true })
      : null;
    turn = { agentId, request: documentRequest, el, outcome: null, response: '' };
    _remoteDocumentTurns.set(key, turn);
    if (agentId === activeAgent) {
      setStreaming(true);
      setTyping(false);
    }
  }
  return { handled: true, turn };
}

function handleRemoteDocumentToolCall(agentId, documentRequest, name) {
  const match = _remoteDocumentTurnForEvent(agentId, documentRequest);
  if (!match.handled || !match.turn) return match.handled;
  const { turn } = match;
  const card = turn.el?.querySelector('.document-artifact-card');
  if (card) {
    card.dataset.stage = name === 'read_document' ? 'Reading...' : _DOCUMENT_MUTATION_TOOLS.has(name) ? 'Saving changes...' : 'Working...';
    _setDocumentArtifactState(turn.el, 'processing');
  }
  return true;
}

function handleRemoteDocumentToolProgress(agentId, documentRequest) {
  return _remoteDocumentTurnForEvent(agentId, documentRequest).handled;
}

function handleRemoteDocumentToolResult(agentId, documentRequest, outcome) {
  const match = _remoteDocumentTurnForEvent(agentId, documentRequest);
  if (!match.handled || !match.turn) return match.handled;
  if (outcome?.success) handleDocumentArtifactEvent(agentId, documentRequest, outcome);
  return true;
}

function handleDocumentArtifactEvent(agentId, documentRequest, outcome) {
  if (!documentRequest?.id || !outcome?.success) return false;
  const request = {
    ...documentRequest,
    id: outcome.docId || documentRequest.id,
    filename: outcome.filename || documentRequest.filename,
    mimeType: outcome.mimeType || documentRequest.mimeType,
    source: outcome.source != null ? outcome.source : documentRequest.source,
  };
  const key = _remoteDocumentTurnKey(agentId, documentRequest);
  const remote = _remoteDocumentTurns.get(key);
  if (remote) {
    Object.assign(remote.request, request);
    remote.outcome = outcome;
    if (remote.el) {
      remote.el.dataset.documentId = remote.request.id;
      _setDocumentArtifactState(remote.el, 'complete', outcome);
      _queueDocumentArtifactPreview(remote.el, remote.request);
    }
  } else if (agentId === activeAgent) {
    const selector = request.requestId
      ? `.document-artifact-message[data-document-request-id="${CSS.escape(request.requestId)}"]`
      : null;
    if (!selector || !document.querySelector(selector)) {
      const el = appendDocumentArtifactCard(request, { state: 'complete', outcome, scroll: true });
      _queueDocumentArtifactPreview(el, request);
    }
  }
  if (!sessions[agentId]) sessions[agentId] = [];
  if (!sessions[agentId].some(m => m.documentArtifact && m.documentRequestId === request.requestId)) {
    sessions[agentId].push({
      role: 'assistant',
      content: `[Document ${outcome.action}: ${request.filename}${outcome.version ? ` (v${outcome.version})` : ''}]`,
      ts: Date.now(),
      documentRequestId: request.requestId,
      documentRequest: request,
      documentArtifact: outcome,
    });
  }
  return true;
}

function handleRemoteDocumentResponse(agentId, text, documentRequest) {
  const match = _remoteDocumentTurnForEvent(agentId, documentRequest);
  if (!match.handled || !match.turn) return match.handled;
  match.turn.response = String(text ?? '');
  return true;
}

function finishRemoteDocumentTurns(agentId, documentRequest = null) {
  const turns = [..._remoteDocumentTurns.entries()].filter(([, turn]) =>
    turn.agentId === agentId && (!documentRequest?.requestId || turn.request.requestId === documentRequest.requestId));
  if (!turns.length) return false;
  for (const [key, turn] of turns) {
    if (!turn.outcome) {
      _settleRemoteDocumentTurn(turn, 'ready');
      if (turn.response && agentId === activeAgent) appendAssistantBubble(turn.response, Date.now(), true);
    }
    _remoteDocumentTurns.delete(key);
  }
  return true;
}

function failRemoteDocumentTurns(agentId, documentRequest = null) {
  const turns = [..._remoteDocumentTurns.entries()].filter(([, turn]) =>
    turn.agentId === agentId && (!documentRequest?.requestId || turn.request.requestId === documentRequest.requestId));
  if (!turns.length) return false;
  for (const [key, turn] of turns) {
    if (!turn.outcome) _settleRemoteDocumentTurn(turn, 'failed');
    _remoteDocumentTurns.delete(key);
  }
  return true;
}

function cancelRemoteDocumentTurns(agentId, label = 'Stopped') {
  const turns = [..._remoteDocumentTurns.entries()].filter(([, turn]) => turn.agentId === agentId);
  if (!turns.length) return false;
  for (const [key, turn] of turns) {
    _settleRemoteDocumentTurn(turn, 'ready', label);
    _remoteDocumentTurns.delete(key);
  }
  return true;
}

function finishDocumentChatTurn(agentId, documentRequest) {
  const turn = _documentChatTurns.get(agentId);
  if (!_matchesDocumentTurn(turn, documentRequest)) return false;
  if (!turn.outcome) {
    const failed = !!turn.toolError;
    turn.entry.documentRequest = {
      ...turn.request,
      status: failed ? 'failed' : 'ready',
      ...(failed ? { error: turn.toolError.slice(0, 240) } : {}),
    };
    _setDocumentArtifactState(turn.el, failed ? 'failed' : 'ready');
    if (!failed) _queueDocumentArtifactPreview(turn.el, turn.request);
    if (turn.response.trim()) {
      const assistantEntry = {
        role: 'assistant', content: turn.response, ts: Date.now(),
        documentRequestId: turn.request.requestId,
      };
      sessions[agentId].push(assistantEntry);
      if (agentId === activeAgent) appendAssistantBubble(turn.response, assistantEntry.ts, true);
    }
  }
  _documentChatTurns.delete(agentId);
  return true;
}

function failDocumentChatTurn(agentId, message, documentRequest = null) {
  const turn = _documentChatTurns.get(agentId);
  if (!_matchesDocumentTurn(turn, documentRequest)) return false;
  if (turn.outcome?.success) {
    turn.entry.documentRequest = { ...turn.request, status: 'complete', outcome: turn.outcome };
    _setDocumentArtifactState(turn.el, 'complete', turn.outcome);
    _queueDocumentArtifactPreview(turn.el, turn.request);
    _documentChatTurns.delete(agentId);
    return true;
  }
  turn.entry.documentRequest = { ...turn.request, status: 'failed', error: String(message ?? '').slice(0, 240) };
  _setDocumentArtifactState(turn.el, 'failed');
  _documentChatTurns.delete(agentId);
  return true;
}

function cancelDocumentChatTurn(agentId, label = 'Stopped') {
  const turn = _documentChatTurns.get(agentId);
  if (!turn) return false;
  if (turn.outcome?.success) {
    turn.entry.documentRequest = { ...turn.request, status: 'complete', outcome: turn.outcome };
    _setDocumentArtifactState(turn.el, 'complete', turn.outcome);
    _queueDocumentArtifactPreview(turn.el, turn.request);
    _documentChatTurns.delete(agentId);
    return true;
  }
  turn.entry.documentRequest = { ...turn.request, status: 'ready' };
  const card = turn.el?.querySelector('.document-artifact-card');
  if (card) card.dataset.statusLabel = label;
  _setDocumentArtifactState(turn.el, 'ready');
  _queueDocumentArtifactPreview(turn.el, turn.request);
  _documentChatTurns.delete(agentId);
  return true;
}

function reconcileDocumentChatTurns(activeAgentIds) {
  const active = activeAgentIds instanceof Set ? activeAgentIds : new Set(activeAgentIds ?? []);
  let rerender = false;
  for (const [agentId, turn] of _documentChatTurns) {
    if (active.has(agentId)) continue;
    turn.entry.documentRequest = { ...turn.request, status: 'ready' };
    _documentChatTurns.delete(agentId);
    if (agentId === activeAgent) rerender = true;
  }
  const remoteAgents = new Set([..._remoteDocumentTurns.values()].map(turn => turn.agentId));
  for (const agentId of remoteAgents) {
    if (!active.has(agentId) && finishRemoteDocumentTurns(agentId) && agentId === activeAgent) rerender = true;
  }
  if (rerender) renderSession();
}

function renderDocumentSessionRequest(message, assistantMessage = null, scroll = false) {
  const request = message?.documentRequest;
  if (!request?.id || !request?.filename) return { rendered: false, hideAssistant: false };
  const persistedOutcome = documentOutcomeFromAssistant(assistantMessage);
  const outcome = persistedOutcome ?? request.outcome ?? null;
  const effectiveRequest = outcome?.success
    ? {
        ...request,
        id: outcome.docId || request.id,
        filename: outcome.filename || request.filename,
        mimeType: outcome.mimeType || request.mimeType,
        source: outcome.source != null ? outcome.source : request.source,
      }
    : request;
  const state = outcome?.success
    ? 'complete'
    : request.status === 'failed'
      ? 'failed'
      : assistantMessage
        ? 'ready'
        : (request.status || 'processing');
  const el = appendDocumentArtifactCard(effectiveRequest, {
    prompt: _documentPromptFromText(message.content), ts: message.ts,
    state, outcome, scroll,
  });
  const liveTurn = request.requestId
    ? [..._documentChatTurns.values()].find(turn => turn.request.requestId === request.requestId)
    : null;
  if (liveTurn) {
    liveTurn.el = el;
    liveTurn.entry = message;
  }
  const remoteTurn = request.requestId
    ? [..._remoteDocumentTurns.values()].find(turn => turn.request.requestId === request.requestId)
    : null;
  if (remoteTurn) {
    remoteTurn.el = el;
    Object.assign(remoteTurn.request, effectiveRequest);
  }
  if (state !== 'processing' && state !== 'failed') _queueDocumentArtifactPreview(el, effectiveRequest);
  return { rendered: true, hideAssistant: !!outcome?.success };
}

function renderStandaloneDocumentArtifact(message, scroll = false) {
  const request = message?.documentRequest;
  const outcome = message?.documentArtifact;
  if (!request?.id || !outcome?.success) return false;
  const effectiveRequest = {
    ...request,
    id: outcome.docId || request.id,
    filename: outcome.filename || request.filename,
    mimeType: outcome.mimeType || request.mimeType,
    source: outcome.source != null ? outcome.source : request.source,
  };
  const el = appendDocumentArtifactCard(effectiveRequest, {
    ts: message.ts, state: 'complete', outcome, scroll,
  });
  _queueDocumentArtifactPreview(el, effectiveRequest);
  return true;
}

// ── Review bar (keep / diff / revert after an agent edit) ────────────────────

let _docReviewSuppress = false;

function _showDocReviewBar(msg) {
  const bar = $('docViewReviewBar');
  if (!bar) return;
  $('docViewReviewLabel').textContent = `Updated to v${msg.version}${msg.byName ? ' by ' + msg.byName : ''}`;
  bar.dataset.version = String(msg.version ?? '');
  bar.style.display = 'flex';
}

function docReviewKeep() {
  // The version is already saved — keeping is just dismissing the bar
  $('docViewReviewBar').style.display = 'none';
}

function docReviewDiff() {
  const n = Number($('docViewReviewBar').dataset.version);
  if (n) showDocVersionDiff(n);
}

async function docReviewRevert() {
  const n = Number($('docViewReviewBar').dataset.version);
  const prev = n - 1;
  if (!_docViewId || !prev) return;
  try {
    _docReviewSuppress = true; // our own restore shouldn't re-open the bar
    const r = await fetch(`${_docApiBase(_docViewId)}/restore/${prev}`, { method: 'POST' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    _docReviewSuppress = false;
    $('docViewReviewBar').style.display = 'none';
    showToast(`Reverted — back to v${prev} content (v${n} stays in History)`, 2800);
    _loadDocTextContent(_docViewId);
    _loadDocVersionsUI(_docViewId);
  } catch (e) {
    _docReviewSuppress = false;
    showToast('Revert failed: ' + e.message);
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
  const btn = $('docShareModal').querySelector('button[data-action="saveDocShare"]');
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
    `<button data-action="toggleDocShareModal" data-args='["*"]' style="background:${everyoneSel ? 'var(--accent)' : 'var(--bg2)'};border:1px solid ${everyoneSel ? 'var(--accent)' : 'var(--border)'};color:${everyoneSel ? '#fff' : 'var(--text)'};border-radius:20px;padding:4px 11px;font-size:12px;cursor:pointer;transition:all .15s">🌐 Everyone</button>` +
    others.map(u => {
      const sel = _docShareModalSel.has(u.id);
      return `<button data-action="toggleDocShareModal" data-args='${JSON.stringify([u.id]).replace(/'/g, "&#39;")}' style="background:${sel ? 'var(--accent)' : 'var(--bg2)'};border:1px solid ${sel ? 'var(--accent)' : 'var(--border)'};color:${sel ? '#fff' : 'var(--text)'};border-radius:20px;padding:4px 11px;font-size:12px;cursor:pointer;transition:all .15s">${escHtml(u.emoji ?? '🧑')} ${escHtml(u.name)}</button>`;
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
  const btn = $('docShareModal').querySelector('button[data-action="saveDocShare"]');
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
                     : doc._source === 'audio' ? 'audio'
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

function downloadAiFile(type, filename) {
  // Let the browser own the transfer so large videos appear in Downloads
  // immediately instead of being silently buffered into page memory first.
  const token = getMediaTokenSync();
  const url = `/api/files/${encodeURIComponent(type)}/${encodeURIComponent(filename)}`
    + (token ? `?token=${encodeURIComponent(token)}` : '');
  _startBrowserDownload(url, filename);
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

async function downloadAudioFile(filename) {
  try {
    const resp = await fetch(`/api/desktop/audio/${encodeURIComponent(filename)}`);
    if (!resp.ok) throw new Error('Server error ' + resp.status);
    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { showToast('Download failed: ' + e.message); }
}

async function deleteAudioFile(filename) {
  if (!confirm(`Delete "${filename}"?`)) return;
  try {
    const r = await fetch(`/api/desktop/audio/${encodeURIComponent(filename)}`, { method: 'DELETE' }).then(r => r.json());
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

// ── Version history, diff & live updates ─────────────────────────────────────
// Agent edits (documents skill) append versions server-side; the viewer shows
// the trail and lets the owner restore. doc_changed WS events keep open UIs live.

let _docViewVersions = [];
let _docViewIsOwn    = false;

// Version/restore endpoints live under the store the open doc belongs to
function _docApiBase(id) {
  return _docViewSource === 'research' ? `/api/research/${id}` : `/api/shared-docs/${id}`;
}

function _loadDocTextContent(id) {
  const renderSeq = ++_docViewRenderSeq;
  const content = $('docViewContent');
  content.innerHTML = '<div class="doc-view-loading">Loading...</div>';
  if (_docViewSource === 'research') {
    fetch(`/api/research/${id}`).then(r => r.json()).then(data => {
      if (_docViewId !== id || renderSeq !== _docViewRenderSeq) return;
      content.innerHTML = `<article class="doc-current-page markdown">${renderMarkdown?.(data.content ?? '') ?? escHtml(data.content ?? '')}</article>`;
    }).catch(() => { if (renderSeq === _docViewRenderSeq) content.innerHTML = '<div class="doc-view-loading error">Failed to load</div>'; });
    return;
  }
  fetch(`/api/shared-docs/${id}/content`).then(r => r.json()).then(data => {
    if (_docViewId !== id || renderSeq !== _docViewRenderSeq) return;
    content.innerHTML = `<pre class="doc-current-page">${escHtml(data.text ?? '')}</pre>`;
  }).catch(() => { if (renderSeq === _docViewRenderSeq) content.innerHTML = '<div class="doc-view-loading error">Failed to load</div>'; });
}

/** Load HTML doc body into sandboxed iframe + optional source pane. */
function _loadDocHtmlContent(id) {
  const renderSeq = ++_docViewRenderSeq;
  const content = $('docViewContent');
  const viewer = content.querySelector('.doc-html-viewer');
  const frame = content.querySelector('.doc-html-frame');
  const source = content.querySelector('.doc-html-source');
  if (!viewer || !frame || !source) {
    content.innerHTML = '<div class="doc-view-loading error">HTML viewer failed to initialize</div>';
    return;
  }
  source.textContent = 'Loading…';
  const url = _docViewSource === 'research'
    ? `/api/research/${id}`
    : `/api/shared-docs/${id}/content`;
  fetch(url).then(r => r.json()).then(data => {
    if (_docViewId !== id || renderSeq !== _docViewRenderSeq) return;
    const text = _docViewSource === 'research'
      ? String(data.content ?? data.text ?? '')
      : String(data.text ?? data.content ?? '');
    source.textContent = text;
    frame.srcdoc = text;
  }).catch(() => {
    if (renderSeq !== _docViewRenderSeq) return;
    source.textContent = 'Failed to load document.';
    frame.removeAttribute('srcdoc');
  });
}

function toggleDocHtmlMode() {
  const content = $('docViewContent');
  const viewer = content?.querySelector('.doc-html-viewer');
  if (!viewer) return;
  const frame = viewer.querySelector('.doc-html-frame');
  const source = viewer.querySelector('.doc-html-source');
  const btn = viewer.querySelector('[data-doc-html-toggle]');
  const showingSource = viewer.dataset.docHtmlMode === 'source';
  if (showingSource) {
    viewer.dataset.docHtmlMode = 'preview';
    if (frame) frame.hidden = false;
    if (source) source.hidden = true;
    if (btn) btn.textContent = 'Show source';
  } else {
    viewer.dataset.docHtmlMode = 'source';
    if (frame) frame.hidden = true;
    if (source) source.hidden = false;
    if (btn) btn.textContent = 'Show preview';
  }
}

async function _loadDocVersionsUI(id) {
  try {
    const data = await fetch(`${_docApiBase(id)}/versions`).then(r => r.json());
    if (data.error || _docViewId !== id) return;
    _docViewVersions = data.versions ?? [];
    _docViewIsOwn    = !!data.isOwn;
    const btn = $('docViewHistoryBtn');
    if (btn && _docViewVersions.length > 0) {
      btn.style.display = '';
      btn.setAttribute('aria-expanded', 'true');
      const panel = $('docViewHistory');
      panel.style.display = 'block';
      document.querySelector('.doc-workspace-body')?.classList.add('has-history');
      document.querySelector('.doc-workspace-body')?.classList.remove('history-hidden');
      const latest = _docViewVersions.at(-1)?.n;
      $('docViewVersionLabel').textContent = latest ? `Current version v${latest}` : '';
      const compareBtn = $('docViewCompareBtn');
      compareBtn.style.display = _docViewVersions.length > 1 ? '' : 'none';
      _renderDocHistory();
      if (_docViewRequestedCompare) {
        const requested = _docViewRequestedCompare;
        _docViewRequestedCompare = null;
        if (_docViewVersions.some(v => v.n === requested && v.n > 1)) showDocVersionDiff(requested);
      }
    }
  } catch {}
}

function toggleDocHistory() {
  const panel = $('docViewHistory');
  if (!panel) return;
  const body = document.querySelector('.doc-workspace-body');
  const btn = $('docViewHistoryBtn');
  if (panel.style.display === 'none') {
    _renderDocHistory();
    panel.style.display = 'block';
    body?.classList.remove('history-hidden');
    btn?.setAttribute('aria-expanded', 'true');
  } else {
    panel.style.display = 'none';
    body?.classList.add('history-hidden');
    btn?.setAttribute('aria-expanded', 'false');
  }
}

function _renderDocHistory() {
  const panel = $('docViewHistory');
  if (!panel || !_docViewVersions.length) return;
  const currentN = _docViewVersions[_docViewVersions.length - 1].n;
  const rows = [..._docViewVersions].reverse().map(v => {
    const isCurrent = v.n === currentN;
    const who  = escHtml(v.byName || v.source || '');
    const when = fmtRelTime(v.at);
    const note = v.note ? `<div class="doc-history-note">${escHtml(v.note)}</div>` : '';
    const hasPrev  = _docViewVersions.some(x => x.n < v.n);
    const buttons = [
      isCurrent ? '' : `<button data-action="viewDocVersion" data-args='[${v.n}]'>${icon('eye', 11)} View</button>`,
      hasPrev ? `<button data-action="showDocVersionDiff" data-args='[${v.n}]'>${icon('columns-2', 11)} Compare</button>` : '',
      (_docViewIsOwn && !isCurrent) ? `<button class="restore" data-action="restoreDocVersion" data-args='[${v.n}]'>${icon('rotate-ccw', 11)} Restore</button>` : '',
    ].filter(Boolean).join('');
    return `<div class="doc-history-row">
      <span class="doc-history-version ${isCurrent ? 'current' : ''}">v${v.n}</span>
      <div class="doc-history-detail">
        <div class="doc-history-byline">${who} · ${when}${isCurrent ? ' · Current' : ''}</div>
        ${note}
        <div class="doc-history-source">${escHtml(v.source ?? '')}</div>
      </div>
      <div class="doc-history-actions">${buttons}</div>
    </div>`;
  }).join('');
  panel.innerHTML = `<div class="doc-history-heading"><span>History</span><span class="doc-history-count">${_docViewVersions.length} versions</span></div>${rows}`;
}

async function _fetchDocVersion(n) {
  const data = await fetch(`${_docApiBase(_docViewId)}/versions/${n}`).then(r => r.json());
  if (data.error) throw new Error(data.error);
  return data;
}

function _docVersionBanner(label) {
  return `<div class="doc-compare-banner">
    <strong>${escHtml(label)}</strong>
    <button data-action="docBackToCurrent">Back to current</button>
  </div>`;
}

async function viewDocVersion(n) {
  const renderSeq = ++_docViewRenderSeq;
  const content = $('docViewContent');
  content.innerHTML = '<div class="doc-view-loading">Loading...</div>';
  try {
    const v = await _fetchDocVersion(n);
    if (renderSeq !== _docViewRenderSeq) return;
    $('docViewVersionLabel').textContent = `Viewing version v${n}`;
    content.innerHTML = `<div class="doc-compare-wrap">${_docVersionBanner(`Viewing v${n}`)}
      <pre class="doc-version-page">${escHtml(v.text ?? '')}</pre></div>`;
  } catch (e) { if (renderSeq === _docViewRenderSeq) content.innerHTML = `<div class="doc-view-loading error">Failed to load version: ${escHtml(e.message)}</div>`; }
}

function docBackToCurrent() {
  if (_docViewId) {
    const latest = _docViewVersions.at(-1)?.n;
    $('docViewVersionLabel').textContent = latest ? `Current version v${latest}` : '';
    _loadDocTextContent(_docViewId);
  }
}

function compareLatestDocVersions() {
  const latest = _docViewVersions.at(-1)?.n;
  if (latest && latest > 1) showDocVersionDiff(latest);
}

async function showDocVersionDiff(n) {
  const renderSeq = ++_docViewRenderSeq;
  const content = $('docViewContent');
  content.innerHTML = '<div class="doc-view-loading">Preparing comparison...</div>';
  try {
    const prevMeta = [..._docViewVersions].filter(v => v.n < n).pop();
    if (!prevMeta) throw new Error('No earlier version is available');
    const [oldV, newV] = await Promise.all([_fetchDocVersion(prevMeta.n), _fetchDocVersion(n)]);
    if (renderSeq !== _docViewRenderSeq) return;
    const ops = _lineDiff(oldV.text ?? '', newV.text ?? '');
    const body = ops
      ? _renderSideBySideDiff(ops, prevMeta.n, n)
      : _renderLargeDocumentComparison(oldV.text ?? '', newV.text ?? '', prevMeta.n, n);
    $('docViewVersionLabel').textContent = `Comparing v${prevMeta.n} with v${n}`;
    content.innerHTML = `<div class="doc-compare-wrap">${_docVersionBanner(`Changes from v${prevMeta.n} to v${n}`)}${body}</div>`;
  } catch (e) { if (renderSeq === _docViewRenderSeq) content.innerHTML = `<div class="doc-view-loading error">Comparison failed: ${escHtml(e.message)}</div>`; }
}

async function restoreDocVersion(n) {
  if (!confirm(`Restore v${n} of "${_docViewFilename}"?\n\nThe current version stays in history — nothing is lost.`)) return;
  try {
    const r = await fetch(`${_docApiBase(_docViewId)}/restore/${n}`, { method: 'POST' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    showToast(`Restored v${n} (now v${r.version})`, 2500);
    _loadDocTextContent(_docViewId);
    _loadDocVersionsUI(_docViewId);
  } catch (e) { showToast('Restore failed: ' + e.message); }
}

// Line-based LCS diff. Returns [{t:' '|'-'|'+', line}] or null when too large.
function _lineDiff(aText, bText) {
  if (String(aText).length + String(bText).length > 500_000) return null;
  const A = aText.split('\n'), B = bText.split('\n');
  const n = A.length, m = B.length;
  if (n * m > 2_250_000) return null; // ~1500×1500 lines — keep the DP table sane
  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ t: ' ', line: A[i] }); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { ops.push({ t: '-', line: A[i] }); i++; }
    else { ops.push({ t: '+', line: B[j] }); j++; }
  }
  while (i < n) { ops.push({ t: '-', line: A[i++] }); }
  while (j < m) { ops.push({ t: '+', line: B[j++] }); }
  return ops;
}

function _comparisonRows(ops) {
  const CTX = 4;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.t === ' ') return;
    for (let k = Math.max(0, idx - CTX); k <= Math.min(ops.length - 1, idx + CTX); k++) keep[k] = true;
  });
  const rows = [];
  let i = 0;
  let skipping = false;
  while (i < ops.length) {
    if (!keep[i]) {
      if (!skipping) rows.push({ gap: true });
      skipping = true;
      i++;
      continue;
    }
    skipping = false;
    if (ops[i].t === ' ') {
      rows.push({ left: ops[i].line, right: ops[i].line, leftType: '', rightType: '' });
      i++;
      continue;
    }
    const removed = [], added = [];
    while (i < ops.length && keep[i] && ops[i].t !== ' ') {
      if (ops[i].t === '-') removed.push(ops[i].line);
      if (ops[i].t === '+') added.push(ops[i].line);
      i++;
    }
    const count = Math.max(removed.length, added.length);
    for (let k = 0; k < count; k++) {
      rows.push({
        left: removed[k] ?? '', right: added[k] ?? '',
        leftType: removed[k] != null ? 'removed' : 'empty',
        rightType: added[k] != null ? 'added' : 'empty',
      });
    }
  }
  return rows;
}

function _renderComparisonCell(value, type = '') {
  const prefix = type === 'removed' ? '- ' : type === 'added' ? '+ ' : '  ';
  return `<div class="doc-compare-line ${type}">${value ? prefix + escHtml(value) : '&nbsp;'}</div>`;
}

function _renderAlignedComparison(rows, oldVersion, newVersion) {
  const body = rows.map(row => row.gap
    ? '<div class="doc-compare-line context-gap">...</div><div class="doc-compare-line context-gap">...</div>'
    : `${_renderComparisonCell(row.left, row.leftType)}${_renderComparisonCell(row.right, row.rightType)}`
  ).join('');
  return `<div class="doc-compare-scroll" role="table" aria-label="Version comparison">
    <div class="doc-compare-aligned">
      <div class="doc-compare-pane-header" role="columnheader">Before · v${oldVersion}</div>
      <div class="doc-compare-pane-header" role="columnheader">After · v${newVersion}</div>
      ${body}
    </div>
  </div>`;
}

function _renderSideBySideDiff(ops, oldVersion, newVersion) {
  if (!ops.some(op => op.t !== ' ')) {
    return '<div class="doc-view-loading">No changes between these versions.</div>';
  }
  const rows = _comparisonRows(ops);
  return _renderAlignedComparison(rows, oldVersion, newVersion);
}

function _renderLargeDocumentComparison(oldText, newText, oldVersion, newVersion) {
  const MAX_CHARS = 250_000;
  const MAX_LINES = 2_500;
  const clip = value => {
    const source = String(value ?? '');
    const clippedChars = source.slice(0, MAX_CHARS);
    const allLines = clippedChars.split('\n');
    return {
      lines: allLines.slice(0, MAX_LINES),
      truncated: source.length > clippedChars.length || allLines.length > MAX_LINES,
    };
  };
  const oldDoc = clip(oldText);
  const newDoc = clip(newText);
  const oldLines = oldDoc.lines;
  const newLines = newDoc.lines;
  const count = Math.max(oldLines.length, newLines.length);
  const rows = Array.from({ length: count }, (_, index) => ({
    left: oldLines[index] ?? '', right: newLines[index] ?? '',
    leftType: '', rightType: '',
  }));
  const clipped = oldDoc.truncated || newDoc.truncated
    ? ' Showing a bounded preview; open an individual version from History to inspect the full document.'
    : '';
  return `<div class="doc-compare-limit">Change highlighting is unavailable for documents this large.${clipped}</div>
    ${_renderAlignedComparison(rows, oldVersion, newVersion)}`;
}

// WS push (see websocket.js 'doc_changed') — keeps drawer + open viewer live
function handleDocChanged(msg) {
  try {
    showToast(`📄 ${msg.filename} ${msg.action}${msg.byName ? ' by ' + msg.byName : ''}`, 2500);
  } catch {}
  const list = $('docList');
  if (list && list.offsetParent !== null) loadDocList();
  if (_docViewId && _docViewId === msg.docId) {
    _loadDocTextContent(_docViewId);
    const meta = _docAllDocs.find(doc => doc.id === _docViewId);
    const canReview = meta?.isOwn !== false
      && _isDocTextEditable(_docViewFilename, _docViewMime, _docViewSource);
    if (canReview) {
      _loadDocVersionsUI(_docViewId);
      const status = $('docViewAskStatus');
      if (status) status.textContent = `Saved as v${msg.version} ✓`;
      if (msg.action === 'updated') {
        if (_docReviewSuppress) _docReviewSuppress = false;
        else _showDocReviewBar(msg);
      } else if (msg.action === 'restored') {
        _docReviewSuppress = false;
      }
    }
  }
}
