import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { isSensitiveArgName } from './learning-safety.mjs';
import { applyRedactions } from './credentials.mjs';

const MAX_TRACES = 200;
const PREVIEW_LIMIT = 500;
const MAX_MODEL_CALLS = 32;
const MAX_TOOL_NAMES_PER_CALL = 4096;
const MAX_SKILLS_PER_CALL = 512;
const MAX_RECOVERY_LOADS = 32;
const MAX_TRACE_NAME_CHARS = 200;
const MAX_TOOL_CALL_ID_CHARS = 512;
const MAX_MODEL_TRACE_BYTES = 128 * 1024;
const COMPACT_TO_TRACES = 150;
const MAX_TOOL_EVENTS = 256;

function tracesPath(userId) {
  return path.join(USERS_DIR, userId, 'run-inspector.jsonl');
}

function preview(value, limit = PREVIEW_LIMIT) {
  const text = redactTextForTrace(value).replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * Scrub registered literals and common credential-shaped text before a value
 * enters the plaintext inspector. Tool results are unstructured strings, so
 * sensitive-key redaction for args alone is not sufficient.
 */
export function redactTextForTrace(value) {
  let text = applyRedactions(String(value ?? ''));
  text = text.replace(
    /\b(Authorization\s*:\s*)(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{4,}/gi,
    '$1[REDACTED]',
  );
  // JSON and key=value/Key: value forms. Preserve the key for diagnostics but
  // never the value. The preview need not remain parseable JSON.
  text = text.replace(
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|bearer|secret|password)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
    '$1[REDACTED]',
  );
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]');
  text = text.replace(/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
  text = text.replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  return text;
}

/**
 * Redact values of sensitive-named args (key/token/secret/password/auth/bearer)
 * before they are previewed into a trace. Traces persist as plaintext under
 * users/<id>/, so credentials passed as tool args must not be written there.
 */
export function redactArgsForTrace(args) {
  if (!args || typeof args !== 'object') return args;
  if (Array.isArray(args)) return args.map(v => redactArgsForTrace(v));
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = isSensitiveArgName(k) ? '[redacted]' : redactArgsForTrace(v);
  }
  return out;
}

function safeIdPart(value) {
  return String(value ?? 'run').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function sanitizeDiagnosticValue(value, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactTextForTrace(value).slice(0, 2_000);
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, MAX_TOOL_EVENTS)
    .map(item => sanitizeDiagnosticValue(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 200);
  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, 128)) {
    out[String(key).slice(0, 200)] = isSensitiveArgName(key)
      ? '[redacted]'
      : sanitizeDiagnosticValue(child, depth + 1);
  }
  return out;
}

function sanitizeTools(tools) {
  if (!tools || typeof tools !== 'object') return null;
  const usedNames = boundedStrings(tools.usedNames, MAX_TOOL_EVENTS).values;
  const used = Array.isArray(tools.used) ? tools.used.slice(0, MAX_TOOL_EVENTS).map(tool => ({
    name: String(tool?.name ?? '').slice(0, MAX_TRACE_NAME_CHARS),
    ...(tool?.toolCallId != null
      ? { toolCallId: String(tool.toolCallId).slice(0, MAX_TOOL_CALL_ID_CHARS) }
      : {}),
    ...(tool?.providerNative === true ? { providerNative: true } : {}),
    argsPreview: preview(tool?.argsPreview),
    resultPreview: preview(tool?.resultPreview),
  })) : [];
  const events = Array.isArray(tools.events) ? tools.events.slice(0, MAX_TOOL_EVENTS).map(event => ({
    name: String(event?.name ?? '').slice(0, MAX_TRACE_NAME_CHARS),
    ...(event?.toolCallId != null
      ? { toolCallId: String(event.toolCallId).slice(0, MAX_TOOL_CALL_ID_CHARS) }
      : {}),
    ...(event?.providerNative === true ? { providerNative: true } : {}),
    status: event?.status == null ? null : String(event.status).slice(0, 80),
    durationMs: Number.isFinite(event?.durationMs) ? event.durationMs : null,
    preview: preview(event?.preview),
  })) : [];
  return { usedNames, used, events };
}

function readRaw(userId) {
  const p = tracesPath(userId);
  try {
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    console.warn('[run-inspector] read failed:', e.message);
    return [];
  }
}

function writeRaw(userId, traces) {
  const p = tracesPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const text = traces.slice(-MAX_TRACES).map(t => JSON.stringify(t)).join('\n') + '\n';
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, p);
    fs.chmodSync(p, 0o600);
    try {
      const dirFd = fs.openSync(path.dirname(p), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {}
  } catch (error) {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function appendRaw(userId, entry) {
  const p = tracesPath(userId);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  let fd = null;
  try {
    fd = fs.openSync(p, 'a', 0o600);
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(p, 0o600);
  } catch (error) {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    throw error;
  }
}

function boundedStrings(value, maxItems, maxChars = MAX_TRACE_NAME_CHARS) {
  if (!Array.isArray(value)) return { values: [], complete: value == null };
  const complete = value.length <= maxItems
    && value.every(item => typeof item === 'string' && item.length <= maxChars);
  return {
    values: value.slice(0, maxItems).map(item => String(item).slice(0, maxChars)),
    complete,
  };
}

function sanitizeRecoveryLoads(value) {
  if (!Array.isArray(value)) return { loads: [], complete: value == null };
  let complete = value.length <= MAX_RECOVERY_LOADS;
  const loads = value.slice(0, MAX_RECOVERY_LOADS).map(load => {
    const requestedGroups = boundedStrings(load?.requestedGroups, MAX_SKILLS_PER_CALL);
    const addedSkills = boundedStrings(load?.addedSkills, MAX_SKILLS_PER_CALL);
    const addedToolNames = boundedStrings(load?.addedToolNames, MAX_TOOL_NAMES_PER_CALL);
    const source = String(load?.source ?? '');
    if (source.length > 80 || !requestedGroups.complete || !addedSkills.complete || !addedToolNames.complete) complete = false;
    return {
      source: source.slice(0, 80),
      requestedGroups: requestedGroups.values,
      addedSkills: addedSkills.values,
      addedToolNames: addedToolNames.values,
    };
  });
  return { loads, complete };
}

function sanitizeModelCalls(calls, { modelExpected = true } = {}) {
  if (!Array.isArray(calls)) return { calls: [], bundles: [], complete: false };
  let complete = (modelExpected ? calls.length > 0 : calls.length === 0)
    && calls.length <= MAX_MODEL_CALLS;
  const bundles = new Map();
  const out = calls.slice(0, MAX_MODEL_CALLS).map((call, index) => {
    const rawNames = Array.isArray(call?.toolNames) ? call.toolNames : [];
    if (rawNames.length > MAX_TOOL_NAMES_PER_CALL) complete = false;
    if (rawNames.some(name => typeof name !== 'string' || name.length > MAX_TRACE_NAME_CHARS)) complete = false;
    if (!Number.isSafeInteger(call?.toolSchemaBytes) || call.toolSchemaBytes < 0
        || !Number.isSafeInteger(call?.schemaTokEst) || call.schemaTokEst < 0
        || !/^[0-9a-f]{64}$/.test(String(call?.schemaHash || ''))
        || typeof call?.toolsPresent !== 'boolean'
        || call?.traceError === true) complete = false;
    const toolNames = rawNames.slice(0, MAX_TOOL_NAMES_PER_CALL)
      .map(name => String(name).slice(0, MAX_TRACE_NAME_CHARS));
    if (!Number.isSafeInteger(call?.toolCount) || call.toolCount !== rawNames.length) complete = false;
    const selectedSkills = boundedStrings(call?.selectedSkills, MAX_SKILLS_PER_CALL);
    const addedSkills = boundedStrings(call?.addedSkills, MAX_SKILLS_PER_CALL);
    const recoveryLoads = sanitizeRecoveryLoads(call?.recoveryLoads);
    if (!selectedSkills.complete || !addedSkills.complete || !recoveryLoads.complete) complete = false;
    const schemaHash = typeof call?.schemaHash === 'string' ? call.schemaHash : null;
    if (schemaHash) {
      const existing = bundles.get(schemaHash);
      if (existing && JSON.stringify(existing.toolNames) !== JSON.stringify(toolNames)) complete = false;
      else if (!existing) bundles.set(schemaHash, {
        schemaHash,
        toolNames,
        toolCount: Number.isSafeInteger(call?.toolCount) ? call.toolCount : null,
        toolSchemaBytes: Number.isSafeInteger(call?.toolSchemaBytes) ? call.toolSchemaBytes : null,
        schemaTokEst: Number.isSafeInteger(call?.schemaTokEst) ? call.schemaTokEst : null,
        toolsPresent: call?.toolsPresent === true,
      });
    }
    return {
      ordinal: Number.isSafeInteger(call?.ordinal) ? call.ordinal : index + 1,
      provider: call?.provider == null ? null : String(call.provider).slice(0, 200),
      model: call?.model == null ? null : String(call.model).slice(0, 200),
      requestedReasoningEffort: call?.requestedReasoningEffort == null
        ? null : String(call.requestedReasoningEffort).slice(0, 40),
      wireReasoningEffort: call?.wireReasoningEffort == null
        ? null : String(call.wireReasoningEffort).slice(0, 40),
      phase: call?.phase === 'dispatch_planned' ? call.phase : 'unknown',
      providerRound: Number.isSafeInteger(call?.providerRound) ? call.providerRound : null,
      toolsPresent: call?.toolsPresent === true,
      selectedSkills: selectedSkills.values,
      addedSkills: addedSkills.values,
      recoveryLoads: recoveryLoads.loads,
      toolCount: Number.isSafeInteger(call?.toolCount) ? call.toolCount : null,
      toolSchemaBytes: Number.isSafeInteger(call?.toolSchemaBytes) ? call.toolSchemaBytes : null,
      schemaTokEst: Number.isSafeInteger(call?.schemaTokEst) ? call.schemaTokEst : null,
      schemaHash,
      ...(call?.traceError === true ? { traceError: true } : {}),
    };
  });
  let bundleList = [...bundles.values()];
  if (Buffer.byteLength(JSON.stringify({ calls: out, bundles: bundleList }), 'utf8') > MAX_MODEL_TRACE_BYTES) {
    complete = false;
    bundleList = bundleList.map(({ toolNames, ...summary }) => summary);
  }
  return { calls: out, bundles: bundleList, complete };
}

function sanitizeRouting(routing) {
  if (!routing || typeof routing !== 'object') return { routing: null, complete: routing == null };
  const initialSkills = boundedStrings(routing.initialSkills, MAX_SKILLS_PER_CALL);
  const matchedSkills = boundedStrings(routing.matchedSkills, MAX_SKILLS_PER_CALL);
  const addedSkills = boundedStrings(routing.addedSkills, MAX_SKILLS_PER_CALL);
  const recoveryLoads = sanitizeRecoveryLoads(routing.recoveryLoads);
  return {
    complete: initialSkills.complete && matchedSkills.complete && addedSkills.complete && recoveryLoads.complete,
    routing: {
      initialSkills: initialSkills.values,
      matchedSkills: matchedSkills.values,
      addedSkills: addedSkills.values,
      recoveredMissingTools: routing.recoveredMissingTools === true,
      fullToolCount: Number.isSafeInteger(routing.fullToolCount) ? routing.fullToolCount : null,
      recoveryLoads: recoveryLoads.loads,
    },
  };
}

function sanitizeUsage(usage, { modelExpected = true } = {}) {
  if (!usage || typeof usage !== 'object') {
    return { usage: null, totalsComplete: !modelExpected, cardinalityComplete: !modelExpected };
  }
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const cachedTokens = count(usage.cachedTokens);
  const cacheCreatedTokens = count(usage.cacheCreatedTokens);
  const requestCount = count(usage.requestCount);
  const completionCount = count(usage.completionCount);
  const usageRecordCount = count(usage.usageRecordCount);
  const estimated = usage.estimated === true;
  const totalsComplete = modelExpected && !estimated
    && Number.isSafeInteger(inputTokens) && inputTokens > 0
    && Number.isSafeInteger(outputTokens) && outputTokens > 0;
  const cardinalityComplete = modelExpected
    && usage.usageComplete === true
    && Number.isSafeInteger(requestCount) && requestCount > 0
    && requestCount === completionCount
    && requestCount === usageRecordCount;
  return {
    usage: {
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheCreatedTokens,
      requestCount,
      completionCount,
      usageRecordCount,
      estimated,
      usageComplete: typeof usage.usageComplete === 'boolean' ? usage.usageComplete : null,
    },
    totalsComplete,
    cardinalityComplete,
  };
}

export function recordRunTrace(userId, trace) {
  if (!userId || userId === 'default') return null;
  try {
    const now = Date.now();
    const id = `run_${now}_${safeIdPart(trace?.agentId)}_${Math.random().toString(36).slice(2, 8)}`;
    const modelExpected = trace?.modelExpected !== false;
    const modelCallTrace = sanitizeModelCalls(trace?.modelCalls, { modelExpected });
    const routingTrace = sanitizeRouting(trace?.routing);
    const usageTrace = sanitizeUsage(trace?.usage, { modelExpected });
    if (modelExpected && usageTrace.cardinalityComplete
        && usageTrace.usage?.requestCount !== modelCallTrace.calls.length) {
      usageTrace.cardinalityComplete = false;
    }
    const entry = {
      id,
      ts: now,
      turnId: trace?.turnId ?? null,
      rootId: trace?.rootId ?? null,
      parentTurnId: trace?.parentTurnId ?? null,
      messageId: trace?.messageId ?? null,
      attemptId: trace?.attemptId ?? null,
      modelCallTraceVersion: 1,
      modelExpected,
      status: trace?.status ?? 'complete',
      userId,
      agentId: trace?.agentId ?? null,
      agentName: trace?.agentName ?? null,
      skillCategory: trace?.skillCategory ?? null,
      provider: trace?.provider ?? null,
      model: trace?.model ?? null,
      source: trace?.source ?? null,
      durationMs: Number.isFinite(trace?.durationMs) ? trace.durationMs : null,
      error: trace?.error ? preview(trace.error, 300) : null,
      inputPreview: preview(trace?.input),
      outputPreview: preview(trace?.output),
      attachment: sanitizeDiagnosticValue(trace?.attachment ?? null),
      routing: routingTrace.routing,
      routingTraceComplete: routingTrace.complete,
      modelCalls: modelCallTrace.calls,
      modelSchemaBundles: modelCallTrace.bundles,
      modelCallTraceComplete: modelCallTrace.complete,
      usage: usageTrace.usage,
      usageTotalsComplete: usageTrace.totalsComplete,
      usageCardinalityComplete: usageTrace.cardinalityComplete,
      sizes: sanitizeDiagnosticValue(trace?.sizes ?? null),
      tools: sanitizeTools(trace?.tools),
      meta: sanitizeDiagnosticValue(trace?.meta ?? null),
    };
    const traces = readRaw(userId);
    if (traces.length >= MAX_TRACES) {
      writeRaw(userId, [...traces.slice(-(COMPACT_TO_TRACES - 1)), entry]);
    } else {
      appendRaw(userId, entry);
    }
    return entry;
  } catch (e) {
    console.warn('[run-inspector] record failed:', e.message);
    return null;
  }
}

export function listRunTraces(userId, { limit = 50 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 50, MAX_TRACES));
  return readRaw(userId)
    .slice(-n)
    .reverse()
    .map(t => ({
      id: t.id,
      ts: t.ts,
      status: t.status,
      agentId: t.agentId,
      agentName: t.agentName,
      skillCategory: t.skillCategory,
      provider: t.provider,
      model: t.model,
      source: t.source,
      durationMs: t.durationMs,
      error: t.error,
      inputPreview: t.inputPreview,
      outputPreview: t.outputPreview,
      turnId: t.turnId ?? null,
      rootId: t.rootId ?? null,
      toolCount: t.sizes?.toolCount ?? null,
      modelCallCount: t.modelCalls?.length ?? 0,
      schemaTokEst: (t.modelCalls || []).reduce((sum, call) => sum + (Number(call?.schemaTokEst) || 0), 0),
      inputTokens: t.usage?.inputTokens ?? null,
      outputTokens: t.usage?.outputTokens ?? null,
      requestCount: t.usage?.requestCount ?? null,
      usageTotalsComplete: t.modelCallTraceVersion === 1 && t.usageTotalsComplete === true,
      usageCardinalityComplete: t.modelCallTraceVersion === 1 && t.usageCardinalityComplete === true,
      modelCallTraceVersion: t.modelCallTraceVersion ?? null,
      modelCallTraceComplete: t.modelCallTraceVersion === 1 && t.modelCallTraceComplete === true,
      routingTraceComplete: t.modelCallTraceVersion === 1 && t.routingTraceComplete === true,
      modelExpected: t.modelCallTraceVersion === 1 ? t.modelExpected !== false : null,
      toolsUsed: t.tools?.usedNames ?? [],
      routing: t.routing ? {
        initialSkills: t.routing.initialSkills ?? [],
        addedSkills: t.routing.addedSkills ?? [],
        recoveredMissingTools: Boolean(t.routing.recoveredMissingTools),
      } : null,
    }));
}

export function getRunTrace(userId, id) {
  const trace = readRaw(userId).find(t => t.id === id) ?? null;
  if (!trace) return null;
  if (trace.modelCallTraceVersion !== 1) {
    return {
      ...trace,
      modelCallTraceVersion: trace.modelCallTraceVersion ?? null,
      modelCallTraceComplete: false,
      routingTraceComplete: false,
      modelExpected: null,
    };
  }
  return trace;
}

export function clearRunTraces(userId) {
  try {
    const p = tracesPath(userId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch (e) {
    console.warn('[run-inspector] clear failed:', e.message);
    return false;
  }
}
