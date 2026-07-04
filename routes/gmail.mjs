/**
 * Gmail routes: /api/gmail/autolabel*
 * /api/inbox and /api/inbox/:id are handled by routes/email-accounts.mjs
 */

import fs from 'fs';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';
import { requireAuth, readBody, safeError } from './_helpers.mjs';
import { loadConfig as loadAutoLabelConfig, saveConfig as saveAutoLabelConfig, startWatcher, stopWatcher, isWatcherRunning, startAllAccountWatchers, undoLastBatch } from '../gmail-autolabel.mjs';
import { tailActivity } from '../lib/gmail-autolabel-activity.mjs';
import { getGmailAuthHeader } from '../lib/google-auth.mjs';

export { getGmailAuthHeader };

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Fetch a page of Gmail inbox messages. Used by email-accounts.mjs unified dispatch.
 */
export async function fetchGmailInboxPage(userId, pageToken, max, accountId, query) {
  const authHdr = await getGmailAuthHeader(userId, accountId);
  let listUrl = `${GMAIL_BASE}/messages?q=${encodeURIComponent(query || 'in:inbox')}&maxResults=${max ?? 30}`;
  if (pageToken) listUrl += `&pageToken=${encodeURIComponent(pageToken)}`;
  const listRes = await fetch(listUrl, { headers: authHdr });
  const listData = await listRes.json();
  const ids = (listData.messages ?? []).map(m => m.id);
  const emails = await Promise.all(ids.map(async id => {
    const msg = await fetch(`${GMAIL_BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: authHdr }).then(r => r.json());
    const hdrs = {};
    for (const h of msg.payload?.headers ?? []) hdrs[h.name] = h.value;
    const snippet = (msg.snippet ?? '')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
      .replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202F\u2060-\u2064\u206A-\u206F\uFEFF]/g, '')
      .replace(/\s+/g, ' ').trim();
    return { id, from: hdrs.From ?? '', subject: hdrs.Subject ?? '(no subject)', date: hdrs.Date ?? '', snippet };
  }));
  return { emails, nextPageToken: listData.nextPageToken ?? null };
}

export async function handle(req, res) {
  // Auto-label endpoints
  if (req.url === '/api/gmail/autolabel' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    const cfg = loadAutoLabelConfig(authId);
    // Migrate legacy __default__ rules to the first Gmail account's real ID
    if (cfg.rulesByAccount?.['__default__']?.length) {
      try {
        const accountsPath = path.join(USERS_DIR, authId, 'email-accounts.json');
        const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
        const firstGmail = accounts.find(a => a.provider === 'gmail');
        if (firstGmail) {
          cfg.rulesByAccount[firstGmail.id] = cfg.rulesByAccount[firstGmail.id]?.length
            ? cfg.rulesByAccount[firstGmail.id]
            : cfg.rulesByAccount['__default__'];
          delete cfg.rulesByAccount['__default__'];
          if (cfg.lastHistoryIdByAccount?.['__default__']) {
            cfg.lastHistoryIdByAccount[firstGmail.id] = cfg.lastHistoryIdByAccount['__default__'];
            delete cfg.lastHistoryIdByAccount['__default__'];
          }
          cfg.accountId = cfg.accountId ?? firstGmail.id;
          saveAutoLabelConfig(authId, cfg);
        }
      } catch (_) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: cfg.enabled, rulesByAccount: cfg.rulesByAccount ?? {}, running: isWatcherRunning(authId), accountId: cfg.accountId ?? null }));
    return true;
  }

  if (req.url === '/api/gmail/autolabel/toggle' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { enabled, accountId } = JSON.parse(await readBody(req));
      const cfg = loadAutoLabelConfig(authId);
      cfg.enabled = !!enabled;
      if (accountId !== undefined && accountId !== cfg.accountId) {
        cfg.accountId = accountId || null;
      }
      saveAutoLabelConfig(authId, cfg);
      if (cfg.enabled) startAllAccountWatchers(authId);
      else stopWatcher(authId); // stops all for this user
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: cfg.enabled, running: isWatcherRunning(authId) }));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  if (req.url === '/api/gmail/autolabel/account' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { accountId } = JSON.parse(await readBody(req));
      const cfg = loadAutoLabelConfig(authId);
      if (accountId !== cfg.accountId) {
        cfg.accountId = accountId || null;
        saveAutoLabelConfig(authId, cfg);
        // Ensure a watcher is running for this account if auto-label is enabled
        if (cfg.enabled) startWatcher(authId, accountId ?? null);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  if (req.url === '/api/gmail/autolabel/rules' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { accountId, field, op, value, label, keepInbox } = JSON.parse(await readBody(req));
      if (!field || !op || !value || !label) { res.writeHead(400); res.end('Missing fields'); return true; }
      const cfg = loadAutoLabelConfig(authId);
      const key = accountId ?? '__default__';
      cfg.rulesByAccount = cfg.rulesByAccount ?? {};
      cfg.rulesByAccount[key] = cfg.rulesByAccount[key] ?? [];
      // Default false — existing rules (and any client that doesn't send this
      // field) keep today's archive-on-match behavior unchanged.
      cfg.rulesByAccount[key].push({ id: Date.now().toString(36), field, op, value, label, keepInbox: !!keepInbox });
      saveAutoLabelConfig(authId, cfg);
      // Start a watcher for this account if auto-label is enabled and not already running
      if (cfg.enabled) startWatcher(authId, accountId ?? null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rules: cfg.rulesByAccount[key] }));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  // Update a single rule's keepInbox flag — the only field the UI lets you
  // edit in place; everything else is delete-and-recreate.
  if (req.url === '/api/gmail/autolabel/rules' && req.method === 'PATCH') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { accountId, id, keepInbox } = JSON.parse(await readBody(req));
      if (!id) { res.writeHead(400); res.end('Missing id'); return true; }
      const cfg = loadAutoLabelConfig(authId);
      const key = accountId ?? '__default__';
      cfg.rulesByAccount = cfg.rulesByAccount ?? {};
      const rule = (cfg.rulesByAccount[key] ?? []).find(r => r.id === id);
      if (!rule) { res.writeHead(404); res.end('Rule not found'); return true; }
      rule.keepInbox = !!keepInbox;
      saveAutoLabelConfig(authId, cfg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rules: cfg.rulesByAccount[key] }));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  if (req.url === '/api/gmail/autolabel/rules' && req.method === 'DELETE') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const { accountId, id } = JSON.parse(await readBody(req));
      const cfg = loadAutoLabelConfig(authId);
      const key = accountId ?? '__default__';
      cfg.rulesByAccount = cfg.rulesByAccount ?? {};
      cfg.rulesByAccount[key] = (cfg.rulesByAccount[key] ?? []).filter(r => r.id !== id);
      saveAutoLabelConfig(authId, cfg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ rules: cfg.rulesByAccount[key] }));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  // Recent activity trail (applied labels + skips) for the account currently
  // selected in the UI. `accountId` query param is always sent by the UI
  // (empty string for the default/legacy account) so results are scoped to
  // one account; omit it entirely to get activity across all accounts.
  if (req.url.split('?')[0] === '/api/gmail/autolabel/activity' && req.method === 'GET') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const params = new URL(req.url, 'http://x').searchParams;
      const accountId = params.has('accountId') ? (params.get('accountId') || null) : undefined;
      const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ activity: tailActivity(authId, { accountId, limit }) }));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  // Reverse the most recent poll-cycle batch for one account: re-adds INBOX
  // where a message was archived and removes the label that was applied.
  // Idempotent — see undoLastBatch() in gmail-autolabel.mjs.
  if (req.url === '/api/gmail/autolabel/undo' && req.method === 'POST') {
    const authId = requireAuth(req, res); if (!authId) return true;
    try {
      const raw = await readBody(req);
      const { accountId } = raw ? JSON.parse(raw) : {};
      const result = await undoLastBatch(authId, accountId ?? null);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      safeError(res, e);
    }
    return true;
  }

  return false;
}
