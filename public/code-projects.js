// ── Code Projects category ───────────────────────────────────────────────────
// Lists the user's coder projects (from users/{id}/documents/code/) and lets
// them download each as a zip or delete it. Runs inside the existing Desktop
// view — see DESKTOP_CATEGORIES in desktop.js.

async function fetchCodeProjectCount() {
  try {
    const r = await fetch('/api/coder/projects', {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!r.ok) return { count: 0, items: [] };
    const d = await r.json();
    const items = Array.isArray(d.projects) ? d.projects : [];
    return { count: items.length, items };
  } catch {
    return { count: 0, items: [] };
  }
}

function _formatProjectSize(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function renderCodeProjectItems(grid, items) {
  grid.className = 'desktop-items-grid list-mode';
  const sorted = items.slice().sort((a, b) =>
    (b.mtime || '').localeCompare(a.mtime || '')
  );
  grid.innerHTML = sorted.map(p => {
    const date = p.mtime
      ? new Date(p.mtime).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    const fileWord = p.fileCount === 1 ? 'file' : 'files';
    const nameAttr = escHtml(p.name).replace(/'/g, '&#39;');
    return `<div class="desktop-item-row" style="cursor:default">
      <div class="desktop-item-icon">💻</div>
      <div class="desktop-item-info">
        <div class="desktop-item-title">${escHtml(p.name)}</div>
        <div class="desktop-item-meta">${p.fileCount} ${fileWord} · ${_formatProjectSize(p.size)} · ${date}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button onclick="downloadCodeProject('${nameAttr}')">Download</button>
        <button class="detail-delete-btn" onclick="deleteCodeProject('${nameAttr}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function deleteCodeProject(name) {
  if (!confirm(`Delete project "${name}"? This removes all its files and cannot be undone.`)) return;
  try {
    const r = await fetch(`/api/coder/projects/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!r.ok) {
      let msg = 'Failed to delete project.';
      try { const j = await r.json(); if (j?.error) msg = j.error; } catch {}
      alert(msg);
      return;
    }
  } catch (e) {
    alert('Failed to delete project: ' + (e?.message || e));
    return;
  }
  openDesktopCategory('code');
}
