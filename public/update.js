// ── Auto-update UI ───────────────────────────────────────────────────────────
// Backed by /api/admin/update/{status,check,apply,config}. Reuses showToast,
// showNodeConfirmModal, and the same /health-poll-then-reload pattern as
// restartServer() in settings.js.

let _updateState = null;

function isAdminViewer() {
  return _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
}

function shortSha(sha) { return sha ? sha.slice(0, 7) : '—'; }

async function loadUpdateStatus() {
  if (!isAdminViewer()) return null;
  try {
    const r = await fetch('/api/admin/update/status');
    if (!r.ok) return null;
    _updateState = await r.json();
    renderUpdateRow();
    refreshUpdateBadge();
    return _updateState;
  } catch { return null; }
}

function refreshUpdateBadge() {
  const badge = document.getElementById('updateBadge');
  if (!badge) return;
  const show = isAdminViewer() && _updateState?.available && !_updateState?.dirty && _updateState?.unpushed === 0;
  badge.style.display = show ? 'inline-flex' : 'none';
  if (show) badge.title = `New version available: ${shortSha(_updateState.remoteSha)} (current ${shortSha(_updateState.currentSha)})`;
}

function renderUpdateRow() {
  const host = document.getElementById('updateRow');
  if (!host) return;
  const s = _updateState;
  if (!s) { host.innerHTML = ''; return; }

  const polling = s.pollingEnabled !== false;
  const intervalMin = Math.round((s.intervalMs ?? 3_600_000) / 60_000);
  const last = s.lastCheckedAt ? new Date(s.lastCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

  let statusHtml;
  if (!s.enabled) {
    statusHtml = `<span style="color:var(--muted)">Auto-update unavailable: ${escHtml(s.error || 'not a git repo')}</span>`;
  } else if (s.blockReason) {
    statusHtml = `<span style="color:#f5a623">${escHtml(s.blockReason)}</span>`;
  } else if (s.available) {
    statusHtml = `<span style="color:var(--accent);font-weight:600">Update available</span> · ${shortSha(s.currentSha)} → ${shortSha(s.remoteSha)}`;
  } else {
    statusHtml = `<span style="color:var(--muted)">Up to date · ${shortSha(s.currentSha)}</span>`;
  }

  const canApply = s.enabled && s.available && !s.dirty && s.unpushed === 0;

  // When dirty, render the modified-files list inline so users can see what
  // got touched (typical culprit on fresh installs: package-lock.json rewritten
  // by `npm install`, or line-ending normalization on a tracked text file).
  // Pair it with a "Force update" button that resets the tree.
  let dirtyBlock = '';
  if (s.enabled && s.dirty && Array.isArray(s.dirtyFiles) && s.dirtyFiles.length) {
    const STATUS_LABELS = { 'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed', 'C': 'copied', '??': 'untracked' };
    const fileList = s.dirtyFiles.slice(0, 20).map(f => {
      const lbl = STATUS_LABELS[f.status] || f.status;
      return `<li style="font-family:monospace;font-size:11px"><span style="color:var(--muted);min-width:60px;display:inline-block">${escHtml(lbl)}</span> ${escHtml(f.path)}</li>`;
    }).join('');
    const more = s.dirtyFiles.length > 20 ? `<li style="font-size:11px;color:var(--muted)">…and ${s.dirtyFiles.length - 20} more</li>` : '';
    dirtyBlock = `
      <details style="margin-top:8px;background:rgba(245,166,35,0.08);border:1px solid rgba(245,166,35,0.3);border-radius:6px;padding:8px 10px">
        <summary style="cursor:pointer;font-size:12px;color:#f5a623">⚠ ${s.dirtyFiles.length} tracked file${s.dirtyFiles.length === 1 ? '' : 's'} changed locally — click to review</summary>
        <ul style="margin:8px 0 4px 0;padding-left:16px;list-style:none">${fileList}${more}</ul>
        <div style="margin-top:6px;font-size:11px;color:var(--muted)">
          Most likely caused by <code>npm install</code> rewriting <code>package-lock.json</code> on a fresh install, or line-ending normalization on a text file. If you didn't make these changes intentionally, use <strong>Force update</strong> to discard them and pull the latest code.
        </div>
      </details>`;
  }
  const canForce = s.enabled && s.available && (s.dirty || s.unpushed > 0);

  host.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div class="settings-section-title" style="margin-bottom:2px"><i data-lucide="download-cloud" style="width:14px;height:14px"></i> Software Update</div>
        <div class="settings-section-desc">${statusHtml}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:6px">Last checked: ${last} · ${polling ? `auto every ${intervalMin}m` : 'auto-check off'}</div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button id="btnUpdateCheck" data-action="runUpdateCheck" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer">Check now</button>
        <button id="btnUpdateApply" data-action="runUpdateApply" style="background:${canApply ? '#43b89c' : 'var(--bg3)'};border:none;color:#fff;border-radius:6px;padding:6px 12px;font-size:12px;cursor:${canApply ? 'pointer' : 'not-allowed'};font-weight:600;opacity:${canApply ? '1' : '0.5'}" ${canApply ? '' : 'disabled'}>Update &amp; restart</button>
        ${canForce ? `<button id="btnUpdateForce" data-action="runUpdateForce" style="background:#c44;border:none;color:#fff;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:600">Force update</button>` : ''}
      </div>
    </div>
    ${dirtyBlock}
    <div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--muted)">
      <label style="position:relative;display:inline-block;width:36px;height:20px">
        <input type="checkbox" id="updateAutoToggle" ${polling ? 'checked' : ''} data-change-action="saveUpdateAutoToggle" data-change-args='["$checked"]' style="opacity:0;width:0;height:0">
        <span style="position:absolute;cursor:pointer;inset:0;background:${polling ? 'var(--accent)' : 'var(--bg3)'};border:1px solid var(--border);border-radius:11px;transition:.2s"></span>
      </label>
      <span>Check origin automatically</span>
    </div>
  `;
  if (window.lucide?.createIcons) window.lucide.createIcons();
}

async function runUpdateCheck() {
  const btn = document.getElementById('btnUpdateCheck');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    const r = await fetch('/api/admin/update/check', { method: 'POST' });
    if (r.status === 429) {
      showToast('Wait 60s between manual checks');
    } else if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      showToast('Check failed: ' + (body.error || `HTTP ${r.status}`));
    } else {
      _updateState = await r.json();
      renderUpdateRow();
      refreshUpdateBadge();
      showToast(_updateState.available ? 'Update available' : 'Up to date', 2500);
    }
  } catch (e) {
    showToast('Check failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Check now'; }
  }
}

async function runUpdateApply() {
  if (!_updateState?.available) return;
  const target = shortSha(_updateState.remoteSha);
  showNodeConfirmModal({
    title: 'Update & Restart',
    message: `Pull ${target} from origin and restart the server. Active sessions will reconnect automatically.\n\nIf package.json changed, dependencies will be reinstalled before restart (may add ~30s).`,
    confirmLabel: 'Update',
    cancelLabel: 'Cancel',
    confirmClass: 'cdraw-btn-danger',
    onConfirm: async () => {
      const btn = document.getElementById('btnUpdateApply');
      if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
      try {
        const r = await fetch('/api/admin/update/apply', { method: 'POST' });
        if (r.status === 409) {
          const body = await r.json().catch(() => ({}));
          showToast('Update blocked: ' + (body.error || body.code));
          if (btn) { btn.disabled = false; btn.textContent = 'Update & restart'; }
          return;
        }
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          showToast('Apply failed: ' + (body.error || `HTTP ${r.status}`));
          if (btn) { btn.disabled = false; btn.textContent = 'Update & restart'; }
          return;
        }
        // Server returns 202 immediately; the WS broadcast carries progress,
        // and update_applying with stage=restarting is our cue to start polling.
        showToast('Updating in background…', 5000);
      } catch (e) {
        showToast('Apply failed: ' + e.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Update & restart'; }
      }
    },
  });
}

async function runUpdateForce() {
  if (!_updateState?.available) return;
  const target = shortSha(_updateState.remoteSha);
  const fileCount = _updateState.dirtyFiles?.length ?? 0;
  showNodeConfirmModal({
    title: 'Force update — discard local changes',
    message: `This will run \`git reset --hard\` and \`git clean -fd\` to throw away ${fileCount} local file change${fileCount === 1 ? '' : 's'}, then pull ${target} from origin and restart.\n\nUser data (config, sessions, users/, models/, expenses/, etc.) is protected by .gitignore and stays intact. Only modifications inside the OpenEnsemble code tree are discarded.\n\nThis cannot be undone.`,
    confirmLabel: 'Discard & update',
    cancelLabel: 'Cancel',
    confirmClass: 'cdraw-btn-danger',
    onConfirm: async () => {
      const btn = document.getElementById('btnUpdateForce');
      if (btn) { btn.disabled = true; btn.textContent = 'Forcing…'; }
      try {
        const r = await fetch('/api/admin/update/apply-force', { method: 'POST' });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          showToast('Force update failed: ' + (body.error || `HTTP ${r.status}`));
          if (btn) { btn.disabled = false; btn.textContent = 'Force update'; }
          return;
        }
        showToast('Force update in progress…', 5000);
      } catch (e) {
        showToast('Force update failed: ' + e.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Force update'; }
      }
    },
  });
}

async function saveUpdateAutoToggle(checked) {
  try {
    const r = await fetch('/api/admin/update/config', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updateCheckEnabled: checked }),
    });
    if (!r.ok) { showToast('Failed to save'); return; }
    showToast(checked ? 'Auto-check enabled (next restart)' : 'Auto-check disabled (next restart)', 3500);
    loadUpdateStatus();
  } catch (e) { showToast('Failed to save: ' + e.message); }
}

// Called from websocket.js when the server pushes restart progress so the UI
// can begin polling /health like restartServer() does.
function _waitForServerBack() {
  const status = document.getElementById('btnUpdateApply');
  if (status) status.textContent = 'Restarting…';
  const deadline = Date.now() + 90_000;
  const tick = async () => {
    if (Date.now() > deadline) {
      showToast('Timed out waiting for server to come back. Reload manually.');
      return;
    }
    try {
      const h = await fetch('/health', { cache: 'no-store' });
      if (h.ok) {
        showToast('Update applied — reloading…', 2000);
        setTimeout(() => location.reload(), 600);
        return;
      }
    } catch {}
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 3000);
}
