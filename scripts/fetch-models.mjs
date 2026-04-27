#!/usr/bin/env node
/**
 * Runs at `npm install` via the postinstall hook. Downloads and caches both
 * bundled models so the server can boot fully offline:
 *
 *   - Embedding: Xenova/nomic-embed-text-v1 (q8 ONNX, 768-dim, ~70 MB)
 *   - Reasoning: openensemble/reason-v1 (q8_0 GGUF, SmolLM2-135M LoRA merge, ~150 MB)
 *
 * The reason model is a specialist fine-tuned by the OpenEnsemble team on the
 * five internal cortex tasks (salience/contradiction/signals/friction/summary).
 * Users never train anything — they download a ready adapter and run it via
 * node-llama-cpp (CPU) or via their own Ollama / LM Studio install.
 *
 * Exits 0 even on network failure so `npm install` doesn't hard-fail in CI
 * or offline environments — the server retries on first startup and prints
 * a loud banner if weights are still missing.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initBuiltinEmbed } from '../memory/builtin-embed.mjs';
import {
  initBuiltinReason,
  getBuiltinReasonModelId,
  getBuiltinReasonModelPath,
} from '../memory/builtin-reason.mjs';
import {
  getBuiltinPlanModelId,
  getBuiltinPlanModelPath,
} from '../scheduler/builtin-plan.mjs';
import { ensureGguf } from '../lib/model-fetch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(BASE_DIR, 'models');

async function fetchEmbed() {
  console.log('[postinstall] Fetching bundled embedding model (nomic-embed-text-v1, q8, ~70 MB)…');
  try {
    const pipe = await initBuiltinEmbed();
    await pipe('search_document: warmup', { pooling: 'mean', normalize: true });
    console.log('[postinstall] Embedding model ready.');
  } catch (e) {
    console.warn('[postinstall] Could not fetch embedding model:', e.message);
    console.warn('[postinstall] The server will retry on first startup.');
  }
}

async function fetchReason() {
  const modelFile = getBuiltinReasonModelId();
  const ok = await ensureGguf(MODELS_DIR, 'reason', modelFile, {
    logger: (m) => console.log(m.replace('[model-fetch]', '[postinstall]')),
  });
  if (!ok) {
    console.warn('[postinstall] The server will retry on first startup.');
    return;
  }
  // Warm the llama.cpp context so the first cortex call at runtime doesn't
  // pay the load cost. Non-fatal — if node-llama-cpp's native binary isn't
  // available on this platform, warming fails but the file is on disk and
  // the user can still route reason through Ollama/LM Studio.
  try {
    await initBuiltinReason();
    console.log('[postinstall] Reasoning model ready.');
  } catch (e) {
    console.warn('[postinstall] Reasoning model on disk but warmup failed:', e.message);
    console.warn('[postinstall] node-llama-cpp may not have a prebuilt for this platform.');
  }
}

async function fetchPlan() {
  const modelFile = getBuiltinPlanModelId();
  const ok = await ensureGguf(MODELS_DIR, 'plan', modelFile, {
    logger: (m) => console.log(m.replace('[model-fetch]', '[postinstall]')),
  });
  if (!ok) console.warn('[postinstall] The server will retry on first startup.');
}

(async () => {
  // Sequence, not parallel — both pulls saturate the link and parallelism
  // just makes the progress output interleave unreadably.
  await fetchEmbed();
  await fetchReason();
  await fetchPlan();
  process.exit(0);
})();
