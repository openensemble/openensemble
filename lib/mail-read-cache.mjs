import { createHash } from 'node:crypto';

// Short-lived account-scoped reads only. Provider writes invalidate both before
// and after dispatch, including failures that may have partially taken effect.
const TTL_MS = 20_000, MAX_ENTRIES = 512, MAX_BYTES = 4 * 1024 * 1024, MAX_ENTRY_BYTES = 256 * 1024;
const entries = new Map();
let bytes = 0;

export function mailCacheScope(userId, account) {
  const identity = JSON.stringify([userId, account.id, account.provider, account.host, account.port, account.tls, account.username, account.encryptedPassword]);
  return createHash('sha256').update(identity).digest('hex');
}

function remove(key) {
  const entry = entries.get(key);
  if (entry) { bytes -= entry.bytes; entries.delete(key); }
}

export function invalidateMailReads(userId, account) {
  const scope = mailCacheScope(userId, account);
  for (const [key, entry] of entries) if (entry.scope === scope) remove(key);
}

export async function cachedMailRead(scope, key, read) {
  const cacheKey = JSON.stringify([scope, key]);
  let entry = entries.get(cacheKey);
  if (entry && entry.expires > Date.now()) {
    entries.delete(cacheKey); entries.set(cacheKey, entry);
    return structuredClone(await entry.promise);
  }
  remove(cacheKey);
  entry = { scope, bytes: 0, expires: Date.now() + TTL_MS, promise: null };
  entries.set(cacheKey, entry);
  while (entries.size > MAX_ENTRIES) remove(entries.keys().next().value);
  entry.promise = Promise.resolve().then(read).then(value => {
    if (entries.get(cacheKey) === entry) {
      const size = Buffer.byteLength(JSON.stringify(value));
      if (size > MAX_ENTRY_BYTES) remove(cacheKey);
      else {
        entry.bytes = size; bytes += size; entry.expires = Date.now() + TTL_MS;
        while (bytes > MAX_BYTES) remove(entries.keys().next().value);
      }
    }
    return value;
  }).catch(error => { if (entries.get(cacheKey) === entry) remove(cacheKey); throw error; });
  return structuredClone(await entry.promise);
}

export async function withMailReadInvalidation(userId, account, write) {
  invalidateMailReads(userId, account);
  try { return await write(); }
  finally { invalidateMailReads(userId, account); }
}
