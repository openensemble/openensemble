/**
 * Tests for Proxmox VM (qemu) coverage — proves the kind:'qemu' code path
 * works end-to-end and that the `vmstate` flag is correctly handled.
 *
 * The architecture treats LXC and VM identically at every layer except the
 * URL path (`/lxc/` vs `/qemu/`) and the optional `vmstate` parameter for
 * memory snapshot. These tests confirm both.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import {
  createSnapshot,
  rollbackSnapshot,
  deleteSnapshot,
} from '../lib/proxmox-api.mjs';
import { captureHostSnapshot, rollbackToHostSnapshot } from '../lib/host-snapshot.mjs';
import { dispatchOperation } from '../lib/op-dispatcher.mjs';
import { rollbackOperationHostLevel } from '../lib/rollback.mjs';
import { setParentHost, registerNode } from '../skills/nodes/node-registry.mjs';
import { nodeDir } from '../lib/op-record.mjs';

const USER = 'user_vmtest';
const NODE = 'home-assistant-vm';

const VM_PARENT = {
  type: 'proxmox',
  api_url: 'https://pve01:8006',
  api_token: 'PVEAPIToken=root@pam!oe=secret',
  node: 'pve01',
  vmid: 200,
  kind: 'qemu',
  vmstate: true, // HA's automations live in RAM
  waitForCompletion: false,
};

const VM_PARENT_DISKONLY = { ...VM_PARENT, vmstate: false };

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}

function makeRecorder(handler) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method || 'GET',
      body: init.body || null,
    });
    return handler(url, init);
  };
  return { calls, fetchFn };
}

// ── proxmox-api: VM URL path ────────────────────────────────────────────────

describe('proxmox-api with kind=qemu', () => {
  it('createSnapshot uses /qemu/ path for VMs', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:vm:create'));
    await createSnapshot({
      api_url: 'https://pve01:8006',
      api_token: 'tok',
      node: 'pve01', vmid: 200, kind: 'qemu',
      waitForCompletion: false, fetchFn,
    }, 'oe-vm-snap');
    expect(calls[0].url).toBe('https://pve01:8006/api2/json/nodes/pve01/qemu/200/snapshot');
  });

  it('createSnapshot includes vmstate=1 when opts.vmstate=true on a qemu VM', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:vm'));
    await createSnapshot({
      api_url: 'x', api_token: 't', node: 'n', vmid: 1, kind: 'qemu',
      vmstate: true, waitForCompletion: false, fetchFn,
    }, 'oe-x');
    expect(calls[0].body).toContain('vmstate=1');
  });

  it('createSnapshot does NOT emit vmstate for LXC even if flag is set', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:lxc'));
    await createSnapshot({
      api_url: 'x', api_token: 't', node: 'n', vmid: 1, kind: 'lxc',
      vmstate: true, waitForCompletion: false, fetchFn,
    }, 'oe-x');
    expect(calls[0].body).not.toContain('vmstate');
  });

  it('createSnapshot omits vmstate for qemu when flag is false/absent', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:vm'));
    await createSnapshot({
      api_url: 'x', api_token: 't', node: 'n', vmid: 1, kind: 'qemu',
      vmstate: false, waitForCompletion: false, fetchFn,
    }, 'oe-x');
    expect(calls[0].body).not.toContain('vmstate');
  });

  it('rollbackSnapshot uses /qemu/ path', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:vm-rb'));
    await rollbackSnapshot({
      api_url: 'https://pve01:8006', api_token: 't',
      node: 'pve01', vmid: 200, kind: 'qemu', waitForCompletion: false, fetchFn,
    }, 'oe-vm-snap');
    expect(calls[0].url).toBe('https://pve01:8006/api2/json/nodes/pve01/qemu/200/snapshot/oe-vm-snap/rollback');
  });

  it('deleteSnapshot uses /qemu/ path', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:vm-del'));
    await deleteSnapshot({
      api_url: 'https://pve01:8006', api_token: 't',
      node: 'pve01', vmid: 200, kind: 'qemu', waitForCompletion: false, fetchFn,
    }, 'oe-vm-snap');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe('https://pve01:8006/api2/json/nodes/pve01/qemu/200/snapshot/oe-vm-snap');
  });
});

// ── host-snapshot wrapper: VM round-trip ────────────────────────────────────

describe('captureHostSnapshot for qemu VMs', () => {
  it('captures with vmstate when parent_host.vmstate=true', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:'));
    const hs = await captureHostSnapshot(VM_PARENT, 'op_2026-05-07T10-00-00-000Z_aaaaaa', { fetchFn });
    expect(hs.type).toBe('proxmox');
    expect(hs.kind).toBe('qemu');
    expect(hs.vmid).toBe(200);
    expect(calls[0].url).toContain('/qemu/200/snapshot');
    expect(calls[0].body).toContain('vmstate=1');
  });

  it('captures disk-only when vmstate=false (default)', async () => {
    const { calls, fetchFn } = makeRecorder(() => jsonResp('UPID:'));
    await captureHostSnapshot(VM_PARENT_DISKONLY, 'op_2026-05-07T10-00-00-000Z_bbbbbb', { fetchFn });
    expect(calls[0].body).not.toContain('vmstate');
  });

  it('rollback round-trip works for qemu', async () => {
    const snapshots = new Map();
    const fetchFn = async (url, init = {}) => {
      const m1 = url.match(/\/qemu\/(\d+)\/snapshot$/);
      if (m1 && init.method === 'POST') {
        const name = new URLSearchParams(init.body || '').get('snapname');
        snapshots.set(`${m1[1]}@${name}`, true);
        return jsonResp(`UPID:vm:create:${name}`);
      }
      const m2 = url.match(/\/qemu\/(\d+)\/snapshot\/([^/]+)\/rollback$/);
      if (m2 && init.method === 'POST') {
        if (!snapshots.has(`${m2[1]}@${m2[2]}`)) return new Response('not found', { status: 404 });
        return jsonResp(`UPID:vm:rb:${m2[2]}`);
      }
      return new Response('?', { status: 404 });
    };

    const hs = await captureHostSnapshot(VM_PARENT, 'op_2026-05-07T10-00-00-000Z_ccc111', { fetchFn });
    const rb = await rollbackToHostSnapshot(VM_PARENT, hs, { fetchFn });
    expect(rb.outcome).toBe('success');
    expect(rb.message).toMatch(/qemu\/200/);
  });
});

// ── dispatcher integration with VM parent_host ──────────────────────────────

describe('op-dispatcher with VM parent_host', () => {
  it('takes a VM-shape host snapshot for high-risk ops on qemu nodes', async () => {
    const calls = [];
    const fetchFn = async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET' });
      return jsonResp('UPID:test');
    };

    const { record } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'home_assistant',
      intent: { user_text: 'restart HA core', agent: 'tester' },
      opSpec: {
        id: 'destructive_thing', mechanism: 'noop',
        mechanism_subtype: 'destructive',
        parameters: {}, declared_risk: 'high',
      },
      parent_host: VM_PARENT,
      ctx: { world: new Map(), fetchFn },
    });

    expect(record.pre_state.host_snapshot.type).toBe('proxmox');
    expect(record.pre_state.host_snapshot.kind).toBe('qemu');
    expect(record.pre_state.host_snapshot.vmid).toBe(200);
    expect(calls[0].url).toContain('/qemu/200/snapshot');
  });

  it('host-level rollback restores the VM via /qemu/ path', async () => {
    const snapshots = new Map();
    const fetchFn = async (url, init = {}) => {
      const m1 = url.match(/\/qemu\/(\d+)\/snapshot$/);
      if (m1 && init.method === 'POST') {
        const name = new URLSearchParams(init.body || '').get('snapname');
        snapshots.set(`${m1[1]}@${name}`, true);
        return jsonResp(`UPID:c`);
      }
      const m2 = url.match(/\/qemu\/(\d+)\/snapshot\/([^/]+)\/rollback$/);
      if (m2 && init.method === 'POST') {
        if (!snapshots.has(`${m2[1]}@${m2[2]}`)) return new Response('?', { status: 404 });
        return jsonResp(`UPID:r`);
      }
      return new Response('?', { status: 404 });
    };

    const { record: orig } = await dispatchOperation({
      userId: USER, nodeId: NODE, serviceId: 'home_assistant',
      intent: { user_text: 'cause damage to HA', agent: 'tester' },
      opSpec: {
        id: 'destructive_thing', mechanism: 'noop', mechanism_subtype: 'destructive',
        parameters: {}, declared_risk: 'high',
      },
      parent_host: VM_PARENT,
      ctx: { world: new Map(), fetchFn },
    });
    expect(orig.pre_state.host_snapshot).toBeTruthy();

    const rb = await rollbackOperationHostLevel({
      userId: USER, nodeId: NODE, opId: orig.id,
      parent_host: VM_PARENT,
      intent: { user_text: 'restore HA', agent: 'tester' },
      ctx: { fetchFn },
    });
    expect(rb.outcome).toBe('success');
  });
});

// ── parent_host validation: vmstate semantics ───────────────────────────────

describe('parent_host validation for VMs', () => {
  function fakeRegister(nodeId, userId) {
    const ws = { readyState: 1, send: () => {}, close: () => {}, OPEN: 1 };
    return registerNode(ws, userId, {
      nodeId, hostname: nodeId, platform: 'linux', distro: 'd', arch: 'x',
      shell: '/sh', packageManager: 'apt',
    });
  }

  it('accepts vmstate:true for qemu', () => {
    fakeRegister(NODE, USER);
    expect(() => setParentHost(NODE, USER, VM_PARENT)).not.toThrow();
  });

  it('accepts vmstate:false for qemu (disk-only)', () => {
    fakeRegister(NODE, USER);
    expect(() => setParentHost(NODE, USER, VM_PARENT_DISKONLY)).not.toThrow();
  });

  it('rejects vmstate:true for LXC (no memory state)', () => {
    fakeRegister(NODE, USER);
    const lxcWithVmstate = { ...VM_PARENT, kind: 'lxc', vmstate: true };
    expect(() => setParentHost(NODE, USER, lxcWithVmstate)).toThrow(/only valid for kind:"qemu"/);
  });

  it('rejects non-boolean vmstate', () => {
    fakeRegister(NODE, USER);
    const bad = { ...VM_PARENT, vmstate: 'yes' };
    expect(() => setParentHost(NODE, USER, bad)).toThrow(/vmstate must be boolean/);
  });
});
