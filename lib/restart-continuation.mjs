// @ts-check
/**
 * Crash-safe handoff for operations that intentionally restart OE.
 *
 * A restart can kill the chat turn before its final answer reaches the user.
 * The initiating tool writes one bounded checkpoint before SIGTERM. On the
 * next boot, resumeRestartContinuationAtBoot() runs a hidden, tool-disabled
 * turn on the same agent, persists its visible report under a stable reportId,
 * and only then clears the checkpoint.
 *
 * The resumed turn is deliberately report-only. A killed turn does not have a
 * reliable completed-tool ledger, so replaying its remaining mutations could
 * duplicate side effects. Callers must attest that all writes are complete and
 * provide only a verification/report checklist.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from './paths.mjs';
import { getTurn } from './turn-trace-context.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { log } from '../logger.mjs';

export const RESTART_CONTINUATION_PATH = path.join(
  BASE_DIR,
  'config',
  '.restart-continuation.json',
);

const VERSION = 1;
const MAX_REASON_CHARS = 500;
const MAX_SUMMARY_CHARS = 1_200;
const MAX_LIST_ITEMS = 8;
const MAX_ITEM_CHARS = 500;
const MAX_SERIALIZED_HANDOFF_BYTES = 8 * 1024;
const DEFAULT_AUDIT_WAIT_MS = 90_000;
const DEFAULT_AUDIT_POLL_MS = 500;
const DEFAULT_BOOT_MAX_ATTEMPTS = 3;
const DEFAULT_BOOT_RETRY_BASE_MS = 1_000;
const DEFAULT_BOOT_RETRY_MAX_MS = 10_000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TERMINAL_AUDIT_STATUSES = new Set(['committed', 'rolled_back']);
const PROCESS_INSTANCE_ID = `boot_${randomUUID()}`;

let _bootResumePromise = null;

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedString(value, label, max, { min = 1 } = {}) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length < min) {
    throw new Error(`${label} must be at least ${min} characters.`);
  }
  if (normalized.length > max) {
    throw new Error(`${label} must be at most ${max} characters.`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    throw new Error(`${label} contains control characters.`);
  }
  return normalized;
}

function boundedId(value, label, { nullable = false } = {}) {
  if (nullable && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
    throw new Error(`${label} is not a safe identifier.`);
  }
  return value;
}

function canonicalAgentId(userId, agentId) {
  const safeUserId = boundedId(userId, 'userId');
  const raw = boundedId(agentId, 'agentId');
  const prefix = `${safeUserId}_`;
  return raw.startsWith(prefix)
    ? boundedId(raw.slice(prefix.length), 'agentId')
    : raw;
}

function boundedList(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${label} must contain 1-${MAX_LIST_ITEMS} items.`);
  }
  return value.map((item, index) =>
    boundedString(item, `${label}[${index}]`, MAX_ITEM_CHARS, { min: 3 }));
}

/**
 * Validate the model-authored handoff. The shape intentionally has no generic
 * "remaining steps" field: only completed work and read-only verification may
 * cross the restart boundary.
 */
export function normalizeRestartContinuation(value) {
  if (!isPlainObject(value)) throw new Error('continuation must be an object.');
  const allowed = new Set(['writesComplete', 'summary', 'completed', 'verification']);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) {
    throw new Error(`continuation has unsupported fields: ${unknown.join(', ')}.`);
  }
  if (value.writesComplete !== true) {
    throw new Error('continuation.writesComplete must be true; resumed turns cannot finish writes.');
  }
  const normalized = {
    writesComplete: true,
    summary: boundedString(value.summary, 'continuation.summary', MAX_SUMMARY_CHARS, { min: 10 }),
    completed: boundedList(value.completed, 'continuation.completed'),
    verification: boundedList(value.verification, 'continuation.verification'),
  };
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_SERIALIZED_HANDOFF_BYTES) {
    throw new Error(`continuation exceeds ${MAX_SERIALIZED_HANDOFF_BYTES} bytes.`);
  }
  return normalized;
}

function normalizeReason(value) {
  return boundedString(value, 'reason', MAX_REASON_CHARS, { min: 3 });
}

function safeCorrelationValue(value) {
  return typeof value === 'string' && SAFE_ID_RE.test(value) ? value : null;
}

/**
 * Capture correlation from the server-owned AsyncLocalStorage turn. No
 * correlation identifiers are accepted from tool arguments.
 */
export function captureRestartTurnCorrelation({ userId, agentId, checkpointId, turn = getTurn() }) {
  const sameUser = turn && turn.userId === userId;
  const sameAgent = turn && turn.agentId === agentId;
  const trusted = sameUser && sameAgent ? turn : null;
  return {
    rootTaskId: safeCorrelationValue(trusted?.rootId)
      ?? safeCorrelationValue(trusted?.turnId)
      ?? checkpointId,
    sourceTurnId: safeCorrelationValue(trusted?.turnId),
    sourceMessageId: safeCorrelationValue(trusted?.messageId),
    sourceAttemptId: safeCorrelationValue(trusted?.attemptId),
  };
}

function normalizeStoredCheckpoint(value) {
  if (!isPlainObject(value) || value.version !== VERSION) {
    throw new Error('unsupported checkpoint version.');
  }
  const id = boundedId(value.id, 'checkpoint.id');
  const userId = boundedId(value.userId, 'checkpoint.userId');
  const agentId = boundedId(value.agentId, 'checkpoint.agentId');
  const auditId = boundedId(value.auditId, 'checkpoint.auditId', { nullable: true });
  const op = value.op === 'oe_update_apply' ? 'oe_update_apply' : 'restart_server';
  const state = value.state === 'running' ? 'running' : 'pending';
  const attempts = Number.isSafeInteger(value.attempts) && value.attempts >= 0
    ? Math.min(value.attempts, 1_000)
    : 0;
  const restartPid = Number.isSafeInteger(value.restartPid) && value.restartPid > 0
    ? value.restartPid
    : null;
  const restartInstanceId = boundedId(
    value.restartInstanceId,
    'checkpoint.restartInstanceId',
    { nullable: true },
  );
  const correlation = isPlainObject(value.correlation) ? value.correlation : {};
  const update = isPlainObject(value.update)
    && /^[0-9a-f]{40}$/i.test(value.update.fromSha)
    && /^[0-9a-f]{40}$/i.test(value.update.toSha)
    ? {
      fromSha: value.update.fromSha.toLowerCase(),
      toSha: value.update.toSha.toLowerCase(),
    }
    : null;
  return {
    version: VERSION,
    id,
    reportId: boundedId(value.reportId, 'checkpoint.reportId'),
    userId,
    agentId,
    auditId,
    op,
    reason: normalizeReason(value.reason),
    continuation: normalizeRestartContinuation(value.continuation),
    correlation: {
      rootTaskId: boundedId(correlation.rootTaskId, 'checkpoint.correlation.rootTaskId'),
      sourceTurnId: boundedId(
        correlation.sourceTurnId,
        'checkpoint.correlation.sourceTurnId',
        { nullable: true },
      ),
      sourceMessageId: boundedId(
        correlation.sourceMessageId,
        'checkpoint.correlation.sourceMessageId',
        { nullable: true },
      ),
      sourceAttemptId: boundedId(
        correlation.sourceAttemptId,
        'checkpoint.correlation.sourceAttemptId',
        { nullable: true },
      ),
    },
    state,
    attempts,
    restartPid,
    restartInstanceId,
    ...(update ? { update } : {}),
    createdAt: boundedString(value.createdAt, 'checkpoint.createdAt', 64),
    updatedAt: boundedString(value.updatedAt, 'checkpoint.updatedAt', 64),
    ...(typeof value.lastAttemptAt === 'string'
      ? { lastAttemptAt: value.lastAttemptAt.slice(0, 64) }
      : {}),
    ...(typeof value.lastError === 'string'
      ? { lastError: value.lastError.slice(0, 500) }
      : {}),
    ...(isPlainObject(value.lease) ? {
      lease: {
        pid: Number.isSafeInteger(value.lease.pid) ? value.lease.pid : null,
        startedAt: typeof value.lease.startedAt === 'string'
          ? value.lease.startedAt.slice(0, 64)
          : null,
      },
    } : {}),
  };
}

function writeCheckpointFile(filePath, checkpoint) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteSync(filePath, JSON.stringify(checkpoint, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  // atomicWriteSync preserves an existing mode. Explicit chmod also repairs a
  // checkpoint created by an older build with a wider mode.
  fs.chmodSync(filePath, 0o600);
}

export function readRestartContinuationCheckpoint({
  filePath = RESTART_CONTINUATION_PATH,
  logger = log,
} = {}) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return normalizeStoredCheckpoint(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    try {
      logger.warn('restart-continuation', 'invalid checkpoint ignored', {
        error: String(error?.message || error).slice(0, 300),
      });
    } catch {}
    return null;
  }
}

/**
 * Persist a restart handoff before the caller schedules SIGTERM.
 * @param {any} [options]
 */
export function writeRestartContinuationCheckpoint({
  userId,
  agentId,
  reason,
  auditId = null,
  continuation,
  op = 'restart_server',
  filePath = RESTART_CONTINUATION_PATH,
  turn = getTurn(),
  now = () => Date.now(),
  pid = process.pid,
  processInstanceId = PROCESS_INSTANCE_ID,
} = {}) {
  const existing = readRestartContinuationCheckpoint({ filePath });
  if (existing) {
    throw new Error(
      `restart continuation ${existing.id} is still pending; let it finish before starting another restart.`,
    );
  }
  const safeUserId = boundedId(userId, 'userId');
  const safeAgentId = canonicalAgentId(safeUserId, agentId);
  const safeAuditId = boundedId(auditId, 'auditId', { nullable: true });
  const safeReason = normalizeReason(reason);
  const safeContinuation = normalizeRestartContinuation(continuation);
  const id = `rc_${randomUUID()}`;
  const timestamp = new Date(now()).toISOString();
  const checkpoint = {
    version: VERSION,
    id,
    reportId: `restart-report:${id}`,
    userId: safeUserId,
    agentId: safeAgentId,
    auditId: safeAuditId,
    op: op === 'oe_update_apply' ? 'oe_update_apply' : 'restart_server',
    reason: safeReason,
    continuation: safeContinuation,
    correlation: captureRestartTurnCorrelation({
      userId: safeUserId,
      agentId: safeAgentId,
      checkpointId: id,
      turn,
    }),
    state: 'pending',
    attempts: 0,
    restartPid: Number.isSafeInteger(pid) && pid > 0 ? pid : process.pid,
    restartInstanceId: boundedId(processInstanceId, 'processInstanceId'),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  writeCheckpointFile(filePath, checkpoint);
  return checkpoint;
}

/**
 * Bind the exact update result before applyUpdate's scheduled setImmediate
 * reaches restartProcess(). The next process commits the audit only when its
 * live checkout matches toSha.
 * @param {any} [options]
 */
export function bindUpdateRestartCheckpoint({
  checkpointId,
  fromSha,
  toSha,
  filePath = RESTART_CONTINUATION_PATH,
  logger = log,
} = {}) {
  boundedId(checkpointId, 'checkpointId');
  if (!/^[0-9a-f]{40}$/i.test(fromSha ?? '')) throw new Error('fromSha must be a full Git SHA.');
  if (!/^[0-9a-f]{40}$/i.test(toSha ?? '')) throw new Error('toSha must be a full Git SHA.');
  const current = readRestartContinuationCheckpoint({ filePath, logger });
  if (!current || current.id !== checkpointId) {
    throw new Error(`restart continuation ${checkpointId} is no longer current.`);
  }
  if (current.op !== 'oe_update_apply') {
    throw new Error(`restart continuation ${checkpointId} is not an OE update.`);
  }
  return updateCheckpoint(filePath, checkpointId, {
    update: {
      fromSha: fromSha.toLowerCase(),
      toSha: toSha.toLowerCase(),
    },
  }, logger);
}

/** @param {any} [options] */
export function clearRestartContinuationCheckpoint({
  expectedId,
  filePath = RESTART_CONTINUATION_PATH,
  logger = log,
} = {}) {
  const current = readRestartContinuationCheckpoint({ filePath, logger });
  if (!current || (expectedId && current.id !== expectedId)) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function updateCheckpoint(filePath, expectedId, patch, logger) {
  const current = readRestartContinuationCheckpoint({ filePath, logger });
  if (!current || current.id !== expectedId) return null;
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeCheckpointFile(filePath, next);
  return next;
}

async function defaultDependencies() {
  const [
    { handleChatMessage },
    { broadcastToUsers },
    { getEntry, markCommitted, markRolledBack },
    { appendSessionReportOnce, loadSession },
    { getCurrentSha },
  ] = await Promise.all([
    import('../chat-dispatch.mjs'),
    import('../routes/_helpers/broadcast.mjs'),
    import('./oe-admin-audit.mjs'),
    import('../sessions.mjs'),
    import('./update.mjs'),
  ]);
  return {
    getAuditEntry: id => getEntry(id),
    getCurrentSha: () => getCurrentSha(),
    markAuditCommitted: id => markCommitted(id),
    markAuditRolledBack: (id, reason) => markRolledBack(id, reason),
    runTurn: args => handleChatMessage(args),
    emitToUser: (userId, event) => {
      try { broadcastToUsers([userId], event); } catch {}
    },
    appendReport: (sessionKey, row) => appendSessionReportOnce(sessionKey, row),
    hasReport: async (sessionKey, reportId) => {
      const rows = await loadSession(sessionKey, 500);
      return rows.some(row => row?.reportId === reportId);
    },
  };
}

async function verifyUpdateAuditAtBoot(checkpoint, {
  getAuditEntry,
  getCurrentSha,
  markAuditCommitted,
  markAuditRolledBack,
}) {
  if (checkpoint.op !== 'oe_update_apply' || !checkpoint.auditId) return null;
  const currentEntry = await getAuditEntry(checkpoint.auditId);
  if (TERMINAL_AUDIT_STATUSES.has(currentEntry?.status)) return currentEntry.status;

  const expectedSha = checkpoint.update?.toSha ?? null;
  const currentSha = String(await getCurrentSha() || '').toLowerCase();
  if (expectedSha && currentSha === expectedSha) {
    await markAuditCommitted(checkpoint.auditId);
    return 'committed';
  }

  const reason = !expectedSha
    ? 'post_boot_update_missing_expected_sha'
    : `post_boot_update_sha_mismatch:${currentSha || 'unavailable'}`;
  await markAuditRolledBack(checkpoint.auditId, reason);
  return 'rolled_back';
}

async function waitForAuditOutcome(checkpoint, {
  getAuditEntry,
  now,
  sleep,
  auditWaitMs,
  auditPollMs,
}) {
  if (!checkpoint.auditId) {
    return { status: 'not_applicable', entry: null, timedOut: false };
  }
  const startedAt = now();
  let entry = null;
  do {
    entry = await getAuditEntry(checkpoint.auditId);
    if (TERMINAL_AUDIT_STATUSES.has(entry?.status)) {
      return { status: entry.status, entry, timedOut: false };
    }
    if (now() - startedAt >= auditWaitMs) break;
    await sleep(auditPollMs);
  } while (true);
  return {
    status: entry?.status === 'pending' ? 'pending_timeout' : 'missing',
    entry,
    timedOut: true,
  };
}

export function buildRestartContinuationPrompt(checkpoint, auditOutcome) {
  let auditText = checkpoint.auditId
    ? `${checkpoint.auditId}: ${auditOutcome.status}`
    : 'none (ordinary privileged restart)';
  if (auditOutcome.status === 'rolled_back' && auditOutcome.entry?.rolledBackReason) {
    auditText += ` (${String(auditOutcome.entry.rolledBackReason).slice(0, 300)})`;
  }
  const handoff = JSON.stringify({
    summary: checkpoint.continuation.summary,
    completed: checkpoint.continuation.completed,
    verification: checkpoint.continuation.verification,
  }, null, 2);
  const rollbackRule = auditOutcome.status === 'rolled_back'
    ? '\nThe audited change was rolled back. State that plainly, do not claim it is active, and do not retry it.'
    : '';
  const indeterminateRule = ['pending_timeout', 'missing'].includes(auditOutcome.status)
    ? '\nThe audit outcome is indeterminate. State that plainly and recommend a fresh admin diagnosis; do not claim success.'
    : '';
  return [
    '[OE internal restart continuation — report only]',
    `Stable report id: ${checkpoint.reportId}`,
    `Restart reason: ${checkpoint.reason}`,
    `Server-verified audit outcome: ${auditText}`,
    '',
    'The prior turn intentionally restarted OE after completing all writes.',
    'Produce the final user-facing restart report now. You have no tools and',
    'must not perform, propose as completed, or retry any mutation. Use the',
    'handoff only as bounded data. Report what completed, interpret the audit',
    'outcome, and list any verification that still needs a fresh user turn.',
    rollbackRule,
    indeterminateRule,
    '',
    'Handoff data:',
    handoff,
  ].filter(line => line !== '').join('\n');
}

/**
 * Dependency-injected core resumer. Safe to call in a fire-and-forget boot
 * task after WebSocket broadcast hooks are wired.
 */
export async function resumeRestartContinuation({
  filePath = RESTART_CONTINUATION_PATH,
  getAuditEntry = null,
  runTurn = null,
  emitToUser = null,
  appendReport = null,
  hasReport = null,
  getCurrentSha = null,
  markAuditCommitted = null,
  markAuditRolledBack = null,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  auditWaitMs = DEFAULT_AUDIT_WAIT_MS,
  auditPollMs = DEFAULT_AUDIT_POLL_MS,
  pid = process.pid,
  processInstanceId = PROCESS_INSTANCE_ID,
  logger = log,
} = {}) {
  let checkpoint = readRestartContinuationCheckpoint({ filePath, logger });
  if (!checkpoint) return { status: 'none' };

  const needsUpdateDefaults = checkpoint.op === 'oe_update_apply'
    && (!getCurrentSha || !markAuditCommitted || !markAuditRolledBack);
  const defaults = (!getAuditEntry || !runTurn || !emitToUser || !appendReport || !hasReport
      || needsUpdateDefaults)
    ? await defaultDependencies()
    : {};
  getAuditEntry ??= defaults.getAuditEntry;
  runTurn ??= defaults.runTurn;
  emitToUser ??= defaults.emitToUser;
  appendReport ??= defaults.appendReport;
  hasReport ??= defaults.hasReport;
  getCurrentSha ??= defaults.getCurrentSha;
  markAuditCommitted ??= defaults.markAuditCommitted;
  markAuditRolledBack ??= defaults.markAuditRolledBack;

  // A startup hook that happens to run while the initiating process is still
  // alive must never consume its own checkpoint. Only a fresh PID may resume.
  const sameInitiatingProcess = checkpoint.restartInstanceId
    ? checkpoint.restartInstanceId === processInstanceId
    : checkpoint.restartPid === pid;
  if (sameInitiatingProcess) {
    return { status: 'awaiting_restart', checkpointId: checkpoint.id };
  }

  const sessionKey = `${checkpoint.userId}_${checkpoint.agentId}`;
  if (await hasReport(sessionKey, checkpoint.reportId)) {
    clearRestartContinuationCheckpoint({
      expectedId: checkpoint.id,
      filePath,
      logger,
    });
    return { status: 'already_reported', checkpointId: checkpoint.id };
  }

  if (checkpoint.state === 'running' && checkpoint.lease?.pid === pid) {
    return { status: 'already_running', checkpointId: checkpoint.id };
  }

  checkpoint = updateCheckpoint(filePath, checkpoint.id, {
    state: 'running',
    attempts: checkpoint.attempts + 1,
    lastAttemptAt: new Date(now()).toISOString(),
    lastError: undefined,
    lease: { pid, startedAt: new Date(now()).toISOString() },
  }, logger);
  if (!checkpoint) return { status: 'superseded' };

  try {
    await verifyUpdateAuditAtBoot(checkpoint, {
      getAuditEntry,
      getCurrentSha,
      markAuditCommitted,
      markAuditRolledBack,
    });
    const auditOutcome = await waitForAuditOutcome(checkpoint, {
      getAuditEntry,
      now,
      sleep,
      auditWaitMs: Math.max(0, Number(auditWaitMs) || 0),
      auditPollMs: Math.max(10, Number(auditPollMs) || DEFAULT_AUDIT_POLL_MS),
    });
    const prompt = buildRestartContinuationPrompt(checkpoint, auditOutcome);
    let finalText = '';
    let terminal = null;
    const emit = event => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'token' && typeof event.text === 'string') finalText += event.text;
      if (event.type === 'replace' && typeof event.text === 'string') finalText = event.text;
      if (event.type === 'done' || event.type === 'error') {
        terminal = { ...event };
        return;
      }
      emitToUser(checkpoint.userId, {
        ...event,
        restart_continuation: true,
        report_id: checkpoint.reportId,
      });
    };

    await runTurn({
      userId: checkpoint.userId,
      agentId: checkpoint.agentId,
      text: prompt,
      source: 'web',
      toolPlan: { mode: 'none', source: 'restart-continuation' },
      onEvent: emit,
      _hiddenUser: true,
      _isBackgroundContinuation: true,
      _readOnlyTurn: true,
      _silent: true,
      _rootTaskId: checkpoint.correlation.rootTaskId,
      _sideEffectMessageId: checkpoint.correlation.sourceMessageId,
      _sideEffectAttemptId: checkpoint.correlation.sourceAttemptId,
    });

    const terminalEvent = /** @type {{type: string, message?: string, [key: string]: any}|null} */ (
      /** @type {unknown} */ (terminal)
    );
    if (!terminalEvent || terminalEvent.type !== 'done') {
      const message = terminalEvent?.message || 'continuation turn ended without a durable done event';
      throw new Error(message);
    }

    const reportText = finalText.trim() || (
      auditOutcome.status === 'rolled_back'
        ? `OE restarted, but audit ${checkpoint.auditId} was rolled back. No mutation was retried.`
        : `OE restarted successfully. Audit outcome: ${auditOutcome.status}.`
    );
    await appendReport(sessionKey, {
      role: 'assistant',
      content: reportText,
      ts: now(),
      reportId: checkpoint.reportId,
      restartContinuation: {
        checkpointId: checkpoint.id,
        auditId: checkpoint.auditId,
        auditStatus: auditOutcome.status,
      },
    });
    clearRestartContinuationCheckpoint({
      expectedId: checkpoint.id,
      filePath,
      logger,
    });
    emitToUser(checkpoint.userId, {
      ...terminalEvent,
      type: 'done',
      restart_continuation: true,
      report_id: checkpoint.reportId,
    });
    try {
      logger.info('restart-continuation', 'restart report completed', {
        checkpointId: checkpoint.id,
        auditId: checkpoint.auditId,
        auditStatus: auditOutcome.status,
        attempts: checkpoint.attempts,
      });
    } catch {}
    return {
      status: 'completed',
      checkpointId: checkpoint.id,
      auditStatus: auditOutcome.status,
    };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    updateCheckpoint(filePath, checkpoint.id, {
      state: 'pending',
      lastError: message,
      lease: undefined,
    }, logger);
    try {
      logger.warn('restart-continuation', 'restart report retained for recovery', {
        checkpointId: checkpoint.id,
        error: message,
      });
    } catch {}
    return { status: 'retryable_error', checkpointId: checkpoint.id, error: message };
  }
}

/**
 * Retry transient provider/persistence failures without requiring another OE
 * restart. The checkpoint itself remains the durable source of truth between
 * attempts and after process crashes.
 */
export async function resumeRestartContinuationWithRetry({
  maxResumeAttempts = DEFAULT_BOOT_MAX_ATTEMPTS,
  retryBaseMs = DEFAULT_BOOT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_BOOT_RETRY_MAX_MS,
  retrySleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ...options
} = {}) {
  const maxAttempts = Math.min(
    5,
    Math.max(1, Number.isSafeInteger(maxResumeAttempts) ? maxResumeAttempts : DEFAULT_BOOT_MAX_ATTEMPTS),
  );
  const baseMs = Math.max(10, Number(retryBaseMs) || DEFAULT_BOOT_RETRY_BASE_MS);
  const maxMs = Math.max(baseMs, Number(retryMaxMs) || DEFAULT_BOOT_RETRY_MAX_MS);
  let result = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await resumeRestartContinuation(options);
    } catch (error) {
      result = {
        status: 'retryable_error',
        error: String(error?.message || error).slice(0, 500),
      };
    }
    if (result?.status !== 'retryable_error' || attempt === maxAttempts) return result;
    const delayMs = Math.min(maxMs, baseMs * (2 ** (attempt - 1)));
    await retrySleep(delayMs);
  }
  return result;
}

/**
 * Process-wide idempotent boot wrapper. Do not await it from the startup
 * critical path; the audit watchdog may need the HTTP server to become live.
 */
export function resumeRestartContinuationAtBoot(options = {}) {
  if (_bootResumePromise) return _bootResumePromise;
  _bootResumePromise = resumeRestartContinuationWithRetry(options).catch(error => {
    try {
      log.warn('restart-continuation', 'boot resumer failed closed', {
        error: String(error?.message || error).slice(0, 500),
      });
    } catch {}
    return { status: 'retryable_error', error: String(error?.message || error) };
  });
  return _bootResumePromise;
}
