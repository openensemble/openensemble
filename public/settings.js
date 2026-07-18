// Settings core (browser bridge, reminders, sessions, drawers, TV, …).
// Models / network / MCP panels live in sibling settings-*.js scripts.

// Section moved to settings-ops.js (was lines 4-75).
// Section moved to settings-ops.js (was lines 76-136).
// ── Vision provider setting ───────────────────────────────────────────────────
async function saveVisionProvider() {
  const val = $('visionModelSelect')?.value;
  if (!val) return;
  const [model, provider] = val.split('||');
  try {
    await postJson('/api/config', { visionProvider: provider, visionModel: model || undefined }, { method: 'PATCH' });
    showToast('Vision model saved', 2000);
  } catch (e) { showToast(e.message || 'Failed to save'); }
}

// ── Strip thinking tags setting ───────────────────────────────────────────────
function setStripThinkingTrack(checked) {
  const track = $('stripThinkingTrack');
  if (track) track.style.background = checked ? 'var(--accent)' : 'var(--bg3)';
}
async function saveStripThinkingTags(checked) {
  setStripThinkingTrack(checked);
  try {
    await postJson('/api/config', { stripThinkingTags: checked }, { method: 'PATCH' });
    showToast(checked ? 'Thinking output will be hidden' : 'Thinking output will be shown', 2000);
  } catch (e) { setStripThinkingTrack(!checked); showToast(e.message || 'Failed to save setting'); }
}

// ── Reminder delivery channel (per-user) ──────────────────────────────────────
function _toggleReminderEmailRow(channel) {
  const row = $('reminderEmailRow');
  if (!row) return;
  row.style.display = (channel === 'email' || channel === 'all') ? '' : 'none';
}

function _toggleReminderVoiceRow(channel) {
  const row = $('reminderVoiceRow');
  if (!row) return;
  const show = channel === 'voice' || channel === 'all';
  row.style.display = show ? '' : 'none';
  // The preferred-device picker only affects the standalone 'voice' channel.
  // 'all' fans out to every paired device, so surface that caveat inline so
  // a user who sets the dropdown then switches to 'all' isn't confused that
  // both rooms speak.
  const note = $('reminderVoiceAllNote');
  if (note) note.style.display = (channel === 'all') ? '' : 'none';
}

async function loadReminderChannel() {
  const sel = $('reminderChannelSelect');
  const status = $('reminderChannelStatus');
  if (!sel || !_currentUser) return;
  try {
    const r = await fetch(`/api/users/${_currentUser.id}`);
    if (!r.ok) return;
    const u = await r.json();
    const channel = u.reminderChannel || 'websocket';
    sel.value = channel;
    if (status) status.textContent = '';
    _toggleReminderEmailRow(channel);
    _toggleReminderVoiceRow(channel);
    await loadReminderEmail(u.reminderEmailId);
    await loadReminderVoiceDevice(u.reminderVoiceDeviceId);
  } catch {}
}

async function saveReminderChannel(channel) {
  const status = $('reminderChannelStatus');
  if (!_currentUser) return;
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saving…'; }
  try {
    const r = await fetch(`/api/users/${_currentUser.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminderChannel: channel }),
    });
    if (!r.ok) {
      if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Failed to save.'; }
      return;
    }
    if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saved'; setTimeout(() => status.textContent = '', 1500); }
    showToast(`Reminder delivery: ${channel}`, 2000);
    _toggleReminderEmailRow(channel);
    _toggleReminderVoiceRow(channel);
    if (channel === 'email' || channel === 'all') await loadReminderEmail();
    if (channel === 'voice' || channel === 'all') await loadReminderVoiceDevice();
  } catch {
    if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Network error.'; }
  }
}

async function loadReminderEmail(currentSelection) {
  const sel = $('reminderEmailSelect');
  if (!sel || !_currentUser) return;
  try {
    const r = await fetch('/api/email-accounts');
    if (!r.ok) {
      sel.innerHTML = '<option value="">No accounts available</option>';
      return;
    }
    const accts = await r.json();
    if (!Array.isArray(accts) || !accts.length) {
      sel.innerHTML = '<option value="">No accounts connected</option>';
      return;
    }
    if (currentSelection === undefined) {
      const u = await fetch(`/api/users/${_currentUser.id}`).then(r => r.ok ? r.json() : null).catch(() => null);
      currentSelection = u?.reminderEmailId;
    }
    sel.innerHTML = accts.map(a => {
      const label = a.label || a.username || a.id;
      return `<option value="${a.id}">${label}${a.username ? ` (${a.username})` : ''}</option>`;
    }).join('');
    // Default to first by createdAt order if user hasn't chosen.
    const defaultId = currentSelection || accts.slice().sort((a, b) =>
      new Date(a.createdAt || 0) - new Date(b.createdAt || 0))[0]?.id;
    if (defaultId) sel.value = defaultId;
  } catch {
    sel.innerHTML = '<option value="">Failed to load</option>';
  }
}

async function saveReminderEmail(accountId) {
  const status = $('reminderEmailStatus');
  if (!_currentUser || !accountId) return;
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saving…'; }
  try {
    const r = await fetch(`/api/users/${_currentUser.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminderEmailId: accountId }),
    });
    if (!r.ok) {
      if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Failed to save.'; }
      return;
    }
    if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saved'; setTimeout(() => status.textContent = '', 1500); }
  } catch {
    if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Network error.'; }
  }
}

async function loadReminderVoiceDevice(currentSelection) {
  const sel = $('reminderVoiceSelect');
  if (!sel || !_currentUser) return;
  try {
    const r = await fetch('/api/devices');
    if (!r.ok) {
      sel.innerHTML = '<option value="">No devices available</option>';
      return;
    }
    const data = await r.json();
    const devices = Array.isArray(data?.devices) ? data.devices : [];
    if (!devices.length) {
      sel.innerHTML = '<option value="">No voice devices paired</option>';
      return;
    }
    if (currentSelection === undefined) {
      const u = await fetch(`/api/users/${_currentUser.id}`).then(r => r.ok ? r.json() : null).catch(() => null);
      currentSelection = u?.reminderVoiceDeviceId;
    }
    sel.innerHTML = devices.map(d => {
      const label = d.name || d.id;
      const status = d.online ? ' • online' : ' • offline';
      return `<option value="${d.id}">${label}${status}</option>`;
    }).join('');
    // Default to the first device if the user hasn't chosen one yet, matching
    // the email-account default behavior.
    const defaultId = currentSelection || devices[0]?.id;
    if (defaultId) sel.value = defaultId;
  } catch {
    sel.innerHTML = '<option value="">Failed to load</option>';
  }
}

async function saveReminderVoiceDevice(deviceId) {
  const status = $('reminderVoiceStatus');
  if (!_currentUser || !deviceId) return;
  if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saving…'; }
  try {
    const r = await fetch(`/api/users/${_currentUser.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reminderVoiceDeviceId: deviceId }),
    });
    if (!r.ok) {
      if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Failed to save.'; }
      return;
    }
    if (status) { status.style.color = 'var(--muted)'; status.textContent = 'Saved'; setTimeout(() => status.textContent = '', 1500); }
  } catch {
    if (status) { status.style.color = 'var(--red,#e05c5c)'; status.textContent = 'Network error.'; }
  }
}

// Section moved to settings-ops.js (was lines 328-510).
// ── Brave Search API key (admin/owner only) ──────────────────────────────────
// Server-wide setting; the row is hidden for non-privileged users by openSettingsDrawer().
async function loadBraveApiKeyStatus() {
  const status = $('braveApiKeyStatus');
  const clearBtn = $('braveApiKeyClearBtn');
  if (!status) return;
  const isPriv = _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
  if (!isPriv) return;
  try {
    const cfg = await fetch('/api/provider-config').then(r => r.json());
    if (cfg.braveKeySet) {
      status.textContent = 'API key is set.';
      if (clearBtn) clearBtn.style.display = '';
    } else {
      status.textContent = 'No API key configured.';
      if (clearBtn) clearBtn.style.display = 'none';
    }
  } catch { status.textContent = 'Status check failed.'; }
}

async function saveBraveApiKey() {
  const input = $('braveApiKeyInput');
  const key = input?.value.trim();
  if (!key) { showToast('Enter a Brave API key'); return; }
  try {
    const r = await fetch('/api/provider-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ braveApiKey: key }),
    });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      showToast(error || `Failed to save Brave key (${r.status})`);
      return;
    }
    input.value = '';
    showToast('Brave API key saved');
    loadBraveApiKeyStatus();
  } catch { showToast('Failed to save Brave key'); }
}

async function clearBraveApiKey() {
  if (!confirm('Remove the Brave Search API key? Web search and news will stop working until a new key is set.')) return;
  try {
    const r = await fetch('/api/provider-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ braveApiKey: '' }),
    });
    if (!r.ok) { showToast('Failed to clear Brave key'); return; }
    showToast('Brave API key cleared');
    loadBraveApiKeyStatus();
  } catch { showToast('Failed to clear Brave key'); }
}

// Drawers: public/settings-drawers.js
// TV sources: public/settings-tv.js
