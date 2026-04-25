import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USERS_DIR = path.join(BASE_DIR, 'users');

const TEXT_CAP = 50_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const CODE_MAX_BYTES = 1 * 1024 * 1024;

const EXCLUDED_TOPLEVEL = new Set(['sessions', 'cortex', 'skills', 'users', 'profile.json']);

function userDir(uid) {
  return path.join(USERS_DIR, uid);
}

function safeJoin(root, rel) {
  const resolved = path.resolve(path.join(root, rel));
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) return null;
  return resolved;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function inferMime(ext) {
  const e = ext.toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(e)) return 'image/' + (e === '.jpg' ? 'jpeg' : e.slice(1));
  if (['.mp4', '.webm', '.mov', '.mkv'].includes(e)) return 'video/' + e.slice(1);
  if (e === '.md') return 'text/markdown';
  if (e === '.txt') return 'text/plain';
  if (e === '.pdf') return 'application/pdf';
  if (e === '.json') return 'application/json';
  if (e === '.csv') return 'text/csv';
  return 'application/octet-stream';
}

// ── documents ────────────────────────────────────────────────────────────────
function listDocuments(uid) {
  const idx = path.join(userDir(uid), 'documents', 'docs-index.json');
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch {}
  return entries.map(d => ({
    id: `documents:${d.id}`,
    folder: 'documents',
    filename: d.filename,
    mimeType: d.mimeType,
    size: d.size,
    createdAt: d.createdAt,
    description: d.description || '',
    _ext: d.ext,
    _internalId: d.id,
  }));
}

// ── research ─────────────────────────────────────────────────────────────────
function listResearch(uid) {
  const idx = path.join(userDir(uid), 'research', 'index.json');
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch {}
  return entries.map(d => {
    let size = 0;
    try { size = fs.statSync(path.join(userDir(uid), 'research', d.filename)).size; } catch {}
    return {
      id: `research:${d.id}`,
      folder: 'research',
      filename: d.title,
      mimeType: 'text/markdown',
      size,
      createdAt: d.createdAt,
      description: (d.tags ?? []).join(', '),
      _filename: d.filename,
    };
  });
}

// ── images / videos (no index — read disk) ───────────────────────────────────
function listMedia(uid, folder) {
  const dir = path.join(userDir(uid), folder);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const ext = path.extname(name);
    out.push({
      id: `${folder}:${name}`,
      folder,
      filename: name,
      mimeType: inferMime(ext),
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
      description: '',
    });
  }
  return out;
}

// ── code (workspace) ─────────────────────────────────────────────────────────
function listCode(uid) {
  const root = path.join(userDir(uid), 'documents', 'code');
  const out = [];
  function walk(dir, relBase) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
      const full = path.join(dir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, rel); continue; }
      if (!e.isFile()) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const ext = path.extname(e.name);
      out.push({
        id: `code:${rel}`,
        folder: 'code',
        filename: rel,
        mimeType: inferMime(ext),
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        description: '',
      });
      if (out.length > 500) return;
    }
  }
  walk(root, '');
  return out;
}

// ── List ─────────────────────────────────────────────────────────────────────
async function execList(args, userId) {
  const folder = args.folder || 'all';
  const query = (args.query || '').toLowerCase().trim();

  let items = [];
  if (folder === 'all' || folder === 'documents') items.push(...listDocuments(userId));
  if (folder === 'all' || folder === 'research')  items.push(...listResearch(userId));
  if (folder === 'all' || folder === 'images')    items.push(...listMedia(userId, 'images'));
  if (folder === 'all' || folder === 'videos')    items.push(...listMedia(userId, 'videos'));
  if (folder === 'all' || folder === 'code')      items.push(...listCode(userId));

  if (query) {
    items = items.filter(i =>
      i.filename.toLowerCase().includes(query) ||
      (i.description ?? '').toLowerCase().includes(query)
    );
  }

  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (!items.length) {
    return folder === 'all'
      ? 'No files found in your profile folders.'
      : `No files found in ${folder}.`;
  }

  const grouped = {};
  for (const i of items) (grouped[i.folder] ||= []).push(i);

  const sections = [];
  for (const f of ['documents', 'research', 'images', 'videos', 'code']) {
    const list = grouped[f];
    if (!list?.length) continue;
    const lines = list.map(i => {
      const when = new Date(i.createdAt).toLocaleString();
      const desc = i.description ? ` — ${i.description}` : '';
      return `- [${i.id}] ${i.filename} (${i.mimeType}, ${fmtSize(i.size)}) — ${when}${desc}`;
    });
    sections.push(`### ${f} (${list.length})\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

// ── Read ─────────────────────────────────────────────────────────────────────
async function readDocument(internalId, userId) {
  const idx = path.join(userDir(userId), 'documents', 'docs-index.json');
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch {}
  const doc = entries.find(d => d.id === internalId);
  if (!doc) return `Document "${internalId}" not found.`;
  const filePath = path.join(userDir(userId), 'documents', doc.id + doc.ext);
  if (!fs.existsSync(filePath)) return `File "${doc.filename}" is missing from storage.`;

  const data = fs.readFileSync(filePath);
  const ext = doc.ext.toLowerCase();

  if (doc.mimeType.startsWith('image/')) {
    if (data.length > IMAGE_MAX_BYTES) return `Image "${doc.filename}" is too large to inline (${fmtSize(data.length)}).`;
    return JSON.stringify({ isImage: true, base64: data.toString('base64'), mimeType: doc.mimeType, name: doc.filename });
  }
  if (doc.mimeType.startsWith('video/')) {
    return `"${doc.filename}" is a video (${doc.mimeType}, ${fmtSize(doc.size)}). Videos cannot be read as text.`;
  }

  if (['.txt', '.md', '.csv'].includes(ext) || doc.mimeType.startsWith('text/')) {
    return `[Document: ${doc.filename}]\n\n${data.toString('utf8').slice(0, TEXT_CAP)}`;
  }

  if (ext === '.pdf') {
    try {
      const { spawn } = await import('child_process');
      const text = await new Promise((resolve, reject) => {
        const proc = spawn('pdftotext', ['-', '-'], { timeout: 15000 });
        const chunks = [];
        proc.stdout.on('data', c => chunks.push(c));
        proc.on('error', reject);
        proc.on('close', code => code !== 0 ? reject(new Error(`pdftotext exited ${code}`)) : resolve(Buffer.concat(chunks).toString()));
        proc.stdin.end(data);
      });
      return `[Document: ${doc.filename}]\n\n${text.slice(0, TEXT_CAP)}`;
    } catch {
      return `Could not extract text from "${doc.filename}". The PDF may be scanned/image-based.`;
    }
  }

  return `"${doc.filename}" is a ${doc.mimeType} file — text extraction is not supported for this format.`;
}

function readResearch(internalId, userId) {
  const idx = path.join(userDir(userId), 'research', 'index.json');
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(idx, 'utf8')); } catch {}
  const doc = entries.find(d => d.id === internalId);
  if (!doc) return `Research document "${internalId}" not found.`;
  const filePath = path.join(userDir(userId), 'research', doc.filename);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return `# ${doc.title}\n_Saved: ${doc.createdAt}_\n\n${content.slice(0, TEXT_CAP)}`;
  } catch {
    return `Error: Research file not found for "${doc.title}".`;
  }
}

function readMedia(folder, name, userId) {
  const root = path.join(userDir(userId), folder);
  const full = safeJoin(root, name);
  if (!full || !fs.existsSync(full)) return `${folder} file "${name}" not found.`;
  const stat = fs.statSync(full);
  const ext = path.extname(name);
  const mime = inferMime(ext);
  if (folder === 'images') {
    if (stat.size > IMAGE_MAX_BYTES) return `Image "${name}" is too large to inline (${fmtSize(stat.size)}).`;
    const data = fs.readFileSync(full);
    return JSON.stringify({ isImage: true, base64: data.toString('base64'), mimeType: mime, name });
  }
  return `"${name}" is a video (${mime}, ${fmtSize(stat.size)}, modified ${stat.mtime.toISOString()}). Videos cannot be read as text.`;
}

function readCode(rel, userId) {
  const root = path.join(userDir(userId), 'documents', 'code');
  const full = safeJoin(root, rel);
  if (!full || !fs.existsSync(full)) return `Code file "${rel}" not found.`;
  const stat = fs.statSync(full);
  if (!stat.isFile()) return `"${rel}" is not a file.`;
  if (stat.size > CODE_MAX_BYTES) return `Code file "${rel}" is too large to read (${fmtSize(stat.size)}).`;
  const data = fs.readFileSync(full);
  // Reject if obviously binary
  for (let i = 0; i < Math.min(data.length, 8000); i++) {
    if (data[i] === 0) return `"${rel}" looks like a binary file — not readable as text.`;
  }
  return `[File: ${rel}]\n\n${data.toString('utf8').slice(0, TEXT_CAP)}`;
}

async function execRead(args, userId) {
  const id = args.file_id;
  if (!id || typeof id !== 'string') return 'file_id is required.';
  const colon = id.indexOf(':');
  if (colon === -1) return `Invalid file_id "${id}". Expected "folder:identifier".`;
  const folder = id.slice(0, colon);
  const rest = id.slice(colon + 1);

  switch (folder) {
    case 'documents': return readDocument(rest, userId);
    case 'research':  return readResearch(rest, userId);
    case 'images':    return readMedia('images', rest, userId);
    case 'videos':    return readMedia('videos', rest, userId);
    case 'code':      return readCode(rest, userId);
    default: return `Unknown folder "${folder}". Expected one of: documents, research, images, videos, code.`;
  }
}

export default async function execute(name, args, userId) {
  if (name === 'list_profile_files') return execList(args, userId);
  if (name === 'read_profile_file')  return execRead(args, userId);
  return null;
}
