import { requireAuth, readBody, isUserTimeBlocked } from './_helpers.mjs';
import { getJobCheckpoint } from '../background-tasks/checkpoints.mjs';
import { resumeJob } from '../background-tasks/resume.mjs';

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/job-recovery/')) return false;
  const userId = requireAuth(req, res);
  if (!userId) return true;
  const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    if (isUserTimeBlocked(userId)) throw Object.assign(new Error('Access is currently restricted.'), { status: 403 });
    const id = url.pathname.slice('/api/job-recovery/'.length);
    if (!/^(?:bg|wkr)_[a-zA-Z0-9_]+$/.test(id)) throw Object.assign(new Error('Job not found.'), { status: 404 });
    if (req.method === 'GET') {
      const entry = getJobCheckpoint(userId, id);
      if (!entry) throw Object.assign(new Error('Job not found.'), { status: 404 });
      const cp = entry.checkpoint;
      reply(200, {
        taskId: id, summary: entry.summary, status: cp.status, revision: cp.revision,
        reason: cp.reason, resumes: cp.resumes,
        completed: cp.actions.filter(a => a.status === 'done').length,
        uncertain: cp.actions.filter(a => a.status === 'started' && a.mutation).map(a => ({ id: a.id, name: a.name, args: a.args })),
      });
    } else if (req.method === 'POST') reply(200, await resumeJob(userId, id, JSON.parse(await readBody(req))));
    else reply(405, { error: 'Method not allowed.' });
  } catch (error) { reply(error.status || (error instanceof SyntaxError ? 400 : 500), { error: error.status || error instanceof SyntaxError ? error.message : 'Job recovery failed.' }); }
  return true;
}
