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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(BASE_DIR, 'models');

// Canonical publish location for the fine-tuned GGUF. `resolve/main/<file>` is
// HuggingFace's direct-download URL that follows LFS redirects transparently.
const REASON_HF_REPO = 'openensemble/reason-v1-gguf';
const REASON_BASE_URL = `https://huggingface.co/${REASON_HF_REPO}/resolve/main`;
const PLAN_HF_REPO = 'openensemble/plan-gguf';
const PLAN_BASE_URL = `https://huggingface.co/${PLAN_HF_REPO}/resolve/main`;

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

// Streaming download with a single follow for the LFS redirect. Writes to a
// .part file and renames on success so a killed install doesn't leave a
// half-downloaded GGUF that the runtime would try to load.
async function downloadFile(url, dest) {
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);

  const total = Number(res.headers.get('content-length')) || 0;
  const totalMB = total ? (total / 1024 / 1024).toFixed(1) : '?';
  let seen = 0;
  let lastPct = -1;

  const out = fs.createWriteStream(tmp);
  try {
    for await (const chunk of res.body) {
      out.write(chunk);
      seen += chunk.length;
      if (total) {
        const pct = Math.floor((seen / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          process.stdout.write(`[postinstall]   ${pct}% (${(seen / 1024 / 1024).toFixed(1)} / ${totalMB} MB)\n`);
          lastPct = pct;
        }
      }
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { out.destroy(); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

async function fetchReason() {
  const modelFile = getBuiltinReasonModelId();           // openensemble-reason-v1.q8_0.gguf
  const modelPath = getBuiltinReasonModelPath();         // <install>/models/<modelFile>

  if (fs.existsSync(modelPath)) {
    console.log(`[postinstall] Reasoning model already present at ${modelPath} — skipping download.`);
  } else {
    const url = `${REASON_BASE_URL}/${modelFile}`;
    console.log(`[postinstall] Fetching bundled reasoning model (${modelFile}, ~150 MB)…`);
    console.log(`[postinstall]   from ${url}`);
    try {
      await downloadFile(url, modelPath);
      console.log(`[postinstall] Reasoning model → ${modelPath}`);
    } catch (e) {
      console.warn('[postinstall] Could not fetch reasoning model:', e.message);
      console.warn('[postinstall] The server will retry on first startup.');
      return;
    }
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
  const modelFile = getBuiltinPlanModelId();           // openensemble-plan-v3.q8_0.gguf
  const modelPath = getBuiltinPlanModelPath();         // <install>/models/<modelFile>

  if (fs.existsSync(modelPath)) {
    console.log(`[postinstall] Plan model already present at ${modelPath} — skipping download.`);
    return;
  }
  const url = `${PLAN_BASE_URL}/${modelFile}`;
  console.log(`[postinstall] Fetching bundled plan model (${modelFile}, ~140 MB)…`);
  console.log(`[postinstall]   from ${url}`);
  try {
    await downloadFile(url, modelPath);
    console.log(`[postinstall] Plan model → ${modelPath}`);
  } catch (e) {
    console.warn('[postinstall] Could not fetch plan model:', e.message);
    console.warn('[postinstall] The server will retry on first startup.');
  }
}

(async () => {
  // Sequence, not parallel — both pulls saturate the link and parallelism
  // just makes the progress output interleave unreadably.
  await fetchEmbed();
  await fetchReason();
  await fetchPlan();
  process.exit(0);
})();
