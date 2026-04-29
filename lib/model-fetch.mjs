import fs from 'fs';
import path from 'path';

// Both repos use the same flat layout: <file> at /resolve/main/<file>.
export const REASON_HF_REPO = 'openensemble/reason-gguf';
export const PLAN_HF_REPO   = 'openensemble/plan-gguf';

// Bundled plan model tiers — both available for user pick. cleanupOldGgufs
// preserves all of these (so switching tiers at runtime doesn't require a
// re-download). The active tier comes from config.scheduler.builtinPlanModel
// (defaulting to 'accurate'). Update this list when a new tier ships.
export const BUNDLED_PLAN_MODELS = {
  fast:     'openensemble-plan-v5.q8_0.gguf',          // SmolLM2-135M, ~140 MB, ~88.5% smoke. Lower latency, lower RAM. (Best 135M release.)
  accurate: 'openensemble-plan-360m-v1.q8_0.gguf',     // SmolLM2-360M, ~370 MB, 95.6% smoke / 87.5% holdout. First 360M release.
};
export const DEFAULT_PLAN_TIER = 'accurate';
export function planFileForTier(tier) {
  return BUNDLED_PLAN_MODELS[tier] || BUNDLED_PLAN_MODELS[DEFAULT_PLAN_TIER];
}
export function tierForPlanFile(file) {
  for (const [tier, f] of Object.entries(BUNDLED_PLAN_MODELS)) if (f === file) return tier;
  return null;
}

const REASON_BASE_URL = `https://huggingface.co/${REASON_HF_REPO}/resolve/main`;
const PLAN_BASE_URL   = `https://huggingface.co/${PLAN_HF_REPO}/resolve/main`;

/**
 * Streaming download with a single LFS redirect follow. Writes to a .part
 * file and renames on success so a killed download doesn't leave a
 * half-written GGUF that the runtime would try to load.
 */
export async function downloadFile(url, dest, { onProgress } = {}) {
  const tmp = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);

  const total = Number(res.headers.get('content-length')) || 0;
  let seen = 0;
  let lastPct = -1;

  const out = fs.createWriteStream(tmp);
  try {
    for await (const chunk of res.body) {
      out.write(chunk);
      seen += chunk.length;
      if (total && onProgress) {
        const pct = Math.floor((seen / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          onProgress({ pct, seen, total });
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

/**
 * Delete stale GGUFs of the given family that don't match the current name.
 * E.g. once openensemble-reason-v3.q8_0.gguf is installed, drop v1, v2, etc.
 *
 * @param {string} modelsDir - absolute path to the install's models/ folder
 * @param {'reason'|'plan'} family
 * @param {string} keepFile - the bare filename to keep (e.g. "openensemble-reason-v3.q8_0.gguf")
 * @returns {string[]} list of removed filenames
 */
export function cleanupOldGgufs(modelsDir, family, keepFile) {
  const removed = [];
  if (!fs.existsSync(modelsDir)) return removed;
  const re = new RegExp(`^openensemble-${family}-(v[\\w.\\-]+|360m-v[\\w.\\-]+)\\.q\\d+_\\w+\\.gguf$`);
  // For plan: preserve every bundled tier so switching tiers at runtime
  // doesn't require a re-download. `keepFile` may be a single string or
  // an array.
  const keepSet = new Set(Array.isArray(keepFile) ? keepFile : [keepFile]);
  if (family === 'plan') {
    for (const f of Object.values(BUNDLED_PLAN_MODELS)) keepSet.add(f);
  }
  for (const f of fs.readdirSync(modelsDir)) {
    if (keepSet.has(f)) continue;
    if (!re.test(f)) continue;
    try {
      fs.unlinkSync(path.join(modelsDir, f));
      removed.push(f);
    } catch (e) {
      // Non-fatal — we'd rather keep going than abort init over a stale file
      // we couldn't remove. Caller can log if they want.
    }
  }
  return removed;
}

/**
 * Ensure the GGUF named by `family`+`fileName` exists at `modelsDir/fileName`.
 * If missing, download from the family's HF repo. After a successful download
 * (or if the file was already present), prune older versions of the same
 * family. Returns true if the file is on disk after the call, false otherwise.
 *
 * @param {string} modelsDir - absolute path to the models/ folder
 * @param {'reason'|'plan'} family
 * @param {string} fileName - bare filename (no directory prefix)
 * @param {{ logger?: Function, skipCleanup?: boolean }} opts
 */
export async function ensureGguf(modelsDir, family, fileName, opts = {}) {
  const log = opts.logger ?? (() => {});
  const dest = path.join(modelsDir, fileName);

  if (fs.existsSync(dest)) {
    if (!opts.skipCleanup) {
      const removed = cleanupOldGgufs(modelsDir, family, fileName);
      if (removed.length) log(`[model-fetch] removed stale ${family} GGUFs: ${removed.join(', ')}`);
    }
    return true;
  }

  const baseUrl = family === 'plan' ? PLAN_BASE_URL : REASON_BASE_URL;
  const url = `${baseUrl}/${fileName}`;
  log(`[model-fetch] ${family} model missing — downloading from ${url}`);
  try {
    await downloadFile(url, dest, {
      onProgress: ({ pct, seen, total }) => {
        log(`[model-fetch]   ${pct}% (${(seen / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB)`);
      },
    });
    log(`[model-fetch] ${family} ready: ${dest}`);
    if (!opts.skipCleanup) {
      const removed = cleanupOldGgufs(modelsDir, family, fileName);
      if (removed.length) log(`[model-fetch] removed stale ${family} GGUFs: ${removed.join(', ')}`);
    }
    return true;
  } catch (e) {
    log(`[model-fetch] ${family} download failed: ${e.message}`);
    return false;
  }
}
