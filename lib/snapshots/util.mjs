/**
 * Snapshot file helpers shared across mechanism handlers.
 * Snapshots are bucketed by day so the 30-day pruner is a single
 * `find -mtime +30 -delete` against directory names.
 */
import fs from 'fs';
import path from 'path';
import { snapshotsDir } from '../op-record.mjs';

export function todayBucket(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

export function dayBucketFromOpId(opId, fallback = null) {
  const m = String(opId || '').match(/^op_(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return fallback ?? todayBucket();
}

export function snapshotFilePath(userId, nodeId, opId, suffix) {
  const day = dayBucketFromOpId(opId);
  return path.join(snapshotsDir(userId, nodeId), day, `${opId}.${suffix}`);
}

export function writeSnapshotFile(userId, nodeId, opId, suffix, data) {
  const file = snapshotFilePath(userId, nodeId, opId, suffix);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

export function readSnapshotFile(userId, nodeId, opId, suffix) {
  const file = snapshotFilePath(userId, nodeId, opId, suffix);
  return fs.readFileSync(file);
}

export function snapshotFileExists(userId, nodeId, opId, suffix) {
  return fs.existsSync(snapshotFilePath(userId, nodeId, opId, suffix));
}
