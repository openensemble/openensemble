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
