#!/bin/sh
set -eu

APP_DIR=/app
STATE_DIR=${OE_DOCKER_STATE_DIR:-/app/docker-data}
TLS_DIR=${OE_TLS_DIR:-/app/tls}
STATE_ROOT=$STATE_DIR/root
BUNDLED_PLUGIN_DIR=/opt/openensemble-plugins

umask 077

install_bundled_plugin() {
  plugin=$1
  source_path=$BUNDLED_PLUGIN_DIR/$plugin
  target_path=$APP_DIR/plugins/$plugin
  next_path=$APP_DIR/plugins/.oe-bundled-$plugin.new
  old_path=$APP_DIR/plugins/.oe-bundled-$plugin.old
  [ -d "$source_path" ] || return 0
  mkdir -p "$APP_DIR/plugins"
  rm -rf "$next_path" "$old_path"
  cp -a "$source_path" "$next_path"
  had_old=0
  if [ -e "$target_path" ] || [ -L "$target_path" ]; then
    mv "$target_path" "$old_path"
    had_old=1
  fi
  if ! mv "$next_path" "$target_path"; then
    [ "$had_old" -eq 0 ] || mv "$old_path" "$target_path"
    exit 1
  fi
  rm -rf "$old_path"
}

# /app/plugins is durable so user-installed drawer plugins survive container
# recreation. Refresh the two immutable bundled plugins from the current image
# on every boot so that volume persistence cannot pin old built-in code.
install_bundled_plugin markets
install_bundled_plugin news

persist_file() {
  rel=$1
  source_path=$APP_DIR/$rel
  target_path=$STATE_ROOT/$rel
  mkdir -p "$(dirname "$target_path")"
  # An explicit file bind mount takes precedence. -L also recognizes a
  # dangling link whose target has not been created by the application yet.
  if [ ! -e "$source_path" ] && [ ! -L "$source_path" ]; then
    ln -s "$target_path" "$source_path"
  fi
}

persist_dir() {
  rel=$1
  source_path=$APP_DIR/$rel
  target_path=$STATE_ROOT/$rel
  mkdir -p "$target_path"
  # An explicit directory bind mount takes precedence over managed state.
  if [ ! -e "$source_path" ] && [ ! -L "$source_path" ]; then
    ln -s "$target_path" "$source_path"
  fi
}

mkdir -p "$STATE_ROOT"

# Persist mutable root registries without masking application source during an
# image upgrade. The application keeps its historical /app paths through
# symlinks, while the real data lives in the named state volume.
for rel in \
  users.json sharing.json shared-notes.json messages.json threads.json \
  active-sessions.json background-task-journal.json mcp-access-tokens.json \
  browser-pairing.json nodes.json admission-requests.json mdns-instance.json \
  dep-status.json last-dep-install.log invites.json gmail-credentials.json \
  microsoft-credentials.json gcal-token.json gmail-token.json tunnel.json \
  MCP_TODO.md
do
  persist_file "$rel"
done

for rel in \
  config expenses tasks research images videos activity agents sessions \
  shared-docs training-data training wake-captures wake-captures-manual tv-app \
  cortex-lancedb memory-db lancedb .backup-meta backups
do
  persist_dir "$rel"
done

# Preserve configuration in a directory volume while leaving the application's
# long-standing /app/config.json path intact. A bind mount on the individual
# file cannot support OE's atomic rename saves; bind the state directory instead.
if [ -d "$APP_DIR/config.json" ]; then
  echo "[docker] /app/config.json is a directory; remove that mount and use the /app/docker-data state volume." >&2
  exit 1
fi
if [ -e "$APP_DIR/config.json" ] && [ ! -L "$APP_DIR/config.json" ]; then
  echo "[docker] Individual /app/config.json file mounts are unsupported because they block atomic saves; mount /app/docker-data instead." >&2
  exit 1
fi
if [ ! -e "$APP_DIR/config.json" ]; then
  if [ ! -s "$STATE_DIR/config.json" ]; then
    cp "$APP_DIR/config.template.json" "$STATE_DIR/config.json"
  fi
  ln -s "$STATE_DIR/config.json" "$APP_DIR/config.json"
fi
chmod 600 "$APP_DIR/config.json" 2>/dev/null || true

# A mapped HTTP request comes from Docker's bridge gateway, not loopback.
# Generate TLS at runtime so first-run owner setup has a secure transport.
mkdir -p "$TLS_DIR"
if [ ! -s "$TLS_DIR/cert.pem" ] || [ ! -s "$TLS_DIR/key.pem" ]; then
  lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  subject_alt_name='DNS:localhost,DNS:openensemble,DNS:openensemble.local,IP:127.0.0.1'
  case "$lan_ip" in
    ''|*[!0-9a-fA-F:.]*) ;;
    *) subject_alt_name="$subject_alt_name,IP:$lan_ip" ;;
  esac
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj '/CN=openensemble' \
    -addext "subjectAltName=$subject_alt_name" \
    -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
    >/dev/null 2>&1
  chmod 600 "$TLS_DIR/key.pem"
  echo '[docker] Generated a self-signed HTTPS certificate on port 3739.'
fi

exec "$@"
