#!/bin/bash
set -euo pipefail

# ─── OpenEnsemble Installer ───────────────────────────────────────────────────
# Self-hosted multi-user AI assistant server
# Usage: ./install.sh [--dir <path>] [--no-service] [--yes]

OE_VERSION="1.0.0"
DEFAULT_INSTALL_DIR="$HOME/.openensemble"
MIN_NODE_MAJOR=18

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}  →${RESET} $*"; }
success() { echo -e "${GREEN}  ✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}  !${RESET} $*"; }
error()   { echo -e "${RED}  ✗${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# ─── Argument Parsing ─────────────────────────────────────────────────────────
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
INSTALL_SERVICE=true
AUTO_YES=false
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)      INSTALL_DIR="$2"; shift 2 ;;
    --no-service) INSTALL_SERVICE=false; shift ;;
    --yes|-y)   AUTO_YES=true; shift ;;
    --help|-h)
      echo "Usage: $0 [--dir <install-path>] [--no-service] [--yes]"
      echo ""
      echo "  --dir <path>    Install to <path> (default: $DEFAULT_INSTALL_DIR)"
      echo "  --no-service    Skip systemd service setup"
      echo "  --yes           Non-interactive (accept all defaults)"
      exit 0 ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

prompt() {
  local var_name="$1" prompt_text="$2" default="$3"
  if $AUTO_YES; then
    printf -v "$var_name" '%s' "$default"
    return
  fi
  read -rp "  $prompt_text [$default]: " input
  printf -v "$var_name" '%s' "${input:-$default}"
}

prompt_yn() {
  local prompt_text="$1" default="$2"
  if $AUTO_YES; then [[ "$default" == "y" ]]; return $?; fi
  read -rp "  $prompt_text [${default^^}/$([ "$default" == "y" ] && echo n || echo Y)]: " yn
  case "${yn:-$default}" in
    [Yy]*) return 0 ;;
    *)     return 1 ;;
  esac
}

# Ensure build tools for native npm modules (node-pty, node-llama-cpp, lancedb)
# plus runtime binaries the server shells out to: zip for code project
# downloads, bubblewrap for the coder skill's shell sandbox, git for the
# in-app auto-update flow. Fresh LXC/VM images typically lack these → npm
# install fails partway through, downloads silently serve 0-byte archives,
# coder refuses every shell command, or auto-update reports "Not a git repo".
ensure_build_tools() {
  local need=()
  command -v make     &>/dev/null || need+=(make)
  command -v g++      &>/dev/null || need+=(g++)
  command -v python3  &>/dev/null || need+=(python3)
  command -v zip      &>/dev/null || need+=(zip)
  command -v bwrap    &>/dev/null || need+=(bubblewrap)
  command -v git      &>/dev/null || need+=(git)
  command -v pdftoppm &>/dev/null || need+=(poppler-utils)
  command -v rg       &>/dev/null || need+=(ripgrep)
  command -v fuser    &>/dev/null || need+=(psmisc)
  command -v ffmpeg   &>/dev/null || need+=(ffmpeg)
  command -v openssl  &>/dev/null || need+=(openssl)
  [[ ${#need[@]} -eq 0 ]] && return 0

  warn "Missing build/runtime tools: ${need[*]}"
  local SUDO=""
  if [[ $EUID -ne 0 ]]; then
    command -v sudo &>/dev/null || { error "Tools missing and no sudo — install build-essential, python3, zip, bubblewrap, git manually and re-run."; exit 1; }
    SUDO="sudo"
  fi
  if ! prompt_yn "Install build tools now?" "y"; then
    error "Build tools required for native modules, coder sandbox, and auto-update. Install manually and re-run."
    exit 1
  fi
  # poppler-utils provides `pdftoppm` (PDF page-1 thumbnails) and `pdftotext`
  # (PDF text extraction for the documents/expenses skills). ripgrep provides
  # `rg`, used by the coder skill for code search — without it, search
  # silently returns "No matches found". psmisc provides `fuser`, used by
  # the systemd unit's prestart cleanup to free port 3737 if a stale process
  # still holds it (without fuser, the unit falls back to pkill matching).
  # ffmpeg is needed by every TTS provider branch (resample to 16 kHz for
  # voice devices) — without it, voice-device replies fail silently with
  # "ffmpeg ENOENT". python3-full is needed for the optional Piper TTS
  # install: Debian/Ubuntu split venv + ensurepip + pip from the python3
  # core, and on Debian 13 (Python 3.13) the bare `python3-venv` virtual
  # package didn't reliably pull in `python3.13-venv`. python3-full is
  # the official meta-package that always includes the matching
  # version-specific venv + ensurepip + pip; works on Debian 11+, Ubuntu
  # 22.04+. RPM/Arch/Alpine ship `python -m venv` as part of base python.
  if   command -v apt-get &>/dev/null; then $SUDO apt-get update && $SUDO apt-get install -y build-essential python3 python3-full zip bubblewrap git poppler-utils ripgrep psmisc ffmpeg openssl
  elif command -v dnf     &>/dev/null; then $SUDO dnf groupinstall -y "Development Tools" && $SUDO dnf install -y python3 zip bubblewrap git poppler-utils ripgrep psmisc ffmpeg openssl
  elif command -v yum     &>/dev/null; then $SUDO yum groupinstall -y "Development Tools" && $SUDO yum install -y python3 zip bubblewrap git poppler-utils ripgrep psmisc ffmpeg openssl
  elif command -v apk     &>/dev/null; then $SUDO apk add --no-cache build-base python3 zip bubblewrap git poppler-utils ripgrep psmisc ffmpeg openssl
  elif command -v pacman  &>/dev/null; then $SUDO pacman -Sy --noconfirm base-devel python zip bubblewrap git poppler ripgrep psmisc ffmpeg openssl
  elif command -v zypper  &>/dev/null; then $SUDO zypper install -y -t pattern devel_basis && $SUDO zypper install -y python3 zip bubblewrap git poppler-tools ripgrep psmisc ffmpeg openssl
  else
    error "No supported package manager found. Install build-essential, python3, python3-full (or python3 + python3-venv + python3-pip), zip, bubblewrap, git, poppler-utils, ripgrep, psmisc, and ffmpeg manually and re-run."
    exit 1
  fi
  success "Build tools installed"
}

# Ensure curl is available — the nvm installer pipes it to bash, so without
# curl the Node bootstrap silently fails on fresh LXC/VM images.
ensure_curl() {
  command -v curl &>/dev/null && return 0
  warn "curl is required but not installed"
  local SUDO=""
  if [[ $EUID -ne 0 ]]; then
    command -v sudo &>/dev/null || { error "curl missing and no sudo — install curl manually and re-run."; exit 1; }
    SUDO="sudo"
  fi
  if ! prompt_yn "Install curl now?" "y"; then
    error "curl is required. Install it manually and re-run."
    exit 1
  fi
  if   command -v apt-get &>/dev/null; then $SUDO apt-get update && $SUDO apt-get install -y curl
  elif command -v dnf     &>/dev/null; then $SUDO dnf install -y curl
  elif command -v yum     &>/dev/null; then $SUDO yum install -y curl
  elif command -v apk     &>/dev/null; then $SUDO apk add --no-cache curl
  elif command -v pacman  &>/dev/null; then $SUDO pacman -Sy --noconfirm curl
  elif command -v zypper  &>/dev/null; then $SUDO zypper install -y curl
  elif command -v brew    &>/dev/null; then brew install curl
  else
    error "No supported package manager found. Install curl manually and re-run."
    exit 1
  fi
  command -v curl &>/dev/null || { error "curl install failed"; exit 1; }
  success "curl installed"
}

# ─── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║    OpenEnsemble Installer v${OE_VERSION}         ║${RESET}"
echo -e "${BOLD}║  Self-hosted multi-user AI assistant   ║${RESET}"
echo -e "${BOLD}╚════════════════════════════════════════╝${RESET}"
echo ""

# ─── Privilege precheck ───────────────────────────────────────────────────────
# Detect upfront whether we can elevate. Two install steps need it:
#   - apt/dnf system deps (build-essential, ripgrep, bubblewrap, etc.)
#   - loginctl enable-linger, so systemd --user works without an active login
# Catching the no-sudo case BEFORE we do 5+ minutes of npm install / file
# copy / config work means the user can re-run as root or with sudo upfront,
# instead of getting stranded near the end.
header "Privilege Check"
if [[ $EUID -eq 0 ]]; then
  success "Running as root — no sudo needed"
  CAN_ELEVATE=true
elif command -v sudo &>/dev/null && sudo -n true 2>/dev/null; then
  success "sudo available without password (cached or NOPASSWD)"
  CAN_ELEVATE=true
elif command -v sudo &>/dev/null; then
  info "sudo is installed but will prompt for a password during install."
  if sudo -v 2>/dev/null; then
    success "sudo session validated"
    CAN_ELEVATE=true
  else
    CAN_ELEVATE=false
  fi
else
  CAN_ELEVATE=false
fi

if [[ "$CAN_ELEVATE" != "true" ]]; then
  echo ""
  warn "Cannot elevate to root and sudo is unavailable for this user."
  warn "OpenEnsemble needs root for two steps:"
  warn "  1. Installing system packages (build-essential, ripgrep, etc.)"
  warn "  2. Enabling user lingering so the service auto-starts at boot"
  echo ""
  warn "Re-run installation as root or with sudo:"
  warn "  ${YELLOW}su -${RESET} ${YELLOW}# then re-run the installer${RESET}"
  warn "  ${YELLOW}sudo bash install.sh${RESET}"
  warn "  ${YELLOW}curl -fsSL <install-url> | sudo bash${RESET}"
  echo ""
  if ! prompt_yn "Continue anyway? (npm install will work; service auto-start will not)" "n"; then
    echo "Aborted. Re-run with sudo/root and try again."
    exit 1
  fi
fi

# ─── Confirm Install Dir ──────────────────────────────────────────────────────
header "Installation Directory"
prompt INSTALL_DIR "Install to" "$INSTALL_DIR"
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"

if [[ -d "$INSTALL_DIR/node_modules" ]]; then
  warn "Existing installation found at $INSTALL_DIR"
  if ! prompt_yn "Upgrade in place?" "y"; then
    echo "Aborted."; exit 0
  fi
  UPGRADING=true
else
  UPGRADING=false
fi

# ─── Check Node.js ────────────────────────────────────────────────────────────
header "Checking Prerequisites"

check_node() {
  command -v node &>/dev/null || return 1
  local ver; ver=$(node --version 2>/dev/null | sed 's/v//')
  local major="${ver%%.*}"
  [[ "$major" -ge "$MIN_NODE_MAJOR" ]] 2>/dev/null
}

if check_node; then
  NODE_VER=$(node --version)
  success "Node.js $NODE_VER found"
else
  warn "Node.js $MIN_NODE_MAJOR+ not found"
  if prompt_yn "Install Node.js via nvm?" "y"; then
    # Install nvm if missing
    if [[ ! -s "$HOME/.nvm/nvm.sh" ]]; then
      ensure_curl
      info "Installing nvm..."
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    fi
    export NVM_DIR="$HOME/.nvm"
    # nvm references unset vars internally; relax -u while sourcing + invoking it.
    set +u
    # shellcheck source=/dev/null
    source "$NVM_DIR/nvm.sh"
    info "Installing Node.js LTS..."
    nvm install --lts
    nvm use --lts
    set -u
    success "Node.js $(node --version) installed"
  else
    error "Node.js $MIN_NODE_MAJOR+ is required. Install it from https://nodejs.org and re-run."
    exit 1
  fi
fi

# Source nvm in case it was set up in a prior session
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  # nvm internals reference unset vars — temporarily relax -u while sourcing.
  set +u
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh" 2>/dev/null || true
  set -u
fi

# ─── Copy Application Files ───────────────────────────────────────────────────
header "Installing OpenEnsemble"

# .git is NOT excluded — preserved so `oe update` can git-pull in place.
EXCLUDES=(
  --exclude='.claude'
  --exclude='node_modules'
  --exclude='config.json'
  --exclude='gmail-credentials.json'
  --exclude='users/'
  --exclude='training-data/'
  --exclude='unsloth_compiled_cache/'
  --exclude='venv/'
  --exclude='research/'
  --exclude='images/'
  --exclude='videos/'
  --exclude='cortex-lancedb/'
  --exclude='memory-db/'
  # Top-level user-data excludes — anchored with leading slash so they don't
  # also match skills/{expenses,tasks,shared-docs} which the runtime imports.
  --exclude='/expenses/'
  --exclude='/tasks/'
  --exclude='/agents/'
  --exclude='/shared-docs/'
  --exclude='active-sessions.json'
  --exclude='messages.json'
  --exclude='threads.json'
  --exclude='shared-notes.json'
  --exclude='sharing.json'
  --exclude='sessions/'
  --exclude='lancedb/'
  --exclude='plugins/usr_*'
  --exclude='plugins/*_*'
  --exclude='activity/'
  --exclude='tools/'
  --exclude='*.log'
  --exclude='*.bak'
  --exclude='CLAUDE.md'
  --exclude='WORKSPACE_LOG.md'
  --exclude='server.log'
)

mkdir -p "$INSTALL_DIR"

if command -v rsync &>/dev/null; then
  rsync -a --delete "${EXCLUDES[@]}" "$SOURCE_DIR/" "$INSTALL_DIR/"
else
  # Fallback: cp with manual exclusions (.git is kept so `oe update` can git-pull)
  find "$SOURCE_DIR" -mindepth 1 -maxdepth 1 \
    ! -name '.claude' ! -name 'node_modules' \
    ! -name 'config.json' ! -name 'gmail-credentials.json' \
    ! -name 'users' ! -name 'training-data' ! -name 'unsloth_compiled_cache' \
    ! -name 'venv' ! -name 'research' ! -name 'images' ! -name 'videos' \
    ! -name 'cortex-lancedb' ! -name 'memory-db' ! -name 'expenses' \
    ! -name 'tasks' ! -name 'agents' ! -name 'shared-docs' \
    ! -name 'sharing.json' ! -name 'sessions' ! -name 'lancedb' ! -name 'activity' ! -name 'tools' \
    ! -name '*.log' ! -name '*.bak' ! -name 'CLAUDE.md' \
    -exec cp -r {} "$INSTALL_DIR/" \;
  # Remove any user-created plugins that slipped through (rsync has --exclude for this)
  find "$INSTALL_DIR/plugins" -mindepth 1 -maxdepth 1 -type d ! -name 'markets' ! -name 'news' -exec rm -rf {} + 2>/dev/null
fi

success "Application files copied to $INSTALL_DIR"

# ─── Create Data Directories ──────────────────────────────────────────────────
for d in users agents tasks expenses shared-docs; do
  mkdir -p "$INSTALL_DIR/$d"
done
success "Data directories initialized"

# ─── Self-signed TLS cert ─────────────────────────────────────────────────────
# Provides HTTPS on port 3739 (alongside HTTP on 3737) so browser features
# that require a secure context — WebUSB / Web Serial for the voice-device
# flash wizard — work from any LAN browser, not just behind a reverse proxy
# with a real cert. Self-signed → users click through the "Not Secure"
# warning the first time. Browsers treat the post-click-through session
# as a secure context and grant WebUSB/Web Serial access. Cert is 10-year
# so we don't ship renewal headaches.
#
# Skip if a cert already exists (upgrade case — don't churn the user's
# accepted cert). If the user wants a real cert, drop their own
# cert.pem + key.pem into $INSTALL_DIR/tls/ and restart; the same
# auto-detect logic in server.mjs will pick them up.
TLS_DIR="$INSTALL_DIR/tls"
mkdir -p "$TLS_DIR"
if [[ ! -s "$TLS_DIR/cert.pem" || ! -s "$TLS_DIR/key.pem" ]]; then
  if command -v openssl &>/dev/null; then
    LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    [[ -z "$LAN_IP" ]] && LAN_IP="127.0.0.1"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -subj "/CN=openensemble" \
      -addext "subjectAltName=DNS:localhost,DNS:openensemble,DNS:openensemble.local,IP:127.0.0.1,IP:${LAN_IP}" \
      -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
      >/dev/null 2>&1 \
      && chmod 600 "$TLS_DIR/key.pem" \
      && success "Self-signed TLS cert generated (HTTPS on port 3739)"
  else
    warn "openssl not found — skipping HTTPS setup. Install openssl and re-run if you want browser features that require a secure context (WebUSB flash wizard)."
  fi
else
  success "Existing TLS cert preserved"
fi

# ─── Config Setup ─────────────────────────────────────────────────────────────
header "Configuration"

CONFIG_FILE="$INSTALL_DIR/config.json"

if [[ -f "$CONFIG_FILE" && "$UPGRADING" == "true" ]]; then
  success "Existing config.json preserved"
else
  cp "$SOURCE_DIR/config.template.json" "$CONFIG_FILE"
  success "config.json created — all providers start disabled"
  info "Enable providers and paste API keys from Settings in the web UI."
fi

# ─── Plan Model ───────────────────────────────────────────────────────────────
# OpenEnsemble ships one bundled scheduler model: SmolLM2-360M. Older
# installers offered a smaller "fast" tier, but it was retired because it was
# too small for current scheduler/local-cognition tasks.
if [[ "$UPGRADING" != "true" ]] && command -v node &>/dev/null; then
  PLAN_FILE="openensemble-plan-360m-v2.q8_0.gguf"
  node -e "
    const fs = require('fs');
    const f = '$CONFIG_FILE';
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    c.scheduler = c.scheduler || {};
    c.scheduler.builtinPlanModel = '$PLAN_FILE';
    fs.writeFileSync(f, JSON.stringify(c, null, 2) + '\n');
  "
  success "Plan model set to $PLAN_FILE"
fi

# ─── Install Dependencies ─────────────────────────────────────────────────────
header "Installing Dependencies"
ensure_build_tools
info "Running npm install (this may take a minute)..."
cd "$INSTALL_DIR"
npm install --prefer-offline 2>&1 | grep -v '^npm warn\|^npm notice' || npm install
success "Dependencies installed"

# `npm install` often rewrites package-lock.json on a fresh install (different
# npm version, platform-specific deps, peer-dep resolution drift). The
# committed lockfile is authoritative for what gets shipped; the on-disk
# rewrite just dirtied a tracked file and would block the in-app "Software
# Update" button for non-developers. Discard the rewrite so the working tree
# stays clean. node_modules is unaffected — npm only reads the lockfile at
# install time, not at runtime.
if [ -d "$INSTALL_DIR/.git" ] && command -v git &>/dev/null; then
  if ! git -C "$INSTALL_DIR" diff --quiet -- package-lock.json 2>/dev/null; then
    git -C "$INSTALL_DIR" checkout -- package-lock.json 2>/dev/null && \
      info "Reverted post-install package-lock.json rewrite (working tree stays clean)"
  fi
fi

# ─── Create start.sh ─────────────────────────────────────────────────────────
cat > "$INSTALL_DIR/start.sh" << STARTSH
#!/bin/bash
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && source "\$NVM_DIR/nvm.sh"
cd "$INSTALL_DIR"
node scripts/ensure-deps.mjs
exec node scripts/launch.mjs
STARTSH
chmod +x "$INSTALL_DIR/start.sh"
success "start.sh created"

# ─── Systemd Service (Linux only) ─────────────────────────────────────────────
HAVE_SERVICE=false
if [[ "$INSTALL_SERVICE" == "true" ]] && command -v systemctl &>/dev/null; then
  header "Systemd Service"
  if prompt_yn "Install openensemble as a systemd user service (auto-start)?" "y"; then
    # loginctl accepts a numeric UID, so an unavailable NSS name lookup does
    # not need to abort an otherwise valid local install.
    INSTALL_USER="$(id -un 2>/dev/null || printf '%s\n' "$EUID")"
    SERVICE_DIR="$HOME/.config/systemd/user"
    mkdir -p "$SERVICE_DIR"

    NODE_BIN=$(command -v node)
    cat > "$SERVICE_DIR/openensemble.service" << SERVICE
[Unit]
Description=OpenEnsemble AI Assistant Server
After=network.target
StartLimitIntervalSec=120
StartLimitBurst=3

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
# Prestart cleanup — covers three cases:
#   1. server.pid points at a live orphan started outside systemd (manual
#      start.sh, prior root invocation) — kill by PID file (authoritative).
#   2. cmdline-matched orphan that didn't write a pid file — pkill any
#      "server.mjs" process under this install dir.
#   3. port 3737 still bound by something else — fuser -k as last resort.
ExecStartPre=-/bin/sh -c 'if [ -f $INSTALL_DIR/server.pid ]; then OLDPID=\$(cat $INSTALL_DIR/server.pid 2>/dev/null); if [ -n "\$OLDPID" ] && kill -0 "\$OLDPID" 2>/dev/null; then kill -TERM "\$OLDPID" 2>/dev/null; for i in 1 2 3 4 5; do kill -0 "\$OLDPID" 2>/dev/null || break; sleep 1; done; kill -KILL "\$OLDPID" 2>/dev/null || true; fi; rm -f $INSTALL_DIR/server.pid; fi; pkill -TERM -f "node .*server.mjs" 2>/dev/null || true; sleep 1; pkill -KILL -f "node .*server.mjs" 2>/dev/null || true; fuser -k -TERM 3737/tcp 2>/dev/null || true; sleep 1; fuser -k -KILL 3737/tcp 2>/dev/null || true; true'
ExecStartPre=-$NODE_BIN $INSTALL_DIR/scripts/ensure-deps.mjs
ExecStart=$NODE_BIN $INSTALL_DIR/scripts/launch.mjs
Restart=always
RestartSec=3
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=10
SendSIGKILL=yes
ExecStopPost=-/bin/sh -c 'if [ -f $INSTALL_DIR/server.pid ]; then OLDPID=\$(cat $INSTALL_DIR/server.pid 2>/dev/null); if [ -n "\$OLDPID" ] && kill -0 "\$OLDPID" 2>/dev/null; then kill -TERM "\$OLDPID" 2>/dev/null; sleep 1; kill -KILL "\$OLDPID" 2>/dev/null || true; fi; rm -f $INSTALL_DIR/server.pid; fi; pkill -TERM -f "node .*server.mjs" 2>/dev/null || true; sleep 1; pkill -KILL -f "node .*server.mjs" 2>/dev/null || true; true'
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
SERVICE

    # A reachable user manager may only be alive for the current SSH session.
    # Linger=yes is what starts it at boot and keeps it alive after logout, so
    # verify lingering independently before trusting `systemctl --user`.
    export XDG_RUNTIME_DIR="/run/user/$EUID"
    # Probe whether `systemctl --user` actually works. On Proxmox / minimal
    # Debian LXCs, lingering keeps the user manager alive but does NOT
    # auto-start dbus.socket, so $XDG_RUNTIME_DIR/bus is missing even when
    # the manager is fine. systemctl talks to systemd's private socket, not
    # dbus — probe that path directly.
    user_manager_ready() { systemctl --user list-units --no-pager >/dev/null 2>&1; }

    info "Checking systemd user lingering for $INSTALL_USER..."
    if OE_CAN_ELEVATE="$CAN_ELEVATE" bash "$INSTALL_DIR/scripts/ensure-user-linger.sh" "$INSTALL_USER"; then
      success "User lingering verified for $INSTALL_USER"

      if ! user_manager_ready; then
        info "Waiting for the systemd user manager to start..."
        # Lingering causes logind to spawn the user manager. Spawn can take
        # 10-20s on cold/slow boxes, so allow 30s.
        for _ in $(seq 1 30); do
          user_manager_ready && break
          sleep 1
        done
      fi

      if user_manager_ready; then
        SERVICE_WAS_ENABLED=false
        SERVICE_WAS_ACTIVE=false
        if systemctl --user is-enabled --quiet openensemble.service 2>/dev/null; then
          SERVICE_WAS_ENABLED=true
        fi
        if systemctl --user is-active --quiet openensemble.service 2>/dev/null; then
          SERVICE_WAS_ACTIVE=true
        fi
        # Wait for the user manager to finish reaching default.target before
        # calling `enable`. On a freshly-lingered manager, default.target can
        # take a moment to settle and `enable` run in that window writes the
        # Install symlink but reports the unit as `disabled` because the
        # resolve races the target chain.
        for _ in $(seq 1 15); do
          [ "$(systemctl --user is-active default.target 2>/dev/null)" = "active" ] && break
          sleep 1
        done
        # Best-effort: bring up dbus.socket so interactive sessions and any
        # tool that does want dbus (loginctl, gdbus, etc.) finds it without
        # waiting for pam_systemd. Harmless if already running.
        systemctl --user start dbus.socket 2>/dev/null || true
        if systemctl --user daemon-reload \
          && systemctl --user enable --now openensemble.service \
          && systemctl --user is-enabled --quiet openensemble.service \
          && systemctl --user is-active --quiet openensemble.service; then
          HAVE_SERVICE=true
          success "Systemd service installed and started"
        else
          if [[ "$SERVICE_WAS_ENABLED" != "true" && "$SERVICE_WAS_ACTIVE" != "true" ]]; then
            systemctl --user disable --now openensemble.service 2>/dev/null || true
          fi
          warn "Systemd service setup did not complete; starting without auto-start."
        fi
      else
        warn "User lingering is enabled, but the systemd user manager did not start."
        warn "Skipping systemd service install; starting without auto-start."
      fi
    else
      warn "Could not enable and verify user lingering. Skipping systemd service install."
      warn "To finish later, run:"
      if [[ $EUID -eq 0 ]]; then
        warn "  loginctl enable-linger $INSTALL_USER"
      else
        warn "  sudo loginctl enable-linger $INSTALL_USER"
      fi
      warn "  systemctl --user daemon-reload"
      warn "  systemctl --user enable --now openensemble.service"
      warn "Until then, start manually: $INSTALL_DIR/start.sh"
    fi
  fi
fi

# ─── Optional: install Piper local TTS ────────────────────────────────────────
# Piper is the local, no-API-key TTS option for voice devices. We ask here
# rather than auto-installing because the model + venv adds ~80 MB and a
# bunch of Python deps that not every user wants; the same install path is
# reachable later from Settings → Providers if the user skips now.
if [[ "$HAVE_SERVICE" == "true" ]] && [ -t 0 ] && [ -t 1 ]; then
  header "Optional: install Piper local TTS"
  info "Piper is a local text-to-speech engine for voice devices."
  info "  Alternatives: OpenAI / ElevenLabs require API keys."
  info "  Download: ~80 MB.  You can also install later from Settings → Providers."
  echo
  read -r -p "  Install Piper now? [y/N] " _piper_yn
  case "${_piper_yn:-}" in
    [Yy]|[Yy][Ee][Ss])
      if bash "$INSTALL_DIR/scripts/install-piper.sh"; then
        success "Piper installed and running on 127.0.0.1:5151"
      else
        warn "Piper install did not complete — retry later from Settings → Providers"
      fi
      ;;
    *)
      info "Skipping Piper install (selectable later in Settings → Providers)"
      ;;
  esac
fi

# ─── Optional: install KittenTTS local TTS ────────────────────────────────────
# KittenTTS is the lightest local TTS option — 25M-param ONNX model, runs on
# CPU, no GPU needed, no API key. ~50 MB install. Quality is functional but
# not on par with GPU-class options (Chatterbox, Kyutai, ElevenLabs) — it's
# the right pick for low-end hardware or users who want zero ongoing cost.
# 8 preset voices, no voice cloning. Reachable later from Settings → Providers.
if [[ "$HAVE_SERVICE" == "true" ]] && [ -t 0 ] && [ -t 1 ]; then
  header "Optional: install KittenTTS local TTS"
  info "KittenTTS is a tiny CPU-only TTS engine — no GPU, no API key required."
  info "  Trade-off: 8 preset voices only (no voice cloning). Quality is functional."
  info "  Download: ~50 MB.  You can also install later from Settings → Providers."
  echo
  read -r -p "  Install KittenTTS now? [y/N] " _kittentts_yn
  case "${_kittentts_yn:-}" in
    [Yy]|[Yy][Ee][Ss])
      if bash "$INSTALL_DIR/scripts/install-kittentts.sh"; then
        success "KittenTTS installed and running on 127.0.0.1:5153"
      else
        warn "KittenTTS install did not complete — retry later from Settings → Providers"
      fi
      ;;
    *)
      info "Skipping KittenTTS install (selectable later in Settings → Providers)"
      ;;
  esac
fi

# ─── oe CLI Wrapper ───────────────────────────────────────────────────────────
# Installed to ~/.local/bin/oe so users get a single unified command for
# start/stop/restart/status/logs/update/uninstall — no sudo needed because
# the server runs as a systemd --user service.
#
# The wrapper body lives in scripts/oe-cli.template.sh (versioned with the
# repo). Both this installer AND lib/update.mjs render it by substituting
# __INSTALL_DIR__, so new subcommands reach existing users via auto-update
# without requiring a re-install.
header "Installing oe CLI"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
OE_BIN="$BIN_DIR/oe"

TEMPLATE="$INSTALL_DIR/scripts/oe-cli.template.sh"
if [[ ! -f "$TEMPLATE" ]]; then
  error "Missing $TEMPLATE — installer cannot render the oe wrapper."
  exit 1
fi
sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$TEMPLATE" > "$OE_BIN"
chmod +x "$OE_BIN"
success "Installed $OE_BIN"

# Ensure ~/.local/bin is on PATH in future shells. Fresh VMs / minimal
# LXC images typically don't have it wired in, so `oe` would be missing
# from the next SSH session even though it installed cleanly. Append an
# init line to each shell rc that doesn't already have one, and export
# it in the current shell so the post-install banner works too.
# Track whether the parent shell will see `oe` without intervention. If
# ~/.local/bin wasn't already on the invoking shell's PATH, the user has to
# `source` an rc file or open a new shell — say so explicitly in the banner.
OE_PATH_NEEDS_RELOAD=false
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) export PATH="$BIN_DIR:$PATH"; OE_PATH_NEEDS_RELOAD=true ;;
esac
for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  [[ -f "$rc" ]] || continue
  if ! grep -q '\.local/bin' "$rc" 2>/dev/null; then
    {
      echo ''
      echo '# OpenEnsemble: add ~/.local/bin so `oe` is on PATH'
      echo 'export PATH="$HOME/.local/bin:$PATH"'
    } >> "$rc"
    info "Added ~/.local/bin to PATH in $rc"
  fi
done

# ─── Ensure nvm auto-loads in future shells ──────────────────────────────────
# nvm's own installer adds init lines to shell rc files when it can detect the
# shell. On fresh LXC/containers where bash runs non-interactive or root uses
# /bin/sh, that detection misses — so `node` / `npm` work during install.sh
# (we source nvm.sh manually) but vanish in the next SSH session. Append the
# init block to .bashrc if it isn't already there.
NVM_LOADED_IN_SHELL=false
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [[ -f "$rc" ]] || continue
    if ! grep -q 'NVM_DIR' "$rc" 2>/dev/null; then
      {
        echo ''
        echo '# OpenEnsemble: load nvm so `node` / `npm` are on PATH in new shells'
        echo 'export NVM_DIR="$HOME/.nvm"'
        echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"'
      } >> "$rc"
      info "Added nvm init block to $rc"
    fi
  done
  NVM_LOADED_IN_SHELL=true
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
# Resolve the machine's primary LAN IP so the "Web UI:" line points at
# something other devices can actually reach. Fall back to localhost if we
# can't determine it (e.g. netns with no routable address).
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LAN_IP" ] && LAN_IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
[ -z "$LAN_IP" ] && LAN_IP="localhost"
WEB_URL="http://$LAN_IP:3737"

echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  OpenEnsemble installed successfully!${RESET}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${BOLD}Install path:${RESET}  $INSTALL_DIR"
echo -e "  ${BOLD}Config file:${RESET}   $INSTALL_DIR/config.json"
echo -e "  ${BOLD}Web UI:${RESET}        $WEB_URL"
echo ""
echo -e "  ${BOLD}Manage with the ${YELLOW}oe${RESET}${BOLD} command:${RESET}"
echo -e "    oe status      — is it running?"
echo -e "    oe start|stop|restart"
echo -e "    oe logs -f     — follow logs"
echo -e "    oe update      — pull latest + restart"
echo -e "    oe uninstall   — remove service"
echo ""
# Auto-start when no systemd service was registered, so a fresh box is
# ready-to-use the moment install.sh finishes. Service-mode already has
# the server running via `systemctl --user start`.
SERVER_AUTOSTARTED=false
if [[ "${HAVE_SERVICE:-false}" != "true" ]]; then
  # start.sh cd's into INSTALL_DIR then `exec node server.mjs`, so the live
  # cmdline is the relative path — match the same regex the systemd unit uses
  # rather than a literal absolute path that would never hit.
  if pgrep -f "node .*server\.mjs" >/dev/null 2>&1; then
    SERVER_AUTOSTARTED=true
  else
    info "Starting OpenEnsemble in the background..."
    ( cd "$INSTALL_DIR" && nohup bash start.sh > server.log 2>&1 & ) >/dev/null 2>&1
    # Give it a few seconds to bind 3737 before declaring success. Fresh
    # installs take longer than a steady-state restart (skills/agents load).
    for _ in $(seq 1 15); do
      sleep 1
      if pgrep -f "node .*server\.mjs" >/dev/null 2>&1; then
        SERVER_AUTOSTARTED=true; break
      fi
    done
    if [[ "$SERVER_AUTOSTARTED" == "true" ]]; then
      success "Server started — logs at $INSTALL_DIR/server.log"
    else
      warn "Server didn't come up in time — check $INSTALL_DIR/server.log"
    fi
  fi
fi

echo -e "  ${BOLD}Next steps:${RESET}"
if [[ "${HAVE_SERVICE:-false}" == "true" || "$SERVER_AUTOSTARTED" == "true" ]]; then
  echo -e "  1. Open ${YELLOW}${WEB_URL}${RESET} and create your first user"
else
  echo -e "  1. Run ${YELLOW}$INSTALL_DIR/start.sh${RESET} or ${YELLOW}oe start${RESET} to start the server"
  echo -e "  2. Open ${YELLOW}${WEB_URL}${RESET} and create your first user"
fi
echo -e "  ${YELLOW}→${RESET} From Settings → Providers, enable the ones you want and paste in API keys"
echo ""
# If nvm was installed during this run, the current shell already has it on
# PATH (we sourced nvm.sh mid-script) — but brand-new SSH sessions won't until
# they re-read .bashrc. Tell the user so `node` isn't mysteriously missing.
if [[ "$OE_PATH_NEEDS_RELOAD" == "true" || "$NVM_LOADED_IN_SHELL" == "true" ]]; then
  echo -e "  ${BOLD}Note:${RESET} The ${YELLOW}oe${RESET} command (and ${YELLOW}node${RESET}/${YELLOW}npm${RESET} if just installed)"
  echo -e "        won't be on PATH until you reload your shell. Either:"
  echo -e "          • open a new terminal, or"
  echo -e "          • run: ${YELLOW}source ~/.bashrc${RESET} ${RESET}(or ${YELLOW}~/.zshrc${RESET} / ${YELLOW}~/.profile${RESET})"
  echo ""
fi
