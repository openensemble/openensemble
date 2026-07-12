import {
  buildDiscoveryCandidates,
  claimBrowserPairing,
  discoverPairingService,
  generatePairingKeypair,
  requestBrowserPairing,
} from './pairing.js';

const POPUP_VERSION = chrome.runtime.getManifest().version;
console.log(`[OE Bridge popup] script loaded version=${POPUP_VERSION}`);

const $ = (id) => document.getElementById(id);

// Populate the input fields exactly once at popup open. The 3-second
// refresh loop only updates the STATUS pill — it must NOT touch the
// input fields, otherwise the user can't finish typing the server URL
// (every refresh overwrites the half-typed value with the empty stored
// value).
let _fieldsPopulated = false;
let _popupConfirmationId = null;

function populateFields(config) {
  if (_fieldsPopulated || !config) return;
  $('serverUrl').value = config.serverUrl || '';
  if (!$('pairingName').value) $('pairingName').value = config.name || defaultBrowserName();
  _fieldsPopulated = true;
}

// ── Browser-bound device-code pairing ──────────────────────────────────
const PENDING_PAIRING_KEY = 'browserPairingPending';
const BROWSER_CREDENTIAL_KEY = 'browserCredential';
const PENDING_CREDENTIAL_KEY = 'pendingBrowserCredential';
let _pairingPending = null;
let _pairingPollTimer = null;
let _pairingPollGeneration = 0;
let _pairingClaimInFlight = false;

function defaultBrowserName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  return platform ? `OE Bridge on ${platform}` : 'OE Bridge';
}

function setPairingMessage(text, isError = false) {
  const target = _pairingPending ? $('pairingPendingMessage') : $('pairingStartMessage');
  if (!target) return;
  target.textContent = text || '';
  target.style.color = isError ? '#8a2424' : '#6b7280';
}

function renderPairingStart() {
  $('pairingStart').hidden = false;
  $('pairingPending').hidden = true;
  $('pairingComplete').hidden = true;
  _pairingPending = null;
}

function renderPendingPairing(pending) {
  _pairingPending = pending;
  $('pairingStart').hidden = true;
  $('pairingPending').hidden = false;
  $('pairingComplete').hidden = true;
  $('pairingCode').textContent = pending.userCode;
  $('pairingServer').textContent = `OE server: ${pending.serverUrl}`;
  $('pairingOpenApproval').hidden = !pending.approvalUrl;
  updatePairingCountdown();
}

function renderPairedCredential(credential) {
  $('pairingStart').hidden = true;
  $('pairingPending').hidden = true;
  $('pairingComplete').hidden = false;
  const who = String(credential?.userName || '').trim();
  $('pairingCompleteLabel').textContent = who ? `Securely paired for ${who}.` : 'Securely paired.';
  if (credential?.browserName) $('pairingName').value = credential.browserName;
}

function updatePairingCountdown() {
  if (!_pairingPending) return;
  const leftMs = Number(_pairingPending.expiresAt) - Date.now();
  if (leftMs <= 0) {
    $('pairingCountdown').textContent = 'This code has expired.';
    return;
  }
  const minutes = Math.floor(leftMs / 60_000);
  const seconds = Math.floor((leftMs % 60_000) / 1000);
  $('pairingCountdown').textContent = `Code expires in ${minutes}:${String(seconds).padStart(2, '0')}. Waiting for approval…`;
}

async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url || '';
  } catch {
    return '';
  }
}

function stopPairingPoll() {
  _pairingPollGeneration++;
  if (_pairingPollTimer) clearTimeout(_pairingPollTimer);
  _pairingPollTimer = null;
}

async function clearPendingPairing() {
  stopPairingPoll();
  _pairingPending = null;
  await chrome.storage.session.remove(PENDING_PAIRING_KEY);
}

async function beginBrowserPairing() {
  const button = $('pairingBegin');
  button.disabled = true;
  setPairingMessage('Looking for OpenEnsemble…');
  try {
    const statusResponse = await chrome.runtime.sendMessage({ type: 'get_status' }).catch(() => null);
    const configuredUrl = statusResponse?.config?.serverUrl || $('serverUrl').value.trim();
    const candidates = buildDiscoveryCandidates({
      explicitUrl: $('serverUrl').value.trim(),
      activeTabUrl: await activeTabUrl(),
      configuredUrl,
    });
    const service = await discoverPairingService({ candidates });
    setPairingMessage('Creating a browser-only identity…');
    const { publicKeyJwk, privateKeyJwk } = await generatePairingKeypair();
    const browserName = $('pairingName').value.trim() || defaultBrowserName();
    const request = await requestBrowserPairing({
      ...service,
      publicKeyJwk,
      browserName,
      extensionVersion: chrome.runtime.getManifest().version,
      sharedProfile: false,
    });
    const pending = {
      schema: 1,
      ...service,
      ...request,
      browserName,
      sharedProfile: false,
      publicKeyJwk,
      privateKeyJwk,
      createdAt: Date.now(),
    };
    // Opening OE closes the popup. Session storage lets pairing resume when
    // the popup is reopened; a browser restart destroys unfinished key data.
    await chrome.storage.session.set({ [PENDING_PAIRING_KEY]: pending });
    renderPendingPairing(pending);
    setPairingMessage('');
    schedulePairingPoll(0);
  } catch (error) {
    renderPairingStart();
    setPairingMessage(error?.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

async function finishApprovedPairing(pending, result) {
  // Background keeps this as a replacement candidate until a signed socket
  // succeeds. A working current browser credential is never overwritten by an
  // unproven replacement.
  const credential = {
    schema: 1,
    serverUrl: pending.serverUrl,
    credentialId: result.credentialId,
    userName: result.userName || '',
    browserName: pending.browserName,
    sharedProfile: Boolean(pending.sharedProfile),
    publicKeyJwk: pending.publicKeyJwk,
    privateKeyJwk: pending.privateKeyJwk,
    pairedAt: Date.now(),
  };
  const accepted = await chrome.runtime.sendMessage({
    type: 'browser_pairing_complete',
    credential,
  });
  if (!accepted?.ok) throw new Error(accepted?.error || 'background could not stage the browser credential');
  await clearPendingPairing();
  renderPairedCredential(credential);
}

async function checkPairingApproval({ manual = false, generation = _pairingPollGeneration } = {}) {
  const pending = _pairingPending;
  if (!pending || generation !== _pairingPollGeneration) return;
  if (_pairingClaimInFlight) {
    if (manual) setPairingMessage('Already checking with OE…');
    return;
  }
  if (Number(pending.expiresAt) <= Date.now()) {
    await clearPendingPairing();
    renderPairingStart();
    setPairingMessage('That pairing code expired. Start again for a new code.', true);
    return;
  }
  const checkButton = $('pairingCheck');
  if (_pairingPollTimer) clearTimeout(_pairingPollTimer);
  _pairingPollTimer = null;
  _pairingClaimInFlight = true;
  if (manual) checkButton.disabled = true;
  try {
    const result = await claimBrowserPairing(pending);
    if (generation !== _pairingPollGeneration) return;
    if (result.status === 'approved') {
      await finishApprovedPairing(pending, result);
      return;
    }
    if (result.status === 'denied' || result.status === 'expired') {
      await clearPendingPairing();
      renderPairingStart();
      setPairingMessage(
        result.status === 'denied' ? 'Pairing was declined in OE.' : 'That pairing code expired. Start again for a new code.',
        true,
      );
      return;
    }
    setPairingMessage(manual ? 'Not approved yet. Keep this code open in OE.' : '');
    schedulePairingPoll(result.pollIntervalMs || pending.pollIntervalMs);
  } catch (error) {
    if (generation !== _pairingPollGeneration) return;
    setPairingMessage(`${error?.message || String(error)} Retrying…`, true);
    schedulePairingPoll(Math.max(3_000, pending.pollIntervalMs || 2_000));
  } finally {
    _pairingClaimInFlight = false;
    checkButton.disabled = false;
  }
}

function schedulePairingPoll(delayMs) {
  if (!_pairingPending) return;
  if (_pairingPollTimer) clearTimeout(_pairingPollTimer);
  const generation = _pairingPollGeneration;
  _pairingPollTimer = setTimeout(() => {
    _pairingPollTimer = null;
    checkPairingApproval({ generation });
  }, Math.max(0, Number(delayMs) || 0));
}

async function initializePairing() {
  if (!$('pairingName').value) $('pairingName').value = defaultBrowserName();
  const [local, session] = await Promise.all([
    chrome.storage.local.get([BROWSER_CREDENTIAL_KEY, PENDING_CREDENTIAL_KEY]),
    chrome.storage.session.get(PENDING_PAIRING_KEY),
  ]);
  const pending = session?.[PENDING_PAIRING_KEY];
  if (pending && Number(pending.expiresAt) > Date.now() && pending.privateKeyJwk?.d) {
    renderPendingPairing(pending);
    schedulePairingPoll(0);
    return;
  }
  if (pending) await chrome.storage.session.remove(PENDING_PAIRING_KEY);
  const credential = local?.[PENDING_CREDENTIAL_KEY] || local?.[BROWSER_CREDENTIAL_KEY];
  if (credential?.credentialId && credential?.privateKeyJwk?.d) renderPairedCredential(credential);
  else renderPairingStart();
}

$('pairingBegin').addEventListener('click', beginBrowserPairing);
$('pairingCheck').addEventListener('click', () => checkPairingApproval({ manual: true }));
$('pairingOpenApproval').addEventListener('click', async () => {
  if (_pairingPending?.approvalUrl) await chrome.tabs.create({ url: _pairingPending.approvalUrl });
});
$('pairingCancel').addEventListener('click', async () => {
  await clearPendingPairing();
  renderPairingStart();
  setPairingMessage('Pairing cancelled. Your existing connection was not changed.');
});
$('pairingAgain').addEventListener('click', () => {
  renderPairingStart();
  setPairingMessage('Your current browser credential stays active until a new pairing succeeds.');
});
setInterval(updatePairingCountdown, 1_000);

function renderStatus(status) {
  const el = $('status');
  if (status.connected) {
    el.className = 'status ok';
    const since = status.since ? new Date(status.since).toLocaleTimeString() : '?';
    const userName = typeof status.userName === 'string' ? status.userName.trim() : '';
    el.replaceChildren();
    const label = document.createElement('b');
    label.textContent = userName ? `Connected ${userName}` : 'Connected';
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `extId: ${status.extId ?? '?'}\nsince: ${since}\nserver: ${status.server ?? ''}`;
    meta.style.whiteSpace = 'pre-wrap';
    el.append(label, meta);
  } else if (status.lastError) {
    el.className = 'status bad';
    el.innerHTML = `<b>Disconnected</b><div class="meta">${status.lastError}</div>`;
  } else {
    el.className = 'status idle';
    el.textContent = 'Waiting for config…';
  }
  // Show the chat panel only when connected — no point asking Sydney
  // if the bridge can't reach OE.
  const panel = $('chatPanel');
  if (panel) panel.style.display = status.connected ? 'block' : 'none';
}

function renderPopupConfirmation(confirmation) {
  _popupConfirmationId = confirmation?.id || null;
  $('actionConfirmation').hidden = !_popupConfirmationId;
  if (!_popupConfirmationId) return;
  $('popupConfirmationSummary').textContent = confirmation.summary || 'Allow this browser action once?';
  $('popupConfirmationOrigin').textContent = [confirmation.pageTitle, confirmation.origin].filter(Boolean).join(' · ');
}

$('popupConfirmationApprove').addEventListener('click', async () => {
  if (!_popupConfirmationId) return;
  const id = _popupConfirmationId;
  renderPopupConfirmation(null);
  const response = await chrome.runtime.sendMessage({ type: 'confirmation_respond', id, approved: true }).catch(() => null);
  if (!response?.ok) showError('That confirmation expired; nothing was done.');
});
$('popupConfirmationDecline').addEventListener('click', async () => {
  if (!_popupConfirmationId) return;
  const id = _popupConfirmationId;
  renderPopupConfirmation(null);
  await chrome.runtime.sendMessage({ type: 'confirmation_respond', id, approved: false }).catch(() => {});
});

// ── Capability lease controls ────────────────────────────────────────────
// Grants originate HERE (a click in extension UI) and nowhere else. The
// background broker denies every tab-touching server command without one.
function renderLease(lease) {
  const statusEl = $('leaseStatus');
  const revokeBtn = $('leaseRevoke');
  if (!statusEl || !revokeBtn) return;
  const tabs = (lease && Array.isArray(lease.tabs)) ? lease.tabs : [];
  if (tabs.length) {
    const until = new Date(lease.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const active = tabs.filter(t => !t.suspended).length;
    const paused = tabs.length - active;
    statusEl.innerHTML = `🔓 <b>OE can use ${active} tab${active === 1 ? '' : 's'} until ${until}.</b>` +
      (paused ? ` ${paused} paused (tab left its granted site — press Resume on its banner).` : '') +
      ' Leased tabs show an amber banner.';
    revokeBtn.style.display = 'block';
  } else {
    statusEl.textContent = 'OE has no access to your tabs. Grant a short lease to let it read or act on the current tab.';
    revokeBtn.style.display = 'none';
  }
}

const leaseGrantBtn = $('leaseGrant');
const leaseRevokeBtn = $('leaseRevoke');
if (leaseGrantBtn) leaseGrantBtn.addEventListener('click', async () => {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'grant_lease' });
    if (resp?.ok) renderLease(resp.lease);
    else showError(resp?.error || 'lease grant failed');
  } catch (e) {
    showError(e?.message || String(e));
  }
});
if (leaseRevokeBtn) leaseRevokeBtn.addEventListener('click', async () => {
  try { await chrome.runtime.sendMessage({ type: 'revoke_lease' }); } catch {}
  renderLease(null);
});

// ── Chat with Sydney from the popup ──────────────────────────────────────
let _chatRequestId = null;
function appendReply(text, replace = false) {
  const el = $('chatReply');
  if (!el) return;
  if (replace) el.textContent = text;
  else el.textContent += text;
  el.scrollTop = el.scrollHeight;
}
function setReplyLabel(label) { appendReply(label, true); }

async function sendChat(text) {
  const t = String(text || '').trim();
  if (!t) return;
  setReplyLabel('…');
  const input = $('chatInput');
  if (input) input.value = '';
  _chatRequestId = `pp_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'chat_send', requestId: _chatRequestId, text: t });
    if (!resp?.ok) appendReply(`\n\n[error: ${resp?.error || 'send failed'}]`, true);
  } catch (e) {
    appendReply(`\n\n[error: ${e?.message || String(e)}]`, true);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.requestId !== _chatRequestId) return;
  if (msg.type === 'chat_event') {
    const ev = msg.event || {};
    if (ev.type === 'token' && typeof ev.text === 'string') {
      const el = $('chatReply');
      if (el && el.textContent === '…') el.textContent = '';
      appendReply(ev.text);
    } else if (ev.type === 'tool_call') {
      appendReply(`\n\n[${ev.name}…]\n`);
    } else if (ev.type === 'tool_result') {
      // Tool results are usually long — show a one-line preview, the
      // full text already lands as token events in the next assistant
      // turn anyway.
      const preview = (ev.preview || ev.text || '').slice(0, 120);
      appendReply(`\n  ↳ ${preview}${(ev.text||'').length > 120 ? '…' : ''}\n`);
    } else if (ev.type === 'error') {
      appendReply(`\n\n[error: ${ev.message || 'unknown'}]`);
    }
  } else if (msg.type === 'chat_done') {
    // Final newline so the reply doesn't run into the next user turn.
    appendReply('\n');
  } else if (msg.type === 'chat_error') {
    appendReply(`\n\n[server error: ${msg.message || 'unknown'}]`);
  }
});

const sendBtn = $('chatSend');
const clearBtn = $('chatClear');
const askPageBtn = $('askThisPage');
const chatInput = $('chatInput');
const sidepanelBtn = $('openSidepanel');
if (sendBtn) sendBtn.addEventListener('click', () => sendChat($('chatInput')?.value));
if (clearBtn) clearBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'chat_history_clear' });
  setReplyLabel('');
});
if (askPageBtn) askPageBtn.addEventListener('click', async () => {
  // One-shot: snapshot the page now and send it with the question — no
  // lease is minted. Asking is consent to read this page once, nothing
  // more; only the explicit Allow button grants OE the ability to act.
  // Uses whatever is typed in the chat box as the question, else a default.
  const q = (chatInput?.value || '').trim();
  if (chatInput) chatInput.value = '';
  setReplyLabel('…');
  _chatRequestId = `pp_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'ask_page_oneshot', requestId: _chatRequestId, question: q });
    if (!r?.ok) appendReply(`\n\n[error: ${r?.error || 'ask failed'}]`, true);
  } catch (e) {
    appendReply(`\n\n[error: ${e?.message || String(e)}]`, true);
  }
});
if (sidepanelBtn) sidepanelBtn.addEventListener('click', async () => {
  // chrome.sidePanel.open() needs the user-gesture call stack — delegating
  // to the service worker silently fails. Open directly from the popup's
  // own click event instead.
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    window.close();
  } catch (e) {
    console.error('[popup] sidepanel open failed:', e);
  }
});
if (chatInput) {
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat(chatInput.value);
    }
  });
}

async function refresh() {
  const [resp, confirmation] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'get_status' }),
    chrome.runtime.sendMessage({ type: 'get_pending_confirmation' }).catch(() => null),
  ]);
  if (!resp) return;
  populateFields(resp.config);   // no-op after first call
  renderStatus(resp.status);
  renderLease(resp.lease);
  renderPopupConfirmation(confirmation?.confirmation || null);
}

// On every popup open, restore the saved chat history into the reply
// pane. Without this, closing the popup mid-conversation made all of
// Sydney's previous turns disappear from view (the data still lived
// in background SW storage; the popup just never read it). Now the
// pane shows everything stored, plus any partial current response.
async function loadChatHistoryIntoReply() {
  const replyEl = $('chatReply');
  if (!replyEl) return;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'chat_history_get' });
    if (!r) return;
    const history = r.history || [];
    const current = r.current || null;
    if (!history.length && !current) return;
    const lines = [];
    for (const m of history) {
      lines.push(`${m.role === 'user' ? '› You' : 'Sydney'}: ${m.text}`);
    }
    if (current) {
      lines.push(`› You: ${current.userText}`);
      lines.push(`Sydney: ${current.assistantText || '…'}`);
    }
    replyEl.textContent = lines.join('\n\n');
    replyEl.scrollTop = replyEl.scrollHeight;
  } catch { /* storage unavailable — leave pane empty */ }
}

function showError(text) {
  const el = $('status');
  el.className = 'status bad';
  el.innerHTML = `<b>Popup error</b><div class="meta">${text}</div>`;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'status') renderStatus(msg.status);
  if (msg?.type === 'action_confirmation') renderPopupConfirmation(msg.confirmation);
});

refresh();
setInterval(refresh, 3000);
loadChatHistoryIntoReply();
initializePairing().catch((error) => {
  renderPairingStart();
  setPairingMessage(error?.message || String(error), true);
});
