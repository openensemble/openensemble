/**
 * Install the OpenEnsemble-fine-tuned scheduler GGUF (openensemble-plan-v3)
 * into the user's external Ollama or LM Studio runtime. Same shape as
 * memory/reason-transfer.mjs — kept separate so cortex and scheduler stay
 * strictly isolated (see builtin-plan.mjs header).
 *
 * Same constraint: only our GGUF can serve the plan tasks because the
 * adapter was trained with task-prefix tokens (<parse>, <decide>,
 * <decompose>, <classify>). Installing any other model under these tags
 * would return garbage, so the install helpers always write *our* GGUF
 * under a fixed, versioned name.
 *
 * We reuse cortex.ollamaLocalUrl / cortex.ollamaLocalApiKey intentionally:
 * the user has a single local Ollama daemon; forcing them to configure it
 * twice would be user-hostile. Only the model *tag* differs.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getBuiltinPlanModelPath, getBuiltinPlanModelId } from './builtin-plan.mjs';
import { modifyConfig, loadConfig } from '../routes/_helpers.mjs';

// Derive a size-prefixed version suffix from the active GGUF file name so
// the Ollama tag / LM Studio dir match the bytes being pushed AND the two
// tiers (135M v5 and 360M v1) don't collide on the same name. Examples:
//   openensemble-plan-v5.q8_0.gguf        → "135-v5"
//   openensemble-plan-360m-v1.q8_0.gguf   → "360-v1"
// Computed per-call instead of cached at module load so a runtime tier
// switch (Settings → Plan model) is reflected on the next install push.
function _planTagSuffix() {
  const id = getBuiltinPlanModelId();
  const m360 = id.match(/-360m-v(\d+)\.q\d/i);
  if (m360) return `360-v${m360[1]}`;
  const m135 = id.match(/-v(\d+)\.q\d/i);
  if (m135) return `135-v${m135[1]}`;
  return 'v0';
}
export const LMSTUDIO_PUBLISHER = 'openensemble';
export function getOllamaModelTag() { return `openensemble-plan:${_planTagSuffix()}`; }
export function getLmstudioModelDir() { return `plan-${_planTagSuffix()}`; }
// Back-compat constants — frozen to whatever tier is active at module load.
// New code should call the getters above so a runtime tier swap is reflected.
export const OLLAMA_MODEL_TAG   = getOllamaModelTag();
export const LMSTUDIO_MODEL_DIR = getLmstudioModelDir();

function ollamaLocalBase() {
  const cfg = loadConfig();
  const raw = cfg?.cortex?.ollamaLocalUrl ?? '';
  if (!raw) return null;
  return raw.replace(/\/$/, '').replace(/\/api$/, '');
}

function ollamaLocalAuthHeaders() {
  const cfg = loadConfig();
  const key = cfg?.cortex?.ollamaLocalApiKey ?? null;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// Modelfile template+params for the new-API shape (Ollama ≥ 0.6).
// Same ChatML template as reason — both are SmolLM2-Instruct derivatives.
const OLLAMA_TEMPLATE = '<|im_start|>system\n{{ .System }}<|im_end|>\n<|im_start|>user\n{{ .Prompt }}<|im_end|>\n<|im_start|>assistant\n';
const OLLAMA_PARAMS = {
  stop: ['<|im_end|>', '<|im_start|>'],
  temperature: 0.01,
  top_p: 0.1,
  top_k: 1,
};

// Upload a GGUF as an Ollama blob. Computes the file's SHA-256, streams the
// bytes to /api/blobs/sha256:<digest>, and returns the `sha256:<digest>`
// string for use in /api/create's `files` field. Idempotent — if Ollama
// already has the blob, the POST is fast and still returns 201.
async function _uploadBlobToOllama(base, ggufPath) {
  const { createHash } = await import('crypto');
  const { Readable } = await import('stream');
  // Compute the digest first — Ollama wants it in the URL.
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(ggufPath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject);
  });
  const digest = `sha256:${hash.digest('hex')}`;
  const stat = fs.statSync(ggufPath);
  // Node 18+'s fetch doesn't accept Node Readable directly — wrap with
  // Readable.toWeb to get a WHATWG ReadableStream.
  const stream = Readable.toWeb(fs.createReadStream(ggufPath));
  const res = await fetch(`${base}/api/blobs/${digest}`, {
    method: 'POST',
    headers: { 'Content-Length': String(stat.size), ...ollamaLocalAuthHeaders() },
    body: stream,
    duplex: 'half',
    signal: AbortSignal.timeout(300000),
  });
  // 201 = uploaded fresh, 200 = already exists. Both are success.
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return digest;
}

export async function isOllamaReachable() {
  const base = ollamaLocalBase();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/tags`, {
      headers: ollamaLocalAuthHeaders(),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch { return false; }
}

export async function installIntoOllama() {
  const modelPath = getBuiltinPlanModelPath();
  if (!fs.existsSync(modelPath)) {
    return { ok: false, error: `GGUF not found at ${modelPath}. Run \`node scripts/fetch-plan-model.mjs\` to download it.` };
  }
  const base = ollamaLocalBase();
  if (!base) {
    return {
      ok: false,
      error:
        'Local Ollama is not configured. Install Ollama (https://ollama.com/download), then set its URL under ' +
        'Settings → Providers → "Ollama (local)" and retry.',
    };
  }
  if (!(await isOllamaReachable())) {
    return { ok: false, error: `Local Ollama is not reachable at ${base}. Make sure the daemon is running.` };
  }

  const tag = getOllamaModelTag();
  // Modern Ollama API (≥0.6) deprecates the `modelfile` string field —
  // /api/create now wants either `from: <existing model name>` or
  // `files: { name: "sha256:<hash>" }`. For a local GGUF the only path
  // that works is: upload the blob, then reference it by digest.
  let digest;
  try {
    digest = await _uploadBlobToOllama(base, modelPath);
  } catch (e) {
    return { ok: false, error: `Ollama blob upload failed: ${e.message}` };
  }
  const fileName = path.basename(modelPath);
  try {
    const res = await fetch(`${base}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ollamaLocalAuthHeaders() },
      body: JSON.stringify({
        model: tag,
        files: { [fileName]: digest },
        template: OLLAMA_TEMPLATE,
        parameters: OLLAMA_PARAMS,
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Ollama /api/create HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    await modifyConfig(x => {
      x.scheduler = x.scheduler ?? {};
      if (x.scheduler.planProvider && x.scheduler.planProvider !== 'ollama') {
        x.scheduler._previousPlanProvider = x.scheduler.planProvider;
      }
      x.scheduler.planProvider = 'ollama';
      x.scheduler.planModel = tag;
    });
    return { ok: true, tag };
  } catch (e) {
    return { ok: false, error: `Ollama create failed: ${e.message}` };
  }
}

function lmstudioModelRoot() {
  const newPath = path.join(os.homedir(), '.lmstudio', 'models');
  const oldPath = path.join(os.homedir(), '.cache', 'lm-studio', 'models');
  if (fs.existsSync(newPath)) return newPath;
  if (fs.existsSync(oldPath)) return oldPath;
  return newPath;
}

export function isLmstudioInstalled() {
  return fs.existsSync(path.join(os.homedir(), '.lmstudio', 'models'))
      || fs.existsSync(path.join(os.homedir(), '.cache', 'lm-studio', 'models'));
}

export async function installIntoLmstudio() {
  const modelPath = getBuiltinPlanModelPath();
  const modelFile = getBuiltinPlanModelId();
  if (!fs.existsSync(modelPath)) {
    return { ok: false, error: `GGUF not found at ${modelPath}. Run \`node scripts/fetch-plan-model.mjs\` to download it.` };
  }
  const root = lmstudioModelRoot();
  const dirName = getLmstudioModelDir();
  const destDir = path.join(root, LMSTUDIO_PUBLISHER, dirName);
  const destFile = path.join(destDir, modelFile);

  try {
    fs.mkdirSync(destDir, { recursive: true });
    if (!fs.existsSync(destFile)) {
      try { fs.linkSync(modelPath, destFile); }
      catch { fs.copyFileSync(modelPath, destFile); }
    }
    const modelId = `${LMSTUDIO_PUBLISHER}/${dirName}`;
    await modifyConfig(x => {
      x.scheduler = x.scheduler ?? {};
      if (x.scheduler.planProvider && x.scheduler.planProvider !== 'lmstudio') {
        x.scheduler._previousPlanProvider = x.scheduler.planProvider;
      }
      x.scheduler.planProvider = 'lmstudio';
      x.scheduler.planModel = modelId;
    });
    return { ok: true, modelId, path: destFile };
  } catch (e) {
    return { ok: false, error: `LM Studio install failed: ${e.message}` };
  }
}

export async function getPlanRuntimeStatus() {
  const cfg = loadConfig();
  const modelPath = getBuiltinPlanModelPath();
  // Lazy-import to avoid a circular dep at module load. plan-transfer is
  // imported by builtin-plan via routes/plan-runtime; importing the other
  // direction at top-level deadlocks the ESM evaluation.
  const { BUNDLED_PLAN_MODELS, tierForPlanFile } = await import('../lib/model-fetch.mjs');
  const modelsDir = path.dirname(modelPath);
  const tiers = Object.fromEntries(
    Object.entries(BUNDLED_PLAN_MODELS).map(([tier, file]) => {
      const p = path.join(modelsDir, file);
      const present = fs.existsSync(p);
      const sizeMb = present ? Math.round(fs.statSync(p).size / 1024 / 1024) : null;
      return [tier, { file, present, sizeMb }];
    }),
  );
  return {
    current: cfg?.scheduler?.planProvider ?? 'builtin',
    builtin: {
      ggufPresent: fs.existsSync(modelPath),
      modelFile: getBuiltinPlanModelId(),
      path: modelPath,
      tier: tierForPlanFile(getBuiltinPlanModelId()),
      tiers,
    },
    ollama: {
      reachable: await isOllamaReachable(),
      baseUrl: ollamaLocalBase(),
      tag: getOllamaModelTag(),
      localConfigured: !!ollamaLocalBase(),
    },
    lmstudio: {
      installed: isLmstudioInstalled(),
      modelRoot: lmstudioModelRoot(),
      modelId: `${LMSTUDIO_PUBLISHER}/${getLmstudioModelDir()}`,
    },
  };
}
