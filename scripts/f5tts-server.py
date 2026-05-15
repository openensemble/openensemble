#!/usr/bin/env python3
"""F5-TTS HTTP server — zero-shot voice cloning for OE.

POST /tts
  body: { "text": "what to say", "ref_path": "/abs/path/to/ref.wav", "ref_text": "what's in the ref" }
  returns: audio/wav

GET /health → { ok: true, model: "..." }

Loads the F5-TTS v1 base model once at startup so per-request latency
stays low (~1-3 s on a 3070 Ti). Runs on 127.0.0.1:5152 by default.

Started via systemd user service alongside OE; OE's /api/tts proxies to
this when ttsProvider='f5-tts'.
"""
import argparse
import io
import logging
import os
import sys
import wave

from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn
import numpy as np
import soundfile as sf

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("f5tts-server")


class TtsBody(BaseModel):
    text: str
    ref_path: str
    ref_text: str = ""
    speed: float = 1.0
    seed: int | None = None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=5152)
    p.add_argument("--model", default="F5TTS_v1_Base")
    p.add_argument(
        "--device",
        default=None,
        help="cuda / cuda:0 / cpu (default: auto — torch picks the first GPU)",
    )
    args = p.parse_args()

    log.info("loading F5-TTS model %s on %s …", args.model, args.device or "auto")
    from f5_tts.api import F5TTS

    model = F5TTS(model=args.model, device=args.device)
    log.info("F5-TTS ready")

    app = FastAPI(title="oe f5-tts")

    @app.get("/health")
    def health():
        return {"ok": True, "model": args.model}

    @app.post("/tts")
    def tts(body: TtsBody):
        if not body.text.strip():
            raise HTTPException(400, "text required")
        if not os.path.exists(body.ref_path):
            raise HTTPException(400, f"ref_path not found: {body.ref_path}")
        try:
            # F5-TTS.infer returns (wav numpy array, sample_rate, spectrogram).
            # We discard the spectrogram and serialize the wav as a 16-bit
            # PCM WAV to the response — same shape OE's /api/tts expects.
            wav, sr, _ = model.infer(
                ref_file=body.ref_path,
                ref_text=body.ref_text or "",
                gen_text=body.text,
                speed=body.speed,
                seed=body.seed,
                show_info=lambda *a, **k: None,
                progress=None,
            )
        except Exception as e:
            log.exception("inference failed")
            raise HTTPException(500, f"inference failed: {e}")

        # Convert float32 (-1..1) to int16 PCM and emit WAV.
        if wav.dtype != np.int16:
            wav = np.clip(wav, -1.0, 1.0)
            wav = (wav * 32767).astype(np.int16)
        buf = io.BytesIO()
        sf.write(buf, wav, sr, format="WAV", subtype="PCM_16")
        buf.seek(0)
        return Response(content=buf.read(), media_type="audio/wav")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
