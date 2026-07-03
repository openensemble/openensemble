/**
 * Gmail Auto-Label — polls Gmail history API and applies labels based on rules.
 * No public URL needed — uses pull-based history polling instead of Pub/Sub push.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAccessToken as getGoogleAccessToken } from './lib/google-auth.mjs';
import { log } from './logger.mjs';
import { atomicWriteSync, withLock } from './routes/_helpers/io-lock.mjs';

const BASE_DIR   = path.dirname(fileURLToPath(import.meta.url));
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const POLL_MS    = 60_000; // poll every 60 seconds

const watchers = new Map(); // `${userId}:${acctKey}` -> intervalId

function watcherKey(userId, accountId) {
  return `${userId}:${accountId ?? '__default__'}`;
}

function configPath(userId) {
  return path.join(BASE_DIR, 'users', userId, 'gmail-autolabel.json');
}

export function loadConfig(userId) {
  try {
    if (fs.existsSync(configPath(userId))) {
      return JSON.parse(fs.readFileSync(configPath(userId), 'utf8'));
    }
  } catch (e) { console.warn('[autolabel] Failed to load config for', userId + ':', e.message); }
  return { enabled: false, accountId: null, rulesByAccount: {}, lastHistoryIdByAccount: {} };
}

export function saveConfig(userId, cfg) {
  atomicWriteSync(configPath(userId), JSON.stringify(cfg, null, 2));
}

async function getAccessToken(userId, accountId) {
  return getGoogleAccessToken('gmail', userId, accountId);
}

async function gmailFetch(userId, accountId, endpoint, opts = {}) {
  const token = await getAccessToken(userId, accountId);
  const res = await fetch(`${GMAIL_BASE}${endpoint}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    // Attach status + Retry-After so callers can apply exponential backoff
    // on 429/5xx without string-parsing the error message.
    const err = new Error(`Gmail API ${res.status}: ${body}`);
    err.status = res.status;
    const ra = res.headers.get('retry-after');
    if (ra) {
      const seconds = Number(ra);
      err.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : null;
    }
    throw err;
  }
  if (res.status === 204) return {};
  return res.json();
}

function extractEmailDomain(fromHeader) {
  const emailMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/(\S+@\S+)/);
  const email = emailMatch ? emailMatch[1] : fromHeader;
  return email.split('@')[1]?.toLowerCase() ?? '';
}

function matchRules(rules, from, subject, to) {
  const labels = [];
  for (const rule of rules) {
    const fieldVal = rule.field === 'from' ? from : rule.field === 'subject' ? subject : to;
    const val = (fieldVal ?? '').toLowerCase();
    const ruleVal = (rule.value ?? '').toLowerCase();
    let match;
    if (rule.op === 'equals') {
      match = val === ruleVal;
    } else if (rule.op === 'domain') {
      const domain = extractEmailDomain(fieldVal ?? '');
      match = domain === ruleVal || domain.endsWith('.' + ruleVal);
    } else {
      match = val.includes(ruleVal); // contains (default)
    }
    if (match && rule.label && !labels.includes(rule.label)) labels.push(rule.label);
  }
  return labels;
}

async function getOrCreateLabel(userId, accountId, labelName) {
  const list = await gmailFetch(userId, accountId, '/labels');
  const existing = (list.labels ?? []).find(l => l.name.toLowerCase() === labelName.toLowerCase());
  if (existing) return existing.id;
  const created = await gmailFetch(userId, accountId, '/labels', {
    method: 'POST',
    body: JSON.stringify({ name: labelName }),
  });
  return created.id;
}

// Locked, targeted update of ONE account's history cursor (+ lastChecked). The
// accounts poll near-simultaneously; a whole-config load-modify-save let one
// account's save clobber another's cursor — re-processing old mail and
// re-archiving messages the user had pulled back to the inbox.
async function saveCursor(userId, acctKey, historyId) {
  await withLock(configPath(userId), () => {
    const cfg = loadConfig(userId);
    cfg.lastHistoryIdByAccount = cfg.lastHistoryIdByAccount ?? {};
    cfg.lastHistoryIdByAccount[acctKey] = historyId;
    cfg.lastChecked = Date.now();
    atomicWriteSync(configPath(userId), JSON.stringify(cfg, null, 2));
  });
}

async function pollNewMessages(userId, accountId) {
  const cfg = loadConfig(userId);
  if (!cfg.enabled) return;

  const acctKey = accountId ?? '__default__';

  // Per-account rules — migrate from legacy flat rules on first access
  cfg.rulesByAccount = cfg.rulesByAccount ?? {};
  if (!cfg.rulesByAccount[acctKey] && cfg.rules?.length) {
    cfg.rulesByAccount[acctKey] = cfg.rules;
  }
  const rules = cfg.rulesByAccount[acctKey] ?? [];
  if (!rules.length) return;

  // Per-account historyId — migrate from legacy flat lastHistoryId
  cfg.lastHistoryIdByAccount = cfg.lastHistoryIdByAccount ?? {};
  if (!cfg.lastHistoryIdByAccount[acctKey] && cfg.lastHistoryId) {
    cfg.lastHistoryIdByAccount[acctKey] = cfg.lastHistoryId;
  }
  const lastHistoryId = cfg.lastHistoryIdByAccount[acctKey] ?? null;

  try {
    // On first run, seed the historyId without processing anything
    if (!lastHistoryId) {
      const profile = await gmailFetch(userId, accountId, '/profile');
      await saveCursor(userId, acctKey, profile.historyId);
      console.log(`[autolabel] Initialized historyId=${profile.historyId} for user ${userId} account ${acctKey}`);
      return;
    }

    // Follow nextPageToken so a burst of >100 history records isn't skipped —
    // the cursor advances to the latest historyId below, so anything not fetched
    // here would be lost. Bounded; if capped, don't advance so the remainder is
    // caught next poll (already-processed messages re-label idempotently).
    const records = [];
    let newHistoryId = lastHistoryId;
    let pageToken = null;
    const MAX_HISTORY_PAGES = 50;
    let pages = 0;
    do {
      const histRes = await gmailFetch(userId, accountId,
        `/history?startHistoryId=${lastHistoryId}&historyTypes=messageAdded&labelId=INBOX${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      );
      if (histRes.history) records.push(...histRes.history);
      newHistoryId = histRes.historyId ?? newHistoryId;
      pageToken = histRes.nextPageToken ?? null;
    } while (pageToken && ++pages < MAX_HISTORY_PAGES);
    if (pageToken) {
      console.warn(`[autolabel] history paging capped at ${MAX_HISTORY_PAGES} pages for ${userId}/${acctKey}; continuing next poll`);
      newHistoryId = lastHistoryId; // don't advance — catch the remainder next poll
    }

    for (const record of records) {
      for (const added of record.messagesAdded ?? []) {
        const msgId = added.message.id;
        try {
          const msg = await gmailFetch(userId, accountId,
            `/messages/${msgId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To`
          );
          const hdrs = {};
          for (const h of msg.payload?.headers ?? []) hdrs[h.name] = h.value;
          const labelNames = matchRules(rules, hdrs.From ?? '', hdrs.Subject ?? '', hdrs.To ?? '');
          for (const labelName of labelNames) {
            const labelId = await getOrCreateLabel(userId, accountId, labelName);
            await gmailFetch(userId, accountId, `/messages/${msgId}/modify`, {
              method: 'POST',
              body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: ['INBOX'] }),
            });
            console.log(`[autolabel] "${hdrs.Subject}" → ${labelName}`);
            log.info('autolabel', 'applied label', { userId, account: accountId, label: labelName });
          }
        } catch (e) {
          console.error(`[autolabel] Error on message ${msgId}:`, e.message);
          log.error('autolabel', 'message error', { userId, account: accountId, msgId, err: e.message });
        }
      }
    }

    await saveCursor(userId, acctKey, newHistoryId);
  } catch (e) {
    if (e.message?.includes('404') || e.message?.includes('startHistoryId')) {
      // historyId too old — reset so it reseeds on next poll
      console.warn(`[autolabel] historyId expired for ${userId} account ${acctKey}, resetting`);
      await saveCursor(userId, acctKey, null);
      return;
    }
    console.error(`[autolabel] Poll error for ${userId}:`, e.message);
    log.error('autolabel', 'poll error', { userId, account: accountId, status: e.status, err: e.message });
    // Rethrow 429/5xx so the watcher scheduler can apply exponential backoff.
    if (e.status === 429 || (e.status >= 500 && e.status < 600)) throw e;
  }
}

// Self-scheduling poller with exponential backoff. On 429/5xx we respect
// Retry-After when present, otherwise double the delay (capped at 30 min).
// On success we reset back to POLL_MS.
const MAX_BACKOFF_MS = 30 * 60_000;
function scheduleNextPoll(userId, accountId, delayMs) {
  const key = watcherKey(userId, accountId);
  const handle = watchers.get(key);
  if (handle && handle.stopped) return; // watcher was removed while we awaited
  const entry = handle ?? { stopped: false, backoffMs: POLL_MS, timerId: null };
  entry.timerId = setTimeout(async () => {
    if (entry.stopped) return;
    try {
      await pollNewMessages(userId, accountId);
      entry.backoffMs = POLL_MS; // success → reset backoff
    } catch (e) {
      const retryMs = e?.retryAfterMs;
      const is429or5xx = e?.status === 429 || (e?.status >= 500 && e?.status < 600);
      if (is429or5xx) {
        entry.backoffMs = retryMs ?? Math.min(entry.backoffMs * 2, MAX_BACKOFF_MS);
        console.warn(`[autolabel] ${e.status} — backing off ${Math.round(entry.backoffMs / 1000)}s for ${key}`);
      } else {
        entry.backoffMs = POLL_MS; // non-rate-limit errors: stay on normal cadence
      }
    }
    if (!entry.stopped) scheduleNextPoll(userId, accountId, entry.backoffMs);
  }, delayMs);
  watchers.set(key, entry);
}

// Start a watcher for one specific account. No-op if already running.
export function startWatcher(userId, accountId) {
  const key = watcherKey(userId, accountId);
  if (watchers.has(key) && !watchers.get(key).stopped) return;
  const acctKey = accountId ?? '__default__';
  console.log(`[autolabel] Starting watcher for ${userId} / ${acctKey}`);
  // Fire once immediately, then schedule with backoff
  scheduleNextPoll(userId, accountId, 0);
}

function _stopEntry(key, entry) {
  if (!entry) return;
  entry.stopped = true;
  if (entry.timerId) clearTimeout(entry.timerId);
  watchers.delete(key);
  console.log(`[autolabel] Stopped watcher ${key}`);
}

// Stop a specific account's watcher, or all watchers for a user if accountId omitted.
export function stopWatcher(userId, accountId) {
  if (accountId === undefined) {
    for (const [key, entry] of watchers) {
      if (key.startsWith(`${userId}:`)) _stopEntry(key, entry);
    }
    return;
  }
  const key = watcherKey(userId, accountId);
  _stopEntry(key, watchers.get(key));
}

export function isWatcherRunning(userId) {
  for (const [key, entry] of watchers) {
    if (key.startsWith(`${userId}:`) && !entry.stopped) return true;
  }
  return false;
}

export function stopAllWatchers() {
  for (const [key, entry] of watchers) _stopEntry(key, entry);
}

// Start watchers for every account that has rules configured.
export function startAllAccountWatchers(userId) {
  const cfg = loadConfig(userId);
  if (!cfg.enabled) return;
  const rba = cfg.rulesByAccount ?? {};
  let started = 0;
  for (const [acctKey, rules] of Object.entries(rba)) {
    if (rules?.length) {
      const accountId = acctKey === '__default__' ? null : acctKey;
      startWatcher(userId, accountId);
      started++;
    }
  }
  // Legacy flat rules fallback
  if (!started && cfg.rules?.length) {
    startWatcher(userId, cfg.accountId ?? null);
  }
}

// Called at server startup — resume watchers for users with autolabel enabled
export function initAutoLabel(usersList) {
  for (const user of usersList) {
    const cfg = loadConfig(user.id);
    if (cfg.enabled) startAllAccountWatchers(user.id);
  }
}
