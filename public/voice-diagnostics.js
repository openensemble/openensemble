// Guided voice checks. Browser audio is analyzed locally and never uploaded.
let _voiceDiagDevice = '';
let _voiceDiagData = null;
let _voiceDiagError = '';
let _voiceDiagRoundTrip = null;
let _voiceDiagCheck = null;
let _voiceDiagMessage = '';
let _voiceDiagGeneration = 0;
let _voiceDiagRequest = null;
let _voiceDiagPoll = null;
let _voiceMic = null;
let _voiceMicMessage = '';
let _voiceCalibration = null;
let _voiceCalibrationResult = null;
let _voiceCalibrationTimer = null;
let _voiceCalibrationStatus = '';

function voiceDiagnosticTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'Not recorded';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function voiceDiagnosticOutcome(outcome) {
  return ({ completed: 'Completed', suppressed: 'Stopped or intentionally silent', no_speech: 'No speech detected',
    stt_dropped: 'Audio capture interrupted', stt_failed: 'Speech recognition failed', tts_failed: 'Voice generation failed', abandoned: 'Turn timed out',
    evicted: 'Turn interrupted', aborted_disconnect: 'Connection lost', handler_error: 'Reply failed', wake_rejected: 'Wake rejected by sensitivity gate' })[outcome] || 'Unknown outcome';
}

function renderVoiceTurnDiagnostics(turn) {
  const t = turn.timing || {};
  const rows = [
    ['Recording / upload', t.captureMs], ['Speech recognition', t.recognitionMs],
    ['Agent → first reply text', t.firstTextMs], ['First audio segment preparation', t.firstSynthesisMs],
    ['End of recording → first audio sent', t.firstAudioMs],
    [t.deliveryMeasured ? 'Total through last audio sent' : 'Total server turn', t.totalMs],
  ];
  const levels = turn.levels;
  const mic = levels ? (levels.silent ? 'No microphone signal reached OE.'
    : levels.likelyClipped ? 'Audio may be distorted. Try speaking farther from the microphone or reducing its input gain.'
    : `Audio reached OE. Peak ${levels.peakDbfs ?? '—'} dBFS; average ${levels.rmsDbfs ?? '—'} dBFS.`) : 'Audio levels were not recorded for this turn.';
  const recognized = turn.recognizedSpeech === true ? 'Speech was recognized.' : turn.recognizedSpeech === false ? 'No words were recognized.' : '';
  return `<div class="voice-diag-turn">
    <p><b>What OE heard:</b> ${escHtml(turn.transcript ?? 'Transcript was not recorded for this turn.')}</p>
    <p><b>Wake:</b> ${escHtml(turn.wake?.decision || 'Not recorded')}${typeof turn.wake?.score === 'number' ? ` · score ${Math.round(turn.wake.score * 100)}%` : ''}${typeof turn.wake?.cutoff === 'number' ? ` · cutoff ${Math.round(turn.wake.cutoff * 100)}%` : ''}. <b>Agent:</b> ${escHtml(turn.agentId || 'No agent dispatch recorded')}</p>
    <p>${escHtml(mic)} ${escHtml(recognized)}${turn.gaps ? ` ${escHtml(turn.gaps)} audio frame gap(s) were recorded.` : ''}</p>
    <table class="voice-diag-timings"><caption>Response timing</caption><tbody>${rows.map(([label, ms]) => `<tr><th scope="row">${label}</th><td>${voiceDiagnosticTime(ms)}</td></tr>`).join('')}</tbody></table>
    <p class="voice-diag-hint">Stages can overlap. Audio timings measure when OE sends sound; speaker buffering is not measured.</p>
  </div>`;
}

function renderVoiceDiagnosticResults() {
  if (_voiceDiagError) return `<p class="voice-diag-error" role="alert">${escHtml(_voiceDiagError)}</p>`;
  if (!_voiceDiagDevice) return '<p class="voice-diag-hint">Pair a voice device to check its connection and voice turns. You can test this browser’s microphone below.</p>';
  const data = _voiceDiagData;
  if (!data) return '<p class="voice-diag-hint">Loading device diagnostics…</p>';
  const link = data.connection;
  return `<div class="voice-diag-checks">${data.checks.map(check => `<div class="voice-diag-check" data-status="${escHtml(check.status)}"><strong>${escHtml(check.name)} · ${escHtml(({ok:'Ready',warning:'Check',error:'Problem',unknown:'Unknown'})[check.status] || 'Unknown')}</strong><span>${escHtml(check.detail)}</span></div>`).join('')}</div>
    <p class="voice-diag-hint">This browser ↔ OE: ${voiceDiagnosticTime(_voiceDiagRoundTrip)} round trip.${data.heartbeatAgeMs !== null ? ` Device telemetry: ${voiceDiagnosticTime(data.heartbeatAgeMs)} old.` : ''}</p>
    <p class="voice-diag-hint">${link.hasHistory ? `Last 24 hours: ${link.disconnects} disconnect(s), ${link.unresponsive} unresponsive connection(s), ${link.interruptedTurns} interrupted turn(s).` : 'No connection history recorded in the last 24 hours.'}</p>
    ${data.turns.length ? `<div class="voice-diag-recent">${data.turns.map((turn, index) => `<details ${index === 0 ? 'open' : ''}><summary>${index === 0 ? 'Latest turn · ' : ''}${escHtml(new Date(turn.endedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}))} · ${escHtml(voiceDiagnosticOutcome(turn.outcome))}</summary>${renderVoiceTurnDiagnostics(turn)}</details>`).join('')}</div>` : '<p class="voice-diag-hint">No voice turns recorded for your profile on this device in the last 24 hours. Start the guided check to record a new result.</p>'}`;
}

function renderVoiceDiagnosticsPanel() {
  if (!_devicesList.some(device => device.id === _voiceDiagDevice)) {
    _voiceDiagDevice = _devicesList[0]?.id || '';
    _voiceDiagData = null;
  }
  return `<section class="voice-diagnostics" aria-labelledby="voiceDiagnosticsTitle">
    <h2 id="voiceDiagnosticsTitle">Voice diagnostics</h2>
    <label class="voice-diag-label">Paired device
      <select data-change-action="selectVoiceDiagnosticDevice" data-change-args='["$value"]' ${_devicesList.length ? '' : 'disabled'}>${_devicesList.length ? _devicesList.map(device => `<option value="${escHtml(device.id)}" ${device.id === _voiceDiagDevice ? 'selected' : ''}>${escHtml(device.name || device.id)}</option>`).join('') : '<option>No paired devices</option>'}</select>
    </label>
    <div class="voice-diag-actions">
      <button class="cdraw-btn cdraw-btn-primary" data-action="startVoiceDeviceCheck" id="voiceDiagStart" ${_voiceDiagDevice && !_voiceDiagCheck ? '' : 'disabled'}>Start device check</button>
      <button class="cdraw-btn" data-action="refreshVoiceDiagnostics" ${_voiceDiagDevice ? '' : 'disabled'}>Refresh</button>
      <button class="cdraw-btn" data-action="cancelVoiceDeviceCheck" id="voiceDiagCancel" ${_voiceDiagCheck ? '' : 'hidden'}>Cancel check</button>
    </div>
    <p class="voice-diag-status" id="voiceDiagStatus" role="status">${escHtml(_voiceDiagMessage)}</p>
    <div id="voiceDiagResults">${renderVoiceDiagnosticResults()}</div>
    <div id="voiceRoomCalibration">${renderVoiceRoomCalibration()}</div>
    <div class="voice-diag-browser">
      <h3>This browser’s microphone</h3>
      <p class="voice-diag-hint">Speak normally for six seconds. This checks audio levels on this computer or phone; audio stays in this browser.</p>
      <div class="voice-diag-actions">
        <button class="cdraw-btn" data-action="startVoiceMicrophoneCheck" id="voiceMicStart" ${_voiceMic ? 'disabled' : ''}>Check this microphone</button>
        <button class="cdraw-btn" data-action="cancelVoiceMicrophoneCheck" id="voiceMicCancel" ${_voiceMic ? '' : 'hidden'}>Stop microphone check</button>
      </div>
      <meter id="voiceMicLevel" min="-60" max="0" low="-45" high="-3" optimum="-15" value="-60" aria-label="Microphone input level"></meter>
      <p class="voice-diag-status" id="voiceMicStatus" role="status">${escHtml(_voiceMicMessage)}</p>
    </div>
  </section>`;
}

function updateVoiceDiagnosticResults() {
  const body = $('voiceDiagResults');
  if (body) body.innerHTML = renderVoiceDiagnosticResults();
  if ($('voiceRoomCalibration')) $('voiceRoomCalibration').innerHTML = renderVoiceRoomCalibration();
  const status = $('voiceDiagStatus');
  if (status) status.textContent = _voiceDiagMessage;
  const start = $('voiceDiagStart');
  if (start) start.disabled = !_voiceDiagDevice || !!_voiceDiagCheck;
  const cancel = $('voiceDiagCancel');
  if (cancel) cancel.hidden = !_voiceDiagCheck;
}

function refreshVoiceDiagnostics() {
  if (!_voiceDiagDevice || activeDrawerId !== 'drawerDevices' || $('sbtnRoutines')?.classList.contains('active')) return null;
  // Refresh and the guided check can request the same snapshot concurrently.
  // Share that request so Refresh cannot cancel the check's starting point.
  if (_voiceDiagRequest) return _voiceDiagRequest.promise;
  const request = { controller: new AbortController(), promise: null };
  _voiceDiagRequest = request;
  request.promise = fetchVoiceDiagnostics(request);
  return request.promise;
}

async function fetchVoiceDiagnostics(request) {
  const ac = request.controller;
  const generation = _voiceDiagGeneration;
  const deviceId = _voiceDiagDevice;
  const started = performance.now();
  const timeout = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/diagnostics?details=1`, { signal: ac.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`Could not load device diagnostics (${res.status}).`);
    const data = await res.json();
    if (generation !== _voiceDiagGeneration || _voiceDiagRequest !== request) return null;
    _voiceDiagData = data;
    _voiceDiagRoundTrip = performance.now() - started;
    _voiceDiagError = '';
    if (_voiceDiagCheck) {
      const turn = data.turns.find(item => item.startedAt >= _voiceDiagCheck.since);
      if (turn) {
        _voiceDiagMessage = turn.recognizedSpeech && turn.outcome === 'completed'
          ? 'Speech reached OE and the server completed the reply. Check the timing below; if you heard no reply, check the device’s speaker and volume.'
          : `Check finished: ${voiceDiagnosticOutcome(turn.outcome)}. Review the microphone and timing details below.`;
        _voiceDiagCheck = null;
      } else if (!_voiceDiagData.device.online) {
        _voiceDiagMessage = 'The device disconnected during the check. Check its power and Wi-Fi, then try again.';
        _voiceDiagCheck = null;
      } else if (performance.now() >= _voiceDiagCheck.deadline) {
        _voiceDiagMessage = 'No completed voice turn arrived within 60 seconds. Check mute, wake-word detection, and Wi-Fi. Use a wake word assigned to your profile, then try again.';
        _voiceDiagCheck = null;
      }
    }
    updateVoiceDiagnosticResults();
    return data;
  } catch (error) {
    if (generation !== _voiceDiagGeneration || _voiceDiagRequest !== request) return null;
    _voiceDiagError = error.name === 'AbortError' ? 'OE did not respond within eight seconds. Check the connection and try Refresh.' : error.message;
    _voiceDiagCheck = null;
    _voiceDiagMessage = '';
    updateVoiceDiagnosticResults();
    return null;
  } finally {
    clearTimeout(timeout);
    if (_voiceDiagRequest === request) _voiceDiagRequest = null;
  }
}

function selectVoiceDiagnosticDevice(id) {
  stopVoiceDiagnostics();
  _voiceDiagDevice = id;
  updateVoiceDiagnosticResults();
  void refreshVoiceDiagnostics();
}

async function startVoiceDeviceCheck() {
  if (_voiceDiagCheck || !_voiceDiagDevice) return;
  _voiceDiagCheck = { since: Infinity, deadline: Infinity };
  updateVoiceDiagnosticResults();
  const generation = _voiceDiagGeneration;
  const data = await refreshVoiceDiagnostics();
  if (!data || generation !== _voiceDiagGeneration) return;
  if (!data.device.online || data.device.muted) {
    _voiceDiagCheck = null;
    _voiceDiagMessage = data.device.muted ? 'Unmute this device before starting the check.' : 'Connect this device to OE before starting the check.';
    updateVoiceDiagnosticResults();
    return;
  }
  _voiceDiagCheck = { since: data.serverNow, deadline: performance.now() + 60_000 };
  _voiceDiagMessage = 'Say your wake word, then “What is two plus two?” Use a wake word assigned to your profile. Waiting up to 60 seconds for the voice turn to finish…';
  updateVoiceDiagnosticResults();
  const poll = async () => {
    if (!_voiceDiagCheck || generation !== _voiceDiagGeneration) return;
    await refreshVoiceDiagnostics();
    if (_voiceDiagCheck && generation === _voiceDiagGeneration) _voiceDiagPoll = setTimeout(poll, 2000);
  };
  _voiceDiagPoll = setTimeout(poll, 2000);
}

function cancelVoiceDeviceCheck() {
  _voiceDiagGeneration++;
  _voiceDiagRequest?.controller.abort();
  _voiceDiagRequest = null;
  clearTimeout(_voiceDiagPoll);
  _voiceDiagCheck = null;
  _voiceDiagMessage = 'Device check canceled.';
  updateVoiceDiagnosticResults();
}

function updateVoiceMicrophoneStatus(message) {
  _voiceMicMessage = message;
  const status = $('voiceMicStatus');
  if (status) status.textContent = message;
  if ($('voiceMicStart')) $('voiceMicStart').disabled = !!_voiceMic;
  if ($('voiceMicCancel')) $('voiceMicCancel').hidden = !_voiceMic;
}

function finishVoiceMicrophoneCheck(message) {
  const test = _voiceMic;
  _voiceMic = null;
  if (test) {
    clearTimeout(test.timer);
    cancelAnimationFrame(test.frame);
    test.stream?.getTracks().forEach(track => track.stop());
    try { test.source?.disconnect(); } catch {}
    if (test.audio) void test.audio.close().catch(() => {});
  }
  if ($('voiceMicLevel')) $('voiceMicLevel').value = -60;
  updateVoiceMicrophoneStatus(message);
}

async function startVoiceMicrophoneCheck() {
  if (_voiceMic) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    updateVoiceMicrophoneStatus('Microphone access needs HTTPS or localhost. Open OE securely on this device, or use the paired-device check above.');
    return;
  }
  const test = { stream: null, audio: null, source: null, timer: null, frame: null };
  _voiceMic = test;
  updateVoiceMicrophoneStatus('Allow microphone access in your browser to begin.');
  test.timer = setTimeout(() => { if (_voiceMic === test) finishVoiceMicrophoneCheck('Microphone access timed out. Check browser permission and try again.'); }, 20_000);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (_voiceMic !== test) { stream.getTracks().forEach(track => track.stop()); return; }
    test.stream = stream;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('Audio analysis is not supported in this browser.');
    test.audio = new Audio();
    await test.audio.resume();
    if (_voiceMic !== test) return;
    clearTimeout(test.timer);
    const analyser = test.audio.createAnalyser();
    analyser.fftSize = 2048;
    test.source = test.audio.createMediaStreamSource(stream);
    test.source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let loudest = -100, peak = 0, clipped = 0, count = 0;
    const started = performance.now();
    const label = stream.getAudioTracks()[0]?.label || 'Default microphone';
    updateVoiceMicrophoneStatus(`${label}: speak normally for six seconds.`);
    const sample = () => {
      if (_voiceMic !== test) return;
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) { sum += value * value; peak = Math.max(peak, Math.abs(value)); if (Math.abs(value) >= 0.99) clipped++; }
      count += samples.length;
      const db = 20 * Math.log10(Math.max(0.00001, Math.sqrt(sum / samples.length)));
      loudest = Math.max(loudest, db);
      if ($('voiceMicLevel')) $('voiceMicLevel').value = Math.max(-60, db);
      test.frame = requestAnimationFrame(sample);
    };
    stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (_voiceMic === test) finishVoiceMicrophoneCheck('The microphone disconnected. Reconnect it and try again.'); }, { once: true });
    sample();
    test.timer = setTimeout(() => {
      if (_voiceMic !== test) return;
      const result = !count || loudest < -45 ? 'Input was quiet or silent. Check the selected microphone, mute switch, and input volume; speak closer and try again.'
        : clipped / count > 0.005 ? 'Input is reaching full volume and may sound distorted. Lower the microphone input volume and try again.'
        : `Audio input detected. Peak ${Math.round(20 * Math.log10(Math.max(peak, 0.00001)))} dBFS. This checks input levels; use the device check above to test speech recognition.`;
      finishVoiceMicrophoneCheck(`${label}: ${result}`);
    }, Math.max(0, 6000 - (performance.now() - started)));
  } catch (error) {
    if (_voiceMic !== test) return;
    const message = ({ NotAllowedError: 'Microphone permission was denied. Allow microphone access for OE in browser settings and try again.',
      NotFoundError: 'No microphone was found. Connect one and try again.',
      NotReadableError: 'The microphone could not be opened. Check whether another app is using it.' })[error.name] || `Microphone check failed: ${error.message}`;
    finishVoiceMicrophoneCheck(message);
  }
}

function cancelVoiceMicrophoneCheck() { finishVoiceMicrophoneCheck('Microphone check stopped.'); }

function stopVoiceDiagnostics() {
  _voiceDiagGeneration++;
  _voiceDiagRequest?.controller.abort();
  _voiceDiagRequest = null;
  clearTimeout(_voiceDiagPoll);
  _voiceDiagCheck = null;
  _voiceDiagData = null;
  _voiceDiagError = '';
  _voiceDiagMessage = '';
  _voiceDiagRoundTrip = null;
  clearTimeout(_voiceCalibrationTimer);
  _voiceCalibration = null;
  _voiceCalibrationResult = null;
  _voiceCalibrationStatus = '';
  finishVoiceMicrophoneCheck('');
  updateVoiceDiagnosticResults();
}

function renderVoiceRoomCalibration() {
  const data = _voiceDiagData;
  const latest = data?.room?.samples?.at(-1);
  const fresh = latest && data.serverNow - latest.ts < 45_000;
  const slots = data?.calibrationSlots || [];
  const result = _voiceCalibrationResult;
  return `<section class="voice-diag-browser"><h3>Room and wake-word calibration</h3>
    <p class="voice-diag-hint">Measure 30 seconds of room noise, then make three separate wake attempts from your usual position. Changes below affect only this device’s average wake-score gate.</p>
    ${fresh ? `<p>Microphone level: ${escHtml(latest.audioLevel ?? 'unknown')} device units · Gain control: ${escHtml(latest.agc || 'unknown')}. Recent wake peaks: ${latest.peaks.map(peak => `slot ${peak.slot + 1}: ${Math.round(peak.score * 100)}%`).join(', ')}.</p>` : '<p>No recent wake telemetry. Supported voice-device firmware must be connected before room calibration can run.</p>'}
    <div class="voice-diag-actions">${slots.map(slot => `<button class="cdraw-btn" data-action="startVoiceRoomCalibration" data-args='[${slot.slot}]' ${!fresh || _voiceCalibration || _voiceDiagCheck ? 'disabled' : ''}>Calibrate slot ${slot.slot + 1}</button>${slot.overridden ? `<button class="cdraw-btn" data-action="resetVoiceRoomCalibration" data-args='[${slot.slot}]'>Restore slot ${slot.slot + 1} defaults</button>` : ''}`).join('')}
    ${_voiceCalibration ? '<button class="cdraw-btn" data-action="cancelVoiceRoomCalibration">Cancel calibration</button>' : ''}</div>
    <p role="status">${escHtml(_voiceCalibrationStatus)}</p>
    ${result ? `<p>${escHtml(result.explanation)}</p><p>${result.quietSamples} quiet samples · ${result.attempts} wake attempts${result.quietLevel != null ? ` · Quiet-room level ${result.quietLevel} device units` : ''}</p>${result.recommendation != null ? `<button class="cdraw-btn" data-action="applyVoiceRoomCalibration">Apply ${Math.round(result.recommendation * 100)}% average cutoff to this device</button>` : ''}` : ''}
  </section>`;
}

async function voiceCalibrationRequest(deviceId, body) {
  const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/calibration`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Calibration request failed.');
  return result;
}

async function startVoiceRoomCalibration(slot) {
  if (_voiceCalibration || _voiceDiagCheck) return;
  const pending = { deviceId: _voiceDiagDevice };
  _voiceCalibration = pending;
  const data = await refreshVoiceDiagnostics();
  if (_voiceCalibration !== pending || pending.deviceId !== _voiceDiagDevice) return;
  const assignment = data?.calibrationSlots?.find(item => item.slot === slot);
  const latest = data?.room?.samples?.at(-1);
  if (!assignment || !latest || data.serverNow - latest.ts >= 45_000 || !data.device.online || data.device.muted) {
    _voiceCalibration = null;
    _voiceCalibrationStatus = 'Connect and unmute the device, then wait for fresh wake telemetry.'; updateVoiceDiagnosticResults(); return;
  }
  const check = { deviceId: _voiceDiagDevice, slot, wakewordId: assignment.wakewordId, startedAt: data.serverNow, quietUntil: data.serverNow + 30_000 };
  _voiceCalibration = check; _voiceCalibrationResult = null;
  const poll = async () => {
    if (_voiceCalibration !== check) return;
    const snapshot = await refreshVoiceDiagnostics();
    if (_voiceCalibration !== check) return;
    if (!snapshot || !snapshot.device.online) { cancelVoiceRoomCalibration(); return; }
    const quietRemaining = check.quietUntil - snapshot.serverNow;
    const attempts = snapshot.turns.filter(turn => turn.startedAt > check.quietUntil && turn.wake?.slot === slot && turn.wake?.decision !== 'followup');
    _voiceCalibrationStatus = quietRemaining > 0
      ? `Quiet-room step: stay quiet for ${Math.ceil(quietRemaining / 1000)} more seconds. Leave normal room noise running.`
      : `Say your wake word, then “What is two plus two?” three separate times. Wait for each reply before trying again. ${attempts.length}/3 attempts recorded.`;
    if (quietRemaining <= 0 && (attempts.length >= 3 || snapshot.serverNow > check.quietUntil + 120_000)) {
      try {
        const result = await voiceCalibrationRequest(check.deviceId, { ...check, action: 'summarize' });
        if (_voiceCalibration !== check) return;
        _voiceCalibrationResult = { ...check, ...result }; _voiceCalibrationStatus = 'Calibration measurements complete.';
      } catch (error) { _voiceCalibrationStatus = error.message; }
      _voiceCalibration = null;
    }
    updateVoiceDiagnosticResults();
    if (_voiceCalibration === check) _voiceCalibrationTimer = setTimeout(poll, 2000);
  };
  await poll();
}

function cancelVoiceRoomCalibration() {
  clearTimeout(_voiceCalibrationTimer); _voiceCalibration = null;
  _voiceCalibrationStatus = 'Calibration stopped. Device sensitivity was not changed.'; updateVoiceDiagnosticResults();
}

async function applyVoiceRoomCalibration() {
  const result = _voiceCalibrationResult;
  if (!result || result.deviceId !== _voiceDiagDevice || result.recommendation == null) return;
  try {
    await voiceCalibrationRequest(result.deviceId, { action: 'apply', slot: result.slot, wakewordId: result.wakewordId, cutoff: result.recommendation });
    _voiceCalibrationStatus = 'Average wake cutoff applied to this device. Repeat the device check to verify it.';
    _voiceCalibrationResult = null; await refreshVoiceDiagnostics();
  } catch (error) { _voiceCalibrationStatus = error.message; updateVoiceDiagnosticResults(); }
}

async function resetVoiceRoomCalibration(slot) {
  const assignment = _voiceDiagData?.calibrationSlots?.find(item => item.slot === slot);
  if (!assignment) return;
  try {
    await voiceCalibrationRequest(_voiceDiagDevice, { action: 'reset', slot, wakewordId: assignment.wakewordId });
    _voiceCalibrationStatus = 'This device is using the shared voice settings again.'; await refreshVoiceDiagnostics();
  } catch (error) { _voiceCalibrationStatus = error.message; updateVoiceDiagnosticResults(); }
}

window.addEventListener('pagehide', stopVoiceDiagnostics);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopVoiceDiagnostics();
  else void refreshVoiceDiagnostics();
});
