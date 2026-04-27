/**
 * Shared Documents — /api/shared-docs
 * Upload, list, download, and ask agents about shared files.
 * Files are stored in each user's documents/ directory.
 * A global sharing.json tracks cross-user access.
 */

import fs   from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { pipeline } from 'stream/promises';
import busboy from 'busboy';
import {
  requireAuth, isPrivileged, loadUsers, readBody, parseMultipart, withLock, BASE_DIR, safeError, getUserDir,
} from './_helpers.mjs';

const SHARING_PATH = path.join(BASE_DIR, 'sharing.json');

// Legacy global shared-docs directory (read-only fallback for unmigrated files)
const LEGACY_DOCS_DIR = path.join(BASE_DIR, 'shared-docs');

function getUserDocsDir(userId) {
  return path.join(getUserDir(userId), 'documents');
}

function getUserIndexPath(userId) {
  return path.join(getUserDocsDir(userId), 'docs-index.json');
}

function loadUserIndex(userId) {
  try { return JSON.parse(fs.readFileSync(getUserIndexPath(userId), 'utf8')); } catch { return []; }
}

function saveUserIndex(userId, docs) {
  const dir = getUserDocsDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getUserIndexPath(userId), JSON.stringify(docs, null, 2));
}

const modifyUserIndex = (userId, fn) => withLock(getUserIndexPath(userId) + '.lock', () => {
  const docs = loadUserIndex(userId);
  fn(docs);
  saveUserIndex(userId, docs);
});

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

// Resolve the file path on disk — checks owner's documents dir, falls back to legacy shared-docs/
function resolveFilePath(doc) {
  const userPath = path.join(getUserDocsDir(doc.uploadedBy), doc.id + doc.ext);
  if (fs.existsSync(userPath)) return userPath;
  // Legacy fallback
  const legacyPath = path.join(LEGACY_DOCS_DIR, doc.id + doc.ext);
  if (fs.existsSync(legacyPath)) return legacyPath;
  return null;
}

function canAccess(doc, userId) {
  if (doc.uploadedBy === userId) return true;
  if (doc.sharedWith?.includes('*') || doc.sharedWith?.includes(userId)) return true;
  // Check sharing.json
  const shares = loadSharing();
  return shares.some(s => s.fileId === doc.id && s.ownerId === doc.uploadedBy && s.sharedWith.includes(userId));
}

async function extractText(fileData, ext) {
  const lower = ext.toLowerCase();
  if (['.txt', '.md', '.csv'].includes(lower))
    return fileData.toString('utf8').slice(0, 50000);
  if (lower === '.pdf') {
    try {
      const { spawn } = await import('child_process');
      const text = await new Promise((resolve, reject) => {
        const proc = spawn('pdftotext', ['-', '-'], { timeout: 15000 });
        const chunks = [];
        proc.stdout.on('data', c => chunks.push(c));
        proc.on('error', reject);
        proc.on('close', code => {
          if (code !== 0) reject(new Error(`pdftotext exited ${code}`));
          else resolve(Buffer.concat(chunks).toString());
        });
        proc.stdin.end(fileData);
      });
      return text.slice(0, 50000);
    } catch {
      return fileData.toString('utf8').replace(/[^\x20-\x7E\n]/g, ' ').slice(0, 30000);
    }
  }
  return '';
}

// Collect all docs visible to this user: own docs + docs shared with them
function getVisibleDocs(userId) {
  // Own docs
  const ownDocs = loadUserIndex(userId);

  // Docs shared with this user via sharing.json
  const shares = loadSharing();
  const sharedWithMe = shares.filter(s => s.sharedWith.includes(userId) && s.ownerId !== userId);
  const sharedDocs = [];
  for (const share of sharedWithMe) {
    const ownerDocs = loadUserIndex(share.ownerId);
    const doc = ownerDocs.find(d => d.id === share.fileId);
    if (doc) sharedDocs.push(doc);
  }

  // Legacy: check old global index for unmigrated docs
  let legacyDocs = [];
  const legacyIndexPath = path.join(LEGACY_DOCS_DIR, 'index.json');
  if (fs.existsSync(legacyIndexPath)) {
    try {
      const allLegacy = JSON.parse(fs.readFileSync(legacyIndexPath, 'utf8'));
      legacyDocs = allLegacy.filter(d =>
        d.uploadedBy === userId ||
        d.sharedWith?.includes('*') ||
        d.sharedWith?.includes(userId)
      );
    } catch {}
  }

  // Dedupe by id (prefer per-user over legacy)
  const seen = new Set(ownDocs.map(d => d.id));
  for (const d of sharedDocs) {
    if (!seen.has(d.id)) { ownDocs.push(d); seen.add(d.id); }
  }
  for (const d of legacyDocs) {
    if (!seen.has(d.id)) { ownDocs.push(d); seen.add(d.id); }
  }

  return ownDocs;
}

// Find a doc by id across user's own index and legacy index
function findDoc(docId, userId) {
  // Check user's own docs
  const ownDocs = loadUserIndex(userId);
  let doc = ownDocs.find(d => d.id === docId);
  if (doc) return doc;

  // Check sharing.json to find the owner
  const shares = loadSharing();
  const share = shares.find(s => s.fileId === docId && s.sharedWith.includes(userId));
  if (share) {
    const ownerDocs = loadUserIndex(share.ownerId);
    doc = ownerDocs.find(d => d.id === docId);
    if (doc) return doc;
  }

  // Legacy fallback
  const legacyIndexPath = path.join(LEGACY_DOCS_DIR, 'index.json');
  if (fs.existsSync(legacyIndexPath)) {
    try {
      const allLegacy = JSON.parse(fs.readFileSync(legacyIndexPath, 'utf8'));
      doc = allLegacy.find(d => d.id === docId);
      if (doc && canAccess(doc, userId)) return doc;
    } catch {}
  }

  return null;
}

export async function handle(req, res) {
  const url      = new URL(req.url, 'http://x');
  const pathname = url.pathname;

  // ── GET /api/shared-docs — list accessible docs ────────────────────────────
  if (pathname === '/api/shared-docs' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const users = loadUsers();
    const docs  = getVisibleDocs(userId)
      .map(d => ({
        ...d,
        uploadedByName: users.find(u => u.id === d.uploadedBy)?.name ?? 'Unknown',
        isOwn: d.uploadedBy === userId,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(docs));
    return true;
  }

  // ── POST /api/shared-docs — upload a document ──────────────────────────────
  // [TEST 2026-04-27] Streams the multipart body directly to disk via
  // busboy — earlier implementation buffered the whole file in memory
  // (25MB → 500MB cap) which made large videos OOM-prone and forced an
  // RSS spike of 1.5× the file size during parse. Now memory stays flat
  // regardless of upload size; only a temp file under documents/ holds
  // the bytes.
  if (pathname === '/api/shared-docs' && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    try {
      const ct = req.headers['content-type'] ?? '';
      if (!ct.startsWith('multipart/form-data')) throw new Error('Expected multipart/form-data');

      // Per-file cap. Crosses the wire as Content-Length first; if the
      // browser lies, busboy enforces again as bytes flow.
      const MAX = 500 * 1024 * 1024;
      const advertised = Number(req.headers['content-length']) || 0;
      if (advertised && advertised > MAX) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `File too large — limit is ${MAX / 1024 / 1024} MB, got ${(advertised / 1024 / 1024).toFixed(1)} MB` }));
        return true;
      }

      const sharedWithRaw = url.searchParams.get('sharedWith') ?? '';
      const sharedWith    = sharedWithRaw ? sharedWithRaw.split(',').filter(Boolean) : [];
      const description   = url.searchParams.get('description') ?? '';

      const id      = 'doc_' + randomBytes(6).toString('hex');
      const docsDir = getUserDocsDir(userId);
      fs.mkdirSync(docsDir, { recursive: true });

      const result = await new Promise((resolve, reject) => {
        const bb = busboy({
          headers: req.headers,
          limits: { fileSize: MAX, files: 1 },
        });
        let landed = false;
        let cleanupTmp = null;

        bb.on('file', (_field, stream, info) => {
          if (landed) { stream.resume(); return; }
          landed = true;
          const fileName = info.filename || 'upload.bin';
          const mimeType = info.mimeType || info.mime || 'application/octet-stream';
          const ext      = path.extname(fileName) || '.bin';
          const dest     = path.join(docsDir, id + ext);
          const tmp      = `${dest}.part`;
          cleanupTmp     = tmp;

          let truncated = false;
          stream.on('limit', () => { truncated = true; });

          const out = fs.createWriteStream(tmp);
          pipeline(stream, out)
            .then(() => {
              if (truncated) {
                try { fs.unlinkSync(tmp); } catch {}
                reject(new Error(`File too large (max ${MAX / 1024 / 1024} MB)`));
                return;
              }
              fs.renameSync(tmp, dest);
              const size = fs.statSync(dest).size;
              resolve({ fileName, mimeType, ext, dest, size });
            })
            .catch(err => {
              try { fs.unlinkSync(tmp); } catch {}
              reject(err);
            });
        });
        bb.on('error', err => {
          if (cleanupTmp) { try { fs.unlinkSync(cleanupTmp); } catch {} }
          reject(err);
        });
        bb.on('close', () => {
          if (!landed) reject(new Error('No file found in upload'));
        });
        req.on('aborted', () => {
          if (cleanupTmp) { try { fs.unlinkSync(cleanupTmp); } catch {} }
          reject(new Error('Upload aborted'));
        });
        req.pipe(bb);
      });

      const { fileName, mimeType, ext, size } = result;
      const users    = loadUsers();
      const uploader = users.find(u => u.id === userId);

      const entry = {
        id, filename: fileName, ext, mimeType,
        size,
        uploadedBy: userId,
        uploadedByName: uploader?.name ?? 'Unknown',
        sharedWith,
        description,
        createdAt: new Date().toISOString(),
      };
      await modifyUserIndex(userId, docs => docs.push(entry));

      // If shared with specific users, add to sharing.json
      if (sharedWith.length > 0 && !sharedWith.includes('*')) {
        await modifySharing(shares => {
          shares.push({
            id: 'share_' + randomBytes(6).toString('hex'),
            ownerId: userId,
            fileType: 'document',
            fileId: id,
            filePath: `documents/${id}${ext}`,
            filename: fileName,
            sharedWith,
            sharedAt: new Date().toISOString(),
          });
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, doc: entry }));
    } catch (e) { safeError(res, e, 400); }
    return true;
  }

  // ── GET /api/shared-docs/:id/thumbnail — cached JPEG thumbnail ────────────
  const thumbMatch = pathname.match(/^\/api\/shared-docs\/([^/]+)\/thumbnail$/);
  if (thumbMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const doc = findDoc(thumbMatch[1], userId);
    if (!doc) { res.writeHead(404); res.end(); return true; }

    const THUMBS_DIR = path.join(getUserDocsDir(doc.uploadedBy), 'thumbs');
    const thumbPath  = path.join(THUMBS_DIR, doc.id + '.jpg');

    // Serve cached thumbnail immediately if available
    if (fs.existsSync(thumbPath)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
      fs.createReadStream(thumbPath).pipe(res);
      return true;
    }

    const filePath = resolveFilePath(doc);
    if (!filePath) { res.writeHead(404); res.end(); return true; }

    const lower    = doc.ext.toLowerCase();
    const isPdf    = lower === '.pdf' || doc.mimeType.includes('pdf');
    const isOffice = ['.doc','.docx','.xls','.xlsx','.ppt','.pptx','.odt','.ods','.odp'].includes(lower);
    if (!isPdf && !isOffice) { res.writeHead(404); res.end(); return true; }

    try {
      const { spawn }  = await import('child_process');
      const { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } = fs;
      const tmpDir = mkdtempSync('/tmp/oe-thumb-');
      mkdirSync(THUMBS_DIR, { recursive: true });

      let pdfPath = isPdf ? filePath : null;

      if (isOffice) {
        await new Promise((resolve, reject) => {
          const proc = spawn('libreoffice', ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, filePath], { timeout: 30000 });
          proc.on('close', code => code === 0 ? resolve() : reject(new Error('LibreOffice conversion failed')));
          proc.on('error', reject);
        });
        const generated = readdirSync(tmpDir).find(f => f.endsWith('.pdf'));
        if (!generated) throw new Error('No PDF output from LibreOffice');
        pdfPath = path.join(tmpDir, generated);
      }

      // Render page 1 as JPEG via pdftoppm
      const outPrefix = path.join(tmpDir, 'page');
      await new Promise((resolve, reject) => {
        const proc = spawn('pdftoppm', ['-jpeg', '-r', '120', '-f', '1', '-l', '1', pdfPath, outPrefix], { timeout: 15000 });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error('pdftoppm failed')));
        proc.on('error', reject);
      });

      const pageFile = readdirSync(tmpDir).find(f => f.startsWith('page') && f.endsWith('.jpg'));
      if (!pageFile) throw new Error('No JPEG output from pdftoppm');
      copyFileSync(path.join(tmpDir, pageFile), thumbPath);
      try { rmSync(tmpDir, { recursive: true }); } catch {}

      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
      fs.createReadStream(thumbPath).pipe(res);
    } catch (e) {
      console.warn(`[shared-docs] thumbnail failed for ${doc.id}:`, e.message);
      res.writeHead(404); res.end();
    }
    return true;
  }

  // ── GET /api/shared-docs/:id/view — inline for img/video/iframe ───────────
  const viewMatch = pathname.match(/^\/api\/shared-docs\/([^/]+)\/view$/);
  if (viewMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const doc = findDoc(viewMatch[1], userId);
    if (!doc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    }
    const filePath = resolveFilePath(doc);
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File missing on disk' }));
      return true;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': doc.mimeType,
      'Content-Length': stat.size,
      'Content-Disposition': `inline; filename="${encodeURIComponent(doc.filename)}"`,
      'Cache-Control': 'private, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // ── GET /api/shared-docs/:id/download ─────────────────────────────────────
  const dlMatch = pathname.match(/^\/api\/shared-docs\/([^/]+)\/download$/);
  if (dlMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const doc = findDoc(dlMatch[1], userId);
    if (!doc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    }
    const filePath = resolveFilePath(doc);
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File missing on disk' }));
      return true;
    }
    res.writeHead(200, {
      'Content-Type': doc.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(doc.filename)}"`,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // ── GET /api/shared-docs/:id/content — text/image payload for AI ──────────
  const contentMatch = pathname.match(/^\/api\/shared-docs\/([^/]+)\/content$/);
  if (contentMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const doc = findDoc(contentMatch[1], userId);
    if (!doc) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    }
    const filePath = resolveFilePath(doc);
    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File missing on disk' }));
      return true;
    }
    const fileData = fs.readFileSync(filePath);
    const isImage  = doc.mimeType.startsWith('image/');
    if (isImage) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ isImage: true, base64: fileData.toString('base64'), mimeType: doc.mimeType, name: doc.filename }));
      return true;
    }
    const text = await extractText(fileData, doc.ext);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ isImage: false, text, name: doc.filename, mimeType: doc.mimeType }));
    return true;
  }

  // ── PATCH /api/shared-docs/:id — update sharing/description ───────────────
  const patchMatch = pathname.match(/^\/api\/shared-docs\/([^/]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const userId = requireAuth(req, res); if (!userId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      const doc = findDoc(patchMatch[1], userId);
      if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return true; }
      if (doc.uploadedBy !== userId && !isPrivileged(userId)) {
        res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not authorized' })); return true;
      }
      await modifyUserIndex(doc.uploadedBy, docs => {
        const d = docs.find(x => x.id === patchMatch[1]);
        if (!d) return;
        if (Array.isArray(body.sharedWith)) d.sharedWith = body.sharedWith;
        if (body.description !== undefined) d.description = body.description;
      });

      // Update sharing.json if sharedWith changed
      if (Array.isArray(body.sharedWith)) {
        await modifySharing(shares => {
          const idx = shares.findIndex(s => s.fileId === doc.id && s.ownerId === doc.uploadedBy);
          if (body.sharedWith.length > 0 && !body.sharedWith.includes('*')) {
            if (idx !== -1) {
              shares[idx].sharedWith = body.sharedWith;
            } else {
              shares.push({
                id: 'share_' + randomBytes(6).toString('hex'),
                ownerId: doc.uploadedBy,
                fileType: 'document',
                fileId: doc.id,
                filePath: `documents/${doc.id}${doc.ext}`,
                filename: doc.filename,
                sharedWith: body.sharedWith,
                sharedAt: new Date().toISOString(),
              });
            }
          } else if (idx !== -1) {
            shares.splice(idx, 1);
          }
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) { safeError(res, e, 400); }
    return true;
  }

  // ── DELETE /api/shared-docs/:id ────────────────────────────────────────────
  const delMatch = pathname.match(/^\/api\/shared-docs\/([^/]+)$/);
  if (delMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const doc = findDoc(delMatch[1], userId);
    if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    if (doc.uploadedBy !== userId && !isPrivileged(userId)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not authorized' })); return true;
    }
    // Remove from owner's index
    await modifyUserIndex(doc.uploadedBy, docs => {
      const idx = docs.findIndex(d => d.id === delMatch[1]);
      if (idx !== -1) docs.splice(idx, 1);
    });
    // Remove from sharing.json
    await modifySharing(shares => {
      const idx = shares.findIndex(s => s.fileId === doc.id && s.ownerId === doc.uploadedBy);
      if (idx !== -1) shares.splice(idx, 1);
    });
    // Delete file from disk
    const filePath = resolveFilePath(doc);
    if (filePath) try { fs.unlinkSync(filePath); } catch {}
    // Clean up thumbnail
    const thumbPath = path.join(getUserDocsDir(doc.uploadedBy), 'thumbs', doc.id + '.jpg');
    try { fs.unlinkSync(thumbPath); } catch {}

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}
