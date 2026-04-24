/**
 * Session persistence for OpenEnsemble.
 * One JSONL file per agent: sessions/{agentId}.jsonl
 * Each line: { role, content, ts }
 *
 * LM Studio stateful response IDs stored alongside:
 * sessions/{agentId}.lms_id  — plain text file, one ID
 */

import fs from 'fs';
import fsp from 'fs/promises';

// Simple per-key lock to serialize session writes
const _sessionLocks = new Map();
function withSessionLock(key, fn) {
  const chain = (_sessionLocks.get(key) ?? Promise.resolve()).then(fn);
  _sessionLocks.set(key, chain.catch(() => {}));
  return chain;
}
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const USERS_DIR = path.join(BASE_DIR, 'users');
const MAX_HISTORY  = 60; // max messages loaded into context

function safeId(id) {
  // Allow only alphanumeric, underscore, hyphen — prevents path traversal
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Split a scoped agentId (e.g. "user_abc123_agent_def456") into userId + localId. */
function parseAgentId(agentId) {
  const m = agentId.match(/^(user_[a-zA-Z0-9]+)_(.+)$/);
  return m ? { userId: m[1], localId: m[2] } : { userId: null, localId: agentId };
}

function getSessionsDir(agentId) {
  const { userId } = parseAgentId(agentId);
  if (userId) return path.join(USERS_DIR, userId, 'sessions');
  return path.join(BASE_DIR, 'sessions'); // fallback for non-user-scoped IDs
}

function sessionPath(agentId) {
  const { localId } = parseAgentId(agentId);
  const dir = getSessionsDir(agentId);
  return path.join(dir, `${safeId(localId)}.jsonl`);
}

function lmsIdPath(agentId) {
  const { localId } = parseAgentId(agentId);
  const dir = getSessionsDir(agentId);
  return path.join(dir, `${safeId(localId)}.lms_id`);
}

export function loadSession(agentId, limit = MAX_HISTORY) {
  const p = sessionPath(agentId);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  const messages = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return messages.slice(-limit);
}

const PRUNE_THRESHOLD = 500; // prune when file exceeds this many lines
const PRUNE_KEEP      = 200; // keep this many most recent lines after pruning
const _lineCounts     = new Map(); // agentId → estimated line count

export function appendToSession(agentId, ...messages) {
  // Ephemeral agents (spawned per-call by deep_research_parallel etc.) have
  // no persistent session — skip all disk writes for IDs prefixed "ephemeral_".
  if (typeof agentId === 'string' && agentId.startsWith('ephemeral_')) return;
  withSessionLock('session:' + agentId, async () => {
    const sessDir = getSessionsDir(agentId);
    await fsp.mkdir(sessDir, { recursive: true });
    const p = sessionPath(agentId);
    const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    // Open → append → fsync → close so lines survive crash / power loss.
    // Plain appendFile leaves bytes in the kernel page cache and the last N
    // messages can disappear silently on reboot.
    const fh = await fsp.open(p, 'a');
    try {
      await fh.appendFile(lines);
      await fh.sync();
    } finally {
      await fh.close();
    }

    // Track line count in memory — only read the file when threshold is exceeded
    const count = (_lineCounts.get(agentId) ?? 0) + messages.length;
    _lineCounts.set(agentId, count);

    if (count > PRUNE_THRESHOLD) {
      try {
        const all = (await fsp.readFile(p, 'utf8')).trim().split('\n').filter(Boolean);
        if (all.length > PRUNE_THRESHOLD) {
          await fsp.writeFile(p, all.slice(-PRUNE_KEEP).join('\n') + '\n');
          _lineCounts.set(agentId, PRUNE_KEEP);
        } else {
          _lineCounts.set(agentId, all.length);
        }
      } catch (e) { console.warn('[sessions] Auto-prune failed for', agentId + ':', e.message); }
    }
  });
}

export function clearSession(agentId) {
  const p = sessionPath(agentId);
  if (fs.existsSync(p)) fs.writeFileSync(p, '');
  _lineCounts.delete(agentId);
  // Also clear LM Studio response_id so next request starts a fresh context
  const idp = lmsIdPath(agentId);
  if (fs.existsSync(idp)) fs.unlinkSync(idp);
}

// ── LM Studio stateful response ID ───────────────────────────────────────────

export function getLmsResponseId(agentId) {
  const p = lmsIdPath(agentId);
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null; } catch (e) { console.warn('[sessions] Failed to read LMS response ID:', e.message); return null; }
}

export function setLmsResponseId(agentId, responseId) {
  try { fs.writeFileSync(lmsIdPath(agentId), responseId); } catch (e) { console.warn('[sessions] Failed to write LMS response ID:', e.message); }
}

// ── Stream buffer (partial response persistence) ─────────────────────────────
// Periodically writes in-progress assistant content to a .streaming file so
// partial responses survive tab closes and server crashes.

const _lastFlush = new Map(); // agentId → timestamp of last write
const FLUSH_INTERVAL = 2000;  // min ms between disk writes per agent

function streamBufferPath(agentId) {
  const { localId } = parseAgentId(agentId);
  const dir = getSessionsDir(agentId);
  return path.join(dir, `${safeId(localId)}.streaming`);
}

export function writeStreamBuffer(agentId, content) {
  if (typeof agentId === 'string' && agentId.startsWith('ephemeral_')) return;
  const now = Date.now();
  const last = _lastFlush.get(agentId) ?? 0;
  if (now - last < FLUSH_INTERVAL) return;
  _lastFlush.set(agentId, now);
  const p = streamBufferPath(agentId);
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ content, ts: now }));
  } catch (e) {
    console.warn('[sessions] Failed to write stream buffer:', e.message);
  }
}

export function clearStreamBuffer(agentId) {
  _lastFlush.delete(agentId);
  const p = streamBufferPath(agentId);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

export function getStreamBuffer(agentId) {
  const p = streamBufferPath(agentId);
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

/** Recover any leftover .streaming files from a previous server crash. */
export function cleanStaleStreamBuffers() {
  try {
    if (!fs.existsSync(USERS_DIR)) return;
    for (const userDir of fs.readdirSync(USERS_DIR)) {
      const sessDir = path.join(USERS_DIR, userDir, 'sessions');
      if (!fs.existsSync(sessDir)) continue;
      for (const file of fs.readdirSync(sessDir)) {
        if (!file.endsWith('.streaming')) continue;
        const bufPath = path.join(sessDir, file);
        try {
          const buf = JSON.parse(fs.readFileSync(bufPath, 'utf8'));
          if (buf?.content) {
            // Convert to a final session entry
            const jsonlFile = path.join(sessDir, file.replace('.streaming', '.jsonl'));
            fs.appendFileSync(jsonlFile, JSON.stringify({ role: 'assistant', content: buf.content, ts: buf.ts, partial: true }) + '\n');
          }
          fs.unlinkSync(bufPath);
        } catch (e) {
          console.warn('[sessions] Failed to recover stream buffer', file, e.message);
          try { fs.unlinkSync(bufPath); } catch {}
        }
      }
    }
  } catch (e) {
    console.warn('[sessions] Stream buffer cleanup failed:', e.message);
  }
}

// Run cleanup on module load (recovers from server crashes)
cleanStaleStreamBuffers();

// ── Cross-agent context ─────────────────────────────────────────────────────
export function loadCrossAgentContext(userId, targetAgentId, limit = 3) {
  return loadSession(`${userId}_${targetAgentId}`, limit);
}
