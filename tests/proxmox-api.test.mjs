/**
 * Tests for the minimal Proxmox API client. Uses an injected fetchFn so the
 * tests are hermetic — no PVE host needed.
 */

import { describe, it, expect } from 'vitest';
import {
  createSnapshot,
  rollbackSnapshot,
  deleteSnapshot,
  listSnapshots,
  waitForTask,
} from '../lib/proxmox-api.mjs';

const OPTS = {
  api_url:   'https://pve01:8006',
  api_token: 'PVEAPIToken=root@pam!oe=abc-123',
  node:      'pve01',
  vmid:      102,
  kind:      'lxc',
  waitForCompletion: false, // skip polling unless test exercises it
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeRecorder(handler) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body || null });
    return handler(url, init);
  };
  return { calls, fetchFn };
}

describe('createSnapshot', () => {
  it('POSTs to /snapshot with snapname in form body and returns the upid', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:pve01:001:test'));
    const result = await createSnapshot({ ...OPTS, fetchFn }, 'oe-pre-x');
    expect(result.upid).toBe('UPID:pve01:001:test');
    expect(result.snapname).toBe('oe-pre-x');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://pve01:8006/api2/json/nodes/pve01/lxc/102/snapshot');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toContain('snapname=oe-pre-x');
    expect(calls[0].headers.Authorization).toMatch(/^PVEAPIToken=/);
  });

  it('includes description when provided', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:..'));
    await createSnapshot({ ...OPTS, fetchFn }, 'oe-x', 'pre-restart');
    expect(calls[0].body).toContain('description=pre-restart');
  });

  it('errors cleanly on non-2xx response', async () => {
    const { fetchFn } = makeRecorder(() => new Response('forbidden', { status: 403 }));
    await expect(createSnapshot({ ...OPTS, fetchFn }, 'oe-x')).rejects.toThrow(/HTTP 403/);
  });
});

describe('rollbackSnapshot', () => {
  it('POSTs to /snapshot/<name>/rollback', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:..'));
    await rollbackSnapshot({ ...OPTS, fetchFn }, 'oe-pre-x');
    expect(calls[0].url).toBe('https://pve01:8006/api2/json/nodes/pve01/lxc/102/snapshot/oe-pre-x/rollback');
    expect(calls[0].method).toBe('POST');
  });

  it('throws when snapname missing', async () => {
    const { fetchFn } = makeRecorder(() => jsonResp('UPID:'));
    await expect(rollbackSnapshot({ ...OPTS, fetchFn }, '')).rejects.toThrow(/snapname required/);
  });
});

describe('deleteSnapshot', () => {
  it('DELETEs to /snapshot/<name>', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:..'));
    await deleteSnapshot({ ...OPTS, fetchFn }, 'old-snap');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('https://pve01:8006/api2/json/nodes/pve01/lxc/102/snapshot/old-snap');
  });
});

describe('listSnapshots', () => {
  it('GETs /snapshot and returns the array', async () => {
    const fetchFn = async () => jsonResp([{ name: 'one' }, { name: 'two' }]);
    const list = await listSnapshots({ ...OPTS, fetchFn });
    expect(list).toEqual([{ name: 'one' }, { name: 'two' }]);
  });

  it('returns [] when API returns non-array', async () => {
    const fetchFn = async () => jsonResp(null);
    expect(await listSnapshots({ ...OPTS, fetchFn })).toEqual([]);
  });
});

describe('waitForTask', () => {
  it('polls until status=stopped + exitstatus=OK', async () => {
    let polls = 0;
    const fetchFn = async () => {
      polls++;
      const status = polls < 3 ? 'running' : 'stopped';
      return jsonResp({ status, exitstatus: status === 'stopped' ? 'OK' : null });
    };
    await waitForTask({ ...OPTS, fetchFn }, 'UPID:test', 5000);
    expect(polls).toBe(3);
  });

  it('throws when exitstatus is not OK', async () => {
    const fetchFn = async () => jsonResp({ status: 'stopped', exitstatus: 'snapshot failed' });
    await expect(waitForTask({ ...OPTS, fetchFn }, 'UPID:bad', 5000))
      .rejects.toThrow(/snapshot failed/);
  });

  it('times out cleanly', async () => {
    const fetchFn = async () => jsonResp({ status: 'running' });
    await expect(waitForTask({ ...OPTS, fetchFn }, 'UPID:slow', 50))
      .rejects.toThrow(/timed out/);
  });
});

describe('input validation', () => {
  it('rejects missing api_url', async () => {
    await expect(createSnapshot({ api_token: 't', node: 'n', vmid: 1, kind: 'lxc' }, 's'))
      .rejects.toThrow(/api_url/);
  });

  it('rejects missing api_token', async () => {
    await expect(createSnapshot({ api_url: 'x', node: 'n', vmid: 1, kind: 'lxc' }, 's'))
      .rejects.toThrow(/api_token/);
  });

  it('rejects unknown kind', async () => {
    const { fetchFn } = makeRecorder(() => jsonResp('UPID:'));
    await expect(createSnapshot({ ...OPTS, kind: 'bogus', fetchFn }, 's'))
      .rejects.toThrow(/kind must be/);
  });
});

describe('auth header normalization', () => {
  it('passes through full PVEAPIToken=... strings', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:'));
    await createSnapshot({ ...OPTS, api_token: 'PVEAPIToken=user@pam!id=secret', fetchFn }, 's');
    expect(calls[0].headers.Authorization).toBe('PVEAPIToken=user@pam!id=secret');
  });

  it('prepends PVEAPIToken= when caller stored just the body', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:'));
    await createSnapshot({ ...OPTS, api_token: 'user@pam!id=secret', fetchFn }, 's');
    expect(calls[0].headers.Authorization).toBe('PVEAPIToken=user@pam!id=secret');
  });
});
