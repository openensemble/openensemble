/**
 * Shared knowledge of the firmware images OE serves at /firmware/<component>/
 * for device OTA and for the browser flash wizard.
 *
 * The images live in the OpenEnsemble repository beside their manifests. A
 * fresh clone is therefore ready for device OTA and browser flashing without
 * a second download, a network connection, or a separate release artifact.
 *
 * manifest.json is the single source of truth for the published version,
 * flash layout, and expected bytes. scripts/fetch-voice-firmware.mjs retains
 * its historical name for package.json compatibility, but now verifies the
 * bundled files without making a network request.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIRMWARE_DIR = path.join(BASE_DIR, 'public', 'firmware');
const REQUIRED_COMPONENTS = ['voice-device', 'xvf3800'];
const VOICE_FLASH_LAYOUT = [
  ['bootloader', '0x0', 'bootloader.bin'],
  ['partition-table', '0x8000', 'partition-table.bin'],
  ['ota-data', '0x10000', 'ota_data_initial.bin'],
  ['app', '0x20000', 'oe_voice_device.bin'],
  ['wakewords', '0x620000', 'wakewords.bin'],
];

/** Required components plus any additional manifest-bearing bundle directories. */
export function listComponents() {
  let discovered = [];
  try {
    discovered = fs.readdirSync(FIRMWARE_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(FIRMWARE_DIR, e.name, 'manifest.json')))
      .map(e => e.name);
  } catch { /* required components below make a missing bundle visible */ }
  return [...new Set([...REQUIRED_COMPONENTS, ...discovered])].sort();
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

function manifestProblems(component, manifest, parts) {
  const problems = [];
  if (typeof manifest?.version !== 'string' || !manifest.version) {
    problems.push('manifest has no version');
  }
  if (component === 'voice-device') {
    const requiredNames = ['bootloader', 'partition-table', 'ota-data', 'app', 'wakewords'];
    const names = parts.map(part => part.name);
    for (const name of requiredNames) {
      if (!names.includes(name)) problems.push(`manifest is missing the ${name} part`);
    }
    if (new Set(names).size !== names.length) problems.push('manifest has duplicate part names');
    const files = parts.map(part => part.file);
    if (new Set(files).size !== files.length) problems.push('manifest has duplicate part files');
    const offsets = Array.isArray(manifest.parts) ? manifest.parts.map(part => part.offset) : [];
    if (offsets.some(offset => typeof offset !== 'string' || !/^0x[0-9a-f]+$/i.test(offset))) {
      problems.push('manifest has an invalid flash offset');
    }
    if (new Set(offsets).size !== offsets.length) problems.push('manifest has duplicate flash offsets');
    const actualLayout = Array.isArray(manifest.parts)
      ? manifest.parts.map(part => [part.name, part.offset, part.file])
      : [];
    if (JSON.stringify(actualLayout) !== JSON.stringify(VOICE_FLASH_LAYOUT)) {
      problems.push('manifest does not match the supported ESP32-S3 flash layout');
    }
    if (manifest.chip !== 'esp32s3'
      || manifest.baud !== 921600
      || manifest.flashSettings?.flashMode !== 'dio'
      || manifest.flashSettings?.flashSize !== '8MB'
      || manifest.flashSettings?.flashFreq !== '80m') {
      problems.push('manifest does not match the supported ESP32-S3 flash settings');
    }

    const app = parts.find(part => part.name === 'app');
    if (app && !partProblem(component, app)) {
      try {
        const image = fs.readFileSync(path.join(FIRMWARE_DIR, component, app.file));
        const embeddedVersion = image.subarray(0x30, 0x50).toString('utf8').replace(/\0.*$/, '');
        if (embeddedVersion !== manifest.version) {
          problems.push(`app embeds version ${embeddedVersion || '(empty)'} instead of ${manifest.version}`);
        }
      } catch (error) {
        problems.push(`could not read the app version: ${error.message}`);
      }
    }
  } else if (component === 'xvf3800') {
    if (parts.length !== 1) problems.push('XVF3800 manifest must select exactly one image');
    if (manifest.chip !== 'xvf3800'
      || manifest.version !== '1.0.7'
      || manifest.variant !== 'ha_inthost_lr48_sqr_i2c'
      || JSON.stringify(manifest.acceptedVendorIds) !== JSON.stringify([8369, 10374])
      || manifest.transport !== 'dfu'
      || manifest.preferInterface !== 'Upgrade'
      || manifest.forceAlt !== 1
      || manifest.transferSize !== 4096
      || manifest.file !== 'xvf_ha_v1_0_7.bin'
      || manifest.size !== 888832) {
      problems.push('manifest does not match the supported XVF3800 DFU image and transport');
    }
  }
  return problems;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * Why a part isn't usable, or null if it is.
 *
 * @returns {'missing'|'unreadable'|'invalid-type'|'invalid-manifest'|'unverified'|'corrupt'|'wrong-size'|null}
 */
export function partProblem(component, part) {
  if (typeof part?.file !== 'string' || !part.file || path.basename(part.file) !== part.file) {
    return 'invalid-manifest';
  }
  const p = path.join(FIRMWARE_DIR, component, part.file);
  let stat;
  try { stat = fs.lstatSync(p); }
  catch (error) { return error?.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  if (!stat.isFile()) return 'invalid-type';
  if (part.size != null && stat.size !== part.size) return 'wrong-size';
  if (typeof part.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(part.sha256)) return 'unverified';
  try { return sha256File(p) === part.sha256.toLowerCase() ? null : 'corrupt'; }
  catch { return 'unreadable'; }
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
    catch { bad.push({ component, file: 'manifest.json', name: 'manifest', problem: 'unreadable-manifest' }); continue; }
    const parts = partsOf(manifest);
    if (!parts.length) {
      bad.push({ component, file: 'manifest.json', name: 'manifest', problem: 'invalid-manifest' });
      continue;
    }
    for (const problem of manifestProblems(component, manifest, parts)) {
      bad.push({ component, file: 'manifest.json', name: 'manifest', problem });
    }
    for (const part of parts) {
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
  return 'The firmware bundled with this OpenEnsemble checkout is missing or corrupt. Restore `public/firmware` from the current revision (`git restore --source=HEAD -- public/firmware` in a Git install), then restart OpenEnsemble.';
}

/**
 * Verify the repository-bundled firmware against its manifests.
 *
 * @param {{ logger?: (m: string) => void }} opts
 * @returns {{ok: boolean, verified: string[], failures: Array<{file: string, reason: string}>}}
 */
export function verifyFirmwareAssets({ logger = () => {} } = {}) {
  const verified = [];
  const failures = [];

  for (const component of listComponents()) {
    let manifest;
    try { manifest = readManifest(component); }
    catch (e) { failures.push({ file: `${component}/manifest.json`, reason: e.message }); continue; }

    const parts = partsOf(manifest);
    if (!parts.length) {
      failures.push({ file: `${component}/manifest.json`, reason: 'manifest has no firmware parts' });
      continue;
    }
    for (const reason of manifestProblems(component, manifest, parts)) {
      failures.push({ file: `${component}/manifest.json`, reason });
    }
    for (const part of parts) {
      const problem = partProblem(component, part);
      const id = `${component}/${part.file}`;
      if (problem) {
        failures.push({ file: id, reason: problem });
        logger(`${id}: ${problem}`);
        continue;
      }
      verified.push(id);
    }
  }

  return { ok: failures.length === 0, verified, failures };
}

/**
 * Backward-compatible name retained for callers from releases that downloaded
 * firmware. It now performs the same offline verification and never fetches.
 */
export async function ensureFirmwareAssets(opts = {}) {
  const result = verifyFirmwareAssets(opts);
  return { ...result, fetched: [] };
}
