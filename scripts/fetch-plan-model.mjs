#!/usr/bin/env node
/**
 * Standalone fetcher for the smart-scheduler plan model. Also runs as part of
 * `scripts/fetch-models.mjs` at `npm install`; kept as a separate entrypoint
 * so users can re-pull on demand without rerunning the full postinstall.
 *
 * Downloads the current plan GGUF (filename comes from
 * scheduler/builtin-plan.mjs's MODEL_FILE constant) from the canonical HF
 * repo. Cleans up older versions automatically.
 *
 * Run: `node scripts/fetch-plan-model.mjs`
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { ensureGguf } from '../lib/model-fetch.mjs';
import { getBuiltinPlanModelId } from '../scheduler/builtin-plan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, '..');
const MODELS_DIR = path.join(BASE_DIR, 'models');

(async () => {
  const modelFile = getBuiltinPlanModelId();
  const ok = await ensureGguf(MODELS_DIR, 'plan', modelFile, {
    logger: (m) => console.log(m.replace('[model-fetch]', '[fetch-plan-model]')),
  });
  process.exit(ok ? 0 : 1);
})();
