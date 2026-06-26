/**
 * Tests for the corrections-to-rules promotion path (cortex automation #2),
 * along with the per-user rules primitive it depends on.
 *
 * Coverage:
 *   1. paths.userRoleRulesPath / userRoleRulesDir resolve to per-user dir
 *   2. self-mgmt role_add_rule writes to per-user file (NOT global)
 *   3. self-mgmt role_list_rules reads per-user file
 *   4. self-mgmt role_remove_rule modifies per-user file by index
 *   5. proposeRulePromotion creates a kind='rule_promotion' record
 *   6. proposeRulePromotion respects dismissal cooldown
 *   7. acceptProposal kind='rule_promotion' writes the rule line to disk
 *   8. acceptProposal kind='rule_promotion' is idempotent (no duplicate lines)
 *   9. dismissProposal puts ruleText in cooldown so re-propose is blocked
 *
 * Cortex-search side (signals.mjs maybePromoteCorrection) is exercised by
 * unit-mocking the imported helpers; we don't spin up LanceDB here.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  USERS_DIR, SKILLS_DIR, userRoleRulesDir, userRoleRulesPath,
} from '../lib/paths.mjs';

const USER = 'user_corrtorule_test';
const ROLE_ID = 'role_test_role';
const HA_ROLE_ID = 'role_home_assistant';

function dropManifest(skillId, name) {
  const dir = path.join(SKILLS_DIR, skillId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: skillId, name: name ?? skillId, service: true, category: 'custom',
  }));
}

function cleanupUser() {
  const dir = path.join(USERS_DIR, USER);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => {
  cleanupUser();
  // Fresh skill manifest each run so role_add_rule passes the manifest check.
  dropManifest(ROLE_ID, 'Test Role');
});

afterAll(() => {
  cleanupUser();
  const skillDir = path.join(SKILLS_DIR, ROLE_ID);
  if (fs.existsSync(skillDir)) fs.rmSync(skillDir, { recursive: true, force: true });
  const haSkillDir = path.join(SKILLS_DIR, HA_ROLE_ID);
  if (fs.existsSync(haSkillDir)) fs.rmSync(haSkillDir, { recursive: true, force: true });
});

// ── 1. Paths primitive ───────────────────────────────────────────────────────

describe('per-user role-rules paths', () => {
  it('userRoleRulesDir is users/<uid>/role-rules', () => {
    const dir = userRoleRulesDir(USER);
    expect(dir).toBe(path.join(USERS_DIR, USER, 'role-rules'));
  });

  it('userRoleRulesPath is users/<uid>/role-rules/<skillId>.md', () => {
    const p = userRoleRulesPath(USER, 'coder');
    expect(p).toBe(path.join(USERS_DIR, USER, 'role-rules', 'coder.md'));
  });
});

// ── 2-4. self-mgmt rule tools — per-user only ────────────────────────────────

describe('self-mgmt role_add/list/remove_rule writes per-user', () => {
  it('role_add_rule writes to users/<uid>/role-rules/<skillId>.md, not the global skills dir', async () => {
    const { default: execute } = await import('../skills/self-mgmt/execute.mjs');
    const result = await execute('role_add_rule', { roleId: ROLE_ID, rule: 'Never use semicolons' }, USER, 'agent_test');
    expect(result).toMatch(/Rule added to Test Role for your account/);

    const userPath = userRoleRulesPath(USER, ROLE_ID);
    expect(fs.existsSync(userPath)).toBe(true);
    expect(fs.readFileSync(userPath, 'utf8')).toMatch(/- Never use semicolons/);

    // Critical: the global file must NOT have been written.
    const globalPath = path.join(SKILLS_DIR, ROLE_ID, 'rules.md');
    expect(fs.existsSync(globalPath)).toBe(false);
  });

  it('role_list_rules reads from per-user file only', async () => {
    const { default: execute } = await import('../skills/self-mgmt/execute.mjs');
    // Plant a rule in the GLOBAL file — list_rules must NOT see it.
    fs.writeFileSync(path.join(SKILLS_DIR, ROLE_ID, 'rules.md'), '- global rule\n');
    // And one in the per-user file — list_rules must see this one.
    fs.mkdirSync(userRoleRulesDir(USER), { recursive: true });
    fs.writeFileSync(userRoleRulesPath(USER, ROLE_ID), '- user-only rule\n');

    const result = await execute('role_list_rules', { roleId: ROLE_ID }, USER, 'agent_test');
    expect(result).toMatch(/user-only rule/);
    expect(result).not.toMatch(/global rule/);

    fs.unlinkSync(path.join(SKILLS_DIR, ROLE_ID, 'rules.md'));
  });

  it('role_remove_rule modifies per-user file by index', async () => {
    const { default: execute } = await import('../skills/self-mgmt/execute.mjs');
    fs.mkdirSync(userRoleRulesDir(USER), { recursive: true });
    fs.writeFileSync(userRoleRulesPath(USER, ROLE_ID), '- first rule\n- second rule\n- third rule\n');

    const result = await execute('role_remove_rule', { roleId: ROLE_ID, index: 1 }, USER, 'agent_test');
    expect(result).toMatch(/Removed rule.*second rule/);

    const remaining = fs.readFileSync(userRoleRulesPath(USER, ROLE_ID), 'utf8');
    expect(remaining).toMatch(/- first rule/);
    expect(remaining).toMatch(/- third rule/);
    expect(remaining).not.toMatch(/- second rule/);
  });

  it('skill_add_rule resolves owned skill aliases instead of requiring exact ids', async () => {
    dropManifest(HA_ROLE_ID, 'Home Assistant');
    fs.mkdirSync(path.join(USERS_DIR, USER), { recursive: true });
    fs.writeFileSync(path.join(USERS_DIR, USER, 'profile.json'), JSON.stringify({
      id: USER,
      role: 'user',
      skillAssignments: { [HA_ROLE_ID]: 'helen' },
    }, null, 2));
    fs.writeFileSync(path.join(USERS_DIR, USER, 'agents.json'), JSON.stringify([
      { id: 'helen', name: 'Helen', emoji: '🏠', ownerId: USER, toolSet: 'general' },
    ], null, 2));

    const { default: execute } = await import('../skills/self-mgmt/execute.mjs');
    const cases = [
      ['home_assistant', 'Follow up after mode changes'],
      ['ha', 'Verify mode actually changed'],
      ['Home Assistant', 'Report failed mode changes'],
      ['Helen', 'Tell the user if the target is unavailable'],
    ];
    for (const [skillId, rule] of cases) {
      const result = await execute('skill_add_rule', { skillId, rule }, USER, 'helen');
      expect(result).toMatch(/Rule added to Home Assistant/);
    }

    const rules = fs.readFileSync(userRoleRulesPath(USER, HA_ROLE_ID), 'utf8');
    expect(rules).toMatch(/Follow up after mode changes/);
    expect(rules).toMatch(/Verify mode actually changed/);
    expect(rules).toMatch(/Report failed mode changes/);
    expect(rules).toMatch(/Tell the user if the target is unavailable/);
  });
});

// ── 5-9. proposeRulePromotion + acceptProposal kind='rule_promotion' ─────────

describe('rule_promotion proposal lifecycle', () => {
  it('proposeRulePromotion creates a record with kind="rule_promotion" and the role payload', async () => {
    const { proposeRulePromotion, getProposal } = await import('../lib/proposals.mjs');
    const rec = await proposeRulePromotion({
      userId: USER,
      agentId: 'agent_test',
      roleId: ROLE_ID,
      roleName: 'Test Role',
      ruleText: 'Never use semicolons',
      sourceCorrectionIds: ['mem_a', 'mem_b'],
    });
    expect(rec).toBeTruthy();
    expect(rec.kind).toBe('rule_promotion');
    expect(rec.ruleText).toBe('Never use semicolons');
    expect(rec.roleId).toBe(ROLE_ID);
    expect(rec.roleName).toBe('Test Role');
    expect(rec.sourceCorrectionIds).toEqual(['mem_a', 'mem_b']);
    expect(rec.accept_label).toMatch(/Add as a rule for Test Role/);

    // getProposal returns the same record by id.
    const fetched = getProposal(rec.id);
    expect(fetched?.id).toBe(rec.id);

    // Persisted to disk so the bubble survives a restart.
    const persistPath = path.join(USERS_DIR, USER, 'proposals.json');
    expect(fs.existsSync(persistPath)).toBe(true);
  });

  it('acceptProposal kind="rule_promotion" writes the rule line to the user rules file', async () => {
    const { proposeRulePromotion, acceptProposal, getProposal } = await import('../lib/proposals.mjs');
    const rec = await proposeRulePromotion({
      userId: USER, agentId: 'agent_test', roleId: ROLE_ID,
      roleName: 'Test Role', ruleText: 'Always use 4-space indents',
    });
    const accepted = await acceptProposal(rec.id);
    expect(accepted.ok).toBe(true);

    // runRulePromotion is fired async — wait briefly for it to finish writing.
    await new Promise(r => setTimeout(r, 100));

    const userPath = userRoleRulesPath(USER, ROLE_ID);
    expect(fs.existsSync(userPath)).toBe(true);
    expect(fs.readFileSync(userPath, 'utf8')).toMatch(/- Always use 4-space indents/);

    // Status flipped to accepted.
    const final = getProposal(rec.id);
    expect(final.status).toBe('accepted');
  });

  it('acceptProposal kind="rule_promotion" is idempotent (the same rule does not duplicate)', async () => {
    const { proposeRulePromotion, acceptProposal } = await import('../lib/proposals.mjs');

    // Seed an existing matching rule.
    fs.mkdirSync(userRoleRulesDir(USER), { recursive: true });
    fs.writeFileSync(userRoleRulesPath(USER, ROLE_ID), '- Use tabs\n- No trailing whitespace\n');

    const rec = await proposeRulePromotion({
      userId: USER, agentId: 'agent_test', roleId: ROLE_ID,
      roleName: 'Test Role', ruleText: 'Use tabs',
    });
    await acceptProposal(rec.id);
    await new Promise(r => setTimeout(r, 100));

    const lines = fs.readFileSync(userRoleRulesPath(USER, ROLE_ID), 'utf8')
      .split('\n').map(l => l.trim()).filter(Boolean);
    const tabsHits = lines.filter(l => l === '- Use tabs');
    expect(tabsHits.length).toBe(1);
  });

  it('dismissProposal puts the ruleText in cooldown so re-propose returns null', async () => {
    const { proposeRulePromotion, dismissProposal } = await import('../lib/proposals.mjs');

    const first = await proposeRulePromotion({
      userId: USER, agentId: 'agent_test', roleId: ROLE_ID,
      roleName: 'Test Role', ruleText: 'No console.log in committed code',
    });
    expect(first).toBeTruthy();

    const dismissed = await dismissProposal(first.id);
    expect(dismissed.ok).toBe(true);

    // Re-propose with the same ruleText should be suppressed by the cooldown.
    const second = await proposeRulePromotion({
      userId: USER, agentId: 'agent_test', roleId: ROLE_ID,
      roleName: 'Test Role', ruleText: 'No console.log in committed code',
    });
    expect(second).toBeNull();

    // A different ruleText still goes through.
    const third = await proposeRulePromotion({
      userId: USER, agentId: 'agent_test', roleId: ROLE_ID,
      roleName: 'Test Role', ruleText: 'Always use TypeScript strict mode',
    });
    expect(third).toBeTruthy();
  });
});
