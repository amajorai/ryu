#!/usr/bin/env bash
# .github/scripts/stable-updater-feed.sh
#
# The hub release's `updater-feed` job: assembles `latest.json` from the signed
# desktop artifacts on release TAG, then copies it to `latest-beta.json`.
#
# Without a feed a release ships installers and `.sig` files but `tauri.conf.json`'s
# updater endpoint 404s and the app can never self-update, which is exactly what
# happened to every release from v0.0.2 through v0.1.0. assemble-channel-feed.sh
# omits any platform whose `.sig` is missing and refuses to publish an empty feed.
#
# beta has no rolling train: it tracks Stable, and the desktop's beta channel
# dials `releases/latest/download/latest-beta.json`. This mirrors the private
# release's `channel-feeds` job so an overlay-built release does not 404 every
# beta-channel desktop.
#
# Environment: GH_TOKEN, TAG and GITHUB_REPOSITORY.
set -euo pipefail

version="${TAG#v}"
bash scripts/release/assemble-channel-feed.sh \
  stable "$version" "$GITHUB_REPOSITORY" "$TAG"
feeds="$(mktemp -d)"
if gh release download "$TAG" -R "$GITHUB_REPOSITORY" -p latest.json -D "$feeds" --clobber; then
  cp "$feeds/latest.json" "$feeds/latest-beta.json"
  gh release upload "$TAG" -R "$GITHUB_REPOSITORY" "$feeds/latest-beta.json" --clobber
fi
