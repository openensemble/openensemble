#!/usr/bin/env bash
# install-llama-server.sh — install a GPU-pinned local llama.cpp model server
# (cortex or plan) as a systemd --user service. No build, no sudo: it runs
# scripts/llama-node-server.mjs (node-llama-cpp, Vulkan prebuilt). Mirrors the
# faster-whisper STT service shape; the GPU pin is the GGML_VK_VISIBLE_DEVICES
# env, rewritten later by routes/config.mjs pinServiceGpu().
#
# Env:
#   OE_LLAMA_KIND    plan | cortex                    (required)
#   OE_LLAMA_GPU_ID  Vulkan device index to pin       (default 0)
#   OE_LLAMA_MODEL   override the .gguf filename       (optional)
# One progress line per step (SSE-friendly).
set -euo pipefail

OE_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KIND="${OE_LLAMA_KIND:-}"
GPU_ID="${OE_LLAMA_GPU_ID:-0}"

case "$KIND" in
  plan)   SERVICE="oe-plan-llama";   PORT=5156; DEFAULT_MODEL="openensemble-plan-360m-extract-v1.q8_0.gguf" ;;
  cortex) SERVICE="oe-cortex-llama"; PORT=5157; DEFAULT_MODEL="openensemble-reason-v3.q8_0.gguf" ;;
  *) echo "error: OE_LLAMA_KIND must be 'plan' or 'cortex' (got '$KIND')"; exit 2 ;;
esac
MODEL="${OE_LLAMA_MODEL:-$DEFAULT_MODEL}"
MODEL_PATH="$OE_HOME/models/$MODEL"

echo "[install-llama-$KIND] service=$SERVICE port=$PORT gpu=$GPU_ID model=$MODEL"

# Preflight
command -v node >/dev/null   || { echo "error: node not on PATH"; exit 1; }
command -v systemctl >/dev/null || { echo "error: systemctl not found"; exit 1; }
systemctl --user show-environment >/dev/null 2>&1 || { echo "error: 'systemctl --user' unavailable (no user systemd)"; exit 1; }
NODE_BIN="$(command -v node)"
[ -f "$MODEL_PATH" ] || { echo "error: model not found at $MODEL_PATH — run the model fetch first"; exit 1; }
echo "[install-llama-$KIND] node=$NODE_BIN model ok ($(stat -c%s "$MODEL_PATH") bytes)"

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/$SERVICE.service"
mkdir -p "$UNIT_DIR"
echo "[install-llama-$KIND] writing unit $UNIT"
cat > "$UNIT" <<UNITEOF
[Unit]
Description=OpenEnsemble $KIND model — local llama.cpp GPU server (node-llama-cpp, Vulkan)
After=network.target

[Service]
Type=simple
# OE GPU pin (managed by Settings → $KIND model)
Environment=GGML_VK_VISIBLE_DEVICES=$GPU_ID
Environment=OE_LLAMA_MODEL=$MODEL_PATH
Environment=OE_LLAMA_PORT=$PORT
Environment=OE_LLAMA_GPU=vulkan
Environment=OE_LLAMA_NAME=$MODEL
WorkingDirectory=$OE_HOME
ExecStart=$NODE_BIN $OE_HOME/scripts/llama-node-server.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
UNITEOF

echo "[install-llama-$KIND] daemon-reload + enable --now"
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE.service"

echo "[install-llama-$KIND] waiting for http://127.0.0.1:$PORT/health (model load) ..."
for i in $(seq 1 60); do
  if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "[install-llama-$KIND] healthy on port $PORT (GPU $GPU_ID)"
    exit 0
  fi
  sleep 1
done
echo "[install-llama-$KIND] WARNING: service did not become healthy in 60s — check 'journalctl --user -u $SERVICE.service'"
exit 1
