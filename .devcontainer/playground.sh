#!/usr/bin/env bash
# Ryu playground lifecycle for GitHub Codespaces (and any dev container).
#
#   playground.sh install   install runtime libraries, the release binaries,
#                           and the same release's browser UI bundle
#   playground.sh start     start Ryu Core, then the browser UI server (idempotent)
#   playground.sh attach    print the welcome banner; open the terminal UI only
#                           when the browser UI is not available
#   playground.sh web       start the browser UI server and print its address
#   playground.sh tui       wait for Core, then open the Ryu terminal UI
#   playground.sh status    show Core and browser UI health, PIDs, and log paths
#   ryu-playground          same as `playground.sh tui` (symlink made by install)
#
# Nothing here compiles anything: the binaries (via install.sh) and the browser
# UI bundle (ryu-webapp-playground.tar.gz) come from one published release, and
# each download is checked against its published sha256 before it is used.
#
# The browser UI server (playground-web.py, Python standard library) listens on
# 127.0.0.1:7990. It serves the bundle and forwards Core's API to Core on
# 127.0.0.1:7980, adding Core's token server-side, so the page never holds the
# token. Codespaces forwards 7990 privately to the codespace owner and opens it
# in a browser tab.
#
# Environment:
#   RYU_DIR                 Core data directory (default /workspaces/.ryu-playground)
#   RYU_PLAYGROUND_VERSION  release tag to pin, e.g. v0.4.0 (default: latest)
#   RYU_CORE_URL            Core URL (default http://127.0.0.1:7980)
#   RYU_PLAYGROUND_RELEASES_URL  where the browser UI bundle is fetched from
#                           (default https://github.com/amajorai/ryu/releases;
#                           for testing a release mirror)
set -euo pipefail

# Resolve through the ~/.ryu/bin/ryu-playground symlink to this file.
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
INSTALL_SCRIPT_URL="https://raw.githubusercontent.com/amajorai/ryu/main/install.sh"
RELEASES_URL="${RYU_PLAYGROUND_RELEASES_URL:-https://github.com/amajorai/ryu/releases}"
WEB_ASSET="ryu-webapp-playground.tar.gz"

BIN_DIR="$HOME/.ryu/bin"
CORE_BIND="127.0.0.1:7980"
CORE_URL="${RYU_CORE_URL:-http://127.0.0.1:7980}"
HEALTH_TIMEOUT_SECONDS=600
WEB_BIND="127.0.0.1:7990"
WEB_PORT="${WEB_BIND##*:}"
WEB_LOCAL_URL="http://$WEB_BIND"
WEB_DIR="$HOME/.ryu/playground-web"
WEB_SERVER="$SCRIPT_DIR/playground-web.py"
WEB_START_TIMEOUT_SECONDS=30

# Data dir first, with a home-directory fallback for containers where
# /workspaces is not writable. The token and logs sit beside it, not inside it,
# so Core's own data-dir layout stays untouched.
resolve_data_dir() {
  local preferred="${RYU_DIR:-/workspaces/.ryu-playground}"
  if mkdir -p "$preferred" 2>/dev/null && [ -w "$preferred" ]; then
    printf '%s\n' "$preferred"
    return 0
  fi
  mkdir -p "$HOME/.ryu-playground"
  printf '%s\n' "$HOME/.ryu-playground"
}

RYU_DIR="$(resolve_data_dir)"
export RYU_DIR
TOKEN_FILE="$RYU_DIR.token"
CORE_LOG="$RYU_DIR-core.log"
PID_FILE="$RYU_DIR-core.pid"
LOCK_FILE="$RYU_DIR-core.lock"
WEB_LOG="$RYU_DIR-web.log"
WEB_PID_FILE="$RYU_DIR-web.pid"
WEB_LOCK_FILE="$RYU_DIR-web.lock"

export PATH="$BIN_DIR:$PATH"

info() { printf '  %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

core_healthy() {
  curl -fsS --max-time 3 "$CORE_URL/api/health" >/dev/null 2>&1
}

wait_for_core() { # <timeout-seconds> <show-spinner 0|1>
  local timeout="$1" spinner="$2" waited=0 frames='-=*=' frame=0
  while ! core_healthy; do
    if [ "$waited" -ge "$timeout" ]; then
      [ "$spinner" = "1" ] && printf '\r'
      return 1
    fi
    if [ "$spinner" = "1" ]; then
      printf '\r  %s waiting for Ryu Core to become ready (%ss)' "${frames:frame:1}" "$waited"
      frame=$(((frame + 1) % 4))
    fi
    sleep 1
    waited=$((waited + 1))
  done
  [ "$spinner" = "1" ] && printf '\r%60s\r' ''
  return 0
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    printf '\n'
  fi
}

ensure_token() {
  if [ -s "$TOKEN_FILE" ]; then
    return 0
  fi
  (
    umask 077
    generate_token >"$TOKEN_FILE"
  )
  chmod 600 "$TOKEN_FILE"
}

resolve_installer() {
  # Public repo: install.sh at the root. Private source repo: the overlay copy.
  local candidate
  for candidate in "$REPO_ROOT/install.sh" "$REPO_ROOT/mirror/overlay/install.sh"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  local downloaded
  downloaded="$(mktemp)"
  curl -fsSL "$INSTALL_SCRIPT_URL" -o "$downloaded" || err "could not download $INSTALL_SCRIPT_URL"
  printf '%s\n' "$downloaded"
}

install_libraries() {
  local sudo_cmd=""
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || err "need root or sudo to install runtime libraries"
    sudo_cmd="sudo"
  fi
  export DEBIAN_FRONTEND=noninteractive
  $sudo_cmd apt-get update -y
  # Ubuntu 24.04+ renamed libasound2 to libasound2t64 (time_t transition).
  local asound="libasound2"
  if apt-cache show libasound2t64 >/dev/null 2>&1; then
    asound="libasound2t64"
  fi
  # python3 runs the browser UI server (standard library only).
  $sudo_cmd apt-get install -y --no-install-recommends \
    ca-certificates curl openssl libssl3 libdbus-1-3 libstdc++6 libopus0 "$asound" \
    python3
}

# Link the commands into /usr/local/bin so a new terminal finds them whatever
# its user or PATH. Best effort: remoteEnv PATH covers the common case.
link_commands() {
  local sudo_cmd="" name
  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || return 0
    sudo_cmd="sudo"
  fi
  for name in ryu-playground ryu-cli; do
    if [ -e "$BIN_DIR/$name" ]; then
      $sudo_cmd ln -sf "$BIN_DIR/$name" "/usr/local/bin/$name" || true
    fi
  done
}

# The release tag to install: the pinned one, else the current latest release.
# Resolving "latest" once keeps the binaries and the browser UI on one version.
resolve_release_tag() {
  if [ -n "${RYU_PLAYGROUND_VERSION:-}" ]; then
    printf '%s\n' "$RYU_PLAYGROUND_VERSION"
    return 0
  fi
  local effective tag
  effective="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES_URL/latest" 2>/dev/null)" || return 1
  tag="${effective##*/tag/}"
  if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.+-][0-9A-Za-z.-]+)?$ ]]; then
    printf '%s\n' "$tag"
    return 0
  fi
  return 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Download, verify, and unpack a release's browser UI bundle into WEB_DIR.
# Returns non-zero without touching WEB_DIR when the release publishes no
# bundle (older releases) or the download fails its checks.
install_web_bundle() { # <release tag, or empty for the latest release>
  local tag="$1" base work want got bundle
  if [ -n "$tag" ]; then
    base="$RELEASES_URL/download/$tag"
  else
    base="$RELEASES_URL/latest/download"
  fi
  work="$(mktemp -d)"
  if ! curl -fsSL "$base/$WEB_ASSET.sha256" -o "$work/asset.sha256" 2>/dev/null; then
    rm -rf "$work"
    warn "release ${tag:-latest} publishes no $WEB_ASSET"
    return 1
  fi
  want="$(awk '{print $1; exit}' "$work/asset.sha256")"
  if [[ ! "$want" =~ ^[0-9a-f]{64}$ ]]; then
    rm -rf "$work"
    warn "malformed checksum file for $WEB_ASSET; not installing it"
    return 1
  fi
  if ! curl -fsSL "$base/$WEB_ASSET" -o "$work/asset.tar.gz"; then
    rm -rf "$work"
    warn "could not download $WEB_ASSET from release ${tag:-latest}"
    return 1
  fi
  got="$(sha256_of "$work/asset.tar.gz")"
  if [ "$want" != "$got" ]; then
    rm -rf "$work"
    warn "checksum mismatch for $WEB_ASSET (want $want, got $got); not installing it"
    return 1
  fi
  mkdir "$work/extract"
  bundle="$work/extract/ryu-webapp-playground"
  if ! tar -xzf "$work/asset.tar.gz" -C "$work/extract" --no-same-owner --no-same-permissions \
    || [ ! -f "$bundle/index.html" ]; then
    rm -rf "$work"
    warn "$WEB_ASSET does not contain a browser UI bundle; not installing it"
    return 1
  fi
  # Precompress text assets once, so the forwarded port can serve gzip.
  find "$bundle" -type f -size +1k \
    \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' \
    -o -name '*.svg' -o -name '*.json' -o -name '*.wasm' -o -name '*.txt' \) \
    -exec gzip -k -6 -f {} + 2>/dev/null || true
  printf '%s\n' "${tag:-latest}" >"$bundle/.ryu-release"
  rm -rf "$WEB_DIR"
  mkdir -p "$(dirname "$WEB_DIR")"
  mv "$bundle" "$WEB_DIR"
  rm -rf "$work"
}

web_available() {
  [ -f "$WEB_DIR/index.html" ] && [ -f "$WEB_SERVER" ] && command -v python3 >/dev/null 2>&1
}

web_healthy() {
  curl -fsS --max-time 3 -o /dev/null "$WEB_LOCAL_URL/" 2>/dev/null
}

# The address the codespace owner opens. Codespaces sets both variables; in
# any other dev container the editor forwards the loopback address itself.
web_public_url() {
  if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
    printf 'https://%s-%s.%s/\n' "$CODESPACE_NAME" "$WEB_PORT" "$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN"
  else
    printf '%s/\n' "$WEB_LOCAL_URL"
  fi
}

cmd_install() {
  printf 'Ryu playground: installing runtime libraries\n'
  install_libraries

  local installer tag
  installer="$(resolve_installer)"
  tag="$(resolve_release_tag)" || tag=""
  printf 'Ryu playground: installing release %s binaries with %s\n' "${tag:-latest}" "$installer"
  if [ -n "$tag" ]; then
    RYU_VERSION="$tag" RYU_INSTALL_MARKER="$tag" RYU_START_CORE=0 RYU_NO_MODIFY_PATH=1 \
      RYU_INSTALL_DIR="$BIN_DIR" sh "$installer"
  else
    RYU_START_CORE=0 RYU_NO_MODIFY_PATH=1 RYU_INSTALL_DIR="$BIN_DIR" sh "$installer"
  fi

  printf 'Ryu playground: installing the browser UI from release %s\n' "${tag:-latest}"
  if install_web_bundle "$tag"; then
    info "browser UI installed in $WEB_DIR"
  else
    # Never serve a bundle from a different release than the binaries.
    rm -rf "$WEB_DIR"
    info "no browser UI for this release; the playground opens the terminal UI"
  fi

  ensure_token
  ln -sf "$SCRIPT_PATH" "$BIN_DIR/ryu-playground"
  link_commands
  info "data dir: $RYU_DIR"
  info "open the terminal UI any time with: ryu-playground"
}

cmd_start() {
  [ -x "$BIN_DIR/ryu-core" ] || err "ryu-core is not installed; run: bash .devcontainer/playground.sh install"
  ensure_token
  # postStartCommand and postAttachCommand can run at the same time. Hold one
  # lock across the health check, spawn, and wait so only one Core starts.
  exec 9>"$LOCK_FILE"
  flock 9
  if core_healthy; then
    info "Ryu Core is already running at $CORE_URL"
    exec 9>&-
    start_web_if_available
    return 0
  fi

  if pgrep -f "$BIN_DIR/ryu-core" >/dev/null 2>&1; then
    printf 'Ryu playground: Ryu Core is starting; waiting for it\n'
  else
    printf 'Ryu playground: starting Ryu Core on %s\n' "$CORE_BIND"
    RYU_TOKEN="$(cat "$TOKEN_FILE")" nohup "$BIN_DIR/ryu-core" "--bind=$CORE_BIND" \
      >>"$CORE_LOG" 2>&1 </dev/null 9>&- &
    printf '%s\n' "$!" >"$PID_FILE"
  fi

  if ! wait_for_core "$HEALTH_TIMEOUT_SECONDS" 0; then
    exec 9>&-
    printf 'error: Ryu Core did not become healthy within %ss\n' "$HEALTH_TIMEOUT_SECONDS" >&2
    tail -n 50 "$CORE_LOG" >&2 || true
    exit 1
  fi
  exec 9>&-
  info "Ryu Core is ready at $CORE_URL"
  start_web_if_available
}

# Start the browser UI server. Idempotent: one lock covers the check, spawn,
# and wait, like Core's. The server reads the token file per request.
start_web() {
  exec 8>"$WEB_LOCK_FILE"
  flock 8
  if web_healthy; then
    exec 8>&-
    return 0
  fi
  if ! pgrep -f "$WEB_SERVER" >/dev/null 2>&1; then
    printf 'Ryu playground: starting the browser UI on %s\n' "$WEB_BIND"
    # Only loopback and the Codespaces forwarding name may reach Core with the
    # owner token; any other Host (DNS rebinding) or foreign Origin gets 403.
    local allowed_host_args=()
    if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
      allowed_host_args=(--allowed-host "$CODESPACE_NAME-$WEB_PORT.$GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN")
    fi
    nohup python3 -I "$WEB_SERVER" --root "$WEB_DIR" --token-file "$TOKEN_FILE" \
      --listen "$WEB_BIND" --upstream "$CORE_BIND" "${allowed_host_args[@]}" \
      >>"$WEB_LOG" 2>&1 </dev/null 8>&- &
    printf '%s\n' "$!" >"$WEB_PID_FILE"
  fi
  local waited=0
  while ! web_healthy; do
    if [ "$waited" -ge "$WEB_START_TIMEOUT_SECONDS" ]; then
      exec 8>&-
      warn "the browser UI did not start; log: $WEB_LOG"
      tail -n 20 "$WEB_LOG" >&2 || true
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  exec 8>&-
  info "Ryu browser UI is ready at $(web_public_url)"
}

start_web_if_available() {
  if web_available; then
    start_web || true
  fi
}

cmd_web() {
  web_available || err "this release has no browser UI; open the terminal UI with: ryu-playground"
  if core_healthy; then
    start_web || exit 1
  else
    cmd_start
    web_healthy || exit 1
  fi
}

# Core's default chat route reads its key only from RYU_DEFAULT_LLM_API_KEY or
# OPENAI_API_KEY; other provider keys reach the Gateway but not that route.
has_provider_key() {
  [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${RYU_DEFAULT_LLM_API_KEY:-}" ]
}

print_key_hint() {
  if ! has_provider_key; then
    cat <<'EOF'
  No chat key found, so chat has no model yet. Add OPENAI_API_KEY, or for
  another OpenAI-compatible provider RYU_DEFAULT_LLM_API_KEY together with
  RYU_DEFAULT_LLM_BASE_URL and RYU_DEFAULT_LLM_MODEL. Enter them on the
  codespace create page, or add them as personal Codespaces secrets
  (github.com/settings/codespaces) with access to this repository, then
  rebuild or restart the codespace.

EOF
  fi
}

print_web_banner() {
  cat <<'EOF'

  ┌──────────────────────────────────────────────────────────────┐
  │  Ryu playground                                              │
  │  Ryu Core runs in this codespace, and the Ryu web app opens  │
  │  in a new browser tab. If the tab did not open, use the link │
  │  below or the "Ryu" row in the Ports panel.                  │
  │  Prefer the terminal? Type:  ryu-playground                  │
  └──────────────────────────────────────────────────────────────┘

EOF
  printf '  Ryu web app: %s\n\n' "$(web_public_url)"
}

print_tui_banner() {
  cat <<'EOF'

  ┌──────────────────────────────────────────────────────────────┐
  │  Ryu playground                                              │
  │  Ryu Core runs in this codespace; the Ryu terminal UI opens  │
  │  below. Reopen it any time by typing:  ryu-playground        │
  └──────────────────────────────────────────────────────────────┘

EOF
}

# postAttachCommand. The browser tab is the main UI when the installed release
# ships the bundle; otherwise this opens the terminal UI as before.
cmd_attach() {
  if web_available; then
    if core_healthy; then
      start_web_if_available
    else
      cmd_start
    fi
    if web_healthy; then
      print_web_banner
      print_key_hint
      return 0
    fi
    warn "the browser UI is not responding; opening the terminal UI instead"
  else
    printf '\n  This release has no browser UI, so the playground opens the Ryu terminal UI.\n'
  fi
  cmd_tui
}

cmd_tui() {
  print_tui_banner
  print_key_hint
  ensure_token
  if ! core_healthy; then
    # postStartCommand normally starts Core first. If it has not spawned Core
    # yet, cmd_start takes the same lock, so the two never both spawn one.
    if ! pgrep -f "$BIN_DIR/ryu-core" >/dev/null 2>&1; then
      cmd_start
    fi
    if ! wait_for_core "$HEALTH_TIMEOUT_SECONDS" 1; then
      printf 'error: Ryu Core is not responding at %s. Logs: %s\n' "$CORE_URL" "$CORE_LOG" >&2
      exit 1
    fi
  fi
  [ -x "$BIN_DIR/ryu-cli" ] || err "ryu-cli is not installed; run: bash .devcontainer/playground.sh install"
  RYU_CORE_URL="$CORE_URL" RYU_CORE_TOKEN="$(cat "$TOKEN_FILE")" exec "$BIN_DIR/ryu-cli"
}

cmd_status() {
  if core_healthy; then
    info "Ryu Core: healthy at $CORE_URL"
  else
    info "Ryu Core: not responding at $CORE_URL"
  fi
  if [ -s "$PID_FILE" ]; then
    info "PID: $(cat "$PID_FILE")"
  fi
  if ! web_available; then
    info "browser UI: not installed for this release (the install log says why)"
  elif web_healthy; then
    info "browser UI: serving at $(web_public_url)"
  else
    info "browser UI: not responding (start it with: bash .devcontainer/playground.sh web)"
  fi
  if [ -s "$WEB_PID_FILE" ]; then
    info "browser UI PID: $(cat "$WEB_PID_FILE")"
  fi
  info "data dir: $RYU_DIR"
  info "log: $CORE_LOG"
  info "browser UI log: $WEB_LOG"
}

# Invoked as `ryu-playground` (the symlink), the default is the terminal UI.
default_command=""
if [ "$(basename "$0")" = "ryu-playground" ]; then
  default_command="tui"
fi

case "${1:-$default_command}" in
  install) cmd_install ;;
  start) cmd_start ;;
  attach) cmd_attach ;;
  web) cmd_web ;;
  tui) cmd_tui ;;
  status) cmd_status ;;
  *)
    printf 'usage: %s {install|start|attach|web|tui|status}\n' "$(basename "$0")" >&2
    exit 2
    ;;
esac
