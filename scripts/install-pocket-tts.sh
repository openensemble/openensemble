#!/usr/bin/env bash
# scripts/install-pocket-tts.sh
#
# Idempotent installer for the local Pocket TTS service (Kyutai pocket-tts) used
# by OpenEnsemble's TTS path. CPU-only, 100M params, zero-shot voice cloning.
# Re-running is safe — existing venv / weights / service are detected and skipped.
#
# Called by:
#   - install.sh (interactive y/N prompt during initial setup)
#   - routes/config.mjs POST /api/provider-config/install-pocket-tts (SSE-streamed)
#
# Weights: the voice-cloning model is mirrored (non-gated, CC-BY-4.0) at
# openensemble/pocket-tts so users never hit the upstream HF gate. The tokenizer
# and non-cloning weights come from the upstream NON-gated
# kyutai/pocket-tts-without-voice-cloning repo. Everything is pre-fetched into a
# private HF cache under the model dir, then the service runs HF_HUB_OFFLINE=1.
#
# Original model © Kyutai Labs (https://github.com/kyutai-labs/pocket-tts), CC-BY-4.0.
# Users must have lawful consent to clone any voice — surfaced in the OE UI.
#
# Exit codes: 0 ok (responding on PORT) | 1 generic | 2 missing prereq
#
# Env overrides (optional):
#   OE_HOME            default $HOME/.openensemble
#   POCKET_TTS_PORT    default 5155
#   POCKET_TTS_MIRROR  default openensemble/pocket-tts

set -eu

OE_HOME="${OE_HOME:-$HOME/.openensemble}"
VENV="$OE_HOME/runtime/pocket-tts-venv"
MODEL_DIR="$OE_HOME/models/tts/pocket-tts"
HF_CACHE="$MODEL_DIR/hf"
CONFIG_OUT="$MODEL_DIR/english.yaml"
PORT="${POCKET_TTS_PORT:-5155}"
MIRROR="${POCKET_TTS_MIRROR:-openensemble/pocket-tts}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="pocket-tts.service"
SERVER_SCRIPT="$OE_HOME/scripts/pocket-tts-server.py"

step()  { echo "[pocket-tts-install] $*"; }
fail()  { echo "[pocket-tts-install] FAIL: $*" >&2; exit "${2:-1}"; }

# ── prerequisites ─────────────────────────────────────────────────────────────
step "Checking dependencies..."
command -v python3 >/dev/null    || fail "python3 not found" 2
command -v systemctl >/dev/null  || fail "systemctl not found (need systemd-user)" 2
python3 -c 'import venv'      2>/dev/null || fail "python3 'venv' missing — sudo apt install -y python3-full" 2
python3 -c 'import ensurepip' 2>/dev/null || fail "python3 'ensurepip' missing — sudo apt install -y python3-full" 2
systemctl --user list-units --no-pager >/dev/null 2>&1 \
                                 || fail "systemd --user not running" 2
[ -f "$SERVER_SCRIPT" ] || fail "pocket-tts-server.py not found at $SERVER_SCRIPT" 2

# ── venv + pip ────────────────────────────────────────────────────────────────
if [ ! -x "$VENV/bin/python" ]; then
  step "Creating venv at $VENV..."
  mkdir -p "$(dirname "$VENV")"
  python3 -m venv "$VENV"
fi
step "Upgrading pip..."
"$VENV/bin/pip" install --quiet --upgrade pip wheel
step "Installing CPU torch (avoids the multi-GB CUDA build — Pocket TTS is CPU-only)..."
"$VENV/bin/pip" install --quiet torch --index-url https://download.pytorch.org/whl/cpu
step "Installing pocket-tts + fastapi + uvicorn (first run can take a few minutes)..."
"$VENV/bin/pip" install --quiet pocket-tts fastapi uvicorn scipy

# ── generate mirror-pointed config (version-matched to installed package) ──────
mkdir -p "$MODEL_DIR" "$HF_CACHE"
pkg_cfg="$("$VENV/bin/python" -c 'import os,pocket_tts; print(os.path.join(os.path.dirname(pocket_tts.__file__),"config","english.yaml"))')"
[ -f "$pkg_cfg" ] || fail "packaged english.yaml not found at $pkg_cfg (pocket-tts layout changed?)"
step "Writing mirror-pointed config -> $CONFIG_OUT"
sed -E "s#^weights_path: hf://kyutai/pocket-tts/languages/english/model.safetensors@.*#weights_path: hf://${MIRROR}/languages/english/model.safetensors#" \
  "$pkg_cfg" > "$CONFIG_OUT"
grep -q "hf://${MIRROR}/" "$CONFIG_OUT" || fail "config rewrite failed — upstream weights_path line changed"

# ── pre-fetch weights into the private HF cache (no token, non-gated) ──────────
step "Pre-fetching weights (mirror model + upstream tokenizer/non-cloning, ~225 MB)..."
HF_HOME="$HF_CACHE" HF_TOKEN="" "$VENV/bin/python" - "$CONFIG_OUT" <<'PY' || fail "weight pre-fetch failed"
import sys, yaml, re
from pocket_tts.utils.utils import download_if_necessary  # resolves hf:// → local cache
cfg = yaml.safe_load(open(sys.argv[1]))
paths = [cfg["weights_path"], cfg["weights_path_without_voice_cloning"],
         cfg["flow_lm"]["lookup_table"]["tokenizer_path"]]
for p in paths:
    print("  fetch", p, flush=True)
    download_if_necessary(p)
print("  prefetch ok")
PY

# ── OE Default voice (bundled offline voice-state) ────────────────────────────
# New users get a working voice with no HF account/network: a pre-computed
# Pocket TTS speaker state hosted (non-gated) on the mirror. Used by the server
# when a slot has no cloned voice and no global default is set.
step "Downloading OE Default voice-state (~11 MB)..."
default_state="$MODEL_DIR/default-voice.safetensors"
if [ ! -s "$default_state" ]; then
  default_url="https://huggingface.co/${MIRROR}/resolve/main/default-voice.safetensors"
  if command -v wget >/dev/null; then wget --quiet -O "$default_state" "$default_url" || { rm -f "$default_state"; fail "OE Default voice download failed"; }
  else curl -fL -o "$default_state" "$default_url" || { rm -f "$default_state"; fail "OE Default voice download failed"; }
  fi
fi

# ── systemd unit ──────────────────────────────────────────────────────────────
mkdir -p "$SERVICE_DIR"
unit_path="$SERVICE_DIR/$SERVICE_NAME"
step "Writing $unit_path..."
cat > "$unit_path" <<UNIT
[Unit]
Description=Pocket TTS HTTP server (local CPU, zero-shot voice cloning) — OpenEnsemble
After=network.target

[Service]
Type=simple
ExecStart=$VENV/bin/python $SERVER_SCRIPT
Restart=on-failure
RestartSec=3
Environment=PYTHONUNBUFFERED=1
Environment=POCKET_TTS_PORT=$PORT
Environment=POCKET_TTS_CONFIG=$CONFIG_OUT
Environment=HF_HOME=$HF_CACHE
Environment=HF_HUB_OFFLINE=1
Environment=CUDA_VISIBLE_DEVICES=

[Install]
WantedBy=default.target
UNIT

step "Reloading systemd-user daemon..."
systemctl --user daemon-reload

# Install only — the service is NOT started here. The selected TTS provider is
# started when the user hits Save (POST /api/provider-config), which first stops
# any other running TTS service so exactly one local TTS runs at a time.
step "OK — Pocket TTS installed. Unit $SERVICE_NAME is ready; it starts when you select Pocket TTS and Save."
exit 0
