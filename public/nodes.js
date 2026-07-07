// ── Remote Nodes ──────────────────────────────────────────────────────────────

let _nodesRefreshTimer = null;
let _nodesList = [];
let _termWindows = {};  // nodeId → Window reference
const NODE_WALKTHROUGH_DISMISSED_KEY = 'oe.nodes.walkthrough.dismissed.v1';

// ── Join requests (device admission queue) ─────────────────────────────────
let _admissionList = [];         // pending requests, privileged users only
let _admissionOwnerChoices = null; // cached GET /api/users result for the owner picker
let _admissionOwnerSel = {};      // requestId -> chosen ownerUserId, survives re-render

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
  return `<span class="cdraw-badge access-badge-click ${info.cls ? 'access-' + info.cls : ''}" data-action="changeNodeAccess" data-args='${JSON.stringify([nodeId]).replace(/'/g, "&#39;")}' title="${title}">${info.label}${lockIcon}</span>`;
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
function isPrivilegedUser() {
  return _currentUser?.role === 'owner' || _currentUser?.role === 'admin';
}

async function loadNodes() {
  const body = $('drawerNodesBody');
  if (!body) return;

  try {
    const res = await fetch('/api/nodes');
    if (!res.ok) throw new Error('Failed to load nodes');
    _nodesList = await res.json();
  } catch (e) {
    body.innerHTML = `<div class="cdraw-error">${escHtml(e.message)}</div>`;
    stopNodesRefresh();
    return;
  }

  await loadAdmissionQueue();
  if (_admissionList.length) await ensureAdmissionOwnerChoices();
  const admissionHtml = renderAdmissionQueue();

  const offlineCount = _nodesList.filter(n => n.health === 'disconnected').length;
  const onlineCount = _nodesList.length - offlineCount;
  const countLabel = offlineCount > 0
    ? `${onlineCount} online &middot; <span style="color:var(--red)">${offlineCount} offline</span>`
    : `${onlineCount} node${onlineCount !== 1 ? 's' : ''} connected`;
  const revokeAllBtn = _nodesList.length
    ? `<button class="cdraw-btn" data-action="revokeAllNodes" style="font-size:11px;padding:5px 10px;color:var(--red,#e05c5c);border-color:var(--red,#e05c5c)" title="Revoke every paired node + every node session for this account">
        <i data-lucide="shield-off" style="width:12px;height:12px;margin-right:4px"></i> Revoke All
      </button>`
    : '';
  const helpBtn = _nodesList.length
    ? `<button class="cdraw-btn" data-action="showNodeWalkthrough" style="font-size:11px;padding:5px 10px" title="Explain node status, checks, services, and auto-fix labels">
        <i data-lucide="circle-help" style="width:12px;height:12px;margin-right:4px"></i> Help
      </button>`
    : '';
  const pairBtnHtml = `<div class="cdraw-toolbar" style="padding:10px 12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
    <span style="font-size:12px;color:var(--muted);flex:1">${countLabel}</span>
    ${helpBtn}
    ${revokeAllBtn}
    <button class="cdraw-btn cdraw-btn-primary" data-action="pairNewNode" style="font-size:11px;padding:5px 12px">
      <i data-lucide="plus" style="width:12px;height:12px;margin-right:4px"></i> Pair New Node
    </button>
  </div>`;

  if (!_nodesList.length) {
    body.innerHTML = `${admissionHtml}${pairBtnHtml}<div class="cdraw-empty" style="padding:32px 16px">
      <div style="font-size:32px;margin-bottom:12px">&#x1F5A5;</div>
      <div style="font-weight:600;margin-bottom:6px">No nodes connected</div>
      <div style="font-size:12px;color:var(--muted)">Install <code>oe-node-agent</code> on a remote machine, then click "Pair New Node" to connect it. New installs default to requesting approval right here — no code needed.</div>
    </div>`;
    lucide.createIcons();
    startNodesRefresh();
    refreshNodesAlertBadge();
    return;
  }

  let html = admissionHtml + pairBtnHtml + renderNodesActionQueue(_nodesList) + '<div style="padding:10px">';
  for (const node of _nodesList) {
    html += renderNodeCard(node);
  }
  html += '</div>';
  body.innerHTML = html;
  lucide.createIcons();
  startNodesRefresh();
  refreshNodesAlertBadge();
}

// Fetch the pending admission queue (owner/admin only — regular users get a
// 403 from the endpoint, so skip the round trip client-side too).
async function loadAdmissionQueue() {
  if (!isPrivilegedUser()) { _admissionList = []; return; }
  try {
    const res = await fetch('/api/admission/pending');
    _admissionList = res.ok ? await res.json() : [];
  } catch {
    _admissionList = [];
  }
}

// Cached user roster for the owner-picker <select> on each request card —
// only fetched once per drawer session (invalidated on full page reload).
async function ensureAdmissionOwnerChoices() {
  if (_admissionOwnerChoices) return _admissionOwnerChoices;
  try {
    const res = await fetch('/api/users');
    const all = res.ok ? await res.json() : [];
    // Child accounts can't own a node — the approve endpoint rejects them with
    // a 400 — so keep them out of the picker rather than let the admin pick
    // one and get a confusing failure.
    _admissionOwnerChoices = all.filter(u => u.role !== 'child');
  } catch {
    _admissionOwnerChoices = [];
  }
  return _admissionOwnerChoices;
}

function renderAdmissionQueue() {
  if (!isPrivilegedUser() || !_admissionList.length) return '';
  const choices = _admissionOwnerChoices || [];
  const cards = _admissionList.map(r => renderAdmissionCard(r, choices)).join('');
  return `<div class="node-admission-queue">
    <div class="node-admission-queue-head">
      <span><i data-lucide="door-open" style="width:14px;height:14px"></i> Join requests</span>
      <small>${_admissionList.length} waiting</small>
    </div>
    ${cards}
  </div>`;
}

function renderAdmissionCard(r, choices) {
  const meta = r.metadata || {};
  const hostname = meta.hostname || r.name || 'Unnamed device';
  const platform = meta.platform || 'unknown';
  // A persisted in-progress pick (see admissionOwnerSelected) wins over the
  // default so the 15s auto-refresh / WS-triggered re-render doesn't silently
  // reset the admin's choice back to themselves.
  const defaultOwner = _admissionOwnerSel[r.requestId] ?? (_currentUser?.id || '');
  const options = choices.length
    ? choices.map(u => `<option value="${escHtml(u.id)}" ${u.id === defaultOwner ? 'selected' : ''}>${escHtml(u.name || u.id)}</option>`).join('')
    : `<option value="${escHtml(defaultOwner)}">${escHtml(_currentUser?.name || 'Me')}</option>`;
  return `<div class="node-admission-card" id="admissionCard_${escHtml(r.requestId)}">
    <div class="node-admission-card-head">
      <span class="node-admission-host">${escHtml(hostname)}</span>
      <span class="cdraw-badge">${escHtml(platform)}</span>
    </div>
    <div class="node-admission-meta">${escHtml(r.ip || 'unknown')} &middot; requested ${timeAgo(r.requestedAt)}${meta.agentVersion ? ` &middot; agent v${escHtml(meta.agentVersion)}` : ''}</div>
    <div class="node-admission-sas" title="Shown on the device too — confirm they match before approving">Verification code: <b>${escHtml(r.sas)}</b></div>
    <div class="node-admission-actions">
      <select id="admissionOwner_${escHtml(r.requestId)}" title="Which account should own this node"
        data-change-action="admissionOwnerSelected" data-change-args='${JSON.stringify([r.requestId, "$value"]).replace(/'/g, "&#39;")}'
        style="background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:4px 6px;font-size:11px">
        ${options}
      </select>
      <button class="cdraw-btn cdraw-btn-primary" data-action="approveAdmission" data-args='${JSON.stringify([r.requestId]).replace(/'/g, "&#39;")}'>
        <i data-lucide="check" style="width:12px;height:12px;margin-right:4px"></i> Approve
      </button>
      <button class="cdraw-btn" data-action="denyAdmission" data-args='${JSON.stringify([r.requestId]).replace(/'/g, "&#39;")}'>
        <i data-lucide="x" style="width:12px;height:12px;margin-right:4px"></i> Deny
      </button>
    </div>
  </div>`;
}

// Change handler for the per-card owner <select> (data-change-action). Stores
// the pick in module state so it survives the 15s auto-refresh / WS-triggered
// loadNodes() re-render, which otherwise rebuilds the card via innerHTML and
// resets the select back to the default owner.
function admissionOwnerSelected(requestId, ownerUserId) {
  _admissionOwnerSel[requestId] = ownerUserId;
}

async function approveAdmission(requestId) {
  const sel = document.getElementById(`admissionOwner_${requestId}`);
  // The persisted pick is authoritative — a re-render could be mid-flight
  // when Approve is clicked, in which case `sel` reflects the just-rebuilt
  // (default) DOM rather than what the admin actually chose.
  const ownerUserId = _admissionOwnerSel[requestId] ?? sel?.value ?? undefined;
  try {
    const res = await fetch(`/api/admission/${encodeURIComponent(requestId)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ownerUserId ? { ownerUserId } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showNodeToast(`Approve failed: ${data.error || res.statusText}`, 'error'); return; }
    showNodeToast('Approved — the device will connect shortly', 'success');
    _admissionList = _admissionList.filter(r => r.requestId !== requestId);
    delete _admissionOwnerSel[requestId];
    await loadNodes();
  } catch (e) {
    showNodeToast(`Approve failed: ${e.message}`, 'error');
  }
}

async function denyAdmission(requestId) {
  try {
    const res = await fetch(`/api/admission/${encodeURIComponent(requestId)}/deny`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { showNodeToast(`Deny failed: ${data.error || res.statusText}`, 'error'); return; }
    showNodeToast('Request denied', 'success');
    _admissionList = _admissionList.filter(r => r.requestId !== requestId);
    delete _admissionOwnerSel[requestId];
    await loadNodes();
  } catch (e) {
    showNodeToast(`Deny failed: ${e.message}`, 'error');
  }
}

// Live updates from the WS (see public/websocket.js `admission_request` /
// `admission_resolved` cases). Keeps the drawer's queue current without
// waiting for the next 15s poll, and nudges a toast when the drawer is
// closed so the join request isn't missed entirely.
function handleAdmissionEvent(msg) {
  if (!isPrivilegedUser()) return;
  if (msg.type === 'admission_request') {
    if (!_admissionList.some(r => r.requestId === msg.requestId)) _admissionList.push({ ...msg });
    if (activeDrawerId !== 'drawerNodes' && typeof showToast === 'function') {
      showToast(`New device wants to join: ${msg.metadata?.hostname || msg.name || 'device'} (code ${msg.sas})`, 6000);
    }
  } else if (msg.type === 'admission_resolved') {
    _admissionList = _admissionList.filter(r => r.requestId !== msg.requestId);
  }
  scheduleNodesRefresh();
  refreshNodesAlertBadge();
}
window._nodeAdmissionHandler = handleAdmissionEvent;

function renderNodesActionQueue(nodes) {
  const items = [];
  for (const node of nodes || []) {
    for (const item of node.actionItems || []) {
      items.push({ ...item, nodeLabel: node.hostname || node.nodeId });
    }
  }
  if (!items.length) return '';
  // Show every actionable item, most severe first — no cap. The header count
  // must match what's rendered; a prior .slice(0, 8) truncated the list while
  // the count still said (e.g.) "9 items", hiding nodes that need action.
  const ordered = items.sort((a, b) => {
    const rank = { critical: 0, warn: 1, info: 2 };
    return (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3);
  });
  return `<div class="node-actions-queue">
    <div class="node-actions-queue-head">
      <span><i data-lucide="triangle-alert" style="width:14px;height:14px"></i> Action required</span>
      <small>${items.length} item${items.length === 1 ? '' : 's'}</small>
    </div>
    ${OENodeHealthView.renderActionItems(ordered)}
  </div>`;
}

function dismissNodeWalkthrough() {
  localStorage.setItem(NODE_WALKTHROUGH_DISMISSED_KEY, '1');
  this?.closest?.('.node-pair-modal')?.remove();
  loadNodes();
}

function showNodeWalkthrough() {
  const modal = document.createElement('div');
  modal.className = 'node-pair-modal';
  modal.innerHTML = `
    <div class="node-pair-modal-bg" data-action="_nodePairModalClose"></div>
    <div class="node-pair-modal-box node-walkthrough-modal">
      <div class="node-walkthrough-modal-head">
        <i data-lucide="server" style="width:18px;height:18px"></i>
        <div>
          <div class="node-walkthrough-modal-title">Reading a node card</div>
          <div class="node-walkthrough-modal-subtitle">What to check after pairing a machine</div>
        </div>
      </div>
      <div class="node-walkthrough-steps">
        <div class="node-walkthrough-step">
          <span class="node-walkthrough-step-num">1</span>
          <div><b>Confirm the node is reachable.</b> The connection badge says Connected, Recovered, Not Responding, or Offline. Recovered means the agent restarted and came back recently.</div>
        </div>
        <div class="node-walkthrough-step">
          <span class="node-walkthrough-step-num">2</span>
          <div><b>Check access before using actions.</b> Full Access can run administrative commands. Locked means the node must be changed from SSH, not from this drawer.</div>
        </div>
        <div class="node-walkthrough-step">
          <span class="node-walkthrough-step-num">3</span>
          <div><b>Use quick actions deliberately.</b> Terminal opens a shell. Refresh updates inventory. Update, Install, Restart, Shut Down, and Upgrade Agent act on the remote machine.</div>
        </div>
        <div class="node-walkthrough-step">
          <span class="node-walkthrough-step-num">4</span>
          <div><b>Separate host health from services.</b> Node checks / Host health is automatic. Managed services are profiles OE researched and verified for a specific service.</div>
        </div>
        <div class="node-walkthrough-step">
          <span class="node-walkthrough-step-num">5</span>
          <div><b>Read the automation level.</b> Draft keeps monitoring and auto-fix off. Approved allows verified low-risk fixes. Auto-fix allows verified medium-risk fixes too; high-risk changes still ask first.</div>
        </div>
      </div>
      <div class="node-walkthrough-next">
        To finish onboarding a useful node, ask an agent: <code>detect services on this node and onboard the ones you find</code>.
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button class="cdraw-btn" data-action="dismissNodeWalkthrough" style="font-size:12px;padding:6px 12px">Hide Inline Guide</button>
        <button class="cdraw-btn cdraw-btn-primary" data-action="_nodePairModalCloseInner" style="font-size:12px;padding:6px 12px">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));
  lucide.createIcons();
}

// Toggle the small red dot on the sidebar Nodes button. Visible iff any
// reachable node has at least one failing profile check — same condition that
// triggers the toast notification — so the user notices something's wrong
// even with the drawer closed.
function refreshNodesAlertBadge() {
  const dot = document.getElementById('sbtnNodesAlert');
  if (!dot) return;
  const anyUnhealthy = _nodesList.some(n =>
    Array.isArray(n.profiles) && n.profiles.some(p => p.overall === 'unhealthy'),
  );
  const anyJoinRequests = _admissionList.length > 0;
  dot.style.display = (anyUnhealthy || anyJoinRequests) ? '' : 'none';
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
      if (stats.disk.pct) statsLine += ` &middot; Disk: ${escHtml(stats.disk.used)}/${escHtml(stats.disk.size)}`;
      else if (Array.isArray(stats.disk) && stats.disk[0]) {
        const d = stats.disk[0];
        statsLine += ` &middot; Disk ${escHtml(d.Name)}: ${formatBytes(d.Used)} used`;
      }
    }
  }

  let recoveryLine = '';
  if (node.restartCount > 0 && node.recoveredAt) {
    recoveryLine = `<div style="font-size:11px;color:var(--yellow);margin-top:2px">Restart #${node.restartCount} &middot; recovered ${timeAgo(node.recoveredAt)}</div>`;
  }

  return `<div class="node-card" id="nodeCard_${escHtml(node.nodeId)}">
    <div class="node-card-header">
      <span class="node-platform-icon">${platformIcon(node.platform)}</span>
      <span class="node-hostname">${escHtml(node.hostname)}</span>
      ${healthDot(node.health)}
      <span class="cdraw-badge">${escHtml(pm)}</span>
      ${versionBadge(node.version, node.latestVersion, node.outdated)}
      ${renderReliabilityBadge(node.reliability)}
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
    ${renderNodeQualitySummary(node)}
    ${node.secureUpdates === false ? `<div class="node-card-info" style="background:var(--bg2);border-left:3px solid #d9a441;border-radius:6px;padding:7px 10px;margin-top:6px;font-size:11.5px;line-height:1.45">
      <b>Older agent (v${escHtml(node.version || 'unknown')}) — updates can't be verified.</b> Auto-update is disabled for security. Re-run the installer on this device to upgrade and enable signed, verified updates (see the action item above).
    </div>` : ''}
    <div class="node-actions">
      <button class="cdraw-btn" data-action="openNodeTerminal" data-args='${JSON.stringify([node.nodeId]).replace(/'/g, "&#39;")}' title="Terminal">
        <i data-lucide="terminal" style="width:13px;height:13px"></i> Terminal
      </button>
      ${canDo(node.accessLevel, 'update') ? `<button class="cdraw-btn" data-action="nodeQuickAction" data-args='${JSON.stringify([node.nodeId, "update"]).replace(/'/g, "&#39;")}' title="Update packages">
        <i data-lucide="download" style="width:13px;height:13px"></i> Update
      </button>` : ''}
      ${canDo(node.accessLevel, 'restart') ? `<button class="cdraw-btn" data-action="nodeQuickAction" data-args='${JSON.stringify([node.nodeId, "restart"]).replace(/'/g, "&#39;")}' title="Restart">
        <i data-lucide="rotate-ccw" style="width:13px;height:13px"></i> Restart
      </button>` : ''}
      ${canDo(node.accessLevel, 'shutdown') ? `<button class="cdraw-btn" data-action="nodeQuickAction" data-args='${JSON.stringify([node.nodeId, "shutdown"]).replace(/'/g, "&#39;")}' title="Shut Down">
        <i data-lucide="power" style="width:13px;height:13px"></i> Shut Down
      </button>` : ''}
      ${canDo(node.accessLevel, 'install') ? `<button class="cdraw-btn" data-action="nodeQuickAction" data-args='${JSON.stringify([node.nodeId, "install"]).replace(/'/g, "&#39;")}' title="Install package">
        <i data-lucide="package-plus" style="width:13px;height:13px"></i> Install
      </button>` : ''}
      <button class="cdraw-btn" data-action="nodeRefreshStatus" data-args='${JSON.stringify([node.nodeId]).replace(/'/g, "&#39;")}' title="Refresh node inventory">
        <i data-lucide="refresh-cw" style="width:13px;height:13px"></i> Refresh
      </button>
      <button class="cdraw-btn" data-action="openNodeHealth" data-args='${JSON.stringify([node.nodeId]).replace(/'/g, "&#39;")}' title="View health signals and open incidents">
        <i data-lucide="heart-pulse" style="width:13px;height:13px"></i> Health
      </button>
      ${node.secureUpdates === false ? '' : `<button class="cdraw-btn" data-action="pushAgentUpdate" data-args='${JSON.stringify([node.nodeId]).replace(/'/g, "&#39;")}' title="Push latest agent code and restart">
        <i data-lucide="refresh-cw" style="width:13px;height:13px"></i> Upgrade Agent
      </button>`}
      <button class="cdraw-btn node-remove-btn" data-action="removeNodeFromUI" data-args='${JSON.stringify([node.nodeId]).replace(/'/g, "&#39;")}' title="Remove this node">
        <i data-lucide="trash-2" style="width:13px;height:13px"></i> Remove
      </button>
    </div>
    ${renderSystemHealthSection(node)}
  </div>`;
}

function renderReliabilityBadge(reliability) {
  if (!reliability) return '';
  const cls = reliability.score < 60 ? 'red' : reliability.score < 80 ? 'yellow' : 'green';
  return `<span class="cdraw-badge ${cls}" title="Node reliability score">${escHtml(reliability.label)} ${escHtml(reliability.score)}</span>`;
}

function renderNodeQualitySummary(node) {
  const actions = Array.isArray(node.actionItems) ? node.actionItems : [];
  const gates = Array.isArray(node.qualityGates) ? node.qualityGates : [];
  const critical = actions.filter(a => a.severity === 'critical').length;
  const warn = actions.filter(a => a.severity === 'warn').length;
  const failingGates = gates.filter(g => g.status === 'fail').length;
  if (!actions.length && !failingGates) return '';
  const parts = [];
  if (critical) parts.push(`<span style="color:var(--red)">${critical} critical</span>`);
  if (warn) parts.push(`<span style="color:var(--yellow)">${warn} warning${warn === 1 ? '' : 's'}</span>`);
  if (failingGates) parts.push(`<span style="color:var(--red)">${failingGates} failed gate${failingGates === 1 ? '' : 's'}</span>`);
  return `<div class="node-quality-summary">${parts.join(' · ')}</div>`;
}

function renderSystemHealthSection(node) {
  const health = node.systemHealth || summarizeNodeHealthClient(node);
  const badgeClass = health.status === 'healthy' ? 'green' : health.status === 'failed' ? 'red' : 'yellow';
  const autoFixDisabled = !health.autoFixAvailable;
  const autoFixTitle = autoFixDisabled
    ? 'Auto-fix is available after System Health is fully onboarded'
    : 'Allow OE to apply verified fixes when health signals fail';
  const skippedCount = Array.isArray(health.skipped) ? health.skipped.length : 0;
  const skipped = skippedCount
    ? `<div class="node-system-health-skipped">${skippedCount} item${skippedCount === 1 ? '' : 's'} skipped during onboarding</div>`
    : '';
  return `<div class="node-system-health">
    <div class="node-system-health-head">
      <div>
        <div class="node-system-health-title">System Health</div>
        <div class="node-system-health-detail">${escHtml(health.detail || 'No checks active yet')}</div>
      </div>
      <span class="cdraw-badge ${badgeClass}">${escHtml(health.label || 'Degraded')}</span>
    </div>
    <div class="node-system-health-meta">
      <span>${escHtml(health.onboardedLabel || 'Not onboarded')}</span>
      ${skipped}
    </div>
    <div class="node-system-health-actions">
      <button class="cdraw-btn" data-action="openNodeOnboarding" data-args='${JSON.stringify([node.nodeId]).replace(/'/g, "&#39;")}' title="Walk through host health and service checks">
        <i data-lucide="route" style="width:12px;height:12px"></i> Onboard
      </button>
      <button class="cdraw-btn" data-action="openNodeHealth" data-args='${JSON.stringify([node.nodeId]).replace(/'/g, "&#39;")}' title="View health details">
        <i data-lucide="heart-pulse" style="width:12px;height:12px"></i> Details
      </button>
      <label class="node-autofix-toggle ${autoFixDisabled ? 'node-autofix-disabled' : ''}" title="${escHtml(autoFixTitle)}">
        <span>Auto-fix</span>
        <input type="checkbox" ${health.autoFixEnabled ? 'checked' : ''} ${autoFixDisabled ? 'disabled' : ''}
          data-change-action="toggleNodeAutoFix"
          data-change-args='${JSON.stringify([node.nodeId, "$checked"]).replace(/'/g, "&#39;")}'>
      </label>
    </div>
  </div>`;
}

function summarizeNodeHealthClient(node) {
  const profiles = Array.isArray(node.profiles) ? node.profiles : [];
  const totalChecks = profiles.reduce((n, p) => n + (p.signals_total || 0), 0);
  const activeChecks = profiles.reduce((n, p) => n + (p.watcher_active ? (p.signals_total || 0) : 0), 0);
  const failingChecks = profiles.reduce((n, p) => n + (p.signals_unhealthy || 0), 0);
  const pendingChecks = profiles.reduce((n, p) => n + (p.signals_unknown || 0), 0);
  const inactive = profiles.filter(p => p.signals_total && !p.watcher_active).length;
  const status = (node.health === 'disconnected' || node.health === 'stale' || failingChecks)
    ? 'failed'
    : (!profiles.length || inactive || pendingChecks)
      ? 'degraded'
      : 'healthy';
  const services = profiles.filter(p => p.service_id !== 'system').length;
  const activeProfiles = profiles.filter(p => p.trust_state !== 'unverified' && p.watcher_active).length;
  const draftProfiles = profiles.filter(p => p.trust_state === 'unverified').length;
  let onboardingStatus = node.onboarding?.status || (activeProfiles ? 'partial' : 'not_started');
  if (onboardingStatus === 'full' && (draftProfiles || inactive || totalChecks === 0)) {
    onboardingStatus = activeProfiles ? 'partial' : 'not_started';
  }
  return {
    status,
    label: status === 'healthy' ? 'Healthy' : status === 'failed' ? 'Failed' : 'Degraded',
    detail: `${activeChecks}/${totalChecks || 0} checks active · ${services} managed service${services === 1 ? '' : 's'}`,
    onboardedLabel: onboardingStatus === 'full' ? 'Fully onboarded' : onboardingStatus === 'partial' ? 'Partially onboarded' : 'Not onboarded',
    autoFixEnabled: !!node.autoFixEnabled,
    autoFixAvailable: onboardingStatus === 'full' && totalChecks > 0,
    skipped: node.onboarding?.skipped || [],
  };
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
  // header (and now that auth is cookie-based, can't carry the cookie either
  // — popup origin sees the cookie automatically only for same-origin
  // navigation, but the terminal page mounts a fresh WS that needs an
  // explicit auth token). We pass this ticket in the URL instead — short-lived
  // and scope-gated so it's useless after the terminal loads.
  let ticket;
  try {
    const resp = await fetch('/api/nodes/terminal-ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

// Wrappers for the event-delegation harness — used by the pair-modal close
// handlers that previously used `this.parentElement.remove()` and
// `this.closest('.node-pair-modal').remove()`.
function _nodePairModalClose(_event) { this.parentElement?.remove(); }
function _nodePairModalCloseInner(_event) { this.closest('.node-pair-modal')?.remove(); }

async function openNodeHealth(nodeId) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  const label = node?.hostname || nodeId;
  const modal = document.createElement('div');
  modal.className = 'node-pair-modal';
  modal.innerHTML = `
    <div class="node-pair-modal-bg" data-action="_nodePairModalClose"></div>
    <div class="node-pair-modal-box node-health-modal">
      <div class="node-walkthrough-modal-head">
        <i data-lucide="heart-pulse" style="width:18px;height:18px"></i>
        <div>
          <div class="node-walkthrough-modal-title">Health: ${escHtml(label)}</div>
          <div class="node-walkthrough-modal-subtitle">Signals, failing checks, and incident details</div>
        </div>
      </div>
      <div class="node-health-modal-body">
        <div class="node-health-empty">Loading health signals…</div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button class="cdraw-btn cdraw-btn-primary" data-action="_nodePairModalCloseInner" style="font-size:12px;padding:6px 12px">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));
  lucide.createIcons();

  const body = modal.querySelector('.node-health-modal-body');
  try {
    const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/health`, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    body.innerHTML = OENodeHealthView.renderNodeOpsView(data);
    lucide.createIcons();
  } catch (e) {
    body.innerHTML = `<div class="cdraw-error">Could not load node health: ${escHtml(e.message)}</div>`;
  }
}

async function applyNodeIncidentFix(nodeId, incidentId) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  if (!nodeId || !incidentId) return;
  showNodeConfirmModal({
    title: `Apply proposed fix?`,
    message: `This will run the operation OE proposed for incident ${incidentId} on ${node?.hostname || nodeId}.\n\nThe operation will be recorded in the activity log and the incident timeline.`,
    confirmLabel: 'Apply Fix',
    cancelLabel: 'Cancel',
    confirmClass: 'cdraw-btn-warning',
    onConfirm: async () => {
      try {
        const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/incidents/${encodeURIComponent(incidentId)}/apply-fix`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        showNodeToast(data.result?.success ? 'Fix applied' : 'Fix ran but did not succeed', data.result?.success ? 'success' : 'error');
        await loadNodes();
        openNodeHealth(nodeId);
      } catch (e) {
        showNodeToast(`Fix failed: ${e.message}`, 'error');
      }
    },
  });
}

function investigateNodeHealth(nodeId, serviceId, signalKind, incidentId) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  const prompt = [
    `Investigate node health for ${node?.hostname || nodeId}.`,
    serviceId ? `Service: ${serviceId}.` : '',
    signalKind ? `Signal: ${signalKind}.` : '',
    incidentId ? `Incident: ${incidentId}.` : '',
    'Use the node health details, incident timeline, diagnostics, activity log, and available profile operations. Explain what is broken, what OE already tried, whether a verified fix is available, and ask for approval before any risky change.',
  ].filter(Boolean).join(' ');
  if (typeof closeDrawer === 'function') closeDrawer();
  const input = $('input');
  if (input && typeof send === 'function') {
    input.value = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    send();
  } else {
    navigator.clipboard?.writeText(prompt).catch(() => {});
    showNodeToast('Investigation prompt copied', 'success');
  }
}

function showNodeConfirmModal({ title, message, confirmLabel, cancelLabel, confirmClass, onConfirm }) {
  const modal = document.createElement('div');
  modal.className = 'node-pair-modal';
  const msgHtml = escHtml(message).replace(/\n/g, '<br>');
  modal.innerHTML = `
    <div class="node-pair-modal-bg" data-action="_nodePairModalClose"></div>
    <div class="node-pair-modal-box">
      <div style="font-weight:700;font-size:15px;margin-bottom:12px">&#x26A0;&#xFE0F; ${escHtml(title)}</div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:20px;text-align:left;line-height:1.5">${msgHtml}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="cdraw-btn" data-action="_nodePairModalCloseInner">${escHtml(cancelLabel || 'Cancel')}</button>
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

function profileDisplayLabel(serviceId) {
  return serviceId === 'system' ? 'Host health' : serviceId;
}

async function requestNodeProfileOnboard(nodeId, serviceId, target) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  const stateLabel = target === 'proven' ? 'Auto-fix' : 'Approved';
  const profileLabel = profileDisplayLabel(serviceId);
  try {
    const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/profile/${encodeURIComponent(serviceId)}/onboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const failed = data.verification?.results
        ?.filter(r => r.status === 'failed')
        ?.map(r => r.op_id)
        ?.join(', ');
      showNodeToast(`${node?.hostname || nodeId}: ${data.error || `could not enable ${stateLabel}`}${failed ? ` (${failed})` : ''}`, 'error');
      await loadNodes();
      return null;
    }
    showNodeToast(`${node?.hostname || nodeId}: ${profileLabel} is now ${stateLabel}`, 'success');
    await loadNodes();
    return data;
  } catch (e) {
    showNodeToast(`${node?.hostname || nodeId}: ${e.message}`, 'error');
    return null;
  }
}

async function approveNodeProfile(nodeId, serviceId) {
  const data = await requestNodeProfileOnboard(nodeId, serviceId, 'reviewed');
  if (!data) return;
  const node = _nodesList.find(n => n.nodeId === nodeId);
  const profileLabel = profileDisplayLabel(serviceId);
  const passed = data.verification ? `${data.verification.passed}/${data.verification.tested} diagnostics passed` : 'Diagnostics passed';
  showNodeConfirmModal({
    title: `Enable Auto-fix for ${profileLabel}?`,
    message: `${profileLabel} is Approved and monitoring is starting on ${node?.hostname || nodeId}.\n\n${passed}.\n\nAuto-fix allows verified medium-risk fixes for this profile when troubleshooting determines that is the fix. High-risk changes still ask first.`,
    confirmLabel: 'Enable Auto-fix',
    cancelLabel: 'Keep Approved',
    confirmClass: 'cdraw-btn-warning',
    onConfirm: () => requestNodeProfileOnboard(nodeId, serviceId, 'proven'),
  });
}

async function openNodeOnboarding(nodeId) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  if (!node) return;
  const modal = document.createElement('div');
  modal.className = 'node-pair-modal';
  modal.innerHTML = `
    <div class="node-pair-modal-bg" data-action="_nodePairModalClose"></div>
    <div class="node-pair-modal-box node-onboarding-modal">
      <div class="node-walkthrough-modal-head">
        <i data-lucide="route" style="width:18px;height:18px"></i>
        <div>
          <div class="node-walkthrough-modal-title">System Health: ${escHtml(node.hostname)}</div>
          <div class="node-walkthrough-modal-subtitle">Host health and managed services in one pass</div>
        </div>
      </div>
      <div id="nodeOnboardBody_${escHtml(nodeId)}" class="node-onboarding-body">
        ${renderSystemOnboardingStart(node)}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button class="cdraw-btn" data-action="_nodePairModalCloseInner" style="font-size:12px;padding:6px 12px">Done</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  requestAnimationFrame(() => modal.classList.add('show'));
  lucide.createIcons();
}

function renderSystemOnboardingStart(node) {
  const health = node.systemHealth || summarizeNodeHealthClient(node);
  return `
    <div class="node-onboarding-status">
      <span class="node-onboarding-spinner" aria-hidden="true"></span>
      <div>
        <b>Current status: ${escHtml(health.label || 'Degraded')}</b>
        <div>${escHtml(health.detail || 'No checks active yet')} · ${escHtml(health.onboardedLabel || 'Not onboarded')}</div>
      </div>
    </div>
    <div class="node-onboarding-step">
      <div>
        <b>1. Safe checks</b>
        <div>Start read-only host and service health checks. No restarts, installs, permission changes, or package actions.</div>
      </div>
      <button class="cdraw-btn cdraw-btn-primary" data-action="startNodeOnboarding" data-args='${JSON.stringify([node.nodeId, 'safe']).replace(/'/g, "&#39;")}'>
        <i data-lucide="shield-check" style="width:12px;height:12px;margin-right:4px"></i> Run Safe Checks
      </button>
    </div>
    <div class="node-onboarding-step">
      <div>
        <b>2. All non-restart checks</b>
        <div>Enable every detected monitoring check that can run without restarting services or the node agent.</div>
      </div>
      <button class="cdraw-btn" data-action="startNodeOnboarding" data-args='${JSON.stringify([node.nodeId, 'no_restart']).replace(/'/g, "&#39;")}'>
        <i data-lucide="activity" style="width:12px;height:12px;margin-right:4px"></i> Run Non-Restart Checks
      </button>
    </div>
    <div class="node-onboarding-step">
      <div>
        <b>3. Include restart-required checks</b>
        <div>Use this when you are ready to include checks or setup steps that may require a service or agent restart. Destructive changes still ask first.</div>
      </div>
      <button class="cdraw-btn" data-action="startNodeOnboarding" data-args='${JSON.stringify([node.nodeId, 'include_restart']).replace(/'/g, "&#39;")}'>
        <i data-lucide="rotate-ccw" style="width:12px;height:12px;margin-right:4px"></i> Include Restart-Required
      </button>
    </div>
  `;
}

function nodeOnboardingBody(nodeId) {
  return document.querySelector(`[id="nodeOnboardBody_${CSS.escape(nodeId)}"]`);
}

async function startNodeOnboarding(nodeId, scope) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  const body = nodeOnboardingBody(nodeId);
  if (!node || !body) return;
  body.innerHTML = `<div class="node-onboarding-status node-onboarding-status-running">
    <span class="node-onboarding-spinner" aria-hidden="true"></span>
    <div>
      <b>Onboarding System Health</b>
      <div>Checking host health, detecting managed services, creating monitoring profiles, and starting watchers.</div>
    </div>
  </div>`;
  lucide.createIcons();
  try {
    const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/onboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    body.innerHTML = renderNodeOnboardingResult(data.onboarding, data.systemHealth);
    showNodeToast(data.onboarding?.status === 'full' ? 'System Health fully onboarded' : 'System Health partially onboarded', data.onboarding?.status === 'full' ? 'success' : 'warning');
    await loadNodes();
  } catch (e) {
    body.innerHTML = `<div class="node-onboarding-status node-onboarding-status-error">
      <span class="node-onboarding-spinner" aria-hidden="true"></span>
      <div>
        <b>Onboarding failed</b>
        <div>${escHtml(e.message)}</div>
      </div>
    </div>`;
    showNodeToast(`Onboarding failed: ${e.message}`, 'error');
  }
  lucide.createIcons();
}

function renderNodeOnboardingResult(onboarding, health) {
  const full = onboarding?.status === 'full';
  const detected = onboarding?.services?.detected || [];
  const onboarded = onboarding?.services?.onboarded || [];
  const skipped = [
    ...(onboarding?.skipped || []),
    ...(onboarding?.services?.skipped || []),
  ];
  const skippedHtml = skipped.length
    ? `<div class="node-onboarding-step">
        <b>Needs attention</b>
        <div class="node-onboarding-services">${skipped.map(s => `<div class="node-onboarding-row"><span>${escHtml(s.label || s.kind || 'item')}</span><span class="node-health-muted">${escHtml(s.reason || 'skipped')}</span></div>`).join('')}</div>
      </div>`
    : '';
  return `
    <div class="node-onboarding-status ${full ? 'node-onboarding-status-done' : 'node-onboarding-status-warning'}">
      <span class="node-onboarding-spinner" aria-hidden="true"></span>
      <div>
        <b>${full ? 'Fully onboarded' : 'Partially onboarded'}</b>
        <div>${escHtml(onboarding?.summary || health?.detail || '')}</div>
      </div>
    </div>
    <div class="node-onboarding-step">
      <b>Checks active</b>
      <div>${escHtml(health?.detail || 'Health watchers started.')}</div>
    </div>
    <div class="node-onboarding-step">
      <b>Managed services</b>
      <div>${detected.length ? `${detected.length} detected · ${onboarded.length} onboarded` : 'No known managed services detected. Host health is still active.'}</div>
      ${onboarded.length ? `<div class="node-onboarding-services">${onboarded.map(s => `<div class="node-onboarding-row"><span>${escHtml(s.label || s.kind)}</span><span class="cdraw-badge green">Monitoring</span></div>`).join('')}</div>` : ''}
    </div>
    ${skippedHtml}
  `;
}

async function toggleNodeAutoFix(nodeId, enabled) {
  try {
    const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/auto-fix`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !!enabled }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showNodeToast(`Auto-fix ${enabled ? 'enabled' : 'disabled'}`, 'success');
    await loadNodes();
  } catch (e) {
    showNodeToast(e.message, 'error');
    await loadNodes();
  }
}

function revokeAllNodes() {
  const count = _nodesList.length;
  if (!count) return;
  showNodeConfirmModal({
    title: `Revoke all ${count} paired node${count === 1 ? '' : 's'}?`,
    message: `Use this if you see a node you don't recognize, or after a suspected token compromise.\n\nThis will:\n• Tell every paired node to uninstall itself\n• Remove every node from the server\n• Revoke every node-agent session token for your account\n\nReconnect attempts will be refused. You'll need to re-pair any nodes you want back.\n\nContinue?`,
    confirmLabel: 'Revoke All',
    cancelLabel: 'Cancel',
    confirmClass: 'cdraw-btn-danger',
    onConfirm: async () => {
      try {
        const res = await fetch('/api/nodes/revoke-all', {
          method: 'POST',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showNodeToast(`Failed: ${err.error || res.statusText}`, 'error');
          return;
        }
        const data = await res.json().catch(() => ({}));
        showNodeToast(`Revoked ${data.removed ?? 0} node(s); ${data.sessionsRevoked ?? 0} session(s) cleared`, 'success');
        loadNodes();
      } catch (e) {
        showNodeToast(`Error: ${e.message}`, 'error');
      }
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
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          if (err.needsReprovision || err.error === 'legacy-agent') {
            showNodeToast(`${node.hostname} runs an older agent that can't verify updates — re-run the installer on the device to enable secure updates.`, 'error');
          } else {
            showNodeToast(`Update failed: ${err.error || res.statusText}`, 'error');
          }
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
    const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/status`);
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

// Coalesce a burst of WS events (a flapping node fires node_health repeatedly,
// admission events arrive in clusters) into a single drawer refresh. Without
// this each event ran a full loadNodes() — refetch /api/nodes + rebuild the
// whole drawer innerHTML + re-run lucide over it — storming during a flap.
let _nodesRefreshDebounce = null;
function scheduleNodesRefresh() {
  if (activeDrawerId !== 'drawerNodes') return;
  if (_nodesRefreshDebounce) return; // a refresh is already queued
  _nodesRefreshDebounce = setTimeout(() => {
    _nodesRefreshDebounce = null;
    if (activeDrawerId === 'drawerNodes') loadNodes();
  }, 600);
}

// ── Real-time health events from WebSocket ───────────────────────────────────
function handleNodeHealthEvent(msg) {
  if (msg.type === 'node_removed') {
    _nodesList = _nodesList.filter(n => n.nodeId !== msg.nodeId);
    scheduleNodesRefresh();
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

  // Re-render if drawer is open (debounced so a flapping node doesn't storm
  // full-drawer rebuilds; local state above is already patched in place).
  scheduleNodesRefresh();

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
// Shared modal for both "Pair New Node" and "re-provision an existing node"
// (the legacy-agent secure-update flow) — both hand the operator the same
// one-line installer + pairing code; only the framing differs.
function _showNodePairModal({ code, expiresIn, installUrl }, { title = 'Pair New Node', introHtml = '' } = {}) {
  const curlUrl = installUrl || `${location.protocol}//${location.host}/nodes/install.sh`;
  const serverUrl = curlUrl.replace(/\/nodes\/install\.sh(?:\?.*)?$/, '');
  const installCmd = `curl -fsSL ${curlUrl} | sh -s -- --server ${serverUrl} --code ${code}`;
  const repairCmd = `sudo oe repair ${code}`;

  const modal = document.createElement('div');
  modal.className = 'node-pair-modal';
  modal.innerHTML = `
    <div class="node-pair-modal-bg" data-action="_nodePairModalClose"></div>
    <div class="node-pair-modal-box">
      <div style="font-weight:700;font-size:15px;margin-bottom:12px">${escHtml(title)}</div>
      ${introHtml}
      <div style="font-size:12px;color:var(--muted);margin-bottom:16px;text-align:left">
        On the remote machine, run this one-line installer:<br>
        <code style="display:block;background:var(--bg2);padding:8px 10px;border-radius:6px;margin-top:8px;font-size:11px;user-select:all;word-break:break-all;line-height:1.4">${escHtml(installCmd)}</code>
        <button class="cdraw-btn" style="margin-top:8px;font-size:11px;padding:5px 10px" data-copy-text="${escHtml(installCmd).replace(/"/g, '&quot;')}">
          <i data-lucide="copy" style="width:12px;height:12px;margin-right:4px"></i> Copy Installer
        </button>
        <div style="margin-top:8px;font-size:11px">It will download Node.js, install the agent, pair it, and start the service without extra prompts.</div>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Pairing code for manual setup or repair:</div>
      <div class="node-pair-code">${code}</div>
      <code style="display:block;background:var(--bg2);padding:8px 10px;border-radius:6px;margin-top:10px;font-size:11px;user-select:all;word-break:break-all;line-height:1.4">${escHtml(repairCmd)}</code>
      <div style="font-size:11px;color:var(--muted);margin-top:12px">Expires in ${Math.floor(expiresIn / 60)} minutes</div>
      <button class="cdraw-btn" style="margin-top:16px;width:100%" data-action="_nodePairModalCloseInner">Close</button>
    </div>
  `;
  document.body.appendChild(modal);
  const copyBtn = modal.querySelector('[data-copy-text]');
  copyBtn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.copyText || installCmd);
      showNodeToast('Installer copied', 'success');
    } catch {
      showNodeToast('Copy failed', 'error');
    }
  });
  requestAnimationFrame(() => modal.classList.add('show'));
  lucide.createIcons();
}

async function pairNewNode() {
  try {
    const res = await fetch('/api/nodes/pair', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to generate pairing code');
    _showNodePairModal(await res.json(), {});
  } catch (e) {
    alert('Failed to generate pairing code: ' + e.message);
  }
}

// Re-provision a legacy node to enable secure (signed) updates: it can't be
// auto-upgraded over the network because it has no pinned key to verify the
// download, so the only safe path is re-running the installer ON the device,
// which re-pairs it and pins the signing key. It reconnects as the same node.
async function reprovisionNode(nodeId) {
  const node = _nodesList.find(n => n.nodeId === nodeId);
  const host = node?.hostname || 'this node';
  try {
    const res = await fetch('/api/nodes/pair', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to generate pairing code');
    const intro = `<div style="font-size:12px;color:var(--muted);text-align:left;background:var(--bg2);border-left:3px solid #d9a441;border-radius:6px;padding:8px 10px;margin-bottom:14px;line-height:1.5">
      <b>${escHtml(host)}</b> runs an older agent (${escHtml(node?.version || 'unknown')}) that can't verify signed updates, so auto-update is disabled for security. Re-run the installer <b>on ${escHtml(host)}</b> to upgrade it and switch to signed, verified updates — it reconnects as the same node.
    </div>`;
    _showNodePairModal(await res.json(), { title: `Enable Secure Updates on ${host}`, introHtml: intro });
  } catch (e) {
    alert('Failed to generate pairing code: ' + e.message);
  }
}

// Hook into the main WS message handler — this function is called from websocket.js
// We'll register it there via a global
window._nodeHealthHandler = handleNodeHealthEvent;
