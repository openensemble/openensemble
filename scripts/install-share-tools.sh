#!/usr/bin/env bash
# Install account-share clients locally, without sudo or changing host mounts.
# Debian/Ubuntu/Mint: download packages for this system's architecture, extract
# them under ignored bin/, and compile a pinned upstream fuse-nfs client.
set -euo pipefail
share_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
share_prefix="$share_root/bin/share-tools"
for share_tool in apt-get apt-cache dpkg-deb dpkg-architecture cc curl sha256sum; do
  command -v "$share_tool" >/dev/null || { echo "Missing $share_tool. Install build-essential, dpkg-dev, curl, rclone, and FUSE on the OE host first." >&2; exit 1; }
done
[[ -c /dev/fuse ]] || { echo 'FUSE is unavailable. Enable /dev/fuse on the OE host/container first.' >&2; exit 1; }
command -v fusermount3 >/dev/null || command -v fusermount >/dev/null || { echo 'Install fuse3 on the OE host first.' >&2; exit 1; }
mkdir -p "$share_prefix/packages" "$share_prefix/src/fuse"
share_packages=(libfuse-dev libnfs-dev nfs-common)
while IFS= read -r share_package; do
  [[ -n "$share_package" ]] && share_packages+=("$share_package")
done < <(apt-cache depends libfuse-dev libnfs-dev | sed -n 's/^ *Depends: \(libfuse[[:alnum:]-]*\|libnfs[[:alnum:]-]*\)$/\1/p')
if ! command -v rclone >/dev/null; then share_packages+=(rclone); fi
(
  cd "$share_prefix/packages"
  apt-get download "${share_packages[@]}"
  for share_deb in ./*.deb; do dpkg-deb -x "$share_deb" "$share_prefix"; done
)
share_commit=8abac8dc4f60ee111e7231ff704919c05923bd57
share_source="$share_prefix/src/fuse/fuse-nfs.c"
curl --fail --location --proto '=https' --tlsv1.2 "https://raw.githubusercontent.com/sahlberg/fuse-nfs/$share_commit/fuse/fuse-nfs.c" -o "$share_source"
echo "4a524391daa644a0830c1003d6ab57d486e4c16859caea16605f689ce976e7df  $share_source" | sha256sum --check
curl --fail --location --proto '=https' --tlsv1.2 "https://raw.githubusercontent.com/sahlberg/fuse-nfs/$share_commit/COPYING" -o "$share_prefix/src/COPYING"
# This installer targets Linux, whose struct stat exposes st_atim.
printf '#define HAVE_ST_ATIM 1\n' > "$share_prefix/src/config.h"
share_arch="$(dpkg-architecture -qDEB_HOST_MULTIARCH)"
# libfuse-dev's linker symlink is absolute on non-merged-/usr releases.
# Point it at our extracted runtime library instead of depending on /lib.
if [[ -e "$share_prefix/lib/$share_arch/libfuse.so.2" ]]; then
  ln -sfn "../../../lib/$share_arch/libfuse.so.2" "$share_prefix/usr/lib/$share_arch/libfuse.so"
fi
cc -O2 -pthread -D_FILE_OFFSET_BITS=64 \
  -I"$share_prefix/usr/include" -I"$share_prefix/usr/include/fuse" \
  "$share_source" -L"$share_prefix/usr/lib/$share_arch" \
  -Wl,-rpath,"\$ORIGIN/share-tools/usr/lib/$share_arch:\$ORIGIN/share-tools/lib/$share_arch" -lnfs -lfuse \
  -o "$share_root/bin/fuse-nfs.new"
mv "$share_root/bin/fuse-nfs.new" "$share_root/bin/fuse-nfs"
echo 'Installed SMB/NFS share tools under bin/. No system packages or mounts were changed.'
echo 'NFS uses the OE service UID/GID. Export rules must allow this host and identity.'
echo 'If an export requires a reserved client port, an administrator must configure that access separately.'
