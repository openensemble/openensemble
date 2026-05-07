import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { pruneSnapshotsForNode, pruneAllSnapshots } from '../scheduler/snapshot-pruner.mjs';
import { snapshotsDir, nodeDir, pinSnapshot, ensureNodeDir } from '../lib/op-record.mjs';

const USER = 'user_prune';
const NODE = 'prunenode';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeSnapshotFile(userId, nodeId, dayBucket, opId, suffix = 'pre.json') {
  ensureNodeDir(userId, nodeId);
  const dir = path.join(snapshotsDir(userId, nodeId), dayBucket);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${opId}.${suffix}`);
  fs.writeFileSync(filePath, '{}');
  return filePath;
}

const NOW = Date.parse('2026-05-06T12:00:00Z');

describe('pruneSnapshotsForNode', () => {
  it('returns zeros for a node with no snapshots dir', () => {
    const stats = pruneSnapshotsForNode(USER, 'nonexistent', { now: NOW });
    expect(stats).toEqual({ scanned: 0, deleted: 0, kept_pinned: 0, kept_recent: 0, empty_dirs_removed: 0 });
  });

  it('keeps files in buckets newer than 30 days', () => {
    const recent = '2026-05-01'; // 5 days ago
    makeSnapshotFile(USER, NODE, recent, 'op_2026-05-01T10-00-00-000Z_aaaaaa');
    const stats = pruneSnapshotsForNode(USER, NODE, { now: NOW });
    expect(stats.scanned).toBe(1);
    expect(stats.kept_recent).toBe(1);
    expect(stats.deleted).toBe(0);
  });

  it('deletes files in buckets older than 30 days', () => {
    const old = '2026-03-01'; // 66 days ago
    const filePath = makeSnapshotFile(USER, NODE, old, 'op_2026-03-01T10-00-00-000Z_bbbbbb');
    const stats = pruneSnapshotsForNode(USER, NODE, { now: NOW });
    expect(stats.deleted).toBe(1);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('removes empty buckets after pruning', () => {
    const old = '2026-03-01';
    makeSnapshotFile(USER, NODE, old, 'op_2026-03-01T10-00-00-000Z_ccc111');
    const stats = pruneSnapshotsForNode(USER, NODE, { now: NOW });
    expect(stats.empty_dirs_removed).toBe(1);
    expect(fs.existsSync(path.join(snapshotsDir(USER, NODE), old))).toBe(false);
  });

  it('keeps pinned op files even when in an old bucket', () => {
    const old = '2026-03-01';
    const opId = 'op_2026-03-01T10-00-00-000Z_pinned';
    const filePath = makeSnapshotFile(USER, NODE, old, opId);
    pinSnapshot(USER, NODE, opId);

    const stats = pruneSnapshotsForNode(USER, NODE, { now: NOW });
    expect(stats.kept_pinned).toBe(1);
    expect(stats.deleted).toBe(0);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('preserves pinned files while pruning unpinned siblings in the same old bucket', () => {
    const old = '2026-03-01';
    const pinnedOpId = 'op_2026-03-01T10-00-00-000Z_pin1';
    const unpinnedOpId = 'op_2026-03-01T11-00-00-000Z_dropme';
    const pinnedFile = makeSnapshotFile(USER, NODE, old, pinnedOpId);
    const unpinnedFile = makeSnapshotFile(USER, NODE, old, unpinnedOpId);
    pinSnapshot(USER, NODE, pinnedOpId);

    const stats = pruneSnapshotsForNode(USER, NODE, { now: NOW });
    expect(stats.kept_pinned).toBe(1);
    expect(stats.deleted).toBe(1);
    expect(fs.existsSync(pinnedFile)).toBe(true);
    expect(fs.existsSync(unpinnedFile)).toBe(false);
    // Bucket still has the pinned file → not removed.
    expect(fs.existsSync(path.join(snapshotsDir(USER, NODE), old))).toBe(true);
  });

  it('respects a custom ttlDays', () => {
    const day = '2026-05-04'; // 2 days ago
    const filePath = makeSnapshotFile(USER, NODE, day, 'op_2026-05-04T10-00-00-000Z_short');
    const stats = pruneSnapshotsForNode(USER, NODE, { now: NOW, ttlDays: 1 });
    expect(stats.deleted).toBe(1);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('dryRun reports what would be deleted without actually unlinking', () => {
    const old = '2026-03-01';
    const filePath = makeSnapshotFile(USER, NODE, old, 'op_2026-03-01T10-00-00-000Z_dry');
    const stats = pruneSnapshotsForNode(USER, NODE, { now: NOW, dryRun: true });
    expect(stats.deleted).toBe(1); // counted
    expect(fs.existsSync(filePath)).toBe(true); // but not actually removed
  });

  it('ignores buckets with malformed names', () => {
    ensureNodeDir(USER, NODE);
    const weird = path.join(snapshotsDir(USER, NODE), 'not-a-date');
    fs.mkdirSync(weird, { recursive: true });
    fs.writeFileSync(path.join(weird, 'something.json'), '{}');
    const stats = pruneSnapshotsForNode(USER, NODE, { now: NOW });
    expect(stats.scanned).toBe(0);
    expect(fs.existsSync(weird)).toBe(true);
  });
});

describe('pruneAllSnapshots', () => {
  it('walks every user+node and aggregates stats', () => {
    makeSnapshotFile(USER, NODE, '2026-03-01', 'op_2026-03-01T10-00-00-000Z_a');
    makeSnapshotFile(USER, 'second-node', '2026-03-01', 'op_2026-03-01T10-00-00-000Z_b');
    const totals = pruneAllSnapshots({ now: NOW });
    expect(totals.nodes).toBe(2);
    expect(totals.deleted).toBe(2);
  });
});
