#!/usr/bin/env bash
# Shared by the main installer and the optional voice-engine installers.
set -euo pipefail

python_venv_ready() {
  command -v python3 >/dev/null 2>&1 && python3 -c 'import venv, ensurepip' >/dev/null 2>&1
}

if [[ "${1:-}" == "--check" ]]; then
  python_venv_ready
  exit $?
fi
python_venv_ready && exit 0

echo '[voice-deps] Installing Python virtual-environment support...'
python_sudo=()
if [[ $EUID -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo '[voice-deps] Administrator access is needed. Re-run install.sh on the OE server to install Python virtual-environment support.' >&2
    exit 2
  fi
  # UI installers have no terminal: never wait for a password they cannot show.
  python_sudo=(sudo -n)
  if [[ -t 0 && -t 2 ]]; then python_sudo=(sudo); fi
fi

if command -v apt-get >/dev/null 2>&1; then
  "${python_sudo[@]}" apt-get update
  "${python_sudo[@]}" apt-get install -y python3 python3-full
elif command -v dnf >/dev/null 2>&1; then
  "${python_sudo[@]}" dnf install -y python3 python3-pip
elif command -v yum >/dev/null 2>&1; then
  "${python_sudo[@]}" yum install -y python3 python3-pip
elif command -v apk >/dev/null 2>&1; then
  "${python_sudo[@]}" apk add --no-cache python3 py3-pip
elif command -v pacman >/dev/null 2>&1; then
  "${python_sudo[@]}" pacman -S --needed --noconfirm python python-pip
elif command -v zypper >/dev/null 2>&1; then
  "${python_sudo[@]}" zypper install -y python3 python3-pip
else
  echo '[voice-deps] No supported package manager. Install Python with venv and ensurepip, then retry.' >&2
  exit 2
fi

if ! python_venv_ready; then
  echo '[voice-deps] The selected python3 still cannot import venv and ensurepip. Check that PATH selects the system Python just installed.' >&2
  exit 2
fi
echo '[voice-deps] Python virtual-environment support is ready.'
