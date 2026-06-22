#!/usr/bin/env bash
# uninstall-llama-server.sh — remove a GPU-pinned llama.cpp model server.
# Idempotent (skip-if-missing on every step). Env: OE_LLAMA_KIND=plan|cortex.
set -uo pipefail
KIND="${OE_LLAMA_KIND:-}"
case "$KIND" in
  plan)   SERVICE="oe-plan-llama" ;;
  cortex) SERVICE="oe-cortex-llama" ;;
  *) echo "error: OE_LLAMA_KIND must be 'plan' or 'cortex'"; exit 2 ;;
esac
UNIT="$HOME/.config/systemd/user/$SERVICE.service"
echo "[uninstall-llama-$KIND] stopping $SERVICE"
systemctl --user stop "$SERVICE.service" 2>/dev/null || true
systemctl --user disable "$SERVICE.service" 2>/dev/null || true
if [ -f "$UNIT" ]; then rm -f "$UNIT"; echo "[uninstall-llama-$KIND] removed $UNIT"; else echo "[uninstall-llama-$KIND] no unit file (already gone)"; fi
systemctl --user daemon-reload 2>/dev/null || true
echo "[uninstall-llama-$KIND] done (model GGUF in models/ is preserved)"
