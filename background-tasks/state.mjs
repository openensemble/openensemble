/**
 * Shared in-memory registries for background tasks.
 * Extracted so journal / auto-bg / workers can share one Map without cycles.
 */

// Background completion is private user state. Injected by server boot.
export let _sendToUser = null;
export function setBackgroundUserSendFn(fn) { _sendToUser = fn; }

export function _sendOwner(userId, payload) {
  if (!_sendToUser || !userId || !payload) return 0;
  try { return _sendToUser(userId, payload); }
  catch (e) {
    console.warn('[background-tasks] owner notification failed:', e?.message || e);
    return 0;
  }
}

// in-flight task registry: taskId -> record
export const activeTasks = new Map();
// Verifier lease capabilities are tied to the in-memory task record without
// becoming enumerable through getActiveTasks(), logs, or journal serializers.
export const verifierLeaseTokens = new WeakMap();

// Root task graph for nested delegation.
export const rootTaskGraphs = new Map(); // rootTaskId -> graph

// Recently-finished workers / delegations (ring buffers)
export const recentWorkers = [];
export const RECENT_CAP = 12;
export const RECENT_READ_CAP = 25;
export const recentDelegations = [];

export function _slug(s) {
  return String(s || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}
