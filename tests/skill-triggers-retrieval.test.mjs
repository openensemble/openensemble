/**
 * Tests for the embedding-ranked skill-trigger retrieval layer.
 *
 * Coverage:
 *   1. buildTriggerNudgeBlock returns '' when the user has no triggers anywhere
 *   2. buildTriggerNudgeBlock falls back to all-triggers listing when
 *      searchSimilar returns empty (cortex unavailable / cold index)
 *   3. buildTriggerNudgeBlock formats the EMBEDDING-RANKED block when
 *      searchSimilar returns rows (mocked)
 *   4. Embedding-ranked path keeps only the closest match per skill
 *      (dedup-by-skill — five rows from the same skill collapse to one)
 *   5. Distance threshold filters out far-off rows
 *   6. dropSkillTriggers swallows LanceDB errors silently (works on installs
 *      without a configured cortex provider)
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

// Mock memory/lance.mjs BEFORE importing skill-triggers. The module uses
// dynamic await import() inside its functions, so the mock has to be in
// place at module-load time AND vi.mock has to be hoisted (it is).
const _mockSearchRows = [];
vi.mock('../memory/lance.mjs', () => ({
  searchSimilar: vi.fn(async () => [..._mockSearchRows]),
  // getTable + delete are exercised by dropSkillTriggers and the embed-write
  // path. We stub them to no-ops; failure should be swallowed silently.
  getTable: vi.fn(async () => ({
    add: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  })),
}));

vi.mock('../memory/embedding.mjs', () => ({
  embed: vi.fn(async () => new Array(384).fill(0.1)),
}));

const { USERS_DIR, userSkillsDir } = await import('../lib/paths.mjs');
const {
  appendTrigger, dropSkillTriggers, buildTriggerNudgeBlock, getRelevantTriggers,
} = await import('../lib/skill-triggers.mjs');

const USER = 'user_trigret_test';
const SKILL_A = 'usr_alpha';
const SKILL_B = 'usr_beta';

function cleanupUser() {
  const dir = path.join(USERS_DIR, USER);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function dropManifest(skillId) {
  const dir = path.join(userSkillsDir(USER), skillId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id: skillId, name: skillId, custom: true, createdBy: USER,
    tools: [{ type: 'function', function: { name: `${skillId}_run` } }],
  }));
}

beforeEach(() => {
  cleanupUser();
  _mockSearchRows.length = 0;
});

afterAll(() => cleanupUser());

// ── 1-2. buildTriggerNudgeBlock fallback paths ──────────────────────────────

describe('buildTriggerNudgeBlock — empty & fallback', () => {
  it("returns '' when the user has no triggers at all", async () => {
    const out = await buildTriggerNudgeBlock(USER, 'do something');
    expect(out).toBe('');
  });

  it('falls back to all-triggers listing when searchSimilar returns nothing', async () => {
    dropManifest(SKILL_A);
    appendTrigger(USER, SKILL_A, 'email Sam the report');
    appendTrigger(USER, SKILL_A, 'send weekly digest');
    // _mockSearchRows is empty → embedding path returns [].

    const out = await buildTriggerNudgeBlock(USER, 'anything');
    expect(out).toMatch(/example invocations/);    // fallback header
    expect(out).toMatch(/usr_alpha/);
    expect(out).toMatch(/email Sam the report/);
    expect(out).toMatch(/send weekly digest/);
  });
});

// ── 3-5. Embedding-ranked path ───────────────────────────────────────────────

describe('buildTriggerNudgeBlock — embedding-ranked', () => {
  it('emits the ranked header when searchSimilar returns rows under threshold', async () => {
    dropManifest(SKILL_A);
    dropManifest(SKILL_B);
    _mockSearchRows.push(
      { agent_id: SKILL_A, text: 'email Sam the report', _distance: 0.12 },
      { agent_id: SKILL_B, text: 'build the weekly digest', _distance: 0.22 },
    );

    const out = await buildTriggerNudgeBlock(USER, 'email sam now');
    expect(out).toMatch(/relevant to this request/);   // ranked header
    expect(out).toMatch(/usr_alpha/);
    expect(out).toMatch(/usr_beta/);
    expect(out).toMatch(/email Sam the report/);
  });

  it('keeps only the closest match per skill (dedup-by-skill)', async () => {
    dropManifest(SKILL_A);
    _mockSearchRows.push(
      { agent_id: SKILL_A, text: 'closest phrasing',  _distance: 0.10 },
      { agent_id: SKILL_A, text: 'second closest',     _distance: 0.20 },
      { agent_id: SKILL_A, text: 'third closest',      _distance: 0.30 },
    );

    const top = await getRelevantTriggers(USER, 'whatever', 5);
    expect(top).toHaveLength(1);
    expect(top[0].skillId).toBe(SKILL_A);
    expect(top[0].phrase).toBe('closest phrasing');
  });

  it('filters out rows past the distance threshold (irrelevant matches)', async () => {
    dropManifest(SKILL_A);
    // 0.9 is far beyond the 0.55 threshold defined in skill-triggers.mjs
    _mockSearchRows.push({ agent_id: SKILL_A, text: 'not relevant', _distance: 0.9 });

    const top = await getRelevantTriggers(USER, 'whatever', 5);
    expect(top).toEqual([]);
  });
});

// ── 6. dropSkillTriggers ─────────────────────────────────────────────────────

describe('dropSkillTriggers', () => {
  it('completes without throwing (LanceDB errors are swallowed)', async () => {
    dropManifest(SKILL_A);
    // Even if the mock returns no-op, the function must not bubble errors.
    await expect(dropSkillTriggers(USER, SKILL_A)).resolves.toBeUndefined();
  });
});
