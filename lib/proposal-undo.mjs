// @ts-check
import fs from 'fs';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'util';

function fileRevision(filePath) {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    const hash = createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    return [stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs, hash].join(':');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Capture immediately after the write, without yielding (inside the store's
// lock for async writers). These stores lack per-entry revisions, so any later
// rewrite invalidates Undo, including deleting and recreating the same value.
export function recordProposalUndo(filePath, before, after) {
  return {
    version: 1,
    before: structuredClone(before),
    after: structuredClone(after),
    revision: fileRevision(filePath),
  };
}

// The version check and restore callback must run together without an await.
// Never infer a previous value for proposals accepted before receipts existed.
export function restoreProposalUndo(filePath, receipt, restore) {
  if (receipt?.version !== 1 || typeof receipt.revision !== 'string'
      || !Object.hasOwn(receipt, 'before') || !Object.hasOwn(receipt, 'after')) {
    return { ok: false, error: 'This suggestion has no saved version to restore safely. Review the current value in Learn.' };
  }
  if (fileRevision(filePath) !== receipt.revision) {
    return { ok: false, conflict: true, error: 'Saved data changed after this suggestion was accepted. Your changes were kept. Review the current value in Learn.' };
  }
  // Accepting a value that already existed must not make Undo delete it.
  if (!isDeepStrictEqual(receipt.before, receipt.after)) restore(receipt.before);
  return { ok: true };
}
