#!/usr/bin/env bash
# Install account-share clients locally, without sudo or changing host mounts.
# Debian/Ubuntu/Mint: download packages for this system's architecture, extract
# them under ignored bin/, and compile a pinned upstream fuse-nfs client.
set -euo pipefail
share_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
share_prefix="$share_root/bin/share-tools"
share_command() {
  local name="$1" sub=bin
  [[ "$name" == showmount ]] && sub=sbin
  if [[ -x "$share_root/bin/$name" ]]; then printf '%s\n' "$share_root/bin/$name"
  elif [[ -x "$share_prefix/usr/$sub/$name" ]]; then printf '%s\n' "$share_prefix/usr/$sub/$name"
  else command -v "$name"
  fi
}
share_tools_ready() {
  local client
  # libfuse2 clients invoke fusermount even on a FUSE 3 host.
  [[ -x "$share_root/bin/fusermount" ]] || command -v fusermount >/dev/null || return 1
  client="$(share_command rclone)" && "$client" help backends 2>/dev/null | grep -qE '^[[:space:]]*smb[[:space:]]' || return 1
  client="$(share_command showmount)" && "$client" --version >/dev/null 2>&1 || return 1
  client="$(share_command fuse-nfs)" && "$client" -h >/dev/null 2>&1
}
if [[ "${1:-}" == --check ]]; then share_tools_ready; exit $?; fi
if ! command -v fusermount >/dev/null && command -v fusermount3 >/dev/null &&
   [[ ! -e "$share_root/bin/fusermount" && ! -L "$share_root/bin/fusermount" ]]; then
  mkdir -p "$share_root/bin"
  ln -s "$(command -v fusermount3)" "$share_root/bin/fusermount" || [[ -x "$share_root/bin/fusermount" ]]
fi
if share_tools_ready; then echo 'Network-share clients are already installed.'; exit 0; fi

for share_tool in apt-get apt-cache dpkg-deb dpkg-architecture cc curl sha256sum flock; do
  command -v "$share_tool" >/dev/null || { echo "Missing $share_tool. Re-run install.sh on the OE server to install network-share prerequisites (Debian/Ubuntu/Mint)." >&2; exit 1; }
done
# Preparing clients also works while building a container without /dev/fuse.
# The host device is checked when a connection actually mounts a share.
mkdir -p "$share_root/bin"
exec 9>"$share_root/bin/.share-tools-install.lock"
flock -w 300 9 || { echo 'Another share-tool installation is still running.' >&2; exit 1; }
if share_tools_ready; then echo 'Network-share clients are already installed.'; exit 0; fi
mkdir -p "$share_prefix/src/fuse"
share_downloads="$(mktemp -d "$share_prefix/.packages.XXXXXX")"
trap 'rm -rf -- "$share_downloads"' EXIT
share_packages=(libfuse-dev libnfs-dev nfs-common)
# Include shared-library dependencies of showmount too. Minimal hosts may not
# have libtirpc/libwrap or their dependencies. Keep the host's libc/loader.
declare -A share_seen=([libfuse-dev]=1 [libnfs-dev]=1 [nfs-common]=1)
for ((share_index=0; share_index<${#share_packages[@]}; share_index++)); do
  share_depends="$(apt-cache depends "${share_packages[$share_index]}")"
  while IFS= read -r share_package; do
    [[ -n "$share_package" && "$share_package" != libc6 && -z "${share_seen[$share_package]:-}" ]] || continue
    share_seen[$share_package]=1
    share_packages+=("$share_package")
  done < <(printf '%s\n' "$share_depends" | sed -n 's/^ *Depends: \(lib[[:alnum:].+-]*\)$/\1/p')
done
share_rclone="$(share_command rclone || true)"
if [[ -z "$share_rclone" ]] || ! "$share_rclone" help backends 2>/dev/null | grep -qE '^[[:space:]]*smb[[:space:]]'; then
  share_packages+=(rclone)
fi
(
  cd "$share_downloads"
  apt-get -o Acquire::Retries=1 -o Acquire::http::Timeout=30 download "${share_packages[@]}"
  for share_deb in ./*.deb; do dpkg-deb -x "$share_deb" "$share_prefix"; done
)
share_commit=8abac8dc4f60ee111e7231ff704919c05923bd57
share_source="$share_prefix/src/fuse/fuse-nfs.c"
curl --fail --location --connect-timeout 15 --max-time 120 --proto '=https' --tlsv1.2 "https://raw.githubusercontent.com/sahlberg/fuse-nfs/$share_commit/fuse/fuse-nfs.c" -o "$share_source"
echo "4a524391daa644a0830c1003d6ab57d486e4c16859caea16605f689ce976e7df  $share_source" | sha256sum --check
curl --fail --location --connect-timeout 15 --max-time 120 --proto '=https' --tlsv1.2 "https://raw.githubusercontent.com/sahlberg/fuse-nfs/$share_commit/COPYING" -o "$share_prefix/src/COPYING"
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
cat > "$share_root/bin/showmount.new" <<SHARE_WRAPPER
#!/usr/bin/env bash
share_dir="\$(cd -- "\$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)/share-tools"
export LD_LIBRARY_PATH="\$share_dir/usr/lib/$share_arch:\$share_dir/lib/$share_arch\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "\$share_dir/usr/sbin/showmount" "\$@"
SHARE_WRAPPER
chmod 755 "$share_root/bin/showmount.new"
mv "$share_root/bin/showmount.new" "$share_root/bin/showmount"
share_tools_ready || { echo 'Network-share clients did not pass their startup checks.' >&2; exit 1; }
echo 'Installed SMB/NFS share tools under bin/. No system packages or mounts were changed.'
echo 'NFS uses the OE service UID/GID. Export rules must allow this host and identity.'
echo 'If an export requires a reserved client port, an administrator must configure that access separately.'
