# Text-to-speech

OE turns agent replies into audio so a voice device can speak them. Configure the provider once at *Settings → Providers → Text-to-Speech*; the same setup is used for every voice device on the install.

## Provider options

| Provider | Hosting | Cost | Notes |
|---|---|---|---|
| **OpenAI-compatible** | Remote | per-character | Works with any service that speaks the `/v1/audio/speech` shape — the real OpenAI, Groq's hosted TTS, self-hosted OpenAI-compat servers, etc. Voices are named (alloy, echo, fable…). |
| **ElevenLabs** | Remote | per-character | High-quality and supports voice cloning. Voices are catalog IDs (or your own clones). |
| **Piper** | **Local** | free | Local libritts_r model, 904 speakers. Runs as a systemd user service on the OE server. ~80 MB download, no GPU needed. |

There used to be an F5-TTS option for zero-shot voice cloning on the OE box; it was retired 2026-05-15 (GPU-only, fragile setup). If you want voice cloning, use ElevenLabs.

## Setup

### OpenAI-compatible

1. Select **OpenAI-compatible** in the provider dropdown.
2. Fill in the API URL (`https://api.openai.com/v1/audio/speech` for stock OpenAI; whatever endpoint your provider gave you otherwise).
3. Paste the API key.
4. Pick a model (e.g. `tts-1` for stock OpenAI) and a default voice (`alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`).
5. Save.

The default voice is what plays when a slot doesn't override it. Per-slot voice overrides happen in *Settings → Voice devices → Voice config*.

### ElevenLabs

1. Select **ElevenLabs** in the provider dropdown.
2. Paste your `xi-api-key` from the ElevenLabs dashboard.
3. Save.

For per-slot voice selection, the device drawer fetches your ElevenLabs voice catalog (including any clones you've made) and shows it as a dropdown. No need to type voice IDs by hand.

### Piper (local)

The first time you select Piper, the UI shows an **Install Piper (~80 MB)** button. Clicking it:

- Creates a Python venv at `~/.openensemble/runtime/piper-venv` (separate from the OE git tree)
- `pip install piper-tts flask`
- Downloads `en_US-libritts_r-medium.onnx` from HuggingFace into `models/tts/`
- Writes a `piper-tts.service` user-systemd unit
- `enable --now`s it
- Probes `127.0.0.1:5151` to confirm it's responding

You watch the progress stream live in the install panel. Total: ~30 seconds on a decent connection. The same install path runs as an optional `y/N` prompt during `install.sh` for new OE installs.

Piper voices are numeric speaker IDs from 0 to 903 (no useful per-ID metadata exists). The slot voice picker is a number input with a **Preview** button — type an ID, click Preview, the browser plays a short sample from that speaker. Iterate until you find one you like.

## How voice selection works

When a voice device sends a chat, the server resolves the voice in this order, first match wins:

1. **Explicit body param** — used by the preview button.
2. **Slot assignment** — if the chat came from a voice-device with a `wake_slot` set and the slot has a custom `ttsVoice`, use it.
3. **Server-global default** — `cfg.ttsVoice` (the "Default voice" field on the TTS panel).
4. **Hardcoded fallback** — `alloy` for OpenAI, `0` for Piper, ElevenLabs uses the stock Rachel voice.

So you can leave the global default alone and just override per-slot, or set a sensible global default and only override slots that need a different voice.

## Latency by provider

Rough rule of thumb for a 1-sentence reply on a typical home network:

- **Piper (local):** ~200-400 ms first byte. No network round-trip.
- **OpenAI / ElevenLabs:** ~500-900 ms first byte. Cloud round-trip dominates.

OE streams TTS sentence-by-sentence, so the device starts speaking as soon as the first sentence comes back, not after the whole reply completes. This makes the perceived latency much smaller than the round-trip-per-sentence math suggests.

## When TTS goes wrong

- **Device says nothing after a wake word** — Check *Settings → Providers → Text-to-Speech* shows a configured provider (green status, key set or "Piper is running"). The TTS panel's preview button works without involving a device, so use it to confirm the provider works.
- **Robotic / sped-up / pitched audio** — Sample rate mismatch. The device expects 16 kHz mono MP3; both Piper and ElevenLabs branches ffmpeg-resample server-side. If you're using a custom OpenAI-compat endpoint that returns 48 kHz, audio will play 3x speed. Either pick a model/voice that defaults to 16 kHz, or contact your provider.
- **First sentence plays, then silence** — usually a server-side error mid-stream. Check the OE log (`/tmp/openensemble.log` if systemd-managed) for `[tts]` errors.
