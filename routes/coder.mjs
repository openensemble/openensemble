/**
 * Coder routes: /api/coder/*
 *
 * Serves browser users their coding projects:
 *   GET    /api/coder/projects                  — list name/size/mtime/fileCount
 *   GET    /api/coder/projects/:name/download   — streams a zip archive
 *   DELETE /api/coder/projects/:name            — deletes the project
 *
 * All routes are scoped to the authenticated user's workspace
 * (`users/{userId}/documents/code/`). Ownership is enforced by
 * `resolveUserProjectDir`, which realpath-checks the project dir against the
 * workspace root — symlink tricks can't escape the user's folder.
 */

import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { requireAuth, safeError } from './_helpers.mjs';
import { createProjectArchive } from '../lib/project-archive.mjs';
export { ARCHIVE_SKIP } from '../lib/project-archive.mjs';
import {
  listUserProjects,
  resolveUserProjectDir,
  deleteUserProject,
} from '../skills/coder/execute.mjs';

function decodeProjectName(encoded) {
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

export async function handle(req, res) {
  if (!req.url.startsWith('/api/coder/')) return false;

  // ── GET /api/coder/projects ── list the user's projects
  if (req.url === '/api/coder/projects' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    try {
      const info = await listUserProjects(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // Remaining routes operate on a specific project — parse the name once.
  const projMatch = req.url.match(/^\/api\/coder\/projects\/([^/?#]+)(\/download)?(?:\?.*)?$/);
  if (!projMatch) return false;
  const name = decodeProjectName(projMatch[1]);
  const isDownload = !!projMatch[2];

  // ── GET /api/coder/projects/:name/download ── stream a zip to the browser
  if (isDownload && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    let bundle;
    try {
      const project = resolveUserProjectDir(userId, name);
      bundle = await createProjectArchive(project.dir, { identity: project.identity, signal: controller.signal });
      const size = (await fs.promises.stat(bundle.file)).size;
      const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_') + '.zip';
      res.writeHead(200, {
        'Content-Type': 'application/zip', 'Content-Length': size,
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      });
      await pipeline(fs.createReadStream(bundle.file), res, { signal: controller.signal });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(error.code === 'ENOENT' ? 503 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.code === 'ENOENT' ? 'Project downloads require Python 3 on the server.' : error.message }));
      } else if (!res.writableEnded) res.destroy();
    } finally {
      res.off('close', cancel);
      await bundle?.cleanup();
    }
    return true;
  }

  // ── DELETE /api/coder/projects/:name ── delete a project
  if (!isDownload && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    try {
      // resolveUserProjectDir re-validates the name and confirms ownership
      // before we hand off to the coder's deleteProject().
      resolveUserProjectDir(userId, name);
      await deleteUserProject(userId, name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      const msg = e?.message || 'Delete failed';
      const status = /not found/i.test(msg) ? 404 : 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
    return true;
  }

  return false;
}
