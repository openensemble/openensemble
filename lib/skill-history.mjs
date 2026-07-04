// @ts-check
/**
 * Versioned rollback history for skill-authoring writes (skill-builder).
 *
 * Every ACCEPTED write from skill-builder's update tools (skill_update_code,
 * skill_patch_code, skill_update_tool_def, skill_update_manifest) snapshots the
 * version it is about to REPLACE into `<skillDir>/.history/`, so `skill_rollback`
 * can restore any of the last HISTORY_KEEP versions of either file.
 *
 * This is IN ADDITION to the existing `<file>.bak` crash-restore mechanics in
 * skills/skill-builder/execute.mjs — `.bak` undoes a bad write WITHIN one call
 * (created before the write, deleted once that call's own gates/smoke pass);
 * `.history` is the durable, multi-version trail ACROSS calls that `.bak` never
 * kept (it was always deleted on success).
 *
 * Layout:
 *   <skillDir>/.history/<safe-iso-timestamp>__execute.mjs[.N]
 *   <skillDir>/.history/<safe-iso-timestamp>__manifest.json[.N]
 * (colons/dots in the ISO timestamp are dashed out for filename safety; the
 * `.N` numeric suffix only appears on the rare same-millisecond collision.)
 *
 * Retention: last HISTORY_KEEP snapshots per file type — pruned on every write.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import path from 'path';

export const HISTORY_KEEP = 10;
const SEP = '__';

/** @typedef {'execute.mjs'|'manifest.json'} HistoryFileType */

export function historyDir(skillDir) {
  return path.join(skillDir, '.history');
}

function safeIso(date = new Date()) {
  // "2026-07-04T12:34:56.789Z" -> "2026-07-04T12-34-56-789Z". Purely a
  // character substitution (fixed width, fixed positions), so lexical string
  // ordering of the result still matches chronological ordering.
  return date.toISOString().replace(/[:.]/g, '-');
}

// Recover a Date-parseable ISO string from the dashed filename form.
function isoFromSafe(safe) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(safe);
  if (!m) return safe;
  const [, y, mo, d, h, mi, s, ms] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
}

function isForType(filename, fileType) {
  const idx = filename.indexOf(SEP);
  if (idx === -1) return false;
  const rest = filename.slice(idx + SEP.length);
  return rest === fileType || rest.startsWith(fileType + '.');
}

function safeTsFromFilename(filename) {
  const idx = filename.indexOf(SEP);
  return idx === -1 ? '' : filename.slice(0, idx);
}

// Same-millisecond collisions get a numeric ".N" suffix (see snapshotToHistory)
// so two files can share an identical `ts` prefix. Break ties on that suffix —
// the un-suffixed file (created first) sorts before ".1", ".1" before ".2", etc.
// — so ordering still reflects write order even when the clock didn't advance.
function collisionSuffix(filename) {
  const m = /\.(\d+)$/.exec(filename);
  return m ? Number(m[1]) : 0;
}

function compareChronological(a, b) {
  const ta = safeTsFromFilename(a), tb = safeTsFromFilename(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return collisionSuffix(a) - collisionSuffix(b);
}

/**
 * Snapshot `content` (the version about to be replaced) into history and
 * prune to the retention window. Best-effort by design of the caller — a
 * history-write problem must never block the underlying skill write, so
 * callers should wrap this in try/catch and just log on failure.
 * @param {string} skillDir
 * @param {HistoryFileType} fileType
 * @param {string} content
 * @returns {string} absolute path written
 */
export function snapshotToHistory(skillDir, fileType, content) {
  const dir = historyDir(skillDir);
  mkdirSync(dir, { recursive: true });
  const base = `${safeIso()}${SEP}${fileType}`;
  let fp = path.join(dir, base);
  let n = 0;
  while (existsSync(fp)) { n += 1; fp = path.join(dir, `${base}.${n}`); }
  writeFileSync(fp, content);
  pruneHistory(skillDir, fileType);
  return fp;
}

/**
 * Delete snapshots beyond the retention window for one file type (oldest first).
 * @param {string} skillDir
 * @param {HistoryFileType} fileType
 * @param {number} [keep]
 */
export function pruneHistory(skillDir, fileType, keep = HISTORY_KEEP) {
  const dir = historyDir(skillDir);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir)
    .filter(f => isForType(f, fileType))
    .sort(compareChronological); // oldest first
  const excess = files.length - keep;
  for (let i = 0; i < excess; i++) {
    try { unlinkSync(path.join(dir, files[i])); } catch { /* best-effort prune */ }
  }
}

function preview(content, fileType) {
  const text = String(content || '');
  if (fileType === 'manifest.json') {
    try {
      const j = JSON.parse(text);
      if (j?.description) return String(j.description).slice(0, 120);
      if (j?.name) return String(j.name).slice(0, 120);
    } catch { /* fall through to first-line */ }
  }
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0) || '(empty)';
  return firstLine.slice(0, 120);
}

/**
 * @typedef {Object} HistorySnapshotMeta
 * @property {number} index  1-based, newest-first (1 = most recently replaced version)
 * @property {string} ts     ISO timestamp string
 * @property {string} file   filename inside .history/
 * @property {number} size   bytes
 * @property {string} preview  first-line / description preview
 */

/**
 * List snapshots for one file type, most-recent-first.
 * @param {string} skillDir
 * @param {HistoryFileType} fileType
 * @returns {HistorySnapshotMeta[]}
 */
export function listHistorySnapshots(skillDir, fileType) {
  const dir = historyDir(skillDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter(f => isForType(f, fileType))
    .sort((a, b) => -compareChronological(a, b)); // newest first
  return files.map((f, i) => {
    const fp = path.join(dir, f);
    let size = 0, content = '';
    try { size = statSync(fp).size; } catch { /* ignore */ }
    try { content = readFileSync(fp, 'utf8'); } catch { /* ignore */ }
    return { index: i + 1, ts: isoFromSafe(safeTsFromFilename(f)), file: f, size, preview: preview(content, fileType) };
  });
}

/**
 * Resolve `version` — a 1-based index into the most-recent-first listing, OR
 * a parseable timestamp string (exact match preferred, else nearest) — to a
 * snapshot + its content.
 *
 * @param {string} skillDir
 * @param {HistoryFileType} fileType
 * @param {string|number} version
 * @returns {(HistorySnapshotMeta & {content: string}) | null | undefined}
 *   null when there is NO history at all for this file type;
 *   undefined when `version` doesn't resolve to any snapshot.
 */
export function readHistorySnapshot(skillDir, fileType, version) {
  const list = listHistorySnapshots(skillDir, fileType);
  if (!list.length) return null;

  let match;
  const asStr = String(version ?? '').trim();
  if (/^\d+$/.test(asStr)) {
    const idx = Number(asStr);
    match = list.find(s => s.index === idx);
  } else {
    const target = Date.parse(asStr);
    if (!Number.isNaN(target)) {
      match = list.find(s => Date.parse(s.ts) === target);
      if (!match) {
        match = list.reduce((best, cur) => {
          const bd = Math.abs(Date.parse(best.ts) - target);
          const cd = Math.abs(Date.parse(cur.ts) - target);
          return cd < bd ? cur : best;
        }, list[0]);
      }
    }
  }
  if (!match) return undefined;
  const content = readFileSync(path.join(historyDir(skillDir), match.file), 'utf8');
  return { ...match, content };
}
