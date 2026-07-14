import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { USERS_DIR } from './paths.mjs';
import { claimTelegramUpdate } from './telegram-update-ledger.mjs';

function unique(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

describe('Telegram webhook update admission', () => {
  it('admits one concurrent claimant and rejects every redelivery', async () => {
    const userId = unique('telegram_claim');
    const results = await Promise.all([
      claimTelegramUpdate(userId, 731),
      claimTelegramUpdate(userId, 731),
      claimTelegramUpdate(userId, 731),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimTelegramUpdate(userId, 731)).toBe(false);
  });

  it('admits distinct update ids independently', async () => {
    const userId = unique('telegram_distinct');
    expect(await claimTelegramUpdate(userId, 100)).toBe(true);
    expect(await claimTelegramUpdate(userId, 101)).toBe(true);
  });

  it('fails closed when an earlier claim record is malformed', async () => {
    const userId = unique('telegram_corrupt');
    const dir = path.join(USERS_DIR, userId, 'telegram-updates');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'update-55.json'), 'truncated');
    expect(await claimTelegramUpdate(userId, 55)).toBe(false);
  });

  it('rejects unsafe user and update identities', async () => {
    await expect(claimTelegramUpdate('../other', 1)).rejects.toThrow('valid userId');
    await expect(claimTelegramUpdate('safe-user', -1)).rejects.toThrow('update_id');
    await expect(claimTelegramUpdate('safe-user', Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow('update_id');
  });
});
