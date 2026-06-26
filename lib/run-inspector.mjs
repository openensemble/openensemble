import fs from 'fs';
import path from 'path';
import { USERS_DIR } from './paths.mjs';
import { isSensitiveArgName } from './learning-safety.mjs';

const MAX_TRACES = 200;
const PREVIEW_LIMIT = 500;

function tracesPath(userId) {
  return path.join(USERS_DIR, userId, 'run-inspector.jsonl');
}

function preview(value, limit = PREVIEW_LIMIT) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
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
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, traces.slice(-MAX_TRACES).map(t => JSON.stringify(t)).join('\n') + '\n');
}

export function recordRunTrace(userId, trace) {
  if (!userId || userId === 'default') return null;
  try {
    const now = Date.now();
    const id = `run_${now}_${safeIdPart(trace?.agentId)}_${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      id,
      ts: now,
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
      attachment: trace?.attachment ?? null,
      routing: trace?.routing ?? null,
      sizes: trace?.sizes ?? null,
      tools: trace?.tools ?? null,
      meta: trace?.meta ?? null,
    };
    const traces = readRaw(userId);
    traces.push(entry);
    writeRaw(userId, traces);
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
      toolCount: t.sizes?.toolCount ?? null,
      toolsUsed: t.tools?.usedNames ?? [],
      routing: t.routing ? {
        initialSkills: t.routing.initialSkills ?? [],
        addedSkills: t.routing.addedSkills ?? [],
        recoveredMissingTools: Boolean(t.routing.recoveredMissingTools),
      } : null,
    }));
}

export function getRunTrace(userId, id) {
  return readRaw(userId).find(t => t.id === id) ?? null;
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
