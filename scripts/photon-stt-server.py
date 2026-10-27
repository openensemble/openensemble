"""Local Photon Parakeet + mandatory Silero VAD, OpenAI transcription API."""
import asyncio
from contextlib import asynccontextmanager
import io
import os

# Models are prefetched by the installer. Base-model inference needs no network.
os.environ.update(HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                  HTTP_PROXY="http://127.0.0.1:9", HTTPS_PROXY="http://127.0.0.1:9",
                  ALL_PROXY="http://127.0.0.1:9", NO_PROXY="127.0.0.1,localhost",
                  MOONDREAM_API_KEY="")

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse
from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, get_speech_timestamps, get_vad_model

VARIANT = os.environ.get("PHOTON_VARIANT", "ultra")
if VARIANT not in ("ultra", "redux"):
    raise ValueError("PHOTON_VARIANT must be ultra or redux")
PROVIDER = f"photon-{VARIANT}"
MODEL = f"moondream/parakeet-{VARIANT}"
DEVICE = os.environ.get("PHOTON_DEVICE", "cuda")
PORT = int(os.environ.get("PHOTON_PORT", "5158" if VARIANT == "ultra" else "5159"))
MAX_BYTES = 32 * 1024 * 1024
MAX_SECONDS = 120


def prepare_audio(raw):
    # Preserve the fast path used in our OE WAV benchmark; PyAV handles webm,
    # m4a, stereo and other sample rates from browser/mobile uploads.
    if raw.startswith(b"RIFF"):
        pcm, rate = sf.read(io.BytesIO(raw), dtype="float32")
        if rate != 16000 or pcm.ndim != 1:
            pcm = decode_audio(io.BytesIO(raw), sampling_rate=16000)
    else:
        pcm = decode_audio(io.BytesIO(raw), sampling_rate=16000)
    if not len(pcm) or len(pcm) > MAX_SECONDS * 16000 or not np.isfinite(pcm).all():
        raise ValueError(f"Audio must be nonempty, finite and at most {MAX_SECONDS} seconds.")
    return pcm, get_speech_timestamps(pcm, VadOptions())


@asynccontextmanager
async def lifespan(app):
    import torch
    from kestrel.config import RuntimeConfig
    from kestrel.engine import InferenceEngine
    torch.set_num_threads(4)
    get_vad_model()  # Fail startup if the required speech detector cannot load.
    engine = await InferenceEngine.create(RuntimeConfig(
        model=MODEL, device="cuda:0" if DEVICE == "cuda" else "cpu",
        cpu_threads=4, max_batch_size=1, single_pass_batch_capacity=1,
    ))
    try:
        app.state.engine = engine
        app.state.gate = asyncio.Semaphore(1)
        # Exercise the decoder before declaring the service ready.
        await engine.model().transcribe(audio=np.zeros(16000, dtype=np.float32),
                                        sample_rate=16000, timestamps="none")
        yield
    finally:
        await engine.shutdown()


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def health():
    return {"ready": True, "provider": PROVIDER, "model": MODEL, "silero": True, "device": DEVICE}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...), model: str = Form(None),
                     language: str = Form(None), response_format: str = Form("json"),
                     temperature: float = Form(0.0), prompt: str = Form(None),
                     timestamp_granularities: list[str] = Form([])):
    if response_format not in ("json", "text", "verbose_json"):
        raise HTTPException(400, "Supported response formats: json, text, verbose_json.")
    raw = await file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "Audio upload exceeds 32 MiB.")
    async with app.state.gate:
        try:
            pcm, regions = await asyncio.to_thread(prepare_audio, raw)
        except Exception as error:
            raise HTTPException(400, f"Cannot decode audio: {error}") from error
        result = {"text": "", "segments": []}
        if regions:
            # Parakeet detects language itself and does not support a prompt or
            # Whisper language forcing. Accept OE's common form without passing
            # unsupported settings to the engine. Keep the original full audio.
            output = await app.state.engine.model().transcribe(
                audio=pcm, sample_rate=16000,
                timestamps="word" if response_format == "verbose_json" else "none",
            )
            result = output.output
        text = result.get("text", "").strip()
        if response_format == "text":
            return PlainTextResponse(text)
        if response_format == "verbose_json":
            segments = result.get("segments", [])
            return {"text": text, "language": result.get("language") or "",
                    "duration": len(pcm) / 16000, "segments": segments,
                    "words": [word for segment in segments for word in segment.get("words", [])]}
        return {"text": text}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
