/**
 * Unified email attachment resolver.
 *
 * Accepts attachment identifiers in any of these forms (mix freely):
 *   'images:filename.png'   — generated image in users/<uid>/images/
 *   'videos:filename.mp4'   — generated video in users/<uid>/videos/
 *   'documents:doc_xxx'     — uploaded file from per-user docs-index.json
 *   'research:doc_xxx'      — saved research markdown
 *   '<bare-id>'             — legacy shared-doc id (shared-docs/index.json)
 *
 * Returns: [{ filename, mimeType, data: Buffer }]
 */

import fs from 'fs';
import path from 'path';
import { BASE_DIR, USERS_DIR } from './paths.mjs';

const SHARED_DOCS_DIR   = path.join(BASE_DIR, 'shared-docs');
const SHARED_DOCS_INDEX = path.join(SHARED_DOCS_DIR, 'index.json');

const MIME_BY_EXT = {
  '.png': 'image/png',  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',  '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',  '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.md':  'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv',
  '.pdf': 'application/pdf', '.json': 'application/json',
};
function mimeFor(name) {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

function loadSharedDoc(id, userId) {
  let index = [];
  try { index = JSON.parse(fs.readFileSync(SHARED_DOCS_INDEX, 'utf8')); } catch { return null; }
  const doc = index.find(d => d.id === id);
  if (!doc) return null;
  if (doc.uploadedBy !== userId
      && !doc.sharedWith?.includes('*')
      && !doc.sharedWith?.includes(userId)) return null;
  const filePath = path.join(SHARED_DOCS_DIR, doc.id + doc.ext);
  if (!fs.existsSync(filePath)) return null;
  return { filename: doc.filename, mimeType: doc.mimeType, data: fs.readFileSync(filePath) };
}

function loadProfileMedia(folder, name, userId) {
  const safe = path.basename(name ?? '');
  if (!safe || safe === '.' || safe === '..') return null;
  const filePath = path.join(USERS_DIR, userId, folder, safe);
  if (!fs.existsSync(filePath)) return null;
  return { filename: safe, mimeType: mimeFor(safe), data: fs.readFileSync(filePath) };
}

function loadProfileDocument(internalId, userId) {
  const idx = path.join(USERS_DIR, userId, 'documents', 'docs-index.json');
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch { return null; }
  const doc = entries.find(d => d.id === internalId);
  if (!doc) return null;
  const filePath = path.join(USERS_DIR, userId, 'documents', doc.id + doc.ext);
  if (!fs.existsSync(filePath)) return null;
  return { filename: doc.filename, mimeType: doc.mimeType, data: fs.readFileSync(filePath) };
}

function loadProfileResearch(internalId, userId) {
  const idx = path.join(USERS_DIR, userId, 'research', 'index.json');
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch { return null; }
  const doc = entries.find(d => d.id === internalId);
  if (!doc) return null;
  const filePath = path.join(USERS_DIR, userId, 'research', doc.filename);
  if (!fs.existsSync(filePath)) return null;
  return { filename: doc.filename, mimeType: 'text/markdown', data: fs.readFileSync(filePath) };
}

/**
 * @returns {{ attachments: Array<{filename,mimeType,data}>, errors: string[] }}
 *   `errors` lists the input ids that failed to resolve to a real file, so
 *   callers can short-circuit instead of silently sending an attachment-less
 *   email when the agent passed bad ids.
 */
export function loadEmailAttachments(ids, userId) {
  if (!Array.isArray(ids) || !ids.length) return { attachments: [], errors: [] };
  const attachments = [];
  const errors = [];
  for (const raw of ids) {
    if (typeof raw !== 'string' || !raw.trim()) {
      errors.push(String(raw));
      continue;
    }
    const id = raw.trim();
    let att = null;
    const colon = id.indexOf(':');
    if (colon !== -1) {
      const folder = id.slice(0, colon);
      const rest   = id.slice(colon + 1);
      if (folder === 'images' || folder === 'videos') att = loadProfileMedia(folder, rest, userId);
      else if (folder === 'documents') att = loadProfileDocument(rest, userId);
      else if (folder === 'research')  att = loadProfileResearch(rest, userId);
    }
    // Fallback: treat the whole string as a shared-doc id (covers legacy callers
    // and bare ids that happen to contain a colon).
    if (!att) att = loadSharedDoc(id, userId);
    if (att) attachments.push(att);
    else errors.push(id);
  }
  return { attachments, errors };
}

/**
 * Returns a user-facing error string when attachment ids were provided but at
 * least one failed to resolve, or null when everything is fine.
 */
export function attachmentResolutionError(requestedIds, errors) {
  if (!errors?.length) return null;
  const requested = Array.isArray(requestedIds) ? requestedIds.length : 0;
  return `Could not attach ${errors.length} of ${requested} requested file(s): ${errors.join(', ')}. ` +
    `Refusing to send the email without the attachment(s). ` +
    `Call list_profile_files (or list_shared_docs) to find the correct id and try again. ` +
    `Accepted forms: 'images:NAME', 'videos:NAME', 'documents:doc_xxx', 'research:doc_xxx', or a bare shared-doc id.`;
}
