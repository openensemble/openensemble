// ── Voice devices ─────────────────────────────────────────────────────────────
// Lists, pairs, and configures XVF3800-class voice devices. Mirrors the
// shape of nodes.js but slimmer: no remote-command dispatch, just metadata.

// OpenAI TTS voice catalog — kept in sync with /api/tts in routes/config.mjs.
// When pluggable TTS lands (v2), swap this for a /api/provider-voices fetch.
const OPENAI_TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

// Multi-slot wake-word routing replaced the old single-slot "wake_word_slot"
// dropdown — the firmware now loads every slot in the SPIFFS partition
// concurrently, so this picker lives inline in the device row as a per-slot
// agent dropdown (see renderDevices). The phrase labels there mirror the
// firmware build's slot{N}.json files.

let _devicesList = [];
// Wake-slots on OTHER users' devices that point at the current user. Fetched
// alongside the owned-device list so the "Shared with you" section can show
// a user what they have access to (and let them opt out). Empty for an
// install with no shared bindings.
let _incomingSlots = [];
// User's wake-word library — uploaded .tflite + .json pairs. Each device
// slot can be assigned a library entry via the slot's "Wake word" picker;
// changing the picker triggers an OTA push to the device.
let _wakewordLibrary = [];
// User's voice-reference library (F5-TTS zero-shot clones). Each entry
// is a label + transcript + WAV file the user uploaded; F5-TTS clones
// from these. Drawer fetches this when ttsProvider='f5-tts'.
let _voiceRefs = [];
// Server-reported TTS provider. Drives which voice-control UI to render
// per slot ('openai' → named-voice dropdown, 'piper' → numeric speaker
// ID input, 'f5-tts' → reference dropdown, 'elevenlabs' → fetched-voice
// dropdown). Fetched on drawer load.
let _ttsProvider = 'openai';
// ElevenLabs voice catalog — populated lazily when ttsProvider='elevenlabs'.
let _elevenlabsVoices = [];
// Per-user voice configuration: { version, updated_at, slot_assignments }.
// Single source of truth for wake-slot routing — applies to every voice
// device paired to this user. Fetched on drawer open via /api/voice-config
// and PUT back via saveVoiceConfig(). Replaces the old per-device
// slot_assignments shape as of 2026-05-13.
let _voiceConfig = { version: 0, slot_assignments: {} };

// Caches for the multi-user slot assignment UI.
//   _usersRoster — list of all OE-install users (from /api/users); seeded on
//                  first device-drawer render. Privileged users get the full
//                  roster; non-privileged see only themselves so the picker
//                  collapses to a no-op for them.
//   _agentsByUser — { userId: [agents...] } populated lazily via the admin
//                  endpoint when the user picks a slot owner that isn't
//                  themselves. Reused across renders within a session.
let _usersRoster   = null;
const _agentsByUser = new Map();

// Always re-fetches by default so the slot-owner dropdown reflects users
// created since the drawer was last opened. Pass `cached:true` only if
// caller is fine with a stale snapshot (no current caller does).
async function ensureUsersRoster({ cached = false } = {}) {
  if (cached && _usersRoster) return _usersRoster;
  try {
    const r = await fetch('/api/users');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const list = await r.json();
    _usersRoster = Array.isArray(list) ? list : [];
  } catch (e) {
    console.warn('[devices] could not load /api/users:', e.message);
    if (!_usersRoster) _usersRoster = [];
  }
  return _usersRoster;
}

async function ensureAgentsForUser(userId) {
  if (!userId) return { agents: [], coordinatorId: null };
  if (_agentsByUser.has(userId)) return _agentsByUser.get(userId);
  try {
    const r = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/agents`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const out = { agents: Array.isArray(data.agents) ? data.agents : [], coordinatorId: data.coordinatorId ?? null };
    _agentsByUser.set(userId, out);
    return out;
  } catch (e) {
    console.warn(`[devices] agents for ${userId} failed:`, e.message);
    return { agents: [], coordinatorId: null };
  }
}

function fmtTimeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

async function loadDevices() {
  const body = $('drawerDevicesBody');
  if (!body) return;
  try {
    // Parallel fetches: paired devices, incoming-slots (other users
    // routing to me), wake-word library, TTS provider/voices, voice
    // refs, OE user roster, AND the per-user voice-config (sole source
    // of truth for slot routing since 2026-05-13 — applies to all of
    // this user's voice devices).
    const [rDevices, rIncoming, rLib, rTts, rRefs, _roster, rCfg] = await Promise.all([
      fetch('/api/devices'),
      fetch('/api/devices/incoming-slots'),
      fetch('/api/wakewords'),
      fetch('/api/tts/info'),
      fetch('/api/voice-refs'),
      ensureUsersRoster(),
      fetch('/api/voice-config'),
    ]);
    if (rTts.ok) {
      const info = await rTts.json();
      _ttsProvider = info.provider || 'openai';
    }
    if (rRefs.ok) {
      const { refs } = await rRefs.json();
      _voiceRefs = Array.isArray(refs) ? refs : [];
    } else {
      _voiceRefs = [];
    }
    // ElevenLabs voice list is a separate fetch (provider-conditional, and
    // it hits ElevenLabs' API server-side so worth not always paying for it).
    if (_ttsProvider === 'elevenlabs') {
      try {
        const rEl = await fetch('/api/tts/elevenlabs/voices');
        if (rEl.ok) {
          const { voices } = await rEl.json();
          _elevenlabsVoices = Array.isArray(voices) ? voices : [];
        }
      } catch { _elevenlabsVoices = []; }
    } else {
      _elevenlabsVoices = [];
    }
    if (!rDevices.ok) throw new Error(`HTTP ${rDevices.status}`);
    const { devices } = await rDevices.json();
    _devicesList = Array.isArray(devices) ? devices : [];
    if (rIncoming.ok) {
      const { slots } = await rIncoming.json();
      _incomingSlots = Array.isArray(slots) ? slots : [];
    } else {
      _incomingSlots = [];
    }
    if (rLib.ok) {
      const { wakewords } = await rLib.json();
      _wakewordLibrary = Array.isArray(wakewords) ? wakewords : [];
    } else {
      _wakewordLibrary = [];
    }
    if (rCfg.ok) {
      _voiceConfig = await rCfg.json();
    } else {
      _voiceConfig = { version: 0, slot_assignments: {} };
    }
    renderDevices();
    // Coordinator-name labels are populated lazily after render — we don't
    // know which user(s) are assigned to slots until the DOM is in place,
    // and the agents-per-user lookup is admin-gated and per-user-cached.
    populateCoordinatorLabels();
  } catch (e) {
    body.innerHTML = `<div class="cdraw-empty" style="color:var(--red)">Failed to load: ${escHtml(e.message)}</div>`;
  }
}

// Walk every rendered user card's coordinator-name label and fill it with
// the assigned user's coordinator agent name (fetched + cached per-user
// via ensureAgentsForUser). Replaces the older agent dropdown — the UI no
// longer lets you pin a slot to a non-coordinator agent.
async function populateCoordinatorLabels() {
  const body = $('drawerDevicesBody');
  if (!body) return;
  const labels = body.querySelectorAll('[data-coord-label]');
  const assignments = _voiceConfig?.slot_assignments || {};
  for (const lbl of labels) {
    const slotKey = lbl.dataset.coordLabel;
    const a = assignments[slotKey] ?? assignments[Number(slotKey)] ?? null;
    const span = lbl.querySelector('.cd-coord-name');
    if (!span || !a?.ownerUserId) continue;
    const { agents, coordinatorId } = await ensureAgentsForUser(a.ownerUserId);
    if (!coordinatorId) {
      span.textContent = '(no coordinator set)';
      span.style.color = 'var(--amber, #d49a44)';
      continue;
    }
    const coord = agents.find(g => g.id === coordinatorId);
    span.textContent = coord?.name || coordinatorId;
  }
}

function renderDevices() {
  const body = $('drawerDevicesBody');
  if (!body) return;

  const header = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="font-size:12px;color:var(--muted)">${_devicesList.length} paired</div>
      <div style="display:flex;gap:6px">
        ${_devicesList.length > 1
          ? `<button class="cdraw-btn" data-action="revokeAllDevices" style="font-size:11px;padding:5px 10px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)" title="Revoke every paired device + every voice-device session for this account">Revoke all</button>`
          : ''}
        <button class="cdraw-btn" data-action="flashNewDevice" style="font-size:11px;padding:5px 10px" title="Flash XVF3800 + ESP32-S3 firmware from the browser (Chrome/Edge only)">⚡ Flash new</button>
        <button class="cdraw-btn cdraw-btn-primary" data-action="pairNewDevice" style="font-size:11px;padding:5px 12px">+ Pair new device</button>
      </div>
    </div>
  `;

  // Wake-word library — user-uploaded .tflite + .json pairs available for
  // OTA push to any device slot. Always rendered (even when empty) so the
  // upload button is visible. Library is per-user; each device's slot
  // picker shows the device-OWNER's library entries.
  //
  // This library section shows ONLY the user's custom uploads. OE-shipped
  // stock wake words (sydney, athena, etc.) are not listed here — they're
  // available in the per-slot wake-word dropdown below alongside any
  // custom entries the user has uploaded. The intent: this section is
  // for "what have I personally added", while slot pickers show "what
  // can I assign". renderRow still has a stock-pill branch as defensive
  // code in case any caller invokes it on a stock entry.
  const renderRow = (w) => {
    const phrase = escHtml(w.wake_word || '(no phrase)');
    const size = (w.size_bytes / 1024).toFixed(1) + ' KB';
    const author = w.author ? ` · ${escHtml(w.author)}` : '';
    const trailing = w.stock
      ? `<span style="font-size:10px;padding:2px 6px;border-radius:8px;background:var(--bg);color:var(--muted);border:1px solid var(--border);text-transform:uppercase;letter-spacing:.04em">stock</span>`
      : `<button class="cdraw-btn" data-action="deleteWakeword" data-args='${JSON.stringify([w.id]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 7px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)" title="Delete from your library">Delete</button>`;
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
        <span style="flex:1"><strong>"${phrase}"</strong> <span style="color:var(--muted)">${size}${author}</span></span>
        ${trailing}
      </div>
    `;
  };
  const customWakewords = (_wakewordLibrary || []).filter(w => !w.stock);
  const libRows = customWakewords.length
    ? customWakewords.map(renderRow).join('')
    : '<div style="font-size:11px;color:var(--muted);padding:4px 0">No custom wake words uploaded yet. Use the dropdown below each slot to pick one of OE\'s bundled wake words, or upload your own here.</div>';
  // Library cap mirrors MAX_LIBRARY_ENTRIES on the server (10) — bounds
  // user uploads only; OE-shipped stock wake words don't count against it.
  const LIBRARY_CAP = 10;
  const libCount = customWakewords.length;
  const atCap = libCount >= LIBRARY_CAP;
  const libraryHtml = `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">
          Your custom wake words
          <span style="text-transform:none;letter-spacing:0;margin-left:6px;opacity:.7">${libCount} / ${LIBRARY_CAP}</span>
        </div>
        <button class="cdraw-btn cdraw-btn-primary" data-action="openWakewordUpload" style="font-size:11px;padding:4px 10px${atCap ? ';opacity:.4;pointer-events:none' : ''}" title="${atCap ? 'Library full — delete an entry first' : 'Upload a custom-trained .tflite + .json pair'}">+ Upload wake word</button>
      </div>
      ${libRows}
    </div>
  `;

  // Voice references — uploaded WAV clips used by F5-TTS for zero-shot
  // cloning. Only shown when ttsProvider='f5-tts'. Per-slot voice picker
  // (further down) selects which reference each wake phrase uses.
  const REFS_CAP = 10;
  const refsHtml = (_ttsProvider === 'f5-tts') ? `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">
          Voice references
          <span style="text-transform:none;letter-spacing:0;margin-left:6px;opacity:.7">${_voiceRefs.length} / ${REFS_CAP}</span>
        </div>
        <button class="cdraw-btn cdraw-btn-primary" data-action="openVoiceRefUpload" style="font-size:11px;padding:4px 10px${_voiceRefs.length >= REFS_CAP ? ';opacity:.4;pointer-events:none' : ''}" title="${_voiceRefs.length >= REFS_CAP ? 'Library full — delete one first' : 'Upload a ~10s WAV + transcript to clone that voice'}">+ Upload voice</button>
      </div>
      ${_voiceRefs.length ? _voiceRefs.map(r => {
        const dur = r.duration_s ? r.duration_s.toFixed(1) + 's' : '—';
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
            <span style="flex:1"><strong>${escHtml(r.label)}</strong> <span style="color:var(--muted)">${dur} · "${escHtml((r.transcript || '').slice(0, 60))}${r.transcript && r.transcript.length > 60 ? '…' : ''}"</span></span>
            <button class="cdraw-btn" data-action="deleteVoiceRef" data-args='${JSON.stringify([r.id]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 7px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)" title="Delete">Delete</button>
          </div>
        `;
      }).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px 0">No voice references uploaded. Click <strong>+ Upload voice</strong> to clone a voice from a short clip.</div>'}
    </div>
  ` : '';

  // "Shared with you" — wake-slots on other users' devices pointing at me.
  // Rendered above the paired-device list (or above the empty state) so the
  // section is visible even for users who don't own any device themselves.
  const SLOT_PHRASES = ['Sydney', 'Hey Ensemble'];
  const incomingHtml = (_incomingSlots && _incomingSlots.length) ? `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">Shared with you</div>
      ${_incomingSlots.map(s => {
        const phrase = SLOT_PHRASES[s.slot] ?? `Slot ${s.slot}`;
        const ownerName = (_usersRoster?.find(u => u.id === s.ownerUserId)?.name) || s.ownerUserId;
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:6px 0;font-size:12px">
            <span style="flex:1">
              <strong>"${escHtml(phrase)}"</strong> on
              <em>${escHtml(s.deviceName || s.deviceId)}</em>
              <span style="color:var(--muted)"> · owned by ${escHtml(ownerName)}</span>
            </span>
            <button class="cdraw-btn" data-action="removeIncomingSlot" data-args='${JSON.stringify([s.ownerUserId, s.deviceId, s.slot]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 8px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)" title="Stop routing this wake phrase to you">Remove</button>
          </div>
        `;
      }).join('')}
    </div>
  ` : '';

  if (!_devicesList.length) {
    body.innerHTML = header + libraryHtml + refsHtml + incomingHtml + `
      <div class="cdraw-empty" style="padding:30px 18px;text-align:center;font-size:13px;color:var(--muted);line-height:1.55">
        <div style="font-size:32px;margin-bottom:10px;opacity:.4">🎙️</div>
        ${_incomingSlots.length
          ? `You don't own any voice devices, but you can speak to other users' devices using the wake words above.`
          : `No voice devices paired yet.<br>Click <strong>+ Pair new device</strong> above to begin.`}
      </div>
    `;
    return;
  }

  // Firmware caps concurrent wake-word slots at WW_NUM_SLOTS=6 (see
  // firmware/voice-device/main/main.c). The voice-config is per-user and
  // applies to ALL of this user's voice devices; users see their own
  // display name as each card's header. UI allocates the lowest free
  // slot index on Add.
  const MAX_SLOTS = 6;
  const roster = Array.isArray(_usersRoster) ? _usersRoster : [];
  // Voice-configuration panel — single source of truth for slot routing
  // across every voice device this user owns. Rendered once at the top of
  // the drawer, NOT per-device, so changing it once propagates to every
  // device (kitchen / bedroom / etc).
  const voiceConfigPanel = renderVoiceConfigPanel(roster, _devicesList.length);

  const rows = _devicesList.map(d => {
    const lastSeen = d.last_seen ? fmtTimeAgo(d.last_seen) : 'never';
    const dot = d.online
      ? '<span title="Connected" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3cc36f;margin-right:6px;vertical-align:middle"></span>'
      : '<span title="Offline" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--muted,#888);margin-right:6px;vertical-align:middle"></span>';
    const status = d.online ? 'connected' : `seen ${escHtml(lastSeen)}`;
    const metaBits = [
      d.fw_version ? `fw ${escHtml(d.fw_version)}` : null,
      `${dot}${status}`,
      d.mute_state ? '<span style="color:var(--red,#e05c5c);font-weight:600">muted</span>' : null,
    ].filter(Boolean).join(' · ');
    return `
      <div class="cdraw-row" style="display:block;padding:14px 14px;border-bottom:1px solid var(--border);background:transparent;border-radius:0;margin-bottom:0">
        <div style="position:relative;text-align:center;margin-bottom:4px">
          <input type="text" class="cdraw-input device-name" value="${escHtml(d.name)}" data-action="renameDevice" data-args='${JSON.stringify([d.id]).replace(/'/g, '&#39;')}' placeholder="(unnamed device)" style="display:inline-block;font-weight:700;font-size:16px;text-align:center;color:#fff;background:transparent;border:1px dashed transparent;padding:4px 10px;border-radius:4px;min-width:60%;max-width:75%" title="Click to rename">
          <button class="cdraw-btn" data-action="playTestMp3" data-args='${JSON.stringify([d.id]).replace(/'/g, '&#39;')}' style="position:absolute;left:0;top:50%;transform:translateY(-50%);font-size:11px;padding:3px 8px" title="Upload a local MP3 and play it on this device (audio-quality test)">▶ Test MP3</button>
          <button class="cdraw-btn" data-action="revokeDevice" data-args='${JSON.stringify([d.id]).replace(/'/g, '&#39;')}' style="position:absolute;right:0;top:50%;transform:translateY(-50%);font-size:11px;padding:3px 8px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)" title="Drop this device and revoke its session token">Revoke</button>
        </div>
        <div style="text-align:center;font-size:11px;color:var(--muted)">${metaBits}</div>
      </div>
    `;
  }).join('');

  body.innerHTML = header + libraryHtml + refsHtml + incomingHtml + voiceConfigPanel + rows;
}

// Build the per-user voice-configuration panel: one card per assigned
// slot (user-named) + an "+ Add user" picker. Sits above the per-device
// rows so it's clear the config is global to all of this user's voice
// devices, not per-device.
function renderVoiceConfigPanel(roster, deviceCount) {
  const MAX_SLOTS = 6;
  const assignments = _voiceConfig?.slot_assignments || {};
  const assignedSlots = Array.from({ length: MAX_SLOTS }, (_, n) => n)
    .filter(n => (assignments[n] ?? assignments[String(n)])?.ownerUserId);
  const assignedUserIds = new Set(assignedSlots.map(n => (assignments[n] ?? assignments[String(n)]).ownerUserId));

  const slotBlocks = assignedSlots.map(slotIdx => {
    const a = assignments[slotIdx] ?? assignments[String(slotIdx)];
    const user = roster.find(u => u.id === a.ownerUserId);
    const displayName = escHtml(user?.name || a.ownerUserId);
    // Stale OpenAI named voices (alloy/echo/onyx/…) sit in legacy configs
    // from before the piper switch. Number input would reject them — hide
    // the value so the placeholder shows. Next save replaces it.
    const rawVoice = a?.ttsVoice || '';
    const curVoice = (_ttsProvider === 'piper' && rawVoice && !/^\d+$/.test(rawVoice)) ? '' : rawVoice;
    // Voice-control flavor depends on the install's TTS provider — same as
    // before, just now keyed by slot index alone instead of {deviceId, slot}.
    let voiceControl;
    if (_ttsProvider === 'elevenlabs') {
      const grouped = { cloned: [], generated: [], professional: [], premade: [], other: [] };
      for (const v of _elevenlabsVoices) {
        const cat = grouped[v.category] !== undefined ? v.category : 'other';
        grouped[cat].push(v);
      }
      const optgroups = Object.entries(grouped).filter(([, list]) => list.length)
        .map(([cat, list]) => `<optgroup label="${cat}">${list.map(v => `<option value="${escHtml(v.id)}" ${v.id === curVoice ? 'selected' : ''}>${escHtml(v.label)}</option>`).join('')}</optgroup>`)
        .join('');
      const elOpts = '<option value="">(device default)</option>' + (optgroups || '<option disabled>No voices found — check ElevenLabs API key</option>');
      voiceControl = `<span style="display:flex;gap:4px;align-items:center;min-width:0">
           <select class="cdraw-input" data-action="setSlotVoice" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}' style="flex:1;min-width:0;padding:4px 6px;font-size:12px">${elOpts}</select>
         </span>`;
    } else if (_ttsProvider === 'f5-tts') {
      const refOpts = ['<option value="">(device default)</option>']
        .concat([{ id: 'default-en', label: 'Default (F5-TTS bundled)' }, ..._voiceRefs]
          .map(r => `<option value="${escHtml(r.id)}" ${r.id === curVoice ? 'selected' : ''}>${escHtml(r.label)}</option>`))
        .join('');
      voiceControl = `<select class="cdraw-input" data-action="setSlotVoice" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}' style="padding:4px 6px;font-size:12px;min-width:0">${refOpts}</select>`;
    } else if (_ttsProvider === 'piper') {
      // Number input + a tiny preview button. Piper has 904 speakers and
      // there's no useful label per ID, so users need to audition before
      // committing. Preview synthesizes a short sample server-side and
      // plays it through the BROWSER (not the voice device) so iteration
      // is fast and doesn't wake the device.
      voiceControl = `
        <div style="display:flex;gap:4px;align-items:center;min-width:0">
          <input type="number" min="0" max="903" step="1" class="cdraw-input piper-voice-input"
            placeholder="0-903" value="${escHtml(curVoice)}"
            data-action="setSlotVoice" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}'
            style="padding:4px 6px;font-size:12px;width:70px;flex:0 0 auto">
          <button type="button" class="cdraw-btn piper-voice-preview"
            data-action="previewSlotVoice" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}'
            title="Preview this speaker in your browser"
            style="font-size:11px;padding:3px 8px;flex:0 0 auto">Preview</button>
        </div>`;
    } else {
      voiceControl = `<select class="cdraw-input" data-action="setSlotVoice" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}' style="padding:4px 6px;font-size:12px;min-width:0">${['<option value="">(device default)</option>'].concat(OPENAI_TTS_VOICES.map(v => `<option value="${v}" ${v === curVoice ? 'selected' : ''}>${v}</option>`)).join('')}</select>`;
    }
    const curWw = a?.wakewordId || '';
    const wwOpts = ['<option value="">(no wake word — pick one)</option>']
      .concat(_wakewordLibrary.map(w => `<option value="${escHtml(w.id)}" ${w.id === curWw ? 'selected' : ''}>${escHtml(w.wake_word || w.id)}</option>`))
      .join('');
    return `
        <div style="background:var(--bg2);border-radius:6px;padding:8px 10px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
            <span style="font-weight:600;font-size:13px">${displayName}</span>
            <button class="cdraw-btn" data-action="removeSlotUser" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 7px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)" title="Remove this user from the voice configuration">Remove</button>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-bottom:6px" data-coord-label="${slotIdx}">Agent: <span class="cd-coord-name">(loading…)</span></div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:center">
            <label style="font-size:11px;color:var(--muted)">Voice</label>
            ${voiceControl}
            <label style="font-size:11px;color:var(--muted)">Wake</label>
            <select class="cdraw-input" data-action="setSlotWakeword" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}' style="padding:4px 6px;font-size:12px;min-width:0" title="Wake word that fires this slot — pushed OTA to every device">${wwOpts}</select>
          </div>
        </div>
    `;
  }).join('');

  const addCandidates = roster.filter(u => !assignedUserIds.has(u.id));
  const atCap = assignedSlots.length >= MAX_SLOTS;
  let addControl = '';
  if (atCap) {
    addControl = `<div style="font-size:11px;color:var(--muted);text-align:center;padding:6px">All ${MAX_SLOTS} slots in use.</div>`;
  } else if (addCandidates.length > 0) {
    const opts = ['<option value="">+ Add a user…</option>']
      .concat(addCandidates.map(u => `<option value="${escHtml(u.id)}">${escHtml(u.name || u.id)}</option>`))
      .join('');
    addControl = `<select class="cdraw-input" data-action="addSlotUser" style="padding:4px 8px;font-size:12px;min-width:0">${opts}</select>`;
  }
  const emptyState = assignedSlots.length === 0
    ? '<div style="font-size:11px;color:var(--muted);padding:8px 10px;text-align:center;background:var(--bg2);border-radius:6px">No users in this voice configuration yet. Pick one below to start.</div>'
    : '';

  const scopeNote = deviceCount > 0
    ? 'Change once, every device updates.'
    : 'No voice devices paired yet. This config will apply automatically when you pair one.';

  return `
    <div style="padding:14px;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Global voice configuration</div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:10px">${escHtml(scopeNote)}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px">${slotBlocks}</div>
      ${emptyState}
      ${addControl ? `<div style="margin-top:8px">${addControl}</div>` : ''}
    </div>
  `;
}

// ── Patch helpers ────────────────────────────────────────────────────────────
// Tiny in-drawer toast — fades in, lingers ~3s, fades out. Used to confirm
// OTA pushes and other transient feedback. Falls back to alert() if the
// drawer body isn't currently rendered.
function showDeviceToast(msg, { variant = 'info' } = {}) {
  const body = $('drawerDevicesBody');
  if (!body) { console.log('[devices toast]', msg); return; }
  const bg = variant === 'error' ? 'var(--red,#e05c5c)'
           : variant === 'warn'  ? 'var(--amber,#d49a44)'
           : 'var(--bg3)';
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:${bg};color:#fff;padding:8px 14px;border-radius:6px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,.4);z-index:9999;opacity:0;transition:opacity .25s`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.style.opacity = '1');
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 3000);
}

async function patchDevice(id, patch) {
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { device, push } = await r.json();
    const idx = _devicesList.findIndex(x => x.id === id);
    if (idx >= 0) _devicesList[idx] = device;
    // OTA-push feedback so the user knows their slot change reached the device.
    if (push?.pushed?.length) {
      showDeviceToast(`Wake word pushed to slot ${push.pushed.join(', ')} — say it to test.`);
    }
    if (push?.offline?.length) {
      showDeviceToast(`Slot ${push.offline.join(', ')} saved, but device is offline — will retry on next change.`, { variant: 'warn' });
    }
  } catch (e) {
    // Don't refetch on error — it costs 5 extra requests and just compounds
    // rate-limit / network failures. The UI state may be momentarily stale
    // but the next user action (or drawer reopen) reconciles.
    showDeviceToast(`Update failed: ${e.message}`, { variant: 'error' });
  }
}

// data-action handlers — global so event-delegation can call them
window.renameDevice = function (id, ev) {
  const v = (ev?.target?.value || '').trim();
  if (v) patchDevice(id, { name: v });
};
window.setDeviceAgent = function (id, ev) {
  patchDevice(id, { default_agent_id: ev.target.value || null });
};
window.setDeviceVoice = function (id, ev) {
  patchDevice(id, { tts_voice: ev.target.value });
};
// Save the current _voiceConfig.slot_assignments back to the server.
// PUT /api/voice-config fans out wake-word OTA pushes to every device
// paired to the user. Returns the new server-side config (with bumped
// version) so we keep _voiceConfig in lockstep.
async function saveVoiceConfig() {
  try {
    const r = await fetch('/api/voice-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot_assignments: _voiceConfig.slot_assignments }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    _voiceConfig = data.config;
    // Aggregate per-device push results for the toast — voice-config
    // applies to all of this user's devices so push results need a
    // device-count rollup, not a per-slot toast.
    const push = data.push || {};
    const onlineSlots = new Set();
    const offlineDevices = new Set();
    let pushedDeviceCount = 0;
    for (const [deviceId, r] of Object.entries(push)) {
      if (r.pushedSlots?.length) {
        pushedDeviceCount++;
        for (const s of r.pushedSlots) onlineSlots.add(s);
      }
      if (r.offlineSlots?.length) offlineDevices.add(deviceId);
    }
    if (pushedDeviceCount > 0) {
      showDeviceToast(`Saved — pushed to ${pushedDeviceCount} device${pushedDeviceCount === 1 ? '' : 's'}.`);
    } else if (offlineDevices.size > 0) {
      showDeviceToast(`Saved — devices offline, will sync on next connect.`, { variant: 'warn' });
    } else {
      showDeviceToast('Saved.');
    }
  } catch (e) {
    showDeviceToast(`Save failed: ${e.message}`, { variant: 'error' });
  }
}

// Add-user picker: allocates the lowest free slot index for the chosen
// user, writes the fresh assignment to _voiceConfig, and PUTs the whole
// config so every device gets the new wake-word OTA. agentId stays null
// (routes to that user's coordinator; UI doesn't expose pin-to-agent).
window.addSlotUser = async function (ev) {
  const userId = ev.target.value;
  if (!userId) return;
  const cur = { ...(_voiceConfig.slot_assignments || {}) };
  let slot = -1;
  for (let i = 0; i < 6; i++) {
    if (!cur[i] && !cur[String(i)]) { slot = i; break; }
  }
  if (slot < 0) {
    showDeviceToast('All 6 slots are in use — remove a user first.', { variant: 'warn' });
    ev.target.value = '';
    return;
  }
  cur[slot] = { ownerUserId: userId, agentId: null, ttsVoice: null, wakewordId: null };
  _voiceConfig.slot_assignments = cur;
  await saveVoiceConfig();
  renderDevices();
  populateCoordinatorLabels();
};

// Remove-user button: clears the slot from _voiceConfig and saves. Wake
// words stay on every device's SPIFFS until that slot is reassigned and
// re-pushed; the routing entry going away is what stops the wake from
// firing.
window.removeSlotUser = async function (slot) {
  const a = _voiceConfig.slot_assignments?.[slot] ?? _voiceConfig.slot_assignments?.[String(slot)];
  const roster = Array.isArray(_usersRoster) ? _usersRoster : [];
  const name = roster.find(u => u.id === a?.ownerUserId)?.name || a?.ownerUserId || 'user';
  if (!confirm(`Remove "${name}" from the voice configuration? Their wake word will stop routing on every paired device.`)) return;
  const cur = { ...(_voiceConfig.slot_assignments || {}) };
  delete cur[slot];
  delete cur[String(slot)];
  _voiceConfig.slot_assignments = cur;
  await saveVoiceConfig();
  renderDevices();
  populateCoordinatorLabels();
};

// Slot voice picker: TTS voice for replies routed through this slot.
// Empty value = fall back to the device-level tts_voice.
window.setSlotVoice = function (slot, ev) {
  const existing = _voiceConfig.slot_assignments?.[slot] ?? _voiceConfig.slot_assignments?.[String(slot)];
  if (!existing?.ownerUserId) return;
  const next = ev.target.value || null;
  // Browsers fire `change` even when re-selecting the same option; skip
  // the PUT (and the OTA push it triggers) when nothing actually changed.
  if ((existing.ttsVoice ?? null) === next) return;
  _voiceConfig.slot_assignments[slot] = { ...existing, ttsVoice: next };
  saveVoiceConfig();
};

// Slot voice preview: play a short sample using the slot's currently
// selected voice. Lets the admin audition a libritts_r speaker before
// committing it. Pulls the voice value from the live input element (not
// the persisted slot_assignments) so unsaved tweaks are previewable too.
//
// `this` is the button element (per event-delegation.js's fn.apply(el, ...)).
// The Piper voice control wraps its <input> + <button> in a <div>, so we
// find the input via the parent's `.piper-voice-input` class rather than
// previousElementSibling. /api/tts returns raw audio/mpeg bytes (NOT a
// JSON wrapper — the old version of this function decoded base64 and was
// silently broken after the TTS path was refactored to stream).
window.previewSlotVoice = function (slot) {
  const btn = this;
  if (!btn) return;
  const input = btn.parentElement?.querySelector('.piper-voice-input');
  const voice = (input?.value || '').trim();
  // Update the label so the user has feedback while the request is in flight.
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';

  fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `Hello, I am speaker ${voice || 0}.`, voice }),
  }).then(async r => {
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${errText.slice(0, 120)}`);
    }
    return r.blob();
  }).then(blob => {
    const url = URL.createObjectURL(blob);
    const audioEl = new Audio(url);
    audioEl.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
    return audioEl.play().catch(err => {
      // Autoplay blocked? Surface a clear hint. Shouldn't normally hit
      // this because the call originated from a real click.
      showDeviceToast?.(`Audio blocked: ${err.message}`, { variant: 'warn' });
    });
  }).catch(e => {
    console.error('[devices] preview fetch failed:', e);
    showDeviceToast?.(`Preview failed: ${e.message}`, { variant: 'error' });
  }).finally(() => {
    btn.disabled = false;
    btn.textContent = originalLabel;
  });
};

// Slot wake-word picker: swap the wake word that fires this slot. Empty
// value clears it. The PUT push fans out to every paired device's SPIFFS;
// firmware hot-reloads the slot without rebooting.
window.setSlotWakeword = function (slot, ev) {
  const existing = _voiceConfig.slot_assignments?.[slot] ?? _voiceConfig.slot_assignments?.[String(slot)];
  if (!existing?.ownerUserId) return;
  const next = ev.target.value || null;
  // Re-selecting the same option still fires `change` — skip the PUT (and
  // its OTA push) to avoid pointless flash writes when nothing changed.
  if ((existing.wakewordId ?? null) === next) return;
  _voiceConfig.slot_assignments[slot] = { ...existing, wakewordId: next };
  saveVoiceConfig();
};

// Open a hidden file picker for the wake-word upload flow. User selects
// both the .tflite and the .json manifest; we read them, base64 the tflite,
// and POST to /api/wakewords.
window.openWakewordUpload = function () {
  // Create a transient <input type="file" multiple> rather than a static
  // element so the dialog can be reopened repeatedly.
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.tflite,.json';
  input.multiple = true;
  input.style.display = 'none';
  input.onchange = async () => {
    const files = Array.from(input.files || []);
    let tfliteFile = null, jsonFile = null;
    for (const f of files) {
      if (f.name.toLowerCase().endsWith('.tflite')) tfliteFile = f;
      else if (f.name.toLowerCase().endsWith('.json')) jsonFile = f;
    }
    if (!tfliteFile || !jsonFile) {
      alert('Select both a .tflite and a .json manifest file.');
      return;
    }
    try {
      // Read both files in parallel — manifest as text (small), tflite as
      // ArrayBuffer so we can base64 it for the JSON-bodied upload endpoint.
      const [manifestText, tfliteBuf] = await Promise.all([
        jsonFile.text(),
        tfliteFile.arrayBuffer(),
      ]);
      let manifest;
      try { manifest = JSON.parse(manifestText); } catch (e) {
        alert(`Manifest is not valid JSON: ${e.message}`);
        return;
      }
      // Browser-side base64. btoa wants a binary string; build it from the
      // Uint8Array a chunk at a time to avoid String.fromCharCode argument
      // limits on big files (~64K args max in some engines).
      const u8 = new Uint8Array(tfliteBuf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      const tflite_b64 = btoa(bin);
      const r = await fetch('/api/wakewords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tflite_b64, manifest, original_filename: tfliteFile.name }),
      });
      if (!r.ok) {
        const { error } = await r.json().catch(() => ({}));
        throw new Error(error || `HTTP ${r.status}`);
      }
      showDeviceToast(`"${manifest.wake_word || tfliteFile.name}" uploaded — pick it in a slot's Wake dropdown to push to your device.`);
      loadDevices();
    } catch (e) {
      showDeviceToast(`Upload failed: ${e.message}`, { variant: 'error' });
    }
  };
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 60_000);
};

// Open a small modal to upload a voice reference for F5-TTS. Three inputs:
// WAV file (10-15s of clean speech), label ("Shawn", "Test"), and a
// transcript of exactly what's said in the clip. F5-TTS clones much better
// when given an accurate transcript.
window.openVoiceRefUpload = function () {
  const label = prompt('Voice label (e.g. "Shawn", "Test"):');
  if (!label || !label.trim()) return;
  const transcript = prompt('Transcript — type EXACTLY what is said in the WAV (e.g. "Hello, my name is Shawn and this is my voice."):');
  if (!transcript || !transcript.trim()) return;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.wav,audio/wav';
  input.style.display = 'none';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.wav')) {
      showDeviceToast('Reference must be a .wav file.', { variant: 'error' });
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const u8 = new Uint8Array(buf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
      }
      const wav_b64 = btoa(bin);
      const r = await fetch('/api/voice-refs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wav_b64, label: label.trim(), transcript: transcript.trim() }),
      });
      if (!r.ok) {
        const { error } = await r.json().catch(() => ({}));
        throw new Error(error || `HTTP ${r.status}`);
      }
      showDeviceToast(`"${label.trim()}" uploaded — assign it to a slot's Voice picker.`);
      loadDevices();
    } catch (e) {
      showDeviceToast(`Upload failed: ${e.message}`, { variant: 'error' });
    }
  };
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 60_000);
};

window.deleteVoiceRef = async function (id) {
  const r = _voiceRefs.find(x => x.id === id);
  if (!confirm(`Delete voice reference "${r?.label || id}"?\n\nDevices already using it will fall back to default until you pick a new one.`)) return;
  try {
    const resp = await fetch(`/api/voice-refs/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    loadDevices();
  } catch (e) {
    showDeviceToast(`Delete failed: ${e.message}`, { variant: 'error' });
  }
};

// Delete a library entry. The server keeps any device slot_assignments
// referencing this id; firmware will fall back to its built-in slot model
// on the next reload (which doesn't happen automatically, so existing
// devices keep the old loaded model until rebooted).
window.deleteWakeword = async function (id) {
  const w = _wakewordLibrary.find(x => x.id === id);
  if (!confirm(`Delete "${w?.wake_word || id}" from your library?\n\nDevices already using this wake word keep it loaded until they reboot.`)) return;
  try {
    const r = await fetch(`/api/wakewords/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    loadDevices();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
  }
};
window.setDeviceSpeak = function (id, ev) {
  patchDevice(id, { speak_replies: !!ev.target.checked });
};

// Clear a wake-slot on someone else's device that's pointing at me.
// The server checks the auth user actually owns the slot before clearing.
window.removeIncomingSlot = async function (ownerUserId, deviceId, slot) {
  if (!confirm('Stop routing this wake word to your account?')) return;
  try {
    const r = await fetch(`/api/devices/incoming-slots/${encodeURIComponent(ownerUserId)}/${encodeURIComponent(deviceId)}/${encodeURIComponent(slot)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    loadDevices();
  } catch (e) {
    alert(`Remove failed: ${e.message}`);
  }
};

// Pick a local MP3 and push it to the device for an audio-quality test.
// Server transcodes to 16 kHz mono and hijacks the TTS playback path; no
// firmware change. File-size sanity-capped at 10 MB so a megabyte browser
// → base64 → JSON round-trip stays reasonable (~13 MB JSON body).
window.playTestMp3 = function (id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mp3,audio/mpeg';
  input.style.display = 'none';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showDeviceToast('MP3 too large (max 10 MB). Trim it down.', { variant: 'error' });
      return;
    }
    try {
      // Stream the file as raw bytes — base64+JSON ran out of memory /
      // hit string-size limits in btoa for ~10 MB payloads. fetch can
      // send a File/Blob directly as the body; browser handles chunking.
      const r = await fetch(`/api/devices/${encodeURIComponent(id)}/play-mp3`, {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'audio/mpeg' },
        body: file,
      });
      if (!r.ok) {
        const { error } = await r.json().catch(() => ({}));
        throw new Error(error || `HTTP ${r.status}`);
      }
      const { bytes } = await r.json();
      showDeviceToast(`Pushed ${bytes} bytes to device — should play now.`);
    } catch (e) {
      showDeviceToast(`Test failed: ${e.message}`, { variant: 'error' });
    }
  };
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 60_000);
};

window.revokeDevice = async function (id) {
  const d = _devicesList.find(x => x.id === id);
  if (!confirm(`Revoke "${d?.name || id}"? The device will lose its session token and need to be re-paired.`)) return;
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    loadDevices();
  } catch (e) {
    alert(`Revoke failed: ${e.message}`);
  }
};

window.revokeAllDevices = async function () {
  if (!confirm('Revoke every paired voice device for this account? Each will need to be re-paired.')) return;
  try {
    const r = await fetch('/api/devices/revoke-all', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    loadDevices();
  } catch (e) {
    alert(`Revoke-all failed: ${e.message}`);
  }
};

// ── Pairing ──────────────────────────────────────────────────────────────────
window.pairNewDevice = async function () {
  try {
    const r = await fetch('/api/devices/pair', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { code, expiresIn, serverHost } = await r.json();
    const minutes = Math.floor(expiresIn / 60);

    const modal = document.createElement('div');
    modal.className = 'node-pair-modal';
    modal.innerHTML = `
      <div class="node-pair-modal-bg" data-action="_nodePairModalClose"></div>
      <div class="node-pair-modal-box">
        <div style="font-weight:700;font-size:15px;margin-bottom:12px">Pair voice device</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:14px;text-align:left;line-height:1.55">
          On first boot the device comes up as the Wi-Fi AP <code>oe-voice-XXXX</code>. Join that AP from your phone, fill in the captive portal form (Wi-Fi creds + server URL + this pairing code), and the device will reboot into operational mode.
          <div style="margin-top:8px"><strong>Server URL:</strong> <code style="user-select:all">${escHtml(serverHost || location.host)}</code></div>
        </div>
        <details style="font-size:11px;color:var(--muted);margin-bottom:14px;text-align:left;background:var(--bg2);padding:8px 10px;border-radius:6px">
          <summary style="cursor:pointer;font-weight:600">Device not enumerating? First-time setup hint</summary>
          <div style="margin-top:6px;line-height:1.5">
            For the one-time i2s-master flash, hold the <strong>Mute</strong> button on the XVF3800 while plugging in USB-C — this drops it into DFU mode so <code>dfu-util</code> can see it. A plain plug-in lands in the runtime USB-audio variant and flashing silently fails.
          </div>
        </details>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Pairing code:</div>
        <div class="node-pair-code">${escHtml(code)}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:12px">Expires in ${minutes} minute${minutes === 1 ? '' : 's'}</div>
        <button class="cdraw-btn" style="margin-top:16px;width:100%" data-action="_nodePairModalCloseInner">Close</button>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('show'));
  } catch (e) {
    alert('Failed to generate pairing code: ' + e.message);
  }
};
