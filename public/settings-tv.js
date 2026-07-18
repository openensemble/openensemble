// TV video sources admin UI — extracted from settings.js.
// Globals intentional.

// ── TV Video Sources (admin/owner only) ───────────────────────────────────────
// System-tab row (index.html #tvVideoSourcesRow, revealed by
// openSettingsDrawer) backed by the admin-gated proxy routes in
// routes/tv.mjs: GET/POST /api/tv/video-sources and DELETE
// /api/tv/video-sources/:name, which forward to the TV video sidecar's
// loopback admin API (oe-tv-assistant/PROTOCOL-TV.md, "Video library v2").

async function loadTvVideoSources() {
  const body = $('tvVideoSourcesBody');
  if (!body) return;
  try {
    const r = await fetch('/api/tv/video-sources');
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error ?? `load failed (${r.status})`);
    renderTvVideoSources(data.sources ?? []);
  } catch (e) {
    body.innerHTML = `<div style="color:var(--red,#e05c5c);font-size:12px">${escHtml(e.message)}</div>`;
  }
}

function renderTvVideoSources(sources) {
  const body = $('tvVideoSourcesBody');
  if (!body) return;
  const statusBadge = (s) => s.status === 'ok'
    ? `<span style="font-size:11px;color:var(--green, #4caf50);font-weight:600">✓ available</span>`
    : `<span style="font-size:11px;color:var(--red,#e05c5c);font-weight:600">⚠ unavailable</span>`;
  const locationOf = (s) => s.type === 'smb'
    ? `share ${s.share}${s.subpath ? `/${s.subpath}` : ''}${s.port ? ` (port ${s.port})` : ''}`
    : `folder ${s.path}${s.subpath ? `/${s.subpath}` : ''}`;

  const listHtml = sources.length === 0
    ? `<div style="font-size:12px;color:var(--muted);padding:10px 0">No video sources configured yet.</div>`
    : `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">${sources.map(s => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <div style="font-size:13px;font-weight:600">${escHtml(s.name)}</div>
            <div style="display:flex;gap:6px;align-items:center">${statusBadge(s)}
              <button data-action="removeTvVideoSource" data-args='${escHtml(JSON.stringify([s.name]))}' style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer">Remove</button>
            </div>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">${escHtml(s.type === 'smb' ? 'Network' : 'Local')} ${escHtml(locationOf(s))}</div>
          ${s.error ? `<div style="font-size:11px;color:var(--red,#e05c5c);margin-top:4px">${escHtml(s.error)}</div>` : ''}
        </div>
      `).join('')}</div>`;

  const formHtml = `
    <details style="border:1px dashed var(--border);border-radius:8px;padding:10px">
      <summary style="cursor:pointer;font-size:12px;font-weight:600">+ Add a video source</summary>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:6px">
        <label style="font-size:11px;color:var(--muted)">Name (shown as a folder on the TV)</label>
        <input id="tvSrcAddName" placeholder="NAS" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">Folder path on this server, or SMB share as //host/share</label>
        <input id="tvSrcAddLocation" placeholder="/srv/media/Movies or //nas/media" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">Subfolder (optional)</label>
        <input id="tvSrcAddSubfolder" placeholder="movies" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <label style="font-size:11px;color:var(--muted)">SMB port (optional, default 445)</label>
        <input id="tvSrcAddPort" type="number" min="1" max="65535" placeholder="445" style="width:100px;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px">
        <button data-action="addTvVideoSource" style="background:var(--accent);border:none;color:#fff;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-weight:600;margin-top:6px;align-self:flex-start">Add source</button>
        <div id="tvSrcAddStatus" style="font-size:11px;color:var(--muted);min-height:14px"></div>
      </div>
    </details>`;
  body.innerHTML = listHtml + formHtml;
}

async function addTvVideoSource() {
  const status = $('tvSrcAddStatus');
  const name = $('tvSrcAddName')?.value.trim();
  let loc = $('tvSrcAddLocation')?.value.trim() ?? '';
  if (loc.startsWith('\\\\')) loc = loc.replace(/\\/g, '/');  // \\host\share → //host/share
  if (!name || !loc) { if (status) status.textContent = 'Name and folder/share are required.'; return; }
  const body = { name };
  if (loc.startsWith('//')) { body.type = 'smb'; body.share = loc; }
  else if (loc.startsWith('/')) { body.type = 'local'; body.path = loc; }
  else { if (status) status.textContent = 'Enter an absolute folder path (/srv/media/Movies) or an SMB share (//host/share).'; return; }
  const sub = $('tvSrcAddSubfolder')?.value.trim();
  if (sub) body.subpath = sub;
  const port = $('tvSrcAddPort')?.value.trim();
  if (port) body.port = Number(port);
  if (status) status.textContent = 'Adding… (a network share can take a few seconds to mount)';
  try {
    const r = await fetch('/api/tv/video-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error ?? `add failed (${r.status})`);
    loadTvVideoSources();
  } catch (e) {
    if (status) status.textContent = `Add failed: ${e.message}`;
  }
}

async function removeTvVideoSource(name) {
  if (!confirm(`Remove video source "${name}" from the TV library? The folder's files are not deleted.`)) return;
  try {
    const r = await fetch(`/api/tv/video-sources/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      alert(`Remove failed: ${data.error ?? r.status}`);
      return;
    }
    loadTvVideoSources();
  } catch (e) {
    alert(`Remove failed: ${e.message}`);
  }
}
