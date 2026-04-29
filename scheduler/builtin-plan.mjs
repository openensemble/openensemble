/**
 * Smart-scheduler reasoning surface. Text in, text out.
 *
 * Loads the fine-tuned `openensemble-plan-v3` q8_0 GGUF (SmolLM2-135M base
 * + LoRA with task-prefix tokens <parse>, <decide>, <decompose>, <classify>)
 * in its own node-llama-cpp context, fully isolated from the cortex model.
 *
 * Strict isolation: this module must not be imported from `memory/` and it
 * must not call back into cortex. Own model, own context, own serial queue.
 */

import path from 'path';
import fs from 'fs';
import { USERS_DIR } from '../lib/paths.mjs';
import { effectiveCpuCount } from '../lib/cpu-count.mjs';
import { loadConfig } from '../routes/_helpers.mjs';
import { ensureGguf, BUNDLED_PLAN_MODELS, DEFAULT_PLAN_TIER, planFileForTier, tierForPlanFile } from '../lib/model-fetch.mjs';

// The active plan model file is resolved at init time from config —
// `scheduler.builtinPlanModel` may be a bare GGUF filename (one of the
// BUNDLED_PLAN_MODELS) OR a tier alias ('fast' | 'accurate'). Defaults to
// 'accurate' (v22, the current best). Resolved lazily so a user toggling
// the tier in Settings + calling reloadBuiltinPlan() picks up the new
// choice without restarting the server.
const CACHE_DIR = path.join(USERS_DIR, '..', 'models');

function resolvePlanModelFile() {
  const cfg = loadConfig() ?? {};
  const sched = cfg.scheduler ?? {};
  const requested = sched.builtinPlanModel;
  if (requested) {
    if (Object.values(BUNDLED_PLAN_MODELS).includes(requested)) return requested;
    if (BUNDLED_PLAN_MODELS[requested]) return BUNDLED_PLAN_MODELS[requested];
  }
  return planFileForTier(DEFAULT_PLAN_TIER);
}
let MODEL_FILE = resolvePlanModelFile();
let MODEL_PATH = path.join(CACHE_DIR, MODEL_FILE);

// Matches the training context (n_ctx_train=8192 in the GGUF). Running below
// this triggers a "full capacity not utilized" warning from llama.cpp and
// clips long scheduler prompts. KV cache at 8192 ≈ 110 MB for this 135M model.
const CONTEXT_SIZE = 8192;

let _initPromise = null;
let _ready = false;
let _llama = null;
let _model = null;
let _context = null;
let _LlamaCompletion = null;
let _LlamaJsonSchemaGrammar = null;
let _grammarCache = new Map();
let _queue = Promise.resolve();

export async function initBuiltinPlan() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const ok = await ensureGguf(CACHE_DIR, 'plan', MODEL_FILE, {
      logger: (m) => console.log(m),
    });
    if (!ok && !fs.existsSync(MODEL_PATH)) {
      throw new Error(
        `plan model missing at ${MODEL_PATH} and download failed. ` +
          `Run \`node scripts/fetch-plan-model.mjs\` manually.`,
      );
    }
    let mod;
    try {
      mod = await import('node-llama-cpp');
    } catch (e) {
      throw new Error(
        `node-llama-cpp unavailable (${e.message}). ` +
          `Install the native binary for your platform.`,
      );
    }
    const { getLlama, LlamaCompletion, LlamaJsonSchemaGrammar } = mod;
    _LlamaCompletion = LlamaCompletion;
    _LlamaJsonSchemaGrammar = LlamaJsonSchemaGrammar;
    _llama = await getLlama();
    _model = await _llama.loadModel({ modelPath: MODEL_PATH });
    // Cap threads via effectiveCpuCount() — see lib/cpu-count.mjs for why
    // os.cpus().length isn't enough (Docker --cpus, K8s limits, etc.).
    _context = await _model.createContext({
      contextSize: CONTEXT_SIZE,
      threads: effectiveCpuCount(),
    });
    _ready = true;
    return true;
  })();
  return _initPromise;
}

// Training-format system prompt — verbatim from training/plan/train.py:44-49.
// The bundled plan GGUF was fine-tuned with this single generic system across
// all 4 tasks, with the task token (<parse>/<decide>/<decompose>/<classify>)
// prepended to the user message for routing. Sending one of the per-task
// detailed system prompts in TASKS below at inference broke decide/decompose
// reasoning entirely (model returned `defer` for everything) and made parse
// produce malformed JSON (the grammar then masked the rot at decode time).
// See 2026-04-26 audit notes.
const TRAINING_SYSTEM =
  'You are a scheduler reasoning assistant. Given a task-prefix token, ' +
  'parse scheduling requests, decide whether pending tasks should run, ' +
  'break goals into checkpoints, or classify event urgency. ' +
  'Output ONLY valid JSON unless the task explicitly asks for prose.';

// Per-task verbose system prompts — preserved for two reasons: (1) used as the
// system prompt when a non-bundled provider (Ollama with stock Llama, LM Studio)
// is selected — those models need schema hints since they have no task-token
// training; (2) self-documents the expected output shape for each task.
// The bundled cortex path uses TRAINING_SYSTEM above.
const TASKS = {
  parse: {
    system:
      'You convert a user\'s natural-language scheduling request into a JSON task record. ' +
      'Output ONLY a single JSON object. Fields: intent (string, verbatim user ask), ' +
      'schedule ({ mode: "window"|"recurring"|"event", earliest: ISO-8601 or null, ' +
      'latest: ISO-8601 or null, preferred: ISO-8601 or null, recurrence: 5-field ' +
      'cron-format string or null }), conditions (array of short natural-language ' +
      'condition strings, e.g. ["they haven\'t replied", "build is green"]), ' +
      'priority (exactly one of "low"|"normal"|"high" — never "urgent" or "no rush"), ' +
      'target ({ agent: string|null, skill: string|null }). ' +
      'When mode="recurring", recurrence holds the cron-format expression and ' +
      'earliest/latest/preferred are null. When mode="window" or "event", recurrence is null. ' +
      'Use null when a field is not specified. Do not invent details.',
  },
  decide: {
    system:
      'You decide whether each candidate task should run, defer, or cancel right now. ' +
      'You are given the current context and a list of candidates. Output ONLY a JSON ' +
      'array. Each element: { taskId, action: "run"|"defer"|"cancel", reason (short), ' +
      'retryAt: ISO-8601 or null }. Use defer (not cancel) when the task is still ' +
      'wanted but this moment is wrong. Use cancel only when the underlying need is gone.',
  },
  decompose: {
    system:
      'You break a high-level goal into concrete checkpoint tasks with deadlines. ' +
      'Output ONLY a JSON array of 2-6 checkpoints: { label, prompt, schedule: ' +
      '{ earliest, latest, preferred } }. Space checkpoints so the final one lands ' +
      'before the stated deadline. Use ISO-8601 timestamps.',
  },
  classify: {
    system:
      'You classify the urgency of a scheduler event. Output ONLY a JSON object: ' +
      '{ urgency: "urgent"|"normal"|"low", interruptable: boolean, reason (short) }.',
  },
};

// JSON schemas used for grammar-constrained generation. SmolLM2-135M leaks
// across mode/recurrence pairings the training data never showed (mode=
// "recurring" with no cron + populated window fields, etc.) — the grammar
// stops invalid combinations at decode time instead of relying on the model.
// One schema per task; we cache the compiled grammar per task name.
// node-llama-cpp's GBNF generator supports `format: "date-time"` but ignores
// `pattern` — use format for ISO and a plain string for cron (validator coerces).
const SCHEMAS = {
  parse: {
    type: 'object',
    properties: {
      intent: { type: 'string' },
      schedule: {
        oneOf: [
          {
            type: 'object',
            properties: {
              mode: { const: 'window' },
              earliest: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
              latest:   { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
              preferred:{ type: 'string', format: 'date-time' },
              recurrence: { type: 'null' },
            },
            required: ['mode', 'earliest', 'latest', 'preferred', 'recurrence'],
          },
          {
            type: 'object',
            properties: {
              mode: { const: 'recurring' },
              earliest: { type: 'null' },
              latest: { type: 'null' },
              preferred: { type: 'null' },
              recurrence: { type: 'string' },
            },
            required: ['mode', 'earliest', 'latest', 'preferred', 'recurrence'],
          },
          {
            type: 'object',
            properties: {
              mode: { const: 'event' },
              earliest: { type: 'null' },
              latest: { type: 'null' },
              preferred: { type: 'null' },
              recurrence: { type: 'null' },
            },
            required: ['mode', 'earliest', 'latest', 'preferred', 'recurrence'],
          },
        ],
      },
      conditions: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      priority: { enum: ['low', 'normal', 'high'] },
      target: {
        type: 'object',
        properties: {
          agent: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          skill: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        // Only `agent` is required — 94% of training rows omit `skill`. When
        // we previously required both, the model invented arbitrary skill
        // strings just to satisfy the grammar.
        required: ['agent'],
      },
    },
    required: ['intent', 'schedule', 'conditions', 'priority', 'target'],
  },
  classify: {
    type: 'object',
    properties: {
      urgency: { enum: ['urgent', 'normal', 'low'] },
      interruptable: { type: 'boolean' },
      reason: { type: 'string' },
    },
    required: ['urgency', 'interruptable', 'reason'],
  },
};

async function _getGrammar(task) {
  if (!SCHEMAS[task]) return null;
  if (_grammarCache.has(task)) return _grammarCache.get(task);
  if (!_LlamaJsonSchemaGrammar || !_llama) return null;
  try {
    const g = new _LlamaJsonSchemaGrammar(_llama, SCHEMAS[task]);
    _grammarCache.set(task, g);
    return g;
  } catch (e) {
    console.warn(`[plan] could not compile grammar for ${task}:`, e.message);
    return null;
  }
}

// Task tokens added to the SmolLM2 vocab during fine-tuning (see
// training/plan/train.py:37-42). Prepended to the user content so the LoRA
// routes to the correct task head — earlier code stripped these entirely
// at inference, which is why decide/decompose reasoning was broken.
const TASK_TOKENS = {
  parse: '<parse>',
  decide: '<decide>',
  decompose: '<decompose>',
  classify: '<classify>',
};

// Build the ChatML prompt — same template SmolLM2-Instruct was trained on,
// with the task token prepended to user content per training/plan/train.py:59.
function _buildPromptTokens(system, user, task) {
  const taskTok = task && TASK_TOKENS[task] ? `${TASK_TOKENS[task]}\n` : '';
  const text =
    `<|im_start|>system\n${system}<|im_end|>\n` +
    `<|im_start|>user\n${taskTok}${user ?? ''}<|im_end|>\n` +
    `<|im_start|>assistant\n`;
  return _model.tokenize(text, true);
}

/**
 * Generate a scheduler-reasoning completion.
 *
 * @param {{
 *   task: 'parse'|'decide'|'decompose'|'classify',
 *   user: string,
 *   systemOverride?: string|null,
 *   temperature?: number,
 *   maxTokens?: number,
 * }} args
 * @returns {Promise<string|null>} trimmed text, or null on failure
 */
export async function planGenerate({
  task,
  user,
  systemOverride = null,
  temperature = 0.01,
  maxTokens = 512,
} = {}) {
  const preset = TASKS[task];
  if (!preset) throw new Error(`planGenerate: unknown task "${task}"`);

  // Routing: same three tiers as the reason runtime. The planProvider config
  // is written by scheduler/plan-transfer.mjs when the user clicks "Install
  // our model" in Settings → Scheduler Model. Builtin stays the default and
  // covers the no-external-runtime case.
  const cfg = loadConfig();
  const provider = cfg?.scheduler?.planProvider ?? 'builtin';

  if (provider === 'ollama' || provider === 'lmstudio') {
    // Two paths through the same external runtime:
    // 1. Our fine-tuned model (Ollama tag `openensemble-plan:...` or LM Studio
    //    `openensemble/plan-...`) — was trained with the SHORT training-format
    //    system prompt + a task-token prefix on the user message. Sending
    //    `preset.system` (the verbose schema-hint prompt the bundled-cortex
    //    path used to use) produces garbage because the LoRA never saw it.
    // 2. A stock external model the user pointed us at (e.g. ministral, llama,
    //    gemma) — needs the schema-rich `preset.system` since the stock model
    //    has no task-token training.
    const planModel = cfg?.scheduler?.planModel ?? '';
    const isOurModel = /^openensemble-plan:/i.test(planModel) || /^openensemble\/plan-/i.test(planModel);
    if (isOurModel && !systemOverride) {
      const taskToken = TASK_TOKENS[task];
      const userWithToken = taskToken ? `${taskToken}\n${user ?? ''}` : (user ?? '');
      return _generateExternal({ provider, system: TRAINING_SYSTEM, user: userWithToken, temperature, maxTokens, cfg });
    }
    return _generateExternal({ provider, system: systemOverride ?? preset.system, user, temperature, maxTokens, cfg });
  }

  // Bundled GGUF: use the training-format system prompt the LoRA actually
  // saw during fine-tuning, and inject the task token into the user message.
  const system = systemOverride ?? TRAINING_SYSTEM;

  const run = async () => {
    try {
      await initBuiltinPlan();
      const tokens = _buildPromptTokens(system, user, task);
      const grammar = await _getGrammar(task);
      const sequence = _context.getSequence();
      try {
        const completion = new _LlamaCompletion({ contextSequence: sequence });
        const opts = { maxTokens, temperature };
        if (grammar) opts.grammar = grammar;
        const response = await completion.generateCompletion(tokens, opts);
        return typeof response === 'string' ? response.trim() : null;
      } finally {
        if (typeof sequence.dispose === 'function') sequence.dispose();
      }
    } catch (e) {
      console.warn('[plan] generation failed:', e.message);
      return null;
    }
  };

  const result = _queue.then(run);
  _queue = result.catch(() => null);
  return result;
}

// External runtimes (Ollama / LM Studio). Both speak their own flavor of
// the OpenAI chat API — Ollama has /api/chat, LM Studio exposes
// /v1/chat/completions. Model name comes from scheduler.planModel which
// the transfer helper wrote when it published the GGUF.
async function _generateExternal({ provider, system, user, temperature, maxTokens, cfg }) {
  const c = cfg?.cortex ?? {};
  const sched = cfg?.scheduler ?? {};
  const model = sched.planModel;
  const signal = AbortSignal.timeout(20000);

  try {
    if (provider === 'ollama') {
      const base = (c.ollamaLocalUrl ?? '').replace(/\/$/, '').replace(/\/api$/, '');
      if (!base) {
        console.warn('[plan] ollama provider selected but ollamaLocalUrl not configured');
        return null;
      }
      const headers = { 'Content-Type': 'application/json' };
      if (c.ollamaLocalApiKey) headers.Authorization = `Bearer ${c.ollamaLocalApiKey}`;
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({
          model, stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user ?? '' },
          ],
          options: { temperature, num_predict: maxTokens },
        }),
      });
      if (!res.ok) {
        console.warn('[plan] ollama HTTP', res.status);
        return null;
      }
      const data = await res.json();
      return (data?.message?.content ?? '').trim() || null;
    }

    if (provider === 'lmstudio') {
      const base = (c.lmstudioUrl ?? 'http://127.0.0.1:1234').replace(/\/$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (c.lmstudioApiKey) headers.Authorization = `Bearer ${c.lmstudioApiKey}`;
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers, signal,
        body: JSON.stringify({
          model, temperature, stream: false,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user ?? '' },
          ],
        }),
      });
      if (!res.ok) {
        console.warn('[plan] lmstudio HTTP', res.status);
        return null;
      }
      const data = await res.json();
      return (data?.choices?.[0]?.message?.content ?? '').trim() || null;
    }
  } catch (e) {
    console.warn(`[plan] ${provider} generation failed:`, e.message);
    return null;
  }
  return null;
}

export function isBuiltinPlanReady() {
  return _ready;
}

export function getBuiltinPlanModelId() {
  return MODEL_FILE;
}

export function getBuiltinPlanModelPath() {
  return MODEL_PATH;
}

export function getBuiltinPlanTier() {
  return tierForPlanFile(MODEL_FILE);
}

// Tear down the loaded model+context and re-init from the current config
// value. Call after switching scheduler.builtinPlanModel — avoids an OE
// server restart. Rejects if a download is needed and fails.
export async function reloadBuiltinPlan() {
  const targetFile = resolvePlanModelFile();
  if (targetFile === MODEL_FILE && _ready) return { ok: true, model: MODEL_FILE, reloaded: false };
  try {
    if (_context && typeof _context.dispose === 'function') await _context.dispose();
  } catch { /* ignore */ }
  try {
    if (_model && typeof _model.dispose === 'function') await _model.dispose();
  } catch { /* ignore */ }
  _ready = false;
  _initPromise = null;
  _llama = null; _model = null; _context = null;
  _grammarCache = new Map();
  MODEL_FILE = targetFile;
  MODEL_PATH = path.join(CACHE_DIR, MODEL_FILE);
  await initBuiltinPlan();
  return { ok: true, model: MODEL_FILE, reloaded: true };
}

export function planTasks() {
  return Object.keys(TASKS);
}
