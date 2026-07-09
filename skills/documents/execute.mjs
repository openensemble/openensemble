/**
 * Document Editing skill executor.
 * Chat-driven editing of Documents-drawer files with append-only version
 * history (lib/doc-store.mjs). Handles both stores: uploaded shared-docs
 * (doc_x / documents:doc_x) and research documents (research:doc_x, with
 * bare-id fallback). Every mutation broadcasts doc_changed so open UIs
 * refresh live.
 */

import fs from 'fs';
import path from 'path';
import {
  MAX_DOC_CONTENT, isTextEditable, findOwnedDoc, findDocForUser,
  listVersions, readVersion, saveNewVersion, restoreVersion,
  createDocument, docAudience,
  findResearchDoc, listResearchVersions, saveResearchVersion,
  restoreResearchVersion, researchAudience,
} from '../../lib/doc-store.mjs';
import { getUserFilesDir, BASE_DIR } from '../../lib/paths.mjs';
import { broadcastToUsers } from '../../routes/_helpers/broadcast.mjs';

function agentName(agentId) {
  if (!agentId) return 'Agent';
  try {
    // Dynamic import avoids pulling the agent registry in at manifest-load time
    const a = _getAgent?.(agentId);
    if (a) return `${a.emoji ?? ''} ${a.name ?? agentId}`.trim();
  } catch {}
  return `Agent ${agentId}`;
}
let _getAgent = null;
import('../../agents.mjs').then(m => { _getAgent = m.getAgent; }).catch(() => {});

/**
 * Resolve any id form to its store: 'research:doc_x' targets the research
 * store; 'documents:doc_x' and bare 'doc_x' try shared-docs first, then fall
 * back to research (bare research ids appear in old chat history).
 * Returns { store: 'docs'|'research', doc, ownerId, id } or null.
 */
function resolveAnyDoc(userId, rawId) {
  const raw = String(rawId ?? '').trim();
  const id = raw.replace(/^(documents|research):/, '');
  if (!id) return null;
  if (!raw.startsWith('research:')) {
    const found = findDocForUser(userId, id);
    if (found) return { store: 'docs', doc: found.doc, ownerId: found.ownerId, id };
  }
  const rdoc = findResearchDoc(userId, id);
  if (rdoc) return { store: 'research', doc: rdoc, ownerId: userId, id };
  return null;
}

function displayName(resolved) {
  return resolved.store === 'research' ? (resolved.doc.title ?? resolved.id) : resolved.doc.filename;
}

function notifyDocChanged(resolved, requesterId, action, version, byName) {
  try {
    const audience = resolved.store === 'research'
      ? researchAudience(resolved.ownerId, resolved.id, requesterId)
      : docAudience(resolved.doc, requesterId);
    broadcastToUsers(audience, {
      type: 'doc_changed',
      docId: resolved.id,
      filename: displayName(resolved),
      mimeType: resolved.doc.mimeType ?? (resolved.store === 'research' ? 'text/markdown' : 'text/plain'),
      source: resolved.store === 'research' ? 'research' : undefined,
      action,
      version,
      previousVersion: version > 1 ? version - 1 : null,
      byName,
    });
  } catch (e) {
    console.warn('[documents] doc_changed broadcast failed:', e.message);
  }
}

function execList(query, userId) {
  // Own docs + docs shared with this user, text-editable only — this skill
  // can't do anything useful with media/PDF entries.
  let docs = [];
  try {
    const indexPath = path.join(getUserFilesDir(userId, 'documents'), 'docs-index.json');
    docs = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!Array.isArray(docs)) docs = [];
  } catch { docs = []; }
  docs = docs.map(d => ({ ...d, _own: true }));

  try {
    const shares = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'sharing.json'), 'utf8'));
    for (const s of shares) {
      if (s.ownerId === userId) continue;
      if (!s.sharedWith.includes(userId) && !s.sharedWith.includes('*')) continue;
      const doc = findOwnedDoc(s.ownerId, s.fileId);
      if (doc && !docs.some(d => d.id === doc.id)) docs.push({ ...doc, _own: false });
    }
  } catch {}

  docs = docs.filter(isTextEditable);

  // Research documents (own only — matches the research routes)
  let research = [];
  try {
    const rIndexPath = path.join(getUserFilesDir(userId, 'research'), 'index.json');
    research = JSON.parse(fs.readFileSync(rIndexPath, 'utf8'));
    if (!Array.isArray(research)) research = [];
  } catch { research = []; }

  if (query) {
    const q = String(query).toLowerCase();
    docs = docs.filter(d =>
      d.filename.toLowerCase().includes(q) ||
      String(d.description ?? '').toLowerCase().includes(q));
    research = research.filter(d =>
      String(d.title ?? '').toLowerCase().includes(q) ||
      (d.tags ?? []).some(t => String(t).toLowerCase().includes(q)));
  }

  if (!docs.length && !research.length) {
    return query
      ? `No editable documents found matching "${query}".`
      : 'No editable documents yet. Documents can be uploaded from the Documents drawer, or created with create_document.';
  }
  const docLines = docs.map(d => {
    const vCount = d.versions?.length ? ` · v${d.versions.at(-1).n}` : '';
    const owner = d._own ? '' : ` · shared by ${d.uploadedByName || 'someone'} (read-only)`;
    const desc = d.description ? ` — ${d.description}` : '';
    return `- **${d.filename}** (id: ${d.id})${vCount}${owner}${desc}`;
  });
  const researchLines = research.map(d => {
    const vCount = d.versions?.length ? ` · v${d.versions.at(-1).n}` : '';
    const tags = d.tags?.length ? ` [${d.tags.join(', ')}]` : '';
    return `- **${d.title ?? d.id}** (id: research:${d.id})${vCount}${tags}`;
  });
  const sections = [];
  if (docLines.length) sections.push(`## Text documents (${docLines.length})\n\n${docLines.join('\n')}`);
  if (researchLines.length) sections.push(`## Research documents (${researchLines.length})\n\n${researchLines.join('\n')}`);
  return sections.join('\n\n');
}

function execRead(documentId, userId) {
  const resolved = resolveAnyDoc(userId, documentId);
  if (!resolved) return `Document "${documentId}" not found. Use list_documents to see what's available.`;
  const { store, doc, ownerId, id } = resolved;
  try {
    let text, idLabel;
    if (store === 'research') {
      text = fs.readFileSync(path.join(getUserFilesDir(ownerId, 'research'), path.basename(doc.filename)), 'utf8');
      idLabel = `research:${id}`;
    } else {
      if (!isTextEditable(doc)) return `"${doc.filename}" is not a text document — it can't be read as text.`;
      text = fs.readFileSync(path.join(getUserFilesDir(ownerId, 'documents'), doc.id + doc.ext), 'utf8');
      idLabel = id;
    }
    if (text.length > MAX_DOC_CONTENT) {
      return `Error: "${displayName(resolved)}" is too large for AI editing (${text.length} characters; maximum ${MAX_DOC_CONTENT}). The document was not changed.`;
    }
    const v = doc.versions?.at(-1)?.n ?? 1;
    return `[Document: ${displayName(resolved)} | id: ${idLabel} | v${v}]\n\n${text}`;
  } catch {
    return `Error: file for "${displayName(resolved)}" is missing on disk.`;
  }
}

async function execUpdate(documentId, content, note, expectedVersion, userId, agentId) {
  const resolved = resolveAnyDoc(userId, documentId);
  if (!resolved) return `Document "${documentId}" not found. Use list_documents to see what's available.`;
  if (!Number.isInteger(Number(expectedVersion)) || Number(expectedVersion) < 1) {
    return 'Error: expected_version is required. Call read_document immediately before updating and pass the version from its header.';
  }
  if (resolved.store === 'docs' && resolved.ownerId !== userId) {
    return `"${resolved.doc.filename}" is shared by ${resolved.doc.uploadedByName || 'another user'} and is read-only for this account. Offer to save an edited copy with create_document instead.`;
  }
  const byName = agentName(agentId);
  const result = resolved.store === 'research'
    ? await saveResearchVersion({ userId, docId: resolved.id, content, source: 'ai', by: userId, byName, note, expectedVersion })
    : await saveNewVersion({ ownerId: resolved.ownerId, docId: resolved.id, content, source: 'ai', by: userId, byName, note, expectedVersion });
  if (result.error) return `Error: ${result.error}`;
  notifyDocChanged(resolved, userId, 'updated', result.n, byName);
  return JSON.stringify({
    success: true,
    action: 'updated',
    id: resolved.store === 'research' ? `research:${resolved.id}` : resolved.id,
    docId: resolved.id,
    filename: displayName(resolved),
    mimeType: resolved.doc.mimeType ?? (resolved.store === 'research' ? 'text/markdown' : 'text/plain'),
    source: resolved.store === 'research' ? 'research' : '',
    version: result.n,
    previousVersion: result.n > 1 ? result.n - 1 : null,
    note: note ?? '',
    message: `"${displayName(resolved)}" updated to v${result.n}. All previous versions are kept — the user can view or restore them from the document's History.`,
  });
}

async function execCreate(filename, content, description, userId, agentId) {
  const byName = agentName(agentId);
  const result = await createDocument({ ownerId: userId, filename, content, description, byName });
  if (result.error) return `Error: ${result.error}`;
  notifyDocChanged({ store: 'docs', doc: result.doc, ownerId: userId, id: result.doc.id }, userId, 'created', 1, byName);
  return JSON.stringify({
    success: true,
    action: 'created',
    id: result.doc.id,
    docId: result.doc.id,
    filename: result.doc.filename,
    mimeType: result.doc.mimeType,
    source: '',
    version: 1,
    previousVersion: null,
    message: `Created "${result.doc.filename}" (id: ${result.doc.id}). It's in the user's Documents drawer.`,
  });
}

function execListVersions(documentId, userId) {
  const resolved = resolveAnyDoc(userId, documentId);
  if (!resolved) return `Document "${documentId}" not found.`;
  const versions = resolved.store === 'research'
    ? listResearchVersions(resolved.ownerId, resolved.id)
    : listVersions(resolved.ownerId, resolved.id);
  if (!versions.length) {
    return `"${displayName(resolved)}" has no version history yet — history starts with its first edit.`;
  }
  const lines = versions.map(v => {
    const who = v.byName || v.source;
    const note = v.note ? ` — ${v.note}` : '';
    return `- v${v.n} · ${v.source} · ${who} · ${v.at}${note}`;
  });
  return `## Versions of ${displayName(resolved)} (current: v${versions.at(-1).n})\n\n${lines.join('\n')}`;
}

async function execRestore(documentId, version, userId, agentId) {
  const resolved = resolveAnyDoc(userId, documentId);
  if (!resolved) return `Document "${documentId}" not found.`;
  if (resolved.store === 'docs' && resolved.ownerId !== userId) {
    return `"${resolved.doc.filename}" is shared by another user and is read-only for this account.`;
  }
  const byName = agentName(agentId);
  const result = resolved.store === 'research'
    ? await restoreResearchVersion({ userId, docId: resolved.id, n: version, by: userId, byName })
    : await restoreVersion({ ownerId: userId, docId: resolved.id, n: version, by: userId, byName });
  if (result.error) return `Error: ${result.error}`;
  notifyDocChanged(resolved, userId, 'restored', result.n, byName);
  return JSON.stringify({
    success: true,
    action: 'restored',
    id: resolved.store === 'research' ? `research:${resolved.id}` : resolved.id,
    docId: resolved.id,
    filename: displayName(resolved),
    mimeType: resolved.doc.mimeType ?? (resolved.store === 'research' ? 'text/markdown' : 'text/plain'),
    source: resolved.store === 'research' ? 'research' : '',
    version: result.n,
    previousVersion: result.n > 1 ? result.n - 1 : null,
    message: `Restored v${version} of "${displayName(resolved)}" as new version v${result.n}.`,
  });
}

export async function executeSkillTool(name, args, userId, agentId, ctx) {
  try {
    switch (name) {
      case 'list_documents':
        return execList(args?.query, userId);
      case 'read_document':
        return execRead(args?.document_id, userId);
      case 'update_document':
        return await execUpdate(args?.document_id, args?.content, args?.note, args?.expected_version, userId, agentId);
      case 'create_document':
        return await execCreate(args?.filename, args?.content, args?.description, userId, agentId);
      case 'list_document_versions':
        return execListVersions(args?.document_id, userId);
      case 'restore_document_version':
        return await execRestore(args?.document_id, args?.version, userId, agentId);
      default:
        return null;
    }
  } catch (err) {
    if (ctx?.toolError) return ctx.toolError(`Document operation failed: ${err.message}`);
    return `Error: ${err.message}`;
  }
}

export default executeSkillTool;
