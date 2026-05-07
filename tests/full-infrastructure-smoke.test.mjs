/**
 * Full infrastructure smoke test — walks the entire user journey from
 * profile onboarding to incident resolution, going through the public
 * skill tools and the orchestrator the way a real session would.
 *
 * The journey:
 *   1. user runs profile_save (skill) with a researched profile
 *   2. user runs profile_verify_readonly (skill) — readonly ops verified
 *   3. user reviews the rendered Markdown via profile_load(render: true)
 *   4. user runs profile_set_trust_state to "reviewed"
 *   5. user registers health watchers for the profile
 *   6. simulated failure — trigger troubleshooting loop directly (the
 *      watcher would do this on transition; we skip the timer)
 *   7. verify: incident opened, diagnostics ran, failure mode matched,
 *      low-risk fix auto-applied, op record exists, activity rendered
 *   8. user runs incident_list (skill) — sees the resolution
 *   9. snapshot pruner runs — keeps recent snapshot
 *
 * This is the canonical "does it actually work end-to-end" test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import profilesSkill from '../skills/profiles/execute.mjs';
import { runTroubleshootingLoop } from '../lib/troubleshooting-loop.mjs';
import { registerProfileHealthWatchers, unregisterProfileHealthWatchers } from '../scheduler/health-monitor.mjs';
import { renderActivity } from '../lib/activity-render.mjs';
import { readOpRecords, nodeDir } from '../lib/op-record.mjs';
import { listIncidents, loadIncident } from '../lib/incident.mjs';
import { loadProfile, markOperationVerified } from '../lib/service-profile.mjs';
import { listWatchers, unregisterWatcher } from '../scheduler/watchers.mjs';
import { pruneSnapshotsForNode } from '../scheduler/snapshot-pruner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIHOLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pihole-profile.json'), 'utf8'));

const USER = 'user_smoke';
const NODE = 'pihole-prod-sim';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  const w = listWatchers(USER);
  for (const x of [...w.active, ...w.recent]) unregisterWatcher(USER, x.id, 'test-cleanup');
});

function buildSyntheticPihole({ ftlAlive = true, regexError = false } = {}) {
  const blocklist = new Set(['existing.bad.com']);
  let _alive = ftlAlive;
  let _regex = regexError;
  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.searchParams.get('auth') !== 'good') return new Response('{"error":"bad auth"}', { status: 401 });
    if (u.searchParams.has('status')) {
      return new Response(JSON.stringify({ status: _alive ? 'enabled' : 'disabled' }), { status: 200 });
    }
    const list = u.searchParams.get('list');
    const add = u.searchParams.get('add');
    const sub = u.searchParams.get('sub');
    if (list === 'black' && !add && !sub) {
      return new Response(JSON.stringify({ data: [...blocklist] }), { status: 200 });
    }
    if (add) { blocklist.add(add); return new Response('{"ok":true}', { status: 200 }); }
    if (sub) { blocklist.delete(sub); return new Response('{"ok":true}', { status: 200 }); }
    return new Response('bad', { status: 400 });
  };
  const execFn = async (command) => {
    if (command.startsWith('systemctl is-active pihole-FTL')) {
      return { stdout: _alive ? 'active' : 'inactive', stderr: '', exitCode: _alive ? 0 : 3 };
    }
    if (command.startsWith('systemctl status pihole-FTL')) {
      return { stdout: _alive ? 'Active: active (running)' : 'Active: failed (Result: exit-code)', stderr: '', exitCode: _alive ? 0 : 3 };
    }
    if (command.startsWith('tail -n 100 /var/log/pihole/FTL.log')) {
      return { stdout: _regex ? 'FTL: malformed regex added to /etc/pihole/regex.list line 47' : 'FTL: query for example.com', stderr: '', exitCode: 0 };
    }
    if (command.startsWith('ss -tlnp | grep')) {
      return { stdout: 'tcp LISTEN 0.0.0.0:53', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: 'unknown', exitCode: 127 };
  };
  return { fetchFn, execFn, isAlive: () => _alive, fail: () => { _alive = false; _regex = true; }, recover: () => { _alive = true; _regex = false; } };
}

describe('Full infrastructure smoke', () => {
  it('walks the complete journey: onboard → review → monitor → diagnose → fix → audit', async () => {
    const sim = buildSyntheticPihole();

    // Build a profile draft that includes a low-risk auto-fixable op so we can
    // demonstrate the auto-apply path without needing the deferred CLI mechanism.
    const draft = JSON.parse(JSON.stringify(PIHOLE));
    draft.operations.push({
      id: 'pihole_pulse',
      capability: null,
      description: 'Ping API to nudge state — synthetic low-risk fix.',
      mechanism: 'http',
      risk: 'low',
      readonly: false,
      parameters: [],
      http: { write: { method: 'GET', url: '${endpoint}/api.php?status&auth=${auth}' } },
      verified: false, last_tested: null, last_failure: null,
    });
    draft.failure_modes[0].fixes = [
      { op_id: 'pihole_pulse', risk: 'low', applies_when: 'transient' },
      { op_id: 'pihole_restart', risk: 'medium', applies_when: 'persistent' },
    ];

    // ── 1. user saves the profile via the skill ──
    const saveResult = await profilesSkill('profile_save', {
      node_id: NODE, service_id: 'pihole', profile: draft,
    }, USER);
    expect(saveResult).toMatch(/Saved profile "pihole"/);

    // ── 2. user runs verify_readonly via the skill ──
    // (skill resolves auth from token storage; we pass via auth_token)
    const verifyResult = await profilesSkill('profile_verify_readonly', {
      node_id: NODE, service_id: 'pihole', auth_token: 'good',
    }, USER, null, { fetchFn: sim.fetchFn });
    // The skill defaults to globalThis.fetch — for the smoke test we
    // override fetch globally to use the simulator.
    // ↑ Note: profiles skill doesn't currently accept ctx — we'll patch
    //   globalThis.fetch as the cleanest workaround for the smoke test.

    // The skill internally calls dispatchCapabilityCall which uses
    // globalThis.fetch. Override it for this assertion.
    const realFetch = globalThis.fetch;
    globalThis.fetch = sim.fetchFn;
    try {
      const verify2 = await profilesSkill('profile_verify_readonly', {
        node_id: NODE, service_id: 'pihole', auth_token: 'good',
      }, USER);
      expect(verify2).toMatch(/passed: 2/); // status + list_blocked
      expect(verify2).toMatch(/failed: 0/);

      // Confirm verified flags persisted
      const profileNow = loadProfile(USER, NODE, 'pihole');
      expect(profileNow.operations.find(o => o.id === 'status').verified).toBe(true);
      expect(profileNow.operations.find(o => o.id === 'list_blocked').verified).toBe(true);

      // ── 3. user reviews the rendered Markdown ──
      const md = await profilesSkill('profile_load', {
        node_id: NODE, service_id: 'pihole', render: true,
      }, USER);
      expect(md).toContain('# pihole on pihole-prod-sim');
      expect(md).toContain('| `status` | dns | http | low | yes | ✓ |');

      // ── 4. user marks profile as reviewed ──
      const trustResult = await profilesSkill('profile_set_trust_state', {
        node_id: NODE, service_id: 'pihole', state: 'reviewed',
      }, USER);
      expect(trustResult).toMatch(/now \*\*reviewed\*\*/);

      // Mark pihole_pulse verified manually so it's auto-apply eligible
      markOperationVerified(USER, NODE, 'pihole', 'pihole_pulse', true);

      // ── 5. confirm watchers are running (auto-registered by profile_set_trust_state) ──
      const { listWatchers } = await import('../scheduler/watchers.mjs');
      const pihealth = listWatchers(USER).active.filter(
        w => w.kind === 'profile_health' && w.state.service_id === 'pihole'
      );
      expect(pihealth).toHaveLength(1);
      expect(pihealth[0].state.signals).toHaveLength(2);

      // ── 6. simulate a failure: ftl crashed with regex error ──
      sim.fail();

      // Trigger the troubleshooting loop directly (in production the
      // watcher fires this on its tick when state transitions).
      const loopResult = await runTroubleshootingLoop({
        userId: USER, nodeId: NODE, serviceId: 'pihole',
        signal: {
          kind: 'service_up_failed',
          value: 'inactive', expected: 'active',
          fired_at: new Date().toISOString(),
        },
        ctx: { fetchFn: sim.fetchFn, execFn: sim.execFn, auth_override: 'good' },
      });

      // ── 7. verify the loop did everything ──
      expect(loopResult.diagnostics_ran).toBe(3);
      expect(loopResult.matched_mode).toBe('ftl_regex_compile_error');
      expect(loopResult.fix_action).toBe('auto_applied');
      expect(loopResult.fix_outcome).toBe(true);

      const incident = loadIncident(USER, NODE, loopResult.incident_id);
      expect(incident.status).toBe('fix_applied');
      expect(incident.diagnostics_collected).toHaveLength(3);
      expect(incident.fix_attempts).toHaveLength(1);
      expect(incident.fix_attempts[0].outcome).toBe('success');

      // op record persisted in activity.jsonl
      const records = readOpRecords(USER, NODE);
      expect(records.find(r => r.id === loopResult.fix_op_record_id)).toBeTruthy();

      // ── 8. user lists incidents via the skill ──
      const incList = await profilesSkill('incident_list', { node_id: NODE }, USER);
      expect(incList).toContain(loopResult.incident_id);
      expect(incList).toContain('fix_applied');

      // Activity log captures the fix in the human-readable doc
      const activityMd = renderActivity(USER, NODE, { write: false });
      expect(activityMd).toContain('pihole_pulse');
      expect(activityMd).toContain('OK');

      // ── 9. snapshot pruner runs (keeps the recent snapshot) ──
      const pruneStats = pruneSnapshotsForNode(USER, NODE);
      // The auto-applied fix has no pre_capture for this op, so snapshots may be 0;
      // either way nothing should be deleted (it's all recent).
      expect(pruneStats.deleted).toBe(0);

      // ── cleanup: unregister watcher so we don't leak across tests ──
      const removed = unregisterProfileHealthWatchers(USER, NODE, 'pihole');
      expect(removed).toBe(1);

    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('reports honestly when profile is not yet reviewed (no auto-apply)', async () => {
    const sim = buildSyntheticPihole();
    const draft = JSON.parse(JSON.stringify(PIHOLE));
    draft.operations.push({
      id: 'pihole_pulse', capability: null, description: 'pulse',
      mechanism: 'http', risk: 'low', readonly: false,
      parameters: [],
      http: { write: { method: 'GET', url: '${endpoint}/api.php?status&auth=${auth}' } },
      verified: true, last_tested: null, last_failure: null,
    });
    draft.failure_modes[0].fixes = [{ op_id: 'pihole_pulse', risk: 'low' }];
    // NB: leaving trust_state: 'unverified'

    await profilesSkill('profile_save', { node_id: NODE, service_id: 'pihole', profile: draft }, USER);

    const realFetch = globalThis.fetch;
    globalThis.fetch = sim.fetchFn;
    try {
      sim.fail();
      const loopResult = await runTroubleshootingLoop({
        userId: USER, nodeId: NODE, serviceId: 'pihole',
        signal: { kind: 'service_up_failed', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
        ctx: { fetchFn: sim.fetchFn, execFn: sim.execFn, auth_override: 'good' },
      });
      // Unverified profile + low-risk fix → still proposed, not auto-applied.
      expect(loopResult.fix_action).toBe('proposed');
      const inc = loadIncident(USER, NODE, loopResult.incident_id);
      expect(inc.status).toBe('fix_proposed');
      // No fix attempt yet
      expect(inc.fix_attempts).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
