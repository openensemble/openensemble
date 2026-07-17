/**
 * email_compose body-by-reference.
 *
 * Lets an agent send a large, already-written body (a briefing, a synthesized
 * report) WITHOUT regenerating it token-by-token as a tool argument. The caller
 * passes `body_doc_id` (a research/documents handle); the server reads the doc's
 * text, renders markdown → HTML inline, and fills body/html_body. The content is
 * generated once and forwarded by reference — fast, exact, no truncation.
 *
 * These docs are transient handoff buffers: delete them after a confirmed send
 * (deleteBodyDoc), so they don't pile up in the user's Profile Files.
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { loadEmailAttachments } from './email-attachments.mjs';
import { currentTaskContext } from './task-proxy-context.mjs';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Inline markdown on a single line. Escapes HTML first, then applies formatting
// to the escaped text so doc content can never inject markup.
function inlineMd(s) {
  let t = esc(s);
  const protectedHtml = [];
  const protect = html => {
    const token = `\u0000${protectedHtml.length}\u0000`;
    protectedHtml.push(html);
    return token;
  };
  // Protect explicit links and code before linkifying bare URLs, otherwise the
  // generated href markup can be matched a second time and nested/corrupted.
  t = t.replace(/`([^`]+)`/g, (_m, code) => protect(`<code>${code}</code>`));
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label, href) => protect(`<a href="${href}">${label}</a>`));
  t = t.replace(/\bhttps?:\/\/[^\s<>]+/gi, (raw) => {
    let href = raw;
    let trailing = '';
    while (/[.,!?;:]$/.test(href)) {
      trailing = href.slice(-1) + trailing;
      href = href.slice(0, -1);
    }
    let opens = (href.match(/\(/g) || []).length;
    let closes = (href.match(/\)/g) || []).length;
    while (href.endsWith(')') && closes > opens) {
      trailing = ')' + trailing;
      href = href.slice(0, -1);
      closes--;
    }
    return href ? `${protect(`<a href="${href}">${href}</a>`)}${trailing}` : raw;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, index) => protectedHtml[Number(index)] || '');
  return t;
}

// Minimal, dependency-free markdown → HTML. Covers what briefings actually use:
// headings, bullet/numbered lists, blockquotes, rules, bold/italic/code/links,
// and blank-line-separated paragraphs. Not a full CommonMark implementation.
export function markdownToHtml(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>'); para = []; } };
  while (i < lines.length) {
    const line = lines[i];
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); const lvl = h[1].length; out.push(`<h${lvl}>${inlineMd(h[2].trim())}</h${lvl}>`); i++; continue; }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushPara(); out.push('<ul>');
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { out.push('<li>' + inlineMd(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i++; }
      out.push('</ul>'); continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushPara(); out.push('<ol>');
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { out.push('<li>' + inlineMd(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i++; }
      out.push('</ol>'); continue;
    }
    if (/^\s*>\s?/.test(line)) { flushPara(); out.push('<blockquote>' + inlineMd(line.replace(/^\s*>\s?/, '')) + '</blockquote>'); i++; continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
    para.push(line.trim()); i++;
  }
  flushPara();
  return out.join('\n');
}

function htmlToTextLite(html) {
  return String(html)
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li|h[1-6]|ul|ol|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Resolve a body_doc_id reference into email body fields.
 * @returns {{ body?: string, htmlBody?: string|null, cleanup?: {kind:string,id:string}|null, error?: string }}
 */
export function resolveBodyDoc(refRaw, userId) {
  const ref = String(refRaw || '').trim();
  if (!ref) return { error: 'body_doc_id was empty.' };
  // Pipeline-bound handoff identity: when a background pipeline declared which
  // docs its producer stage created (taskCtx.allowedBodyDocIds), only those ids
  // may be inlined as an email body. Blocks the "producer saved nothing →
  // consumer hunts old files and mails a stale doc" failure (2026-07-02 daily
  // briefing). Interactive turns never set allowedBodyDocIds, so a manual
  // "email me that research doc from last week" is untouched. Single choke
  // point: email_user delegates to email_compose, which resolves here.
  const taskCtx = currentTaskContext();
  if (taskCtx && Array.isArray(taskCtx.allowedBodyDocIds)) {
    const tail = (s) => { const i = String(s).lastIndexOf(':'); return i === -1 ? String(s) : String(s).slice(i + 1); };
    const ok = taskCtx.allowedBodyDocIds.some(a => a === ref || tail(a) === tail(ref));
    if (!ok) {
      return { error: `body_doc_id "${ref}" was not produced by this pipeline run — refusing to email a substitute document. ` +
        `Allowed ids for this handoff: ${taskCtx.allowedBodyDocIds.join(', ') || '(none)'}.` };
    }
  }
  const { attachments, errors } = loadEmailAttachments([ref], userId);
  if (!attachments.length) {
    return { error: `Could not load body_doc_id "${ref}"${errors.length ? ': ' + errors.join(', ') : ''}. ` +
      `Call list_research (or list_profile_files) to find the id. Accepted forms: 'research:doc_xxx', 'documents:doc_xxx'.` };
  }
  const doc = attachments[0];
  const mime = (doc.mimeType || '').toLowerCase();
  const name = (doc.filename || '').toLowerCase();
  const isText = mime.startsWith('text/') || mime === 'application/json';
  if (!isText) {
    return { error: `body_doc_id "${ref}" is a ${doc.mimeType || 'binary'} file — it can't be inlined as the email body. ` +
      `To send it as a downloadable file, use attachment_doc_ids instead.` };
  }
  const text = doc.data.toString('utf8');
  const isHtml = mime.includes('html') || /\.html?$/.test(name);
  const isMarkdown = mime.includes('markdown') || /\.md$/.test(name);
  let body, htmlBody = null;
  if (isHtml) { htmlBody = text; body = htmlToTextLite(text); }
  else if (isMarkdown) { htmlBody = markdownToHtml(text); body = text; }
  else { body = text; }  // plain text / csv / json — inline as-is, no HTML part

  // Only per-user research/documents docs are transient-deletable. Never delete
  // shared docs or media (images/videos) — those aren't handoff buffers.
  let cleanup = null;
  const colon = ref.indexOf(':');
  if (colon !== -1) {
    const folder = ref.slice(0, colon);
    const id = ref.slice(colon + 1);
    if (folder === 'research' || folder === 'documents') cleanup = { kind: folder, id };
  }
  return { body, htmlBody, cleanup };
}

/**
 * Delete a transient handoff doc (research/documents) after a confirmed send.
 * @returns {boolean} whether something was removed.
 */
export function deleteBodyDoc(cleanup, userId) {
  if (!cleanup || !cleanup.id) return false;
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
  try {
    if (cleanup.kind === 'research') {
      const dir = path.join(USERS_DIR, safe, 'research');
      const idxPath = path.join(dir, 'index.json');
      const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      const i = idx.findIndex(d => d.id === cleanup.id);
      if (i === -1) return false;
      try { fs.unlinkSync(path.join(dir, idx[i].filename)); } catch { /* file already gone */ }
      idx.splice(i, 1);
      fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
      return true;
    }
    if (cleanup.kind === 'documents') {
      const dir = path.join(USERS_DIR, safe, 'documents');
      const idxPath = path.join(dir, 'docs-index.json');
      const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      const i = idx.findIndex(d => d.id === cleanup.id);
      if (i === -1) return false;
      try { fs.unlinkSync(path.join(dir, idx[i].id + (idx[i].ext || ''))); } catch { /* file already gone */ }
      idx.splice(i, 1);
      fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
      return true;
    }
  } catch { /* index missing/corrupt — nothing safe to delete */ }
  return false;
}
