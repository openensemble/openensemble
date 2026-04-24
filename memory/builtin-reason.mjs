/**
 * Bundled reasoning model — runs locally in-process via node-llama-cpp (GGUF).
 *
 * Mirrors builtin-embed.mjs in purpose but uses llama.cpp instead of ONNX:
 * autoregressive decode on CPU via ONNX is 3-5× slower than llama.cpp on the
 * same hardware, which matters for a 135M multi-task fine-tune we expect to
 * run on a Raspberry Pi.
 *
 * Serves the five internal cortex helpers — salience, contradiction, signals,
 * friction, session summary — via a task-prefix routing scheme the adapter
 * was trained on (<salience>, <contradiction>, ...).
 *
 * Concurrency: llama.cpp processes one sequence at a time per context. We
 * load one context and serialize generate() calls through a promise chain.
 * The 5 cortex tasks that fire per chat turn are already queued
 * (memory/memory.mjs splits critical-path vs background enrichment), so
 * serial execution here matches the existing pipeline.
 *
 * Why pre-tokenize instead of using LlamaChatSession: the adapter added five
 * task-prefix tokens (<salience>, etc.) to the vocabulary during training.
 * LlamaChatSession tokenizes the user text with special-token parsing OFF by
 * default — so "<friction> …" gets split into ["<", "fr", "iction", ">", …]
 * and the model never sees the task-prefix token it was trained on. We build
 * the ChatML prompt manually and tokenize with specialTokens=true so the
 * single 49155 token lands in the context the same way it did in training.
 *
 * Hardware target: Raspberry Pi 4/5 (ARM64, 4-8 GB RAM, no GPU). The q8 GGUF
 * is ~140 MB on disk; working set during inference peaks near 250 MB.
 */

import path from 'path';
import fs from 'fs';
import { USERS_DIR } from '../lib/paths.mjs';
import { effectiveCpuCount } from '../lib/cpu-count.mjs';

// Task tokens added to the SmolLM2 vocab during training (see training/train.py).
// Prepended to the user content so the multi-task adapter routes to the right
// head. Must match the training format exactly — do not reformat casing/spacing.
const TASK_TOKENS = {
  salience: '<salience>',
  contradiction: '<contradiction>',
  signals: '<signals>',
  friction: '<friction>',
  summary: '<summary>',
};

// Keep identical to training/train.py system prompt; changing this at inference
// time nudges the model off-distribution.
const DEFAULT_SYSTEM =
  'You are a memory assistant. Output JSON only unless asked for prose.';

const MODEL_FILE = 'openensemble-reason-v1.q8_0.gguf';
const CACHE_DIR = path.join(USERS_DIR, '..', 'models');
const MODEL_PATH = path.join(CACHE_DIR, MODEL_FILE);

const CONTEXT_SIZE = 2048;

let _initPromise = null;
let _ready = false;
let _llama = null;
let _model = null;
let _context = null;
let _LlamaCompletion = null;
// Serial queue — llama.cpp one sequence at a time per context. New work
// appends to this promise; result<n> awaits result<n-1>.
let _queue = Promise.resolve();

export async function initBuiltinReason() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    if (!fs.existsSync(MODEL_PATH)) {
      throw new Error(
        `reason model missing at ${MODEL_PATH}. ` +
          `Run \`node scripts/fetch-models.mjs\` or set reasonProvider to ollama/lmstudio.`,
      );
    }
    let mod;
    try {
      mod = await import('node-llama-cpp');
    } catch (e) {
      throw new Error(
        `node-llama-cpp unavailable (${e.message}). ` +
          `Install the native binary for your platform or pick a different reasonProvider.`,
      );
    }
    const { getLlama, LlamaCompletion } = mod;
    _LlamaCompletion = LlamaCompletion;
    _llama = await getLlama();
    _model = await _llama.loadModel({ modelPath: MODEL_PATH });
    // See lib/cpu-count.mjs — node-llama-cpp defaults to the host's physical
    // core count via CPUID, which oversubscribes any container/VM with a CPU
    // limit and thrashes (400x slowdown observed). effectiveCpuCount()
    // respects cgroup v1/v2 quotas, sched_getaffinity, and lxcfs-filtered
    // /proc/cpuinfo, so the same binary behaves correctly on bare metal, VMs,
    // LXC, and Docker/K8s regardless of how the operator capped CPU.
    _context = await _model.createContext({
      contextSize: CONTEXT_SIZE,
      threads: effectiveCpuCount(),
    });
    _ready = true;
    return true;
  })();
  return _initPromise;
}

// Build the ChatML-format prompt identical to what the adapter was trained on
// (matches tokenizer.apply_chat_template with add_generation_prompt=True). We
// then pre-tokenize with specialTokens=true so <|im_start|>/<|im_end|> and the
// task prefix token resolve to their single vocabulary IDs.
function _buildPromptTokens(system, user, task) {
  const prefix = task && TASK_TOKENS[task] ? `${TASK_TOKENS[task]} ` : '';
  const sys = system ?? DEFAULT_SYSTEM;
  const text =
    `<|im_start|>system\n${sys}<|im_end|>\n` +
    `<|im_start|>user\n${prefix}${user ?? ''}<|im_end|>\n` +
    `<|im_start|>assistant\n`;
  return _model.tokenize(text, true);
}

/**
 * Generate a chat-style completion. Mirrors the provider abstraction used in
 * memory/shared.mjs `_chatCall()` so the caller just sees text in, text out.
 *
 * @param {{
 *   system?: string|null,
 *   user: string,
 *   temperature?: number,
 *   maxTokens?: number,
 *   task?: 'salience'|'contradiction'|'signals'|'friction'|'summary'|null,
 * }} args
 * @returns {Promise<string|null>} trimmed text, or null on failure
 */
export async function builtinGenerate({
  system,
  user,
  temperature = 0.01,
  maxTokens = 256,
  task = null,
} = {}) {
  const run = async () => {
    try {
      await initBuiltinReason();

      const tokens = _buildPromptTokens(system, user, task);
      const sequence = _context.getSequence();
      try {
        const completion = new _LlamaCompletion({ contextSequence: sequence });
        const response = await completion.generateCompletion(tokens, {
          maxTokens,
          // Training was greedy (do_sample=False); 0 keeps that. Non-zero
          // only used by callers that want sampling variety for summaries.
          temperature,
        });
        return typeof response === 'string' ? response.trim() : null;
      } finally {
        if (typeof sequence.dispose === 'function') sequence.dispose();
      }
    } catch (e) {
      console.warn('[cortex] Builtin reason generation failed:', e.message);
      return null;
    }
  };

  const result = _queue.then(run);
  // Swallow this result's rejection at the queue level so one failure doesn't
  // poison subsequent calls; individual callers still see the rejection.
  _queue = result.catch(() => null);
  return result;
}

export function isBuiltinReasonReady() {
  return _ready;
}

export function getBuiltinReasonModelId() {
  return MODEL_FILE;
}

export function getBuiltinReasonModelPath() {
  return MODEL_PATH;
}

export function builtinReasonTaskTokens() {
  return { ...TASK_TOKENS };
}
