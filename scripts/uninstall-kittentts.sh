#!/usr/bin/env bash
# scripts/uninstall-kittentts.sh
#
# Mirror of scripts/install-kittentts.sh. Stops the systemd --user service,
# removes the unit file, deletes the venv at $OE_HOME/runtime/kittentts-venv,
# and removes the model directory at $OE_HOME/models/tts/kittentts/.
# Idempotent — re-runs silently skip already-removed pieces.
#
# Called by:
#   - routes/config.mjs POST /api/provider-config/uninstall-kittentts
#     (the "Uninstall" button in Settings → Providers → Text-to-Speech)
#
# Exit codes:
#   0 — success (whether or not all artifacts were present)
#   1 — generic failure (see stderr)
#
# Env overrides (all optional):
#   OE_HOME            default $HOME/.openensemble

set -eu

OE_HOME="${OE_HOME:-$HOME/.openensemble}"
VENV="$OE_HOME/runtime/kittentts-venv"
MODEL_DIR="$OE_HOME/models/tts/kittentts"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="kittentts.service"

step()  { echo "[kittentts-uninstall] $*"; }

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
if [ -d "$VENV" ]; then
  step "Removing venv $VENV..."
  rm -rf "$VENV"
else
  step "Venv not present — skipping"
fi

# ── remove model directory (kittentts has its own subdir, safe to nuke) ───────
if [ -d "$MODEL_DIR" ]; then
  step "Removing model directory $MODEL_DIR..."
  rm -rf "$MODEL_DIR"
else
  step "Model directory not present — skipping"
fi

step "Done. KittenTTS is uninstalled."
exit 0
