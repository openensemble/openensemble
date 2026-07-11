#!/bin/bash
set -uo pipefail

# A reachable systemd user manager only proves that the current login session
# started it. Linger=yes is what keeps the manager running after logout and
# starts it at boot, so service installation must verify that state directly.
INSTALL_USER="${1:-}"
if [[ -z "$INSTALL_USER" ]]; then
  INSTALL_USER="$(id -un 2>/dev/null || printf '%s\n' "$EUID")"
fi

linger_enabled() {
  local state
  command -v loginctl >/dev/null 2>&1 || return 1
  if ! state="$(loginctl show-user "$INSTALL_USER" -p Linger --value 2>/dev/null)"; then
    return 1
  fi
  [[ "$state" == "yes" ]]
}

# Already-enabled users do not need sudo, even if this install cannot elevate.
if linger_enabled; then
  exit 0
fi

if ! command -v loginctl >/dev/null 2>&1; then
  echo "loginctl is unavailable; cannot enable systemd user lingering." >&2
  exit 1
fi

if [[ $EUID -eq 0 ]]; then
  if ! loginctl enable-linger "$INSTALL_USER"; then
    echo "Failed to enable lingering for $INSTALL_USER." >&2
    exit 1
  fi
elif [[ "${OE_CAN_ELEVATE:-true}" == "true" ]] && command -v sudo >/dev/null 2>&1; then
  if ! sudo loginctl enable-linger "$INSTALL_USER"; then
    echo "Failed to enable lingering for $INSTALL_USER." >&2
    exit 1
  fi
else
  echo "Root access is unavailable; cannot enable lingering for $INSTALL_USER." >&2
  exit 1
fi

if ! linger_enabled; then
  echo "Lingering is still disabled for $INSTALL_USER after enable-linger." >&2
  exit 1
fi
