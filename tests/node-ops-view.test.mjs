import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import { saveProfile } from '../lib/service-profile.mjs';
import { openIncident } from '../lib/incident.mjs';
import { buildNodeOpsView } from '../lib/node-ops-view.mjs';
import { registerWatcher, listWatchers, unregisterWatcher } from '../scheduler/watchers.mjs';

const USER = 'user_node_ops_view_test';
const NODE = 'node_ops_test';

function cleanup() {
  try {
    const w = listWatchers(USER);
    for (const x of [...w.active, ...w.recent]) unregisterWatcher(USER, x.id, 'test-cleanup');
  } catch {}
  const dir = path.join(USERS_DIR, USER);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function profile() {
  return {
    schema_version: 1,
    service_id: 'apache2',
    node_id: NODE,
    display_name: 'Apache',
    detected_version: null,
    identity: { what_it_is: 'web server', primary_value: 'apache2' },
    endpoint: '',
    trust_state: 'reviewed',
    control_surface: { api: { auth_method: 'none' }, cli: {}, config_files: [], services: ['apache2'], log_sources: [] },
    operations: [{
      id: 'apache_restart',
      capability: null,
      description: 'Restart Apache',
      mechanism: 'cli',
      risk: 'medium',
      readonly: false,
      parameters: [],
      cli: { write: { command: 'sudo systemctl restart apache2' } },
      verified: false,
    }],
    health_signals: [{
      kind: 'service_up',
      check: { mechanism: 'cli', command: 'systemctl is-active apache2' },
      expect: 'active',
      severity: 'critical',
      cadence_sec: 60,
    }],
    diagnostic_recipes: [],
    failure_modes: [],
    agent_requirements: [],
    backup_before: [],
    research_sources: [],
  };
}

beforeEach(cleanup);
afterAll(cleanup);

describe('buildNodeOpsView', () => {
  it('summarizes reliability, actions, gates, health watchers, incidents, and timeline', () => {
    saveProfile(USER, NODE, profile());
    registerWatcher({
      userId: USER,
      agentId: `${USER}_coordinator`,
      kind: 'profile_health',
      cadenceSec: 60,
      expiresAt: null,
      label: `apache2@${NODE}`,
      state: {
        node_id: NODE,
        service_id: 'apache2',
        signals: [{
          kind: 'service_up',
          check: { mechanism: 'cli', command: 'systemctl is-active apache2' },
          expect: 'active',
          severity: 'critical',
          last_state: 'unhealthy',
          last_checked_at: Date.now(),
          current_incident_id: null,
          last_output: 'inactive',
          last_exit_code: 3,
        }],
      },
    });
    const inc = openIncident(USER, NODE, {
      service_id: 'apache2',
      profile_version: 'test',
      triggering_signal: { kind: 'service_up', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
    });

    const view = buildNodeOpsView(USER, {
      nodeId: NODE,
      hostname: 'web01',
      health: 'healthy',
      version: '1.0.0',
      latestVersion: '1.0.1',
      outdated: true,
    });

    expect(view.reliability.score).toBeLessThan(100);
    expect(view.actionItems.map(a => a.kind)).toEqual(expect.arrayContaining(['outdated', 'incident', 'signal_unhealthy']));
    expect(view.qualityGates.some(g => g.label === 'Open incident')).toBe(true);
    expect(view.watchers).toHaveLength(1);
    expect(view.incidents[0]).toMatchObject({ id: inc.id, service_id: 'apache2' });
    expect(view.incidents[0].timeline.map(t => t.kind)).toContain('opened');
    expect(view.eventLog.length).toBeGreaterThan(0);
  });
});
