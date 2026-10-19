import { requireAuth, readBody } from './_helpers.mjs';
import { isSkillAllowedForUser, executeRoleToolForSkill } from '../roles.mjs';
import { workspaceAccount, workspaceAction, withMailUiAction } from '../lib/mail-workspace.mjs';
import { mailAttachment } from '../lib/mail-workspace-provider.mjs';

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/mail/')) return false;
  const userId = requireAuth(req, res); if (!userId) return true;
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (!isSkillAllowedForUser('email', userId)) { json(403, { error: 'Email access is not available for this profile.' }); return true; }
  try {
    if (url.pathname === '/api/mail/action' && req.method === 'POST') {
      const args = JSON.parse(await readBody(req));
      // Mutations go through the same permission/tool boundary as the agent.
      const result = await withMailUiAction(() => executeRoleToolForSkill('email', 'email_workspace', args, userId));
      if (typeof result === 'string' && result.startsWith('Tool error:')) json(400, { error: result.replace(/^Tool error:\s*/, '') });
      else if (typeof result === 'string') {
        let parsed;
        try { parsed = JSON.parse(result); } catch { throw new Error(result); }
        json(200, parsed);
      } else json(200, result);
    } else if (url.pathname === '/api/mail/read' && req.method === 'GET') {
      const args = Object.fromEntries(url.searchParams);
      if (!['folders', 'list', 'read', 'list_drafts'].includes(args.operation)) { json(400, { error: 'Unsupported read operation.' }); return true; }
      json(200, await workspaceAction(userId, args));
    } else if (url.pathname === '/api/mail/attachment' && req.method === 'GET') {
      const args = Object.fromEntries(url.searchParams);
      const account = workspaceAccount(userId, args.account);
      const file = await mailAttachment(userId, account, args);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name || 'attachment').replace(/'/g, '%27')}`, 'Content-Length': file.data.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      res.end(file.data);
    } else json(404, { error: 'Mail endpoint not found.' });
  } catch (error) { json(error.status || 400, { error: error.message || 'Mail request failed.' }); }
  return true;
}
