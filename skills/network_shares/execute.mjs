import { networkShares } from '../../lib/network-shares.mjs';
import { getUserRole } from '../../routes/_helpers.mjs';

const operations = { list_network_shares: 'list', discover_network_shares: 'discover', connect_network_share: 'connect',
  disconnect_network_share: 'disconnect', list_network_share_files: 'browse', read_network_share_file: 'browse',
  copy_to_network_share: 'copyTo', copy_from_network_share: 'copyFrom', delete_network_share_files: 'deleteFiles' };

export default async function execute(name, args, userId) {
  const operation = operations[name];
  if (!operation) return null;
  if (!userId || getUserRole(userId) === 'child') return 'Error: Network shares are unavailable for this account.';
  try {
    // Credentials can only come from the protected inline form or encrypted
    // store, never from model-authored tool arguments.
    const { credentials: _credentials, password: _password, ...options } = args || {};
    return JSON.stringify(await networkShares[operation](userId, { ...options, prompt: true, read: name === 'read_network_share_file' }));
  } catch (e) {
    return JSON.stringify({ error: e.code ? e.message : 'The share operation failed.', code: e.code || 'SHARE_ERROR' });
  }
}
