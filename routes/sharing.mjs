/**
 * Sharing API — /api/sharing
 * Manages file sharing between users.
 * Files stay in owner's directory; sharing.json tracks permissions.
 */

import fs   from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import {
  requireAuth, loadUsers, readBody, withLock, atomicWriteSync, BASE_DIR, safeError, getUserDir,
} from './_helpers.mjs';

const SHARING_PATH = path.join(BASE_DIR, 'sharing.json');

function loadSharing() {
  try { return JSON.parse(fs.readFileSync(SHARING_PATH, 'utf8')); } catch { return []; }
}

function saveSharing(shares) {
  atomicWriteSync(SHARING_PATH, JSON.stringify(shares, null, 2));
}

const modifySharing = fn => withLock(SHARING_PATH + '.lock', () => {
  const shares = loadSharing();
  fn(shares);
  saveSharing(shares);
});

// Validate that the file exists in the owner's directory
function validateOwnership(userId, fileType, fileId) {
  const userDir = getUserDir(userId);
  let indexPath;
  switch (fileType) {
    case 'document':
      indexPath = path.join(userDir, 'documents', 'docs-index.json');
      break;
    case 'research':
      indexPath = path.join(userDir, 'research', 'index.json');
      break;
    case 'image':
    case 'video':
    case 'audio':
    case 'invoice':
      // These don't have index files; check if the file exists in the directory
      return true;
    default:
      return false;
  }
  if (!indexPath) return false;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    return index.some(d => d.id === fileId);
  } catch { return false; }
}

export async function handle(req, res) {
  const url      = new URL(req.url, 'http://x');
  const pathname = url.pathname;

  // ── GET /api/sharing — list shares (files I shared + files shared with me) ─
  if (pathname === '/api/sharing' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const shares = loadSharing();
    const users  = loadUsers();
    const result = shares
      .filter(s => s.ownerId === userId || s.sharedWith.includes(userId) || s.sharedWith.includes('*'))
      .map(s => ({
        ...s,
        ownerName: users.find(u => u.id === s.ownerId)?.name ?? 'Unknown',
        sharedWithNames: s.sharedWith.map(uid => uid === '*' ? 'Everyone' : (users.find(u => u.id === uid)?.name ?? uid)),
        isOwn: s.ownerId === userId,
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return true;
  }

  // ── POST /api/sharing — share a file ───────────────────────────────────────
  if (pathname === '/api/sharing' && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      const { fileType, fileId, sharedWith } = body;

      if (!fileType || !fileId || !Array.isArray(sharedWith) || sharedWith.length === 0) {
        throw new Error('fileType, fileId, and sharedWith[] are required.');
      }
      // Reject filenames with path separators or traversal — resolveSharedFile
      // joins this into a path, so '../' would escape the owner's directory and
      // let listing endpoints probe arbitrary files.
      if (body.filename != null) {
        if (typeof body.filename !== 'string' || body.filename.includes('/') || body.filename.includes('\\') || body.filename.includes('\0') || body.filename.split('/').some(p => p === '..')) {
          throw new Error('Invalid filename.');
        }
      }

      // Code cannot be shared
      if (fileType === 'code') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Code projects cannot be shared.' }));
        return true;
      }

      // Validate ownership
      if (!validateOwnership(userId, fileType, fileId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found in your directory.' }));
        return true;
      }

      let shareId;
      await modifySharing(shares => {
        // Check if already shared
        const existing = shares.find(s => s.fileId === fileId && s.ownerId === userId);
        if (existing) {
          // Merge sharedWith
          const combined = new Set([...existing.sharedWith, ...sharedWith]);
          existing.sharedWith = [...combined];
          shareId = existing.id;
        } else {
          shareId = 'share_' + randomBytes(6).toString('hex');
          shares.push({
            id: shareId,
            ownerId: userId,
            fileType,
            fileId,
            filename: body.filename ?? fileId,
            sharedWith,
            sharedAt: new Date().toISOString(),
          });
        }
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shareId }));
    } catch (e) { safeError(res, e, 400); }
    return true;
  }

  // ── DELETE /api/sharing/:shareId — unshare (owner only) ───────────────────
  const downloadMatch = pathname.match(/^\/api\/sharing\/([^/]+)\/download$/);
  if (downloadMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const share = loadSharing().find(s => s.id === downloadMatch[1]);
    if (!share || (share.ownerId !== userId && !share.sharedWith.includes(userId) && !share.sharedWith.includes('*'))) {
      res.writeHead(404); res.end('Shared file unavailable'); return true;
    }
    const directory = { document: 'documents', research: 'research', image: 'images', video: 'videos', audio: 'audio', invoice: 'invoices' }[share.fileType];
    if (!directory) { res.writeHead(404); res.end('Shared file unavailable'); return true; }
    try {
      const root = fs.realpathSync(path.join(getUserDir(share.ownerId), directory));
      let name = share.filename;
      if (share.fileType === 'document' || share.fileType === 'research') {
        const index = JSON.parse(fs.readFileSync(path.join(root, share.fileType === 'document' ? 'docs-index.json' : 'index.json'), 'utf8'));
        const doc = index.find(d => d.id === share.fileId);
        if (!doc) throw new Error('Missing document');
        name = share.fileType === 'document' ? doc.id + doc.ext : doc.filename;
      }
      if (typeof name !== 'string' || name !== path.basename(name) || name.includes('\\')) throw new Error('Invalid file');
      const file = fs.realpathSync(path.join(root, name));
      if (!file.startsWith(root + path.sep)) throw new Error('Invalid file');
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error('Invalid file');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(share.filename || name))}"`, 'Content-Length': stat.size });
      const stream = fs.createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
    } catch { res.writeHead(404); res.end('Shared file unavailable'); }
    return true;
  }

  const patchMatch = pathname.match(/^\/api\/sharing\/([^/]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const userId = requireAuth(req, res); if (!userId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      const allowed = new Set(loadUsers().map(u => u.id)); allowed.add('*');
      if (!Array.isArray(body.sharedWith) || body.sharedWith.some(id => typeof id !== 'string' || !allowed.has(id))) throw new Error('Choose valid recipients.');
      if (body.expectedSharedWith !== undefined && !Array.isArray(body.expectedSharedWith)) throw new Error('Invalid expected recipients.');
      let result;
      await modifySharing(shares => {
        const share = shares.find(s => s.id === patchMatch[1]);
        if (!share || share.ownerId !== userId) { result = { status: 404, error: 'Share unavailable.' }; return; }
        if (body.expectedSharedWith && JSON.stringify([...share.sharedWith].sort()) !== JSON.stringify([...body.expectedSharedWith].sort())) {
          result = { status: 409, error: 'Recipients changed. Refresh before editing.' }; return;
        }
        share.sharedWith = [...new Set(body.sharedWith)]; result = { status: 200, ok: true, shareId: share.id };
      });
      res.writeHead(result.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (e) { safeError(res, e, 400); }
    return true;
  }

  const delMatch = pathname.match(/^\/api\/sharing\/([^/]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const shareId = delMatch[1];
    const shares = loadSharing();
    const share = shares.find(s => s.id === shareId);
    if (!share) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Share not found.' }));
      return true;
    }
    if (share.ownerId !== userId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Only the owner can unshare.' }));
      return true;
    }
    await modifySharing(shares => {
      const idx = shares.findIndex(s => s.id === shareId);
      if (idx !== -1) shares.splice(idx, 1);
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}
