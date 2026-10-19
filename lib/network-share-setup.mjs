import fs from 'node:fs/promises';
import path from 'node:path';
import { BASE_DIR } from './paths.mjs';
import { runShareCommand } from './network-share-process.mjs';
import { requirePrivilegedTool } from './oe-admin-paths.mjs';
import { log } from '../logger.mjs';
import { requestCredential, resolveCredentialValue, dropRamCredential,
  registerRedaction, unregisterRedaction } from './credentials.mjs';

export const shareSetupEnv = () => ({ PATH: `${path.join(BASE_DIR, 'bin')}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  HOME: process.env.HOME || BASE_DIR, LANG: 'C.UTF-8' });
const script = name => path.join(BASE_DIR, 'scripts', name);
const error = (code, message) => Object.assign(new Error(message), { code });
let cached, checking, repairing;

function describe(result) {
  if (result.ready) return 'Network-share support is ready. A local FUSE mount and unmount passed.';
  const reason = { device_missing: 'The FUSE device is missing.', device_denied: 'OE cannot open the FUSE device.',
    helper_missing: 'The FUSE mount helper is missing.', clients_missing: 'Network-share clients need installation or repair.',
    mount_denied: 'The host allows device access but blocked or failed a FUSE test mount.',
    unsupported_platform: 'Network-share mounting requires a Linux OE server.',
    check_failed: 'OE could not finish checking its network-share prerequisites.' }[result.issue] || 'Network-share support needs setup.';
  return `${reason} ${result.host_required
    ? 'An OE administrator can pair the container host with full access, then ask OE to set up network shares on that host.'
    : 'Ask an OE administrator to set up network-share support. OE can install prerequisites and check the repair; any sudo password goes in a protected form.'}`;
}

// Coalesce probes across accounts; never cache a failure across an explicit retry.
export async function networkShareSetupStatus({ refresh = false } = {}) {
  if (!refresh && cached && Date.now() - cached.at < 30000) return { ...cached.value };
  if (!checking) checking = (async () => {
    const [fuse, clients] = await Promise.allSettled([
      runShareCommand('python3', [script('check-share-fuse.py')], { env: shareSetupEnv(), timeout: 25000, maxBytes: 32768, killGroup: true }),
      runShareCommand('/bin/bash', [script('install-share-tools.sh'), '--check'], { env: shareSetupEnv(), timeout: 15000, maxBytes: 32768, killGroup: true }),
    ]);
    let result;
    try { result = fuse.status === 'fulfilled' ? JSON.parse(fuse.value) : null; } catch { /* Report a diagnostic failure. */ }
    if (!result || typeof result.ready !== 'boolean') result = { ready: false, issue: 'check_failed', container: null, mount_test: 'not_run' };
    result.clients = clients.status === 'fulfilled';
    if (result.ready && !result.clients) { result.ready = false; result.issue = 'clients_missing'; }
    result.host_required = Boolean(result.container && ['device_missing', 'device_denied', 'mount_denied'].includes(result.issue));
    result.next_tool = result.ready ? null : 'setup_network_shares';
    result.message = describe(result);
    cached = { at: Date.now(), value: result };
    return result;
  })().finally(() => { checking = undefined; });
  return { ...await checking };
}

async function systemSetup(userId) {
  const env = shareSetupEnv();
  try { await runShareCommand('/bin/bash', [script('setup-share-fuse.sh'), '--check'], { env }); return; }
  catch { /* Missing prerequisites require the fixed privileged installer. */ }
  const options = { env, timeout: 300000, maxBytes: 4 * 1024 * 1024, killGroup: true };
  if (process.getuid?.() === 0) { await runShareCommand('/bin/bash', [script('setup-share-fuse.sh')], options); return; }
  let password, credentialId;
  try {
    let passwordless = false;
    try { await runShareCommand('sudo', ['-n', '-v'], { env, timeout: 10000 }); passwordless = true; }
    catch (e) { if (e.code === 'ENOENT') throw error('DEPENDENCY', 'This OE service has no sudo. An administrator must install the host prerequisites or provide an authorized host node.'); }
    if (!passwordless) {
      const credential = await requestCredential({ userId, label: 'Network-share setup: sudo password',
        description: 'Install FUSE and network-share prerequisites on the OE server. Your password is used only by sudo and is not sent to the agent.',
        kind: 'sudo', ttlMs: 300000 });
      credentialId = credential.id;
      password = resolveCredentialValue(userId, credentialId);
      if (!password) throw error('CANCELLED', 'Network-share setup was cancelled.');
      registerRedaction(password);
    }
    await runShareCommand('sudo', [passwordless ? '-n' : '-S', '-p', '', '--', '/bin/bash', script('setup-share-fuse.sh')],
      { ...options, input: password ? `${password}\n` : undefined });
  } finally {
    if (credentialId) dropRamCredential(credentialId);
    if (password) unregisterRedaction(password);
  }
}

export async function setupNetworkShares(userId, args = {}, agentId) {
  requirePrivilegedTool(userId);
  // Never share a privileged result, password prompt, or host target across accounts.
  if (repairing) throw error('BUSY', 'Network-share setup is already running. Check its status when it finishes.');
  repairing = true;
  try {
    log.info('network-shares', 'Setup requested', { userId, hostNodeId: args.host_node_id || null, hostKind: args.host_kind || null });
    if (args.host_node_id || args.host_kind || args.container_id) {
      const { setupShareContainerHost } = await import('./network-share-host-setup.mjs');
      return await setupShareContainerHost(userId, args, agentId);
    }
    if (args.restart_container) throw error('INVALID', 'Choose the paired host and exact OE container before requesting its restart.');
    const before = await networkShareSetupStatus({ refresh: true });
    if (before.ready) return before;
    // A guest cannot grant itself host device or mount permissions.
    if (before.host_required) return before;
    await systemSetup(userId);
    await runShareCommand('/bin/bash', [script('install-share-tools.sh')], {
      env: shareSetupEnv(), timeout: 300000, maxBytes: 4 * 1024 * 1024, killGroup: true,
    });
    if (checking) await checking;
    const result = await networkShareSetupStatus({ refresh: true });
    log.info('network-shares', 'Setup verified', { userId, ready: result.ready, issue: result.issue });
    return result;
  } catch (e) {
    log.warn('network-shares', 'Setup did not complete', { userId, code: e.code || 'SETUP_FAILED' });
    if (['EPRIVILEGE', 'BUSY', 'INVALID', 'CANCELLED', 'DEPENDENCY', 'HOST_REQUIRED'].includes(e.code)) throw e;
    // Installer output can include host configuration. Do not return it to the model.
    throw error('DEPENDENCY', 'Network-share setup did not complete. Check the host package manager, sudo access, and device permissions, then retry.');
  } finally { repairing = false; cached = undefined; }
}

export async function shareSetupIdentity() {
  let machineId = '';
  try { machineId = (await fs.readFile('/etc/machine-id', 'utf8')).trim(); } catch { /* Docker often omits it. */ }
  const uts = await fs.stat('/proc/self/ns/uts');
  const statePaths = await Promise.all(['config', 'users', 'config.json'].map(name =>
    fs.realpath(path.join(BASE_DIR, name)).catch(() => null)));
  return { hostname: (await import('node:os')).hostname(), machine_id: machineId, uts_inode: String(uts.ino), state_paths: statePaths };
}
