/**
 * Tests for per-skill telemetry + trigger-phrase accumulation +
 * skill_deprecation proposal flow.
 *
 * Coverage:
 *   1. recordToolInvocations bumps counters for tools listed in a user-skill manifest
 *   2. recordToolInvocations ignores tools not owned by any user skill
 *   3. recordCorrection attributes to the MOST RECENT skill invocation
 *   4. recordCorrection resets the buffer (no double-attribution to other skills)
 *   5. recordCorrection emits proposeSkillDeprecation past threshold (5 invocations, 50% corrections)
 *   6. skill_deprecation proposal is suppressed once already proposed for that skill
 *   7. Triggers: appendTrigger writes the seed + dedups + caps at MAX_TRIGGERS
 *   8. Triggers: getAllUserTriggers returns the per-skill map
 *   9. Triggers: appendTrigger is a no-op when the skill dir doesn't exist
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR, userSkillsDir } from '../lib/paths.mjs';
import {
  recordToolInvocations, recordCorrection, getSkillStats, resetAfterRefine, _resetForTests,
} from '../lib/skill-telemetry.mjs';
import { readLog, appendEntry } from '../lib/skill-improvement-log.mjs';
import {
  appendTrigger, loadTriggers, getAllUserTriggers,
} from '../lib/skill-triggers.mjs';
import { listUserProposals, getProposal, dismissProposal } from '../lib/proposals.mjs';

const USER = 'user_skilltel_test';
const SKILL_A = 'usr_emailflow';
const SKILL_B = 'usr_reportflow';

function cleanupUser() {
  const dir = path.join(USERS_DIR, USER);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function dropManifest(skillId, tools) {
  const dir = path.join(userSkillsDir(USER), skillId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: skillId, name: skillId, custom: true, createdBy: USER,
    tools: tools.map(name => ({ type: 'function', function: { name } })),
  }));
}

beforeEach(() => {
  cleanupUser();
  _resetForTests();
  // Clear any test proposals left from prior tests so listUserProposals is clean.
  for (const p of listUserProposals(USER, null)) {
    p.status = 'cleared_for_test';
  }
});

afterAll(() => cleanupUser());

// ── 1-2. Invocation counters ────────────────────────────────────────────────

describe('recordToolInvocations', () => {
  it('bumps counters for tools listed in a user-skill manifest', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    recordToolInvocations({
      userId: USER,
      toolsUsed: [
        { name: 'emailflow_run' },
        { name: 'emailflow_run' }, // 2 invocations same turn
        { name: 'web_search' },   // not a user-skill tool
      ],
    });
    // Persistence is async — give it a tick.
    await new Promise(r => setTimeout(r, 50));
    const stats = getSkillStats(USER);
    expect(stats[SKILL_A]?.invocations).toBe(2);
    expect(stats['web_search']).toBeUndefined();
  });

  it('ignores tools not owned by any user skill', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    recordToolInvocations({
      userId: USER,
      toolsUsed: [{ name: 'list_tasks' }, { name: 'create_task' }],
    });
    await new Promise(r => setTimeout(r, 50));
    const stats = getSkillStats(USER);
    expect(stats[SKILL_A]).toBeUndefined();
  });
});

// ── 3-6. Correction attribution + auto-deprecate ────────────────────────────

describe('recordCorrection', () => {
  it('attributes to the most recent skill invocation', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    dropManifest(SKILL_B, ['reportflow_run']);

    // Invoke A, then B. The correction should land on B (most recent).
    recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
    recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'reportflow_run' }] });

    await recordCorrection({ userId: USER, agentId: 'agent_x' });
    await new Promise(r => setTimeout(r, 50));

    const stats = getSkillStats(USER);
    expect(stats[SKILL_B]?.corrections).toBe(1);
    expect(stats[SKILL_A]?.corrections ?? 0).toBe(0);
  });

  it('resets the buffer after attribution (no double-counting)', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
    await recordCorrection({ userId: USER });
    await recordCorrection({ userId: USER }); // second one should find empty buffer
    await new Promise(r => setTimeout(r, 50));

    const stats = getSkillStats(USER);
    expect(stats[SKILL_A]?.corrections).toBe(1);
  });

  it('emits a skill_deprecation proposal once invocations≥5 and corrections/invocations≥0.5', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);

    // 5 invocations + 3 corrections → ratio 0.6, past threshold.
    for (let i = 0; i < 5; i++) {
      recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
      if (i < 2) await recordCorrection({ userId: USER });
    }
    // One more correction to trigger the proposal (now 3/5 = 0.6).
    const proposal = await recordCorrection({ userId: USER });
    await new Promise(r => setTimeout(r, 50));

    expect(proposal).toBeTruthy();
    expect(proposal.kind).toBe('skill_deprecation');
    expect(proposal.skillId).toBe(SKILL_A);
    expect(proposal.accept_label).toMatch(/Delete usr_emailflow/);

    // Persisted to disk like every other kind.
    const persistPath = path.join(USERS_DIR, USER, 'proposals.json');
    expect(fs.existsSync(persistPath)).toBe(true);
  });

  it('does not re-propose deprecation after the first time, even on more corrections', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    for (let i = 0; i < 5; i++) {
      recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
      if (i < 3) await recordCorrection({ userId: USER });
    }
    const firstProposal = await recordCorrection({ userId: USER });
    expect(firstProposal?.kind).toBe('skill_deprecation');

    // Drive ratio even higher. deprecationProposedAt stamp must block.
    recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
    const second = await recordCorrection({ userId: USER });
    expect(second).toBeNull();
  });
});

// ── 7-9. Trigger phrases ────────────────────────────────────────────────────

describe('skill triggers', () => {
  it('appendTrigger writes the seed phrase and dedups exact lowercase repeats', () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    expect(appendTrigger(USER, SKILL_A, 'send the weekly report to sam')).toBe(true);
    expect(appendTrigger(USER, SKILL_A, 'Send the Weekly Report to Sam')).toBe(false); // dedup
    expect(appendTrigger(USER, SKILL_A, 'mail sam the report')).toBe(true);

    const list = loadTriggers(USER, SKILL_A);
    expect(list.map(t => t.phrase)).toEqual([
      'send the weekly report to sam',
      'mail sam the report',
    ]);
  });

  it('caps the list at the configured max (most-recent kept)', () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    for (let i = 0; i < 15; i++) appendTrigger(USER, SKILL_A, `phrase number ${i}`);
    const list = loadTriggers(USER, SKILL_A);
    expect(list.length).toBe(10);
    // Most recent (phrase 14) must be present; oldest (phrase 0) must be gone.
    expect(list[list.length - 1].phrase).toBe('phrase number 14');
    expect(list.find(t => t.phrase === 'phrase number 0')).toBeUndefined();
  });

  it('getAllUserTriggers returns the per-skill map', () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    dropManifest(SKILL_B, ['reportflow_run']);
    appendTrigger(USER, SKILL_A, 'email sam');
    appendTrigger(USER, SKILL_B, 'build the report');

    const all = getAllUserTriggers(USER);
    expect(all[SKILL_A]).toEqual(['email sam']);
    expect(all[SKILL_B]).toEqual(['build the report']);
  });

  it('appendTrigger is a no-op when the skill dir does not exist', () => {
    expect(appendTrigger(USER, 'usr_does_not_exist', 'whatever')).toBe(false);
    // No file was created.
    const orphan = path.join(userSkillsDir(USER), 'usr_does_not_exist', 'triggers.json');
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

// ── Refine proposal — mid-zone (20-50% corrections, min 3 invocations) ──────

describe('refine proposal mid-zone', () => {
  it('emits a skill_refine proposal when ratio enters [0.20, 0.50) past 3 invocations', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);

    // 4 invocations + 1 correction (with text) = 25% → mid-zone.
    for (let i = 0; i < 4; i++) {
      recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
    }
    const proposal = await recordCorrection({
      userId: USER, agentId: 'agent_x',
      correctionText: 'the email body needs a P.S.',
    });
    await new Promise(r => setTimeout(r, 50));

    expect(proposal).toBeTruthy();
    expect(proposal.kind).toBe('skill_refine');
    expect(proposal.skillId).toBe(SKILL_A);
    expect(proposal.invocations).toBe(4);
    expect(proposal.corrections).toBe(1);
    expect(proposal.recentCorrections).toEqual(['the email body needs a P.S.']);
    expect(proposal.accept_label).toMatch(/Refine usr_emailflow/);
  });

  it('stores recentCorrections on the skill so the proposer can read them', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    for (let i = 0; i < 4; i++) {
      recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
    }
    await recordCorrection({ userId: USER, correctionText: 'first issue here' });
    await new Promise(r => setTimeout(r, 30));

    const stats = getSkillStats(USER);
    expect(stats[SKILL_A]?.recentCorrections).toHaveLength(1);
    expect(stats[SKILL_A]?.recentCorrections[0].text).toBe('first issue here');
  });

  it('does NOT fire refine in the deprecation zone (ratio >= 0.5)', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    // 5 invocations + 3 corrections = 60% → deprecation, not refine.
    for (let i = 0; i < 5; i++) {
      recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
      if (i < 2) await recordCorrection({ userId: USER, correctionText: `c${i}` });
    }
    const proposal = await recordCorrection({ userId: USER, correctionText: 'c2' });
    expect(proposal?.kind).toBe('skill_deprecation');
  });

  it('does NOT fire refine in the fine zone (ratio < 0.20)', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    // 10 invocations + 1 correction = 10% → fine, no proposal.
    for (let i = 0; i < 10; i++) {
      recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
    }
    const proposal = await recordCorrection({ userId: USER, correctionText: 'small nit' });
    expect(proposal).toBeNull();
  });

  it('refineProposedAt blocks re-fire even when more corrections accumulate', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    for (let i = 0; i < 4; i++) {
      recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
    }
    const first = await recordCorrection({ userId: USER, correctionText: 'first' });
    expect(first?.kind).toBe('skill_refine');

    // Another invocation + correction. We're at 5 inv / 2 corr = 40% still
    // mid-zone, but refineProposedAt should block.
    recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
    const second = await recordCorrection({ userId: USER, correctionText: 'second' });
    expect(second).toBeNull();
  });

  it('resetAfterRefine clears counters + recentCorrections + refineProposedAt', async () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    for (let i = 0; i < 4; i++) {
      recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
    }
    await recordCorrection({ userId: USER, correctionText: 'pre-reset' });

    await resetAfterRefine({ userId: USER, skillId: SKILL_A });
    await new Promise(r => setTimeout(r, 30));

    const stats = getSkillStats(USER);
    expect(stats[SKILL_A].invocations).toBe(0);
    expect(stats[SKILL_A].corrections).toBe(0);
    expect(stats[SKILL_A].recentCorrections).toEqual([]);
    expect(stats[SKILL_A].refineProposedAt).toBe(0);

    // After reset, refine can fire again on a fresh round of corrections.
    for (let i = 0; i < 4; i++) {
      recordToolInvocations({ userId: USER, toolsUsed: [{ name: 'emailflow_run' }] });
    }
    const next = await recordCorrection({ userId: USER, correctionText: 'post-reset' });
    expect(next?.kind).toBe('skill_refine');
  });
});

// ── Improvement log ─────────────────────────────────────────────────────────

describe('skill improvement log', () => {
  it('appendEntry writes an entry and readLog returns it', () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    const entry = appendEntry(USER, SKILL_A, {
      kind: 'created', summary: 'Created with 1 tool: emailflow_run',
    });
    expect(entry).toBeTruthy();
    expect(entry.kind).toBe('created');

    const log = readLog(USER, SKILL_A);
    expect(log).toHaveLength(1);
    expect(log[0].summary).toMatch(/Created with 1 tool/);
    expect(typeof log[0].ts).toBe('number');
  });

  it('caps at 50 entries (oldest dropped)', () => {
    dropManifest(SKILL_A, ['emailflow_run']);
    for (let i = 0; i < 60; i++) {
      appendEntry(USER, SKILL_A, { kind: 'manual_patch', summary: `entry ${i}` });
    }
    const log = readLog(USER, SKILL_A);
    expect(log.length).toBe(50);
    expect(log[log.length - 1].summary).toBe('entry 59');
    expect(log.find(e => e.summary === 'entry 0')).toBeUndefined();
  });

  it('is a no-op when the skill dir does not exist (no orphan file)', () => {
    const out = appendEntry(USER, 'usr_does_not_exist', { kind: 'created', summary: 'ghost' });
    expect(out).toBeNull();
    const orphan = path.join(userSkillsDir(USER), 'usr_does_not_exist', 'improvement-log.json');
    expect(fs.existsSync(orphan)).toBe(false);
  });
});
