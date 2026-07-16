// @ts-check
/**
 * Durable at-most-once guard for model-initiated email sends.
 *
 * Providers are allowed to emit parallel tool calls. A model can therefore
 * request the same email through `email_user` several times (or fall back to
 * `email_compose`) before any one result reaches the next model round. Loop
 * guards are too late to prevent those duplicate side effects.
 *
 * This guard lives below both public tools, around the provider dispatch.
 * Within the originating attempt, distinct normalized payloads remain distinct
 * sends; after any dispatch, a browser Retry of the same user-message id may
 * only replay already-authorized payloads. Programmatic watcher/scheduler
 * scopes name exactly one delivery. The public tool name is deliberately
 * excluded so `email_user` and `email_compose` share one boundary.
 *
 * Crash contract: a `pending` record is written BEFORE dispatch and becomes
 * `completed` only after the provider confirms a send. If the process dies in
 * between, a later retry fails closed instead of risking a second delivery.
 * This gives at-most-once behavior at the unavoidable dispatch/persist crash
 * boundary; providers without their own idempotency API cannot provide true
 * exactly-once delivery or prove whether a timed-out request was accepted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { USERS_DIR } from './paths.mjs';
import { getTurn } from './turn-trace-context.mjs';
import { withFileLock } from './file-lock.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { looksLikeToolError } from './tool-error.mjs';

const STORE_DIR = 'email-idempotency';
const MIN_COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const BACKGROUND_COMPLETED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 60_000;
const MAX_AUTHORIZED_PAYLOADS = 100;
const _inflight = new Map();
const _lastSweep = new Map();
const emailDeliveryContext = new AsyncLocalStorage();

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function userStoreDir(userId) {
  const id = String(userId || '');
  if (!id || path.basename(id) !== id || id === '.' || id === '..') {
    throw new Error('A valid userId is required for email delivery idempotency.');
  }
  return path.join(USERS_DIR, id, STORE_DIR);
}

function canonicalRecipients(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean))]
    .sort()
    .join(',');
}

/**
 * Bind one programmatic delivery (watcher/scheduler fire) to a durable key.
 * The scope is internal ALS state rather than a model-visible tool argument,
 * so prompt input cannot suppress a later legitimate delivery by choosing a
 * victim's key. One scope authorizes exactly one outbound email even if a
 * restarted caller changes the payload while retrying it.
 */
export function withEmailDeliveryScope(scopeId, fn) {
  const clean = String(scopeId || '').trim();
  if (!clean) return fn();
  return emailDeliveryContext.run({
    scopeId: `programmatic:${sha256(clean)}`,
    singleOperation: true,
  }, fn);
}

/**
 * Canonical provider payload used by both email_user and email_compose.
 * Keep body bytes exact; whitespace can be meaningful in plain text/HTML.
 */
export function canonicalEmailPayload(payload = {}) {
  const bodyDocId = String(payload.body_doc_id || payload.html_body_doc_id || '').trim();
  return JSON.stringify({
    action: String(payload.action || 'compose').trim().toLowerCase(),
    accountId: String(payload.accountId || ''),
    provider: String(payload.provider || '').toLowerCase(),
    // IMAP callers resolve UID / RFC Message-ID aliases through a read-only
    // header preflight and provide canonicalReplyId. The raw user/model alias
    // must not split one reply into two provider dispatches.
    messageId: String(payload.canonicalReplyId || payload.messageId || '').trim(),
    to: canonicalRecipients(payload.to),
    subject: String(payload.subject || '').trim(),
    // body_doc_id supersedes literal body fields in the email executor, so
    // ignore those fields here too or harmless model-added fallback text would
    // split one real delivery into two idempotency keys.
    body: (bodyDocId || payload.body == null) ? '' : String(payload.body),
    htmlBody: (bodyDocId || payload.html_body == null) ? '' : String(payload.html_body),
    bodyDocId,
    attachments: Array.isArray(payload.attachment_doc_ids)
      ? [...new Set(payload.attachment_doc_ids.map(id => String(id).trim()).filter(Boolean))].sort()
      : [],
  });
}

export function currentEmailTurnScope() {
  const delivery = emailDeliveryContext.getStore();
  if (delivery?.scopeId) return delivery.scopeId;
  const turn = getTurn();
  if (!turn) return null;
  // Browser Retry deliberately keeps messageId while minting a new attemptId.
  // Prefer that stable logical-message identity so a retry cannot repeat a
  // side effect that completed before the prior turn failed. Inline
  // coordinator/specialist work shares the same ALS store and messageId.
  const messageId = String(turn.messageId || '').trim();
  if (messageId) return `message:${messageId}`;

  // Detached/background callers have no browser message id. Their durable
  // root task id is the logical operation boundary; attempt/turn fallbacks
  // preserve historical behavior for direct callers and tests.
  const rootId = String(turn.rootId || turn.attemptId || turn.turnId || '').trim();
  return rootId ? `root:${rootId}` : null;
}

function currentEmailOperationContext() {
  const delivery = emailDeliveryContext.getStore();
  if (delivery?.scopeId) {
    return {
      scopeId: String(delivery.scopeId),
      attemptId: null,
      singleOperation: delivery.singleOperation === true,
      sourceMessageId: null,
      sourceSessionKey: null,
      sourceSessionEpoch: null,
    };
  }
  const turn = getTurn();
  if (!turn) return { scopeId: null, attemptId: null, singleOperation: false };
  return {
    scopeId: currentEmailTurnScope(),
    attemptId: String(turn.attemptId || turn.turnId || '').trim() || null,
    singleOperation: false,
    sourceMessageId: String(turn.messageId || '').trim() || null,
    sourceSessionKey: String(turn.sessionKey || '').trim() || null,
    sourceSessionEpoch: String(turn.sessionEpoch || '').trim() || null,
  };
}

function operationIdentity(userId, scopeId, payload, singleOperation = false) {
  const payloadHash = sha256(canonicalEmailPayload(payload));
  const operationId = sha256(singleOperation
    ? `${userId}\0${scopeId}`
    : `${userId}\0${scopeId}\0${payloadHash}`);
  return { operationId, payloadHash };
}

function scopeIdentity(userId, scopeId) {
  return sha256(`${userId}\0${scopeId}`);
}

function readRecord(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function writeRecord(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  atomicWriteSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function duplicateResult(priorResult) {
  return `Duplicate email suppressed; the original authorized send already completed. Prior result: ${String(priorResult || 'Email sent.')}`;
}

function uncertainResult() {
  return 'Error: email delivery status is uncertain from an earlier attempt in this turn, so no retry was made to avoid sending a duplicate. Check Sent mail before starting a new send.';
}

function sessionLocalId(userId, sessionKey) {
  const raw = String(sessionKey || '');
  const local = raw.startsWith(`${userId}_`) ? raw.slice(userId.length + 1) : raw;
  return local.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sessionContainsMessage(filePath, messageId) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    return lines.some(line => {
      try { return JSON.parse(line)?.messageId === messageId; } catch { return false; }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    return null; // unknown => retain, never guess that authorization expired
  }
}

/** True while the durable source message can still be retried by the UI. */
function sourceMessageIsRetriable(userId, record) {
  const messageId = String(record?.sourceMessageId
    || (String(record?.scopeId || '').startsWith('message:') ? String(record.scopeId).slice(8) : '')).trim();
  if (!messageId) return null;
  const sessionsDir = path.join(USERS_DIR, userId, 'sessions');
  if (record?.sourceSessionKey) {
    if (record.sourceSessionEpoch) {
      const epochPath = path.join(sessionsDir, `${sessionLocalId(userId, record.sourceSessionKey)}.session-epoch`);
      let currentEpoch = 'legacy';
      try { currentEpoch = fs.readFileSync(epochPath, 'utf8').trim() || 'legacy'; }
      catch (error) { if (error?.code !== 'ENOENT') return true; }
      if (currentEpoch !== record.sourceSessionEpoch) return false;
    }
    const filePath = path.join(sessionsDir, `${sessionLocalId(userId, record.sourceSessionKey)}.jsonl`);
    return sessionContainsMessage(filePath, messageId);
  }

  // Legacy records predate sessionKey metadata. Scan the user's bounded
  // session JSONLs; failures retain the tombstone rather than risking resend.
  let entries;
  try { entries = fs.readdirSync(sessionsDir, { withFileTypes: true }); }
  catch (error) { return error?.code === 'ENOENT' ? false : true; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const found = sessionContainsMessage(path.join(sessionsDir, entry.name), messageId);
    if (found === true) return true;
    if (found === null) return true;
  }
  return false;
}

function shouldDeleteCompleted(userId, record, stat, now) {
  const age = now - stat.mtimeMs;
  if (age <= MIN_COMPLETED_RETENTION_MS) return false;
  const sourceRetriable = sourceMessageIsRetriable(userId, record);
  if (sourceRetriable === true) return false;
  if (sourceRetriable === false) return true;
  return age > BACKGROUND_COMPLETED_RETENTION_MS;
}

function sweepOldRecords(dir, userId) {
  const now = Date.now();
  const last = _lastSweep.get(dir) || 0;
  if (now - last < 60 * 60 * 1000) return;
  _lastSweep.set(dir, now);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const p = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(p);
      // Never age out an uncertain dispatch automatically. Completed browser
      // tombstones live at least as long as their durable source message, so a
      // still-authorized Retry can never outlive duplicate suppression.
      const record = readRecord(p);
      if (record?.status === 'completed' && shouldDeleteCompleted(userId, record, stat, now)) {
        fs.rmSync(p, { force: true });
      }
    } catch { /* best-effort retention cleanup */ }
  }

  // Authorization ledgers are retained under the same source-message
  // lifecycle as their completed operations. They are small, but pruning them
  // after the source row disappears keeps the per-user store bounded.
  const scopesDir = path.join(dir, '.scopes');
  let scopes = [];
  try { scopes = fs.readdirSync(scopesDir, { withFileTypes: true }); } catch { return; }
  for (const entry of scopes) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(scopesDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      const record = readRecord(filePath);
      if (record?.sealed === true && shouldDeleteCompleted(userId, record, stat, now)) {
        fs.rmSync(filePath, { force: true });
      }
    } catch { /* best-effort retention cleanup */ }
  }
}

function authorizationPaths(dir, userId, scopeId) {
  const id = scopeIdentity(userId, scopeId);
  return {
    recordPath: path.join(dir, '.scopes', `${id}.json`),
    lockPath: path.join(dir, '.locks', `scope-${id}.lock`),
  };
}

function recordsForScope(dir, scopeId) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(dir, entry.name);
    const record = readRecord(filePath);
    if (record?.scopeId === scopeId) records.push({ filePath, record });
  }
  return records;
}

function retryPayloadChangedResult() {
  return 'Tool error: Email was not sent again because this is a retry of a request that already dispatched email. Start a new message to authorize a changed email.';
}

/**
 * Execute one email provider dispatch per normalized payload in a logical turn.
 * Outside a turn context, direct callers retain historical behavior unless
 * they bind one exact event through withEmailDeliveryScope().
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {object} opts.payload
 * @param {(markDispatchStarted: () => void) => Promise<any>} opts.send
 * @param {string|null} [opts.scopeId]
 * @param {string|null} [opts.attemptId]
 * @param {boolean} [opts.singleOperation]
 * @returns {Promise<any>}
 */
export async function sendEmailIdempotently(opts) {
  const { userId, payload, send } = opts;
  if (typeof send !== 'function') throw new Error('send callback is required');
  const ambient = currentEmailOperationContext();
  const scopeId = Object.prototype.hasOwnProperty.call(opts, 'scopeId')
    ? opts.scopeId
    : ambient.scopeId;
  const attemptId = Object.prototype.hasOwnProperty.call(opts, 'attemptId')
    ? opts.attemptId
    : ambient.attemptId;
  const singleOperation = Object.prototype.hasOwnProperty.call(opts, 'singleOperation')
    ? opts.singleOperation === true
    : ambient.singleOperation === true;
  if (!scopeId) return send(() => {});

  const dir = userStoreDir(userId);
  const { operationId, payloadHash } = operationIdentity(userId, scopeId, payload, singleOperation);
  const recordPath = path.join(dir, `${operationId}.json`);
  const lockPath = path.join(dir, '.locks', `${operationId}.lock`);
  const source = {
    sourceMessageId: ambient.sourceMessageId || null,
    sourceSessionKey: ambient.sourceSessionKey || null,
    sourceSessionEpoch: ambient.sourceSessionEpoch || null,
  };

  // Parallel model tool calls in this process share the same promise instead
  // of waiting on a filesystem lock whose timeout may be shorter than SMTP.
  const active = _inflight.get(operationId);
  if (active) {
    const first = await active;
    return first.confirmed ? duplicateResult(first.result) : first.result;
  }

  const executeOperation = (beforeDispatch = () => {}) => withFileLock(lockPath, async () => {
    sweepOldRecords(dir, userId);
    const existing = readRecord(recordPath);
    if (existing?.status === 'completed') {
      return { deduped: true, confirmed: true, result: existing.result };
    }
    // A preflight claim proves dispatch had not begun. It can remain only
    // after a process crash (live concurrent callers are serialized by the
    // lock / _inflight promise), so retrying it is safe.
    if (existing?.status === 'preflight') {
      try { fs.rmSync(recordPath, { force: true }); } catch { /* rewritten below */ }
    } else if (existing || fs.existsSync(recordPath)) {
      // Any other non-completed or unreadable record is fail-closed. Atomic
      // writes make corruption unlikely, but treating it as a fresh operation
      // could duplicate an email whose completion record was damaged.
      return { deduped: true, confirmed: false, result: uncertainResult(), uncertain: true };
    }

    const now = Date.now();
    writeRecord(recordPath, {
      version: 2,
      operationId,
      payloadHash,
      scopeId: String(scopeId),
      attemptId: attemptId ? String(attemptId) : null,
      ...source,
      status: 'preflight',
      createdAt: now,
      updatedAt: now,
    });

    let dispatchStarted = false;
    const markDispatchStarted = () => {
      if (dispatchStarted) return;
      // Persist the ambiguity boundary before the provider send begins. A
      // crash from this point onward must fail closed; a crash before it is a
      // safely retryable preflight failure.
      beforeDispatch();
      writeRecord(recordPath, {
        version: 2,
        operationId,
        payloadHash,
        scopeId: String(scopeId),
        attemptId: attemptId ? String(attemptId) : null,
        ...source,
        status: 'dispatching',
        createdAt: now,
        updatedAt: Date.now(),
      });
      dispatchStarted = true;
    };

    let result;
    try {
      result = await send(markDispatchStarted);
    } catch (error) {
      if (!dispatchStarted) {
        // Authentication, attachment resolution, decryption, and other
        // preflight work failed before the provider could receive a send.
        // Remove the claim so a corrected retry is allowed.
        try { fs.rmSync(recordPath, { force: true }); } catch { /* best effort */ }
        throw error;
      }
      // We cannot know whether a transport exception happened before or after
      // the remote provider accepted the request. Preserve the claim and fail
      // closed on future retries of this logical operation.
      writeRecord(recordPath, {
        version: 2,
        operationId,
        payloadHash,
        scopeId: String(scopeId),
        attemptId: attemptId ? String(attemptId) : null,
        ...source,
        status: 'uncertain',
        createdAt: now,
        updatedAt: Date.now(),
        error: String(error?.message || error).slice(0, 500),
      });
      throw error;
    }

    const text = typeof result === 'string' ? result : JSON.stringify(result);
    // Every outbound provider returns an `Email sent...` or `Reply sent...`
    // confirmation. If a provider implementation forgot to mark the dispatch
    // boundary, completion is still persisted to prevent a duplicate, but its
    // focused provider tests should catch the missing marker.
    // Do not treat vague text such as "not sent" as a completed side effect.
    const confirmed = /^(?:Email|Reply) sent\b/i.test(text.trim()) && !looksLikeToolError(text);
    if (!confirmed) {
      // Validation/refusal results happen before dispatch and are safe to retry
      // after the caller fixes its arguments or account configuration.
      try { fs.rmSync(recordPath, { force: true }); } catch { /* best effort */ }
      return { deduped: false, confirmed: false, result };
    }

    writeRecord(recordPath, {
      version: 2,
      operationId,
      payloadHash,
      scopeId: String(scopeId),
      attemptId: attemptId ? String(attemptId) : null,
      ...source,
      status: 'completed',
      createdAt: now,
      updatedAt: Date.now(),
      result: text,
    });
    return { deduped: false, confirmed: true, result };
  }, { timeoutMs: LOCK_TIMEOUT_MS });

  const run = async () => {
    // A programmatic watcher/scheduler scope names one exact fire. Its
    // operation id intentionally excludes the payload so a retry that changes
    // prose cannot become a second external side effect.
    if (singleOperation || !attemptId) return executeOperation();

    const authPaths = authorizationPaths(dir, userId, String(scopeId));
    return withFileLock(authPaths.lockPath, async () => {
      sweepOldRecords(dir, userId);
      let auth = readRecord(authPaths.recordPath);
      if (!auth && fs.existsSync(authPaths.recordPath)) {
        return { deduped: true, confirmed: false, result: uncertainResult(), uncertain: true };
      }

      // Upgrade safety: old operation records did not have a scope ledger. If
      // any prior dispatch for this message already crossed the boundary,
      // synthesize a sealed authorization before considering a changed retry.
      if (!auth) {
        const legacy = recordsForScope(dir, String(scopeId));
        const dangerous = legacy.filter(({ record }) =>
          ['dispatching', 'uncertain', 'completed'].includes(record?.status));
        if (dangerous.length) {
          auth = {
            version: 1,
            scopeId: String(scopeId),
            originAttemptId: dangerous[0].record?.attemptId || 'legacy',
            authorizedPayloads: [...new Set(legacy.map(({ record }) => record?.payloadHash).filter(Boolean))],
            sealed: true,
            ...source,
            createdAt: Math.min(...dangerous.map(({ record }) => Number(record?.createdAt) || Date.now())),
            updatedAt: Date.now(),
          };
          writeRecord(authPaths.recordPath, auth);
        }
      }

      if (auth && String(auth.originAttemptId) !== String(attemptId)) {
        if (auth.sealed === true) {
          // A matching operation may replay its completed result. A changed
          // payload is new authority and must come from a new user message,
          // not a browser Retry of the old one.
          if (!Array.isArray(auth.authorizedPayloads)
            || !auth.authorizedPayloads.includes(payloadHash)) {
            return { deduped: true, confirmed: false, result: retryPayloadChangedResult(), uncertain: true };
          }
          if (!readRecord(recordPath)) {
            return { deduped: true, confirmed: false, result: uncertainResult(), uncertain: true };
          }
        } else {
          // The scope lock was held across preflight. Acquiring it here proves
          // the old caller either returned or died. With no dispatch boundary
          // crossed, stale preflight claims are safe to discard and the retry
          // becomes the new originating attempt.
          for (const { filePath, record } of recordsForScope(dir, String(scopeId))) {
            if (record?.status === 'preflight') fs.rmSync(filePath, { force: true });
            else if (record) {
              auth.sealed = true;
              writeRecord(authPaths.recordPath, auth);
              return { deduped: true, confirmed: false, result: uncertainResult(), uncertain: true };
            }
          }
          auth = null;
          fs.rmSync(authPaths.recordPath, { force: true });
        }
      }

      if (!auth) {
        auth = {
          version: 1,
          scopeId: String(scopeId),
          originAttemptId: String(attemptId),
          authorizedPayloads: [],
          sealed: false,
          ...source,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }
      if (!Array.isArray(auth.authorizedPayloads)) auth.authorizedPayloads = [];
      if (!auth.authorizedPayloads.includes(payloadHash)) {
        if (auth.authorizedPayloads.length >= MAX_AUTHORIZED_PAYLOADS) {
          return {
            deduped: true,
            confirmed: false,
            result: 'Tool error: Too many distinct email sends were requested in one message; no additional email was sent.',
            uncertain: true,
          };
        }
        auth.authorizedPayloads.push(payloadHash);
      }
      auth.updatedAt = Date.now();
      writeRecord(authPaths.recordPath, auth);

      const beforeDispatch = () => {
        // Seal BEFORE the operation's dispatching marker and provider call. If
        // the process stops between writes, a new attempt still fails closed.
        auth.sealed = true;
        auth.updatedAt = Date.now();
        writeRecord(authPaths.recordPath, auth);
      };

      try {
        const outcome = await executeOperation(beforeDispatch);
        if (!auth.sealed) {
          const remaining = recordsForScope(dir, String(scopeId));
          if (!remaining.length) fs.rmSync(authPaths.recordPath, { force: true });
        }
        return outcome;
      } catch (error) {
        if (!auth.sealed) {
          const remaining = recordsForScope(dir, String(scopeId));
          if (!remaining.length) fs.rmSync(authPaths.recordPath, { force: true });
        }
        throw error;
      }
    }, { timeoutMs: LOCK_TIMEOUT_MS });
  };

  const operation = run();

  // Store the first caller's operation promise. A concurrent caller gets the
  // explicit duplicate-suppressed result above, while the first sees the real
  // provider result.
  _inflight.set(operationId, operation);
  try {
    const outcome = await operation;
    if (outcome.deduped && !outcome.uncertain) return duplicateResult(outcome.result);
    return outcome.result;
  } finally {
    if (_inflight.get(operationId) === operation) _inflight.delete(operationId);
  }
}
