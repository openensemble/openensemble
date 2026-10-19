import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { USERS_DIR } from './paths.mjs';
import { withFileLockSync, getProcessIdentity, processIdentityIsProvenDead } from './file-lock.mjs';
import { resolveWriteTargetSync } from './write-target.mjs';
import { tokenPricing, tokenCost } from './token-cost.mjs';

export const budgetContext = new AsyncLocalStorage();
const unlimited = () => ({ tokens: null, usd: null });
const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0, tokens: 0, estimatedUsd: 0, unpricedTokens: 0, uncertainRequests: 0 });
const limited = limits => limits?.tokens != null || limits?.usd != null;
const httpError = (status, message) => Object.assign(new Error(message), { status });
export const currentRunBudget = () => budgetContext.getStore() || null;
export const budgetIsActive = () => Boolean(currentRunBudget() && currentRunBudget().bounded !== false);

// One reservation admits one physical inference request. Compatibility probes
// and transport retries must never consume a second request invisibly.
export function noteBudgetNetworkAttempt() {
  const context = currentRunBudget();
  if (!budgetIsActive()) return;
  const request = context.networkReservation;
  if (!request || request.attempts++) throw pauseBudgetRun(context, 'An additional provider request needs a new usage reservation. Review the previous request before continuing.');
  assertBudgetRunning(context);
}

export class RunBudgetPaused extends Error {
  constructor(runId, message) { super(message); this.code = 'RUN_BUDGET_PAUSED'; this.runId = runId; this.retryable = false; this.status = 409; }
}
export function budgetErrorEvent(error) {
  return { type: 'error', code: error.code || 'RUN_BUDGET_STORAGE', retryable: false, status: 'paused', runId: error.runId || currentRunBudget()?.runId,
    message: `Run paused: ${error.message}` };
}
export function validateBudgetLimits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['tokens', 'usd'].includes(k))) throw httpError(400, 'Use token and USD limits.');
  const limits = unlimited();
  for (const key of ['tokens', 'usd']) {
    const number = value[key];
    if (number == null) continue;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > (key === 'tokens' ? 1e12 : 1e7)
        || key === 'tokens' && !Number.isSafeInteger(number)) throw httpError(400, 'Limits must be nonnegative numbers; tokens must be whole numbers. Use null for unlimited.');
    limits[key] = number;
  }
  return limits;
}
function fileFor(userId) {
  if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(userId)) throw httpError(400, 'Invalid account.');
  return resolveWriteTargetSync(path.join(USERS_DIR, userId, 'run-budgets.json'));
}
function load(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || !saved.runs || !saved.projects || !saved.defaults) throw new Error('Invalid budget ledger');
    return saved;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, revision: 0, defaults: unlimited(), projects: {}, runs: {} };
    throw Object.assign(new Error('The budget ledger could not be read. No request was authorized.'), { code: 'RUN_BUDGET_STORAGE', retryable: false });
  }
}
function durableSave(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new Error('The budget ledger needs review before more work can start.');
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, json); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}
function mutate(userId, fn) {
  const file = fileFor(userId);
  return withFileLockSync(`${file}.lock`, () => {
    const data = load(file);
    const result = fn(data);
    data.revision++;
    durableSave(file, data);
    return result;
  }, { timeoutMs: 5000 });
}
const clone = value => structuredClone(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 500
  && !['__proto__', 'prototype', 'constructor'].includes(value);
const own = (records, id) => validId(id) && records && Object.hasOwn(records, id) ? records[id] : undefined;
export function getBudgetSettings(userId) {
  const data = load(fileFor(userId));
  return { revision: data.settingsRevision || 0, defaults: data.defaults };
}
export function setBudgetSettings(userId, { revision, defaults }) {
  const value = validateBudgetLimits(defaults);
  return mutate(userId, data => {
    if (revision !== (data.settingsRevision || 0)) throw httpError(409, 'Budget settings changed. Reload before saving.');
    data.defaults = value;
    data.settingsRevision = (data.settingsRevision || 0) + 1;
    return { revision: data.settingsRevision, defaults: clone(value) };
  });
}
function projectRow(data, id) {
  if (!validId(id)) throw httpError(400, 'Invalid project.');
  if (!own(data.projects, id)) data.projects[id] = { revision: 0, limits: unlimited(), runLimits: null, usage: emptyUsage() };
  return data.projects[id];
}
export function getProjectBudget(userId, projectId) {
  const data = load(fileFor(userId));
  const project = projectRow(data, projectId);
  return { projectId, ...clone(project), defaults: clone(data.defaults), reserved: reservedUsage(Object.values(data.runs).filter(run => run.projectId === projectId)) };
}
export function setProjectBudget(userId, projectId, { revision, limits, runLimits }) {
  const cap = validateBudgetLimits(limits), perRun = runLimits == null ? null : validateBudgetLimits(runLimits);
  return mutate(userId, data => {
    const project = projectRow(data, projectId);
    if (revision !== project.revision) throw httpError(409, 'Project budget changed. Reload before saving.');
    project.limits = cap; project.runLimits = perRun; project.revision++;
    return { projectId, ...clone(project) };
  });
}
function reservedUsage(runs) {
  const reserved = { tokens: 0, estimatedUsd: 0, requests: 0 };
  for (const run of runs) for (const request of Object.values(run.reservations || {})) {
    reserved.tokens += request.inputEstimate + request.outputLimit;
    reserved.estimatedUsd += request.estimatedUsd || 0;
    reserved.requests++;
  }
  return reserved;
}
function publicRun(run) {
  if (!run) return null;
  return { id: run.id, title: run.title, projectId: run.projectId, chatId: run.chatId, agentId: run.agentId,
    status: run.status, reason: run.reason || null, revision: run.revision, limits: clone(run.limits), usage: clone(run.usage),
    reserved: reservedUsage([run]), createdAt: run.createdAt, updatedAt: run.updatedAt,
    spans: Object.values(run.spans).map(span => ({ id: span.id, title: span.title, agentId: span.agentId, taskId: span.taskId,
      status: span.status, generation: span.generation, reason: span.reason || null, output: span.output || '',
      uncertain: span.actions.filter(action => action.status === 'started' && action.mutation).map(action => ({ id: action.id, name: action.name, args: action.args })),
      completedActions: span.actions.filter(action => action.status === 'done').length })) };
}
export function getBudgetRun(userId, runId) {
  recoverBudgetRuns(userId);
  const run = own(load(fileFor(userId)).runs, runId);
  if (!run) throw httpError(404, 'Budgeted run not found.');
  return publicRun(run);
}
export function listBudgetRuns(userId) {
  recoverBudgetRuns(userId);
  return Object.values(load(fileFor(userId)).runs).sort((a, b) => b.updatedAt - a.updatedAt).map(publicRun);
}
export function listPausedBudgetRuns(userId) {
  return listBudgetRuns(userId).filter(run => run.status === 'paused' || run.status === 'cancelled' && run.reserved.requests > 0);
}

export function setRunBudget(userId, runId, { revision, limits }) {
  const cap = validateBudgetLimits(limits);
  return mutate(userId, data => {
    const run = own(data.runs, runId);
    if (!run) throw httpError(404, 'Budgeted run not found.');
    if (revision !== run.revision) throw httpError(409, 'This run changed. Reload its details.');
    run.limits = cap; touch(run);
    return publicRun(run);
  });
}

export function openBudgetRun(userId, { runId, projectId = null, chatId = null, agentId = null, title = '', limits } = {}) {
  if (runId != null && !validId(runId)) throw httpError(400, 'Invalid run.');
  const data = load(fileFor(userId));
  const project = projectId ? projectRow(data, projectId) : null;
  const effective = limits === undefined ? project?.runLimits || data.defaults : validateBudgetLimits(limits);
  if (!own(data.runs, runId) && !limited(effective) && !limited(project?.limits)) return null;
  return mutate(userId, saved => {
    const existing = own(saved.runs, runId);
    if (existing) return { userId, runId: existing.id, bounded: limited(existing.limits) || limited(project?.limits) };
    if (Object.keys(saved.runs).length >= 512) {
      const removable = Object.values(saved.runs).filter(run => ['done', 'error', 'cancelled'].includes(run.status) && !Object.keys(run.reservations).length)
        .sort((a, b) => a.updatedAt - b.updatedAt).slice(0, 64);
      for (const run of removable) delete saved.runs[run.id];
      if (Object.keys(saved.runs).length >= 512) throw httpError(409, 'Review unfinished budgeted runs before starting more.');
    }
    const id = runId || `budget_${randomUUID()}`;
    saved.runs[id] = { id, projectId, chatId, agentId, title: String(title).slice(0, 240), limits: clone(effective),
      status: 'running', revision: 0, usage: emptyUsage(), reservations: {}, spans: {}, createdAt: Date.now(), updatedAt: Date.now() };
    return { userId, runId: id, bounded: true };
  });
}
function touch(run) { run.revision++; run.updatedAt = Date.now(); }
function pause(run, reason) { run.status = 'paused'; run.reason = reason; touch(run); return new RunBudgetPaused(run.id, reason); }
function runRow(data, context) {
  const run = own(data.runs, context.runId);
  if (!run) throw httpError(404, 'Budgeted run not found.');
  return run;
}
export function pauseBudgetRun(context, reason) {
  let error;
  mutate(context.userId, data => { error = pause(runRow(data, context), reason); });
  return error;
}
export function budgetSpan(context, execution, spanId = null) {
  let failure;
  const result = mutate(context.userId, data => {
    const run = runRow(data, context);
    if (run.status === 'cancelled') throw new RunBudgetPaused(run.id, 'This work was stopped.');
    if (spanId) {
      if (run.status === 'paused') throw new RunBudgetPaused(run.id, run.reason);
      if (!own(run.spans, spanId)) throw httpError(404, 'Budgeted work not found.');
      if (run.spans[spanId].status !== 'ready') throw httpError(409, 'This work is not authorized to continue, or is already running.');
      run.spans[spanId].status = 'running'; run.spans[spanId].owner = getProcessIdentity(); touch(run);
      run.status = 'running';
      if (execution.taskId) run.spans[spanId].taskId = execution.taskId;
      return { ...context, spanId };
    }
    if (Object.keys(run.spans).length >= 128) { failure = pause(run, 'This run reached its saved work limit. Review it before continuing.'); return; }
    const id = randomUUID();
    run.spans[id] = { ...execution, id, title: String(execution.task || '').slice(0, 240), status: 'running', generation: 0, actions: [], owner: getProcessIdentity() };
    if (run.status !== 'paused') run.status = 'running';
    touch(run);
    return { ...context, spanId: id };
  });
  if (failure) throw failure;
  return result;
}
export function finishBudgetSpan(context, { status, output = '', reason = '' }) {
  return mutate(context.userId, data => {
    const run = runRow(data, context), span = own(run.spans, context.spanId);
    if (!span) return;
    span.status = run.status === 'paused' && status === 'done' ? 'paused' : status;
    span.output = String(output).slice(-24000); span.reason = reason;
    if (Object.values(run.spans).every(item => ['done', 'error', 'cancelled'].includes(item.status))) run.status = status;
    else if (Object.values(run.spans).some(item => item.status === 'paused') && !Object.values(run.spans).some(item => ['running', 'ready'].includes(item.status))) {
      run.status = 'paused'; run.reason ||= 'Other work in this run still needs continuation authorization.';
    }
    touch(run);
  });
}
function exceeds(limits, usage, reserved, tokens, usd) {
  return limits?.tokens != null && usage.tokens + reserved.tokens + tokens > limits.tokens
    || limits?.usd != null && usage.estimatedUsd + reserved.estimatedUsd + (usd || 0) > limits.usd + 1e-10;
}
export function estimateBudgetRequest({ provider, model, request, inputTokens, outputTokens = 4096, config = {} }) {
  const inputEstimate = inputTokens ?? Math.max(1, Buffer.byteLength(JSON.stringify(request || {})));
  const outputLimit = outputTokens;
  const pricing = tokenPricing(provider, model, config);
  return { inputEstimate, outputLimit, tokens: inputEstimate + outputLimit,
    estimatedUsd: tokenCost(pricing, inputEstimate, outputLimit), pricing, estimated: true,
    note: 'Conservative input-byte estimate plus output allowance. Actual tokenization, provider rates and extra tool charges can differ.' };
}
export function reserveBudgetRequest(context, estimate, { provider, model, enforceable = true } = {}) {
  let failure, reservation;
  mutate(context.userId, data => {
    const run = runRow(data, context);
    if (run.status === 'cancelled' || own(run.spans, context.spanId)?.status === 'cancelled') { failure = new RunBudgetPaused(run.id, 'This work was stopped.'); return; }
    if (run.status === 'paused') { failure = new RunBudgetPaused(run.id, run.reason); return; }
    const project = run.projectId ? projectRow(data, run.projectId) : null;
    const projectRuns = Object.values(data.runs).filter(item => item.projectId === run.projectId);
    if (Object.values(run.reservations).some(row => processIdentityIsProvenDead(row.owner))) {
      failure = pause(run, 'A prior request ended without durable usage. Review its reserved estimate before continuing.'); return;
    }
    if (!enforceable) { failure = pause(run, 'This provider endpoint cannot enforce an output allowance. Choose a compatible endpoint or explicitly remove the limits.'); return; }
    if (!Number.isSafeInteger(estimate.inputEstimate) || estimate.inputEstimate < 0 || !Number.isSafeInteger(estimate.outputLimit) || estimate.outputLimit < 1) {
      failure = pause(run, 'The next request could not be estimated safely.'); return;
    }
    if ((run.limits.usd != null || project?.limits.usd != null) && estimate.estimatedUsd == null) {
      failure = pause(run, 'Pricing is unknown for this model. Use a token-only limit or a model with available pricing. No request was sent.'); return;
    }
    if (run.limits.usd != null && run.usage.unpricedTokens > 0 || project?.limits.usd != null && project.usage.unpricedTokens > 0) {
      failure = pause(run, 'Earlier usage has unknown pricing. A USD ceiling cannot account for it safely; use a token-only limit. No request was sent.'); return;
    }
    if (exceeds(run.limits, run.usage, reservedUsage([run]), estimate.tokens, estimate.estimatedUsd)
        || project && exceeds(project.limits, project.usage, reservedUsage(projectRuns), estimate.tokens, estimate.estimatedUsd)) {
      failure = pause(run, 'The next request plus active reservations exceeds the run or project allowance. Approve more allowance to continue.'); return;
    }
    const id = randomUUID();
    reservation = { id, spanId: context.spanId, provider, model, ...estimate, owner: getProcessIdentity(), startedAt: Date.now() };
    run.reservations[id] = reservation; run.status = 'running'; touch(run);
  });
  if (failure) throw failure;
  return reservation;
}
function charge(usage, input, output, cost, uncertain = false) {
  usage.inputTokens += input; usage.outputTokens += output; usage.tokens += input + output;
  if (cost == null) usage.unpricedTokens += input + output;
  else usage.estimatedUsd += cost;
  if (uncertain) usage.uncertainRequests++;
}
export function settleBudgetRequest(context, reservationId, usage) {
  let failure;
  mutate(context.userId, data => {
    const run = runRow(data, context), row = own(run.reservations, reservationId);
    if (!row) return; // A duplicate terminal usage record cannot charge twice.
    const known = usage?.complete !== false && usage?.estimated !== true
      && [usage?.inputTokens, usage?.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)
      && usage.inputTokens + usage.outputTokens > 0;
    if (!known) { row.uncertain = true; failure = pause(run, 'The provider did not report complete usage. Its full allowance remains reserved; review it before continuing.'); return; }
    const cost = tokenCost(row.pricing, usage.inputTokens, usage.outputTokens);
    charge(run.usage, usage.inputTokens, usage.outputTokens, cost);
    const project = run.projectId ? projectRow(data, run.projectId) : null;
    if (project) charge(project.usage, usage.inputTokens, usage.outputTokens, cost);
    delete run.reservations[reservationId]; touch(run);
    if (exceeds(run.limits, run.usage, { tokens: 0, estimatedUsd: 0 }, 0, 0)
        || project && exceeds(project.limits, project.usage, { tokens: 0, estimatedUsd: 0 }, 0, 0)) {
      failure = pause(run, 'Reported usage exceeded the allowance estimate. Further work is paused.');
    }
  });
  if (failure) throw failure;
}
export function assertBudgetRunning(context = currentRunBudget()) {
  if (!context) return;
  const run = own(load(fileFor(context.userId)).runs, context.runId);
  if (!run) throw httpError(404, 'Budgeted run not found.');
  if (run.status === 'paused') throw new RunBudgetPaused(run.id, run.reason);
  if (run.status === 'cancelled' || context.spanId && own(run.spans, context.spanId)?.status === 'cancelled') throw Object.assign(new Error('This work was stopped.'), { code: 'RUN_BUDGET_STOPPED', retryable: false });
  if (context.spanId && own(run.spans, context.spanId)?.status === 'paused') throw new RunBudgetPaused(run.id, 'This work needs explicit continuation authorization.');
}

function recoverBudgetRuns(userId) {
  const abandoned = data => Object.values(data.runs).some(run => Object.values(run.spans).some(span => ['running', 'ready'].includes(span.status) && processIdentityIsProvenDead(span.owner)));
  if (!abandoned(load(fileFor(userId)))) return;
  mutate(userId, data => {
    for (const run of Object.values(data.runs)) {
      let interrupted = false;
      for (const span of Object.values(run.spans)) if (['running', 'ready'].includes(span.status) && processIdentityIsProvenDead(span.owner)) {
        span.status = 'paused'; span.reason = 'The previous process stopped. Review saved progress before continuing.'; interrupted = true;
      }
      if (interrupted) {
        for (const row of Object.values(run.reservations)) if (processIdentityIsProvenDead(row.owner)) row.uncertain = true;
        pause(run, 'The previous process stopped. Usage reservations and action receipts were retained for review.');
      }
    }
  });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function beginBudgetAction({ userId, name, args, mutation }) {
  const context = currentRunBudget();
  if (!context || context.userId !== userId) return null;
  assertBudgetRunning(context);
  let action, failure;
  mutate(userId, data => {
    const run = runRow(data, context), span = own(run.spans, context.spanId);
    if (run.status === 'paused') { failure = new RunBudgetPaused(run.id, run.reason); return; }
    if (!span) throw httpError(404, 'Budgeted work not found.');
    const fingerprint = createHash('sha256').update(JSON.stringify([name, canonical(args ?? {})])).digest('hex');
    const prior = span.actions.findLast(row => row.fingerprint === fingerprint && row.status !== 'retry_authorized');
    if (prior?.status === 'started' && mutation) { failure = pause(run, `The result of ${name} is uncertain. Review it before repeating the action.`); return; }
    if (mutation && prior?.status === 'done' && prior.generation < span.generation) {
      action = { replay: true, text: prior.result, isError: prior.isError, events: prior.events }; return;
    }
    if (span.actions.length >= 256) { failure = pause(run, 'This work reached its saved action limit.'); return; }
    const id = randomUUID();
    span.actions.push({ id, name, args, fingerprint, mutation, generation: span.generation, status: 'started', events: [] });
    action = { ...context, id }; touch(run);
  });
  if (failure) throw failure;
  return action;
}
export function finishBudgetAction(action, event) {
  if (!action || action.replay || !['result', 'image', 'audio', 'video'].includes(event.type)) return;
  mutate(action.userId, data => {
    const run = runRow(data, action), row = own(run.spans, action.spanId)?.actions.find(item => item.id === action.id);
    if (!row) throw new Error('Budget action receipt is missing.');
    if (event.type === 'result') { row.status = 'done'; row.result = String(event.text || '').slice(0, 48000); row.isError = event.isError === true; }
    else if (event.filename) row.events.push({ type: event.type, filename: event.filename, savedPath: event.savedPath, mimeType: event.mimeType });
    touch(run);
  });
}
export function readBudgetSpan(userId, runId, spanId) {
  recoverBudgetRuns(userId);
  const span = own(own(load(fileFor(userId)).runs, runId)?.spans, spanId);
  if (!span) throw httpError(404, 'Budgeted work not found.');
  return clone(span);
}
export function rememberBudgetConversation(context, messages, execution = null) {
  if (!context) return;
  const text = JSON.stringify(messages, (key, value) => key === 'base64' || typeof value === 'string' && value.startsWith('data:') ? '[Inline attachment omitted; use its saved file]' : value);
  mutate(context.userId, data => {
    const run = runRow(data, context), span = own(run.spans, context.spanId);
    if (!span) throw httpError(404, 'Budgeted work not found.');
    if (execution) {
      span.provider = execution.provider; span.model = execution.model; span.reasoningEffort = execution.reasoningEffort;
    }
    // Keep the original conversation, not the empty isolated resume session.
    if (span.conversation == null) {
      span.conversation = text.length > 64000 ? `[Earlier context truncated]\n${text.slice(-64000)}` : text;
      touch(run);
    }
  });
}
function reconcileUnknownUsage(run, project, accept) {
  const pending = Object.values(run.reservations);
  if (pending.some(row => !row.uncertain && !processIdentityIsProvenDead(row.owner))) throw httpError(409, 'Wait for active provider requests to finish before continuing.');
  if (pending.length && accept !== true) throw httpError(400, 'Acknowledge the reserved estimates for requests with unknown usage.');
  for (const row of pending) {
    charge(run.usage, row.inputEstimate, row.outputLimit, row.estimatedUsd, true);
    if (project) charge(project.usage, row.inputEstimate, row.outputLimit, row.estimatedUsd, true);
    delete run.reservations[row.id];
  }
}

/** Reconcile stopped work without authorizing another request or tool action. */
export function acceptBudgetUsageEstimate(userId, runId, { revision, acceptUncertainUsage } = {}) {
  return mutate(userId, data => {
    const run = own(data.runs, runId);
    if (!run) throw httpError(404, 'Budgeted run not found.');
    if (revision !== run.revision) throw httpError(409, 'This run changed. Reload its budget details.');
    if (acceptUncertainUsage !== true) throw httpError(400, 'Explicitly accept the reserved usage estimates.');
    reconcileUnknownUsage(run, run.projectId ? projectRow(data, run.projectId) : null, true);
    touch(run);
    return publicRun(run);
  });
}
export function authorizeBudgetContinuation(userId, runId, { revision, additional, projectAdditional, removeLimits = false, acceptUncertainUsage = false, resolutions = [], spanIds = null } = {}) {
  if (!Array.isArray(resolutions) || resolutions.some(row => !row || typeof row !== 'object' || !validId(row.spanId) || !validId(row.id))
      || spanIds != null && (!Array.isArray(spanIds) || spanIds.some(id => !validId(id)))) throw httpError(400, 'Invalid continuation review.');
  const extra = validateBudgetLimits(additional || {}), projectExtra = validateBudgetLimits(projectAdditional || {});
  return mutate(userId, data => {
    const run = own(data.runs, runId);
    if (!run) throw httpError(404, 'Budgeted run not found.');
    if (run.status !== 'paused' || revision !== run.revision) throw httpError(409, 'This run changed. Reload its budget details.');
    if (!removeLimits && !extra.tokens && !extra.usd && !projectExtra.tokens && !projectExtra.usd) throw httpError(400, 'Explicitly approve additional allowance.');
    const project = run.projectId ? projectRow(data, run.projectId) : null;
    reconcileUnknownUsage(run, project, acceptUncertainUsage);
    const spans = Object.values(run.spans).filter(span => span.status === 'paused' && (!spanIds || spanIds.includes(span.id)));
    if (!spans.length) throw httpError(409, 'No paused work was selected.');
    for (const span of spans) for (const action of span.actions.filter(row => row.status === 'started' && row.mutation)) {
      const resolution = resolutions.find(item => item.spanId === span.id && item.id === action.id);
      if (!resolution || !['completed', 'retry'].includes(resolution.outcome)) throw httpError(400, 'Review every interrupted action before continuing.');
      if (resolution.outcome === 'completed') {
        if (typeof resolution.result !== 'string' || !resolution.result.trim() || resolution.result.length > 12000) throw httpError(400, 'Enter the observed action result.');
        action.status = 'done'; action.result = `User verified: ${resolution.result.trim()}`; action.isError = false;
      } else action.status = 'retry_authorized';
    }
    for (const key of ['tokens', 'usd']) {
      if (extra[key]) run.limits[key] = (run.limits[key] ?? (key === 'tokens' ? run.usage.tokens : run.usage.estimatedUsd)) + extra[key];
      if (project && projectExtra[key]) { project.limits[key] = (project.limits[key] ?? (key === 'tokens' ? project.usage.tokens : project.usage.estimatedUsd)) + projectExtra[key]; project.revision++; }
    }
    if (removeLimits === true) run.limits = unlimited();
    run.status = 'ready'; run.reason = null;
    for (const span of spans) { span.generation++; span.status = 'ready'; span.owner = getProcessIdentity(); }
    run.authorizations = [...(run.authorizations || []), { at: Date.now(), additional: extra, projectAdditional: projectExtra,
      removeLimits: removeLimits === true, acceptedUncertainUsage: acceptUncertainUsage === true, spanIds: spans.map(span => span.id) }].slice(-32);
    touch(run);
    return { run: publicRun(run), spanIds: spans.map(span => span.id) };
  });
}
