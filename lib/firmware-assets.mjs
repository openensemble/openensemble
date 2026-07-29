/**
 * Shared knowledge of the firmware images OE serves at /firmware/<component>/
 * for device OTA and for the browser flash wizard.
 *
 * The images deliberately do NOT live in git. Each is ~2.4 MB and a new one
 * lands on every firmware publish, so committing them grew .git by ~2.4 MB per
 * release with no way to reclaim it short of a history rewrite. They live on
 * GitHub Releases instead; only manifest.json is committed.
 *
 * That makes manifest.json the single source of truth for BOTH which version
 * is published and what its bytes must hash to. The release tag is derived
 * from it, so publishing firmware is a manifest edit plus a release upload —
 * never a binary commit.
 *
 * scripts/fetch-voice-firmware.mjs downloads against this; routes/devices.mjs
 * uses it to explain a missing image instead of serving a 404 the device
 * reports as a generic OTA failure.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIRMWARE_DIR = path.join(BASE_DIR, 'public', 'firmware');

// Forks won't have the upstream releases. Let them point the fetcher at their
// own without patching the script.
export const RELEASE_REPO = process.env.OE_FIRMWARE_RELEASE_REPO || 'openensemble/openensemble';

/** Components are just the subdirectories that carry a manifest.json. */
export function listComponents() {
  if (!fs.existsSync(FIRMWARE_DIR)) return [];
  return fs.readdirSync(FIRMWARE_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(FIRMWARE_DIR, e.name, 'manifest.json')))
    .map(e => e.name)
    .sort();
}

export function readManifest(component) {
  const p = path.join(FIRMWARE_DIR, component, 'manifest.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`unreadable manifest ${component}/manifest.json: ${e.message}`); }
}

/**
 * Normalize the two manifest shapes into one list.
 *
 *   voice-device — multi-part flash layout: parts[] of {name, offset, file, sha256}
 *   xvf3800      — a single DFU image at the top level: {file, size, sha256}
 */
export function partsOf(manifest) {
  if (Array.isArray(manifest.parts)) {
    return manifest.parts.map(p => ({ name: p.name || p.file, file: p.file, sha256: p.sha256, size: p.size }));
  }
  if (manifest.file) {
    return [{ name: manifest.chip || manifest.file, file: manifest.file, sha256: manifest.sha256, size: manifest.size }];
  }
  return [];
}

/** Release tag for a component, derived entirely from committed metadata. */
export function releaseTag(component, manifest) {
  return `${component}-v${manifest.version}`;
}

export function assetUrl(component, manifest, file) {
  return `https://github.com/${RELEASE_REPO}/releases/download/${releaseTag(component, manifest)}/${file}`;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * Why a part isn't usable, or null if it is.
 *
 * A manifest entry with no sha256 falls back to a size check — weaker, but it
 * still catches the truncated-download case, which is the failure that
 * actually bricks a flash.
 *
 * @returns {'missing'|'corrupt'|'wrong-size'|null}
 */
export function partProblem(component, part) {
  const p = path.join(FIRMWARE_DIR, component, part.file);
  if (!fs.existsSync(p)) return 'missing';
  if (part.sha256) return sha256File(p) === part.sha256 ? null : 'corrupt';
  if (part.size) return fs.statSync(p).size === part.size ? null : 'wrong-size';
  return null;
}

/**
 * Every part across every component that is missing or fails verification.
 * Empty array means the install can serve OTA and flash a device.
 *
 * @returns {Array<{component: string, file: string, name: string, problem: string}>}
 */
export function missingParts() {
  const bad = [];
  for (const component of listComponents()) {
    let manifest;
    try { manifest = readManifest(component); }
    catch { bad.push({ component, file: 'manifest.json', name: 'manifest', problem: 'missing' }); continue; }
    for (const part of partsOf(manifest)) {
      const problem = partProblem(component, part);
      if (problem) bad.push({ component, file: part.file, name: part.name, problem });
    }
  }
  return bad;
}

/**
 * One-line remediation shown to an admin. Kept here so the OTA route, the
 * flash wizard endpoint, and the fetch script all say the same thing.
 */
export function remediationHint() {
  return 'Firmware images are fetched from GitHub Releases, not stored in git. Run `node scripts/fetch-voice-firmware.mjs` from the install directory to download them.';
}

/**
 * Download every part that is missing or fails verification.
 *
 * Lives here rather than in the CLI script so lib/update.mjs can call it
 * in-process after a pull instead of shelling out to node.
 *
 * Never throws — a firmware image is not needed to boot OE, only to flash or
 * OTA a device. Callers decide how loud to be about `ok: false`.
 *
 * @param {{ logger?: (m: string) => void, checkOnly?: boolean }} opts
 * @returns {Promise<{ok: boolean, fetched: string[], failures: Array<{file: string, reason: string}>}>}
 */
export async function ensureFirmwareAssets({ logger = () => {}, checkOnly = false } = {}) {
  // Imported lazily so the hot path (routes reading missingParts) never pulls
  // in the downloader.
  const { downloadFile } = await import('./model-fetch.mjs');
  const fetched = [];
  const failures = [];

  for (const component of listComponents()) {
    let manifest;
    try { manifest = readManifest(component); }
    catch (e) { failures.push({ file: `${component}/manifest.json`, reason: e.message }); continue; }

    const tag = releaseTag(component, manifest);
    for (const part of partsOf(manifest)) {
      const problem = partProblem(component, part);
      if (!problem) continue;

      const id = `${component}/${part.file}`;
      if (checkOnly) { failures.push({ file: id, reason: problem }); continue; }

      const dest = path.join(FIRMWARE_DIR, component, part.file);
      logger(`${id} ${problem} — downloading from ${tag}`);
      try {
        await downloadFile(assetUrl(component, manifest, part.file), dest, {
          onProgress: ({ pct, seen, total }) =>
            logger(`  ${part.file} ${pct}% (${(seen / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`),
        });
      } catch (e) {
        failures.push({ file: id, reason: `download failed: ${e.message}` });
        continue;
      }

      // Verify what actually landed. A corrupt image reaching an ESP32 is far
      // worse than a missing one, so a mismatch is deleted rather than served.
      const after = partProblem(component, part);
      if (after) {
        logger(`${id} failed verification after download (${after}) — discarding`);
        try { fs.unlinkSync(dest); } catch { /* best-effort */ }
        failures.push({ file: id, reason: `verification failed after download (${after})` });
        continue;
      }
      logger(`${id} ok`);
      fetched.push(id);
    }
  }

  return { ok: failures.length === 0, fetched, failures };
}
