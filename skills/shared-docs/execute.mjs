import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_DIR   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS_DIR   = path.join(BASE_DIR, 'shared-docs');
const INDEX_PATH = path.join(DOCS_DIR, 'index.json');
const USERS_DIR  = path.join(BASE_DIR, 'users');

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); } catch { return []; }
}

function loadUsers() {
  try {
    return fs.readdirSync(USERS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function canAccess(doc, userId) {
  return doc.uploadedBy === userId ||
    doc.sharedWith.includes('*') ||
    doc.sharedWith.includes(userId);
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

async function execListSharedDocs(args, userId) {
  const { filter } = args;
  const users = loadUsers();
  let docs = loadIndex().filter(d => canAccess(d, userId));

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
  const docs = loadIndex();
  const doc  = docs.find(d => d.id === doc_id);

  if (!doc)               return `Document "${doc_id}" not found.`;
  if (!canAccess(doc, userId)) return `You don't have access to document "${doc_id}".`;

  const filePath = path.join(DOCS_DIR, doc.id + doc.ext);
  if (!fs.existsSync(filePath)) return `File "${doc.filename}" is missing from storage.`;

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
