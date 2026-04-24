/**
 * Bundled embedding model — runs locally in-process via transformers.js +
 * onnxruntime-node. Lets cortex work without requiring the user to install
 * Ollama, LM Studio, or configure a cloud embedder.
 *
 * Model: Xenova/nomic-embed-text-v1 (q8 quantized, 768-dim, ~70MB).
 * 768-dim matches VECTOR_DIM in shared.mjs, so previously-written vectors from
 * the external nomic-embed-text model remain dimensionally compatible.
 */

import os from 'os';
import path from 'path';
import { USERS_DIR } from '../lib/paths.mjs';

const MODEL_ID = 'Xenova/nomic-embed-text-v1';
const CACHE_DIR = path.join(USERS_DIR, '..', 'models');

let _pipelinePromise = null;
let _pipelineReady = false;

export async function initBuiltinEmbed() {
  if (_pipelinePromise) return _pipelinePromise;
  _pipelinePromise = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = CACHE_DIR;
    // Allow local cache hits; don't hit the hub at runtime if weights already
    // downloaded during `npm install`. If cache is missing, transformers.js
    // will still fetch them unless allowRemoteModels is disabled.
    // Explicit thread counts skip onnxruntime's pthread_setaffinity_np call,
    // which is blocked in unprivileged LXC/Docker and spams stderr otherwise.
    const threads = Math.max(1, os.cpus()?.length ?? 1);
    const pipe = await pipeline('feature-extraction', MODEL_ID, {
      dtype: 'q8',
      session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
    });
    _pipelineReady = true;
    return pipe;
  })();
  return _pipelinePromise;
}

export async function builtinEmbed(text) {
  const pipe = await initBuiltinEmbed();
  // nomic-embed-text requires a task prefix; `search_document:` is the right
  // choice for both stored facts and queries (symmetric retrieval works well
  // enough for a personal memory system of this size).
  const prefixed = `search_document: ${text ?? ''}`;
  const output = await pipe(prefixed, { pooling: 'mean', normalize: true });
  // output.data is a Float32Array of length 768 — convert to a plain Array so
  // LanceDB's node binding serializes it cleanly.
  return Array.from(output.data);
}

export function isBuiltinReady() {
  return _pipelineReady;
}
