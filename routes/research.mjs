/**
 * Research routes: /api/research*
 * Lists, retrieves, and deletes saved research documents for the authenticated user.
 */

import fs from 'fs';
import path from 'path';
import { requireAuth, getSessionUserId, getAuthToken, safeId, BASE_DIR, getUserDir, withLock, loadUsers } from './_helpers.mjs';
import { listResearchVersions, readResearchVersion, restoreResearchVersion, researchAudience } from '../lib/doc-store.mjs';
import { broadcastToUsers } from './_helpers/broadcast.mjs';

function getUserResearchDir(userId) {
  return path.join(getUserDir(userId), 'research');
}

function loadIndex(userId) {
  const indexPath = path.join(getUserResearchDir(userId), 'index.json');
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch { return []; }
}

export async function handle(req, res) {
  // GET /api/research — list documents for the authenticated user
  if (req.url === '/api/research' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const index = loadIndex(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(index));
    return true;
  }

  // GET /api/research/:id/versions/:n — one version's text
  const versionMatch = req.url.match(/^\/api\/research\/(doc_[\w]+)\/versions\/(\d+)$/);
  if (versionMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const version = readResearchVersion(userId, versionMatch[1], Number(versionMatch[2]));
    if (!version) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Version not found' })); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(version));
    return true;
  }

  // GET /api/research/:id/versions — version history metadata
  const versionsMatch = req.url.match(/^\/api\/research\/(doc_[\w]+)\/versions$/);
  if (versionsMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const index = loadIndex(userId);
    if (!index.some(d => d.id === versionsMatch[1])) {
      res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ versions: listResearchVersions(userId, versionsMatch[1]), editable: true, isOwn: true }));
    return true;
  }

  // POST /api/research/:id/restore/:n — restore an old version
  const restoreMatch = req.url.match(/^\/api\/research\/(doc_[\w]+)\/restore\/(\d+)$/);
  if (restoreMatch && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const byName = loadUsers().find(u => u.id === userId)?.name ?? 'User';
    const result = await restoreResearchVersion({
      userId, docId: restoreMatch[1], n: Number(restoreMatch[2]), by: userId, byName,
    });
    if (result.error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: result.error })); return true; }
    try {
      broadcastToUsers(researchAudience(userId, restoreMatch[1], userId), {
        type: 'doc_changed', docId: restoreMatch[1], filename: result.doc.title ?? restoreMatch[1],
        source: 'research', action: 'restored', version: result.n, byName,
      });
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: result.n }));
    return true;
  }

  // GET /api/research/:id — get document content
  const getMatch = req.url.match(/^\/api\/research\/(doc_[\w]+)$/);
  if (getMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const docId = getMatch[1];
    const index = loadIndex(userId);
    const doc = index.find(d => d.id === docId);
    if (!doc) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    const filePath = path.join(getUserResearchDir(userId), path.basename(doc.filename)) // index data is user-editable — never let it traverse;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...doc, content }));
    } catch {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Document file not found' }));
    }
    return true;
  }

  // DELETE /api/research/:id — delete document
  const delMatch = req.url.match(/^\/api\/research\/(doc_[\w]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const docId = delMatch[1];
    const dir = getUserResearchDir(userId);
    const indexPath = path.join(dir, 'index.json');
    // Serialize index read/write so concurrent deletes don't clobber each other.
    const result = await withLock(indexPath + '.lock', () => {
      const index = loadIndex(userId);
      const idx = index.findIndex(d => d.id === docId);
      if (idx === -1) return { notFound: true };
      const doc = index[idx];
      try { fs.unlinkSync(path.join(dir, path.basename(doc.filename))); } catch {}
      try { fs.rmSync(path.join(dir, 'versions', docId), { recursive: true, force: true }); } catch {}
      index.splice(idx, 1);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
      return { ok: true };
    });
    if (result.notFound) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return true;
  }

  return false;
}
