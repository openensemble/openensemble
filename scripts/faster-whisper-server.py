"""Faster-Whisper HTTP server for OpenEnsemble.

Speaks the OpenAI /v1/audio/transcriptions multipart shape so OE's existing
/api/stt path works unchanged — set sttApiUrl to this server's URL,
sttApiKey can be anything (ignored), sttModel is ignored too.

Two install profiles:
  - CPU build with distil-large-v3 (English, ~750 MB, int8)
  - CUDA build with large-v3-turbo (multilingual, ~810 MB, float16)
The active profile is decided at install time and baked into the systemd
unit's Environment lines (FW_MODEL / FW_DEVICE / FW_COMPUTE_TYPE).

Model is loaded into memory (RAM for CPU, VRAM for CUDA) at service start
so the first request hits a warm cache. Service restart re-loads (~5-15 s
CPU, ~3-8 s GPU) but that only happens on `systemctl restart` or boot.

Endpoints:
  GET  /                               — "faster-whisper" (liveness probe)
  POST /v1/audio/transcriptions        — multipart `file` upload → JSON {text}
"""
import io
import os
import sys

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from faster_whisper import WhisperModel

MODEL = os.environ.get("FW_MODEL", "distil-large-v3")
DEVICE = os.environ.get("FW_DEVICE", "cpu")
COMPUTE_TYPE = (
    os.environ.get("FW_COMPUTE_TYPE")
    or ("float16" if DEVICE == "cuda" else "int8")
)
PORT = int(os.environ.get("FW_PORT", "5154"))
DOWNLOAD_DIR = os.environ.get("FW_DOWNLOAD_DIR") or None

print(
    f"[faster-whisper-server] loading {MODEL} on {DEVICE} ({COMPUTE_TYPE}) ...",
    flush=True,
)
try:
    model = WhisperModel(
        MODEL,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        download_root=DOWNLOAD_DIR,
    )
except Exception as e:
    print(
        f"[faster-whisper-server] FAIL loading model: {e}",
        file=sys.stderr,
        flush=True,
    )
    sys.exit(2)
print("[faster-whisper-server] ready", flush=True)

app = FastAPI()


@app.get("/", response_class=PlainTextResponse)
def root():
    return "faster-whisper"


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(None),
    language: str = Form(None),
    response_format: str = Form("json"),
    temperature: float = Form(0.0),
    prompt: str = Form(None),
    timestamp_granularities: list[str] = Form([]),
):
    # faster-whisper accepts a file path or BinaryIO; BytesIO works because
    # the underlying PyAV/ffmpeg pipeline handles arbitrary containers.
    raw = await file.read()
    audio_buf = io.BytesIO(raw)
    # verbose_json + word-level timestamps are needed for callers doing
    # offline segmentation (training-data builds, subtitle generation,
    # search-within-audio). word_timestamps=True is a per-call enable on
    # faster-whisper; it's not a separate model. The plain `text` /
    # `json` paths skip it to keep latency low.
    want_words = (
        response_format == "verbose_json"
        and (not timestamp_granularities or "word" in timestamp_granularities)
    )
    segments_iter, info = globals()["model"].transcribe(  # avoid shadowing the form param
        audio_buf,
        language=language,
        temperature=temperature,
        initial_prompt=prompt,
        beam_size=5,
        word_timestamps=want_words,
        vad_filter=True if response_format == "verbose_json" else False,
    )
    # Materialise the generator once — it can only be iterated once.
    segments = list(segments_iter)
    text = "".join(s.text for s in segments).strip()
    if response_format == "text":
        return PlainTextResponse(text)
    if response_format == "verbose_json":
        seg_list = []
        word_list = []
        for s in segments:
            seg_words = []
            if want_words and getattr(s, "words", None):
                for w in s.words:
                    word = {"word": w.word, "start": float(w.start), "end": float(w.end)}
                    seg_words.append(word)
                    word_list.append(word)
            seg_list.append({
                "id": s.id,
                "start": float(s.start),
                "end": float(s.end),
                "text": s.text,
                **({"words": seg_words} if want_words else {}),
            })
        return JSONResponse({
            "text": text,
            "language": getattr(info, "language", language) or "",
            "duration": float(getattr(info, "duration", 0.0) or 0.0),
            "segments": seg_list,
            **({"words": word_list} if want_words else {}),
        })
    return JSONResponse({"text": text})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
