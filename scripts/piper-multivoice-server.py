"""Piper multi-voice HTTP server for OpenEnsemble.

Loaded by scripts/install-piper.sh → systemd --user unit piper-tts.service.
Replaces piper.http_server (which is locked to a single --model). Scans
PIPER_MODEL_DIR for *.onnx + *.onnx.json pairs and loads PiperVoice instances
lazily on first request, so installing N voices doesn't multiply RAM until
each is actually used.

Endpoints:
  GET  /            — plain "piper-multivoice" (liveness for voice-deps.mjs)
  GET  /voices      — JSON [{id, num_speakers, sample_rate, espeak_voice}, ...]
                      One entry per installed voice. Used by Voice Devices UI
                      to populate per-slot dropdowns and by /api/tts/piper/voices.
  POST /            — JSON {text, voice, speaker_id?, length_scale?, noise_scale?,
                      noise_w_scale?, volume?} → audio/wav. `voice` is the bare
                      voice id (e.g. en_AU-OE_custom-medium). speaker_id only
                      meaningful for multi-speaker voices (num_speakers > 1).

The default-voice fallback is PIPER_DEFAULT_VOICE, or the first voice found
alphabetically if that voice isn't installed. Callers should always pass an
explicit `voice` once Voice Devices is wired up; the fallback exists for the
liveness/smoke-test path and for legacy callers from before the multi-voice
migration.
"""
import glob
import io
import json
import os
import sys
import wave
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse, Response
from piper import PiperVoice
from piper.config import SynthesisConfig
from pydantic import BaseModel

MODEL_DIR = os.environ.get(
    "PIPER_MODEL_DIR",
    os.path.expanduser("~/.openensemble/models/tts"),
)
PORT = int(os.environ.get("PIPER_PORT", "5151"))
DEFAULT_VOICE_ENV = os.environ.get("PIPER_DEFAULT_VOICE", "")

_voices: dict = {}      # id → PiperVoice (lazy)
_voice_meta: dict = {}  # id → metadata dict (refreshed on each /voices + on miss in get_voice)
_default_voice = ""
_load_lock = Lock()
_scan_lock = Lock()


def scan_voices():
    """Re-scan MODEL_DIR. Adds new voices, evicts ones whose files disappeared.
    Cheap (just glob + json.load); safe to call on every /voices request.
    """
    global _default_voice
    new_meta = {}
    for onnx_path in sorted(glob.glob(os.path.join(MODEL_DIR, "*.onnx"))):
        vid = Path(onnx_path).stem
        cfg_path = onnx_path + ".json"
        if not os.path.exists(cfg_path):
            continue
        try:
            with open(cfg_path) as f:
                cfg = json.load(f)
        except Exception:
            continue
        new_meta[vid] = {
            "id": vid,
            "num_speakers": int(cfg.get("num_speakers", 1)),
            "sample_rate": int(cfg.get("audio", {}).get("sample_rate", 22050)),
            "espeak_voice": cfg.get("espeak", {}).get("voice", "en"),
            "_onnx": onnx_path,
            "_cfg": cfg_path,
        }
    with _scan_lock:
        _voice_meta.clear()
        _voice_meta.update(new_meta)
        for vid in list(_voices):
            if vid not in _voice_meta:
                del _voices[vid]
        if DEFAULT_VOICE_ENV and DEFAULT_VOICE_ENV in _voice_meta:
            _default_voice = DEFAULT_VOICE_ENV
        elif _voice_meta and _default_voice not in _voice_meta:
            _default_voice = next(iter(_voice_meta))


def get_voice(vid: str) -> PiperVoice:
    if vid not in _voice_meta:
        scan_voices()
    if vid not in _voice_meta:
        raise HTTPException(
            status_code=404,
            detail=f"voice not installed: {vid!r}. installed: {sorted(_voice_meta)}",
        )
    if vid in _voices:
        return _voices[vid]
    with _load_lock:
        if vid in _voices:
            return _voices[vid]
        meta = _voice_meta[vid]
        print(f"[piper-multivoice] loading {vid} ...", flush=True)
        _voices[vid] = PiperVoice.load(meta["_onnx"], config_path=meta["_cfg"])
        return _voices[vid]


scan_voices()
if not _voice_meta:
    print(f"[piper-multivoice] no voices in {MODEL_DIR}", file=sys.stderr)
    sys.exit(2)


app = FastAPI()


class TtsRequest(BaseModel):
    text: str
    voice: str = ""
    speaker_id: int | None = None
    length_scale: float | None = None
    noise_scale: float | None = None
    noise_w_scale: float | None = None
    volume: float = 1.0


@app.get("/", response_class=PlainTextResponse)
def root():
    return "piper-multivoice"


@app.get("/voices")
def list_voices():
    scan_voices()
    return [
        {k: v for k, v in m.items() if not k.startswith("_")}
        for m in _voice_meta.values()
    ]


@app.post("/")
def tts(req: TtsRequest):
    vid = req.voice or _default_voice
    voice = get_voice(vid)
    meta = _voice_meta[vid]
    sr = meta["sample_rate"]

    syn = SynthesisConfig(
        speaker_id=req.speaker_id if meta["num_speakers"] > 1 else None,
        length_scale=req.length_scale,
        noise_scale=req.noise_scale,
        noise_w_scale=req.noise_w_scale,
        volume=req.volume,
    )

    pcm = bytearray()
    for chunk in voice.synthesize(req.text, syn_config=syn):
        pcm.extend(chunk.audio_int16_bytes)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm)
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
