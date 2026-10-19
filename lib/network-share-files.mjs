import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { runShareCommand } from './network-share-process.mjs';

const MAX_FILES = 2000;
const MAX_BYTES = 1024 * 1024 * 1024;
const fdPath = handle => `/proc/self/fd/${handle.fd}`;
export function relativeSharePath(value = '') {
  if (typeof value !== 'string' || value.length > 2048 || value.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(value)) throw new Error('Use a relative path inside the share.');
  const parts = value.split('/').filter(Boolean);
  if (parts.some(p => p === '..' || p === '.')) throw new Error('Paths cannot contain . or .. segments.');
  return parts.join('/');
}

// Open each path component relative to an already-open directory. O_NOFOLLOW
// alone only protects the final component; descriptor-relative traversal also
// prevents a server swapping a parent directory for an escaping symlink.
async function openDirectory(root, relative = '', create = false) {
  let current = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of relativeSharePath(relative).split('/').filter(Boolean)) {
      const entry = `${fdPath(current)}/${part}`;
      if (create) await fs.mkdir(entry, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const next = await fs.open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await current.close();
      current = next;
    }
    return current;
  } catch (e) { await current.close(); throw e; }
}

async function openFile(root, relative, flags = constants.O_RDONLY) {
  const clean = relativeSharePath(relative);
  if (!clean) throw new Error('A file path is required.');
  const parent = await openDirectory(root, path.posix.dirname(clean) === '.' ? '' : path.posix.dirname(clean));
  try { return await fs.open(`${fdPath(parent)}/${path.posix.basename(clean)}`, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
  finally { await parent.close(); }
}

async function directoryNames(handle, maximum = 50000) {
  const names = [];
  const directory = await fs.opendir(fdPath(handle));
  for await (const entry of directory) {
    names.push(entry.name);
    if (names.length > maximum) throw new Error('This directory contains too many entries. Choose a smaller subfolder.');
  }
  return names;
}

async function readBytes(file, count) {
  const buffer = Buffer.alloc(count);
  let offset = 0;
  while (offset < count) {
    const { bytesRead } = await file.read(buffer, offset, count - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export async function listShareDirectory(root, relative = '', { offset = 0, limit = 100 } = {}) {
  const directory = await openDirectory(root, relative);
  try {
    const names = await directoryNames(directory);
    names.sort((a, b) => a.localeCompare(b));
    offset = Math.max(0, Math.floor(Number(offset) || 0));
    limit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
    const entries = [];
    for (const name of names.slice(offset, offset + limit)) {
      const entry = { name, path: [relativeSharePath(relative), name].filter(Boolean).join('/') };
      try {
        const info = await fs.lstat(`${fdPath(directory)}/${name}`);
        entries.push({ ...entry, type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
          size: info.size, modifiedAt: info.mtime.toISOString() });
      } catch {
        entries.push({ ...entry, type: 'unavailable', message: 'This entry disappeared or its metadata could not be read.' });
      }
    }
    return { entries, total: names.length, nextOffset: offset + limit < names.length ? offset + limit : null };
  } finally { await directory.close(); }
}

export function shareFileMime(name) {
  const ext = path.extname(name).toLowerCase();
  return ({ '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.pdf': 'application/pdf',
    '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' })[ext] || 'application/octet-stream';
}

export async function readShareFile(root, relative, { offset = 0, limit = 30000 } = {}) {
  const file = await openFile(root, relative);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Only regular files can be read.');
    const mimeType = shareFileMime(relative), name = path.posix.basename(relative);
    offset = Math.max(0, Math.floor(Number(offset) || 0));
    limit = Math.max(1, Math.min(50000, Math.floor(Number(limit) || 30000)));
    if (mimeType.startsWith('image/')) {
      if (info.size > 10 * 1024 * 1024) throw new Error('Image is too large to preview. Copy it into OE instead.');
      return { isImage: true, name, mimeType, base64: (await readBytes(file, info.size)).toString('base64') };
    }
    if (mimeType === 'application/pdf') {
      if (info.size > 25 * 1024 * 1024) throw new Error('PDF is too large to read inline. Copy it into OE instead.');
      const content = await runShareCommand('pdftotext', ['-', '-'], { input: await readBytes(file, info.size), maxBytes: 2 * 1024 * 1024 });
      return { name, mimeType, content: content.slice(offset, offset + limit), nextOffset: offset + limit < content.length ? offset + limit : null };
    }
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await file.read(buffer, 0, limit, offset);
    if (buffer.subarray(0, bytesRead).includes(0) || mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
      return { name, mimeType, size: info.size, message: 'This is a binary or media file. Copy it to an OE folder to use its preview or media tools.' };
    }
    return { name, mimeType, size: info.size, content: buffer.subarray(0, bytesRead).toString('utf8'), nextOffset: offset + bytesRead < info.size ? offset + bytesRead : null };
  } finally { await file.close(); }
}

export function shareFilePaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 100) throw new Error('Choose between 1 and 100 exact file paths from the share listing.');
  return [...new Set(paths.map(value => {
    const relative = relativeSharePath(value);
    if (!relative || /[*?\[\]]/.test(relative)) throw new Error('Choose exact filenames. The share root, folders, and wildcard patterns cannot be deleted with this tool.');
    return relative;
  }))];
}

// File-only deletion never removes a directory or disconnects the share. Check
// the entire selection before deleting anything and keep parent descriptors
// open so replacing a parent path with a symlink cannot redirect an unlink.
export async function deleteShareFiles(root, paths) {
  const selected = shareFilePaths(paths), plan = [], deleted = [];
  try {
    for (const relative of selected) {
      const parentPath = path.posix.dirname(relative);
      const parent = await openDirectory(root, parentPath === '.' ? '' : parentPath);
      const entry = { path: relative, parent, name: `${fdPath(parent)}/${path.posix.basename(relative)}` };
      plan.push(entry);
      entry.info = await fs.lstat(entry.name);
      if (!entry.info.isFile()) throw new Error('Only regular files can be deleted. Folders, symbolic links, and the share itself are preserved.');
    }
    for (const entry of plan) {
      try {
        const current = await fs.lstat(entry.name);
        if (!current.isFile() || current.dev !== entry.info.dev || current.ino !== entry.info.ino
            || current.size !== entry.info.size || current.mtimeMs !== entry.info.mtimeMs) {
          return { deleted, complete: false, error: 'A selected file changed. List the share again before deleting any remaining files.' };
        }
        await fs.unlink(entry.name);
        deleted.push({ path: entry.path });
      } catch (error) {
        return { deleted, complete: false, code: error.code || 'FILES',
          error: 'File deletion stopped. Only the listed files were deleted. List the share again before retrying.' };
      }
    }
    return { deleted, complete: true };
  } finally {
    await Promise.allSettled(plan.map(entry => entry.parent.close()));
  }
}

async function inventory(root, relative) {
  const files = [], folders = [];
  let bytes = 0, directories = 0;
  async function visit(rel, depth) {
    if (depth > 32 || ++directories > 4000) throw new Error('Folder is too large or deeply nested. Copy a smaller folder.');
    const parentRel = path.posix.dirname(rel);
    const parent = await openDirectory(root, parentRel === '.' ? '' : parentRel);
    let info;
    try { info = rel ? await fs.lstat(`${fdPath(parent)}/${path.posix.basename(rel)}`) : await parent.stat(); }
    finally { await parent.close(); }
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Copies cannot contain symbolic links or special files.');
    if (info.isDirectory()) {
      folders.push(rel);
      const directory = await openDirectory(root, rel);
      let names;
      try { names = await directoryNames(directory, 4000); } finally { await directory.close(); }
      for (const name of names) await visit([rel, name].filter(Boolean).join('/'), depth + 1);
    } else {
      bytes += info.size;
      files.push({ path: rel, size: info.size });
      if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error('Copy at most 2,000 files and 1 GiB at a time. Choose a smaller folder.');
    }
    return info.isDirectory();
  }
  const directory = await visit(relativeSharePath(relative), 0);
  return { files, folders, bytes, directory };
}

// Destination is always exclusive: an existing file is never overwritten.
export async function copyShareFiles({ sourceRoot, sourcePath, destinationRoot, destinationPath }) {
  sourcePath = relativeSharePath(sourcePath);
  destinationPath = relativeSharePath(destinationPath);
  if (!destinationPath) throw new Error('Choose a destination file or folder name.');
  const tree = await inventory(sourceRoot, sourcePath);
  const plan = tree.files.map(file => ({ ...file, destination: tree.directory
    ? [destinationPath, file.path.slice(sourcePath ? sourcePath.length + 1 : 0)].join('/') : destinationPath }));
  // Check all collisions before starting, then use exclusive opens for races.
  for (const file of plan) {
    try {
      const existing = await openFile(destinationRoot, file.destination);
      await existing.close();
      throw new Error(`Destination already exists: ${file.destination}`);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const copied = [];
  for (const folder of tree.folders) {
    const relative = folder === sourcePath ? '' : folder.slice(sourcePath ? sourcePath.length + 1 : 0);
    const empty = await openDirectory(destinationRoot, [destinationPath, relative].filter(Boolean).join('/'), true);
    await empty.close();
  }
  for (const file of plan) {
    let source, target, parent, created = false;
    try {
      source = await openFile(sourceRoot, file.path);
      const info = await source.stat();
      if (!info.isFile() || info.size !== file.size) throw new Error('Source changed during the copy. Try again.');
      const parentPath = path.posix.dirname(file.destination);
      parent = await openDirectory(destinationRoot, parentPath === '.' ? '' : parentPath, true);
      const name = `${fdPath(parent)}/${path.posix.basename(file.destination)}`;
      target = await fs.open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      // Bounded chunks also work on FUSE clients that only support sequential
      // writes. Keep ownership of both descriptors until the remote close.
      const buffer = Buffer.alloc(Math.min(256 * 1024, file.size));
      let position = 0;
      while (position < file.size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, file.size - position), position);
        if (!bytesRead) throw new Error('Source changed during the copy.');
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await target.write(buffer, written, bytesRead - written);
          if (!bytesWritten) throw new Error('Could not finish writing the destination.');
          written += bytesWritten;
        }
        position += bytesRead;
      }
      if ((await target.stat()).size !== file.size || (await source.stat()).size !== file.size) throw new Error('Source changed during the copy. Try again.');
      await target.sync();
      await target.close(); target = null;
      copied.push({ path: file.destination, size: file.size });
    } catch (e) {
      if (target) await target.close().catch(() => {});
      if (created && parent) await fs.unlink(`${fdPath(parent)}/${path.posix.basename(file.destination)}`).catch(() => {});
      return { copied, error: e.code === 'EEXIST' ? 'A destination file already exists. Choose a new name.' : 'Copy failed. The source may have changed or access may have been denied.', complete: false };
    } finally {
      await source?.close().catch(() => {});
      await parent?.close().catch(() => {});
    }
  }
  return { copied, complete: true, bytes: tree.bytes };
}
