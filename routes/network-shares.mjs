import { requireAuth, readBody, getUserRole } from './_helpers.mjs';
import { isSkillRuntimeEnabledForUser } from '../roles.mjs';
import { networkShares } from '../lib/network-shares.mjs';
import { networkShareSetupStatus } from '../lib/network-share-setup.mjs';

export async function handle(req, res) {
  const url = req.url.split('?')[0];
  if (!/^\/api\/network-shares(?:\/|$)/.test(url)) return false;
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const userId = requireAuth(req, res);
  if (!userId) return true;
  if (getUserRole(userId) === 'child' || !isSkillRuntimeEnabledForUser('network_shares', userId)) {
    send(403, { error: 'Network shares are unavailable for this account.' });
    return true;
  }
  try {
    if (url === '/api/network-shares' && req.method === 'GET') send(200, { shares: await networkShares.list(userId) });
    else if (url === '/api/network-shares/setup' && req.method === 'GET') send(200, await networkShareSetupStatus());
    else if (req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { send(400, { error: 'Invalid request body.' }); return true; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { send(400, { error: 'Invalid request body.' }); return true; }
      // The API never accepts a caller-selected account or prompt mode.
      const options = { ...body, prompt: false };
      const operations = { '/api/network-shares/connect': 'connect', '/api/network-shares/discover': 'discover',
        '/api/network-shares/disconnect': 'disconnect', '/api/network-shares/list': 'browse',
        '/api/network-shares/read': 'browse', '/api/network-shares/copy-to': 'copyTo', '/api/network-shares/copy-from': 'copyFrom' };
      const operation = operations[url];
      if (!operation) send(404, { error: 'Unknown share operation.' });
      else send(200, await networkShares[operation](userId, { ...options, read: url.endsWith('/read') }));
    } else send(405, { error: 'Method not allowed.' });
  } catch (e) {
    const code = e.code || 'SHARE_ERROR';
    const message = e.code ? e.message : 'The share operation failed.';
    const setup = code === 'DEPENDENCY' ? await networkShareSetupStatus().catch(() => undefined) : undefined;
    send(code === 'NOT_FOUND' ? 404 : code === 'INVALID' ? 400 : 409, { error: message, code, setup });
  }
  return true;
}
