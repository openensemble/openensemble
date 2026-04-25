import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_DIR     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY_DIR   = path.join(BASE_DIR, 'shared-docs');
const LEGACY_INDEX = path.join(LEGACY_DIR, 'index.json');
const USERS_DIR    = path.join(BASE_DIR, 'users');
const SHARING_PATH = path.join(BASE_DIR, 'sharing.json');

function userDocsDir(uid)   { return path.join(USERS_DIR, uid, 'documents'); }
function userIndexPath(uid) { return path.join(userDocsDir(uid), 'docs-index.json'); }

function loadUserIndex(uid) {
  try { return JSON.parse(fs.readFileSync(userIndexPath(uid), 'utf8')); } catch { return []; }
}

function loadSharing() {
  try { return JSON.parse(fs.readFileSync(SHARING_PATH, 'utf8')); } catch { return []; }
}

function loadLegacyIndex() {
  try { return JSON.parse(fs.readFileSync(LEGACY_INDEX, 'utf8')); } catch { return []; }
}

function loadUsers() {
  try {
    return fs.readdirSync(USERS_DIR, { withFileTypes: true })
      .map(d => {
        if (d.isFile() && d.name.endsWith('.json')) {
          try { return JSON.parse(fs.readFileSync(path.join(USERS_DIR, d.name), 'utf8')); } catch { return null; }
        }
        if (d.isDirectory()) {
          try { return JSON.parse(fs.readFileSync(path.join(USERS_DIR, d.name, 'profile.json'), 'utf8')); } catch { return null; }
        }
        return null;
      })
      .filter(Boolean);
  } catch { return []; }
}

function getVisibleDocs(userId) {
  const own = loadUserIndex(userId);
  const seen = new Set(own.map(d => d.id));
  const out  = [...own];

  const shares = loadSharing();
  for (const s of shares) {
    if (s.ownerId === userId) continue;
    if (!s.sharedWith?.includes(userId)) continue;
    const ownerDocs = loadUserIndex(s.ownerId);
    const doc = ownerDocs.find(d => d.id === s.fileId);
    if (doc && !seen.has(doc.id)) { out.push(doc); seen.add(doc.id); }
  }

  for (const d of loadLegacyIndex()) {
    if (seen.has(d.id)) continue;
    if (d.uploadedBy === userId || d.sharedWith?.includes('*') || d.sharedWith?.includes(userId)) {
      out.push(d); seen.add(d.id);
    }
  }
  return out;
}

function findDoc(docId, userId) {
  const own = loadUserIndex(userId);
  const mine = own.find(d => d.id === docId);
  if (mine) return mine;

  const shares = loadSharing();
  const share = shares.find(s => s.fileId === docId && s.sharedWith?.includes(userId));
  if (share) {
    const ownerDocs = loadUserIndex(share.ownerId);
    const doc = ownerDocs.find(d => d.id === docId);
    if (doc) return doc;
  }

  const legacy = loadLegacyIndex().find(d => d.id === docId);
  if (legacy && (legacy.uploadedBy === userId || legacy.sharedWith?.includes('*') || legacy.sharedWith?.includes(userId))) {
    return legacy;
  }
  return null;
}

function resolveFilePath(doc) {
  const ownerPath = path.join(userDocsDir(doc.uploadedBy), doc.id + doc.ext);
  if (fs.existsSync(ownerPath)) return ownerPath;
  const legacyPath = path.join(LEGACY_DIR, doc.id + doc.ext);
  if (fs.existsSync(legacyPath)) return legacyPath;
  return null;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

async function execListSharedDocs(args, userId) {
  const { filter } = args;
  const users = loadUsers();
  let docs = getVisibleDocs(userId);

  if (filter === 'photos') docs = docs.filter(d => d.mimeType.startsWith('image/'));
  else if (filter === 'videos') docs = docs.filter(d => d.mimeType.startsWith('video/'));
  else if (filter === 'docs') docs = docs.filter(d => !d.mimeType.startsWith('image/') && !d.mimeType.startsWith('video/'));

  docs = docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (!docs.length) return 'No documents found.';

  return docs.map(d => {
    const uploader = users.find(u => u.id === d.uploadedBy)?.name ?? 'Unknown';
    const isOwn    = d.uploadedBy === userId;
    let sharing;
    if (isOwn) {
      if (d.sharedWith.includes('*')) sharing = 'shared with everyone';
      else if (d.sharedWith.length)   sharing = `shared with ${d.sharedWith.length} user(s)`;
      else                            sharing = 'private';
    } else {
      sharing = `shared by ${uploader}`;
    }
    const when = new Date(d.createdAt).toLocaleString();
    const canRead = !d.mimeType.startsWith('image/') && !d.mimeType.startsWith('video/');
    return `- [${d.id}] ${d.filename} (${d.mimeType}, ${fmtSize(d.size)}) — ${sharing} — uploaded ${when}${canRead ? ' [readable]' : ''}`;
  }).join('\n');
}

async function execReadSharedDoc(args, userId) {
  const { doc_id } = args;
  const doc = findDoc(doc_id, userId);

  if (!doc) return `Document "${doc_id}" not found or you don't have access.`;

  const filePath = resolveFilePath(doc);
  if (!filePath) return `File "${doc.filename}" is missing from storage.`;

  if (doc.mimeType.startsWith('image/')) return `"${doc.filename}" is an image — use list_shared_docs to see it, or ask the user to share it in the chat.`;
  if (doc.mimeType.startsWith('video/')) return `"${doc.filename}" is a video and cannot be read as text.`;

  const fileData = fs.readFileSync(filePath);
  const ext      = doc.ext.toLowerCase();

  if (['.txt', '.md', '.csv'].includes(ext) || doc.mimeType.startsWith('text/')) {
    const text = fileData.toString('utf8').slice(0, 50000);
    return `[Document: ${doc.filename}]\n\n${text}`;
  }

  if (ext === '.pdf') {
    try {
      const { spawn } = await import('child_process');
      const text = await new Promise((resolve, reject) => {
        const proc = spawn('pdftotext', ['-', '-'], { timeout: 15000 });
        const chunks = [];
        proc.stdout.on('data', c => chunks.push(c));
        proc.on('error', reject);
        proc.on('close', code => {
          if (code !== 0) reject(new Error(`pdftotext exited ${code}`));
          else resolve(Buffer.concat(chunks).toString());
        });
        proc.stdin.end(fileData);
      });
      return `[Document: ${doc.filename}]\n\n${text.slice(0, 50000)}`;
    } catch {
      return `Could not extract text from "${doc.filename}". The PDF may be scanned/image-based.`;
    }
  }

  return `"${doc.filename}" is a ${doc.mimeType} file — text extraction is not supported for this format.`;
}

export default async function execute(name, args, userId) {
  if (name === 'list_shared_docs') return execListSharedDocs(args, userId);
  if (name === 'read_shared_doc')  return execReadSharedDoc(args, userId);
  return `Unknown tool: ${name}`;
}
