/**
 * Tests for the location-fact proposer's pure heuristic detection +
 * stash/flush behavior. The accept-side path (pinLocationFact + proposal
 * persistence) needs a live cortex/proposals stack and is exercised by
 * integration testing in a running install.
 *
 * Coverage:
 *   1. findPairing returns null on a single failed-path probe with no follow-up
 *   2. findPairing pairs a fail + later success on the same node_id
 *   3. findPairing ignores a follow-up on a DIFFERENT node_id
 *   4. findPairing ignores a follow-up that produced no real content (fences only)
 *   5. flushPendingLocationFact returns null when nothing is stashed
 *   6. flushPendingLocationFact drops on corrective follow-up
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _findPairingForTests, flushPendingLocationFact, _resetForTests,
} from '../lib/location-fact-proposer.mjs';

beforeEach(() => { _resetForTests(); });

describe('findPairing — pure heuristic', () => {
  it('returns null when a single node_exec just failed (no later success)', () => {
    const tools = [
      {
        name: 'node_exec',
        args: { node_id: 'pxesrv', command: 'find /var/lib/tftpboot -type d' },
        text: 'STDERR:\nfind: \'/var/lib/tftpboot\': No such file or directory\n\nExit code: 0 (7ms)',
      },
    ];
    expect(_findPairingForTests(tools)).toBeNull();
  });

  it('pairs a fail on /var/lib/tftpboot with a later success at /srv/tftp on the same node', () => {
    const tools = [
      {
        name: 'node_exec',
        args: { node_id: 'pxesrv', command: 'find /var/lib/tftpboot -type d' },
        text: 'STDERR:\nfind: \'/var/lib/tftpboot\': No such file or directory\n\nExit code: 0 (7ms)',
      },
      {
        name: 'node_exec',
        args: { node_id: 'pxesrv', command: 'ls -la /srv/tftp' },
        text: 'total 24\ndrwxr-xr-x 4 root root 4096 May 22 16:00 .\n-rw-r--r-- 1 root root 8192 May 22 15:30 pxelinux.0\n\nExit code: 0 (12ms)',
      },
    ];
    const pair = _findPairingForTests(tools);
    expect(pair).toEqual({
      nodeId: 'pxesrv',
      failedPath: '/var/lib/tftpboot',
      foundPath: '/srv/tftp',
    });
  });

  it('ignores a follow-up on a DIFFERENT node_id', () => {
    const tools = [
      {
        name: 'node_exec',
        args: { node_id: 'pxesrv', command: 'find /var/lib/tftpboot -type d' },
        text: 'STDERR:\nfind: \'/var/lib/tftpboot\': No such file or directory\n\nExit code: 0',
      },
      {
        name: 'node_exec',
        args: { node_id: 'other-host', command: 'ls /srv/tftp' },
        text: 'pxelinux.0\nbootmgr.exe\n\nExit code: 0 (5ms)',
      },
    ];
    expect(_findPairingForTests(tools)).toBeNull();
  });

  it('rejects a follow-up that only echoes section fences (no real stdout)', () => {
    const tools = [
      {
        name: 'node_exec',
        args: { node_id: 'pxesrv', command: 'find /var/lib/tftpboot' },
        text: 'STDERR:\nfind: \'/var/lib/tftpboot\': No such file or directory\n\nExit code: 0',
      },
      {
        name: 'node_exec',
        args: { node_id: 'pxesrv', command: 'ls /srv/tftp' },
        text: '--- ls /srv/tftp ---\n--- end ---\n\nExit code: 0 (3ms)',
      },
    ];
    expect(_findPairingForTests(tools)).toBeNull();
  });
});

describe('flushPendingLocationFact', () => {
  it('returns null when nothing is stashed', async () => {
    const res = await flushPendingLocationFact({
      userId: 'u1', agentId: 'a1', currentUserMessage: 'hello',
    });
    expect(res).toBeNull();
  });

  it('drops on corrective follow-up', async () => {
    const proposals = await import('../lib/proposals.mjs');
    const spy = vi.spyOn(proposals, 'proposeLocationFact');
    const lfp = await import('../lib/location-fact-proposer.mjs');
    const reg = await import('../skills/nodes/node-registry.mjs');
    vi.spyOn(reg, 'getNode').mockReturnValue({
      nodeId: 'pxesrv', hostname: 'pxeserver',
    });

    const tools = [
      {
        name: 'node_exec',
        args: { node_id: 'pxesrv', command: 'find /var/lib/tftpboot' },
        text: 'STDERR:\nfind: \'/var/lib/tftpboot\': No such file or directory\n\nExit code: 0',
      },
      {
        name: 'node_exec',
        args: { node_id: 'pxesrv', command: 'ls /srv/tftp' },
        text: 'pxelinux.0\nbootmgr.exe\n\nExit code: 0',
      },
    ];

    await lfp.maybeProposeLocationFact({
      userId: 'u2', agentId: 'a2', agentName: 'Coordinator',
      userMessage: 'find the pxe boot tree', toolsUsed: tools,
    });

    const dropped = await flushPendingLocationFact({
      userId: 'u2', agentId: 'a2',
      currentUserMessage: 'no that\'s wrong, I meant the windows tree',
    });
    expect(dropped).toEqual({ dropped: 'correction' });
    expect(spy).not.toHaveBeenCalled();
  });
});
