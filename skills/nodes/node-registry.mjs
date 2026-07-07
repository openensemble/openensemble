/**
 * Node Registry — shared singleton for remote node management.
 * Imported by both routes/nodes.mjs (WS handler) and skills/nodes/execute.mjs (skill executor).
 */

import fs from 'fs';
import path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { BASE_DIR } from '../../lib/paths.mjs';
import { signManifestString, supportsSecureUpdates, getUpdatePublicKeyPem } from '../../lib/node-update-signing.mjs';

// ── State ────────────────────────────────────────────────────────────────────
// Connected AND disconnected nodes both live in `nodes`. Disconnected entries
// have `ws = null`, `health = 'disconnected'`, and `disconnectedAt = <ts>` so
// the UI can keep showing them as "offline" instead of making them vanish.
// The only way a node leaves this map is via removeNode() (explicit UI remove).
// Entries and the revocation list are persisted to nodes.json so a server
// restart doesn't silently drop registered nodes from the UI until they
// happen to reconnect.
const nodes = new Map();           // nodeId → node entry
const pendingCommands = new Map(); // cmdId → { resolve, reject, timer, chunks }
const ptyCallbacks = new Map();    // ptyId → (msg) => void — browser WS relay
const revokedNodes = new Map();    // `${userId}:${nodeId}` → revokedAt ts — prevents re-registration after remove

// Upper bound on live stream bytes we retain per command in cmd.chunks. The
// agent also caps what it streams; this is server-side defense so a noisy
// command can't grow memory unbounded.
const MAX_STREAM_CHUNK_BYTES = 2 * 1024 * 1024;

const NODES_PATH = path.join(BASE_DIR, 'nodes.json');

function hashToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function tokenHashMatches(storedHash, token) {
  if (!storedHash || !token) return false;
  const a = Buffer.from(String(storedHash), 'hex');
  const b = Buffer.from(hashToken(token), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function atomicWriteSync(filepath, data) {
  const tmp = `${filepath}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filepath);
}

function persistNodes() {
  try {
    const out = { nodes: [], revoked: [] };
    for (const entry of nodes.values()) {
      out.nodes.push({
        nodeId: entry.nodeId,
        userId: entry.userId,
        hostname: entry.hostname,
        platform: entry.platform,
        distro: entry.distro,
        arch: entry.arch,
        shell: entry.shell,
        packageManager: entry.packageManager,
        ip: entry.ip,
        capabilities: entry.capabilities,
        accessLevel: entry.accessLevel,
        accessLocked: entry.accessLocked,
        // Per-node file-read allowlist for node_read_file. Server-side check
        // before dispatching to the agent. NOT enforced by node_exec —
        // node_exec is a higher-privilege tool that bypasses this list by
        // design. Agents that should be limited to allowlisted reads
        // shouldn't have node_exec in their toolset.
        readableFolders: entry.readableFolders || [],
        // parent_host: optional pointer to a hypervisor/storage host that owns
        // this node's guest (Proxmox LXC/VM, ZFS dataset on TrueNAS, etc.).
        // Enables host-level rollback for high-risk ops via lib/host-snapshot.mjs.
        parentHost: entry.parentHost || null,
        autoFixEnabled: !!entry.autoFixEnabled,
        onboarding: entry.onboarding || null,
        version: entry.version,
        registeredAt: entry.registeredAt,
        disconnectedAt: entry.ws ? null : (entry.disconnectedAt ?? Date.now()),
        restartCount: entry.restartCount,
        tokenHash: entry.tokenHash || null,
        tokenPrefix: entry.tokenPrefix || null,
      });
    }
    for (const [key, ts] of revokedNodes) out.revoked.push({ key, ts });
    atomicWriteSync(NODES_PATH, JSON.stringify(out));
  } catch (e) { console.warn('[nodes] Failed to persist nodes.json:', e.message); }
}

// Called once at startup (before WSS starts accepting connections) so the UI
// shows previously-registered nodes as offline until they reconnect instead of
// making them appear removed.
export function loadPersistedNodes() {
  try {
    if (!fs.existsSync(NODES_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(NODES_PATH, 'utf8'));
    const now = Date.now();
    let loadedNodes = 0;
    for (const n of raw.nodes || []) {
      if (!n.nodeId || !n.userId) continue;
      if (nodes.has(n.nodeId)) continue;
      nodes.set(n.nodeId, {
        ws: null,
        userId: n.userId,
        nodeId: n.nodeId,
        hostname: n.hostname || 'unknown',
        platform: n.platform || 'linux',
        distro: n.distro || 'unknown',
        arch: n.arch || 'x64',
        shell: n.shell || '/bin/bash',
        packageManager: n.packageManager || 'unknown',
        ip: n.ip || null,
        capabilities: n.capabilities || [],
        accessLevel: n.accessLevel || 'unknown',
        accessLocked: !!n.accessLocked,
        readableFolders: Array.isArray(n.readableFolders) ? n.readableFolders : [],
        parentHost: n.parentHost || null,
        autoFixEnabled: !!n.autoFixEnabled,
        onboarding: n.onboarding || null,
        version: n.version || 'unknown',
        registeredAt: n.registeredAt || now,
        lastHeartbeat: n.registeredAt || now,
        stats: null,
        health: 'disconnected',
        missedPings: 0,
        lastStatsAt: null,
        lastStatsRequestedAt: null,
        disconnectedAt: n.disconnectedAt || now,
        recoveredAt: null,
        restartCount: n.restartCount || 0,
        uptimeSince: n.registeredAt || now,
        tokenHash: n.tokenHash || null,
        tokenPrefix: n.tokenPrefix || null,
      });
      loadedNodes++;
    }
    let loadedRevoked = 0;
    for (const r of raw.revoked || []) {
      if (r.key) { revokedNodes.set(r.key, r.ts || now); loadedRevoked++; }
    }
    if (loadedNodes || loadedRevoked) {
      console.log(`[nodes] Loaded ${loadedNodes} node(s) + ${loadedRevoked} revocation(s) from disk`);
    }
  } catch (e) { console.warn('[nodes] Failed to load nodes.json:', e.message); }
}

let _broadcastToUser = null;  // injected: (userId, msg) => void
let _appendToSession = null;  // injected: (agentId, msg) => void
let _getCoordinator  = null;  // injected: (userId) => coordinatorAgentId

// ── Injection (called once at startup from routes/nodes.mjs) ─────────────────
export function injectDeps({ broadcastToUser, appendToSession, getCoordinator }) {
  _broadcastToUser = broadcastToUser;
  _appendToSession = appendToSession;
  _getCoordinator  = getCoordinator;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function genCmdId() {
  return `cmd_${Date.now()}_${randomBytes(3).toString('hex')}`;
}

function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatUptime(seconds) {
  if (!seconds || seconds < 0) return 'unknown';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(1)}${units[i]}`;
}

// ── Broadcast helpers ────────────────────────────────────────────────────────
function broadcastNodeEvent(userId, event) {
  if (_broadcastToUser) _broadcastToUser(userId, event);
}

function notifyCoordinator(userId, message) {
  if (!_appendToSession || !_getCoordinator) return;
  try {
    const coordId = _getCoordinator(userId);
    if (coordId) {
      _appendToSession(coordId, { role: 'system', content: message, ts: Date.now() });
    }
  } catch (e) {
    console.warn('[nodes] Failed to notify coordinator:', e.message);
  }
}

function shouldAutoOnboardNode(entry, info = {}) {
  if (info.autoOnboard === false) return false;
  // Unit tests register fake WebSockets that never answer node_exec. Keep the
  // historical fake-node behavior unless a test explicitly opts in.
  if ((process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') && info.autoOnboard !== true) return false;
  if (entry.platform !== 'linux') return false;
  return entry.onboarding?.status !== 'full';
}

function ensureDraftSystemProfile(userId, nodeId, entry) {
  import('../../lib/node-system-profile.mjs')
    .then(({ ensureNodeSystemProfile }) => ensureNodeSystemProfile(userId, nodeId, {
      hostname: entry.hostname,
      platform: entry.platform,
    }))
    .catch(e => console.warn(`[nodes] system-profile bootstrap failed for ${nodeId}: ${e.message}`));
}

function scheduleAutoOnboarding(userId, nodeId, entry, info = {}) {
  if (!shouldAutoOnboardNode(entry, info)) {
    ensureDraftSystemProfile(userId, nodeId, entry);
    return;
  }
  const timer = setTimeout(async () => {
    const current = nodes.get(nodeId);
    if (!current || current.userId !== userId || !current.ws) return;
    try {
      const { runNodeOnboarding } = await import('../../lib/node-onboarding.mjs');
      const result = await runNodeOnboarding({
        userId,
        node: nodeToWire(current),
        scope: 'safe',
        execFn: async (command) => sendCommand(nodeId, userId, {
          type: 'exec',
          command,
          timeout: 45,
        }),
      });
      setNodeOnboardingState(nodeId, userId, result);
      broadcastNodeEvent(userId, {
        type: 'node_health',
        nodeId,
        health: current.health,
        message: `${current.hostname} System Health ${result.status === 'full' ? 'fully onboarded' : 'partially onboarded'}`,
      });
    } catch (e) {
      console.warn(`[nodes] auto-onboarding failed for ${nodeId}: ${e.message}`);
      ensureDraftSystemProfile(userId, nodeId, current);
    }
  }, 1500);
  timer.unref?.();
}

// ── Revocation ────────────────────────────────────────────────────────────────
function revocationKey(userId, nodeId) { return `${userId}:${nodeId}`; }

export function isRevoked(userId, nodeId) {
  return revokedNodes.has(revocationKey(userId, nodeId));
}

export function rememberNodeSessionToken(userId, nodeId, token) {
  const entry = nodes.get(nodeId);
  if (!entry || entry.userId !== userId || !token) return false;
  const tokenHash = hashToken(token);
  if (entry.tokenHash === tokenHash) return true;
  entry.tokenHash = tokenHash;
  entry.tokenPrefix = token.slice(0, 8);
  persistNodes();
  return true;
}

export function reviveNodeSessionFromToken(token) {
  if (!token) return null;
  for (const entry of nodes.values()) {
    if (!entry.tokenHash) continue;
    if (!tokenHashMatches(entry.tokenHash, token)) continue;
    if (isRevoked(entry.userId, entry.nodeId)) return null;
    return { userId: entry.userId, nodeId: entry.nodeId };
  }
  return null;
}

// Read-only lookup for the sessions list (routes/misc.mjs GET /api/sessions):
// given a node session's full token, resolve which node it belongs to so the
// UI can show a real hostname instead of a generic "node" label. Reuses the
// exact same hash-compare as reviveNodeSessionFromToken (tokenHashMatches) —
// no second hashing scheme — but unlike that function this NEVER mutates
// revocation/timestamp state; it's a pure read called on every page load.
// Returns null for no match OR a revoked node (display shouldn't out a
// revoked node's identity either).
export function findNodeByToken(token) {
  if (!token) return null;
  for (const entry of nodes.values()) {
    if (!entry.tokenHash) continue;
    if (!tokenHashMatches(entry.tokenHash, token)) continue;
    if (isRevoked(entry.userId, entry.nodeId)) return null;
    return { nodeId: entry.nodeId, hostname: entry.hostname, userId: entry.userId };
  }
  return null;
}

// NOTE: reviveLegacyNodeSession() was removed (2026-07-06). It adopted a
// caller-supplied token as the node owner's full session using a LAN-forgeable
// hostname as the only identity proof — an account-takeover vector. Legacy
// (pre-tokenHash) nodes now re-pair instead; see routes/nodes/websocket.mjs's
// register handler. reviveNodeSessionFromToken() (below) remains the sole,
// tokenHash-verified revival path.

// ── Registration ─────────────────────────────────────────────────────────────
export function registerNode(ws, userId, info) {
  const nodeId = info.nodeId || `node_${info.hostname}_${randomBytes(3).toString('hex')}`;

  // Refuse registration if this nodeId was explicitly removed by the user —
  // UNLESS the agent authenticated with a session minted AFTER the
  // revocation. Pairing codes and admission approvals are admin-issued, so a
  // post-revocation token proves the user deliberately re-added this machine
  // ("re-pair intentionally" is the documented way back in); the removed
  // agent's own token predates its revocation and stays refused.
  if (isRevoked(userId, nodeId)) {
    const revokedAt = revokedNodes.get(revocationKey(userId, nodeId)) || 0;
    if (info.sessionCreatedAt && info.sessionCreatedAt > revokedAt) {
      revokedNodes.delete(revocationKey(userId, nodeId));
      persistNodes();
      console.log(`[nodes] Revocation cleared for ${nodeId}: re-paired with a session minted after removal`);
    } else {
      console.log(`[nodes] Refusing registration of revoked node ${nodeId} for user ${userId}`);
      try {
        ws.send(JSON.stringify({ type: 'revoked', message: 'This node was removed by the user. Uninstall the agent to stop reconnect attempts.' }));
        ws.close(4003, 'Revoked');
      } catch {}
      return null;
    }
  }

  // Check if this is a reconnect (entry still in `nodes`, possibly marked disconnected)
  const oldEntry = nodes.get(nodeId);
  const restartCount = oldEntry?.restartCount ?? 0;
  const isReconnect = !!oldEntry;

  // If an old WS is still open on the existing entry (rare — agent restart
  // beat our unregister), force-close it before accepting the new socket.
  if (oldEntry?.ws && oldEntry.ws !== ws) {
    try { oldEntry.ws.close(4000, 'Replaced by new connection'); } catch {}
    rejectPendingForNode(nodeId);
  }

  const now = Date.now();
  const entry = {
    ws,
    userId,
    nodeId,
    hostname: info.hostname || 'unknown',
    platform: info.platform || 'linux',
    distro: info.distro || info.platform || 'unknown',
    arch: info.arch || 'x64',
    shell: info.shell || '/bin/bash',
    packageManager: info.packageManager || 'unknown',
    ip: info.ip || null,
    capabilities: info.capabilities || [],
    accessLevel: info.accessLevel || 'unknown',
    accessLocked: !!info.accessLocked,
    // Preserve user-configured readableFolders across reconnects — the agent
    // doesn't know about this list, only the OE server does, so a fresh
    // entry from a reconnecting agent would otherwise wipe it.
    readableFolders: oldEntry?.readableFolders || [],
    // Same for parent_host — agent never knows about this; preserve it.
    parentHost: oldEntry?.parentHost || null,
    autoFixEnabled: !!oldEntry?.autoFixEnabled,
    onboarding: oldEntry?.onboarding || null,
    tokenHash: oldEntry?.tokenHash || null,
    tokenPrefix: oldEntry?.tokenPrefix || null,
    version: info.version || 'unknown',
    registeredAt: now,
    lastHeartbeat: now,
    stats: null,
    lastStatsAt: null,
    lastStatsRequestedAt: null,
    // Health tracking
    health: isReconnect ? 'recovered' : 'healthy',
    missedPings: 0,
    disconnectedAt: null,
    recoveredAt: isReconnect ? now : null,
    restartCount: isReconnect ? restartCount + 1 : 0,
    uptimeSince: now,
  };

  nodes.set(nodeId, entry);
  persistNodes();

  console.log(`[nodes] ${isReconnect ? 'Reconnected' : 'Registered'}: ${nodeId} (${info.hostname}) for user ${userId}`);

  // New Linux nodes should populate System Health on their own. The background
  // pass is read-only and safe; the drawer's Onboard button remains for
  // re-running checks or explicitly including restart-required work later.
  scheduleAutoOnboarding(userId, nodeId, entry, info);

  if (isReconnect) {
    const downtime = oldEntry?.disconnectedAt ? now - oldEntry.disconnectedAt : 0;
    broadcastNodeEvent(userId, {
      type: 'node_health', nodeId,
      health: 'recovered',
      restartCount: entry.restartCount,
      downtime,
      message: `${entry.hostname} reconnected (restart #${entry.restartCount})`,
    });
    notifyCoordinator(userId,
      `[System] Node "${entry.hostname}" (${nodeId}) reconnected after ${Math.round(downtime / 1000)}s downtime (restart #${entry.restartCount})`
    );
  }

  return nodeId;
}

// User-initiated removal: drops the node from memory, rejects pending commands,
// closes any live WS, and records the revocation so the agent can't re-register
// on its own. The agent should uninstall to stop reconnect attempts.
export function removeNode(nodeId, userId) {
  const entry = nodes.get(nodeId);
  if (!entry) return { removed: false, reason: 'not found' };
  if (entry.userId !== userId) return { removed: false, reason: 'not owned by user' };

  revokedNodes.set(revocationKey(userId, nodeId), Date.now());

  // If currently connected: send a revocation message and close the WS
  try {
    if (entry.ws && entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(JSON.stringify({ type: 'revoked', message: 'This node was removed by the user. Uninstall the agent to stop reconnect attempts.' }));
      entry.ws.close(4003, 'Revoked');
    }
  } catch {}
  rejectPendingForNode(nodeId);
  nodes.delete(nodeId);
  persistNodes();

  broadcastNodeEvent(userId, { type: 'node_removed', nodeId });
  console.log(`[nodes] Removed: ${nodeId} for user ${userId}`);
  return { removed: true };
}

export function unregisterNode(nodeId) {
  const entry = nodes.get(nodeId);
  if (!entry) return;
  // Already marked disconnected — nothing to do (guards against double-fire
  // from both 'close' and a forced replacement).
  if (entry.health === 'disconnected' && !entry.ws) return;

  const now = Date.now();

  // Mark the entry as disconnected in-place so the UI keeps showing it as
  // offline. The entry is only fully removed when the user clicks Remove.
  entry.ws = null;
  entry.health = 'disconnected';
  entry.disconnectedAt = now;
  entry.missedPings = 0;
  persistNodes();

  // Clean up pending commands
  rejectPendingForNode(nodeId);

  // Tear down any live terminal (PTY) sessions bound to this node so the
  // browser xterm gets a real error/close instead of sitting "Connected" but
  // dead until the user notices.
  for (const [ptyId, cb] of ptyCallbacks) {
    if (cb.nodeId !== nodeId) continue;
    try {
      cb.callback({ type: 'pty_error', ptyId, message: `${entry.hostname} disconnected` });
    } catch {}
    ptyCallbacks.delete(ptyId);
  }

  // Notify
  broadcastNodeEvent(entry.userId, {
    type: 'node_health', nodeId,
    health: 'disconnected',
    message: `${entry.hostname} disconnected`,
  });
  notifyCoordinator(entry.userId,
    `[System] Node "${entry.hostname}" (${nodeId}) went offline at ${new Date(now).toISOString()}`
  );

  console.log(`[nodes] Disconnected: ${nodeId} (${entry.hostname})`);
}

// Patterns that indicate a command is sitting at an interactive prompt with
// no way to receive input over node_exec's non-interactive channel. We match
// at the END of the stream buffer — a finished line would have a trailing
// newline, so prompts (which keep cursor on the same line waiting for typing)
// are detectable as "ends with a known phrase + no newline".
const INTERACTIVE_PROMPT_PATTERNS = [
  /\[sudo\] password for [^\s]+:\s*$/i,
  /(^|\n)password:\s*$/i,
  /Please enter your password:?\s*$/i,
  /Sorry, try again\.\s*$/i,                         // sudo retry — we already failed once
  /Are you sure you want to continue connecting[^?]*\?\s*$/i,
  /\([yY]\/[nN]\)\??\s*$/,                           // common confirmation prompts
  /\(yes\/no\)\??\s*$/i,
];

function looksLikeInteractivePrompt(text) {
  if (!text) return null;
  // Strip trailing whitespace except don't be fooled by control codes.
  // Most prompts won't have a trailing newline; a finished line would.
  const tail = text.replace(/[\x00-\x1f]/g, ' ').trimEnd();
  for (const pat of INTERACTIVE_PROMPT_PATTERNS) {
    const m = tail.match(pat);
    if (m) return m[0];
  }
  return null;
}

function rejectPendingForNode(nodeId) {
  for (const [cmdId, cmd] of pendingCommands) {
    if (cmd.nodeId === nodeId) {
      clearTimeout(cmd.timer);
      cmd.reject(new Error('Node disconnected'));
      pendingCommands.delete(cmdId);
    }
  }
}

// ── Queries ──────────────────────────────────────────────────────────────────
export function getNodes(userId) {
  const result = [];
  for (const entry of nodes.values()) {
    if (entry.userId === userId) {
      result.push(nodeToWire(entry));
    }
  }
  return result;
}

export function getNode(nodeId, userId) {
  // Primary lookup: exact nodeId match.
  let entry = nodes.get(nodeId);
  if (!entry || entry.userId !== userId) {
    // Fallback: hostname match (node_list displays "hostname (nodeId)"
    // so models frequently pass the hostname).
    entry = null;
    const needle = String(nodeId).toLowerCase();
    for (const e of nodes.values()) {
      if (e.userId === userId && e.hostname?.toLowerCase() === needle) { entry = e; break; }
    }
  }
  if (!entry || entry.userId !== userId) return null;
  return nodeToWire(entry);
}

function nodeToWire(entry) {
  return {
    nodeId: entry.nodeId,
    hostname: entry.hostname,
    platform: entry.platform,
    distro: entry.distro,
    arch: entry.arch,
    shell: entry.shell,
    packageManager: entry.packageManager,
    ip: entry.ip,
    capabilities: entry.capabilities,
    accessLevel: entry.accessLevel,
    accessLocked: entry.accessLocked,
    readableFolders: entry.readableFolders || [],
    parentHost: entry.parentHost || null,
    autoFixEnabled: !!entry.autoFixEnabled,
    onboarding: entry.onboarding || null,
    version: entry.version || 'unknown',
    // false = legacy agent that can't verify signed updates; the UI shows a
    // "re-run the installer" prompt instead of an Update button (the server
    // also refuses to push auto-updates to it — see pushUpdate).
    secureUpdates: supportsSecureUpdates(entry.version),
    registeredAt: entry.registeredAt,
    lastHeartbeat: entry.lastHeartbeat,
    health: entry.health,
    restartCount: entry.restartCount,
    recoveredAt: entry.recoveredAt,
    disconnectedAt: entry.disconnectedAt,
    uptimeSince: entry.uptimeSince,
    lastStatsAt: entry.lastStatsAt,
    stats: entry.stats,
    formattedUptime: formatUptime(entry.stats?.uptime),
    formattedMem: entry.stats
      ? `${formatBytes(entry.stats.memUsed)}/${formatBytes(entry.stats.memTotal)}`
      : null,
  };
}

// ── readable-folder allowlist ────────────────────────────────────────────────
//
// Per-node allowlist for node_read_file. Updates persist to nodes.json and
// survive reconnects. Returns the new wire-shape on success, or null if the
// node isn't owned by this user / doesn't exist (so callers can't probe
// other users' nodes).

// Resolve a user-supplied node identifier (id or hostname) to the internal
// entry. Match shape of getNode but returns the raw entry for mutation.
function resolveNodeEntry(nodeId, userId) {
  let entry = nodes.get(nodeId);
  if (!entry || entry.userId !== userId) {
    const needle = String(nodeId).toLowerCase();
    entry = null;
    for (const e of nodes.values()) {
      if (e.userId === userId && e.hostname?.toLowerCase() === needle) { entry = e; break; }
    }
  }
  return entry && entry.userId === userId ? entry : null;
}

// ── parent_host (hypervisor / storage backend pointer) ──────────────────────
//
// Per-node pointer to the host that can take a whole-guest snapshot of this
// node. Enables `lib/host-snapshot.mjs` to provide an outer rollback layer
// for high-risk ops. Shape:
//
//   { type: 'proxmox', api_url, api_token, node, vmid, kind: 'lxc'|'qemu' }
//   { type: 'zfs',     ssh_host, ssh_user?, dataset }
//
// `api_token` may be a literal string OR a token-storage reference like
// 'config_field:proxmox_api_token' / 'env:PROXMOX_TOKEN'; lib/host-snapshot
// resolves it through lib/token-storage when used. Storing references is
// preferred so secrets don't sit in nodes.json.

const VALID_PARENT_HOST_TYPES = new Set(['proxmox', 'zfs', 'btrfs']);

function validateParentHost(ph) {
  if (ph === null) return null;
  if (typeof ph !== 'object') throw new Error('parent_host must be object or null');
  if (!VALID_PARENT_HOST_TYPES.has(ph.type)) {
    throw new Error(`parent_host.type must be one of ${[...VALID_PARENT_HOST_TYPES].join(',')}`);
  }
  if (ph.type === 'proxmox') {
    for (const k of ['api_url', 'api_token', 'node', 'vmid', 'kind']) {
      if (ph[k] === undefined || ph[k] === null || ph[k] === '') {
        throw new Error(`parent_host (proxmox) requires ${k}`);
      }
    }
    if (!['lxc', 'qemu'].includes(ph.kind)) {
      throw new Error('parent_host.kind must be "lxc" or "qemu"');
    }
    if (ph.vmstate !== undefined && typeof ph.vmstate !== 'boolean') {
      throw new Error('parent_host.vmstate must be boolean');
    }
    if (ph.kind === 'lxc' && ph.vmstate) {
      throw new Error('parent_host.vmstate only valid for kind:"qemu" (LXC has no separate memory state)');
    }
  } else if (ph.type === 'zfs') {
    for (const k of ['ssh_host', 'dataset']) {
      if (!ph[k]) throw new Error(`parent_host (zfs) requires ${k}`);
    }
  } else if (ph.type === 'btrfs') {
    for (const k of ['subvolume', 'snapshot_dir']) {
      if (!ph[k]) throw new Error(`parent_host (btrfs) requires ${k}`);
    }
  }
  return ph;
}

export function setParentHost(nodeId, userId, parentHost) {
  const entry = resolveNodeEntry(nodeId, userId);
  if (!entry) return null;
  entry.parentHost = validateParentHost(parentHost);
  persistNodes();
  return nodeToWire(entry);
}

export function getParentHost(nodeId, userId) {
  const entry = resolveNodeEntry(nodeId, userId);
  return entry?.parentHost || null;
}

export function setNodeAutoFix(nodeId, userId, enabled) {
  const entry = resolveNodeEntry(nodeId, userId);
  if (!entry) return null;
  entry.autoFixEnabled = !!enabled;
  persistNodes();
  return nodeToWire(entry);
}

export function getNodeAutoFixEnabled(nodeId, userId) {
  const entry = resolveNodeEntry(nodeId, userId);
  return entry ? !!entry.autoFixEnabled : null;
}

export function setNodeOnboardingState(nodeId, userId, onboarding) {
  const entry = resolveNodeEntry(nodeId, userId);
  if (!entry) return null;
  entry.onboarding = onboarding && typeof onboarding === 'object' ? onboarding : null;
  persistNodes();
  return nodeToWire(entry);
}

export function setReadableFolders(nodeId, userId, paths) {
  const entry = resolveNodeEntry(nodeId, userId);
  if (!entry) return null;
  // Normalize: trim, drop empties, require absolute paths, dedupe.
  const norm = [...new Set((paths || [])
    .map(p => String(p || '').trim())
    .filter(p => p.length > 0 && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))))];
  entry.readableFolders = norm;
  persistNodes();
  return nodeToWire(entry);
}

// True if `path` is reachable under one of the allowlisted prefixes. We
// require an exact match or a path-segment-aligned prefix match so a
// `readableFolders=['/home/user/Documents']` setting does NOT permit reads
// of `/home/user/Documents.bak/foo` or other accidental siblings.
//
// Also rejects paths containing `..` to keep the canonical form. Symlink
// traversal beyond the allowlist is the agent's concern — defense in depth
// belongs on the node, not the OE server.
export function isPathAllowed(nodeId, userId, requestedPath) {
  const entry = resolveNodeEntry(nodeId, userId);
  if (!entry) return false;
  const list = entry.readableFolders || [];
  if (!list.length) return false;
  const p = String(requestedPath || '');
  if (!p || p.includes('/../') || p.endsWith('/..') || p.startsWith('../')) return false;
  for (const allowed of list) {
    if (p === allowed) return true;
    const prefix = allowed.endsWith('/') ? allowed : allowed + '/';
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

// ── Command dispatch ─────────────────────────────────────────────────────────
// Per-node concurrency guard — prevents LLM retry storms from hammering a node
// with simultaneous exec calls. Commands beyond the limit are rejected
// immediately with a clear error so the model sees the backpressure. Sized
// to absorb a tick-aligned burst of profile-health signals (system + 1-2
// service profiles, ~8 signals total) plus a couple of LLM-driven exec calls
// without flapping signals into "is busy" rejections.
const MAX_CONCURRENT_PER_NODE = 10;

function countInflight(nodeId) {
  let n = 0;
  for (const cmd of pendingCommands.values()) {
    if (cmd.nodeId === nodeId) n++;
  }
  return n;
}

function dispatchCommand(nodeId, userId, payload, { onChunk } = {}) {
  return new Promise((resolve, reject) => {
    // Match getNode/getNode-style resolution: try exact id first, then fall
    // back to hostname match. The exact-id-only lookup was a hidden
    // inconsistency — getNode tolerated hostnames but sendCommand didn't,
    // so callers that resolved a node via getNode then dispatched against
    // the same string sometimes got "not found" if they used a hostname.
    const entry = resolveNodeEntry(nodeId, userId);
    if (!entry) {
      return reject(new Error(`Node "${nodeId}" not found or not connected`));
    }
    if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) {
      return reject(new Error(`Node "${entry.hostname}" is offline`));
    }

    const inflight = countInflight(nodeId);
    if (inflight >= MAX_CONCURRENT_PER_NODE) {
      return reject(new Error(
        `Node "${entry.hostname}" is busy (${inflight} commands already in flight, max ${MAX_CONCURRENT_PER_NODE}). ` +
        `Wait for previous commands to finish before sending more.`
      ));
    }

    const cmdId = genCmdId();
    const timeout = Math.min(payload.timeout || 60, 300);

    const timer = setTimeout(() => {
      pendingCommands.delete(cmdId);
      reject(new Error(`Command timed out after ${timeout}s`));
    }, timeout * 1000);

    // Track pending under the canonical nodeId (entry.nodeId), not the
    // caller's possibly-hostname input. Otherwise rejectPendingForNode
    // (called on disconnect with the canonical id) wouldn't match this
    // pending and the op would hang until timeout.
    const pending = { resolve, reject, timer, nodeId: entry.nodeId, chunks: [] };
    if (onChunk) pending.onChunk = onChunk;
    pendingCommands.set(cmdId, pending);

    try {
      entry.ws.send(JSON.stringify({ ...payload, cmdId }));
    } catch (e) {
      clearTimeout(timer);
      pendingCommands.delete(cmdId);
      reject(new Error(`Failed to send command: ${e.message}`));
    }
  });
}

export function sendCommand(nodeId, userId, payload) {
  return dispatchCommand(nodeId, userId, payload);
}

export function sendCommandStreaming(nodeId, userId, payload, onChunk) {
  return dispatchCommand(nodeId, userId, payload, { onChunk });
}

// ── Message handling ─────────────────────────────────────────────────────────
export function handleNodeMessage(nodeId, msg) {
  const entry = nodes.get(nodeId);
  if (!entry) return;

  switch (msg.type) {
    case 'cmd_result': {
      const cmd = pendingCommands.get(msg.cmdId);
      // Ownership check: a paired node must only resolve its OWN pending
      // commands. Without this, any node could forge a cmd_result for another
      // node's cmdId and inject fabricated output.
      if (!cmd || cmd.nodeId !== nodeId) return;
      clearTimeout(cmd.timer);
      pendingCommands.delete(msg.cmdId);
      cmd.resolve({
        stdout: msg.stdout ?? '',
        stderr: msg.stderr ?? '',
        exitCode: msg.exitCode ?? -1,
        duration: msg.duration ?? 0,
      });
      break;
    }

    case 'cmd_stream': {
      const cmd = pendingCommands.get(msg.cmdId);
      // Ownership check (see cmd_result) — reject forged streams from other nodes.
      if (!cmd || cmd.nodeId !== nodeId) return;
      // Bound the accumulated chunk buffer so a noisy command (journalctl -f,
      // cat /dev/urandom) can't grow server memory without limit.
      cmd._chunkBytes = (cmd._chunkBytes || 0) + (msg.data?.length || 0);
      if (cmd._chunkBytes <= MAX_STREAM_CHUNK_BYTES) {
        cmd.chunks.push(msg.data);
      } else if (!cmd._chunksTruncated) {
        cmd._chunksTruncated = true;
        cmd.chunks.push('\n[output truncated: stream cap reached]\n');
      }
      if (cmd.onChunk) cmd.onChunk(msg.stream, msg.data);

      // Detect interactive-input prompts that would otherwise hang for the
      // full timeout. node_exec runs commands via `bash -c` with no terminal,
      // but tools like sudo open /dev/tty directly so they're not stopped by
      // a closed stdin — they just sit there waiting for nothing.
      // Heuristic: prompt-shaped ending (no trailing newline, ends with a
      // known phrase) → reject immediately so the agent gets a real error.
      // The remote process is still alive and will timeout naturally; we
      // just don't make the user wait for it.
      if (!cmd._promptDetected) {
        cmd._streamBuf = ((cmd._streamBuf || '') + msg.data).slice(-2048);
        const prompt = looksLikeInteractivePrompt(cmd._streamBuf);
        if (prompt) {
          cmd._promptDetected = true;
          clearTimeout(cmd.timer);
          pendingCommands.delete(msg.cmdId);
          cmd.reject(new Error(
            `Command is waiting for interactive input ("${prompt.trim()}"). ` +
            `node_exec has no terminal so this would hang until timeout. ` +
            `Try one of: (1) configure passwordless sudo for the node-agent user; ` +
            `(2) onboard this service as a profile so operations go via API/managed paths instead of CLI ` +
            `(see profile_save / dispatch_op in the profiles skill); ` +
            `(3) re-run with non-interactive flags (e.g. add -y / --yes / --batch).`
          ));
        }
      }
      break;
    }

    case 'status_result': {
      const cmd = pendingCommands.get(msg.cmdId);
      // Ownership check (see cmd_result) — reject forged status from other nodes.
      if (!cmd || cmd.nodeId !== nodeId) return;
      clearTimeout(cmd.timer);
      pendingCommands.delete(msg.cmdId);
      // Resolve with the full status object (not stdout/stderr)
      const { type: _t, cmdId: _c, ...statusData } = msg;
      cmd.resolve(statusData);
      break;
    }

    case 'pong': {
      const wasUnhealthy = entry.health !== 'healthy';
      entry.missedPings = 0;
      entry.lastHeartbeat = Date.now();
      if (msg.stats) {
        entry.stats = msg.stats;
        entry.lastStatsAt = Date.now();
      }

      if (entry.health === 'recovered' || entry.health === 'stale') {
        entry.health = 'healthy';
        broadcastNodeEvent(entry.userId, {
          type: 'node_health', nodeId,
          health: 'healthy',
          message: `${entry.hostname} is healthy`,
        });
      }
      break;
    }

    case 'uninstall_ack': {
      console.log(`[nodes] ${nodeId} acknowledged uninstall`);
      break;
    }

    case 'update_result': {
      const status = msg.ok ? `OK (${msg.size} bytes)` : `FAILED: ${msg.error}`;
      console.log(`[nodes] Update on ${nodeId}: ${status}`);
      broadcastNodeEvent(entry.userId, {
        type: 'node_update_result', nodeId,
        ok: !!msg.ok, size: msg.size || null, error: msg.error || null,
      });
      // Self-heal the keyless-v2 migration gap: an agent that got v2 code via
      // `oe update` (which historically didn't pin the signing key) rejects
      // every signed push with this exact error. The exec channel already
      // carries arbitrary root commands, so delivering the PUBLIC key over it
      // adds no new trust — pin it, restart the agent, re-push once.
      if (!msg.ok && /no pinned update-signing key/i.test(msg.error || '')) {
        remediateMissingUpdateKey(entry).catch(e =>
          console.warn(`[nodes] ${nodeId} update-key self-heal failed: ${e.message}`));
      }
      break;
    }

    case 'pty_output':
    case 'pty_exit':
    case 'pty_started':
    case 'pty_error': {
      const cb = ptyCallbacks.get(msg.ptyId);
      if (cb) cb.callback(msg);
      break;
    }

    default:
      console.warn(`[nodes] Unknown message type from ${nodeId}: ${msg.type}`);
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────────────
let _heartbeatInterval = null;
const STATS_POLL_INTERVAL_MS = 5 * 60 * 1000;

export function startHeartbeat(intervalMs = 60000) {
  if (_heartbeatInterval) clearInterval(_heartbeatInterval);

  _heartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const [nodeId, entry] of nodes) {
      // Skip disconnected entries (kept in the map for UI display)
      if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) continue;

      // Check health before sending ping
      entry.missedPings++;
      if (entry.missedPings >= 3 && entry.health === 'healthy') {
        entry.health = 'stale';
        broadcastNodeEvent(entry.userId, {
          type: 'node_health', nodeId,
          health: 'stale',
          message: `${entry.hostname} is not responding`,
        });
      }

      try {
        const wantStats = !entry.lastStatsRequestedAt || (now - entry.lastStatsRequestedAt) >= STATS_POLL_INTERVAL_MS;
        if (wantStats) entry.lastStatsRequestedAt = now;
        entry.ws.send(JSON.stringify({ type: 'ping', wantStats }));
      } catch {}
    }
  }, intervalMs);
}

export function stopHeartbeat() {
  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
  }
}

// ── PTY relay ───────────────────────────────────────────────────────────────
export function sendPtyMessage(nodeId, userId, msg) {
  const entry = nodes.get(nodeId);
  if (!entry || entry.userId !== userId) return false;
  if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) return false;
  try { entry.ws.send(JSON.stringify(msg)); return true; }
  catch { return false; }
}

export function registerPtyCallback(ptyId, nodeId, callback) {
  ptyCallbacks.set(ptyId, { nodeId, callback });
}

export function unregisterPtyCallback(ptyId) {
  ptyCallbacks.delete(ptyId);
}

// Return whether a node currently has a live (OPEN) WebSocket. getNode returns
// disconnected entries too (kept for UI display), so callers that need to
// actually reach the agent — e.g. opening a PTY — must check this.
export function isNodeConnected(nodeId, userId) {
  const entry = nodes.get(nodeId);
  if (!entry || entry.userId !== userId) {
    // Allow hostname-form ids (getNode does the same fallback).
    const needle = String(nodeId).toLowerCase();
    for (const e of nodes.values()) {
      if (e.userId === userId && e.hostname?.toLowerCase() === needle) {
        return !!e.ws && e.ws.readyState === e.ws.OPEN;
      }
    }
    return false;
  }
  return !!entry.ws && entry.ws.readyState === entry.ws.OPEN;
}

// ── Push uninstall ──────────────────────────────────────────────────────────
// Tells the agent to run its self-destruct script, then revokes + removes.
// Returns { ok, error? }. Best-effort: if the node is offline, we just revoke.
export function pushUninstall(nodeId, userId) {
  const entry = nodes.get(nodeId);
  if (!entry || entry.userId !== userId) return { ok: false, error: 'node not found' };
  try {
    if (entry.ws && entry.ws.readyState === entry.ws.OPEN) {
      entry.ws.send(JSON.stringify({ type: 'uninstall', message: 'Removed by user' }));
    }
  } catch {}
  return { ok: true };
}

// ── Missing-update-key self-heal ────────────────────────────────────────────
// A v2 agent with no pinned signing key (upgraded via `oe update` before that
// path learned to pin) rejects every dashboard push. Fix it in place over the
// exec channel: write the public key into the agent's config file(s), restart
// the service, and re-push the update once it reconnects. Cooldown-gated so a
// node that still fails after remediation can't loop (its second rejection
// lands inside the cooldown and is dropped).
const KEY_FIX_COOLDOWN_MS = 10 * 60 * 1000;

async function remediateMissingUpdateKey(entry) {
  const { nodeId, userId } = entry;
  const now = Date.now();
  if ((entry._keyFixAt || 0) > now - KEY_FIX_COOLDOWN_MS) return;
  entry._keyFixAt = now;
  if (entry.accessLevel !== 'full') {
    console.log(`[nodes] ${nodeId} rejected update (no pinned key) but accessLevel=${entry.accessLevel} — cannot self-heal over exec; re-pair it manually`);
    return;
  }
  const pem = getUpdatePublicKeyPem();
  const b64 = Buffer.from(pem, 'utf8').toString('base64');
  // The key rides as argv[1] (node -e makes extra args argv[1..]) so the
  // script itself stays double-quotes-only and survives the single-quoted
  // shell wrapping. Both candidate config locations are patched — the root
  // CLI and the service user can have separate ~/.oe-node dirs. The restart
  // is detached so cmd_result gets flushed before systemd tears the agent down.
  const js = 'const fs=require("fs");const pem=Buffer.from(process.argv[1],"base64").toString("utf8");'
    + 'const cands=[...new Set([(process.env.HOME||"/root")+"/.oe-node/config.json","/opt/oe-node-agent/.oe-node/config.json","/root/.oe-node/config.json"])];'
    + 'let touched=0,had=0;'
    + 'for(const p of cands){let c;try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){continue}'
    + 'if(c.updatePublicKey){had++;continue}c.updatePublicKey=pem;fs.writeFileSync(p,JSON.stringify(c,null,2));touched++;console.log("pinned "+p)}'
    + 'if(!touched&&!had){console.error("no agent config found");process.exit(1)}';
  // Restart chain: plain systemctl for root installs, `sudo -n` for the
  // default oe-agent service user (the installer's sudoers rule grants
  // exactly this command NOPASSWD). setsid detaches into a new session so
  // the restart survives the agent's own process teardown.
  const command = `node -e '${js}' ${b64} && setsid -f sh -c "sleep 1; systemctl restart oe-node-agent 2>/dev/null || sudo -n systemctl restart oe-node-agent 2>/dev/null || service oe-node-agent restart" </dev/null >/dev/null 2>&1`;
  console.log(`[nodes] ${nodeId} has no pinned signing key — pinning over exec channel and retrying the update`);
  const res = await sendCommand(nodeId, userId, { type: 'exec', command, timeout: 30 });
  if (res.exitCode !== 0) {
    console.warn(`[nodes] ${nodeId} key pinning failed (exit ${res.exitCode}): ${(res.stderr || res.stdout || '').slice(0, 300)}`);
    return;
  }
  const back = await waitForNodeReconnect(nodeId, userId, 90_000);
  if (!back.ok) {
    console.warn(`[nodes] ${nodeId} did not reconnect after key pinning: ${back.reason}`);
    return;
  }
  const pushed = pushUpdate(nodeId, userId);
  console.log(`[nodes] ${nodeId} re-pushed update after key pinning: ${pushed.ok ? 'sent' : pushed.error}`);
}

// ── Push update ─────────────────────────────────────────────────────────────
// Tells a connected agent to re-download and restart itself. Fire-and-forget:
// the agent ACKs via an `update_result` message, then exits (systemd restarts it).
export function pushUpdate(nodeId, userId, url = null) {
  const entry = nodes.get(nodeId);
  if (!entry || entry.userId !== userId) return { ok: false, error: 'node not found' };
  if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) return { ok: false, error: 'node not connected' };

  // GATE: a legacy agent (pre-signing, no pinned public key) can't verify an
  // update's authenticity, so we refuse to auto-update it over the tamperable
  // plain-HTTP channel — it must re-run the installer to re-pair and pin the
  // signing key. The UI surfaces this via node.secureUpdates === false and
  // shows the re-provision command instead of an Update button.
  if (!supportsSecureUpdates(entry.version)) {
    return { ok: false, error: 'legacy-agent', needsReprovision: true };
  }

  // Sign a versioned manifest of the exact bytes /nodes/agent will serve, so
  // the agent verifies content hash + version against its pinned key before
  // installing. Manifest is sent as the literal signed string to avoid any
  // canonicalization mismatch. See remote/oe-node-agent.mjs handleUpdateMessage.
  let signed;
  try {
    const agentBytes = fs.readFileSync(path.join(BASE_DIR, 'remote', 'oe-node-agent.mjs'));
    const sha256 = createHash('sha256').update(agentBytes).digest('hex');
    const version = (agentBytes.toString('utf8').match(/const AGENT_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1] || 'unknown';
    const manifest = JSON.stringify({ v: 1, sha256, version, nodeId, signedAt: Date.now() });
    signed = { manifest, signature: signManifestString(manifest), alg: 'ed25519' };
  } catch (e) {
    return { ok: false, error: `failed to sign update: ${e.message}` };
  }

  try {
    entry.ws.send(JSON.stringify({ type: 'update', url, ...signed }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Wait for reconnect ──────────────────────────────────────────────────────
//
// After an action that restarts oe-node-agent (usermod + systemctl restart,
// `oe change-access`, etc.), callers need to know when the agent's WS is back
// before issuing the next command. This polls the registry until the entry
// has a recoveredAt newer than start time, or times out. Polling rather than
// event-driven so the function works without changes to the WS handler.

export async function waitForNodeReconnect(nodeId, userId, timeoutMs = 60_000) {
  const startMs = Date.now();
  const deadline = startMs + timeoutMs;
  // Wait at least one tick so the disconnect actually happens before we check
  // recoveredAt — otherwise a still-connected node would falsely "succeed".
  await new Promise(r => setTimeout(r, 800));
  while (Date.now() < deadline) {
    const entry = resolveNodeEntry(nodeId, userId);
    if (entry && entry.ws && entry.ws.readyState === entry.ws.OPEN
        && (entry.recoveredAt ?? 0) >= startMs) {
      // Brief grace so the agent finishes its registration handshake before
      // callers start sending commands.
      await new Promise(r => setTimeout(r, 500));
      return { ok: true, reconnectedAt: entry.recoveredAt };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: false, reason: `node did not reconnect within ${timeoutMs}ms` };
}

// ── Stats for debugging ──────────────────────────────────────────────────────
export function getRegistryStats() {
  let connected = 0, offline = 0;
  for (const entry of nodes.values()) {
    if (entry.ws && entry.ws.readyState === entry.ws.OPEN) connected++;
    else offline++;
  }
  return {
    connectedNodes: connected,
    offlineNodes: offline,
    totalNodes: nodes.size,
    pendingCommands: pendingCommands.size,
  };
}
