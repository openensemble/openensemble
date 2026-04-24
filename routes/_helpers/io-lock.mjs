/**
 * Per-file write serialization and atomic write primitives.
 * Leaf module — safe for any extracted helper to depend on at top level.
 */

import fs from 'fs';
import { randomBytes } from 'crypto';

// withLock serializes async operations on a shared key (file path).
// Each call chains onto the prior operation so concurrent read-modify-writes
// are serialized per file rather than interleaved.
const _locks = new Map();
export async function withLock(key, fn) {
  const chain = (_locks.get(key) ?? Promise.resolve()).then(() => fn());
  _locks.set(key, chain.catch(e => { console.error('[lock] Error in locked operation for', key + ':', e.message); }));
  return chain;
}

// Write a file atomically — write to a sibling tmp path then rename. Prevents
// a crash or concurrent reader from seeing a half-written JSON blob, which
// Node's writeFileSync does not guarantee on its own.
export function atomicWriteSync(filePath, data, opts) {
  const tmp = filePath + '.tmp.' + process.pid + '.' + randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, data, opts);
  fs.renameSync(tmp, filePath);
}

// makeModify returns an async helper that loads, mutates (via fn), and saves
// atomically under the file lock.  fn(data) should mutate data in place;
// its return value is forwarded to the caller but does NOT replace save data.
export function makeModify(loadFn, saveFn, filePath) {
  return fn => withLock(filePath, () => {
    const data = loadFn();
    const result = fn(data);
    saveFn(data);
    return result;
  });
}
