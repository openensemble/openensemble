/**
 * Tests for parent_host plumbing: node-registry persistence, the
 * node_set_parent_host skill tool, and the dispatch_op / rollback_op skill
 * tools that go through capability-dispatcher with parent_host resolution.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  setParentHost,
  getParentHost,
  registerNode,
} from '../skills/nodes/node-registry.mjs';
import profilesSkill from '../skills/profiles/execute.mjs';
import nodesSkill from '../skills/nodes/execute.mjs';
import { saveProfile, setTrustState, markOperationVerified } from '../lib/service-profile.mjs';
import { readOpRecords, nodeDir } from '../lib/op-record.mjs';
import { listWatchers, unregisterWatcher } from '../scheduler/watchers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIHOLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pihole-profile.json'), 'utf8'));

const USER = 'user_phtest';
const NODE = 'pihole-test';

// Stand up a fake "registered node" using the registry's own internals.
// We can't open a real WebSocket from a unit test, so this is the cleanest
// way to put an entry into the registry's internal map.
function fakeRegister(nodeId, userId) {
  const fakeWs = { readyState: 1, send: () => {}, close: () => {}, OPEN: 1 };
  return registerNode(fakeWs, userId, {
    nodeId, hostname: nodeId, platform: 'linux', distro: 'Debian',
    arch: 'x64', shell: '/bin/sh', packageManager: 'apt',
  });
}

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  // Clean stray watchers
  const w = listWatchers(USER);
  for (const x of [...w.active, ...w.recent]) unregisterWatcher(USER, x.id, 'test-cleanup');
  // Ensure node exists in registry. registerNode treats subsequent calls as
  // reconnects (preserving in-memory state), then we reset parent_host so
  // tests start from a known clean baseline. We deliberately do NOT call
  // removeNode — it adds the node to the revocation list and prevents the
  // next test from re-registering.
  fakeRegister(NODE, USER);
  setParentHost(NODE, USER, null);
});

const PARENT_PROXMOX = {
  type: 'proxmox',
  api_url: 'https://pve01:8006',
  api_token: 'PVEAPIToken=root@pam!oe=secret',
  node: 'pve01',
  vmid: 102,
  kind: 'lxc',
  waitForCompletion: false,
};

// ── direct registry ─────────────────────────────────────────────────────────

describe('node-registry parent_host', () => {
  it('persists and retrieves parent_host via setParentHost/getParentHost', () => {
    expect(getParentHost(NODE, USER)).toBeNull();
    setParentHost(NODE, USER, PARENT_PROXMOX);
    expect(getParentHost(NODE, USER)).toEqual(expect.objectContaining({
      type: 'proxmox', vmid: 102, kind: 'lxc',
    }));
    setParentHost(NODE, USER, null);
    expect(getParentHost(NODE, USER)).toBeNull();
  });

  it('rejects malformed parent_host', () => {
    expect(() => setParentHost(NODE, USER, { type: 'magic-fs' })).toThrow(/type must be/);
    expect(() => setParentHost(NODE, USER, { type: 'proxmox', api_url: 'x' })).toThrow(/requires api_token/);
    expect(() => setParentHost(NODE, USER, { type: 'proxmox', api_url: 'x', api_token: 't', node: 'n', vmid: 1, kind: 'bogus' })).toThrow(/kind must be/);
    expect(() => setParentHost(NODE, USER, { type: 'zfs', ssh_host: 'x' })).toThrow(/dataset/);
  });

  it('returns null for unknown node', () => {
    expect(getParentHost('never-existed', USER)).toBeNull();
    expect(setParentHost('never-existed', USER, PARENT_PROXMOX)).toBeNull();
  });
});

// ── nodes skill: node_set_parent_host + node_detect_services ────────────────

async function collectGenerator(gen) {
  const items = [];
  for await (const item of gen) items.push(item);
  return items;
}

describe('nodes skill: node_set_parent_host', () => {
  it('wires a node to a Proxmox host and reports the target', async () => {
    const result = await collectGenerator(
      nodesSkill('node_set_parent_host', { node_id: NODE, parent_host: PARENT_PROXMOX }, USER)
    );
    expect(result.find(r => r.text)?.text).toMatch(/Wired/);
    expect(result.find(r => r.text)?.text).toMatch(/Proxmox lxc 102 on pve01/);
    expect(getParentHost(NODE, USER)).not.toBeNull();
  });

  it('clears parent_host when called with null', async () => {
    setParentHost(NODE, USER, PARENT_PROXMOX);
    const result = await collectGenerator(
      nodesSkill('node_set_parent_host', { node_id: NODE, parent_host: null }, USER)
    );
    expect(result.find(r => r.text)?.text).toMatch(/Cleared parent_host/);
    expect(getParentHost(NODE, USER)).toBeNull();
  });

  it('reports a clean error for malformed parent_host', async () => {
    const result = await collectGenerator(
      nodesSkill('node_set_parent_host', { node_id: NODE, parent_host: { type: 'magic-fs' } }, USER)
    );
    expect(result.find(r => r.text)?.text).toMatch(/Error.*type must be/);
  });
});

// ── profiles skill: dispatch_op + rollback_op end-to-end ────────────────────

describe('profiles skill: dispatch_op + rollback_op', () => {
  function makeMockBlocklist() {
    const blocklist = new Set(['existing.bad.com']);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      if (u.searchParams.get('auth') !== 'good') return new Response('{}', { status: 401 });
      const list = u.searchParams.get('list');
      const add = u.searchParams.get('add');
      const sub = u.searchParams.get('sub');
      if (list === 'black' && !add && !sub) return new Response(JSON.stringify({ data: [...blocklist] }), { status: 200 });
      if (add) { blocklist.add(add); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
      if (sub) { blocklist.delete(sub); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }
      return new Response('bad', { status: 400 });
    };
    return { blocklist, restore: () => { globalThis.fetch = realFetch; } };
  }

  beforeEach(async () => {
    // Save profile + stash auth token so the skill can resolve it
    const profile = JSON.parse(JSON.stringify(PIHOLE));
    profile.node_id = NODE;
    saveProfile(USER, NODE, profile);
    setTrustState(USER, NODE, 'pihole', 'reviewed');
    markOperationVerified(USER, NODE, 'pihole', 'dns_block', true);

    // Stash the API token in the user's profile.json (the skill reads this)
    const userProfile = path.join(path.dirname(nodeDir(USER, NODE)), '..', 'profile.json');
    fs.mkdirSync(path.dirname(userProfile), { recursive: true });
    fs.writeFileSync(userProfile, JSON.stringify({ pihole_api_token: 'good' }), 'utf8');
  });

  it('dispatches a dns_block through the skill and returns op id + rollback hint', async () => {
    const m = makeMockBlocklist();
    try {
      const result = await profilesSkill('dispatch_op', {
        node_id: NODE, service_id: 'pihole', op_id: 'dns_block',
        parameters: { domain: 'doubleclick.net' },
        user_text: 'block doubleclick',
      }, USER);
      expect(result).toMatch(/outcome: \*\*success\*\*/);
      expect(result).toMatch(/Op id: `op_/);
      expect(result).toMatch(/Rollback: available/);
      expect(m.blocklist.has('doubleclick.net')).toBe(true);
    } finally { m.restore(); }
  });

  it('rollback_op surgically reverses a dispatched op', async () => {
    const m = makeMockBlocklist();
    try {
      const dispatchResult = await profilesSkill('dispatch_op', {
        node_id: NODE, service_id: 'pihole', op_id: 'dns_block',
        parameters: { domain: 'tracker.example.com' },
      }, USER);
      const opIdMatch = dispatchResult.match(/Op id: `(op_[^`]+)`/);
      expect(opIdMatch).toBeTruthy();
      const opId = opIdMatch[1];

      const rb = await profilesSkill('rollback_op', { node_id: NODE, op_id: opId }, USER);
      expect(rb).toMatch(/Surgical rollback: \*\*success\*\*/);
      expect(m.blocklist.has('tracker.example.com')).toBe(false);
    } finally { m.restore(); }
  });

  it('reports honestly when no profile exists', async () => {
    const result = await profilesSkill('dispatch_op', {
      node_id: NODE, service_id: 'home_assistant', op_id: 'turn_on',
      parameters: {},
    }, USER);
    expect(result).toMatch(/No profile found/);
  });

  it('rollback_op aborts cleanly for an unknown op id', async () => {
    const result = await profilesSkill('rollback_op', { node_id: NODE, op_id: 'op_does_not_exist' }, USER);
    expect(result).toMatch(/not found/);
  });

  it('rollback_op host_level=true reports missing parent_host clearly', async () => {
    const m = makeMockBlocklist();
    try {
      const dispatchResult = await profilesSkill('dispatch_op', {
        node_id: NODE, service_id: 'pihole', op_id: 'dns_block',
        parameters: { domain: 'host-test.invalid' },
      }, USER);
      const opId = dispatchResult.match(/Op id: `(op_[^`]+)`/)[1];
      // No parent_host wired
      const rb = await profilesSkill('rollback_op', { node_id: NODE, op_id: opId, host_level: true }, USER);
      expect(rb).toMatch(/no parent_host configured/);
    } finally { m.restore(); }
  });
});

// ── service detection probe ─────────────────────────────────────────────────
//
// node_detect_services calls sendCommand on the node registry, which is hard
// to mock cleanly (the skill imports the binding directly, so vi.spyOn on the
// module namespace doesn't replace it). We test that the tool requires a real
// node and rejects missing args; the parser logic is exercised in the
// integration smoke when we walk the live flow.

describe('nodes skill: node_detect_services (input handling)', () => {
  it('requires node_id', async () => {
    const result = await collectGenerator(nodesSkill('node_detect_services', {}, USER));
    expect(result.find(r => r.text)?.text).toMatch(/Error.*node_id/);
  });

  it('reports unknown node cleanly', async () => {
    const result = await collectGenerator(
      nodesSkill('node_detect_services', { node_id: 'never-registered-anywhere' }, USER)
    );
    expect(result.find(r => r.text)?.text).toMatch(/not found/);
  });
});
