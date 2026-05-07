/**
 * End-to-end integration test for the troubleshooting pipeline.
 *
 * Walks: profile saved → incident opened → diagnostic recipe ran →
 *        failure mode matched → fix proposed/auto-applied → activity logged.
 *
 * Uses a synthetic in-memory Pi-hole (mock fetch + mock exec) so this is
 * hermetic — no real network or shell.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { saveProfile, loadProfile, setTrustState, markOperationVerified } from '../lib/service-profile.mjs';
import { openIncident, loadIncident, listIncidents } from '../lib/incident.mjs';
import { runDiagnosticRecipe } from '../lib/diagnostic-runner.mjs';
import { matchFailureModeHeuristic } from '../lib/failure-matcher.mjs';
import { proposeFix, applyProposedFix } from '../lib/fix-proposer.mjs';
import { runTroubleshootingLoop } from '../lib/troubleshooting-loop.mjs';
import { readOpRecords, nodeDir } from '../lib/op-record.mjs';
import { renderActivity } from '../lib/activity-render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIHOLE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pihole-profile.json'), 'utf8'));

const USER = 'user_pipeline';
const NODE = 'pihole-test';

beforeEach(() => {
  const dir = nodeDir(USER, NODE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

const fresh = () => JSON.parse(JSON.stringify(PIHOLE));

// ── synthetic Pi-hole world (HTTP API + simulated shell) ──────────────────────

function buildSyntheticPihole({ ftlAlive = true, regexError = false } = {}) {
  const blocklist = new Set(['existing.bad.com']);

  const fetchFn = async (url) => {
    const u = new URL(url);
    if (u.searchParams.get('auth') !== 'good') return new Response('{"error":"bad auth"}', { status: 401 });
    if (u.searchParams.has('status')) {
      return new Response(JSON.stringify({ status: ftlAlive ? 'enabled' : 'disabled' }), { status: 200 });
    }
    const list = u.searchParams.get('list');
    const add = u.searchParams.get('add');
    const sub = u.searchParams.get('sub');
    if (list === 'black' && !add && !sub) {
      return new Response(JSON.stringify({ data: [...blocklist] }), { status: 200 });
    }
    if (add) { blocklist.add(add); return new Response('{"added":"'+add+'"}', { status: 200 }); }
    if (sub) { blocklist.delete(sub); return new Response('{"removed":"'+sub+'"}', { status: 200 }); }
    return new Response('bad', { status: 400 });
  };

  // Simulated shell: known commands return canned output. The "regex error"
  // mode injects a phrase that the failure_modes heuristic should match on.
  const execFn = async (command) => {
    if (command.startsWith('systemctl is-active pihole-FTL')) {
      return { stdout: ftlAlive ? 'active' : 'inactive', stderr: '', exitCode: ftlAlive ? 0 : 3 };
    }
    if (command.startsWith('systemctl status pihole-FTL')) {
      return {
        stdout: ftlAlive
          ? 'pihole-FTL.service - Active: active (running)'
          : 'pihole-FTL.service - Active: failed (Result: exit-code)',
        stderr: '',
        exitCode: ftlAlive ? 0 : 3,
      };
    }
    if (command.startsWith('tail -n 100 /var/log/pihole/FTL.log')) {
      return {
        stdout: regexError
          ? 'FTL: malformed regex added to /etc/pihole/regex.list line 47\nFTL: aborting startup'
          : 'FTL: query for example.com from 192.168.1.50',
        stderr: '', exitCode: 0,
      };
    }
    if (command.startsWith('ss -tlnp | grep')) {
      return { stdout: 'tcp LISTEN 0.0.0.0:53', stderr: '', exitCode: 0 };
    }
    if (command.startsWith('pihole restartdns')) {
      ftlAlive = true; regexError = false; // simulate fix
      return { stdout: 'DNS service restarted', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: `unknown command: ${command}`, exitCode: 127 };
  };

  return {
    blocklist,
    fetchFn,
    execFn,
    setFtlState: (alive, regex = false) => { ftlAlive = alive; regexError = regex; },
    isFtlAlive: () => ftlAlive,
  };
}

// ── unit: diagnostic-runner ───────────────────────────────────────────────────

describe('runDiagnosticRecipe', () => {
  it('runs all CLI steps and attaches output to the incident', async () => {
    saveProfile(USER, NODE, fresh());
    const sim = buildSyntheticPihole({ ftlAlive: false, regexError: true });
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'service_up_failed', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
    });
    const profile = loadProfile(USER, NODE, 'pihole');

    const result = await runDiagnosticRecipe({
      userId: USER, nodeId: NODE, incidentId: inc.id, profile,
      recipeKey: 'service_up_failed',
      ctx: { execFn: sim.execFn, auth_override: 'good' },
    });

    expect(result.ran).toBe(3);
    const updated = loadIncident(USER, NODE, inc.id);
    expect(updated.diagnostics_collected).toHaveLength(3);
    expect(updated.status).toBe('investigating');
  });

  it('returns reason when recipe key missing', async () => {
    saveProfile(USER, NODE, fresh());
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'never_heard_of_this', value: 'x', expected: 'y', fired_at: new Date().toISOString() },
    });
    const profile = loadProfile(USER, NODE, 'pihole');
    const result = await runDiagnosticRecipe({
      userId: USER, nodeId: NODE, incidentId: inc.id, profile,
      recipeKey: 'never_heard_of_this',
      ctx: {},
    });
    expect(result.ran).toBe(0);
    expect(result.reason).toMatch(/no diagnostic recipe/);
  });

  it('records errors from CLI steps as incident diagnostics, does not throw', async () => {
    saveProfile(USER, NODE, fresh());
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'service_up_failed', value: 'x', expected: 'y', fired_at: new Date().toISOString() },
    });
    const profile = loadProfile(USER, NODE, 'pihole');
    // execFn throws on every command
    const result = await runDiagnosticRecipe({
      userId: USER, nodeId: NODE, incidentId: inc.id, profile,
      recipeKey: 'service_up_failed',
      ctx: { execFn: async () => { throw new Error('node unreachable'); } },
    });
    expect(result.ran).toBe(3);
    expect(result.results.every(r => r.error)).toBe(true);
    const updated = loadIncident(USER, NODE, inc.id);
    expect(updated.diagnostics_collected[0].output_excerpt).toMatch(/\[error\]/);
  });
});

// ── unit: failure-matcher ─────────────────────────────────────────────────────

describe('matchFailureModeHeuristic', () => {
  it('matches on a likely_causes substring with score 1.0', () => {
    const profile = fresh();
    const diagnostics = [{ output_excerpt: 'FTL: malformed regex added to /etc/pihole/regex.list line 47' }];
    const matched = matchFailureModeHeuristic(profile, diagnostics);
    expect(matched).not.toBeNull();
    expect(matched.mode.id).toBe('ftl_regex_compile_error');
    expect(matched.score).toBe(1.0);
    expect(matched.matched_cause).toMatch(/regex/i);
  });

  it('falls back to symptom match with score 0.5', () => {
    const profile = fresh();
    const diagnostics = [{ output_excerpt: 'pihole-FTL fails to start with regex compile error in custom blocklist' }];
    const matched = matchFailureModeHeuristic(profile, diagnostics);
    expect(matched.score).toBeGreaterThanOrEqual(0.5);
  });

  it('returns null when nothing matches', () => {
    const profile = fresh();
    const diagnostics = [{ output_excerpt: 'totally unrelated output' }];
    expect(matchFailureModeHeuristic(profile, diagnostics)).toBeNull();
  });

  it('returns null with no diagnostics', () => {
    expect(matchFailureModeHeuristic(fresh(), [])).toBeNull();
    expect(matchFailureModeHeuristic(fresh(), null)).toBeNull();
  });
});

// ── unit: fix-proposer ────────────────────────────────────────────────────────

describe('proposeFix', () => {
  it('proposes (does not auto-apply) when profile is unverified', async () => {
    saveProfile(USER, NODE, fresh()); // trust_state: unverified
    markOperationVerified(USER, NODE, 'pihole', 'pihole_restart', true);
    const profile = loadProfile(USER, NODE, 'pihole');
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'service_up_failed', value: 'x', expected: 'y', fired_at: new Date().toISOString() },
    });
    const matched = { mode: profile.failure_modes[0], score: 1.0 };
    const result = await proposeFix({
      userId: USER, nodeId: NODE, incidentId: inc.id, profile, matchedMode: matched, ctx: {},
    });
    expect(result.action).toBe('proposed');
    const updated = loadIncident(USER, NODE, inc.id);
    expect(updated.status).toBe('fix_proposed');
    expect(updated.events.find(e => e.type === 'fix_proposed')).toBeTruthy();
  });

  it('does not auto-apply medium-risk fixes even on reviewed profiles', async () => {
    saveProfile(USER, NODE, fresh());
    setTrustState(USER, NODE, 'pihole', 'reviewed');
    markOperationVerified(USER, NODE, 'pihole', 'pihole_restart', true);
    const profile = loadProfile(USER, NODE, 'pihole');
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'service_up_failed', value: 'x', expected: 'y', fired_at: new Date().toISOString() },
    });
    const matched = { mode: profile.failure_modes[0], score: 1.0 };
    // pihole_restart is risk=medium; should not auto-apply
    const result = await proposeFix({
      userId: USER, nodeId: NODE, incidentId: inc.id, profile, matchedMode: matched, ctx: {},
    });
    expect(result.action).toBe('proposed');
  });

  it('returns no_op_for_fix when fix references missing operation', async () => {
    saveProfile(USER, NODE, fresh());
    const profile = loadProfile(USER, NODE, 'pihole');
    const inc = openIncident(USER, NODE, {
      service_id: 'pihole',
      triggering_signal: { kind: 'service_up_failed', value: 'x', expected: 'y', fired_at: new Date().toISOString() },
    });
    const matched = {
      mode: { id: 'fake', symptom: 'fake', fixes: [{ op_id: 'no_such_op', risk: 'low' }] },
      score: 1.0,
    };
    const result = await proposeFix({
      userId: USER, nodeId: NODE, incidentId: inc.id, profile, matchedMode: matched, ctx: {},
    });
    expect(result.action).toBe('no_op_for_fix');
  });
});

// ── integration: full troubleshooting loop ────────────────────────────────────

describe('runTroubleshootingLoop (end-to-end)', () => {
  it('opens incident → runs diagnostics → matches failure mode → proposes fix', async () => {
    saveProfile(USER, NODE, fresh());
    setTrustState(USER, NODE, 'pihole', 'reviewed');
    markOperationVerified(USER, NODE, 'pihole', 'pihole_restart', true);

    const sim = buildSyntheticPihole({ ftlAlive: false, regexError: true });

    const result = await runTroubleshootingLoop({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      signal: { kind: 'service_up_failed', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
      ctx: { fetchFn: sim.fetchFn, execFn: sim.execFn, auth_override: 'good' },
    });

    expect(result.profile_loaded).toBe(true);
    expect(result.diagnostics_ran).toBe(3);
    expect(result.matched_mode).toBe('ftl_regex_compile_error');
    expect(result.fix_action).toBe('proposed'); // medium risk → not auto

    const inc = loadIncident(USER, NODE, result.incident_id);
    expect(inc.status).toBe('fix_proposed');
    expect(inc.diagnostics_collected).toHaveLength(3);
    expect(inc.events.find(e => e.type === 'failure_mode_matched')).toBeTruthy();
    expect(inc.events.find(e => e.type === 'fix_proposed')).toBeTruthy();
  });

  it('applyProposedFix completes the cycle and writes an op record', async () => {
    saveProfile(USER, NODE, fresh());
    setTrustState(USER, NODE, 'pihole', 'reviewed');
    markOperationVerified(USER, NODE, 'pihole', 'pihole_restart', true);

    const sim = buildSyntheticPihole({ ftlAlive: false, regexError: true });
    const profile = loadProfile(USER, NODE, 'pihole');

    // Run the loop to get a fix proposal.
    const loopResult = await runTroubleshootingLoop({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      signal: { kind: 'service_up_failed', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
      ctx: { fetchFn: sim.fetchFn, execFn: sim.execFn, auth_override: 'good' },
    });
    expect(loopResult.fix_action).toBe('proposed');

    // pihole_restart is mechanism=cli — apply via the CLI mechanism through
    // the synthetic execFn. Verify the fix runs end-to-end and is recorded
    // in the activity log + as a fix attempt on the incident.
    const profileNow = loadProfile(USER, NODE, 'pihole');
    const applyResult = await applyProposedFix({
      userId: USER, nodeId: NODE, incidentId: loopResult.incident_id, profile: profileNow,
      fix: { op_id: 'pihole_restart' },
      ctx: { execFn: sim.execFn, auth_override: 'good' },
      confirmedBy: 'shawn',
    });
    expect(applyResult.applied).toBe(true);
    expect(applyResult.success).toBe(true);
    expect(sim.isFtlAlive()).toBe(true); // mock shell flips ftlAlive on restartdns
  });

  it('reports cleanly when no profile exists for the service', async () => {
    const result = await runTroubleshootingLoop({
      userId: USER, nodeId: NODE, serviceId: 'home_assistant',
      signal: { kind: 'service_up', value: 'x', expected: 'y', fired_at: new Date().toISOString() },
      ctx: {},
    });
    expect(result.profile_loaded).toBe(false);
    expect(result.summary).toMatch(/no profile/);
  });

  it('joins an existing open incident instead of creating duplicates', async () => {
    saveProfile(USER, NODE, fresh());
    const sim = buildSyntheticPihole({ ftlAlive: false, regexError: true });

    const a = await runTroubleshootingLoop({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      signal: { kind: 'service_up_failed', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
      ctx: { fetchFn: sim.fetchFn, execFn: sim.execFn, auth_override: 'good' },
    });
    const b = await runTroubleshootingLoop({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      signal: { kind: 'service_up_failed', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
      ctx: { fetchFn: sim.fetchFn, execFn: sim.execFn, auth_override: 'good' },
    });
    expect(b.incident_id).toBe(a.incident_id);
    expect(listIncidents(USER, NODE)).toHaveLength(1);
  });

  it('auto-applies a low-risk fix when profile is reviewed and op is verified', async () => {
    // Construct a profile variant where the only fix is risk=low and references
    // an http operation (so capability dispatch actually works).
    const variant = fresh();
    // Add a low-risk synthetic "fix" op that uses http (simulating "ping API to nudge")
    variant.operations.push({
      id: 'pihole_pulse',
      capability: null,
      description: 'Ping the API to nudge things — synthetic low-risk fix.',
      mechanism: 'http',
      risk: 'low',
      readonly: false,
      parameters: [],
      http: {
        write: { method: 'GET', url: '${endpoint}/api.php?status&auth=${auth}' },
      },
      verified: false, last_tested: null, last_failure: null,
    });
    variant.failure_modes[0].fixes = [{ op_id: 'pihole_pulse', risk: 'low', applies_when: 'transient' }];
    saveProfile(USER, NODE, variant);
    setTrustState(USER, NODE, 'pihole', 'reviewed');
    markOperationVerified(USER, NODE, 'pihole', 'pihole_pulse', true);

    const sim = buildSyntheticPihole({ ftlAlive: false, regexError: true });
    const result = await runTroubleshootingLoop({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      signal: { kind: 'service_up_failed', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
      ctx: { fetchFn: sim.fetchFn, execFn: sim.execFn, auth_override: 'good' },
    });

    expect(result.fix_action).toBe('auto_applied');
    expect(result.fix_outcome).toBe(true);

    // op record should exist in activity.jsonl
    const records = readOpRecords(USER, NODE);
    expect(records.find(r => r.id === result.fix_op_record_id)).toBeTruthy();

    const inc = loadIncident(USER, NODE, result.incident_id);
    expect(inc.fix_attempts).toHaveLength(1);
    expect(inc.fix_attempts[0].outcome).toBe('success');
    expect(inc.status).toBe('fix_applied');
  });
});

// ── activity log integration ──────────────────────────────────────────────────

describe('activity log integration', () => {
  it('captures auto-applied fixes in the rendered ACTIVITY.md', async () => {
    const variant = fresh();
    variant.operations.push({
      id: 'pihole_pulse', mechanism: 'http', risk: 'low', readonly: false,
      capability: null, description: 'pulse',
      parameters: [],
      http: { write: { method: 'GET', url: '${endpoint}/api.php?status&auth=${auth}' } },
      verified: false, last_tested: null, last_failure: null,
    });
    variant.failure_modes[0].fixes = [{ op_id: 'pihole_pulse', risk: 'low' }];
    saveProfile(USER, NODE, variant);
    setTrustState(USER, NODE, 'pihole', 'reviewed');
    markOperationVerified(USER, NODE, 'pihole', 'pihole_pulse', true);

    const sim = buildSyntheticPihole({ ftlAlive: false, regexError: true });
    await runTroubleshootingLoop({
      userId: USER, nodeId: NODE, serviceId: 'pihole',
      signal: { kind: 'service_up_failed', value: 'inactive', expected: 'active', fired_at: new Date().toISOString() },
      ctx: { fetchFn: sim.fetchFn, execFn: sim.execFn, auth_override: 'good' },
    });

    const md = renderActivity(USER, NODE, { write: false });
    expect(md).toContain('pihole_pulse');
    expect(md).toContain('OK');
  });
});
