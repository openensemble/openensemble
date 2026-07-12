import fs from 'fs';
import path from 'path';
import {
  MAX_DOC_CONTENT,
  createDocument,
  docAudience,
  findOwnedDoc,
  findResearchDoc,
  isTextEditable,
  researchAudience,
  saveNewVersion,
  saveResearchVersion,
} from './doc-store.mjs';
import { getUserFilesDir } from './paths.mjs';
import { broadcastToUsers } from '../routes/_helpers/broadcast.mjs';
import { getUser } from '../routes/_helpers.mjs';

const MAX_CLIP_TEXT = 20_000;

function readIndex(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export function listBrowserClipTargets(userId) {
  const docsDir = getUserFilesDir(userId, 'documents');
  const researchDir = getUserFilesDir(userId, 'research');
  const docs = readIndex(path.join(docsDir, 'docs-index.json'))
    .filter(isTextEditable)
    .map(doc => ({
      id: `documents:${doc.id}`,
      kind: 'document',
      label: doc.filename,
      description: String(doc.description || '').slice(0, 200),
      version: doc.versions?.at(-1)?.n ?? 1,
    }));
  const research = readIndex(path.join(researchDir, 'index.json'))
    .map(doc => ({
      id: `research:${doc.id}`,
      kind: 'research',
      label: doc.title || doc.id,
      description: Array.isArray(doc.tags) ? doc.tags.slice(0, 8).join(', ') : '',
      version: doc.versions?.at(-1)?.n ?? 1,
    }));
  return [...docs, ...research].sort((a, b) => a.label.localeCompare(b.label));
}

function cleanLine(value, fallback) {
  const line = String(value || '').replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (line || fallback).slice(0, 300);
}

function formatClip(capture) {
  if (!capture || typeof capture !== 'object') throw new Error('clip capture is required');
  const rawUrl = String(capture.url || '').trim();
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('clip URL is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('clip URL must use http or https');
  parsed.username = '';
  parsed.password = '';
  // Query strings often contain account/search identifiers. A clip is a
  // citation, not a replay token, so retain only the origin and path.
  parsed.search = '';
  parsed.hash = '';
  const url = parsed.toString().replace(/>/g, '%3E');
  const title = cleanLine(capture.title, parsed.hostname);
  const kind = capture.kind === 'selection' ? 'Selection' : 'Page excerpt';
  const text = String(capture.text || '').replace(/\0/g, '').trim().slice(0, MAX_CLIP_TEXT);
  if (!text) throw new Error('clip has no text');
  const quoted = text.split('\n').map(line => `> ${line}`).join('\n');
  return [
    `## ${title}`,
    '',
    `- Source: <${url}>`,
    `- Saved: ${new Date().toISOString()}`,
    `- Capture: ${kind}`,
    '',
    quoted,
  ].join('\n');
}

function notify(userId, target, version, byName) {
  try {
    const audience = target.kind === 'research'
      ? researchAudience(userId, target.doc.id, userId)
      : docAudience(target.doc, userId);
    broadcastToUsers(audience, {
      type: 'doc_changed',
      docId: target.doc.id,
      filename: target.kind === 'research' ? (target.doc.title || target.doc.id) : target.doc.filename,
      source: target.kind === 'research' ? 'research' : undefined,
      action: 'updated',
      version,
      previousVersion: version > 1 ? version - 1 : null,
      byName,
    });
  } catch (e) {
    console.warn('[browser-clip] doc_changed broadcast failed:', e.message);
  }
}

function resolveOwnedTarget(userId, rawId) {
  const value = String(rawId || '');
  if (value.startsWith('documents:')) {
    const id = value.slice('documents:'.length);
    const doc = findOwnedDoc(userId, id);
    return doc && isTextEditable(doc) ? { kind: 'document', doc } : null;
  }
  if (value.startsWith('research:')) {
    const id = value.slice('research:'.length);
    const doc = findResearchDoc(userId, id);
    return doc ? { kind: 'research', doc } : null;
  }
  return null;
}

export async function appendBrowserClip(userId, { targetId, newDocumentName, capture } = {}) {
  const fragment = formatClip(capture);
  const byName = getUser(userId)?.name || 'OE Browser Clip';

  if (targetId === 'new' || (!targetId && newDocumentName)) {
    const cleanName = cleanLine(newDocumentName, 'Browser research');
    const filename = path.extname(cleanName) ? cleanName : cleanName + '.md';
    const created = await createDocument({
      ownerId: userId,
      filename,
      content: `# ${cleanName.replace(/\.[^.]+$/, '')}\n\n${fragment}\n`,
      description: 'Research collected with OE Bridge',
      byName,
    });
    if (created.error) throw new Error(created.error);
    notify(userId, { kind: 'document', doc: created.doc }, 1, byName);
    return { ok: true, created: true, targetId: `documents:${created.doc.id}`, label: created.doc.filename, version: 1 };
  }

  const target = resolveOwnedTarget(userId, targetId);
  if (!target) throw new Error('clip target was not found or is not editable by this user');
  let current = '';
  let expectedVersion = target.doc.versions?.at(-1)?.n ?? 1;
  if (target.kind === 'research') {
    current = fs.readFileSync(path.join(getUserFilesDir(userId, 'research'), path.basename(target.doc.filename)), 'utf8');
  } else {
    current = fs.readFileSync(path.join(getUserFilesDir(userId, 'documents'), target.doc.id + target.doc.ext), 'utf8');
  }
  const separator = current.trim() ? '\n\n' : '';
  const content = `${current.replace(/\s*$/, '')}${separator}${fragment}\n`;
  if (content.length > MAX_DOC_CONTENT) throw new Error('the selected document is too large for another clip');

  const result = target.kind === 'research'
    ? await saveResearchVersion({
        userId, docId: target.doc.id, content, source: 'user', by: userId, byName,
        note: `Clipped ${cleanLine(capture?.title, 'browser page')}`, expectedVersion,
      })
    : await saveNewVersion({
        ownerId: userId, docId: target.doc.id, content, source: 'user', by: userId, byName,
        note: `Clipped ${cleanLine(capture?.title, 'browser page')}`, expectedVersion,
      });
  if (result.error) throw new Error(result.error);
  notify(userId, target, result.n, byName);
  return {
    ok: true,
    created: false,
    targetId,
    label: target.kind === 'research' ? (target.doc.title || target.doc.id) : target.doc.filename,
    version: result.n,
  };
}
