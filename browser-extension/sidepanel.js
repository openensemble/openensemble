// OE Bridge — side panel chat surface.
//
// Stays open while the user interacts with the page (this is the whole
// point vs the popup). Reads chat history from chrome.storage.local on
// load so the conversation survives panel close + reopen. Listens for
// chat_event / chat_done / chat_error messages from the background SW
// for the currently-streaming response.

const $ = (id) => document.getElementById(id);

let _currentRequestId = null;
let _currentAssistantEl = null;
let _statusBadge = $('status');
let _voiceUserEl = null;
let _voiceRecorder = null;
let _voiceStream = null;
let _voiceChunks = [];
let _voiceStopTimer = null;
let _teachActive = false;
let _confirmationId = null;
let _fieldWatchSelection = null;
let _suggestionId = null;

function renderSuggestionAvailable(available) {
  $('suggestionCard').hidden = !available;
  if (!available) {
    _suggestionId = null;
    $('suggestionDetails').hidden = true;
    $('suggestionReason').textContent = '';
  }
}

function renderStatus(status) {
  const el = $('status');
  if (!el) return;
  if (status?.connected) {
    el.className = 'status ok';
    const userName = typeof status.userName === 'string' ? status.userName.trim() : '';
    el.textContent = userName ? `Connected ${userName}` : 'Connected';
  } else if (status?.lastError) {
    el.className = 'status bad';
    el.textContent = `Disconnected — ${String(status.lastError).slice(0, 60)}`;
  } else {
    el.className = 'status idle';
    el.textContent = 'Waiting…';
  }
}

async function refreshStatus() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'get_status' });
    if (r?.status) renderStatus(r.status);
  } catch {}
}

async function refreshSuggestion() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'suggestion_get' });
    renderSuggestionAvailable(response?.ok && response.available);
  } catch {}
}

async function refreshTeachState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get_teach_state' });
    _teachActive = Boolean(response?.active);
    const button = $('teachThisSite');
    button.textContent = _teachActive ? '■ Stop teaching' : '🎓 Teach this site';
    button.style.color = _teachActive ? '#b91c1c' : '';
    button.title = _teachActive
      ? 'Stop the current tab-scoped Teach session and erase its observation buffer.'
      : 'Observe your clicks and non-sensitive inputs on this tab and site for up to 15 minutes.';
  } catch {}
}

function renderActionConfirmation(confirmation) {
  _confirmationId = confirmation?.id || null;
  $('actionConfirmation').hidden = !_confirmationId;
  if (!_confirmationId) return;
  $('confirmationSummary').textContent = confirmation.summary || 'Allow this browser action once?';
  $('confirmationOrigin').textContent = [confirmation.pageTitle, confirmation.origin].filter(Boolean).join(' · ');
}

async function refreshActionConfirmation() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get_pending_confirmation' });
    renderActionConfirmation(response?.confirmation || null);
  } catch {}
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'status') renderStatus(msg.status);
  if (msg?.type === 'suggestion_available') renderSuggestionAvailable(msg.available === true);
  if (msg?.type === 'context_started') {
    appendMessage('user', msg.userText || 'Shared browser context');
    _currentRequestId = msg.requestId;
    _currentAssistantEl = appendMessage('assistant', '…');
  }
  if (msg?.type === 'clip_ready') openClipPicker(msg.capture).catch(error => {
    appendMessage('assistant', `[clip error: ${error?.message || String(error)}]`);
  });
  if (msg?.type === 'action_confirmation') renderActionConfirmation(msg.confirmation);
  if (msg?.type === 'field_watch_selection') renderFieldWatchSelection(msg.selection);
  if (msg?.type === 'field_watch_picker_cancelled') {
    $('fieldWatchMessage').textContent = 'Field selection cancelled.';
    $('fieldWatchPick').disabled = false;
  }
});

function appendMessage(role, text) {
  const empty = $('empty');
  if (empty) empty.remove();
  const msgsEl = $('messages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text || '';
  msgsEl.appendChild(div);
  msgsEl.scrollTop = msgsEl.scrollHeight;
  return div;
}

async function openClipPicker(capture) {
  $('clipPicker').hidden = false;
  $('clipSummary').textContent = capture?.title
    ? `${capture.kind === 'selection' ? 'Selection from' : 'Page'}: ${capture.title}`
    : 'Preparing page…';
  $('clipMessage').textContent = 'Loading your OE documents…';
  $('clipSave').disabled = true;
  const response = await chrome.runtime.sendMessage({ type: 'clip_targets' });
  if (!response?.ok) throw new Error(response?.error || 'could not load clip destinations');
  const select = $('clipTarget');
  select.replaceChildren();
  const create = document.createElement('option');
  create.value = 'new';
  create.textContent = '＋ New project document…';
  select.appendChild(create);
  for (const target of response.targets || []) {
    const option = document.createElement('option');
    option.value = String(target.id || '');
    option.textContent = `${target.kind === 'research' ? 'Research' : 'Document'} · ${target.label || target.id}`;
    select.appendChild(option);
  }
  select.value = select.options.length > 1 ? select.options[1].value : 'new';
  $('clipNewNameRow').hidden = select.value !== 'new';
  $('clipMessage').textContent = 'Only this captured excerpt will be sent when you press Save.';
  $('clipSave').disabled = false;
}

function renderFieldWatchSelection(selection) {
  _fieldWatchSelection = selection || null;
  const summary = $('fieldWatchSelection');
  const form = $('fieldWatchCreate');
  $('fieldWatchPick').disabled = false;
  if (!selection) {
    summary.hidden = true;
    form.hidden = true;
    return;
  }
  let host = '';
  try { host = new URL(selection.exactUrl).host; } catch {}
  summary.textContent = `Selected “${selection.initialValue || 'value'}”. Exact URL: ${selection.exactUrl}. Only selector ${selection.field?.selector || 'the pinned field'} will be read.`;
  summary.hidden = false;
  form.hidden = false;
  if (!$('fieldWatchLabel').value) {
    const property = selection.field?.property === 'price' ? 'price'
      : selection.field?.property === 'availability' ? 'availability' : 'value';
    $('fieldWatchLabel').value = `${selection.title || host || 'Page'} ${property}`.slice(0, 160);
  }
  $('fieldWatchConfirm').checked = false;
  $('fieldWatchMessage').textContent = 'Review the exact-field permission, then start the watch.';
}

function watchPredicateLabel(watch) {
  const type = watch?.predicate?.type || 'changed';
  if (type === 'changed') return 'when it changes';
  return `${type.replaceAll('_', ' ')} ${watch?.predicate?.target ?? ''}`.trim();
}

async function refreshFieldWatches() {
  const list = $('fieldWatchList');
  list.replaceChildren();
  try {
    const response = await chrome.runtime.sendMessage({ type: 'field_watch_list' });
    if (!response?.ok) throw new Error(response?.error || 'could not load field watches');
    const watches = response.watches || [];
    if (!watches.length) {
      const empty = document.createElement('span');
      empty.style.cssText = 'font-size:11px;color:#6b7280';
      empty.textContent = 'No active field watches.';
      list.appendChild(empty);
      return;
    }
    for (const watch of watches) {
      const row = document.createElement('div');
      row.className = 'field-watch-row';
      const details = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = watch.label || 'Field watch';
      const meta = document.createElement('small');
      const current = watch.baseline?.displayValue || watch.baseline?.value;
      const execution = watch.execution?.mode === 'browser'
        ? 'checked by this paired browser'
        : 'checked privately by the OE server';
      meta.textContent = `${watch.url} · ${watchPredicateLabel(watch)} · ${execution} · ${current == null ? 'waiting for first reading' : `now ${current}`}`;
      details.append(name, meta);
      if (watch.lastError?.message) {
        const error = document.createElement('small');
        error.style.color = '#b45309';
        error.textContent = watch.lastError.message;
        details.append(error);
      }
      const revoke = document.createElement('button');
      revoke.textContent = 'Stop';
      revoke.dataset.watchId = String(watch.id || '');
      revoke.addEventListener('click', async () => {
        revoke.disabled = true;
        $('fieldWatchMessage').textContent = `Stopping “${watch.label || 'field watch'}”…`;
        try {
          const result = await chrome.runtime.sendMessage({ type: 'field_watch_revoke', watchId: watch.id });
          if (!result?.ok) throw new Error(result?.error || 'could not stop watch');
          $('fieldWatchMessage').textContent = `Stopped “${watch.label || 'field watch'}”. Its standing permission is revoked.`;
          await refreshFieldWatches();
        } catch (error) {
          $('fieldWatchMessage').textContent = error?.message || String(error);
          revoke.disabled = false;
        }
      });
      row.append(details, revoke);
      list.appendChild(row);
    }
  } catch (error) {
    const message = document.createElement('span');
    message.style.cssText = 'font-size:11px;color:#b91c1c';
    message.textContent = error?.message || String(error);
    list.appendChild(message);
  }
}

async function openFieldWatchPanel() {
  $('fieldWatchPanel').hidden = false;
  $('fieldWatchMessage').textContent = 'Loading field watches…';
  await refreshFieldWatches();
  try {
    const pending = await chrome.runtime.sendMessage({ type: 'field_watch_pending_get' });
    renderFieldWatchSelection(pending?.selection || null);
    if (!pending?.selection) $('fieldWatchMessage').textContent = 'Pick the exact value you want OE to watch.';
  } catch (error) {
    $('fieldWatchMessage').textContent = error?.message || String(error);
  }
}

async function loadHistory() {
  const msgsEl = $('messages');
  msgsEl.innerHTML = '<div id="empty" class="empty">Loading…</div>';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'chat_history_get' });
    const history = r?.history || [];
    const current = r?.current || null;
    msgsEl.innerHTML = '';
    if (!history.length && !current) {
      msgsEl.innerHTML = '<div id="empty" class="empty">No conversation yet. Ask Sydney something.</div>';
      return;
    }
    for (const m of history) appendMessage(m.role, m.text);
    if (current) {
      appendMessage('user', current.userText);
      _currentRequestId = current.requestId;
      _currentAssistantEl = appendMessage('assistant', current.assistantText || '…');
    }
  } catch (e) {
    msgsEl.innerHTML = `<div class="empty">Couldn't load history: ${e?.message || String(e)}</div>`;
  }
}

function startNewAssistantBubble() {
  _currentAssistantEl = appendMessage('assistant', '');
}

function appendToken(text) {
  if (!_currentAssistantEl) startNewAssistantBubble();
  if (_currentAssistantEl.textContent === '…') _currentAssistantEl.textContent = '';
  _currentAssistantEl.textContent += text;
  const msgsEl = $('messages');
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function appendToolLine(name, preview = null) {
  if (!_currentAssistantEl) startNewAssistantBubble();
  const line = document.createElement('div');
  line.className = 'tool-line';
  line.textContent = preview ? `↳ ${name}: ${String(preview).slice(0, 100)}` : `[${name}…]`;
  _currentAssistantEl.appendChild(line);
  const msgsEl = $('messages');
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function sendChat(text) {
  const t = String(text || '').trim();
  if (!t) return;
  appendMessage('user', t);
  $('chatInput').value = '';
  _currentRequestId = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _currentAssistantEl = null;
  startNewAssistantBubble();
  _currentAssistantEl.textContent = '…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'chat_send', requestId: _currentRequestId, text: t });
    if (!r?.ok) {
      _currentAssistantEl.textContent = `[error: ${r?.error || 'send failed'}]`;
    }
  } catch (e) {
    _currentAssistantEl.textContent = `[error: ${e?.message || String(e)}]`;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.requestId !== _currentRequestId) return;
  if (msg.type === 'voice_transcript') {
    if (_voiceUserEl) _voiceUserEl.textContent = `🎙️ ${msg.transcript}`;
    if (!_currentAssistantEl) {
      _currentAssistantEl = appendMessage('assistant', '…');
    }
  } else if (msg.type === 'chat_event') {
    const ev = msg.event || {};
    if (ev.type === 'token' && typeof ev.text === 'string') appendToken(ev.text);
    else if (ev.type === 'tool_call') appendToolLine(ev.name);
    else if (ev.type === 'tool_result') appendToolLine(ev.name, ev.preview || ev.text);
    else if (ev.type === 'error') appendToken(`\n[error: ${ev.message || 'unknown'}]`);
  } else if (msg.type === 'chat_done') {
    _currentRequestId = null;
    _currentAssistantEl = null;
    _voiceUserEl = null;
  } else if (msg.type === 'chat_error') {
    appendToken(`\n[server error: ${msg.message || 'unknown'}]`);
    _currentRequestId = null;
    _currentAssistantEl = null;
    _voiceUserEl = null;
  }
});

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function resetVoiceButton() {
  const button = $('pushToTalk');
  button.classList.remove('recording');
  button.textContent = '🎙️ Talk';
  button.title = 'The microphone is active only while recording.';
}

async function finishVoiceRecording() {
  clearTimeout(_voiceStopTimer);
  _voiceStopTimer = null;
  const recorder = _voiceRecorder;
  const stream = _voiceStream;
  const chunks = _voiceChunks;
  _voiceRecorder = null;
  _voiceStream = null;
  _voiceChunks = [];
  stream?.getTracks().forEach(track => track.stop());
  resetVoiceButton();
  if (!chunks.length) {
    appendMessage('assistant', 'No microphone audio was captured.');
    return;
  }
  const mimeType = recorder?.mimeType || chunks[0]?.type || 'audio/webm';
  const blob = new Blob(chunks, { type: mimeType });
  if (!blob.size || blob.size > 925_000) {
    appendMessage('assistant', 'That recording was too large. Keep voice messages under 12 seconds.');
    return;
  }
  _currentRequestId = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _currentAssistantEl = null;
  _voiceUserEl = appendMessage('user', '🎙️ Transcribing…');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'voice_send',
      requestId: _currentRequestId,
      mimeType,
      base64: arrayBufferToBase64(await blob.arrayBuffer()),
      lang: navigator.language || '',
    });
    if (!response?.ok) throw new Error(response?.error || 'voice send failed');
  } catch (error) {
    appendMessage('assistant', `[voice error: ${error?.message || String(error)}]`);
    _currentRequestId = null;
    _voiceUserEl = null;
  }
}

async function togglePushToTalk() {
  if (_voiceRecorder) {
    if (_voiceRecorder.state !== 'inactive') _voiceRecorder.stop();
    return;
  }
  if (_currentRequestId) {
    appendMessage('assistant', 'Wait for the current reply to finish before recording another message.');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    appendMessage('assistant', 'Microphone recording is not available in this browser.');
    return;
  }
  try {
    _voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferred = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']
      .find(type => MediaRecorder.isTypeSupported?.(type));
    _voiceChunks = [];
    _voiceRecorder = new MediaRecorder(_voiceStream, preferred ? { mimeType: preferred } : undefined);
    _voiceRecorder.addEventListener('dataavailable', event => { if (event.data?.size) _voiceChunks.push(event.data); });
    _voiceRecorder.addEventListener('stop', () => finishVoiceRecording().catch(error => {
      resetVoiceButton();
      appendMessage('assistant', `[voice error: ${error?.message || String(error)}]`);
    }), { once: true });
    _voiceRecorder.start(500);
    $('pushToTalk').classList.add('recording');
    $('pushToTalk').textContent = '■ Stop';
    $('pushToTalk').title = 'Microphone active — click to stop.';
    _voiceStopTimer = setTimeout(() => {
      if (_voiceRecorder?.state !== 'inactive') _voiceRecorder.stop();
    }, 12_000);
  } catch (error) {
    _voiceStream?.getTracks().forEach(track => track.stop());
    _voiceStream = null;
    _voiceRecorder = null;
    resetVoiceButton();
    appendMessage('assistant', `Microphone permission was not granted: ${error?.message || String(error)}`);
  }
}

$('chatSend').addEventListener('click', () => sendChat($('chatInput').value));
$('pushToTalk').addEventListener('click', togglePushToTalk);
$('confirmationApprove').addEventListener('click', async () => {
  if (!_confirmationId) return;
  const id = _confirmationId;
  renderActionConfirmation(null);
  const response = await chrome.runtime.sendMessage({ type: 'confirmation_respond', id, approved: true }).catch(() => null);
  if (!response?.ok) appendMessage('assistant', 'That browser confirmation expired; nothing was done.');
});
$('confirmationDecline').addEventListener('click', async () => {
  if (!_confirmationId) return;
  const id = _confirmationId;
  renderActionConfirmation(null);
  await chrome.runtime.sendMessage({ type: 'confirmation_respond', id, approved: false }).catch(() => {});
});
$('chatClear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'chat_history_clear' });
  $('messages').innerHTML = '<div id="empty" class="empty">Cleared.</div>';
  _currentRequestId = null;
  _currentAssistantEl = null;
});
$('askThisPage').addEventListener('click', async () => {
  // One-shot page ask — background snapshots the active tab and attaches
  // it to the question. No lease is minted; only the popup's explicit
  // Allow button grants OE the ability to act on a tab.
  const q = ($('chatInput').value || '').trim();
  $('chatInput').value = '';
  _currentRequestId = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _currentAssistantEl = null;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'ask_page_oneshot', requestId: _currentRequestId, question: q });
    if (!r?.ok) {
      appendMessage('assistant', `[error: ${r?.error || 'ask failed'}]`);
      _currentRequestId = null;
      return;
    }
    // Mirror the display line background stored in chat history.
    appendMessage('user', `📄 [${r.title || 'this page'}] ${r.question || q}`);
    startNewAssistantBubble();
    _currentAssistantEl.textContent = '…';
  } catch (e) {
    appendMessage('assistant', `[error: ${e?.message || String(e)}]`);
    _currentRequestId = null;
  }
});
$('askScreenshot').addEventListener('click', async () => {
  const q = ($('chatInput').value || '').trim();
  $('chatInput').value = '';
  _currentRequestId = `ss_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _currentAssistantEl = null;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'ask_screenshot_oneshot', requestId: _currentRequestId, question: q });
    if (!r?.ok) {
      appendMessage('assistant', `[error: ${r?.error || 'screenshot ask failed'}]`);
      _currentRequestId = null;
      return;
    }
    appendMessage('user', `🖼️ [${r.title || 'visible viewport'}] ${r.question || q}`);
    startNewAssistantBubble();
    _currentAssistantEl.textContent = '…';
  } catch (e) {
    appendMessage('assistant', `[error: ${e?.message || String(e)}]`);
    _currentRequestId = null;
  }
});
$('clipThisPage').addEventListener('click', async () => {
  $('clipThisPage').disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'clip_prepare' });
    if (!result?.ok) throw new Error(result?.error || 'could not capture the page');
    await openClipPicker(result.capture);
  } catch (error) {
    appendMessage('assistant', `[clip error: ${error?.message || String(error)}]`);
  } finally {
    $('clipThisPage').disabled = false;
  }
});
$('clipTarget').addEventListener('change', () => {
  $('clipNewNameRow').hidden = $('clipTarget').value !== 'new';
  if (!$('clipNewNameRow').hidden) $('clipNewName').focus();
});
$('clipCancel').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clip_pending_cancel' }).catch(() => {});
  $('clipPicker').hidden = true;
});
$('clipSave').addEventListener('click', async () => {
  const targetId = $('clipTarget').value;
  const newDocumentName = $('clipNewName').value.trim();
  if (targetId === 'new' && !newDocumentName) {
    $('clipMessage').textContent = 'Name the new project document first.';
    $('clipNewName').focus();
    return;
  }
  $('clipSave').disabled = true;
  $('clipMessage').textContent = 'Saving a new document version…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'clip_save', targetId, newDocumentName });
    if (!response?.ok) throw new Error(response?.error || 'save failed');
    $('clipPicker').hidden = true;
    $('clipNewName').value = '';
    appendMessage('assistant', `Saved the clip to ${response.result?.label || 'OE'} (version ${response.result?.version || 'new'}).`);
  } catch (error) {
    $('clipMessage').textContent = error?.message || String(error);
  } finally {
    $('clipSave').disabled = false;
  }
});
$('compareTabs').addEventListener('click', async () => {
  const list = $('tabPickerList');
  list.replaceChildren();
  const tabs = await chrome.tabs.query({ currentWindow: true });
  for (const tab of tabs) {
    const web = /^https?:\/\//i.test(tab.url || '');
    const label = document.createElement('label');
    label.className = 'tab-choice';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(tab.id);
    checkbox.disabled = !web;
    const details = document.createElement('span');
    const title = document.createElement('span');
    title.textContent = tab.title || tab.url || 'Untitled tab';
    const host = document.createElement('small');
    try { host.textContent = new URL(tab.url).host; } catch { host.textContent = 'Browser-internal page (unavailable)'; }
    details.append(title, host);
    label.append(checkbox, details);
    list.appendChild(label);
  }
  $('tabPicker').hidden = false;
});
$('tabPickerCancel').addEventListener('click', () => { $('tabPicker').hidden = true; });
$('tabPickerCompare').addEventListener('click', async () => {
  const tabIds = [...$('tabPickerList').querySelectorAll('input:checked')].map(el => Number(el.value));
  if (tabIds.length < 2) {
    appendMessage('assistant', 'Choose at least two tabs to compare.');
    return;
  }
  $('tabPicker').hidden = true;
  const q = ($('chatInput').value || '').trim();
  $('chatInput').value = '';
  _currentRequestId = `tabs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _currentAssistantEl = null;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'compare_tabs_oneshot', requestId: _currentRequestId, tabIds, question: q });
    if (!r?.ok) {
      appendMessage('assistant', `[error: ${r?.error || 'tab comparison failed'}]`);
      _currentRequestId = null;
      return;
    }
    appendMessage('user', `🗂️ Compare ${r.count} selected tabs: ${r.question}`);
    startNewAssistantBubble();
    _currentAssistantEl.textContent = '…';
  } catch (e) {
    appendMessage('assistant', `[error: ${e?.message || String(e)}]`);
    _currentRequestId = null;
  }
});
$('sendToDevice').addEventListener('click', async () => {
  $('handoffPicker').hidden = false;
  $('handoffTargets').replaceChildren();
  $('handoffMessage').textContent = 'Loading your devices…';
  $('handoffSend').disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'handoff_targets' });
    if (!response?.ok) throw new Error(response?.error || 'could not load devices');
    const targets = response.targets || [];
    for (const target of targets) {
      const capability = target.capabilities?.[0];
      if (!capability) continue;
      const label = document.createElement('label');
      label.className = 'handoff-choice';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'handoffTarget';
      radio.value = String(target.id);
      radio.dataset.mode = String(capability.mode);
      radio.disabled = !target.online;
      const details = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = target.name || (target.kind === 'tv' ? 'TV' : 'Speaker');
      const description = document.createElement('small');
      description.textContent = target.online ? capability.label : `${capability.label} · offline`;
      details.append(name, description);
      label.append(radio, details);
      $('handoffTargets').appendChild(label);
    }
    const first = $('handoffTargets').querySelector('input:not(:disabled)');
    if (first) first.checked = true;
    $('handoffMessage').textContent = first ? 'Choose exactly one destination.' : 'No handoff-capable device is online.';
    $('handoffSend').disabled = !first;
  } catch (error) {
    $('handoffMessage').textContent = error?.message || String(error);
  }
});
$('handoffCancel').addEventListener('click', () => { $('handoffPicker').hidden = true; });
$('handoffSend').addEventListener('click', async () => {
  const selected = $('handoffTargets').querySelector('input:checked');
  if (!selected) { $('handoffMessage').textContent = 'Choose a device first.'; return; }
  $('handoffSend').disabled = true;
  $('handoffMessage').textContent = 'Capturing and sending a bounded excerpt…';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'handoff_send',
      targetId: selected.value,
      mode: selected.dataset.mode,
    });
    if (!response?.ok) throw new Error(response?.error || 'handoff failed');
    $('handoffPicker').hidden = true;
    const result = response.result || {};
    appendMessage('assistant', result.mode === 'read_aloud'
      ? `Reading a short excerpt on ${result.targetName || 'the speaker'}.`
      : `Displayed a page card on ${result.targetName || 'the TV'}.`);
  } catch (error) {
    $('handoffMessage').textContent = error?.message || String(error);
  } finally {
    $('handoffSend').disabled = false;
  }
});
$('watchField').addEventListener('click', () => openFieldWatchPanel());
$('fieldWatchClose').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'field_watch_picker_cancel' }).catch(() => {});
  $('fieldWatchPanel').hidden = true;
  $('fieldWatchPick').disabled = false;
});
$('fieldWatchPick').addEventListener('click', async () => {
  $('fieldWatchPick').disabled = true;
  renderFieldWatchSelection(null);
  $('fieldWatchMessage').textContent = 'Click the exact value on the page. Press Escape to cancel.';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'field_watch_picker_start' });
    if (!response?.ok) throw new Error(response?.error || 'field picker could not start');
  } catch (error) {
    $('fieldWatchMessage').textContent = error?.message || String(error);
    $('fieldWatchPick').disabled = false;
  }
});
$('fieldWatchPredicate').addEventListener('change', () => {
  const changed = $('fieldWatchPredicate').value === 'changed';
  $('fieldWatchTargetRow').hidden = changed;
  if (!changed) $('fieldWatchTarget').focus();
});
$('fieldWatchCreateButton').addEventListener('click', async () => {
  if (!_fieldWatchSelection) { $('fieldWatchMessage').textContent = 'Pick a field first.'; return; }
  if (!$('fieldWatchConfirm').checked) {
    $('fieldWatchMessage').textContent = 'Confirm the exact URL and field standing permission first.';
    return;
  }
  const predicateType = $('fieldWatchPredicate').value;
  const target = $('fieldWatchTarget').value.trim();
  if (predicateType !== 'changed' && !target) {
    $('fieldWatchMessage').textContent = 'Enter the target value for this alert.';
    $('fieldWatchTarget').focus();
    return;
  }
  $('fieldWatchCreateButton').disabled = true;
  $('fieldWatchMessage').textContent = 'Saving the exact-field standing permission…';
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'field_watch_create',
      confirmed: true,
      label: $('fieldWatchLabel').value.trim(),
      predicate: { type: predicateType, target },
      cadenceSec: Number($('fieldWatchCadence').value),
    });
    if (!response?.ok) throw new Error(response?.error || 'field watch could not be created');
    const label = response.watch?.label || $('fieldWatchLabel').value.trim() || 'Field watch';
    renderFieldWatchSelection(null);
    $('fieldWatchLabel').value = '';
    $('fieldWatchTarget').value = '';
    $('fieldWatchPredicate').value = 'changed';
    $('fieldWatchTargetRow').hidden = true;
    $('fieldWatchMessage').textContent = `Watching “${label}”. Two matching readings are required before OE notifies you.`;
    await refreshFieldWatches();
  } catch (error) {
    $('fieldWatchMessage').textContent = error?.message || String(error);
  } finally {
    $('fieldWatchCreateButton').disabled = false;
  }
});
$('suggestionWhy').addEventListener('click', async () => {
  $('suggestionWhy').disabled = true;
  $('suggestionReason').textContent = 'Checking against your project…';
  $('suggestionDetails').hidden = false;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'suggestion_open' });
    if (!response?.ok || !response.suggestion) throw new Error(response?.error || 'suggestion is no longer relevant');
    _suggestionId = response.suggestion.id;
    $('suggestionReason').textContent = response.suggestion.reason || `This may relate to ${response.suggestion.projectLabel || 'one of your projects'}.`;
  } catch (error) {
    $('suggestionReason').textContent = error?.message || String(error);
    _suggestionId = null;
  } finally {
    $('suggestionWhy').disabled = false;
  }
});

async function respondToSuggestion(action) {
  if (!_suggestionId) return;
  for (const id of ['suggestionRemember', 'suggestionIgnore', 'suggestionForget']) $(id).disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'suggestion_respond', matcherId: _suggestionId, action,
    });
    if (!response?.ok) throw new Error(response?.error || 'could not update the suggestion');
    if (action === 'remember') {
      $('suggestionReason').textContent = 'Remembered. OE may also notice related pages on this same site for this project.';
    } else {
      renderSuggestionAvailable(false);
    }
  } catch (error) {
    $('suggestionReason').textContent = error?.message || String(error);
  } finally {
    for (const id of ['suggestionRemember', 'suggestionIgnore', 'suggestionForget']) $(id).disabled = false;
  }
}

$('suggestionRemember').addEventListener('click', () => respondToSuggestion('remember'));
$('suggestionIgnore').addEventListener('click', () => respondToSuggestion('not_relevant'));
$('suggestionForget').addEventListener('click', () => respondToSuggestion('forget'));
$('teachThisSite').addEventListener('click', async () => {
  $('teachThisSite').disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: _teachActive ? 'teach_stop' : 'teach_start' });
    if (!response?.ok) throw new Error(response?.error || 'Teach Mode could not change state');
    _teachActive = !_teachActive;
    appendMessage('assistant', _teachActive
      ? `Teach Mode is observing only “${response.title || 'this site'}” for 15 minutes. Sensitive values are redacted; changing sites or pressing Stop ends it.`
      : 'Teach Mode stopped and its observation buffer was erased.');
  } catch (error) {
    appendMessage('assistant', `[Teach Mode error: ${error?.message || String(error)}]`);
  } finally {
    $('teachThisSite').disabled = false;
    await refreshTeachState();
  }
});
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat($('chatInput').value); }
});
window.addEventListener('pagehide', () => {
  clearTimeout(_voiceStopTimer);
  _voiceStopTimer = null;
  _voiceStream?.getTracks().forEach(track => track.stop());
});

(async () => {
  await loadHistory();
  await refreshStatus();
  await refreshSuggestion();
  await refreshTeachState();
  await refreshActionConfirmation();
  try {
    const pending = await chrome.runtime.sendMessage({ type: 'clip_pending_get' });
    if (pending?.capture) await openClipPicker(pending.capture);
  } catch {}
  setInterval(() => { refreshStatus(); refreshSuggestion(); refreshTeachState(); refreshActionConfirmation(); }, 4000);
})();
