/**
 * Resolve the storage target for writes that finish with rename(2).
 *
 * Renaming a temporary file over a symlink replaces the link itself. Docker
 * uses links from historical application paths into its durable state volume,
 * so atomic writers must replace the linked target instead. A dangling link is
 * valid here: it represents state that the application has not created yet.
 */
import fs from 'fs';
import path from 'path';

export function resolveWriteTargetSync(filePath) {
  try {
    if (!fs.lstatSync(filePath).isSymbolicLink()) return filePath;
    try {
      return fs.realpathSync(filePath);
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
      const linkTarget = fs.readlinkSync(filePath);
      return path.resolve(path.dirname(filePath), linkTarget);
    }
  } catch (e) {
    if (e?.code === 'ENOENT') return filePath;
    throw e;
  }
}
