#!/usr/bin/env bash
# scripts/install-piper.sh
#
# Idempotent installer for the local Piper TTS service used by OpenEnsemble's
# voice-device path. Re-running is safe — already-created venv + downloaded
# model + existing service are detected and skipped.
#
# Called by:
#   - install.sh (interactive y/N prompt during initial setup)
#   - routes/config.mjs POST /api/provider-config/install-piper (SSE-streamed
#     for the in-app "Install Piper" button)
#
# Output is plain-text progress lines, one step per line, so the SSE
# pipeline can stream them straight to the UI without parsing.
#
# Exit codes:
#   0 — success, piper-tts.service is running and responding on 5151
#   1 — generic failure (see stderr for the failing step)
#   2 — missing prerequisite (python3, python3-venv, systemd, etc.)
#
# Env overrides (all optional):
#   OE_HOME              default $HOME/.openensemble
#   PIPER_VOICE          default en_US-libritts_r-medium. Naming convention is
#                        <lang_REGION>-<name>-<quality>; HF layout
#                        /<lang>/<lang_REGION>/<name>/<quality>/ is derived from
#                        the voice name. en_AU-OE_custom-* maps to OE's HF repo
#                        (openensemble/piper-voices); everything else uses
#                        rhasspy/piper-voices.
#   PIPER_VOICE_URL_BASE override the HF base URL entirely (no trailing slash).
#                        Useful for self-hosted voices or unreleased forks.
#   PIPER_PORT           default 5151

set -eu

OE_HOME="${OE_HOME:-$HOME/.openensemble}"
PIPER_VENV="$OE_HOME/runtime/piper-venv"
MODEL_DIR="$OE_HOME/models/tts"
PIPER_VOICE="${PIPER_VOICE:-en_US-libritts_r-medium}"
PIPER_PORT="${PIPER_PORT:-5151}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="piper-tts.service"

# Derive the HF model path from PIPER_VOICE. Convention is
# <lang_REGION>-<name>-<quality>, mirrored on HF as /<lang>/<lang_REGION>/<name>/<quality>/.
voice_lang_region="${PIPER_VOICE%%-*}"          # en_US
voice_rest="${PIPER_VOICE#*-}"                  # libritts_r-medium
voice_quality="${voice_rest##*-}"               # medium
voice_name="${voice_rest%-*}"                   # libritts_r
voice_lang="${voice_lang_region%_*}"            # en

# OE-hosted custom voices live under openensemble/piper-voices; everything else
# falls back to the official rhasspy/piper-voices repo. PIPER_VOICE_URL_BASE
# overrides both for self-hosted setups.
case "$PIPER_VOICE" in
  en_AU-OE_custom-*) default_repo="https://huggingface.co/openensemble/piper-voices/resolve/main" ;;
  *)                 default_repo="https://huggingface.co/rhasspy/piper-voices/resolve/main" ;;
esac
HF_BASE="${PIPER_VOICE_URL_BASE:-$default_repo}/$voice_lang/$voice_lang_region/$voice_name/$voice_quality"

step()  { echo "[piper-install] $*"; }
fail()  { echo "[piper-install] FAIL: $*" >&2; exit "${2:-1}"; }

# ── prerequisites ─────────────────────────────────────────────────────────────
step "Checking dependencies..."
command -v python3 >/dev/null   || fail "python3 not found" 2
command -v wget    >/dev/null || command -v curl >/dev/null \
                                || fail "wget or curl required for model download" 2
command -v systemctl >/dev/null || fail "systemctl not found (need systemd-user)" 2
python3 -c 'import venv' 2>/dev/null \
                                || fail "python3 'venv' module missing — run: sudo apt install -y python3-full" 2
# `import venv` returns OK on a minimal Debian even when ensurepip isn't
# available — but `python3 -m venv …` then fails with "ensurepip is not
# available". Check ensurepip directly to catch this before we try to
# build the venv. On Debian/Ubuntu the fix is `apt install python3-full`
# (the meta-package that pulls in the version-specific venv + ensurepip).
python3 -c 'import ensurepip' 2>/dev/null \
                                || fail "python3 'ensurepip' module missing — run: sudo apt install -y python3-full" 2
systemctl --user list-units --no-pager >/dev/null 2>&1 \
                                || fail "systemd --user not running — see install.sh user_manager_ready check" 2

# ── venv + pip install ────────────────────────────────────────────────────────
if [ ! -x "$PIPER_VENV/bin/python" ]; then
  step "Creating venv at $PIPER_VENV..."
  mkdir -p "$(dirname "$PIPER_VENV")"
  python3 -m venv "$PIPER_VENV"
fi

step "Upgrading pip..."
"$PIPER_VENV/bin/pip" install --quiet --upgrade pip wheel

# piper-tts gives us PiperVoice/SynthesisConfig for in-process synthesis;
# fastapi+uvicorn is what scripts/piper-multivoice-server.py runs on (replaces
# the upstream piper.http_server which can't multi-voice). Idempotent.
step "Installing piper-tts + fastapi + uvicorn (this can take a minute the first time)..."
"$PIPER_VENV/bin/pip" install --quiet piper-tts fastapi "uvicorn[standard]" pydantic

# ── model download ────────────────────────────────────────────────────────────
mkdir -p "$MODEL_DIR"
model_path="$MODEL_DIR/$PIPER_VOICE.onnx"
json_path="$MODEL_DIR/$PIPER_VOICE.onnx.json"

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
  step "Downloading $PIPER_VOICE.onnx from $HF_BASE..."
  download "$HF_BASE/$PIPER_VOICE.onnx" "$model_path" \
    || { rm -f "$model_path"; fail "model .onnx download failed"; }
fi
if [ ! -s "$json_path" ]; then
  step "Downloading $PIPER_VOICE.onnx.json..."
  download "$HF_BASE/$PIPER_VOICE.onnx.json" "$json_path" \
    || { rm -f "$json_path"; fail "model .onnx.json download failed"; }
fi

# ── systemd unit ──────────────────────────────────────────────────────────────
mkdir -p "$SERVICE_DIR"
unit_path="$SERVICE_DIR/$SERVICE_NAME"
step "Writing $unit_path..."
cat > "$unit_path" <<UNIT
[Unit]
Description=Piper TTS HTTP server ($PIPER_VOICE) — OpenEnsemble
After=network.target

[Service]
Type=simple
ExecStart=$PIPER_VENV/bin/python $OE_HOME/scripts/piper-multivoice-server.py
Restart=on-failure
RestartSec=3
Environment=PYTHONUNBUFFERED=1
Environment=PIPER_MODEL_DIR=$MODEL_DIR
Environment=PIPER_PORT=$PIPER_PORT
Environment=PIPER_DEFAULT_VOICE=$PIPER_VOICE

[Install]
WantedBy=default.target
UNIT

step "Reloading systemd-user daemon..."
systemctl --user daemon-reload

step "Enabling + starting $SERVICE_NAME..."
systemctl --user enable --now "$SERVICE_NAME"

# ── verify ────────────────────────────────────────────────────────────────────
step "Waiting for Piper to come up on 127.0.0.1:$PIPER_PORT..."
for i in $(seq 1 30); do
  if command -v curl >/dev/null; then
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PIPER_PORT/" || true)
    case "$code" in
      2*|3*|4*|5*) step "OK — piper responding (HTTP $code)"; exit 0 ;;
    esac
  fi
  sleep 1
done

# 30 s and still nothing — surface journalctl tail for debugging.
echo "[piper-install] last 20 service log lines:" >&2
journalctl --user -u "$SERVICE_NAME" --no-pager -n 20 >&2 || true
fail "service started but didn't respond on 127.0.0.1:$PIPER_PORT after 30 s"
