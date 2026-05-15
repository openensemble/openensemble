# Speech-to-text

OE's STT handles the *device-says-something → text* half of a voice interaction. Configure once at *Settings → Providers → Speech-to-Text*; the same setup serves every voice device.

## Provider options

OE talks to anything that speaks the **OpenAI Whisper `/v1/audio/transcriptions`** shape — that's the de-facto standard, supported by:

- OpenAI's stock Whisper endpoint (`whisper-1` model)
- Groq's hosted Whisper (faster + cheaper than OpenAI)
- Self-hosted `whisper.cpp`, `faster-whisper-server`, etc.
- LM Studio with a Whisper model loaded
- Anyone else exposing the same API shape

There's no local-by-default option in the UI (yet — Whisper is heavier than Piper TTS and benefits noticeably from a GPU). If you're running a Whisper-compatible server locally, point the URL at it and you're done.

## Setup

1. Open *Settings → Providers → Speech-to-Text*.
2. Fill in the API URL — e.g. `https://api.openai.com/v1/audio/transcriptions` for stock OpenAI, `https://api.groq.com/openai/v1/audio/transcriptions` for Groq, `http://localhost:8000/v1/audio/transcriptions` for a local server.
3. Paste the API key (empty is fine for local servers that don't authenticate).
4. Optionally override the model name (default is `whisper-1`; Groq uses `whisper-large-v3-turbo` for the fastest option).
5. Save.

The TTS preview panel doesn't have an STT equivalent yet — easiest sanity check is to pair a voice device, say something, and watch the OE log for `[stt] result: …`.

## How it works under the hood

When a voice device hits end-of-utterance:

1. The device sends the raw 16 kHz mono `int16` PCM captured since wake-word fire (typically 1-15 seconds) to `/api/stt` over a regular HTTPS-or-HTTP POST.
2. The OE server wraps it as a WAV (no transcoding — Whisper accepts WAV directly), forwards to the configured STT URL with the user's key, and returns the JSON text back to the device.
3. The device sends the resulting transcript as a normal `chat` WebSocket message tagged `source:'voice-device'`. From here it's just a chat — agent dispatch, tool calls, reply tokens, TTS playback.

The 1-15 s utterance window is enforced device-side by VAD (energy threshold + silence-to-end + max-duration cap). The server only gets one transcription request per utterance, so per-request cost is bounded.

## Latency notes

For a typical 3-5 second utterance:

- **OpenAI Whisper:** ~600-1200 ms (Whisper is slower than they'd like to admit)
- **Groq Whisper-turbo:** ~150-400 ms (this is the speed king right now)
- **Local whisper.cpp on CPU:** ~1-3 s
- **Local whisper.cpp on a 3060 Ti:** ~200-500 ms

Groq is the no-brainer if you don't already have a Whisper provider — fast, cheap (often free tier), supports the same API shape.

## When STT goes wrong

- **`stt: <blank>` in the device log** — Whisper returned an empty string. Either the audio was silence or near-silence, or the model didn't recognize anything. Check the wake-word path is firing (`ww: wake!` line), and that the mic actually captures sound during the listening state (`audio_lvl=` non-zero in `ww` log lines).
- **`stt:` is wildly wrong** — usually noise/reverb. The device's wake-word path is robust to background noise (we noise-augment-train the wake-word models against MUSAN) but Whisper transcription is more sensitive. Move closer to the device, or check for HVAC / TV blare.
- **`stt: " ."` or just a period** — STT got a glance of audio but couldn't transcribe. Often happens if the VAD ended the utterance early; the user starts speaking just as the wake refractory ends. Try saying the wake word *and then a brief pause* before your request.
- **HTTP 401 / 403 from STT provider** — re-check the API key. Save again from *Settings → Providers*.
- **HTTP 429** — you're rate-limited at the provider. Different provider, or upgrade plan.
