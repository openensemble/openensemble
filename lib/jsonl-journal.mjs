// @ts-check
/**
 * Append-with-retention for small operational JSONL journals.
 *
 * Shared by the voice turn and connectivity journals. Rewrite-on-append is
 * O(file), which is deliberate: these journals are bounded by a retention
 * window and see tens to low hundreds of rows a day, so a rewrite costs less
 * than the machinery needed to compact a growing file safely. Do not reach for
 * this for anything high-volume.
 *
 * Every entry point swallows its own errors. These journals exist to explain
 * failures in the voice path; one must never become a failure in the voice path.
 */
import fs from 'fs';
import path from 'path';
import { withLock } from '../routes/_helpers/io-lock.mjs';

/**
 * Append one row, dropping rows older than `retentionMs` in the same pass.
 * Rows without a numeric `ts` are kept — an unparseable timestamp is not a
 * reason to silently discard evidence.
 */
export async function appendJsonlRow(filePath, row, retentionMs) {
  const line = JSON.stringify(row);
  try {
    await withLock(filePath, () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const cutoff = Date.now() - retentionMs;
      const kept = [];
      if (fs.existsSync(filePath)) {
        for (const l of fs.readFileSync(filePath, 'utf8').split('\n')) {
          if (!l) continue;
          try {
            const rec = JSON.parse(l);
            if (typeof rec.ts !== 'number' || rec.ts > cutoff) kept.push(l);
          } catch { /* drop unparseable lines rather than lose the whole file */ }
        }
      }
      kept.push(line);
      fs.writeFileSync(filePath, kept.join('\n') + '\n');
    });
  } catch (e) {
    console.warn(`[jsonl-journal] append failed for ${path.basename(filePath)}:`, e.message);
  }
}

/** Read rows back in write order (newest last). Returns [] if absent. */
export function readJsonlRows(filePath, { limit = 0 } = {}) {
  if (!fs.existsSync(filePath)) return [];
  const out = [];
  try {
    for (const l of fs.readFileSync(filePath, 'utf8').split('\n')) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* skip */ }
    }
  } catch { return []; }
  return limit > 0 ? out.slice(-limit) : out;
}
