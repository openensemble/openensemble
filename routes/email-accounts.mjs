/**
 * Email account management + unified inbox dispatch.
 *
 * Routes:
 *   GET    /api/email-accounts           — list connected accounts
 *   POST   /api/email-accounts           — add new account (IMAP or pending Microsoft)
 *   PATCH  /api/email-accounts/:id       — rename label
 *   DELETE /api/email-accounts/:id       — remove account
 *   GET    /api/inbox?accountId=...      — unified inbox page (Gmail / MS / IMAP)
 *   GET    /api/inbox/:msgId?accountId=  — unified message body
 */

import fs   from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { requireAuth, readBody, withLock, getUserDir, safeError } from './_helpers.mjs';
import { encrypt, decrypt } from '../lib/email-crypto.mjs';
import { fetchInboxPage as fetchImapPage, fetchImapMessageBody, testConnection } from '../lib/imap-client.mjs';
import { fetchMsInboxPage, fetchMsMessageBody, msTokenPath } from '../lib/ms-graph.mjs';
import { fetchGmailInboxPage, getGmailAuthHeader } from './gmail.mjs';

const BASE_DIR  = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── Per-user account file helpers ────────────────────────────────────────────

function accountsPath(userId) {
  return path.join(getUserDir(userId), 'email-accounts.json');
}

function loadAccounts(userId) {
  const p = accountsPath(userId);
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.warn('[email-accounts] load error:', e.message); }
  return [];
}

function saveAccounts(userId, accounts) {
  fs.writeFileSync(accountsPath(userId), JSON.stringify(accounts, null, 2));
}

async function modifyAccounts(userId, fn) {
  return withLock(accountsPath(userId), () => {
    const accounts = loadAccounts(userId);
    const result = fn(accounts);
    saveAccounts(userId, accounts);
    return result;
  });
}

// ── Gmail backwards-compat seed ──────────────────────────────────────────────

export async function seedGmailAccount(userId, accountId) {
  return withLock(accountsPath(userId), () => {
    const accounts = loadAccounts(userId);
    // If called with a specific accountId, update that account's label if needed
    if (accountId) {
      if (accounts.some(a => a.id === accountId)) return; // already exists
      accounts.push({
        id: accountId,
        label: 'Gmail',
        provider: 'gmail',
        order: Date.now(),
        createdAt: new Date().toISOString(),
      });
      saveAccounts(userId, accounts);
      return;
    }
    // Legacy seed: no accountId — only seed if the user has their own gmail token
    if (accounts.some(a => a.provider === 'gmail')) return;
    const perUser = path.join(BASE_DIR, `gmail-token-${userId}.json`);
    if (!fs.existsSync(perUser)) return;
    accounts.unshift({
      id: 'acct_gmail_legacy',
      label: 'Gmail',
      provider: 'gmail',
      order: 0,
      createdAt: new Date().toISOString(),
    });
    saveAccounts(userId, accounts);
  });
}

// Strip sensitive fields before sending to client
function sanitize(account) {
  const { encryptedPassword: _ep, ...rest } = account;
  return rest;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function handle(req, res) {
  const url = new URL(req.url, 'http://x');

  // ── GET /api/email-accounts ───────────────────────────────────────────────
  if (url.pathname === '/api/email-accounts' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const accounts = loadAccounts(userId).map(sanitize);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(accounts));
    return true;
  }

  // ── POST /api/email-accounts ──────────────────────────────────────────────
  if (url.pathname === '/api/email-accounts' && req.method === 'POST') {
    const userId = requireAuth(req, res); if (!userId) return true;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }

    const { provider, label, host, port, tls, username, password,
            smtpHost, smtpPort, smtpTls, smtpUsername } = body;
    if (!provider || !label) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'provider and label required' }));
      return true;
    }

    const id = 'acct_' + randomBytes(4).toString('hex');
    let account = { id, label, provider, order: Date.now(), createdAt: new Date().toISOString() };

    if (provider === 'imap') {
      if (!host || !username || !password) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'host, username, and password required for IMAP' }));
        return true;
      }
      // Test IMAP connection before saving
      try {
        await testConnection({ host, port: port ?? 993, tls: tls !== false, username, password });
      } catch (e) {
        // imapflow throws Error('Command failed') for pretty much every server-side
        // rejection, with the real diagnostic on auxiliary fields. Surface them so
        // the user sees something actionable instead of a generic message.
        const parts = [];
        if (e.responseText)       parts.push(`server said: ${e.responseText}`);
        if (e.responseStatus)     parts.push(`status: ${e.responseStatus}`);
        if (e.code)               parts.push(`code: ${e.code}`);
        if (e.authenticationFailed) parts.push('authenticationFailed=true');
        const detail = parts.length ? parts.join(' | ') : e.message;
        console.warn('[email-accounts] IMAP testConnection failed', {
          host, port: port ?? 993, username, message: e.message,
          responseText: e.responseText, responseStatus: e.responseStatus,
          code: e.code, authenticationFailed: e.authenticationFailed,
        });
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `IMAP connection failed: ${detail}` }));
        return true;
      }
      const encryptedPassword = await encrypt(userId, password);
      account = { ...account, host, port: port ?? 993, tls: tls !== false, username, encryptedPassword };
      // Optional SMTP for sending
      if (smtpHost) {
        account.smtpHost     = smtpHost;
        account.smtpPort     = smtpPort ?? 587;
        account.smtpTls      = smtpTls !== false;
        account.smtpUsername = smtpUsername || username;
      }
    }
    // For gmail/microsoft, just store the shell; OAuth handled separately

    await modifyAccounts(userId, accounts => { accounts.push(account); });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sanitize(account)));
    return true;
  }

  // ── PATCH /api/email-accounts/:id ─────────────────────────────────────────
  const patchMatch = url.pathname.match(/^\/api\/email-accounts\/([^/]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const userId = requireAuth(req, res); if (!userId) return true;
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); return true;
    }
    const acctId = patchMatch[1];
    let updated = null;
    await modifyAccounts(userId, accounts => {
      const acct = accounts.find(a => a.id === acctId);
      if (acct && body.label) { acct.label = body.label; updated = sanitize(acct); }
    });
    if (!updated) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Account not found' })); return true; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
    return true;
  }

  // ── DELETE /api/email-accounts/:id ────────────────────────────────────────
  const deleteMatch = url.pathname.match(/^\/api\/email-accounts\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const acctId = deleteMatch[1];
    let removed = false;
    await modifyAccounts(userId, accounts => {
      const idx = accounts.findIndex(a => a.id === acctId);
      if (idx !== -1) { accounts.splice(idx, 1); removed = true; }
    });
    // Clean up Microsoft token file if present
    const tp = msTokenPath(userId, acctId);
    if (fs.existsSync(tp)) fs.unlinkSync(tp);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ removed }));
    return true;
  }

  // ── GET /api/inbox/:msgId — unified message body ──────────────────────────
  const inboxIdMatch = req.url.match(/^\/api\/inbox\/([^/?]+)/);
  if (inboxIdMatch && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const msgId = inboxIdMatch[1];
    const accountId = url.searchParams.get('accountId');

    try {
      const account = await resolveAccount(userId, accountId, 'gmail');
      let html;
      if (account.provider === 'gmail') {
        html = await fetchGmailMessageBodyById(userId, msgId, account.id);
      } else if (account.provider === 'microsoft') {
        html = await fetchMsMessageBody(userId, account.id, msgId);
      } else if (account.provider === 'imap') {
        html = await fetchImapMessageBody(userId, account, msgId);
      } else {
        throw new Error('Unknown provider');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500); res.end(`<p>Error: ${e.message}</p>`);
    }
    return true;
  }

  // ── GET /api/inbox — unified inbox list ───────────────────────────────────
  if (url.pathname === '/api/inbox' && req.method === 'GET') {
    const userId = requireAuth(req, res); if (!userId) return true;
    const accountId = url.searchParams.get('accountId');
    const max = parseInt(url.searchParams.get('max') ?? '30', 10);
    const pageToken = url.searchParams.get('pageToken') || null;
    const query = url.searchParams.get('query') || null;

    try {
      const account = await resolveAccount(userId, accountId, 'gmail');
      let result;
      if (account.provider === 'gmail') {
        result = await fetchGmailInboxPage(userId, pageToken, max, account.id, query);
      } else if (account.provider === 'microsoft') {
        result = await fetchMsInboxPage(userId, account.id, pageToken, max);
      } else if (account.provider === 'imap') {
        result = await fetchImapPage(userId, account, pageToken, max);
      } else {
        throw new Error('Unknown provider');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) { safeError(res, e); }
    return true;
  }

  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveAccount(userId, accountId, fallbackProvider) {
  const accounts = loadAccounts(userId);
  if (accountId) {
    const acct = accounts.find(a => a.id === accountId);
    if (!acct) throw new Error(`Account ${accountId} not found`);
    return acct;
  }
  // Fallback: first account matching provider
  const fallback = accounts.find(a => a.provider === fallbackProvider);
  if (fallback) return fallback;
  // Last resort: first account
  if (accounts.length) return accounts[0];
  throw new Error('No email accounts configured');
}

// Gmail message body fetcher
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function fetchGmailMessageBodyById(userId, msgId, accountId) {
  const authHdr = await getGmailAuthHeader(userId, accountId);
  const msg = await fetch(`${GMAIL_BASE}/messages/${msgId}?format=full`, { headers: authHdr }).then(r => r.json());
  function extractBody(part) {
    if (!part) return null;
    if (part.mimeType === 'text/html' && part.body?.data)
      return { html: true, data: Buffer.from(part.body.data, 'base64').toString('utf8') };
    if (part.mimeType === 'text/plain' && part.body?.data)
      return { html: false, data: Buffer.from(part.body.data, 'base64').toString('utf8') };
    if (part.parts) {
      const html = part.parts.map(extractBody).find(r => r?.html);
      if (html) return html;
      return part.parts.map(extractBody).find(r => r);
    }
    return null;
  }
  const result = extractBody(msg.payload);
  return result?.html
    ? result.data
    : `<pre style="font-family:sans-serif;white-space:pre-wrap">${(result?.data ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
}
