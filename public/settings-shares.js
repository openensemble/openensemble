// Account-owned SMB/NFS connections. Passwords go directly to the authenticated
// API, never through chat messages, browser storage, or a saved UI record.
async function shareSettingsRequest(action, body) {
  const response = await fetch(`/api/network-shares${action ? '/' + action : ''}`, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.setup?.message || data.error || 'Share operation failed.');
  return data;
}

async function loadNetworkShares() {
  const list = $('networkSharesList');
  if (!list) return;
  // Check host support independently so a failed NAS does not hide setup help.
  let support = $('networkShareSupport');
  if (!support) {
    support = document.createElement('p'); support.id = 'networkShareSupport';
    support.className = 'network-share-note'; support.setAttribute('role', 'status');
    list.before(support);
  }
  shareSettingsRequest('setup').then(result => {
    support.textContent = result.ready ? '' : result.message;
    support.hidden = result.ready;
  }).catch(() => { support.textContent = 'Could not check network-share support. Ask OE to check its setup.'; support.hidden = false; });
  try {
    const { shares } = await shareSettingsRequest('');
    list.innerHTML = shares.length ? shares.map(share => `
      <div class="network-share-card">
        <div class="network-share-heading"><strong>${escHtml(share.name)}</strong><span>${share.connected ? 'Connected' : 'Disconnected'} · ${escHtml(share.protocol.toUpperCase())}${share.readOnly ? ' · Read only' : ''}</span></div>
        <div class="network-share-location">${escHtml(share.location)}</div>
        <div class="network-share-note">${share.autoMount === false ? 'Automatic mounting is off. Connect to enable it.' : 'Mounts automatically when OE starts.'}</div>
        <div class="network-share-actions">
          <button class="btn-sm" data-action="browseNetworkShare" data-args='${escHtml(JSON.stringify([share.id, '', 0]))}'>Browse</button>
          <button class="btn-sm" data-action="setNetworkShareConnection" data-args='${escHtml(JSON.stringify([share.id, !share.connected, false]))}'>${share.connected ? 'Disconnect' : 'Connect'}</button>
          <button class="btn-sm" data-action="setNetworkShareConnection" data-args='${escHtml(JSON.stringify([share.id, false, true]))}'>Forget</button>
        </div>
      </div>`).join('') : '<p class="network-share-note">No network shares connected yet.</p>';
  } catch (e) { list.textContent = e.message; }
}

function toggleNetworkShareProtocol() {
  const nfs = /^(?:nfs:\/\/|(?:\[[^\]]+\]|[^/:]+):\/(?!\/))/i.test($('networkShareLocation')?.value.trim() || '');
  $('networkShareSmbFields').hidden = nfs;
  $('networkShareNfsFields').hidden = !nfs;
}

async function connectNetworkShareSettings() {
  const status = $('networkShareStatus'), button = $('networkShareConnect');
  const location = $('networkShareLocation').value.trim();
  const name = $('networkShareName').value.trim();
  const nfs = /^(?:nfs:\/\/|(?:\[[^\]]+\]|[^/:]+):\/(?!\/))/i.test(location);
  const body = { location, name, read_only: $('networkShareReadOnly').checked };
  if (nfs) body.version = Number($('networkShareVersion').value);
  const username = $('networkShareUsername').value.trim();
  if (!nfs && !username && $('networkSharePassword').value) { status.textContent = 'Enter a username with this password.'; return; }
  if (!nfs && username) body.credentials = { username, password: $('networkSharePassword').value, domain: $('networkShareDomain').value.trim() };
  $('networkSharePassword').value = '';
  status.textContent = 'Connecting…'; button.disabled = true;
  try {
    const result = await shareSettingsRequest('connect', body);
    status.textContent = `Connected to ${result.name}. You can ask about it in chat.`;
    await loadNetworkShares();
  } catch (e) { status.textContent = e.message; }
  finally { button.disabled = false; }
}

async function setNetworkShareConnection(id, connect, forget) {
  const status = $('networkShareStatus');
  if (forget && !confirm('Forget this connection and its unused saved login? Files on the server stay in place.')) return;
  status.textContent = connect ? 'Connecting…' : 'Disconnecting…';
  try {
    await shareSettingsRequest(connect ? 'connect' : 'disconnect', { share_id: id, forget });
    status.textContent = forget ? 'Connection forgotten.' : connect ? 'Connected.' : 'Disconnected.';
    $('networkShareBrowser').replaceChildren();
    await loadNetworkShares();
  } catch (e) { status.textContent = e.message; }
}

async function discoverNetworkSharesSettings() {
  const status = $('networkShareDiscovery');
  status.textContent = 'Looking for shared folders…';
  try {
    const data = await shareSettingsRequest('discover', { server: $('networkShareServer').value.trim() });
    status.replaceChildren();
    for (const protocol of ['smb', 'nfs']) {
      const result = data[protocol];
      if (!result) continue;
      const heading = document.createElement('p');
      heading.textContent = `${protocol.toUpperCase()}: ${result.error || (result.shares.length ? '' : 'No advertised shares.')}`;
      status.appendChild(heading);
      for (const share of result.shares || []) {
        const button = document.createElement('button');
        button.className = 'btn-sm';
        button.textContent = share.location;
        button.addEventListener('click', () => { $('networkShareLocation').value = share.location; toggleNetworkShareProtocol(); $('networkShareLocation').focus(); });
        status.appendChild(button);
      }
      if (result.hint) { const hint = document.createElement('p'); hint.textContent = result.hint; status.appendChild(hint); }
    }
  } catch (e) { status.textContent = e.message; }
}

async function browseNetworkShare(id, folder = '', offset = 0) {
  const browser = $('networkShareBrowser');
  browser.textContent = 'Opening folder…';
  try {
    const data = await shareSettingsRequest('list', { share_id: id, path: folder, offset });
    browser.innerHTML = `<strong>${escHtml(data.share.name)} / ${escHtml(folder)}</strong><p class="network-share-note">Ask in chat to read files or copy them between this share and your OE folders.</p>`;
    if (folder || offset) {
      const back = document.createElement('button'); back.className = 'btn-sm'; back.textContent = offset ? 'First page' : 'Up a folder';
      back.addEventListener('click', () => browseNetworkShare(id, offset ? folder : folder.split('/').slice(0, -1).join('/')));
      browser.appendChild(back);
    }
    for (const entry of data.entries) {
      const row = document.createElement(entry.type === 'directory' ? 'button' : 'div');
      row.className = 'network-share-entry';
      row.textContent = `${entry.type === 'directory' ? '📁' : entry.type === 'symlink' ? '↗' : '📄'} ${entry.name}${entry.type === 'file' ? ` · ${entry.size.toLocaleString()} bytes` : ''}`;
      if (entry.type === 'directory') row.addEventListener('click', () => browseNetworkShare(id, entry.path));
      browser.appendChild(row);
    }
    if (!data.entries.length) { const empty = document.createElement('p'); empty.textContent = 'This folder is empty.'; browser.appendChild(empty); }
    if (data.nextOffset !== null) {
      const next = document.createElement('button'); next.className = 'btn-sm'; next.textContent = 'Next page';
      next.addEventListener('click', () => browseNetworkShare(id, folder, data.nextOffset)); browser.appendChild(next);
    }
    await loadNetworkShares();
  } catch (e) { browser.textContent = e.message; }
}
