// ── Backup & Restore ─────────────────────────────────────────────────────────
let _backupController = null;
let _backupVerifiedSelection = null;
const _backupIdentity = () => typeof _currentUser === 'object' && _currentUser
  && !(typeof _authSuspended === 'boolean' && _authSuspended) ? _currentUser.id : null;
const _backupBytes = value => value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GiB' : (value / 1024 ** 2).toFixed(2) + ' MiB';
const _backupValidReceipt = receipt => receipt?.scope === 'disposable-restore' && /^[a-f0-9]{64}$/.test(receipt.sha256)
  && Number.isInteger(receipt.verifierVersion) && receipt.verifierVersion > 0 && Number.isFinite(Date.parse(receipt.verifiedAt));

function _backupSelectionMatches() {
  return _backupVerifiedSelection && _backupVerifiedSelection.file === $('backupFileInput')?.files?.[0]
    && _backupVerifiedSelection.password === ($('restorePassword')?.value || '')
    && _backupVerifiedSelection.userId === _backupIdentity();
}
function _backupControls() {
  const busy = !!_backupController;
  for (const id of ['btnBackupPreflight', 'btnBackupDownload', 'backupFileInput', 'backupPassword', 'restorePassword']) {
    if ($(id)) $(id).disabled = busy;
  }
  if ($('btnBackupVerify')) $('btnBackupVerify').disabled = busy || !$('backupFileInput')?.files?.length;
  if ($('btnBackupRestore')) $('btnBackupRestore').disabled = busy || !_backupSelectionMatches();
  if ($('btnBackupCancel')) $('btnBackupCancel').hidden = !busy;
}
async function _backupJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Backup request failed (' + response.status + ')');
  return data;
}
function _backupReceiptText(receipt) {
  return `Verified ${new Date(receipt.verifiedAt).toLocaleString()}: ${receipt.files ?? 'archive'} files, ${_backupBytes(receipt.archiveBytes)}. SHA-256 ${receipt.sha256}. Restore check v${receipt.verifierVersion}.`;
}
async function loadBackupStatus() {
  const identity = _backupIdentity();
  if (!identity) return;
  try {
    const state = await _backupJson('/api/admin/backup/status');
    if (identity !== _backupIdentity()) return;
    $('backupVerificationStatus').textContent = state.lastSuccess
      ? 'Last successful check — ' + _backupReceiptText(state.lastSuccess) + ' This applies only to that exact archive.'
      : 'No archive has passed a restore check on this installation yet.';
    if (state.latest && ['failed', 'blocked', 'cancelled', 'interrupted'].includes(state.latest.state)) {
      $('backupVerificationStatus').textContent += ' ' + state.latest.message;
    }
  } catch (error) { if ($('backupVerificationStatus') && identity === _backupIdentity()) $('backupVerificationStatus').textContent = error.message; }
}
function resetBackupChecks() {
  _backupController?.abort();
  _backupVerifiedSelection = null;
  for (const id of ['backupFileInput', 'backupPassword', 'restorePassword']) if ($(id)) $(id).value = '';
  for (const id of ['backupPreflightResult', 'backupOperationStatus', 'backupVerificationStatus', 'restoreStatus']) if ($(id)) $(id).textContent = '';
  _backupControls();
}
async function _runBackupOperation(action) {
  if (_backupController) return;
  _backupController = new AbortController();
  _backupControls();
  try { return await action(_backupController.signal); }
  catch (error) {
    const message = error.name === 'AbortError' ? 'Backup check cancelled.' : error.message;
    if ($('backupOperationStatus')) $('backupOperationStatus').textContent = message;
    showToast(message);
  } finally {
    _backupController = null;
    _backupControls();
    loadBackupStatus();
  }
}
function _renderBackupPreflight(data) {
  const panel = $('backupPreflightResult');
  panel.replaceChildren();
  const line = text => { const p = document.createElement('div'); p.textContent = text; panel.appendChild(p); };
  line(`${data.canExport ? 'Ready to export' : 'Review required'} · ${_backupBytes(data.totalBytes)} of selected data · ${data.profiles} profiles`);
  for (const category of data.categories) line(`${category.label}: ${category.files} files, ${_backupBytes(category.bytes)}`);
  line('Omitted: ' + data.excluded.map(item => item.label + (item.count === null ? '' : ` (${item.count})`)).join('; ') + '.');
  line('Project folders omitted: ' + (data.excluded.find(item => item.id === 'project-generated')?.names || []).join(', ') + '.');
  line(`Limits: ${_backupBytes(data.limits.archiveBytes)} archive, ${_backupBytes(data.limits.restoredBytes)} restored data, ${data.limits.entries.toLocaleString()} entries. Checks stop after ${data.limits.timeoutSeconds / 60} minutes.`);
  for (const blocker of data.blockers) line(blocker.message + ` (${blocker.count})`);
  line(data.note);
}
async function checkBackupPreflight() {
  await _runBackupOperation(async signal => {
    $('backupOperationStatus').textContent = 'Checking selected data and exclusions…';
    const data = await _backupJson('/api/admin/backup/preflight', { signal });
    _renderBackupPreflight(data);
    $('backupOperationStatus').textContent = data.canExport ? 'Preflight complete.' : 'Resolve the items above before exporting.';
  });
}
async function verifySelectedBackup() {
  const file = $('backupFileInput')?.files?.[0];
  if (!file) return;
  _backupVerifiedSelection = null;
  if (file.size > 500 * 1024 ** 2) { $('restoreStatus').textContent = 'Archive exceeds the 500 MiB limit.'; _backupControls(); return; }
  await _runBackupOperation(async signal => {
    const password = $('restorePassword')?.value || '', userId = _backupIdentity();
    $('backupOperationStatus').textContent = 'Uploading and restoring a disposable copy. Current data stays in place…';
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (password) headers['X-Restore-Password'] = password;
    const data = await _backupJson('/api/admin/backup/verify', { method: 'POST', headers, body: file, signal });
    if (!_backupValidReceipt(data.receipt)) throw new Error('The server did not return a valid restore verification. Check the server version and try again.');
    if (file !== $('backupFileInput')?.files?.[0] || userId !== _backupIdentity()) return;
    _backupVerifiedSelection = { file, password, userId, receipt: data.receipt };
    $('restoreStatus').textContent = _backupReceiptText(data.receipt) + ' You can now restore this file.';
    $('backupOperationStatus').textContent = 'Restore check passed. The disposable copy was removed.';
  });
}

(function setupBackupChecks() {
  const panel = $('stab-panel-backup');
  if (!panel) return;
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px';
  for (const [id, label, action] of [['btnBackupPreflight', 'Check backup contents', checkBackupPreflight], ['btnBackupCancel', 'Cancel check', () => _backupController?.abort()]]) {
    const button = document.createElement('button'); button.id = id; button.textContent = label;
    button.type = 'button'; button.style.cssText = 'padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg3);color:var(--text);cursor:pointer';
    button.addEventListener('click', action); controls.appendChild(button);
  }
  const details = document.createElement('div');
  details.id = 'backupPreflightResult'; details.style.cssText = 'font-size:12px;line-height:1.6;margin-bottom:10px;color:var(--muted)';
  details.textContent = 'Check what will be included before export. Every download also passes a disposable restore check.';
  const status = document.createElement('div'); status.id = 'backupOperationStatus'; status.setAttribute('role', 'status');
  status.style.cssText = 'font-size:12px;line-height:1.5;margin-bottom:8px';
  const verification = document.createElement('div'); verification.id = 'backupVerificationStatus';
  verification.style.cssText = 'font-size:11px;line-height:1.5;overflow-wrap:anywhere;margin-bottom:16px;color:var(--muted)';
  panel.prepend(controls, details, status, verification);
  const verify = document.createElement('button'); verify.id = 'btnBackupVerify'; verify.type = 'button';
  verify.textContent = 'Verify selected backup'; verify.style.cssText = 'margin-top:8px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg3);color:var(--text);cursor:pointer';
  verify.addEventListener('click', verifySelectedBackup); $('restorePassword').after(verify);
  const resetSelection = () => { _backupVerifiedSelection = null; $('restoreStatus').textContent = 'Verify the selected file before restoring. Verification uses a disposable copy.'; _backupControls(); };
  $('backupFileInput').addEventListener('change', resetSelection);
  $('restorePassword').addEventListener('input', resetSelection);
  new MutationObserver(() => { if (panel.classList.contains('active')) { _backupControls(); loadBackupStatus(); } }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  _backupControls();
})();

async function downloadBackup() {
  const btn = $('btnBackupDownload');
  const pwInput = $('backupPassword');
  const password = pwInput?.value ?? '';
  if (password) {
    if (password.length < 6) { showToast('Use at least 6 characters'); return; }
    if (!confirm('Encrypt this backup with the password you entered?\n\nForgotten passwords cannot be recovered — the backup will be unreadable.')) return;
  }
  await _runBackupOperation(async signal => {
    const identity = _backupIdentity();
    $('backupOperationStatus').textContent = 'Checking backup contents…';
    const preflight = await _backupJson('/api/admin/backup/preflight', { signal });
    _renderBackupPreflight(preflight);
    if (!preflight.canExport) throw new Error('Resolve the preflight items before exporting.');
    btn.textContent = 'Exporting and verifying…';
    $('backupOperationStatus').textContent = 'Creating the archive and testing a restore. This may take several minutes…';
    const headers = {};
    let method = 'GET';
    if (password) {
      method = 'POST';
      headers['X-Backup-Password'] = password;
    }
    const r = await fetch('/api/admin/backup', { method, headers, signal });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + r.status));
    }
    const blob = await r.blob();
    if (identity !== _backupIdentity()) return;
    const sha256 = r.headers.get('X-Backup-SHA256');
    if (!/^[a-f0-9]{64}$/.test(sha256 || '') || !r.headers.get('X-Backup-Verifier-Version') || !Number.isFinite(Date.parse(r.headers.get('X-Backup-Verified-At')))) {
      throw new Error('The server did not confirm archive verification. Check the server version and try again.');
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0,10);
    a.download = password
      ? `openensemble-backup-${stamp}.oeb`
      : `openensemble-backup-${stamp}.tar.gz`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    $('backupOperationStatus').textContent = 'Verified backup downloaded. SHA-256 ' + sha256;
    showToast(password ? 'Verified encrypted backup downloaded' : 'Verified backup downloaded');
    if (pwInput) pwInput.value = '';
  });
  btn.textContent = 'Download Backup';
}

async function restoreBackup() {
  const fileInput = $('backupFileInput');
  const status = $('restoreStatus');
  const btn = $('btnBackupRestore');
  const pwInput = $('restorePassword');
  if (!fileInput?.files?.length) return;
  if (!_backupSelectionMatches()) { showToast('Verify the selected backup before restoring.'); return; }
  if (!confirm('This will overwrite all current data with the backup contents. Are you sure?')) return;

  btn.disabled = true; btn.textContent = 'Restoring…';
  status.textContent = 'Uploading backup…';
  status.style.color = 'var(--muted)';

  try {
    const file = fileInput.files[0];
    const buf = await file.arrayBuffer();
    const password = pwInput?.value ?? '';
    const headers = { 'Content-Type': 'application/octet-stream', 'X-Restore-Expected-SHA256': _backupVerifiedSelection.receipt.sha256 };
    if (password) headers['X-Restore-Password'] = password;
    const r = await fetch('/api/admin/restore', { method: 'POST', headers, body: buf });
    const data = await r.json();
    if (!r.ok) {
      if (data?.encrypted && !password) {
        status.textContent = 'This backup is encrypted — enter the password and try again.';
      } else {
        throw new Error(data.error || 'Restore failed');
      }
      return;
    }
    if (data.restarting) {
      status.textContent = 'Backup validated. Restarting to restore the snapshot…';
      status.style.color = 'var(--green,#43b89c)';
      showToast('Backup validated — server restarting');
      if (pwInput) pwInput.value = '';
      _waitForServerAfterRestore(status);
    } else {
      status.textContent = `Restored ${data.restored} file(s). Restart the server to apply changes.`;
      status.style.color = 'var(--green,#43b89c)';
      showToast(`Backup restored (${data.restored} files)`);
      if (pwInput) pwInput.value = '';
    }
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    status.style.color = 'var(--red,#e05c5c)';
    showToast('Restore failed: ' + e.message);
  } finally {
    btn.disabled = true; btn.textContent = 'Restore';
    _backupVerifiedSelection = null;
    fileInput.value = '';
  }
}

// After the server restarts post-restore, poll /health until it's reachable
// then full-reload the page so the SPA boots against the restored state.
// Mirrors the auto-update flow in update.js:_waitForServerBack().
function _waitForServerAfterRestore(statusEl) {
  const deadline = Date.now() + 90_000; // 90s — restore + restart can be slow
  const tick = async () => {
    if (Date.now() > deadline) {
      if (statusEl) {
        statusEl.style.color = 'var(--red,#e05c5c)';
        statusEl.textContent = 'Server didn\'t come back within 90s. Reload the page manually.';
      }
      return;
    }
    try {
      const h = await fetch('/health', { cache: 'no-store' });
      if (h.ok) {
        if (statusEl) statusEl.textContent = 'Server back — reloading…';
        setTimeout(() => location.reload(), 600);
        return;
      }
    } catch {}
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 3000);
}

$('btnRefreshModels').addEventListener('click', async () => {
  try {
    await Promise.all([loadModels(), loadCortexConfig(), loadReasonRuntimeStatus(), loadPlanRuntimeStatus()]);
    renderModelBrowser(); renderAgentModelRows(); renderCortexModelRows(); renderPlanModelRows();
    checkCortexHealth().then(renderCortexModelRows);
  } catch {}
});
