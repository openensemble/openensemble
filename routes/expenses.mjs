/**
 * Expense routes: /api/expenses/*, /api/expense-groups/*, /api/expense-books/*, /api/chat-upload
 */

import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import {
  requireAuth, isPrivileged, loadUsers, loadConfig, readBody, parseMultipart,
  loadExpGroups, getExpGroupMemberIds,
  modifyExpGroups, withLock,
  loadExpBooks, getExpBooksForUser, modifyExpBooks,
  EXPENSES_DB, safeError,
} from './_helpers.mjs';
import { extractTransactions } from '../skills/expenses/execute.mjs';
import { addDocument, addDocumentFromPath } from '../lib/profile-files.mjs';
import busboy from 'busboy';
import os from 'os';
import { pipeline } from 'stream/promises';

async function extractText(fileData, ext) {
  const isPdf = ext.toLowerCase() === '.pdf';
  const isCsv = ext.toLowerCase() === '.csv';
  if (isCsv) return fileData.toString('utf8').slice(0, 30000);
  if (isPdf) {
    try {
      const { spawn } = await import('child_process');
      const text = await new Promise((resolve, reject) => {
        const proc = spawn('pdftotext', ['-', '-'], { timeout: 15000 });
        const chunks = [];
        proc.stdout.on('data', chunk => chunks.push(chunk));
        proc.on('error', reject);
        proc.on('close', code => {
          if (code !== 0) reject(new Error(`pdftotext exited with code ${code}`));
          else resolve(Buffer.concat(chunks).toString());
        });
        proc.stdin.end(fileData);
      });
      return text.slice(0, 30000);
    } catch (e) {
      console.warn('[expenses] pdftotext failed, falling back to raw text:', e.message);
      return fileData.toString('utf8').replace(/[^\x20-\x7E\n]/g, ' ').slice(0, 30000);
    }
  }
  return '';
}

export async function handle(req, res) {
  // Chat file upload (images + docs for any agent)
  if (req.url === '/api/chat-upload' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    // Streaming multipart parse via busboy — body goes straight from socket
    // to a temp file on disk, then gets moved into its final folder once
    // we know the MIME. Avoids buffering 500 MB in RAM (the old buffer-
    // then-parse pattern) and matches the same shape /api/shared-docs uses.
    const MAX_UPLOAD = 500 * 1024 * 1024;
    const ct = req.headers['content-type'] ?? '';
    if (!ct.startsWith('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
      return true;
    }
    const advertised = Number(req.headers['content-length']) || 0;
    if (advertised && advertised > MAX_UPLOAD) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `File too large — limit is ${MAX_UPLOAD / 1024 / 1024} MB, got ${(advertised / 1024 / 1024).toFixed(1)} MB` }));
      return true;
    }

    try {
      // Stream to a tmpfile first so we can route by MIME after we see the
      // file header. Move (rename) into final destination once we know.
      const tmpPath = path.join(os.tmpdir(), `oe-chat-upload-${Date.now()}-${randomBytes(4).toString('hex')}`);
      const parsed = await new Promise((resolve, reject) => {
        const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD, files: 1 } });
        let landed = false;
        let cleanupTmp = null;
        let captured = null;

        bb.on('file', (_field, stream, info) => {
          if (landed) { stream.resume(); return; }
          landed = true;
          const fileName = info.filename || 'upload.bin';
          const mimeType = info.mimeType || info.mime || 'application/octet-stream';
          cleanupTmp = tmpPath;
          let truncated = false;
          stream.on('limit', () => { truncated = true; });
          const out = fs.createWriteStream(tmpPath);
          pipeline(stream, out)
            .then(() => {
              if (truncated) {
                try { fs.unlinkSync(tmpPath); } catch {}
                reject(new Error(`File too large (max ${MAX_UPLOAD / 1024 / 1024} MB)`));
                return;
              }
              captured = { fileName, mimeType, tmpPath };
              resolve(captured);
            })
            .catch(err => {
              try { fs.unlinkSync(tmpPath); } catch {}
              reject(err);
            });
        });
        bb.on('error', err => {
          if (cleanupTmp) { try { fs.unlinkSync(cleanupTmp); } catch {} }
          reject(err);
        });
        bb.on('close', () => { if (!landed) reject(new Error('No file found in upload')); });
        req.on('aborted', () => {
          if (cleanupTmp) { try { fs.unlinkSync(cleanupTmp); } catch {} }
          reject(new Error('Upload aborted'));
        });
        req.pipe(bb);
      });

      const { fileName, mimeType, tmpPath: srcPath } = parsed;
      const ext       = path.extname(fileName) || '.bin';
      const lowerMime = mimeType.toLowerCase();
      const isImage   = lowerMime.startsWith('image/') || ['.jpg','.jpeg','.png','.webp','.gif','.heic'].includes(ext.toLowerCase());
      const isPdf     = lowerMime.includes('pdf') || ext.toLowerCase() === '.pdf';
      const isCsv     = lowerMime.includes('csv') || ext.toLowerCase() === '.csv';
      const isVideo   = lowerMime.startsWith('video/');
      const isAudio   = lowerMime.startsWith('audio/');
      const isFinanceFile = isPdf || isCsv || isImage;

      // Route by MIME — same destinations as before, just via rename
      // rather than re-writing the buffer.
      let file_id;
      const renameToMedia = async (kind) => {
        const { getUserFilesDir } = await import('../lib/paths.mjs');
        const targetDir = getUserFilesDir(authId, kind);
        fs.mkdirSync(targetDir, { recursive: true });
        const safeName = `chat-${Date.now()}-${fileName.replace(/[^\w.-]/g, '_')}`;
        const dest = path.join(targetDir, safeName);
        try { fs.renameSync(srcPath, dest); }
        catch (e) {
          if (e.code === 'EXDEV') { fs.copyFileSync(srcPath, dest); fs.unlinkSync(srcPath); }
          else throw e;
        }
        return `${kind}:${safeName}`;
      };
      if (isImage && !isPdf && !isCsv) {
        file_id = await renameToMedia('images');
      } else if (isVideo) {
        file_id = await renameToMedia('videos');
      } else if (isAudio) {
        file_id = await renameToMedia('audio');
      } else {
        // PDFs / CSVs / docs → documents/ via the path-based addDocument.
        const saved = await addDocumentFromPath(authId, {
          srcPath, fileName, mimeType,
          kind: 'chat_upload',
          description: `Uploaded from chat on ${new Date().toLocaleDateString()}`,
        });
        file_id = saved.file_id;
      }

      // extractText needs an in-memory buffer; only fetch it back when the
      // chat-side caller will actually use it (images for vision, PDFs/CSVs
      // for the finance preprocessor). For media headed to transcribe,
      // skip the read — saves 60-500 MB of bounce.
      const { getProfileFilePath } = await import('../lib/profile-files.mjs');
      let extractedText = null;
      let base64 = null;
      if (isImage && !isVideo && !isAudio) {
        const buf = fs.readFileSync(getProfileFilePath(authId, file_id));
        base64 = buf.toString('base64');
        extractedText = await extractText(buf, ext);
      } else if (isPdf || isCsv) {
        const buf = fs.readFileSync(getProfileFilePath(authId, file_id));
        extractedText = await extractText(buf, ext);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: fileName, mimeType, isImage, isFinanceFile,
        file_id, base64,
        extractedText: extractedText || null,
      }));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  // Expense upload (with AI extraction)
  if (req.url.split('?')[0] === '/api/expenses/upload' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const ct = req.headers['content-type'] ?? '';
      const boundary = ct.match(/boundary=([^\s;]+)/)?.[1];
      if (!boundary) throw new Error('No multipart boundary');
      const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw new Error('File too large (max 10MB)');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      const parsed = parseMultipart(raw, boundary);
      if (!parsed) throw new Error('No file found in upload');
      const { fileData, fileName, mimeType } = parsed;

      const ext = path.extname(fileName) || '.bin';
      const lowerMime = mimeType.toLowerCase();
      const isImage = lowerMime.includes('image') || ['.jpg','.jpeg','.png','.webp','.gif','.heic'].includes(ext.toLowerCase());
      const isPdf   = lowerMime.includes('pdf') || ext.toLowerCase() === '.pdf';
      const isCsv   = lowerMime.includes('csv') || ext.toLowerCase() === '.csv';
      const extractedText = await extractText(fileData, ext);

      // Persist receipts/statements/CSVs into the user's profile-files
      // registry instead of the legacy expenses/uploads/ scratch folder. This
      // turns sourceFile references into permanent file_ids, which the user
      // can later view via list_profile_files or attach to email — and
      // removes the need for the cleanUploads task that was orphaning these
      // references at 24h.
      const saved = await addDocument(authId, {
        fileData, fileName, mimeType,
        kind: isPdf ? 'statement' : isImage ? 'receipt' : 'csv',
        description: `Expense ${isPdf ? 'statement' : isImage ? 'receipt' : 'transactions CSV'} — ${new Date().toLocaleDateString()}`,
      });

      // bookId may be passed as a query param (?bookId=xxx)
      const uploadUrl = new URL(req.url, 'http://x');
      const bookId = uploadUrl.searchParams.get('bookId') || null;

      const cfg = loadConfig();
      const extracted = await extractTransactions(cfg, { isImage, mimeType, base64: isImage ? fileData.toString('base64') : null, extractedText });

      const newTxns = extracted.map(t => ({
        id:           'txn_' + randomBytes(6).toString('hex'),
        userId:       authId,
        bookId:       bookId || undefined,
        date:         t.date ?? new Date().toISOString().slice(0, 10),
        amount:       parseFloat(t.amount) || 0,
        currency:     'USD',
        merchant:     t.merchant ?? '',
        description:  t.description ?? t.merchant ?? '',
        category:     t.category ?? 'Other',
        subcategory:  t.subcategory ?? '',
        source:       isPdf ? 'statement' : isImage ? 'receipt' : 'csv',
        sourceFileId: saved.file_id,
        createdAt:    new Date().toISOString(),
      })).filter(t => t.amount > 0);

      await withLock(EXPENSES_DB, () => {
        fs.mkdirSync(path.dirname(EXPENSES_DB), { recursive: true });
        const existingList = fs.existsSync(EXPENSES_DB) ? JSON.parse(fs.readFileSync(EXPENSES_DB, 'utf8')) : [];
        fs.writeFileSync(EXPENSES_DB, JSON.stringify([...existingList, ...newTxns], null, 2));
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ extracted: newTxns.length, transactions: newTxns }));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  // List transactions
  if (req.url.split('?')[0] === '/api/expenses/transactions' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const params = new URL(req.url, 'http://x').searchParams;
    const bookParam = params.get('bookId');
    // Require a bookId — never return cross-book results
    if (!bookParam) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return true; }
    let list = fs.existsSync(EXPENSES_DB) ? JSON.parse(fs.readFileSync(EXPENSES_DB, 'utf8')) : [];
    const memberIds = getExpGroupMemberIds(authId);
    const usersSnap = loadUsers();
    list = list.filter(t => memberIds.includes(t.userId));
    if (bookParam === 'none') list = list.filter(t => !t.bookId);
    else list = list.filter(t => t.bookId === bookParam);
    list = list.map(t => {
      if (t.userId === authId) return t;
      const u = usersSnap.find(x => x.id === t.userId);
      return { ...t, uploaderName: u?.name ?? 'Unknown', uploaderEmoji: u?.emoji ?? '🧑' };
    });
    if (params.get('dateFrom')) list = list.filter(t => t.date >= params.get('dateFrom'));
    if (params.get('dateTo'))   list = list.filter(t => t.date <= params.get('dateTo'));
    if (params.get('category')) list = list.filter(t => t.category === params.get('category'));
    list = list.sort((a, b) => b.date.localeCompare(a.date));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return true;
  }

  // Years
  if (req.url.split('?')[0] === '/api/expenses/years' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const params = new URL(req.url, 'http://x').searchParams;
    const bookParam = params.get('bookId');
    if (!bookParam) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return true; }
    let list = fs.existsSync(EXPENSES_DB) ? JSON.parse(fs.readFileSync(EXPENSES_DB, 'utf8')) : [];
    const memberIds = getExpGroupMemberIds(authId);
    list = list.filter(t => memberIds.includes(t.userId));
    if (bookParam === 'none') list = list.filter(t => !t.bookId);
    else list = list.filter(t => t.bookId === bookParam);
    const years = [...new Set(list.map(t => t.date?.slice(0,4)).filter(Boolean))].sort((a,b) => b-a);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(years));
    return true;
  }

  // Summary
  if (req.url.split('?')[0] === '/api/expenses/summary' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const params = new URL(req.url, 'http://x').searchParams;
    const bookParam = params.get('bookId');
    if (!bookParam) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ byMonth: {}, total: 0, count: 0 })); return true; }
    let list = fs.existsSync(EXPENSES_DB) ? JSON.parse(fs.readFileSync(EXPENSES_DB, 'utf8')) : [];
    list = list.filter(t => getExpGroupMemberIds(authId).includes(t.userId));
    if (bookParam === 'none') list = list.filter(t => !t.bookId);
    else list = list.filter(t => t.bookId === bookParam);
    if (params.get('year'))  list = list.filter(t => t.date.startsWith(params.get('year')));
    if (params.get('month')) list = list.filter(t => parseInt(t.date.slice(5, 7)) === parseInt(params.get('month')));
    const byMonth = {};
    for (const t of list) {
      const m = t.date.slice(0, 7);
      if (!byMonth[m]) byMonth[m] = { total: 0, categories: {} };
      byMonth[m].total += t.amount;
      byMonth[m].categories[t.category] = (byMonth[m].categories[t.category] ?? 0) + t.amount;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ byMonth, total: list.reduce((s, t) => s + t.amount, 0), count: list.length }));
    return true;
  }

  // Update transaction
  if (req.url.match(/^\/api\/expenses\/transactions\/[^/]+$/) && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const id = req.url.split('/').pop();
    try {
      const changes = JSON.parse(await readBody(req));
      const allowed = ['category', 'description', 'merchant', 'date', 'amount'];
      const memberIds = getExpGroupMemberIds(authId);
      const updated = await withLock(EXPENSES_DB, () => {
        const list = fs.existsSync(EXPENSES_DB) ? JSON.parse(fs.readFileSync(EXPENSES_DB, 'utf8')) : [];
        const idx = list.findIndex(t => t.id === id && memberIds.includes(t.userId));
        if (idx === -1) return null;
        for (const k of allowed) { if (k in changes) list[idx][k] = changes[k]; }
        fs.writeFileSync(EXPENSES_DB, JSON.stringify(list, null, 2));
        return list[idx];
      });
      if (!updated) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(updated));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  // Delete transaction
  if (req.url.match(/^\/api\/expenses\/transactions\/[^/]+$/) && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const id = req.url.split('/').pop();
    const memberIds = getExpGroupMemberIds(authId);
    const found = await withLock(EXPENSES_DB, () => {
      const list = fs.existsSync(EXPENSES_DB) ? JSON.parse(fs.readFileSync(EXPENSES_DB, 'utf8')) : [];
      const idx = list.findIndex(t => t.id === id && memberIds.includes(t.userId));
      if (idx === -1) return false;
      list.splice(idx, 1);
      fs.writeFileSync(EXPENSES_DB, JSON.stringify(list, null, 2));
      return true;
    });
    if (!found) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── Expense books (portfolios) ─────────────────────────────────────────────
  if (req.url === '/api/expense-books' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const books = getExpBooksForUser(authId);
    const users = loadUsers();
    const result = books.map(b => ({
      ...b,
      isOwner: b.ownerId === authId,
      sharedMembers: (b.sharedWith ?? []).map(id => { const u = users.find(x => x.id === id); return u ? { id: u.id, name: u.name, emoji: u.emoji } : { id, name: 'Unknown', emoji: '🧑' }; }),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    return true;
  }

  if (req.url === '/api/expense-books' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { name } = JSON.parse(await readBody(req));
      if (!name?.trim()) throw new Error('Book name required');
      const book = await modifyExpBooks(books => {
        const b = { id: 'book_' + randomBytes(4).toString('hex'), name: name.trim(), ownerId: authId, sharedWith: [], createdAt: new Date().toISOString() };
        books.push(b);
        return b;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(book));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  const bookMatch = req.url.split('?')[0].match(/^\/api\/expense-books\/([\w-]+)$/);
  if (bookMatch && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const bookId = bookMatch[1];
    try {
      const changes = JSON.parse(await readBody(req));
      const updated = await modifyExpBooks(books => {
        const idx = books.findIndex(b => b.id === bookId);
        if (idx === -1) return null;
        const b = books[idx];
        if (b.ownerId !== authId && !isPrivileged(authId)) return 'forbidden';
        if (changes.name) b.name = changes.name.trim();
        if (Array.isArray(changes.sharedWith)) b.sharedWith = changes.sharedWith;
        return b;
      });
      if (updated === 'forbidden') { res.writeHead(403); res.end(JSON.stringify({ error: 'Not your book' })); return true; }
      if (!updated) { res.writeHead(404); res.end(JSON.stringify({ error: 'Book not found' })); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(updated));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  if (bookMatch && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const bookId = bookMatch[1];
    const qp = new URL(req.url, 'http://x').searchParams;
    const deleteTransactions = qp.get('deleteTransactions') === 'true';
    const moveToBookId = qp.get('moveToBookId') || null;
    const result = await modifyExpBooks(books => {
      const idx = books.findIndex(b => b.id === bookId);
      if (idx === -1) return 'notfound';
      if (books[idx].ownerId !== authId && !isPrivileged(authId)) return 'forbidden';
      books.splice(idx, 1);
      return 'ok';
    });
    if (result === 'notfound') { res.writeHead(404); res.end(JSON.stringify({ error: 'Book not found' })); return true; }
    if (result === 'forbidden') { res.writeHead(403); res.end(JSON.stringify({ error: 'Not your book' })); return true; }
    // Delete, move, or unlink transactions belonging to this book
    await withLock(EXPENSES_DB, () => {
      if (!fs.existsSync(EXPENSES_DB)) return;
      const list = JSON.parse(fs.readFileSync(EXPENSES_DB, 'utf8'));
      let updated;
      if (deleteTransactions) {
        updated = list.filter(t => t.bookId !== bookId);
      } else if (moveToBookId) {
        updated = list.map(t => t.bookId === bookId ? { ...t, bookId: moveToBookId } : t);
      } else {
        updated = list.map(t => t.bookId === bookId ? (delete t.bookId, t) : t);
      }
      fs.writeFileSync(EXPENSES_DB, JSON.stringify(updated, null, 2));
    });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // Expense groups
  if (req.url === '/api/expense-groups' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const groups = loadExpGroups();
    const visible = isPrivileged(authId) ? groups : groups.filter(g => g.memberIds.includes(authId));
    const users = loadUsers();
    const result = visible.map(g => ({
      ...g,
      members: g.memberIds.map(id => { const u = users.find(x => x.id === id); return u ? { id: u.id, name: u.name, emoji: u.emoji, role: u.role } : { id, name: 'Unknown', emoji: '🧑' }; }),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    return true;
  }

  if (req.url === '/api/expense-groups' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    if (!isPrivileged(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    try {
      const { name, memberIds } = JSON.parse(await readBody(req));
      if (!name?.trim()) throw new Error('Group name required');
      if (!Array.isArray(memberIds) || memberIds.length < 2) throw new Error('At least 2 members required');
      const group = await modifyExpGroups(groups => {
        for (const uid of memberIds) {
          if (groups.some(g => g.memberIds.includes(uid))) throw new Error(`User is already in a group`);
        }
        const g = { id: 'expgrp_' + randomBytes(4).toString('hex'), name: name.trim(), memberIds, createdBy: authId, createdAt: new Date().toISOString() };
        groups.push(g);
        return g;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(group));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  if (req.url.match(/^\/api\/expense-groups\/[^/]+$/) && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    if (!isPrivileged(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    const groupId = req.url.split('/').pop();
    try {
      const changes = JSON.parse(await readBody(req));
      const updated = await modifyExpGroups(groups => {
        const idx = groups.findIndex(g => g.id === groupId);
        if (idx === -1) return null;
        if (changes.name) groups[idx].name = changes.name.trim();
        if (Array.isArray(changes.memberIds)) {
          if (changes.memberIds.length < 1) throw new Error('Group must have at least 1 member');
          for (const uid of changes.memberIds) {
            const other = groups.find((g, i) => i !== idx && g.memberIds.includes(uid));
            if (other) throw new Error(`User is already in group "${other.name}"`);
          }
          groups[idx].memberIds = changes.memberIds;
        }
        return groups[idx];
      });
      if (!updated) { res.writeHead(404); res.end(JSON.stringify({ error: 'Group not found' })); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(updated));
    } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
    return true;
  }

  if (req.url.match(/^\/api\/expense-groups\/[^/]+$/) && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    if (!isPrivileged(authId)) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return true; }
    const groupId = req.url.split('/').pop();
    const found = await modifyExpGroups(groups => {
      const idx = groups.findIndex(g => g.id === groupId);
      if (idx === -1) return false;
      groups.splice(idx, 1);
      return true;
    });
    if (!found) { res.writeHead(404); res.end(JSON.stringify({ error: 'Group not found' })); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    return true;
  }

  return false;
}
