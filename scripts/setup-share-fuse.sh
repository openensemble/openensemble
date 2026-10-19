#!/usr/bin/env bash
# Fixed system prerequisites only. Client binaries remain owned by the OE user.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
share_container=false
if [[ -e /.dockerenv || -e /run/.containerenv || -s /run/systemd/container ]] ||
   { command -v systemd-detect-virt >/dev/null && systemd-detect-virt --container --quiet; }; then
  share_container=true
fi
share_ready() {
  [[ -c /dev/fuse && -r /dev/fuse && -w /dev/fuse ]] &&
    { command -v fusermount3 >/dev/null || command -v fusermount >/dev/null; }
}
share_catalogue() {
  local item
  if command -v apt-get >/dev/null; then
    for item in libfuse-dev libnfs-dev nfs-common rclone; do apt-cache show "$item" >/dev/null 2>&1 || return 1; done
  fi
}
share_prerequisites() {
  local item
  for item in python3 cc curl flock; do command -v "$item" >/dev/null || return 1; done
  if command -v apt-get >/dev/null; then command -v dpkg-architecture >/dev/null || return 1; fi
  share_catalogue
}
if [[ "${1:-}" == --check ]]; then share_ready && share_prerequisites; exit $?; fi
if [[ $# -gt 0 ]]; then echo 'Usage: setup-share-fuse.sh [--check]' >&2; exit 64; fi
if share_ready && share_prerequisites; then echo 'FUSE system prerequisites are present.'; exit 0; fi
if [[ "$(id -u)" != 0 ]]; then
  if [[ -t 0 ]]; then exec sudo -- /bin/bash "$0"; fi
  exec sudo -n -- /bin/bash "$0"
fi
share_packages=()
command -v python3 >/dev/null || share_packages+=(python3)
command -v cc >/dev/null || share_packages+=(gcc)
command -v curl >/dev/null || share_packages+=(curl)
command -v flock >/dev/null || share_packages+=(util-linux)
if command -v apt-get >/dev/null && ! command -v dpkg-architecture >/dev/null; then share_packages+=(dpkg-dev); fi
if ! command -v fusermount3 >/dev/null && ! command -v fusermount >/dev/null; then share_packages+=(fuse3); fi
if ! $share_container && ! command -v modprobe >/dev/null; then share_packages+=(kmod); fi
if command -v apt-get >/dev/null && { (( ${#share_packages[@]} )) || ! share_catalogue; }; then
  # Minimal images can have all binaries but no package metadata. The private
  # client installer still needs that catalogue to download its dependencies.
  apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 update
fi
if (( ${#share_packages[@]} )); then
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=60 install -y --no-install-recommends "${share_packages[@]}"
  elif command -v dnf >/dev/null; then dnf install -y "${share_packages[@]}"
  elif command -v pacman >/dev/null; then pacman -S --needed --noconfirm "${share_packages[@]}"
  else echo 'Install FUSE 3 and kmod with this host package manager.' >&2; exit 69
  fi
fi
if ! $share_container && [[ ! -c /dev/fuse ]]; then
  modprobe fuse
  # udev normally creates /dev/fuse when the module loads. Never mknod/chmod it.
  if command -v udevadm >/dev/null; then udevadm settle --timeout=5; fi
  if [[ -c /dev/fuse ]]; then
    install -d -m 755 /etc/modules-load.d
    printf 'fuse\n' > /etc/modules-load.d/openensemble-fuse.conf
  fi
fi
if ! share_ready; then
  if $share_container; then echo 'The container host must expose /dev/fuse and allow FUSE mounts. Ask OE to set up the paired host.' >&2
  else echo 'FUSE is still unavailable. Check the host kernel and service device permissions.' >&2; fi
  exit 78
fi
echo 'FUSE system setup completed. Verify a mount as the OE service user.'
