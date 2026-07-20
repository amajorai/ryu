#!/bin/sh
# Ryu one-line installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/amajorai/ryu/main/install.sh | sh
#
# Downloads the headless stack — ryu-core, ryu-gateway, ryu-cli — into ~/.ryu/bin
# and puts it on your PATH. Core starts the Gateway and a fully-local model stack
# itself, so there is nothing else to wire up.
#
# Environment overrides:
#   RYU_INSTALL_DIR   install location            (default: $HOME/.ryu/bin)
#   RYU_VERSION       release tag e.g. v0.0.4      (default: latest)
#   RYU_SKIP_CHECKSUM 1 to skip sha256 verify      (default: verify when available)
#   RYU_NO_MODIFY_PATH 1 to leave shell rc untouched
set -eu

REPO="amajorai/ryu"
INSTALL_DIR="${RYU_INSTALL_DIR:-$HOME/.ryu/bin}"
BINARIES="ryu-core ryu-gateway ryu-cli"

info() { printf '  %s\n' "$1"; }
err()  { printf 'error: %s\n' "$1" >&2; exit 1; }

# --- detect OS/arch and map to release-asset suffix -------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64|aarch64) suffix="macos-aarch64" ;;
      *) err "Intel Macs are not supported by the prebuilt binaries. Build from source: https://github.com/$REPO#quick-start-self-host" ;;
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
  dl_ok() { curl -fsSLI "$1" >/dev/null 2>&1; }
elif command -v wget >/dev/null 2>&1; then
  dl() { wget -qO "$2" "$1"; }
  dl_ok() { wget -q --spider "$1" >/dev/null 2>&1; }
else
  err "need curl or wget on PATH"
fi

if [ -n "${RYU_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$RYU_VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

# --- sha256 helper (best-effort; binaries job may not emit .sha256) ----------
sha_cmd=""
if command -v sha256sum >/dev/null 2>&1; then sha_cmd="sha256sum";
elif command -v shasum >/dev/null 2>&1; then sha_cmd="shasum -a 256"; fi

verify() { # <file> <sha_url>
  file="$1"; sha_url="$2"
  [ "${RYU_SKIP_CHECKSUM:-0}" = "1" ] && return 0
  [ -z "$sha_cmd" ] && { info "no sha256 tool found — skipping checksum"; return 0; }
  dl_ok "$sha_url" || { info "no published checksum — skipping verify"; return 0; }
  tmp_sha="$file.sha256"
  dl "$sha_url" "$tmp_sha" || { info "checksum download failed — skipping verify"; return 0; }
  want="$(awk '{print $1}' "$tmp_sha")"
  got="$($sha_cmd "$file" | awk '{print $1}')"
  rm -f "$tmp_sha"
  [ "$want" = "$got" ] || err "checksum mismatch for $(basename "$file") (want $want, got $got)"
}

# --- install ----------------------------------------------------------------
printf 'Installing Ryu (%s) into %s\n' "$suffix" "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for bin in $BINARIES; do
  asset="$bin-$suffix"
  url="$base/$asset"
  out="$tmp/$bin"
  info "$bin"
  dl "$url" "$out" || err "download failed: $url"
  verify "$out" "$url.sha256"
  chmod +x "$out"
  mv "$out" "$INSTALL_DIR/$bin"
done

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
cat <<EOF

Next:
  ryu-core     # start the node (spawns the Gateway + a local model stack, no key needed)
  ryu-cli      # in another terminal, connect the TUI to it

Point any OpenAI-compatible client at the Gateway: http://127.0.0.1:7981/v1
EOF
