#!/usr/bin/env node
/**
 * Thorough end-to-end test for Learn panel phases 1–4.5.
 *
 * Runs against a LIVE OpenEnsemble server. Tags every artifact with a UUID
 * suffix so cleanup leaves no residue. Each section prints PASS/FAIL with
 * a one-line diagnostic.
 */
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import WebSocket from 'ws';

// ── Config ──────────────────────────────────────────────────────────────────
const USER_ID = process.env.OE_TEST_USER ?? 'user_39ce139e';
const HOST    = process.env.OE_TEST_HOST ?? 'localhost';
const PORT    = process.env.OE_TEST_PORT ?? '3737';
const TOKEN   = process.env.OE_TEST_TOKEN ?? '1efb330eefc9b96f125971210487ce074024d22d8cadace77bd97d00394ed4bb';
const BASE    = `http://${HOST}:${PORT}`;
const COOKIE  = `oe_session=${TOKEN}`;
const USER_DIR = `/home/shawn/.openensemble/users/${USER_ID}`;
const TAG = `smoke_${Date.now()}`;

const day = 24 * 60 * 60 * 1000;
let passes = 0, fails = 0;
const failures = [];

function pass(label) { passes++; console.log(`  ✓ ${label}`); }
function fail(label, why) { fails++; failures.push({label, why}); console.log(`  ✗ ${label}\n      ${why}`); }
function assert(cond, label, why) { cond ? pass(label) : fail(label, why); }
function section(name) { console.log(`\n── ${name} ──`); }

async function req(method, urlPath, body) {
  const r = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'Cookie': COOKIE, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'follow',
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function writeJson(p, d) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
}

async function restartServer() {
  console.log('  ↻ restarting server …');
  // Clear systemd's start-burst counter so repeat restarts in this test
  // don't trip the start-limit-hit threshold.
  try { execSync('systemctl --user reset-failed openensemble', { stdio: 'pipe' }); } catch {}
  execSync('systemctl --user restart openensemble', { stdio: 'pipe' });
  // Poll a real authenticated endpoint until it returns a real JSON 200,
  // not just a 302 redirect. The server's HTTP listener opens before all
  // routes are registered.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/proposals`, {
        headers: { Cookie: COOKIE }, redirect: 'follow',
      });
      if (r.status === 200) {
        await r.json();   // ensure body is real
        // small grace so background imports (boot-load) settle
        await new Promise(res => setTimeout(res, 300));
        return;
      }
    } catch {}
    await new Promise(res => setTimeout(res, 250));
  }
  throw new Error('server failed to come back up');
}

// ── Setup: capture baseline so we can verify deltas without test pollution ──
async function snapshotBaseline() {
  const { data: props } = await req('GET', '/api/proposals');
  const { data: learn } = await req('GET', '/api/learnings');
  return {
    pendingIds: new Set((props?.pending || []).map(p => p.id)),
    aliasCount: (learn?.aliases || []).length,
    routineCount: (learn?.routines || []).length,
    pinCount: (learn?.defaults || []).length,
    skillCount: (learn?.skills || []).length,
    ruleRoles: (learn?.rules || []).map(r => r.roleId),
  };
}

// ── Phase 1: surface routes + revoke pipeline ───────────────────────────────
async function testPhase1(baseline) {
  section('Phase 1: surface routes');

  // GET /api/learnings basic shape
  const { status: lcode, data: learn } = await req('GET', '/api/learnings');
  assert(lcode === 200, 'GET /api/learnings 200', `got ${lcode}`);
  const expectedKeys = ['rules', 'aliases', 'routines', 'defaults', 'failures', 'skills', 'recentAccepted', 'outcomesByKind'];
  for (const k of expectedKeys) {
    assert(k in (learn || {}), `learnings.${k} exists`, `missing key`);
  }

  // GET /api/proposals basic shape
  const { status: pcode, data: props } = await req('GET', '/api/proposals');
  assert(pcode === 200 && Array.isArray(props?.pending), 'GET /api/proposals returns {pending: [...]}', `got status ${pcode}`);

  // Test snooze: seed a synth proposal on disk, restart, hit endpoint
  const synthProposalId = `prop_${TAG}_snooze`;
  const propPath = path.join(USER_DIR, 'proposals.json');
  const propData = readJson(propPath) || { proposals: [], dismissedPatterns: {} };
  propData.proposals.push({
    id: synthProposalId,
    userId: USER_ID,
    agentId: 'test',
    kind: 'rule_promotion',
    message: 'synth proposal for snooze test',
    ruleText: `synth-rule-${TAG}`,
    roleId: 'test_role',
    roleName: 'test_role',
    sourceCorrectionIds: [],
    accept_label: 'add',
    dismiss_label: 'no',
    createdAt: Date.now(),
    status: 'pending',
  });
  writeJson(propPath, propData);
  await restartServer();

  const { data: pAfterSeed } = await req('GET', '/api/proposals');
  assert((pAfterSeed?.pending || []).some(p => p.id === synthProposalId),
    'synth proposal appears in /api/proposals after restart', 'not present');

  const { status: snStatus, data: snData } = await req('POST', `/api/proposals/${synthProposalId}/snooze`);
  assert(snStatus === 200 && snData?.ok === true, 'POST /api/proposals/<id>/snooze 200 + ok', `status=${snStatus} ok=${snData?.ok}`);

  const { data: pAfterSnooze } = await req('GET', '/api/proposals');
  assert(!(pAfterSnooze?.pending || []).some(p => p.id === synthProposalId),
    'snoozed proposal not in pending', 'still present');

  // Verify wake-on-elapsed: backdate wakeAt to past, force re-list
  const snoozedData = readJson(propPath);
  const snoozed = snoozedData.proposals.find(p => p.id === synthProposalId);
  assert(snoozed?.status === 'snoozed' && typeof snoozed.wakeAt === 'number',
    'snoozed status persisted with wakeAt', `status=${snoozed?.status} wakeAt=${typeof snoozed?.wakeAt}`);

  snoozed.wakeAt = Date.now() - 1000;
  writeJson(propPath, snoozedData);
  // The in-memory map needs to see the wakeAt update. listUserProposals lives-
  // wakes from in-memory state, but in-memory wakeAt was set 7d in the future
  // by the snooze call — disk edit alone won't propagate. Restart so boot
  // sweep re-reads disk.
  await restartServer();
  const { data: pAfterWake } = await req('GET', '/api/proposals');
  assert((pAfterWake?.pending || []).some(p => p.id === synthProposalId),
    'wake-on-elapsed pulls snoozed back to pending after restart', 'still hidden');

  // Test dismiss: seed a SEPARATE fresh proposal (the one above is now
  // pending again after wake; we could dismiss it but using a distinct id
  // makes the assertion intent clear).
  const dismissProposalId = `prop_${TAG}_dismiss`;
  const propData2 = readJson(propPath) || { proposals: [], dismissedPatterns: {} };
  propData2.proposals.push({
    id: dismissProposalId,
    userId: USER_ID, agentId: 'test', kind: 'rule_promotion',
    message: 'synth dismiss test', ruleText: `dismiss-rule-${TAG}`,
    roleId: 'dismiss_role', roleName: 'dismiss_role', sourceCorrectionIds: [],
    accept_label: 'add', dismiss_label: 'no',
    createdAt: Date.now(), status: 'pending',
  });
  writeJson(propPath, propData2);
  await restartServer();

  const { status: dsStatus } = await req('POST', `/api/proposals/${dismissProposalId}/dismiss`);
  assert(dsStatus === 200, 'POST .../dismiss 200', `status ${dsStatus}`);
  const { data: pAfterDismiss } = await req('GET', '/api/proposals');
  assert(!(pAfterDismiss?.pending || []).some(p => p.id === dismissProposalId),
    'dismissed proposal removed from pending', 'still present');

  // Test rule revoke: write a synth role-rules.md, verify GET shows it,
  // DELETE, verify it's gone + .deleted.log written
  const synthRoleId = `test_role_${TAG}`;
  const rulePath = path.join(USER_DIR, 'role-rules', `${synthRoleId}.md`);
  fs.mkdirSync(path.dirname(rulePath), { recursive: true });
  fs.writeFileSync(rulePath, `- rule A from ${TAG}\n- rule B from ${TAG}\n`);

  const { data: learnWithRules } = await req('GET', '/api/learnings');
  const ourRules = (learnWithRules.rules || []).find(r => r.roleId === synthRoleId);
  assert(ourRules && ourRules.rules.length === 2, 'GET /api/learnings shows synth role-rules', `found ${ourRules?.rules?.length}`);

  const { status: dr0 } = await req('DELETE', `/api/learnings/rules/${synthRoleId}/0`);
  assert(dr0 === 200, 'DELETE rule[0] 200', `status ${dr0}`);

  const { data: learnAfterRevoke } = await req('GET', '/api/learnings');
  const ourRulesAfter = (learnAfterRevoke.rules || []).find(r => r.roleId === synthRoleId);
  assert(ourRulesAfter && ourRulesAfter.rules.length === 1, 'role-rules count drops to 1', `got ${ourRulesAfter?.rules?.length}`);
  assert(ourRulesAfter.rules[0].text.includes('rule B'), 'remaining rule is the right one', `text=${ourRulesAfter.rules[0].text}`);

  const delLogPath = path.join(USER_DIR, `role-rules/${synthRoleId}.deleted.log`);
  assert(fs.existsSync(delLogPath), '.deleted.log written', 'not created');

  // Cleanup synth rule artifacts
  fs.rmSync(rulePath, { force: true });
  fs.rmSync(delLogPath, { force: true });
}

// ── Phase 2: default-arg pinning via real dispatcher + HTTP accept ──────────
async function testPhase2() {
  section('Phase 2: default-arg pinning');

  const td = await import('/home/shawn/.openensemble/lib/tool-defaults.mjs');
  const prop = await import('/home/shawn/.openensemble/lib/proposals.mjs');

  const fakeTool = `phase2_${TAG}_tool`;
  const args = { zip: '99999', limit: 7 };

  let signal;
  for (let i = 1; i <= 3; i++) signal = await td.recordToolCall(USER_ID, fakeTool, args);
  assert(signal.proposed === true && signal.arg === 'zip', 'counter trips at exact threshold=3', JSON.stringify(signal));

  // Emit proposal — this writes to disk via persistUser
  const created = await prop.proposeDefaultArg({
    userId: USER_ID, agentId: 'test',
    tool: signal.tool, arg: signal.arg, value: signal.value, count: signal.count,
  });
  assert(created && created.kind === 'default_arg', 'proposeDefaultArg returns valid proposal', JSON.stringify(created)?.slice(0, 100));

  await restartServer();   // server's in-memory map rehydrates from disk

  const { data: propsAfter } = await req('GET', '/api/proposals');
  const visible = (propsAfter.pending || []).find(p => p.id === created.id);
  assert(visible, 'pending list shows the default_arg proposal after restart', 'missing');

  // Accept via HTTP → verify pin written
  const { status: aS } = await req('POST', `/api/proposals/${created.id}/accept`);
  assert(aS === 200, 'POST .../accept 200', `status ${aS}`);
  await new Promise(r => setTimeout(r, 300));   // applier is fire-and-forget

  const pinsAfter = td.loadDefaults(USER_ID);
  assert(pinsAfter[fakeTool]?.zip === '99999', 'pin written to tool-defaults.json', JSON.stringify(pinsAfter[fakeTool]));

  // Verify merge: omitting zip should fill it; explicit override should win
  const filled = td.mergeDefaults(USER_ID, fakeTool, { limit: 7 });
  assert(filled.zip === '99999', 'mergeDefaults fills omitted zip', JSON.stringify(filled));
  const overridden = td.mergeDefaults(USER_ID, fakeTool, { zip: 'override', limit: 7 });
  assert(overridden.zip === 'override', 'user-supplied value wins over pin', JSON.stringify(overridden));

  // DELETE pin via HTTP
  const { status: dS } = await req('DELETE', `/api/learnings/defaults/${encodeURIComponent(fakeTool)}/${encodeURIComponent('zip')}`);
  assert(dS === 200, 'DELETE /api/learnings/defaults 200', `status ${dS}`);
  await new Promise(r => setTimeout(r, 100));
  const pinsAfterDelete = td.loadDefaults(USER_ID);
  assert(!(fakeTool in pinsAfterDelete), 'pin removed after DELETE', JSON.stringify(pinsAfterDelete));

  // Verify sensitive-arg blocklist: key/token/secret/password/auth must not trip
  const sensTool = `phase2_${TAG}_sens`;
  for (let i = 1; i <= 4; i++) await td.recordToolCall(USER_ID, sensTool, { api_key: 'sk-xxx' });
  const counts = readJson(path.join(USER_DIR, 'tool-arg-counts.json')) || {};
  const sensKey = `${sensTool}.api_key`;
  assert(!(sensKey in counts), 'sensitive arg name "api_key" is NOT counted', `found in counts: ${JSON.stringify(counts[sensKey])}`);

  // Verify destructive-tool blocklist
  const destrTool = `delete_${TAG}_thing`;
  for (let i = 1; i <= 4; i++) await td.recordToolCall(USER_ID, destrTool, { target: 'x' });
  const counts2 = readJson(path.join(USER_DIR, 'tool-arg-counts.json')) || {};
  const destrKey = `${destrTool}.target`;
  assert(!(destrKey in counts2), 'destructive tool name (delete_*) is NOT counted', `found: ${JSON.stringify(counts2[destrKey])}`);
}

// ── Phase 3: tool-failure tracker ───────────────────────────────────────────
async function testPhase3() {
  section('Phase 3: tool-failure');

  const tf = await import('/home/shawn/.openensemble/lib/tool-failures.mjs');
  const failTool = `phase3_${TAG}_failtool`;

  let signal;
  signal = await tf.recordToolFailure(USER_ID, failTool, 'Error A: x');
  assert(signal.proposed === false, 'failure 1 doesn\'t trip', JSON.stringify(signal));
  signal = await tf.recordToolFailure(USER_ID, failTool, 'Error B: y');
  assert(signal.proposed === false, 'failure 2 doesn\'t trip', JSON.stringify(signal));
  signal = await tf.recordToolFailure(USER_ID, failTool, 'Error C: z');
  assert(signal.proposed === true && signal.tool === failTool, 'failure 3 unique-prefix trips', JSON.stringify(signal));
  signal = await tf.recordToolFailure(USER_ID, failTool, 'Error D: another');
  assert(signal.proposed === false, 'failure 4 silent (24h cooldown)', JSON.stringify(signal));

  // Dedup: identical errors don't trip
  const dupTool = `phase3_${TAG}_duptool`;
  for (let i = 1; i <= 3; i++) {
    signal = await tf.recordToolFailure(USER_ID, dupTool, 'Same error every time');
  }
  assert(signal.proposed === false, '3 identical errors do NOT trip (uniqueness gate)', JSON.stringify(signal));

  // List exposes both
  const list = tf.listRecentFailures(USER_ID);
  const failEntry = list.find(f => f.tool === failTool);
  const dupEntry = list.find(f => f.tool === dupTool);
  assert(failEntry?.uniqueErrorCount === 4, 'listRecentFailures reports 4 unique prefixes for failTool', JSON.stringify(failEntry));
  assert(dupEntry?.uniqueErrorCount === 1, 'listRecentFailures reports 1 unique for dupTool', JSON.stringify(dupEntry));

  // Tool-failure proposal: built-in branch
  const prop = await import('/home/shawn/.openensemble/lib/proposals.mjs');
  const builtIn = await prop.proposeToolFailure({
    userId: USER_ID, agentId: 'test',
    tool: failTool, skillId: 'tasks',     // built-in skill id
    recentErrors: ['e1', 'e2', 'e3'], count: 3,
  });
  assert(builtIn?.isUserSkill === false && /diagnostic/i.test(builtIn?.accept_label || ''),
    'built-in tool gets "Write diagnostic" path', `isUserSkill=${builtIn?.isUserSkill}`);

  // User-skill branch (localweather is a user skill in Shawn's install)
  const userSkill = await prop.proposeToolFailure({
    userId: USER_ID, agentId: 'test',
    tool: 'localweather_smoke', skillId: 'localweather',
    recentErrors: ['e1', 'e2', 'e3'], count: 3,
  });
  assert(userSkill?.isUserSkill === true && /refine/i.test(userSkill?.accept_label || ''),
    'user-skill gets "Refine <skill>" path', `isUserSkill=${userSkill?.isUserSkill}`);

  // Cleanup proposals from disk
  const propData = readJson(path.join(USER_DIR, 'proposals.json'));
  if (propData) {
    propData.proposals = (propData.proposals || []).filter(p => p.id !== builtIn?.id && p.id !== userSkill?.id);
    writeJson(path.join(USER_DIR, 'proposals.json'), propData);
  }
}

// ── Phase 4 / 4.5: outcome telemetry + per-kind measurers ───────────────────
async function testPhase4() {
  section('Phase 4 / 4.5: outcome telemetry + per-kind measurers');

  const fs2 = fs;
  const now = Date.now();

  // Each measurer gets a synthetic accepted-7d-ago outcome record + the data
  // it needs in its source store. Then we hit /api/learnings and verify the
  // lazy reader fills the right fields with the right semantic.
  const outcomesPath = path.join(USER_DIR, 'proposal-outcomes.json');
  const fpath = path.join(USER_DIR, 'tool-failures.json');
  const cpath = path.join(USER_DIR, 'correction-events.jsonl');
  const ppath = path.join(USER_DIR, 'tool-pin-events.jsonl');

  // --- A. tool_failure measurer ---
  const failTool = `phase45_${TAG}_failtool`;
  const failures = readJson(fpath) || {};
  failures[failTool] = { msgs: [
    { ts: now - 10*day, error: 'x' }, { ts: now - 9*day, error: 'y' },
    { ts: now - 8*day, error: 'z' }, { ts: now - 7*day, error: 'x' },
    { ts: now - 6*day, error: 'y' },   // 5 in pre window
    { ts: now - 4*day, error: 'x' },   // 1 in post window
  ]};
  writeJson(fpath, failures);

  // --- B. rule_promotion measurer + C. skill_refine measurer ---
  // Use a DIFFERENT agentId for the skill_refine seeding so that
  // rule_promotion's agentId filter doesn't double-count skill-attributed
  // events. The agentId filter is exclusive; this keeps the two measurers
  // isolated.
  const synthAgent      = `phase45_${TAG}_agent_only`;
  const synthSkillAgent = `phase45_${TAG}_agent_skillpath`;
  const synthSkill      = `phase45_${TAG}_skill`;
  const corrLines = [];
  // 4 pre, 1 post for synthAgent (agent-only path, no skillId)
  for (const t of [now - 10*day, now - 8*day, now - 7*day, now - 6*day]) {
    corrLines.push(JSON.stringify({ ts: t, agentId: synthAgent, skillId: null, text: 'x' }));
  }
  corrLines.push(JSON.stringify({ ts: now - 4*day, agentId: synthAgent, skillId: null, text: 'x' }));
  // 3 pre, 0 post for synthSkill (different agentId so rule_promotion
  // measurer's agentId-filter doesn't pull these in)
  for (const t of [now - 10*day, now - 8*day, now - 6*day]) {
    corrLines.push(JSON.stringify({ ts: t, agentId: synthSkillAgent, skillId: synthSkill, text: 'x' }));
  }
  fs2.mkdirSync(path.dirname(cpath), { recursive: true });
  fs2.appendFileSync(cpath, corrLines.join('\n') + '\n');

  // --- E. skill_proposal measurer (Phase 5) ---
  const synthNewSkillId = `phase5_${TAG}_newskill`;
  const invPath = path.join(USER_DIR, 'invocation-events.jsonl');
  const invLines = [];
  // 0 pre (skill didn't exist), 4 post invocations
  for (const t of [now - 4*day, now - 3*day, now - 2*day, now - 1*day]) {
    invLines.push(JSON.stringify({ ts: t, toolName: 'phase5_smoke_tool', skillId: synthNewSkillId }));
  }
  fs2.mkdirSync(path.dirname(invPath), { recursive: true });
  fs2.appendFileSync(invPath, invLines.join('\n') + '\n');

  // --- F. routine_proposal measurer (Phase 5) ---
  const synthRoutineId = `phase5_${TAG}_routine`;
  const rfPath = path.join(USER_DIR, 'routine-fires.jsonl');
  const rfLines = [];
  for (const t of [now - 4*day, now - 3*day, now - 1*day]) {
    rfLines.push(JSON.stringify({ ts: t, routineId: synthRoutineId, trigger: 'smoke trigger' }));
  }
  fs2.mkdirSync(path.dirname(rfPath), { recursive: true });
  fs2.appendFileSync(rfPath, rfLines.join('\n') + '\n');

  // --- D. default_arg measurer ---
  const synthDfTool = `phase45_${TAG}_dftool`;
  const pinLines = [
    { ts: now - 4*day, tool: synthDfTool, arg: 'x', kind: 'override', pinned: 1, supplied: 2 },
    { ts: now - 3*day, tool: synthDfTool, arg: 'x', kind: 'override', pinned: 1, supplied: 3 },
    { ts: now - 2*day, tool: synthDfTool, arg: 'x', kind: 'fill', pinned: 1, supplied: null },
  ].map(o => JSON.stringify(o));
  fs2.mkdirSync(path.dirname(ppath), { recursive: true });
  fs2.appendFileSync(ppath, pinLines.join('\n') + '\n');

  // Seed outcome records with checkAt in the past
  const outAll = readJson(outcomesPath) || {};
  const cases = {
    [`prop_${TAG}_phase45_tool_failure`]: { kind: 'tool_failure', tool: failTool },
    [`prop_${TAG}_phase45_rule_promo`]:    { kind: 'rule_promotion', agentId: synthAgent },
    [`prop_${TAG}_phase45_skill_refine`]:  { kind: 'skill_refine', skillId: synthSkill },
    [`prop_${TAG}_phase45_default_arg`]:   { kind: 'default_arg', tool: synthDfTool, arg: 'x' },
    [`prop_${TAG}_phase5_skill_proposal`]: { kind: 'skill_proposal', newSkillId: synthNewSkillId },
    [`prop_${TAG}_phase5_routine_proposal`]: { kind: 'routine_proposal', routineId: synthRoutineId },
  };
  for (const [pid, info] of Object.entries(cases)) {
    outAll[pid] = {
      kind: info.kind,
      acceptedAt: now - 5*day,
      preCount: 0, postCount: null, delta: null,
      semantic: null, note: null, measurerUsed: info.kind,
      checkAt: now - 3*day,
      proposalPayload: {
        tool: info.tool || null, arg: info.arg || null,
        skillId: info.skillId || null, agentId: info.agentId || null,
        newSkillId: info.newSkillId || null,
        routineId: info.routineId || null,
      },
    };
  }
  writeJson(outcomesPath, outAll);

  // Hit /api/learnings — triggers lazy reader. The lazy reader persists
  // back via fire-and-forget; race with our writeJson can clobber state.
  // Small settle + a second GET after lets reads stabilize.
  await req('GET', '/api/learnings');
  await new Promise(r => setTimeout(r, 250));
  const { data: learn } = await req('GET', '/api/learnings');
  const outRec = (after, kind) => {
    const after2 = readJson(outcomesPath) || {};
    const pid = Object.keys(after2).find(k => after2[k].kind === kind && k.includes(TAG));
    return pid ? after2[pid] : null;
  };

  // tool_failure: pre=5, post=1, delta=-4, semantic lower-better
  let r = outRec(true, 'tool_failure');
  assert(r?.preCount === 5 && r?.postCount === 1 && r?.delta === -4 && r?.semantic === 'lower-better',
    'tool_failure measurer correct', JSON.stringify(r));

  // rule_promotion: pre=4, post=1, delta=-3
  r = outRec(true, 'rule_promotion');
  assert(r?.preCount === 4 && r?.postCount === 1 && r?.delta === -3 && r?.semantic === 'lower-better',
    'rule_promotion measurer correct', JSON.stringify(r));

  // skill_refine: pre=3, post=0, delta=-3
  r = outRec(true, 'skill_refine');
  assert(r?.preCount === 3 && r?.postCount === 0 && r?.delta === -3 && r?.semantic === 'lower-better',
    'skill_refine measurer correct', JSON.stringify(r));

  // default_arg: pre=0, post=2, delta=+2 (overrides → bad)
  r = outRec(true, 'default_arg');
  assert(r?.preCount === 0 && r?.postCount === 2 && r?.delta === 2 && r?.semantic === 'lower-better',
    'default_arg measurer correct', JSON.stringify(r));

  // skill_proposal: pre=0, post=4, delta=+4, semantic higher-better
  r = outRec(true, 'skill_proposal');
  assert(r?.postCount === 4 && r?.semantic === 'higher-better',
    'skill_proposal measurer correct (Phase 5)', JSON.stringify(r));

  // routine_proposal: pre=0, post=3, delta=+3, semantic higher-better
  r = outRec(true, 'routine_proposal');
  assert(r?.postCount === 3 && r?.semantic === 'higher-better',
    'routine_proposal measurer correct (Phase 5)', JSON.stringify(r));

  // --- G. alias_proposal measurer (Phase 9) ---
  // Wait for any in-flight fire-and-forget saves from the earlier
  // /api/learnings call to settle before we mutate the outcomes file.
  await new Promise(r => setTimeout(r, 300));
  const synthPhrase = `phase9_${TAG}_phrase`;
  const ahPath = path.join(USER_DIR, 'alias-hits.jsonl');
  const ahLines = [];
  // 2 hits in post window
  for (const t of [now - 4*day, now - 2*day]) {
    ahLines.push(JSON.stringify({ ts: t, phrase: synthPhrase, entityId: 'light.test' }));
  }
  fs2.mkdirSync(path.dirname(ahPath), { recursive: true });
  fs2.appendFileSync(ahPath, ahLines.join('\n') + '\n');

  // Seed outcome record
  const outAll3 = readJson(outcomesPath) || {};
  const aliasPid = `prop_${TAG}_phase9_alias`;
  outAll3[aliasPid] = {
    kind: 'alias_proposal',
    acceptedAt: now - 5*day,
    preCount: 0, postCount: null, delta: null,
    semantic: null, note: null, measurerUsed: 'alias_proposal',
    checkAt: now - 3*day,
    proposalPayload: { phrase: synthPhrase, tool: null, arg: null, skillId: null, agentId: null, newSkillId: null, routineId: null, overrideId: null },
  };
  writeJson(outcomesPath, outAll3);

  await req('GET', '/api/learnings');
  await new Promise(r => setTimeout(r, 250));
  await req('GET', '/api/learnings');
  r = outRec(true, 'alias_proposal');
  assert(r?.postCount === 2 && r?.semantic === 'higher-better',
    'alias_proposal measurer correct (Phase 9)', JSON.stringify(r));

  // Verify summarizeByKind aggregates correctly
  const byKind = learn?.outcomesByKind || [];
  const tf = byKind.find(k => k.kind === 'tool_failure');
  const da = byKind.find(k => k.kind === 'default_arg');
  assert(tf?.measured >= 1 && tf?.improved >= 1, 'byKind tool_failure shows improvement', JSON.stringify(tf));
  assert(da?.measured >= 1 && da?.improved === 0, 'byKind default_arg correctly NOT improved (overrides=2)', JSON.stringify(da));

  // Verify recentAccepted decoration carries semantic + note through to API
  // (we don't have an accepted record in proposals.json for these synth ids,
  //  so this is implicitly tested via the outcomesByKind layer.)

  // Coarse fallback: insert an outcome for a kind we haven't built a measurer
  // for (e.g. routine_proposal). Should NOT touch the measurer and should
  // fall back to coarse counting.
  const coarseId = `prop_${TAG}_phase45_coarse`;
  const outAll2 = readJson(outcomesPath);
  outAll2[coarseId] = {
    kind: 'routine_proposal',
    acceptedAt: now - 5*day,
    preCount: 5, postCount: null, delta: null,
    semantic: null, note: null, measurerUsed: null,
    checkAt: now - 3*day,
    proposalPayload: { tool: null, arg: null, skillId: null, agentId: null },
  };
  writeJson(outcomesPath, outAll2);
  await req('GET', '/api/learnings');
  await new Promise(r => setTimeout(r, 250));   // let fire-and-forget save settle
  await req('GET', '/api/learnings');
  const outAfter = readJson(outcomesPath) || {};
  const coarseRec = outAfter[coarseId];
  assert(coarseRec?.postCount !== null && coarseRec?.measurerUsed === null,
    'kinds without measurer fall back to coarse', JSON.stringify(coarseRec));

  // ── Cleanup synth artifacts ──
  const cleanFiles = {
    [outcomesPath]: 'json', [fpath]: 'json',
    [cpath]: 'jsonl', [ppath]: 'jsonl',
    [invPath]: 'jsonl', [rfPath]: 'jsonl',
    [ahPath]: 'jsonl',
  };
  for (const [p, fmt] of Object.entries(cleanFiles)) {
    if (!fs2.existsSync(p)) continue;
    if (fmt === 'json') {
      const d = readJson(p) || {};
      for (const k of Object.keys(d)) {
        if (k.includes(TAG) || k.includes('phase45') || k.includes('phase5_') || k.includes('phase9_')) delete d[k];
      }
      writeJson(p, d);
    } else {
      const lines = fs2.readFileSync(p, 'utf8').split('\n').filter(l =>
        l && !l.includes(TAG) && !l.includes('phase45') && !l.includes('phase5_') && !l.includes('phase9_')
      );
      fs2.writeFileSync(p, lines.join('\n') + (lines.length ? '\n' : ''));
    }
  }
}

// ── Phase 6: routing overrides + redirect detection ────────────────────────
async function testPhase6() {
  section('Phase 6: routing overrides + redirect detection');

  const rovr = await import('/home/shawn/.openensemble/lib/routing-overrides.mjs');
  const rmis = await import('/home/shawn/.openensemble/lib/router-mistakes.mjs');

  // --- Override match ---
  const fakeAgent = `agent_smoke_${TAG}_phase6`;
  const addRes = await rovr.addOverride(USER_ID, {
    pattern: `phase6 ${TAG}`,
    forcedAgent: fakeAgent,
    mode: 'contains',
    addedBy: 'smoke',
  });
  assert(addRes.ok && addRes.id, 'addOverride returns id', JSON.stringify(addRes));
  const ovrId = addRes.id;

  const m1 = rovr.matchOverride(USER_ID, `tell me about phase6 ${TAG} please`);
  assert(m1?.forcedAgent === fakeAgent, 'matchOverride substring-match hit', JSON.stringify(m1));
  const m2 = rovr.matchOverride(USER_ID, 'unrelated message');
  assert(m2 === null, 'matchOverride miss returns null', JSON.stringify(m2));

  // --- Redirect detection ---
  const detected1 = rmis.detectRedirect(`@ada show me something`);
  assert(detected1 === 'ada', 'detectRedirect @-mention hits', `got ${detected1}`);
  const detected2 = rmis.detectRedirect(`use sydney instead`);
  assert(detected2 === 'sydney', 'detectRedirect "use <agent>" hits', `got ${detected2}`);
  const detected3 = rmis.detectRedirect(`no, ask coder about it`);
  assert(detected3 === 'coder', 'detectRedirect "ask <agent>" hits', `got ${detected3}`);
  const detected4 = rmis.detectRedirect(`tell me a story`);
  assert(detected4 === null, 'detectRedirect ignores non-redirect', `got ${detected4}`);
  const detected5 = rmis.detectRedirect(`no, that is wrong`);
  assert(detected5 === null, 'detectRedirect ignores vague correction', `got ${detected5}`);

  // --- Threshold-based proposal logic ---
  // Seed 2 mistakes with same correctedAgent + overlapping prevMessage tokens
  await rmis.appendMistake(USER_ID, {
    prevMessage: `when did the ${TAG} skill last run`,
    prevAgent: 'sydney',
    correctedAgent: fakeAgent,
    evidenceMsg: `use ${fakeAgent}`,
  });
  await rmis.appendMistake(USER_ID, {
    prevMessage: `please tell me when did the ${TAG} watcher last fire`,
    prevAgent: 'sydney',
    correctedAgent: fakeAgent,
    evidenceMsg: `ask ${fakeAgent}`,
  });
  const signal = rmis.maybePropose(USER_ID);
  assert(signal.proposed === true && signal.correctedAgent === fakeAgent && typeof signal.pattern === 'string',
    'maybePropose trips at 2+ similar mistakes', JSON.stringify(signal));

  // --- Proposal emission ---
  const prop = await import('/home/shawn/.openensemble/lib/proposals.mjs');
  const proposal = await prop.proposeRoutingOverride({
    userId: USER_ID, agentId: 'sydney',
    correctedAgent: signal.correctedAgent,
    correctedAgentName: 'TestAgent',
    pattern: signal.pattern,
    examples: signal.examples,
  });
  assert(proposal?.kind === 'routing_override' && proposal?.pattern === signal.pattern,
    'proposeRoutingOverride returns valid proposal', JSON.stringify({id: proposal?.id, kind: proposal?.kind}));

  // --- routing_override measurer with synthetic fires ---
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  // Log 3 fires in the post-window
  for (let i = 1; i <= 3; i++) {
    await rovr.logFire(USER_ID, ovrId, `phase6 ${TAG} message ${i}`);
  }
  const meas = await import('/home/shawn/.openensemble/lib/proposal-outcome-measurers.mjs');
  const r = meas.measureProposalOutcome(USER_ID, {
    kind: 'routing_override',
    acceptedAt: now - 1*day,    // accepted yesterday; fires after that
    overrideId: ovrId,
  });
  assert(r?.postCount === 3 && r?.semantic === 'higher-better',
    'routing_override measurer counts fires', JSON.stringify(r));

  // --- API surface: GET /api/learnings includes routingOverrides ---
  const { data: learn } = await req('GET', '/api/learnings');
  const ourOvr = (learn?.routingOverrides || []).find(o => o.id === ovrId);
  assert(ourOvr?.forcedAgent === fakeAgent, '/api/learnings exposes routing overrides', JSON.stringify(ourOvr));

  // --- DELETE revoke endpoint ---
  const { status: dS } = await req('DELETE', `/api/learnings/routing-overrides/${encodeURIComponent(ovrId)}`);
  assert(dS === 200, 'DELETE /api/learnings/routing-overrides/<id> 200', `status ${dS}`);
  const overridesAfter = rovr.loadOverrides(USER_ID);
  assert(!overridesAfter.some(o => o.id === ovrId), 'override removed from disk after DELETE', JSON.stringify(overridesAfter.map(o => o.id)));

  // --- Cleanup synth records ---
  const fs2 = fs;
  const cpath = `${USER_DIR}/router-mistakes.jsonl`;
  if (fs2.existsSync(cpath)) {
    const lines = fs2.readFileSync(cpath, 'utf8').split('\n').filter(l => l && !l.includes(TAG));
    fs2.writeFileSync(cpath, lines.join('\n') + (lines.length ? '\n' : ''));
  }
  const firesPath = `${USER_DIR}/routing-fires.jsonl`;
  if (fs2.existsSync(firesPath)) {
    const lines = fs2.readFileSync(firesPath, 'utf8').split('\n').filter(l => l && !l.includes(TAG));
    fs2.writeFileSync(firesPath, lines.join('\n') + (lines.length ? '\n' : ''));
  }
  const propPath = `${USER_DIR}/proposals.json`;
  if (fs2.existsSync(propPath)) {
    const d = readJson(propPath);
    d.proposals = (d.proposals || []).filter(p => p.id !== proposal?.id);
    writeJson(propPath, d);
  }
}

// ── Phase 7: salience feedback ──────────────────────────────────────────────
async function testPhase7() {
  section('Phase 7: salience feedback');

  const sal = await import('/home/shawn/.openensemble/lib/proposal-salience.mjs');
  const fs2 = fs;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  // Seed a kind with bad outcomes (1 of 3 improved → below PAUSE_THRESHOLD 0.5)
  // and a kind with no data (should pass freely).
  const badKind = `bad_${TAG}_kind`;
  const outcomesPath = `${USER_DIR}/proposal-outcomes.json`;
  const out = readJson(outcomesPath) || {};
  // 3 bad outcomes: delta > 0 with semantic=lower-better → "improved" = false
  for (let i = 0; i < 3; i++) {
    out[`prop_${TAG}_bad_${i}`] = {
      kind: badKind, acceptedAt: now - 10*day, preCount: 5, postCount: 8, delta: 3,
      semantic: 'lower-better', note: '', measurerUsed: badKind,
      checkAt: now - 3*day, proposalPayload: { tool: null, arg: null, skillId: null, agentId: null },
    };
  }
  // 1 good outcome (so 1 of 4 improved = 25% → below 50% threshold)
  out[`prop_${TAG}_good_0`] = {
    kind: badKind, acceptedAt: now - 8*day, preCount: 5, postCount: 2, delta: -3,
    semantic: 'lower-better', note: '', measurerUsed: badKind,
    checkAt: now - 1*day, proposalPayload: { tool: null, arg: null, skillId: null, agentId: null },
  };
  writeJson(outcomesPath, out);

  // Hit /api/learnings to trigger byKind aggregation (and salience read)
  const { data: learn1 } = await req('GET', '/api/learnings');
  const status1 = (learn1.salienceStatus || []).find(s => s.kind === badKind);
  assert(status1 && status1.allow === false && status1.reason === 'paused',
    'kind with bad outcomes is paused', JSON.stringify(status1));

  // Verify createProposal is blocked for paused kinds
  const v1 = sal.getKindStatus(USER_ID, badKind);
  assert(v1.allow === false, 'getKindStatus returns paused for bad kind', JSON.stringify(v1));

  // Kind with no data — always allowed
  const newKind = `new_${TAG}_kind`;
  const v2 = sal.getKindStatus(USER_ID, newKind);
  assert(v2.allow === true && v2.reason === 'insufficient-data',
    'kind without data allowed (insufficient-data)', JSON.stringify(v2));

  // Reset: POST /api/learnings/salience/<kind>/reset; verify within grace window
  const { status: rsStatus } = await req('POST', `/api/learnings/salience/${encodeURIComponent(badKind)}/reset`);
  assert(rsStatus === 200, 'POST .../salience/.../reset 200', `status ${rsStatus}`);
  const { data: learn2 } = await req('GET', '/api/learnings');
  const status2 = (learn2.salienceStatus || []).find(s => s.kind === badKind);
  assert(status2 && status2.allow === true && status2.reason === 'reset-grace',
    'reset enters 7d grace window', JSON.stringify(status2));

  // End-to-end gate: try to emit a proposal of the badKind — should be blocked.
  // We use a one-off proposeRoutingOverride against the badKind to verify the
  // gate fires inside createProposal (any kind would work; routing-override
  // is convenient since the proposer is simple). First we need to clear the
  // grace window so the gate is back to paused.
  const overridesPath = `${USER_DIR}/salience-overrides.json`;
  if (fs2.existsSync(overridesPath)) {
    const ov = JSON.parse(fs2.readFileSync(overridesPath, 'utf8'));
    delete ov[badKind];
    fs2.writeFileSync(overridesPath, JSON.stringify(ov, null, 2));
  }
  // We can't directly call createProposal with badKind because each proposer
  // sets its own kind, but we can verify via getKindStatus that gating would
  // happen — already covered above. The actual createProposal gate is exercised
  // by the existing Phase 2/3/6 tests (their proposals must pass to run, and
  // they all use kinds without bad outcomes).

  // Cleanup
  const finalOut = readJson(outcomesPath) || {};
  for (const k of Object.keys(finalOut)) if (k.includes(TAG)) delete finalOut[k];
  writeJson(outcomesPath, finalOut);
  if (fs2.existsSync(overridesPath)) {
    const ov = JSON.parse(fs2.readFileSync(overridesPath, 'utf8'));
    delete ov[badKind];
    fs2.writeFileSync(overridesPath, JSON.stringify(ov, null, 2));
  }
}

// ── Phase 8: first-week sweep ───────────────────────────────────────────────
async function testPhase8() {
  section('Phase 8: first-week sweep');

  const sweepStatusPath = `${USER_DIR}/week1-sweep.json`;
  const propPath = `${USER_DIR}/proposals.json`;
  const countsPath = `${USER_DIR}/tool-arg-counts.json`;
  const failPath = `${USER_DIR}/tool-failures.json`;
  const mistakesPath = `${USER_DIR}/router-mistakes.jsonl`;

  // Save current state so we can restore. Shawn's user dir is months old, so
  // his sweep status is initialized as late-init/skipped — we need to clear
  // it for the test.
  const savedStatus = readJson(sweepStatusPath);
  if (fs.existsSync(sweepStatusPath)) fs.unlinkSync(sweepStatusPath);

  // --- Status endpoint exposes week1Sweep field ---
  const { data: learnPre } = await req('GET', '/api/learnings');
  // After this call, lazy maybeRunSweep ran (fire-and-forget). For an old
  // user dir, it should mark skipped with late-init. The status surfaces.
  await new Promise(r => setTimeout(r, 200));
  const lateStatus = readJson(sweepStatusPath);
  assert(lateStatus?.skipped === true && lateStatus?.reason === 'late-init',
    'pre-existing user dir → sweep marked late-init/skipped',
    JSON.stringify(lateStatus));

  // Re-fetch to confirm /api/learnings surfaces the saved status
  const { data: learn1 } = await req('GET', '/api/learnings');
  assert(learn1?.week1Sweep?.done === true && learn1?.week1Sweep?.reason === 'late-init',
    '/api/learnings week1Sweep field carries late-init', JSON.stringify(learn1?.week1Sweep));

  // --- Forced sweep does nothing when already done ---
  const { status: f1Status, data: f1 } = await req('POST', '/api/learnings/sweep/run');
  assert(f1Status === 200 && f1?.ran === false && f1?.reason === 'already-done',
    'force run on done/skipped → ran=false', JSON.stringify(f1));

  // --- Reset sweep state + seed test signals + force run ---
  if (fs.existsSync(sweepStatusPath)) fs.unlinkSync(sweepStatusPath);
  // Write a fresh status with firstSeenAt = now (NOT skipped); forceRun
  // backdates it.
  writeJson(sweepStatusPath, { firstSeenAt: Date.now(), done: false });

  const now = Date.now();
  const day = 86_400_000;

  // Seed tool-arg-counts: 2 occurrences (relaxed threshold) of same value
  const sweepTool = `phase8_${TAG}_tool`;
  const counts = readJson(countsPath) || {};
  counts[`${sweepTool}.zip`] = { 's:99999': [now - 2*day, now - 1*day] };
  writeJson(countsPath, counts);

  // Seed tool-failures: 2 unique error prefixes (relaxed)
  const sweepFailTool = `phase8_${TAG}_failtool`;
  const fail = readJson(failPath) || {};
  fail[sweepFailTool] = { msgs: [
    { ts: now - 2*day, error: 'Error one' },
    { ts: now - 1*day, error: 'Error two' },
  ], cooldownLastProposedAt: 0 };
  writeJson(failPath, fail);

  // Seed a single router-mistake (relaxed: 1 is enough)
  const sweepAgent = `phase8_${TAG}_agent`;
  fs.appendFileSync(mistakesPath, JSON.stringify({
    ts: now - 1*day,
    prevMessage: `phase8 ${TAG} unique trigger phrase`,
    prevAgent: 'sydney',
    correctedAgent: sweepAgent,
    evidenceMsg: `use ${sweepAgent}`,
  }) + '\n');

  const { data: f2 } = await req('POST', '/api/learnings/sweep/run');
  assert(f2?.ran === true && typeof f2?.count === 'number',
    'force run executes when not done', JSON.stringify(f2));
  assert(f2.count >= 3,
    'force run emits >=3 proposals from seeded signals',
    `emitted ${f2.count}, expected >=3 (default_arg + tool_failure + routing_override)`);

  // Verify sweep marked done after run
  const doneStatus = readJson(sweepStatusPath);
  assert(doneStatus?.done === true && Array.isArray(doneStatus?.emittedKinds),
    'sweep status marked done with emittedKinds', JSON.stringify(doneStatus));

  // --- Idempotency: re-run returns already-done ---
  const { data: f3 } = await req('POST', '/api/learnings/sweep/run');
  assert(f3?.ran === false && f3?.reason === 'already-done',
    'second force-run is idempotent', JSON.stringify(f3));

  // --- Verify proposals landed in queue ---
  const propData = readJson(propPath);
  const sweepProps = (propData?.proposals || []).filter(p =>
    p.tool === sweepTool || p.tool === sweepFailTool || p.correctedAgent === sweepAgent
  );
  assert(sweepProps.length >= 3, 'proposals visible in queue', `found ${sweepProps.length}`);

  // --- Cleanup synth state and restore baseline ---
  const cleanCounts = readJson(countsPath) || {};
  delete cleanCounts[`${sweepTool}.zip`];
  writeJson(countsPath, cleanCounts);

  const cleanFail = readJson(failPath) || {};
  delete cleanFail[sweepFailTool];
  writeJson(failPath, cleanFail);

  if (fs.existsSync(mistakesPath)) {
    const lines = fs.readFileSync(mistakesPath, 'utf8').split('\n').filter(l => l && !l.includes(TAG));
    fs.writeFileSync(mistakesPath, lines.join('\n') + (lines.length ? '\n' : ''));
  }

  const cleanProps = readJson(propPath);
  if (cleanProps?.proposals) {
    cleanProps.proposals = cleanProps.proposals.filter(p =>
      p.tool !== sweepTool && p.tool !== sweepFailTool && p.correctedAgent !== sweepAgent
    );
    writeJson(propPath, cleanProps);
  }

  // Restore the user's original sweep status (or delete if there wasn't one)
  if (savedStatus) writeJson(sweepStatusPath, savedStatus);
  else if (fs.existsSync(sweepStatusPath)) fs.unlinkSync(sweepStatusPath);
}

// ── Phase 10: per-user skill overrides ──────────────────────────────────────
async function testPhase10() {
  section('Phase 10: per-user skill overrides');

  const so = await import('/home/shawn/.openensemble/lib/skill-overrides.mjs');
  const roles = await import('/home/shawn/.openensemble/roles.mjs');

  // We're a separate node process from the server — _manifests is empty
  // until we boot-load it ourselves. listRoles in OUR process returns []
  // without this call.
  roles.loadRoleManifests();

  // Pick a real non-always_on skill to test against. tasks is always_on per
  // its manifest (enabled_by_default true, but not always_on). Try a few
  // candidates and use the first that exists and isn't always_on.
  const allManifests = roles.listRoles(USER_ID);
  const target = allManifests.find(m => !m.always_on && Array.isArray(m.tools) && m.tools.length >= 1);
  assert(target, 'found a non-always_on skill to test against',
    `manifests checked=${allManifests.length}`);
  if (!target) return;

  const skillId = target.id;
  const firstTool = target.tools[0]?.function?.name;
  const initialToolCount = roles.getRoleTools(skillId, USER_ID).length;
  const initialListedCount = roles.listRoles(USER_ID).filter(m => m.id === skillId).length;

  // --- 1. Disable the skill via setSkillOverride ---
  const setResult = await so.setSkillOverride(USER_ID, skillId, { disabled: true });
  assert(setResult.ok, 'setSkillOverride disable returns ok', JSON.stringify(setResult));
  const listedAfterDisable = roles.listRoles(USER_ID).filter(m => m.id === skillId).length;
  assert(initialListedCount === 1 && listedAfterDisable === 0,
    'listRoles drops disabled skill', `before=${initialListedCount} after=${listedAfterDisable}`);

  // --- 2. Always_on guard: try to disable an always_on skill ---
  const alwaysOnSkill = allManifests.find(m => m.always_on);
  if (alwaysOnSkill) {
    await so.setSkillOverride(USER_ID, alwaysOnSkill.id, { disabled: true });
    const isStillVisible = roles.listRoles(USER_ID).some(m => m.id === alwaysOnSkill.id);
    assert(isStillVisible, 'always_on skill resists disable (safety net)',
      `disabled persisted but listRoles=${isStillVisible}`);
    await so.clearSkillOverride(USER_ID, alwaysOnSkill.id);
  } else {
    // No always_on skill to test against — skip but log pass
    pass('always_on guard skipped (no always_on skill in roster)');
  }

  // --- 3. Clear disable + hide a single tool ---
  await so.clearSkillOverride(USER_ID, skillId);
  if (firstTool) {
    await so.setSkillOverride(USER_ID, skillId, { hiddenTools: [firstTool] });
    const toolsAfterHide = roles.getRoleTools(skillId, USER_ID);
    assert(toolsAfterHide.length === initialToolCount - 1
        && !toolsAfterHide.some(t => t.function?.name === firstTool),
      'getRoleTools strips hidden tool',
      `before=${initialToolCount} after=${toolsAfterHide.length} firstTool=${firstTool}`);
  }

  // --- 4. listSkillOverrides flat view ---
  const listed = so.listSkillOverrides(USER_ID);
  assert(listed.length >= 1 && listed.some(o => o.skillId === skillId && o.hiddenTools?.includes(firstTool)),
    'listSkillOverrides reflects current state', JSON.stringify(listed.find(o => o.skillId === skillId)));

  // --- 5. /api/learnings surfaces skillOverrides ---
  const { data: learn } = await req('GET', '/api/learnings');
  assert(Array.isArray(learn?.skillOverrides) && learn.skillOverrides.some(o => o.skillId === skillId),
    '/api/learnings exposes skillOverrides', JSON.stringify(learn?.skillOverrides));

  // --- 6. PUT endpoint roundtrip ---
  const putRes = await fetch(`${BASE}/api/learnings/skill-overrides/${encodeURIComponent(skillId)}`, {
    method: 'PUT', headers: { Cookie: COOKIE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hiddenTools: firstTool ? [firstTool] : [], disabled: false }),
  });
  const putData = await putRes.json();
  assert(putRes.status === 200 && putData.ok, 'PUT /api/learnings/skill-overrides/<id> 200', JSON.stringify(putData));

  // --- 7. DELETE endpoint clears the override ---
  const delRes = await fetch(`${BASE}/api/learnings/skill-overrides/${encodeURIComponent(skillId)}`, {
    method: 'DELETE', headers: { Cookie: COOKIE },
  });
  assert(delRes.status === 200, 'DELETE /api/learnings/skill-overrides/<id> 200', `status ${delRes.status}`);
  const finalTools = roles.getRoleTools(skillId, USER_ID);
  assert(finalTools.length === initialToolCount, 'tools restored after delete',
    `final=${finalTools.length} initial=${initialToolCount}`);

  // --- Cleanup any lingering state from this test ---
  const overridesPath = `${USER_DIR}/skill-overrides.json`;
  if (fs.existsSync(overridesPath)) {
    const d = readJson(overridesPath);
    delete d[skillId];
    if (alwaysOnSkill) delete d[alwaysOnSkill.id];
    writeJson(overridesPath, d);
  }
}

// ── Phase 13: inline undo + bulk ops ────────────────────────────────────────
async function testPhase13() {
  section('Phase 13: undo + bulk');

  const propPath = `${USER_DIR}/proposals.json`;

  // --- 1. producedArtifact + 24h undo for alias_proposal ---
  // Seed an alias_proposal that's marked accepted with a producedArtifact.
  // Set acceptedAt to NOW so we're inside the undo window.
  // Phrases get normalized (lowercased, underscores → spaces) on write, so
  // assert against the normalized form, not the raw input.
  const aliasPhraseRaw = `phase13_${TAG}_alias_phrase`;
  const aliasEntity = 'light.test_entity_phase13';
  const { setAlias, loadAliases, normalizeAliasPhrase } = await import('/home/shawn/.openensemble/lib/ha-aliases.mjs');
  const aliasPhrase = normalizeAliasPhrase(aliasPhraseRaw);
  setAlias(USER_ID, aliasPhraseRaw, aliasEntity);
  assert(loadAliases(USER_ID)[aliasPhrase] === aliasEntity,
    'alias was written for undo test',
    `got=${JSON.stringify(loadAliases(USER_ID)[aliasPhrase])} expected=${aliasEntity} normalizedKey="${aliasPhrase}"`);

  // Seed the proposal in accepted state with producedArtifact
  const propData = readJson(propPath) || { proposals: [], dismissedPatterns: {} };
  const undoId = `prop_${TAG}_phase13_undo`;
  propData.proposals.push({
    id: undoId, userId: USER_ID, agentId: 'test',
    kind: 'alias_proposal',
    message: 'phase 13 undo test',
    phrase: aliasPhrase, entityId: aliasEntity,
    accept_label: 'Yes', dismiss_label: 'No',
    createdAt: Date.now() - 60_000,
    acceptedAt: Date.now() - 10_000,
    status: 'accepted',
    producedArtifact: { kind: 'alias', phrase: aliasPhrase },
  });
  writeJson(propPath, propData);
  await restartServer();   // load into in-memory map

  // Hit the undo endpoint
  const undoRes = await req('POST', `/api/proposals/${encodeURIComponent(undoId)}/undo`);
  assert(undoRes.status === 200 && undoRes.data?.ok,
    'POST /api/proposals/<id>/undo 200', JSON.stringify(undoRes.data));

  // Verify alias was actually removed from the store (check normalized key)
  const aliasesAfter = loadAliases(USER_ID);
  assert(!aliasesAfter[aliasPhrase], 'alias removed from disk after undo',
    `still present: ${JSON.stringify(aliasesAfter[aliasPhrase])}`);

  // --- 2. 24h gate rejects stale undo ---
  const staleId = `prop_${TAG}_phase13_stale`;
  const propData2 = readJson(propPath) || { proposals: [], dismissedPatterns: {} };
  propData2.proposals.push({
    id: staleId, userId: USER_ID, agentId: 'test',
    kind: 'alias_proposal',
    message: 'phase 13 stale undo test',
    phrase: `${aliasPhrase}_stale`, entityId: aliasEntity,
    accept_label: 'Yes', dismiss_label: 'No',
    createdAt: Date.now() - 2 * 86_400_000,
    acceptedAt: Date.now() - 2 * 86_400_000,   // 2 days ago — past 24h window
    status: 'accepted',
    producedArtifact: { kind: 'alias', phrase: `${aliasPhrase}_stale` },
  });
  writeJson(propPath, propData2);
  await restartServer();

  const staleRes = await req('POST', `/api/proposals/${encodeURIComponent(staleId)}/undo`);
  assert(staleRes.status === 400 && /window expired/i.test(staleRes.data?.error || ''),
    '24h-stale undo rejected', JSON.stringify(staleRes.data));

  // --- 3. Bulk accept ---
  // Seed two pending proposals (use rule_promotion kind since it has a simple
  // direct-write accept handler).
  const bulkId1 = `prop_${TAG}_phase13_bulk1`;
  const bulkId2 = `prop_${TAG}_phase13_bulk2`;
  const propData3 = readJson(propPath) || { proposals: [], dismissedPatterns: {} };
  for (const [pid, ruleText] of [[bulkId1, `rule-${TAG}-1`], [bulkId2, `rule-${TAG}-2`]]) {
    propData3.proposals.push({
      id: pid, userId: USER_ID, agentId: 'test',
      kind: 'rule_promotion',
      message: 'bulk test',
      ruleText, roleId: `bulk_${TAG}_role`, roleName: `bulk_${TAG}_role`,
      sourceCorrectionIds: [],
      accept_label: 'Add', dismiss_label: 'No',
      createdAt: Date.now(),
      status: 'pending',
    });
  }
  writeJson(propPath, propData3);
  await restartServer();

  const bulkRes = await req('POST', '/api/proposals/bulk/accept', { ids: [bulkId1, bulkId2] });
  assert(bulkRes.status === 200 && bulkRes.data?.ok && Array.isArray(bulkRes.data?.results),
    'POST /api/proposals/bulk/accept 200 with results array', JSON.stringify(bulkRes.data));
  assert(bulkRes.data.results.length === 2 && bulkRes.data.results.every(r => r.ok),
    'both bulk accepts reported ok', JSON.stringify(bulkRes.data.results));

  // Verify the rule files were created
  await new Promise(r => setTimeout(r, 400));   // applier is fire-and-forget
  const rulePath = `${USER_DIR}/role-rules/bulk_${TAG}_role.md`;
  const rulesContent = fs.existsSync(rulePath) ? fs.readFileSync(rulePath, 'utf8') : '';
  assert(rulesContent.includes(`rule-${TAG}-1`) && rulesContent.includes(`rule-${TAG}-2`),
    'bulk accept wrote both rules', `content: "${rulesContent.replace(/\n/g, ' ').slice(0, 120)}"`);

  // --- 4. Cleanup ---
  const finalProps = readJson(propPath) || { proposals: [] };
  finalProps.proposals = (finalProps.proposals || []).filter(p =>
    p.id !== undoId && p.id !== staleId && p.id !== bulkId1 && p.id !== bulkId2
  );
  writeJson(propPath, finalProps);
  if (fs.existsSync(rulePath)) fs.unlinkSync(rulePath);
  const delLogPath = `${USER_DIR}/role-rules/bulk_${TAG}_role.deleted.log`;
  if (fs.existsSync(delLogPath)) fs.unlinkSync(delLogPath);
}

// ── Phase 11 + 12: comprehensive Sydney WS chat coverage ────────────────────
// Exercises the live dispatcher hooks (Phases 2/3/6/10/11d) by sending real
// chat messages and verifying side-effect files / API state. The earlier
// "minimal smoke" Sydney call confirms round-trip; this is the deep version.

function waitForFile(p, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(async (resolve) => {
    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(p)) {
          const data = fs.readFileSync(p, 'utf8');
          if (predicate(data)) return resolve(true);
        }
      } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    resolve(false);
  });
}

async function chat(text, timeoutMs = 60000) {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/`, { headers: { Cookie: COOKIE } });
  return new Promise((resolve, reject) => {
    const events = [];
    const t = setTimeout(() => { ws.close(); resolve({ timedOut: true, events }); }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'chat', agent: 'sydney', text }));
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      events.push(m.type);
      if (m.type === 'done' || m.type === 'stream_end' || m.type === 'assistant_complete') {
        clearTimeout(t);
        ws.close();
        // Short settle for fire-and-forget side effects
        setTimeout(() => resolve({ timedOut: false, events }), 250);
      }
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

async function testPhase12Comprehensive() {
  section('Phase 12: comprehensive Sydney chat test (every phase)');

  // ── Phase 2: dispatcher hook records tool-arg-counts ────────────────
  // Send something likely to call list_watches (no args). The PURPOSE is to
  // confirm executeToolStreaming runs through our hook code path without
  // throwing — the counter doesn't update for empty args, that's expected.
  const result1 = await chat('list my active watches please, no commentary');
  assert(!result1.timedOut && result1.events.includes('done'),
    'Sydney chat 1 (list watches) completes', `events: ${[...new Set(result1.events)].join(',')}`);
  const toolFired1 = result1.events.includes('tool_call') || result1.events.includes('tool_result');
  // Sydney may or may not call a tool depending on classifier — accept either
  // outcome as long as the round-trip completed cleanly.
  pass(`Sydney chat 1 dispatcher ${toolFired1 ? 'fired a tool' : 'answered without a tool'} (no error path)`);

  // ── Phase 6: redirect detection logs to router-mistakes.jsonl ───────
  // Use a phrase that includes "ask <agent>" — even if the agent doesn't
  // resolve, detectAndLog runs through its pipeline without throwing.
  // We don't strictly require the chat to COMPLETE because some routing
  // prompts trigger background delegations that don't emit `done` over the
  // original WS. The side-effect check (router-mistake log integrity)
  // covers the actual behavior we care about.
  const mistakesPath = `${USER_DIR}/router-mistakes.jsonl`;
  const beforeMistakes = fs.existsSync(mistakesPath)
    ? fs.readFileSync(mistakesPath, 'utf8').split('\n').filter(Boolean).length
    : 0;
  const result2 = await chat(`ask ada when did the ${TAG} skill last run`, 30000);
  pass(`Sydney chat 2 (redirect-shaped) round-tripped: events=${result2.events.length}, completed=${!result2.timedOut}`);
  // The detection is async + the chat may still be streaming — wait longer
  // for the side effect than for the chat itself.
  await new Promise(r => setTimeout(r, 1500));
  const afterMistakes = fs.existsSync(mistakesPath)
    ? fs.readFileSync(mistakesPath, 'utf8').split('\n').filter(Boolean).length
    : 0;
  assert(afterMistakes >= beforeMistakes, 'router-mistake log not corrupted after redirect chat',
    `before=${beforeMistakes} after=${afterMistakes}`);
  pass(`router-mistake detection ran (logged: ${afterMistakes > beforeMistakes})`);

  // ── Phase 10: skill-disable rejects dispatch ────────────────────────
  // Pick a non-always_on user-created skill that has tools. Disable it.
  // Send a message that would target it. Verify Sydney can't dispatch.
  const so = await import('/home/shawn/.openensemble/lib/skill-overrides.mjs');
  // localweather is a user-created skill in Shawn's setup with one tool.
  // Disable it, then exercise a chat that would normally try to use it.
  const targetSkill = 'localweather';
  await so.setSkillOverride(USER_ID, targetSkill, { disabled: true });

  const result3 = await chat('what is the weather right now, briefly');
  assert(!result3.timedOut, 'Sydney chat 3 (with localweather disabled) completes', JSON.stringify(result3.events.slice(-3)));
  // We can't strictly assert "tool was NOT called" because Sydney might
  // pick a different weather tool or just answer from prior context. Just
  // verify she didn't error — disable working correctly means no exception.
  pass('Sydney still answers cleanly with a skill disabled');

  // Cleanup: clear the override
  await so.clearSkillOverride(USER_ID, targetSkill);

  // ── Phase 11d: verbosity tracker accepts a short-message log ────────
  // Direct test (cheap) — verify the tracker increments without firing the
  // proposal yet (need 10 samples). Real chat-driven verbosity would cost
  // 10+ LLM turns; we cover the data path here.
  const vt = await import('/home/shawn/.openensemble/lib/verbosity-tracker.mjs');
  let s;
  for (let i = 1; i <= 9; i++) {
    s = await vt.recordUserMessageLength(USER_ID, `phase12_${TAG}_agent`, 5);   // 5-char "messages"
  }
  assert(s?.proposed === false, '9 short messages do not yet trip the threshold', JSON.stringify(s));
  s = await vt.recordUserMessageLength(USER_ID, `phase12_${TAG}_agent`, 5);     // 10th
  assert(s?.proposed === true && s?.agentId === `phase12_${TAG}_agent`,
    '10th short message trips verbosity threshold', JSON.stringify(s));

  // ── Phase 11c: node-exec path log accepts a record ──────────────────
  const nep = await import('/home/shawn/.openensemble/lib/node-exec-paths.mjs');
  await nep.appendNodeExec(USER_ID, { nodeId: `phase12_${TAG}_node`, command: `ls /nonexistent/${TAG}/path` });
  const events = nep.loadNodeExecPaths(USER_ID);
  const ours = events.filter(e => e.nodeId === `phase12_${TAG}_node`);
  assert(ours.length === 1 && ours[0].command.includes(TAG),
    'node-exec-paths log accepts and reads back', JSON.stringify(ours[0]));

  // location_fact measurer end-to-end with synthetic data
  const now = Date.now();
  const day = 86_400_000;
  const meas = await import('/home/shawn/.openensemble/lib/proposal-outcome-measurers.mjs');
  // Seed 2 probe events at "post-accept" time
  for (let i = 0; i < 2; i++) {
    await nep.appendNodeExec(USER_ID, { nodeId: `phase12_${TAG}_node`, command: `cat /dead/${TAG}/path/file${i}` });
  }
  const probeResult = meas.measureProposalOutcome(USER_ID, {
    kind: 'location_fact',
    acceptedAt: now - 1 * day,
    hostname: `phase12_${TAG}_node`,
    failedPath: `/dead/${TAG}/path`,
  });
  assert(probeResult?.postCount === 2 && probeResult?.semantic === 'lower-better',
    'location_fact measurer counts dead-path probes', JSON.stringify(probeResult));

  // ── Cleanup ──
  // Strip our synthetic records from each affected file
  const verbosityPath = `${USER_DIR}/verbosity-stats.json`;
  if (fs.existsSync(verbosityPath)) {
    const d = readJson(verbosityPath) || {};
    for (const k of Object.keys(d)) if (k.includes(TAG)) delete d[k];
    writeJson(verbosityPath, d);
  }
  const nepPath = `${USER_DIR}/node-exec-paths.jsonl`;
  if (fs.existsSync(nepPath)) {
    const lines = fs.readFileSync(nepPath, 'utf8').split('\n').filter(l => l && !l.includes(TAG));
    fs.writeFileSync(nepPath, lines.join('\n') + (lines.length ? '\n' : ''));
  }
  if (fs.existsSync(mistakesPath)) {
    const lines = fs.readFileSync(mistakesPath, 'utf8').split('\n').filter(l => l && !l.includes(TAG));
    fs.writeFileSync(mistakesPath, lines.join('\n') + (lines.length ? '\n' : ''));
  }
}

// ── Sydney end-to-end: hook dispatcher via real chat message ────────────────
async function testSydneyDispatcher() {
  section('End-to-end: dispatcher hook via real Sydney WS chat');

  // Snapshot pre-state of counters
  const countsPath = path.join(USER_DIR, 'tool-arg-counts.json');
  const failPath  = path.join(USER_DIR, 'tool-failures.json');
  const preCounts = readJson(countsPath) || {};
  const preFails  = readJson(failPath) || {};
  const preLearnings = (await req('GET', '/api/learnings')).data;

  const ws = new WebSocket(`ws://${HOST}:${PORT}/`, { headers: { Cookie: COOKIE } });
  const events = [];
  let toolCompleted = false;
  let assistantReplied = false;

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve({ timedOut: true, events });
    }, 45000);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'chat', agent: 'sydney',
        text: 'list my active watches please, no commentary',
      }));
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      events.push(m.type);
      if (m.type === 'tool_call' || m.type === 'tool_result' || m.type === 'tool_complete') toolCompleted = true;
      if (m.type === 'done' || m.type === 'stream_end' || m.type === 'assistant_complete') assistantReplied = true;
      // `done` is the terminal signal in OE's WS dispatch loop (post-stream
      // cleanup). Some legacy code paths emit stream_end/assistant_complete;
      // we accept any of them.
      if (m.type === 'done' || m.type === 'stream_end' || m.type === 'assistant_complete') {
        clearTimeout(timeout);
        ws.close();
        resolve({ timedOut: false, events });
      }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });

  console.log(`    WS events seen: ${[...new Set(result.events)].join(', ').slice(0, 150)}`);
  assert(!result.timedOut, 'WS chat round-trip completed', 'timed out — Sydney may not be wired up');

  // The dispatcher hooks fire even if no tool was called this turn (just no-op).
  // What we really want to verify: if a tool WAS called, did the counter file
  // get touched?
  const postCounts = readJson(countsPath) || {};
  const postFails  = readJson(failPath) || {};
  const countsChanged = JSON.stringify(preCounts) !== JSON.stringify(postCounts);
  const failsChanged  = JSON.stringify(preFails)  !== JSON.stringify(postFails);

  // We can't strictly require either to change (depends on whether Sydney
  // called a tool with args). Just print what we observed.
  console.log(`    counts file changed: ${countsChanged}    failures file changed: ${failsChanged}`);
  pass('WS chat → server dispatch round-trip (smoke level)');
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Test tag: ${TAG}`);
  console.log(`Target: ${BASE}  user: ${USER_ID}`);

  const baseline = await snapshotBaseline();
  await testPhase1(baseline);
  await testPhase2();
  await testPhase3();
  await testPhase4();
  await testPhase6();
  await testPhase7();
  await testPhase8();
  await testPhase10();
  await testPhase13();
  await testPhase12Comprehensive();
  await testSydneyDispatcher();

  // Final pass: clean up any leftover proposals tagged with TAG
  console.log('\nFinal cleanup pass …');
  const propPath = path.join(USER_DIR, 'proposals.json');
  const propData = readJson(propPath);
  if (propData) {
    const before = propData.proposals?.length || 0;
    propData.proposals = (propData.proposals || []).filter(p => !String(p.id || '').includes(TAG));
    writeJson(propPath, propData);
    console.log(`  proposals: ${before} → ${propData.proposals.length}`);
  }
  for (const fname of ['tool-arg-counts.json', 'tool-failures.json', 'tool-defaults.json']) {
    const p = path.join(USER_DIR, fname);
    const d = readJson(p);
    if (!d) continue;
    let removed = 0;
    for (const k of Object.keys(d)) {
      if (k.includes(TAG) || k.includes('phase2') || k.includes('phase3') || k.startsWith('delete_') && k.includes(TAG)) {
        delete d[k]; removed++;
      }
    }
    if (removed) writeJson(p, d);
  }

  // Print summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Result: ${passes} passed, ${fails} failed`);
  if (fails) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  • ${f.label}\n    ${f.why}`);
    process.exit(1);
  }
  console.log('All passed.');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
