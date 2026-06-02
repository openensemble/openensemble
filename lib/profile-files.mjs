/**
 * Profile-files registry write helper.
 *
 * Single import path for "user uploaded a file, save it under their profile
 * and give back a stable file_id." Reads stay in skills/profile_files (which
 * already understands the docs-index.json + `documents:<id>` ABI). This
 * module only handles writes — it's the missing producer side of the
 * registry.
 *
 * On-disk layout (mirrors what skills/profile_files/execute.mjs reads):
 *   users/<uid>/documents/docs-index.json   — array of metadata entries
 *   users/<uid>/documents/<id><ext>         — the file itself
 *
 * Returned `file_id` is `documents:<id>` — directly usable by:
 *   - read_profile_file tool (skills/profile_files)
 *   - gina_send_email's attachment_doc_ids
 *   - any future skill that takes a file_id
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { withLock } from '../routes/_helpers/io-lock.mjs';
import { USERS_DIR } from './paths.mjs';

function docsDir(userId) { return path.join(USERS_DIR, userId, 'documents'); }
function indexPath(userId) { return path.join(docsDir(userId), 'docs-index.json'); }

function loadIndex(userId) {
  try { return JSON.parse(fs.readFileSync(indexPath(userId), 'utf8')); } catch { return []; }
}
function saveIndex(userId, entries) {
  fs.mkdirSync(docsDir(userId), { recursive: true });
  fs.writeFileSync(indexPath(userId), JSON.stringify(entries, null, 2));
}

/**
 * Persist a user-uploaded file into the registry. Returns the new file_id
 * plus the on-disk path (callers like the expenses extractor still need
 * the path for re-display, even though the canonical reference is the id).
 *
 * @param {string} userId
 * @param {object} opts
 * @param {Buffer} opts.fileData
 * @param {string} opts.fileName       Original filename (preserved for display).
 * @param {string} [opts.mimeType]
 * @param {string} [opts.description]  Free-form note shown in list_profile_files.
 * @param {string} [opts.kind]         Tag for source (chat_upload | receipt | doc).
 *                                     Stored as metadata; not interpreted by the
 *                                     read path today. Useful for future filters.
 * @returns {Promise<{ id, file_id, ext, path, entry }>}
 */
/**
 * Resolve a `documents:doc_xxx` (or bare `doc_xxx`) id to its filesystem
 * path inside the user's documents/ folder. Returns null if the doc id
 * isn't in the user's docs-index or the underlying file is missing.
 *
 * Used by chat.mjs to surface the path of audio/video attachments so the
 * LLM's `transcribe_file` tool can act on them without an extra lookup.
 */
export function getDocumentPath(userId, fileId) {
  if (!userId || !fileId) return null;
  const docId = String(fileId).startsWith('documents:') ? String(fileId).slice('documents:'.length) : String(fileId);
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(indexPath(userId), 'utf8')); } catch { return null; }
  const doc = entries.find(d => d.id === docId);
  if (!doc) return null;
  const filePath = path.join(docsDir(userId), doc.id + doc.ext);
  return fs.existsSync(filePath) ? filePath : null;
}

/**
 * Resolve any profile-file id (documents:doc_xxx, images:name.png,
 * videos:clip.mp4, research:doc_xxx) to its absolute filesystem path.
 * Returns null for unknown prefixes or missing files. Used by chat.mjs to
 * inject a usable path into the LLM's view of an attachment regardless of
 * which folder the chat-upload routing landed it in.
 */
export function getProfileFilePath(userId, fileId) {
  if (!userId || !fileId || typeof fileId !== 'string') return null;
  const colonIdx = fileId.indexOf(':');
  if (colonIdx < 0) return getDocumentPath(userId, fileId);
  const kind = fileId.slice(0, colonIdx);
  const rest = fileId.slice(colonIdx + 1);
  if (kind === 'documents') return getDocumentPath(userId, rest);
  if (kind === 'research') {
    const idx = path.join(USERS_DIR, userId, 'research', 'index.json');
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch { return null; }
    const doc = entries.find(d => d.id === rest);
    if (!doc) return null;
    const p = path.join(USERS_DIR, userId, 'research', doc.filename);
    return fs.existsSync(p) ? p : null;
  }
  if (kind === 'images' || kind === 'videos' || kind === 'audio') {
    // images: / videos: / audio: file_ids are bare filenames keyed off the
    // directory listing — no index. Resist path-traversal: reject embedded
    // separators.
    if (rest.includes('/') || rest.includes('..')) return null;
    const p = path.join(USERS_DIR, userId, kind, rest);
    return fs.existsSync(p) ? p : null;
  }
  return null;
}

/**
 * Like addDocument but ingests an already-on-disk file (e.g. streamed to a
 * tempfile via busboy) by renaming it into place rather than allocating a
 * second buffer in memory. Used by /api/chat-upload's streaming refactor.
 *
 * opts: { srcPath, fileName, mimeType, kind, description }
 *   srcPath  — absolute path of the file currently on disk (will be renamed)
 *   fileName — original filename (drives ext + index entry)
 */
export async function addDocumentFromPath(userId, opts) {
  if (!userId) throw new Error('addDocumentFromPath: userId required');
  const { srcPath, fileName, mimeType, description, kind } = opts || {};
  if (!srcPath || !fileName) throw new Error('addDocumentFromPath: srcPath and fileName required');
  if (!fs.existsSync(srcPath)) throw new Error(`addDocumentFromPath: source missing ${srcPath}`);
  const ext = path.extname(fileName) || '.bin';
  const id  = 'doc_' + randomBytes(6).toString('hex');
  const filePath = path.join(docsDir(userId), id + ext);

  fs.mkdirSync(docsDir(userId), { recursive: true });
  // rename is atomic on the same fs; fall back to copy+unlink across mounts.
  try { fs.renameSync(srcPath, filePath); }
  catch (e) {
    if (e.code === 'EXDEV') { fs.copyFileSync(srcPath, filePath); fs.unlinkSync(srcPath); }
    else throw e;
  }

  const size = fs.statSync(filePath).size;
  const entry = {
    id,
    filename: fileName,
    mimeType: mimeType || 'application/octet-stream',
    size,
    ext,
    createdAt: new Date().toISOString(),
    description: description || '',
    kind: kind || 'doc',
  };
  await withLock(indexPath(userId), () => {
    const entries = loadIndex(userId);
    entries.push(entry);
    saveIndex(userId, entries);
  });
  return { id, file_id: `documents:${id}`, ext, path: filePath, size, entry };
}

export async function addDocument(userId, opts) {
  if (!userId) throw new Error('addDocument: userId required');
  const { fileData, fileName, mimeType, description, kind } = opts || {};
  if (!fileData || !fileName) throw new Error('addDocument: fileData and fileName required');
  const ext = path.extname(fileName) || '.bin';
  const id  = 'doc_' + randomBytes(6).toString('hex');
  const filePath = path.join(docsDir(userId), id + ext);

  fs.mkdirSync(docsDir(userId), { recursive: true });
  fs.writeFileSync(filePath, fileData);

  const entry = {
    id,
    filename: fileName,
    mimeType: mimeType || 'application/octet-stream',
    size:     Buffer.isBuffer(fileData) ? fileData.length : Buffer.byteLength(fileData),
    ext,
    createdAt: new Date().toISOString(),
    description: description || '',
    kind: kind || 'doc',
  };

  await withLock(indexPath(userId), () => {
    const entries = loadIndex(userId);
    entries.push(entry);
    saveIndex(userId, entries);
  });

  return { id, file_id: `documents:${id}`, ext, path: filePath, entry };
}
