/**
 * Tests for the health-monitor watcher integration.
 *
 * Tests the registration helpers + the watcher record state shape. The
 * full "watcher fires on tick → opens incident" path is exercised
 * end-to-end through runTroubleshootingLoop in troubleshooting-pipeline.test.mjs;
 * this file just confirms the wiring around it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  registerProfileHealthWatchers,
  unregisterProfileHealthWatchers,
  startHealthMonitorHandlers,
  setHealthMonitorCtxResolver,
  _runSignalCheckForTest as runSignalCheck,
} from '../scheduler/health-monitor.mjs';
import { saveProfile } from '../lib/service-profile.mjs';
import { listWatchers, unregisterWatcher } from '../scheduler/watchers.mjs';
import { nodeDir } from '../lib/op-record.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIHOLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pihole-profile.json'), 'utf8'));

const USER = 'user_health';
const NODE = 'pihole-test';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  // Wipe any stray watchers from prior tests for this user.
  const w = listWatchers(USER);
  for (const x of [...w.active, ...w.recent]) unregisterWatcher(USER, x.id, 'test-cleanup');
});

const fresh = () => JSON.parse(JSON.stringify(PIHOLE));

describe('startHealthMonitorHandlers', () => {
  it('is idempotent — safe to call multiple times', () => {
    expect(() => {
      startHealthMonitorHandlers();
      startHealthMonitorHandlers();
      startHealthMonitorHandlers();
    }).not.toThrow();
  });

  it('accepts a ctxResolver via opts', () => {
    const resolver = () => ({ auth_override: 'test' });
    expect(() => startHealthMonitorHandlers({ ctxResolver: resolver })).not.toThrow();
    setHealthMonitorCtxResolver(null); // restore
  });
});

describe('registerProfileHealthWatchers', () => {
  beforeEach(() => { saveProfile(USER, NODE, fresh()); });

  it('creates one watcher carrying every signal', () => {
    const result = registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'test-agent' });
    expect(result.registered).toBe(1); // single coalesced watcher
    expect(result.signal_count).toBe(2); // pihole fixture has 2 health_signals
    expect(result.watcher_id).toBeTruthy();
  });

  it('persists watcher state with the coalesced signals[] shape', () => {
    registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'test-agent' });
    const watchers = listWatchers(USER);
    const profileWatchers = watchers.active.filter(w => w.kind === 'profile_health');
    expect(profileWatchers).toHaveLength(1);
    const w = profileWatchers[0];
    expect(w.state.node_id).toBe(NODE);
    expect(w.state.service_id).toBe('pihole');
    expect(w.expiresAt).toBeNull(); // indefinite
    expect(w.state.signals).toHaveLength(2);
    expect(w.state.signals.map(s => s.kind).sort()).toEqual(['blocking_enabled', 'service_up']);
    for (const s of w.state.signals) {
      expect(s.last_state).toBe('unknown');
      expect(s.current_incident_id).toBeNull();
      expect(s.last_checked_at).toBeNull();
    }
  });

  it('returns zero when profile has no health signals', () => {
    const noSignals = fresh();
    noSignals.health_signals = [];
    saveProfile(USER, NODE, noSignals);
    const result = registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'test-agent' });
    expect(result.registered).toBe(0);
    expect(result.signal_count).toBe(0);
    expect(result.watcher_id).toBeNull();
  });

  it('throws cleanly when profile does not exist', () => {
    expect(() => registerProfileHealthWatchers(USER, NODE, 'nonexistent'))
      .toThrow(/no profile/);
  });

  it('normalizes LLM-coined non-canonical signal shape', () => {
    // LLM-saved profiles often spell `check.mechanism` as `check.type`, nest
    // `expect` inside check, or use 'exec'/'shell' for the mechanism. Make
    // sure the watcher state ends up canonical regardless.
    const profile = fresh();
    profile.health_signals = [{
      kind: 'ports_listening',
      check: { type: 'exec', command: 'ss -ltn', expect: 'LISTEN' },
      severity: 'critical',
      cadence_sec: 60,
    }];
    saveProfile(USER, NODE, profile);
    registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'a' });
    const w = listWatchers(USER).active.find(x => x.kind === 'profile_health');
    const sig = w.state.signals[0];
    expect(sig.check.mechanism).toBe('cli'); // exec → cli
    expect(sig.check.type).toBeUndefined();  // dropped
    expect(sig.expect).toBe('LISTEN');       // pulled up to signal level
    expect(sig.check.expect).toBeUndefined();
    expect(sig.check.command).toBe('ss -ltn');
  });
});

describe('runSignalCheck — cli / exec mechanisms', () => {
  // Helper to install a stub execFn for the duration of one assertion.
  function withExecFn(execFn, fn) {
    setHealthMonitorCtxResolver(() => ({ execFn }));
    try { return fn(); } finally { setHealthMonitorCtxResolver(null); }
  }

  it("treats 'exec' as an alias for 'cli'", async () => {
    const calls = [];
    const execFn = async (cmd) => { calls.push(cmd); return { stdout: 'active', stderr: '', exitCode: 0 }; };
    await withExecFn(execFn, async () => {
      const result = await runSignalCheck(
        { node_id: NODE, service_id: 'pihole', endpoint: '' },
        { check: { mechanism: 'exec', command: 'systemctl is-active foo' }, expect: 'active' },
        { userId: USER },
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe('active');
      expect(calls).toEqual(['systemctl is-active foo']);
    });
  });

  it("'cli' mechanism passes through identically", async () => {
    const execFn = async () => ({ stdout: 'enabled', stderr: '', exitCode: 0 });
    await withExecFn(execFn, async () => {
      const result = await runSignalCheck(
        { node_id: NODE, service_id: 'pihole', endpoint: '' },
        { check: { mechanism: 'cli', command: 'pihole status' }, expect: 'enabled' },
        { userId: USER },
      );
      expect(result.ok).toBe(true);
      expect(result.value).toBe('enabled');
    });
  });

  it('returns unknown when execFn is not provided', async () => {
    setHealthMonitorCtxResolver(null); // no execFn in ctx
    const result = await runSignalCheck(
      '',
      { check: { mechanism: 'cli', command: 'whatever' } },
      { userId: USER },
    );
    expect(result.unknown).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('returns unknown when node is offline (so disconnects do not flip signals unhealthy)', async () => {
    const execFn = async () => ({ stdout: '', stderr: 'Node "abc" is offline', exitCode: 1 });
    await withExecFn(execFn, async () => {
      const result = await runSignalCheck(
        { node_id: NODE, service_id: 'pihole', endpoint: '' },
        { check: { mechanism: 'cli', command: 'foo' }, expect: 'bar' },
        { userId: USER },
      );
      expect(result.unknown).toBe(true);
      expect(result.ok).toBe(false);
    });
  });

  it('returns ok=false (genuine unhealthy) when the command runs but produces wrong output', async () => {
    const execFn = async () => ({ stdout: 'inactive', stderr: '', exitCode: 3 });
    await withExecFn(execFn, async () => {
      const result = await runSignalCheck(
        { node_id: NODE, service_id: 'pihole', endpoint: '' },
        { check: { mechanism: 'cli', command: 'systemctl is-active foo' }, expect: 'active' },
        { userId: USER },
      );
      expect(result.unknown).toBeUndefined();
      expect(result.ok).toBe(false);
      expect(result.value).toBe('inactive');
    });
  });
});

describe('unregisterProfileHealthWatchers', () => {
  beforeEach(() => { saveProfile(USER, NODE, fresh()); });

  it('removes only the matching service_id watcher', () => {
    // Save a second profile + register both
    const second = fresh();
    second.service_id = 'home_assistant';
    second.endpoint = 'http://192.0.2.20:8123';
    saveProfile(USER, NODE, second);
    registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'a' });
    registerProfileHealthWatchers(USER, NODE, 'home_assistant', { agentId: 'a' });
    expect(listWatchers(USER).active.filter(w => w.kind === 'profile_health')).toHaveLength(2);

    const removed = unregisterProfileHealthWatchers(USER, NODE, 'pihole');
    expect(removed).toBe(1);
    const left = listWatchers(USER).active.filter(w => w.kind === 'profile_health');
    expect(left).toHaveLength(1);
    expect(left[0].state.service_id).toBe('home_assistant');
  });

  it('returns 0 when nothing matches', () => {
    const removed = unregisterProfileHealthWatchers(USER, NODE, 'never-registered');
    expect(removed).toBe(0);
  });
});

describe('registerProfileHealthWatchers — orphan incident cleanup', () => {
  beforeEach(() => { saveProfile(USER, NODE, fresh()); });

  it('abandons open incidents from prior watcher iterations on re-register', async () => {
    const { openIncident, listIncidents, loadIncident } = await import('../lib/incident.mjs');

    // Register, then simulate a watcher firing (open incident), then unregister
    // and re-register — the new watcher has no link to the old incident.
    registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'a' });
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'service_up', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
    });
    expect(listIncidents(USER, NODE, { openOnly: true })).toHaveLength(1);

    unregisterProfileHealthWatchers(USER, NODE, 'pihole');
    const result = registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'a' });
    expect(result.orphans_closed).toBe(1);
    expect(listIncidents(USER, NODE, { openOnly: true })).toHaveLength(0);

    // Verify the abandoned incident still exists with the right status + summary
    const closed = loadIncident(USER, NODE, inc.id);
    expect(closed.status).toBe('abandoned');
    expect(closed.resolution_summary).toMatch(/watcher re-registered/);
  });

  it('does not touch incidents from other services on the same node', async () => {
    const { openIncident, listIncidents } = await import('../lib/incident.mjs');
    const second = fresh();
    second.service_id = 'home_assistant';
    saveProfile(USER, NODE, second);

    const piIncident = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 's', value: 'v', expected: 'e', fired_at: new Date().toISOString() },
    });
    const haIncident = openIncident(USER, NODE, {
      service_id: 'home_assistant',
      triggering_signal: { kind: 's', value: 'v', expected: 'e', fired_at: new Date().toISOString() },
    });
    expect(listIncidents(USER, NODE, { openOnly: true })).toHaveLength(2);

    registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'a' });
    const open = listIncidents(USER, NODE, { openOnly: true });
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(haIncident.id);
  });
});
