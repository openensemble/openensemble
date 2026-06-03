/**
 * Tests for the auto-skill proposer (Hermes-inspired learning loop) +
 * defer-until-next-turn correction guard.
 *
 * Coverage:
 *   1. toolsetKey is order-insensitive and dedups by name
 *   2. maybeProposeSkill returns null below MIN_TOOLS (no candidate stashed)
 *   3. maybeProposeSkill returns null when ONLY mutation/skill-builder tools fired
 *   4. maybeProposeSkill returns null when any skill_* tool fired this turn
 *   5. maybeProposeSkill returns null on destructive verb in user message
 *   6. maybeProposeSkill stashes a candidate on a qualifying turn (no proposal yet)
 *   7. flushPendingSkillCandidate emits the proposal on a non-corrective follow-up
 *   8. flushPendingSkillCandidate DROPS the candidate on a corrective follow-up
 *   9. flushPendingSkillCandidate returns null when nothing is stashed
 *  10. Per-agent 7-day rate limit suppresses a second stash
 *  11. proposeSkill is suppressed by dismiss cooldown keyed on toolsKey
 *  12. cooldown matches by sorted-tool-set hash, NOT by message preamble
 *
 * The runSkillProposal accept path needs a live agent + LLM and is exercised
 * by integration testing in a running install, not here.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import {
  maybeProposeSkill, flushPendingSkillCandidate, toolsetKey, _resetForTests,
} from '../lib/skill-proposer.mjs';
import {
  proposeSkill, getProposal, dismissProposal, listUserProposals,
} from '../lib/proposals.mjs';

const USER = 'user_skillprop_test';
const AGENT = 'agent_skillprop_test';

function cleanupUser() {
  const dir = path.join(USERS_DIR, USER);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => {
  cleanupUser();
  _resetForTests();
  for (const p of listUserProposals(USER, null)) {
    p.status = 'cleared_for_test';
  }
});

afterAll(() => cleanupUser());

const baseTools = [
  { name: 'web_search', text: 'ok' },
  { name: 'fetch_url',  text: 'ok' },
  { name: 'send_email', text: 'ok' },
  { name: 'schedule_task', text: 'ok' },
];

// ── 1. toolsetKey shape ──────────────────────────────────────────────────────

describe('toolsetKey', () => {
  it('is order-insensitive and dedups by name', () => {
    const k1 = toolsetKey([{ name: 'web_search' }, { name: 'send_email' }, { name: 'web_search' }]);
    const k2 = toolsetKey([{ name: 'send_email' }, { name: 'web_search' }]);
    expect(k1).toBe(k2);
    expect(k1).toBe('send_email,web_search');
  });

  it('returns empty string for empty input', () => {
    expect(toolsetKey([])).toBe('');
    expect(toolsetKey(null)).toBe('');
  });
});

// ── 2-6. Detector gates ──────────────────────────────────────────────────────

describe('maybeProposeSkill — gates', () => {
  it('returns null below MIN_TOOLS=4 interesting tools', async () => {
    const res = await maybeProposeSkill({
      userId: USER, agentId: AGENT, agentName: 'A',
      userMessage: 'do a thing', assistantContent: 'done',
      toolsUsed: baseTools.slice(0, 3),
    });
    expect(res).toBeNull();
  });

  it('returns null when only memory/rule mutation tools fired', async () => {
    const res = await maybeProposeSkill({
      userId: USER, agentId: AGENT, agentName: 'A',
      userMessage: 'remember some stuff', assistantContent: 'done',
      toolsUsed: [
        { name: 'remember_fact', text: 'ok' },
        { name: 'forget_fact',   text: 'ok' },
        { name: 'role_add_rule', text: 'ok' },
        { name: 'role_remove_rule', text: 'ok' },
      ],
    });
    expect(res).toBeNull();
  });

  it('returns null when any skill_* tool fired (already authoring)', async () => {
    const res = await maybeProposeSkill({
      userId: USER, agentId: AGENT, agentName: 'A',
      userMessage: 'make a skill that does X', assistantContent: 'done',
      toolsUsed: [
        ...baseTools,
        { name: 'skill_create', text: 'ok' },
      ],
    });
    expect(res).toBeNull();
  });

  it('returns null on destructive verb in user message', async () => {
    const res = await maybeProposeSkill({
      userId: USER, agentId: AGENT, agentName: 'A',
      userMessage: 'delete all the old logs', assistantContent: 'done',
      toolsUsed: baseTools,
    });
    expect(res).toBeNull();
  });

  it('stashes a candidate on a qualifying turn (no proposal yet)', async () => {
    const res = await maybeProposeSkill({
      userId: USER, agentId: AGENT, agentName: 'Coder',
      userMessage: 'research X then email Sam',
      assistantContent: 'Done.',
      toolsUsed: baseTools,
    });
    expect(res).toEqual({ stashed: true, agentId: AGENT });

    // Critically: NO proposal record exists yet. The bubble waits for the
    // next-turn correction guard to either emit or drop it.
    const pending = listUserProposals(USER);
    expect(pending).toEqual([]);
  });

  it('enforces a per-agent rate limit (7 days) — second stash is dropped', async () => {
    // Stash + flush the first candidate so the rate-limit timer arms.
    const first = await maybeProposeSkill({
      userId: USER, agentId: AGENT, agentName: 'Coder',
      userMessage: 'one workflow', assistantContent: 'done',
      toolsUsed: baseTools,
    });
    expect(first).toEqual({ stashed: true, agentId: AGENT });
    const emitted = await flushPendingSkillCandidate({
      agentId: AGENT, currentUserMessage: 'thanks, that was great!',
    });
    expect(emitted).toBeTruthy();
    expect(emitted.kind).toBe('skill_proposal');

    // A different tool combo so cooldown wouldn't fire — but rate cap should.
    const second = await maybeProposeSkill({
      userId: USER, agentId: AGENT, agentName: 'Coder',
      userMessage: 'a different workflow', assistantContent: 'done',
      toolsUsed: [
        { name: 'list_tasks',  text: 'ok' },
        { name: 'create_task', text: 'ok' },
        { name: 'update_task', text: 'ok' },
        { name: 'mark_done',   text: 'ok' },
      ],
    });
    expect(second).toBeNull();
  });
});

// ── 7-9. Defer-until-next-turn correction guard ──────────────────────────────

describe('flushPendingSkillCandidate', () => {
  it('emits the proposal on a non-corrective follow-up', async () => {
    await maybeProposeSkill({
      userId: USER, agentId: AGENT, agentName: 'Coder',
      userMessage: 'research X', assistantContent: 'done',
      toolsUsed: baseTools,
    });
    const res = await flushPendingSkillCandidate({
      agentId: AGENT, currentUserMessage: 'thanks, can you also schedule it?',
    });
    expect(res).toBeTruthy();
    expect(res.kind).toBe('skill_proposal');
    expect(res.status).toBe('pending');
    expect(res.toolNames).toEqual(expect.arrayContaining([
      'web_search', 'fetch_url', 'send_email', 'schedule_task',
    ]));
  });

  it('drops the candidate on a corrective follow-up', async () => {
    await maybeProposeSkill({
      userId: USER, agentId: AGENT, agentName: 'Coder',
      userMessage: 'research X', assistantContent: 'done',
      toolsUsed: baseTools,
    });
    const res = await flushPendingSkillCandidate({
      agentId: AGENT, currentUserMessage: 'no, that\'s wrong — try again',
    });
    expect(res).toEqual({ dropped: 'correction' });

    // No proposal was emitted.
    expect(listUserProposals(USER)).toEqual([]);
  });

  it('returns null when nothing is stashed', async () => {
    const res = await flushPendingSkillCandidate({
      agentId: AGENT, currentUserMessage: 'hello',
    });
    expect(res).toBeNull();
  });
});

// ── 10-12. Cooldown by toolsKey ──────────────────────────────────────────────

describe('proposeSkill — cooldown keyed by toolsKey', () => {
  it('suppresses re-propose of the same tool-set after dismissal', async () => {
    const first = await proposeSkill({
      userId: USER, agentId: AGENT, agentName: 'Coder',
      userTrigger: 'research X', agentSummary: '',
      toolNames: ['web_search', 'fetch_url', 'send_email', 'schedule_task'],
      toolsKey: 'fetch_url,schedule_task,send_email,web_search',
      message: 'That turn used 4 different tools (web_search, fetch_url, …).',
    });
    expect(first).toBeTruthy();

    const dismissed = await dismissProposal(first.id);
    expect(dismissed.ok).toBe(true);

    // Same toolsKey → suppressed.
    const second = await proposeSkill({
      userId: USER, agentId: AGENT, agentName: 'Coder',
      userTrigger: 'research Y next time',
      agentSummary: '',
      toolNames: ['web_search', 'fetch_url', 'send_email', 'schedule_task'],
      toolsKey: 'fetch_url,schedule_task,send_email,web_search',
      message: 'That turn used 4 different tools (web_search, fetch_url, …).',
    });
    expect(second).toBeNull();

    // Different toolsKey → still goes through. This is the key contrast with
    // patternKey-on-message: the boilerplate preamble would otherwise collide.
    const third = await proposeSkill({
      userId: USER, agentId: AGENT, agentName: 'Coder',
      userTrigger: 'log analysis run',
      agentSummary: '',
      toolNames: ['logs_query', 'logs_filter', 'logs_summarize', 'send_email'],
      toolsKey: 'logs_filter,logs_query,logs_summarize,send_email',
      message: 'That turn used 4 different tools (logs_query, logs_filter, …).',
    });
    expect(third).toBeTruthy();
    expect(getProposal(third.id)?.kind).toBe('skill_proposal');
  });
});
