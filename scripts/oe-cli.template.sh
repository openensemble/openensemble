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

# Make `systemctl --user` work even when invoked from a shell that started
# before lingering was enabled (e.g. the same SSH session that ran
# install.sh). Without these env vars, systemctl --user has no D-Bus to
# talk to and is-active returns empty stdout — which the status branch
# below interprets as "not installed" and confuses brand-new users.
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR
[ -S "$XDG_RUNTIME_DIR/bus" ] && : "${DBUS_SESSION_BUS_ADDRESS:=unix:path=$XDG_RUNTIME_DIR/bus}" && export DBUS_SESSION_BUS_ADDRESS

cmd="${1:-status}"
shift || true

resolve_node_npm() {
  local node_path node_dir npm_path
  node_path="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_path" ]; then
    echo "✗ Node.js is not available on PATH." >&2
    return 1
  fi
  node_dir="$(CDPATH= cd "$(dirname "$node_path")" 2>/dev/null && pwd -P)"
  NODE_BIN="$node_dir/$(basename "$node_path")"
  npm_path="$node_dir/npm"
  if [ ! -x "$npm_path" ]; then
    npm_path="$(command -v npm 2>/dev/null || true)"
  fi
  if [ -z "$npm_path" ] || [ ! -x "$npm_path" ]; then
    echo "✗ npm was not found next to $NODE_BIN or on PATH." >&2
    return 1
  fi
  NPM_BIN="$npm_path"
  export PATH="$node_dir${PATH:+:$PATH}"
}

tracked_state_fingerprint() {
  {
    git status --porcelain=v1 -uno
    git diff --no-ext-diff --binary HEAD
    git diff --cached --no-ext-diff --binary HEAD
  } | git hash-object --stdin
}

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
    resolve_node_npm
    previous_head="$(git rev-parse --verify HEAD)"
    echo "→ git pull"
    if ! git pull --ff-only; then
      echo "✗ git pull failed; dependencies and the service were not changed." >&2
      exit 1
    fi
    pulled_head="$(git rev-parse --verify HEAD)"

    # Preserve the exact lockfile state that existed before npm. A clean
    # lockfile may be restored to the pulled commit if npm alone rewrites it;
    # a pre-existing staged/unstaged edit belongs to the operator.
    lock_started_clean=true
    lock_existed=false
    lock_backup=""
    lock_status_before_npm="$(git status --porcelain=v1 -- package-lock.json)"
    if [ -f package-lock.json ]; then lock_existed=true; fi
    if [ -n "$lock_status_before_npm" ]; then
      lock_started_clean=false
      lock_backup="$(mktemp "${TMPDIR:-/tmp}/oe-package-lock.XXXXXX")"
      if $lock_existed; then cp -p package-lock.json "$lock_backup"; fi
    fi
    cleanup_update_lock_backup() {
      if [ -n "${lock_backup:-}" ]; then rm -f -- "$lock_backup"; fi
    }
    trap cleanup_update_lock_backup EXIT

    expected_state="$(tracked_state_fingerprint)"
    expected_index_clean=true
    if ! git diff --cached --quiet; then expected_index_clean=false; fi

    restore_update_lock() {
      local expected_head="$1" phase="${2:-install}" current_head lock_status lock_hash
      current_head="$(git rev-parse --verify HEAD 2>/dev/null || true)"
      if [ "$current_head" != "$expected_head" ]; then
        echo "✗ HEAD moved during npm $phase; package-lock.json was left untouched." >&2
        return 1
      fi

      if ! $lock_started_clean; then
        if $lock_existed; then
          cp -p "$lock_backup" package-lock.json
        else
          rm -f -- package-lock.json
        fi
        echo "→ preserved pre-existing package-lock.json edit"
        return 0
      fi

      lock_status="$(git status --porcelain=v1 -- package-lock.json)"
      [ -z "$lock_status" ] && return 0
      if [ "$lock_status" != " M package-lock.json" ] || [ ! -f package-lock.json ]; then
        echo "✗ package-lock.json changed unexpectedly during npm $phase; it was not overwritten." >&2
        return 1
      fi

      # Recheck both HEAD and the lock contents immediately before the scoped
      # checkout. This narrows the race window without ever resetting the tree.
      lock_hash="$(git hash-object package-lock.json)"
      if [ "$(git rev-parse --verify HEAD 2>/dev/null || true)" != "$expected_head" ] \
        || [ "$(git status --porcelain=v1 -- package-lock.json)" != " M package-lock.json" ] \
        || [ "$(git hash-object package-lock.json 2>/dev/null || true)" != "$lock_hash" ]; then
        echo "✗ package-lock.json changed concurrently; it was not overwritten." >&2
        return 1
      fi
      git checkout -- package-lock.json
      echo "→ restored npm-generated package-lock.json drift"
    }

    echo "→ npm install"
    "$NODE_BIN" scripts/ensure-deps.mjs --mark-uncertain
    if "$NPM_BIN" install --prefer-offline --no-save --no-audit --no-fund; then
      if ! restore_update_lock "$pulled_head" install; then
        echo "✗ Dependencies installed, but the source changed concurrently; the service was not restarted." >&2
        exit 1
      fi
      post_install_state=""
      if ! post_install_state="$(tracked_state_fingerprint)" \
        || [ "$post_install_state" != "$expected_state" ]; then
        echo "✗ A tracked source edit changed during npm install; it was preserved and the service was not restarted." >&2
        exit 1
      fi
    else
      npm_status=$?
      echo "✗ npm install failed; attempting a guarded rollback." >&2
      lock_restored=true
      restore_update_lock "$pulled_head" failed-install || lock_restored=false

      rollback_safe=true
      current_state=""
      if [ "$(git rev-parse --verify HEAD 2>/dev/null || true)" != "$pulled_head" ]; then
        rollback_safe=false
      elif ! current_state="$(tracked_state_fingerprint)"; then
        rollback_safe=false
      elif [ "$current_state" != "$expected_state" ] || ! $expected_index_clean || ! $lock_restored; then
        rollback_safe=false
      fi

      if [ "$previous_head" = "$pulled_head" ]; then
        echo "  No source revision changed, so there is no earlier revision to restore." >&2
      elif ! $rollback_safe; then
        echo "  Rollback refused because HEAD or tracked edits changed during npm install." >&2
        echo "  Your edits were left intact; inspect the tree and run npm install manually." >&2
      elif git reset --keep "$previous_head" \
        && [ "$(git rev-parse --verify HEAD 2>/dev/null || true)" = "$previous_head" ]; then
        echo "→ previous source revision restored; repairing dependencies"
        rollback_npm_ok=false
        if "$NPM_BIN" install --prefer-offline --no-save --no-audit --no-fund; then
          rollback_npm_ok=true
        fi
        rollback_lock_ok=true
        restore_update_lock "$previous_head" rollback || rollback_lock_ok=false
        if $rollback_npm_ok && $rollback_lock_ok; then
          if ! "$NODE_BIN" scripts/ensure-deps.mjs --record-installed; then
            echo "  Previous dependencies were restored, but their state marker could not be recorded." >&2
          fi
          echo "  Previous source and dependencies restored; service was not restarted." >&2
        else
          echo "  Previous source was restored, but dependency repair failed; service was not restarted." >&2
        fi
      else
        echo "  Guarded source rollback failed; your working-tree edits were not reset." >&2
      fi
      exit "$npm_status"
    fi

    if ! "$NODE_BIN" scripts/ensure-deps.mjs --record-installed; then
      echo "✗ Dependencies installed, but their state marker could not be recorded; the service was not restarted." >&2
      exit 1
    fi
    echo "→ refresh oe wrapper"
    if [ -f "$INSTALL_DIR/scripts/oe-cli.template.sh" ]; then
      wrapper_tmp="$0.tmp.$$"
      sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$INSTALL_DIR/scripts/oe-cli.template.sh" > "$wrapper_tmp"
      chmod +x "$wrapper_tmp"
      mv "$wrapper_tmp" "$0"
    fi
    echo "→ restart service"
    if ! systemctl --user restart "$SERVICE"; then
      echo "✗ Update installed, but the service restart failed." >&2
      echo "  Start manually with $INSTALL_DIR/start.sh after checking the service logs." >&2
      exit 1
    fi
    if ! systemctl --user is-active --quiet "$SERVICE"; then
      echo "✗ Update installed, but the service is not active after restart." >&2
      echo "  Check: systemctl --user status $SERVICE" >&2
      exit 1
    fi
    echo "✓ Update complete"
    ;;
  bench)
    cd "$INSTALL_DIR"
    exec node scripts/bench.mjs "$@"
    ;;
  bootstrap)
    cd "$INSTALL_DIR"
    exec node scripts/first-run-bootstrap.mjs
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
  bootstrap           Show the local one-time first-run credential
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
