/**
 * Install the OpenEnsemble-fine-tuned reasoning GGUF into the user's
 * external Ollama or LM Studio runtime. The built-in llama.cpp tier runs
 * our model directly; these helpers exist for users with a dedicated GPU
 * who already run one of those front-ends and want the memory lane to use
 * their GPU instead of the CPU path.
 *
 * Important: we do NOT let users swap in any other model for the memory
 * lane. The cortex tasks were trained on this specific adapter with
 * task-prefix tokens — a different 7B would produce garbage. These helpers
 * therefore always install *our* GGUF under a fixed, versioned name and
 * the config flip uses that name verbatim.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getBuiltinReasonModelPath, getBuiltinReasonModelId } from './builtin-reason.mjs';
import { modifyConfig, loadConfig } from '../routes/_helpers.mjs';

// Derive the version suffix from the active GGUF file name so the destination
// tag/dir match the bytes being pushed. Was hardcoded "v1" while the bundled
// MODEL_FILE was actually v3 — installed model showed up as "reason-v1" in
// LM Studio even though the bytes were v3.
function _modelVersion() {
  const id = getBuiltinReasonModelId();           // e.g. "openensemble-reason-v3.q8_0.gguf"
  const m = id.match(/-v(\d+)\.q\d/i);
  return m ? `v${m[1]}` : 'v0';
}
const _REASON_VERSION = _modelVersion();
export const OLLAMA_MODEL_TAG   = `openensemble-reason:${_REASON_VERSION}`;
export const LMSTUDIO_PUBLISHER = 'openensemble';
export const LMSTUDIO_MODEL_DIR = `reason-${_REASON_VERSION}`;

// Memory-lane install targets the *local* Ollama, not the cloud one — cloud
// (ollama.com) refuses /api/create for custom GGUFs. Configured separately
// in Settings → Providers → "Ollama (local)" and stored at
// cortex.ollamaLocalUrl / cortex.ollamaLocalApiKey.
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

// Minimal Modelfile. We set the chat template to match the SmolLM2-Instruct
// format the adapter was trained on and pin the stop tokens so Ollama doesn't
// over-generate past JSON close-braces. Stop tokens come from the SmolLM2
// tokenizer's end-of-turn markers.
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

/**
 * Install our GGUF into the user's Ollama via its REST /api/create endpoint.
 * Uses `files` payload (a map of sha256 → local path) which Ollama reads
 * directly from disk — avoids uploading the 150 MB blob over HTTP.
 *
 * Returns { ok, tag, error? }.
 */
export async function installIntoOllama() {
  const modelPath = getBuiltinReasonModelPath();
  if (!fs.existsSync(modelPath)) {
    return { ok: false, error: `GGUF not found at ${modelPath}. Run \`npm install\` to fetch it.` };
  }
  const base = ollamaLocalBase();
  if (!base) {
    return {
      ok: false,
      error:
        'Local Ollama is not configured. Install Ollama (https://ollama.com/download), then set its URL under ' +
        'Settings → Providers → "Ollama (local)" (e.g. http://localhost:11434) and retry.',
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
      body: JSON.stringify({
        name: OLLAMA_MODEL_TAG,
        modelfile,
        // stream: false so we get a single JSON response instead of NDJSON.
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Ollama /api/create HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    // Flip cortex config to point reason at this tag. User can still revert
    // by editing config.json — we stash the previous value.
    await modifyConfig(x => {
      x.cortex = x.cortex ?? {};
      if (x.cortex.reasonProvider && x.cortex.reasonProvider !== 'ollama') {
        x.cortex._previousReasonProvider = x.cortex.reasonProvider;
      }
      x.cortex.reasonProvider = 'ollama';
      x.cortex.reasonModel = OLLAMA_MODEL_TAG;
    });
    return { ok: true, tag: OLLAMA_MODEL_TAG };
  } catch (e) {
    return { ok: false, error: `Ollama create failed: ${e.message}` };
  }
}

function lmstudioModelRoot() {
  // LM Studio 0.3+ uses ~/.lmstudio/models; older versions used ~/.cache/lm-studio/models.
  // Prefer the new path; fall back to the old if only the old dir exists.
  const newPath = path.join(os.homedir(), '.lmstudio', 'models');
  const oldPath = path.join(os.homedir(), '.cache', 'lm-studio', 'models');
  if (fs.existsSync(newPath)) return newPath;
  if (fs.existsSync(oldPath)) return oldPath;
  return newPath; // will be created
}

export function isLmstudioInstalled() {
  return fs.existsSync(path.join(os.homedir(), '.lmstudio', 'models'))
      || fs.existsSync(path.join(os.homedir(), '.cache', 'lm-studio', 'models'));
}

/**
 * Copy our GGUF into LM Studio's model tree so it appears in the UI and
 * is loadable via its OpenAI-compat endpoint. LM Studio auto-detects GGUFs
 * dropped under ~/.lmstudio/models/<publisher>/<model>/.
 *
 * We hardlink when possible (same filesystem) to avoid burning another
 * 150 MB of disk; fall back to copy if hardlinking fails (cross-device).
 *
 * Returns { ok, modelId, path, error? }.
 */
export async function installIntoLmstudio() {
  const modelPath = getBuiltinReasonModelPath();
  const modelFile = getBuiltinReasonModelId();
  if (!fs.existsSync(modelPath)) {
    return { ok: false, error: `GGUF not found at ${modelPath}. Run \`npm install\` to fetch it.` };
  }
  const root = lmstudioModelRoot();
  const destDir = path.join(root, LMSTUDIO_PUBLISHER, LMSTUDIO_MODEL_DIR);
  const destFile = path.join(destDir, modelFile);

  try {
    fs.mkdirSync(destDir, { recursive: true });
    if (!fs.existsSync(destFile)) {
      try {
        fs.linkSync(modelPath, destFile);
      } catch {
        fs.copyFileSync(modelPath, destFile);
      }
    }
    const modelId = `${LMSTUDIO_PUBLISHER}/${LMSTUDIO_MODEL_DIR}`;
    await modifyConfig(x => {
      x.cortex = x.cortex ?? {};
      if (x.cortex.reasonProvider && x.cortex.reasonProvider !== 'lmstudio') {
        x.cortex._previousReasonProvider = x.cortex.reasonProvider;
      }
      x.cortex.reasonProvider = 'lmstudio';
      x.cortex.reasonModel = modelId;
    });
    return { ok: true, modelId, path: destFile };
  } catch (e) {
    return { ok: false, error: `LM Studio install failed: ${e.message}` };
  }
}

/** Status of all three memory-lane tiers. Used by the UI to render toggles. */
export async function getReasonRuntimeStatus() {
  const cfg = loadConfig();
  const modelPath = getBuiltinReasonModelPath();
  return {
    current: cfg?.cortex?.reasonProvider ?? 'auto',
    builtin: {
      ggufPresent: fs.existsSync(modelPath),
      modelFile: getBuiltinReasonModelId(),
      path: modelPath,
    },
    ollama: {
      // Reachability here reflects the *local* Ollama — the cloud endpoint
      // can't host custom GGUFs, so the memory-lane install flow only cares
      // about the local daemon.
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
