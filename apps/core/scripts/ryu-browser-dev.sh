#!/usr/bin/env bash
# Dev launcher for the browser sidecar: Core spawns this as RYU_BROWSER_BIN
# (kind:local override) so the electron-vite build runs under `bun dev` with no
# packaged binary. Args + env are passed straight through to electron.
# Requires `electron-vite build` to have produced out/main/index.js first.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bunx electron "$DIR/../../../apps-store/browser/sidecar/out/main/index.js" "$@"
