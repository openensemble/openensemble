const $ = (id) => document.getElementById(id);

function render(status, config) {
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
  if (config) {
    $('serverUrl').value = config.serverUrl || '';
    $('token').value     = config.token     || '';
    $('name').value      = config.name      || '';
  }
}

async function refresh() {
  const resp = await chrome.runtime.sendMessage({ type: 'get_status' });
  if (resp) render(resp.status, resp.config);
}

$('save').addEventListener('click', async () => {
  const config = {
    serverUrl: $('serverUrl').value.trim(),
    token:     $('token').value.trim(),
    name:      $('name').value.trim(),
  };
  await chrome.runtime.sendMessage({ type: 'save_config', config });
  setTimeout(refresh, 500);
});

$('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(refresh, 500);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'status') render(msg.status);
});

refresh();
setInterval(refresh, 3000);
