// @ts-check
/**
 * Cascade cleanup for a removed (or already-gone) node.
 *
 * removeNode() historically only dropped the registry entry + revoked the
 * agent. Service profiles, incidents, activity logs, and profile_health
 * watchers under users/<uid>/nodes/<nodeId>/ were left behind as orphans
 * that kept ticking forever with "node not found".
 *
 * purgeNodeLocalData() is the single cleanup path:
 *   1. cancel profile_health watchers for that nodeId
 *   2. delete the on-disk node data directory (profiles/incidents/snapshots/…)
 *
 * Safe against path traversal: nodeId must be a single path segment under
 * the caller's users/<uid>/nodes/ tree.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';

/**
 * Resolve the on-disk data directory for a node, or null if the ids are
 * unsafe / would escape the user nodes root.
 *
 * @param {string} userId
 * @param {string} nodeId
 * @returns {string | null}
 */
export function safeNodeDataDir(userId, nodeId) {
  if (typeof userId !== 'string' || typeof nodeId !== 'string') return null;
  if (!userId || !nodeId) return null;
  // Single path segment only — no absolute paths, no traversal.
  if (userId.includes('/') || userId.includes('\\') || userId.includes('..') || userId === '.' || userId === '..') {
    return null;
  }
  if (nodeId.includes('/') || nodeId.includes('\\') || nodeId.includes('..') || nodeId === '.' || nodeId === '..') {
    return null;
  }
  if (/[\x00-\x1f]/.test(userId) || /[\x00-\x1f]/.test(nodeId)) return null;

  const root = path.resolve(path.join(USERS_DIR, userId, 'nodes'));
  const dir = path.resolve(path.join(root, nodeId));
  if (dir !== root && !dir.startsWith(root + path.sep)) return null;
  return dir;
}

/**
 * Cancel standing profile_health watchers owned by this node.
 * Best-effort: watcher module may be unavailable in some test harnesses.
 *
 * @param {string} userId
 * @param {string} nodeId
 * @returns {Promise<number>} count of cancelled watchers
 */
export async function cancelNodeHealthWatchers(userId, nodeId) {
  if (!userId || !nodeId) return 0;
  try {
    const { unregisterMatchingWatchers } = await import('../scheduler/watchers.mjs');
    return unregisterMatchingWatchers(
      userId,
      w => w?.kind === 'profile_health' && w?.state?.node_id === nodeId,
      'node-removed',
    );
  } catch (e) {
    console.warn(`[node-cleanup] watcher cancel failed for ${nodeId}:`, e?.message || e);
    return 0;
  }
}

/**
 * Delete the on-disk node data directory if it exists and is safe.
 *
 * @param {string} userId
 * @param {string} nodeId
 * @returns {{ deleted: boolean, path: string | null }}
 */
export function deleteNodeDataDir(userId, nodeId) {
  const dir = safeNodeDataDir(userId, nodeId);
  if (!dir) return { deleted: false, path: null };
  if (!fs.existsSync(dir)) return { deleted: false, path: dir };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { deleted: true, path: dir };
  } catch (e) {
    console.warn(`[node-cleanup] failed to delete ${dir}:`, e?.message || e);
    return { deleted: false, path: dir };
  }
}

/**
 * Full local cascade for a node: watchers first, then disk.
 * Idempotent — safe to call when the registry entry is already gone.
 *
 * @param {string} userId
 * @param {string} nodeId
 * @returns {Promise<{ watchersCancelled: number, dataDeleted: boolean }>}
 */
export async function purgeNodeLocalData(userId, nodeId) {
  const watchersCancelled = await cancelNodeHealthWatchers(userId, nodeId);
  const { deleted } = deleteNodeDataDir(userId, nodeId);
  if (watchersCancelled || deleted) {
    console.log(
      `[node-cleanup] purged ${nodeId} for ${userId}: `
      + `${watchersCancelled} watcher(s), dataDir=${deleted ? 'deleted' : 'absent'}`,
    );
  }
  return { watchersCancelled, dataDeleted: deleted };
}
