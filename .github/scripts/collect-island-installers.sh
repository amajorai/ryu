#!/usr/bin/env bash
# .github/scripts/collect-island-installers.sh
#
# Copies the Island (Electron) installers into dist-island/. Shared by the hub's
# release, canary and nightly island jobs.
#
# electron-builder's output layout varies per platform; take the installers and
# skip the unpacked build trees.
set -euo pipefail

mkdir -p dist-island
find apps/island -type f \
  \( -name "*.dmg" -o -name "*.AppImage" -o -name "*.deb" -o -name "*.exe" -o -name "*.zip" \) \
  -not -path "*/node_modules/*" -not -path "*unpacked*" \
  -exec cp {} dist-island/ \; || true
ls -la dist-island || true
