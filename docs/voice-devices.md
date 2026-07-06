---
title: Voice devices
nav_order: 3
description: >-
  Build an open-source ESP32-S3 voice assistant: on-device wake words,
  far-field capture with hardware echo cancellation, and a self-hosted
  alternative to Alexa or Google Home that keeps audio on your own server.
---

# Voice devices — an open, self-hosted voice assistant

Pair a physical wake-word device with your OpenEnsemble server: say
**"Hey Ensemble"** (or any of the bundled wake words) and talk to your agents
hands-free. The reply is spoken back through the device's speaker or 3.5 mm
jack. Audio, transcripts, and conversation history never leave your server.

It's a fully open alternative to an Alexa- or Google-Home-style smart speaker:
open hardware, [open firmware](https://github.com/openensemble/voice-device-firmware),
and a server you run yourself.

## Hardware

The currently supported build is two boards that socket together — no
soldering:

| Part | Role |
|---|---|
| Seeed reSpeaker XVF3800 4-Mic Array | Far-field mic array, hardware echo cancellation, beamforming, LEDs, speaker amp |
| Seeed XIAO ESP32-S3 | Runs the [open-source firmware](https://github.com/openensemble/voice-device-firmware) |
| 4–8 Ω speaker on the XVF3800 JST connector | Output |

Other hardware combinations may work but aren't tested or shipped with
matching firmware.

## What it does

- **Wake words on-device** — streaming
  [microWakeWord](https://github.com/kahrendt/microWakeWord) models run on the
  ESP32; nothing is streamed to the server until the device hears its wake
  word. Six wake-word slots, with per-user custom models pushed by the server.
- **Far-field voice turns** — beamformed, echo-cancelled capture; speech goes
  to your server for STT, your agents answer, and the reply streams back as
  spoken audio. Barge-in works during playback.
- **Full-duplex conversation mode** — follow-up questions without repeating
  the wake word.
- **Fast-path voice control** — "volume up", "pause", "stop" execute directly
  without an LLM round-trip.
- **Household sharing** — one device can route "hey roommate" to a different
  user's account, with per-slot voice and wake-word routing.
- **AirPlay receiver** — stream music from iOS/macOS; wake words stay live
  during playback.
- **Device-side alarms and timers** — armed on the device itself, so they
  fire even if Wi-Fi or the server is down.
- **OTA updates** — the server delivers firmware updates over the air.

## Flashing and pairing

OpenEnsemble ships prebuilt firmware and includes a **browser-based flash
wizard** (WebUSB + Web Serial in Chrome or Edge) — no `dfu-util`, `esptool`,
or toolchain needed. Open the in-app **Guide → Voice devices** section for
pairing and flashing.

On first boot the device comes up as a Wi-Fi access point; a small captive
portal form takes your Wi-Fi credentials, the server URL, and a pairing code.

## Firmware

The device firmware is open source (AGPL-3.0) at
[openensemble/voice-device-firmware](https://github.com/openensemble/voice-device-firmware)
— ESP-IDF v5.4, CI-built artifacts on every push. You only need that repo if
you want to hack on the firmware itself; prebuilt binaries ship with every
OpenEnsemble install.
