/**
 * Shared helpers used across all route modules.
 *
 * This file is the public barrel — routes import everything from here.
 * Larger concerns are extracted to _helpers/*.mjs:
 *   - _helpers/paths.mjs           — path constants, getUserDir
 *   - _helpers/io-lock.mjs         — withLock, atomicWriteSync, makeModify
 *   - _helpers/broadcast.mjs       — setBroadcastFn, broadcastAgentList, etc.
 *   - _helpers/auth-sessions.mjs   — sessions, media tokens, tickets, passwords
 *   - _helpers/agent-resolver.mjs  — getAgentsForUser, prompt composition
 *   - _helpers/expenses-activity.mjs — expense groups/books, activity, token cost
 *
 * What stays here: config, users, notes, invites, http, wire format,
 * small parsers — the bits most routes touch.
 */

import fs from 'fs';
import path from 'path';
import {
  BASE_DIR, USERS_DIR, CFG_PATH, NOTES_PATH, INVITES_PATH, BODY_LIMIT,
  getUserDir,
} from './_helpers/paths.mjs';
import { withLock, atomicWriteSync, makeModify } from './_helpers/io-lock.mjs';
import { listAgents, getAgent, getAgentScope, loadCustomAgents, updateAgentMeta, invalidateModelOverridesCache } from '../agents.mjs';
import { getDefaultRoles, listRoles, getRoleAssignments } from '../roles.mjs';
import { log } from '../logger.mjs';

// ── Re-export path constants and leaf helpers ────────────────────────────────
export {
  BASE_DIR, APP_NAME, APP_BASE_DIR, safeId,
  CFG_PATH, USERS_PATH, USERS_DIR, ACTIVITY_DIR,
  getUserDir, NOTES_PATH, INVITES_PATH, SESSIONS_PATH,
  EXPENSES_DB, EXPENSES_UPLOADS, EXPENSE_GROUPS_PATH, EXPENSE_BOOKS_PATH,
  BODY_LIMIT,
} from './_helpers/paths.mjs';
export { withLock, atomicWriteSync } from './_helpers/io-lock.mjs';

// ── Parse a multipart/form-data body and return the first file part ──────────
export function parseMultipart(raw, boundary) {
  const sep = Buffer.from('--' + boundary);
  const parts = [];
  let start = 0;
  while (start < raw.length) {
    const sepIdx = raw.indexOf(sep, start);
    if (sepIdx === -1) break;
    const end = raw.indexOf(sep, sepIdx + sep.length);
    const part = raw.slice(sepIdx + sep.length, end === -1 ? raw.length : end);
    if (part.length > 4) parts.push(part);
    start = sepIdx + sep.length;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd).toString();
    const body = part.slice(headerEnd + 4, part.length - 2);
    if (!headers.includes('filename=')) continue;
    const fileName = (headers.match(/filename="([^"]+)"/) ?? [])[1] ?? 'upload';
    const mimeType = (headers.match(/Content-Type:\s*([^\r\n]+)/) ?? [])[1]?.trim() ?? 'application/octet-stream';
    return { fileData: body, fileName, mimeType };
  }
  return null;
}

/** Log the full error server-side, return a generic message to the client. */
export function safeError(res, e, status = 500) {
  console.error(`[${status}]`, e);
  try {
    const meta = { status, err: e?.message ?? String(e) };
    if (e?.stack) meta.stack = e.stack.split('\n').slice(0, 4).join(' | ');
    log.error('http', `${status} error`, meta);
  } catch {}
  if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Internal error' }));
}

// ── Config cache ─────────────────────────────────────────────────────────────
let _cfgCache = null;
let _cfgMtime = 0;

// Environment variable → config key mapping.
// Env vars take precedence over config.json values.
const ENV_MAP = {
  ANTHROPIC_API_KEY:   'anthropicApiKey',
  BRAVE_API_KEY:       'braveApiKey',
  FIREWORKS_API_KEY:   'fireworksApiKey',
  GROK_API_KEY:        'grokApiKey',
  OPENROUTER_API_KEY:  'openrouterApiKey',
  OLLAMA_API_KEY:      'ollamaApiKey',
  OE_SESSION_EXPIRY:   'sessionExpiryHours',
  OE_VISION_PROVIDER:  'visionProvider',
  OE_VISION_MODEL:     'visionModel',
};

export function loadConfig() {
  let cfg;
  try {
    const stat = fs.statSync(CFG_PATH);
    if (_cfgCache && stat.mtimeMs === _cfgMtime) cfg = _cfgCache;
    else {
      cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      _cfgCache = cfg;
      _cfgMtime = stat.mtimeMs;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[config] Failed to load config.json:', e.message);
    cfg = {};
  }
  // Overlay environment variables (takes precedence)
  for (const [envKey, cfgKey] of Object.entries(ENV_MAP)) {
    if (process.env[envKey]) cfg[cfgKey] = process.env[envKey];
  }
  return cfg;
}

export function saveConfig(cfg) {
  atomicWriteSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  _cfgCache = cfg;
  try { _cfgMtime = fs.statSync(CFG_PATH).mtimeMs; } catch (e) { console.warn('[config] stat after save failed:', e.message); }
}

// ── User store ───────────────────────────────────────────────────────────────
let _usersCache = null;
let _usersDirMtime = 0;

export function loadUsers() {
  const dir = path.join(BASE_DIR, 'users');
  if (!fs.existsSync(dir)) return [];
  try {
    // Invalidate if the users/ directory itself changed (user added/removed)
    const dirMtime = fs.statSync(dir).mtimeMs;
    if (_usersCache && dirMtime === _usersDirMtime) return _usersCache;

    const users = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profilePath = path.join(dir, entry.name, 'profile.json');
      try { users.push(JSON.parse(fs.readFileSync(profilePath, 'utf8'))); }
      catch (e) { console.warn('[users] Failed to parse profile for', entry.name + ':', e.message); }
    }
    _usersCache = users;
    _usersDirMtime = dirMtime;
    return users;
  } catch (e) {
    // Throw rather than return empty — an empty list would silently break all permission checks
    console.error('[users] CRITICAL: Failed to read users directory:', e.message);
    throw e;
  }
}

/** Invalidate users cache — call after any user profile write. */
export function invalidateUsersCache() { _usersCache = null; _usersDirMtime = 0; }
/** Write a single user's profile — does not touch any other files in their directory. */
export function saveUser(user) {
  const dir = getUserDir(user.id);
  fs.mkdirSync(dir, { recursive: true });
  atomicWriteSync(path.join(dir, 'profile.json'), JSON.stringify(user, null, 2));
  invalidateUsersCache();
}

/** Bulk save — used when the user list itself changes (create/delete). Removes dirs for deleted users. */
export function saveUsers(list) {
  const currentIds = new Set(list.map(u => u.id));
  for (const user of list) saveUser(user);
  // Remove subdirs for users no longer in the list
  try {
    for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!currentIds.has(entry.name)) fs.rmSync(path.join(USERS_DIR, entry.name), { recursive: true, force: true });
    }
  } catch {}
}
export function getUser(id) {
  if (!id) return null;
  const p = path.join(getUserDir(id), 'profile.json');
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn('[users] Failed to load user', id + ':', e.message); }
  return null;
}
export function getUserRole(id) { return getUser(id)?.role ?? 'user'; }
export function getUserCoordinatorAgentId(userId) {
  return getRoleAssignments(userId)['coordinator'] ?? null;
}
export function isPrivileged(id) { const r = getUserRole(id); return r === 'owner' || r === 'admin'; }
export function isTimeBlocked(schedule) {
  if (!schedule?.blockedFrom || !schedule?.blockedUntil) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [fH, fM] = schedule.blockedFrom.split(':').map(Number);
  const [uH, uM] = schedule.blockedUntil.split(':').map(Number);
  const from = fH * 60 + fM;
  const until = uH * 60 + uM;
  return from > until ? (cur >= from || cur < until) : (cur >= from && cur < until);
}

// Convenience wrapper — fetches the user's schedule and evaluates it now.
// Returns false for unknown users / privileged users (they are never blocked).
export function isUserTimeBlocked(userId) {
  if (!userId) return false;
  const u = getUser(userId);
  if (!u) return false;
  if (u.role === 'owner' || u.role === 'admin') return false;
  return isTimeBlocked(u.accessSchedule);
}

// ── Shared notes ─────────────────────────────────────────────────────────────
export function loadNotes() {
  try { if (fs.existsSync(NOTES_PATH)) return JSON.parse(fs.readFileSync(NOTES_PATH, 'utf8')); } catch (e) { console.warn('[notes] Failed to load shared-notes.json:', e.message); }
  return { content: '', updatedAt: null, updatedBy: null };
}
export function saveNotes(notes) { try { fs.writeFileSync(NOTES_PATH, JSON.stringify(notes, null, 2)); } catch (e) { console.warn('[notes] Failed to save shared-notes.json:', e.message); } }

// ── Invites ──────────────────────────────────────────────────────────────────
export function loadInvites() {
  try { if (fs.existsSync(INVITES_PATH)) return JSON.parse(fs.readFileSync(INVITES_PATH, 'utf8')); } catch (e) { console.warn('[invites] Failed to load invites.json:', e.message); }
  return [];
}
export function saveInvites(list) { try { fs.writeFileSync(INVITES_PATH, JSON.stringify(list, null, 2)); } catch (e) { console.warn('[invites] Failed to save invites.json:', e.message); } }

// ── Request body ─────────────────────────────────────────────────────────────
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '', size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) { req.destroy(); reject(new Error('Request too large')); return; }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// ── Wire format ──────────────────────────────────────────────────────────────
export function agentToWire(a) {
  return { id: a.id, name: a.name, emoji: a.emoji, model: a.model,
           provider: a.provider ?? 'ollama', custom: !!a.custom,
           toolSet: a.toolSet ?? 'web', description: a.description ?? '',
           scope: a.scope ?? 'private', skillCategory: a.skillCategory ?? null,
           outputDir: a.outputDir ?? null,
           maxTokens: a.maxTokens ?? null,
           contextSize: a.contextSize ?? 32768 };
}

// ── News preference detection ────────────────────────────────────────────────
const NEWS_TOPIC_LABELS = ['top', 'politics', 'tech', 'crypto', 'markets'];
export function detectNewsPref(text) {
  const patterns = [
    /(?:set|change|update)\s+(?:my\s+)?(?:news|default\s+news|news\s+topic)\s+(?:to|preference\s+to|topic\s+to)\s+(\w+)/i,
    /(?:i\s+(?:want|prefer|like))\s+(\w+)\s+news/i,
    /(?:news\s+preference|default\s+topic)[:\s]+(\w+)/i,
    /show\s+me\s+(\w+)\s+news\s+by\s+default/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const word = m[1].toLowerCase();
      const idx = NEWS_TOPIC_LABELS.findIndex(l => word.startsWith(l) || l.startsWith(word));
      if (idx !== -1) return idx;
    }
  }
  return null;
}

// ── Rename/emoji detection ───────────────────────────────────────────────────
export function detectRenameCommand(text) {
  const clean = text.trim();
  const namePatterns = [
    /(?:rename yourself|change your name)\s+to\s+["']?([A-Za-z][A-Za-z0-9 '_-]{0,29})["']?/i,
    /(?:your name is now|from now on (?:your name is|you(?:'re| are)|go by))\s+["']?([A-Za-z][A-Za-z0-9 '_-]{0,29})["']?/i,
    /call yourself\s+["']?([A-Za-z][A-Za-z0-9 '_-]{0,29})["']?/i,
  ];
  const emojiPattern = /(?:your emoji is|change your (?:icon|emoji) to)\s+(\S+)/i;
  let name = null, emoji = null;
  for (const p of namePatterns) {
    const m = clean.match(p);
    if (m) { name = m[1].trim(); break; }
  }
  const em = clean.match(emojiPattern);
  if (em) emoji = em[1].trim();
  return (name || emoji) ? { name, emoji } : null;
}

// ── Locked modify helpers ─────────────────────────────────────────────────────
export const modifyUsers     = makeModify(loadUsers,     saveUsers,     USERS_DIR);

/** Modify a single user's profile — only writes that user's profile.json. */
export function modifyUser(userId, fn) {
  const profilePath = path.join(getUserDir(userId), 'profile.json');
  return withLock(profilePath, () => {
    const user = getUser(userId);
    if (!user) throw new Error(`User ${userId} not found`);
    fn(user);
    saveUser(user);
    return user;
  });
}
export const modifyConfig    = makeModify(loadConfig,    saveConfig,    CFG_PATH);
export const modifyInvites   = makeModify(loadInvites,   saveInvites,   INVITES_PATH);

// ── Barrel re-exports from extracted submodules ──────────────────────────────
export {
  setBroadcastFn, broadcastAgentList, setUserBroadcastFn, broadcastToUsers,
} from './_helpers/broadcast.mjs';

export {
  validatePassword, hashPassword, verifyPassword,
  loadPersistedSessions, createSession, getSessionUserId, deleteSession,
  clearUserSessions, clearUserSessionsExcept, getUserSessions, revokeSessionByPrefix,
  getAuthToken, getUrlToken,
  createMediaToken, consumeMediaToken,
  createTicket, consumeTicket,
  requireAuth, requirePrivileged,
} from './_helpers/auth-sessions.mjs';

export {
  loadExpGroups, saveExpGroups, getExpGroupForUser, getExpGroupMemberIds,
  loadExpBooks, saveExpBooks, getExpBooksForUser,
  modifyExpGroups, modifyExpBooks,
  resolveShareGroup,
  loadActivity, saveActivity, modifyActivity, recordActivity, recordTokenUsage,
} from './_helpers/expenses-activity.mjs';

export {
  getDefaultChildSafetyPrompt, getUserEnabledSkills,
  getAgentsForUser, getAgentForUser, saveUserAgentOverride,
} from './_helpers/agent-resolver.mjs';

// Re-export agent/role functions used by routes
export { getAgent, getAgentScope, loadCustomAgents, updateAgentMeta, invalidateModelOverridesCache, listAgents, listRoles, getDefaultRoles };
