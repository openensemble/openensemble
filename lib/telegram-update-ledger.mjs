// @ts-check
/**
 * Durable at-most-once admission for Telegram webhook updates.
 *
 * Telegram retries a webhook when its acknowledgement is lost. The claim is
 * persisted before OE acknowledges or starts model/tool work, so the same
 * update_id can never launch a second coordinator turn or repeat its side
 * effects. A crash after the claim may lose that one update, which is safer
 * than replaying an ambiguously completed action.
 */
import fs from 'node:fs';
import path from 'node:path';

import { USERS_DIR } from './paths.mjs';
import { withFileLock } from './file-lock.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 15_000;
const _lastSweep = new Map();

function userDir(userId) {
  const id = String(userId || '');
  if (!id || path.basename(id) !== id || id === '.' || id === '..') {
    throw new Error('A valid userId is required for Telegram update admission.');
  }
  return path.join(USERS_DIR, id, 'telegram-updates');
}

function safeUpdateId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('Telegram update_id must be a non-negative safe integer.');
  return id;
}

function sweep(dir, now) {
  const last = _lastSweep.get(dir) || 0;
  if (now - last < 60 * 60 * 1000) return;
  _lastSweep.set(dir, now);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !/^update-\d+\.json$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      if (now - fs.statSync(file).mtimeMs > RETENTION_MS) fs.rmSync(file, { force: true });
    } catch { /* retention is best effort; admission remains fail closed */ }
  }
}

/**
 * @returns {Promise<boolean>} true only for the first durable claim.
 */
export async function claimTelegramUpdate(userId, updateId, { now = Date.now() } = {}) {
  const id = safeUpdateId(updateId);
  const dir = userDir(userId);
  const record = path.join(dir, `update-${id}.json`);
  const lock = path.join(dir, '.locks', `update-${id}.lock`);
  return withFileLock(lock, async () => {
    sweep(dir, now);
    // Any existing bytes, including malformed bytes, mean the update is not
    // safe to execute again. Atomic creation makes corruption unlikely; a
    // fail-open parser would turn storage damage into duplicate actions.
    if (fs.existsSync(record)) return false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteSync(record, JSON.stringify({ version: 1, updateId: id, claimedAt: now }), { mode: 0o600 });
    return true;
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}
