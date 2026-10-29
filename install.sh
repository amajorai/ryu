#!/bin/sh
# Ryu one-line installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/amajorai/ryu/main/install.sh | sh
#
# Installs and starts the headless stack — ryu-core, ryu-gateway, ryu-cli — in
# ~/.ryu/bin. Starting Core is part of the install so the same entry point also
# kicks off the bundled models, engines, skills, and built-in defaults. Core owns
# those defaults; this script is the cross-surface bootstrap that starts them.
# Shadow and Ghost are preinstalled and started by Core. Island is preinstalled
# and kept up to date through the global download center, but remains stopped
# until the companion feature is enabled in a later release.
#
# Environment overrides:
#   RYU_INSTALL_DIR   install location            (default: $HOME/.ryu/bin)
#   RYU_VERSION       release tag e.g. v0.0.4      (default: latest)
#   RYU_SKIP_CHECKSUM 1 to skip sha256 verify      (default: verify, abort on failure)
#   RYU_NO_MODIFY_PATH 1 to leave shell rc untouched
#   RYU_START_CORE    0 to install binaries without starting Core (default: 1)
#   RYU_CORE_BIND     Core bind address (default: 127.0.0.1:7980)
#   RYU_CORE_URL      Core health URL (default: http://127.0.0.1:7980)
#   RYU_PROGRESS_FORMAT json to emit RYU_INSTALL_EVENT JSON lines for callers
#   RYU_INSTALL_MARKER version marker written beside installed binaries
#                     (default: $RYU_VERSION; an unpinned install always reinstalls)
#   RYU_FORCE_INSTALL 1 to reinstall even when the marker already matches
# Desktop supplies --release-base from its packaged distribution configuration.
set -eu

REPO="amajorai/ryu"
INSTALL_DIR="${RYU_INSTALL_DIR:-$HOME/.ryu/bin}"
BINARIES="ryu-core ryu-gateway ryu-cli"
PROGRESS_FORMAT="${RYU_PROGRESS_FORMAT:-human}"
START_CORE="${RYU_START_CORE:-1}"
CORE_BIND="${RYU_CORE_BIND:-127.0.0.1:7980}"
CORE_URL="${RYU_CORE_URL:-http://127.0.0.1:7980}"
# `latest` names no fixed release, so it never matches an existing install: a
# re-run of the one-liner must upgrade rather than report "already installed".
INSTALL_MARKER="${RYU_INSTALL_MARKER:-${RYU_VERSION:-latest}}"
FORCE_INSTALL="${RYU_FORCE_INSTALL:-0}"
EVENT_PREFIX="RYU_INSTALL_EVENT:"

info() { printf '  %s\n' "$1"; }
emit() {
  [ "$PROGRESS_FORMAT" = "json" ] || return 0
  phase="$1"
  component="$2"
  status="$3"
  percent="$4"
  printf '%s{"version":1,"phase":"%s","component":"%s","status":"%s","percent":%s}\n' \
    "$EVENT_PREFIX" "$phase" "$component" "$status" "$percent"
}
err()  { printf 'error: %s\n' "$1" >&2; exit 1; }
fail() {
  component="$1"
  message="$2"
  emit "error" "$component" "failed" 0
  err "$message"
}

RELEASE_BASE="https://github.com/amajorai/ryu/releases"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-base)
      [ "$#" -ge 2 ] || err "--release-base requires an HTTPS URL"
      RELEASE_BASE="$2"
      shift 2
      ;;
    *) err "unknown installer argument: $1" ;;
  esac
done
# This argument is native-owned in Desktop. Headless callers receive the same
# transport guard without adding a mutable environment override.
printf '%s\n' "$RELEASE_BASE" | LC_ALL=C grep -Eq '^https://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:[0-9]+)?(/[A-Za-z0-9._~!$&()+,;=:%/-]*)?$' \
  || err "release base must be HTTPS without credentials, query, or fragment"
case "$RELEASE_BASE" in
  *[[:space:][:cntrl:]]*) err "release base contains whitespace or control characters" ;;
esac
while [ "${RELEASE_BASE%/}" != "$RELEASE_BASE" ]; do
  RELEASE_BASE="${RELEASE_BASE%/}"
done

# --- detect OS/arch and map to release-asset suffix -------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64|aarch64) suffix="macos-aarch64" ;;
      x86_64) suffix="macos-x86_64" ;;
      *) err "macOS $arch is not supported by the prebuilt binaries. Build from source: https://github.com/$REPO#quick-start-self-host" ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64|amd64) suffix="linux-x86_64" ;;
      *) err "Linux $arch is not supported by the prebuilt binaries (only x86_64). Build from source: https://github.com/$REPO#quick-start-self-host" ;;
    esac
    ;;
  *)
    err "unsupported OS '$os'. On Windows use install.ps1; see https://github.com/$REPO#quick-start-self-host" ;;
esac

# --- pick a downloader ------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  dl() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -qO "$2" "$1"; }
else
  err "need curl or wget on PATH"
fi

if [ -n "${RYU_VERSION:-}" ]; then
  base="$RELEASE_BASE/download/$RYU_VERSION"
else
  base="$RELEASE_BASE/latest/download"
fi

# --- sha256 verification (fail closed) ---------------------------------------
# Releases publish a .sha256 next to every binary, so a missing/failed checksum
# is treated as an error, not a shrug — otherwise a network hiccup (or an
# attacker stripping the checksum) silently disables verification. Emergency
# escape hatch: RYU_SKIP_CHECKSUM=1.
sha_cmd=""
if command -v sha256sum >/dev/null 2>&1; then sha_cmd="sha256sum";
elif command -v shasum >/dev/null 2>&1; then sha_cmd="shasum -a 256"; fi

verify() { # <file> <sha_url>
  file="$1"; sha_url="$2"
  if [ "${RYU_SKIP_CHECKSUM:-0}" = "1" ]; then
    info "RYU_SKIP_CHECKSUM=1 — skipping checksum verification (not recommended)"
    return 0
  fi
  if [ -z "$sha_cmd" ]; then
    printf '%s\n' 'error: no sha256 tool (sha256sum/shasum) on PATH — install one, or set RYU_SKIP_CHECKSUM=1 to bypass verification (not recommended)' >&2
    return 1
  fi
  tmp_sha="$file.sha256"
  if ! dl "$sha_url" "$tmp_sha"; then
    printf 'error: could not download checksum %s — refusing to install an unverified binary (set RYU_SKIP_CHECKSUM=1 to bypass)\n' "$sha_url" >&2
    return 1
  fi
  want="$(awk '{print $1; exit}' "$tmp_sha")"
  got="$($sha_cmd "$file" | awk '{print $1}')"
  rm -f "$tmp_sha"
  if [ "${#want}" -ne 64 ]; then
    printf 'error: malformed checksum file at %s — refusing to install (set RYU_SKIP_CHECKSUM=1 to bypass)\n' "$sha_url" >&2
    return 1
  fi
  if [ "$want" != "$got" ]; then
    printf 'error: checksum mismatch for %s (want %s, got %s)\n' "$(basename "$file")" "$want" "$got" >&2
    return 1
  fi
}

# --- install ----------------------------------------------------------------
printf 'Installing Ryu (%s) into %s\n' "$suffix" "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
REPLACED_EXISTING=0

install_binary() {
  bin="$1"
  ordinal="$2"
  asset="$bin-$suffix"
  url="$base/$asset"
  dest="$INSTALL_DIR/$bin"
  out="$tmp/$bin"
  before=$(( (ordinal - 1) * 15 ))
  after=$(( ordinal * 15 ))

  if [ "$FORCE_INSTALL" != "1" ] && [ "$INSTALL_MARKER" != "latest" ] \
    && [ -x "$dest" ] && [ -f "$dest.version" ] \
    && [ "$(cat "$dest.version")" = "$INSTALL_MARKER" ]; then
    info "$bin already installed"
    emit "binary" "$bin" "skipped" "$after"
    return 0
  fi

  info "$bin"
  emit "binary" "$bin" "started" "$before"
  dl "$url" "$out" || fail "$bin" "download failed: $url"
  verify "$out" "$url.sha256" || fail "$bin" "verification failed: $url"
  chmod +x "$out"
  if [ -e "$dest" ]; then REPLACED_EXISTING=1; fi
  # Stage beside the destination, then rename: $tmp can be on another
  # filesystem, where mv may fall back to copying over a running Core/gateway
  # image (ETXTBSY) instead of swapping the directory entry.
  mv "$out" "$dest.new"
  mv -f "$dest.new" "$dest"
  printf '%s\n' "$INSTALL_MARKER" > "$dest.version"
  emit "binary" "$bin" "complete" "$after"
}

install_binary ryu-core 1
install_binary ryu-gateway 2
install_binary ryu-cli 3

# --- PATH -------------------------------------------------------------------
added_path=0
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    if [ "${RYU_NO_MODIFY_PATH:-0}" != "1" ]; then
      line="export PATH=\"$INSTALL_DIR:\$PATH\""
      for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
        [ -f "$rc" ] || continue
        grep -qF "$INSTALL_DIR" "$rc" 2>/dev/null && continue
        printf '\n# Ryu\n%s\n' "$line" >> "$rc"
        added_path=1
      done
    fi
    ;;
esac

printf '\nDone. Installed: %s\n' "$BINARIES"
if [ "$added_path" = "1" ]; then
  info "Added $INSTALL_DIR to your PATH — open a new terminal, or run:"
  info "  export PATH=\"$INSTALL_DIR:\$PATH\""
fi
if [ "$START_CORE" = "1" ]; then
  # The desktop and the one-line install now share this exact Core bring-up. The
  # Core process owns the default model/engine/skill installers and continues
  # those downloads in the background after its health endpoint is ready.
  emit "core" "ryu-core" "started" 55
  # RYU_CORE_LOG: legacy name the desktop installer still passes.
  core_log="${RYU_CORE_LOG_PATH:-${RYU_CORE_LOG:-$HOME/.ryu/ryu-core.log}}"
  core_dir="$(dirname "$core_log")"
  mkdir -p "$core_dir"

  http_ok() {
    if command -v curl >/dev/null 2>&1; then
      curl -fsS --max-time 3 "$CORE_URL/api/health" >/dev/null 2>&1
    else
      wget -qO- --timeout=3 "$CORE_URL/api/health" >/dev/null 2>&1
    fi
  }

  if ! http_ok; then
    info "starting Ryu Core"
    RYU_CORE_LOG_PATH="$core_log" nohup "$INSTALL_DIR/ryu-core" "--bind=$CORE_BIND" \
      >/dev/null 2>&1 </dev/null &
  else
    info "Ryu Core is already running"
    if [ "$REPLACED_EXISTING" = "1" ]; then
      # The running process keeps executing the previous build; only a restart
      # picks up the binaries this run just installed.
      info "Restart Ryu Core to run the upgraded binaries; the running process is still the previous build"
    fi
  fi

  healthy=0
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if http_ok; then
      healthy=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  [ "$healthy" = "1" ] || fail "ryu-core" "Ryu Core did not become healthy at $CORE_URL"
  emit "core" "ryu-core" "complete" 75

  info "Core is provisioning bundled models, engines, skills, and defaults"
  emit "defaults" "bundled-defaults" "started" 80
  info "Core is preinstalling Shadow, Ghost, and Island (Island stays stopped)"
  emit "defaults" "shadow" "started" 85
  emit "defaults" "ghost" "started" 90
  emit "defaults" "island" "started" 95
fi

emit "bootstrap" "ryu" "complete" 100
cat <<EOF

Next:
  ryu-core     # already running; bundled defaults continue provisioning
  ryu-cli      # in another terminal, connect the TUI to it

Point any OpenAI-compatible client at the Gateway: http://127.0.0.1:7981/v1
EOF
