import { requireAuth, getAgentsForUser, isPrivileged, isUserTimeBlocked } from './_helpers.mjs';
import { listProjectSpaces } from '../lib/project-spaces.mjs';
import { getNeedsAttention } from '../lib/needs-attention.mjs';

export async function handle(req, res) {
  if (req.url.split('?', 1)[0] !== '/api/needs-attention') return false;
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const userId = requireAuth(req, res, { allowMediaToken: false });
  if (!userId) return true;
  if (isUserTimeBlocked(userId)) { reply(403, { error: 'Access is currently outside your allowed hours' }); return true; }
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); reply(405, { error: 'Method not allowed' }); return true; }
  try {
    reply(200, await getNeedsAttention(userId, { agents: getAgentsForUser(userId), projects: listProjectSpaces(userId), admin: isPrivileged(userId) }));
  } catch { reply(503, { error: 'Could not check work that needs attention. Try again.' }); }
  return true;
}
