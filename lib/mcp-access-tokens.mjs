// @ts-check
/**
 * Personal access tokens for the OUTBOUND MCP server (/mcp endpoint).
 *
 * These let external MCP clients (Claude Code, Claude Desktop, Cursor,
 * scripts) call a user's OE agents and memory with a long-lived bearer
 * token, without ever holding an OE session token.
 *
 * Token format:  oemcp_<id>_<secret>
 *   - id: 8 hex chars — public, indexes the store record (O(1) lookup,
 *     shows up in audit logs and the Settings list).
 *   - secret: 40 hex chars (160 bits from crypto randomBytes).
 *
 * Storage: BASE_DIR/mcp-access-tokens.json (0600). Only the SHA-256 of the
 * full raw token is stored — the raw token is shown exactly once at
 * creation. SHA-256 (not scrypt) is deliberate: scrypt exists to slow
 * brute-force of low-entropy human passwords; a 160-bit random secret is
 * not brute-forceable, and a fast hash keeps per-request auth free.
 *
 * Test isolation: BASE_DIR comes from lib/paths.mjs, which redirects to a
 * tmp dir under vitest — this module must never derive its own base path.
 */
import fs from 'fs';
import path from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { BASE_DIR } from './paths.mjs';

const STORE_PATH = path.join(BASE_DIR, 'mcp-access-tokens.json');
const TOKEN_RE = /^oemcp_([0-9a-f]{8})_([0-9a-f]{40})$/;

export const VALID_SCOPES = ['chat', 'memory-read', 'memory-write'];

/**
 * @typedef {object} AccessTokenRecord
 * @property {string} id            8-hex public id
 * @property {string} userId        owner — the ONLY user this token can act as
 * @property {string} name          user-chosen label ("laptop claude code")
 * @property {string} sha256        hex sha256 of the full raw token
 * @property {string[]} scopes      subset of VALID_SCOPES
 * @property {string|null} agentId  optional binding: token can only talk to this agent
 * @property {string} createdAt     ISO
 * @property {string|null} lastUsedAt ISO, throttled to ~1/min
 */

/** @returns {AccessTokenRecord[]} */
function loadStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { console.warn('[mcp-tokens] failed to load store:', e.message); }
  return [];
}

/** @param {AccessTokenRecord[]} list */
function saveStore(list) {
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
  // mode only applies on create — re-chmod so perms don't drift after restore/rsync
  try { fs.chmodSync(STORE_PATH, 0o600); } catch {}
}

function sha256Hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** Strip the hash before anything leaves this module. */
function sanitize(rec) {
  const { sha256, ...rest } = rec;
  return rest;
}

/**
 * Mint a new token for a user. Returns the raw token — the only time it is
 * ever available in plaintext. Caller (route) shows it to the user once.
 *
 * @param {string} userId
 * @param {{name?: string, scopes?: string[], agentId?: string|null}} opts
 * @returns {{token: string, record: Omit<AccessTokenRecord,'sha256'>}}
 */
export function createAccessToken(userId, { name = '', scopes = ['chat', 'memory-read'], agentId = null } = {}) {
  if (!userId) throw new Error('userId is required');
  const cleanScopes = [...new Set(scopes)].filter(s => VALID_SCOPES.includes(s));
  if (cleanScopes.length === 0) throw new Error(`scopes must include at least one of: ${VALID_SCOPES.join(', ')}`);
  const cleanName = String(name || '').trim().slice(0, 60) || 'unnamed token';
  const id = randomBytes(4).toString('hex');
  const secret = randomBytes(20).toString('hex');
  const token = `oemcp_${id}_${secret}`;
  /** @type {AccessTokenRecord} */
  const record = {
    id, userId,
    name: cleanName,
    sha256: sha256Hex(token),
    scopes: cleanScopes,
    agentId: agentId ? String(agentId) : null,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  const list = loadStore();
  list.push(record);
  saveStore(list);
  return { token, record: sanitize(record) };
}

/**
 * List a user's tokens (hashes stripped).
 * @param {string} userId
 */
export function listAccessTokens(userId) {
  return loadStore().filter(t => t.userId === userId).map(sanitize);
}

/**
 * Revoke one token by id — only if it belongs to userId.
 * @param {string} userId
 * @param {string} tokenId
 * @returns {boolean} true if a token was removed
 */
export function revokeAccessToken(userId, tokenId) {
  const list = loadStore();
  const next = list.filter(t => !(t.id === tokenId && t.userId === userId));
  if (next.length === list.length) return false;
  saveStore(next);
  return true;
}

// lastUsedAt writes are throttled: a busy client shouldn't rewrite the
// store file on every request. In-memory map of id → last persisted ms.
const _lastTouch = new Map();
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Resolve a raw bearer token to its record, or null. Timing-safe hash
 * compare; touches lastUsedAt (throttled).
 *
 * @param {string|null|undefined} raw
 * @returns {Omit<AccessTokenRecord,'sha256'>|null}
 */
export function resolveAccessToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(TOKEN_RE);
  if (!m) return null;
  const rec = loadStore().find(t => t.id === m[1]);
  if (!rec) return null;
  const expected = Buffer.from(rec.sha256, 'hex');
  const actual = createHash('sha256').update(raw).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  const now = Date.now();
  if ((now - (_lastTouch.get(rec.id) ?? 0)) > TOUCH_INTERVAL_MS) {
    _lastTouch.set(rec.id, now);
    try {
      const list = loadStore();
      const live = list.find(t => t.id === rec.id);
      if (live) { live.lastUsedAt = new Date(now).toISOString(); saveStore(list); }
    } catch (e) { console.warn('[mcp-tokens] lastUsedAt touch failed:', e.message); }
  }
  return sanitize(rec);
}
