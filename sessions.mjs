/**
 * Session persistence for OpenEnsemble.
 * One JSONL file per agent: sessions/{agentId}.jsonl
 * Each line: { role, content, ts }
 *
 * LM Studio stateful response IDs stored alongside:
 * sessions/{agentId}.lms_id  — plain text file, one ID
 */

import fs from 'fs';
import fsp from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  withFileLock,
  getProcessIdentity,
  processIdentityIsProvenDead,
} from './lib/file-lock.mjs';

// Simple per-key lock to serialize session writes
const _sessionLocks = new Map();
function withSessionLock(key, fn) {
  const chain = (_sessionLocks.get(key) ?? Promise.resolve()).then(fn);
  _sessionLocks.set(key, chain.catch(() => {}));
  return chain;
}
import path from 'path';
import { fileURLToPath } from 'url';
// Turn-trace correlation for send-time user-row durability (see
// appendUserTurnPending). turn-trace-context imports only async_hooks +
// crypto, so this adds no import-cycle risk.
import { getTurn } from './lib/turn-trace-context.mjs';

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const USERS_DIR = path.join(BASE_DIR, 'users');
const MAX_HISTORY  = 60; // max messages loaded into context

function safeId(id) {
  // Allow only alphanumeric, underscore, hyphen — prevents path traversal
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Split a scoped agentId (e.g. "user_abc123_agent_def456") into userId + localId. */
function parseAgentId(agentId) {
  const m = agentId.match(/^(user_[a-zA-Z0-9]+)_(.+)$/);
  return m ? { userId: m[1], localId: m[2] } : { userId: null, localId: agentId };
}

function getSessionsDir(agentId) {
  const { userId } = parseAgentId(agentId);
  if (userId) return path.join(USERS_DIR, userId, 'sessions');
  return path.join(BASE_DIR, 'sessions'); // fallback for non-user-scoped IDs
}

function sessionPath(agentId) {
  const { localId } = parseAgentId(agentId);
  const dir = getSessionsDir(agentId);
  return path.join(dir, `${safeId(localId)}.jsonl`);
}

function lmsIdPath(agentId, epoch = null) {
  const { localId } = parseAgentId(agentId);
  const dir = getSessionsDir(agentId);
  const generation = epoch ?? getSessionEpoch(agentId);
  return path.join(dir, `${safeId(localId)}.${safeId(generation)}.lms_id`);
}

function sessionEpochPath(agentId) {
  const { localId } = parseAgentId(agentId);
  return path.join(getSessionsDir(agentId), `${safeId(localId)}.session-epoch`);
}

function sessionFileLockPath(agentId) {
  return `${sessionPath(agentId)}.lock`;
}

/** Current durable clear-generation. Missing means the pre-upgrade generation. */
export function getSessionEpoch(agentId) {
  try {
    const value = fs.readFileSync(sessionEpochPath(agentId), 'utf8').trim();
    return value || 'legacy';
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[sessions] epoch read failed:', e.message);
    return 'legacy';
  }
}

function withSessionWriteLock(agentId, fn) {
  return withSessionLock('session:' + agentId, () =>
    withFileLock(sessionFileLockPath(agentId), fn));
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fsp.open(dir, 'r');
    await fh.sync();
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function atomicRewrite(p, text) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const fh = await fsp.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, p);
    await fsyncDir(path.dirname(p));
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export async function loadSession(agentId, limit = MAX_HISTORY) {
  const p = sessionPath(agentId);
  // Async read — sync readFileSync on every chat dispatch / WS connect /
  // tool-routing decision (8 call sites) was real event-loop pressure
  // under disk contention. ENOENT → empty history; any other failure
  // logs but still degrades to empty rather than throwing.
  // Reads share the writer lock. An epoch-before/after retry still had a final
  // check→return race: a reader could validate the old epoch, get descheduled,
  // then return old rows after Clear completed. Serializing the short file read
  // makes the boundary linearizable across tabs and OE processes.
  const text = await withSessionWriteLock(agentId, async () => {
    try {
      return await fsp.readFile(p, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[sessions] loadSession read failed:', e.message);
      return '';
    }
  });
  const lines = text.trim().split('\n').filter(Boolean);
  const messages = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .map(({ turnOwner: _turnOwner, ...message }) => message);
  // The turn that wrote a send-time pending row (appendUserTurnPending) must
  // never read it back as history: streamChat appends the current user turn
  // to the provider payload itself, so without this filter every normal
  // prompt reached the model twice (and three times on a retry). Scoped to
  // the CURRENT turn id only — out-of-turn readers (UI session fetch, WS
  // reconnect) and later turns still see crashed-turn rows, which is the
  // whole durability point.
  const turnId = getTurn()?.turnId ?? null;
  const visible = turnId ? messages.filter(m => m.pendingTurn !== turnId) : messages;
  return visible.slice(-limit);
}

const PRUNE_THRESHOLD = 500; // prune when file exceeds this many lines
const PRUNE_KEEP      = 200; // keep this many most recent lines after pruning
const _lineCounts     = new Map(); // agentId → estimated line count

function applyTurnMetadata(messages, turn) {
  if (!turn?.turnId) return messages;
  return messages.map((message, index) => ({
    ...message,
    ...(message.turnId ? {} : { turnId: turn.turnId }),
    ...(turn.messageId && !message.messageId ? { messageId: turn.messageId } : {}),
    ...(turn.attemptId && !message.attemptId ? { attemptId: turn.attemptId } : {}),
    ...(index === 0 && message.role === 'user' && !message.pendingTurn && !message.turnStatus
      ? { turnStatus: 'complete' }
      : {}),
  }));
}

const TURN_TERMINAL_ROLE = 'turn_terminal';
const TURN_ARTIFACT_ROLES = new Set([
  'approval_pending', 'approval_resolved', 'attachment_decision',
]);

function rowMatchesTurn(row, turn) {
  if (!row || !turn?.turnId) return false;
  return row.turnId === turn.turnId
    || row.pendingTurn === turn.turnId
    || (turn.attemptId && row.attemptId === turn.attemptId);
}

function terminalReplay(rows, turn) {
  const matching = rows.filter(row => rowMatchesTurn(row, turn));
  const terminal = [...matching].reverse().find(row => row?.role === TURN_TERMINAL_ROLE) ?? null;
  const userMessage = matching.find(row => row?.role === 'user') ?? null;
  const artifacts = matching.filter(row => TURN_ARTIFACT_ROLES.has(row?.role));
  const turnError = [...matching].reverse().find(row => row?.role === 'turn_error') ?? null;
  // Reconstruct the approval UI state immediately BEFORE this turn. Recovery
  // needs this when the destructive action cleared X but the process died
  // before persisting approval_resolved; looking only at this turn's artifacts
  // would see {}→{} and leave X's older card stale forever.
  const approvalBefore = Object.create(null);
  const userIndex = rows.findIndex(row => row === userMessage);
  for (const row of rows.slice(0, userIndex === -1 ? 0 : userIndex)) {
    if (row?.role === 'approval_pending' && row.kind) {
      approvalBefore[row.kind] = {
        phrase: row.phrase, description: row.description,
        expiresAt: row.expiresAt ?? null, opId: row.opId ?? null,
      };
    } else if (row?.role === 'approval_resolved' && row.kind) {
      const prior = approvalBefore[row.kind];
      if (!row.opId || !prior?.opId || prior.opId === row.opId) delete approvalBefore[row.kind];
    }
  }
  return { terminal, userMessage, artifacts, turnError, approvalBefore };
}

export function appendToSession(agentId, ...messages) {
  // Ephemeral agents (spawned per-call by deep_research_parallel etc.) have
  // no persistent session — skip all disk writes for IDs prefixed "ephemeral_".
  if (typeof agentId === 'string' && agentId.startsWith('ephemeral_')) return Promise.resolve();
  // Captured synchronously — the lock's deferred callback must not observe a
  // different turn's ALS store (barge-in replaces the turn under the same key).
  const turn = getTurn();
  const turnMeta = turn ? {
    turnId: turn.turnId ?? null,
    messageId: turn.messageId ?? null,
    attemptId: turn.attemptId ?? null,
    sessionKey: turn.sessionKey ?? null,
    sessionEpoch: turn.sessionEpoch ?? null,
  } : null;
  const durableMessages = applyTurnMetadata(messages, turnMeta);
  return withSessionWriteLock(agentId, async () => {
    const sessDir = getSessionsDir(agentId);
    await fsp.mkdir(sessDir, { recursive: true });
    const p = sessionPath(agentId);
    const currentEpoch = getSessionEpoch(agentId);
    if (turnMeta?.sessionKey === agentId && turnMeta.sessionEpoch && turnMeta.sessionEpoch !== currentEpoch) {
      const err = new Error('Session was cleared while this turn was running');
      err.code = 'SESSION_CLEARED';
      throw err;
    }

    // Completion write for a turn that persisted its user row at send time
    // (appendUserTurnPending): swap the tagged pending row for the final one
    // instead of appending a duplicate. Matching on the pendingTurn tag — not
    // content — keeps interleaved/barged-in turns safe: a turn only ever
    // replaces its OWN row. Falls through to a plain append when no tagged
    // row exists (turns that never wrote one, or one already replaced).
    if (turnMeta?.turnId && durableMessages[0]?.role === 'user' && !durableMessages[0].pendingTurn) {
      if (await replacePendingUserRow(p, agentId, turnMeta.turnId, durableMessages)) return;
      // This turn DID create a pending row, but it vanished without an epoch
      // change only if another completion already consumed it. Never fall
      // through to a duplicate append.
      if (turnMeta.sessionKey === agentId && turnMeta.sessionEpoch) {
        const err = new Error('Pending turn row is no longer current');
        err.code = 'SESSION_CLEARED';
        throw err;
      }
    }

    const lines = durableMessages.map(m => JSON.stringify(m)).join('\n') + '\n';
    // Open → append → fsync → close so lines survive crash / power loss.
    // Plain appendFile leaves bytes in the kernel page cache and the last N
    // messages can disappear silently on reboot.
    const fh = await fsp.open(p, 'a');
    try {
      await fh.appendFile(lines);
      await fh.sync();
    } finally {
      await fh.close();
    }

    // Track line count in memory — only read the file when threshold is exceeded
    const count = (_lineCounts.get(agentId) ?? 0) + durableMessages.length;
    _lineCounts.set(agentId, count);

    if (count > PRUNE_THRESHOLD) {
      try {
        const all = (await fsp.readFile(p, 'utf8')).trim().split('\n').filter(Boolean);
        if (all.length > PRUNE_THRESHOLD) {
          await atomicRewrite(p, all.slice(-PRUNE_KEEP).join('\n') + '\n');
          _lineCounts.set(agentId, PRUNE_KEEP);
        } else {
          _lineCounts.set(agentId, all.length);
        }
      } catch (e) { console.warn('[sessions] Auto-prune failed for', agentId + ':', e.message); }
    }
  });
}

/**
 * Atomically append a report-like row once. Background completions can be
 * retried after a crash and from more than one OE process, so the ordinary
 * load-then-append sequence is not sufficient: both writers could observe the
 * row as absent. The stable reportId is the durable idempotency key.
 *
 * @returns {Promise<'appended'|'existing'>}
 */
export function appendSessionReportOnce(agentId, row) {
  if (!row?.reportId) return Promise.reject(new Error('Session report requires a reportId'));
  if (typeof agentId === 'string' && agentId.startsWith('ephemeral_')) {
    return Promise.reject(new Error('Session report requires a persistent agent'));
  }
  const durable = applyTurnMetadata([row], getTurn())[0];
  return withSessionWriteLock(agentId, async () => {
    const p = sessionPath(agentId);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    let rows = [];
    try {
      rows = (await fsp.readFile(p, 'utf8')).split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (rows.some(existing => existing?.reportId === durable.reportId)) return 'existing';
    const fh = await fsp.open(p, 'a', 0o600);
    try {
      await fh.appendFile(JSON.stringify(durable) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    _lineCounts.set(agentId, (_lineCounts.get(agentId) ?? rows.length) + 1);
    return 'appended';
  });
}

/**
 * Send-time durability: persist the user's message BEFORE the turn runs,
 * tagged with the turn-trace id. appendToSession later REPLACES this row with
 * the final (possibly transformed — attachment notes, financePreprocess) user
 * row on the happy path, so completed turns stay byte-identical on disk. If
 * the turn errors, is stopped, or the process dies first, this row is what
 * keeps the user's message from vanishing along with the missing reply.
 * No-op without a turn store: with no id to correlate, the completion write
 * couldn't dedupe it and every successful turn would show a doubled bubble —
 * so the pathological no-ALS case degrades to today's behavior instead.
 */
export function appendUserTurnPending(agentId, msg) {
  const turn = getTurn();
  const turnId = turn?.turnId ?? null;
  if (!turnId) return Promise.resolve({ inserted: false, duplicate: false });
  return withSessionWriteLock(agentId, async () => {
    const p = sessionPath(agentId);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const epoch = getSessionEpoch(agentId);
    // The dispatcher captures the epoch synchronously before its first await.
    // Never let an older request that was paused across Clear adopt the new
    // generation here and repopulate the transcript after Clear returned.
    const expectedEpoch = turn?.sessionKey === agentId && turn.sessionEpoch
      ? turn.sessionEpoch
      : epoch;
    if (expectedEpoch !== epoch) {
      const err = new Error('Session was cleared before this turn was accepted');
      err.code = 'SESSION_CLEARED';
      throw err;
    }
    if (turn) {
      turn.sessionKey = agentId;
      turn.sessionEpoch = expectedEpoch;
    }

    let existing = [];
    try {
      existing = (await fsp.readFile(p, 'utf8')).split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const prior = existing.filter(row =>
      row?.attemptId === (turn.attemptId ?? turnId)
      || row?.turnId === turnId
      || row?.pendingTurn === turnId);
    if (prior.length) {
      const user = prior.find(row => row.role === 'user');
      const hasAssistant = prior.some(row => row.role === 'assistant');
      const replay = terminalReplay(existing, turn);
      if (replay.terminal) {
        const terminalType = replay.terminal.terminalType === 'done' ? 'complete'
          : (replay.terminal.status === 'stopped' ? 'stopped' : 'failed');
        return {
          inserted: false, duplicate: true, status: terminalType,
          retryable: replay.terminal.retryable === true,
          terminal: replay.terminal,
          artifacts: replay.artifacts,
          approvalBefore: replay.approvalBefore,
          userMessage: replay.userMessage,
          turnError: replay.turnError,
        };
      }
      // A duplicate can arrive before fire-and-forget boot reconciliation. Do
      // the same owner-CAS under this writer lock so we never ACK an orphaned
      // attempt as `active` with no worker left to produce a terminal event.
      if (!hasAssistant && user?.pendingTurn && user.turnOwner
          && processIdentityIsProvenDead(user.turnOwner)) {
        let partial = '';
        let toolEvents = [];
        try {
          const buffer = JSON.parse(await fsp.readFile(streamBufferPath(agentId), 'utf8'));
          if (buffer?.turnId === user.pendingTurn) {
            partial = String(buffer.content || '');
            toolEvents = Array.isArray(buffer.toolEvents) ? buffer.toolEvents : [];
          }
        } catch { /* pre-open crash has no stream marker */ }
        const pendingIdx = existing.indexOf(user);
        markRecoveredPendingFailed(existing, pendingIdx, {
          message: partial
            ? 'Server restarted before the reply completed.'
            : 'Server restarted before the turn could begin.',
          retryable: false,
          partial,
          toolEvents,
          ts: user.ts ?? Date.now(),
        });
        const recoveredUser = existing.find(row => row?.role === 'user' && row.turnId === turnId);
        if (recoveredUser) recoveredUser.turnOwner = getProcessIdentity();
        await atomicRewrite(p, existing.map(row => JSON.stringify(row)).join('\n') + '\n');
        _lineCounts.set(agentId, existing.length);
        const recoveredReplay = terminalReplay(existing, turn);
        return {
          inserted: false, duplicate: true, status: 'finalizing', recoverable: true, recoveryClaimed: true,
          retryable: false,
          terminal: {
            terminalType: 'error', status: 'failed', retryable: false,
            code: 'turn_interrupted',
            message: recoveredReplay.turnError?.error || recoveredReplay.turnError?.content || 'Server restarted before the turn completed.',
          },
          artifacts: recoveredReplay.artifacts,
          approvalBefore: recoveredReplay.approvalBefore,
          userMessage: recoveredReplay.userMessage,
          turnError: recoveredReplay.turnError,
        };
      }
      // New durable turns are not complete merely because their assistant row
      // landed: approval/attachment artifacts and the whole-turn terminal
      // marker are committed by the outer dispatcher afterward. Keep a replay
      // request in `finalizing` until that marker exists. Legacy rows that
      // predate terminalPending retain their historical complete/failed status.
      const isTerminalPending = user?.terminalPending === true
        || user?.turnStatus === 'reply_persisted';
      if (isTerminalPending) {
        let ownerDead = false;
        let ownerKnown = Boolean(user?.turnOwner);
        if (user?.turnOwner) ownerDead = processIdentityIsProvenDead(user.turnOwner);
        if (!ownerKnown) {
          try {
            const buffer = JSON.parse(await fsp.readFile(streamBufferPath(agentId), 'utf8'));
            if (buffer?.turnId === turnId && buffer?.turnOwner) {
              ownerKnown = true;
              ownerDead = processIdentityIsProvenDead(buffer.turnOwner);
            }
          } catch { /* pre-open failures may have no stream marker */ }
        }
        const recoverable = ownerDead || !ownerKnown;
        if (recoverable && user) {
          // Cross-process recovery claim. This mutation occurs inside the same
          // session lock as selection, so exactly one reconnect can own the
          // idempotent artifact finalizer. A second process observes this live
          // owner and waits for the durable terminal instead of racing cards.
          user.turnOwner = getProcessIdentity();
          await atomicRewrite(p, existing.map(row => JSON.stringify(row)).join('\n') + '\n');
        }
        return {
          inserted: false, duplicate: true, status: 'finalizing',
          recoverable,
          ...(recoverable ? { recoveryClaimed: true } : {}),
          retryable: user?.retryable === true,
          terminal: user?.turnStatus === 'reply_persisted'
            ? { terminalType: 'done', status: 'complete' }
            : {
                terminalType: 'error', status: user?.turnStatus || 'failed',
                retryable: user?.retryable === true,
                code: replay.turnError?.code || 'turn_failed',
                message: replay.turnError?.error || replay.turnError?.content || 'The turn failed before completion.',
              },
          artifacts: replay.artifacts,
          approvalBefore: replay.approvalBefore,
          userMessage: replay.userMessage,
          turnError: replay.turnError,
        };
      }
      const status = hasAssistant ? 'complete' : (user?.turnStatus || (user?.pendingTurn ? 'active' : 'failed'));
      return {
        inserted: false, duplicate: true, status,
        retryable: user?.retryable === true,
        artifacts: replay.artifacts,
        approvalBefore: replay.approvalBefore,
        userMessage: replay.userMessage,
        turnError: replay.turnError,
      };
    }

    const entry = applyTurnMetadata([{
      ...msg,
      pendingTurn: turnId,
      turnStatus: 'running',
      sessionEpoch: epoch,
      // Lets a later server distinguish a crashed pre-open turn from a live
      // turn owned by an overlapping OE process. PID alone is insufficient
      // because it can be reused; Linux start ticks identify the incarnation.
      turnOwner: getProcessIdentity(),
    }], turn)[0];
    const retryIdx = turn.messageId
      ? existing.findIndex(row => row?.role === 'user'
          && row.messageId === turn.messageId
          && ['failed', 'stopped'].includes(row.turnStatus))
      : -1;
    if (retryIdx !== -1) {
      existing[retryIdx] = entry;
      const rewritten = existing.filter(row =>
        !(row?.role === 'turn_error' && row.messageId === turn.messageId));
      await atomicRewrite(p, rewritten.map(row => JSON.stringify(row)).join('\n') + '\n');
      _lineCounts.set(agentId, rewritten.length);
      return { inserted: true, duplicate: false, status: 'active', retry: true };
    }
    const fh = await fsp.open(p, 'a', 0o600);
    try {
      await fh.appendFile(JSON.stringify(entry) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    _lineCounts.set(agentId, (_lineCounts.get(agentId) ?? existing.length) + 1);
    return { inserted: true, duplicate: false, status: 'active' };
  });
}

/**
 * Swap the pendingTurn-tagged user row for this turn with the final user row,
 * then append the rest of the completion batch. Whole-file rewrite via
 * tmp + fsync + rename so a crash mid-rewrite can never truncate the session.
 * Runs inside the caller's session lock. Returns false when no tagged row
 * exists so appendToSession falls through to its plain append path.
 */
async function replacePendingUserRow(p, agentId, turnId, messages) {
  let text;
  try { text = await fsp.readFile(p, 'utf8'); } catch { return false; }
  const lines = text.split('\n').filter(Boolean);
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { if (JSON.parse(lines[i])?.pendingTurn === turnId) { idx = i; break; } } catch { /* skip unparsable */ }
  }
  if (idx === -1) return false;
  let pending = null;
  try { pending = JSON.parse(lines[idx]); } catch { /* malformed legacy row */ }
  const finalUser = {
    ...messages[0],
    turnStatus: 'reply_persisted',
    terminalPending: true,
    ...(pending?.turnOwner ? { turnOwner: pending.turnOwner } : {}),
    ...(pending?.sessionEpoch ? { sessionEpoch: pending.sessionEpoch } : {}),
  };
  // Keep every turn contiguous. Appending assistant rows at EOF produced
  // userA,userB,assistantB,assistantA when two pre-open fastpaths completed out
  // of order, corrupting both UI reconstruction and future model history.
  lines.splice(idx, 1, ...[finalUser, ...messages.slice(1)].map(m => JSON.stringify(m)));
  const keep = lines.length > PRUNE_THRESHOLD ? lines.slice(-PRUNE_KEEP) : lines;
  await atomicRewrite(p, keep.join('\n') + '\n');
  _lineCounts.set(agentId, keep.length);
  return true;
}

/** Persist a terminal failure/stopped row before the error reaches clients. */
export function failPendingTurn(agentId, message, { status = 'failed', retryable = true, partial = '' } = {}) {
  const turn = getTurn();
  const turnId = turn?.turnId ?? null;
  if (!turnId) return Promise.resolve(false);
  const expectedEpoch = turn?.sessionKey === agentId ? turn.sessionEpoch : null;
  return withSessionWriteLock(agentId, async () => {
    if (expectedEpoch && getSessionEpoch(agentId) !== expectedEpoch) return false;
    const p = sessionPath(agentId);
    let lines;
    try { lines = (await fsp.readFile(p, 'utf8')).split('\n').filter(Boolean); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    let idx = -1;
    let pending = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]);
        if (row?.pendingTurn === turnId) { idx = i; pending = row; break; }
      } catch { /* ignore malformed legacy line */ }
    }
    if (idx === -1 || !pending) return false;
    const failedUser = {
      ...pending,
      pendingTurn: undefined,
      turnStatus: status,
      terminalPending: true,
      retryable: retryable === true,
      excludeFromModel: true,
    };
    delete failedUser.pendingTurn;
    const errorRow = applyTurnMetadata([{
      role: 'turn_error',
      content: String(message || 'Turn failed'),
      error: String(message || 'Turn failed'),
      status,
      retryable: retryable === true,
      ...(partial ? { assistantPartial: String(partial) } : {}),
      ts: Date.now(),
    }], turn)[0];
    lines.splice(idx, 1, JSON.stringify(failedUser), JSON.stringify(errorRow));
    await atomicRewrite(p, lines.join('\n') + '\n');
    _lineCounts.set(agentId, lines.length);
    return true;
  });
}

/**
 * Whole-turn durability barrier. Called only after the assistant/failure row
 * and every approval/attachment artifact are durable. It atomically clears the
 * transient owner flag, records the final user status, and appends the marker
 * duplicate attempts use for authoritative terminal replay.
 */
export function markTurnTerminal(agentId, terminal = {}) {
  const turn = getTurn();
  if (!turn?.turnId) return Promise.resolve(false);
  const turnMeta = {
    turnId: turn.turnId,
    messageId: turn.messageId ?? null,
    attemptId: turn.attemptId ?? turn.turnId,
  };
  const expectedEpoch = turn?.sessionKey === agentId ? turn.sessionEpoch : null;
  return withSessionWriteLock(agentId, async () => {
    if (expectedEpoch && getSessionEpoch(agentId) !== expectedEpoch) return false;
    const p = sessionPath(agentId);
    let rows;
    try {
      rows = (await fsp.readFile(p, 'utf8')).split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
    const existing = rows.find(row => row?.role === TURN_TERMINAL_ROLE && rowMatchesTurn(row, turnMeta));
    if (existing) {
      try {
        const bufferPath = streamBufferPath(agentId);
        const buffer = JSON.parse(await fsp.readFile(bufferPath, 'utf8'));
        if (!buffer?.turnId || buffer.turnId === turn.turnId) await fsp.rm(bufferPath, { force: true });
      } catch { /* already clear */ }
      return existing;
    }
    const userIdx = rows.findIndex(row => row?.role === 'user' && rowMatchesTurn(row, turnMeta));
    if (userIdx === -1) return false;

    const terminalType = terminal?.type === 'done' ? 'done'
      : (terminal?.type === 'stopped' ? 'stopped' : 'error');
    const status = terminalType === 'done' ? 'complete'
      : (terminalType === 'stopped' ? 'stopped' : 'failed');
    const user = { ...rows[userIdx], turnStatus: status };
    delete user.pendingTurn;
    delete user.turnOwner;
    delete user.terminalPending;
    rows[userIdx] = user;
    if (terminalType !== 'done' && !rows.some(row =>
      row?.role === 'turn_error' && rowMatchesTurn(row, turnMeta))) {
      const message = String(terminal?.message
        || (terminalType === 'stopped' ? 'Stopped by user.' : 'The turn failed before completion.'));
      rows.push({
        role: 'turn_error', content: message, error: message,
        status, retryable: terminal?.retryable === true,
        ...(terminal?.code ? { code: String(terminal.code) } : {}),
        ts: Date.now(),
        ...turnMeta,
      });
    }
    const marker = {
      role: TURN_TERMINAL_ROLE,
      terminalType,
      status,
      retryable: terminal?.retryable === true,
      ...(terminal?.code ? { code: String(terminal.code) } : {}),
      ...(terminal?.message ? { message: String(terminal.message) } : {}),
      ts: Date.now(), hidden: true, excludeFromModel: true,
      ...turnMeta,
    };
    rows.push(marker);
    await atomicRewrite(p, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    try {
      const bufferPath = streamBufferPath(agentId);
      const buffer = JSON.parse(await fsp.readFile(bufferPath, 'utf8'));
      if (!buffer?.turnId || buffer.turnId === turn.turnId) {
        await fsp.rm(bufferPath, { force: true });
        await fsyncDir(path.dirname(p));
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') console.warn('[sessions] terminal buffer cleanup failed:', e.message);
    }
    _lineCounts.set(agentId, rows.length);
    return marker;
  });
}

/**
 * Idempotently append one whole-turn artifact. Concurrent reconnect recovery
 * may run in two OE processes; both must converge on the same persisted card
 * (including its decisionId) rather than append conflicting duplicates.
 */
export function appendTurnArtifactOnce(agentId, artifact) {
  const turn = getTurn();
  if (!turn?.turnId) return Promise.reject(new Error('Turn artifact requires a turn id'));
  const expectedEpoch = turn?.sessionKey === agentId ? turn.sessionEpoch : null;
  const durable = applyTurnMetadata([artifact], turn)[0];
  return withSessionWriteLock(agentId, async () => {
    if (expectedEpoch && getSessionEpoch(agentId) !== expectedEpoch) {
      const err = new Error('Session was cleared while finalizing artifacts');
      err.code = 'SESSION_CLEARED';
      throw err;
    }
    const p = sessionPath(agentId);
    let rows = [];
    try {
      rows = (await fsp.readFile(p, 'utf8')).split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const existing = rows.find(row => {
      if (row?.role !== durable.role || !rowMatchesTurn(row, turn)) return false;
      if (durable.role === 'attachment_decision') return row.file_id === durable.file_id;
      if (durable.role === 'approval_pending' || durable.role === 'approval_resolved') {
        return row.kind === durable.kind && (durable.opId ? row.opId === durable.opId : !row.opId);
      }
      return false;
    });
    if (existing) return { inserted: false, row: existing };
    const fh = await fsp.open(p, 'a', 0o600);
    try {
      await fh.appendFile(JSON.stringify(durable) + '\n');
      await fh.sync();
    } finally { await fh.close(); }
    _lineCounts.set(agentId, (_lineCounts.get(agentId) ?? rows.length) + 1);
    return { inserted: true, row: durable };
  });
}

/**
 * Atomically validate and resolve one persisted attachment decision. The
 * optional side effect (discard) runs while the cross-process session lock is
 * held, so two stale tabs cannot record conflicting Keep/Discard outcomes.
 */
export function resolveAttachmentDecision(agentId, { decisionId, fileId, decision }, action = async () => {}) {
  return withSessionWriteLock(agentId, async () => {
    const p = sessionPath(agentId);
    let rows;
    try {
      rows = (await fsp.readFile(p, 'utf8')).split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      if (e.code === 'ENOENT') return { status: 'missing' };
      throw e;
    }
    const prompt = [...rows].reverse().find(row =>
      row?.role === 'attachment_decision' && row.decisionId === decisionId);
    if (!prompt || prompt.file_id !== fileId) return { status: 'missing' };
    const prior = [...rows].reverse().find(row =>
      row?.role === 'attachment_decision_outcome' && row.decisionId === decisionId);
    if (prior) return {
      status: prior.decision === decision ? 'already_resolved' : 'conflict',
      decision: prior.decision,
      ts: prior.ts,
    };

    await action();
    const entry = {
      role: 'attachment_decision_outcome', decisionId, decision, ts: Date.now(),
      file_id: fileId,
    };
    const fh = await fsp.open(p, 'a', 0o600);
    try {
      await fh.appendFile(JSON.stringify(entry) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    _lineCounts.set(agentId, (_lineCounts.get(agentId) ?? rows.length) + 1);
    return { status: 'resolved', decision, ts: entry.ts };
  });
}

export function clearSession(agentId) {
  return withSessionWriteLock(agentId, async () => {
    const p = sessionPath(agentId);
    const nextEpoch = `se_${randomUUID().slice(0, 12)}`;
    // Empty first, then publish the new epoch, under one cross-process lock.
    // loadSession is intentionally lock-free; publishing the epoch first left
    // a window where it could observe new epoch + old transcript and return
    // history the user had just cleared. Writers wait on this same lock and
    // validate their captured epoch only after release, so ordering the two
    // rewrites this way still rejects every late old-generation write.
    await atomicRewrite(p, '');
    await atomicRewrite(sessionEpochPath(agentId), nextEpoch + '\n');
    const staleSidecars = [streamBufferPath(agentId)];
    try {
      const { localId } = parseAgentId(agentId);
      const base = safeId(localId);
      for (const name of await fsp.readdir(getSessionsDir(agentId))) {
        if (name === `${base}.lms_id` || (name.startsWith(`${base}.`) && name.endsWith('.lms_id'))) {
          staleSidecars.push(path.join(getSessionsDir(agentId), name));
        }
      }
    } catch { /* empty session dir */ }
    await Promise.all(staleSidecars.map(sidecar => fsp.rm(sidecar, { force: true })));
    await fsyncDir(path.dirname(p));
    _lineCounts.delete(agentId);
    for (const key of _lastFlush.keys()) if (key.startsWith(`${agentId}:`)) _lastFlush.delete(key);
    return nextEpoch;
  });
}

// Full delete (used when the agent is being permanently removed, not just
// when the user clears its context). Removes the session JSONL, the
// .streaming buffer, the LM Studio response-id file, and evicts every
// in-memory tracking entry so nothing leaks across agent IDs over time.
export async function deleteSession(agentId) {
  const paths = [sessionPath(agentId), streamBufferPath(agentId), lmsIdPath(agentId), sessionEpochPath(agentId)];
  try {
    const { localId } = parseAgentId(agentId);
    const prefix = `${safeId(localId)}.`;
    for (const name of await fsp.readdir(getSessionsDir(agentId))) {
      if ((name === `${safeId(localId)}.lms_id`) || (name.startsWith(prefix) && name.endsWith('.lms_id'))) {
        paths.push(path.join(getSessionsDir(agentId), name));
      }
    }
  } catch { /* directory may not exist */ }
  await Promise.all(paths.map(p => fsp.rm(p, { force: true }).catch(() => {})));
  _lineCounts.delete(agentId);
  for (const key of _lastFlush.keys()) if (key.startsWith(`${agentId}:`)) _lastFlush.delete(key);
}

// ── LM Studio stateful response ID ───────────────────────────────────────────

export function getLmsResponseId(agentId) {
  const p = lmsIdPath(agentId);
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
    // One-time compatibility read for sessions that predate epochs.
    if (getSessionEpoch(agentId) === 'legacy') {
      const { localId } = parseAgentId(agentId);
      const legacy = path.join(getSessionsDir(agentId), `${safeId(localId)}.lms_id`);
      if (fs.existsSync(legacy)) return fs.readFileSync(legacy, 'utf8').trim();
    }
    return null;
  } catch (e) { console.warn('[sessions] Failed to read LMS response ID:', e.message); return null; }
}

export function setLmsResponseId(agentId, responseId) {
  const turn = getTurn();
  const epoch = turn?.sessionKey === agentId && turn.sessionEpoch
    ? turn.sessionEpoch
    : getSessionEpoch(agentId);
  try {
    fs.mkdirSync(getSessionsDir(agentId), { recursive: true });
    fs.writeFileSync(lmsIdPath(agentId, epoch), responseId);
  } catch (e) { console.warn('[sessions] Failed to write LMS response ID:', e.message); }
}

// ── Stream buffer (partial response persistence) ─────────────────────────────
// Periodically writes in-progress assistant content to a .streaming file so
// partial responses survive tab closes and server crashes.

const _lastFlush = new Map(); // agentId → timestamp of last write
const FLUSH_INTERVAL = 2000;  // min ms between disk writes per agent

function streamBufferPath(agentId) {
  const { localId } = parseAgentId(agentId);
  const dir = getSessionsDir(agentId);
  return path.join(dir, `${safeId(localId)}.streaming`);
}

export function writeStreamBuffer(agentId, contentOrState) {
  if (typeof agentId === 'string' && agentId.startsWith('ephemeral_')) return;
  const turn = getTurn();
  const expectedEpoch = turn?.sessionKey === agentId
    ? turn.sessionEpoch
    : getSessionEpoch(agentId);
  const state = contentOrState && typeof contentOrState === 'object'
    ? { ...contentOrState }
    : { content: String(contentOrState ?? '') };
  const now = Date.now();
  const flushKey = `${agentId}:${expectedEpoch || 'legacy'}:${state.turnId || turn?.turnId || ''}`;
  const last = _lastFlush.get(flushKey) ?? 0;
  const initialMarker = !state.content && !state.seq && !(state.toolEvents?.length);
  if (!initialMarker && now - last < FLUSH_INTERVAL) return;
  if (!initialMarker) _lastFlush.set(flushKey, now);
  const p = streamBufferPath(agentId);
  // Fire-and-forget: the FLUSH_INTERVAL throttle is the only bound. Sync
  // writeFileSync here blocked the Node event loop on every flush — same
  // disk-pressure trap that bit the logger. Use fsp + .catch() so the
  // caller never awaits and the disk write stays out of the hot path.
  withSessionWriteLock(agentId, async () => {
    if (expectedEpoch && getSessionEpoch(agentId) !== expectedEpoch) return;
    await atomicRewrite(p, JSON.stringify({
      ...state,
      content: String(state.content ?? ''),
      ts: now,
      turnId: state.turnId ?? turn?.turnId ?? null,
      messageId: state.messageId ?? turn?.messageId ?? null,
      attemptId: state.attemptId ?? turn?.attemptId ?? null,
      sessionEpoch: expectedEpoch ?? getSessionEpoch(agentId),
      turnOwner: state.turnOwner ?? getProcessIdentity(),
    }));
  })
    .catch(e => console.warn('[sessions] Failed to write stream buffer:', e.message));
}

export function clearStreamBuffer(agentId) {
  const turn = getTurn();
  const ownTurnId = turn?.turnId ?? null;
  for (const key of _lastFlush.keys()) {
    if (key.startsWith(`${agentId}:`)) _lastFlush.delete(key);
  }
  const p = streamBufferPath(agentId);
  withSessionWriteLock(agentId, async () => {
    if (ownTurnId) {
      try {
        const existing = JSON.parse(await fsp.readFile(p, 'utf8'));
        if (existing?.turnId && existing.turnId !== ownTurnId) return;
      } catch (e) {
        if (e.code === 'ENOENT') return;
      }
    }
    await fsp.rm(p, { force: true });
    await fsyncDir(path.dirname(p));
  }).catch(() => {});
}

export function getStreamBuffer(agentId) {
  const p = streamBufferPath(agentId);
  try {
    if (!fs.existsSync(p)) return null;
    const value = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (value?.sessionEpoch && value.sessionEpoch !== getSessionEpoch(agentId)) return null;
    // Process identity is recovery metadata, not part of the browser protocol.
    const { turnOwner: _turnOwner, ...publicValue } = value;
    return publicValue;
  } catch { return null; }
}

/**
 * Recover any leftover .streaming files from a previous server crash.
 * Async and fire-and-forget from module load — the walk used to run
 * synchronously at import (readdir × every user × every session file),
 * stalling boot on large installs. Deferral is safe because only buffers
 * whose mtime predates THIS process's start are touched: a .streaming file
 * created by a live turn after boot is active, not stale, and unlinking it
 * would corrupt an in-flight stream's crash net.
 */
const _bootTs = Date.now();

function markRecoveredPendingFailed(rows, pendingIdx, {
  message,
  status = 'interrupted',
  retryable = false,
  partial = '',
  toolEvents = [],
  ts = Date.now(),
} = {}) {
  const pending = rows[pendingIdx];
  const failedUser = {
    ...pending,
    turnStatus: 'failed',
    terminalPending: true,
    retryable: retryable === true,
    excludeFromModel: true,
  };
  delete failedUser.pendingTurn;
  const errorRow = {
    role: 'turn_error',
    content: message || 'Server restarted before the reply completed.',
    error: message || 'Server restarted before the reply completed.',
    status,
    retryable: retryable === true,
    ...(partial ? { assistantPartial: partial } : {}),
    ts,
    ...(pending.turnId ? { turnId: pending.turnId } : {}),
    ...(pending.messageId ? { messageId: pending.messageId } : {}),
    ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
    ...(Array.isArray(toolEvents) && toolEvents.length ? { toolEvents } : {}),
  };
  rows.splice(pendingIdx, 1, failedUser, errorRow);
}

/**
 * Reconcile a send-time row whose owner died before it could create a stream
 * buffer. Ownerless legacy rows fail closed: with an overlapping old OE binary
 * there is no reliable way to distinguish a live turn from crash residue.
 */
async function reconcileDeadPreOpenTurns(scopedAgentId) {
  await withSessionWriteLock(scopedAgentId, async () => {
    const p = sessionPath(scopedAgentId);
    let rows;
    try {
      rows = (await fsp.readFile(p, 'utf8')).split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }

    let bufferedTurnId = null;
    try {
      const buffer = JSON.parse(await fsp.readFile(streamBufferPath(scopedAgentId), 'utf8'));
      bufferedTurnId = buffer?.turnId ?? null;
    } catch { /* no readable buffer */ }

    let changed = false;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row?.role !== 'user' || !row.pendingTurn || !row.turnOwner) continue;
      if (!processIdentityIsProvenDead(row.turnOwner)) continue;
      // A dead-owner buffer carries partial/tool state and is recovered by the
      // richer path below. If that path failed, preserve it for the next boot.
      if (bufferedTurnId && bufferedTurnId === row.pendingTurn) continue;
      markRecoveredPendingFailed(rows, i, {
        message: 'Server restarted before the turn could begin.',
        retryable: false,
        ts: row.ts ?? Date.now(),
      });
      changed = true;
    }
    if (changed) {
      await atomicRewrite(p, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      _lineCounts.set(scopedAgentId, rows.length);
    }
  });
}

export async function cleanStaleStreamBuffers({ onlyAgentId = null } = {}) {
  const fsp = fs.promises;
  try {
    if (!fs.existsSync(USERS_DIR)) return;
    for (const userDir of await fsp.readdir(USERS_DIR)) {
      const sessDir = path.join(USERS_DIR, userDir, 'sessions');
      let files;
      try { files = await fsp.readdir(sessDir); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.streaming')) continue;
        const bufPath = path.join(sessDir, file);
        try {
          const st = await fsp.stat(bufPath).catch(() => null);
          if (!st || st.mtimeMs >= _bootTs) continue; // active (post-boot) buffer
          const localAgentId = file.slice(0, -'.streaming'.length);
          const scopedAgentId = `${userDir}_${localAgentId}`;
          if (onlyAgentId && scopedAgentId !== onlyAgentId) continue;
          await withSessionWriteLock(scopedAgentId, async () => {
            // Recheck under the writer lock: a post-boot turn may have replaced
            // this path while cleanup was walking the directory.
            const lockedStat = await fsp.stat(bufPath).catch(() => null);
            if (!lockedStat || lockedStat.mtimeMs >= _bootTs) return;
            const buf = JSON.parse(await fsp.readFile(bufPath, 'utf8'));
            // mtime predating this boot does NOT prove staleness when another
            // OE process is still serving. Recover only after proving the exact
            // writer incarnation dead. Ownerless pre-upgrade buffers are left
            // alone rather than risking corruption of a live old process.
            if (!buf?.turnOwner || !processIdentityIsProvenDead(buf.turnOwner)) return;
            if (buf?.sessionEpoch && buf.sessionEpoch !== getSessionEpoch(scopedAgentId)) {
              await fsp.unlink(bufPath);
              return;
            }
            if (buf?.turnId || buf?.content) {
              const jsonlFile = path.join(sessDir, file.replace('.streaming', '.jsonl'));
              let rows = [];
              try {
                rows = (await fsp.readFile(jsonlFile, 'utf8')).trim().split('\n').filter(Boolean)
                  .map(line => { try { return JSON.parse(line); } catch { return null; } })
                  .filter(Boolean);
              } catch (e) { if (e.code !== 'ENOENT') throw e; }
              const bufferContent = String(buf.content || '').trim();
              // New buffers have a turn id: it is the sole durable identity.
              // Content-prefix fallback is legacy-only and requires both sides
              // nonempty; `someText.startsWith('')` previously made every empty
              // initial marker look completed whenever history had an assistant.
              const alreadyPersisted = buf.turnId
                ? rows.some(row => row?.role === 'assistant' && row.turnId === buf.turnId)
                : Boolean(bufferContent && [...rows].reverse().find(row => {
                    if (row?.role !== 'assistant') return false;
                    const assistantContent = String(row.content || '').trim();
                    return assistantContent && (
                      assistantContent.startsWith(bufferContent)
                      || bufferContent.startsWith(assistantContent));
                  }));
              const terminalPersisted = buf.turnId
                ? rows.some(row => row?.role === TURN_TERMINAL_ROLE && row.turnId === buf.turnId)
                : false;
              let needsArtifactFinalizer = false;
              if (!alreadyPersisted) {
                const pendingIdx = buf.turnId
                  ? rows.findIndex(row => row?.role === 'user' && row.pendingTurn === buf.turnId)
                  : -1;
                if (pendingIdx !== -1) {
                  markRecoveredPendingFailed(rows, pendingIdx, {
                    message: 'Server restarted before the reply completed.',
                    retryable: false, // tools may have run before crash
                    partial: String(buf.content || ''),
                    ts: buf.ts,
                    toolEvents: buf.toolEvents,
                  });
                  await atomicRewrite(jsonlFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
                  needsArtifactFinalizer = true;
                } else if (bufferContent) {
                  const fh = await fsp.open(jsonlFile, 'a', 0o600);
                  try {
                    await fh.appendFile(JSON.stringify({
                      role: 'assistant', content: buf.content, ts: buf.ts, partial: true,
                      ...(buf.turnId ? { turnId: buf.turnId } : {}),
                      ...(buf.messageId ? { messageId: buf.messageId } : {}),
                      ...(buf.attemptId ? { attemptId: buf.attemptId } : {}),
                      ...(Array.isArray(buf.toolEvents) && buf.toolEvents.length ? { toolEvents: buf.toolEvents } : {}),
                    }) + '\n');
                    await fh.sync();
                  } finally { await fh.close(); }
                }
              } else if (!terminalPersisted && buf.turnId) {
                // Reply bytes are durable, but approval/attachment artifacts and
                // the whole-turn marker may not be. Keep the dead-owner buffer
                // as recovery proof; a same-attempt reconnect will run only the
                // idempotent finalizer and then remove it through finalizeTurn.
                needsArtifactFinalizer = rows.some(row => row?.role === 'user'
                  && row.turnId === buf.turnId
                  && (row.terminalPending === true || row.turnStatus === 'reply_persisted'));
              }
              if (needsArtifactFinalizer) return;
            }
            await fsp.unlink(bufPath);
            await fsyncDir(sessDir);
          });
        } catch (e) {
          console.warn('[sessions] Failed to recover stream buffer', file, e.message);
          // Never unlink outside the session lock. The failure may be lock
          // contention with a live overlapping process or a transient read;
          // preserving the buffer makes recovery retryable on the next boot.
        }
      }

      // A crash can land after the durable user row but before openTurn writes
      // its initial `.streaming` marker. Reconcile those owner-proven-dead rows
      // after buffer recovery so richer partial/tool state wins when present.
      let sessionFiles = [];
      try { sessionFiles = await fsp.readdir(sessDir); } catch { /* gone */ }
      for (const file of sessionFiles) {
        if (!file.endsWith('.jsonl')) continue;
        const localAgentId = file.slice(0, -'.jsonl'.length);
        const scopedAgentId = `${userDir}_${localAgentId}`;
        if (onlyAgentId && scopedAgentId !== onlyAgentId) continue;
        try {
          await reconcileDeadPreOpenTurns(scopedAgentId);
        } catch (e) {
          console.warn('[sessions] Failed to reconcile pending turn', file, e.message);
        }
      }
    }
  } catch (e) {
    console.warn('[sessions] Stream buffer cleanup failed:', e.message);
  }
}

// Run cleanup on module load (recovers from server crashes). Fire-and-forget:
// the mtime gate above makes it safe to run concurrently with new turns.
cleanStaleStreamBuffers().catch(e => console.warn('[sessions] Stream buffer cleanup failed:', e.message));

// ── Cross-agent context ─────────────────────────────────────────────────────
// async because it just forwards to loadSession, which is async since
// 4a0d21e.
export async function loadCrossAgentContext(userId, targetAgentId, limit = 3) {
  return loadSession(`${userId}_${targetAgentId}`, limit);
}
