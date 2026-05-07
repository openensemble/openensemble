/**
 * Snapshot pruner — daily sweep that deletes pre-state captures older than
 * 30 days. Pinned op-ids are preserved indefinitely (see pinned.json per node).
 *
 * Granularity is per-file (not per-day-bucket): a single pinned op in an old
 * day-bucket keeps only that op's files alive. Empty day-buckets get rmdir'd.
 *
 * Designed to be called from server.mjs's startup — wire it into a 24h
 * setInterval (or via the scheduler) once we're ready to enforce retention
 * in production. For now it's just a callable function so tests can drive it.
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import { listPinned, snapshotsDir, readOpRecords, isPinned } from '../lib/op-record.mjs';
import { deleteHostSnapshot } from '../lib/host-snapshot.mjs';
import { log } from '../logger.mjs';

const DEFAULT_TTL_DAYS = 30;

function dayBucketAgeDays(name, now = Date.now()) {
  // bucket is YYYY-MM-DD; reject anything malformed by returning -1 so we don't touch it
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return -1;
  const ts = Date.parse(name + 'T00:00:00Z');
  if (Number.isNaN(ts)) return -1;
  return (now - ts) / 86400_000;
}

function extractOpId(filename) {
  // op_<...>.<suffix>; opId is everything up to the LAST dot before the suffix
  // we accept any suffix shape (.json, .pre.json, .config.tar, etc.) by taking
  // the portion that starts with op_ and stop at the FIRST dot after it.
  const m = filename.match(/^(op_[^.]+(?:\.\d{3}Z_[0-9a-f]+)?)/);
  if (m) return m[1];
  // Fallback for unexpected shapes.
  const dot = filename.indexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * Prune snapshots for a single (userId, nodeId).
 * Returns { scanned, deleted, kept_pinned, kept_recent, empty_dirs_removed }.
 */
export function pruneSnapshotsForNode(userId, nodeId, opts = {}) {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const now = opts.now ?? Date.now();
  const dryRun = !!opts.dryRun;

  const dir = snapshotsDir(userId, nodeId);
  const stats = { scanned: 0, deleted: 0, kept_pinned: 0, kept_recent: 0, empty_dirs_removed: 0 };
  if (!fs.existsSync(dir)) return stats;

  const pinnedSet = new Set(listPinned(userId, nodeId));

  for (const bucket of fs.readdirSync(dir)) {
    const bucketPath = path.join(dir, bucket);
    let bucketStat;
    try { bucketStat = fs.statSync(bucketPath); } catch { continue; }
    if (!bucketStat.isDirectory()) continue;

    const ageDays = dayBucketAgeDays(bucket, now);
    if (ageDays < 0) continue; // unparseable bucket name; leave alone

    for (const file of fs.readdirSync(bucketPath)) {
      stats.scanned++;
      const opId = extractOpId(file);
      if (pinnedSet.has(opId)) {
        stats.kept_pinned++;
        continue;
      }
      if (ageDays <= ttlDays) {
        stats.kept_recent++;
        continue;
      }
      if (!dryRun) {
        try { fs.unlinkSync(path.join(bucketPath, file)); }
        catch (e) { log?.warn?.('snapshot-pruner', 'unlink failed', { file, err: e.message }); continue; }
      }
      stats.deleted++;
    }

    // Remove empty buckets (after pruning, or if the dir was already empty).
    try {
      if (fs.readdirSync(bucketPath).length === 0) {
        if (!dryRun) fs.rmdirSync(bucketPath);
        stats.empty_dirs_removed++;
      }
    } catch {}
  }

  return stats;
}

/**
 * Walk op records older than ttlDays whose `pre_state.host_snapshot` is
 * populated and not pinned, then ask the corresponding driver to delete the
 * remote snapshot (Proxmox `pct delsnapshot`, ZFS `zfs destroy`).
 *
 * Best-effort: failures (host unreachable, snapshot already gone) are logged
 * but don't abort the sweep. Caller passes an `execFn` factory keyed by
 * (userId, nodeId) for ZFS-driver calls; Proxmox uses the parent_host's
 * own api_url + token (resolved by host-snapshot.mjs).
 *
 * Production wiring lives in server.mjs alongside the local-file pruner.
 */
export async function pruneHostSnapshotsForNode(userId, nodeId, opts = {}) {
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const now = opts.now ?? Date.now();
  const cutoff = now - ttlDays * 86400_000;
  const stats = { scanned: 0, deleted: 0, kept_pinned: 0, kept_recent: 0, failed: 0 };

  const records = readOpRecords(userId, nodeId);

  // Lazy parent_host lookup — only one call per node, cached.
  let parent_host;
  if (opts.parent_host !== undefined) {
    parent_host = opts.parent_host;
  } else {
    try {
      const { getParentHost } = await import('../skills/nodes/node-registry.mjs');
      parent_host = getParentHost(nodeId, userId);
    } catch { parent_host = null; }
  }

  for (const rec of records) {
    const hs = rec.pre_state?.host_snapshot;
    if (!hs) continue;
    stats.scanned++;
    const ts = new Date(rec.ts).getTime();
    if (ts > cutoff) { stats.kept_recent++; continue; }
    if (isPinned(userId, nodeId, rec.id)) { stats.kept_pinned++; continue; }
    if (!parent_host) {
      // No parent_host configured today; can't reach the host to delete.
      // Could happen if user removed it. Keep counted as "scanned, untouched."
      continue;
    }
    try {
      const ctx = opts.ctx || (hs.type === 'zfs' && opts.execFnFor ? { execFn: opts.execFnFor(userId, nodeId) } : {});
      const r = await deleteHostSnapshot(parent_host, hs, ctx);
      if (r.deleted) stats.deleted++;
      else stats.failed++;
    } catch (e) {
      stats.failed++;
      log?.warn?.('snapshot-pruner', 'host snapshot delete failed', { opId: rec.id, err: e.message });
    }
  }

  return stats;
}

/**
 * Walk all users + nodes and prune. Returns aggregate stats.
 */
export function pruneAllSnapshots(opts = {}) {
  const totals = { scanned: 0, deleted: 0, kept_pinned: 0, kept_recent: 0, empty_dirs_removed: 0, nodes: 0 };
  if (!fs.existsSync(USERS_DIR)) return totals;

  for (const userEntry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) continue;
    const nodesRoot = path.join(USERS_DIR, userEntry.name, 'nodes');
    if (!fs.existsSync(nodesRoot)) continue;

    for (const nodeEntry of fs.readdirSync(nodesRoot, { withFileTypes: true })) {
      if (!nodeEntry.isDirectory()) continue;
      const stats = pruneSnapshotsForNode(userEntry.name, nodeEntry.name, opts);
      totals.scanned += stats.scanned;
      totals.deleted += stats.deleted;
      totals.kept_pinned += stats.kept_pinned;
      totals.kept_recent += stats.kept_recent;
      totals.empty_dirs_removed += stats.empty_dirs_removed;
      totals.nodes++;
    }
  }
  return totals;
}
