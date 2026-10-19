import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';
import { BASE_DIR } from './paths.mjs';
import { runShareCommand } from './network-share-process.mjs';
import { ensureShareCommand } from './network-share-tools.mjs';

export const shareError = (code, message) => Object.assign(new Error(message), { code });
const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 24);
export const shareServerKey = spec => `network-share-${digest(`${spec.protocol}:${spec.host}:${spec.port || 445}`)}`;

export function validateShareHost(input) {
  const host = String(input || '').trim().replace(/^\[|\]$/g, '');
  if (host.length > 253 || (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) {
    throw shareError('INVALID', 'Enter a server hostname or IP address.');
  }
  return host.toLowerCase();
}

export function parseShareLocation(input, options = {}) {
  let location = String(input || '').trim().replace(/\\/g, '/');
  if (!location || location.length > 2048 || /[\x00-\x1f\x7f]/.test(location)) throw shareError('INVALID', 'Enter an SMB share or NFS export path.');
  const nfs = location.match(/^(\[[^\]]+\]|[^/:]+):(\/(?!\/).*)$/);
  if (nfs) location = `nfs://${nfs[1]}${nfs[2]}`;
  if (location.startsWith('//')) location = `smb:${location}`;
  // Check before URL normalization, which would silently remove traversal.
  let decoded;
  try { decoded = decodeURIComponent(location); } catch { throw shareError('INVALID', 'Invalid share address encoding.'); }
  if (/[\x00-\x1f\x7f\\]/.test(decoded) || decoded.split('/').some(p => p === '.' || p === '..')) throw shareError('INVALID', 'Share addresses cannot contain traversal or control characters.');
  let url;
  try { url = new URL(location); } catch { throw shareError('INVALID', 'Use //server/share, smb://server/share, nfs://server/export, or server:/export.'); }
  if (!['smb:', 'nfs:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw shareError('INVALID', 'Use an SMB or NFS address without credentials, query parameters, or a fragment.');
  const protocol = url.protocol.slice(0, -1);
  const host = validateShareHost(url.hostname);
  const remotePath = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
  if (protocol === 'smb' && remotePath === '/') throw shareError('INVALID', 'An SMB share name is required. Discover the server first if you do not know it.');
  const port = url.port ? Number(url.port) : (options.port !== undefined ? Number(options.port) : undefined);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw shareError('INVALID', 'Port must be between 1 and 65535.');
  if (protocol === 'nfs' && remotePath.includes('?')) throw shareError('INVALID', 'NFS export paths cannot contain a question mark.');
  const mountPort = options.mount_port === undefined ? undefined : Number(options.mount_port);
  if (mountPort !== undefined && (!Number.isInteger(mountPort) || mountPort < 1 || mountPort > 65535)) throw shareError('INVALID', 'NFS mount port must be between 1 and 65535.');
  const version = Number(options.version ?? 4);
  if (protocol === 'nfs' && ![3, 4].includes(version)) throw shareError('INVALID', 'Choose NFS version 3 or 4.');
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  return { protocol, host, remotePath, ...(port ? { port } : {}), ...(protocol === 'nfs' ? { version, ...(mountPort ? { mount_port: mountPort } : {}) } : {}),
    location: `${protocol}://${authority}${port ? `:${port}` : ''}${remotePath.split('/').map(encodeURIComponent).join('/')}` };
}

export function publicMountError(error, protocol) {
  if (['INVALID', 'LIMIT', 'TIMEOUT', 'CANCELLED', 'DEPENDENCY', 'AUTH_REQUIRED', 'AUTH_FAILED'].includes(error?.code)) return error;
  if (error?.code === 'ENOENT') return shareError('DEPENDENCY', 'Share tools are missing. Ask OE to set up network-share support.');
  const detail = String(error?.stderr || '');
  // Host FUSE permission failures are not SMB credentials or NFS export errors.
  if (/fusermount|\/dev\/fuse|fuse:|failed to mount FUSE|mount.*operation not permitted/i.test(detail)) {
    return shareError('DEPENDENCY', 'The host blocked the network-share mount. Ask OE to check and set up FUSE support.');
  }
  if (protocol === 'smb' && /logon|access.denied|permission.denied|authentication|STATUS_ACCOUNT|STATUS_PASSWORD/i.test(detail)) {
    return shareError('AUTH_REQUIRED', 'The SMB server needs a valid username, password, and optionally a domain.');
  }
  if (protocol === 'nfs' && /denied|permission|not permitted|auth/i.test(detail)) {
    return shareError('ACCESS_DENIED', 'NFS access was denied. Check the export allows this OE host and its service UID/GID. Servers requiring a reserved client port need fuse-nfs configured for that by an administrator.');
  }
  if (/not found|does not exist|BAD_NETWORK_NAME|No such file/i.test(detail)) return shareError('NOT_FOUND', 'The server could not find that share or export. Check its exact path.');
  return shareError('UNAVAILABLE', 'Could not access the share. Check the server, share path, network access, and server permissions.');
}

function commandEnv(extra = {}) {
  const env = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.PATH = `${path.join(BASE_DIR, 'bin')}${path.delimiter}${env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}`;
  return { ...env, ...extra };
}

async function shareCommand(name) {
  return ensureShareCommand(name, commandEnv());
}

async function smbEnv(spec, credentials) {
  const env = commandEnv({ RCLONE_CONFIG_OESHARE_TYPE: 'smb', RCLONE_CONFIG_OESHARE_HOST: spec.host,
    RCLONE_CONFIG_OESHARE_PORT: String(spec.port || 445), RCLONE_CONFIG_OESHARE_USER: credentials?.username || 'guest',
    RCLONE_CONFIG_OESHARE_DOMAIN: credentials?.domain || '', RCLONE_CONFIG_OESHARE_PASS: '' });
  if (credentials?.password) env.RCLONE_CONFIG_OESHARE_PASS = (await runShareCommand(await shareCommand('rclone'), ['obscure', '-'], { env: commandEnv(), input: credentials.password })).trim();
  return env;
}

// Retire pooled SMB connections before the socket I/O timeout expires. Older
// rclone clients otherwise reuse a dead connection and the next FUSE lookup
// fails with EIO, even though the share still appears connected.
const RCLONE_ARGS = ['--config', '/dev/null', '--contimeout', '8s', '--timeout', '15s',
  '--smb-idle-timeout', '10s', '--retries', '1', '--low-level-retries', '1'];

export async function discoverSmb(spec, credentials) {
  const env = await smbEnv(spec, credentials);
  try {
    const output = await runShareCommand(await shareCommand('rclone'), ['lsjson', 'oeshare:', '--dirs-only', ...RCLONE_ARGS], { env });
    return JSON.parse(output).slice(0, 200).map(e => ({ name: e.Name, location: parseShareLocation(`smb://${isIP(spec.host) === 6 ? `[${spec.host}]` : spec.host}${spec.port ? `:${spec.port}` : ''}/${encodeURIComponent(e.Name)}`).location }));
  } catch (e) { throw publicMountError(e, 'smb'); }
}

export async function discoverNfs(host) {
  try {
    const output = await runShareCommand(await shareCommand('showmount'), ['--exports', validateShareHost(host)], { env: commandEnv() });
    const authority = isIP(host) === 6 ? `[${host}]` : host;
    return output.split('\n').filter(line => line.startsWith('/')).slice(0, 200).map(line => {
      const remotePath = line.trim().split(/\s+/)[0];
      return { name: remotePath, location: parseShareLocation(`nfs://${authority}${remotePath}`).location };
    });
  } catch (e) { throw publicMountError(e, 'nfs'); }
}

// Mounts live outside the account tree so backups/indexers cannot walk a NAS.
const RUNTIME_ROOT = path.join(os.tmpdir(), `oe-shares-${process.getuid?.() ?? 'user'}-${digest(BASE_DIR)}`);
const mountSource = (userId, id) => `oe-share-${digest(`${userId}:${id}`)}`;
export const shareMountPath = (userId, id) => path.join(RUNTIME_ROOT, digest(userId), id, 'mount');
const decodeMountField = text => text.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));

export async function hasShareMount(userId, id) {
  const target = shareMountPath(userId, id);
  const source = mountSource(userId, id);
  const info = await fs.readFile('/proc/self/mountinfo', 'utf8');
  return info.split('\n').some(line => {
    const [left, right] = line.split(' - ');
    return right && decodeMountField(left.split(' ')[4]) === target && right.split(' ')[0].startsWith('fuse') && decodeMountField(right.split(' ')[1]) === source;
  });
}

async function privateDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw shareError('INVALID', 'The share mount directory is not private to the OE service.');
  await fs.chmod(dir, 0o700);
}

const children = new Map();
export async function mountShare(userId, record, credentials) {
  if (process.platform !== 'linux') throw shareError('DEPENDENCY', 'Network share mounts currently require a Linux OE server with FUSE.');
  if (await hasShareMount(userId, record.id)) return shareMountPath(userId, record.id);
  try {
    const device = await fs.open('/dev/fuse', fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
    try { if (!(await device.stat()).isCharacterDevice()) throw new Error('Invalid FUSE device.'); }
    finally { await device.close(); }
  }
  catch { throw shareError('DEPENDENCY', 'OE cannot access the FUSE device needed for network shares. Ask OE to set up network-share support.'); }
  const target = shareMountPath(userId, record.id), source = mountSource(userId, record.id);
  for (const dir of [RUNTIME_ROOT, path.dirname(path.dirname(target)), path.dirname(target), target]) await privateDirectory(dir);
  if ((await fs.readdir(target)).length) throw shareError('INVALID', 'The share mount folder is not empty.');
  let command, args, env;
  if (record.protocol === 'smb') {
    env = await smbEnv(record, credentials);
    command = await shareCommand('rclone');
    // rclone can publish a FUSE mount before its first SMB tree connection.
    // Verify access now so an auth failure opens the inline form instead of
    // leaving a successful-looking mount that returns EIO on the first read.
    try {
      await runShareCommand(command, ['lsjson', `oeshare:${record.remotePath.slice(1)}`, '--stat', ...RCLONE_ARGS], { env });
    } catch (e) { throw publicMountError(e, 'smb'); }
    args = ['mount', `oeshare:${record.remotePath.slice(1)}`, target, ...RCLONE_ARGS,
      '--devname', source, '--dir-cache-time', '2s', '--attr-timeout', '1s', '--vfs-cache-mode', 'off',
      '--umask', '077', '--default-permissions', ...(record.readOnly ? ['--read-only'] : [])];
  } else {
    command = await shareCommand('fuse-nfs');
    env = commandEnv();
    const authority = isIP(record.host) === 6 ? `[${record.host}]` : record.host;
    const encodedPath = record.remotePath.split('/').map(encodeURIComponent).join('/');
    const url = `nfs://${authority}${encodedPath}?version=${record.version}&uid=${process.getuid()}&gid=${process.getgid()}&auto-traverse-mounts=0&timeout=10000&autoreconnect=0${record.port ? `&nfsport=${record.port}` : ''}${record.mount_port ? `&mountport=${record.mount_port}` : ''}`;
    // -D keeps fuse-nfs in the foreground; stderr is drained and bounded.
    args = ['-n', url, '-m', target, '-D', '-f', source, '-s', 'oe-nfs', '-K', '077', ...(record.readOnly ? ['-O'] : [])];
  }
  const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let error, stderr = '', exited = false;
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  child.on('error', e => { error = e; });
  child.on('close', () => { exited = true; if (children.get(target) === child) children.delete(target); });
  children.set(target, child);
  try {
    for (let i = 0; i < 150; i++) {
      if (error || exited) throw error || Object.assign(new Error('Mount failed.'), { stderr });
      if (await hasShareMount(userId, record.id)) return target;
      await delay(100);
    }
    throw shareError('TIMEOUT', 'Connecting to the share timed out. Check the server and export path.');
  } catch (e) {
    child.kill('SIGKILL');
    await unmountShare(userId, record.id).catch(() => {});
    throw publicMountError(e, record.protocol);
  }
}

export async function unmountShare(userId, id) {
  const target = shareMountPath(userId, id);
  if (await hasShareMount(userId, id)) {
    try { await runShareCommand('fusermount3', ['-u', target], { timeout: 5000 }); }
    catch (e) {
      if (e.code !== 'ENOENT') throw shareError('BUSY', 'The share is busy. Finish its file operations before disconnecting.');
      await runShareCommand('fusermount', ['-u', target], { timeout: 5000 });
    }
  }
  children.get(target)?.kill('SIGTERM');
  children.delete(target);
  // Never recursively remove a mount path, even after a failed unmount.
}

export async function stopShareMounts() {
  await Promise.allSettled([...children.keys()].map(async target => {
    await runShareCommand('fusermount3', ['-u', target], { timeout: 3000 }).catch(() => {});
    children.get(target)?.kill('SIGTERM');
  }));
}
