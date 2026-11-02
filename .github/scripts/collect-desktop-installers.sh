#!/usr/bin/env bash
# .github/scripts/collect-desktop-installers.sh
#
# Copies the Tauri bundles out of apps/desktop/src-tauri/target into
# dist-desktop/, stamps the arch into the macOS updater bundle, and renames the
# files by the artifact-name rule. Shared by the hub's release, canary and
# nightly desktop jobs so every train names its artifacts the same way.
#
# Environment: TAURI_ARGS (the matrix `args`, e.g. `--target aarch64-apple-darwin`)
# and RUNNER_OS (set by the Actions runner).
#
# macOS names the updater bundle `<productName>.app.tar.gz` with NO arch in it,
# so the aarch64 and x86_64 legs upload the SAME filename and `--clobber` keeps
# only whichever finished last. One arch's updater bundle was lost on every
# release, which is why `latest.json` could only ever carry darwin-aarch64 and
# Intel Macs were offered no update at all, and the rolling channel feeds could
# not address both arches. Stamp the arch in so both survive. (.dmg/.exe/
# .AppImage already carry arch or are single-arch.)
#
# Glob the productName rather than hardcoding "Ryu": channel-brand.mjs stamps the
# channel into productName before the bundle is built, so the file is e.g.
# `Ryu Canary.app.tar.gz`, or `Ryu Research Preview.app.tar.gz` on stable. A
# literal `Ryu.app.tar.gz` stopped matching the moment branding landed, which
# silently reintroduced the exact collision this block exists to prevent: v0.1.5
# shipped ONE `Ryu.Research.Preview.app.tar.gz` where v0.1.4 had both arches.
#
# artifact-name.mjs then decouples the FILE name from the OS-registered name.
# productName is "Ryu (Research Preview)" on stable, which GitHub stores as
# `Ryu.Research.Preview._0.1.7_aarch64.dmg`: unrecognisable as "the Mac
# installer", and it reads like the `research` app leaked into the hub. It
# renames the prefix only; the script asserts every suffix the updater feed and
# the marketing site match on, and throws rather than upload a set that would
# silently omit a platform. It runs BEFORE attestation so the attested names are
# the published ones.
set -euo pipefail

mkdir -p dist-desktop
find apps/desktop/src-tauri/target -type f \
  \( -name "*.dmg" -o -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" \
     -o -name "*.msi" -o -name "*-setup.exe" -o -name "*.app.tar.gz" \
     -o -name "*.sig" \) \
  -not -path "*deps*" -exec cp {} dist-desktop/ \; || true
if [ "$RUNNER_OS" = "macOS" ]; then
  case "$TAURI_ARGS" in
    *aarch64-apple-darwin*) arch=aarch64 ;;
    *) arch=x86_64 ;;
  esac
  shopt -s nullglob
  for f in dist-desktop/*.app.tar.gz dist-desktop/*.app.tar.gz.sig; do
    base="$(basename "$f")"
    # Already stamped (defensive: never double-stamp on a re-run).
    case "$base" in *-"$arch".app.tar.gz|*-"$arch".app.tar.gz.sig) continue ;; esac
    mv "$f" "dist-desktop/${base/.app.tar.gz/-$arch.app.tar.gz}"
  done
  shopt -u nullglob
fi
node scripts/release/artifact-name.mjs --dir dist-desktop
ls -la dist-desktop || true
