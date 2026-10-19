import fs from 'node:fs/promises';
import path from 'node:path';
import { BASE_DIR } from './paths.mjs';
import { runShareCommand } from './network-share-process.mjs';

const names = new Set(['rclone', 'showmount', 'fuse-nfs']);
let installation;
const dependencyError = message => Object.assign(new Error(message), { code: 'DEPENDENCY' });

async function findCommand(name, env) {
  const candidates = [path.join(BASE_DIR, 'bin', name)];
  if (name !== 'fuse-nfs') {
    candidates.push(path.join(BASE_DIR, 'bin', 'share-tools', 'usr', name === 'showmount' ? 'sbin' : 'bin', name));
  }
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(directory, name));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    }
    catch { /* Try the next installed location. */ }
  }
}

// Only fixed client names can trigger the fixed, unprivileged installer.
// Concurrent accounts wait for the same installation; a failure can be retried.
export async function ensureShareCommand(name, env) {
  if (!names.has(name)) throw dependencyError('Unknown network-share client.');
  if (installation) await installation;
  const existing = await findCommand(name, env);
  if (existing) return existing;
  if (process.platform !== 'linux') throw dependencyError('Network-share clients require a Linux OE server.');
  if (!installation) {
    installation = runShareCommand('/bin/bash', [path.join(BASE_DIR, 'scripts', 'install-share-tools.sh')], {
      env, timeout: 300000, maxBytes: 4 * 1024 * 1024, killGroup: true,
    }).catch(error => {
      console.warn('[network-shares] Client installation failed:', error.stderr || error.message);
      throw dependencyError('Automatic network-share client installation failed. Ask an OE administrator to set up network-share support, then retry the connection.');
    }).finally(() => { installation = undefined; });
  }
  await installation;
  const installed = await findCommand(name, env);
  if (!installed) throw dependencyError('Network-share setup completed without the required client. Ask OE to repair network-share support.');
  return installed;
}
