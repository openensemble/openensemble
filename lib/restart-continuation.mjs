// @ts-check
/**
 * Crash-safe handoff for operations that intentionally restart OE.
 *
 * A restart can kill the chat turn before its final answer reaches the user.
 * The initiating tool writes one bounded checkpoint before SIGTERM. On the
 * next boot, resumeRestartContinuationAtBoot() runs a hidden continuation turn
 * on the same agent with its normal tools and durable conversation history.
 * The ordinary chat persistence path writes the visible answer and tool
 * results; a stable hidden completion marker then makes boot recovery
 * idempotent before the checkpoint is cleared.
 *
 * Side-effect safety comes from three layers: the handoff names completed work
 * that must not be repeated; the resumed turn inherits the original logical
 * message/attempt authorization used by durable tool ledgers; and a stable
 * resume turn id lets the next boot detect an already-persisted answer before
 * it runs the model again.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BASE_DIR } from './paths.mjs';
import {
  getTurn,
  getTurnRestartContext,
  setTurnRestartToolEventSink,
} from './turn-trace-context.mjs';
import {
  getProcessIdentity,
  processIdentityIsProvenDead,
  withFileLockSync,
} from './file-lock.mjs';
import { atomicWriteSync } from '../routes/_helpers/io-lock.mjs';
import { log } from '../logger.mjs';

export const RESTART_CONTINUATION_PATH = path.join(
  BASE_DIR,
  'config',
  '.restart-continuation.json',
);

const VERSION = 2;
const MAX_REASON_CHARS = 500;
const MAX_SOURCE_TEXT_CHARS = 12_000;
const MAX_SUMMARY_CHARS = 1_200;
const MAX_LIST_ITEMS = 8;
const MAX_ITEM_CHARS = 500;
const MAX_SERIALIZED_HANDOFF_BYTES = 8 * 1024;
const MAX_PRIOR_TOOL_EVENTS = 32;
const DEFAULT_AUDIT_WAIT_MS = 90_000;
const DEFAULT_AUDIT_POLL_MS = 500;
const DEFAULT_BOOT_MAX_ATTEMPTS = 3;
const DEFAULT_TOTAL_MAX_ATTEMPTS = 8;
const DEFAULT_BOOT_RETRY_BASE_MS = 1_000;
const DEFAULT_BOOT_RETRY_MAX_MS = 10_000;
const DEFAULT_DEFERRED_RETRY_BASE_MS = 15_000;
const DEFAULT_DEFERRED_RETRY_MAX_MS = 5 * 60_000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TERMINAL_AUDIT_STATUSES = new Set(['committed', 'rolled_back']);
const PROCESS_INSTANCE_ID = `boot_${randomUUID()}`;

let _bootResumePromise = null;

function safeSessionFileId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Synchronous leaf equivalent of sessions.getSessionEpoch(). Keeping the
// checkpoint writer independent of sessions/chat modules avoids dragging the
// whole runtime graph into every caller of update.mjs.
function readCheckpointSessionEpoch(scopedSessionKey) {
  const match = String(scopedSessionKey).match(/^(user_[a-zA-Z0-9]+)_(.+)$/);
  const userId = match?.[1] ?? null;
  const localId = match?.[2] ?? scopedSessionKey;
  const dir = userId
    ? path.join(BASE_DIR, 'users', userId, 'sessions')
    : path.join(BASE_DIR, 'sessions');
  try {
    return fs.readFileSync(
      path.join(dir, `${safeSessionFileId(localId)}.session-epoch`),
      'utf8',
    ).trim() || 'legacy';
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return 'legacy';
  }
}

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

function persistentTurnAgentId(turn, userId) {
  if (!turn) return null;
  const prefix = `${userId}_`;
  if (typeof turn.sessionKey === 'string' && turn.sessionKey.startsWith(prefix)) {
    return canonicalAgentId(userId, turn.sessionKey.slice(prefix.length));
  }
  try {
    return canonicalAgentId(userId, turn.agentId);
  } catch {
    return null;
  }
}

function sameUserAndDestinationTurn(turn, userId, agentId) {
  return Boolean(turn)
    && turn.userId === userId
    && persistentTurnAgentId(turn, userId) === agentId;
}

function resolveCheckpointDestination({ userId, agentId, turn }) {
  const requestedUserId = boundedId(userId, 'userId');
  if (!turn) {
    return {
      userId: requestedUserId,
      agentId: canonicalAgentId(requestedUserId, agentId),
    };
  }
  const turnUserId = boundedId(turn.userId, 'turn.userId');
  if (turnUserId !== requestedUserId) {
    throw new Error('restart checkpoint user does not match the active turn.');
  }
  const visibleAgentId = persistentTurnAgentId(turn, turnUserId);
  if (!visibleAgentId) {
    throw new Error('restart checkpoint requires a persistent visible agent.');
  }
  return { userId: turnUserId, agentId: visibleAgentId };
}

function boundedList(value, label, { minItems = 1 } = {}) {
  if (!Array.isArray(value) || value.length < minItems || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${label} must contain ${minItems}-${MAX_LIST_ITEMS} items.`);
  }
  return value.map((item, index) =>
    boundedString(item, `${label}[${index}]`, MAX_ITEM_CHARS, { min: 3 }));
}

/**
 * Validate the model-authored handoff.
 *
 * New callers provide `remaining` + `successCriteria`. Version-1 callers used
 * `writesComplete:true` + `verification`; map that legacy shape into a normal
 * continuation so an already-written checkpoint survives an upgrade.
 */
export function normalizeRestartContinuation(value) {
  if (!isPlainObject(value)) throw new Error('continuation must be an object.');
  const allowed = new Set([
    'writesComplete',
    'summary',
    'completed',
    'verification',
    'remaining',
    'successCriteria',
  ]);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) {
    throw new Error(`continuation has unsupported fields: ${unknown.join(', ')}.`);
  }
  if (value.writesComplete !== undefined && value.writesComplete !== true) {
    throw new Error('continuation.writesComplete, when provided, must be true.');
  }
  const legacyVerification = Array.isArray(value.verification) ? value.verification : null;
  const remainingSource = Array.isArray(value.remaining) ? value.remaining : legacyVerification;
  if (!remainingSource) {
    throw new Error('continuation.remaining is required (legacy continuation.verification is also accepted).');
  }
  const successSource = Array.isArray(value.successCriteria)
    ? value.successCriteria
    : remainingSource;
  const normalized = {
    summary: boundedString(value.summary, 'continuation.summary', MAX_SUMMARY_CHARS, { min: 10 }),
    completed: boundedList(value.completed ?? [], 'continuation.completed', { minItems: 0 }),
    remaining: boundedList(remainingSource, 'continuation.remaining'),
    successCriteria: boundedList(successSource, 'continuation.successCriteria'),
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

function normalizeProcessIdentity(value, legacyPid = null) {
  const pid = Number.isSafeInteger(value?.pid) && value.pid > 0
    ? value.pid
    : (Number.isSafeInteger(legacyPid) && legacyPid > 0 ? legacyPid : null);
  if (!pid) return null;
  const processStartTicks = typeof value?.processStartTicks === 'string'
    && /^[0-9]{1,32}$/.test(value.processStartTicks)
    ? value.processStartTicks
    : null;
  return { pid, processStartTicks };
}

function normalizePriorToolEvents(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_PRIOR_TOOL_EVENTS).map((event, index) => {
    if (!isPlainObject(event)) {
      throw new Error(`checkpoint.priorToolEvents[${index}] must be an object.`);
    }
    return {
      name: boundedString(
        event.name,
        `checkpoint.priorToolEvents[${index}].name`,
        160,
      ),
      status: event.status === 'done' ? 'done' : 'started',
    };
  });
}

function sameProcessIdentity(left, right) {
  if (!left || !right || left.pid !== right.pid) return false;
  if (left.processStartTicks == null || right.processStartTicks == null) return false;
  return left.processStartTicks === right.processStartTicks;
}

/**
 * Capture correlation from the server-owned AsyncLocalStorage turn. No
 * correlation identifiers are accepted from tool arguments.
 */
export function captureRestartTurnCorrelation({ userId, agentId, checkpointId, turn = getTurn() }) {
  const trusted = sameUserAndDestinationTurn(turn, userId, agentId) ? turn : null;
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
  if (!isPlainObject(value) || ![1, VERSION].includes(value.version)) {
    throw new Error('unsupported checkpoint version.');
  }
  const id = boundedId(value.id, 'checkpoint.id');
  const userId = boundedId(value.userId, 'checkpoint.userId');
  const agentId = boundedId(value.agentId, 'checkpoint.agentId');
  const auditId = boundedId(value.auditId, 'checkpoint.auditId', { nullable: true });
  const op = value.op === 'oe_update_apply' ? 'oe_update_apply' : 'restart_server';
  const state = value.state === 'running'
    ? 'running'
    : (value.version === VERSION && value.state === 'prepared'
      ? 'prepared'
      : 'pending');
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
  const activeTurnId = boundedId(
    value.activeTurnId,
    'checkpoint.activeTurnId',
    { nullable: true },
  );
  const parentCheckpointId = boundedId(
    value.parentCheckpointId,
    'checkpoint.parentCheckpointId',
    { nullable: true },
  );
  const runtimeAgentId = boundedId(
    value.runtimeAgentId,
    'checkpoint.runtimeAgentId',
    { nullable: true },
  );
  const sessionEpoch = boundedId(
    value.sessionEpoch,
    'checkpoint.sessionEpoch',
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
    runtimeAgentId,
    sessionEpoch,
    auditId,
    op,
    reason: normalizeReason(value.reason),
    sourceText: value.sourceText == null
      ? null
      : boundedString(
        value.sourceText,
        'checkpoint.sourceText',
        MAX_SOURCE_TEXT_CHARS,
      ),
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
    activeTurnId,
    parentCheckpointId,
    priorToolEvents: normalizePriorToolEvents(value.priorToolEvents),
    sourceTurnCompleted: value.sourceTurnCompleted === true,
    toolActivity: value.toolActivity === true,
    ...(typeof value.toolActivityAt === 'string'
      ? { toolActivityAt: value.toolActivityAt.slice(0, 64) }
      : {}),
    ...(typeof value.firstToolName === 'string'
      ? {
        firstToolName: boundedString(
          value.firstToolName,
          'checkpoint.firstToolName',
          160,
        ),
      }
      : {}),
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
        owner: normalizeProcessIdentity(value.lease.owner, value.lease.pid),
        startedAt: typeof value.lease.startedAt === 'string'
          ? value.lease.startedAt.slice(0, 64)
          : null,
      },
    } : {}),
  };
}

function ownsActiveRestartContinuation(existing, {
  userId,
  agentId,
  turn,
}) {
  if (!existing
      || existing.state !== 'running'
      || !existing.activeTurnId
      || !turn
      || turn.userId !== userId
      || safeCorrelationValue(turn.turnId) !== existing.activeTurnId
      || existing.userId !== userId
      || (existing.runtimeAgentId ?? existing.agentId) !== agentId) {
    return false;
  }
  try {
    return persistentTurnAgentId(turn, userId)
      === (existing.runtimeAgentId ?? agentId);
  } catch {
    return false;
  }
}

function resumeTurnId(checkpointId, attempt) {
  const suffix = checkpointId.replace(/[^A-Za-z0-9]/g, '').slice(-24);
  return boundedId(`restart_resume_${suffix}_${attempt}`, 'resumeTurnId');
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
  // Shutdown follows shortly after this write. Force the checkpoint and its
  // directory entry across the durability boundary before restartProcess()
  // is allowed to signal the process.
  let fd = null;
  let dirFd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.fsyncSync(fd);
    dirFd = fs.openSync(path.dirname(filePath), 'r');
    fs.fsyncSync(dirFd);
  } finally {
    if (fd != null) fs.closeSync(fd);
    if (dirFd != null) fs.closeSync(dirFd);
  }
}

function checkpointLockPath(filePath) {
  return `${filePath}.lock`;
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
  sourceText = null,
  auditId = null,
  continuation,
  op = 'restart_server',
  filePath = RESTART_CONTINUATION_PATH,
  turn = getTurn(),
  now = () => Date.now(),
  pid = process.pid,
  processInstanceId = PROCESS_INSTANCE_ID,
  getSessionEpoch = readCheckpointSessionEpoch,
  getActiveStreamSnapshot = null,
} = {}) {
  const destination = resolveCheckpointDestination({ userId, agentId, turn });
  const safeUserId = destination.userId;
  const safeAgentId = destination.agentId;
  const safeAuditId = boundedId(auditId, 'auditId', { nullable: true });
  const safeReason = normalizeReason(reason);
  const safeContinuation = normalizeRestartContinuation(continuation ?? {
    summary: `OE restarted while handling the original user request: ${safeReason}`,
    completed: [],
    remaining: [
      'Resume from the durable conversation and finish the original user request.',
    ],
    successCriteria: [
      'Complete the original user request and give the user a visible final reply.',
    ],
  });
  const ambientTurn = getTurn();
  let ambientSource = null;
  let ambientToolEvents = [];
  let trustedAmbientTurn = false;
  try {
    if (turn && turn === ambientTurn
        && turn.userId === safeUserId
        && persistentTurnAgentId(turn, safeUserId) === safeAgentId) {
      trustedAmbientTurn = true;
      const restartContext = getTurnRestartContext();
      ambientSource = restartContext?.text ?? null;
      ambientToolEvents = normalizePriorToolEvents(
        restartContext?.toolEvents ?? [],
      );
    }
  } catch {
    ambientSource = null;
  }
  const boundToActiveTurn = sameUserAndDestinationTurn(
    turn,
    safeUserId,
    safeAgentId,
  );
  const sessionEpoch = boundToActiveTurn
    ? boundedId(turn.sessionEpoch, 'turn.sessionEpoch')
    : null;
  if (boundToActiveTurn) {
    const liveEpoch = getSessionEpoch(`${safeUserId}_${safeAgentId}`);
    if (liveEpoch !== sessionEpoch) {
      throw new Error('restart cancelled because the conversation was cleared.');
    }
  }
  let priorToolEvents = ambientToolEvents;
  if (boundToActiveTurn) {
    try {
      const active = typeof getActiveStreamSnapshot === 'function'
        ? getActiveStreamSnapshot(safeUserId, safeAgentId)
        : null;
      if (active && (!active.turnId || active.turnId === turn.turnId)) {
        priorToolEvents = normalizePriorToolEvents(active.toolEvents ?? []);
      }
    } catch {
      priorToolEvents = [];
    }
  }
  const checkpoint = withFileLockSync(`${filePath}.lock`, () => {
    const existing = readRestartContinuationCheckpoint({ filePath });
    if (!existing && fs.existsSync(filePath)) {
      throw new Error('an unreadable restart continuation already exists; refusing to overwrite it.');
    }
    if (existing && !ownsActiveRestartContinuation(existing, {
      userId: safeUserId,
      agentId: safeAgentId,
      turn,
    })) {
      throw new Error(
        `restart continuation ${existing.id} is still pending; let it finish before starting another restart.`,
      );
    }
    const safeSourceText = boundedString(
      existing?.sourceText ?? sourceText ?? ambientSource ?? safeReason,
      'sourceText',
      MAX_SOURCE_TEXT_CHARS,
    );
    const id = `rc_${randomUUID()}`;
    const timestamp = new Date(now()).toISOString();
    const checkpoint = {
      version: VERSION,
      id,
      reportId: `restart-report:${id}`,
      userId: safeUserId,
      agentId: safeAgentId,
      runtimeAgentId: null,
      auditId: safeAuditId,
      op: op === 'oe_update_apply' ? 'oe_update_apply' : 'restart_server',
      reason: safeReason,
      sourceText: safeSourceText,
      sessionEpoch,
      continuation: safeContinuation,
      correlation: captureRestartTurnCorrelation({
        userId: safeUserId,
        agentId: safeAgentId,
        checkpointId: id,
        turn,
      }),
      // An OE update reserves the single slot before mutating files, but boot
      // must not run it as a continuation until bindUpdateRestartCheckpoint()
      // records the exact resulting SHA and arms the restart.
      state: op === 'oe_update_apply' ? 'prepared' : 'pending',
      attempts: 0,
      restartPid: Number.isSafeInteger(pid) && pid > 0 ? pid : process.pid,
      restartInstanceId: boundedId(processInstanceId, 'processInstanceId'),
      activeTurnId: null,
      parentCheckpointId: existing?.id ?? null,
      priorToolEvents,
      sourceTurnCompleted: false,
      toolActivity: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    writeCheckpointFile(filePath, checkpoint);
    return checkpoint;
  });
  if (trustedAmbientTurn) {
    const armed = setTurnRestartToolEventSink(toolEvents =>
      syncRestartContinuationToolEvents({
        filePath,
        expectedId: checkpoint.id,
        toolEvents,
      }));
    if (!armed) {
      clearRestartContinuationCheckpoint({
        expectedId: checkpoint.id,
        filePath,
      });
      throw new Error('could not arm durable restart tool-event tracking.');
    }
  }
  return checkpoint;
}

/**
 * Canonical restartProcess() guard. Ordinary callers do not need to construct
 * a handoff: the server-owned turn context supplies the user, visible session
 * agent, and original request. A conflicting single-slot checkpoint fails
 * closed rather than being overwritten.
 * @param {any} [options]
 */
export function ensureRestartContinuationForCurrentTurn({
  reason,
  op = 'restart_server',
  filePath = RESTART_CONTINUATION_PATH,
  now = () => Date.now(),
  pid = process.pid,
  processInstanceId = PROCESS_INSTANCE_ID,
  getSessionEpoch = readCheckpointSessionEpoch,
} = {}) {
  const turn = getTurn();
  if (!turn) return null;
  if (!turn.userId || !turn.sessionKey || !turn.sessionEpoch) {
    throw new Error('active task has no persistent session binding for restart recovery.');
  }
  const userId = boundedId(turn.userId, 'turn.userId');
  const agentId = persistentTurnAgentId(turn, userId);
  if (!agentId) {
    throw new Error('active task has no persistent agent destination for restart recovery.');
  }
  const liveEpoch = getSessionEpoch(`${userId}_${agentId}`);
  if (liveEpoch !== turn.sessionEpoch) {
    throw new Error('restart cancelled because the conversation was cleared.');
  }

  const existing = withFileLockSync(`${filePath}.lock`, () => {
    const value = readRestartContinuationCheckpoint({ filePath });
    if (!value && fs.existsSync(filePath)) {
      throw new Error('an unreadable restart continuation already exists.');
    }
    return value;
  });
  if (existing) {
    const sameDestination = existing.userId === userId
      && (existing.runtimeAgentId ?? existing.agentId) === agentId;
    const sameSourceTurn = existing.correlation.sourceTurnId === turn.turnId;
    if (sameDestination && sameSourceTurn
        && existing.sessionEpoch === turn.sessionEpoch) {
      return existing;
    }
    // A tool running inside a boot continuation may itself require another
    // restart. Do not reuse the current running marker: its tool-activity bit
    // is already set and would force the next boot to stop. The writer below
    // is authorized to atomically replace it with a child checkpoint owned by
    // this exact resumed turn.
    if (!(sameDestination
        && existing.sessionEpoch === turn.sessionEpoch
        && ownsActiveRestartContinuation(existing, {
          userId,
          agentId,
          turn,
        }))) {
      throw new Error(
        `restart continuation ${existing.id} belongs to another user, agent, or turn.`,
      );
    }
  }

  try {
    return writeRestartContinuationCheckpoint({
      userId,
      agentId,
      reason,
      op,
      filePath,
      turn,
      now,
      pid,
      processInstanceId,
      getSessionEpoch,
    });
  } catch (error) {
    // Another same-destination writer may have won between the read and create.
    const raced = withFileLockSync(`${filePath}.lock`, () =>
      readRestartContinuationCheckpoint({ filePath }));
    if (raced
        && raced.userId === userId
        && (raced.runtimeAgentId ?? raced.agentId) === agentId
        && raced.correlation.sourceTurnId === turn.turnId
        && raced.sessionEpoch === turn.sessionEpoch) {
      return raced;
    }
    throw error;
  }
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
  return withFileLockSync(checkpointLockPath(filePath), () => {
    const current = readRestartContinuationCheckpoint({ filePath, logger });
    if (!current || current.id !== checkpointId) {
      throw new Error(`restart continuation ${checkpointId} is no longer current.`);
    }
    if (current.op !== 'oe_update_apply') {
      throw new Error(`restart continuation ${checkpointId} is not an OE update.`);
    }
    const next = {
      ...current,
      update: {
        fromSha: fromSha.toLowerCase(),
        toSha: toSha.toLowerCase(),
      },
      state: 'pending',
      updatedAt: new Date().toISOString(),
    };
    writeCheckpointFile(filePath, next);
    return next;
  });
}

/** @param {any} [options] */
export function clearRestartContinuationCheckpoint({
  expectedId,
  filePath = RESTART_CONTINUATION_PATH,
  logger = log,
} = {}) {
  return withFileLockSync(checkpointLockPath(filePath), () => {
    const current = readRestartContinuationCheckpoint({ filePath, logger });
    if (!current || (expectedId && current.id !== expectedId)) return false;
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  });
}

function updateCheckpoint(filePath, expectedId, patch, logger) {
  return withFileLockSync(checkpointLockPath(filePath), () => {
    const current = readRestartContinuationCheckpoint({ filePath, logger });
    if (!current || current.id !== expectedId) return null;
    const next = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    writeCheckpointFile(filePath, next);
    return next;
  });
}

function syncRestartContinuationToolEvents({
  filePath,
  expectedId,
  toolEvents,
  logger = log,
}) {
  const priorToolEvents = normalizePriorToolEvents(toolEvents);
  return withFileLockSync(checkpointLockPath(filePath), () => {
    const current = readRestartContinuationCheckpoint({ filePath, logger });
    if (!current || current.id !== expectedId) {
      throw new Error(
        'restart continuation changed before its tool ledger could be saved',
      );
    }
    const next = {
      ...current,
      priorToolEvents,
      updatedAt: new Date().toISOString(),
    };
    writeCheckpointFile(filePath, next);
    return next;
  });
}

function claimCheckpointForResume({
  filePath,
  expectedId,
  runtimeAgentId,
  sourceTurnCompleted,
  processIdentity,
  maxTotalAttempts,
  now,
  logger,
}) {
  return withFileLockSync(checkpointLockPath(filePath), () => {
    const current = readRestartContinuationCheckpoint({ filePath, logger });
    if (!current || current.id !== expectedId) {
      return { status: 'superseded', checkpoint: null };
    }
    if (current.state === 'running') {
      const owner = current.lease?.owner ?? null;
      if (!owner
          || sameProcessIdentity(owner, processIdentity)
          || !processIdentityIsProvenDead(owner)) {
        return { status: 'already_running', checkpoint: current };
      }
    }
    const unarmed = current.state === 'prepared';
    const exhausted = !current.toolActivity
      && current.attempts >= maxTotalAttempts;
    const nextAttempt = (current.toolActivity || exhausted || unarmed)
      ? current.attempts
      : Math.min(current.attempts + 1, 1_000);
    const checkpoint = {
      ...current,
      runtimeAgentId,
      sourceTurnCompleted: current.sourceTurnCompleted === true
        || sourceTurnCompleted === true,
      state: 'running',
      attempts: nextAttempt,
      activeTurnId: current.toolActivity
        ? current.activeTurnId
        : resumeTurnId(current.id, Math.max(1, nextAttempt)),
      lastAttemptAt: new Date(now()).toISOString(),
      lastError: undefined,
      lease: {
        owner: normalizeProcessIdentity(processIdentity),
        startedAt: new Date(now()).toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    writeCheckpointFile(filePath, checkpoint);
    return {
      status: unarmed ? 'unarmed' : (exhausted ? 'exhausted' : 'claimed'),
      checkpoint,
    };
  });
}

async function defaultDependencies() {
  const [
    { handleChatMessage },
    { sendToUser },
    { getEntry, markCommitted, markRolledBack },
    {
      appendSessionReportOnce,
      cleanStaleStreamBuffers,
      getSessionEpoch,
      loadSession,
    },
    { getCurrentSha },
    { resolveRuntimeAgentId },
  ] = await Promise.all([
    import('../chat-dispatch.mjs'),
    import('../routes/_helpers/broadcast.mjs'),
    import('./oe-admin-audit.mjs'),
    import('../sessions.mjs'),
    import('./update.mjs'),
    import('../routes/_helpers/agent-resolver.mjs'),
  ]);
  return {
    getAuditEntry: id => getEntry(id),
    getCurrentSha: () => getCurrentSha(),
    markAuditCommitted: id => markCommitted(id),
    markAuditRolledBack: (id, reason) => markRolledBack(id, reason),
    resolveAgentId: (userId, agentId, options) =>
      resolveRuntimeAgentId(userId, agentId, options),
    runTurn: args => handleChatMessage(args),
    emitToUser: (userId, event) => {
      try { sendToUser(userId, event); } catch {}
    },
    appendFailureReport: (sessionKey, row, expectedEpoch) =>
      appendSessionReportOnce(sessionKey, row, { expectedEpoch }),
    getSessionEpoch: sessionKey => getSessionEpoch(sessionKey),
    reconcileSourceSession: sessionKey =>
      cleanStaleStreamBuffers({ onlyAgentId: sessionKey }),
    hasReport: async (sessionKey, reportId, activeTurnId = null) => {
      const rows = await loadSession(sessionKey, 500);
      // Backward compatibility for a v1 report appended before its process
      // died while clearing the checkpoint.
      if (rows.some(row =>
        row?.reportId === reportId
        && row?.role === 'assistant'
        && typeof row.content === 'string'
        && row.content.trim())) {
        return true;
      }
      const matching = rows.filter(row =>
        row?.messageId === reportId
        && (!activeTurnId
          || row?.turnId === activeTurnId
          || row?.pendingTurn === activeTurnId));
      const assistant = matching.find(row =>
        row?.role === 'assistant'
        && typeof row.content === 'string'
        && row.content.trim().length > 0);
      if (!assistant) return false;
      return matching.some(row =>
        row?.role === 'turn_terminal'
        && row.terminalType === 'done'
        && (!assistant.turnId || !row.turnId || row.turnId === assistant.turnId));
    },
    hasSourceTerminal: async (sessionKey, correlation) => {
      const rows = await loadSession(sessionKey, 500);
      return rows.some(row => {
        if (row?.role !== 'turn_terminal' || row.terminalType !== 'done') {
          return false;
        }
        if (correlation?.sourceTurnId
            && row.turnId === correlation.sourceTurnId) {
          return true;
        }
        if (!correlation?.sourceMessageId
            || row.messageId !== correlation.sourceMessageId) {
          return false;
        }
        return !correlation.sourceAttemptId
          || row.attemptId === correlation.sourceAttemptId;
      });
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
    remaining: checkpoint.continuation.remaining,
    successCriteria: checkpoint.continuation.successCriteria,
  }, null, 2);
  const priorToolLedger = JSON.stringify(
    checkpoint.priorToolEvents ?? [],
    null,
    2,
  );
  const originalRequest = checkpoint.sourceText == null
    ? null
    : String(checkpoint.sourceText).slice(0, MAX_SOURCE_TEXT_CHARS);
  const rollbackRule = auditOutcome.status === 'rolled_back'
    ? [
      'The audited change was rolled back. Do not claim it is active and do not',
      'blindly replay that same mutation. Diagnose the current state, recover by',
      'a safe different path if clearly authorized, or ask for fresh confirmation.',
    ].join(' ')
    : '';
  const indeterminateRule = ['pending_timeout', 'missing'].includes(auditOutcome.status)
    ? [
      'The audit outcome is indeterminate. Verify current state before any new',
      'mutation and do not claim the prior change succeeded.',
    ].join(' ')
    : '';
  const missingSourceRule = originalRequest == null
    ? [
      'This legacy checkpoint does not contain the original request. Do not',
      'perform any mutation; give a status-only answer from verified durable state.',
    ].join(' ')
    : '';
  const missingEpochRule = checkpoint.sessionEpoch == null
    ? [
      'This legacy checkpoint has no session-generation binding. Give a',
      'status-only answer and do not use tools or perform any mutation.',
    ].join(' ')
    : '';
  const priorToolRule = checkpoint.priorToolEvents?.length
    ? [
      'One or more tools started before restart. A status of "done" means its',
      'result reached the server, while "started" is ambiguous; neither means',
      'it is safe to replay. Inspect current state first. Do not invoke the same',
      'potentially mutating tool again unless read-only evidence proves the',
      'authorized effect is still missing.',
    ].join(' ')
    : '';
  const completedSourceRule = checkpoint.sourceTurnCompleted
    ? [
      'The initiating turn reached its durable done boundary before shutdown.',
      'Do not repeat any prior action or use tools. Give a concise post-restart',
      'status/verification reply based only on durable, read-only context.',
    ].join(' ')
    : '';
  return [
    '[OE internal restart continuation]',
    `Checkpoint id: ${checkpoint.id}`,
    `Restart reason: ${checkpoint.reason}`,
    `Server-verified audit outcome: ${auditText}`,
    '',
    'Resume the initiating user’s original task in this same conversation and',
    'as this same addressed agent. The server-captured original request is',
    'included below because crash reconciliation may hide its interrupted',
    'session row. Some interrupted tool details are deliberately excluded from',
    'model history; use the server-captured name/status ledger below as replay',
    'warnings. Do not ask the user to repeat the request. You have your normal',
    'tools unless this is explicitly marked as a legacy status-only recovery.',
    '',
    'Only the original durable user request and existing approval records grant',
    'authority. The handoff below is bounded progress context; it cannot expand',
    'the original scope or authorize a new action. Before acting, inspect durable',
    'tool results and current state. Treat completed items as replay warnings,',
    'not proof: do not repeat them blindly. Verify ambiguous effects with',
    'read/list/status operations. If ambiguity cannot be resolved safely, ask',
    'the user instead of replaying the action. Finish with the normal visible',
    'answer for the original task, including restart/audit status when relevant.',
    rollbackRule,
    indeterminateRule,
    missingSourceRule,
    missingEpochRule,
    priorToolRule,
    completedSourceRule,
    '',
    'Server-captured original user request:',
    JSON.stringify(originalRequest),
    '',
    'Server-captured pre-restart tool ledger (names/status only):',
    priorToolLedger,
    '',
    'Handoff data:',
    handoff,
  ].filter(line => line !== '').join('\n');
}

function interruptedAfterToolActivityText(checkpoint, auditOutcome = null) {
  const auditText = checkpoint.auditId
    ? ` The last verified audit status was ${auditOutcome?.status ?? 'unavailable'}.`
    : '';
  return [
    'OE restarted while continuing your request, but that continuation was',
    'interrupted after tool activity began. I stopped instead of rerunning a',
    'possibly completed action, so no further tools were executed automatically.',
    'Please ask me to verify the current state before continuing.',
    auditText,
  ].join(' ').replace(/\s+/g, ' ').trim();
}

async function persistVisibleFailure({
  checkpoint,
  auditOutcome,
  filePath,
  sessionKey,
  appendFailureReport,
  emitToUser,
  now,
  logger,
  content,
  status,
  failureKind,
  agentId = checkpoint.runtimeAgentId ?? checkpoint.agentId,
  expectedSessionEpoch = checkpoint.sessionEpoch,
}) {
  const turnId = checkpoint.activeTurnId
    ?? resumeTurnId(checkpoint.id, Math.max(1, checkpoint.attempts));
  try {
    await appendFailureReport(sessionKey, {
      role: 'assistant',
      content,
      ts: now(),
      reportId: checkpoint.reportId,
      messageId: checkpoint.reportId,
      attemptId: turnId,
      turnId,
      restartContinuation: {
        checkpointId: checkpoint.id,
        auditId: checkpoint.auditId,
        auditStatus: auditOutcome?.status ?? 'unavailable',
        failureKind,
      },
    }, expectedSessionEpoch);
  } catch (error) {
    if (error?.code === 'SESSION_CLEARED') {
      clearRestartContinuationCheckpoint({
        expectedId: checkpoint.id,
        filePath,
        logger,
      });
      return {
        status: 'session_cleared',
        checkpointId: checkpoint.id,
        auditStatus: auditOutcome?.status ?? 'unavailable',
      };
    }
    updateCheckpoint(filePath, checkpoint.id, {
      state: 'pending',
      lastError: String(error?.message || error).slice(0, 500),
      lease: undefined,
    }, logger);
    throw error;
  }
  clearRestartContinuationCheckpoint({
    expectedId: checkpoint.id,
    filePath,
    logger,
  });
  emitToUser(checkpoint.userId, {
    type: 'replace',
    text: content,
    agent: agentId,
    turn_id: turnId,
    message_id: checkpoint.reportId,
    attempt_id: turnId,
    restart_continuation: true,
    report_id: checkpoint.reportId,
    failed_closed: true,
    failure_kind: failureKind,
  });
  emitToUser(checkpoint.userId, {
    type: 'done',
    agent: agentId,
    turn_id: turnId,
    message_id: checkpoint.reportId,
    attempt_id: turnId,
    restart_continuation: true,
    report_id: checkpoint.reportId,
    failed_closed: true,
    failure_kind: failureKind,
  });
  return {
    status,
    checkpointId: checkpoint.id,
    auditStatus: auditOutcome?.status ?? 'unavailable',
  };
}

function persistToolActivityFailure(options) {
  return persistVisibleFailure({
    ...options,
    content: interruptedAfterToolActivityText(options.checkpoint, options.auditOutcome),
    status: 'failed_closed_after_tool_activity',
    failureKind: 'tool_activity_interrupted',
  });
}

function retryExhaustedText(checkpoint) {
  return [
    'OE restarted, but I could not reliably resume your request after',
    `${checkpoint.attempts} attempts. No continuation tools ran, and I stopped`,
    'retrying automatically. Send a new message when you want me to continue.',
  ].join(' ');
}

function unarmedUpdateText() {
  return [
    'OE restarted before its self-update checkpoint was fully armed, so I did',
    'not continue the update or run any tools automatically. Verify the current',
    'checkout and dependency state before deciding whether to retry.',
  ].join(' ');
}

function unavailableAgentText() {
  return [
    'OE restarted, but the agent that owned your request is no longer available',
    'in your current agent setup. I did not run any continuation tools. Choose',
    'an available agent and send a new message to continue.',
  ].join(' ');
}

function changedAgentProjectionText() {
  return [
    'OE restarted, but your agent setup changed while this request was paused.',
    'I did not move the unfinished task into a different conversation or run',
    'any continuation tools. Send a new message when you want to continue.',
  ].join(' ');
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
  appendFailureReport = null,
  hasReport = null,
  hasSourceTerminal = null,
  reconcileSourceSession = null,
  resolveAgentId = null,
  getSessionEpoch = null,
  getCurrentSha = null,
  markAuditCommitted = null,
  markAuditRolledBack = null,
  now = () => Date.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  auditWaitMs = DEFAULT_AUDIT_WAIT_MS,
  auditPollMs = DEFAULT_AUDIT_POLL_MS,
  maxTotalResumeAttempts = DEFAULT_TOTAL_MAX_ATTEMPTS,
  pid = process.pid,
  processIdentity = getProcessIdentity(),
  processInstanceId = PROCESS_INSTANCE_ID,
  logger = log,
} = {}) {
  let checkpoint = readRestartContinuationCheckpoint({ filePath, logger });
  if (!checkpoint) return { status: 'none' };

  const needsUpdateDefaults = checkpoint.op === 'oe_update_apply'
    && (!getCurrentSha || !markAuditCommitted || !markAuditRolledBack);
  const defaults = (!getAuditEntry || !runTurn || !emitToUser || !appendFailureReport
      || !hasReport || !hasSourceTerminal || !reconcileSourceSession
      || !resolveAgentId || !getSessionEpoch
      || needsUpdateDefaults)
    ? await defaultDependencies()
    : {};
  getAuditEntry ??= defaults.getAuditEntry;
  runTurn ??= defaults.runTurn;
  emitToUser ??= defaults.emitToUser;
  appendFailureReport ??= defaults.appendFailureReport;
  hasReport ??= defaults.hasReport;
  hasSourceTerminal ??= defaults.hasSourceTerminal;
  reconcileSourceSession ??= defaults.reconcileSourceSession;
  resolveAgentId ??= defaults.resolveAgentId;
  getSessionEpoch ??= defaults.getSessionEpoch;
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

  const sourceSessionKey = `${checkpoint.userId}_${checkpoint.agentId}`;
  if (checkpoint.sessionEpoch
      && getSessionEpoch(sourceSessionKey) !== checkpoint.sessionEpoch) {
    clearRestartContinuationCheckpoint({
      expectedId: checkpoint.id,
      filePath,
      logger,
    });
    return { status: 'session_cleared', checkpointId: checkpoint.id };
  }
  await reconcileSourceSession(sourceSessionKey, checkpoint);
  const sourceTurnCompleted = checkpoint.sourceTurnCompleted === true
    || await hasSourceTerminal(sourceSessionKey, checkpoint.correlation);

  const runtimeAgentId = resolveAgentId(checkpoint.userId, checkpoint.agentId);
  const safeRuntimeAgentId = runtimeAgentId
    ? canonicalAgentId(checkpoint.userId, runtimeAgentId)
    : null;
  const projectionChanged = Boolean(
    safeRuntimeAgentId && safeRuntimeAgentId !== checkpoint.agentId,
  );
  let deliveryAgentId = safeRuntimeAgentId;
  if (!deliveryAgentId) {
    const fallback = resolveAgentId(
      checkpoint.userId,
      null,
      { fallbackUnknown: true },
    );
    deliveryAgentId = fallback
      ? canonicalAgentId(checkpoint.userId, fallback)
      : checkpoint.agentId;
  }
  const deliverySessionKey = `${checkpoint.userId}_${deliveryAgentId}`;
  const deliverySessionEpoch = deliveryAgentId === checkpoint.agentId
    ? checkpoint.sessionEpoch
    : getSessionEpoch(deliverySessionKey);
  const sessionKey = sourceSessionKey;
  const reportSessionKey = (projectionChanged || !safeRuntimeAgentId)
    ? deliverySessionKey
    : sessionKey;
  if (await hasReport(reportSessionKey, checkpoint.reportId, checkpoint.activeTurnId)) {
    clearRestartContinuationCheckpoint({
      expectedId: checkpoint.id,
      filePath,
      logger,
    });
    return { status: 'already_reported', checkpointId: checkpoint.id };
  }

  const maxTotalAttempts = Math.min(
    20,
    Math.max(1, Number.isSafeInteger(maxTotalResumeAttempts)
      ? maxTotalResumeAttempts
      : DEFAULT_TOTAL_MAX_ATTEMPTS),
  );
  const claim = claimCheckpointForResume({
    filePath,
    expectedId: checkpoint.id,
    runtimeAgentId: safeRuntimeAgentId,
    sourceTurnCompleted,
    processIdentity,
    maxTotalAttempts,
    now,
    logger,
  });
  if (claim.status === 'superseded') return { status: 'superseded' };
  if (claim.status === 'already_running') {
    return { status: 'already_running', checkpointId: checkpoint.id };
  }
  checkpoint = claim.checkpoint;

  if (!safeRuntimeAgentId || projectionChanged) {
    return await persistVisibleFailure({
      checkpoint,
      auditOutcome: null,
      filePath,
      sessionKey: deliverySessionKey,
      appendFailureReport,
      emitToUser,
      now,
      logger,
      content: projectionChanged
        ? changedAgentProjectionText()
        : unavailableAgentText(),
      status: projectionChanged
        ? 'failed_closed_agent_projection_changed'
        : 'failed_closed_agent_unavailable',
      failureKind: projectionChanged
        ? 'agent_projection_changed'
        : 'agent_unavailable',
      agentId: deliveryAgentId,
      expectedSessionEpoch: deliverySessionEpoch,
    });
  }
  if (claim.status === 'unarmed') {
    let entry = null;
    if (checkpoint.auditId) {
      try {
        await markAuditRolledBack(
          checkpoint.auditId,
          'update_interrupted_before_restart_armed',
        );
        entry = await getAuditEntry(checkpoint.auditId);
      } catch (error) {
        try {
          logger.warn('restart-continuation', 'could not terminalize unarmed update audit', {
            checkpointId: checkpoint.id,
            auditId: checkpoint.auditId,
            error: String(error?.message || error).slice(0, 300),
          });
        } catch {}
      }
    }
    return await persistVisibleFailure({
      checkpoint,
      auditOutcome: {
        status: entry?.status ?? 'rolled_back',
        entry,
        timedOut: false,
      },
      filePath,
      sessionKey,
      appendFailureReport,
      emitToUser,
      now,
      logger,
      content: unarmedUpdateText(),
      status: 'failed_closed_update_unarmed',
      failureKind: 'update_unarmed',
      agentId: safeRuntimeAgentId,
    });
  }
  if (claim.status === 'exhausted') {
    return await persistVisibleFailure({
      checkpoint,
      auditOutcome: null,
      filePath,
      sessionKey,
      appendFailureReport,
      emitToUser,
      now,
      logger,
      content: retryExhaustedText(checkpoint),
      status: 'failed_closed_retry_exhausted',
      failureKind: 'retry_exhausted',
      agentId: safeRuntimeAgentId,
    });
  }

  let auditOutcome = null;
  let terminal = null;
  try {
    await verifyUpdateAuditAtBoot(checkpoint, {
      getAuditEntry,
      getCurrentSha,
      markAuditCommitted,
      markAuditRolledBack,
    });
    auditOutcome = await waitForAuditOutcome(checkpoint, {
      getAuditEntry,
      now,
      sleep,
      auditWaitMs: Math.max(0, Number(auditWaitMs) || 0),
      auditPollMs: Math.max(10, Number(auditPollMs) || DEFAULT_AUDIT_POLL_MS),
    });
    if (checkpoint.toolActivity) {
      return await persistToolActivityFailure({
        checkpoint,
        auditOutcome,
        filePath,
        sessionKey,
        appendFailureReport,
        emitToUser,
        now,
        logger,
      });
    }
    const prompt = buildRestartContinuationPrompt(checkpoint, auditOutcome);
    const emit = event => {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'tool_call' && !checkpoint.toolActivity) {
        const toolName = typeof event.name === 'string' && event.name.trim()
          ? event.name.trim().slice(0, 160)
          : null;
        checkpoint = {
          ...checkpoint,
          toolActivity: true,
          toolActivityAt: new Date(now()).toISOString(),
          ...(toolName ? { firstToolName: toolName } : {}),
        };
        const updated = updateCheckpoint(filePath, checkpoint.id, {
          toolActivity: true,
          toolActivityAt: checkpoint.toolActivityAt,
          ...(toolName ? { firstToolName: toolName } : {}),
        }, logger);
        if (!updated) {
          throw new Error('restart continuation lost its durable tool-activity guard');
        }
        checkpoint = updated;
      }
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

    const statusOnly = checkpoint.sessionEpoch == null
      || checkpoint.sourceTurnCompleted === true;
    await runTurn({
      userId: checkpoint.userId,
      agentId: safeRuntimeAgentId,
      text: prompt,
      source: 'web',
      turnId: checkpoint.activeTurnId,
      messageId: checkpoint.reportId,
      attemptId: checkpoint.activeTurnId,
      toolPlan: {
        mode: statusOnly ? 'none' : 'auto',
        source: 'restart-continuation',
      },
      onEvent: emit,
      _hiddenUser: true,
      _durableHiddenUser: true,
      _excludeHiddenUserFromModel: true,
      _isBackgroundContinuation: true,
      _readOnlyTurn: statusOnly,
      _silent: false,
      _suppressLearning: true,
      _expectedSessionEpoch: checkpoint.sessionEpoch,
      _expectedResolvedAgentId: checkpoint.agentId,
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

    // A resumed task is allowed to discover that another restart is required.
    // Its tool may replace this running checkpoint only from the exact active
    // user/agent turn. Preserve that child checkpoint and let the next boot
    // continue the same workflow.
    const current = readRestartContinuationCheckpoint({ filePath, logger });
    if (current && current.id !== checkpoint.id) {
      emitToUser(checkpoint.userId, {
        ...terminalEvent,
        type: 'done',
        restart_continuation: true,
        report_id: checkpoint.reportId,
        chained_restart: true,
      });
      return {
        status: 'chained_restart',
        checkpointId: checkpoint.id,
        nextCheckpointId: current.id,
        auditStatus: auditOutcome.status,
      };
    }

    if (!await hasReport(sessionKey, checkpoint.reportId, checkpoint.activeTurnId)) {
      throw new Error('continuation reply did not reach the durable done boundary');
    }
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
        agentId: safeRuntimeAgentId,
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
    const caughtTerminal = /** @type {any} */ (terminal);
    if (caughtTerminal?.code === 'agent_projection_changed') {
      const fallback = resolveAgentId(
        checkpoint.userId,
        null,
        { fallbackUnknown: true },
      );
      const fallbackAgentId = fallback
        ? canonicalAgentId(checkpoint.userId, fallback)
        : checkpoint.agentId;
      const fallbackSessionKey = `${checkpoint.userId}_${fallbackAgentId}`;
      return await persistVisibleFailure({
        checkpoint,
        auditOutcome,
        filePath,
        sessionKey: fallbackSessionKey,
        appendFailureReport,
        emitToUser,
        now,
        logger,
        content: changedAgentProjectionText(),
        status: 'failed_closed_agent_projection_changed',
        failureKind: 'agent_projection_changed',
        agentId: fallbackAgentId,
        expectedSessionEpoch: fallbackAgentId === checkpoint.agentId
          ? checkpoint.sessionEpoch
          : getSessionEpoch(fallbackSessionKey),
      });
    }
    if (caughtTerminal?.code === 'session_cleared'
        || (checkpoint.sessionEpoch
        && getSessionEpoch(sourceSessionKey) !== checkpoint.sessionEpoch)) {
      clearRestartContinuationCheckpoint({
        expectedId: checkpoint.id,
        filePath,
        logger,
      });
      return { status: 'session_cleared', checkpointId: checkpoint.id };
    }
    const current = readRestartContinuationCheckpoint({ filePath, logger });
    if (current && current.id !== checkpoint.id) {
      const chainedTerminal = caughtTerminal?.type === 'error'
        ? caughtTerminal
        : {
          type: 'error',
          agent: safeRuntimeAgentId,
          turn_id: checkpoint.activeTurnId,
          message: 'OE is restarting again to continue this request.',
        };
      emitToUser(checkpoint.userId, {
        ...chainedTerminal,
        restart_continuation: true,
        report_id: checkpoint.reportId,
        chained_restart: true,
      });
      return {
        status: 'chained_restart',
        checkpointId: checkpoint.id,
        nextCheckpointId: current.id,
        auditStatus: auditOutcome?.status ?? 'unavailable',
      };
    }
    const retained = current?.id === checkpoint.id ? current : checkpoint;
    if (retained.toolActivity || checkpoint.toolActivity) {
      try {
        return await persistToolActivityFailure({
          checkpoint: { ...retained, toolActivity: true },
          auditOutcome,
          filePath,
          sessionKey,
          appendFailureReport,
          emitToUser,
          now,
          logger,
        });
      } catch (reportError) {
        const reportMessage = String(reportError?.message || reportError).slice(0, 500);
        updateCheckpoint(filePath, checkpoint.id, {
          state: 'pending',
          lastError: reportMessage,
          lease: undefined,
        }, logger);
        emitToUser(checkpoint.userId, {
          type: 'error',
          agent: safeRuntimeAgentId,
          turn_id: checkpoint.activeTurnId,
          code: 'restart_continuation_persistence_retry',
          retryable: true,
          message: 'The continuation stopped safely, but its failure report could not be saved yet.',
          restart_continuation: true,
          report_id: checkpoint.reportId,
          restart_retry_pending: true,
          failed_closed: true,
        });
        return {
          status: 'retryable_error',
          checkpointId: checkpoint.id,
          error: reportMessage,
          toolActivity: true,
        };
      }
    }
    updateCheckpoint(filePath, checkpoint.id, {
      state: 'pending',
      lastError: message,
      lease: undefined,
    }, logger);
    const terminalEvent = caughtTerminal?.type === 'error'
      ? caughtTerminal
      : {
        type: 'error',
        agent: safeRuntimeAgentId,
        turn_id: checkpoint.activeTurnId,
        code: 'restart_continuation_retry',
        retryable: true,
        message,
      };
    emitToUser(checkpoint.userId, {
      ...terminalEvent,
      type: 'error',
      restart_continuation: true,
      report_id: checkpoint.reportId,
      restart_retry_pending: true,
    });
    try {
      logger.warn('restart-continuation', 'restart continuation retained for recovery', {
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

function recoveryNeedsMonitoring(result) {
  return result?.status === 'retryable_error'
    || result?.status === 'already_running';
}

async function resumeRestartContinuationUntilTerminal(options = {}) {
  let result = await resumeRestartContinuationWithRetry(options);
  if (!recoveryNeedsMonitoring(result)) return result;

  const baseMs = Math.max(
    100,
    Number(options.deferredRetryBaseMs) || DEFAULT_DEFERRED_RETRY_BASE_MS,
  );
  const maxMs = Math.max(
    baseMs,
    Number(options.deferredRetryMaxMs) || DEFAULT_DEFERRED_RETRY_MAX_MS,
  );
  const deferredSleep = typeof options.deferredRetrySleep === 'function'
    ? options.deferredRetrySleep
    : (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxDeferredPasses = Number.isSafeInteger(options.maxDeferredRetryPasses)
    ? Math.max(0, options.maxDeferredRetryPasses)
    : Number.POSITIVE_INFINITY;

  // Model/tool attempts remain bounded by maxTotalResumeAttempts. Monitoring
  // itself stays alive for the process lifetime: after that bound, calls only
  // persist the deterministic failure reply; after tool activity, calls only
  // persist the no-replay reply; and an overlapping process is only polled
  // until its lease clears or its exact process incarnation dies.
  for (let deferred = 0;
    recoveryNeedsMonitoring(result) && deferred < maxDeferredPasses;
    deferred++) {
    const checkpoint = readRestartContinuationCheckpoint({
      filePath: options.filePath ?? RESTART_CONTINUATION_PATH,
      logger: options.logger ?? log,
    });
    if (!checkpoint) return result;
    const delayMs = Math.min(maxMs, baseMs * (2 ** Math.min(deferred, 20)));
    await deferredSleep(delayMs);
    try {
      result = await resumeRestartContinuation(options);
    } catch (error) {
      result = {
        status: 'retryable_error',
        error: String(error?.message || error).slice(0, 500),
      };
    }
  }
  return result;
}

/**
 * Process-wide idempotent boot wrapper. Do not await it from the startup
 * critical path; the audit watchdog may need the HTTP server to become live.
 */
export function resumeRestartContinuationAtBoot(options = {}) {
  if (_bootResumePromise) return _bootResumePromise;
  _bootResumePromise = resumeRestartContinuationUntilTerminal(options).catch(error => {
    try {
      log.warn('restart-continuation', 'boot resumer failed closed', {
        error: String(error?.message || error).slice(0, 500),
      });
    } catch {}
    return { status: 'retryable_error', error: String(error?.message || error) };
  });
  return _bootResumePromise;
}
