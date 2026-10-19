import fs from 'node:fs/promises';
import path from 'node:path';
import { BASE_DIR } from './paths.mjs';
import { requirePrivilegedTool } from './oe-admin-paths.mjs';
import { makeNodeExecFn } from './node-exec-wrapper.mjs';
import { requestCredential, resolveCredentialValue, dropRamCredential } from './credentials.mjs';
import { writeRestartContinuationCheckpoint, clearRestartContinuationCheckpoint } from './restart-continuation.mjs';
import { networkShareSetupStatus, shareSetupIdentity } from './network-share-setup.mjs';
import { appendNodeExec } from './node-exec-paths.mjs';

const fail = message => Object.assign(new Error(message), { code: 'HOST_REQUIRED' });
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;

export async function setupShareContainerHost(userId, args, agentId) {
  requirePrivilegedTool(userId);
  if (!['docker_compose', 'proxmox'].includes(args.host_kind) || typeof args.host_node_id !== 'string'
      || typeof args.container_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(args.container_id)
      || (args.restart_container !== undefined && typeof args.restart_container !== 'boolean')) {
    throw fail('Choose a paired host node, Docker Compose or Proxmox, and the exact OE container ID.');
  }
  const status = await networkShareSetupStatus({ refresh: true });
  if (status.ready) return status;
  if (!status.container) throw fail('This OE server is not a container. Use local network-share setup.');
  if ((args.host_kind === 'docker_compose' && status.container !== 'docker')
      || (args.host_kind === 'proxmox' && !['lxc', 'lxc-libvirt'].includes(status.container))) {
    throw fail('The selected host runtime does not match this OE container.');
  }
  const { getNodes } = await import('../skills/nodes/node-registry.mjs');
  // Exact IDs only; hostname fallbacks can select the wrong machine.
  const node = getNodes(userId).find(item => item.nodeId === args.host_node_id);
  if (!node || node.accessLevel !== 'full' || node.platform !== 'linux' || node.disconnectedAt) {
    throw fail('Pair the Linux container host with this account and grant its node full access before setup.');
  }
  const [source, profile, identity] = await Promise.all([
    fs.readFile(path.join(BASE_DIR, 'scripts/setup-share-host.py'), 'utf8'),
    fs.readFile(path.join(BASE_DIR, 'scripts/openensemble-shares.apparmor'), 'utf8'),
    shareSetupIdentity(),
  ]);
  const payload = { host_kind: args.host_kind, container_id: args.container_id,
    restart_container: args.restart_container === true, ...identity, apparmor_profile: profile };
  let checkpoint;
  if (payload.restart_container) {
    const prompt = await requestCredential({ userId, agentId, kind: 'confirm', label: 'Type RESTART to apply network-share setup',
      description: `Restart only OE container ${args.container_id} on ${node.hostname}. OE will be briefly unavailable; its conversation is saved before the host schedules the restart.`, ttlMs: 120000 });
    let phrase;
    try { phrase = resolveCredentialValue(userId, prompt.id); }
    finally { dropRamCredential(prompt.id); }
    if (String(phrase || '').trim().toUpperCase() !== 'RESTART') throw fail('Container restart cancelled. Host configuration can still be prepared without a restart.');
    checkpoint = writeRestartContinuationCheckpoint({ userId, agentId, reason: 'Apply FUSE support to the OE container',
      op: 'restart_server', continuation: {
        summary: 'The authorized host is applying FUSE setup to this OE container.',
        completed: ['Recorded the authorized container-host setup request.'],
        remaining: ['Call network_share_setup_status. If clients or helpers are missing, run local setup_network_shares.',
          'Verify ready=true, then retry the user’s requested share operation and report its actual result.'],
        successCriteria: ['FUSE mount test passes and the requested network-share operation succeeds.'],
      } });
  }
  const command = `python3 -c ${quote(`import base64; exec(compile(base64.b64decode('${Buffer.from(source).toString('base64')}'), 'oe-share-host-setup', 'exec'))`)} ${quote(JSON.stringify(payload))}`;
  try {
    // Audit target/action without persisting embedded host configuration or secrets.
    await appendNodeExec(userId, { nodeId: node.nodeId, command: `OE network-share setup: ${args.host_kind} container=${args.container_id} restart=${payload.restart_container}` });
    const output = await makeNodeExecFn(userId, node.nodeId)(command, { timeout: 180 });
    let result;
    try { result = JSON.parse(output.stdout); } catch {
      throw fail(checkpoint ? 'The host response was lost. Its restart may already be scheduled; the conversation checkpoint was retained. Check this host task before retrying.'
        : 'The paired host could not run network-share setup. Check its Python 3 installation and node connection.');
    }
    if (output.exitCode !== 0 || result.error) {
      if (checkpoint) { clearRestartContinuationCheckpoint({ expectedId: checkpoint.id }); checkpoint = undefined; }
      throw fail(result.error || 'Host setup failed; the container has not been verified.');
    }
    if (!result.restart_job && checkpoint) { clearRestartContinuationCheckpoint({ expectedId: checkpoint.id }); checkpoint = undefined; }
    return { ...result, host_node_id: node.nodeId, container_id: args.container_id,
      next_tool: 'network_share_setup_status', ...(result.restart_job ? { message: 'The host scheduled this OE container’s restart. After OE returns, verify FUSE and retry the share connection.' } : {}) };
  } catch (e) {
    // A lost host response may follow a successfully scheduled restart. Keep
    // its durable continuation until OE reconnects and verifies the outcome.
    throw e;
  }
}
