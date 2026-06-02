#!/usr/bin/env bash
# scripts/uninstall-faster-whisper.sh
#
# Stops + removes the faster-whisper.service systemd-user unit and deletes
# the venv. The model cache under models/stt/faster-whisper is preserved by
# default so a re-install doesn't re-download ~750-810 MB; pass
# FW_PURGE_MODELS=1 to remove it too.

set -eu

OE_HOME="${OE_HOME:-$HOME/.openensemble}"
VENV="$OE_HOME/runtime/faster-whisper-venv"
MODEL_CACHE_DIR="$OE_HOME/models/stt/faster-whisper"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="faster-whisper.service"

step() { echo "[fw-uninstall] $*"; }

if systemctl --user list-unit-files --no-pager 2>/dev/null | grep -q "^$SERVICE_NAME"; then
  step "Stopping + disabling $SERVICE_NAME..."
  systemctl --user disable --now "$SERVICE_NAME" 2>/dev/null || true
fi

if [ -f "$SERVICE_DIR/$SERVICE_NAME" ]; then
  step "Removing unit file..."
  rm -f "$SERVICE_DIR/$SERVICE_NAME"
  systemctl --user daemon-reload 2>/dev/null || true
fi

if [ -d "$VENV" ]; then
  step "Removing venv at $VENV..."
  rm -rf "$VENV"
fi

if [ "${FW_PURGE_MODELS:-0}" = "1" ] && [ -d "$MODEL_CACHE_DIR" ]; then
  step "Purging model cache at $MODEL_CACHE_DIR (FW_PURGE_MODELS=1)..."
  rm -rf "$MODEL_CACHE_DIR"
fi

step "Done."
