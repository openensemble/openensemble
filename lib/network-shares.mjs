import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getUserDir } from '../routes/_helpers/paths.mjs';
import { atomicWriteSync, withLock } from '../routes/_helpers/io-lock.mjs';
import { addDocumentFromPath, getProfileFilePath } from './profile-files.mjs';
import { getCredentialValue, storeCredential, deleteCredential, requestCredential, resolveCredentialValue, dropRamCredential } from './credentials.mjs';
import { parseShareLocation, validateShareHost, shareError, shareServerKey, mountShare, unmountShare, hasShareMount, shareMountPath, discoverSmb, discoverNfs } from './network-share-mounts.mjs';
import { runShareCommand } from './network-share-process.mjs';
import { relativeSharePath, shareFileMime, shareFilePaths } from './network-share-files.mjs';

const worker = fileURLToPath(new URL('./network-share-worker.mjs', import.meta.url));
const USER_ID = /^[a-zA-Z0-9_-]+$/;
const SHARE_ID = /^share_[a-f0-9]{24}$/;

function accountDir(userId) {
  if (typeof userId !== 'string' || !USER_ID.test(userId)) throw shareError('INVALID', 'A signed-in OE account is required.');
  return getUserDir(userId);
}
function configPath(userId) { return path.join(accountDir(userId), 'network-shares.json'); }
async function load(userId) {
  try {
    const records = JSON.parse(await fs.readFile(configPath(userId), 'utf8'));
    if (!Array.isArray(records)) throw new Error('Invalid share configuration.');
    return records;
  } catch (e) { if (e.code === 'ENOENT') return []; throw shareError('CONFIG', 'Could not read saved network shares.'); }
}
async function save(userId, records) {
  await fs.mkdir(accountDir(userId), { recursive: true });
  atomicWriteSync(configPath(userId), JSON.stringify(records, null, 2), { mode: 0o600 });
}
function findRecord(records, reference) {
  const found = records.filter(r => r.id === reference || r.name.toLowerCase() === String(reference).toLowerCase());
  if (found.length !== 1 || !SHARE_ID.test(found[0].id)) throw shareError('NOT_FOUND', 'Choose a saved share by its name or ID from list_network_shares.');
  return found[0];
}
function publicRecord(record, connected) {
  return { id: record.id, name: record.name, protocol: record.protocol, location: record.location,
    readOnly: record.readOnly, autoMount: record.autoMount !== false, ...(record.version ? { version: record.version } : {}), connected };
}

export function validateSmbCredentials(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw shareError('INVALID', 'Enter the SMB username and password in the credential form.');
  const out = {};
  for (const key of ['username', 'password', 'domain']) {
    const text = value[key] ?? '';
    if (typeof text !== 'string' || text.length > 1024 || /[\x00-\x1f\x7f]/.test(text)) throw shareError('INVALID', 'SMB credentials must be text without control characters.');
    out[key] = key === 'password' ? text : text.trim();
  }
  if (!out.username) throw shareError('INVALID', 'An SMB username is required.');
  return out;
}
function savedCredentials(userId, spec) {
  const value = getCredentialValue(userId, shareServerKey(spec));
  if (!value) return null;
  try { return validateSmbCredentials(JSON.parse(value)); } catch { return null; }
}
async function promptSmbCredentials(userId, spec) {
  let prompt;
  try {
    prompt = await requestCredential({ userId, kind: 'smb', persist: false, ttlMs: 300000,
      label: `Connect to ${spec.host}`, description: 'Enter the SMB login for this server. It stays out of chat history and is saved encrypted for your account after a successful connection.' });
    return validateSmbCredentials(JSON.parse(resolveCredentialValue(userId, prompt.id)));
  } catch (e) {
    if (['CANCELLED', 'TIMEOUT'].includes(e.code)) throw shareError(e.code, e.code === 'CANCELLED' ? 'Connection cancelled.' : 'The credential form expired. Ask to connect again.');
    throw shareError('INVALID', 'Could not read the SMB credential form. Try connecting again.');
  } finally { if (prompt) dropRamCredential(prompt.id); }
}
async function rememberCredentials(userId, spec, credentials) {
  if (!credentials) return;
  await storeCredential(userId, { id: shareServerKey(spec), label: `SMB login for ${spec.host}`, kind: 'network_share', value: JSON.stringify(credentials) });
}

async function fileOperation(action, args) {
  const output = await runShareCommand(process.execPath, [worker], { input: JSON.stringify({ action, args }),
    timeout: ['copy', 'delete'].includes(action) ? 300000 : 30000, maxBytes: 16 * 1024 * 1024 });
  const result = JSON.parse(output);
  if (result.error && !('copied' in result) && !('deleted' in result)) throw shareError(result.code || 'FILES', result.error);
  return result;
}

// The adapter also permits protocol-independent regression tests without a
// live share or any writes to a user's NAS.
export function createNetworkShareService(adapter = {}) {
  const backend = { mountShare, unmountShare, hasShareMount, shareMountPath, discoverSmb, discoverNfs, fileOperation, ...adapter };
  const locked = (userId, fn) => withLock(configPath(userId), fn);

  async function authenticate(userId, spec, options, operation) {
    if (spec.protocol !== 'smb') {
      if (options.credentials) throw shareError('INVALID', 'NFS uses export permissions and the OE service UID/GID, not an SMB password.');
      return operation(null);
    }
    let credentials = options.credentials ? validateSmbCredentials(options.credentials) : savedCredentials(userId, spec);
    if (options.authenticate && !options.credentials) {
      if (!options.prompt) throw shareError('AUTH_REQUIRED', 'Enter the SMB login in the connection form.');
      credentials = await promptSmbCredentials(userId, spec);
    }
    let result;
    try { result = await operation(credentials); }
    catch (e) {
      if (e.code !== 'AUTH_REQUIRED' || !options.prompt || options.authenticate || options.credentials) throw e;
      credentials = await promptSmbCredentials(userId, spec);
      try { result = await operation(credentials); }
      catch (next) { if (next.code === 'AUTH_REQUIRED') throw shareError('AUTH_FAILED', 'The SMB login was rejected. Check the username, password, and domain, then connect again.'); throw next; }
    }
    await rememberCredentials(userId, spec, credentials);
    return result;
  }

  async function connectRecord(userId, record, options) {
    if ((options.authenticate || options.credentials) && await backend.hasShareMount(userId, record.id)) await backend.unmountShare(userId, record.id);
    if (!await backend.hasShareMount(userId, record.id)) {
      await authenticate(userId, record, options, credentials => backend.mountShare(userId, record, credentials));
    }
    return publicRecord(record, true);
  }

  async function connected(userId, reference, options) {
    const records = await load(userId), record = findRecord(records, reference);
    await connectRecord(userId, record, options);
    if (record.autoMount === false) {
      record.autoMount = true;
      await save(userId, records);
    }
    return record;
  }

  return {
    async list(userId) {
      return Promise.all((await load(userId)).map(async record => publicRecord(record, await backend.hasShareMount(userId, record.id))));
    },
    restore(userId) {
      return locked(userId, async () => {
        const results = [];
        for (const record of await load(userId)) {
          if (record?.autoMount === false) continue;
          try {
            if (!record || !SHARE_ID.test(record.id)) throw shareError('CONFIG', 'Invalid saved share.');
            const spec = parseShareLocation(record.location, record);
            const share = await connectRecord(userId, { ...record, ...spec }, { prompt: false });
            results.push({ id: share.id, connected: true });
          } catch (error) {
            results.push({ id: SHARE_ID.test(record?.id) ? record.id : null, connected: false, code: error.code || 'SHARE_ERROR' });
          }
        }
        return results;
      });
    },
    async discover(userId, options = {}) {
      accountDir(userId);
      const host = validateShareHost(options.server);
      const protocol = options.protocol || 'auto';
      if (!['auto', 'smb', 'nfs'].includes(protocol)) throw shareError('INVALID', 'Choose SMB, NFS, or automatic discovery.');
      if (options.port && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw shareError('INVALID', 'Port must be between 1 and 65535.');
      const results = {};
      // Start both protocols together: a missing NFS portmapper must not
      // delay the SMB result or its credential form.
      const nfsDiscovery = async () => {
        if (protocol === 'smb') return;
        try { results.nfs = { shares: await backend.discoverNfs(host) }; }
        catch (e) { results.nfs = { error: e.message, hint: 'NFSv4 servers may hide export discovery. An exact nfs://server/export address can still connect.' }; }
      };
      const smbDiscovery = async () => {
        if (protocol === 'nfs') return;
        try {
          const spec = { protocol: 'smb', host, port: options.port };
          results.smb = { shares: await authenticate(userId, spec, options, credentials => backend.discoverSmb(spec, credentials)) };
        } catch (e) {
          if (['CANCELLED', 'TIMEOUT'].includes(e.code)) throw e;
          results.smb = { error: e.message, code: e.code };
        }
      };
      await Promise.all([nfsDiscovery(), smbDiscovery()]);
      return { server: host, ...results };
    },
    connect(userId, options = {}) {
      return locked(userId, async () => {
        const records = await load(userId);
        if (options.share_id) {
          const record = findRecord(records, options.share_id);
          await connectRecord(userId, record, options);
          record.autoMount = true;
          await save(userId, records);
          return publicRecord(record, true);
        }
        if (options.read_only !== undefined && typeof options.read_only !== 'boolean') throw shareError('INVALID', 'Read only must be true or false.');
        const spec = parseShareLocation(options.location, options);
        const existing = records.find(r => r.location === spec.location && r.version === spec.version && r.mount_port === spec.mount_port);
        if (existing) {
          await connectRecord(userId, existing, options);
          existing.autoMount = true;
          await save(userId, records);
          return publicRecord(existing, true);
        }
        if (records.length >= 32) throw shareError('LIMIT', 'An account can save up to 32 network shares. Disconnect and forget one first.');
        const name = String(options.name || `${spec.host} ${path.posix.basename(spec.remotePath) || 'root'}`).trim();
        if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw shareError('INVALID', 'Choose a share name of 1–100 characters.');
        if (records.some(r => r.name.toLowerCase() === name.toLowerCase())) throw shareError('INVALID', 'That share name is already in use. Choose another name.');
        const record = { ...spec, id: `share_${randomBytes(12).toString('hex')}`, name, readOnly: options.read_only === true, autoMount: true, createdAt: new Date().toISOString() };
        const result = await connectRecord(userId, record, options);
        try { await save(userId, [...records, record]); }
        catch (e) { await backend.unmountShare(userId, record.id).catch(() => {}); throw e; }
        return result;
      });
    },
    disconnect(userId, options = {}) {
      return locked(userId, async () => {
        const records = await load(userId), record = findRecord(records, options.share_id);
        await backend.unmountShare(userId, record.id);
        if (options.forget === true) {
          const remaining = records.filter(r => r.id !== record.id);
          await save(userId, remaining);
          if (!remaining.some(r => shareServerKey(r) === shareServerKey(record))) deleteCredential(userId, shareServerKey(record));
        } else {
          record.autoMount = false;
          await save(userId, records);
        }
        return { ...publicRecord(record, false), autoMount: false, forgotten: options.forget === true,
          message: 'Disconnected from OE. The server share and all remote files are unchanged.' };
      });
    },
    browse(userId, options = {}) {
      return locked(userId, async () => {
        const record = await connected(userId, options.share_id, options);
        return { share: publicRecord(record, true), ...await backend.fileOperation(options.read ? 'read' : 'list', {
          root: backend.shareMountPath(userId, record.id), path: relativeSharePath(options.path || ''), offset: options.offset, limit: options.limit }) };
      });
    },
    copyTo(userId, options = {}) {
      return locked(userId, async () => {
        const record = await connected(userId, options.share_id, options);
        if (record.readOnly) throw shareError('READ_ONLY', 'This share was connected read-only.');
        if (typeof options.file_id !== 'string') throw shareError('INVALID', 'Choose a file_id from list_profile_files.');
        let source;
        if (options.file_id.startsWith('code:')) source = path.join(accountDir(userId), 'documents', 'code', relativeSharePath(options.file_id.slice(5)));
        else source = getProfileFilePath(userId, options.file_id);
        if (!source) throw shareError('NOT_FOUND', 'The source file is not in your OE profile. Use a file_id from list_profile_files.');
        const sourcePath = relativeSharePath(path.relative(accountDir(userId), source));
        if (!['documents', 'images', 'videos', 'audio', 'research'].includes(sourcePath.split('/')[0])) throw shareError('INVALID', 'Only your profile files can be copied to a share.');
        const destinationPath = relativeSharePath(options.destination);
        return backend.fileOperation('copy', { sourceRoot: accountDir(userId), sourcePath,
          destinationRoot: backend.shareMountPath(userId, record.id), destinationPath });
      });
    },
    deleteFiles(userId, options = {}) {
      return locked(userId, async () => {
        let paths;
        try { paths = shareFilePaths(options.paths); }
        catch (error) { throw shareError('INVALID', error.message); }
        const record = await connected(userId, options.share_id, options);
        if (record.readOnly) throw shareError('READ_ONLY', 'This share was connected read-only.');
        return { share: publicRecord(record, true), ...await backend.fileOperation('delete', {
          root: backend.shareMountPath(userId, record.id), paths }) };
      });
    },
    copyFrom(userId, options = {}) {
      return locked(userId, async () => {
        const record = await connected(userId, options.share_id, options);
        const sourcePath = relativeSharePath(options.path || '');
        const folder = options.folder || 'documents';
        if (!['documents', 'images', 'videos', 'audio'].includes(folder)) throw shareError('INVALID', 'Choose documents, images, videos, or audio as the OE folder.');
        // Stage locally before adding registry entries, so failed transfers
        // cannot produce successful-looking profile files.
        const staging = await fs.mkdtemp(path.join(accountDir(userId), '.share-import-'));
        try {
          const result = await backend.fileOperation('copy', { sourceRoot: backend.shareMountPath(userId, record.id), sourcePath,
            destinationRoot: staging, destinationPath: 'import' });
          if (!result.complete) return { copied: [], complete: false, error: result.error || 'Import did not finish. No profile files were added.' };
          const imported = [];
          for (const file of result.copied) {
            const relative = relativeSharePath(file.path);
            const fileName = relative === 'import' ? path.posix.basename(sourcePath) : relative.slice('import/'.length);
            const mimeType = shareFileMime(fileName);
            if (folder !== 'documents' && !mimeType.startsWith(`${folder === 'images' ? 'image' : folder === 'videos' ? 'video' : 'audio'}/`)) {
              throw shareError('INVALID', `Use Documents for files that are not ${folder}.`);
            }
          }
          for (const file of result.copied) {
            const relative = relativeSharePath(file.path);
            const fileName = relative === 'import' ? path.posix.basename(sourcePath) : relative.slice('import/'.length);
            const srcPath = path.join(staging, relative), mimeType = shareFileMime(fileName);
            try {
              if (folder === 'documents') {
                const added = await addDocumentFromPath(userId, { srcPath, fileName, mimeType, kind: 'network_share', description: `Copied from ${record.name}` });
                imported.push({ file_id: added.file_id, name: fileName, size: file.size });
              } else {
                // Media drawers use flat filenames. A random suffix preserves
                // every existing file and handles repeated names in folders.
                const ext = path.extname(fileName), base = path.basename(fileName, ext);
                const name = `${base.slice(0, 150)}-${randomBytes(6).toString('hex')}${ext}`;
                const destinationRoot = path.join(accountDir(userId), folder);
                await fs.mkdir(destinationRoot, { recursive: true });
                const copied = await backend.fileOperation('copy', { sourceRoot: staging, sourcePath: relative, destinationRoot, destinationPath: name });
                if (!copied.complete) throw new Error('Media import failed.');
                imported.push({ file_id: `${folder}:${name}`, name, size: file.size });
              }
            } catch { return { copied: imported, complete: false, error: 'Import stopped. The listed files were saved; remaining files were not imported.' }; }
          }
          return { copied: imported, complete: true, bytes: result.bytes,
            ...(!imported.length ? { message: 'No regular files were found; nothing was imported.' } : {}) };
        } finally { await fs.rm(staging, { recursive: true, force: true }); }
      });
    },
  };
}

export const networkShares = createNetworkShareService();
