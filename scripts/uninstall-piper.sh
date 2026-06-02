#!/usr/bin/env bash
# scripts/uninstall-piper.sh
#
# Mirror of scripts/install-piper.sh. Stops the systemd --user service, removes
# the unit file, deletes the venv at $OE_HOME/runtime/piper-venv, and deletes
# the Piper voice model files from $OE_HOME/models/tts/. Idempotent — re-runs
# silently skip already-removed pieces.
#
# Called by:
#   - routes/config.mjs POST /api/provider-config/uninstall-piper
#     (the "Uninstall" button in Settings → Providers → Text-to-Speech)
#
# Output is plain-text progress lines, one step per line, so the calling
# handler can capture stdout and surface it to the client.
#
# Exit codes:
#   0 — success (whether or not all artifacts were present)
#   1 — generic failure (see stderr)
#
# Env overrides (all optional):
#   OE_HOME            default $HOME/.openensemble
#   PIPER_VOICE        default en_US-libritts_r-medium

set -eu

OE_HOME="${OE_HOME:-$HOME/.openensemble}"
PIPER_VENV="$OE_HOME/runtime/piper-venv"
MODEL_DIR="$OE_HOME/models/tts"
PIPER_VOICE="${PIPER_VOICE:-en_US-libritts_r-medium}"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="piper-tts.service"

step()  { echo "[piper-uninstall] $*"; }

# ── stop + disable the service ────────────────────────────────────────────────
if systemctl --user list-unit-files --no-legend "$SERVICE_NAME" 2>/dev/null | grep -q "$SERVICE_NAME"; then
  step "Stopping + disabling $SERVICE_NAME..."
  systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
else
  step "Service $SERVICE_NAME not registered — skipping stop"
fi

# ── remove unit file ──────────────────────────────────────────────────────────
unit_path="$SERVICE_DIR/$SERVICE_NAME"
if [ -f "$unit_path" ]; then
  step "Removing $unit_path..."
  rm -f "$unit_path"
  systemctl --user daemon-reload
else
  step "Unit file not present — skipping"
fi

# ── remove venv ───────────────────────────────────────────────────────────────
if [ -d "$PIPER_VENV" ]; then
  step "Removing venv $PIPER_VENV..."
  rm -rf "$PIPER_VENV"
else
  step "Venv not present — skipping"
fi

# ── remove model files (only Piper's, not the sibling models/tts/refs/) ───────
removed_models=0
for f in "$MODEL_DIR/$PIPER_VOICE.onnx" "$MODEL_DIR/$PIPER_VOICE.onnx.json"; do
  if [ -f "$f" ]; then
    rm -f "$f"
    removed_models=$((removed_models + 1))
  fi
done
if [ "$removed_models" -gt 0 ]; then
  step "Removed $removed_models model file(s)"
else
  step "Model files not present — skipping"
fi

step "Done. Piper is uninstalled."
exit 0
