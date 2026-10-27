import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { USERS_DIR } from './paths.mjs';
import { networkShares } from './network-shares.mjs';

const RETRYABLE = new Set(['UNAVAILABLE', 'TIMEOUT']);

// Give the LAN and file servers time to boot without delaying HTTP startup.
// Retry in rounds so an offline account never holds a worker while waiting.
export async function restoreNetworkSharesAtStartup({
  canRestore,
  service = networkShares,
  onResult = () => {},
  initialDelayMs = 30_000,
  retryDelaysMs = [30_000, 60_000, 120_000, 240_000],
  signal,
  wait = delay,
} = {}) {
  if (typeof canRestore !== 'function') throw new Error('Share startup requires an account permission check.');
  let entries;
  try { entries = await fs.readdir(USERS_DIR, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const accounts = entries.filter(entry => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name));
  let pending = new Map(accounts.map(entry => [entry.name, null]));
  for (const delayMs of [initialDelayMs, ...retryDelaysMs]) {
    if (!pending.size || signal?.aborted) return;
    try { await wait(delayMs, undefined, { signal, ref: false }); }
    catch (error) { if (signal?.aborted) return; throw error; }
    if (signal?.aborted) return;
    const batch = [...pending];
    const retry = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
      while (next < batch.length && !signal?.aborted) {
        const [userId, shareIds] = batch[next++];
        try {
          if (!await canRestore(userId) || signal?.aborted) continue;
          const failed = [];
          for (const result of await service.restore(userId, { shareIds, signal })) {
            onResult(userId, result);
            if (result.id && !result.connected && RETRYABLE.has(result.code)) failed.push(result.id);
          }
          if (failed.length) retry.set(userId, failed);
        }
        catch { if (!signal?.aborted) onResult(userId, { connected: false, code: 'CONFIG' }); }
      }
    }));
    pending = retry;
  }
}
