// @ts-check
/**
 * Small, dependency-free cross-process filesystem lock.
 *
 * OE normally runs as one process, but development/upgrade leftovers can leave
 * two server processes sharing the same user files.  An in-memory Promise lock
 * cannot serialize those writers.  mkdir is atomic on the local filesystem, so
 * a directory is used as the ownership token and removed in finally.
 *
 * This API is intentionally synchronous.  Its first consumer is the tiny
 * pending-approvals JSON store, whose public API is synchronous and whose
 * operations are user-paced.  Contention is exceptional; waits are bounded and
 * a timeout throws rather than letting a destructive approval proceed unlocked.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_WORD, 0, 0, Math.max(1, Math.floor(ms)));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(1, Math.floor(ms))));
}

/** Return Linux /proc start ticks (field 22), or null when unavailable. */
function processStartTicks(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm (field 2) is parenthesized and may itself contain spaces.  Tokens
    // after the final ')' begin at field 3, so field 22 is index 19 here.
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    return fields[19] || null;
  } catch {
    return null;
  }
}

const SELF_PROCESS_START_TICKS = processStartTicks(process.pid);

/** Stable identity for this exact process incarnation. */
export function getProcessIdentity() {
  return {
    pid: process.pid,
    processStartTicks: SELF_PROCESS_START_TICKS,
  };
}

/**
 * Return true only when the supplied process incarnation is provably dead.
 * Unknown/invalid ownership fails closed: callers must not recover shared
 * state merely because they cannot establish who owns it.
 */
export function processIdentityIsProvenDead(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  const currentTicks = processStartTicks(owner.pid);
  if (currentTicks != null && owner.processStartTicks != null) {
    return String(currentTicks) !== String(owner.processStartTicks);
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (e) {
    return e?.code === 'ESRCH';
  }
}

function readOwner(lockDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * A lock is breakable only when its exact Linux process incarnation is proven
 * dead.  An ownerless directory (process died between mkdir and owner write)
 * becomes breakable after staleMs.  Unknown state is treated as live.
 */
function lockIsProvenStale(lockDir, staleMs) {
  const owner = readOwner(lockDir);
  if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
    const currentTicks = processStartTicks(owner.pid);
    if (currentTicks != null && owner.processStartTicks != null) {
      return String(currentTicks) !== String(owner.processStartTicks);
    }
    // /proc may be unavailable on a non-Linux host.  kill(pid, 0) does not
    // signal the process; EPERM means it exists but belongs to another user.
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (e) {
      if (e?.code === 'ESRCH') return true;
      return false;
    }
  }

  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs >= staleMs;
  } catch {
    return false;
  }
}

/**
 * Serialize stale-lock cleanup so two waiters cannot both remove/reacquire the
 * same path and accidentally delete a new owner's lock.
 */
function breakStaleLock(lockDir, staleMs) {
  const breaker = `${lockDir}.breaker`;
  // The breaker is itself a lock. A process can die after mkdir and before its
  // finally; reap that exact dead incarnation through an atomic quarantine
  // rename so the tombstone cleanup can never delete a newly acquired breaker.
  if (fs.existsSync(breaker) && lockIsProvenStale(breaker, staleMs)) {
    const tombstone = `${breaker}.stale.${randomUUID()}`;
    try {
      fs.renameSync(breaker, tombstone);
      fs.rmSync(tombstone, { recursive: true, force: true });
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
  }
  const breakerNonce = randomUUID();
  try {
    fs.mkdirSync(breaker, { mode: 0o700 });
  } catch (e) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  }

  try {
    try {
      fs.writeFileSync(path.join(breaker, 'owner.json'), JSON.stringify({
        pid: process.pid,
        processStartTicks: SELF_PROCESS_START_TICKS,
        nonce: breakerNonce,
        acquiredAt: Date.now(),
      }), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      fs.rmSync(breaker, { recursive: true, force: true });
      throw e;
    }
    // Re-read under the breaker.  The prior owner may have released the lock
    // while this contender was waiting.
    if (!fs.existsSync(lockDir) || !lockIsProvenStale(lockDir, staleMs)) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    releaseOwnedLock(breaker, breakerNonce);
  }
}

function releaseOwnedLock(lockDir, nonce) {
  const owner = readOwner(lockDir);
  // Never remove a path whose ownership changed unexpectedly.
  if (!owner || owner.nonce !== nonce) return;
  fs.rmSync(lockDir, { recursive: true, force: true });
}

/**
 * Run fn while exclusively holding lockDir across OE processes.
 *
 * @template T
 * @param {string} lockDir
 * @param {() => T} fn
 * @param {{timeoutMs?: number, staleMs?: number, retryMinMs?: number, retryMaxMs?: number}} [opts]
 * @returns {T}
 */
export function withFileLockSync(lockDir, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30_000;
  const retryMinMs = opts.retryMinMs ?? 8;
  const retryMaxMs = Math.max(retryMinMs, opts.retryMaxMs ?? 32);
  const deadline = Date.now() + timeoutMs;
  const nonce = randomUUID();

  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      breakStaleLock(lockDir, staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring file lock: ${lockDir}`);
      }
      const jitter = retryMinMs + Math.random() * (retryMaxMs - retryMinMs);
      sleepSync(Math.min(jitter, Math.max(1, deadline - Date.now())));
      continue;
    }

    try {
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        processStartTicks: SELF_PROCESS_START_TICKS,
        nonce,
        acquiredAt: Date.now(),
      }), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      throw e;
    }

    try {
      return fn();
    } finally {
      releaseOwnedLock(lockDir, nonce);
    }
  }
}

async function processStartTicksAsync(pid) {
  try {
    const raw = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    return fields[19] || null;
  } catch {
    return null;
  }
}

async function readOwnerAsync(lockDir) {
  try {
    const value = JSON.parse(await fs.promises.readFile(path.join(lockDir, 'owner.json'), 'utf8'));
    if (!value || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

async function lockIsProvenStaleAsync(lockDir, staleMs) {
  const owner = await readOwnerAsync(lockDir);
  if (owner && Number.isInteger(owner.pid) && owner.pid > 0) {
    const currentTicks = await processStartTicksAsync(owner.pid);
    if (currentTicks != null && owner.processStartTicks != null) {
      return String(currentTicks) !== String(owner.processStartTicks);
    }
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (e) {
      if (e?.code === 'ESRCH') return true;
      return false;
    }
  }
  try {
    const stat = await fs.promises.stat(lockDir);
    return Date.now() - stat.mtimeMs >= staleMs;
  } catch {
    return false;
  }
}

async function breakStaleLockAsync(lockDir, staleMs) {
  const breaker = `${lockDir}.breaker`;
  try {
    if (await fs.promises.stat(breaker).then(() => true, () => false)
        && await lockIsProvenStaleAsync(breaker, staleMs)) {
      const tombstone = `${breaker}.stale.${randomUUID()}`;
      try {
        await fs.promises.rename(breaker, tombstone);
        await fs.promises.rm(tombstone, { recursive: true, force: true });
      } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
      }
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
  const breakerNonce = randomUUID();
  try {
    await fs.promises.mkdir(breaker, { mode: 0o700 });
  } catch (e) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  }
  try {
    try {
      await fs.promises.writeFile(path.join(breaker, 'owner.json'), JSON.stringify({
        pid: process.pid,
        processStartTicks: SELF_PROCESS_START_TICKS,
        nonce: breakerNonce,
        acquiredAt: Date.now(),
      }), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      await fs.promises.rm(breaker, { recursive: true, force: true });
      throw e;
    }
    if (!await lockIsProvenStaleAsync(lockDir, staleMs)) return false;
    await fs.promises.rm(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    await releaseOwnedLockAsync(breaker, breakerNonce);
  }
}

async function releaseOwnedLockAsync(lockDir, nonce) {
  const owner = await readOwnerAsync(lockDir);
  if (!owner || owner.nonce !== nonce) return;
  await fs.promises.rm(lockDir, { recursive: true, force: true });
}

/**
 * Async counterpart for session and other event-loop-sensitive persistence.
 * Filesystem ownership checks are asynchronous, retry waits use timers, and
 * the lock remains held until an async callback has fully settled.
 *
 * @template T
 * @param {string} lockDir
 * @param {() => Promise<T>|T} fn
 * @param {{timeoutMs?: number, staleMs?: number, retryMinMs?: number, retryMaxMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockDir, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const staleMs = opts.staleMs ?? 30_000;
  const retryMinMs = opts.retryMinMs ?? 8;
  const retryMaxMs = Math.max(retryMinMs, opts.retryMaxMs ?? 32);
  const deadline = Date.now() + timeoutMs;
  const nonce = randomUUID();

  await fs.promises.mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });

  while (true) {
    try {
      await fs.promises.mkdir(lockDir, { mode: 0o700 });
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      await breakStaleLockAsync(lockDir, staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring file lock: ${lockDir}`);
      }
      const jitter = retryMinMs + Math.random() * (retryMaxMs - retryMinMs);
      await sleep(Math.min(jitter, Math.max(1, deadline - Date.now())));
      continue;
    }

    try {
      await fs.promises.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        processStartTicks: SELF_PROCESS_START_TICKS,
        nonce,
        acquiredAt: Date.now(),
      }), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      await fs.promises.rm(lockDir, { recursive: true, force: true });
      throw e;
    }

    try {
      return await fn();
    } finally {
      await releaseOwnedLockAsync(lockDir, nonce);
    }
  }
}
