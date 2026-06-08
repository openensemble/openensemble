"""Pocket TTS HTTP server for OpenEnsemble.

Loaded by scripts/install-pocket-tts.sh → systemd --user unit pocket-tts.service.
OE's TTS dispatch in routes/config.mjs POSTs {text, ref_path|voice} → WAV bytes.

Pocket TTS (Kyutai, https://github.com/kyutai-labs/pocket-tts) is a 100M-param
CPU TTS with zero-shot voice cloning. CC-BY-4.0 — see NOTICE in models dir.

Endpoints (single root URL, FastAPI routes by method):
  GET  /      — plain "pocket-tts" (cheap liveness probe for voice-deps.mjs)
  POST /      — JSON {text: str, ref_path?: str, voice?: str} → audio/wav (24 kHz)
                ref_path: absolute path to a reference .wav/.mp3 → zero-shot clone
                voice:    a preset catalog voice name (used if no ref_path)

Voice-clone states are cached in-process keyed by (ref_path, mtime) so repeated
synthesis of the same cloned voice skips the (slow) speaker-embedding step.

Env:
  POCKET_TTS_PORT    default 5155
  POCKET_TTS_CONFIG  optional path to a custom config YAML (points weights_path
                     at the OE mirror). If unset, uses the bundled "english" config.
  POCKET_TTS_VOICE   default preset voice when no ref_path given (default "george")
  HF_HUB_OFFLINE     set to 1 by the systemd unit — weights are pre-fetched by the
                     installer into HF_HOME, so no network/token at runtime.
"""
import io
import os
import sys
import threading

import numpy as np
import scipy.io.wavfile
from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel

os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")  # CPU only — GPU gives no speedup

from pocket_tts import TTSModel
try:
    from pocket_tts.models.tts_model import export_model_state
except Exception:
    export_model_state = None  # voice-state caching disabled if unavailable

PORT          = int(os.environ.get("POCKET_TTS_PORT", "5155"))
CONFIG_PATH   = os.environ.get("POCKET_TTS_CONFIG") or None
DEFAULT_VOICE = os.environ.get("POCKET_TTS_VOICE", "george")
# int8 quantization (torchao). Kyutai advertises ~27% faster on x86 FBGEMM,
# but measured ~2x SLOWER on this torch/torchao build (2026-06-08), so default
# OFF. Flip POCKET_TTS_QUANTIZE=1 to re-test on a future torchao.
QUANTIZE      = os.environ.get("POCKET_TTS_QUANTIZE", "0") not in ("0", "", "false")

def _load():
    try:
        return TTSModel.load_model(config=CONFIG_PATH, quantize=QUANTIZE) if CONFIG_PATH \
            else TTSModel.load_model(quantize=QUANTIZE)
    except Exception as e:
        if QUANTIZE:
            print(f"[pocket-tts-server] quantize unavailable ({e}); loading unquantized", flush=True)
            return TTSModel.load_model(config=CONFIG_PATH) if CONFIG_PATH else TTSModel.load_model()
        raise

print(f"[pocket-tts-server] loading model (config={CONFIG_PATH or 'english'}, quantize={QUANTIZE}) ...", flush=True)
model = _load()
SR = model.sample_rate
print(f"[pocket-tts-server] ready (sr={SR})", flush=True)

# voice-state cache: key -> state. Key is ref path+mtime, or "preset:<name>".
_states: dict = {}
_lock = threading.Lock()


def _state_for(ref_path: str | None, voice: str | None):
    if ref_path:
        try:
            mtime = os.path.getmtime(ref_path)
        except OSError:
            raise HTTPException(status_code=400, detail=f"ref_path not found: {ref_path}")
        key = f"ref:{ref_path}:{mtime}"
    else:
        key = f"preset:{voice or DEFAULT_VOICE}"
    with _lock:
        st = _states.get(key)
        if st is not None:
            return st
    # build outside the lock (slow). For cloned refs, persist the computed
    # speaker state next to the wav as <ref>.safetensors and reload that on
    # later calls — extracting the state from audio is the ~3s cold cost;
    # reloading the .safetensors is near-instant and survives restarts.
    if ref_path:
        st_path = os.path.splitext(ref_path)[0] + ".safetensors"
        if os.path.exists(st_path) and os.path.getmtime(st_path) >= mtime:
            st = model.get_state_for_audio_prompt(st_path)        # fast reload
        else:
            st = model.get_state_for_audio_prompt(ref_path)       # compute (slow)
            if export_model_state is not None:
                try:
                    export_model_state(st, st_path)
                    print(f"[pocket-tts-server] cached voice state -> {st_path}", flush=True)
                except Exception as e:
                    print(f"[pocket-tts-server] voice-state cache failed: {e}", flush=True)
    else:
        target = voice or DEFAULT_VOICE
        try:
            st = model.get_state_for_audio_prompt(target)
        except Exception as e:
            # Invalid/legacy preset name (e.g. F5's "default-en") → don't 500;
            # fall back to the default catalog voice so a reply still plays.
            print(f"[pocket-tts-server] voice '{target}' invalid ({e}); using {DEFAULT_VOICE}", flush=True)
            st = model.get_state_for_audio_prompt(DEFAULT_VOICE)
    with _lock:
        _states[key] = st
    return st


app = FastAPI()


class TtsRequest(BaseModel):
    text: str
    ref_path: str | None = None
    voice: str | None = None


@app.get("/", response_class=PlainTextResponse)
def root():
    return "pocket-tts"


class WarmRequest(BaseModel):
    ref_path: str


@app.post("/warm")
def warm(req: WarmRequest):
    # Compute + persist the speaker state for a reference (writes <ref>.safetensors)
    # without synthesizing audio. Called at upload time so the first real reply
    # for a new voice isn't slow.
    if not req.ref_path:
        raise HTTPException(status_code=400, detail="ref_path required")
    _state_for(req.ref_path, None)
    return {"ok": True}


@app.post("/")
def tts(req: TtsRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    state = _state_for(req.ref_path, req.voice)
    audio = model.generate_audio(state, req.text)
    arr = audio.numpy() if hasattr(audio, "numpy") else np.asarray(audio)
    arr = np.asarray(arr, dtype=np.float32)
    pcm = np.clip(arr, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    scipy.io.wavfile.write(buf, SR, pcm)
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
