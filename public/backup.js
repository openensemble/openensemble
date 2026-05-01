// ── Backup & Restore ─────────────────────────────────────────────────────────
(function() {
  const fileInput = $('backupFileInput');
  const restoreBtn = $('btnBackupRestore');
  if (fileInput && restoreBtn) {
    fileInput.addEventListener('change', () => {
      restoreBtn.disabled = !fileInput.files?.length;
    });
  }
})();

async function downloadBackup() {
  const btn = $('btnBackupDownload');
  const pwInput = $('backupPassword');
  const password = pwInput?.value ?? '';
  if (password) {
    if (password.length < 6) { showToast('Use at least 6 characters'); return; }
    if (!confirm('Encrypt this backup with the password you entered?\n\nForgotten passwords cannot be recovered — the backup will be unreadable.')) return;
  }
  btn.textContent = password ? 'Encrypting…' : 'Downloading…';
  btn.disabled = true;
  try {
    const headers = {};
    let method = 'GET';
    if (password) {
      method = 'POST';
      headers['X-Backup-Password'] = password;
    }
    const r = await fetch('/api/admin/backup', { method, headers });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(txt || ('HTTP ' + r.status));
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0,10);
    a.download = password
      ? `openensemble-backup-${stamp}.oeb`
      : `openensemble-backup-${stamp}.tar.gz`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(password ? 'Encrypted backup downloaded' : 'Backup downloaded');
    if (pwInput) pwInput.value = '';
  } catch (e) {
    showToast('Backup failed: ' + e.message);
  } finally {
    btn.textContent = 'Download Backup'; btn.disabled = false;
  }
}

async function restoreBackup() {
  const fileInput = $('backupFileInput');
  const status = $('restoreStatus');
  const btn = $('btnBackupRestore');
  const pwInput = $('restorePassword');
  if (!fileInput?.files?.length) return;
  if (!confirm('This will overwrite all current data with the backup contents. Are you sure?')) return;

  btn.disabled = true; btn.textContent = 'Restoring…';
  status.textContent = 'Uploading backup…';
  status.style.color = 'var(--muted)';

  try {
    const file = fileInput.files[0];
    const buf = await file.arrayBuffer();
    const password = pwInput?.value ?? '';
    const headers = { 'Content-Type': 'application/octet-stream' };
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
    status.textContent = `Restored ${data.restored} file(s). Restart the server to apply changes.`;
    status.style.color = 'var(--green,#43b89c)';
    showToast(`Backup restored (${data.restored} files)`);
    if (pwInput) pwInput.value = '';
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    status.style.color = 'var(--red,#e05c5c)';
    showToast('Restore failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Restore';
    fileInput.value = '';
  }
}

$('btnRefreshModels').addEventListener('click', async () => {
  try {
    await Promise.all([loadModels(), loadCortexConfig(), loadReasonRuntimeStatus(), loadPlanRuntimeStatus()]);
    renderModelBrowser(); renderAgentModelRows(); renderCortexModelRows(); renderPlanModelRows();
    checkCortexHealth().then(renderCortexModelRows);
  } catch {}
});
$('btnAddCustomModel').addEventListener('click', () => {
  const name = $('customModelName').value.trim(), provider = $('customModelProvider').value;
  if (!name) return;
  if (!customModels.find(m => m.name === name)) {
    customModels.push({ name, provider });
    localStorage.setItem('oe_custom_models', JSON.stringify(customModels));
  }
  $('customModelName').value = '';
  renderModelBrowser(); renderAgentModelRows();
});

