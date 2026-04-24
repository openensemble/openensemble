#!/usr/bin/env bash
# OpenEnsemble Node Agent — Installer
# Usage:
#   curl -sSL http://<oe-server>:3737/nodes/install.sh | bash
#   curl -sSL http://<oe-server>:3737/nodes/install.sh | bash -s -- --server ws://<oe-server>:3737/ws/nodes
#
# Environment variables:
#   OE_SERVER        — WebSocket URL of the OpenEnsemble server (auto-detected from download origin if unset)
#   OE_DIR           — Install directory (default: ~/oe-node-agent)
#   OE_NO_SETUP      — If "1", skip running --setup at the end
#   OE_PAIRING_CODE  — Single-use pairing code (or pass --code <CODE>). Enables unattended install.
#
# Unattended usage (e.g. Proxmox bulk provisioning, agent-driven install):
#   curl -fsSL http://server:3737/nodes/install.sh | sh -s -- --server http://server:3737 --code ABC123

set -e

# ── Color output ─────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; BOLD=''; NC=''
fi

log()  { printf "${BLUE}[oe-install]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}[✓]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
err()  { printf "${RED}[✗]${NC} %s\n" "$*" >&2; }

# ── Parse args ───────────────────────────────────────────────────────────────
OE_SERVER="${OE_SERVER:-}"
OE_DIR="${OE_DIR:-$HOME/oe-node-agent}"
OE_PAIRING_CODE="${OE_PAIRING_CODE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --server)  OE_SERVER="$2"; shift 2 ;;
    --dir)     OE_DIR="$2"; shift 2 ;;
    --code)    OE_PAIRING_CODE="$2"; shift 2 ;;
    --no-setup) OE_NO_SETUP=1; shift ;;
    *) err "Unknown arg: $1"; exit 1 ;;
  esac
done
export OE_PAIRING_CODE

# ── Detect server URL (used to fetch the agent script) ───────────────────────
# If called via curl, the user passed the server's http URL. We parse it from
# $OE_DOWNLOAD_URL if set (server injects this when serving), else from OE_SERVER.
if [ -z "${OE_DOWNLOAD_URL:-}" ]; then
  if [ -n "$OE_SERVER" ]; then
    # Convert ws://host:port/path → http://host:port
    OE_DOWNLOAD_URL="$(printf '%s' "$OE_SERVER" | sed -E 's|^ws(s)?://|http\1://|; s|/ws/nodes.*||')"
  else
    err "Cannot determine server URL. Set OE_SERVER or OE_DOWNLOAD_URL."
    err "Example: curl -sSL http://your-server:3737/nodes/install.sh | bash"
    exit 1
  fi
fi

printf "\n${BOLD}=== OpenEnsemble Node Agent Installer ===${NC}\n\n"
log "Server:     $OE_DOWNLOAD_URL"
log "Install to: $OE_DIR"
echo

# ── sudo shim ────────────────────────────────────────────────────────────────
# If we're root, no sudo needed. If sudo is missing and we're not root, error early.
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
elif command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
else
  err "This installer needs root privileges, but 'sudo' is not installed and you are not root."
  err "Either install sudo (apt-get install sudo), or re-run this script as root:"
  err "  su -c 'curl -sSL $OE_DOWNLOAD_URL/nodes/install.sh | bash'"
  exit 1
fi

# ── Detect OS/distro ─────────────────────────────────────────────────────────
OS="$(uname -s)"
DISTRO=""
if [ "$OS" = "Linux" ]; then
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO="$ID"
  fi
fi

# ── Ensure Node.js ───────────────────────────────────────────────────────────
install_node() {
  log "Installing Node.js..."
  if [ "$OS" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install node
    else
      err "Homebrew not found. Install from https://brew.sh first, or install Node manually."
      exit 1
    fi
  else
    case "$DISTRO" in
      ubuntu|debian|mint|pop|elementary|raspbian)
        $SUDO apt-get update -qq
        $SUDO apt-get install -y nodejs npm
        ;;
      fedora|rhel|centos|rocky|almalinux)
        $SUDO dnf install -y nodejs npm
        ;;
      arch|manjaro|endeavouros)
        $SUDO pacman -S --noconfirm nodejs npm
        ;;
      opensuse*|sles)
        $SUDO zypper install -y nodejs npm
        ;;
      alpine)
        $SUDO apk add --no-cache nodejs npm
        ;;
      *)
        err "Unsupported distro: $DISTRO. Install Node.js 18+ manually, then re-run."
        exit 1
        ;;
    esac
  fi
}

# Find the best available Node binary (node or nodejs, pick newer if both exist)
pick_node() {
  local best="" best_ver=0
  for bin in node nodejs; do
    if command -v "$bin" >/dev/null 2>&1; then
      local v
      v="$("$bin" -v 2>/dev/null | sed 's/v//; s/\..*//')"
      if [ -n "$v" ] && [ "$v" -gt "$best_ver" ] 2>/dev/null; then
        best="$bin"; best_ver="$v"
      fi
    fi
  done
  NODE_BIN="$best"
  NODE_VERSION="$best_ver"
}

pick_node
if [ -z "$NODE_BIN" ]; then
  warn "Node.js not found."
  install_node
  pick_node
fi

if [ "$NODE_VERSION" -lt 18 ]; then
  warn "Node.js $NODE_VERSION is older than required 18+. Attempting to upgrade..."
  install_node
  pick_node
fi

# If nodejs is newer than node, point `node` at it so npm and scripts use the right version
if [ "$NODE_BIN" = "nodejs" ]; then
  warn "System has 'nodejs' ($("$NODE_BIN" -v)) newer than 'node'. Fixing symlink..."
  if command -v update-alternatives >/dev/null 2>&1; then
    $SUDO update-alternatives --install /usr/bin/node node "$(command -v nodejs)" 100 >/dev/null 2>&1 || true
  else
    $SUDO ln -sf "$(command -v nodejs)" /usr/local/bin/node
  fi
  hash -r
  pick_node
fi

ok "Node.js $("$NODE_BIN" -v) ready ($NODE_BIN)"

# ── Install build tools (needed for node-pty native module) ──────────────────
install_build_tools() {
  log "Installing build tools for node-pty..."
  case "$DISTRO" in
    ubuntu|debian|mint|pop|elementary|raspbian)
      $SUDO apt-get install -y build-essential python3 make g++
      ;;
    fedora|rhel|centos|rocky|almalinux)
      $SUDO dnf groupinstall -y "Development Tools"
      $SUDO dnf install -y python3
      ;;
    arch|manjaro|endeavouros)
      $SUDO pacman -S --noconfirm base-devel python
      ;;
    opensuse*|sles)
      $SUDO zypper install -y -t pattern devel_basis
      $SUDO zypper install -y python3
      ;;
    alpine)
      $SUDO apk add --no-cache build-base python3
      ;;
  esac
}

if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  install_build_tools
fi
ok "Build tools ready"

# ── Create install dir ───────────────────────────────────────────────────────
mkdir -p "$OE_DIR"
cd "$OE_DIR"
ok "Created $OE_DIR"

# ── Download agent script ────────────────────────────────────────────────────
log "Downloading agent script..."
if command -v curl >/dev/null 2>&1; then
  curl -sSL "$OE_DOWNLOAD_URL/nodes/agent" -o oe-node-agent.mjs
elif command -v wget >/dev/null 2>&1; then
  wget -q "$OE_DOWNLOAD_URL/nodes/agent" -O oe-node-agent.mjs
else
  err "Neither curl nor wget found."
  exit 1
fi

if [ ! -s oe-node-agent.mjs ]; then
  err "Failed to download agent script from $OE_DOWNLOAD_URL/nodes/agent"
  exit 1
fi
ok "Downloaded oe-node-agent.mjs ($(wc -c < oe-node-agent.mjs) bytes)"

# ── package.json + npm install ───────────────────────────────────────────────
cat > package.json <<'EOF'
{
  "name": "oe-node-agent",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "ws": "^8.18.0",
    "node-pty": "^1.1.0-beta21"
  }
}
EOF

log "Installing npm dependencies (this may take a minute for node-pty)..."
# Use the npm that ships with our chosen node (important when nodejs vs node differ)
NPM_BIN="$(command -v npm || true)"
"$NPM_BIN" install --omit=dev --no-audit --no-fund --loglevel=error
ok "Dependencies installed"

# ── Run interactive setup ────────────────────────────────────────────────────
echo
if [ "${OE_NO_SETUP:-0}" = "1" ]; then
  ok "Install complete. Run setup manually:"
  echo "    cd $OE_DIR && node oe-node-agent.mjs setup"
elif [ -n "$OE_PAIRING_CODE" ]; then
  # ── Unattended install ──
  # --code was passed (or OE_PAIRING_CODE was set). No prompts, no tty required.
  # Used by agent-driven provisioning (e.g. Proxmox `pct exec` loops) and
  # interactive operators who want a one-shot install.
  log "Unattended install (pairing code supplied)..."
  export OE_AGENT_DEFAULT_SERVER="${OE_SERVER:-$OE_DOWNLOAD_URL}"
  export OE_AGENT_UNATTENDED=1
  "$NODE_BIN" oe-node-agent.mjs setup --pair-only </dev/null
  echo
  log "Installing as systemd service (requires sudo)..."
  echo
  if [ "$(id -u)" -eq 0 ]; then
    OE_PAIRING_CODE="$OE_PAIRING_CODE" OE_AGENT_UNATTENDED=1 \
      "$NODE_BIN" oe-node-agent.mjs install-service </dev/null
  else
    sudo -E HOME="$HOME" OE_PAIRING_CODE="$OE_PAIRING_CODE" OE_AGENT_UNATTENDED=1 \
      "$NODE_BIN" oe-node-agent.mjs install-service </dev/null
  fi
else
  # When run via curl | bash, stdin is the pipe — we need /dev/tty for the prompts
  if [ ! -t 0 ] && [ ! -r /dev/tty ]; then
    warn "Cannot run interactive setup — no terminal available."
    warn "Run setup manually:  cd $OE_DIR && node oe-node-agent.mjs setup"
    warn "Or pass --code <CODE> for unattended pairing."
  else
    log "Starting interactive setup (pair with server)..."
    echo
    # Preseed the server URL so setup doesn't need LAN discovery — we already
    # know the server (it's where we just downloaded from).
    export OE_AGENT_DEFAULT_SERVER="${OE_SERVER:-$OE_DOWNLOAD_URL}"
    # Pick the stdin source once: /dev/tty when piped, inherited stdin otherwise.
    if [ ! -t 0 ]; then SETUP_STDIN=/dev/tty; else SETUP_STDIN=/dev/stdin; fi
    # --pair-only: write config then exit (don't leave agent running in fg)
    "$NODE_BIN" oe-node-agent.mjs setup --pair-only < "$SETUP_STDIN"

    echo
    log "Installing as systemd service (requires sudo)..."
    echo
    # Preserve HOME so installService() can find the config we just wrote.
    if [ "$(id -u)" -eq 0 ]; then
      "$NODE_BIN" oe-node-agent.mjs install-service < "$SETUP_STDIN"
    else
      sudo -E HOME="$HOME" "$NODE_BIN" oe-node-agent.mjs install-service < "$SETUP_STDIN"
    fi
  fi
fi

echo
printf "${BOLD}Install complete.${NC} The agent is running as a systemd service.\n"
echo
echo "  • Status:            oe                  (or 'oe status')"
echo "  • Logs:              oe logs -f"
echo "  • Restart:           sudo oe restart"
echo "  • Re-pair:           sudo oe repair <code>"
echo "  • Change access:     sudo oe change-access"
echo "  • Update:            sudo oe update"
echo "  • Uninstall:         sudo oe uninstall"
echo
