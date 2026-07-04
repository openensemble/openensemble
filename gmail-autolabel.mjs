/**
 * Gmail Auto-Label — polls Gmail history API and applies labels based on rules.
 * No public URL needed — uses pull-based history polling instead of Pub/Sub push.
 */
import fs from 'fs';
import path from 'path';
import { BASE_DIR } from './lib/paths.mjs';
import { getAccessToken as getGoogleAccessToken } from './lib/google-auth.mjs';
import { emailLabelsEnabled, getPin } from './lib/email-label-memory.mjs';
import { appendActivityBatch, getLastBatch, markRowsUndone } from './lib/gmail-autolabel-activity.mjs';
import { log } from './logger.mjs';
import { atomicWriteSync, withLock } from './routes/_helpers/io-lock.mjs';

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

/**
 * Match a message's headers against a rule list.
 * @returns {Array<{ruleId: string, label: string, keepInbox: boolean}>} one
 *   entry per distinct label a matching rule targets (first rule for a given
 *   label wins, same as before — this just carries ruleId/keepInbox through
 *   for the activity trail and the keep-inbox decision).
 */
export function matchRules(rules, from, subject, to) {
  const matched = [];
  const seenLabels = new Set();
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
    if (match && rule.label && !seenLabels.has(rule.label)) {
      seenLabels.add(rule.label);
      matched.push({ ruleId: rule.id, label: rule.label, keepInbox: !!rule.keepInbox });
    }
  }
  return matched;
}

/**
 * Decide what to do with one rule match, given the learned-memory pin (if
 * any) for that sender/subject. Pure — no I/O, so this is unit-testable
 * without touching Gmail or the filesystem.
 *
 * Decision table (rule x pin -> action):
 *   no pin                                  -> apply; archive unless rule.keepInbox
 *   pin exists, pin.labels doesn't include
 *     the rule's label (CONFLICT)           -> skip entirely (no label, no archive)
 *   pin exists, pin.labels includes the
 *     rule's label, pin.keepInbox=false     -> apply; archive unless rule.keepInbox
 *   pin exists, pin.labels includes the
 *     rule's label, pin.keepInbox=true      -> apply; never archive (pin wins)
 *
 * @param {{ruleId: string, label: string, keepInbox: boolean}} match
 * @param {{labels: string[], keepInbox: boolean, source: string}|null} pin
 * @returns {{action: 'apply', label: string, archive: boolean} | {action: 'skip', skipReason: string}}
 */
export function decideAction(match, pin) {
  if (pin && !pin.labels.includes(match.label)) {
    return { action: 'skip', skipReason: `learned pin says ${pin.labels.join(', ')}` };
  }
  const archive = !match.keepInbox && !(pin && pin.keepInbox);
  return { action: 'apply', label: match.label, archive };
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

/**
 * Reverse the most recent poll-cycle batch for one account: remove the
 * applied label and, for anything that was archived, re-add INBOX. Skipped
 * rows (pin conflicts) never touched Gmail, so there's nothing to reverse —
 * they're ignored here.
 *
 * Idempotent: rows are marked `undone` individually only after their Gmail
 * call succeeds, so a second call (or a retry after a partial failure) only
 * re-attempts whatever didn't already succeed. Calling this with nothing
 * left to undo is a no-op ({ undone: 0 }), not an error.
 * @returns {Promise<{ok: boolean, batchId: string|null, undone: number, attempted?: number, alreadyUndone?: boolean, errors?: Array<{messageId:string, error:string}>}>}
 */
export async function undoLastBatch(userId, accountId) {
  const last = getLastBatch(userId, accountId ?? null);
  if (!last) return { ok: true, batchId: null, undone: 0 };

  const actionable = last.rows.filter(r => !r.skipped && !r.undone);
  if (!actionable.length) {
    return { ok: true, batchId: last.batchId, undone: 0, alreadyUndone: last.rows.some(r => r.undone) };
  }

  const succeededIds = [];
  const errors = [];
  for (const row of actionable) {
    try {
      const labelId = await getOrCreateLabel(userId, accountId, row.label);
      const body = { removeLabelIds: [labelId] };
      if (row.archived) body.addLabelIds = ['INBOX'];
      await gmailFetch(userId, accountId, `/messages/${row.messageId}/modify`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      succeededIds.push(row.id);
    } catch (e) {
      errors.push({ messageId: row.messageId, error: e.message });
      log.error('autolabel', 'undo error', { userId, account: accountId, messageId: row.messageId, err: e.message });
    }
  }
  const undone = succeededIds.length ? await markRowsUndone(userId, succeededIds) : 0;
  return {
    ok: errors.length === 0,
    batchId: last.batchId,
    undone,
    attempted: actionable.length,
    ...(errors.length ? { errors } : {}),
  };
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

export async function pollNewMessages(userId, accountId) {
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

    // One batchId per poll cycle — lets the UI/undo-endpoint reverse
    // "everything this poll just did" as a unit (see undoLastBatch below).
    const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const activityRows = [];

    for (const record of records) {
      for (const added of record.messagesAdded ?? []) {
        const msgId = added.message.id;
        try {
          const msg = await gmailFetch(userId, accountId,
            `/messages/${msgId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To`
          );
          const hdrs = {};
          for (const h of msg.payload?.headers ?? []) hdrs[h.name] = h.value;
          const matches = matchRules(rules, hdrs.From ?? '', hdrs.Subject ?? '', hdrs.To ?? '');
          if (!matches.length) continue;
          // Learned-pin awareness: read-only lookup, gated the same way the
          // email skill gates it. A pin never MUTATES here — it only decides
          // whether/how a static rule applies to this one message.
          const pin = emailLabelsEnabled() ? getPin(userId, hdrs.From ?? '', hdrs.Subject ?? '', { accountId }) : null;
          for (const match of matches) {
            const decision = decideAction(match, pin);
            if (decision.action === 'skip') {
              console.log(`[autolabel] "${hdrs.Subject}" skipped for ${match.label} — ${decision.skipReason}`);
              log.info('autolabel', 'skipped — pin conflict', { userId, account: accountId, label: match.label, reason: decision.skipReason });
              activityRows.push({
                account: accountId ?? null, messageId: msgId, from: hdrs.From ?? '', subject: hdrs.Subject ?? '',
                ruleId: match.ruleId, label: match.label, archived: false, batchId, skipped: decision.skipReason,
              });
              continue;
            }
            const labelId = await getOrCreateLabel(userId, accountId, decision.label);
            const body = { addLabelIds: [labelId] };
            if (decision.archive) body.removeLabelIds = ['INBOX'];
            await gmailFetch(userId, accountId, `/messages/${msgId}/modify`, {
              method: 'POST',
              body: JSON.stringify(body),
            });
            console.log(`[autolabel] "${hdrs.Subject}" → ${decision.label}${decision.archive ? '' : ' (kept in inbox)'}`);
            log.info('autolabel', 'applied label', { userId, account: accountId, label: decision.label, archived: decision.archive });
            activityRows.push({
              account: accountId ?? null, messageId: msgId, from: hdrs.From ?? '', subject: hdrs.Subject ?? '',
              ruleId: match.ruleId, label: decision.label, archived: decision.archive, batchId,
            });
          }
        } catch (e) {
          console.error(`[autolabel] Error on message ${msgId}:`, e.message);
          log.error('autolabel', 'message error', { userId, account: accountId, msgId, err: e.message });
        }
      }
    }

    if (activityRows.length) await appendActivityBatch(userId, activityRows);

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
