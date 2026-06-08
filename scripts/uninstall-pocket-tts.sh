#!/usr/bin/env bash
# scripts/uninstall-pocket-tts.sh
#
# Removes the local Pocket TTS service: stops/disables the systemd unit, deletes
# the unit file, the venv, and the model/weights dir. Idempotent.
#
# Called by:
#   - routes/config.mjs POST /api/provider-config/uninstall-pocket-tts
#
# Exit codes: 0 always (best-effort cleanup; missing pieces are not errors)
set -u

OE_HOME="${OE_HOME:-$HOME/.openensemble}"
VENV="$OE_HOME/runtime/pocket-tts-venv"
MODEL_DIR="$OE_HOME/models/tts/pocket-tts"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="pocket-tts.service"

step() { echo "[pocket-tts-uninstall] $*"; }

step "Stopping + disabling $SERVICE_NAME..."
systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true

unit_path="$SERVICE_DIR/$SERVICE_NAME"
if [ -f "$unit_path" ]; then
  step "Removing $unit_path..."
  rm -f "$unit_path"
  systemctl --user daemon-reload 2>/dev/null || true
fi

if [ -d "$VENV" ]; then
  step "Removing venv $VENV..."
  rm -rf "$VENV"
fi

if [ -d "$MODEL_DIR" ]; then
  step "Removing model dir $MODEL_DIR..."
  rm -rf "$MODEL_DIR"
fi

step "Done."
exit 0
