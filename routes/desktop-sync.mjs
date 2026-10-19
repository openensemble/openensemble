// Account-scoped desktop file transfers. No caller can provide an absolute root.
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { requireAuth, getUserDir, readBody, isUserTimeBlocked, getAuthToken, getSessionUserId } from './_helpers.mjs';
import { USERS_DIR } from '../lib/paths.mjs';
import { createFileTree, fileError, FILE_LIMIT } from '../lib/desktop-file-tree.mjs';

const folders = {
  coder: ['documents/code', []],
  documents: ['documents', ['docs-index.json', 'code', 'thumbs', 'versions']],
  downloads: ['downloads', []],
  images: ['images', []],
  videos: ['videos', []],
  research: ['research', ['index.json', '.versions', 'versions']],
};

function treeFor(userId, folder) {
  if (!Object.hasOwn(folders, folder)) throw fileError('Unknown file folder.');
  const [relative, exclude] = folders[folder];
  // Verify every component below the trusted users root, including the profile
  // and category roots; a symlink cannot turn a category into another account.
  const profiles = createFileTree(USERS_DIR);
  const relativeRoot = path.relative(USERS_DIR, path.join(getUserDir(userId), relative)).split(path.sep).join('/');
  profiles.mkdir(relativeRoot);
  return createFileTree(profiles.resolve(relativeRoot), { exclude });
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/desktop-sync/')) return false;
  const userId = requireAuth(req, res, { allowMediaToken: false });
  if (!userId) return true;
  if (isUserTimeBlocked(userId)) { json(res, 403, { error: 'Access is currently paused for this account.' }); return true; }
  const abort = new AbortController();
  const cancel = () => { if (!res.writableEnded) abort.abort(); };
  res.on('close', cancel);
  try {
    if (url.pathname === '/api/desktop-sync/info' && req.method === 'GET') {
      json(res, 200, { protocol: 1, userId, folders: Object.keys(folders), maxFileBytes: FILE_LIMIT });
      return true;
    }
    const tree = treeFor(userId, url.searchParams.get('folder'));
    const rel = url.searchParams.get('path') || '.';
    const action = url.pathname.slice('/api/desktop-sync/'.length);
    if (action === 'list' && req.method === 'GET') {
      json(res, 200, tree.list(rel));
    } else if (action === 'manifest' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      json(res, 200, await tree.manifest(body.paths, abort.signal));
    } else if (action === 'directory' && req.method === 'POST') {
      json(res, 200, tree.mkdir(rel));
    } else if (action === 'file' && req.method === 'GET') {
      const opened = await tree.open(rel, req.headers['if-match']?.replace(/^"|"$/g, ''), abort.signal);
      try {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': opened.size, ETag: `"${opened.hash}"`, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment', 'X-Content-Type-Options': 'nosniff' });
        await pipeline(opened.handle.createReadStream({ autoClose: false, start: 0 }), res, { signal: abort.signal });
      } finally { await opened.handle.close(); }
    } else if (action === 'file' && req.method === 'PUT') {
      const expected = req.headers['if-none-match'] === '*' ? null : req.headers['if-match']?.replace(/^"|"$/g, '');
      if (Number(req.headers['content-length']) > FILE_LIMIT) throw fileError('Each file must be 500 MB or smaller.', 413);
      const result = await tree.put(rel, req, {
        expected, hash: req.headers['x-oe-content-sha256'], executable: req.headers['x-oe-executable'] === '1', signal: abort.signal,
        beforeCommit() {
          if (getSessionUserId(getAuthToken(req)) !== userId) throw fileError('Your server session expired. Sign in again.', 401);
          if (isUserTimeBlocked(userId)) throw fileError('Access is currently paused for this account.', 403);
        },
      });
      json(res, 200, result);
    } else json(res, 405, { error: 'Unsupported file sync operation.' });
  } catch (error) {
    if (res.headersSent) res.destroy();
    else {
      const status = error.status || (error.code === 'ENOENT' ? 404 : error instanceof SyntaxError ? 400 : 500);
      json(res, status, { error: error.status ? error.message : status === 404 ? 'File not found. Refresh and try again.' : status === 400 ? 'Invalid request.' : 'Unable to access these files. Refresh and try again.' });
    }
  } finally { res.removeListener('close', cancel); }
  return true;
}
