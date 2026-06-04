const POPUP_VERSION = '0.1.0-r2';
console.log(`[OE Bridge popup] script loaded version=${POPUP_VERSION}`);

const $ = (id) => document.getElementById(id);

// Populate the input fields exactly once at popup open. The 3-second
// refresh loop only updates the STATUS pill — it must NOT touch the
// input fields, otherwise the user can't finish typing the server URL
// (every refresh overwrites the half-typed value with the empty stored
// value).
let _fieldsPopulated = false;

function populateFields(config) {
  if (_fieldsPopulated || !config) return;
  $('serverUrl').value = config.serverUrl || '';
  $('token').value     = config.token     || '';
  $('name').value      = config.name      || '';
  _fieldsPopulated = true;
}

function renderStatus(status) {
  const el = $('status');
  if (status.connected) {
    el.className = 'status ok';
    const since = status.since ? new Date(status.since).toLocaleTimeString() : '?';
    el.innerHTML = `Connected as <code>${status.userId ?? '?'}</code><div class="meta">extId: ${status.extId ?? '?'}<br>since: ${since}<br>server: ${status.server ?? ''}</div>`;
  } else if (status.lastError) {
    el.className = 'status bad';
    el.innerHTML = `<b>Disconnected</b><div class="meta">${status.lastError}</div>`;
  } else {
    el.className = 'status idle';
    el.textContent = 'Waiting for config…';
  }
}

async function refresh() {
  const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
  if (!resp) return;
  populateFields(resp.config);   // no-op after first call
  renderStatus(resp.status);
}

function showError(text) {
  const el = $('status');
  el.className = 'status bad';
  el.innerHTML = `<b>Popup error</b><div class="meta">${text}</div>`;
}

$('save').addEventListener('click', async () => {
  const config = {
    serverUrl: $('serverUrl').value.trim(),
    token:     $('token').value.trim(),
    name:      $('name').value.trim(),
  };
  if (!config.serverUrl) return showError('Server URL is required (e.g. http://localhost:3737).');
  if (!config.token)     return showError('Auth token is required. Open the OE setup-token URL in a logged-in tab to get it.');
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'save_config', config });
    if (!resp || resp.ok !== true) {
      showError(`Save returned: ${JSON.stringify(resp || null)}. The background service worker may be inactive — reload the extension.`);
      return;
    }
    setTimeout(refresh, 500);
  } catch (e) {
    showError(`Couldn't reach the background service worker: ${e?.message || String(e)}. Reload the extension at chrome://extensions.`);
  }
});

$('reconnect').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'reconnect' });
    setTimeout(refresh, 500);
  } catch (e) {
    showError(`Reconnect failed: ${e?.message || String(e)}.`);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'status') renderStatus(msg.status);
});

refresh();
setInterval(refresh, 3000);
