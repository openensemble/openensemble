# Flashing voice devices

The reference voice device is a **two-chip board**: a Seeed reSpeaker XVF3800 (audio front-end — mic array, AEC, beam-forming) and a Seeed XIAO ESP32-S3 (Wi-Fi, wake-word inference, TTS playback). Each chip has its own firmware and gets flashed separately. OE ships a browser-based wizard that handles both — you don't need `dfu-util`, `idf.py`, or anything on the command line.

## The browser flash wizard

Open *Settings → Voice devices → Flash device* (or just hit `/flash` if you're already in the OE web app on the same network as where the device will be plugged in).

The wizard runs in two stages:

1. **Stage 1 — XVF firmware (WebUSB DFU).** Flashes the XMOS audio chip with the formatBCE HA v1.0.7 firmware (the only variant OE supports — 48 kHz stereo, AEC, configurable for music playback). Take a freshly-soldered or factory-reset board and plug it into your computer's USB-C. Click **Detect XVF**. The browser asks for permission to talk to the USB device; pick the reSpeaker. The wizard pushes ~870 KB and verifies.

2. **Stage 2 — ESP32 firmware (Web Serial / esptool-js).** Flashes the ESP32-S3 application binary (the OE-side code — Wi-Fi, captive portal, wake-word inference, OE WS client). Plug the same board into the **same USB-C port** (the carrier muxes both chips through one port; the wizard switches modes automatically). Click **Detect ESP**. Browser asks for serial-port permission. The wizard writes bootloader + partition table + app + initial wake-word SPIFFS.

Total time: ~2-3 minutes for a fresh board. Done in-browser, no external tools, no installs.

### Why two stages

The XVF and the ESP32 are physically separate chips with separate firmware and separate flash protocols. They share one USB-C port via an on-board hub. The wizard sequences them so you don't end up booting an ESP32 that expects audio it can't get from a yet-unflashed XVF.

After stage 2 completes, the device hard-resets and starts up. If it's never been paired, it boots into provisioning mode (see the **Voice devices** page) and broadcasts `oe-voice-XXXX` Wi-Fi.

## Recovery / "I bricked it"

You did not brick it. The XVF has a separate **factory partition** that you cannot overwrite from the wizard (the wizard only writes the *upgrade* partition). If the upgrade ever boots into a bad state, the XVF falls back to the factory image automatically. Your worst case is "device boots into Seeed's stock vendor firmware" — which still answers DFU just fine, so the wizard can re-flash it.

If the wizard can't detect the XVF at all:

1. **Mute and plug** — hold the device's mute button while plugging in USB-C. This forces the XMOS into DFU mode regardless of what state its application firmware was in. Release the button after the USB enumerates.
2. **Try a different cable** — many cheap USB-C cables are charge-only and won't surface the device as DFU. Use a known-good data cable.
3. **Different port / hub** — some hubs don't pass through WebUSB cleanly. Try a port directly on the host.

If the wizard finds the XVF but stage 2 (ESP) can't see the board, the XVF is still in DFU mode and shadowing the ESP serial port. Wait for the XVF stage to complete + the device to reset, then click **Detect ESP** again.

## Multi-device installs

If you're flashing more than one device, do them one at a time. The browser API binds to a specific USB device handle on first detect, and trying to flash a second board through the same browser tab without re-detecting will pick the wrong one. New tab or re-detect each time.

## What changes on each ESP-side update vs. XVF update

The two firmwares update on very different cadences:

- **ESP-side updates are frequent** (every OE release that touches voice-device behavior). They're what add new features: wake-word slot count, voice intent router, control commands, etc.
- **XVF updates are rare** (the v1.0.7 HA firmware has been stable since the project launched). You usually don't need to re-flash the XVF when OE updates.

The wizard always offers both stages because re-flashing the XVF with the same bytes is a no-op (~3 minutes wasted but safe). If you want to skip stage 1 on a board you've already done, click straight to stage 2.

## Behind the scenes (only read this if curious)

The ESP firmware embeds a copy of the XVF firmware in flash and on first boot pushes it to the XMOS over I²C (the chips talk to each other internally). The wizard's stage 1 is technically optional in the sense that even a totally unflashed XVF will get the firmware pushed by the ESP after stage 2 finishes. We still run stage 1 because the I²C push takes ~3 minutes and the user sees zero feedback during it; doing it explicitly over USB DFU is faster and clearer.
