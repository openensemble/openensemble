/**
 * Document version store — append-only history for uploaded documents.
 *
 * Versions live at users/{ownerId}/documents/versions/{docId}/v{n}{ext}.
 * Version metadata rides on the doc's entry in docs-index.json as
 * doc.versions = [{ n, size, source, by, byName, note, at }].
 *
 * v1 is always the pre-edit original, created lazily on the first write so
 * docs uploaded before this feature get a history the moment they're first
 * edited. The live file (documents/{docId}{ext}) always matches the highest
 * version. Every write goes through the same index lock the routes use, so
 * route and skill writes serialize.
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { BASE_DIR, USERS_DIR, getUserFilesDir } from './paths.mjs';
import { withLock, atomicWriteSync } from '../routes/_helpers/io-lock.mjs';

// Whole-body agent rewrites arrive as one LLM output, so anything near this
// cap is a runaway, not a document.
export const MAX_DOC_CONTENT = 1_000_000;

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.json', '.html', '.htm', '.xml',
  '.yml', '.yaml', '.toml', '.ini', '.log',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.css',
  '.sql', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp',
]);

export function isTextEditable(doc) {
  if (!doc) return false;
  const ext = String(doc.ext ?? '').toLowerCase();
  if (TEXT_EXTS.has(ext)) return true;
  return String(doc.mimeType ?? '').toLowerCase().startsWith('text/');
}

function docsDir(ownerId)  { return getUserFilesDir(ownerId, 'documents'); }
function indexPath(ownerId) { return path.join(docsDir(ownerId), 'docs-index.json'); }
function lockKey(ownerId)   { return indexPath(ownerId) + '.lock'; } // same key as routes/shared-docs.mjs modifyUserIndex
function versionsDir(ownerId, docId) { return path.join(docsDir(ownerId), 'versions', docId); }

function liveContentExceedsLimit(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const size = fs.statSync(filePath).size;
  if (size <= MAX_DOC_CONTENT) return false;
  // A UTF-8 code point uses at most three bytes per UTF-16 code unit. Avoid
  // loading obviously runaway files just to count their decoded characters.
  if (size > MAX_DOC_CONTENT * 3) return true;
  return fs.readFileSync(filePath, 'utf8').length > MAX_DOC_CONTENT;
}

export function versionFilePath(ownerId, docId, n, ext) {
  return path.join(versionsDir(ownerId, docId), `v${n}${ext}`);
}

function loadIndex(ownerId) {
  try {
    const docs = JSON.parse(fs.readFileSync(indexPath(ownerId), 'utf8'));
    return Array.isArray(docs) ? docs : [];
  } catch { return []; }
}

function saveIndex(ownerId, docs) {
  atomicWriteSync(indexPath(ownerId), JSON.stringify(docs, null, 2));
}

export function findOwnedDoc(ownerId, docId) {
  return loadIndex(ownerId).find(d => d.id === docId) ?? null;
}

export function listVersions(ownerId, docId) {
  const doc = findOwnedDoc(ownerId, docId);
  return doc?.versions ?? [];
}

export function readVersion(ownerId, docId, n) {
  const doc = findOwnedDoc(ownerId, docId);
  if (!doc) return null;
  const meta = (doc.versions ?? []).find(v => v.n === Number(n));
  if (!meta) return null;
  try {
    return {
      ...meta,
      text: fs.readFileSync(versionFilePath(ownerId, docId, meta.n, doc.ext), 'utf8'),
    };
  } catch { return null; }
}

/**
 * Write new content as the next version and update the live file.
 * source: 'ai' | 'user' | 'restore'. Returns { n, doc } or { error }.
 */
export async function saveNewVersion({ ownerId, docId, content, source, by, byName, note, expectedVersion = null }) {
  if (typeof content !== 'string') return { error: 'content must be a string' };
  if (content.length > MAX_DOC_CONTENT) {
    return { error: `Content too large (${content.length} chars, max ${MAX_DOC_CONTENT})` };
  }
  const expected = expectedVersion == null ? null : Number(expectedVersion);
  if (expected != null && (!Number.isInteger(expected) || expected < 1)) {
    return { error: 'expectedVersion must be a positive integer' };
  }
  let result;
  await withLock(lockKey(ownerId), () => {
    const docs = loadIndex(ownerId);
    const doc = docs.find(d => d.id === docId);
    if (!doc) { result = { error: `Document "${docId}" not found` }; return; }
    if (!isTextEditable(doc)) {
      result = { error: `"${doc.filename}" (${doc.ext}) is not a text document and can't be edited` };
      return;
    }
    const livePath = path.join(docsDir(ownerId), doc.id + doc.ext);
    const currentVersion = doc.versions?.at(-1)?.n ?? (fs.existsSync(livePath) ? 1 : 0);
    if (expected != null && expected !== currentVersion) {
      result = { error: `Stale document version: expected v${expected}, but current is v${currentVersion}. Reread the document and retry; document was not changed` };
      return;
    }
    if (liveContentExceedsLimit(livePath)) {
      result = { error: `"${doc.filename}" is too large to rewrite safely (max ${MAX_DOC_CONTENT} characters); document was not changed` };
      return;
    }
    const vDir = versionsDir(ownerId, docId);
    fs.mkdirSync(vDir, { recursive: true });

    if (!Array.isArray(doc.versions) || doc.versions.length === 0) {
      // Lazily seed v1 with the pre-edit original
      doc.versions = [];
      if (fs.existsSync(livePath)) {
        fs.copyFileSync(livePath, versionFilePath(ownerId, docId, 1, doc.ext));
        doc.versions.push({
          n: 1,
          size: fs.statSync(livePath).size,
          source: 'upload',
          by: doc.uploadedBy ?? ownerId,
          byName: doc.uploadedByName ?? '',
          note: 'Original',
          at: doc.createdAt ?? new Date().toISOString(),
        });
      }
    }

    const n = (doc.versions.at(-1)?.n ?? 0) + 1;
    atomicWriteSync(versionFilePath(ownerId, docId, n, doc.ext), content);
    atomicWriteSync(livePath, content);
    const meta = {
      n,
      size: Buffer.byteLength(content, 'utf8'),
      source,
      by: by ?? null,
      byName: byName ?? '',
      note: note ?? '',
      at: new Date().toISOString(),
    };
    doc.versions.push(meta);
    doc.size = meta.size;
    doc.updatedAt = meta.at;
    saveIndex(ownerId, docs);
    result = { n, doc };
  });
  return result;
}

/** Re-save an old version's content as the newest version (history stays intact). */
export async function restoreVersion({ ownerId, docId, n, by, byName }) {
  const old = readVersion(ownerId, docId, n);
  if (!old) return { error: `Version ${n} of "${docId}" not found` };
  return saveNewVersion({
    ownerId, docId,
    content: old.text,
    source: 'restore',
    by, byName,
    note: `Restored v${n}`,
  });
}

const EXT_MIME = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain',
  '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html',
  '.xml': 'text/xml', '.yml': 'text/yaml', '.yaml': 'text/yaml',
};

/** Create a brand-new text document with v1 seeded. Returns { doc } or { error }. */
export async function createDocument({ ownerId, filename, content, description, byName }) {
  if (typeof content !== 'string') return { error: 'content must be a string' };
  if (content.length > MAX_DOC_CONTENT) {
    return { error: `Content too large (${content.length} chars, max ${MAX_DOC_CONTENT})` };
  }
  const clean = path.basename(String(filename ?? '').trim() || 'untitled.md');
  const ext = (path.extname(clean) || '.md').toLowerCase();
  const finalName = path.extname(clean) ? clean : clean + '.md';
  // Extension allowlist only — no mime fallback here, since we'd be inventing
  // the mime ourselves and 'text/plain' would wave anything through.
  if (!TEXT_EXTS.has(ext)) return { error: `"${ext}" is not a supported text document type` };

  const id = 'doc_' + randomBytes(6).toString('hex');
  const now = new Date().toISOString();
  const entry = {
    id, filename: finalName, ext, mimeType: EXT_MIME[ext] ?? 'text/plain',
    size: Buffer.byteLength(content, 'utf8'),
    uploadedBy: ownerId,
    uploadedByName: byName ?? '',
    sharedWith: [],
    description: description ?? '',
    createdAt: now,
    updatedAt: now,
    versions: [{ n: 1, size: Buffer.byteLength(content, 'utf8'), source: 'ai', by: ownerId, byName: byName ?? '', note: 'Created', at: now }],
  };
  await withLock(lockKey(ownerId), () => {
    fs.mkdirSync(versionsDir(ownerId, id), { recursive: true });
    atomicWriteSync(path.join(docsDir(ownerId), id + ext), content);
    atomicWriteSync(versionFilePath(ownerId, id, 1, ext), content);
    const docs = loadIndex(ownerId);
    docs.push(entry);
    saveIndex(ownerId, docs);
  });
  return { doc: entry };
}

/**
 * Find a doc visible to userId: their own index first, then docs shared with
 * them via sharing.json. Returns { doc, ownerId } or null.
 */
export function findDocForUser(userId, docId) {
  const own = findOwnedDoc(userId, docId);
  if (own) return { doc: own, ownerId: userId };
  try {
    const shares = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'sharing.json'), 'utf8'));
    const share = shares.find(s => s.fileId === docId
      && (s.sharedWith.includes(userId) || s.sharedWith.includes('*')));
    if (share) {
      const doc = findOwnedDoc(share.ownerId, docId);
      if (doc) return { doc, ownerId: share.ownerId };
    }
  } catch {}
  return null;
}

// ── Research store (users/{id}/research) ─────────────────────────────────────
// Research docs live in their own index ({id, title, tags, filename, …}) but
// get the identical append-only version treatment: v1 = pre-edit original,
// seeded lazily, versions at research/versions/{docId}/v{n}.md.

function researchDir(userId)       { return getUserFilesDir(userId, 'research'); }
function researchIndexPath(userId) { return path.join(researchDir(userId), 'index.json'); }
// Same lock key as routes/research.mjs delete flow
function researchLockKey(userId)   { return researchIndexPath(userId) + '.lock'; }

export function researchVersionPath(userId, docId, n) {
  return path.join(researchDir(userId), 'versions', docId, `v${n}.md`);
}

function loadResearchIndex(userId) {
  try {
    const index = JSON.parse(fs.readFileSync(researchIndexPath(userId), 'utf8'));
    return Array.isArray(index) ? index : [];
  } catch { return []; }
}

export function findResearchDoc(userId, docId) {
  return loadResearchIndex(userId).find(d => d.id === docId) ?? null;
}

export function listResearchVersions(userId, docId) {
  return findResearchDoc(userId, docId)?.versions ?? [];
}

export function readResearchVersion(userId, docId, n) {
  const doc = findResearchDoc(userId, docId);
  if (!doc) return null;
  const meta = (doc.versions ?? []).find(v => v.n === Number(n));
  if (!meta) return null;
  try {
    return { ...meta, text: fs.readFileSync(researchVersionPath(userId, docId, meta.n), 'utf8') };
  } catch { return null; }
}

/** Write new research content as the next version. Returns { n, doc } or { error }. */
export async function saveResearchVersion({ userId, docId, content, source, by, byName, note, expectedVersion = null }) {
  if (typeof content !== 'string') return { error: 'content must be a string' };
  if (content.length > MAX_DOC_CONTENT) {
    return { error: `Content too large (${content.length} chars, max ${MAX_DOC_CONTENT})` };
  }
  const expected = expectedVersion == null ? null : Number(expectedVersion);
  if (expected != null && (!Number.isInteger(expected) || expected < 1)) {
    return { error: 'expectedVersion must be a positive integer' };
  }
  let result;
  await withLock(researchLockKey(userId), () => {
    const index = loadResearchIndex(userId);
    const doc = index.find(d => d.id === docId);
    if (!doc) { result = { error: `Research document "${docId}" not found` }; return; }
    const livePath = path.join(researchDir(userId), path.basename(doc.filename));
    const currentVersion = doc.versions?.at(-1)?.n ?? (fs.existsSync(livePath) ? 1 : 0);
    if (expected != null && expected !== currentVersion) {
      result = { error: `Stale document version: expected v${expected}, but current is v${currentVersion}. Reread the document and retry; document was not changed` };
      return;
    }
    if (liveContentExceedsLimit(livePath)) {
      result = { error: `"${doc.title ?? doc.filename}" is too large to rewrite safely (max ${MAX_DOC_CONTENT} characters); document was not changed` };
      return;
    }
    fs.mkdirSync(path.dirname(researchVersionPath(userId, docId, 1)), { recursive: true });

    if (!Array.isArray(doc.versions) || doc.versions.length === 0) {
      doc.versions = [];
      if (fs.existsSync(livePath)) {
        fs.copyFileSync(livePath, researchVersionPath(userId, docId, 1));
        doc.versions.push({
          n: 1,
          size: fs.statSync(livePath).size,
          source: 'ai',
          by: null,
          byName: 'Deep Research',
          note: 'Original',
          at: doc.createdAt ?? new Date().toISOString(),
        });
      }
    }

    const n = (doc.versions.at(-1)?.n ?? 0) + 1;
    atomicWriteSync(researchVersionPath(userId, docId, n), content);
    atomicWriteSync(livePath, content);
    const meta = {
      n,
      size: Buffer.byteLength(content, 'utf8'),
      source,
      by: by ?? null,
      byName: byName ?? '',
      note: note ?? '',
      at: new Date().toISOString(),
    };
    doc.versions.push(meta);
    doc.updatedAt = meta.at;
    atomicWriteSync(researchIndexPath(userId), JSON.stringify(index, null, 2));
    result = { n, doc };
  });
  return result;
}

/** Re-save an old research version as the newest one (history intact). */
export async function restoreResearchVersion({ userId, docId, n, by, byName }) {
  const old = readResearchVersion(userId, docId, n);
  if (!old) return { error: `Version ${n} of "${docId}" not found` };
  return saveResearchVersion({
    userId, docId,
    content: old.text,
    source: 'restore',
    by, byName,
    note: `Restored v${n}`,
  });
}

/** Owner + requester + anyone the research doc is shared with via sharing.json. */
export function researchAudience(userId, docId, requesterId) {
  const ids = new Set([userId, requesterId].filter(Boolean));
  try {
    const shares = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'sharing.json'), 'utf8'));
    for (const s of shares) {
      if (s.fileId !== docId || s.ownerId !== userId) continue;
      if (s.sharedWith.includes('*')) {
        for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
          if (entry.isDirectory() && fs.existsSync(path.join(USERS_DIR, entry.name, 'profile.json'))) {
            ids.add(entry.name);
          }
        }
      } else {
        for (const id of s.sharedWith) ids.add(id);
      }
    }
  } catch {}
  return [...ids];
}

/**
 * Who should hear doc_changed for this doc: owner + requester + anyone it's
 * shared with ('*' → every user with a profile dir).
 */
export function docAudience(doc, requesterId) {
  const ids = new Set([doc.uploadedBy, requesterId].filter(Boolean));
  const shared = doc.sharedWith ?? [];
  if (shared.includes('*')) {
    try {
      for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory() && fs.existsSync(path.join(USERS_DIR, entry.name, 'profile.json'))) {
          ids.add(entry.name);
        }
      }
    } catch {}
  } else {
    for (const id of shared) ids.add(id);
  }
  return [...ids];
}
