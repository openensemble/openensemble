import fs from 'node:fs/promises';
import { USERS_DIR } from './paths.mjs';
import { networkShares } from './network-shares.mjs';

// Run after account/skill loading and HTTP startup. One offline NAS must not
// hold up OE or prevent other accounts from restoring their connections.
export async function restoreNetworkSharesAtStartup({
  canRestore,
  service = networkShares,
  onResult = () => {},
} = {}) {
  if (typeof canRestore !== 'function') throw new Error('Share startup requires an account permission check.');
  let entries;
  try { entries = await fs.readdir(USERS_DIR, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const accounts = entries.filter(entry => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => {
    while (next < accounts.length) {
      const userId = accounts[next++].name;
      try {
        if (!await canRestore(userId)) continue;
        for (const result of await service.restore(userId)) onResult(userId, result);
      }
      catch { onResult(userId, { connected: false, code: 'CONFIG' }); }
    }
  }));
}
