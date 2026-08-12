// @ts-check
/**
 * One durable row per voice turn: wake -> STT -> dispatch -> TTS -> outcome.
 *
 * Why this exists. Every stage of a voice turn already logs *something* to
 * app.log, but each line stands alone: 'wake fired' here, 'stt stream complete'
 * there, a warn from the dispatch path somewhere else, and nothing at all when
 * a turn simply stops progressing. That makes the questions users actually ask
 * — "why did it cut me off", "why did it not answer", "is it getting worse" —
 * unanswerable, because you cannot count what was never recorded as a unit.
 *
 * The verify gate (oe-verify-gate/metrics/events.jsonl) already proved the
 * shape: one row per event with the verdict and the reasons attached. Wake
 * problems were diagnosable in minutes because of it. This is the same idea
 * applied to the rest of the turn.
 *
 * The important property is that a turn ALWAYS produces a row. A turn that is
 * abandoned mid-flight — the device drops, the dispatch never returns, the
 * socket dies — is swept by TTL and written with outcome 'abandoned'. Silent
 * disappearance is the failure mode most worth measuring, so it must not itself
 * be silent.
 */
import path from 'path';
import { BASE_DIR } from './paths.mjs';
import { appendJsonlRow, readJsonlRows } from './jsonl-journal.mjs';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// A turn that has produced no update for this long is presumed dead. Longer
// than the device's own 90 s THINKING watchdog so a slow-but-alive dispatch is
// never mislabelled abandoned; the device gives up before we do.
const TURN_TTL_MS = 120 * 1000;
// Hard cap on live turns. A leak here would be unbounded memory in a
// long-running server, so the oldest is force-closed rather than trusted.
const MAX_LIVE_TURNS = 64;

/** @type {Map<string, any>} */
const _live = new Map();

function journalPath() {
  return path.join(BASE_DIR, 'logs', 'voice-turns.jsonl');
}

function writeRow(row) {
  return appendJsonlRow(journalPath(), row, RETENTION_MS);
}

/** Force-close anything past its TTL, and cap total live turns. */
function sweep() {
  const now = Date.now();
  for (const [id, rec] of _live) {
    if (now - rec._touchedAt > TURN_TTL_MS) {
      _live.delete(id);
      void writeRow(finalize(rec, 'abandoned', { failStage: rec._stage }));
    }
  }
  while (_live.size > MAX_LIVE_TURNS) {
    const [id, rec] = _live.entries().next().value;
    _live.delete(id);
    void writeRow(finalize(rec, 'evicted', { failStage: rec._stage }));
  }
}

function finalize(rec, outcome, extra = {}) {
  const endedAt = Date.now();
  const { _touchedAt, _stage, startedAt, ...fields } = rec;
  return {
    ts: endedAt,
    iso: new Date(endedAt).toISOString(),
    ...fields,
    ...extra,
    outcome,
    totalMs: startedAt ? endedAt - startedAt : null,
  };
}

/**
 * Open a turn record. Safe to call twice for the same id (the later call is
 * ignored) so a retry path cannot clobber accumulated stage data.
 */
export function beginTurn(turn) {
  if (!turn?.id) return;
  sweep();
  if (_live.has(turn.id)) return;
  _live.set(turn.id, {
    _touchedAt: Date.now(),
    _stage: 'wake',
    turnId: turn.id,
    deviceId: turn.deviceId ?? null,
    authUserId: turn.authUserId ?? null,
    effectiveUserId: turn.effectiveUserId ?? null,
    agentId: turn.agentId ?? null,
    wakeSlot: turn.wakeSlot ?? null,
    startedAt: turn.startedAt ?? Date.now(),
  });
}

/**
 * Merge stage data into a live turn. `stage` labels where the turn had got to,
 * so an abandoned turn still reports the point it died at.
 */
export function noteTurn(turnId, fields = {}, stage = null) {
  if (!turnId) return;
  const rec = _live.get(turnId);
  if (!rec) return;
  Object.assign(rec, fields);
  rec._touchedAt = Date.now();
  if (stage) rec._stage = stage;
}

/** Close a turn and write its row. Unknown ids are ignored, not thrown. */
export function endTurn(turnId, outcome, fields = {}) {
  if (!turnId) return;
  const rec = _live.get(turnId);
  if (!rec) return;
  _live.delete(turnId);
  Object.assign(rec, fields);
  void writeRow(finalize(rec, outcome));
}

/** Test seam — drop live state without emitting rows. */
export function _resetTurnJournalForTest() {
  _live.clear();
}

/** Read rows back, newest last. Used by diagnostics surfaces. */
export function loadVoiceTurns({ limit = 200 } = {}) {
  return readJsonlRows(journalPath(), { limit });
}
