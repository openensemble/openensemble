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
  btn.textContent = 'Downloading…'; btn.disabled = true;
  try {
    const r = await fetch('/api/admin/backup');
    if (!r.ok) throw new Error('Backup failed');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `openensemble-backup-${new Date().toISOString().slice(0,10)}.tar.gz`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Backup downloaded');
  } catch (e) {
    showToast('Backup failed: ' + e.message);
  } finally {
    btn.textContent = 'Download Backup (.tar.gz)'; btn.disabled = false;
  }
}

async function restoreBackup() {
  const fileInput = $('backupFileInput');
  const status = $('restoreStatus');
  const btn = $('btnBackupRestore');
  if (!fileInput?.files?.length) return;
  if (!confirm('This will overwrite all current data with the backup contents. Are you sure?')) return;

  btn.disabled = true; btn.textContent = 'Restoring…';
  status.textContent = 'Uploading backup…';
  status.style.color = 'var(--muted)';

  try {
    const file = fileInput.files[0];
    const buf = await file.arrayBuffer();
    const r = await fetch('/api/admin/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/gzip' },
      body: buf,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Restore failed');
    status.textContent = `Restored ${data.restored} file(s). Restart the server to apply changes.`;
    status.style.color = 'var(--green,#43b89c)';
    showToast(`Backup restored (${data.restored} files)`);
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

