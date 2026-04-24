#!/usr/bin/env node
/**
 * Standalone fetcher for the smart-scheduler plan model. Also runs as part of
 * `scripts/fetch-models.mjs` at `npm install`; kept as a separate entrypoint
 * so users can re-pull on demand without rerunning the full postinstall.
 *
 * Downloads the fine-tuned `openensemble-plan-v12` q8_0 GGUF (~140 MB, SmolLM2-135M
 * base + LoRA with four scheduler task-prefix tokens) from the canonical HF repo.
 *
 * Run: `node scripts/fetch-plan-model.mjs`
 * Safe to re-run — skips the download if the file already exists.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(BASE_DIR, 'models');

// Single HF repo holds every version (openensemble-plan-vN.q8_0.gguf). Bump
// MODEL_FILE here + in scheduler/builtin-plan.mjs when promoting a new adapter.
const MODEL_FILE = 'openensemble-plan-v12.q8_0.gguf';
const MODEL_PATH = path.join(MODELS_DIR, MODEL_FILE);
const MODEL_URL =
  `https://huggingface.co/openensemble/plan-gguf/resolve/main/${MODEL_FILE}`;

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
          process.stdout.write(
            `  ${pct}% (${(seen / 1024 / 1024).toFixed(1)} / ${totalMB} MB)\n`,
          );
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

(async () => {
  if (fs.existsSync(MODEL_PATH)) {
    console.log(`[fetch-plan-model] already present at ${MODEL_PATH} — skipping`);
    process.exit(0);
  }
  console.log(`[fetch-plan-model] downloading ${MODEL_FILE} (~140 MB)`);
  console.log(`  from ${MODEL_URL}`);
  try {
    await downloadFile(MODEL_URL, MODEL_PATH);
    console.log(`[fetch-plan-model] done → ${MODEL_PATH}`);
    process.exit(0);
  } catch (e) {
    console.error('[fetch-plan-model] failed:', e.message);
    process.exit(1);
  }
})();
