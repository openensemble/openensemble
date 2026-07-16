import { describe, expect, it, vi } from 'vitest';

import {
  tryAcquireUserTurnLease,
  tryAcquireUserTopologyTransition,
  runWithUserTopologyLease,
  finishUserTopologyTransition,
  rollbackUserTopologyTransition,
  getCurrentUserTopologyLease,
  getUserTopologyState,
} from './slot-registry.mjs';

describe('per-user topology admission gate', () => {
  it('makes a topology write exclusive with interactive readers', () => {
    const userId = 'slot_topology_exclusive';
    const reader = tryAcquireUserTurnLease(userId, { allowUpgrade: true });
    expect(reader).toBeTruthy();
    const secondReader = tryAcquireUserTurnLease(userId);
    expect(secondReader).toBeTruthy();
    expect(tryAcquireUserTopologyTransition(userId)).toBeNull();
    expect(getUserTopologyState(userId)).toEqual({ readers: 2, writer: false });
    reader.release();
    expect(tryAcquireUserTopologyTransition(userId)).toBeNull();
    secondReader.release();

    const writerAfterReaders = tryAcquireUserTopologyTransition(userId);
    expect(writerAfterReaders?.external).toBe(true);
    finishUserTopologyTransition(writerAfterReaders);

    const user2 = 'slot_topology_writer';
    const writer = tryAcquireUserTopologyTransition(user2);
    expect(writer?.external).toBe(true);
    expect(tryAcquireUserTurnLease(user2)).toBeNull();
    finishUserTopologyTransition(writer);
    expect(getUserTopologyState(user2)).toEqual({ readers: 0, writer: false });
  });

  it('upgrades only the sole ambient interactive lease', async () => {
    const userId = 'slot_topology_upgrade';
    const first = tryAcquireUserTurnLease(userId, { allowUpgrade: true });
    const second = tryAcquireUserTurnLease(userId, { allowUpgrade: true });
    await runWithUserTopologyLease(first, async () => {
      expect(getCurrentUserTopologyLease()).toBe(first);
      expect(tryAcquireUserTopologyTransition(userId)).toBeNull();
    });
    second.release();

    await runWithUserTopologyLease(first, async () => {
      const upgraded = tryAcquireUserTopologyTransition(userId);
      expect(upgraded).toMatchObject({ external: false, upgradedNow: true });
      expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: true });
      rollbackUserTopologyTransition(upgraded);
      expect(getUserTopologyState(userId)).toEqual({ readers: 1, writer: false });
    });
    first.release();
  });

  it('holds a deferred broadcast until the upgraded turn releases', async () => {
    const userId = 'slot_topology_deferred';
    const reader = tryAcquireUserTurnLease(userId, { allowUpgrade: true });
    const broadcast = vi.fn();
    await runWithUserTopologyLease(reader, async () => {
      const upgraded = tryAcquireUserTopologyTransition(userId);
      upgraded.lease.deferUntilRelease(broadcast);
      expect(broadcast).not.toHaveBeenCalled();
      expect(tryAcquireUserTurnLease(userId)).toBeNull();
    });
    reader.release();
    expect(broadcast).toHaveBeenCalledOnce();
    expect(getUserTopologyState(userId)).toEqual({ readers: 0, writer: false });
  });

  it('does not let autonomous/non-upgradable readers mutate topology', async () => {
    const userId = 'slot_topology_autonomous';
    const reader = tryAcquireUserTurnLease(userId, { allowUpgrade: false });
    await runWithUserTopologyLease(reader, async () => {
      expect(tryAcquireUserTopologyTransition(userId)).toBeNull();
    });
    reader.release();
  });
});
