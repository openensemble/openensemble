// Sync protocol v1 filesystem implementation. Keep in step with OE server's
// lib/desktop-file-tree.mjs; neither repository depends on the other's install.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const FILE_LIMIT = 500 * 1024 * 1024;
export const TREE_LIMIT = 1024 * 1024 * 1024;
export const ENTRY_LIMIT = 5000;
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', '.cache', '.turbo', '.parcel-cache', '.pytest_cache', '.run', '.openensemble', '.ssh', '.aws']);
const locks = new Map();

export function fileError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function cleanPath(value = '.') {
  if (value === '.') return value;
  if (typeof value !== 'string' || !value || value.length > 2048) throw fileError('Invalid relative path.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\:<>"|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw fileError('Use a relative path with names supported on Windows, macOS, and Linux.');
  }
  return value;
}

function stamp(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function lstat(target) {
  try { return fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function locked(key, action) {
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}

export function createFileTree(root, { exclude = [] } = {}) {
  const realRoot = fs.realpathSync(root);
  const rootStamp = fs.statSync(realRoot);
  function excluded(rel) {
    return exclude.some(item => rel === item || rel.startsWith(item + '/')) || rel.split('/').some(part =>
      SKIP.has(part) || part.startsWith('.oe-sync-') || /^\.env(?:\.|$)/.test(part) && !/\.(example|sample|template)$/.test(part));
  }

  function resolve(rel = '.') {
    cleanPath(rel);
    if (excluded(rel)) throw fileError('This path is excluded from file sync.');
    const now = fs.statSync(realRoot);
    if (fs.realpathSync(root) !== realRoot || now.dev !== rootStamp.dev || now.ino !== rootStamp.ino) throw fileError('Folder changed. Refresh and try again.', 409);
    let target = realRoot;
    if (rel === '.') return target;
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      target = path.join(target, parts[i]);
      const stat = lstat(target);
      if (stat?.isSymbolicLink()) throw fileError('Symbolic links are excluded from file sync.', 409);
      if (stat && i < parts.length - 1 && !stat.isDirectory()) throw fileError('A file blocks this folder path.', 409);
    }
    return target;
  }

  function info(rel) {
    const target = resolve(rel), stat = lstat(target);
    if (!stat) return null;
    if (!stat.isDirectory() && !stat.isFile()) throw fileError('Only regular files and folders can be synced.');
    return { path: rel, name: path.posix.basename(rel), type: stat.isDirectory() ? 'dir' : 'file', size: stat.isFile() ? stat.size : 0, modified: stat.mtime.toISOString(), executable: !!(stat.mode & 0o111), version: stamp(stat) };
  }

  function list(rel = '.') {
    const target = resolve(rel);
    if (!lstat(target)) return { path: rel, entries: [], excluded: 0 };
    if (!fs.statSync(target).isDirectory()) throw fileError('Select a folder to browse.');
    const entries = [];
    let skipped = 0;
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
      try { cleanPath(child); } catch { skipped++; continue; }
      if (excluded(child) || entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) { skipped++; continue; }
      const item = info(child);
      if (item) entries.push(item);
      if (entries.length > ENTRY_LIMIT) throw fileError(`This folder exceeds ${ENTRY_LIMIT} items. Choose a smaller folder.`, 413);
    }
    entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name));
    return { path: rel, entries, excluded: skipped };
  }

  async function open(rel, expectedHash, signal) {
    signal?.throwIfAborted();
    const target = resolve(rel);
    const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw fileError('Path is not a file.');
      if (before.size > FILE_LIMIT) throw fileError('Each file must be 500 MB or smaller.', 413);
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, signal })) {
        bytes += chunk.length;
        if (bytes > FILE_LIMIT) throw fileError('Each file must be 500 MB or smaller.', 413);
        hash.update(chunk);
      }
      const digest = hash.digest('hex');
      const after = await handle.stat();
      if (stamp(before) !== stamp(after) || stamp(lstat(resolve(rel)) || {}) !== stamp(after)) throw fileError('File changed while being read. Preview again.', 409);
      if (expectedHash && digest !== expectedHash) throw fileError('File changed since the preview. Preview again.', 409);
      return { handle, hash: digest, size: after.size, version: stamp(after), executable: !!(after.mode & 0o111) };
    } catch (error) { await handle.close(); throw error; }
  }

  async function manifest(paths, signal) {
    if (!Array.isArray(paths) || !paths.length || paths.length > ENTRY_LIMIT) throw fileError('Select files or folders to sync.');
    const entries = [], seen = new Set();
    let bytes = 0, skipped = 0;
    async function walk(rel) {
      signal?.throwIfAborted();
      if (seen.has(rel)) return;
      seen.add(rel);
      const item = info(rel);
      if (!item) return;
      if (entries.length >= ENTRY_LIMIT) throw fileError(`Select fewer than ${ENTRY_LIMIT} items per transfer.`, 413);
      if (item.type === 'file') {
        bytes += item.size;
        if (bytes > TREE_LIMIT) throw fileError('Select up to 1 GB per transfer.', 413);
        const opened = await open(rel, null, signal);
        try { entries.push({ ...item, hash: opened.hash, version: opened.version }); } finally { await opened.handle.close(); }
      } else {
        if (rel !== '.') entries.push(item);
        const listing = list(rel);
        skipped += listing.excluded;
        for (const child of listing.entries) await walk(child.path);
      }
    }
    for (const rel of paths) await walk(cleanPath(rel));
    return { entries, bytes, excluded: skipped };
  }

  async function put(rel, source, { expected, hash, executable = false, signal, beforeCommit } = {}) {
    cleanPath(rel);
    if (rel === '.' || expected !== null && !/^[a-f0-9]{64}$/.test(expected || '') || !/^[a-f0-9]{64}$/.test(hash || '')) throw fileError('A preview and content checksum are required.');
    return locked(`${realRoot}/${rel}`, async () => {
      signal?.throwIfAborted();
      let target = resolve(rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      target = resolve(rel);
      const tmp = path.join(path.dirname(target), `.oe-sync-${randomBytes(16).toString('hex')}`);
      const handle = await fs.promises.open(tmp, 'wx', 0o600);
      let bytes = 0;
      try {
        const digest = createHash('sha256');
        for await (const chunk of source) {
          signal?.throwIfAborted();
          const data = Buffer.from(chunk);
          bytes += data.length;
          if (bytes > FILE_LIMIT) throw fileError('Each file must be 500 MB or smaller.', 413);
          digest.update(data);
          let offset = 0;
          while (offset < data.length) offset += (await handle.write(data, offset, data.length - offset)).bytesWritten;
        }
        if (digest.digest('hex') !== hash) throw fileError('File contents changed or the transfer was incomplete. Preview again.', 409);
        await handle.sync();
        await handle.close();
        signal?.throwIfAborted();
        let current = info(rel);
        if (current && current.type !== 'file') throw fileError('A folder blocks this file. Nothing was replaced.', 409);
        if (expected === null) {
          if (current) throw fileError('A file appeared at the destination. Preview again.', 409);
        } else {
          if (!current) throw fileError('The destination changed. Preview again.', 409);
          const opened = await open(rel, expected, signal);
          current = { ...current, version: opened.version };
          await opened.handle.close();
        }
        await beforeCommit?.();
        signal?.throwIfAborted();
        if (resolve(rel) !== target || (info(rel)?.version || null) !== (current?.version || null)) throw fileError('The destination changed. Preview again.', 409);
        // No awaits between final validation and publication. New files use an
        // exclusive link so even a concurrent creator cannot be overwritten.
        const mode = current ? fs.statSync(target).mode & 0o777 : executable ? 0o700 : 0o600;
        fs.chmodSync(tmp, mode);
        if (expected === null) { fs.linkSync(tmp, target); fs.unlinkSync(tmp); }
        else fs.renameSync(tmp, target);
        return { path: rel, bytes, hash };
      } finally {
        await handle.close().catch(() => {});
        try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    });
  }

  function mkdir(rel) {
    const target = resolve(rel), current = info(rel);
    if (current && current.type !== 'dir') throw fileError('A file blocks this folder. Nothing was replaced.', 409);
    fs.mkdirSync(target, { recursive: true });
    resolve(rel);
    return { path: rel };
  }
  return { resolve, info, list, manifest, open, put, mkdir };
}
