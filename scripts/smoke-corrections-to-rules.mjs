#!/usr/bin/env node
/**
 * Smoke test for cortex automation #2 (corrections-to-rules promotion).
 *
 * Bypasses the chat path and the cortex signals classifier — directly seeds
 * two CORRECTION rows in an agent's _params table via the production
 * remember() helper, then invokes maybePromoteCorrection() and inspects
 * whether a kind='rule_promotion' proposal was created.
 *
 * Proves: real LanceDB embeddings + vector search + similarity threshold +
 * proposal creation all work end-to-end. Does NOT prove: cortex signals head
 * classifies user messages as corrections (that needs real chat with model
 * loaded — Path 2 in the manual smoke).
 *
 * Usage:
 *   node scripts/smoke-corrections-to-rules.mjs --user-id <uid> --agent-id <aid>
 *   # optional: --role-id <id>  (default 'coder' — must be a service role)
 *
 * The server should be STOPPED while running this — concurrent writes to
 * config.json (role assignments) would race. Cortex models load lazily, so
 * the first embed call takes a few seconds.
 *
 * Cleanup is best-effort: forgets the two seeded correction rows, dismisses
 * the created proposal (so it doesn't loiter in proposals.json), and
 * restores the role assignment to whatever it was before. Rerunnable.
 */

import fs from 'fs';
import { remember } from '../memory/lance.mjs';
import { forget } from '../memory/recall.mjs';
import { maybePromoteCorrection } from '../memory/signals.mjs';
import {
  loadRoleManifests, getRoleAssignments, getRoleAssignment, setRoleAssignment, getRoleManifest,
} from '../roles.mjs';
import {
  listUserProposals, dismissProposal, acceptProposal, getProposal,
} from '../lib/proposals.mjs';
import { userRoleRulesPath } from '../lib/paths.mjs';

// The roles registry (_manifests) is populated lazily — server.mjs calls
// loadRoleManifests() at boot. As a standalone script we have to do it
// ourselves or every getRoleManifest() returns null.
loadRoleManifests();

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    out[k] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv);
const USER_ID  = args['user-id'];
const AGENT_ID = args['agent-id'];
const ROLE_ID  = args['role-id'] ?? 'coder';

if (!USER_ID || !AGENT_ID) {
  console.error('Usage: node scripts/smoke-corrections-to-rules.mjs --user-id <uid> --agent-id <aid> [--role-id coder]');
  process.exit(2);
}

const SEED_TEXT_1 = 'CORRECTION: Never use semicolons in JavaScript code.';
const SEED_TEXT_2 = 'CORRECTION: No semicolons in JS please, drop them.';

function logStep(n, msg) { console.log(`\n[step ${n}] ${msg}`); }
function logResult(label, ok, extra = '') {
  const tag = ok ? '✓' : '✗';
  console.log(`  ${tag} ${label}${extra ? ' — ' + extra : ''}`);
}

let savedRoleOwner = null;
let seededIds = [];
let createdProposal = null;
let rulesFilePath = null;
let rulesFileExistedBefore = false;

async function cleanup() {
  console.log('\n— cleanup —');

  // Soft-delete the seeded correction rows so they don't pollute real recall.
  for (const id of seededIds) {
    try {
      const r = await forget({ agentId: AGENT_ID, type: 'params', exactId: id, userId: USER_ID });
      console.log(`  forgot ${id}: ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`  forget ${id} failed: ${e.message}`);
    }
  }

  // Dismiss the proposal if it's still pending. If we already accepted it,
  // dismiss returns "already accepted" — that's a no-op. Either way the
  // record stays in proposals.json (accepted/dismissed proposals don't
  // auto-prune from disk). For the smoke we want a zero-footprint run, so
  // we surgically remove the test record from disk afterwards.
  if (createdProposal?.id) {
    try {
      const r = await dismissProposal(createdProposal.id);
      console.log(`  dismiss attempt ${createdProposal.id}: ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`  dismiss failed: ${e.message}`);
    }
    try {
      const path = (await import('path')).default;
      const { USERS_DIR } = await import('../lib/paths.mjs');
      const pPath = path.join(USERS_DIR, USER_ID, 'proposals.json');
      if (fs.existsSync(pPath)) {
        const data = JSON.parse(fs.readFileSync(pPath, 'utf8'));
        const before = (data.proposals || []).length;
        data.proposals = (data.proposals || []).filter(r => r.id !== createdProposal.id);
        if (data.proposals.length !== before) {
          fs.writeFileSync(pPath, JSON.stringify(data, null, 2));
          console.log(`  pruned test record from proposals.json`);
        }
      }
    } catch (e) {
      console.log(`  proposals.json prune failed: ${e.message}`);
    }
  }

  // If the rule file didn't exist before but does now, this script created
  // it via the accept path — remove our line (or the whole file if empty).
  if (rulesFilePath && !rulesFileExistedBefore && fs.existsSync(rulesFilePath)) {
    try {
      fs.unlinkSync(rulesFilePath);
      console.log(`  removed rules file ${rulesFilePath} (script-created)`);
    } catch (e) {
      console.log(`  rules file cleanup failed: ${e.message}`);
    }
  }

  // Restore role assignment to whatever it was before (null if nobody owned it).
  try {
    setRoleAssignment(ROLE_ID, savedRoleOwner ?? null, USER_ID);
    console.log(`  restored role ${ROLE_ID} → ${savedRoleOwner ?? '(unassigned)'}`);
  } catch (e) {
    console.log(`  restore role assignment failed: ${e.message}`);
  }
}

async function main() {
  console.log(`smoke-corrections-to-rules`);
  console.log(`  user:  ${USER_ID}`);
  console.log(`  agent: ${AGENT_ID}`);
  console.log(`  role:  ${ROLE_ID}`);

  // ── Setup: ensure the agent holds exactly one service role ─────────────────
  logStep(1, `assigning role "${ROLE_ID}" to agent ${AGENT_ID}`);
  const manifest = getRoleManifest(ROLE_ID, USER_ID);
  if (!manifest) {
    console.error(`  role "${ROLE_ID}" not found — pick one from: ${Object.keys(getRoleAssignments(USER_ID)).join(', ')}`);
    process.exit(3);
  }
  if (!manifest.service) {
    console.error(`  role "${ROLE_ID}" exists but is not a service role — promotion only fires for service roles`);
    process.exit(3);
  }
  savedRoleOwner = getRoleAssignment(ROLE_ID, USER_ID);
  setRoleAssignment(ROLE_ID, AGENT_ID, USER_ID);
  logResult('role assigned', true, savedRoleOwner ? `previously owned by ${savedRoleOwner}` : 'was unassigned');

  // ── Seed two similar CORRECTION rows ───────────────────────────────────────
  logStep(2, 'seeding correction #1 (real embedding via cortex — first call may take a few seconds)');
  const rec1 = await remember({
    agentId: AGENT_ID, type: 'params', source: 'correction',
    confidence: 0.99, text: SEED_TEXT_1,
    metadata: { category: 'correction' }, userId: USER_ID,
  });
  if (!rec1?.id) {
    console.error('  correction #1 store failed');
    await cleanup();
    process.exit(4);
  }
  seededIds.push(rec1.id);
  logResult(`stored ${rec1.id}`, true, SEED_TEXT_1);

  // Brief pause so the second store doesn't dedup against the first via the
  // 0.05 threshold. Different wording should clear that bar but the LanceDB
  // queued write needs a moment to flush.
  await new Promise(r => setTimeout(r, 300));

  logStep(3, 'seeding correction #2 (similar wording)');
  const rec2 = await remember({
    agentId: AGENT_ID, type: 'params', source: 'correction',
    confidence: 0.99, text: SEED_TEXT_2,
    metadata: { category: 'correction' }, userId: USER_ID,
  });
  if (!rec2?.id) {
    console.error('  correction #2 store failed');
    await cleanup();
    process.exit(5);
  }
  // If dedup hit, the returned record IS the original — that's an interesting
  // signal too (means our threshold is wrong or the wording is too close).
  if (rec2._dedupHit) {
    console.warn('  ⚠ correction #2 returned as dedup-hit against #1 — vector distance < 0.05.');
    console.warn('    For a real promotion test, corrections must have wording diverse enough to');
    console.warn('    survive write-time dedup but similar enough to match at the 0.12 threshold.');
  }
  seededIds.push(rec2.id);
  logResult(`stored ${rec2.id}`, true, SEED_TEXT_2);

  // ── Invoke production code path ────────────────────────────────────────────
  logStep(4, 'calling maybePromoteCorrection (production path) with correction #2');
  const promoted = await maybePromoteCorrection({
    agentId: AGENT_ID,
    userId: USER_ID,
    correctionRecord: rec2,
    correctionText: SEED_TEXT_2.replace(/^CORRECTION:\s*/, ''),
  });

  if (!promoted) {
    logResult('proposal NOT created', false);
    console.log(`
This means one of:
  - cortex search found no prior correction within distance < 0.12
    (try wording the seeds even closer — same phrasing with paraphrase)
  - the seeded #1 was deduped against #2 (check dedup-hit warning above)
  - the agent doesn't hold exactly one service role (check role assignment)
  - role lookup failed for "${ROLE_ID}"
`);
    await cleanup();
    process.exit(1);
  }

  createdProposal = promoted;
  logResult('proposal created', true, promoted.id);

  // ── Verify the record shape ────────────────────────────────────────────────
  logStep(5, 'verifying proposal record fields');
  const checks = [
    ['kind === rule_promotion', promoted.kind === 'rule_promotion'],
    ['carries roleId', promoted.roleId === ROLE_ID],
    ['carries roleName', !!promoted.roleName],
    ['carries ruleText', typeof promoted.ruleText === 'string' && promoted.ruleText.length > 0],
    ['status pending',  promoted.status === 'pending'],
    ['accept_label set', !!promoted.accept_label],
    ['source ids reference both seeded rows', Array.isArray(promoted.sourceCorrectionIds)
      && promoted.sourceCorrectionIds.includes(rec1.id)
      && promoted.sourceCorrectionIds.includes(rec2.id)],
  ];
  let allPass = true;
  for (const [label, ok] of checks) { logResult(label, ok); allPass &&= ok; }

  // ── Confirm it's discoverable via listUserProposals ────────────────────────
  logStep(6, 'listing pending proposals for user');
  const pending = listUserProposals(USER_ID, 'pending');
  const found = pending.find(p => p.id === promoted.id);
  logResult('proposal appears in listUserProposals', !!found);

  // ── Exercise the accept path → rule file write ────────────────────────────
  logStep(7, 'calling acceptProposal — runRulePromotion should write the user rules file');
  rulesFilePath = userRoleRulesPath(USER_ID, ROLE_ID);
  rulesFileExistedBefore = fs.existsSync(rulesFilePath);
  const ruleLineExpected = `- ${promoted.ruleText.trim()}`;

  const accepted = await acceptProposal(promoted.id);
  if (!accepted.ok) {
    console.error(`  accept failed: ${JSON.stringify(accepted)}`);
    await cleanup();
    process.exit(7);
  }
  logResult('acceptProposal returned ok', accepted.status === 'running');

  // runRulePromotion is fired async via .catch() in acceptProposal — poll the
  // status flip with a tight timeout so we don't hang if something throws.
  const deadline = Date.now() + 3000;
  let finalStatus;
  while (Date.now() < deadline) {
    finalStatus = getProposal(promoted.id)?.status;
    if (finalStatus && finalStatus !== 'running') break;
    await new Promise(r => setTimeout(r, 50));
  }
  logResult('status flipped to accepted', finalStatus === 'accepted', `final status: ${finalStatus}`);

  logStep(8, 'verifying rule file content');
  const fileExists = fs.existsSync(rulesFilePath);
  logResult('user rules file exists', fileExists, rulesFilePath);
  let fileHasLine = false;
  if (fileExists) {
    const content = fs.readFileSync(rulesFilePath, 'utf8');
    fileHasLine = content.includes(ruleLineExpected);
    logResult('rule line present', fileHasLine, ruleLineExpected);
  }

  const acceptAllPass = (finalStatus === 'accepted') && fileExists && fileHasLine;

  console.log('\n— summary —');
  console.log(`  proposal id:    ${promoted.id}`);
  console.log(`  rule text:      "${promoted.ruleText}"`);
  console.log(`  role:           ${promoted.roleName} (${promoted.roleId})`);
  console.log(`  source rows:    ${(promoted.sourceCorrectionIds || []).join(', ')}`);
  console.log(`  rules file:     ${rulesFilePath}`);
  console.log(`  final status:   ${finalStatus}`);
  console.log(`  rule applied:   ${fileHasLine ? 'yes' : 'no'}`);

  await cleanup();
  process.exit(allPass && found && acceptAllPass ? 0 : 1);
}

main().catch(async e => {
  console.error('\nsmoke crashed:', e.stack || e.message);
  await cleanup().catch(() => {});
  process.exit(99);
});
