#!/usr/bin/env bash
# scripts/install-faster-whisper.sh
#
# Idempotent installer for the local Faster-Whisper STT service used by
# OpenEnsemble's voice-device path. Re-running is safe — already-created
# venv + downloaded model + existing service are detected and skipped.
#
# Two profiles, picked via FW_DEVICE — same model in both, different runtime:
#
#   FW_DEVICE=cpu  → large-v3-turbo, int8 quant, ~810 MB on disk + ~2 GB RAM
#                    at runtime. No GPU needed. Speed varies by CPU: a modern
#                    desktop CPU runs ~2-3× faster than real-time; older or
#                    low-end CPUs land closer to real-time on long clips.
#   FW_DEVICE=cuda → large-v3-turbo, float16, ~810 MB model + ~2 GB of NVIDIA
#                    CUDA runtime libs (nvidia-cublas-cu12 + cudnn) + ~2.5 GB
#                    of VRAM at runtime. Requires a working NVIDIA driver
#                    (probed via nvidia-smi). ~14-40× faster than realtime.
#
# Called by:
#   - routes/config.mjs POST /api/provider-config/install-faster-whisper
#     (SSE-streamed for the in-app "Install" button; the route passes
#     FW_DEVICE in the spawn env based on which install button the user clicked)
#   - skills/oe-admin/integrations/faster-whisper.json (oe-admin recipe)
#
# Exit codes:
#   0 — success, faster-whisper.service is running and responding on 5154
#   1 — generic failure
#   2 — missing prerequisite
#
# Env overrides (all optional):
#   OE_HOME            default $HOME/.openensemble
#   FW_DEVICE          cpu | cuda (default cpu)
#   FW_MODEL           override the auto-picked model
#   FW_PORT            default 5154

set -eu

OE_HOME="${OE_HOME:-$HOME/.openensemble}"
VENV="$OE_HOME/runtime/faster-whisper-venv"
MODEL_CACHE_DIR="$OE_HOME/models/stt/faster-whisper"
PORT="${FW_PORT:-5154}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="faster-whisper.service"
SERVER_SCRIPT="$OE_HOME/scripts/faster-whisper-server.py"

FW_DEVICE="${FW_DEVICE:-cpu}"
case "$FW_DEVICE" in
  cpu|cuda) ;;
  *) echo "[fw-install] FAIL: FW_DEVICE must be cpu or cuda, got $FW_DEVICE" >&2; exit 1 ;;
esac

# Both profiles use large-v3-turbo. distil-large-v3 was tested as the CPU
# default but quality was meaningfully worse (Tree/Three confusion, "trademark
# file lane" type errors) while runtime speed barely changed — large-v3-turbo
# int8 is only ~30% slower than distil int8 on CPU for the same audio, and
# the per-request overhead dominates on short voice-device utterances anyway.
# Caller can still override with FW_MODEL for experiments.
FW_MODEL="${FW_MODEL:-large-v3-turbo}"
if [ "$FW_DEVICE" = "cuda" ]; then
  FW_COMPUTE_TYPE="float16"
else
  FW_COMPUTE_TYPE="int8"
fi

step()  { echo "[fw-install] $*"; }
fail()  { echo "[fw-install] FAIL: $*" >&2; exit "${2:-1}"; }

# ── prerequisites ─────────────────────────────────────────────────────────────
step "Checking dependencies (device=$FW_DEVICE, model=$FW_MODEL)..."
command -v python3 >/dev/null   || fail "python3 not found" 2
command -v wget    >/dev/null || command -v curl >/dev/null \
                                || fail "wget or curl required for model download" 2
command -v systemctl >/dev/null || fail "systemctl not found (need systemd-user)" 2
python3 -c 'import venv' 2>/dev/null \
                                || fail "python3 'venv' module missing — run: sudo apt install -y python3-full" 2
python3 -c 'import ensurepip' 2>/dev/null \
                                || fail "python3 'ensurepip' module missing — run: sudo apt install -y python3-full" 2
systemctl --user list-units --no-pager >/dev/null 2>&1 \
                                || fail "systemd --user not running — see install.sh user_manager_ready check" 2

[ -f "$SERVER_SCRIPT" ] || fail "faster-whisper-server.py not found at $SERVER_SCRIPT (corrupt install dir?)" 2

# GPU profile: require an NVIDIA driver. CTranslate2 + cuDNN can be pip-installed,
# but the kernel driver has to already be there. Fail loudly rather than installing
# 2 GB of libs that won't work.
if [ "$FW_DEVICE" = "cuda" ]; then
  command -v nvidia-smi >/dev/null \
    || fail "FW_DEVICE=cuda but nvidia-smi not found — install NVIDIA drivers first, or use FW_DEVICE=cpu" 2
  nvidia-smi -L >/dev/null 2>&1 \
    || fail "FW_DEVICE=cuda but nvidia-smi failed — no GPU detected or driver mismatch" 2
fi

# ── venv + pip install ────────────────────────────────────────────────────────
# Profile-switch detection: if an existing unit file shows a different
# FW_DEVICE than what we're installing for, tear down the venv so the
# new profile's pip install is clean (CPU→GPU adds 2 GB of NVIDIA libs,
# GPU→CPU strands them in the venv otherwise).
if [ -x "$VENV/bin/python" ] && [ -f "$SERVICE_DIR/$SERVICE_NAME" ]; then
  prev_device=$(grep -oP '(?<=^Environment=FW_DEVICE=)\w+' "$SERVICE_DIR/$SERVICE_NAME" 2>/dev/null || echo "")
  if [ -n "$prev_device" ] && [ "$prev_device" != "$FW_DEVICE" ]; then
    step "Switching profile ($prev_device → $FW_DEVICE) — stopping service + rebuilding venv..."
    systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
    rm -rf "$VENV"
  fi
fi
if [ ! -x "$VENV/bin/python" ]; then
  step "Creating venv at $VENV..."
  mkdir -p "$(dirname "$VENV")"
  python3 -m venv "$VENV"
fi

step "Upgrading pip..."
"$VENV/bin/pip" install --quiet --upgrade pip wheel

# Profile-specific dep set. CTranslate2 bundles CPU runtime libs but needs
# NVIDIA's cuBLAS + cuDNN for CUDA — installed as pip packages so we don't
# touch system /usr/local/cuda.
if [ "$FW_DEVICE" = "cuda" ]; then
  step "Installing faster-whisper + NVIDIA CUDA runtime libs (~2 GB on disk)..."
  "$VENV/bin/pip" install --quiet \
    faster-whisper \
    nvidia-cublas-cu12 nvidia-cudnn-cu12 \
    fastapi "uvicorn[standard]" python-multipart
else
  step "Installing faster-whisper (CPU only)..."
  "$VENV/bin/pip" install --quiet \
    faster-whisper \
    fastapi "uvicorn[standard]" python-multipart
fi

# ── model pre-download ───────────────────────────────────────────────────────
# WhisperModel() pulls the CTranslate2-format model from HF on first construct.
# Force device=cpu/compute=int8 just for the download so we don't pay VRAM
# warmup twice (this process exits and the service re-loads with the real
# device). The HF cache is shared between this run and the service runtime.
mkdir -p "$MODEL_CACHE_DIR"
step "Pre-downloading model $FW_MODEL (this can take a minute on first install)..."
"$VENV/bin/python" - <<PY
from faster_whisper import WhisperModel
WhisperModel("$FW_MODEL", device="cpu", compute_type="int8", download_root="$MODEL_CACHE_DIR")
print("[fw-install] model files cached at $MODEL_CACHE_DIR")
PY

# ── systemd unit ──────────────────────────────────────────────────────────────
# For CUDA, the pip-installed NVIDIA libs ship .so files under
# .venv/lib/python<X.Y>/site-packages/nvidia/{cublas,cudnn}/lib. CTranslate2
# dlopen()s them at runtime, so we hand the path to systemd via
# LD_LIBRARY_PATH on the Environment line.
PY_VER=$("$VENV/bin/python" -c 'import sys; print(f"python{sys.version_info[0]}.{sys.version_info[1]}")')
LD_PATH=""
if [ "$FW_DEVICE" = "cuda" ]; then
  LD_PATH="$VENV/lib/$PY_VER/site-packages/nvidia/cublas/lib:$VENV/lib/$PY_VER/site-packages/nvidia/cudnn/lib"
fi

mkdir -p "$SERVICE_DIR"
unit_path="$SERVICE_DIR/$SERVICE_NAME"
step "Writing $unit_path..."
cat > "$unit_path" <<UNIT
[Unit]
Description=Faster-Whisper STT server ($FW_MODEL on $FW_DEVICE) — OpenEnsemble
After=network.target

[Service]
Type=simple
ExecStart=$VENV/bin/python $SERVER_SCRIPT
Restart=on-failure
RestartSec=3
Environment=PYTHONUNBUFFERED=1
Environment=FW_PORT=$PORT
Environment=FW_MODEL=$FW_MODEL
Environment=FW_DEVICE=$FW_DEVICE
Environment=FW_COMPUTE_TYPE=$FW_COMPUTE_TYPE
Environment=FW_DOWNLOAD_DIR=$MODEL_CACHE_DIR
${LD_PATH:+Environment=LD_LIBRARY_PATH=$LD_PATH}
${CUDA_VISIBLE_DEVICES:+Environment=CUDA_VISIBLE_DEVICES=$CUDA_VISIBLE_DEVICES}

[Install]
WantedBy=default.target
UNIT

step "Reloading systemd-user daemon..."
systemctl --user daemon-reload

step "Enabling + starting $SERVICE_NAME..."
systemctl --user enable --now "$SERVICE_NAME"

# ── verify ────────────────────────────────────────────────────────────────────
# Model load takes 5-15 s on CPU, 3-8 s on GPU (warm HF cache). Give it 60 s
# to be safe before deciding the service is actually broken.
step "Waiting for Faster-Whisper to come up on 127.0.0.1:$PORT (model load ~10 s)..."
for i in $(seq 1 60); do
  if command -v curl >/dev/null; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/" || true)
    case "$code" in
      2*|3*|4*|5*) step "OK — faster-whisper responding (HTTP $code)"; exit 0 ;;
    esac
  fi
  sleep 1
done

echo "[fw-install] last 30 service log lines:" >&2
journalctl --user -u "$SERVICE_NAME" --no-pager -n 30 >&2 || true
fail "service started but didn't respond on 127.0.0.1:$PORT after 60 s"
