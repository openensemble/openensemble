#!/usr/bin/env node
/**
 * Compatibility-named verifier for the firmware images OE serves at
 * /firmware/<component>/ for device OTA and the browser flash wizard.
 *
 * Firmware is bundled in the OpenEnsemble repository. This script retains its
 * historical filename so package.json can stay byte-for-byte compatible with
 * older updaters, but it performs no download and needs no network access.
 *
 * The normal postinstall path stays non-fatal because voice hardware is
 * optional. `--check` exits non-zero on an incomplete/corrupt bundle for
 * packaging tests and manual audits.
 */

import { remediationHint, verifyFirmwareAssets } from '../lib/firmware-assets.mjs';

const checkOnly = process.argv.includes('--check');
const log = (m) => console.log(`[firmware-bundle] ${m}`);

const { ok, verified, failures } = verifyFirmwareAssets();

if (ok) {
  log(`all ${verified.length} bundled firmware parts present and verified`);
} else {
  for (const f of failures) console.warn(`[firmware-bundle] ${f.file}: ${f.reason}`);
  console.warn('[firmware-bundle] Device OTA and USB flashing will not work until the bundle is restored.');
  console.warn(`[firmware-bundle] ${remediationHint()}`);
}

// --check is for packaging tests and audits. The install path stays non-fatal
// so users without voice hardware are not blocked by a damaged optional asset.
process.exit(checkOnly && !ok ? 1 : 0);
