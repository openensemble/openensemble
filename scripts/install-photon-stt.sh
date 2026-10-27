#!/usr/bin/env bash
# Install a pinned Photon runtime and model. OE starts it only when selected.
set -euo pipefail
OE_HOME="${OE_HOME:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
VARIANT="${PHOTON_VARIANT:-ultra}"
DEVICE="${PHOTON_DEVICE:-cuda}"
case "$VARIANT" in ultra) PORT=5158 ;; redux) PORT=5159 ;; *) echo 'Unknown Photon model' >&2; exit 2 ;; esac
case "$DEVICE" in cpu|cuda) ;; *) echo 'Profile must be cpu or cuda' >&2; exit 2 ;; esac
if [ "$VARIANT" = ultra ] && [ "$DEVICE" != cuda ]; then echo 'Ultra requires the GPU profile' >&2; exit 2; fi
GPU_ID="${PHOTON_GPU_ID:-}"
if [ -n "$GPU_ID" ] && [[ ! "$GPU_ID" =~ ^[0-9]+$ ]]; then echo 'Invalid GPU index' >&2; exit 2; fi
VENV="$OE_HOME/runtime/photon-stt-$DEVICE-venv"
MODEL_DIR="$OE_HOME/models/stt/photon"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE="photon-$VARIANT.service"
step() { echo "[photon-install] $*"; }
fail() { echo "[photon-install] $*" >&2; exit 2; }

command -v systemctl >/dev/null || fail 'Linux with systemd user services is required.'
systemctl --user list-units --no-pager >/dev/null 2>&1 || fail 'systemd user services are unavailable.'
command -v flock >/dev/null || fail 'Install util-linux (flock), then retry.'
mkdir -p "$OE_HOME/runtime" "$MODEL_DIR" "$SERVICE_DIR"
exec 9>"$OE_HOME/runtime/photon-stt-install.lock"
flock -n 9 || fail 'Another Photon install or uninstall is running.'
bash "$OE_HOME/scripts/ensure-python-venv.sh"
python3 -c 'import sys; assert (3,10) <= sys.version_info[:2] <= (3,13), "Photon installer requires Python 3.10–3.13"'
if [ "$DEVICE" = cuda ]; then
  command -v nvidia-smi >/dev/null || fail 'Install NVIDIA drivers first, or choose Redux CPU.'
  nvidia-smi -L >/dev/null || fail 'NVIDIA driver cannot detect a GPU.'
fi
if [ ! -x "$VENV/bin/python" ]; then python3 -m venv "$VENV"; fi
step 'Installing the shared Photon runtime (several GB on first install)...'
"$VENV/bin/python" -m pip install --no-cache-dir --quiet --upgrade pip
if [ "$DEVICE" = cuda ]; then TORCH_INDEX=https://download.pytorch.org/whl/cu128
else TORCH_INDEX=https://download.pytorch.org/whl/cpu; fi
"$VENV/bin/python" -m pip install --no-cache-dir --quiet 'torch==2.8.0' --index-url "$TORCH_INDEX"
"$VENV/bin/python" -m pip install --no-cache-dir --quiet 'kestrel==0.9.1' 'faster-whisper==1.2.1' 'av==17.0.1' 'soundfile==0.13.1' fastapi uvicorn python-multipart

if [ "$DEVICE" = cuda ]; then
  CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES="${GPU_ID:-0}" "$VENV/bin/python" - <<'PY'
import torch
assert torch.cuda.is_available(), "CUDA is unavailable; check your NVIDIA driver."
assert torch.cuda.get_device_capability()[0] >= 8, "Photon requires an NVIDIA Ampere or newer GPU."
print("[photon-install] GPU:", torch.cuda.get_device_name())
PY
fi

step "Downloading Parakeet $VARIANT and preparing Silero..."
HF_HOME="$MODEL_DIR" HF_HUB_DISABLE_TELEMETRY=1 "$VENV/bin/python" - "$VARIANT" <<'PY'
import sys
from pathlib import Path
from huggingface_hub import snapshot_download
from faster_whisper.vad import get_vad_model
variant = sys.argv[1]
revision = {"ultra": "73175eb7aeb0d82f1e2a6b53b3aabc10a90bcd0b", "redux": "2bf128600aac4b16946f7ed8372e56117fe5e23b"}[variant]
snapshot = Path(snapshot_download(f"moondream/parakeet-{variant}", revision=revision,
    allow_patterns=["config.json", "tokenizer.json", "model.safetensors", "ternary.json"]))
# Kestrel resolves these model names at 'main'. Pin that ref in this private
# cache so offline service starts keep using the reviewed checkpoint.
refs = snapshot.parent.parent / "refs"
refs.mkdir(exist_ok=True)
(refs / "main").write_text(revision)
get_vad_model()
print("[photon-install] Model and Silero are cached.")
PY

# Writing a unit does not start it. Install & use performs the verified switch.
step "Writing $SERVICE..."
cat > "$SERVICE_DIR/$SERVICE" <<UNIT
[Unit]
Description=OpenEnsemble Photon $VARIANT + Silero STT
After=network.target

[Service]
Type=simple
ExecStart="$VENV/bin/python" "$OE_HOME/scripts/photon-stt-server.py"
Restart=on-failure
RestartSec=3
Environment=PYTHONUNBUFFERED=1
Environment=PHOTON_VARIANT=$VARIANT
Environment=PHOTON_DEVICE=$DEVICE
Environment=PHOTON_PORT=$PORT
Environment="HF_HOME=$MODEL_DIR"
Environment=HF_HUB_OFFLINE=1
Environment=OMP_NUM_THREADS=4
Environment=MKL_NUM_THREADS=4
Environment=OPENBLAS_NUM_THREADS=4
Environment=OMP_WAIT_POLICY=passive
Environment=CUDA_DEVICE_ORDER=PCI_BUS_ID
Environment=CUDA_VISIBLE_DEVICES=${GPU_ID:-0}

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
step 'Installed. OpenEnsemble will start and verify the selected model.'
