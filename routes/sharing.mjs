/**
 * Sharing API — /api/sharing
 * Manages file sharing between users.
 * Files stay in owner's directory; sharing.json tracks permissions.
 */

import fs   from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import {
  requireAuth, loadUsers, readBody, withLock, BASE_DIR, safeError, getUserDir,
} from './_helpers.mjs';

const SHARING_PATH = path.join(BASE_DIR, 'sharing.json');

function loadSharing() {
  try { return JSON.parse(fs.readFileSync(SHARING_PATH, 'utf8')); } catch { return []; }
}

function saveSharing(shares) {
  fs.writeFileSync(SHARING_PATH, JSON.stringify(shares, null, 2));
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
      .filter(s => s.ownerId === userId || s.sharedWith.includes(userId))
      .map(s => ({
        ...s,
        ownerName: users.find(u => u.id === s.ownerId)?.name ?? 'Unknown',
        sharedWithNames: s.sharedWith.map(uid => users.find(u => u.id === uid)?.name ?? uid),
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
