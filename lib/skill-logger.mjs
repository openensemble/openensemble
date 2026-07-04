// @ts-check
/**
 * Per-skill structured logging surface.
 *
 *   ctx.log.info('fetched 3 songs', { query, ms });
 *   ctx.log.warn('search returned empty');
 *   ctx.log.error('yt-dlp failed', { code: 1, stderr });
 *
 * Behaviour:
 *   - Mirrors to OE's app.log via the same logger as `log.info('tag', …)`,
 *     tagged `skill:<id>` so global queries can filter.
 *   - Also writes a per-skill JSONL at
 *     users/<userId>/skills/<skillId>/runtime.log (the file Ada reads via
 *     skill_read_logs to diagnose misbehaving skills). Size-capped at 2 MB
 *     with one rotation kept (.1).
 *   - Both writes are async via fsp; no event-loop blocking.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { log as oeLog } from '../logger.mjs';

const MAX_PER_SKILL_LOG_BYTES = 2 * 1024 * 1024;

function skillLogDir(userId, skillId) {
  return path.join(USERS_DIR, userId, 'skills', String(skillId));
}

function skillLogPath(userId, skillId) {
  return path.join(skillLogDir(userId, skillId), 'runtime.log');
}

async function rotateIfNeeded(filepath) {
  let size = 0;
  try { size = (await fsp.stat(filepath)).size; } catch { return; }
  if (size < MAX_PER_SKILL_LOG_BYTES) return;
  try { await fsp.rm(filepath + '.1', { force: true }); } catch {}
  try { await fsp.rename(filepath, filepath + '.1'); } catch {}
}

async function writeLine(userId, skillId, entry) {
  const dir = skillLogDir(userId, skillId);
  const p = skillLogPath(userId, skillId);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await rotateIfNeeded(p);
    await fsp.appendFile(p, JSON.stringify(entry) + '\n');
  } catch (e) {
    // Logging must never throw. Fall back to OE's main log so we don't lose
    // the entry entirely.
    oeLog.warn(`skill:${skillId}`, 'per-skill log write failed', { err: e.message });
  }
}

/**
 * Build the ctx.log object handed to a skill's execute.mjs.
 * The skillId is bound at construction so the skill author doesn't have to
 * pass it on every call.
 */
export function buildSkillLogger({ userId, skillId, agentId }) {
  const emit = (level, msg, meta) => {
    const safeMsg = String(msg ?? '');
    const entry = { ts: new Date().toISOString(), level, msg: safeMsg, agentId };
    if (meta && typeof meta === 'object') entry.meta = meta;
    // Mirror to OE's main app.log so cross-skill queries still see it.
    const oeMeta = { ...(meta || {}), agentId };
    if (level === 'error') oeLog.error(`skill:${skillId}`, safeMsg, oeMeta);
    else if (level === 'warn') oeLog.warn(`skill:${skillId}`, safeMsg, oeMeta);
    else oeLog.info(`skill:${skillId}`, safeMsg, oeMeta);
    // Fire-and-forget per-skill JSONL write. Doesn't block the skill's flow.
    writeLine(userId, skillId, entry).catch(() => {});
  };
  return {
    info:  (msg, meta) => emit('info', msg, meta),
    warn:  (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
  };
}

/**
 * Forward a chunk of raw console/stderr output (captured from a sandboxed
 * skill's jail — see lib/skill-subprocess.mjs) into the skill's durable
 * per-skill log, so a run that RETURNED successfully but did the wrong thing
 * is still debuggable via skill_read_logs. Without this, console.log/warn/
 * error inside the jail (rerouted to stderr by lib/skill-host.mjs so it can't
 * corrupt the NDJSON stdout protocol) was captured by the parent but silently
 * dropped whenever the child exited with a result.
 *
 * Entries use level:'console' (distinct from info/warn/error) since this is
 * raw unstructured process output, not a `ctx.log.*` call the skill author
 * made deliberately. Never mirrored to the main app.log — jail stderr can be
 * noisy (stack traces, library warnings) and app.log is a shared resource.
 *
 * Best-effort: logging must never throw or block the caller.
 *
 * @param {{ userId: string, skillId: string, agentId?: string|null, text: string, maxBytes?: number }} opts
 */
export async function appendSkillConsoleOutput({ userId, skillId, agentId = null, text, maxBytes = 8192 }) {
  try {
    const trimmed = String(text ?? '').trim();
    if (!trimmed || !userId || !skillId) return;
    const overflow = trimmed.length - maxBytes;
    const truncated = overflow > 0
      ? `${trimmed.slice(0, maxBytes)}\n…[truncated, ${overflow} more bytes]`
      : trimmed;
    const entry = { ts: new Date().toISOString(), level: 'console', msg: truncated, agentId };
    await writeLine(userId, skillId, entry);
  } catch (e) {
    oeLog.warn(`skill:${skillId}`, 'console-output forward failed', { err: e?.message || String(e) });
  }
}

/**
 * Read recent log entries from a skill's per-skill JSONL.
 * Used by the skill_read_logs tool that Ada calls to debug misbehaving skills.
 * Mirrors the shape of logger.mjs#readLog: tail/level/since/q filters and a
 * 2 MB read cap.
 *
 * @param {{ userId: string, skillId: string, tail?: number, level?: string, since?: string|number, q?: string }} opts
 */
export async function readSkillLog(opts) {
  const { userId, skillId, tail = 100, level, since, q } = opts;
  const p = skillLogPath(userId, skillId);
  let text = '';
  let totalBytes = 0;
  try {
    const stat = await fsp.stat(p);
    totalBytes = stat.size;
    const READ_CAP = 2 * 1024 * 1024;
    if (totalBytes <= READ_CAP) {
      text = await fsp.readFile(p, 'utf8');
    } else {
      const fh = await fsp.open(p, 'r');
      try {
        const buf = Buffer.alloc(READ_CAP);
        await fh.read(buf, 0, READ_CAP, totalBytes - READ_CAP);
        const str = buf.toString('utf8');
        const firstNl = str.indexOf('\n');
        text = firstNl === -1 ? str : str.slice(firstNl + 1);
      } finally {
        await fh.close();
      }
    }
  } catch {
    return { entries: [], totalBytes: 0, skillId };
  }
  let entries = [];
  for (const raw of text.split('\n')) {
    if (!raw) continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && obj.ts && obj.level && obj.msg !== undefined) entries.push(obj);
    } catch {
      entries.push({ ts: null, level: 'info', msg: raw });
    }
  }
  if (level) entries = entries.filter(e => e.level === level);
  if (since) {
    const sinceMs = typeof since === 'number' ? since : Date.parse(since);
    if (!Number.isNaN(sinceMs)) {
      entries = entries.filter(e => {
        const t = e.ts ? Date.parse(e.ts) : 0;
        return t >= sinceMs;
      });
    }
  }
  if (q) {
    const needle = String(q).toLowerCase();
    entries = entries.filter(e =>
      (e.msg ?? '').toLowerCase().includes(needle) ||
      (e.meta ? JSON.stringify(e.meta).toLowerCase().includes(needle) : false)
    );
  }
  const n = Math.max(1, Math.min(5000, Number(tail) || 100));
  if (entries.length > n) entries = entries.slice(entries.length - n);
  return { entries, totalBytes, skillId };
}
