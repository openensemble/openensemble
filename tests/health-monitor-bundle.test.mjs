/**
 * Tests for the bundled-bash CLI signal batching + jitter dispersion.
 *
 * The bundle path is the perf-critical fix from project_node_health_batching_todo:
 * one composite `bash -c` per profile per tick, parsed back into per-signal
 * results via nonce-delimited markers. Tests cover the script builder, parser,
 * fallback semantics, and registerWatcher's deterministic phase offset.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildBundleScript,
  parseBundleOutput,
} from '../scheduler/health-monitor.mjs';
import {
  registerWatcher,
  listWatchers,
  unregisterWatcher,
  registerSystemWatcherHandler,
} from '../scheduler/watchers.mjs';

const USER = 'user_bundle_test';

function wipeUserWatchers() {
  try {
    const w = listWatchers(USER);
    for (const x of [...w.active, ...w.recent]) unregisterWatcher(USER, x.id, 'test-cleanup');
  } catch {}
}

beforeEach(wipeUserWatchers);
afterEach(wipeUserWatchers);

describe('buildBundleScript', () => {
  it('produces a script with begin/end markers per command', () => {
    const script = buildBundleScript(
      [{ cmd: 'echo hello' }, { cmd: 'systemctl is-active pihole-FTL' }],
      'abc123',
    );
    expect(script).toContain('__OE_SIG_abc123_BEGIN__');
    expect(script).toContain('__OE_SIG_abc123_END__');
    expect(script).toContain('echo hello');
    expect(script).toContain('systemctl is-active pihole-FTL');
    // Subcommands are wrapped in timeout so one slow check can't stall the batch.
    expect(script).toContain('timeout 15s');
  });

  it('escapes embedded single quotes in commands', () => {
    const script = buildBundleScript([{ cmd: "echo 'hi'" }], 'nonce');
    // Must not break the outer single-quoted bash -c argument.
    expect(script).toContain(`'\\''`);
  });
});

describe('parseBundleOutput', () => {
  const nonce = 'deadbeef';
  function block(i, { stdout = '', stderr = '', rc = 0 } = {}) {
    return [
      `__OE_SIG_${nonce}_BEGIN__${i}`,
      stdout,
      `__OE_SIG_${nonce}_BEGIN__${i}:err`,
      stderr,
      `__OE_SIG_${nonce}_BEGIN__${i}:rc`,
      String(rc),
      `__OE_SIG_${nonce}_END__${i}`,
    ].join('\n') + '\n';
  }

  it('splits clean output into per-signal stdout/stderr/exitCode', () => {
    const combined = block(0, { stdout: 'active' }) + block(1, { stdout: 'enabled' });
    const parsed = parseBundleOutput(combined, 2, nonce);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ stdout: 'active', stderr: '', exitCode: 0 });
    expect(parsed[1]).toEqual({ stdout: 'enabled', stderr: '', exitCode: 0 });
  });

  it('captures stderr separately from stdout', () => {
    const combined = block(0, { stdout: 'syntax is ok', stderr: 'warning: unused', rc: 0 });
    const parsed = parseBundleOutput(combined, 1, nonce);
    expect(parsed[0].stdout).toBe('syntax is ok');
    expect(parsed[0].stderr).toBe('warning: unused');
  });

  it('maps exit 124 to a synthetic "timed out" stderr hint', () => {
    const combined = block(0, { stdout: '', stderr: '', rc: 124 });
    const parsed = parseBundleOutput(combined, 1, nonce);
    expect(parsed[0].exitCode).toBe(124);
    expect(parsed[0].stderr).toContain('timed out');
  });

  it('returns null when output contains no markers (caller falls back)', () => {
    const parsed = parseBundleOutput('completely unrelated output', 2, nonce);
    expect(parsed).toBeNull();
  });

  it('marks individual signals null when their block is incomplete', () => {
    // Only signal 0 got its markers; signal 1 was cut off.
    const combined = block(0, { stdout: 'ok' });
    const parsed = parseBundleOutput(combined, 2, nonce);
    expect(parsed[0]).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(parsed[1]).toBeNull();
  });

  it('different nonce → no match → null', () => {
    const combined = block(0, { stdout: 'ok' });
    // Caller used a stale nonce vs. the one we built with.
    const parsed = parseBundleOutput(combined, 1, 'wrongnonce');
    expect(parsed).toBeNull();
  });
});

describe('registerWatcher jitter', () => {
  beforeEach(() => {
    // The supervisor's autopilot is started elsewhere; we only test registration
    // side effects here, which happen synchronously.
    registerSystemWatcherHandler('jitter_test', async () => ({}));
  });

  it('assigns nextTickAt to a deterministic offset within the cadence window', () => {
    const cadenceSec = 60;
    const id = registerWatcher({
      userId: USER,
      agentId: 'a1',
      kind: 'jitter_test',
      cadenceSec,
      expiresAt: Date.now() + 60_000,
      state: { node_id: 'nodeA', service_id: 'svcA' },
    });
    const w = listWatchers(USER).active.find(x => x.id === id);
    const offset = w.nextTickAt - w.createdAt;
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThan(cadenceSec * 1000);
  });

  it('two watchers with different (node, service) keys get different offsets', () => {
    const cadenceSec = 60;
    const ids = [];
    for (const [n, s] of [['nodeA', 'svcA'], ['nodeB', 'svcA'], ['nodeA', 'svcB'], ['nodeC', 'svcC']]) {
      ids.push(registerWatcher({
        userId: USER,
        agentId: 'a1',
        kind: 'jitter_test',
        cadenceSec,
        expiresAt: Date.now() + 60_000,
        state: { node_id: n, service_id: s },
      }));
    }
    const active = listWatchers(USER).active;
    const offsets = ids.map(id => {
      const w = active.find(x => x.id === id);
      return w.nextTickAt - w.createdAt;
    });
    const unique = new Set(offsets);
    // Hash collisions are vanishingly unlikely for 4 distinct keys, so all 4
    // offsets should be distinct.
    expect(unique.size).toBe(4);
  });

  it('same jitter key → same offset across re-registration', () => {
    const cadenceSec = 60;
    const id1 = registerWatcher({
      userId: USER,
      agentId: 'a1',
      kind: 'jitter_test',
      cadenceSec,
      expiresAt: Date.now() + 60_000,
      state: { node_id: 'stable', service_id: 'stable' },
    });
    const w1 = listWatchers(USER).active.find(x => x.id === id1);
    const off1 = w1.nextTickAt - w1.createdAt;
    unregisterWatcher(USER, id1, 'test');
    const id2 = registerWatcher({
      userId: USER,
      agentId: 'a1',
      kind: 'jitter_test',
      cadenceSec,
      expiresAt: Date.now() + 60_000,
      state: { node_id: 'stable', service_id: 'stable' },
    });
    const w2 = listWatchers(USER).active.find(x => x.id === id2);
    const off2 = w2.nextTickAt - w2.createdAt;
    expect(off2).toBe(off1);
  });

  it('non-health watchers (no node_id/service_id) still get a per-record offset', () => {
    // Falls back to hash(record.id) — each new UUID gives a fresh offset.
    const cadenceSec = 60;
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push(registerWatcher({
        userId: USER,
        agentId: 'a1',
        kind: 'jitter_test',
        cadenceSec,
        expiresAt: Date.now() + 60_000,
        state: { whatever: i },
      }));
    }
    const active = listWatchers(USER).active;
    const offsets = ids.map(id => {
      const w = active.find(x => x.id === id);
      return w.nextTickAt - w.createdAt;
    });
    expect(new Set(offsets).size).toBe(4);
  });
});
