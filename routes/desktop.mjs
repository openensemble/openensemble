/**
 * Desktop routes: /api/desktop/*
 * Image listing/serving and tutoring subject aggregation for the Desktop view.
 */

import fs from 'fs';
import path from 'path';
import { requireAuth, safeId as safeIdFn, BASE_DIR, getUserDir, readBody, withLock } from './_helpers.mjs';
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTS  = new Set(['.mp4', '.webm', '.mov']);
const AUDIO_EXTS  = new Set(['.wav', '.mp3', '.flac', '.ogg', '.oga', '.m4a', '.aac', '.opus']);

/**
 * Parse an HTTP Range header into a single satisfiable { start, end }, or null
 * if malformed/unsatisfiable (caller should respond 416). Guards against the
 * NaN headers / broken streams that `bytes=abc`, `bytes=999999-1`, or oversized
 * starts would otherwise produce.
 */
function parseByteRange(rangeHeader, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m) return null;
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  let start, end;
  if (s === '') {                              // suffix range: last N bytes
    const n = parseInt(e, 10);
    if (!Number.isInteger(n) || n <= 0) return null;
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = parseInt(s, 10);
    end = e === '' ? total - 1 : parseInt(e, 10);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (end >= total) end = total - 1;         // clamp to EOF
  }
  if (start < 0 || end < start || start >= total) return null;   // unsatisfiable
  return { start, end };
}

const SHARING_PATH = path.join(BASE_DIR, 'sharing.json');
function loadSharing() {
  try { return JSON.parse(fs.readFileSync(SHARING_PATH, 'utf8')); } catch { return []; }
}

/** Check sharing.json for a file shared with userId, return the owner's file path or null */
function resolveSharedFile(userId, filename, fileType) {
  // Defense-in-depth: strip any path separators so a malicious share record
  // can't escape the owner's directory via path.join below.
  const safeFilename = path.basename(filename ?? '');
  if (!safeFilename || safeFilename === '.' || safeFilename === '..') return null;
  const shares = loadSharing();
  for (const s of shares) {
    if (!s.sharedWith.includes(userId)) continue;
    // Match by filename (also basenamed — ignore any stored traversal)
    if (path.basename(s.filename ?? '') !== safeFilename) continue;
    // Search all possible directories for the file
    const searchDirs = fileType === 'image' ? ['images', 'documents']
                     : fileType === 'video' ? ['videos', 'documents']
                     : fileType === 'audio' ? ['audio', 'documents']
                     : fileType === 'research' ? ['research']
                     : ['documents', 'images', 'videos', 'audio'];
    for (const dir of searchDirs) {
      // Try the actual filename
      let candidate = path.join(getUserDir(s.ownerId), dir, safeFilename);
      if (fs.existsSync(candidate)) return candidate;
      // For documents, files are stored as {docId}{ext} — check the filePath field or scan the index
      if (dir === 'documents' && s.filePath) {
        candidate = path.join(getUserDir(s.ownerId), s.filePath);
        if (fs.existsSync(candidate)) return candidate;
      }
      if (dir === 'documents' && s.fileId) {
        // Look up in docs-index.json
        const indexPath = path.join(getUserDir(s.ownerId), 'documents', 'docs-index.json');
        try {
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
          const doc = index.find(d => d.id === s.fileId || d.filename === safeFilename);
          if (doc) {
            candidate = path.join(getUserDir(s.ownerId), 'documents', doc.id + doc.ext);
            if (fs.existsSync(candidate)) return candidate;
          }
        } catch {}
      }
    }
  }
  return null;
}

/** Discover all agent IDs that have params tables in this user's cortex dir */
function discoverAgentParamTables(userId) {
  const cortexDir = path.join(getUserDir(userId), 'cortex');
  try {
    return fs.readdirSync(cortexDir)
      .filter(f => f.endsWith('_params.lance'))
      .map(f => f.replace('_params.lance', ''));
  } catch { return ['main']; }
}
const MIME_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };

export async function handle(req, res) {

  // ── GET /api/desktop/images ── list all generated images across user's agents
  if (req.url === '/api/desktop/images' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const images = [];

    // User-scoped images dir (no agent required)
    const userImgDir = path.join(getUserDir(userId), 'images');
    try {
      for (const f of fs.readdirSync(userImgDir)) {
        const ext = path.extname(f).toLowerCase();
        if (!IMAGE_EXTS.has(ext)) continue;
        try {
          const stat = fs.statSync(path.join(userImgDir, f));
          images.push({ filename: f, agentId: null, agentName: null, agentEmoji: null, createdAt: stat.mtime.toISOString(), size: stat.size });
        } catch {}
      }
    } catch {}

    // Include images shared with this user from other users
    const seenFiles = new Set(images.map(i => i.filename));
    const shares = loadSharing();
    for (const s of shares) {
      if (!s.sharedWith.includes(userId)) continue;
      if (seenFiles.has(s.filename)) continue;
      // Check if this shared file is an image (by fileType or by mime-type heuristic)
      const ext = path.extname(s.filename).toLowerCase();
      const isImage = s.fileType === 'image' || IMAGE_EXTS.has(ext);
      if (!isImage) continue;
      // Find the file — could be in images/ or documents/
      const filePath = resolveSharedFile(userId, s.filename, 'image');
      if (!filePath) continue;
      try {
        const stat = fs.statSync(filePath);
        images.push({ filename: s.filename, agentId: null, agentName: null, agentEmoji: null, createdAt: stat.mtime.toISOString(), size: stat.size, sharedBy: s.ownerId });
        seenFiles.add(s.filename);
      } catch {}
    }

    images.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(images));
    return true;
  }

  // ── GET /api/desktop/images/:filename?agent=xxx&token=xxx ── serve an image file
  // <img> tags cannot set an Authorization header, so ?token= is accepted —
  // but requireAuth now treats URL tokens as *media tokens* only (see
  // _helpers.mjs::createMediaToken), so a leaked URL can't impersonate the
  // session. The frontend mints one via POST /api/media-token.
  const imgMatch = req.url.match(/^\/api\/desktop\/images\/([^?]+)/);
  if (imgMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const filename = decodeURIComponent(imgMatch[1]);
    const safeName = path.basename(filename);

    // Resolve file path: check user-scoped dir first, then shared files
    let filePath = null;
    const userImgPath = path.join(getUserDir(userId), 'images', safeName);
    if (fs.existsSync(userImgPath)) filePath = userImgPath;
    if (!filePath) filePath = resolveSharedFile(userId, safeName, 'image');
    if (!filePath) { res.writeHead(404); res.end('Not found'); return true; }

    const ext = path.extname(safeName).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  // ── DELETE /api/desktop/images/:filename?agent=xxx ── delete an image file
  const imgDelMatch = req.url.match(/^\/api\/desktop\/images\/([^?]+)/);
  if (imgDelMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const safeName = path.basename(decodeURIComponent(imgDelMatch[1]));
    const ext = path.extname(safeName).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) { res.writeHead(400); res.end('Invalid file type'); return true; }

    const userImgPath = path.join(getUserDir(userId), 'images', safeName);
    const filePath = fs.existsSync(userImgPath) ? userImgPath : null;
    if (!filePath) { res.writeHead(404); res.end('Not found'); return true; }
    fs.unlinkSync(filePath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── GET /api/desktop/videos ── list all generated videos
  if (req.url === '/api/desktop/videos' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const videos = [];
    const dir = path.join(getUserDir(userId), 'videos');
    try {
      for (const f of fs.readdirSync(dir)) {
        const ext = path.extname(f).toLowerCase();
        if (!VIDEO_EXTS.has(ext)) continue;
        try {
          const stat = fs.statSync(path.join(dir, f));
          videos.push({ filename: f, dir, createdAt: stat.mtime.toISOString(), size: stat.size });
        } catch {}
      }
    } catch {}
    // Include videos shared with this user from other users
    const seenVids = new Set(videos.map(v => v.filename));
    const vidShares = loadSharing();
    for (const s of vidShares) {
      if (!s.sharedWith.includes(userId)) continue;
      if (seenVids.has(s.filename)) continue;
      const ext = path.extname(s.filename).toLowerCase();
      const isVid = s.fileType === 'video' || VIDEO_EXTS.has(ext);
      if (!isVid) continue;
      const filePath = resolveSharedFile(userId, s.filename, 'video');
      if (!filePath) continue;
      try {
        const stat = fs.statSync(filePath);
        videos.push({ filename: s.filename, dir: path.dirname(filePath), createdAt: stat.mtime.toISOString(), size: stat.size, sharedBy: s.ownerId });
        seenVids.add(s.filename);
      } catch {}
    }

    videos.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(videos));
    return true;
  }

  // ── GET /api/desktop/audio ── list audio files in users/<id>/audio/
  // Same shape as /api/desktop/videos. Audio is the newest media kind —
  // chat-upload of audio/* mime types lands here, as do future
  // chat-side voice memos, TTS exports, etc.
  if (req.url === '/api/desktop/audio' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const audio = [];
    const dir = path.join(getUserDir(userId), 'audio');
    try {
      for (const f of fs.readdirSync(dir)) {
        const ext = path.extname(f).toLowerCase();
        if (!AUDIO_EXTS.has(ext)) continue;
        try {
          const stat = fs.statSync(path.join(dir, f));
          audio.push({ filename: f, dir, createdAt: stat.mtime.toISOString(), size: stat.size });
        } catch {}
      }
    } catch {}
    audio.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(audio));
    return true;
  }

  // ── GET /api/desktop/audio/:filename?token=xxx ── serve an audio file with range support
  const audMatch = req.url.match(/^\/api\/desktop\/audio\/([^?]+)/);
  if (audMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const safeName = path.basename(decodeURIComponent(audMatch[1]));
    const userAudPath = path.join(getUserDir(userId), 'audio', safeName);
    if (!fs.existsSync(userAudPath)) { res.writeHead(404); res.end('Not found'); return true; }
    const ext = path.extname(safeName).toLowerCase();
    const mime = ext === '.mp3' ? 'audio/mpeg'
               : ext === '.wav' ? 'audio/wav'
               : ext === '.flac' ? 'audio/flac'
               : ext === '.ogg' || ext === '.oga' ? 'audio/ogg'
               : ext === '.m4a' || ext === '.aac' ? 'audio/mp4'
               : ext === '.opus' ? 'audio/opus'
               : 'application/octet-stream';
    const stat = fs.statSync(userAudPath);
    const total = stat.size;
    const rangeHeader = req.headers['range'];
    if (rangeHeader) {
      const range = parseByteRange(rangeHeader, total);
      if (!range) {
        res.writeHead(416, { 'Content-Type': mime, 'Content-Range': `bytes */${total}` });
        res.end();
        return true;
      }
      const { start, end } = range;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
      });
      fs.createReadStream(userAudPath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(userAudPath).pipe(res);
    }
    return true;
  }

  // ── DELETE /api/desktop/audio/:filename ── delete an audio file
  if (audMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const safeName = path.basename(decodeURIComponent(audMatch[1]));
    const filePath = path.join(getUserDir(userId), 'audio', safeName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    }
    try { fs.unlinkSync(filePath); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }
    catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }
    return true;
  }

  // ── GET /api/desktop/videos/:filename?token=xxx ── serve a video file with range support
  // See /api/desktop/images above for notes on the short-lived media token.
  const vidMatch = req.url.match(/^\/api\/desktop\/videos\/([^?]+)/);
  if (vidMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;

    const safeName = path.basename(decodeURIComponent(vidMatch[1]));
    const userVidPath = path.join(getUserDir(userId), 'videos', safeName);
    let filePath = fs.existsSync(userVidPath) ? userVidPath : null;
    if (!filePath) filePath = resolveSharedFile(userId, safeName, 'video');
    if (!filePath) { res.writeHead(404); res.end('Not found'); return true; }

    const ext = path.extname(safeName).toLowerCase();
    const mime = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
    const stat = fs.statSync(filePath);
    const total = stat.size;
    const rangeHeader = req.headers['range'];

    if (rangeHeader) {
      const range = parseByteRange(rangeHeader, total);
      if (!range) {
        res.writeHead(416, { 'Content-Type': mime, 'Content-Range': `bytes */${total}` });
        res.end();
        return true;
      }
      const { start, end } = range;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filePath).pipe(res);
    }
    return true;
  }

  // ── DELETE /api/desktop/videos/:filename ── delete a video file
  const vidDelMatch = req.url.match(/^\/api\/desktop\/videos\/([^?]+)/);
  if (vidDelMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const safeName = path.basename(decodeURIComponent(vidDelMatch[1]));
    const ext = path.extname(safeName).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) { res.writeHead(400); res.end('Invalid file type'); return true; }
    const userVidPath = path.join(getUserDir(userId), 'videos', safeName);
    const filePath = fs.existsSync(userVidPath) ? userVidPath : null;
    if (!filePath) { res.writeHead(404); res.end('Not found'); return true; }
    fs.unlinkSync(filePath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // ── GET /api/desktop/tutor-subjects ── list all tutoring subjects
  if (req.url === '/api/desktop/tutor-subjects' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;

    try {
      const { recall } = await import('../memory.mjs');
      // Search across all agent param tables — tutor data may be stored under
      // scoped agent IDs (e.g. user_XXXXXXXX_agent_YYYYYYYY) not just 'main'
      const agentIds = discoverAgentParamTables(userId);
      const allResults = [];
      for (const aid of agentIds) {
        try {
          const r = await recall({
            agentId: aid, type: 'params',
            query: '[TUTOR subject roadmap progress study',
            topK: 100, includeShared: false, userId,
          });
          allResults.push(...r);
        } catch {}
      }

      const subjects = new Map();
      for (const r of allResults) {
        const m = r.text?.match(/\[TUTOR:([^:]+):/);
        if (!m) continue;
        const subj = m[1];
        if (!subjects.has(subj)) subjects.set(subj, { subject: subj, noteCount: 0, lastActivity: r.created_at, hasRoadmap: false });
        const info = subjects.get(subj);
        info.noteCount++;
        if (r.text.includes(':roadmap]')) info.hasRoadmap = true;
        if (new Date(r.created_at) > new Date(info.lastActivity)) info.lastActivity = r.created_at;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([...subjects.values()]));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return true;
  }

  // ── GET /api/desktop/tutor-subject/:name ── get notes for a subject
  const tutorMatch = req.url.match(/^\/api\/desktop\/tutor-subject\/([^?]+)/);
  if (tutorMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const subject = decodeURIComponent(tutorMatch[1]);

    try {
      const { recall } = await import('../memory.mjs');
      const agentIds = discoverAgentParamTables(userId);
      const allResults = [];
      for (const aid of agentIds) {
        try {
          const r = await recall({
            agentId: aid, type: 'params',
            query: `[TUTOR:${subject}: study note progress quiz roadmap`,
            topK: 50, includeShared: false, userId,
          });
          allResults.push(...r);
        } catch {}
      }
      const results = allResults;

      const subjectTag = `[TUTOR:${subject}:`;
      const filtered = results.filter(r => r.text?.includes(subjectTag));

      let roadmap = null;
      const notes = [];

      for (const r of filtered) {
        const catMatch = r.text.match(/\[TUTOR:[^:]+:([^\]]+)\]/);
        const cat = catMatch?.[1] || 'general';
        const clean = r.text.replace(/^\[TUTOR:[^\]]*\]\s*/, '');

        if (cat === 'roadmap') {
          if (!roadmap || new Date(r.created_at) > new Date(roadmap.createdAt)) {
            roadmap = clean;
          }
        } else {
          notes.push({
            text: clean,
            category: cat,
            createdAt: r.created_at,
          });
        }
      }

      notes.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ subject, roadmap, notes }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ subject, roadmap: null, notes: [] }));
    }
    return true;
  }

  // ── GET /api/desktop/widgets ── load user's widget layout
  if (req.url === '/api/desktop/widgets' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const widgetPath = path.join(getUserDir(userId), 'desktop.json');
    let data = { widgets: [] };
    try { data = JSON.parse(fs.readFileSync(widgetPath, 'utf8')); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return true;
  }

  // ── PUT /api/desktop/widgets ── save user's widget layout
  if (req.url === '/api/desktop/widgets' && req.method === 'PUT') {
    const userId = requireAuth(req, res); if (!userId) return true;
    try {
      const body = JSON.parse(await readBody(req));
      const widgetPath = path.join(getUserDir(userId), 'desktop.json');
      await withLock(widgetPath + '.lock', () => {
        fs.mkdirSync(path.dirname(widgetPath), { recursive: true });
        fs.writeFileSync(widgetPath, JSON.stringify(body, null, 2));
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return true;
  }

  // ── GET /api/files/:type/:filename — generic download endpoint ─────────────
  const fileMatch = req.url.match(/^\/api\/files\/(images|videos|documents|research|invoices)\/([^?]+)/);
  if (fileMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const fileType = fileMatch[1];
    const safeName = path.basename(decodeURIComponent(fileMatch[2]));
    const filePath = path.join(getUserDir(userId), fileType, safeName);

    if (!fs.existsSync(filePath)) {
      // Shared-file fallback. A share record grants access to exactly ONE
      // file — we must match the requested name against s.filename, not just
      // check that some share exists for this user. Without this check, any
      // user Alice has shared anything with could read Alice's entire
      // images/videos/invoices directory by guessing filenames.
      const sharingPath = path.join(BASE_DIR, 'sharing.json');
      let found = false;
      try {
        const shares = JSON.parse(fs.readFileSync(sharingPath, 'utf8'));
        for (const s of shares) {
          if (!s.sharedWith.includes(userId)) continue;
          if (s.filename !== safeName) continue;
          const ownerPath = path.join(getUserDir(s.ownerId), fileType, safeName);
          if (fs.existsSync(ownerPath)) {
            const stat = fs.statSync(ownerPath);
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}"`,
              'Content-Length': stat.size,
            });
            fs.createReadStream(ownerPath).pipe(res);
            found = true;
            break;
          }
        }
      } catch {}
      if (!found) { res.writeHead(404); res.end('Not found'); }
      return true;
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(safeName)}"`,
      'Content-Length': stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  return false;
}
