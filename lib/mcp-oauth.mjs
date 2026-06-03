// @ts-check
/**
 * OAuth 2.1 + PKCE provider for MCP, implementing the SDK's
 * OAuthClientProvider interface with file-backed encrypted storage.
 *
 * Tokens and PKCE state live at:
 *   users/<ownerId>/mcp-oauth-<serverId>.json
 * encrypted with the same envelope as the rest of the per-user secrets.
 *
 * Flow:
 *   1. UI calls POST /api/mcp/servers/:id/oauth/start.
 *      Route instantiates this provider and calls SDK's `auth(provider, {serverUrl})`.
 *      SDK discovers metadata, runs Dynamic Client Registration (if supported),
 *      generates PKCE, and calls `provider.redirectToAuthorization(url)`.
 *      We capture the URL here. Route returns `{authUrl, state}` to UI.
 *   2. UI opens authUrl in a popup. User authorizes on the provider.
 *      Provider redirects to `<oe>/api/mcp/oauth/callback?code=...&state=...`.
 *   3. Callback route looks up the (ownerId, serverId) from the in-memory
 *      pending-state map, instantiates the provider, and calls
 *      `auth(provider, {serverUrl, authorizationCode: code})`.
 *      SDK exchanges code for tokens; `provider.saveTokens()` persists them.
 *   4. Future HTTP requests inject the bearer token automatically because
 *      StreamableHTTPClientTransport was given the same provider as `authProvider`.
 *
 * Token refresh is handled transparently by the SDK — it calls
 * `provider.tokens()` before each request and refreshes when the access
 * token nears expiry, calling `provider.saveTokens()` with the new pair.
 *
 * Threat model: tokens are encrypted at rest under the system master key
 * (config-secrets.mjs). The OS account running OE can read them; that's
 * the boundary, same as everywhere else.
 */
import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { readEncryptedJsonFile, writeEncryptedJsonFile } from './encrypted-file.mjs';

export class OeOAuthProvider {
  constructor({ ownerUserId, serverId, redirectOrigin, scope = '' }) {
    /** @type {string} */
    this.ownerUserId = ownerUserId;
    /** @type {string} */
    this.serverId = serverId;
    /** @type {string} — e.g. `https://192.168.1.50:3739` */
    this.redirectOrigin = redirectOrigin;
    /** @type {string} */
    this.scope = scope;
    /** @type {URL|null} — captured by redirectToAuthorization(). The route reads this back. */
    this.lastAuthorizationUrl = null;
  }

  /** @returns {string} */
  get redirectUrl() {
    return `${this.redirectOrigin}/api/mcp/oauth/callback`;
  }

  get clientMetadata() {
    return {
      client_name: 'OpenEnsemble',
      client_uri: this.redirectOrigin,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  _file() {
    return path.join(USERS_DIR, this.ownerUserId, `mcp-oauth-${this.serverId}.json`);
  }

  _load() {
    const p = this._file();
    if (!fs.existsSync(p)) return {};
    try { return readEncryptedJsonFile(p); }
    catch (e) { console.warn(`[mcp-oauth] read ${p} failed:`, e.message); return {}; }
  }

  _save(data) {
    const p = this._file();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeEncryptedJsonFile(p, data, { mode: 0o600 });
  }

  clientInformation() { return this._load().clientInformation; }

  saveClientInformation(info) {
    const data = this._load();
    data.clientInformation = info;
    this._save(data);
  }

  tokens() { return this._load().tokens; }

  saveTokens(t) {
    const data = this._load();
    data.tokens = t;
    this._save(data);
  }

  codeVerifier() {
    const v = this._load().codeVerifier;
    if (!v) throw new Error('PKCE code_verifier not found (start the OAuth flow first)');
    return v;
  }

  saveCodeVerifier(v) {
    const data = this._load();
    data.codeVerifier = v;
    this._save(data);
  }

  /**
   * Called by the SDK during the start phase. We can't actually redirect
   * the user (this is server-side code) — we capture the URL and let the
   * route hand it back to the browser to open.
   * @param {URL} url
   */
  redirectToAuthorization(url) {
    this.lastAuthorizationUrl = url;
  }
}

// ── Pending-state map for the callback route ──────────────────────────────────
// Maps the OAuth `state` parameter to the (userId, serverId) that initiated
// the flow. 10-min TTL — if the user takes longer to authorize, they re-start.
//
// Why in-memory (not encrypted file): the state token already comes back
// signed-with-PKCE-via-codeVerifier, so a leaked state token alone isn't
// useful without also reading the same user's encrypted oauth file. And
// the lifetime is short enough that server restart invalidating pending
// flows is acceptable (user just clicks Authorize again).
const _pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

export function registerPendingState(state, payload) {
  _pending.set(state, { ...payload, expiresAt: Date.now() + PENDING_TTL_MS });
}

export function consumePendingState(state) {
  const entry = _pending.get(state);
  if (!entry) return null;
  _pending.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

// Periodically sweep expired entries so the map can't grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _pending) if (v.expiresAt < now) _pending.delete(k);
}, 60 * 1000).unref?.();
