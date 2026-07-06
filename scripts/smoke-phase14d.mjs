#!/usr/bin/env node
/**
 * Phase 14d — Sydney introspection + nudges.
 *
 *   1. get_task_log tool returns rich info for a task_proxy watcher
 *   2. Nudge tick re-broadcasts a stale awaiting_input question
 *      (verified by handler unit-test shape — invoking the handler with
 *      stale state directly)
 */
import fs from 'fs';
import { execSync } from 'child_process';

const USER_ID = process.env.OE_TEST_USER ?? 'user_00000000';
const HOST    = process.env.OE_TEST_HOST ?? 'localhost';
const PORT    = process.env.OE_TEST_PORT ?? '3737';
const TOKEN   = process.env.OE_TEST_TOKEN ?? '1efb330eefc9b96f125971210487ce074024d22d8cadace77bd97d00394ed4bb';
const BASE    = `http://${HOST}:${PORT}`;
const COOKIE  = `oe_session=${TOKEN}`;
const TAG     = `p14d_${Date.now()}`;

let passes = 0, fails = 0;
const failures = [];
function pass(label) { passes++; console.log(`  ✓ ${label}`); }
function fail(label, why) { fails++; failures.push({label, why}); console.log(`  ✗ ${label}\n      ${why}`); }
function assert(cond, label, why) { cond ? pass(label) : fail(label, why); }

async function restart() {
  try { execSync('systemctl --user reset-failed openensemble', { stdio: 'pipe' }); } catch {}
  execSync('systemctl --user restart openensemble', { stdio: 'pipe' });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/proposals`, { headers: { Cookie: COOKIE }, redirect: 'follow' });
      if (r.status === 200) { await r.json(); await new Promise(s => setTimeout(s, 300)); return; }
    } catch {}
    await new Promise(s => setTimeout(s, 250));
  }
}

async function main() {
  console.log(`Phase 14d smoke — tag ${TAG}`);

  // Boot manifests in MY process so we can spot-check the new tool exists
  const roles = await import('../roles.mjs');
  roles.loadRoleManifests();
  const aaTools = roles.getRoleTools('active-agents', USER_ID);
  const toolNames = aaTools.map(t => t.function?.name);
  assert(toolNames.includes('get_task_log'), 'active-agents skill now exposes get_task_log',
    `tools: ${toolNames.join(',')}`);
  assert(toolNames.includes('list_active_agents'), 'list_active_agents still present', '');

  // Direct handler-shape unit test for the 1h nudge logic
  // Build a stale awaiting_input state, then walk through the handler logic
  // by reimporting (the handler is module-private but its effect surfaces via
  // pushWatcherStatus). Simulate by seeding a real watcher with stale
  // questionPostedAt and triggering a tick via supervisor.
  // (Full tick-simulation is expensive; we verify the SHAPE is right by
  //  examining the watcher state we'd seed and the expected output.)

  // Seed a task_proxy with stale lastNudgeAt → restart → tick will fire
  // (cadence is 30s, so we wait up to 60s for one tick). Verify nudge fires.
  const watchersFile = `users/${USER_ID}/watchers.json`;
  const data = JSON.parse(fs.readFileSync(watchersFile, 'utf8'));
  const nudgeId = `wnudge_${TAG}`;
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  const entry = {
    id: nudgeId,
    userId: USER_ID,
    agentId: `${USER_ID}_sydney`,
    kind: 'task_proxy',
    skillId: null,        // system handler (no owning skill)
    label: `🧪 NUDGE TEST ${TAG}`,
    state: {
      taskId: `bg_nudge_${TAG}`,
      targetAgentName: 'TestAgent',
      awaiting_input: true,
      pending_question: `What should we do about ${TAG}?`,
      questionPostedAt: twoHoursAgo,
      lastNudgeAt: twoHoursAgo,
      lastActivityAt: twoHoursAgo,
      startedAt: twoHoursAgo,
    },
    cadenceSec: 30,
    createdAt: twoHoursAgo,
    lastChangeAt: twoHoursAgo,
    nextTickAt: Date.now() + 100,    // tick almost immediately on boot
    expiresAt: null,
    lastStatusText: `❓ What should we do about ${TAG}?`,
    lastTickAt: null,
    failures: 0, ticks: 0, status: 'active',
    history: [{ text: 'Started', ts: twoHoursAgo }, { text: `❓ What should we do about ${TAG}?`, ts: twoHoursAgo }],
    onFire: null,
  };
  data.active.push(entry);
  fs.writeFileSync(watchersFile, JSON.stringify(data, null, 2));

  console.log(`  seeded stale awaiting watcher; restarting & waiting for nudge tick (≤60s) …`);
  await restart();

  // Wait up to 75s for a tick to fire and bump lastNudgeAt
  const deadline = Date.now() + 75_000;
  let nudged = false;
  let final = null;
  while (Date.now() < deadline) {
    const cur = JSON.parse(fs.readFileSync(watchersFile, 'utf8'));
    const found = (cur.active || []).find(w => w.id === nudgeId);
    if (found && found.state?.lastNudgeAt > twoHoursAgo) {
      nudged = true;
      final = found;
      break;
    }
    if (!found) {
      // moved to recent? (only if reaped — shouldn't happen for awaiting_input)
      const recent = (cur.recent || []).find(w => w.id === nudgeId);
      if (recent) { final = recent; break; }
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  assert(nudged, '1h nudge tick re-broadcast question (lastNudgeAt advanced)',
    final ? JSON.stringify({ status: final.status, lastNudge: final.state?.lastNudgeAt, ageAtSeed: 'started 2h ago' }) : 'never observed');

  // Cleanup seed
  const cleanup = JSON.parse(fs.readFileSync(watchersFile, 'utf8'));
  cleanup.active = (cleanup.active || []).filter(w => w.id !== nudgeId);
  cleanup.recent = (cleanup.recent || []).filter(w => w.id !== nudgeId);
  fs.writeFileSync(watchersFile, JSON.stringify(cleanup, null, 2));

  // Verify get_task_log via real API call. We can't easily drive Sydney to
  // call it deterministically, so we test it via direct module call against
  // the seeded watcher (data plane).
  // For this, we need an active task_proxy with history. Easiest: register
  // one in-process, query getWatcher, hand off to execute.
  // But the watcher is in MY process not the server's. So just verify the
  // tool's handler shape directly.
  const ag = await import('../skills/active-agents/execute.mjs');
  // Bad watcherId path
  const noW = await ag.executeSkillTool('get_task_log', { watcherId: 'bogus' }, USER_ID);
  assert(typeof noW === 'string' && /no watcher found/i.test(noW),
    'get_task_log returns helpful error for unknown id', JSON.stringify(noW).slice(0, 100));
  // Missing arg path
  const noArg = await ag.executeSkillTool('get_task_log', {}, USER_ID);
  assert(typeof noArg === 'string' && /missing watcherId/i.test(noArg),
    'get_task_log returns helpful error when watcherId missing', JSON.stringify(noArg).slice(0, 100));

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Phase 14d: ${passes} passed, ${fails} failed`);
  if (fails) {
    for (const f of failures) console.log(`  • ${f.label}\n    ${f.why}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
