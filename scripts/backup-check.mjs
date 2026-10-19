// Trusted, file-only subprocess. Never import or execute code from the archive.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createBackupArchive, verifyRestoreFile } from '../lib/backup-state.mjs';
import { copyStableBackupTree } from '../lib/backup-snapshot.mjs';
import { encryptBackupFile, decryptBackupFile, isEncryptedBackupFile } from '../lib/backup-crypto.mjs';
import { backupRoots, BACKUP_MAX_BYTES, BACKUP_MAX_UNCOMPRESSED, BACKUP_MAX_ENTRIES,
  BACKUP_VERIFIER_VERSION } from '../lib/backup-policy.mjs';
import { ARCHIVE_SKIP } from '../lib/project-archive.mjs';

function hashFile(file) {
  const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

export async function checkBackup({ action, base, workspace, password = '' }) {
  if (action === 'preflight') {
    const inventory = copyStableBackupTree(base, null, () => backupRoots(base), BACKUP_MAX_UNCOMPRESSED, { inspectOnly: true });
    const blockers = [];
    if (inventory.blockers.stateLinks) blockers.push({ code: 'STATE_LINKS', count: inventory.blockers.stateLinks, message: 'Remove symbolic links from account state before exporting. Code project links are safely omitted.' });
    if (inventory.blockers.specialFiles) blockers.push({ code: 'SPECIAL_FILES', count: inventory.blockers.specialFiles, message: 'Remove sockets, devices or named pipes from saved data before exporting.' });
    if (inventory.missingConfiguration) blockers.push({ code: 'MISSING_CONFIG', count: 1, message: 'Save the installation configuration before exporting.' });
    if (!inventory.profiles) blockers.push({ code: 'MISSING_PROFILES', count: 1, message: 'Create an owner profile before exporting.' });
    return { checkedAt: new Date().toISOString(), canExport: !blockers.length, blockers,
      categories: inventory.categories, totalBytes: inventory.bytes, profiles: inventory.profiles,
      excluded: [{ id: 'project-generated', label: 'Code dependencies, build output and caches', count: inventory.skippedDirectories, names: ARCHIVE_SKIP },
        { id: 'project-links', label: 'Code project symbolic links', count: inventory.skippedLinks },
        { id: 'runtime', label: 'Server dependencies, model weights, server logs, browser sessions and transient server state', count: null }],
      limits: { archiveBytes: BACKUP_MAX_BYTES, restoredBytes: BACKUP_MAX_UNCOMPRESSED, entries: BACKUP_MAX_ENTRIES, timeoutSeconds: 600 },
      note: 'Inventory is an estimate. Export rechecks source consistency and verifies the actual archive with a disposable restore.' };
  }
  let archive = path.join(workspace, 'input');
  if (action === 'export') {
    const bundle = await createBackupArchive(base, { workspace: path.join(workspace, 'export') });
    archive = bundle.archive;
    if (password) {
      archive = path.join(workspace, 'download.oeb');
      await encryptBackupFile(bundle.archive, archive, password);
    }
  } else if (action !== 'verify') throw new Error('Unsupported backup check action.');
  const archiveBytes = fs.statSync(archive).size;
  if (archiveBytes > BACKUP_MAX_BYTES || archiveBytes < 10) throw new Error('Invalid archive or archive exceeds the 500 MiB restore limit.');
  const sha256 = hashFile(archive);
  const encrypted = isEncryptedBackupFile(archive);
  let plain = archive;
  if (encrypted) {
    if (!password) throw new Error('Password is required');
    plain = path.join(workspace, 'plain.tar.gz');
    await decryptBackupFile(archive, plain, password);
  }
  const scratch = path.join(workspace, 'scratch');
  fs.mkdirSync(scratch, { mode: 0o700 });
  const inventory = await verifyRestoreFile(scratch, plain);
  if (hashFile(archive) !== sha256) throw new Error('Archive changed during verification.');
  const receipt = { sha256, archiveBytes, encrypted, verifierVersion: BACKUP_VERIFIER_VERSION,
    verifiedAt: new Date().toISOString(), scope: 'disposable-restore', ...inventory };
  return { receipt, ...(action === 'export' ? { archive } : {}) };
}

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16384) throw new Error('Backup check input too large.');
}
try { process.stdout.write(JSON.stringify({ result: await checkBackup(JSON.parse(input)) })); }
catch (error) {
  // The parent maps this internal diagnostic to fixed, path-free messages.
  process.stdout.write(JSON.stringify({ error: String(error.message).slice(0, 2000) }));
  process.exitCode = 1;
}
