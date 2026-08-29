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
let _adBlockBusy = false;
let _adBlockReloadHint = false;

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

const AD_BLOCK_TIER_INPUTS = {
  ads: 'adBlockTierAds',
  trackers: 'adBlockTierTrackers',
  annoyances: 'adBlockTierAnnoyances',
};

function renderAdBlock(status) {
  if (!status?.ok) return;
  const enabledInput = $('adBlockEnabled');
  const statusEl = $('adBlockStatus');
  const actions = $('adBlockActions');
  const undo = $('adBlockUndo');
  const clear = $('adBlockClearSite');
  const tiers = $('adBlockTiers');
  const pauseRow = $('adBlockPauseRow');
  const pause = $('adBlockPause');
  statusEl.style.color = '#4b5563';
  enabledInput.checked = status.enabled === true;
  $('adBlockToggleLabel').textContent = status.enabled ? 'On' : 'Off';
  enabledInput.disabled = _adBlockBusy || status.networkAvailable === false;

  const available = status.networkAvailable !== false;
  const paused = status.paused === true;
  const count = Math.max(0, Number(status.learnedSiteCount) || 0);
  const blocked = Math.max(0, Number(status.blockedCount) || 0);

  for (const [tier, id] of Object.entries(AD_BLOCK_TIER_INPUTS)) {
    const input = $(id);
    input.checked = status.tiers?.[tier] === true;
    input.disabled = _adBlockBusy || !status.enabled || !available;
  }
  tiers.hidden = !available;
  pauseRow.hidden = !available || !status.siteHost;
  pause.textContent = paused ? `Resume blocking on ${status.siteHost}` : 'Pause on this site';
  pause.disabled = _adBlockBusy || !status.enabled;

  if (!available) {
    statusEl.textContent = 'This browser does not expose Manifest V3 network filtering.';
  } else if (!status.enabled) {
    statusEl.textContent = 'Off. Turn it on to block ads and trackers and apply anything you teach it.'
      + (_adBlockReloadHint ? ' Reload this page to restore requests that were already blocked.' : '');
  } else if (paused) {
    statusEl.textContent = `Paused on ${status.siteHost}. Nothing is blocked or hidden here until you resume.`
      + (_adBlockReloadHint ? ' Reload this page to apply the change.' : '');
  } else {
    const learned = count
      ? ` ${count} learned rule${count === 1 ? '' : 's'} also apply on ${status.siteHost || 'this site'}.`
      : '';
    const onThisPage = status.countersAvailable && blocked
      ? ` ${blocked} request${blocked === 1 ? '' : 's'} blocked on this page.`
      : '';
    statusEl.textContent = `Blocking locally.${onThisPage}${learned} Right-click anything it misses and choose “Block this ad with OE”.`
      + (_adBlockReloadHint ? ' Reload this page to apply the network setting to every request.' : '');
  }

  renderBlockedDomains(status);

  const filters = status.filters;
  $('adBlockFilterInfo').textContent = filters?.counts
    ? `Filter lists built ${filters.generated} · `
      + `${(filters.counts.tiers?.ads + filters.counts.tiers?.trackers + filters.counts.tiers?.annoyances).toLocaleString()} network rules · `
      + `${filters.counts.siteHosts.toLocaleString()} sites with specific rules`
    : '';

  actions.hidden = count === 0;
  undo.disabled = _adBlockBusy || !status.lastRuleId;
  clear.disabled = _adBlockBusy || count === 0;
}

/**
 * Rebuild the hand-blocked domain list. Rows are built with DOM calls rather
 * than markup so a stored hostname can never be interpreted as HTML.
 */
function renderBlockedDomains(status) {
  const section = $('adBlockDomains');
  const list = $('adBlockDomainList');
  const domains = Array.isArray(status.blockedDomains) ? status.blockedDomains : [];
  section.hidden = status.networkAvailable === false;
  $('adBlockDomainInput').disabled = _adBlockBusy || !status.enabled;
  $('adBlockDomainAdd').querySelector('button').disabled = _adBlockBusy || !status.enabled;

  list.replaceChildren();
  for (const host of domains) {
    const row = document.createElement('li');
    const label = document.createElement('code');
    label.textContent = host;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.disabled = _adBlockBusy || !status.enabled;
    remove.addEventListener('click', () => runAdBlockAction(
      { type: 'set_adblock_domain_blocked', host, blocked: false },
      `Unblocking ${host}…`,
    ));
    row.append(label, remove);
    list.append(row);
  }
}

function showAdBlockError(text) {
  $('adBlockStatus').textContent = text || 'Ad-block settings could not be changed.';
  $('adBlockStatus').style.color = '#8a2424';
}

async function setAdBlockBusy(busy) {
  _adBlockBusy = busy;
  const ids = ['adBlockEnabled', 'adBlockUndo', 'adBlockClearSite', 'adBlockPause',
    'adBlockDomainInput', ...Object.values(AD_BLOCK_TIER_INPUTS)];
  for (const id of ids) $(id).disabled = busy;
  for (const button of $('adBlockDomains').querySelectorAll('button')) button.disabled = busy;
}

/** Shared wrapper for the ad-block controls: keep the panel busy, restore the
 * previous rendering if the worker rejects the change. */
async function runAdBlockAction(message, pending) {
  await setAdBlockBusy(true);
  $('adBlockStatus').style.color = '#4b5563';
  if (pending) $('adBlockStatus').textContent = pending;
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'that change was not applied');
    _adBlockReloadHint = true;
    await setAdBlockBusy(false);
    renderAdBlock(response);
    return true;
  } catch (error) {
    await setAdBlockBusy(false);
    showAdBlockError(error?.message || String(error));
    try {
      const status = await chrome.runtime.sendMessage({ type: 'get_adblock_status' });
      if (status?.ok) {
        const reported = $('adBlockStatus').textContent;
        renderAdBlock(status);
        showAdBlockError(reported);
      }
    } catch {}
    return false;
  }
}

for (const [tier, id] of Object.entries(AD_BLOCK_TIER_INPUTS)) {
  $(id).addEventListener('change', () => runAdBlockAction(
    { type: 'set_adblock_tier', tier, enabled: $(id).checked },
    'Applying…',
  ));
}

$('adBlockDomainAdd').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('adBlockDomainInput');
  // Accept a pasted URL as readily as a bare hostname.
  const raw = input.value.trim().replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].replace(/^www\./i, '');
  if (!raw) return;
  const added = await runAdBlockAction(
    { type: 'set_adblock_domain_blocked', host: raw, blocked: true },
    `Blocking ${raw}…`,
  );
  // Leave a rejected entry in the box so the typo is visible and editable.
  if (added) input.value = '';
});

$('adBlockPause').addEventListener('click', () => {
  const resuming = $('adBlockPause').textContent.startsWith('Resume');
  return runAdBlockAction(
    { type: 'set_adblock_paused', paused: !resuming },
    resuming ? 'Resuming…' : 'Pausing…',
  );
});

$('adBlockEnabled').addEventListener('change', async () => {
  const desired = $('adBlockEnabled').checked;
  $('adBlockToggleLabel').textContent = desired ? 'On' : 'Off';
  await setAdBlockBusy(true);
  $('adBlockStatus').style.color = '#4b5563';
  $('adBlockStatus').textContent = desired ? 'Turning local ad blocking on…' : 'Turning local ad blocking off…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'set_adblock_enabled', enabled: desired });
    if (!response?.ok) throw new Error(response?.error || 'ad-block setting failed');
    _adBlockReloadHint = true;
    await setAdBlockBusy(false);
    renderAdBlock(response);
  } catch (error) {
    await setAdBlockBusy(false);
    $('adBlockEnabled').checked = !desired;
    $('adBlockToggleLabel').textContent = desired ? 'Off' : 'On';
    showAdBlockError(error?.message || String(error));
  }
});

$('adBlockUndo').addEventListener('click', async () => {
  await setAdBlockBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'adblock_undo_last' });
    if (!response?.ok) throw new Error(response?.error || 'undo failed');
    await setAdBlockBusy(false);
    renderAdBlock(response);
  } catch (error) {
    await setAdBlockBusy(false);
    showAdBlockError(error?.message || String(error));
  }
});

$('adBlockClearSite').addEventListener('click', async () => {
  if (!confirm('Remove every ad rule OE learned for this site?')) return;
  await setAdBlockBusy(true);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'adblock_clear_site' });
    if (!response?.ok) throw new Error(response?.error || 'clear failed');
    await setAdBlockBusy(false);
    renderAdBlock(response);
  } catch (error) {
    await setAdBlockBusy(false);
    showAdBlockError(error?.message || String(error));
  }
});

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
  const [resp, confirmation, adBlock] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'get_status' }),
    chrome.runtime.sendMessage({ type: 'get_pending_confirmation' }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'get_adblock_status' }).catch(() => null),
  ]);
  if (!resp) return;
  populateFields(resp.config);   // no-op after first call
  renderStatus(resp.status);
  renderLease(resp.lease);
  renderPopupConfirmation(confirmation?.confirmation || null);
  if (!_adBlockBusy && adBlock?.ok) {
    $('adBlockStatus').style.color = '#4b5563';
    renderAdBlock(adBlock);
  }
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
