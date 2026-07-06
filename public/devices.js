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
// User's voice-reference library (Pocket TTS zero-shot clones). Each entry
// is a label + WAV file the user uploaded (transcript optional); Pocket TTS
// clones from these. Drawer fetches this when ttsProvider='pocket-tts'.
let _voiceRefs = [];
// Alarm chime state — per-user. { hasCustom: bool, sizeBytes: number }.
// When hasCustom is false the device(s) use the firmware's built-in
// procedural two-tone chime.
let _chimeInfo = { hasCustom: false, sizeBytes: 0 };
// Server-reported TTS provider. Drives which voice-control UI to render
// per slot ('openai' → named-voice dropdown, 'piper' → numeric speaker
// ID input, 'pocket-tts' → cloned-voice dropdown, 'elevenlabs' → fetched-voice
// dropdown). Fetched on drawer load.
let _ttsProvider = 'openai';
// Runtime availability snapshot from /api/tts/info — { ffmpeg, openai,
// piper, elevenlabs }. Used to surface a banner when the configured
// provider can't actually fulfill TTS (missing ffmpeg, Piper down, key
// cleared) so devices don't silently hang on the next wake.
let _ttsAvailable = null;
// Runtime availability snapshot from /api/stt/info. STT is the first server
// hop after wake capture, so it gets its own health state instead of being
// inferred from provider settings.
let _sttInfo = null;
// ElevenLabs voice catalog — populated lazily when ttsProvider='elevenlabs'.
let _elevenlabsVoices = [];
// KittenTTS preset-voice list (8 baked-in names) — populated from /api/tts/info
// when ttsProvider='kittentts'. Empty otherwise.
let _kittenttsVoices = [];
let _piperVoices = []; // installed Piper voices for the per-slot picker.
// Voice routines (trigger phrase → action list) and the ambient sound library
// they draw from. Both per-user; the Routines panel below the voice-config
// section in the drawer is the sole UI for both. Server-side persistence in
// users/<id>/routines.json + users/<id>/ambient/*.mp3.
let _routines = [];
let _ambientFiles = [];
// HA scene + script entities — populated on drawer open from the HA cache.
// Drives the ha_scene action picker so users don't have to type entity ids.
let _haSceneEntities = [];
// Broader HA actionable-entity list (light/switch/fan/cover/lock/media_player/
// climate/input_boolean/automation/group + scenes/scripts) used by the ha_call
// action editor's entity-picker dropdown. Same shape as _haSceneEntities:
// [{entity_id, domain, friendly_name}, ...]. Sourced from the same cache as
// scenes — the entities endpoint filters server-side by ?domain=…
let _haActionEntities = [];
// HA service catalog — {domain: [serviceName, ...]}. Drives the cascading
// domain + service dropdowns in the ha_call action editor so users pick
// from real services instead of guessing at strings.
let _haServiceCatalog = {};

// Resolve the current user's coordinator agent name for routine-editor UI
// strings. Reads the global `agents` array set up in init.js — every user
// names their coordinator something different, so the "Ask <name>" labels
// must NOT hardcode any specific name; resolve at render time.
function _coordinatorLabel() {
  const list = (typeof agents !== 'undefined' && Array.isArray(agents)) ? agents : [];
  const coord = list.find(a => a?.skillCategory === 'coordinator');
  const name = coord?.name?.trim();
  return name || 'your coordinator';
}

// Per-user voice configuration: { version, updated_at, slot_assignments }.
// Single source of truth for wake-slot routing — applies to every voice
// device paired to this user. Fetched on drawer open via /api/voice-config
// and PUT back via saveVoiceConfig(). Replaces the old per-device
// slot_assignments shape as of 2026-05-13.
let _voiceConfig = { version: 0, slot_assignments: {} };

// Cached firmware manifest from /firmware/voice-device/manifest.json.
// Loaded once per drawer open so the per-device row can render an Update
// button when manifest.version > device.fw_version. Null until the fetch
// resolves; we just skip the Update affordance until then.
let _firmwareManifest = null;

// Compare two dotted-version strings "MAJOR.MINOR.PATCH". Returns >0 if a>b,
// <0 if a<b, 0 if equal. Mirrors firmware-side version_cmp in oe_ota.c.
function versionCmp(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

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
    const [rDevices, rIncoming, rLib, rTts, rStt, rRefs, _roster, rCfg, rFw, rChime, rRoutines, rAmbient, rHaEnts, rHaCall, rHaSvc] = await Promise.all([
      fetch('/api/devices'),
      fetch('/api/devices/incoming-slots'),
      fetch('/api/wakewords'),
      fetch('/api/tts/info'),
      fetch('/api/stt/info'),
      fetch('/api/voice-refs'),
      ensureUsersRoster(),
      fetch('/api/voice-config'),
      fetch('/firmware/voice-device/manifest.json'),
      fetch('/api/voice-chime'),
      fetch('/api/routines'),
      fetch('/api/devices/ambient-library'),
      fetch('/api/home-assistant/entities?domain=scene,script,group'),
      // Broader actionable-entity list for the ha_call entity picker.
      fetch('/api/home-assistant/entities?domain=light,switch,fan,cover,lock,media_player,climate,input_boolean,automation,group,scene,script'),
      fetch('/api/home-assistant/services'),
    ]);
    // Firmware manifest is best-effort — if it's missing (no flash wizard
    // bundled, etc.) the Update button just doesn't appear. Don't fail the
    // drawer over it.
    if (rFw.ok) {
      try { _firmwareManifest = await rFw.json(); } catch { _firmwareManifest = null; }
    } else {
      _firmwareManifest = null;
    }
    if (rTts.ok) {
      const info = await rTts.json();
      _ttsProvider = info.provider || 'openai';
      _ttsAvailable = info.available || null;
      _kittenttsVoices = Array.isArray(info.voices) ? info.voices : [];
    } else {
      _ttsAvailable = null;
      _kittenttsVoices = [];
    }
    if (rStt.ok) {
      try { _sttInfo = await rStt.json(); }
      catch { _sttInfo = null; }
    } else {
      _sttInfo = null;
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
    // Piper installed voices — same provider-conditional pattern. Proxies
    // the multivoice server's /voices endpoint and enriches with catalog
    // metadata (label, gender, multi_speaker, etc.).
    if (_ttsProvider === 'piper') {
      try {
        const rP = await fetch('/api/tts/piper/voices');
        if (rP.ok) {
          const { voices } = await rP.json();
          _piperVoices = Array.isArray(voices) ? voices : [];
        }
      } catch { _piperVoices = []; }
    } else {
      _piperVoices = [];
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
    if (rChime && rChime.ok) {
      try { _chimeInfo = await rChime.json(); }
      catch { _chimeInfo = { hasCustom: false, sizeBytes: 0 }; }
    } else {
      _chimeInfo = { hasCustom: false, sizeBytes: 0 };
    }
    if (rRoutines && rRoutines.ok) {
      try { const j = await rRoutines.json(); _routines = Array.isArray(j.routines) ? j.routines : []; }
      catch { _routines = []; }
    } else { _routines = []; }
    if (rAmbient && rAmbient.ok) {
      try { const j = await rAmbient.json(); _ambientFiles = Array.isArray(j.files) ? j.files : []; }
      catch { _ambientFiles = []; }
    } else { _ambientFiles = []; }
    if (rHaEnts && rHaEnts.ok) {
      try { const j = await rHaEnts.json(); _haSceneEntities = Array.isArray(j.entities) ? j.entities : []; }
      catch { _haSceneEntities = []; }
    } else { _haSceneEntities = []; }
    if (rHaCall && rHaCall.ok) {
      try { const j = await rHaCall.json(); _haActionEntities = Array.isArray(j.entities) ? j.entities : []; }
      catch { _haActionEntities = []; }
    } else { _haActionEntities = []; }
    if (rHaSvc && rHaSvc.ok) {
      try { const j = await rHaSvc.json(); _haServiceCatalog = (j.services && typeof j.services === 'object') ? j.services : {}; }
      catch { _haServiceCatalog = {}; }
    } else { _haServiceCatalog = {}; }
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

// Surface a warning when /api/tts/info reports the configured TTS
// provider can't actually fulfill a request (missing ffmpeg, Piper
// service down, key cleared since pairing). Without this the device
// would just sit in THINKING-forever the next time it wakes; this
// makes the failure mode visible in the drawer where the user can fix
// it (Settings → Providers).
function renderTtsAvailabilityBanner() {
  if (!_ttsAvailable) return '';
  if (_ttsAvailable[_ttsProvider]) return '';
  const reason = !_ttsAvailable.ffmpeg
    ? 'ffmpeg is not installed on this server. All TTS providers need it. Install with: <code>sudo apt install ffmpeg</code> (or your distro equivalent), then restart OE.'
    : _ttsProvider === 'piper'
      ? 'The local Piper service is not running. Reinstall or restart it from Settings → Providers → Text-to-Speech.'
      : _ttsProvider === 'kittentts'
        ? 'The local KittenTTS service is not running. Install or restart it from Settings → Providers → Text-to-Speech.'
        : _ttsProvider === 'pocket-tts'
          ? 'The local Pocket TTS service is not running. In Settings → Providers → Text-to-Speech, select Pocket TTS and click Save to start it.'
        : _ttsProvider === 'elevenlabs'
          ? 'The ElevenLabs API key is missing. Set it in Settings → Providers → Text-to-Speech.'
          : 'The OpenAI-compatible TTS provider is not configured. Set the URL and API key in Settings → Providers → Text-to-Speech.';
  return `
    <div style="padding:10px 14px;background:var(--bg3);border-bottom:1px solid var(--warning,#d97706);color:var(--warning,#d97706);font-size:12px;line-height:1.5">
      <strong>Voice replies disabled:</strong> ${reason}
    </div>
  `;
}

function renderVoiceHealthPanel() {
  const online = _devicesList.filter(d => d.online).length;
  const total = _devicesList.length;
  const manifestVer = _firmwareManifest?.version || null;
  const outdated = manifestVer
    ? _devicesList.filter(d => d.fw_version && versionCmp(manifestVer, d.fw_version) > 0).length
    : 0;
  const unknownFw = _devicesList.filter(d => !d.fw_version).length;

  const ttsOk = !!(_ttsAvailable && _ttsAvailable[_ttsProvider]);
  const sttOk = !!(_sttInfo && _sttInfo.available);
  const chip = (label, ok, detail) => `
    <div style="display:flex;align-items:center;gap:7px;min-width:0;padding:7px 8px;border:1px solid var(--border);background:var(--bg);border-radius:6px">
      <span style="width:8px;height:8px;border-radius:50%;background:${ok ? '#3cc36f' : 'var(--amber,#d49a44)'};flex:0 0 auto"></span>
      <div style="min-width:0">
        <div style="font-size:11px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${label}</div>
        <div style="font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${detail}</div>
      </div>
    </div>
  `;

  const deviceDetail = total
    ? `${online}/${total} online`
    : 'no paired devices';
  const sttDetail = _sttInfo
    ? (_sttInfo.mode === 'local'
      ? `local Whisper ${_sttInfo.localAvailable ? 'running' : 'not reachable'}`
      : `remote ${_sttInfo.remoteConfigured ? 'configured' : 'missing key or URL'}`)
    : 'status unavailable';
  const ttsDetail = _ttsAvailable
    ? `${_ttsProvider} ${ttsOk ? 'ready' : 'not ready'}`
    : 'status unavailable';
  const fwDetail = manifestVer
    ? (outdated ? `${outdated} update available` : unknownFw ? `${unknownFw} unknown` : `server ${manifestVer}`)
    : 'manifest unavailable';

  const hints = [];
  if (_sttInfo && !sttOk) {
    hints.push(_sttInfo.mode === 'local'
      ? 'STT is set to local, but Faster-Whisper is not reachable on 127.0.0.1:5154.'
      : 'STT is set to remote, but the Whisper URL or API key is missing.');
  }
  if (_ttsAvailable && !ttsOk) {
    hints.push('TTS is not ready, so a successful chat turn may still produce no spoken reply.');
  }
  if (total && online === 0) hints.push('No paired voice device is online right now.');
  if (outdated) hints.push('One or more devices can be updated.');

  return `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Voice health</div>
        <button class="cdraw-btn" data-action="loadDevices" style="font-size:11px;padding:3px 8px" title="Refresh voice health">Refresh</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px">
        ${chip('Devices', total > 0 && online > 0, deviceDetail)}
        ${chip('STT', sttOk, sttDetail)}
        ${chip('TTS', ttsOk, ttsDetail)}
        ${chip('Firmware', !outdated && !unknownFw, fwDetail)}
      </div>
      ${hints.length ? `<div style="margin-top:8px;font-size:11px;color:var(--amber,#d49a44);line-height:1.45">${hints.map(escHtml).join(' ')}</div>` : ''}
    </div>
  `;
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
    ${renderTtsAvailabilityBanner()}
    ${renderVoiceHealthPanel()}
  `;

  // Wake-word library — user-uploaded .tflite + .json pairs available for
  // OTA push to any device slot. Always rendered (even when empty) so the
  // upload button is visible. Library is per-user; each device's slot
  // picker shows the device-OWNER's library entries.
  //
  // This library section shows ONLY the user's custom uploads. OE-shipped
  // stock wake words (the .tflite files under wakewords/stock/) are not
  // listed here — they're
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
  // Alarm chime — applies to every voice device paired to this user.
  // The firmware ships with a built-in procedural two-tone chime; uploading
  // a custom MP3 (any reasonable length, server normalizes to mono 16k)
  // replaces it on all paired devices.
  const chimeStatus = _chimeInfo.hasCustom
    ? `Custom chime <span style="color:var(--muted)">· ${(_chimeInfo.sizeBytes / 1024).toFixed(1)} KB</span>`
    : `<span style="color:var(--muted)">Built-in chime (two-tone alert)</span>`;
  const chimeRevertBtn = _chimeInfo.hasCustom
    ? `<button class="cdraw-btn" data-action="revertChime" style="font-size:11px;padding:3px 7px" title="Revert to the built-in procedural chime">Reset to default</button>`
    : '';
  const chimeHtml = `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Alarm chime</div>
        <div style="display:flex;gap:6px;align-items:center">
          ${chimeRevertBtn}
          <button class="cdraw-btn cdraw-btn-primary" data-action="openChimeUpload" style="font-size:11px;padding:4px 10px" title="Upload an MP3 to use as the alarm chime on every paired voice device">${_chimeInfo.hasCustom ? 'Replace' : '+ Upload chime'}</button>
        </div>
      </div>
      <div style="font-size:12px">${chimeStatus}</div>
    </div>
  `;

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

  // Voice references — uploaded WAV clips used by Pocket TTS for zero-shot
  // cloning. Only shown when ttsProvider='pocket-tts'. Per-slot voice picker
  // (further down) selects which reference each wake phrase uses.
  const REFS_CAP = 10;
  const refsHtml = (_ttsProvider === 'pocket-tts') ? `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">
          Voice references
          <span style="text-transform:none;letter-spacing:0;margin-left:6px;opacity:.7">${_voiceRefs.length} / ${REFS_CAP}</span>
        </div>
        <button class="cdraw-btn cdraw-btn-primary" data-action="openVoiceRefUpload" style="font-size:11px;padding:4px 10px${_voiceRefs.length >= REFS_CAP ? ';opacity:.4;pointer-events:none' : ''}" title="${_voiceRefs.length >= REFS_CAP ? 'Library full — delete one first' : 'Upload a clean ~15-20s WAV to clone that voice'}">+ Upload voice</button>
      </div>
      ${_voiceRefs.length ? _voiceRefs.map(r => {
        const dur = r.duration_s ? r.duration_s.toFixed(1) + 's' : '—';
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
            <span style="flex:1"><strong>${escHtml(r.label)}</strong> <span style="color:var(--muted)">${dur}${r.transcript ? ' · "' + escHtml(r.transcript.slice(0, 60)) + (r.transcript.length > 60 ? '…' : '') + '"' : ''}</span></span>
            <button class="cdraw-btn" data-action="deleteVoiceRef" data-args='${JSON.stringify([r.id]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 7px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)" title="Delete">Delete</button>
          </div>
        `;
      }).join('') : '<div style="font-size:11px;color:var(--muted);padding:4px 0">No voice references uploaded. Click <strong>+ Upload voice</strong> to clone a voice from a short clip.</div>'}
    </div>
  ` : '';

  // "Shared with you" — wake-slots on other users' devices pointing at me.
  // Rendered above the paired-device list (or above the empty state) so the
  // section is visible even for users who don't own any device themselves.
  const SLOT_PHRASES = ['Hey Ensemble', 'Computer'];
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
    // Routines + ambient library are PER-USER (users/<id>/routines.json,
    // users/<id>/ambient/*.mp3) and fire when the user says their wake word on
    // ANY device — including a slot SHARED to them on someone else's device. A
    // user who owns no device but has an incoming slot (e.g. a household member) still needs
    // them, so render those panels here too instead of bailing to a bare empty
    // state. (voiceConfigPanel is intentionally omitted — slot routing is owned
    // by whoever owns the physical device.)
    const sharedPanels = _incomingSlots.length
      ? renderRoutinesPanel() + renderAmbientLibraryPanel()
      : '';
    body.innerHTML = header + chimeHtml + libraryHtml + refsHtml + incomingHtml + `
      <div class="cdraw-empty" style="padding:30px 18px;text-align:center;font-size:13px;color:var(--muted);line-height:1.55">
        <div style="font-size:32px;margin-bottom:10px;opacity:.4">🎙️</div>
        ${_incomingSlots.length
          ? `You don't own any voice devices, but you can speak to other users' devices using the wake words above.`
          : `No voice devices paired yet.<br>Click <strong>+ Pair new device</strong> above to begin.`}
      </div>
    ` + sharedPanels;
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
    const degraded = d.online && (d.health?.micDead || d.health?.rebootStorm);
    const dot = degraded
      ? '<span title="Degraded" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e05c5c;margin-right:6px;vertical-align:middle"></span>'
      : d.online
      ? '<span title="Online" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#3cc36f;margin-right:6px;vertical-align:middle"></span>'
      : '<span title="Offline" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e0a030;margin-right:6px;vertical-align:middle"></span>';
    const status = degraded
      ? '<span style="color:#e05c5c;font-weight:600">Degraded</span>'
      : d.online
      ? '<span style="color:#3cc36f;font-weight:600">Online</span>'
      : `<span style="color:#e0a030;font-weight:600">Offline</span> · last seen ${escHtml(lastSeen)}`;
    // Firmware row: current version + an Update button when an upgrade is
    // available and the device is online. _firmwareManifest is the cached
    // /firmware/voice-device/manifest.json fetched on drawer open.
    const manifestVer = _firmwareManifest?.version || null;
    const fwBehind = manifestVer && d.fw_version && versionCmp(manifestVer, d.fw_version) > 0;
    const fwLabel = d.fw_version
      ? `fw ${escHtml(d.fw_version)}` + (manifestVer ? ` (server: ${escHtml(manifestVer)})` : '')
      : 'fw unknown';
    const updateBtn = (fwBehind && d.online)
      ? `<button class="cdraw-btn" data-action="updateDeviceFirmware" data-args='${JSON.stringify([d.id]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:2px 8px;margin-left:6px" title="Download and apply firmware ${escHtml(manifestVer)} over the air">Update</button>`
      : (manifestVer && d.fw_version && !fwBehind ? '<span style="font-size:11px;color:var(--muted);margin-left:6px">up to date</span>' : '');
    const metaBits = [
      `${dot}${status}`,
      d.mute_state ? '<span style="color:var(--red,#e05c5c);font-weight:600">muted</span>' : null,
      d.health?.micDead ? '<span style="color:#e05c5c;font-weight:600" title="Heartbeat reports no microphone capture while the control socket is online">mic stalled</span>' : null,
      d.health?.rebootStorm ? '<span style="color:#e05c5c;font-weight:600" title="Recent boot telemetry indicates repeated restarts">rebooting repeatedly</span>' : null,
      Number.isFinite(d.health?.capSps) ? `<span title="Capture samples per second">mic ${Math.round(d.health.capSps)}/s</span>` : null,
      Number.isFinite(d.health?.rssi)
        ? (d.health.rssi < -75
          ? `<span style="color:#e05c5c;font-weight:600" title="Wi-Fi signal strength (weak)">wifi ${Math.round(d.health.rssi)} dBm</span>`
          : `<span title="Wi-Fi signal strength">wifi ${Math.round(d.health.rssi)} dBm</span>`)
        : null,
      (Number.isFinite(d.health?.pcmDrop) && d.health.pcmDrop > 0)
        ? `<span title="Audio frames dropped from the capture buffer since last heartbeat">drops ${Math.round(d.health.pcmDrop)}</span>`
        : null,
    ].filter(Boolean).join(' · ');
    return `
      <div class="cdraw-row" data-device-row="${escHtml(d.id)}" style="display:block;padding:14px 14px;border-bottom:1px solid var(--border);background:transparent;border-radius:0;margin-bottom:0">
        <div style="position:relative;text-align:center;margin-bottom:4px">
          <input type="text" class="cdraw-input device-name" value="${escHtml(d.name)}" data-change-action="renameDevice" data-change-args='${JSON.stringify([d.id]).replace(/'/g, '&#39;')}' placeholder="(unnamed device)" style="display:inline-block;font-weight:700;font-size:16px;text-align:center;color:#fff;background:transparent;border:1px dashed transparent;padding:4px 10px;border-radius:4px;min-width:60%;max-width:75%" title="Click to rename">
          <button class="cdraw-btn" data-action="playTestMp3" data-args='${JSON.stringify([d.id]).replace(/'/g, '&#39;')}' style="position:absolute;left:0;top:50%;transform:translateY(-50%);font-size:11px;padding:3px 8px" title="Upload a local MP3 and play it on this device (audio-quality test)">▶ Test MP3</button>
          <button class="cdraw-btn" data-action="revokeDevice" data-args='${JSON.stringify([d.id]).replace(/'/g, '&#39;')}' style="position:absolute;right:0;top:50%;transform:translateY(-50%);font-size:11px;padding:3px 8px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)" title="Drop this device and revoke its session token">Revoke</button>
        </div>
        <div style="text-align:center;font-size:11px;color:var(--muted)">${metaBits}</div>
        <div style="text-align:center;font-size:11px;color:var(--muted);margin-top:4px"><span>${fwLabel}</span>${updateBtn}</div>
        <div style="text-align:center;font-size:11px;color:var(--muted);margin-top:6px">
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer" title="For headphones or an external amp on the 3.5mm jack: keeps the internal speaker amp off during playback, so the mic stays at full sensitivity and barge-in works at normal voice. With this off, the on-board speaker plays and the echo canceller suppresses the mic while audio is playing.">
            <input type="checkbox" ${d.headphone_mode ? 'checked' : ''} data-change-action="setDeviceHeadphone" data-change-args='${JSON.stringify([d.id]).replace(/'/g, '&#39;')}'>
            Headphone / line-out mode
          </label>
        </div>
        <div style="text-align:center;font-size:11px;color:var(--muted);margin-top:6px">
          <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer" title="Say the wake word once, then just keep talking: after every reply the device listens for ~8 more seconds, and you can interrupt a reply mid-sentence by speaking over it. End with &quot;stop&quot;, &quot;that's all&quot;, or &quot;goodbye&quot; — or just go quiet. Requires firmware 0.2.65+ (older firmware ignores the setting).">
            <input type="checkbox" ${d.conversation_mode ? 'checked' : ''} data-change-action="setDeviceConversation" data-change-args='${JSON.stringify([d.id]).replace(/'/g, '&#39;')}'>
            Conversation mode
          </label>
        </div>
        ${d.online ? `<div style="text-align:center;margin-top:6px"><button class="cdraw-btn" data-action="enterApMode" data-args='${JSON.stringify([d.id]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 9px" title="Wipe Wi-Fi/pairing and reboot into the setup AP (oe-voice-XXXX) so you can move this device to a different Wi-Fi network">⟳ Reset Wi-Fi</button></div>` : ''}
        <div data-ota-status="${escHtml(d.id)}" style="text-align:center;font-size:11px;color:var(--muted);margin-top:4px;display:none"></div>
      </div>
    `;
  }).join('');

  const routinesPanel = renderRoutinesPanel();
  const ambientPanel = renderAmbientLibraryPanel();
  body.innerHTML = header + chimeHtml + libraryHtml + refsHtml + incomingHtml + voiceConfigPanel + routinesPanel + ambientPanel + rows;
}

// ── Routines panel ──────────────────────────────────────────────────────────
// Trigger-phrase → ordered action list. Mirrors the schema in
// lib/routines.mjs; the server validates on PUT so we don't need exhaustive
// client-side validation. Inline editor expands when a routine is being
// edited (tracked in _editingRoutineId so re-renders don't collapse it).
let _editingRoutineId = null;
let _ambientUploadProgress = null;

function renderRoutinesPanel() {
  const rows = _routines.length
    ? _routines.map(renderRoutineRow).join('')
    : `<div style="font-size:11px;color:var(--muted);padding:8px 0;line-height:1.5">No routines yet. Click <strong>+ New routine</strong> to bind a phrase to an action sequence — e.g. "goodnight" turns off scene.goodnight and plays thunderstorm.mp3.</div>`;
  return `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">
          Voice routines
          <span style="text-transform:none;letter-spacing:0;margin-left:6px;opacity:.7">${_routines.length}</span>
        </div>
        <button class="cdraw-btn cdraw-btn-primary" data-action="addRoutine" style="font-size:11px;padding:4px 10px">+ New routine</button>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px;line-height:1.45">
        Say the trigger phrase after your wake word ("hey ensemble, goodnight") to fire the actions in order.
      </div>
      ${rows}
    </div>
  `;
}

function renderRoutineRow(r) {
  if (_editingRoutineId === r.id) return renderRoutineEditor(r);
  const aliases = r.aliases?.length ? ` <span style="color:var(--muted);font-size:11px">(${r.aliases.map(escHtml).join(', ')})</span>` : '';
  const summary = r.actions.map(summarizeRoutineAction).join(' → ');
  const boundDevice = r.device_id ? _devicesList.find(d => d.id === r.device_id) : null;
  const targetLabel = boundDevice
    ? `<span style="font-size:10px;color:var(--muted);margin-left:6px" title="Target device for play-ambient + tts-say">→ ${escHtml(boundDevice.name || boundDevice.id)}</span>`
    : '';
  return `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-top:1px solid var(--border);font-size:12px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">"${escHtml(r.trigger)}"${aliases}${targetLabel}</div>
        <div style="color:var(--muted);font-size:11px;margin-top:2px;word-break:break-word">${escHtml(summary)}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button class="cdraw-btn" data-action="testRoutine" data-args='${JSON.stringify([r.id]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 7px" title="Fire this routine now on a paired device">Test</button>
        <button class="cdraw-btn" data-action="editRoutine" data-args='${JSON.stringify([r.id]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 7px">Edit</button>
        <button class="cdraw-btn" data-action="deleteRoutine" data-args='${JSON.stringify([r.id]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 7px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)">Delete</button>
      </div>
    </div>
  `;
}

function summarizeRoutineAction(a) {
  switch (a.type) {
    case 'ha_scene': {
      const id = a.scene_id || '?';
      const isPreset = /^(scene|script)\./.test(id);
      const verbLabel = isPreset ? 'activate' :
        a.verb === 'turn_off' ? 'turn off' :
        a.verb === 'toggle'   ? 'toggle'    :
        'turn on';
      return `${verbLabel} ${id}`;
    }
    case 'ha_call':      return `${a.domain || '?'}.${a.service || '?'}${a.data?.entity_id ? ` (${a.data.entity_id})` : ''}`;
    case 'play_ambient': return `play ${a.file || '?'}${a.loop !== false ? ' on loop' : ''}${Number.isFinite(a.volume) ? ` @ ${a.volume}%` : ''}`;
    case 'tts_say':      return `say "${a.text || ''}"`;
    case 'run_prompt': {
      const p = (a.prompt || '').trim();
      const short = p.length > 60 ? p.slice(0, 57) + '…' : p;
      return `ask ${_coordinatorLabel()}: "${short || '?'}"`;
    }
    default:             return a.type || '?';
  }
}

function renderRoutineEditor(r) {
  // "_new" is the synthetic id used to flag an in-progress create. Don't
  // surface it in the id input — leave the field empty so the user types
  // their own slug. After save, the editor switches to readonly with the
  // user's chosen id, so this branch only fires while authoring.
  const isNew = !r.id || r.id === '_new';
  const displayId = isNew ? '' : r.id;
  const ambientOpts = _ambientFiles.map(f => `<option value="${escHtml(f.name)}">${escHtml(f.name)}</option>`).join('');
  const actionsHtml = (r.actions || []).map((a, i) => renderActionEditor(a, i, ambientOpts)).join('');
  // Target-device dropdown: "(originating device)" plus every paired device.
  // For voice-triggered routines, the originating device is the one that
  // heard the trigger; for webhook fires there's no originator so the user
  // MUST pick a target if the routine has play_ambient/tts_say actions.
  const deviceOpts = ['<option value="">(device that heard the trigger)</option>']
    .concat(_devicesList.map(d =>
      `<option value="${escHtml(d.id)}" ${r.device_id === d.id ? 'selected' : ''}>${escHtml(d.name || d.id)}</option>`
    )).join('');
  // Webhook URL panel — only after first save, when the server has stamped a
  // token onto the routine. Uses window.location.origin so it works through
  // tunnels / mylan / whatever the user actually exposes externally.
  const webhookHtml = (r.webhook_token && !isNew)
    ? `
      <div style="margin-top:8px;padding:8px;border:1px dashed var(--border);border-radius:4px;background:var(--bg2)">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Webhook URL</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px;line-height:1.45">POST to this URL to fire the routine — works from iPhone NFC tag scans (Shortcuts app → "Get contents of URL"), or any HTTP client. Anyone with the URL can fire it, so don't share it widely.</div>
        <div style="display:flex;gap:6px;align-items:stretch">
          <input type="text" class="cdraw-input" data-routine-webhook-url value="${escHtml(window.location.origin + '/api/routines/webhook/' + r.webhook_token)}" readonly style="flex:1;min-width:0;font-family:monospace;font-size:11px;padding:4px 6px;opacity:.85">
          <button class="cdraw-btn" data-action="copyRoutineWebhook" data-args='${JSON.stringify([r.id]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:4px 8px" title="Copy URL to clipboard">Copy</button>
          <button class="cdraw-btn" data-action="regenRoutineWebhook" data-args='${JSON.stringify([r.id]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:4px 8px" title="Issue a fresh token (revokes the old URL)">Regen</button>
        </div>
      </div>
    `
    : (isNew ? '<div style="font-size:11px;color:var(--muted);margin-top:6px">Webhook URL will appear here after you save.</div>' : '');
  return `
    <div data-routine-editor="${escHtml(r.id || '_new')}" style="padding:10px;margin:8px 0;border:1px solid var(--accent,#5da0ff);border-radius:6px;background:var(--bg)">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;margin-bottom:8px">
        <label style="font-size:11px;color:var(--muted)" title="Short slug for this routine — lowercase letters/digits/underscores/dashes only. Not the phrase you say.">ID</label>
        <input type="text" class="cdraw-input" data-routine-field="id" value="${escHtml(displayId)}" placeholder="goodnight (slug — no spaces)" ${isNew ? '' : 'readonly'} data-keydown-action="blockRoutineIdSpace" data-keydown-args='["$key"]' style="font-family:monospace;font-size:12px;padding:4px 6px${isNew ? '' : ';opacity:.6'}" title="Slug — lowercase letters/digits/underscores/dashes only. The trigger phrase goes below.">
        <label style="font-size:11px;color:var(--muted)" title="The actual phrase you'll say to fire this routine — spaces allowed.">Trigger</label>
        <input type="text" class="cdraw-input" data-routine-field="trigger" value="${escHtml(r.trigger || '')}" placeholder="good night" style="font-size:12px;padding:4px 6px">
        <label style="font-size:11px;color:var(--muted)">Aliases</label>
        <input type="text" class="cdraw-input" data-routine-field="aliases" value="${escHtml((r.aliases || []).join(', '))}" placeholder="good night, time for bed" style="font-size:12px;padding:4px 6px" title="Comma-separated alternative phrasings">
        <label style="font-size:11px;color:var(--muted)" title="Where play-ambient + tts-say actions go. Leave on (originating device) to follow the device that heard the trigger.">Target</label>
        <select class="cdraw-input" data-routine-field="device_id" style="font-size:12px;padding:4px 6px">${deviceOpts}</select>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Actions</div>
        <select class="cdraw-input" data-change-action="addRoutineAction" data-change-args='["$value"]' style="font-size:11px;padding:3px 6px">
          <option value="">+ Add action…</option>
          <option value="ha_scene">HA scene</option>
          <option value="ha_call">HA service call</option>
          <option value="play_ambient">Play ambient sound</option>
          <option value="tts_say">Speak text</option>
          <option value="run_prompt">Ask ${_coordinatorLabel()} (run a prompt)</option>
        </select>
      </div>
      <div data-routine-actions>${actionsHtml || '<div style="font-size:11px;color:var(--muted);padding:4px 0">No actions yet. Pick one above.</div>'}</div>
      ${webhookHtml}
      <div style="display:flex;gap:6px;margin-top:10px;justify-content:flex-end">
        <button class="cdraw-btn" data-action="cancelRoutineEdit" style="font-size:11px;padding:4px 10px">Cancel</button>
        <button class="cdraw-btn cdraw-btn-primary" data-action="saveRoutineEdit" style="font-size:11px;padding:4px 10px">Save routine</button>
      </div>
    </div>
  `;
}

function renderActionEditor(a, idx, ambientOpts) {
  const headerRow = `
    <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">
      <span>${idx + 1}. ${escHtml(a.type)}</span>
      <div style="display:flex;gap:4px">
        ${idx > 0 ? `<button class="cdraw-btn" data-action="moveRoutineAction" data-args='${JSON.stringify([idx, -1]).replace(/'/g, '&#39;')}' style="font-size:10px;padding:1px 6px" title="Move up">↑</button>` : ''}
        <button class="cdraw-btn" data-action="moveRoutineAction" data-args='${JSON.stringify([idx, 1]).replace(/'/g, '&#39;')}' style="font-size:10px;padding:1px 6px" title="Move down">↓</button>
        <button class="cdraw-btn" data-action="removeRoutineAction" data-args='${JSON.stringify([idx]).replace(/'/g, '&#39;')}' style="font-size:10px;padding:1px 6px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)">✕</button>
      </div>
    </div>
  `;
  let body = '';
  if (a.type === 'ha_scene') {
    // Dropdown pulled from the HA entity cache (scenes + scripts + groups).
    // If the saved entity_id isn't in the cache (HA offline, fresh entity
    // not refreshed), prepend it so the value isn't lost on next save.
    // Grouped by entity type so the long list stays scannable.
    const cur = a.scene_id || '';
    const grouped = { scene: [], script: [], group: [], other: [] };
    for (const e of _haSceneEntities) {
      const bucket = grouped[e.domain] ? e.domain : 'other';
      grouped[bucket].push(e);
    }
    const optgroup = (label, list) => list.length
      ? `<optgroup label="${escHtml(label)}">${list.map(e => {
          const lbl = e.friendly_name && e.friendly_name !== e.entity_id
            ? `${e.friendly_name} (${e.entity_id})`
            : e.entity_id;
          return `<option value="${escHtml(e.entity_id)}" ${e.entity_id === cur ? 'selected' : ''}>${escHtml(lbl)}</option>`;
        }).join('')}</optgroup>`
      : '';
    const hasCur = !cur || _haSceneEntities.some(e => e.entity_id === cur);
    const opts = ['<option value="">Pick a scene, script, or group…</option>']
      .concat(hasCur ? [] : [`<option value="${escHtml(cur)}" selected>${escHtml(cur)} (not in cache)</option>`])
      .concat(optgroup('Scenes',  grouped.scene),
              optgroup('Scripts', grouped.script),
              optgroup('Groups',  grouped.group),
              optgroup('Other',   grouped.other))
      .join('');
    // Verb picker — meaningful for groups (and any other domain), ignored
    // server-side for scene/script (always turn_on). Default 'turn_off'
    // for groups since routines almost always turn things off; toggleable.
    const isPresetType = /^(scene|script)\./.test(cur);
    const verb = a.verb || (isPresetType ? 'turn_on' : 'turn_off');
    const verbPicker = isPresetType
      ? `<input type="hidden" data-action-field="${idx}.verb" value="turn_on">`
      : `<select class="cdraw-input" data-action-field="${idx}.verb" style="font-size:12px;padding:4px 6px;margin-top:4px">
          <option value="turn_off" ${verb === 'turn_off' ? 'selected' : ''}>Turn off</option>
          <option value="turn_on"  ${verb === 'turn_on'  ? 'selected' : ''}>Turn on</option>
          <option value="toggle"   ${verb === 'toggle'   ? 'selected' : ''}>Toggle</option>
        </select>`;
    const emptyHint = _haSceneEntities.length === 0
      ? '<div style="font-size:10px;color:var(--amber,#d49a44);margin-top:4px">No HA scenes/scripts/groups found. Check the Home Assistant integration is configured + reachable, or wait up to 5 min for the cache to refresh.</div>'
      : '';
    body = `<div style="display:flex;gap:4px;align-items:stretch">
        <select class="cdraw-input" data-action-field="${idx}.scene_id" style="flex:1;min-width:0;font-family:monospace;font-size:12px;padding:4px 6px">${opts}</select>
        <button class="cdraw-btn" data-action="refreshHaEntities" title="Re-fetch scenes/scripts/groups from Home Assistant (skips the 5-min cache)" style="font-size:11px;padding:4px 8px">↻</button>
      </div>${verbPicker}${emptyHint}`;
  } else if (a.type === 'ha_call') {
    // Cascading dropdowns sourced from the live HA service catalog + entity
    // cache so users pick instead of guessing strings. Saved values that
    // aren't in the catalog (HA offline, integration removed, etc.) are
    // preserved as a "(saved value)" option so a stale edit doesn't silently
    // drop the routine on next save.
    const curDomain  = (a.domain || '').toLowerCase();
    const curService = (a.service || '').toLowerCase();
    const data = (a.data && typeof a.data === 'object') ? a.data : {};
    const curEntityId = typeof data.entity_id === 'string' ? data.entity_id : '';
    // Extra-params JSON shows everything except entity_id — that's the
    // picker's job. Keeps the JSON box scoped to the actual "advanced" stuff
    // (brightness, color, target, etc.).
    const extraParams = { ...data };
    delete extraParams.entity_id;
    const extraStr = Object.keys(extraParams).length ? JSON.stringify(extraParams) : '';

    const allDomains = Object.keys(_haServiceCatalog).sort();
    const hasCurDomain = !curDomain || allDomains.includes(curDomain);
    const domainOpts = ['<option value="">Pick a domain…</option>']
      .concat(hasCurDomain ? [] : [`<option value="${escHtml(curDomain)}" selected>${escHtml(curDomain)} (not in catalog)</option>`])
      .concat(allDomains.map(d => `<option value="${escHtml(d)}" ${d === curDomain ? 'selected' : ''}>${escHtml(d)}</option>`))
      .join('');

    const serviceList = (_haServiceCatalog[curDomain] || []);
    const hasCurService = !curService || serviceList.includes(curService);
    const serviceOpts = curDomain
      ? ['<option value="">Pick a service…</option>']
          .concat(hasCurService ? [] : [`<option value="${escHtml(curService)}" selected>${escHtml(curService)} (not in catalog)</option>`])
          .concat(serviceList.map(s => `<option value="${escHtml(s)}" ${s === curService ? 'selected' : ''}>${escHtml(s)}</option>`))
          .join('')
      : '<option value="">Pick a domain first</option>';

    // Entity picker is per-domain. For domains we don't cache entities for
    // (notify, button, etc.) the picker collapses to "(no entities cached)"
    // and the user can still put entity_id in Extra params if their service
    // needs one.
    const matchEntities = curDomain
      ? _haActionEntities.filter(e => e.domain === curDomain || (curDomain !== 'group' && e.entity_id.split('.', 1)[0] === curDomain))
      : [];
    const hasCurEntity = !curEntityId || matchEntities.some(e => e.entity_id === curEntityId);
    const entityOpts = curDomain
      ? ['<option value="">— No entity (or specify in Extra params) —</option>']
          .concat(hasCurEntity ? [] : [`<option value="${escHtml(curEntityId)}" selected>${escHtml(curEntityId)} (not in cache)</option>`])
          .concat(matchEntities
            .slice()
            .sort((x, y) => (x.friendly_name || x.entity_id).localeCompare(y.friendly_name || y.entity_id))
            .map(e => {
              const lbl = e.friendly_name && e.friendly_name !== e.entity_id ? `${e.friendly_name} (${e.entity_id})` : e.entity_id;
              return `<option value="${escHtml(e.entity_id)}" ${e.entity_id === curEntityId ? 'selected' : ''}>${escHtml(lbl)}</option>`;
            }))
          .join('')
      : '<option value="">Pick a domain first</option>';

    const emptyHint = allDomains.length === 0
      ? '<div style="font-size:10px;color:var(--amber,#d49a44);margin-top:4px">No HA services loaded. Check the Home Assistant integration is configured + reachable, or hit ↻ to refresh.</div>'
      : '';

    body = `
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:6px;align-items:stretch">
        <select class="cdraw-input" data-action-field="${idx}.domain" data-change-action="changeHaCallDomain" data-change-args='[${idx},"$value"]' style="font-family:monospace;font-size:12px;padding:4px 6px;min-width:0">${domainOpts}</select>
        <select class="cdraw-input" data-action-field="${idx}.service" style="font-family:monospace;font-size:12px;padding:4px 6px;min-width:0">${serviceOpts}</select>
        <button class="cdraw-btn" data-action="refreshHaEntities" title="Re-fetch service catalog + entities from Home Assistant (skips the 5-min cache)" style="font-size:11px;padding:4px 8px">↻</button>
      </div>
      <select class="cdraw-input" data-action-field="${idx}.entity_id" style="width:100%;font-family:monospace;font-size:12px;padding:4px 6px;margin-top:4px" title="Entity this service call targets — auto-merged into the data payload as entity_id.">${entityOpts}</select>
      <input type="text" class="cdraw-input" data-action-field="${idx}.data" value="${escHtml(extraStr)}" placeholder='Extra params (optional, e.g. {"brightness":200})' style="width:100%;font-family:monospace;font-size:11px;padding:4px 6px;margin-top:4px" title="Extra fields beyond entity_id (brightness, color, etc.) as a JSON object.">
      ${emptyHint}
    `;
  } else if (a.type === 'play_ambient') {
    // If a.file points at something no longer in the library, prepend a
    // "(missing)" option so the value sticks instead of silently resetting
    // to "" — that would make the action fail cleanAction on the next save
    // and drop the whole routine.
    const cur = a.file || '';
    const hasCur = !cur || _ambientFiles.some(f => f.name === cur);
    const missingOpt = hasCur ? '' : `<option value="${escHtml(cur)}" selected>${escHtml(cur)} (missing — upload or re-pick)</option>`;
    body = `
      <div style="display:grid;grid-template-columns:minmax(0,2fr) 1fr 1fr;gap:6px;align-items:center">
        <select class="cdraw-input" data-action-field="${idx}.file" style="font-size:12px;padding:4px 6px;min-width:0;max-width:100%" title="${escHtml(cur || '(no sound picked)')}">
          <option value="">Pick a sound…</option>
          ${missingOpt}
          ${ambientOpts.replace(`value="${escHtml(a.file || '')}"`, `value="${escHtml(a.file || '')}" selected`)}
        </select>
        <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" data-action-field="${idx}.loop" ${a.loop !== false ? 'checked' : ''}> Loop</label>
        <label style="font-size:11px;display:flex;align-items:center;gap:4px">Vol <input type="number" class="cdraw-input" data-action-field="${idx}.volume" value="${a.volume ?? ''}" min="0" max="100" placeholder="—" style="width:50px;font-size:12px;padding:2px 4px"></label>
      </div>
      ${_ambientFiles.length ? '' : '<div style="font-size:10px;color:var(--amber,#d49a44);margin-top:4px">Library is empty — upload an MP3 in the Ambient library section below.</div>'}
    `;
  } else if (a.type === 'tts_say') {
    body = `<input type="text" class="cdraw-input" data-action-field="${idx}.text" value="${escHtml(a.text || '')}" placeholder="Sleep well." style="width:100%;font-size:12px;padding:4px 6px">`;
  } else if (a.type === 'run_prompt') {
    // Free-form prompt sent to the user's coordinator agent. The reply
    // streams to TTS on the device that fired the routine, so any tools
    // (news, weather, web search) just work.
    body = `<textarea class="cdraw-input" data-action-field="${idx}.prompt" rows="2" placeholder="give me the latest news" style="width:100%;font-size:12px;padding:4px 6px;font-family:inherit;resize:vertical">${escHtml(a.prompt || '')}</textarea>
      <div style="font-size:10px;color:var(--muted);margin-top:4px">Runs after the other actions in this routine. The reply is spoken on the device that fired the trigger.</div>`;
  } else {
    body = `<div style="font-size:11px;color:var(--red,#e05c5c)">Unknown action type: ${escHtml(a.type)}</div>`;
  }
  return `<div style="padding:6px;margin:4px 0;border:1px solid var(--border);border-radius:4px;background:var(--bg2)">${headerRow}<div style="margin-top:4px">${body}</div></div>`;
}

// ── Ambient library panel ────────────────────────────────────────────────────

function renderAmbientLibraryPanel() {
  const rows = _ambientFiles.length
    ? _ambientFiles.map(renderAmbientFileRow).join('')
    : `<div style="font-size:11px;color:var(--muted);padding:4px 0">No ambient sounds uploaded yet. Drop an MP3 below or click <strong>+ Upload sound</strong>.</div>`;
  const dragHint = _ambientUploadProgress
    ? `<div style="font-size:11px;color:var(--muted);margin-top:6px">Uploading ${escHtml(_ambientUploadProgress.name)}… ${_ambientUploadProgress.pct}%</div>`
    : '';
  return `
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg2)" data-ambient-drop>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">
          Ambient library
          <span style="text-transform:none;letter-spacing:0;margin-left:6px;opacity:.7">${_ambientFiles.length}</span>
        </div>
        <button class="cdraw-btn cdraw-btn-primary" data-action="uploadAmbient" style="font-size:11px;padding:4px 10px">+ Upload sound</button>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-bottom:6px;line-height:1.45">
        MP3s available to the <em>play ambient</em> action. Click <strong>+ Upload sound</strong> to add one (max 40&nbsp;MB).
      </div>
      ${rows}
      ${dragHint}
    </div>
  `;
}

function renderAmbientFileRow(f) {
  const sizeKb = (f.size / 1024).toFixed(1) + ' KB';
  const dur = f.duration_s
    ? (() => { const m = Math.floor(f.duration_s / 60); const s = Math.floor(f.duration_s % 60); return `${m}:${String(s).padStart(2, '0')}`; })()
    : '—';
  const isPlaying = window._ambientPreviewName === f.name;
  const playBtn = isPlaying
    ? `<button class="cdraw-btn" data-action="previewAmbient" data-args='${JSON.stringify([f.name]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 7px;color:var(--accent,#5da0ff);border-color:var(--accent,#5da0ff)" title="Stop preview">■</button>`
    : `<button class="cdraw-btn" data-action="previewAmbient" data-args='${JSON.stringify([f.name]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 7px" title="Preview in browser">▶</button>`;
  return `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px">
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><strong>${escHtml(f.name)}</strong> <span style="color:var(--muted)">${sizeKb} · ${dur}</span></span>
      ${playBtn}
      <button class="cdraw-btn" data-action="deleteAmbient" data-args='${JSON.stringify([f.name]).replace(/'/g, '&#39;')}' style="font-size:11px;padding:3px 7px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)">Delete</button>
    </div>
  `;
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
    // Pre-multivoice this filter dropped any non-numeric ttsVoice when
    // provider=piper, on the theory that only libritts_r speaker-ids were
    // valid. Post-multivoice, ttsVoice can be "<voice-id>" or
    // "<voice-id>:<speaker_id>" — the Piper render branch handles all three
    // shapes (bare number, voice id, voice:speaker). Trust the saved value
    // and let unrecognized values render as no-selection.
    const rawVoice = a?.ttsVoice || '';
    const curVoice = rawVoice;
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
           <select class="cdraw-input" data-change-action="setSlotVoice" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}' style="flex:1;min-width:0;padding:4px 6px;font-size:12px">${elOpts}</select>
         </span>`;
    } else if (_ttsProvider === 'pocket-tts') {
      // "(OE Default)" = empty value → server uses the bundled default voice-state.
      // Then the user's cloned voices.
      const refOpts = ['<option value="">(OE Default)</option>']
        .concat(_voiceRefs
          .map(r => `<option value="${escHtml(r.id)}" ${r.id === curVoice ? 'selected' : ''}>${escHtml(r.label)}</option>`))
        .join('');
      voiceControl = `<select class="cdraw-input" data-change-action="setSlotVoice" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}' style="padding:4px 6px;font-size:12px;min-width:0">${refOpts}</select>`;
    } else if (_ttsProvider === 'kittentts') {
      // KittenTTS exposes 8 preset voices (expr-voice-{2,3,4,5}-{m,f}). No
      // cloning, no numeric speaker ids — just a fixed dropdown.
      const ktOpts = ['<option value="">(device default)</option>']
        .concat(_kittenttsVoices.map(v => `<option value="${escHtml(v)}" ${v === curVoice ? 'selected' : ''}>${escHtml(v)}</option>`))
        .join('');
      voiceControl = `<select class="cdraw-input" data-change-action="setSlotVoice" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}' style="padding:4px 6px;font-size:12px;min-width:0">${ktOpts}</select>`;
    } else if (_ttsProvider === 'piper') {
      // Voice picker now lists installed voices (from /api/tts/piper/voices).
      // Multi-speaker voices (libritts_r) expose a secondary speaker_id field.
      // Stored format: "voice-id" or "voice-id:speaker_id". Legacy bare-numeric
      // values from before the multivoice migration are auto-mapped to
      // en_US-libritts_r-medium:<num> at render time.
      let voiceId = '', speakerId = '';
      if (curVoice) {
        if (/^\d+$/.test(curVoice)) {
          voiceId = 'en_US-libritts_r-medium';
          speakerId = curVoice;
        } else if (curVoice.includes(':')) {
          [voiceId, speakerId] = curVoice.split(':');
        } else {
          voiceId = curVoice;
        }
      }
      const selectedMeta = _piperVoices.find(v => v.id === voiceId);
      const isMulti = !!selectedMeta?.multi_speaker;
      const maxSpk = Math.max((selectedMeta?.num_speakers ?? 1) - 1, 0);
      const slotArgs = JSON.stringify([slotIdx]).replace(/'/g, '&#39;');
      const voiceOpts = ['<option value="">(device default)</option>']
        .concat(_piperVoices.map(v => `<option value="${escHtml(v.id)}" ${v.id === voiceId ? 'selected' : ''}>${escHtml(v.label || v.id)}</option>`))
        .join('');
      const noVoicesHint = _piperVoices.length === 0
        ? '<div style="font-size:10px;color:var(--muted)">No voices installed — Settings → Providers → Piper to download.</div>'
        : '';
      const speakerInput = isMulti
        ? `<input type="number" class="cdraw-input piper-speaker-input" min="0" max="${maxSpk}" step="1"
              placeholder="speaker 0-${maxSpk}" value="${escHtml(speakerId)}"
              data-change-action="setSlotPiperVoice" data-args='${slotArgs}'
              style="padding:4px 6px;font-size:12px;min-width:0">`
        : '';
      const previewBtn = voiceId
        ? `<button type="button" class="cdraw-btn"
              data-action="previewSlotVoice" data-args='${slotArgs}'
              title="Preview this voice in your browser"
              style="font-size:11px;padding:3px 8px;flex:0 0 auto">Preview</button>`
        : '';
      voiceControl = `
        <div class="piper-slot-controls" data-slot="${slotIdx}" style="display:flex;flex-direction:column;gap:4px;min-width:0">
          <div style="display:flex;gap:4px;align-items:center;min-width:0">
            <select class="cdraw-input piper-voice-select" data-change-action="setSlotPiperVoice" data-args='${slotArgs}' style="flex:1;min-width:0;padding:4px 6px;font-size:12px">${voiceOpts}</select>
            ${previewBtn}
          </div>
          ${speakerInput}
          ${noVoicesHint}
        </div>`;
    } else {
      voiceControl = `<select class="cdraw-input" data-change-action="setSlotVoice" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}' style="padding:4px 6px;font-size:12px;min-width:0">${['<option value="">(device default)</option>'].concat(OPENAI_TTS_VOICES.map(v => `<option value="${v}" ${v === curVoice ? 'selected' : ''}>${v}</option>`)).join('')}</select>`;
    }
    const curWw = a?.wakewordId || '';
    const wwOpts = ['<option value="">(no wake word — pick one)</option>']
      .concat(_wakewordLibrary.map(w => `<option value="${escHtml(w.id)}" ${w.id === curWw ? 'selected' : ''}>${escHtml(w.wake_word || w.id)}</option>`))
      .join('');
    const wwEntry = curWw ? _wakewordLibrary.find(w => w.id === curWw) : null;
    const defaultCutoff = wwEntry?.probability_cutoff;
    const effectiveCutoff = (typeof a?.probability_cutoff === 'number')
      ? a.probability_cutoff
      : defaultCutoff;
    const avgCutoffVal = typeof a?.avg_prob_cutoff === 'number' ? a.avg_prob_cutoff : '';
    const probInput = curWw && typeof effectiveCutoff === 'number'
      ? `
            <label style="font-size:11px;color:var(--muted)">Cutoff</label>
            <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
              <input type="number" class="cdraw-input" min="0.5" max="0.99" step="0.01"
                value="${effectiveCutoff}"
                data-change-action="setSlotProbability"
                data-change-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}'
                style="padding:4px 6px;font-size:12px;width:80px"
                title="Wake-word probability cutoff (0.5–0.99). Lower = fires more easily. Saved on change — click Push to send to the device.">
              <span style="font-size:10px;color:var(--muted);line-height:1.3">Lowering can cause more false positives.</span>
            </div>
            <label style="font-size:11px;color:var(--muted)">Avg cutoff</label>
            <div style="display:flex;flex-direction:column;gap:3px;min-width:0">
              <div style="display:flex;gap:6px;align-items:center">
                <input type="number" class="cdraw-input" min="0" max="0.99" step="0.01"
                  value="${avgCutoffVal}"
                  placeholder="off"
                  data-change-action="setSlotAvgProbability"
                  data-change-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}'
                  style="padding:4px 6px;font-size:12px;width:80px"
                  title="Server-side gate on the firmware's rolling-window avg probability. Filters cross-fires that spike one frame then dip (e.g. TTS playback). Set 0 or leave blank to disable (shows as off).">
                <button class="cdraw-btn" data-action="pushVoiceConfig"
                  style="font-size:11px;padding:3px 8px"
                  title="Save these settings and push them (wake word, voice, cutoffs) to your paired device(s)">Save &amp; Push</button>
              </div>
              <span style="font-size:10px;color:var(--muted);line-height:1.3">Server-only — drops marginal wakes whose avg dips below this.</span>
            </div>`
      : '';
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
            <select class="cdraw-input" data-change-action="setSlotWakeword" data-args='${JSON.stringify([slotIdx]).replace(/'/g, '&#39;')}' style="padding:4px 6px;font-size:12px;min-width:0" title="Wake word that fires this slot — pushed OTA to every device">${wwOpts}</select>
            ${probInput}
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
    addControl = `<select class="cdraw-input" data-change-action="addSlotUser" style="padding:4px 8px;font-size:12px;min-width:0">${opts}</select>`;
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

// Voice-device firmware OTA: nudge the device to check the bundled manifest.
// Server fans ota_progress events back to this browser tab over WS; the
// _handleOtaProgress receiver below updates the per-device status row.
window.updateDeviceFirmware = async function (id) {
  const row = document.querySelector(`[data-ota-status="${CSS.escape(id)}"]`);
  if (row) { row.style.display = 'block'; row.textContent = 'Requesting update…'; }
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(id)}/ota`, { method: 'POST' });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${txt}`);
    }
  } catch (e) {
    if (row) row.textContent = `Update failed to start: ${e.message}`;
    showDeviceToast(`OTA nudge failed: ${e.message}`, { variant: 'error' });
  }
};

// WS dispatch lands here (see public/websocket.js 'ota_progress' case).
// Updates the per-device status row in place; refetches the device list
// when the device reboots so fw_version flips to the new value.
window._handleOtaProgress = function (msg) {
  const row = document.querySelector(`[data-ota-status="${CSS.escape(msg.device_id || '')}"]`);
  if (!row) return;
  row.style.display = 'block';
  switch (msg.phase) {
    case 'checking':    row.textContent = 'Checking for updates…'; break;
    case 'up_to_date':  row.textContent = `Already on ${msg.target_version || 'current'} — nothing to do.`; break;
    case 'downloading': {
      if (msg.total > 0) {
        const pct = Math.round((msg.bytes_done / msg.total) * 100);
        row.textContent = `Downloading ${msg.target_version || ''} — ${pct}%`;
      } else {
        row.textContent = `Downloading ${msg.target_version || ''}…`;
      }
      break;
    }
    case 'applying':  row.textContent = 'Writing flash…'; break;
    case 'rebooting': row.textContent = `Rebooting into ${msg.target_version || 'new firmware'}…`; setTimeout(loadDevices, 8000); break;
    case 'error':     row.textContent = `Update failed: ${msg.err || 'unknown error'}`; break;
    default:          row.textContent = msg.phase || '';
  }
};

// Tell an online device to wipe its Wi-Fi/pairing and reboot into the captive
// portal AP so it can be moved to a different network. Destructive (the device
// goes offline + must be re-provisioned and re-paired), so confirm first.
window.enterApMode = async function (id) {
  if (!confirm('Reset this device\'s Wi-Fi?\n\nIt will reboot into its setup AP (oe-voice-XXXX) and be REMOVED from OpenEnsemble. To use it again, join its "oe-voice-…" Wi-Fi, enter the new network, and re-pair it. Wake words on the device are kept.')) return;
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(id)}/enter-ap`, { method: 'POST' });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(r.status === 409 ? 'device is offline' : `HTTP ${r.status} ${txt}`);
    }
    showDeviceToast('Device is resetting into setup mode and has been removed — re-pair it after joining its "oe-voice-…" Wi-Fi.');
    setTimeout(loadDevices, 1200); // it's already removed server-side; refresh the drawer
  } catch (e) {
    showDeviceToast(`Reset Wi-Fi failed: ${e.message}`, { variant: 'error' });
  }
};

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
    // Save only — no push here (decoupled). Stay silent on success: saves fire
    // on every field change, and a toast per keystroke is noise. The Push
    // button is where the user gets explicit "reached the device" feedback.
  } catch (e) {
    showDeviceToast(`Save failed: ${e.message}`, { variant: 'error' });
  }
}

// Re-pack slot assignments into contiguous indices 0..N-1, preserving their
// current slot order. The firmware loads wake words by slot index, so a
// device's slots ARE the user list in order: removing a middle user must
// shift everyone after them down a slot, not leave a hole. Without this,
// deleting "test" (slot 1) from [alex:0, test:1, jordan:2] would strand
// jordan at slot 2 with an empty slot 1; with it, jordan moves to slot 1 and
// the now-unassigned slot 2 gets cleared off the device by the push pass.
// Returns a fresh assignments object (does not mutate the input).
function repackSlotAssignments(assignments) {
  const ordered = Object.keys(assignments || {})
    .map(Number)
    .filter(n => Number.isInteger(n) && (assignments[n] ?? assignments[String(n)])?.ownerUserId)
    .sort((a, b) => a - b);
  const packed = {};
  ordered.forEach((oldSlot, i) => {
    packed[i] = assignments[oldSlot] ?? assignments[String(oldSlot)];
  });
  return packed;
}

// Add-user picker: appends the chosen user to the next free contiguous slot
// (so slot index == position in the user list), writes the fresh assignment
// to _voiceConfig, and PUTs the whole config. agentId stays null (routes to
// that user's coordinator; UI doesn't expose pin-to-agent). Save only — the
// new slot has no wake word yet, so there's nothing to push until the user
// picks one and clicks Push.
window.addSlotUser = async function (ev) {
  const userId = ev.target.value;
  if (!userId) return;
  // Repack first so a legacy gappy config collapses before we append.
  const cur = repackSlotAssignments(_voiceConfig.slot_assignments || {});
  const slot = Object.keys(cur).length;   // contiguous → next index == count
  if (slot >= 6) {
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

// Remove-user button: drops the slot, repacks the remaining users into
// contiguous slots, then pushes. The push re-sends the shifted users' wake
// words to their new (lower) slots AND sends ww_clear for the freed tail
// slot, so the removed user's wake word is wiped from every online device's
// SPIFFS partition immediately (offline devices sync on next connect). This
// is a deliberate, confirmed action, so we push rather than wait for the
// Push button — the removal should take effect now.
window.removeSlotUser = async function (slot) {
  const a = _voiceConfig.slot_assignments?.[slot] ?? _voiceConfig.slot_assignments?.[String(slot)];
  const roster = Array.isArray(_usersRoster) ? _usersRoster : [];
  const name = roster.find(u => u.id === a?.ownerUserId)?.name || a?.ownerUserId || 'user';
  if (!confirm(`Remove "${name}" from the voice configuration? Their wake word will be cleared from every paired device and the remaining users move up a slot.`)) return;
  const cur = { ...(_voiceConfig.slot_assignments || {}) };
  delete cur[slot];
  delete cur[String(slot)];
  _voiceConfig.slot_assignments = repackSlotAssignments(cur);
  await pushVoiceConfig();   // save + OTA: re-push shifted slots, clear the freed tail
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

// Piper voice + speaker picker. Two-input control (voice select + optional
// speaker_id input for multi-speaker voices) collapses to one stored
// "voice-id" or "voice-id:speaker_id" string. Bound to both the select and
// the input, so either change recomputes the combined value. Calls
// renderDevices() at the end so the speaker_id field appears/disappears
// when the selected voice's multi_speaker flag changes.
window.setSlotPiperVoice = function (slot) {
  const existing = _voiceConfig.slot_assignments?.[slot] ?? _voiceConfig.slot_assignments?.[String(slot)];
  if (!existing?.ownerUserId) return;
  const wrap = document.querySelector(`.piper-slot-controls[data-slot="${slot}"]`);
  const voiceId = wrap?.querySelector('.piper-voice-select')?.value || '';
  const speakerStr = (wrap?.querySelector('.piper-speaker-input')?.value || '').trim();
  const meta = _piperVoices.find(v => v.id === voiceId);
  const combined = !voiceId ? null
    : (meta?.multi_speaker && speakerStr ? `${voiceId}:${speakerStr}` : voiceId);
  if ((existing.ttsVoice ?? null) === combined) return;
  _voiceConfig.slot_assignments[slot] = { ...existing, ttsVoice: combined };
  saveVoiceConfig();
  renderDevices();              // re-render so the multi-speaker input shows/hides
  populateCoordinatorLabels();  // re-render erases the agent labels — refill them
};

// Slot voice preview: play a short sample using the slot's currently
// selected voice. Lets the admin audition a Piper voice before committing.
// Pulls the voice value from the live select+speaker inputs (not the
// persisted slot_assignments) so unsaved tweaks are previewable too.
//
// `this` is the button element. The Piper voice control wraps its select +
// optional speaker input + button in a `.piper-slot-controls` div; we find
// them via the closest wrapper. /api/tts returns raw audio bytes.
window.previewSlotVoice = function (slot) {
  const btn = this;
  if (!btn) return;
  const wrap = btn.closest('.piper-slot-controls');
  const voiceId = (wrap?.querySelector('.piper-voice-select')?.value || '').trim();
  const speaker = (wrap?.querySelector('.piper-speaker-input')?.value || '').trim();
  const voice = voiceId && speaker ? `${voiceId}:${speaker}` : voiceId;
  // Update the label so the user has feedback while the request is in flight.
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';

  fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Short showcase phrase: greeting, pangram-style consonant coverage,
      // and a final question to exercise rising intonation. Same across all
      // voices so they're directly comparable.
      text: 'Hi there. The quick brown fox jumps over the lazy dog. How does this voice sound to you?',
      voice,
    }),
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
  // Switching wake words drops BOTH the cutoff and avg-cutoff overrides — the
  // new word has its own manifest default (the UI re-displays cutoff from the
  // new manifest automatically) and the server-side avg gate goes back to off.
  _voiceConfig.slot_assignments[slot] = { ...existing, wakewordId: next, probability_cutoff: null, avg_prob_cutoff: null };
  saveVoiceConfig();
  renderDevices();   // re-render so cutoff/avg inputs redraw with the new word's defaults
};

// Cutoff input is in-memory only — typing into it shouldn't fire an OTA on
// every keystroke. The user clicks "Push" to commit. Re-renders the slot
// card immediately so a subsequent wake-word change sees the pending value.
window.setSlotProbability = function (slot, ev) {
  const existing = _voiceConfig.slot_assignments?.[slot] ?? _voiceConfig.slot_assignments?.[String(slot)];
  if (!existing?.ownerUserId) return;
  const raw = parseFloat(ev.target.value);
  const next = Number.isFinite(raw) && raw >= 0.5 && raw <= 0.99
    ? Math.round(raw * 100) / 100
    : null;
  _voiceConfig.slot_assignments[slot] = { ...existing, probability_cutoff: next };
  saveVoiceConfig();   // save only — the device gets it on the next Push
};

// Push the saved voice config (wake words, voices, cutoffs) to every paired
// device. Decoupled from saving: editing fields just persists locally +
// server-side; THIS is the only thing that OTAs the device. Saves any pending
// edit first so the push reflects what's on screen.
window.pushVoiceConfig = async function () {
  await saveVoiceConfig();
  try {
    const r = await fetch('/api/voice-config/push', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    // Report against EVERY paired device, not just the ones reached — a device
    // is "reached" only if it acked a slot; anything else (no socket / ack
    // timeout) is offline and will sync on its next connect.
    const push = data.push || {};
    const total = Object.keys(push).length;
    // "Reached" = the device acked something this round — a wake-word push OR a
    // slot clear. A removal that only clears slots (no remaining wake words)
    // still reached the device even though ackedSlots is empty.
    let reached = 0;
    for (const pr of Object.values(push)) if (pr.ackedSlots?.length || pr.clearedSlots?.length) reached++;
    const offline = total - reached;
    const dev = (n) => `${n} device${n === 1 ? '' : 's'}`;
    if (total === 0) {
      showDeviceToast('Saved — no paired device to push to.', { variant: 'warn' });
    } else if (offline === 0) {
      showDeviceToast(`Saved & pushed to ${dev(reached)}.`);
    } else if (reached > 0) {
      showDeviceToast(`Saved & pushed to ${dev(reached)}; ${dev(offline)} offline (will sync on connect).`, { variant: 'warn' });
    } else {
      showDeviceToast(`Saved — couldn't push: ${total === 1 ? 'device is offline' : `all ${total} devices offline`} (will sync on next connect).`, { variant: 'warn' });
    }
  } catch (e) {
    showDeviceToast(`Push failed: ${e.message}`, { variant: 'error' });
  }
};

// Avg-prob gate is server-only — no OTA fan-out needed, so save on every
// change instead of behind a Push button. Empty input clears the gate.
window.setSlotAvgProbability = function (slot, ev) {
  const existing = _voiceConfig.slot_assignments?.[slot] ?? _voiceConfig.slot_assignments?.[String(slot)];
  if (!existing?.ownerUserId) return;
  const raw = ev.target.value.trim();
  let next = null;
  if (raw !== '') {
    const f = parseFloat(raw);
    // 0 (or anything below 0.5 / out of range) means "no gate" → off.
    if (Number.isFinite(f) && f >= 0.5 && f <= 0.99) {
      next = Math.round(f * 100) / 100;
    }
  }
  // When it resolves to off, blank the field so it shows the "off" placeholder
  // instead of a stale "0" the user typed.
  if (next === null) ev.target.value = '';
  if ((existing.avg_prob_cutoff ?? null) === next) return;
  _voiceConfig.slot_assignments[slot] = { ...existing, avg_prob_cutoff: next };
  saveVoiceConfig();
};

// Open a hidden file picker for the alarm-chime upload flow. POSTs the
// raw MP3 to /api/voice-chime, which transcodes + broadcasts to every
// paired voice device.
window.openChimeUpload = function () {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mp3,audio/mpeg,audio/mp3,audio/*';
  input.style.display = 'none';
  input.onchange = async () => {
    const file = (input.files || [])[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const r = await fetch('/api/voice-chime', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/mpeg' },
        body: buf,
      });
      if (!r.ok) {
        const { error } = await r.json().catch(() => ({}));
        throw new Error(error || `HTTP ${r.status}`);
      }
      const { bytes, pushed, devices } = await r.json();
      const tail = devices
        ? ` Pushed to ${pushed}/${devices} device(s).`
        : ' No paired devices online to receive it.';
      showDeviceToast(`Chime updated (${(bytes / 1024).toFixed(1)} KB).${tail}`);
      loadDevices();
    } catch (e) {
      showDeviceToast(`Chime upload failed: ${e.message}`, { variant: 'error' });
    }
  };
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 60_000);
};

// Revert to the firmware's built-in procedural chime. DELETE on the same
// endpoint clears the persisted MP3 and broadcasts `chime_upload` with no
// audioMarker, which the device interprets as "use the procedural chime."
window.revertChime = async function () {
  if (!confirm('Reset the alarm chime to the built-in default on every paired device?')) return;
  try {
    const r = await fetch('/api/voice-chime', { method: 'DELETE' });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      throw new Error(error || `HTTP ${r.status}`);
    }
    showDeviceToast('Chime reset to default.');
    loadDevices();
  } catch (e) {
    showDeviceToast(`Reset failed: ${e.message}`, { variant: 'error' });
  }
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

// Open a small modal to upload a voice reference for Pocket TTS zero-shot
// cloning. Two inputs: a label ("Alex", "Test") and a WAV file (a clean
// ~15-20s clip of a single speaker). No transcript needed — Pocket TTS is
// fully zero-shot. By uploading you confirm you have consent to clone the voice.
window.openVoiceRefUpload = function () {
  const label = prompt('Voice label (e.g. "Alex", "Test"):');
  if (!label || !label.trim()) return;
  if (!confirm('Confirm you have the explicit, lawful consent of the person whose voice this clip contains. Cloning a voice without permission is prohibited.')) return;
  const transcript = '';

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.wav,.mp3,audio/wav,audio/mpeg';
  input.style.display = 'none';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (!/\.(wav|mp3)$/i.test(file.name)) {
      showDeviceToast('Reference must be a .wav or .mp3 file.', { variant: 'error' });
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

// Headphone / line-out mode: PATCH persists server-side and live-pushes
// set_headphone_mode over the device WS (routes/devices.mjs); the firmware
// stores it in NVS so it survives reboots. Voice fast-path equivalent:
// "headphone mode on/off" (chat-dispatch/voice-preprocess.mjs).
window.setDeviceHeadphone = function (id, ev) {
  patchDevice(id, { headphone_mode: !!ev.target.checked });
};

// Conversation mode: PATCH persists server-side and live-pushes
// set_conversation_mode over the device WS (routes/devices.mjs); the server
// also re-asserts it on every device reconnect (ws-handler reconcile). Old
// firmware (< 0.2.65) drops the frame silently, so toggling is safe anywhere.
window.setDeviceConversation = function (id, ev) {
  patchDevice(id, { conversation_mode: !!ev.target.checked });
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

// ── Routines: actions ───────────────────────────────────────────────────────
// Pending-edits buffer: when the user clicks Edit (or + New routine), we
// stash the working copy here so live <input>s drive it. Save flushes the
// buffer to _routines and PUTs the whole list.
let _routineEditBuffer = null;

function _readEditorIntoBuffer() {
  if (!_routineEditBuffer) return;
  const root = document.querySelector(`[data-routine-editor]`);
  if (!root) return;
  const get = (sel) => root.querySelector(sel);
  _routineEditBuffer.id      = (get('[data-routine-field="id"]')?.value || '').trim().toLowerCase();
  _routineEditBuffer.trigger = (get('[data-routine-field="trigger"]')?.value || '').trim();
  _routineEditBuffer.aliases = (get('[data-routine-field="aliases"]')?.value || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  _routineEditBuffer.device_id = (get('[data-routine-field="device_id"]')?.value || '').trim() || null;
  for (let i = 0; i < (_routineEditBuffer.actions || []).length; i++) {
    const a = _routineEditBuffer.actions[i];
    const f = (key) => root.querySelector(`[data-action-field="${i}.${key}"]`);
    if (a.type === 'ha_scene') {
      a.scene_id = (f('scene_id')?.value || '').trim();
      a.verb = f('verb')?.value || 'turn_on';
    } else if (a.type === 'ha_call') {
      a.domain = (f('domain')?.value || '').trim().toLowerCase();
      a.service = (f('service')?.value || '').trim().toLowerCase();
      // entity_id is a first-class picker now; Extra params holds everything
      // else as JSON. Merge so the persisted action.data still matches the
      // {entity_id, ...rest} shape HA service calls expect.
      const entityId = (f('entity_id')?.value || '').trim();
      const raw = (f('data')?.value || '').trim();
      let extra = {};
      try { extra = raw ? JSON.parse(raw) : {}; }
      catch { extra = a.data && typeof a.data === 'object' ? { ...a.data } : {}; delete extra.entity_id; }
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) extra = {};
      a.data = entityId ? { ...extra, entity_id: entityId } : { ...extra };
    } else if (a.type === 'play_ambient') {
      a.file = (f('file')?.value || '').trim();
      a.loop = !!f('loop')?.checked;
      const v = Number(f('volume')?.value);
      a.volume = Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined;
    } else if (a.type === 'tts_say') {
      a.text = (f('text')?.value || '').trim();
    } else if (a.type === 'run_prompt') {
      a.prompt = (f('prompt')?.value || '').trim();
    }
  }
}

window.addRoutine = function () {
  _readEditorIntoBuffer();
  _routineEditBuffer = { id: '', trigger: '', aliases: [], actions: [] };
  _editingRoutineId = '_new';
  // Put the in-progress buffer into _routines temporarily so renderRoutineRow
  // → renderRoutineEditor finds it.
  _routines = _routines.filter(r => r.id !== '_new');
  _routines.push({ ..._routineEditBuffer, id: '_new' });
  renderDevices();
  populateCoordinatorLabels();
};

window.editRoutine = function (id) {
  _readEditorIntoBuffer();
  const r = _routines.find(x => x.id === id);
  if (!r) return;
  _routineEditBuffer = JSON.parse(JSON.stringify(r));
  _editingRoutineId = id;
  renderDevices();
  populateCoordinatorLabels();
};

window.cancelRoutineEdit = function () {
  // Drop the in-progress new-routine row if it never got saved.
  _routines = _routines.filter(r => r.id !== '_new');
  _routineEditBuffer = null;
  _editingRoutineId = null;
  renderDevices();
  populateCoordinatorLabels();
};

window.saveRoutineEdit = async function () {
  _readEditorIntoBuffer();
  if (!_routineEditBuffer) return;
  const buf = _routineEditBuffer;
  if (!buf.id || buf.id === '_new') { showDeviceToast('Routine needs an id (short slug, e.g. goodnight).', { variant: 'error' }); return; }
  if (!buf.trigger) { showDeviceToast('Routine needs a trigger phrase.', { variant: 'error' }); return; }
  if (!buf.actions?.length) { showDeviceToast('Add at least one action.', { variant: 'error' }); return; }
  // Auto-slugify the id so "good night" (which the user often types when
  // they confuse id-the-slug with trigger-the-phrase) becomes "good_night"
  // and passes the server-side [a-z0-9_-]{1,64} regex.
  const slugged = buf.id.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (slugged !== buf.id) {
    showDeviceToast(`Slugified id "${buf.id}" → "${slugged}".`);
    buf.id = slugged;
  }
  if (!slugged) { showDeviceToast('ID must contain at least one letter, digit, underscore, or dash.', { variant: 'error' }); return; }
  // If we were editing under the synthetic "_new" id, swap in the real one.
  const realId = buf.id;
  const merged = _routines.filter(r => r.id !== '_new' && r.id !== _editingRoutineId);
  const existingIdx = merged.findIndex(r => r.id === realId);
  if (existingIdx >= 0) merged[existingIdx] = { ...buf, id: realId };
  else merged.push({ ...buf, id: realId });
  try {
    const r = await fetch('/api/routines', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routines: merged }),
    });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      throw new Error(error || `HTTP ${r.status}`);
    }
    const saved = await r.json();
    const savedList = Array.isArray(saved.routines) ? saved.routines : [];
    // Server cleanRoutine silently drops routines with no valid actions
    // (e.g. an ha_scene without a scene_id picked, or a play_ambient pointing
    // at a deleted file). Detect that here so the user doesn't get a fake
    // "saved" toast while the routine vanishes. The server log explains why.
    const persisted = savedList.find(r => r.id === realId);
    if (!persisted) {
      // Preserve the original list so the user sees their existing routines
      // are still intact (the server kept them); restore the in-progress
      // editor so they can fix the broken action and try again.
      _routines = savedList;
      const dropped = merged.filter(m => !savedList.some(s => s.id === m.id)).map(m => m.id);
      showDeviceToast(
        `Save rejected — routine "${realId}" was dropped (likely an action with an empty required field — check ha_scene scene_id, play_ambient file, tts_say text). Check the server log for the specific reason.${dropped.length > 1 ? ` Also dropped: ${dropped.filter(id => id !== realId).join(', ')}.` : ''}`,
        { variant: 'error' }
      );
      renderDevices();
      populateCoordinatorLabels();
      return;
    }
    _routines = savedList;
    _routineEditBuffer = null;
    _editingRoutineId = null;
    showDeviceToast(`Routine "${realId}" saved.`);
    renderDevices();
    populateCoordinatorLabels();
  } catch (e) {
    showDeviceToast(`Save failed: ${e.message}`, { variant: 'error' });
  }
};

window.deleteRoutine = async function (id) {
  const r = _routines.find(x => x.id === id);
  if (!r) return;
  if (!confirm(`Delete routine "${id}"?`)) return;
  try {
    const next = _routines.filter(x => x.id !== id);
    const resp = await fetch('/api/routines', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routines: next }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const saved = await resp.json();
    _routines = saved.routines || next;
    if (_editingRoutineId === id) { _editingRoutineId = null; _routineEditBuffer = null; }
    showDeviceToast(`Deleted "${id}".`);
    renderDevices();
    populateCoordinatorLabels();
  } catch (e) {
    showDeviceToast(`Delete failed: ${e.message}`, { variant: 'error' });
  }
};

window.copyRoutineWebhook = async function (id) {
  const r = _routines.find(x => x.id === id);
  if (!r?.webhook_token) {
    showDeviceToast('Save the routine first to generate its webhook URL.', { variant: 'error' });
    return;
  }
  const url = window.location.origin + '/api/routines/webhook/' + r.webhook_token;
  try {
    await navigator.clipboard.writeText(url);
    showDeviceToast('Webhook URL copied.');
  } catch {
    // Fallback: select the field so the user can copy by hand.
    const input = document.querySelector(`[data-routine-editor="${id}"] [data-routine-webhook-url]`);
    if (input) { input.focus(); input.select(); }
    showDeviceToast('Copy failed — URL is selected, press Ctrl+C.', { variant: 'error' });
  }
};

window.regenRoutineWebhook = async function (id) {
  if (!confirm(`Issue a fresh webhook URL for "${id}"? The old URL will stop working immediately.`)) return;
  try {
    const r = await fetch(`/api/routines/${encodeURIComponent(id)}/regen-token`, { method: 'POST' });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      throw new Error(error || `HTTP ${r.status}`);
    }
    const { routine } = await r.json();
    // Splice the fresh token into _routines so the editor re-render shows
    // the new URL without a full /api/routines re-fetch.
    const idx = _routines.findIndex(x => x.id === id);
    if (idx >= 0) _routines[idx] = routine;
    if (_routineEditBuffer && _editingRoutineId === id) {
      _routineEditBuffer.webhook_token = routine.webhook_token;
    }
    showDeviceToast('New webhook URL issued.');
    renderDevices();
    populateCoordinatorLabels();
  } catch (e) {
    showDeviceToast(`Regen failed: ${e.message}`, { variant: 'error' });
  }
};

window.testRoutine = async function (id) {
  // Prefer the routine's bound device when it's online; fall back to any
  // online paired device. Server applies the same precedence, but resolving
  // it client-side lets us toast the actual target device name.
  const routine = _routines.find(r => r.id === id);
  let targetDevice = null;
  if (routine?.device_id) {
    targetDevice = _devicesList.find(d => d.id === routine.device_id && d.online) || null;
  }
  if (!targetDevice) targetDevice = _devicesList.find(d => d.online) || null;
  if (!targetDevice) {
    showDeviceToast('No paired device is online to test against.', { variant: 'error' });
    return;
  }
  try {
    const r = await fetch(`/api/routines/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: targetDevice.id }),
    });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      throw new Error(error || `HTTP ${r.status}`);
    }
    const { errors } = await r.json();
    if (errors?.length) {
      showDeviceToast(`Routine ran with ${errors.length} error(s): ${errors[0].message}`, { variant: 'error' });
    } else {
      showDeviceToast(`Routine "${id}" fired on ${targetDevice.name}.`);
    }
  } catch (e) {
    showDeviceToast(`Test failed: ${e.message}`, { variant: 'error' });
  }
};

// Swallow space on the routine-id input — the id is a slug, not a phrase,
// and space typed there is almost always confusion with the Trigger field.
// The auto-slugify on save still handles other invalid chars + paste.
window.blockRoutineIdSpace = function (key, ev) {
  if (key === ' ') ev.preventDefault();
};

// Apply buffer edits to the in-progress row in _routines so the next render
// keeps showing the editor with the user's typed values + new actions. For
// '_new' rows we MUST keep r.id === '_new' even if the buffer's id has been
// typed in, otherwise renderRoutineRow's `_editingRoutineId === r.id` check
// fails and the editor collapses to a summary row. The real id is stamped
// at save time.
function _flushBufferToRoutines() {
  if (!_routineEditBuffer || !_editingRoutineId) return;
  const target = _routines.find(r => r.id === _editingRoutineId);
  if (!target) return;
  const cloned = JSON.parse(JSON.stringify(_routineEditBuffer));
  if (_editingRoutineId === '_new') cloned.id = '_new';
  Object.assign(target, cloned);
}

window.addRoutineAction = function (type, ev) {
  if (!type) return;
  if (ev?.target) ev.target.value = '';  // reset dropdown
  _readEditorIntoBuffer();
  if (!_routineEditBuffer) return;
  const fresh = { ha_scene:     { type, scene_id: '' },
                  ha_call:      { type, domain: '', service: '', data: {} },
                  play_ambient: { type, file: '', loop: true },
                  tts_say:      { type, text: '' },
                  run_prompt:   { type, prompt: '' } }[type];
  if (!fresh) return;
  _routineEditBuffer.actions = _routineEditBuffer.actions || [];
  _routineEditBuffer.actions.push(fresh);
  _flushBufferToRoutines();
  renderDevices();
  populateCoordinatorLabels();
};

window.removeRoutineAction = function (idx) {
  _readEditorIntoBuffer();
  if (!_routineEditBuffer) return;
  _routineEditBuffer.actions.splice(idx, 1);
  _flushBufferToRoutines();
  renderDevices();
  populateCoordinatorLabels();
};

window.refreshHaEntities = async function (_ignored, ev) {
  if (ev) ev.preventDefault();
  // Stash the in-flight editor before re-render swallows it.
  _readEditorIntoBuffer();
  try {
    const r = await fetch('/api/home-assistant/refresh', { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    // Re-pull every catalog the routine editor uses: scenes/scripts/groups
    // (ha_scene picker), broader actionable entities + service catalog
    // (ha_call cascading dropdowns).
    const [r2, r3, r4] = await Promise.all([
      fetch('/api/home-assistant/entities?domain=scene,script,group'),
      fetch('/api/home-assistant/entities?domain=light,switch,fan,cover,lock,media_player,climate,input_boolean,automation,group,scene,script'),
      fetch('/api/home-assistant/services'),
    ]);
    if (r2.ok) {
      const j = await r2.json();
      _haSceneEntities = Array.isArray(j.entities) ? j.entities : [];
    }
    if (r3.ok) {
      const j = await r3.json();
      _haActionEntities = Array.isArray(j.entities) ? j.entities : [];
    }
    if (r4.ok) {
      const j = await r4.json();
      _haServiceCatalog = (j.services && typeof j.services === 'object') ? j.services : {};
    }
    // Persist edits to the editor's working buffer so the re-render keeps them.
    _flushBufferToRoutines();
    const svcDomains = Object.keys(_haServiceCatalog).length;
    showDeviceToast(`HA refreshed — ${_haSceneEntities.length} scenes/scripts/groups, ${_haActionEntities.length} entities, ${svcDomains} service domains.`);
    renderDevices();
    populateCoordinatorLabels();
  } catch (e) {
    showDeviceToast(`HA refresh failed: ${e.message}`, { variant: 'error' });
  }
};

// Cascading domain → service handler for ha_call actions. When the user
// picks a domain we need a re-render to repopulate the service dropdown and
// the entity-picker filter — the buffer already captures the new domain via
// _readEditorIntoBuffer (data-action-field on the same <select>).
window.changeHaCallDomain = function (_idx, _value) {
  _readEditorIntoBuffer();
  if (!_routineEditBuffer) return;
  // Picking a new domain almost always invalidates the previously-chosen
  // service (different domains have different service names). Clear it so
  // the user is forced to pick a real value instead of saving a stale one.
  const action = _routineEditBuffer.actions?.[_idx];
  if (action && action.type === 'ha_call') {
    action.service = '';
    // Drop the previous entity_id too — it almost certainly belongs to a
    // different domain. The Extra params JSON is preserved (it may carry
    // domain-agnostic fields like brightness, color, etc. that still apply).
    if (action.data && typeof action.data === 'object') {
      const next = { ...action.data };
      delete next.entity_id;
      action.data = next;
    }
  }
  _flushBufferToRoutines();
  renderDevices();
  populateCoordinatorLabels();
};

window.moveRoutineAction = function (idx, delta) {
  _readEditorIntoBuffer();
  if (!_routineEditBuffer) return;
  const list = _routineEditBuffer.actions;
  const ni = idx + delta;
  if (ni < 0 || ni >= list.length) return;
  [list[idx], list[ni]] = [list[ni], list[idx]];
  _flushBufferToRoutines();
  renderDevices();
  populateCoordinatorLabels();
};

// ── Ambient library: actions ────────────────────────────────────────────────

window.uploadAmbient = function () {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.mp3,audio/mpeg';
  input.style.display = 'none';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    await _uploadAmbientFile(file);
  };
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 60_000);
};

async function _uploadAmbientFile(file) {
  if (file.size > 40 * 1024 * 1024) {
    showDeviceToast('File too large (max 40 MB).', { variant: 'error' });
    return;
  }
  if (!/\.mp3$/i.test(file.name)) {
    showDeviceToast('Only MP3 files are supported.', { variant: 'error' });
    return;
  }
  _ambientUploadProgress = { name: file.name, pct: 0 };
  renderDevices();
  populateCoordinatorLabels();
  try {
    const r = await fetch(`/api/devices/ambient-library/${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'audio/mpeg' },
      body: file,
    });
    if (!r.ok) {
      const { error } = await r.json().catch(() => ({}));
      throw new Error(error || `HTTP ${r.status}`);
    }
    _ambientUploadProgress = null;
    showDeviceToast(`Uploaded "${file.name}".`);
    loadDevices();
  } catch (e) {
    _ambientUploadProgress = null;
    showDeviceToast(`Upload failed: ${e.message}`, { variant: 'error' });
    renderDevices();
    populateCoordinatorLabels();
  }
}

window.deleteAmbient = async function (name) {
  if (!confirm(`Delete "${name}" from your ambient library?\n\nAny routines referencing it will start failing until you change the action.`)) return;
  try {
    const r = await fetch(`/api/devices/ambient-library/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    loadDevices();
  } catch (e) {
    showDeviceToast(`Delete failed: ${e.message}`, { variant: 'error' });
  }
};

window.previewAmbient = function (name) {
  // Toggle: clicking the play button while THIS file is already playing
  // stops it; otherwise stop any other preview and start this one. The
  // button's icon (▶ vs ■) is driven by window._ambientPreviewName so a
  // re-render flips it.
  const wasPlayingThis = window._ambientPreviewName === name;
  if (window._ambientPreviewEl) {
    try { window._ambientPreviewEl.pause(); } catch {}
    window._ambientPreviewEl.remove();
    window._ambientPreviewEl = null;
  }
  window._ambientPreviewName = null;
  if (wasPlayingThis) {
    renderDevices();
    populateCoordinatorLabels();
    return;
  }
  const audio = document.createElement('audio');
  audio.src = `/api/devices/ambient-library/${encodeURIComponent(name)}/preview`;
  audio.controls = false;
  audio.autoplay = true;
  audio.style.display = 'none';
  audio.addEventListener('ended', () => {
    audio.remove();
    if (window._ambientPreviewEl === audio) window._ambientPreviewEl = null;
    if (window._ambientPreviewName === name) {
      window._ambientPreviewName = null;
      renderDevices();
      populateCoordinatorLabels();
    }
  });
  document.body.appendChild(audio);
  window._ambientPreviewEl = audio;
  window._ambientPreviewName = name;
  renderDevices();
  populateCoordinatorLabels();
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
