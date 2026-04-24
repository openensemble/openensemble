/**
 * Coder routes: /api/coder/*
 *
 * Serves browser users their coding projects:
 *   GET    /api/coder/projects                  — list name/size/mtime/fileCount
 *   GET    /api/coder/projects/:name/download   — streams a zip archive
 *   DELETE /api/coder/projects/:name            — deletes the project
 *   GET    /api/coder/project-snapshot          — (legacy) seeds the client-side mirror
 *
 * All routes are scoped to the authenticated user's workspace
 * (`users/{userId}/documents/code/`). Ownership is enforced by
 * `resolveUserProjectDir`, which realpath-checks the project dir against the
 * workspace root — symlink tricks can't escape the user's folder.
 */

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { requireAuth, safeError } from './_helpers.mjs';

// The download endpoint shells out to `zip`. Detect it up front so fresh-install
// boxes don't silently serve 0-byte archives when the binary is missing.
const ZIP_BIN = (() => {
  try {
    const p = execSync('command -v zip', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return p || null;
  } catch { return null; }
})();
if (!ZIP_BIN) {
  console.warn('[coder] zip binary not found — code project downloads will fail. Install with: sudo apt install zip');
}
import {
  getProjectSnapshot,
  listUserProjects,
  resolveUserProjectDir,
  deleteUserProject,
} from '../skills/coder/execute.mjs';

// Segments the zip archive should skip. Matches the client-side mirror skip
// list so downloaded projects carry only source + small artifacts — no
// node_modules, virtualenvs, or build output bloating the archive.
const ARCHIVE_SKIP = [
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next',
  'dist', 'build', '.cache', '.turbo', '.parcel-cache', '.pytest_cache',
  '.run',
];

// 500MB hard cap on archive size — kills the zip process if the download
// exceeds this. Matches the node push_tar precedent so users can't blow up
// server memory or client bandwidth with a runaway download.
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

function decodeProjectName(encoded) {
  try { return decodeURIComponent(encoded); } catch { return encoded; }
}

// Zip exclude flags are relative to the source dir; `zip -r - . -x 'node_modules/*'`
// matches top-level node_modules and any nested node_modules.
function buildZipExcludes() {
  const args = [];
  for (const seg of ARCHIVE_SKIP) {
    args.push('-x', `${seg}/*`, '-x', `*/${seg}/*`);
  }
  return args;
}

export async function handle(req, res) {
  if (!req.url.startsWith('/api/coder/')) return false;

  // ── GET /api/coder/projects ── list the user's projects
  if (req.url === '/api/coder/projects' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    try {
      const info = listUserProjects(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (e) { safeError(res, e); }
    return true;
  }

  // ── GET /api/coder/project-snapshot ── legacy mirror seed
  if (req.url.startsWith('/api/coder/project-snapshot') && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    try {
      const url = new URL(req.url, 'http://x');
      const project = url.searchParams.get('project');
      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project query param required' }));
        return true;
      }
      const snap = getProjectSnapshot(userId, project);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snap));
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
    let projectDir;
    try {
      projectDir = resolveUserProjectDir(userId, name).dir;
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e?.message || 'Invalid project' }));
      return true;
    }

    if (!ZIP_BIN) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server is missing the `zip` binary. Install with: sudo apt install zip' }));
      return true;
    }

    const safeFileName = name.replace(/[^a-zA-Z0-9._-]/g, '_') + '.zip';
    // Archive to a tmp file first so we can send a real Content-Length — the
    // browser then shows actual file size and progress instead of "Unknown".
    // Streaming straight from zip stdout is simpler but gives up both. Code
    // projects are small (MAX_DOWNLOAD_BYTES=500MB cap), so the tmp file is
    // short-lived and cheap.
    const tmpPath = path.join(os.tmpdir(), `oe-coder-${crypto.randomBytes(8).toString('hex')}.zip`);
    const zipArgs = ['-r', '-q', tmpPath, '.', ...buildZipExcludes()];
    const child = spawn(ZIP_BIN, zipArgs, { cwd: projectDir });

    let clientClosed = false;
    req.on('close', () => {
      clientClosed = true;
      if (!child.killed) { try { child.kill('SIGTERM'); } catch {} }
    });

    child.stderr.on('data', buf => {
      const s = buf.toString();
      if (s.trim()) console.warn(`[coder] zip stderr: ${s.trim()}`);
    });

    child.on('error', err => {
      console.error('[coder] zip spawn error:', err);
      fs.promises.unlink(tmpPath).catch(() => {});
      if (res.headersSent) return;
      const msg = err?.code === 'ENOENT'
        ? 'Server is missing the `zip` binary. Install with: sudo apt install zip'
        : `Archive failed: ${err?.message || err}`;
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      } catch {}
    });

    child.on('close', code => {
      if (clientClosed) { fs.promises.unlink(tmpPath).catch(() => {}); return; }
      if (code !== 0) {
        fs.promises.unlink(tmpPath).catch(() => {});
        if (!res.headersSent) {
          try {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `zip exited with code ${code}` }));
          } catch {}
        }
        return;
      }

      let size;
      try { size = fs.statSync(tmpPath).size; }
      catch (e) {
        fs.promises.unlink(tmpPath).catch(() => {});
        if (!res.headersSent) {
          try {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'archive stat failed' }));
          } catch {}
        }
        return;
      }
      if (size > MAX_DOWNLOAD_BYTES) {
        fs.promises.unlink(tmpPath).catch(() => {});
        console.warn(`[coder] download size cap hit for ${userId}/${name} @ ${size} bytes`);
        if (!res.headersSent) {
          try {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `archive exceeds ${MAX_DOWNLOAD_BYTES} byte cap` }));
          } catch {}
        }
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename="${safeFileName}"`,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(tmpPath);
      stream.pipe(res);
      const cleanup = () => { fs.promises.unlink(tmpPath).catch(() => {}); };
      stream.on('close', cleanup);
      stream.on('error', err => { console.warn('[coder] stream error:', err?.message || err); cleanup(); });
    });
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
