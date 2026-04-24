// ── Remote Nodes ──────────────────────────────────────────────────────────────

let _nodesRefreshTimer = null;
let _nodesList = [];
let _termWindows = {};  // nodeId → Window reference

const PKG_COMMANDS = {
  apt:    { update: 'sudo apt update && sudo apt upgrade -y', install: 'sudo apt install -y' },
  pacman: { update: 'sudo pacman -Syu --noconfirm',          install: 'sudo pacman -S --noconfirm' },
  dnf:    { update: 'sudo dnf upgrade -y',                   install: 'sudo dnf install -y' },
  yum:    { update: 'sudo yum update -y',                    install: 'sudo yum install -y' },
  zypper: { update: 'sudo zypper update -y',                 install: 'sudo zypper install -y' },
  apk:    { update: 'sudo apk upgrade',                      install: 'sudo apk add' },
  brew:   { update: 'brew update && brew upgrade',            install: 'brew install' },
  nix:    { update: 'nix-channel --update && nix-env -u',     install: 'nix-env -iA nixpkgs.' },
  winget: { update: 'winget upgrade --all --accept-source-agreements', install: 'winget install' },
  choco:  { update: 'choco upgrade all -y',                   install: 'choco install -y' },
  scoop:  { update: 'scoop update *',                         install: 'scoop install' },
};

const REBOOT_COMMANDS = { win32: 'Restart-Computer -Force', default: 'sudo reboot' };
const SHUTDOWN_COMMANDS = { win32: 'Stop-Computer -Force', default: 'sudo shutdown -h now' };

const ACCESS_BADGES = {
  full:       { label: 'Full Access',  cls: 'red' },
  sysadmin:   { label: 'System Admin', cls: 'orange' },
  updates:    { label: 'Updates',      cls: 'green' },
  monitoring: { label: 'Monitor Only', cls: 'blue' },
  nosudo:     { label: 'No Sudo',      cls: '' },
  unknown:    { label: 'Unknown',      cls: '' },
};

function accessBadge(level, nodeId, locked) {
  const info = ACCESS_BADGES[level] || ACCESS_BADGES.unknown;
  const lockIcon = locked ? ' &#x1F512;' : '';
  const title = locked
    ? 'Access level is LOCKED — change via SSH only'
    : 'Click to change access level';
  return `<span class="cdraw-badge access-badge-click ${info.cls ? 'access-' + info.cls : ''}" onclick="changeNodeAccess('${nodeId}')" title="${title}">${info.label}${lockIcon}</span>`;
}

function versionBadge(version, latestVersion, outdated) {
  if (!version || version === 'unknown') {
    return `<span class="cdraw-badge" title="Agent did not report a version — upgrade recommended">v?</span>`;
  }
  if (outdated) {
    return `<span class="cdraw-badge yellow" title="Agent is outdated. Latest: v${latestVersion}. Click 'Upgrade Agent' to update.">v${escHtml(version)} &rarr; v${escHtml(latestVersion)}</span>`;
  }
  return `<span class="cdraw-badge" title="Agent is up to date">v${escHtml(version)}</span>`;
}

function canDo(level, action) {
  const perms = {
    update:   ['updates', 'sysadmin', 'full', 'unknown'],
    install:  ['updates', 'sysadmin', 'full', 'unknown'],
    restart:  ['updates', 'sysadmin', 'full'],
    shutdown: ['updates', 'sysadmin', 'full'],
  };
  return (perms[action] || []).includes(level || 'unknown');
}

function platformIcon(platform) {
  if (platform === 'win32') return '&#x1FA9F;'; // window emoji
  if (platform === 'darwin') return '&#x1F34E;'; // apple
  return '&#x1F427;'; // penguin
}

function healthBadge(health) {
  const map = {
    healthy:      '<span class="cdraw-badge green">Connected</span>',
    stale:        '<span class="cdraw-badge yellow node-pulse">Not Responding</span>',
    disconnected: '<span class="cdraw-badge red">Offline</span>',
    recovered:    '<span class="cdraw-badge accent">Recovered</span>',
  };
  return map[health] || '<span class="cdraw-badge">Unknown</span>';
}

function healthDot(health) {
  const colors = { healthy: 'var(--green)', stale: 'var(--yellow)', disconnected: 'var(--red)', recovered: 'var(--accent)' };
  const color = colors[health] || 'var(--muted)';
  const cls = health === 'stale' ? ' node-pulse' : '';
  return `<span class="node-dot${cls}" style="background:${color}"></span>`;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + units[i];
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function promptChar(platform) {
  return platform === 'win32' ? 'PS&gt;' : '$';
}

// ── Load & render ────────────────────────────────────────────────────────────
async function loadNodes() {
  const body = $('drawerNodesBody');
  if (!body) return;

  try {
    const res = await fetch('/api/nodes', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('oe_token') } });
    if (!res.ok) throw new Error('Failed to load nodes');
    _nodesList = await res.json();
  } catch (e) {
    body.innerHTML = `<div class="cdraw-error">${escHtml(e.message)}</div>`;
    stopNodesRefresh();
    return;
  }

  const offlineCount = _nodesList.filter(n => n.health === 'disconnected').length;
  const onlineCount = _nodesList.length - offlineCount;
  const countLabel = offlineCount > 0
    ? `${onlineCount} online &middot; <span style="color:var(--red)">${offlineCount} offline</span>`
    : `${onlineCount} node${onlineCount !== 1 ? 's' : ''} connected`;
  const pairBtnHtml = `<div class="cdraw-toolbar" style="padding:10px 12px">
    <span style="font-size:12px;color:var(--muted)">${countLabel}</span>
    <button class="cdraw-btn cdraw-btn-primary" onclick="pairNewNode()" style="font-size:11px;padding:5px 12px">
      <i data-lucide="plus" style="width:12px;height:12px;margin-right:4px"></i> Pair New Node
    </button>
  </div>`;

  if (!_nodesList.length) {
    body.innerHTML = `${pairBtnHtml}<div class="cdraw-empty" style="padding:32px 16px">
      <div style="font-size:32px;margin-bottom:12px">&#x1F5A5;</div>
      <div style="font-weight:600;margin-bottom:6px">No nodes connected</div>
      <div style="font-size:12px;color:var(--muted)">Install <code>oe-node-agent</code> on a remote machine, then click "Pair New Node" to connect it.</div>
    </div>`;
    lucide.createIcons();
    startNodesRefresh();
    return;
  }

  let html = pairBtnHtml + '<div style="padding:10px">';
  for (const node of _nodesList) {
    html += renderNodeCard(node);
  }
  html += '</div>';
  body.innerHTML = html;
  lucide.createIcons();
  startNodesRefresh();
}

function renderNodeCard(node) {
  const pm = node.packageManager || 'unknown';
  const stats = node.stats;
  let statsLine = '';
  if (stats) {
    const load = (stats.load || [0])[0]?.toFixed(2) || '0.00';
    statsLine = `Load: ${load}`;
    if (stats.memUsed != null && stats.memTotal != null) {
      statsLine += ` &middot; Mem: ${formatBytes(stats.memUsed)}/${formatBytes(stats.memTotal)}`;
    }
    if (stats.disk) {
      if (stats.disk.pct) statsLine += ` &middot; Disk: ${stats.disk.used}/${stats.disk.size}`;
      else if (Array.isArray(stats.disk) && stats.disk[0]) {
        const d = stats.disk[0];
        statsLine += ` &middot; Disk ${d.Name}: ${formatBytes(d.Used)} used`;
      }
    }
  }

  let recoveryLine = '';
  if (node.restartCount > 0 && node.recoveredAt) {
    recoveryLine = `<div style="font-size:11px;color:var(--yellow);margin-top:2px">Restart #${node.restartCount} &middot; recovered ${timeAgo(node.recoveredAt)}</div>`;
  }

  return `<div class="node-card" id="nodeCard_${node.nodeId}">
    <div class="node-card-header">
      <span class="node-platform-icon">${platformIcon(node.platform)}</span>
      <span class="node-hostname">${escHtml(node.hostname)}</span>
      ${healthDot(node.health)}
      <span class="cdraw-badge">${escHtml(pm)}</span>
      ${versionBadge(node.version, node.latestVersion, node.outdated)}
    </div>
    <div class="node-card-status">
      ${healthBadge(node.health)}
      ${accessBadge(node.accessLevel, node.nodeId, node.accessLocked)}
    </div>
    <div class="node-card-info">
      ${escHtml(node.distro)} &middot; ${escHtml(node.arch)} ${node.ip ? '&middot; ' + escHtml(node.ip) : ''} ${node.formattedUptime ? '&middot; up ' + escHtml(node.formattedUptime) : ''}
    </div>
    ${statsLine ? `<div class="node-card-stats">${statsLine}</div>` : ''}
    ${recoveryLine}
    <div class="node-actions">
      <button class="cdraw-btn" onclick="openNodeTerminal('${node.nodeId}')" title="Terminal">
        <i data-lucide="terminal" style="width:13px;height:13px"></i> Terminal
      </button>
      ${canDo(node.accessLevel, 'update') ? `<button class="cdraw-btn" onclick="nodeQuickAction('${node.nodeId}','update')" title="Update packages">
        <i data-lucide="download" style="width:13px;height:13px"></i> Update
      </button>` : ''}
      ${canDo(node.accessLevel, 'restart') ? `<button class="cdraw-btn" onclick="nodeQuickAction('${node.nodeId}','restart')" title="Restart">
        <i data-lucide="rotate-ccw" style="width:13px;height:13px"></i> Restart
      </button>` : ''}
      ${canDo(node.accessLevel, 'shutdown') ? `<button class="cdraw-btn" onclick="nodeQuickAction('${node.nodeId}','shutdown')" title="Shut Down">
        <i data-lucide="power" style="width:13px;height:13px"></i> Shut Down
      </button>` : ''}
      ${canDo(node.accessLevel, 'install') ? `<button class="cdraw-btn" onclick="nodeQuickAction('${node.nodeId}','install')" title="Install package">
        <i data-lucide="package-plus" style="width:13px;height:13px"></i> Install
      </button>` : ''}
      <button class="cdraw-btn" onclick="nodeRefreshStatus('${node.nodeId}')" title="Refresh status">
        <i data-lucide="activity" style="width:13px;height:13px"></i> Status
      </button>
      <button class="cdraw-btn" onclick="pushAgentUpdate('${node.nodeId}')" title="Push latest agent code and restart">
        <i data-lucide="refresh-cw" style="width:13px;height:13px"></i> Upgrade Agent
      </button>
      <button class="cdraw-btn node-remove-btn" onclick="removeNodeFromUI('${node.nodeId}')" title="Remove this node">
        <i data-lucide="trash-2" style="width:13px;height:13px"></i> Remove
      </button>
    </div>
  </div>`;
}

// ── Popout Terminal ──────────────────────────────────────────────────────────

async function openNodeTerminal(nodeId, initialCommand, commandOpts) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  if (!node) return;

  // If window already open and not closed, focus it and type the command
  if (_termWindows[nodeId] && !_termWindows[nodeId].closed) {
    _termWindows[nodeId].focus();
    if (initialCommand && _termWindows[nodeId]._oeWs?.readyState === WebSocket.OPEN) {
      _termWindows[nodeId]._oeWs.send(initialCommand + '\n');
    }
    return;
  }

  // Mint a single-use page ticket. window.open() can't carry an Authorization
  // header, so we pass this ticket in the URL instead of the session token —
  // short-lived and scope-gated so it's useless after the terminal loads.
  const token = localStorage.getItem('oe_token');
  let ticket;
  try {
    const resp = await fetch('/api/nodes/terminal-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ nodeId }),
    });
    if (!resp.ok) { alert(`Terminal auth failed: ${resp.status}`); return; }
    ticket = (await resp.json()).ticket;
  } catch (e) {
    alert(`Terminal auth error: ${e.message}`);
    return;
  }

  let url = `/nodes/terminal?nodeId=${encodeURIComponent(nodeId)}&ticket=${encodeURIComponent(ticket)}`;
  if (initialCommand) {
    url += `&cmd=${encodeURIComponent(initialCommand)}`;
    if (commandOpts?.timeout) url += `&timeout=${commandOpts.timeout}`;
  }

  const w = window.open(url, `node_term_${nodeId}`, 'width=820,height=520,menubar=no,toolbar=no,location=no,status=no');
  if (!w) { alert('Pop-up blocked — please allow pop-ups for this site.'); return; }
  _termWindows[nodeId] = w;
}

// ── Quick actions ────────────────────────────────────────────────────────────
function nodeQuickAction(nodeId, action) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  if (!node) return;

  const pm = node.packageManager || 'unknown';
  const cmds = PKG_COMMANDS[pm];

  if (action === 'update') {
    if (!cmds) { alert(`Unknown package manager: ${pm}`); return; }
    openNodeTerminal(nodeId, cmds.update, { timeout: 300 });
  } else if (action === 'restart') {
    showNodeConfirmModal({
      title: `Restart ${node.hostname}?`,
      message: 'This will reboot the machine. The node will disconnect and reconnect automatically after restart.',
      confirmLabel: 'Restart',
      confirmClass: 'cdraw-btn-warning',
      onConfirm: () => {
        const cmd = node.platform === 'win32' ? REBOOT_COMMANDS.win32 : REBOOT_COMMANDS.default;
        openNodeTerminal(nodeId, cmd);
      },
    });
  } else if (action === 'shutdown') {
    showNodeConfirmModal({
      title: `Shut Down ${node.hostname}?`,
      message: 'This will power off the machine. The node will go offline and will NOT come back automatically.\n\nYou will need physical or remote access (IPMI/iLO/Proxmox) to power it back on.',
      confirmLabel: 'Shut Down',
      confirmClass: 'cdraw-btn-danger',
      onConfirm: () => {
        const cmd = node.platform === 'win32' ? SHUTDOWN_COMMANDS.win32 : SHUTDOWN_COMMANDS.default;
        openNodeTerminal(nodeId, cmd);
      },
    });
  } else if (action === 'install') {
    if (!cmds) { alert(`Unknown package manager: ${pm}`); return; }
    const pkg = prompt('Package name to install:');
    if (!pkg || !pkg.trim()) return;
    openNodeTerminal(nodeId, cmds.install + ' ' + pkg.trim(), { timeout: 300 });
  }
}

function showNodeConfirmModal({ title, message, confirmLabel, cancelLabel, confirmClass, onConfirm }) {
  const modal = document.createElement('div');
  modal.className = 'node-pair-modal';
  const msgHtml = escHtml(message).replace(/\n/g, '<br>');
  modal.innerHTML = `
    <div class="node-pair-modal-bg" onclick="this.parentElement.remove()"></div>
    <div class="node-pair-modal-box">
      <div style="font-weight:700;font-size:15px;margin-bottom:12px">&#x26A0;&#xFE0F; ${escHtml(title)}</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:20px;text-align:left;line-height:1.5">${msgHtml}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="cdraw-btn" onclick="this.closest('.node-pair-modal').remove()">${escHtml(cancelLabel || 'Cancel')}</button>
        <button class="cdraw-btn ${confirmClass || ''}" id="nodeConfirmBtn">${escHtml(confirmLabel)}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));
  modal.querySelector('#nodeConfirmBtn').addEventListener('click', () => {
    modal.remove();
    onConfirm();
  });
}

function changeNodeAccess(nodeId) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  if (!node) return;
  const currentInfo = ACCESS_BADGES[node.accessLevel] || ACCESS_BADGES.unknown;

  if (node.accessLocked) {
    showNodeConfirmModal({
      title: `Access Level Locked — ${node.hostname}`,
      message: `Current level: ${currentInfo.label} (LOCKED)\n\nThis node was installed with self-management disabled. Access level changes from the web UI are refused for security.\n\nTo change it, SSH into the machine as a real admin and run:\n\n  sudo oe change-access --force`,
      confirmLabel: 'OK',
      confirmClass: 'cdraw-btn-primary',
      onConfirm: () => {},
    });
    return;
  }

  showNodeConfirmModal({
    title: `Change Access Level for ${node.hostname}`,
    message: `Current level: ${currentInfo.label}\n\nThis will open a terminal on the node to run the access level change command.`,
    confirmLabel: 'Open Terminal',
    confirmClass: 'cdraw-btn-primary',
    onConfirm: () => {
      const cmd = 'sudo oe change-access';
      openNodeTerminal(nodeId, cmd);
    },
  });
}

function removeNodeFromUI(nodeId) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  if (!node) return;
  showNodeConfirmModal({
    title: `Remove ${node.hostname}?`,
    message: `This will tell ${node.hostname} to uninstall itself and it will be removed from the server.\n\nThe agent service, sudoers rules, oe-agent user, and /opt/oe-node-agent will all be deleted from the node.\n\nContinue?`,
    confirmLabel: 'Yes',
    cancelLabel: 'No',
    confirmClass: 'cdraw-btn-danger',
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}`, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + localStorage.getItem('oe_token') },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showNodeToast(`Failed to remove: ${err.error || res.statusText}`, 'error');
          return;
        }
        showNodeToast(`${node.hostname}: uninstall requested and removed from server`, 'success');
        loadNodes();
      } catch (e) {
        showNodeToast(`Error: ${e.message}`, 'error');
      }
    },
  });
}

function pushAgentUpdate(nodeId) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  if (!node) return;
  showNodeConfirmModal({
    title: `Upgrade ${node.hostname}?`,
    message: `Push the latest agent script to ${node.hostname} and restart the service.\n\nThe node will disconnect briefly while systemd restarts it, then reconnect automatically.`,
    confirmLabel: 'Upgrade',
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/update`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + localStorage.getItem('oe_token') },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showNodeToast(`Update failed: ${err.error || res.statusText}`, 'error');
          return;
        }
        showNodeToast(`${node.hostname}: update pushed`, 'info');
      } catch (e) {
        showNodeToast(`Error: ${e.message}`, 'error');
      }
    },
  });
}

async function nodeRefreshStatus(nodeId) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  if (!node) return;

  try {
    const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/status`, {
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('oe_token') },
    });
    if (res.ok) loadNodes();
  } catch {}
}

// ── Auto-refresh ─────────────────────────────────────────────────────────────
function startNodesRefresh() {
  stopNodesRefresh();
  _nodesRefreshTimer = setInterval(() => {
    if (activeDrawerId === 'drawerNodes') loadNodes();
    else stopNodesRefresh();
  }, 15000);
}

function stopNodesRefresh() {
  if (_nodesRefreshTimer) { clearInterval(_nodesRefreshTimer); _nodesRefreshTimer = null; }
}

// ── Real-time health events from WebSocket ───────────────────────────────────
function handleNodeHealthEvent(msg) {
  if (msg.type === 'node_removed') {
    _nodesList = _nodesList.filter(n => n.nodeId !== msg.nodeId);
    if (activeDrawerId === 'drawerNodes') loadNodes();
    return;
  }
  if (msg.type === 'node_update_result') {
    const node = _nodesList.find(n => n.nodeId === msg.nodeId);
    const name = node?.hostname || msg.nodeId;
    if (msg.ok) {
      if (typeof showToast === 'function') showToast(`${name}: agent updated (${msg.size} bytes). Restarting...`, 'success');
      else console.log(`[nodes] ${name} updated (${msg.size} bytes)`);
    } else {
      if (typeof showToast === 'function') showToast(`${name}: update failed — ${msg.error}`, 'error');
      else console.warn(`[nodes] ${name} update failed:`, msg.error);
    }
    return;
  }
  if (msg.type !== 'node_health') return;

  // Update local state
  const node = _nodesList.find(n => n.nodeId === msg.nodeId);
  if (node) {
    node.health = msg.health;
    if (msg.restartCount != null) node.restartCount = msg.restartCount;
    if (msg.health === 'recovered') node.recoveredAt = Date.now();
  }

  // Re-render if drawer is open
  if (activeDrawerId === 'drawerNodes') loadNodes();

  // Toast notification
  if (msg.health === 'disconnected') {
    showNodeToast(msg.message || `${msg.nodeId} went offline`, 'error');
  } else if (msg.health === 'recovered') {
    const dt = msg.downtime ? ` (offline ${Math.round(msg.downtime / 1000)}s)` : '';
    showNodeToast(msg.message || `${msg.nodeId} reconnected${dt}`, 'success');
  } else if (msg.health === 'stale') {
    showNodeToast(msg.message || `${msg.nodeId} is not responding`, 'warning');
  } else if (msg.health === 'healthy' && node?.restartCount > 0) {
    showNodeToast(msg.message || `${msg.nodeId} is healthy`, 'success');
  }
}

function showNodeToast(text, type) {
  let stack = document.getElementById('node-toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'node-toast-stack';
    stack.className = 'node-toast-stack';
    document.body.appendChild(stack);
  }
  const toast = document.createElement('div');
  toast.className = `node-toast node-toast-${type}`;
  toast.textContent = text;
  stack.prepend(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.remove();
      if (stack && !stack.childElementCount) stack.remove();
    }, 300);
  }, 4000);
}

// ── Pairing ──────────────────────────────────────────────────────────────────
async function pairNewNode() {
  try {
    const res = await fetch('/api/nodes/pair', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('oe_token') },
    });
    if (!res.ok) throw new Error('Failed to generate pairing code');
    const { code, expiresIn, installUrl } = await res.json();
    // Fallback in case server didn't return installUrl (older build)
    const curlUrl = installUrl || `${location.protocol}//${location.host}/nodes/install.sh`;

    // Show modal with the code
    const modal = document.createElement('div');
    modal.className = 'node-pair-modal';
    modal.innerHTML = `
      <div class="node-pair-modal-bg" onclick="this.parentElement.remove()"></div>
      <div class="node-pair-modal-box">
        <div style="font-weight:700;font-size:15px;margin-bottom:12px">Pair New Node</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:16px;text-align:left">
          On the remote machine, run this one-line installer:<br>
          <code style="display:block;background:var(--bg2);padding:8px 10px;border-radius:6px;margin-top:8px;font-size:11px;user-select:all;word-break:break-all;line-height:1.4">curl -sSL ${curlUrl} | bash</code>
          <div style="margin-top:8px;font-size:11px">It will download Node.js, the agent, dependencies, and prompt for this pairing code.</div>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Enter this pairing code when prompted:</div>
        <div class="node-pair-code">${code}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:12px">Expires in ${Math.floor(expiresIn / 60)} minutes</div>
        <button class="cdraw-btn" style="margin-top:16px;width:100%" onclick="this.closest('.node-pair-modal').remove()">Close</button>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('show'));
  } catch (e) {
    alert('Failed to generate pairing code: ' + e.message);
  }
}

// Hook into the main WS message handler — this function is called from websocket.js
// We'll register it there via a global
window._nodeHealthHandler = handleNodeHealthEvent;
