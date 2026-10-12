/** Prepare one authenticated ZIP for a Docs selection without buffering media in the browser. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { requireAuth, readBody, getUserDir, BASE_DIR } from './_helpers.mjs';
import { resolveDocumentDownload } from './shared-docs.mjs';
import { ARCHIVE_SKIP } from './coder.mjs';

const MAX_ITEMS = 250;
const MAX_BYTES = 5 * 1024 ** 3;
const MAX_FILES = 10000;
const TTL = 10 * 60 * 1000;
const archives = new Map();
const preparing = new Set();
const MEDIA = { 'ai-image': ['images', 'image', 'ai_img_'], 'ai-video': ['videos', 'video', 'ai_vid_'], audio: ['audio', 'audio', 'audio_'] };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

function beneath(file, root) {
  const rel = path.relative(root, file);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function checkedPath(file, roots, directory = false) {
  let real, stat;
  try { real = fs.realpathSync(file); stat = fs.statSync(real); }
  catch { fail('A selected file is no longer available. Refresh Docs and try again.', 404); }
  const allowed = roots.some(root => {
    try { return beneath(real, fs.realpathSync(root)); } catch { return false; }
  });
  if (!allowed || (directory ? !stat.isDirectory() : !stat.isFile())) fail('Selected file is outside its account folder.', 403);
  return real;
}

function validName(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\x00-\x1f]/.test(value)) fail('Invalid filename.');
  return value;
}

function resolveItem(userId, item) {
  if (!item || typeof item !== 'object') fail('Invalid selection.');
  if (item.source === 'document') {
    if (typeof item.id !== 'string' || !/^doc_[\w-]+$/.test(item.id)) fail('Invalid document ID.');
    const doc = resolveDocumentDownload(item.id, userId);
    if (!doc) fail('A selected document is unavailable or no longer shared with you.', 404);
    return { path: checkedPath(doc.path, doc.roots), name: doc.filename };
  }
  const ownerId = item.ownerId || userId;
  if (typeof ownerId !== 'string' || !/^[\w-]+$/.test(ownerId)) fail('Invalid owner.');
  const media = MEDIA[item.source];
  if (!media && item.source !== 'research' && item.source !== 'code') fail('Unsupported file type.');
  const filename = media || item.source === 'code' ? validName(item.filename) : null;
  if (ownerId !== userId) {
    const fileId = media ? media[2] + filename : item.id;
    const shared = readJson(path.join(BASE_DIR, 'sharing.json')).some(share =>
      share.ownerId === ownerId && share.fileId === fileId && share.fileType === (media ? media[1] : 'research') &&
      (share.sharedWith?.includes(userId) || share.sharedWith?.includes('*')));
    if (item.source === 'code' || !shared) fail('A selected file is no longer shared with you.', 403);
  }
  const userRoot = getUserDir(ownerId);
  if (media) {
    const folder = path.join(userRoot, media[0]);
    const file = checkedPath(path.join(folder, filename), [folder]);
    return { path: checkedPath(file, [userRoot]), name: filename };
  }
  if (item.source === 'research') {
    const folder = path.join(userRoot, 'research');
    const doc = readJson(path.join(folder, 'index.json')).find(row => row.id === item.id);
    if (!doc) fail('A selected research document is unavailable.', 404);
    const file = checkedPath(path.join(folder, validName(doc.filename)), [folder]);
    const title = doc.title || doc.filename;
    return { path: checkedPath(file, [userRoot]), name: /\.(md|markdown)$/i.test(title) ? title : title + '.md' };
  }
  const workspace = path.join(userRoot, 'documents', 'code');
  const project = checkedPath(path.join(workspace, filename), [workspace], true);
  return { path: checkedPath(project, [userRoot], true), name: filename, directory: true };
}

function archiveName(name, used) {
  // ZIP names are flat, portable and unique, including on case-insensitive disks.
  const base = String(name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 180) || 'file';
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let candidate = base, number = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${stem} (${number++})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

async function buildArchive(userId, items, dir, signal) {
  const inputs = items.map(item => resolveItem(userId, item));
  const stage = path.join(dir, 'files');
  await fs.promises.mkdir(stage);
  let bytes = 0, files = 0;
  const stageFile = async (source, target) => {
    signal.throwIfAborted();
    const stat = await fs.promises.lstat(source);
    if (!stat.isFile()) fail('A selected file changed while preparing the download. Please retry.');
    bytes += stat.size;
    if (bytes > MAX_BYTES || ++files > MAX_FILES) fail('Select fewer files: ZIP downloads allow up to 5 GB and 10,000 files.', 413);
    try { await fs.promises.link(source, target); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    }
    if (!(await fs.promises.lstat(target)).isFile()) fail('A selected file changed while preparing the download. Please retry.');
  };
  const stageProject = async (source, target, root, depth = 0) => {
    signal.throwIfAborted();
    if (depth > 40 || ++files > MAX_FILES) fail('Select fewer project files.', 413);
    checkedPath(source, depth ? [root] : [path.dirname(root)], true);
    await fs.promises.mkdir(target);
    for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
      if (ARCHIVE_SKIP.includes(entry.name) || entry.isSymbolicLink()) continue;
      const from = path.join(source, entry.name), to = path.join(target, entry.name);
      if (entry.isDirectory()) await stageProject(from, to, root, depth + 1);
      else if (entry.isFile()) await stageFile(checkedPath(from, [root]), to);
    }
  };
  const used = new Set();
  for (const input of inputs) {
    const target = path.join(stage, archiveName(input.name, used));
    if (input.directory) await stageProject(input.path, target, input.path);
    else await stageFile(input.path, target);
  }
  const output = path.join(dir, 'selection.zip');
  await new Promise((resolve, reject) => {
    // Media is already compressed. Store it without compression; zip streams
    // from disk and handles ZIP64 without accumulating videos in Node memory.
    const child = spawn('zip', ['-0', '-q', '-r', output, '.'], { cwd: stage, stdio: 'ignore', signal });
    let overLimit = false;
    const watch = setInterval(() => {
      try {
        if (fs.statSync(output).size > MAX_BYTES + 16 * 1024 ** 2) { overLimit = true; child.kill('SIGKILL'); }
      } catch {}
    }, 500);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5 * 60 * 1000);
    child.once('error', error => {
      clearInterval(watch); clearTimeout(timeout);
      reject(error.code === 'ENOENT' ? Object.assign(new Error('ZIP downloads require the zip program on the server.'), { status: 503 }) : error);
    });
    child.once('close', code => {
      clearInterval(watch); clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(overLimit ? 'ZIP download exceeds the 5 GB limit.' : 'Could not prepare the ZIP. Please try a smaller selection.'), { status: overLimit ? 413 : 500 }));
    });
  });
  await fs.promises.rm(stage, { recursive: true, force: true });
  return output;
}

function discard(id) {
  const archive = archives.get(id);
  if (!archive) return;
  archives.delete(id);
  clearTimeout(archive.timer);
  fs.promises.rm(archive.dir, { recursive: true, force: true }).catch(() => {});
}

export async function handle(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname !== '/api/document-batches' && !/^\/api\/document-batches\/[a-f0-9]{32}\/download$/.test(pathname)) return false;
  const userId = requireAuth(req, res); if (!userId) return true;
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (pathname === '/api/document-batches' && req.method === 'POST') {
    let dir;
    if (preparing.has(userId) || preparing.size >= 2 || archives.size >= 8 || [...archives.values()].filter(row => row.userId === userId).length >= 2) {
      json(429, { error: 'A ZIP download is already being prepared or waiting. Finish it before starting another.' }); return true;
    }
    preparing.add(userId);
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
      const { items } = JSON.parse(await readBody(req));
      if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) fail(`Select between 1 and ${MAX_ITEMS} items per download.`);
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oe-doc-download-'));
      const file = await buildArchive(userId, items, dir, controller.signal);
      controller.signal.throwIfAborted();
      const id = randomBytes(16).toString('hex');
      const filename = `OpenEnsemble-files-${new Date().toISOString().slice(0, 10)}.zip`;
      const timer = setTimeout(() => discard(id), TTL); timer.unref();
      archives.set(id, { userId, dir, file, filename, items, timer });
      dir = null;
      json(200, { id, filename, count: items.length });
    } catch (error) {
      if (!res.destroyed) json(error.status || 400, { error: error.status ? error.message : 'Could not prepare the ZIP. Refresh Docs and try again.' });
    } finally {
      preparing.delete(userId);
      res.off('close', abort);
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return true;
  }
  if (req.method === 'GET' && pathname.endsWith('/download')) {
    const id = pathname.split('/')[3];
    const archive = archives.get(id);
    if (!archive || archive.userId !== userId) { json(404, { error: 'Download expired or not found. Select the files again.' }); return true; }
    try {
      // A share revoked after preparation must not grant access via a cached ZIP.
      for (const item of archive.items) resolveItem(userId, item);
      const size = (await fs.promises.stat(archive.file)).size;
      res.writeHead(200, {
        'Content-Type': 'application/zip', 'Content-Length': size,
        'Content-Disposition': `attachment; filename="${archive.filename}"`,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      });
      await pipeline(fs.createReadStream(archive.file), res);
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : 'Download failed. Please try again.' });
    } finally { discard(id); }
    return true;
  }
  json(405, { error: 'Method not allowed' });
  return true;
}
