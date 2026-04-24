/**
 * Install the OpenEnsemble-fine-tuned scheduler GGUF (openensemble-plan-v12)
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

export const OLLAMA_MODEL_TAG   = 'openensemble-plan:v12';
export const LMSTUDIO_PUBLISHER = 'openensemble';
export const LMSTUDIO_MODEL_DIR = 'plan-v12';

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

// Same ChatML template as reason — both are SmolLM2-Instruct derivatives.
function buildModelfile(ggufPath) {
  return [
    `FROM ${ggufPath}`,
    '',
    'TEMPLATE """<|im_start|>system',
    '{{ .System }}<|im_end|>',
    '<|im_start|>user',
    '{{ .Prompt }}<|im_end|>',
    '<|im_start|>assistant',
    '"""',
    '',
    'PARAMETER stop "<|im_end|>"',
    'PARAMETER stop "<|im_start|>"',
    'PARAMETER temperature 0.01',
    'PARAMETER top_p 0.1',
    'PARAMETER top_k 1',
    '',
  ].join('\n');
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

  const modelfile = buildModelfile(modelPath);
  try {
    const res = await fetch(`${base}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ollamaLocalAuthHeaders() },
      body: JSON.stringify({ name: OLLAMA_MODEL_TAG, modelfile, stream: false }),
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
      x.scheduler.planModel = OLLAMA_MODEL_TAG;
    });
    return { ok: true, tag: OLLAMA_MODEL_TAG };
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
  const destDir = path.join(root, LMSTUDIO_PUBLISHER, LMSTUDIO_MODEL_DIR);
  const destFile = path.join(destDir, modelFile);

  try {
    fs.mkdirSync(destDir, { recursive: true });
    if (!fs.existsSync(destFile)) {
      try { fs.linkSync(modelPath, destFile); }
      catch { fs.copyFileSync(modelPath, destFile); }
    }
    const modelId = `${LMSTUDIO_PUBLISHER}/${LMSTUDIO_MODEL_DIR}`;
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
  return {
    current: cfg?.scheduler?.planProvider ?? 'builtin',
    builtin: {
      ggufPresent: fs.existsSync(modelPath),
      modelFile: getBuiltinPlanModelId(),
      path: modelPath,
    },
    ollama: {
      reachable: await isOllamaReachable(),
      baseUrl: ollamaLocalBase(),
      tag: OLLAMA_MODEL_TAG,
      localConfigured: !!ollamaLocalBase(),
    },
    lmstudio: {
      installed: isLmstudioInstalled(),
      modelRoot: lmstudioModelRoot(),
      modelId: `${LMSTUDIO_PUBLISHER}/${LMSTUDIO_MODEL_DIR}`,
    },
  };
}
