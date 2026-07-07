// @ts-check
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
 *
 * Type-checked. Public helpers (loadConfig, loadUsers, saveUsers,
 * modifyUser, etc.) carry JSDoc so callers in routes/* get type errors
 * at edit time. The 2026-05-26 master-key incident was the kind of bug
 * this catches: a saveUsers call from a single-field-mutation site.
 */

import fs from 'fs';
import path from 'path';
import {
  BASE_DIR, USERS_DIR, CFG_PATH, NOTES_PATH, INVITES_PATH, BODY_LIMIT,
  getUserDir,
} from './_helpers/paths.mjs';
import { withLock, atomicWriteSync, makeModify } from './_helpers/io-lock.mjs';
import { resolveClientIp } from './_helpers/client-ip.mjs';
import { getSessionUserId as _gsuid, getAuthToken as _gtok } from './_helpers/auth-sessions.mjs';
import { encryptConfigSecrets, decryptedConfigView, encryptProfileSecrets, decryptedProfileView } from '../lib/config-secrets.mjs';
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
export { getSecret, decryptedConfigView, inspectSecrets } from '../lib/config-secrets.mjs';

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

// Resolve the real client IP for rate-limiting. X-Forwarded-For / CF-Connecting-IP
// are honoured ONLY when the request arrived from a trusted proxy
// (config.security.trustedProxies); otherwise the (unspoofable) socket peer is
// used. Defaults to loopback so same-machine nginx works out of the box — add
// your reverse-proxy's address for a separate-box setup. See _helpers/client-ip.mjs.
const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1'];
export function getClientIp(req) {
  const cfg = loadConfig();
  const configured = cfg?.security?.trustedProxies;
  const trusted = Array.isArray(configured) && configured.length ? configured : DEFAULT_TRUSTED_PROXIES;
  return resolveClientIp(req, trusted) || 'unknown';
}

export function loadConfig() {
  let cfg;
  try {
    const stat = fs.statSync(CFG_PATH);
    if (_cfgCache && stat.mtimeMs === _cfgMtime) cfg = _cfgCache;
    else {
      const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
      // Decrypt registered secret paths into the in-memory cache so existing
      // call sites that do `cfg.anthropicApiKey` keep working without code
      // changes. Encryption-on-write happens in saveConfig (encryptConfigSecrets).
      // Disk stays encrypted; RAM is plaintext (same as it always was).
      // Decryption failures fall back to '' so a missing/rotated system key
      // doesn't crash the server — the affected provider just acts unconfigured.
      try { cfg = decryptedConfigView(raw); }
      catch (e) {
        console.warn('[config] decrypt-on-load failed; using raw config:', e.message);
        cfg = raw;
      }
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
  // Disk side: clone, encrypt secrets, write. Memory side: keep `cfg` (with
  // plaintext secrets) as the cache so the next loadConfig hit doesn't have
  // to round-trip through decrypt. Disk stays encrypted; RAM stays plaintext.
  // Fail closed: if encryption fails (missing/corrupt master key, etc.),
  // refuse to write rather than silently downgrading secrets to plaintext.
  const toWrite = JSON.parse(JSON.stringify(cfg));
  try {
    encryptConfigSecrets(toWrite);
  } catch (e) {
    log.error('config', 'secret encryption failed; refusing to save', { err: e.message });
    throw new Error(`Refusing to save config — secret encryption failed: ${e.message}`);
  }
  atomicWriteSync(CFG_PATH, JSON.stringify(toWrite, null, 2));
  _cfgCache = cfg;
  try { _cfgMtime = fs.statSync(CFG_PATH).mtimeMs; } catch (e) { console.warn('[config] stat after save failed:', e.message); }
}

// ── User store ───────────────────────────────────────────────────────────────

/**
 * Profile shape stored at users/{id}/profile.json. Many optional fields
 * — only `id` is guaranteed at every call site. Extra fields outside this
 * list are tolerated; routes/users.mjs and Settings UI add more over time.
 *
 * @typedef {object} User
 * @property {string} id                       canonical user id, `user_xxxxxxxx`
 * @property {string} [name]
 * @property {string} [email]
 * @property {'owner'|'admin'|'user'|'child'} [role]
 * @property {string[]} [skills]               role ids the user has enabled
 * @property {object} [agentOverrides]         per-agent field overrides keyed by agentId
 * @property {Record<string, any>} [skillAssignments]
 * @property {number} [newsDefaultTopic]
 * @property {object} [telegram]
 * @property {string} [telegramChatId]         legacy; superseded by telegram.chatId
 * @property {string} [reminderEmailId]
 * @property {string} [reminderVoiceDeviceId]
 * @property {string[]} [allowedSkills]        restricts which skills user can enable
 * @property {string[]} [allowedModels]
 * @property {string[]} [allowedOAuthProviders]
 * @property {boolean} [skillsLocked]
 * @property {{blockedFrom?: string, blockedUntil?: string}} [accessSchedule]  child-safety curfew, HH:MM
 */

/** @type {User[] | null} */
let _usersCache = null;
let _usersDirMtime = 0;

/**
 * Return every user profile under users/{id}/profile.json. Caches by the
 * users/ dir mtime so adding/removing a user invalidates automatically.
 * @returns {User[]}
 */
export function loadUsers() {
  const dir = path.join(BASE_DIR, 'users');
  if (!fs.existsSync(dir)) return [];
  try {
    // Invalidate if the users/ directory itself changed (user added/removed)
    const dirMtime = fs.statSync(dir).mtimeMs;
    if (_usersCache && dirMtime === _usersDirMtime) return _usersCache;

    const users = [];
    let profileDirsSeen = 0;
    let failedDirs = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // Skip the system-only dirs (_system holds the master key, etc.).
      // They have no profile.json on purpose; don't count as a "failed parse."
      if (entry.name.startsWith('_')) continue;
      const profilePath = path.join(dir, entry.name, 'profile.json');
      // Dirs without profile.json belong to fixture/test users; don't count
      // as a failure either. Only dirs that DO have a profile.json that
      // failed to parse count as a real read failure.
      if (!fs.existsSync(profilePath)) continue;
      profileDirsSeen++;
      try { users.push(decryptedProfileView(JSON.parse(fs.readFileSync(profilePath, 'utf8')))); }
      catch (e) {
        console.warn('[users] Failed to parse profile for', entry.name + ':', e.message);
        failedDirs.push(entry.name);
      }
    }

    // Anti-foot-gun: if every profile failed to parse (was producing the
    // setup-page lockout when a transient FS or decrypt glitch hit ALL
    // profiles in one read), don't poison the cache with an empty list.
    // Two recovery paths:
    //   1. If we have a prior good cache, keep returning it. Whatever
    //      glitched will heal on the next dir-mtime change.
    //   2. If no prior cache and dirs exist but none parsed, throw —
    //      callers will surface an error rather than silently treating
    //      the install as fresh.
    if (users.length === 0 && profileDirsSeen > 0) {
      console.error(`[users] CRITICAL: all ${profileDirsSeen} profile(s) failed to parse (${failedDirs.join(', ')}). Refusing to cache empty list.`);
      if (_usersCache && _usersCache.length > 0) {
        console.error('[users] Falling back to last good cache to avoid setup-page lockout.');
        return _usersCache;
      }
      throw new Error(`Refusing to return empty users list when ${profileDirsSeen} profile dirs exist on disk`);
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
/**
 * Write a single user's profile — does not touch any other files in their
 * directory. Use this (or `modifyUser`) instead of `saveUsers` when you're
 * only mutating one user.
 * @param {User} user
 */
export function saveUser(user) {
  const dir = getUserDir(user.id);
  fs.mkdirSync(dir, { recursive: true });
  // Encrypt PROFILE_SECRET_PATHS (telegram.botToken, etc.) before writing.
  // Caller still passes us a plaintext user object — encryption is a disk
  // concern only. Cloning so we don't mutate the caller's reference (which
  // may keep being used after the write, e.g. modifyUser returns it).
  const onDisk = JSON.parse(JSON.stringify(user));
  encryptProfileSecrets(onDisk);
  atomicWriteSync(path.join(dir, 'profile.json'), JSON.stringify(onDisk, null, 2));
  invalidateUsersCache();
}

/**
 * Bulk save — used when the user LIST ITSELF changes (i.e. a user was added
 * or removed). For a single user's field change, ALWAYS prefer `modifyUser`
 * (locked, surgical, writes one profile.json) over `saveUsers(loadUsers())`.
 *
 * Why this matters: this function rewrites every profile.json AND runs an
 * orphan-cleanup sweep over every subdir of `users/`. Callers that just want
 * to flip one field on one user (news pref, agent rename, /claim, telegram
 * link) used to come in here, triggering a full-directory GC every time.
 * The 2026-05-26 master-key incident traced back to exactly that pattern.
 *
 * The orphan-cleanup loop is now scoped to `user_*` directories so even
 * legitimate uses can't touch system-reserved dirs (`_system/`, `default/`,
 * any `_*`-prefixed system dir). But the safer rule is: don't reach for
 * saveUsers at all unless you're adding or removing a user. modifyUser is
 * the right hammer for everything else.
 *
 * @param {User[]} list
 */
export function saveUsers(list) {
  const currentIds = new Set(list.map(u => u.id));
  for (const user of list) saveUser(user);
  // Remove subdirs for users no longer in the list — but only directories
  // that actually look like user IDs. Anything else (`_system`, `_admin`,
  // `default`, etc.) is system-reserved and never managed by this function.
  try {
    for (const entry of fs.readdirSync(USERS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith('user_')) continue;
      if (!currentIds.has(entry.name)) fs.rmSync(path.join(USERS_DIR, entry.name), { recursive: true, force: true });
    }
  } catch {}
}
/**
 * Load one user's profile by id. Returns null if not found / unreadable.
 * @param {string|null|undefined} id
 * @returns {User|null}
 */
export function getUser(id) {
  if (!id) return null;
  const p = path.join(getUserDir(id), 'profile.json');
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      // Decrypt PROFILE_SECRET_PATHS so callers see plaintext (telegram send,
      // webhook validate). Legacy plaintext profile.json passes through
      // unchanged — the envelope detector skips non-encrypted fields.
      return decryptedProfileView(parsed);
    }
  }
  catch (e) { console.warn('[users] Failed to load user', id + ':', e.message); }
  return null;
}
/** @param {string|null|undefined} id @returns {'owner'|'admin'|'user'|'child'} */
export function getUserRole(id) { return getUser(id)?.role ?? 'user'; }

// True if the request's authenticated caller is a child account. Used to lock
// children out of voice-device management (an admin manages those for them).
// No response is written — the caller decides what to do (typically 403).
export function isChildRequest(req) {
  const uid = _gsuid(_gtok(req));
  return uid ? getUserRole(uid) === 'child' : false;
}

/**
 * Strip secrets before sending a user object to the browser. SINGLE chokepoint —
 * any secret added to the profile MUST be masked HERE. getUser()/loadUsers()
 * return profiles with secrets decrypted for runtime use (telegram bot token /
 * webhook secret, password/pin hashes); never echo those to JS, or an XSS bug
 * elsewhere could exfiltrate the live token. chatId + "is it configured" are safe.
 */
export function sanitizeUserForWire(user) {
  if (!user || typeof user !== 'object') return user;
  const { passwordHash, pinHash, telegram, ...rest } = user;
  const safe = { ...rest, hasPin: !!pinHash };
  if (telegram) safe.telegram = { configured: !!telegram.botToken, chatId: telegram.chatId ?? null };
  return safe;
}
/** @param {string} userId @returns {string|null} */
export function getUserCoordinatorAgentId(userId) {
  return getRoleAssignments(userId)['coordinator'] ?? null;
}
/** @param {string|null|undefined} id @returns {boolean} */
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

/**
 * Binary-safe body reader. The default readBody() concatenates chunks into a
 * string (`body += chunk`), which UTF-8-decodes them and replaces any byte
 * >= 0x80 outside a valid multi-byte sequence with U+FFFD (0xEF 0xBF 0xBD).
 * That destroys WAV/MP3/image uploads. Use this for any endpoint accepting
 * application/octet-stream or multipart/form-data with binary parts.
 */
export function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) { req.destroy(); reject(new Error('Request too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Wire format ──────────────────────────────────────────────────────────────
export function agentToWire(a) {
  return { id: a.id, name: a.name, emoji: a.emoji, model: a.model,
           provider: a.provider ?? 'ollama', custom: !!a.custom,
           toolSet: a.toolSet ?? 'web', description: a.description ?? '',
           personality: a.personality ?? '',
           scope: a.scope ?? 'private', skillCategory: a.skillCategory ?? null,
           maxTokens: a.maxTokens ?? null,
           contextSize: a.contextSize ?? 32768,
           reasoningEffort: a.reasoningEffort ?? 'auto' };
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

/**
 * Modify a single user's profile — only writes that user's profile.json,
 * locked across concurrent callers. The SURGICAL primitive for any
 * single-user mutation; reach for this instead of saveUsers(loadUsers())
 * unless you're truly changing the user LIST itself.
 *
 * @param {string} userId
 * @param {(user: User) => void} fn  mutate the user in place; return value ignored.
 * @returns {Promise<User>}
 */
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
  loadPersistedSessions, createSession, getSessionUserId, getSessionMeta, deleteSession, deleteSessionByToken,
  adoptSession,
  clearUserSessions, clearUserSessionsExcept, clearUserNodeSessions, clearUserVoiceDeviceSessions,
  getUserSessions, revokeSessionByPrefix, isPersistentDeviceKind,
  getAuthToken, getUrlToken, setSessionCookie, clearSessionCookie,
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
