/**
 * Guide routes:
 *   GET /api/guide              — table of contents (sections + pages)
 *   GET /api/guide/page/:slug   — markdown body of a page
 *
 * Pages live in `guide/` at the install root. The TOC is the source of truth
 * for which slugs are reachable, so a slug not listed in `guide/index.json`
 * is rejected even if a matching `.md` file exists on disk.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { requireAuth, BASE_DIR } from './_helpers.mjs';

const GUIDE_DIR = path.join(BASE_DIR, 'guide');
const INDEX_PATH = path.join(GUIDE_DIR, 'index.json');

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch { return { sections: [] }; }
}

// Short content hash of whats-new.md so the client can show a "there's
// something new" dot on the Guide button until the user opens it. SHA-1
// truncated to 12 hex chars — collision risk is irrelevant here, we just
// need any-change detection.
function whatsNewVersion() {
  try {
    const body = fs.readFileSync(path.join(GUIDE_DIR, 'whats-new.md'), 'utf8');
    return crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
  } catch { return null; }
}

function listSlugs(idx) {
  const out = new Set();
  for (const s of idx.sections ?? []) {
    for (const p of s.pages ?? []) {
      if (typeof p.slug === 'string') out.add(p.slug);
    }
  }
  return out;
}

function findPageMeta(idx, slug) {
  for (const s of idx.sections ?? []) {
    for (const p of s.pages ?? []) {
      if (p.slug === slug) return { ...p, section: s.title };
    }
  }
  return null;
}

export async function handle(req, res) {
  if (req.method !== 'GET' || !req.url.startsWith('/api/guide')) return false;

  const userId = requireAuth(req, res); if (!userId) return true;

  if (req.url === '/api/guide' || req.url === '/api/guide/') {
    const idx = loadIndex();
    idx.whatsNewVersion = whatsNewVersion();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(idx));
    return true;
  }

  const m = req.url.match(/^\/api\/guide\/page\/([a-z0-9-]+)\/?$/);
  if (m) {
    const slug = m[1];
    const idx = loadIndex();
    if (!listSlugs(idx).has(slug)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown guide page' }));
      return true;
    }
    const filePath = path.join(GUIDE_DIR, slug + '.md');
    let body;
    try { body = fs.readFileSync(filePath, 'utf8'); }
    catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Guide page missing on disk' }));
      return true;
    }
    const meta = findPageMeta(idx, slug) ?? { slug };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ slug: meta.slug, title: meta.title, section: meta.section, body }));
    return true;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
  return true;
}
