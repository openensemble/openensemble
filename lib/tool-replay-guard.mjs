// @ts-check
/**
 * Per-foreground-turn protection against a repeated exact tool call. Provider
 * adapters all converge on executeToolStreaming(), so one reservation here
 * covers sequential and concurrent repeats across providers.
 *
 * Ledgers are explicitly enabled by the interactive dispatcher and live in a
 * WeakMap keyed by the non-enumerable turn object. Arguments/results therefore
 * never enter trace logs and are collected with the turn.
 */
import { getTurn } from './turn-trace-context.mjs';

/** @type {WeakMap<object, {entries: Map<string, any>, mutationEpochByAgent: Map<string, number>, replayDetected: boolean}>} */
const foregroundLedgers = new WeakMap();

function canonicalValue(value, seen = new WeakSet()) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value);
  if (kind === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  if (kind === 'bigint') return JSON.stringify(`${value}n`);
  if (kind === 'undefined') return '"[undefined]"';
  if (kind !== 'object') return JSON.stringify(String(value));
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map(item => canonicalValue(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalValue(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return serialized;
}

export function enableForegroundToolReplayGuard(turn = getTurn()) {
  if (!turn || typeof turn !== 'object') return false;
  if (!foregroundLedgers.has(turn)) {
    foregroundLedgers.set(turn, {
      entries: new Map(),
      mutationEpochByAgent: new Map(),
      replayDetected: false,
    });
  }
  return true;
}

/**
 * The first exact call owns execution. An identical in-flight call always
 * waits. Read-like completed calls are reused throughout the same state epoch;
 * a newly admitted mutating call advances that epoch so a later read can
 * deliberately re-check changed state. Particularly replay-sensitive tools
 * can opt into full-turn retention because replaying a send/toggle/write is
 * unsafe even after another mutation.
 */
export function reserveForegroundToolCall({
  userId,
  agentId,
  skillId,
  name,
  args,
  advanceEpoch = false,
  retainCompleted = false,
  retainFailure = false,
}) {
  const turn = getTurn();
  const ledger = turn && foregroundLedgers.get(turn);
  if (!ledger || typeof name !== 'string' || !name) return null;

  const agentKey = `${String(userId || '')}:${String(agentId || '')}`;
  const key = [
    agentKey,
    String(skillId || ''),
    name,
    canonicalValue(args),
  ].join('\u001f');
  const existing = ledger.entries.get(key);
  const mutationEpoch = ledger.mutationEpochByAgent.get(agentKey) ?? 0;

  if (existing && (
    existing.state === 'running'
    || existing.mutationEpoch === mutationEpoch
    || existing.retainCompleted === true
  )) {
    ledger.replayDetected = true;
    return { owner: false, wait: existing.promise };
  }

  const entryMutationEpoch = advanceEpoch
    ? mutationEpoch + 1
    : mutationEpoch;
  if (advanceEpoch) {
    // Advance only for a newly admitted side-effecting call. Replayed
    // mutations return above and therefore cannot invalidate reads repeatedly.
    ledger.mutationEpochByAgent.set(agentKey, entryMutationEpoch);
  }
  let resolveOutcome;
  const entry = {
    state: 'running',
    retainCompleted,
    mutationEpoch: entryMutationEpoch,
    promise: new Promise(resolve => { resolveOutcome = resolve; }),
  };
  ledger.entries.set(key, entry);

  return {
    owner: true,
    complete(outcome) {
      if (entry.state !== 'running') return false;
      const normalized = {
        text: String(outcome?.text ?? ''),
        isError: outcome?.isError === true,
        status: ['success', 'accepted', 'failure', 'uncertain'].includes(outcome?.status)
          ? outcome.status
          : (outcome?.isError === true ? 'failure' : 'success'),
      };
      entry.state = normalized.status;
      resolveOutcome(normalized);

      // Read-like retryable failures may run again on the next provider
      // round. Existing concurrent waiters already hold entry.promise and
      // receive this same outcome before the microtask removes the cache.
      if (normalized.status === 'failure' && !retainFailure) {
        queueMicrotask(() => {
          if (ledger.entries.get(key) === entry) ledger.entries.delete(key);
        });
      }
      return true;
    },
  };
}

/**
 * Consume the trusted control signal used by provider loop guards. The signal
 * lives only in the server-owned turn ledger, so arbitrary tool/web text
 * cannot forge a completion-only provider round.
 */
export function consumeForegroundToolReplaySignal() {
  const turn = getTurn();
  const ledger = turn && foregroundLedgers.get(turn);
  if (!ledger?.replayDetected) return false;
  ledger.replayDetected = false;
  return true;
}
