// @ts-check
/**
 * Server-owned completion contract for a detached singleton workflow.
 *
 * Admission decides which routed tools are required. A detached worker is not
 * allowed to replace that decision with model prose such as "finished"; its
 * normalized tool-event ledger must prove that every required step completed.
 * This module is deliberately pure: it never executes, retries, or rolls back
 * a tool, and it contains no user- or skill-specific capability names.
 */

import { looksLikeToolError, looksLikeToolRefusal } from './tool-error.mjs';

const VERSION = 1;
const EXACTLY_ONCE_RE = /\b(?:exactly|only)\s+once\b|\bonce\s+and\s+only\s+once\b|\bno\s+more\s+than\s+once\b/i;
const DEFERRED_RESULT_RE = /\b(?:is\s+)?(?:still\s+)?running\s+in\s+(?:the\s+)?background\b/i;
const SUCCESS_STATUS = 'done';
const PENDING_STATUSES = new Set(['backgrounded', 'deferred', 'pending']);
const RUNNING_STATUSES = new Set(['queued', 'running', 'streaming']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function frozenArray(values) {
  return Object.freeze([...values]);
}

function contractError(message) {
  return new TypeError(`Invalid compound workflow decision: ${message}`);
}

/**
 * Convert one successful admission decision into the small, immutable contract
 * that follows the worker. The contract contains metadata only; model-supplied
 * arguments must never be accepted as a substitute for this object.
 *
 * Delivery steps are causal barriers: every earlier routed step must have
 * returned before the delivery call starts. Earlier producer/read steps remain
 * free to run in parallel.
 *
 * @param {object} decision
 * @returns {Readonly<{version: number, source: string, steps: readonly object[]}>}
 */
export function buildCompoundWorkflowContract(decision) {
  if (!decision || typeof decision !== 'object') throw contractError('decision is required');
  const matchedSteps = Array.isArray(decision.matchedSteps) ? decision.matchedSteps : [];
  if (matchedSteps.length < 2) throw contractError('at least two matched steps are required');
  if (Array.isArray(decision.clauses) && decision.clauses.length !== matchedSteps.length) {
    throw contractError('every instruction clause must have a routed step');
  }

  const steps = matchedSteps.map((matched, index) => {
    const toolName = nonEmptyString(matched?.toolName);
    if (!toolName) throw contractError(`step ${index + 1} has no tool name`);
    const capability = nonEmptyString(matched?.capability) || `runtime:${toolName}`;
    const clause = nonEmptyString(matched?.clause) || '';
    const delivery = matched?.traits?.delivery === true;
    const sideEffecting = matched?.traits?.sideEffecting === true || delivery;
    const explicitDependencies = Array.isArray(matched?.dependsOn)
      ? matched.dependsOn
      : null;
    const dependsOn = explicitDependencies == null
      ? (delivery ? Array.from({ length: index }, (_, dependency) => dependency) : [])
      : [...new Set(explicitDependencies.map(Number))].sort((a, b) => a - b);
    if (dependsOn.some(dependency => !Number.isSafeInteger(dependency)
      || dependency < 0 || dependency >= index)) {
      throw contractError(`step ${index + 1} has an invalid dependency`);
    }
    return Object.freeze({
      index,
      toolName,
      capability,
      delivery,
      sideEffecting,
      exactlyOnce: EXACTLY_ONCE_RE.test(clause),
      dependsOn: frozenArray(dependsOn),
    });
  });

  return Object.freeze({
    version: VERSION,
    source: 'singleton-compound',
    steps: frozenArray(steps),
  });
}

function malformedContractAudit(reason) {
  return {
    ok: false,
    code: 'completion_contract_unverifiable',
    completed: [],
    missing: [],
    failed: [],
    pending: [],
    running: [],
    outOfOrder: [],
    overInvoked: [],
    unverifiable: [{ reason }],
    recoveredFailures: [],
    completedSideEffects: [],
    stepCount: 0,
  };
}

function validateContract(contract) {
  if (!contract || typeof contract !== 'object') return 'contract is missing';
  if (contract.version !== VERSION) return `unsupported contract version ${String(contract.version)}`;
  if (!Array.isArray(contract.steps) || contract.steps.length < 2) return 'contract requires at least two steps';
  for (let position = 0; position < contract.steps.length; position++) {
    const step = contract.steps[position];
    if (!step || typeof step !== 'object') return `step ${position + 1} is malformed`;
    if (step.index !== position) return `step ${position + 1} has a non-canonical index`;
    if (!nonEmptyString(step.toolName)) return `step ${position + 1} has no tool name`;
    if (!Array.isArray(step.dependsOn)) return `step ${position + 1} has no dependency list`;
    if (step.dependsOn.some(dependency => !Number.isSafeInteger(dependency)
      || dependency < 0 || dependency >= position)) return `step ${position + 1} has an invalid dependency`;
  }
  return null;
}

function eventText(event) {
  return String(event?.text ?? event?.preview ?? '');
}

function eventState(event) {
  const rawStatus = nonEmptyString(event?.status)?.toLowerCase() || '';
  const text = eventText(event);
  if (event?.isError === true || rawStatus === 'error' || rawStatus === 'failed'
      || looksLikeToolError(text) || looksLikeToolRefusal(text)) return 'failed';
  if (PENDING_STATUSES.has(rawStatus) || DEFERRED_RESULT_RE.test(text)) return 'pending';
  if (RUNNING_STATUSES.has(rawStatus)) return 'running';
  if (rawStatus === SUCCESS_STATUS) return 'done';
  return 'unverifiable';
}

function normalizeEvents(toolEvents) {
  if (!Array.isArray(toolEvents)) return { events: [], invalid: ['tool event ledger is missing'] };
  const events = [];
  const invalid = [];
  for (let eventIndex = 0; eventIndex < toolEvents.length; eventIndex++) {
    const raw = toolEvents[eventIndex];
    const name = nonEmptyString(raw?.name);
    if (!name) {
      invalid.push(`event ${eventIndex + 1} has no tool name`);
      continue;
    }
    const callSeq = finiteSequence(raw?.callSeq);
    const resultSeq = finiteSequence(raw?.resultSeq);
    const callObserved = raw?.callObserved === true
      || (raw?.native === true && raw?.completionEvidence === 'provider-progress');
    let evidenceIssue = null;
    if (!callObserved) evidenceIssue = 'tool call was not observed';
    else if (callSeq == null) evidenceIssue = 'tool call sequence is missing';
    else if (resultSeq == null) evidenceIssue = 'tool result sequence is missing';
    else if (resultSeq < callSeq) evidenceIssue = 'tool result precedes its call';
    events.push({
      raw,
      eventIndex,
      name,
      state: eventState(raw),
      callSeq,
      resultSeq,
      callObserved,
      evidenceIssue,
      toolCallId: nonEmptyString(raw?.toolCallId),
      native: raw?.native === true,
    });
  }
  return { events, invalid };
}

function issueStep(step, extra = {}) {
  return { stepIndex: step.index, toolName: step.toolName, ...extra };
}

function successCandidate(event) {
  return event.state === 'done' && !event.evidenceIssue;
}

function sequenceSort(left, right) {
  return (left.callSeq - right.callSeq)
    || (left.resultSeq - right.resultSeq)
    || (left.eventIndex - right.eventIndex);
}

/**
 * Verify a normalized worker tool-event ledger against the immutable contract.
 * This function is fail-closed and side-effect free. A false result is evidence
 * for `_onComplete(..., status:'error')`, never authority to retry a tool.
 *
 * Each event is one completed-call record, not separate raw call/result frames:
 * `{name,status,callObserved,callSeq,resultSeq,toolCallId?,native?,text?}`.
 *
 * @param {object} contract
 * @param {object[]} toolEvents
 */
export function evaluateCompoundWorkflowContract(contract, toolEvents) {
  const contractProblem = validateContract(contract);
  if (contractProblem) return malformedContractAudit(contractProblem);

  const normalized = normalizeEvents(toolEvents);
  const byName = new Map();
  for (const event of normalized.events) {
    if (!byName.has(event.name)) byName.set(event.name, []);
    byName.get(event.name).push(event);
  }
  for (const events of byName.values()) events.sort(sequenceSort);

  /** @type {any[]} */
  const completed = [];
  /** @type {any[]} */
  const missing = [];
  /** @type {any[]} */
  const failed = [];
  /** @type {any[]} */
  const pending = [];
  /** @type {any[]} */
  const running = [];
  /** @type {any[]} */
  const outOfOrder = [];
  /** @type {any[]} */
  const overInvoked = [];
  /** @type {any[]} */
  const unverifiable = normalized.invalid.map(reason => ({ reason }));
  /** @type {any[]} */
  const recoveredFailures = [];
  /** @type {any[]} */
  const completedSideEffects = [];
  const assigned = new Map();
  const usedEventIndexes = new Set();

  for (const step of contract.steps) {
    const allForName = byName.get(step.toolName) || [];
    const availableSuccesses = allForName.filter(event =>
      !usedEventIndexes.has(event.eventIndex) && successCandidate(event));
    const dependencyEvents = step.dependsOn.map(index => assigned.get(index));
    const dependenciesMissing = dependencyEvents.some(event => !event);
    const dependencyEvidenceMissing = dependencyEvents.some(event => event?.resultSeq == null);
    const dependencyBoundary = dependencyEvidenceMissing
      ? null
      : dependencyEvents.reduce((latest, event) => Math.max(latest, event?.resultSeq ?? -1), -1);

    const orderedSuccesses = step.dependsOn.length === 0
      ? availableSuccesses
      : availableSuccesses.filter(event => dependencyBoundary != null
        && event.callSeq > dependencyBoundary);
    const selected = orderedSuccesses[0] || null;
    if (selected) {
      assigned.set(step.index, selected);
      usedEventIndexes.add(selected.eventIndex);
      const completion = issueStep(step, {
        eventIndex: selected.eventIndex,
        callSeq: selected.callSeq,
        resultSeq: selected.resultSeq,
        toolCallId: selected.toolCallId,
        native: selected.native,
      });
      completed.push(completion);
      if (step.sideEffecting) completedSideEffects.push(completion);
      const priorFailures = allForName.filter(event =>
        event.eventIndex !== selected.eventIndex && event.state === 'failed');
      if (priorFailures.length) {
        recoveredFailures.push(issueStep(step, { count: priorFailures.length }));
      }
      continue;
    }

    if (availableSuccesses.length && step.dependsOn.length) {
      if (dependenciesMissing) {
        // The prerequisite step gets its own primary issue. Keep this consumer
        // missing rather than claiming a concrete ordering violation against an
        // event whose dependency was never established.
        missing.push(issueStep(step, { reason: 'dependency did not complete' }));
      } else if (dependencyEvidenceMissing) {
        unverifiable.push(issueStep(step, { reason: 'dependency result sequence is missing' }));
      } else {
        outOfOrder.push(issueStep(step, {
          dependsOn: [...step.dependsOn],
          dependencyResultSeq: dependencyBoundary,
          observedCallSeq: availableSuccesses[0].callSeq,
        }));
      }
      continue;
    }

    const failedEvents = allForName.filter(event => event.state === 'failed');
    const pendingEvents = allForName.filter(event => event.state === 'pending');
    const runningEvents = allForName.filter(event => event.state === 'running');
    const badEvidence = allForName.filter(event => event.state === 'unverifiable' || event.evidenceIssue);
    if (failedEvents.length) {
      failed.push(issueStep(step, { count: failedEvents.length }));
    } else if (pendingEvents.length) {
      pending.push(issueStep(step, { count: pendingEvents.length }));
    } else if (runningEvents.length) {
      running.push(issueStep(step, { count: runningEvents.length }));
    } else if (badEvidence.length) {
      unverifiable.push(issueStep(step, {
        reason: badEvidence[0].evidenceIssue || 'tool result status is unknown',
      }));
    } else {
      missing.push(issueStep(step, { reason: allForName.length ? 'insufficient distinct successful calls' : 'tool was not called' }));
    }
  }

  // An explicit "exactly once" applies to that routed operation. When a tool
  // legitimately represents multiple contract steps, the expected total is the
  // number of those steps, not one call for the entire workflow.
  const exactNames = new Set(contract.steps.filter(step => step.exactlyOnce).map(step => step.toolName));
  for (const toolName of exactNames) {
    const progressOnly = (byName.get(toolName) || [])
      .some(event => event.raw?.completionEvidence === 'provider-progress');
    if (progressOnly) {
      unverifiable.push({
        toolName,
        reason: 'provider-progress evidence cannot prove exact invocation count',
      });
      continue;
    }
    const expected = contract.steps.filter(step => step.toolName === toolName).length;
    const observed = (byName.get(toolName) || []).filter(event => event.callObserved).length;
    if (observed > expected) overInvoked.push({ toolName, expected, observed });
    else if (observed < expected && !missing.some(issue => issue.toolName === toolName)
      && !failed.some(issue => issue.toolName === toolName)
      && !pending.some(issue => issue.toolName === toolName)
      && !running.some(issue => issue.toolName === toolName)
      && !unverifiable.some(issue => issue.toolName === toolName)) {
      missing.push({ toolName, expected, observed, reason: 'exact call count was not met' });
    }
  }

  const ok = missing.length === 0
    && failed.length === 0
    && pending.length === 0
    && running.length === 0
    && outOfOrder.length === 0
    && overInvoked.length === 0
    && unverifiable.length === 0;
  return {
    ok,
    code: ok ? 'ok' : 'compound_workflow_incomplete',
    completed,
    missing,
    failed,
    pending,
    running,
    outOfOrder,
    overInvoked,
    unverifiable,
    recoveredFailures,
    completedSideEffects,
    stepCount: contract.steps.length,
  };
}

function stepLabel(issue) {
  const number = Number.isSafeInteger(issue?.stepIndex) ? `step ${issue.stepIndex + 1} ` : '';
  return `${number}(${issue?.toolName || 'unknown tool'})`;
}

/** Return bounded, deterministic user-facing error text without tool contents. */
export function formatCompoundContractFailure(audit) {
  if (!audit || audit.ok === true) return '';
  const reasons = [];
  for (const issue of audit.missing || []) reasons.push(`missing required ${stepLabel(issue)}`);
  for (const issue of audit.failed || []) reasons.push(`failed required ${stepLabel(issue)}`);
  for (const issue of audit.pending || []) reasons.push(`required ${stepLabel(issue)} is still pending`);
  for (const issue of audit.running || []) reasons.push(`required ${stepLabel(issue)} never reached a terminal result`);
  for (const issue of audit.outOfOrder || []) reasons.push(`required ${stepLabel(issue)} started before its prerequisite completed`);
  for (const issue of audit.overInvoked || []) {
    reasons.push(`${issue.toolName} was called ${issue.observed} times but the contract allowed ${issue.expected}`);
  }
  for (const issue of audit.unverifiable || []) {
    reasons.push(issue.toolName
      ? `required ${stepLabel(issue)} could not be verified`
      : `the completion evidence could not be verified (${issue.reason || 'unknown reason'})`);
  }
  const completed = Array.isArray(audit.completed) ? audit.completed.length : 0;
  const total = Number.isSafeInteger(audit.stepCount) ? audit.stepCount : 0;
  const detail = (reasons.length ? reasons : ['the completion contract was not satisfied'])
    .slice(0, 8).join('; ');
  return `Background workflow incomplete: ${detail}. Completed required steps: ${completed} of ${total}. `
    + 'No missing or failed step was retried automatically. Any external action that already completed was left in place.';
}

export const _internal = {
  DEFERRED_RESULT_RE,
  EXACTLY_ONCE_RE,
  eventState,
  normalizeEvents,
  validateContract,
};
