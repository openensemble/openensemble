#!/usr/bin/env bash
# Linux Docker host launcher with network-share support.
set -euo pipefail
share_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$share_root/scripts/setup-share-fuse.sh"
share_sudo=()
share_compose=(-f docker-compose.yml -f docker-compose.shares.yml)
if [[ "$(id -u)" != 0 ]]; then share_sudo=(sudo); fi
if [[ -r /sys/module/apparmor/parameters/enabled ]] && [[ "$(cat /sys/module/apparmor/parameters/enabled)" == Y ]]; then
  command -v apparmor_parser >/dev/null || { echo 'Install the host AppArmor parser, then retry.' >&2; exit 1; }
  share_profile=/etc/apparmor.d/openensemble-shares
  # Keep an administrator's edited policy intact.
  if [[ -e "$share_profile" ]]; then
    cmp -s "$share_root/scripts/openensemble-shares.apparmor" "$share_profile" || { echo 'Existing openensemble-shares policy differs; reconcile it before starting.' >&2; exit 1; }
  else
    "${share_sudo[@]}" install -m 644 "$share_root/scripts/openensemble-shares.apparmor" "$share_profile"
  fi
  "${share_sudo[@]}" apparmor_parser -r "$share_profile"
  share_compose+=(-f docker-compose.shares-apparmor.yml)
fi
cd "$share_root"
exec docker compose "${share_compose[@]}" up -d "$@"
