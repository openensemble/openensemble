#!/usr/bin/env node
/**
 * CLI wrapper around ensureFirmwareAssets(). Downloads the firmware images OE
 * serves at /firmware/<component>/ for device OTA and the browser flash
 * wizard. See lib/firmware-assets.mjs for why they live on GitHub Releases
 * rather than in git.
 *
 * Runs in three places:
 *   - `npm install` postinstall, after fetch-models.mjs (fresh install)
 *   - lib/update.mjs after every self-update pull — REQUIRED, because the
 *     commit that untracked these images also deletes them from an existing
 *     install's working tree on pull
 *   - by hand, when an admin is told to by a missing-firmware error
 *
 * Idempotent: a part whose bytes already match the manifest sha256 is skipped,
 * so the common no-op case costs a few hashes and no network.
 *
 * Exits 0 even on failure, matching fetch-models.mjs — firmware is not needed
 * to boot OE, and hard-failing `npm install` offline would be a worse trade.
 * The gap is surfaced at the point of use instead. `--check` inverts that
 * (verify only, non-zero if anything is missing) for tests and manual audits.
 */

import { ensureFirmwareAssets, listComponents, RELEASE_REPO, FIRMWARE_DIR } from '../lib/firmware-assets.mjs';

const checkOnly = process.argv.includes('--check');
const log = (m) => console.log(`[firmware-fetch] ${m}`);

if (!listComponents().length) {
  console.warn(`[firmware-fetch] no firmware manifests under ${FIRMWARE_DIR} — nothing to fetch`);
  process.exit(0);
}

if (!checkOnly) log(`source: github.com/${RELEASE_REPO} releases`);

const { ok, fetched, failures } = await ensureFirmwareAssets({ logger: log, checkOnly });

if (ok) {
  log(checkOnly ? 'all firmware parts present and verified' : `firmware ready${fetched.length ? ` (fetched ${fetched.length})` : ' (nothing to do)'}`);
} else {
  for (const f of failures) console.warn(`[firmware-fetch] ${f.file}: ${f.reason}`);
  console.warn('[firmware-fetch] Device OTA and USB flashing will not work until these are present.');
  console.warn('[firmware-fetch] Retry with: node scripts/fetch-voice-firmware.mjs');
}

// --check is for tests and audits, so it reports truthfully. The install path
// stays non-fatal on purpose.
process.exit(checkOnly && !ok ? 1 : 0);
