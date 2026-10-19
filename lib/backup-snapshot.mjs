import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_SKIP } from './project-archive.mjs';

const fdPath = fd => `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${fd}`;
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const changed = () => Object.assign(new Error('Data changed during backup. Pause active work and retry; no inconsistent archive was exported.'), { code: 'SNAPSHOT_CHANGED' });
const version = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const inProject = relative => /^users\/[^/]+\/documents\/code\/[^/]+(?:\/|$)/.test(relative);
function excluded(relative) {
  const parts = relative.split('/');
  return inProject(relative) && parts.slice(5).some(name => ARCHIVE_SKIP.includes(name));
}
function equal(a, b) {
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}

/**
 * Three descriptor-rooted passes: inventory, copy, verification. Every retained
 * source must keep its identity/version throughout the copy window. External
 * writers therefore cannot silently produce a mixed account/key snapshot.
 * Synchronous work is confined to the export worker, not the server thread.
 */
export function copyStableBackupTree(base, destination, rootNames, maxBytes, { afterCopy } = {}) {
  function scan(copy, expected) {
    const inventory = new Map();
    let bytes = 0, skippedLinks = 0;
    function record(relative, value) {
      if (inventory.size >= 100000) throw new Error('Backup exceeds the 100,000 entry restore limit.');
      inventory.set(relative, value);
      if (expected && expected.get(relative) !== value) throw changed();
    }
    function readEntry(parent, name, relative, depth = 0) {
      if (depth > 80) throw new Error('Backup directory nesting is too deep.');
      if (excluded(relative)) return;
      const source = `${fdPath(parent)}/${name}`;
      const before = fs.lstatSync(source, { bigint: true });
      if (before.isSymbolicLink()) {
        if (!inProject(relative)) throw new Error('Backup state contains an unsupported symbolic link: ' + relative);
        skippedLinks++;
        record(relative, 'excluded-symlink:' + version(before));
        return;
      }
      if (!before.isDirectory() && !before.isFile()) throw new Error('Backup contains an unsupported special file: ' + relative);
      const fd = fs.openSync(source, flags | (before.isDirectory() ? fs.constants.O_DIRECTORY : 0));
      try { readOpened(fd, relative, before, depth); } finally { fs.closeSync(fd); }
    }
    function readOpened(fd, relative, before, depth) {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (version(opened) !== version(before)) throw changed();
      record(relative, version(opened));
      const target = path.join(destination, relative);
      if (opened.isDirectory()) {
        if (copy) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        for (const name of fs.readdirSync(fdPath(fd)).sort()) readEntry(fd, name, relative + '/' + name, depth + 1);
      } else if (opened.isFile()) {
        bytes += Number(opened.size);
        if (bytes > maxBytes) throw new Error('Backup exceeds the 5 GiB restored data limit.');
        if (copy) {
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.copyFileSync(fdPath(fd), target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
          fs.chmodSync(target, Number(opened.mode) & 0o111 ? 0o700 : 0o600);
        }
      } else throw new Error('Backup root is not a regular file or directory: ' + relative);
      if (version(fs.fstatSync(fd, { bigint: true })) !== version(before)) throw changed();
    }
    for (const relative of rootNames().sort()) {
      let source;
      try { source = fs.realpathSync(path.join(base, relative)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        record(relative, 'missing');
        continue;
      }
      // Only explicitly selected installation roots may be storage symlinks
      // (Docker volumes). All descendants are opened with O_NOFOLLOW.
      record(relative + ':root', source);
      const fd = fs.openSync(source, flags);
      try { readOpened(fd, relative, fs.fstatSync(fd, { bigint: true }), 0); }
      finally { fs.closeSync(fd); }
    }
    if (expected && !equal(inventory, expected)) throw changed();
    return { inventory, bytes, skippedLinks };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const before = scan(false);
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      scan(true, before.inventory);
      afterCopy?.(attempt);
      const after = scan(false, before.inventory);
      return { bytes: after.bytes, excludedProjectLinks: after.skippedLinks,
        excludedProjectDirectories: ARCHIVE_SKIP };
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      if (error.code !== 'SNAPSHOT_CHANGED' && !['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error.code) || attempt === 2) throw error;
    }
  }
  throw changed();
}
