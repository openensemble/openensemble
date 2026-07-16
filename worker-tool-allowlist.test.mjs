import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { SKILLS_DIR, USERS_DIR } from './lib/paths.mjs';

const USER_ID = 'worker_empty_allowlist_user';
const profilePath = path.join(USERS_DIR, USER_ID, 'profile.json');
const markerPath = path.join(USERS_DIR, USER_ID, 'mutator-ran');
let executeToolStreaming;

async function resultText(generator) {
  const out = [];
  for await (const event of generator) {
    if (event.type === 'result') out.push(event.text);
  }
  return out.join('');
}

function writeProfile() {
  mkdirSync(path.dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, JSON.stringify({
    id: USER_ID,
    name: 'Worker Allowlist Test',
    role: 'owner',
    skills: ['test-mutator'],
  }));
}

beforeAll(async () => {
  rmSync(SKILLS_DIR, { recursive: true, force: true });
  const skillDir = path.join(SKILLS_DIR, 'test-mutator');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify({
    id: 'test-mutator',
    name: 'Test Mutator',
    always_on: true,
    tools: [{
      type: 'function',
      function: {
        name: 'test_account_mutator',
        description: 'Test-only durable mutator.',
        parameters: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'] },
      },
    }],
  }));
  writeFileSync(path.join(skillDir, 'execute.mjs'), [
    "import { writeFileSync } from 'fs';",
    "export default async function execute(_name, args) {",
    "  writeFileSync(args.marker, 'ran');",
    "  return 'mutated';",
    "}",
  ].join('\n'));
  writeProfile();
  const roles = await import('./roles.mjs');
  roles.loadRoleManifests();
  executeToolStreaming = roles.executeToolStreaming;
});

describe('explicit empty turn tool allowlist', () => {
  it('denies a real account mutator before its executor can write', async () => {
    // Positive control: this fixture reaches a real durable writer when
    // the current-turn schema explicitly includes the tool.
    await resultText(executeToolStreaming(
      'test_account_mutator',
      { marker: markerPath },
      USER_ID,
      'ephemeral_worker_allowlist_test',
      ['test_account_mutator'],
    ));
    expect(existsSync(markerPath)).toBe(true);

    rmSync(markerPath, { force: true });
    const denied = await resultText(executeToolStreaming(
      'test_account_mutator',
      { marker: markerPath },
      USER_ID,
      'ephemeral_worker_allowlist_test',
      [],
    ));

    expect(denied).toBe('Unknown tool: test_account_mutator');
    expect(existsSync(markerPath)).toBe(false);
  });
});
