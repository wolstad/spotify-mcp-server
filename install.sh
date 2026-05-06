#!/usr/bin/env bash
#
# Spotify MCP Server installer for Debian/Ubuntu LXCs.
#
# Idempotent — re-running it on an existing install pulls latest code,
# rebuilds, migrates state from /opt/spotify-mcp/ to /etc/spotify-mcp/ on
# first run after upgrade, and leaves .env / .spotify-tokens untouched on
# every run after that.
#
# Invoke from inside the LXC, as root:
#   bash <(curl -fsSL https://raw.githubusercontent.com/wolstad/spotify-mcp-server/main/install.sh)

set -euo pipefail

# ----- Configuration ----------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/wolstad/spotify-mcp-server.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/spotify-mcp}"
STATE_DIR="${STATE_DIR:-/etc/spotify-mcp}"
SERVICE_USER="${SERVICE_USER:-spotify-mcp}"
SYSTEMD_UNIT="/etc/systemd/system/spotify-mcp.service"
NODE_MAJOR=22

# ----- Flags ------------------------------------------------------------------
BRANCH="main"
BRANCH_EXPLICIT=0
NON_INTERACTIVE=0

usage() {
  cat <<'EOF'
Usage: install.sh [--branch <name>] [--non-interactive] [--help]

  --branch <name>       Install or update from a specific branch (default: main).
                        Only forces a checkout when explicitly passed.
  --non-interactive     Fail rather than prompt for confirmations.
  --help                Print this message.

The script is idempotent — re-running it pulls latest code, rebuilds, and
preserves .env / .spotify-tokens. State files migrate from /opt/spotify-mcp/
to /etc/spotify-mcp/ on the first run after upgrade.
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --branch)
      [[ $# -ge 2 ]] || { echo "--branch requires an argument" >&2; exit 2; }
      BRANCH="$2"
      BRANCH_EXPLICIT=1
      shift 2
      ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ----- Output helpers ---------------------------------------------------------
section() { printf '\n\033[1;34m==> %s\033[0m\n' "$1"; }
info()    { printf '    %s\n' "$1"; }
ok()      { printf '    \033[1;32m✓\033[0m %s\n' "$1"; }
fail()    { printf '    \033[1;31m✗\033[0m %s\n' "$1" >&2; }

trap 'fail "Install failed at line $LINENO. Re-run after fixing the above; the script is idempotent."' ERR

# ----- Sanity checks ----------------------------------------------------------
section "Sanity checks"
[[ "$(uname -s)" == "Linux" ]]   || { fail "Linux only.";        exit 1; }
[[ "$(id -u)"   == "0"     ]]    || { fail "Must run as root.";  exit 1; }
[[ -r /etc/os-release ]]         || { fail "Cannot read /etc/os-release."; exit 1; }
# shellcheck source=/dev/null
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *" debian "*|*" ubuntu "*) ;;
  *) fail "Only Debian/Ubuntu are supported (detected: ${ID:-unknown})."; exit 1 ;;
esac
ok "Linux, root, ${PRETTY_NAME:-${ID:-unknown}}"

# ----- Detect install mode ----------------------------------------------------
if [[ -d "$INSTALL_DIR/.git" ]]; then
  MODE="update"
elif [[ -d "$INSTALL_DIR" ]]; then
  fail "$INSTALL_DIR exists but is not a git checkout. Move or remove it before re-running."
  exit 1
else
  MODE="fresh"
fi
ok "Install mode: $MODE"

SERVICE_WAS_ACTIVE=0
if systemctl is-active --quiet spotify-mcp 2>/dev/null; then
  SERVICE_WAS_ACTIVE=1
fi

# ----- Prerequisites ----------------------------------------------------------
section "Prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates git openssl >/dev/null
ok "curl, ca-certificates, git, openssl present"

NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CURRENT_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node).split(".")[0])' 2>/dev/null || echo 0)"
  if (( CURRENT_MAJOR >= NODE_MAJOR )); then
    NEED_NODE=0
    ok "Node $(node --version) already installed"
  fi
fi
if (( NEED_NODE )); then
  info "Installing Node ${NODE_MAJOR}.x via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node --version) installed"
fi

# ----- Service user -----------------------------------------------------------
section "Service user"
if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "User $SERVICE_USER already exists"
else
  adduser --system --group --home "$INSTALL_DIR" --no-create-home \
    --shell /usr/sbin/nologin "$SERVICE_USER" >/dev/null
  ok "Created system user $SERVICE_USER"
fi

# ----- Source code ------------------------------------------------------------
section "Source code"
if [[ "$MODE" == "fresh" ]]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
  ok "Cloned $REPO_URL ($BRANCH) to $INSTALL_DIR"
else
  CURRENT_BRANCH="$(sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" rev-parse --abbrev-ref HEAD)"
  if (( BRANCH_EXPLICIT )) && [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
    info "Switching from $CURRENT_BRANCH to $BRANCH"
    sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" fetch origin "$BRANCH" >/dev/null 2>&1
    sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" checkout "$BRANCH" >/dev/null 2>&1
    CURRENT_BRANCH="$BRANCH"
  fi
  sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" pull --ff-only >/dev/null
  ok "Updated $INSTALL_DIR to latest $CURRENT_BRANCH"
fi

# ----- Build ------------------------------------------------------------------
section "Build"
sudo -u "$SERVICE_USER" -H bash -c "cd '$INSTALL_DIR' && npm ci --silent && npm run build --silent" >/dev/null
ok "Dependencies installed and TypeScript compiled"

# ----- State directory + migration --------------------------------------------
section "State directory"
if [[ ! -d "$STATE_DIR" ]]; then
  install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_DIR"
  ok "Created $STATE_DIR (mode 750, owner $SERVICE_USER)"
else
  chown "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR"
  chmod 750 "$STATE_DIR"
  ok "$STATE_DIR present; ensured ownership and mode"
fi

MIGRATED=0
SPLIT_STATE=0
for fname in .env .spotify-tokens; do
  if [[ -f "$INSTALL_DIR/$fname" && -e "$STATE_DIR/$fname" ]]; then
    info "Both $INSTALL_DIR/$fname and $STATE_DIR/$fname exist — leaving $STATE_DIR/ as the source of truth. Remove $INSTALL_DIR/$fname when ready."
    SPLIT_STATE=1
  elif [[ -f "$INSTALL_DIR/$fname" && ! -e "$STATE_DIR/$fname" ]]; then
    mv "$INSTALL_DIR/$fname" "$STATE_DIR/$fname"
    chown "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR/$fname"
    chmod 600 "$STATE_DIR/$fname"
    ok "Migrated $fname → $STATE_DIR/"
    MIGRATED=1
  fi
done
if (( MIGRATED == 0 && SPLIT_STATE == 0 )); then
  ok "No legacy state to migrate"
fi

# ----- .env generation (fresh installs only) ----------------------------------
GENERATED_TOKEN=""
if [[ ! -f "$STATE_DIR/.env" ]]; then
  section "Generating .env"
  cp "$INSTALL_DIR/.env.example" "$STATE_DIR/.env"
  GENERATED_TOKEN="$(openssl rand -hex 32)"
  # Replace the empty MCP_HTTP_TOKEN= line.
  sed -i "s|^MCP_HTTP_TOKEN=$|MCP_HTTP_TOKEN=$GENERATED_TOKEN|" "$STATE_DIR/.env"
  chown "$SERVICE_USER:$SERVICE_USER" "$STATE_DIR/.env"
  chmod 600 "$STATE_DIR/.env"
  ok "Wrote $STATE_DIR/.env (mode 600)"
fi

# ----- systemd unit -----------------------------------------------------------
section "systemd unit"
NEW_UNIT="$INSTALL_DIR/deploy/spotify-mcp.service"
NEEDS_RELOAD=0
if [[ ! -f "$SYSTEMD_UNIT" ]] || ! cmp -s "$NEW_UNIT" "$SYSTEMD_UNIT"; then
  install -m 644 "$NEW_UNIT" "$SYSTEMD_UNIT"
  NEEDS_RELOAD=1
  ok "Installed $SYSTEMD_UNIT"
else
  ok "$SYSTEMD_UNIT already up to date"
fi
if (( NEEDS_RELOAD )); then
  systemctl daemon-reload
  ok "systemd reloaded"
fi
systemctl enable spotify-mcp >/dev/null 2>&1
ok "Service enabled (will start on boot)"

# ----- Service state ----------------------------------------------------------
section "Service state"
if [[ "$MODE" == "fresh" ]]; then
  ok "Fresh install — service NOT started yet (OAuth has not been run)"
elif (( SERVICE_WAS_ACTIVE )); then
  systemctl restart spotify-mcp
  sleep 2
  if systemctl is-active --quiet spotify-mcp; then
    ok "Service restarted and active"
  else
    fail "Service failed to start. Check: journalctl -u spotify-mcp -n 30 --no-pager"
    exit 1
  fi
else
  ok "Service was not running before — leaving stopped"
fi

# ----- Next steps -------------------------------------------------------------
printf '\n\033[1;32m✅ Install complete.\033[0m\n\n'

if [[ "$MODE" == "fresh" ]]; then
  cat <<'EOF'
Next steps:

  1. Edit credentials:
       nano /etc/spotify-mcp/.env
     Fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET from your
     Spotify Developer Dashboard (https://developer.spotify.com/dashboard).
     The redirect URI on the dashboard must be http://127.0.0.1:8888/callback.

  2. Run the OAuth flow (from your workstation, not the LXC):
       ssh -L 8888:127.0.0.1:8888 root@<this-lxc-ip>
       sudo -u spotify-mcp -H bash -c 'cd /opt/spotify-mcp && npm run auth'
     Open the URL printed to your terminal in your browser.

  3. Start the service:
       systemctl start spotify-mcp
       systemctl status spotify-mcp

  4. Add to Claude Desktop's config (see README "Connecting Claude Desktop"):
       Server URL: http://<this-lxc-ip>:3000/mcp
       Bearer token: (printed below)

EOF
  if [[ -n "$GENERATED_TOKEN" ]]; then
    printf '       \033[1;33m%s\033[0m\n\n' "$GENERATED_TOKEN"
    info "(This is the only time the token is displayed. It is also stored in $STATE_DIR/.env.)"
  fi
else
  cat <<'EOF'
Service updated. State and tokens preserved at /etc/spotify-mcp/.

  systemctl status spotify-mcp
  journalctl -u spotify-mcp -n 30 --no-pager

EOF
fi
