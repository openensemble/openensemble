# Bundled voice-device firmware

These are the exact images served by OpenEnsemble for browser flashing and
device OTA. They are tracked with OE so a fresh or offline installation does
not depend on a separate release download.

The component manifests define the version, flash layout, size where
applicable, and SHA-256 of every image. Update a manifest and its binaries in
the same commit, then run:

```bash
node scripts/fetch-voice-firmware.mjs --check
```

The script name is retained for compatibility with older installers; it only
verifies local files and does not access the network.

## Provenance and licenses

- `voice-device/` contains the ESP32-S3 OpenEnsemble voice-device build. Its
  source is [openensemble/voice-device-firmware](https://github.com/openensemble/voice-device-firmware),
  licensed AGPL-3.0 with separately licensed third-party components documented
  by that project. The application binary reports `0.2.92-selfheal`; its
  corresponding source snapshot is commit
  `da4d6a1d26b33fc7c7e93f8a7c6add5e17adfb02`. Supporting images are pinned
  independently by the manifest hashes.
- `xvf3800/xvf_ha_v1_0_7.bin` is compiled Seeed/XMOS XVF3800 firmware, variant
  `ha_inthost_lr48_sqr_i2c`, distributed by the
  [formatBCE XVF3800 integration](https://github.com/formatBCE/Respeaker-XVF3800-ESPHome-integration)
  at commit `8c4aa8ad0098bcc8b076ef17660bab4e0cf0531d` and based on the
  [Seeed reSpeaker firmware](https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY).
  Neither upstream repository published a license file or an explicit binary
  redistribution grant when this notice was written. This image is not covered
  by OE's AGPL; distributors must confirm the applicable Seeed/XMOS rights.

Do not add rotated backups or historical images here. OE ships only the
manifest-selected version needed by supported devices.
