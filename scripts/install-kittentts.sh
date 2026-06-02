#!/usr/bin/env bash
# scripts/install-kittentts.sh
#
# Idempotent installer for the local KittenTTS service used by OpenEnsemble's
# voice-device path. Re-running is safe — already-created venv + downloaded
# model + existing service are detected and skipped.
#
# Called by:
#   - install.sh (interactive y/N prompt during initial setup)
#   - routes/config.mjs POST /api/provider-config/install-kittentts (SSE-streamed
#     for the in-app "Install KittenTTS" button)
#   - skills/oe-admin/integrations/kittentts.json (oe-admin recipe — coordinator path)
#
# KittenTTS is a 25M-param ONNX model with 8 preset voices. CPU only, no GPU
# needed, no API key, no system espeak-ng (the espeakng-loader pip package
# bundles the .so library and data files).
#
# Output is plain-text progress lines, one step per line, so the SSE pipeline
# can stream them straight to the UI without parsing.
#
# Exit codes:
#   0 — success, kittentts.service is running and responding on 5153
#   1 — generic failure (see stderr for the failing step)
#   2 — missing prerequisite (python3, python3-venv, systemd, etc.)
#
# Env overrides (all optional):
#   OE_HOME            default $HOME/.openensemble
#   KITTENTTS_PORT     default 5153

set -eu

OE_HOME="${OE_HOME:-$HOME/.openensemble}"
VENV="$OE_HOME/runtime/kittentts-venv"
MODEL_DIR="$OE_HOME/models/tts/kittentts"
PORT="${KITTENTTS_PORT:-5153}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="kittentts.service"
SERVER_SCRIPT="$OE_HOME/scripts/kittentts-server.py"

# HuggingFace location of the nano-0.2 model + voice embeddings.
HF_REPO="KittenML/kitten-tts-nano-0.2"
HF_BASE="https://huggingface.co/$HF_REPO/resolve/main"
MODEL_FILE="kitten_tts_nano_v0_2.onnx"
VOICES_FILE="voices.npz"

step()  { echo "[kittentts-install] $*"; }
fail()  { echo "[kittentts-install] FAIL: $*" >&2; exit "${2:-1}"; }

# ── prerequisites ─────────────────────────────────────────────────────────────
step "Checking dependencies..."
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

[ -f "$SERVER_SCRIPT" ] || fail "kittentts-server.py not found at $SERVER_SCRIPT (corrupt install dir?)" 2

# ── venv + pip install ────────────────────────────────────────────────────────
if [ ! -x "$VENV/bin/python" ]; then
  step "Creating venv at $VENV..."
  mkdir -p "$(dirname "$VENV")"
  python3 -m venv "$VENV"
fi

step "Upgrading pip..."
"$VENV/bin/pip" install --quiet --upgrade pip wheel

# kittentts pulls onnxruntime + phonemizer + espeakng-loader (bundles the .so,
# no system espeak-ng required). fastapi/uvicorn/python-multipart/soundfile
# host the HTTP server. Idempotent: pip no-ops on already-satisfied packages.
step "Installing kittentts + fastapi + uvicorn (this can take a minute the first time)..."
"$VENV/bin/pip" install --quiet kittentts fastapi uvicorn python-multipart soundfile

# ── model download ────────────────────────────────────────────────────────────
mkdir -p "$MODEL_DIR"
model_path="$MODEL_DIR/$MODEL_FILE"
voices_path="$MODEL_DIR/$VOICES_FILE"

download() {
  # Usage: download <url> <dest>. Tries wget then curl.
  local url="$1" dest="$2"
  if command -v wget >/dev/null; then
    wget --quiet --show-progress -O "$dest" "$url"
  else
    curl -fL --progress-bar -o "$dest" "$url"
  fi
}

if [ ! -s "$model_path" ]; then
  step "Downloading $MODEL_FILE (~25 MB) from HuggingFace..."
  download "$HF_BASE/$MODEL_FILE" "$model_path" \
    || { rm -f "$model_path"; fail "model .onnx download failed"; }
fi
if [ ! -s "$voices_path" ]; then
  step "Downloading $VOICES_FILE (voice embeddings)..."
  download "$HF_BASE/$VOICES_FILE" "$voices_path" \
    || { rm -f "$voices_path"; fail "voices.npz download failed"; }
fi

# ── systemd unit ──────────────────────────────────────────────────────────────
mkdir -p "$SERVICE_DIR"
unit_path="$SERVICE_DIR/$SERVICE_NAME"
step "Writing $unit_path..."
cat > "$unit_path" <<UNIT
[Unit]
Description=KittenTTS HTTP server (local CPU ONNX, 8 preset voices) — OpenEnsemble
After=network.target

[Service]
Type=simple
ExecStart=$VENV/bin/python $SERVER_SCRIPT
Restart=on-failure
RestartSec=3
Environment=PYTHONUNBUFFERED=1
Environment=KITTENTTS_PORT=$PORT
Environment=KITTENTTS_MODEL=$model_path
Environment=KITTENTTS_VOICES=$voices_path

[Install]
WantedBy=default.target
UNIT

step "Reloading systemd-user daemon..."
systemctl --user daemon-reload

step "Enabling + starting $SERVICE_NAME..."
systemctl --user enable --now "$SERVICE_NAME"

# ── verify ────────────────────────────────────────────────────────────────────
step "Waiting for KittenTTS to come up on 127.0.0.1:$PORT..."
for i in $(seq 1 30); do
  if command -v curl >/dev/null; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/" || true)
    case "$code" in
      2*|3*|4*|5*) step "OK — kittentts responding (HTTP $code)"; exit 0 ;;
    esac
  fi
  sleep 1
done

# 30 s and still nothing — surface journalctl tail for debugging.
echo "[kittentts-install] last 20 service log lines:" >&2
journalctl --user -u "$SERVICE_NAME" --no-pager -n 20 >&2 || true
fail "service started but didn't respond on 127.0.0.1:$PORT after 30 s"
