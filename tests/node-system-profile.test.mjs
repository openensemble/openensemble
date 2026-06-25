import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import {
  buildSystemProfile,
  ensureNodeSystemProfile,
  backfillSystemProfilesForUserNodes,
} from '../lib/node-system-profile.mjs';
import { validateProfile, loadProfile } from '../lib/service-profile.mjs';
import { listWatchers, unregisterWatcher } from '../scheduler/watchers.mjs';
import { nodeDir } from '../lib/op-record.mjs';

const USER = 'user_sysprofile';
const NODE = 'system-test-node';

beforeEach(() => {
  // Wipe per-node state
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  // Wipe stray watchers from prior tests
  const w = listWatchers(USER);
  for (const x of [...w.active, ...w.recent]) unregisterWatcher(USER, x.id, 'test-cleanup');
});

describe('buildSystemProfile', () => {
  it('returns a profile that passes validateProfile', () => {
    const p = buildSystemProfile({ nodeId: NODE, hostname: 'mybox' });
    expect(() => validateProfile(p)).not.toThrow();
  });

  it('declares the four baseline signals', () => {
    const p = buildSystemProfile({ nodeId: NODE, hostname: 'mybox' });
    const kinds = p.health_signals.map(s => s.kind).sort();
    expect(kinds).toEqual(['agent_active', 'disk_free', 'load_1min', 'memory_free']);
  });

  it('declares baseline diagnostic + maintenance operations', () => {
    const p = buildSystemProfile({ nodeId: NODE, hostname: 'mybox' });
    const ids = p.operations.map(o => o.id).sort();
    expect(ids).toEqual([
      'agent_restart', 'apt_autoclean', 'disk_detail',
      'journal_tail', 'smart_health', 'top_cpu', 'top_memory',
    ]);
    // Read-only diagnostics should outnumber write ops.
    expect(p.operations.filter(o => o.readonly).length).toBe(5);
    expect(p.operations.filter(o => !o.readonly).length).toBe(2);
    // Write ops must declare risk; agent_restart in particular must NOT be low
    // (would let it auto-fire from the troubleshooting loop, undesirable).
    const restart = p.operations.find(o => o.id === 'agent_restart');
    expect(restart.risk).toBe('medium');
  });

  it('every signal uses canonical mechanism (cli or http)', () => {
    const p = buildSystemProfile({ nodeId: NODE, hostname: 'mybox' });
    for (const s of p.health_signals) {
      expect(['cli', 'http']).toContain(s.check.mechanism);
    }
  });

  it('expects use proper {contains|lt|gt} object form for multiline output', () => {
    const p = buildSystemProfile({ nodeId: NODE, hostname: 'mybox' });
    for (const s of p.health_signals) {
      // No bare strings — would false-positive on stdout that contains the
      // expected value but isn't strictly equal.
      if (typeof s.expect === 'string') {
        throw new Error(`signal ${s.kind} uses bare-string expect (would not match multiline output)`);
      }
    }
  });

  it('starts trust_state at unverified until the user onboards Host health', () => {
    const p = buildSystemProfile({ nodeId: NODE, hostname: 'mybox' });
    expect(p.trust_state).toBe('unverified');
  });
});

describe('ensureNodeSystemProfile', () => {
  it('creates the profile as Draft without registering a watcher on first run', () => {
    const r = ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    expect(r.created).toBe(true);
    expect(r.signal_count).toBe(4);
    expect(r.watcher_id).toBeNull();
    expect(loadProfile(USER, NODE, 'system')).toBeTruthy();
    const watchers = listWatchers(USER).active.filter(w => w.kind === 'profile_health' && w.state.service_id === 'system');
    expect(watchers).toHaveLength(0);
  });

  it('is idempotent while the profile is waiting for approval', () => {
    ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    const second = ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    expect(second.created).toBe(false);
    expect(second.reason).toMatch(/non-monitoring trust state/);
    const watchers = listWatchers(USER).active.filter(w => w.kind === 'profile_health' && w.state.service_id === 'system');
    expect(watchers).toHaveLength(0);
  });

  it('recovers a missing watcher when the profile exists but no watcher does', async () => {
    // Simulate the cap-was-hit scenario: profile saved, but watcher never registered.
    ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    const { saveProfile, loadProfile } = await import('../lib/service-profile.mjs');
    const p = loadProfile(USER, NODE, 'system');
    p.trust_state = 'reviewed';
    saveProfile(USER, NODE, p);
    ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    // Tear down the watcher externally to simulate the bug state.
    const { unregisterProfileHealthWatchers } = await import('../scheduler/health-monitor.mjs');
    unregisterProfileHealthWatchers(USER, NODE, 'system');
    expect(listWatchers(USER).active.filter(w => w.kind === 'profile_health' && w.state.service_id === 'system')).toHaveLength(0);

    const recovery = ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    expect(recovery.created).toBe(false); // profile not freshly created
    expect(recovery.signal_count).toBe(4); // but watcher recovered
    expect(listWatchers(USER).active.filter(w => w.kind === 'profile_health' && w.state.service_id === 'system')).toHaveLength(1);
  });

  it('auto-upgrades an OE-authored profile when the bundled version moves forward', async () => {
    // Plant an old-version profile on disk to simulate a v1 install.
    const { saveProfile, loadProfile } = await import('../lib/service-profile.mjs');
    const old = buildSystemProfile({ nodeId: NODE, hostname: 'mybox' });
    old.profile_version = 'oe_system_v1';
    old.operations = []; // v1 had no operations
    saveProfile(USER, NODE, old);

    const r = ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    expect(r.upgraded).toBe(true);
    expect(r.from_version).toBe('oe_system_v1');
    expect(r.to_version).toMatch(/oe_system_v/);
    const after = loadProfile(USER, NODE, 'system');
    expect(after.profile_version).not.toBe('oe_system_v1');
    expect(after.operations.length).toBeGreaterThan(0); // v2 has operations
  });

  it('does NOT upgrade a user-customized profile (profile_version not oe_system_v*)', async () => {
    const { saveProfile, loadProfile } = await import('../lib/service-profile.mjs');
    const custom = buildSystemProfile({ nodeId: NODE, hostname: 'mybox' });
    custom.profile_version = 'shawn_custom_v1'; // user has opted out
    custom.operations = [];
    saveProfile(USER, NODE, custom);

    const r = ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    expect(r.upgraded).toBeFalsy();
    const after = loadProfile(USER, NODE, 'system');
    expect(after.profile_version).toBe('shawn_custom_v1');
    expect(after.operations).toEqual([]);
  });

  it('preserves trust_state across an auto-upgrade', async () => {
    const { saveProfile, loadProfile } = await import('../lib/service-profile.mjs');
    const old = buildSystemProfile({ nodeId: NODE, hostname: 'mybox' });
    old.profile_version = 'oe_system_v1';
    old.trust_state = 'proven'; // user promoted it
    old.operations = [];
    saveProfile(USER, NODE, old);

    ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    expect(loadProfile(USER, NODE, 'system').trust_state).toBe('proven');
  });

  it('respects user choice if profile exists with non-monitoring trust state', async () => {
    ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    // Toggle trust state to unverified to simulate user disabling monitoring.
    const { saveProfile, loadProfile } = await import('../lib/service-profile.mjs');
    const p = loadProfile(USER, NODE, 'system');
    p.trust_state = 'unverified';
    saveProfile(USER, NODE, p);
    const { unregisterProfileHealthWatchers } = await import('../scheduler/health-monitor.mjs');
    unregisterProfileHealthWatchers(USER, NODE, 'system');

    const r = ensureNodeSystemProfile(USER, NODE, { hostname: 'mybox', platform: 'linux' });
    expect(r.created).toBe(false);
    expect(r.reason).toMatch(/non-monitoring trust state/);
    expect(listWatchers(USER).active.filter(w => w.kind === 'profile_health' && w.state.service_id === 'system')).toHaveLength(0);
  });

  it('skips non-linux platforms', () => {
    const r = ensureNodeSystemProfile(USER, NODE, { hostname: 'wibble', platform: 'win32' });
    expect(r.created).toBe(false);
    expect(r.reason).toMatch(/not supported/);
    expect(loadProfile(USER, NODE, 'system')).toBeNull();
  });

  it('errors gracefully on missing args', () => {
    expect(ensureNodeSystemProfile('', NODE).created).toBe(false);
    expect(ensureNodeSystemProfile(USER, '').created).toBe(false);
  });
});

describe('backfillSystemProfilesForUserNodes', () => {
  it('creates one profile per linux node, skips non-linux', () => {
    const r = backfillSystemProfilesForUserNodes(USER, [
      { nodeId: NODE,           hostname: 'a', platform: 'linux' },
      { nodeId: NODE + '_two',  hostname: 'b', platform: 'linux' },
      { nodeId: NODE + '_win',  hostname: 'c', platform: 'win32' },
    ]);
    expect(r.swept).toBe(3);
    expect(r.created).toBe(2);
    expect(r.skipped).toBe(1);
  });

  it('handles empty or missing input', () => {
    expect(backfillSystemProfilesForUserNodes(USER, []).swept).toBe(0);
    expect(backfillSystemProfilesForUserNodes(USER, null).swept).toBe(0);
  });
});
