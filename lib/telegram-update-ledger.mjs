// @ts-check
/**
 * Durable at-most-once admission for Telegram webhook updates.
 *
 * Telegram retries a webhook when its acknowledgement is lost. The claim is
 * persisted before OE acknowledges or starts model/tool work, so the same
 * update_id cannot launch a second coordinator turn during Telegram's retry
 * lifetime or active sequence. A crash after the claim may lose that one
 * update, which is safer than replaying an ambiguously completed action.
 * Telegram may restart update_id sequencing after a week without updates, so
 * cleanup retains a compact watermark only until that documented idle reset.
 */
import fs from 'node:fs';
import path from 'node:path';

import { USERS_DIR } from './paths.mjs';
import { withFileLock } from './file-lock.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 15_000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_RECORDS = 10_000;
const CHECKPOINT_FILE = 'checkpoint.json';
// Telegram documents that update_id sequencing may restart randomly after at
// least one idle week. It retains unacknowledged updates for at most 24 hours,
// so resetting only after our longer retention window is conservative.
const SEQUENCE_RESET_IDLE_MS = RETENTION_MS;
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

function checkpointPath(dir) {
  return path.join(dir, CHECKPOINT_FILE);
}

function readCheckpoint(dir) {
  const file = checkpointPath(dir);
  if (!fs.existsSync(file)) {
    return { version: 1, retiredThrough: -1, lastClaimedAt: 0, updatedAt: 0 };
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.version !== 1
      || !Number.isSafeInteger(value.retiredThrough)
      || value.retiredThrough < -1
      || (value.lastClaimedAt != null
        && (!Number.isFinite(value.lastClaimedAt) || value.lastClaimedAt < 0))) {
      throw new Error('invalid shape');
    }
    return { ...value, lastClaimedAt: Number(value.lastClaimedAt ?? value.updatedAt) || 0 };
  } catch {
    throw new Error('Telegram update checkpoint is malformed; refusing webhook admission.');
  }
}

function writeCheckpoint(dir, retiredThrough, now, lastClaimedAt = 0) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteSync(checkpointPath(dir), JSON.stringify({
    version: 1,
    retiredThrough,
    lastClaimedAt,
    updatedAt: now,
  }), { mode: 0o600 });
}

/**
 * Retire an old numeric prefix before deleting its individual claim files.
 * The durable high-water mark means cleanup cannot turn an old Telegram retry
 * back into a first delivery. A very late out-of-order id below the watermark
 * is conservatively suppressed rather than risking duplicate side effects.
 */
function sweep(dir, now, {
  force = false,
  retentionMs = RETENTION_MS,
  maxRecords = MAX_RECORDS,
  reserve = 0,
} = {}) {
  const checkpoint = readCheckpoint(dir);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      return { retiredThrough: checkpoint.retiredThrough, retained: 0, atCapacity: false, removed: 0 };
    }
    throw error;
  }
  const records = entries.flatMap(entry => {
    const match = entry.isFile() ? entry.name.match(/^update-(\d+)\.json$/) : null;
    if (!match) return [];
    const updateId = Number(match[1]);
    return Number.isSafeInteger(updateId) ? [{ updateId, file: path.join(dir, entry.name) }] : [];
  }).sort((a, b) => a.updateId - b.updateId);

  // Existing installations have claim files but no checkpoint activity time.
  // Derive it once from mtimes so an upgrade never resets a live sequence.
  let lastActivityAt = checkpoint.lastClaimedAt || 0;
  if (!lastActivityAt && records.length) {
    for (const record of records) {
      try { lastActivityAt = Math.max(lastActivityAt, fs.statSync(record.file).mtimeMs); }
      catch { lastActivityAt = now; } // unknown storage state retains the sequence
    }
  }

  if (lastActivityAt > 0 && now - lastActivityAt > SEQUENCE_RESET_IDLE_MS) {
    // Commit the new generation before deleting old exact claims. Telegram may
    // choose a lower random id after this idle interval; keeping the old
    // watermark would suppress a legitimate update forever.
    writeCheckpoint(dir, -1, now, 0);
    let removed = 0;
    for (const record of records) {
      try {
        fs.rmSync(record.file, { force: true });
        removed += 1;
      } catch { /* failed cleanup remains fail-closed by exact filename */ }
    }
    const retained = records.length - removed;
    return { retiredThrough: -1, retained, atCapacity: retained + Math.max(0, reserve) > maxRecords, removed };
  }

  const target = Math.max(0, maxRecords - Math.max(0, reserve));
  let retiredThrough = checkpoint.retiredThrough;
  const last = _lastSweep.get(dir) || 0;
  if (force || now - last >= SWEEP_INTERVAL_MS) {
    _lastSweep.set(dir, now);
    for (const record of records) {
      if (record.updateId <= retiredThrough) continue;
      try {
        if (now - fs.statSync(record.file).mtimeMs > retentionMs) {
          retiredThrough = Math.max(retiredThrough, record.updateId);
        }
      } catch { /* unreadable claims remain represented by their filename */ }
    }
  }

  const aboveCheckpoint = records.filter(record => record.updateId > retiredThrough);
  if (aboveCheckpoint.length > target) {
    const retireCount = aboveCheckpoint.length - target;
    retiredThrough = Math.max(retiredThrough, aboveCheckpoint[retireCount - 1].updateId);
  }

  // Advance the compact tombstone first. A crash after this write but before
  // file deletion is harmless; the reverse order could admit a duplicate.
  if (retiredThrough > checkpoint.retiredThrough) {
    writeCheckpoint(dir, retiredThrough, now, checkpoint.lastClaimedAt || lastActivityAt);
  }

  let removed = 0;
  for (const record of records) {
    if (record.updateId > retiredThrough) continue;
    try {
      fs.rmSync(record.file, { force: true });
      removed += 1;
    } catch { /* best effort; physical capacity below remains fail closed */ }
  }
  const retained = records.length - removed;
  return {
    retiredThrough,
    retained,
    atCapacity: retained + Math.max(0, reserve) > maxRecords,
    removed,
  };
}

/**
 * @returns {Promise<boolean>} true only for the first durable claim.
 */
export async function claimTelegramUpdate(userId, updateId, { now = Date.now() } = {}) {
  const id = safeUpdateId(updateId);
  const dir = userDir(userId);
  const record = path.join(dir, `update-${id}.json`);
  // One short per-user lock serializes checkpoint advancement with every
  // claim. Per-update locks allowed one claimant to delete another id while a
  // sweep was advancing the compact tombstone.
  const lock = path.join(dir, '.locks', 'admission.lock');
  return withFileLock(lock, async () => {
    const state = sweep(dir, now, { reserve: 1 });
    if (id <= state.retiredThrough) return false;
    // Any existing bytes, including malformed bytes, mean the update is not
    // safe to execute again. Atomic creation makes corruption unlikely; a
    // fail-open parser would turn storage damage into duplicate actions.
    if (fs.existsSync(record)) return false;
    if (state.atCapacity) {
      throw new Error('Telegram update ledger is at capacity; refusing webhook admission.');
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Record sequence activity before the exact claim. If the second atomic
    // write fails, no model work starts and a later webhook retry remains safe.
    writeCheckpoint(dir, state.retiredThrough, now, now);
    atomicWriteSync(record, JSON.stringify({ version: 1, updateId: id, claimedAt: now }), { mode: 0o600 });
    return true;
  }, { timeoutMs: LOCK_TIMEOUT_MS });
}

export const _internal = Object.freeze({
  RETENTION_MS,
  SEQUENCE_RESET_IDLE_MS,
  MAX_RECORDS,
  userDir,
  readCheckpoint,
  sweep,
});
