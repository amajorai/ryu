#!/usr/bin/env bash
# .github/scripts/compile-tui.sh
#
# Compiles the terminal client (apps/cli, Bun/TypeScript) into a standalone
# executable for this runner's platform, plus its `.sha256`, under dist/. Used
# by the hub release's `tui` job.
#
# apps/cli is Bun, not Rust, so it cannot ride the cargo matrix. It must be built
# NATIVELY on each OS: @opentui/core pulls a platform-specific native package
# (@opentui/core-<plat>), so cross-compiling from one runner fails to resolve the
# others.
#
# The assets are named `ryu-cli-*`: install.sh, install.ps1, and Core's updater
# fetch that exact name. Keeping the name means the deprecated Rust CLI simply
# disappears without breaking a single installer or updater contract.
#
# Environment: RUNNER_OS (set by the Actions runner).
set -euo pipefail

ext=""; [ "$RUNNER_OS" = "Windows" ] && ext=".exe"
case "$RUNNER_OS" in
  Linux)   plat="linux-x86_64" ;;
  macOS)   if [ "$(uname -m)" = "x86_64" ]; then plat="macos-x86_64"; else plat="macos-aarch64"; fi ;;
  Windows) plat="windows-x86_64" ;;
esac
mkdir -p dist
( cd apps/cli && bun build --compile src/index.tsx --outfile "../../dist/ryu-cli-${plat}${ext}" )
( cd dist
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "ryu-cli-${plat}${ext}" > "ryu-cli-${plat}${ext}.sha256"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "ryu-cli-${plat}${ext}" > "ryu-cli-${plat}${ext}.sha256"; fi )
