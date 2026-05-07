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

  it('creates one watcher per health_signal', () => {
    const result = registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'test-agent' });
    expect(result.registered).toBe(2); // pihole fixture has 2 health_signals
    expect(result.watchers.map(w => w.signal_kind).sort()).toEqual(['blocking_enabled', 'service_up']);
  });

  it('persists watcher state with correct shape', () => {
    registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'test-agent' });
    const watchers = listWatchers(USER);
    const profileWatchers = watchers.active.filter(w => w.kind === 'profile_health');
    expect(profileWatchers).toHaveLength(2);
    for (const w of profileWatchers) {
      expect(w.state.node_id).toBe(NODE);
      expect(w.state.service_id).toBe('pihole');
      expect(w.state.last_state).toBe('unknown');
      expect(w.state.current_incident_id).toBeNull();
      expect(w.expiresAt).toBeNull(); // health watchers are indefinite
    }
  });

  it('throws cleanly when profile does not exist', () => {
    expect(() => registerProfileHealthWatchers(USER, NODE, 'nonexistent'))
      .toThrow(/no profile/);
  });
});

describe('unregisterProfileHealthWatchers', () => {
  beforeEach(() => { saveProfile(USER, NODE, fresh()); });

  it('removes only the matching service_id watchers', () => {
    // Save a second profile + register both
    const second = fresh();
    second.service_id = 'home_assistant';
    second.endpoint = 'http://192.168.1.20:8123';
    saveProfile(USER, NODE, second);
    registerProfileHealthWatchers(USER, NODE, 'pihole', { agentId: 'a' });
    registerProfileHealthWatchers(USER, NODE, 'home_assistant', { agentId: 'a' });
    expect(listWatchers(USER).active.filter(w => w.kind === 'profile_health')).toHaveLength(4);

    const removed = unregisterProfileHealthWatchers(USER, NODE, 'pihole');
    expect(removed).toBe(2);
    const left = listWatchers(USER).active.filter(w => w.kind === 'profile_health');
    expect(left).toHaveLength(2);
    expect(left.every(w => w.state.service_id === 'home_assistant')).toBe(true);
  });

  it('returns 0 when nothing matches', () => {
    const removed = unregisterProfileHealthWatchers(USER, NODE, 'never-registered');
    expect(removed).toBe(0);
  });
});
