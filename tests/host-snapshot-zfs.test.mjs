/**
 * ZFS driver tests for host-snapshot. Uses a fake execFn standing in for
 * SSH-to-TrueNAS.
 */

import { describe, it, expect } from 'vitest';
import {
  captureHostSnapshot,
  rollbackToHostSnapshot,
  deleteHostSnapshot,
} from '../lib/host-snapshot.mjs';

const PARENT = {
  type: 'zfs',
  ssh_host: 'truenas.local',
  dataset: 'tank/services/pihole',
};

function makeFakeZfs() {
  const snapshots = new Set(); // tag → exists
  const calls = [];
  const execFn = async (command) => {
    calls.push(command);
    let m = command.match(/^zfs snapshot (.+)$/);
    if (m) { snapshots.add(m[1]); return { stdout: '', stderr: '', exitCode: 0 }; }
    m = command.match(/^zfs rollback -r (.+)$/);
    if (m) {
      if (!snapshots.has(m[1])) return { stdout: '', stderr: 'no such snapshot', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    m = command.match(/^zfs destroy (.+)$/);
    if (m) { snapshots.delete(m[1]); return { stdout: '', stderr: '', exitCode: 0 }; }
    return { stdout: '', stderr: `unknown: ${command}`, exitCode: 127 };
  };
  return { snapshots, calls, execFn };
}

describe('captureHostSnapshot (zfs)', () => {
  it('runs zfs snapshot with dataset@snapname tag', async () => {
    const fake = makeFakeZfs();
    const opId = 'op_2026-05-07T04-02-00-000Z_aaaaaa';
    const hs = await captureHostSnapshot(PARENT, opId, { execFn: fake.execFn });
    expect(hs.type).toBe('zfs');
    expect(hs.dataset).toBe('tank/services/pihole');
    expect(hs.snapname).toBe('oe_20260507_040200_aaaaaa');
    expect(hs.tag).toBe('tank/services/pihole@oe_20260507_040200_aaaaaa');
    expect(fake.snapshots.has(hs.tag)).toBe(true);
    expect(fake.calls).toEqual(['zfs snapshot tank/services/pihole@oe_20260507_040200_aaaaaa']);
  });

  it('throws when execFn missing', async () => {
    await expect(captureHostSnapshot(PARENT, 'op_x', {})).rejects.toThrow(/execFn/);
  });

  it('propagates zfs failures', async () => {
    const execFn = async () => ({ stdout: '', stderr: 'permission denied', exitCode: 1 });
    await expect(captureHostSnapshot(PARENT, 'op_x', { execFn })).rejects.toThrow(/permission denied/);
  });
});

describe('rollbackToHostSnapshot (zfs)', () => {
  it('rolls back a known snapshot using -r', async () => {
    const fake = makeFakeZfs();
    const hs = await captureHostSnapshot(PARENT, 'op_2026-05-07T04-02-00-000Z_bbbbbb', { execFn: fake.execFn });
    const r = await rollbackToHostSnapshot(PARENT, hs, { execFn: fake.execFn });
    expect(r.outcome).toBe('success');
    expect(fake.calls).toContain(`zfs rollback -r ${hs.tag}`);
  });

  it('returns failure when execFn missing', async () => {
    const fake = makeFakeZfs();
    const hs = await captureHostSnapshot(PARENT, 'op_xyz', { execFn: fake.execFn });
    const r = await rollbackToHostSnapshot(PARENT, hs, {});
    expect(r.outcome).toBe('failure');
    expect(r.message).toMatch(/execFn/);
  });

  it('returns failure when snapshot does not exist', async () => {
    const fake = makeFakeZfs();
    const stale = { type: 'zfs', dataset: 'tank/services/pihole', snapname: 'never', tag: 'tank/services/pihole@never' };
    const r = await rollbackToHostSnapshot(PARENT, stale, { execFn: fake.execFn });
    expect(r.outcome).toBe('failure');
    expect(r.message).toMatch(/no such snapshot/);
  });
});

describe('deleteHostSnapshot (zfs)', () => {
  it('runs zfs destroy and reports deleted: true', async () => {
    const fake = makeFakeZfs();
    const hs = await captureHostSnapshot(PARENT, 'op_2026-05-07T04-02-00-000Z_ccc111', { execFn: fake.execFn });
    expect(fake.snapshots.has(hs.tag)).toBe(true);
    const r = await deleteHostSnapshot(PARENT, hs, { execFn: fake.execFn });
    expect(r.deleted).toBe(true);
    expect(fake.snapshots.has(hs.tag)).toBe(false);
  });
});
