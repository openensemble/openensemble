#!/usr/bin/env bash
# OpenEnsemble server CLI — wraps systemctl --user + install-dir operations.
#
# This file is the SOURCE OF TRUTH for the `oe` wrapper installed at
# ~/.local/bin/oe. install.sh and lib/update.mjs both render it by replacing
# __INSTALL_DIR__ with the resolved install path. Auto-update refreshes the
# wrapper after a successful git pull, so new subcommands ship to existing
# users without re-running install.sh.
set -euo pipefail

INSTALL_DIR="__INSTALL_DIR__"
SERVICE="openensemble.service"

cmd="${1:-status}"
shift || true

case "$cmd" in
  start|stop|restart)
    systemctl --user "$cmd" "$SERVICE"
    ;;
  status|'')
    if systemctl --user is-active --quiet "$SERVICE" 2>/dev/null; then
      echo "✓ OpenEnsemble is running"
    else
      state=$(systemctl --user is-active "$SERVICE" 2>/dev/null || true)
      [ -z "$state" ] && state="not installed"
      echo "✗ OpenEnsemble is $state"
    fi
    lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -z "$lan_ip" ] && lan_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
    [ -z "$lan_ip" ] && lan_ip="localhost"
    echo ""
    echo "  Install:  $INSTALL_DIR"
    echo "  Web UI:   http://$lan_ip:3737"
    echo ""
    systemctl --user status "$SERVICE" --no-pager -n 5 2>/dev/null || true
    ;;
  logs)
    if [ "${1:-}" = "-f" ] || [ "${1:-}" = "--follow" ]; then
      journalctl --user -u "$SERVICE" -f
    else
      journalctl --user -u "$SERVICE" -n 100 --no-pager
    fi
    ;;
  update)
    cd "$INSTALL_DIR"
    if [ ! -d .git ]; then
      echo "✗ $INSTALL_DIR is not a git checkout — cannot update in place."
      echo "  Re-clone the repo and run install.sh --dir $INSTALL_DIR, or"
      echo "  cd to your source checkout and re-run install.sh."
      exit 1
    fi
    echo "→ git pull"
    git pull --ff-only
    echo "→ npm install"
    npm install --prefer-offline --no-audit --no-fund
    echo "→ refresh oe wrapper"
    if [ -f "$INSTALL_DIR/scripts/oe-cli.template.sh" ]; then
      sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$INSTALL_DIR/scripts/oe-cli.template.sh" > "$0.tmp"
      chmod +x "$0.tmp"
      mv "$0.tmp" "$0"
    fi
    echo "→ restart service"
    systemctl --user restart "$SERVICE" 2>/dev/null || \
      echo "  (no user service registered — start manually with $INSTALL_DIR/start.sh)"
    echo "✓ Update complete"
    ;;
  bench)
    cd "$INSTALL_DIR"
    exec node scripts/bench.mjs "$@"
    ;;
  uninstall)
    read -rp "Remove OpenEnsemble service? [y/N]: " yn
    case "${yn:-n}" in [Yy]*) ;; *) exit 0 ;; esac
    systemctl --user stop "$SERVICE" 2>/dev/null || true
    systemctl --user disable "$SERVICE" 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/$SERVICE"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "✓ Service removed"
    read -rp "Also delete install dir ($INSTALL_DIR) — config, users, memory? [y/N]: " yn
    case "${yn:-n}" in
      [Yy]*) rm -rf "$INSTALL_DIR"; echo "✓ $INSTALL_DIR removed" ;;
      *) echo "  $INSTALL_DIR preserved" ;;
    esac
    rm -f "$0"
    echo "✓ oe CLI removed"
    ;;
  help|--help|-h)
    cat <<HELP
OpenEnsemble — server CLI

Usage:  oe <command>

  status              Show service status (default)
  start               Start the server
  stop                Stop the server
  restart             Restart the server
  logs [-f]           Show logs (pass -f to follow)
  update              git pull + npm install + restart
  bench               Benchmark this CPU on the memory + plan models
  uninstall           Remove service (optionally wipe install dir)
  help                Show this message

The server runs as a systemd --user service; no sudo required.
HELP
    ;;
  *)
    echo "Unknown command: $cmd"
    echo "Run 'oe help' for usage."
    exit 1
    ;;
esac
