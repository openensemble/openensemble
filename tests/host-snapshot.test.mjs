/**
 * Tests for host_snapshot — the Proxmox/ZFS outer rollback layer.
 *
 * Direct-primitive tests + dispatcher integration + host-level rollback
 * through the rollback.mjs entrypoint.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  captureHostSnapshot,
  rollbackToHostSnapshot,
  snapshotNameFromOpId,
} from '../lib/host-snapshot.mjs';
import { dispatchOperation } from '../lib/op-dispatcher.mjs';
import { rollbackOperationHostLevel } from '../lib/rollback.mjs';
import { findOpRecord, readOpRecords, nodeDir } from '../lib/op-record.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USER = 'user_hostsnap';
const NODE = 'pihole-lxc';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

const PARENT = {
  type:      'proxmox',
  api_url:   'https://pve01:8006',
  api_token: 'PVEAPIToken=root@pam!oe=secret',
  node:      'pve01',
  vmid:      102,
  kind:      'lxc',
  waitForCompletion: false,
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}

// Mock Proxmox: keeps a {vmid → snapshots} map, responds to API calls.
function makeMockProxmox({ failOn = null } = {}) {
  const snapshots = new Map(); // vmid → Set<snapname>
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    if (url === failOn) return new Response('boom', { status: 500 });

    // Snapshot create: POST /nodes/.../<kind>/<vmid>/snapshot
    let m = url.match(/\/nodes\/[^/]+\/(lxc|qemu)\/(\d+)\/snapshot$/);
    if (m && (init.method || 'GET') === 'POST') {
      const vmid = m[2];
      const name = new URLSearchParams(init.body || '').get('snapname');
      if (!snapshots.has(vmid)) snapshots.set(vmid, new Set());
      snapshots.get(vmid).add(name);
      return jsonResp(`UPID:pve01:create:${vmid}:${name}`);
    }
    // Snapshot rollback: POST /snapshot/<name>/rollback
    m = url.match(/\/(lxc|qemu)\/(\d+)\/snapshot\/([^/]+)\/rollback$/);
    if (m && (init.method || 'GET') === 'POST') {
      const vmid = m[2];
      const name = m[3];
      const set = snapshots.get(vmid);
      if (!set?.has(name)) return new Response('not found', { status: 404 });
      return jsonResp(`UPID:pve01:rollback:${vmid}:${name}`);
    }
    // Snapshot delete: DELETE /snapshot/<name>
    m = url.match(/\/(lxc|qemu)\/(\d+)\/snapshot\/([^/]+)$/);
    if (m && init.method === 'DELETE') {
      const vmid = m[2];
      snapshots.get(vmid)?.delete(m[3]);
      return jsonResp(`UPID:pve01:del`);
    }
    return new Response(`unknown: ${init.method || 'GET'} ${url}`, { status: 404 });
  };
  return { snapshots, calls, fetchFn };
}

const intent = (text = 'host-snap test') => ({ user_text: text, agent: 'tester' });

// ── snapshotNameFromOpId ─────────────────────────────────────────────────────

describe('snapshotNameFromOpId', () => {
  it('produces a Proxmox-safe sortable name from a real op id', () => {
    const name = snapshotNameFromOpId('op_2026-05-07T04-02-00-000Z_abc123');
    expect(name).toBe('oe_20260507_040200_abc123');
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(name.length).toBeLessThan(40);
  });

  it('falls back to a sanitized form for unexpected ids', () => {
    const name = snapshotNameFromOpId('weird/id with stuff');
    expect(name).toMatch(/^oe_[A-Za-z0-9_-]+$/);
  });
});

// ── captureHostSnapshot direct ───────────────────────────────────────────────

describe('captureHostSnapshot (proxmox)', () => {
  it('creates a snapshot and returns the manifest', async () => {
    const mock = makeMockProxmox();
    const opId = 'op_2026-05-07T04-02-00-000Z_aaaaaa';
    const hs = await captureHostSnapshot(PARENT, opId, { fetchFn: mock.fetchFn });

    expect(hs.type).toBe('proxmox');
    expect(hs.vmid).toBe(102);
    expect(hs.kind).toBe('lxc');
    expect(hs.snapname).toBe('oe_20260507_040200_aaaaaa');
    expect(hs.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mock.snapshots.get('102')?.has('oe_20260507_040200_aaaaaa')).toBe(true);
  });

  it('errors on unknown parent_host.type', async () => {
    await expect(captureHostSnapshot({ type: 'magic-fs' }, 'op_x', {}))
      .rejects.toThrow(/unsupported parent_host\.type/);
  });

  it('propagates Proxmox API failures', async () => {
    const fetchFn = async () => new Response('err', { status: 500 });
    await expect(captureHostSnapshot(PARENT, 'op_x', { fetchFn }))
      .rejects.toThrow(/HTTP 500/);
  });
});

// ── rollbackToHostSnapshot ───────────────────────────────────────────────────

describe('rollbackToHostSnapshot', () => {
  it('rolls back a known snapshot', async () => {
    const mock = makeMockProxmox();
    const opId = 'op_2026-05-07T04-02-00-000Z_bbb111';
    const hs = await captureHostSnapshot(PARENT, opId, { fetchFn: mock.fetchFn });
    const result = await rollbackToHostSnapshot(PARENT, hs, { fetchFn: mock.fetchFn });
    expect(result.outcome).toBe('success');
    expect(result.message).toMatch(/rolled back lxc\/102/);
  });

  it('returns failure on missing snapname', async () => {
    const result = await rollbackToHostSnapshot(PARENT, { type: 'proxmox' }, {});
    expect(result.outcome).toBe('failure');
    expect(result.message).toMatch(/snapname/);
  });

  it('returns failure when Proxmox rejects (snapshot already deleted)', async () => {
    const mock = makeMockProxmox();
    const stale = { type: 'proxmox', node: 'pve01', vmid: 102, kind: 'lxc', snapname: 'never-existed' };
    const result = await rollbackToHostSnapshot(PARENT, stale, { fetchFn: mock.fetchFn });
    expect(result.outcome).toBe('failure');
  });
});

// ── dispatcher integration ──────────────────────────────────────────────────

describe('op-dispatcher: host_snapshot for high-risk ops', () => {
  it('takes a host snapshot before high-risk ops on parent_host nodes', async () => {
    const mock = makeMockProxmox();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent('high-risk thing'),
      opSpec: {
        id: 'destructive_thing', mechanism: 'noop',
        mechanism_subtype: 'destructive', // forces effective_risk=high
        parameters: {},
        declared_risk: 'medium',
      },
      parent_host: PARENT,
      ctx: { world: new Map(), fetchFn: mock.fetchFn },
    });

    expect(record.operation.risk_class).toBe('high');
    expect(record.pre_state.host_snapshot).not.toBeNull();
    expect(record.pre_state.host_snapshot.type).toBe('proxmox');
    expect(record.pre_state.host_snapshot.vmid).toBe(102);
    expect(mock.snapshots.get('102')).toBeDefined();
    expect([...mock.snapshots.get('102')]).toHaveLength(1);
  });

  it('does NOT take a host snapshot for low-risk ops', async () => {
    const mock = makeMockProxmox();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent('low risk'),
      opSpec: {
        id: 'safe_thing', mechanism: 'noop', mechanism_subtype: 'set',
        parameters: { key: 'k', value: 'v' },
        declared_risk: 'low',
      },
      parent_host: PARENT,
      ctx: { world: new Map(), fetchFn: mock.fetchFn },
    });
    expect(record.operation.risk_class).toBe('low');
    expect(record.pre_state.host_snapshot).toBeNull();
    expect(mock.snapshots.size).toBe(0);
  });

  it('does NOT take a host snapshot when parent_host is absent', async () => {
    const mock = makeMockProxmox();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent('high-risk no parent'),
      opSpec: {
        id: 'destructive', mechanism: 'noop', mechanism_subtype: 'destructive',
        parameters: {}, declared_risk: 'medium',
      },
      // no parent_host
      ctx: { world: new Map(), fetchFn: mock.fetchFn },
    });
    expect(record.operation.risk_class).toBe('high');
    expect(record.pre_state.host_snapshot).toBeNull();
    expect(mock.snapshots.size).toBe(0);
  });

  it('logs host_snapshot capture failure in execution.error but does not abort the op', async () => {
    // failOn URL prevents any snapshot from being created
    const mock = makeMockProxmox({ failOn: 'https://pve01:8006/api2/json/nodes/pve01/lxc/102/snapshot' });
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent(),
      opSpec: {
        id: 'destructive', mechanism: 'noop', mechanism_subtype: 'destructive',
        parameters: {}, declared_risk: 'medium',
      },
      parent_host: PARENT,
      ctx: { world: new Map(), fetchFn: mock.fetchFn },
    });
    expect(record.outcome).toBe('success'); // inner op still ran
    expect(record.pre_state.host_snapshot).toBeNull();
    expect(record.execution.error).toMatch(/host_snapshot/);
  });
});

// ── rollbackOperationHostLevel ───────────────────────────────────────────────

describe('rollbackOperationHostLevel', () => {
  it('reverses an op via host snapshot and writes a new rollback record', async () => {
    const mock = makeMockProxmox();
    // Run a high-risk op so a host snapshot is captured
    const { record: orig } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent('cause damage'),
      opSpec: {
        id: 'destructive', mechanism: 'noop', mechanism_subtype: 'destructive',
        parameters: {}, declared_risk: 'high',
      },
      parent_host: PARENT,
      ctx: { world: new Map(), fetchFn: mock.fetchFn },
    });
    expect(orig.pre_state.host_snapshot).not.toBeNull();

    const rb = await rollbackOperationHostLevel({
      userId: USER, nodeId: NODE, opId: orig.id,
      parent_host: PARENT,
      intent: intent('host-level undo'),
      ctx: { fetchFn: mock.fetchFn },
    });
    expect(rb.outcome).toBe('success');
    expect(rb.message).toMatch(/rolled back/);

    // New record exists, points back at original
    const records = readOpRecords(USER, NODE);
    expect(records).toHaveLength(2);
    expect(records[1].rolls_back_op_id).toBe(orig.id);
    expect(records[1].operation.id).toBe('host_rollback_destructive');
    expect(records[1].operation.risk_class).toBe('high');
  });

  it('aborts when the original op had no host snapshot', async () => {
    const mock = makeMockProxmox();
    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      intent: intent(),
      opSpec: {
        id: 'low', mechanism: 'noop', mechanism_subtype: 'set',
        parameters: { key: 'k', value: 'v' }, declared_risk: 'low',
      },
      parent_host: PARENT,
      ctx: { world: new Map(), fetchFn: mock.fetchFn },
    });
    const rb = await rollbackOperationHostLevel({
      userId: USER, nodeId: NODE, opId: record.id,
      parent_host: PARENT,
      intent: intent(),
      ctx: { fetchFn: mock.fetchFn },
    });
    expect(rb.outcome).toBe('aborted');
    expect(rb.message).toMatch(/no host_snapshot/);
  });

  it('aborts cleanly when parent_host config is missing', async () => {
    const rb = await rollbackOperationHostLevel({
      userId: USER, nodeId: NODE, opId: 'op_does_not_matter',
      // no parent_host
      intent: intent(),
      ctx: {},
    });
    expect(rb.outcome).toBe('aborted');
    expect(rb.message).toMatch(/parent_host/);
  });

  it('aborts when op id not found', async () => {
    const rb = await rollbackOperationHostLevel({
      userId: USER, nodeId: NODE, opId: 'op_never_existed',
      parent_host: PARENT,
      intent: intent(),
      ctx: {},
    });
    expect(rb.outcome).toBe('aborted');
    expect(rb.message).toMatch(/not found/);
  });
});
