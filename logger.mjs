/**
 * Structured logger with size-capped rotation and redaction.
 *
 *   log.info('scheduler', 'Task complete', { taskId, durationMs });
 *   log.warn('auth',      'Rate limited', { ip });
 *   log.error('chat',     'Provider failed', { provider, status, err: e.message });
 *
 * Writes one JSONL entry per line to logs/app.log (all levels) and
 * logs/error.log (errors only). Mirrors to stdout/stderr so existing
 * shell redirection still captures everything.
 *
 * Files rotate at MAX_BYTES, keeping KEEP_FILES older copies (.1 .. .N).
 * Redaction strips password/token/auth/cookie/secret-style keys and
 * truncates long string values; still, never pass raw prompts or
 * message bodies as meta — keep logs metadata-only.
 */

import fs from 'fs';
import path from 'path';
import { BASE_DIR } from './lib/paths.mjs';

export const LOG_DIR = path.join(BASE_DIR, 'logs');

// Defaults; can be tuned via config.json logs.{maxFileMB, keepFiles}.
let MAX_BYTES   = 5 * 1024 * 1024; // 5 MB per file
let KEEP_FILES  = 5;
let MAX_META_STR = 500;            // truncate long string values in meta

// Call once at startup to override defaults from config.
export function configureLogger({ maxFileMB, keepFiles, maxMetaChars } = {}) {
  if (Number.isFinite(maxFileMB) && maxFileMB > 0) MAX_BYTES = Math.floor(maxFileMB * 1024 * 1024);
  if (Number.isFinite(keepFiles) && keepFiles >= 1) KEEP_FILES = Math.floor(keepFiles);
  if (Number.isFinite(maxMetaChars) && maxMetaChars > 0) MAX_META_STR = Math.floor(maxMetaChars);
}

const REDACT_KEYS = /pass(word|code)?|token|authori[sz]ation|cookie|secret|api[_-]?key|bearer|credential|session/i;

function ensureDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function redact(value, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (value == null) return value;
  if (typeof value === 'string') {
    return value.length > MAX_META_STR ? value.slice(0, MAX_META_STR) + '…[truncated]' : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEYS.test(k)) { out[k] = '[redacted]'; continue; }
    out[k] = redact(v, depth + 1);
  }
  return out;
}

function rotate(filepath) {
  try {
    // Drop oldest, shift the rest up by one.
    const oldest = `${filepath}.${KEEP_FILES}`;
    if (fs.existsSync(oldest)) { try { fs.unlinkSync(oldest); } catch {} }
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      const src = `${filepath}.${i}`;
      const dst = `${filepath}.${i + 1}`;
      if (fs.existsSync(src)) { try { fs.renameSync(src, dst); } catch {} }
    }
    if (fs.existsSync(filepath)) fs.renameSync(filepath, `${filepath}.1`);
  } catch {
    // Never throw from logger.
  }
}

function writeLine(filepath, line) {
  ensureDir();
  try {
    let size = 0;
    try { size = fs.statSync(filepath).size; } catch {}
    if (size > 0 && size + line.length > MAX_BYTES) rotate(filepath);
    fs.appendFileSync(filepath, line);
  } catch {
    // Never throw from logger.
  }
}

const APP_FILE = path.join(LOG_DIR, 'app.log');
const ERR_FILE = path.join(LOG_DIR, 'error.log');

export const LOG_FILES = { app: APP_FILE, error: ERR_FILE };

function emit(level, tag, msg, meta) {
  const ts = new Date().toISOString();
  const safeMeta = meta ? redact(meta) : undefined;
  const entry = safeMeta
    ? { ts, level, tag, msg, meta: safeMeta }
    : { ts, level, tag, msg };
  let line;
  try { line = JSON.stringify(entry) + '\n'; }
  catch { line = JSON.stringify({ ts, level, tag, msg: String(msg), meta: '[unserializable]' }) + '\n'; }

  writeLine(APP_FILE, line);
  if (level === 'error') writeLine(ERR_FILE, line);

  // Mirror to stdout/stderr so existing shell redirection keeps working.
  const human = `[${tag}] ${msg}` + (safeMeta ? ' ' + JSON.stringify(safeMeta) : '');
  if (level === 'error')      console.error(human);
  else if (level === 'warn')  console.warn(human);
  else                        console.log(human);
}

export const log = {
  info:  (tag, msg, meta) => emit('info',  tag, msg, meta),
  warn:  (tag, msg, meta) => emit('warn',  tag, msg, meta),
  error: (tag, msg, meta) => emit('error', tag, msg, meta),
};

export default log;

// ── Reader API used by admin route + logs skill ──────────────────────────────
//
// Reads the tail of a log file. Returns parsed JSONL entries newest-last.
// Malformed lines (pre-logger legacy content, if any) are returned as a
// synthetic { ts: null, level: 'info', tag: 'raw', msg: <line> } entry.

function parseJSONL(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && obj.level && obj.msg !== undefined) {
        out.push(obj);
        continue;
      }
    } catch {}
    out.push({ ts: null, level: 'info', tag: 'raw', msg: raw });
  }
  return out;
}

export function listLogFiles() {
  ensureDir();
  const files = [];
  for (const [name, filepath] of Object.entries(LOG_FILES)) {
    let size = 0, mtime = null;
    try { const s = fs.statSync(filepath); size = s.size; mtime = s.mtimeMs; } catch {}
    files.push({ name, path: filepath, size, mtime });
  }
  return files;
}

// Read up to `tail` most recent entries from the given named log file.
// Optional level filter (info|warn|error) and case-insensitive text search.
export function readLog({ file = 'app', tail = 200, level, q, since } = {}) {
  const filepath = LOG_FILES[file];
  if (!filepath) return { entries: [], totalBytes: 0, file };
  let totalBytes = 0;
  let text = '';
  try {
    const s = fs.statSync(filepath);
    totalBytes = s.size;
    // Read at most ~2 MB from the end to keep memory bounded.
    const READ_CAP = 2 * 1024 * 1024;
    if (totalBytes <= READ_CAP) {
      text = fs.readFileSync(filepath, 'utf8');
    } else {
      const fd = fs.openSync(filepath, 'r');
      try {
        const buf = Buffer.alloc(READ_CAP);
        fs.readSync(fd, buf, 0, READ_CAP, totalBytes - READ_CAP);
        // Drop a possibly-partial first line.
        const str = buf.toString('utf8');
        const firstNl = str.indexOf('\n');
        text = firstNl === -1 ? str : str.slice(firstNl + 1);
      } finally { fs.closeSync(fd); }
    }
  } catch {
    return { entries: [], totalBytes: 0, file };
  }
  let entries = parseJSONL(text);
  if (level) entries = entries.filter(e => e.level === level);
  if (since) {
    const sinceMs = typeof since === 'number' ? since : Date.parse(since);
    if (!Number.isNaN(sinceMs)) entries = entries.filter(e => {
      const t = e.ts ? Date.parse(e.ts) : 0;
      return t >= sinceMs;
    });
  }
  if (q) {
    const needle = String(q).toLowerCase();
    entries = entries.filter(e =>
      (e.tag ?? '').toLowerCase().includes(needle) ||
      (e.msg ?? '').toLowerCase().includes(needle) ||
      (e.meta ? JSON.stringify(e.meta).toLowerCase().includes(needle) : false)
    );
  }
  const n = Math.max(1, Math.min(5000, Number(tail) || 200));
  if (entries.length > n) entries = entries.slice(entries.length - n);
  return { entries, totalBytes, file };
}
