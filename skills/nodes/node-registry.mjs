/**
 * Node Registry — shared singleton for remote node management.
 * Imported by both routes/nodes.mjs (WS handler) and skills/nodes/execute.mjs (skill executor).
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { BASE_DIR } from '../../lib/paths.mjs';

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

const NODES_PATH = path.join(BASE_DIR, 'nodes.json');

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
        version: entry.version,
        registeredAt: entry.registeredAt,
        disconnectedAt: entry.ws ? null : (entry.disconnectedAt ?? Date.now()),
        restartCount: entry.restartCount,
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
        version: n.version || 'unknown',
        registeredAt: n.registeredAt || now,
        lastHeartbeat: n.registeredAt || now,
        stats: null,
        health: 'disconnected',
        missedPings: 0,
        disconnectedAt: n.disconnectedAt || now,
        recoveredAt: null,
        restartCount: n.restartCount || 0,
        uptimeSince: n.registeredAt || now,
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

// ── Revocation ────────────────────────────────────────────────────────────────
function revocationKey(userId, nodeId) { return `${userId}:${nodeId}`; }

export function isRevoked(userId, nodeId) {
  return revokedNodes.has(revocationKey(userId, nodeId));
}

// ── Registration ─────────────────────────────────────────────────────────────
export function registerNode(ws, userId, info) {
  const nodeId = info.nodeId || `node_${info.hostname}_${randomBytes(3).toString('hex')}`;

  // Refuse registration if this nodeId was explicitly removed by the user
  if (isRevoked(userId, nodeId)) {
    console.log(`[nodes] Refusing registration of revoked node ${nodeId} for user ${userId}`);
    try {
      ws.send(JSON.stringify({ type: 'revoked', message: 'This node was removed by the user. Uninstall the agent to stop reconnect attempts.' }));
      ws.close(4003, 'Revoked');
    } catch {}
    return null;
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
    version: info.version || 'unknown',
    registeredAt: now,
    lastHeartbeat: now,
    stats: null,
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
    version: entry.version || 'unknown',
    registeredAt: entry.registeredAt,
    lastHeartbeat: entry.lastHeartbeat,
    health: entry.health,
    restartCount: entry.restartCount,
    recoveredAt: entry.recoveredAt,
    disconnectedAt: entry.disconnectedAt,
    uptimeSince: entry.uptimeSince,
    stats: entry.stats,
    formattedUptime: formatUptime(entry.stats?.uptime),
    formattedMem: entry.stats
      ? `${formatBytes(entry.stats.memUsed)}/${formatBytes(entry.stats.memTotal)}`
      : null,
  };
}

// ── Command dispatch ─────────────────────────────────────────────────────────
// Per-node concurrency guard — prevents LLM retry storms from hammering a node
// with simultaneous exec calls. Commands beyond the limit are rejected
// immediately with a clear error so the model sees the backpressure.
const MAX_CONCURRENT_PER_NODE = 3;

function countInflight(nodeId) {
  let n = 0;
  for (const cmd of pendingCommands.values()) {
    if (cmd.nodeId === nodeId) n++;
  }
  return n;
}

function dispatchCommand(nodeId, userId, payload, { onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const entry = nodes.get(nodeId);
    if (!entry || entry.userId !== userId) {
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

    const pending = { resolve, reject, timer, nodeId, chunks: [] };
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
      if (!cmd) return;
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
      if (!cmd) return;
      cmd.chunks.push(msg.data);
      if (cmd.onChunk) cmd.onChunk(msg.stream, msg.data);
      break;
    }

    case 'status_result': {
      const cmd = pendingCommands.get(msg.cmdId);
      if (!cmd) return;
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
      if (msg.stats) entry.stats = msg.stats;

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

    case 'update_result': {
      const status = msg.ok ? `OK (${msg.size} bytes)` : `FAILED: ${msg.error}`;
      console.log(`[nodes] Update on ${nodeId}: ${status}`);
      broadcastNodeEvent(entry.userId, {
        type: 'node_update_result', nodeId,
        ok: !!msg.ok, size: msg.size || null, error: msg.error || null,
      });
      break;
    }

    case 'pty_output':
    case 'pty_exit':
    case 'pty_started':
    case 'pty_error': {
      const cb = ptyCallbacks.get(msg.ptyId);
      if (cb) cb(msg);
      break;
    }

    default:
      console.warn(`[nodes] Unknown message type from ${nodeId}: ${msg.type}`);
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────────────
let _heartbeatInterval = null;

export function startHeartbeat(intervalMs = 30000) {
  if (_heartbeatInterval) clearInterval(_heartbeatInterval);

  _heartbeatInterval = setInterval(() => {
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
        entry.ws.send(JSON.stringify({ type: 'ping' }));
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

export function registerPtyCallback(ptyId, callback) {
  ptyCallbacks.set(ptyId, callback);
}

export function unregisterPtyCallback(ptyId) {
  ptyCallbacks.delete(ptyId);
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

// ── Push update ─────────────────────────────────────────────────────────────
// Tells a connected agent to re-download and restart itself. Fire-and-forget:
// the agent ACKs via an `update_result` message, then exits (systemd restarts it).
export function pushUpdate(nodeId, userId, url = null) {
  const entry = nodes.get(nodeId);
  if (!entry || entry.userId !== userId) return { ok: false, error: 'node not found' };
  if (!entry.ws || entry.ws.readyState !== entry.ws.OPEN) return { ok: false, error: 'node not connected' };
  try {
    entry.ws.send(JSON.stringify({ type: 'update', url }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
