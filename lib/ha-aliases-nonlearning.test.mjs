import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USERS_DIR } from './paths.mjs';

const mocks = vi.hoisted(() => ({
  appendAliasHit: vi.fn(async () => {}),
}));

vi.mock('./alias-hits.mjs', () => ({
  appendAliasHit: mocks.appendAliasHit,
}));

const { resolveAlias } = await import('./ha-aliases.mjs');

const USER_ID = 'user_ha_alias_nonlearning_test';
const userDir = path.join(USERS_DIR, USER_ID);

beforeEach(() => {
  mocks.appendAliasHit.mockClear();
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'ha-aliases.json'), JSON.stringify({
    kitchen: 'light.kitchen_group',
  }));
});

afterEach(() => {
  fs.rmSync(userDir, { recursive: true, force: true });
});

describe('Home Assistant alias non-learning reads', () => {
  it('resolves the alias without recording an outcome hit', async () => {
    expect(resolveAlias(USER_ID, 'kitchen', { suppressLearning: true }))
      .toBe('light.kitchen_group');

    // A normal hit schedules the mocked writer in a promise continuation.
    // Yield once so this assertion would observe that continuation if the
    // non-learning guard regressed.
    await new Promise(resolve => setImmediate(resolve));
    expect(mocks.appendAliasHit).not.toHaveBeenCalled();
  });

  it('keeps ordinary alias-hit outcome measurement intact', async () => {
    expect(resolveAlias(USER_ID, 'kitchen')).toBe('light.kitchen_group');

    await vi.waitFor(() => expect(mocks.appendAliasHit).toHaveBeenCalledOnce());
    expect(mocks.appendAliasHit).toHaveBeenCalledWith(USER_ID, {
      phrase: 'kitchen', entityId: 'light.kitchen_group',
    });
  });
});
