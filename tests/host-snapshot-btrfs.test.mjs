/**
 * Btrfs driver tests for host-snapshot — covers the bare-metal-with-btrfs case
 * (openSUSE / NixOS / Pop!_OS / some NAS firmware).
 *
 * Notable difference from zfs/proxmox: rollback is NOT auto-applied. The
 * snapshot is taken, but the rollback function returns a guidance string
 * with the manual recovery command — btrfs subvolume swap is risky to
 * perform without a human present.
 */

import { describe, it, expect } from 'vitest';
import {
  captureHostSnapshot,
  rollbackToHostSnapshot,
  deleteHostSnapshot,
} from '../lib/host-snapshot.mjs';
import { setParentHost, registerNode } from '../skills/nodes/node-registry.mjs';

const PARENT = {
  type: 'btrfs',
  subvolume: '/var/lib/pihole',
  snapshot_dir: '/btrfs-snapshots/oe',
};

function makeFakeBtrfs() {
  const snapshots = new Set();
  const calls = [];
  const execFn = async (command) => {
    calls.push(command);
    let m = command.match(/^btrfs subvolume snapshot -r (\S+) (\S+)$/);
    if (m) {
      snapshots.add(m[2]);
      return { stdout: `Create a readonly snapshot of '${m[1]}' in '${m[2]}'`, stderr: '', exitCode: 0 };
    }
    m = command.match(/^btrfs subvolume delete (\S+)$/);
    if (m) {
      if (!snapshots.has(m[1])) return { stdout: '', stderr: 'no such subvolume', exitCode: 1 };
      snapshots.delete(m[1]);
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unknown: ${command}`, exitCode: 127 };
  };
  return { snapshots, calls, execFn };
}

describe('captureHostSnapshot (btrfs)', () => {
  it('takes a read-only btrfs snapshot under snapshot_dir', async () => {
    const fake = makeFakeBtrfs();
    const opId = 'op_2026-05-07T07-30-00-000Z_aaaaaa';
    const hs = await captureHostSnapshot(PARENT, opId, { execFn: fake.execFn });

    expect(hs.type).toBe('btrfs');
    expect(hs.subvolume).toBe('/var/lib/pihole');
    expect(hs.snapname).toBe('oe_20260507_073000_aaaaaa');
    expect(hs.snapshot_path).toBe('/btrfs-snapshots/oe/oe_20260507_073000_aaaaaa');
    expect(fake.calls[0]).toBe('btrfs subvolume snapshot -r /var/lib/pihole /btrfs-snapshots/oe/oe_20260507_073000_aaaaaa');
    expect(fake.snapshots.has(hs.snapshot_path)).toBe(true);
  });

  it('strips trailing slash from snapshot_dir', async () => {
    const fake = makeFakeBtrfs();
    const hs = await captureHostSnapshot(
      { ...PARENT, snapshot_dir: '/btrfs-snapshots/oe///' },
      'op_2026-05-07T07-30-00-000Z_bbbbbb',
      { execFn: fake.execFn },
    );
    expect(hs.snapshot_path).toBe('/btrfs-snapshots/oe/oe_20260507_073000_bbbbbb');
  });

  it('throws when execFn missing', async () => {
    await expect(captureHostSnapshot(PARENT, 'op_x', {})).rejects.toThrow(/execFn/);
  });

  it('propagates btrfs failures', async () => {
    const execFn = async () => ({ stdout: '', stderr: 'snapshot_dir does not exist', exitCode: 1 });
    await expect(captureHostSnapshot(PARENT, 'op_x', { execFn })).rejects.toThrow(/snapshot_dir does not exist/);
  });
});

describe('rollbackToHostSnapshot (btrfs) — manual-only by design', () => {
  it('returns failure with the manual recovery recipe in the message', async () => {
    const fake = makeFakeBtrfs();
    const hs = await captureHostSnapshot(PARENT, 'op_2026-05-07T07-30-00-000Z_ccc111', { execFn: fake.execFn });
    const r = await rollbackToHostSnapshot(PARENT, hs, { execFn: fake.execFn });
    expect(r.outcome).toBe('failure');
    // Message should preserve the snapshot path AND give an actionable recipe
    expect(r.message).toContain(hs.snapshot_path);
    expect(r.message).toMatch(/btrfs subvolume delete/);
    expect(r.message).toMatch(/btrfs subvolume snapshot/);
  });

  it('does NOT touch the filesystem when rollback is invoked', async () => {
    const fake = makeFakeBtrfs();
    const hs = await captureHostSnapshot(PARENT, 'op_xxx', { execFn: fake.execFn });
    const callsBefore = fake.calls.length;
    await rollbackToHostSnapshot(PARENT, hs, { execFn: fake.execFn });
    expect(fake.calls.length).toBe(callsBefore);
    expect(fake.snapshots.has(hs.snapshot_path)).toBe(true);
  });
});

describe('deleteHostSnapshot (btrfs)', () => {
  it('runs btrfs subvolume delete and reports deleted: true', async () => {
    const fake = makeFakeBtrfs();
    const hs = await captureHostSnapshot(PARENT, 'op_2026-05-07T07-30-00-000Z_ddd222', { execFn: fake.execFn });
    expect(fake.snapshots.has(hs.snapshot_path)).toBe(true);
    const r = await deleteHostSnapshot(PARENT, hs, { execFn: fake.execFn });
    expect(r.deleted).toBe(true);
    expect(fake.snapshots.has(hs.snapshot_path)).toBe(false);
  });

  it('returns deleted:false when execFn missing', async () => {
    const hs = { type: 'btrfs', snapshot_path: '/x' };
    const r = await deleteHostSnapshot(PARENT, hs, {});
    expect(r.deleted).toBe(false);
    expect(r.reason).toMatch(/execFn/);
  });
});

describe('node-registry validation: btrfs parent_host', () => {
  function fakeRegister(nodeId, userId) {
    const ws = { readyState: 1, send: () => {}, close: () => {}, OPEN: 1 };
    return registerNode(ws, userId, {
      nodeId, hostname: nodeId, platform: 'linux', distro: 'd', arch: 'x',
      shell: '/sh', packageManager: 'apt',
    });
  }

  const USER = 'user_btrfs_validation';
  const NODE = 'btrfs-bare-metal';

  it('accepts a well-formed btrfs config', () => {
    fakeRegister(NODE, USER);
    expect(() => setParentHost(NODE, USER, PARENT)).not.toThrow();
  });

  it('rejects missing subvolume', () => {
    fakeRegister(NODE, USER);
    expect(() => setParentHost(NODE, USER, { type: 'btrfs', snapshot_dir: '/x' }))
      .toThrow(/requires subvolume/);
  });

  it('rejects missing snapshot_dir', () => {
    fakeRegister(NODE, USER);
    expect(() => setParentHost(NODE, USER, { type: 'btrfs', subvolume: '/' }))
      .toThrow(/requires snapshot_dir/);
  });
});
