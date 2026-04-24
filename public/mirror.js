// ── Client-side file mirror ────────────────────────────────────────────────
// Server (coder skill) pushes every project file mutation over WS; this module
// writes those bytes into a local folder the user picked via the File System
// Access API. The picked FileSystemDirectoryHandle is persisted per-user in
// IndexedDB so it survives reloads (subject to the browser re-asking for
// readwrite permission on first use each session).

const MIRROR_IDB_NAME  = 'oe_mirror';
const MIRROR_IDB_STORE = 'handles';
const MIRROR_FSA_SUPPORTED = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

let _mirrorRoot = null;       // the user's picked FileSystemDirectoryHandle
let _mirrorUserId = null;     // which user the loaded handle belongs to
let _snapshotSeen = new Set(); // `${userId}::${project}` we've snapshotted this session
let _permissionDenied = false;

// ── IDB ──────────────────────────────────────────────────────────────────────
function _openMirrorDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MIRROR_IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(MIRROR_IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _idbGet(key) {
  const db = await _openMirrorDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MIRROR_IDB_STORE, 'readonly');
    const r = tx.objectStore(MIRROR_IDB_STORE).get(key);
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(r.error);
  });
}

async function _idbSet(key, value) {
  const db = await _openMirrorDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MIRROR_IDB_STORE, 'readwrite');
    tx.objectStore(MIRROR_IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function _idbDel(key) {
  const db = await _openMirrorDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MIRROR_IDB_STORE, 'readwrite');
    tx.objectStore(MIRROR_IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Permission + load ────────────────────────────────────────────────────────
async function _ensurePermission(handle, { prompt = false } = {}) {
  if (!handle) return 'denied';
  const opts = { mode: 'readwrite' };
  const state = await handle.queryPermission(opts);
  if (state === 'granted') return 'granted';
  if (!prompt) return state; // 'prompt' | 'denied' — must be re-requested in a user gesture
  try { return await handle.requestPermission(opts); }
  catch { return 'denied'; }
}

async function initMirror() {
  if (!MIRROR_FSA_SUPPORTED) return;
  const userId = getCurrentUserId();
  if (!userId) return;
  _mirrorUserId = userId;
  try {
    const handle = await _idbGet(userId);
    if (handle) {
      _mirrorRoot = handle;
      // Don't prompt here — no user gesture available on page load.
      // User has to click "Re-grant access" if state is 'prompt'.
      const state = await _ensurePermission(handle, { prompt: false });
      _permissionDenied = state === 'denied';
    }
  } catch (e) {
    console.warn('[mirror] failed to load handle', e);
  }
  renderMirrorStatus();
}

// ── Path resolution inside the picked folder ─────────────────────────────────
async function _resolveDir(rootHandle, segments, { create = true } = {}) {
  let dir = rootHandle;
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') continue;
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

function _splitPath(posixPath) {
  return (posixPath ?? '').split('/').filter(Boolean);
}

async function _writeFile(rootHandle, project, relPath, bytes) {
  const segs = _splitPath(relPath);
  if (!segs.length) return;
  const fileName = segs.pop();
  const dir = await _resolveDir(rootHandle, [project, ...segs], { create: true });
  const fh = await dir.getFileHandle(fileName, { create: true });
  const stream = await fh.createWritable();
  await stream.write(bytes);
  await stream.close();
}

async function _deleteEntry(rootHandle, project, relPath) {
  const segs = _splitPath(relPath);
  if (!segs.length) return;
  const fileName = segs.pop();
  try {
    const dir = await _resolveDir(rootHandle, [project, ...segs], { create: false });
    await dir.removeEntry(fileName, { recursive: true });
  } catch { /* missing is fine */ }
}

async function _deleteProject(rootHandle, project) {
  try { await rootHandle.removeEntry(project, { recursive: true }); }
  catch { /* missing is fine */ }
}

// ── WS message entry point ───────────────────────────────────────────────────
async function applyMirrorMessage(msg) {
  if (!_mirrorRoot || !msg?.op || !msg.project) return;
  const state = await _ensurePermission(_mirrorRoot, { prompt: false });
  if (state !== 'granted') {
    _permissionDenied = state === 'denied';
    renderMirrorStatus();
    return;
  }
  try {
    if (msg.op === 'write') {
      const bytes = Uint8Array.from(atob(msg.contentBase64 ?? ''), c => c.charCodeAt(0));
      await _writeFile(_mirrorRoot, msg.project, msg.path, bytes);
    } else if (msg.op === 'delete') {
      await _deleteEntry(_mirrorRoot, msg.project, msg.path);
    } else if (msg.op === 'delete_project') {
      await _deleteProject(_mirrorRoot, msg.project);
      _snapshotSeen.delete(`${_mirrorUserId}::${msg.project}`);
    } else if (msg.op === 'resync') {
      await resyncProject(msg.project);
    }
  } catch (e) {
    console.warn('[mirror] write failed', e);
  }
}

// ── Snapshot fetch (full project seed) ───────────────────────────────────────
async function resyncProject(project) {
  if (!_mirrorRoot || !project) return;
  const state = await _ensurePermission(_mirrorRoot, { prompt: false });
  if (state !== 'granted') { renderMirrorStatus(); return; }
  try {
    const r = await fetch(`/api/coder/project-snapshot?project=${encodeURIComponent(project)}`);
    if (!r.ok) return;
    const snap = await r.json();
    for (const f of snap.files ?? []) {
      const bytes = Uint8Array.from(atob(f.contentBase64 ?? ''), c => c.charCodeAt(0));
      try { await _writeFile(_mirrorRoot, snap.project, f.path, bytes); }
      catch (e) { console.warn('[mirror] snapshot write failed', f.path, e); }
    }
    _snapshotSeen.add(`${_mirrorUserId}::${snap.project}`);
    renderMirrorStatus(`Synced ${snap.files?.length ?? 0} files from "${snap.project}"`);
  } catch (e) {
    console.warn('[mirror] resync failed', e);
  }
}

// ── Settings UI actions ──────────────────────────────────────────────────────
async function chooseMirrorFolder() {
  if (!MIRROR_FSA_SUPPORTED) return;
  const userId = getCurrentUserId();
  if (!userId) return;
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'oe-coder-mirror' });
    const state = await _ensurePermission(handle, { prompt: true });
    if (state !== 'granted') {
      renderMirrorStatus('Permission not granted — folder not saved.');
      return;
    }
    await _idbSet(userId, handle);
    _mirrorRoot = handle;
    _mirrorUserId = userId;
    _permissionDenied = false;
    renderMirrorStatus('Folder connected. Agent file changes will mirror here.');
  } catch (e) {
    if (e?.name === 'AbortError') return;
    console.warn('[mirror] chooseFolder error', e);
    renderMirrorStatus(`Error: ${e.message ?? e}`);
  }
}

async function disableMirror() {
  const userId = getCurrentUserId();
  if (!userId) return;
  await _idbDel(userId);
  _mirrorRoot = null;
  _snapshotSeen.clear();
  renderMirrorStatus('Mirror disabled.');
}

async function regrantMirrorPermission() {
  if (!_mirrorRoot) return;
  const state = await _ensurePermission(_mirrorRoot, { prompt: true });
  _permissionDenied = state === 'denied';
  renderMirrorStatus(state === 'granted' ? 'Access granted.' : 'Permission was not granted.');
}

async function manualResyncActive() {
  // Resync the coder agent's currently-active project. We don't track that
  // on the client, so just ask the user — or resync every known project.
  // Simpler first pass: ask the server for the active project name via a
  // lightweight endpoint. For now, resync whatever the user types.
  const name = prompt('Project name to re-sync:');
  if (name) await resyncProject(name.trim());
}

// ── Settings panel renderer ──────────────────────────────────────────────────
function renderMirrorStatus(statusMsg = '') {
  const el = document.getElementById('mirrorBody');
  if (!el) return;
  if (!MIRROR_FSA_SUPPORTED) {
    el.innerHTML = `<div style="font-size:12px;color:var(--muted)">Your browser doesn't support the File System Access API. Use Chrome, Edge, or another Chromium-based browser to mirror files to a local folder.</div>`;
    return;
  }
  const hasHandle = !!_mirrorRoot;
  const needsPermission = hasHandle && _permissionDenied;
  const folderName = _mirrorRoot?.name ?? '—';
  const extra = statusMsg ? `<div style="font-size:11px;color:var(--muted);margin-top:6px">${escHtml(statusMsg)}</div>` : '';
  el.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${hasHandle
        ? `<div style="font-size:12px">📂 <strong>${escHtml(folderName)}</strong></div>`
        : `<div style="font-size:12px;color:var(--muted)">No folder connected.</div>`}
      <button onclick="chooseMirrorFolder()" style="background:var(--accent);border:none;color:#fff;border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer;font-weight:600">
        ${hasHandle ? 'Change folder' : 'Choose folder'}
      </button>
      ${hasHandle ? `<button onclick="manualResyncActive()" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer">Re-sync…</button>` : ''}
      ${hasHandle ? `<button onclick="disableMirror()" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer">Disable</button>` : ''}
    </div>
    ${needsPermission
      ? `<div style="font-size:12px;color:var(--warn,#c99);margin-top:8px">Access to this folder was revoked by the browser. <button onclick="regrantMirrorPermission()" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;margin-left:6px">Re-grant access</button></div>`
      : ''}
    ${extra}
  `;
}

// Expose entry points used by websocket.js + settings panel.
window.initMirror = initMirror;
window.applyMirrorMessage = applyMirrorMessage;
window.chooseMirrorFolder = chooseMirrorFolder;
window.disableMirror = disableMirror;
window.regrantMirrorPermission = regrantMirrorPermission;
window.manualResyncActive = manualResyncActive;
window.renderMirrorStatus = renderMirrorStatus;
window.resyncProject = resyncProject;
