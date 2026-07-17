import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { USERS_DIR } from './paths.mjs';
import { _internal, claimTelegramUpdate } from './telegram-update-ledger.mjs';

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

  it('persists a retired watermark before pruning old claims', async () => {
    const userId = unique('telegram_retired');
    const dir = _internal.userDir(userId);
    const now = Date.now();
    expect(await claimTelegramUpdate(userId, 700, { now })).toBe(true);
    expect(await claimTelegramUpdate(userId, 701, { now })).toBe(true);
    expect(await claimTelegramUpdate(userId, 702, { now })).toBe(true);
    const old = new Date(now - 10_000);
    fs.utimesSync(path.join(dir, 'update-700.json'), old, old);

    const result = _internal.sweep(dir, now, {
      force: true,
      retentionMs: 1_000,
      maxRecords: 10,
    });
    expect(result.retiredThrough).toBe(700);
    expect(fs.existsSync(path.join(dir, 'update-700.json'))).toBe(false);
    expect(_internal.readCheckpoint(dir).retiredThrough).toBe(700);
    expect(await claimTelegramUpdate(userId, 700, { now: now + 1 })).toBe(false);
    expect(await claimTelegramUpdate(userId, 699, { now: now + 1 })).toBe(false);
    expect(await claimTelegramUpdate(userId, 703, { now: now + 1 })).toBe(true);
  });

  it('bounds live update files by retiring the oldest numeric prefix', async () => {
    const userId = unique('telegram_limit');
    const dir = _internal.userDir(userId);
    expect(await claimTelegramUpdate(userId, 800)).toBe(true);
    expect(await claimTelegramUpdate(userId, 801)).toBe(true);
    expect(await claimTelegramUpdate(userId, 802)).toBe(true);

    const result = _internal.sweep(dir, Date.now(), {
      force: true,
      retentionMs: Number.MAX_SAFE_INTEGER,
      maxRecords: 2,
    });
    expect(result).toMatchObject({ retiredThrough: 800, retained: 2, atCapacity: false });
    expect(fs.existsSync(path.join(dir, 'update-800.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'update-801.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'update-802.json'))).toBe(true);
    expect(await claimTelegramUpdate(userId, 800)).toBe(false);
  });

  it('accepts a lower random sequence only after Telegram\'s documented idle reset window', async () => {
    const userId = unique('telegram_sequence_reset');
    const startedAt = Date.now();
    expect(await claimTelegramUpdate(userId, 9_000, { now: startedAt })).toBe(true);
    const dir = _internal.userDir(userId);
    _internal.sweep(dir, startedAt, {
      force: true,
      retentionMs: Number.MAX_SAFE_INTEGER,
      maxRecords: 0,
    });
    expect(_internal.readCheckpoint(dir).retiredThrough).toBe(9_000);
    expect(await claimTelegramUpdate(userId, 100, {
      now: startedAt + _internal.SEQUENCE_RESET_IDLE_MS - 1,
    })).toBe(false);
    expect(await claimTelegramUpdate(userId, 100, {
      now: startedAt + _internal.SEQUENCE_RESET_IDLE_MS + 1,
    })).toBe(true);
    expect(_internal.readCheckpoint(dir)).toMatchObject({ retiredThrough: -1 });
  });

  it('fails closed when the compact retirement checkpoint is malformed', async () => {
    const userId = unique('telegram_checkpoint_corrupt');
    const dir = _internal.userDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'checkpoint.json'), 'truncated', { mode: 0o600 });
    await expect(claimTelegramUpdate(userId, 900)).rejects.toThrow('checkpoint is malformed');
  });
});
