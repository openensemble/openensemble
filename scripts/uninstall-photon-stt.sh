#!/usr/bin/env bash
# Keep model downloads and any runtime still used by the other Photon model.
set -euo pipefail
OE_HOME="${OE_HOME:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
VARIANT="${PHOTON_VARIANT:-ultra}"
case "$VARIANT" in ultra|redux) ;; *) echo 'Unknown Photon model' >&2; exit 2 ;; esac
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE="photon-$VARIANT.service"
mkdir -p "$OE_HOME/runtime"
exec 9>"$OE_HOME/runtime/photon-stt-install.lock"
flock -n 9 || { echo 'Another Photon operation is running.' >&2; exit 2; }
if [ -f "$SERVICE_DIR/$SERVICE" ]; then
  systemctl --user disable --now "$SERVICE"
  rm -f -- "$SERVICE_DIR/$SERVICE"
  systemctl --user daemon-reload
fi
for profile in cpu cuda; do
  venv="$OE_HOME/runtime/photon-stt-$profile-venv"
  used=0
  for model in ultra redux; do
    unit="$SERVICE_DIR/photon-$model.service"
    if [ -f "$unit" ] && grep -Fq -- "$venv/bin/python" "$unit"; then used=1; fi
  done
  if [ "$used" = 0 ] && [ -d "$venv" ]; then rm -rf -- "$venv"; fi
done
echo '[photon-uninstall] Removed service. Cached models are kept for reinstalling.'
