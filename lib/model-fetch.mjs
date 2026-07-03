import fs from 'fs';
import path from 'path';

// Both repos use the same flat layout: <file> at /resolve/main/<file>.
export const REASON_HF_REPO = 'openensemble/reason-gguf';
export const PLAN_HF_REPO   = 'openensemble/plan-gguf';

// Bundled plan models. `accurate` is the user-facing scheduler model; `extract`
// is used by the local cognition slot-filling tier. cleanupOldGgufs preserves
// all of these so runtime switches don't require a re-download. The active
// scheduler file comes from config.scheduler.builtinPlanModel, defaulting to
// `accurate`. Update this list when a new bundled plan model ships.
export const BUNDLED_PLAN_MODELS = {
  accurate: 'openensemble-plan-360m-v2.q8_0.gguf',     // SmolLM2-360M, ~370 MB, 98.2% smoke. Adds natural-language scheduling, reschedule, cancel, and v25 fail-cell reinforcement (anchored arithmetic, multi-day pairs, verb-target diversity). eval_loss 0.1833.
  // SmolLM2-360M, ~368 MB. Superset of `accurate`: same scheduler tasks +
  // the <extract> slot-filling task for the local cognition tier. Trained
  // 2026-06-08 (parse.360m-v23 + extract.jsonl, rehearsal-interleaved),
  // eval_loss 0.1925. Used by the extract task (lib/local-label.mjs Tier-3).
  extract:  'openensemble-plan-360m-extract-v1.q8_0.gguf',
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

  // Idle timeout: abort if no data arrives for 2 minutes — a stalled CDN
  // connection otherwise hangs the install step forever.
  const IDLE_MS = 120_000;
  const ac = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(new Error(`download stalled (no data for ${IDLE_MS / 1000}s)`)), IDLE_MS);
  };

  const out = fs.createWriteStream(tmp);
  // A write-stream error (ENOSPC mid-download of a ~370MB GGUF) used to be an
  // unhandled 'error' event — a process crash. Surface it into the loop.
  const outFailed = new Promise((_, reject) => out.on('error', reject));
  outFailed.catch(() => {}); // observed below via Promise.race; never unhandled
  try {
    armIdle();
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);

    const total = Number(res.headers.get('content-length')) || 0;
    let seen = 0;
    let lastPct = -1;

    for await (const chunk of res.body) {
      armIdle();
      // Backpressure: without honoring write()'s return value a slow disk
      // buffers the whole file in memory.
      if (!out.write(chunk)) {
        await Promise.race([new Promise(resolve => out.once('drain', resolve)), outFailed]);
      }
      seen += chunk.length;
      if (total && onProgress) {
        const pct = Math.floor((seen / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) {
          onProgress({ pct, seen, total });
          lastPct = pct;
        }
      }
    }
    await Promise.race([
      new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve()))),
      outFailed,
    ]);
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { out.destroy(); } catch { /* best-effort */ }
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  } finally {
    clearTimeout(idleTimer);
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
