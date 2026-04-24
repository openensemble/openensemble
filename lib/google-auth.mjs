/**
 * Shared Google OAuth token management.
 * Consolidates token refresh logic used by Gmail, GCal, and OAuth routes.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CREDS_PATH = path.join(BASE_DIR, 'gmail-credentials.json');

function getClientCredentials() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  return creds.installed || creds.web;
}

/**
 * Resolve the token file path for a given service/user/account.
 * @param {'gmail'|'gcal'} service
 * @param {string} [userId]
 * @param {string} [accountId]
 * @returns {string|null}
 */
export function resolveTokenPath(service, userId, accountId) {
  const userDir = userId ? path.join(BASE_DIR, 'users', userId) : null;
  if (service === 'gcal') {
    const p = userDir
      ? path.join(userDir, 'gcal-token.json')
      : path.join(BASE_DIR, 'gcal-token.json');
    return fs.existsSync(p) ? p : null;
  }
  // Gmail: try account-specific, then user-level, then global
  const candidates = [
    accountId && userDir ? path.join(userDir, `gmail-token-${accountId}.json`) : null,
    userDir ? path.join(userDir, 'gmail-token.json') : null,
    path.join(BASE_DIR, 'gmail-token.json'),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

/**
 * Refresh a Google OAuth token if expired, and return a valid access token.
 * Writes updated tokens back to disk.
 * @param {string} tokenPath - path to the token JSON file
 * @returns {Promise<string>} access_token
 */
export async function ensureFreshToken(tokenPath) {
  let tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  if (!tokens.expiry_date || Date.now() > tokens.expiry_date - 60_000) {
    const c = getClientCredentials();
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     c.client_id,
        client_secret: c.client_secret,
        refresh_token: tokens.refresh_token,
        grant_type:    'refresh_token',
      }),
    });
    const data = await res.json();
    if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
    tokens.access_token = data.access_token;
    tokens.expiry_date  = Date.now() + (data.expires_in * 1000);
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  }
  return tokens.access_token;
}

/**
 * Get a valid access token for a Google service.
 * @param {'gmail'|'gcal'} service
 * @param {string} [userId]
 * @param {string} [accountId]
 * @returns {Promise<string>}
 */
export async function getAccessToken(service, userId, accountId) {
  const tokenPath = resolveTokenPath(service, userId, accountId);
  if (!tokenPath) throw new Error(`${service} token not found for user ${userId ?? 'default'}`);
  return ensureFreshToken(tokenPath);
}

/**
 * Get an Authorization header object for Gmail API calls.
 * Drop-in replacement for the old getGmailAuthHeader.
 */
export async function getGmailAuthHeader(userId, accountId) {
  const token = await getAccessToken('gmail', userId, accountId);
  return { Authorization: `Bearer ${token}` };
}

export { getClientCredentials, CREDS_PATH, BASE_DIR as GOOGLE_AUTH_BASE_DIR };
