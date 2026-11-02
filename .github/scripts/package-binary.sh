#!/usr/bin/env bash
# .github/scripts/package-binary.sh
#
# Copies one built binary into dist/ under its updater/installer asset name
# (`<asset>-<os>-<arch>[.exe]`) and writes the sibling `<asset>.sha256`. Shared
# by the hub's release, canary and nightly `build` jobs.
#
# Environment: TARGET_DIR, TARGET_BIN, TARGET_ASSET (the matrix row's `dir`,
# `bin` and `asset`), RUNNER_OS (set by the runner), and optionally MACOS_PLAT.
#
# The os-arch labels match Core's updater (`update::platform_tag` / install.rs
# platform_slug) so asset names line up across trains. On macOS the label is
# MACOS_PLAT when set (the rolling workflows build on Apple Silicon
# `macos-latest` and pass `macos-aarch64`); otherwise it follows `uname -m`, so
# the stable release's macos-15 (Apple Silicon) and macos-15-intel legs are each
# labelled accurately.
set -eo pipefail

ext=""; [ "$RUNNER_OS" = "Windows" ] && ext=".exe"
case "$RUNNER_OS" in
  Linux)   plat="linux-x86_64" ;;
  macOS)
    if [ -n "${MACOS_PLAT:-}" ]; then plat="$MACOS_PLAT"
    elif [ "$(uname -m)" = "x86_64" ]; then plat="macos-x86_64"; else plat="macos-aarch64"; fi ;;
  Windows) plat="windows-x86_64" ;;
esac
src="$TARGET_DIR/target/release/$TARGET_BIN${ext}"
asset="$TARGET_ASSET-${plat}${ext}"
mkdir -p dist
cp "$src" "dist/$asset"
# Portable sha256 (Linux/Windows-git ship sha256sum; macOS ships shasum) in the
# standard `<hash>  <name>` form the installers read (field 1). Basename only.
( cd dist
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$asset" > "$asset.sha256"
  elif command -v shasum   >/dev/null 2>&1; then shasum -a 256 "$asset" > "$asset.sha256"
  else echo "! no sha256 tool — skipping checksum for $asset" >&2; fi )
