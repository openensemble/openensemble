"""KittenTTS HTTP server for OpenEnsemble.

Loaded by scripts/install-kittentts.sh → systemd --user unit kittentts.service.
OE's TTS dispatch in routes/config.mjs POSTs {text, voice} → WAV bytes.

Endpoints (single root URL, FastAPI routes by method):
  GET  /      — plain "kittentts" (cheap liveness probe for voice-deps.mjs)
  POST /      — JSON {text: str, voice?: str, speed?: float} → audio/wav

Voices (8 presets, no cloning):
  expr-voice-{2,3,4,5}-{m,f}    e.g. expr-voice-2-f (default)

KittenTTS is a 25M-param ONNX model. CPU-only. The espeakng-loader pip dep
bundles its own libespeak-ng.so + data files, so no system espeak-ng install
is needed.
"""
import io
import os
import sys

import soundfile as sf
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel
from kittentts import KittenTTS

MODEL_PATH  = os.environ.get("KITTENTTS_MODEL")
VOICES_PATH = os.environ.get("KITTENTTS_VOICES")
PORT        = int(os.environ.get("KITTENTTS_PORT", "5153"))

# KittenTTS nano-0.2 emits 24 kHz mono float32.
SAMPLE_RATE = 24000
DEFAULT_VOICE = "expr-voice-2-f"

if not MODEL_PATH or not os.path.exists(MODEL_PATH):
    print(f"[kittentts-server] KITTENTTS_MODEL not set or missing: {MODEL_PATH!r}", file=sys.stderr)
    sys.exit(2)
if not VOICES_PATH or not os.path.exists(VOICES_PATH):
    print(f"[kittentts-server] KITTENTTS_VOICES not set or missing: {VOICES_PATH!r}", file=sys.stderr)
    sys.exit(2)

print(f"[kittentts-server] loading model {MODEL_PATH} ...", flush=True)
model = KittenTTS(MODEL_PATH, VOICES_PATH)
print(f"[kittentts-server] ready (voices: {model.available_voices})", flush=True)

app = FastAPI()


class TtsRequest(BaseModel):
    text: str
    voice: str = DEFAULT_VOICE
    speed: float = 1.0


@app.get("/", response_class=PlainTextResponse)
def root():
    return "kittentts"


@app.post("/")
def tts(req: TtsRequest):
    voice = req.voice if req.voice in model.available_voices else DEFAULT_VOICE
    arr = model.generate(req.text, voice=voice, speed=req.speed)
    buf = io.BytesIO()
    sf.write(buf, arr, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
