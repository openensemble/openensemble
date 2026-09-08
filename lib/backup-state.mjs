/** File-only backup staging and crash-recoverable restore, before server import. */
import fs from 'node:fs';
import path from 'node:path';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWriteTargetSync } from './write-target.mjs';

export const BACKUP_MAX_BYTES = 500 * 1024 * 1024;
export const BACKUP_MAX_UNCOMPRESSED = 5 * 1024 * 1024 * 1024;
export const BACKUP_ENCRYPTION_OVERHEAD = 48;
const MANIFEST = '.backup-meta/snapshot.json';
const LEGACY_OWNER_STATE = '.backup-meta/owner-state.json';
const DATA_FILES = ['config.json', 'config/user-providers.json', 'shared-notes.json',
  'invites.json', 'expenses/transactions.json', 'expenses/groups.json', 'nodes.json'];
const DATA_DIRS = ['users', 'shared-docs', 'tasks'];
const RESET_FILES = ['active-sessions.json', 'browser-pairing.json', 'mcp-access-tokens.json',
  'background-task-journal.json', 'admission-requests.json'];
const PLUGIN_RE = /^usr_[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const OWNER_FIELDS = ['owner', 'ownerId', 'ownerUserId', 'ownerEmail'];
const EXTRACT_SCRIPT = fileURLToPath(new URL('../scripts/backup-archive.py', import.meta.url));

function exists(file) { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function readObject(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid JSON object: ' + file);
  return value;
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.tmp';
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function stateRoot(base) {
  return resolveWriteTargetSync(path.join(base, '.backup-meta'));
}
function pendingPath(base) { return path.join(stateRoot(base), 'pending-restore.json'); }
export function hasPendingRestore(base) { return exists(pendingPath(base)); }
export function assertNoPendingRestore(base) {
  if (hasPendingRestore(base)) throw new Error('A backup restore is staged. Run node scripts/launch.mjs to apply it before starting the server.');
}
function createWorkspace(base, prefix) {
  const root = stateRoot(base);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, prefix));
}
function children(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir) : []; }
function trainingFiles(dir) {
  return children(dir).filter(name => /\.(jsonl|py|json)$/.test(name) || name.startsWith('Modelfile'));
}
function assertDataTree(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) assertDataTree(full);
    else if (!entry.isFile()) throw new Error('Backup contains a link or special file: ' + full);
  }
}
function includesEncrypted(value) {
  if (!value || typeof value !== 'object') return false;
  return value.__enc === 'v1' || Object.values(value).some(includesEncrypted);
}

function validateSnapshot(root, { clearOwnerConfig = false, base } = {}) {
  assertDataTree(root);
  const profileNames = children(path.join(root, 'users')).filter(name => !name.startsWith('_') &&
    fs.existsSync(path.join(root, 'users', name, 'profile.json')));
  if (!profileNames.length) throw new Error('Backup has no user profiles; refusing to replace the installation.');
  let hasOwner = false;
  const profiles = [];
  for (const name of profileNames) {
    const profile = readObject(path.join(root, 'users', name, 'profile.json'));
    profiles.push(profile);
    if (profile.id !== name) throw new Error('Backup profile identity does not match its directory: ' + name);
    if (profile.role === 'owner' || profile.role === 'admin') hasOwner = true;
  }
  if (!hasOwner) throw new Error('Backup has no owner or admin profile.');
  const manifestPath = path.join(root, MANIFEST);
  const modern = fs.existsSync(manifestPath);
  if (modern && readObject(manifestPath).format !== 2) throw new Error('Unsupported backup snapshot format.');
  const configPath = path.join(root, 'config.json');
  if (!fs.existsSync(configPath)) {
    if (modern) throw new Error('Backup is missing config.json.');
    // Older exports omitted config. Retain the destination configuration and
    // matching system key; never pair its ciphertext with an unrelated key.
    const previous = base && fs.existsSync(path.join(base, 'config.json')) ? readObject(path.join(base, 'config.json')) : {};
    if (clearOwnerConfig) for (const key of OWNER_FIELDS) delete previous[key];
    const sidecar = path.join(root, LEGACY_OWNER_STATE);
    if (fs.existsSync(sidecar)) {
      const owner = readObject(sidecar);
      if (owner.skillAssignments !== undefined) previous.skillAssignments = owner.skillAssignments;
    }
    if (includesEncrypted(previous)) {
      throw new Error('This legacy backup omitted global configuration. Export a new backup, or restore to a fresh installation with no saved global credentials.');
    }
    writeJson(configPath, previous);
  }
  const config = readObject(configPath);
  if ([config, ...profiles].some(includesEncrypted)) {
    const key = path.join(root, 'users', '_system', '.master-key');
    if (!fs.existsSync(key) || fs.statSync(key).size !== 32) throw new Error('Encrypted configuration is missing its system encryption key.');
    const keyBytes = fs.readFileSync(key);
    const verify = value => {
      if (!value || typeof value !== 'object') return;
      if (value.__enc === 'v1') {
        try {
          const decipher = createDecipheriv('aes-256-gcm', keyBytes, Buffer.from(value.iv, 'hex'));
          decipher.setAuthTag(Buffer.from(value.tag, 'hex'));
          decipher.update(Buffer.from(value.ct, 'hex'));
          decipher.final();
        } catch { throw new Error('Backup configuration/profile encryption key does not match its encrypted data.'); }
      } else Object.values(value).forEach(verify);
    };
    [config, ...profiles].forEach(verify);
  }
  const providers = path.join(root, 'config/user-providers.json');
  if (fs.existsSync(providers)) readObject(providers);
  for (const name of children(path.join(root, 'users'))) {
    const key = path.join(root, 'users', name, '.master-key');
    if (fs.existsSync(key) && fs.statSync(key).size !== 32) throw new Error('Invalid user encryption key: ' + name);
  }
  return { modern };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let error = '';
    proc.stdout.resume();
    proc.stderr.on('data', data => { error = (error + data).slice(-8000); });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5 * 60_000);
    proc.once('error', reject);
    proc.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(error.trim() || `${command} failed (${code})`)); });
  });
}

export async function createBackupArchive(base, { maxBytes = BACKUP_MAX_BYTES - BACKUP_ENCRYPTION_OVERHEAD } = {}) {
  const workspace = createWorkspace(base, 'export-');
  const data = path.join(workspace, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  try {
    const files = [...DATA_FILES, ...DATA_DIRS];
    files.push(...children(path.join(base, 'plugins')).filter(name => PLUGIN_RE.test(name)).map(name => 'plugins/' + name));
    files.push(...trainingFiles(path.join(base, 'training-data')).map(name => 'training-data/' + name));
    // Synchronous copy freezes JS writers for the snapshot. Copy raw saved
    // ciphertext together with user keys; never export decrypted RAM/env keys.
    for (const rel of files) {
      const src = path.join(base, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(data, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      fs.cpSync(fs.realpathSync(src), dst, { recursive: true, dereference: false });
    }
    writeJson(path.join(data, MANIFEST), { format: 2, createdAt: new Date().toISOString() });
    validateSnapshot(data);
    let total = 0;
    const measure = dir => { for (const ent of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, ent.name); if (ent.isDirectory()) measure(file); else total += fs.statSync(file).size; } };
    measure(data);
    if (total > BACKUP_MAX_UNCOMPRESSED) throw new Error('Backup exceeds the 5 GiB restored data limit.');
    const archive = path.join(workspace, 'backup.tar.gz');
    await run('tar', ['czf', archive, '-C', data, '.']);
    if (fs.statSync(archive).size > maxBytes) throw new Error('Backup exceeds the 500 MiB restore limit. Use an offline filesystem backup for larger installations.');
    return { archive, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(workspace, { recursive: true, force: true }); throw error; }
}

export async function stageRestore(base, raw, options = {}) {
  assertNoPendingRestore(base);
  if (!Buffer.isBuffer(raw) || raw.length < 10 || raw.length > BACKUP_MAX_BYTES) throw new Error('Invalid archive or archive exceeds the 500 MiB restore limit.');
  const workspace = createWorkspace(base, 'restore-');
  const data = path.join(workspace, 'data');
  fs.mkdirSync(data, { mode: 0o700 });
  try {
    const archive = path.join(workspace, 'backup.tar.gz');
    fs.writeFileSync(archive, raw, { mode: 0o600 });
    await run('python3', [EXTRACT_SCRIPT, archive, data, String(BACKUP_MAX_UNCOMPRESSED)]);
    const { modern } = validateSnapshot(data, { ...options, base });
    fs.unlinkSync(archive);
    // Only one request can publish a pending restore, including concurrent
    // first-run and owner restore requests. All data is ready before publish.
    const descriptor = { format: 1, job: path.basename(workspace), modern, phase: 'staged' };
    fs.writeFileSync(pendingPath(base), JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
    return { restored: children(path.join(data, 'users')).length, pending: true };
  } catch (error) { fs.rmSync(workspace, { recursive: true, force: true }); throw error; }
}

function makePlan(base, data, modern, id) {
  const entries = [];
  function add(rel, incoming = path.join(data, rel)) {
    const dst = resolveWriteTargetSync(path.join(base, rel));
    const suffix = `.oe-restore-${id}-${entries.length}`;
    entries.push({ rel, dst, src: incoming && fs.existsSync(incoming) ? incoming : null,
      next: path.join(path.dirname(dst), suffix + '.new'), old: path.join(path.dirname(dst), suffix + '.old'),
      hadOld: exists(dst), ready: false });
  }
  for (const rel of DATA_FILES) {
    if (modern || fs.existsSync(path.join(data, rel))) add(rel);
  }
  for (const rel of [...DATA_DIRS, 'memory-db']) {
    const input = path.join(data, rel);
    if (rel === 'memory-db' && !fs.existsSync(input)) continue;
    if (!modern && !fs.existsSync(input)) continue;
    const target = resolveWriteTargetSync(path.join(base, rel));
    // Replace children, leaving bind-mounted directory roots intact.
    for (const name of new Set([...children(input), ...children(target)])) add(rel + '/' + name);
  }
  for (const name of new Set([...children(path.join(data, 'plugins')),
    ...(modern ? children(path.join(base, 'plugins')) : [])])) {
    if (PLUGIN_RE.test(name)) add('plugins/' + name);
  }
  for (const name of new Set([...trainingFiles(path.join(data, 'training-data')),
    ...(modern ? trainingFiles(path.join(base, 'training-data')) : [])])) add('training-data/' + name);
  // Browser sessions are intentionally never revived from the previous
  // installation. Paired nodes/devices revive through the restored registries.
  const empty = path.join(data, '.backup-meta/empty-sessions.json');
  writeJson(empty, {});
  for (const rel of RESET_FILES) add(rel, rel === 'active-sessions.json' ? empty : null);
  return entries;
}

function rollback(entries) {
  for (const entry of [...entries].reverse()) {
    if (exists(entry.old)) {
      if (exists(entry.dst)) fs.rmSync(entry.dst, { recursive: true, force: true });
      fs.renameSync(entry.old, entry.dst);
    } else if (!entry.hadOld && entry.ready && !exists(entry.next) && exists(entry.dst)) {
      fs.rmSync(entry.dst, { recursive: true, force: true });
    }
    if (exists(entry.next)) fs.rmSync(entry.next, { recursive: true, force: true });
  }
}

/** Called only by the builtins-only launcher, before any stateful imports. */
export function applyPendingRestore(base, { afterSwap } = {}) {
  const pending = pendingPath(base);
  if (!exists(pending)) return { applied: false };
  const pidPath = path.join(base, 'server.pid');
  const pid = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, 'utf8').trim()) : NaN;
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; }
    if (alive) throw new Error('Stop the running OE server before applying the staged backup restore.');
  }
  const descriptor = readObject(pending);
  if (descriptor.format !== 1 || !/^restore-[A-Za-z0-9]+$/.test(descriptor.job)) throw new Error('Invalid pending restore descriptor.');
  const workspace = path.join(stateRoot(base), descriptor.job);
  const journalPath = path.join(workspace, 'journal.json');
  const data = path.join(workspace, 'data');
  let journal = fs.existsSync(journalPath) ? readObject(journalPath) : null;
  if (journal?.phase === 'committed') {
    for (const entry of journal.entries) if (exists(entry.old)) fs.rmSync(entry.old, { recursive: true, force: true });
    fs.unlinkSync(pending);
    fs.rmSync(workspace, { recursive: true, force: true });
    return { applied: true };
  }
  if (journal) {
    rollback(journal.entries);
    fs.unlinkSync(journalPath);
  }
  validateSnapshot(data, { base });
  journal = { phase: 'preparing', entries: makePlan(base, data, descriptor.modern, randomBytes(5).toString('hex')) };
  writeJson(journalPath, journal);
  try {
    for (const entry of journal.entries) {
      fs.mkdirSync(path.dirname(entry.dst), { recursive: true, mode: 0o700 });
      if (entry.src) fs.cpSync(entry.src, entry.next, { recursive: true, errorOnExist: true, force: false });
      entry.ready = true;
      writeJson(journalPath, journal);
    }
    journal.phase = 'applying';
    writeJson(journalPath, journal);
    for (const [index, entry] of journal.entries.entries()) {
      if (entry.hadOld) fs.renameSync(entry.dst, entry.old);
      if (entry.src) fs.renameSync(entry.next, entry.dst);
      afterSwap?.(index, entry);
    }
    journal.phase = 'committed';
    writeJson(journalPath, journal);
  } catch (error) {
    rollback(journal.entries);
    fs.unlinkSync(journalPath);
    throw new Error('Restore failed; previous state was restored. Fix the error and restart to retry: ' + error.message);
  }
  for (const entry of journal.entries) if (exists(entry.old)) fs.rmSync(entry.old, { recursive: true, force: true });
  fs.unlinkSync(pending);
  fs.rmSync(workspace, { recursive: true, force: true });
  return { applied: true };
}
