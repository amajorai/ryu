#!/usr/bin/env bash
# .github/scripts/version-guard.sh
#
# The hub release's `version-guard` job: the tag MUST match the version in the
# mirrored source (apps/desktop/src-tauri/tauri.conf.json).
#
# This repo BUILT the mislabelled `v0.0.12` on 2026-07-27: the tag was pushed
# while the mirrored `tauri.conf.json` still said 0.0.11, and since Tauri names
# installers from the SOURCE version rather than the tag, every asset in that
# release is `Ryu_0.0.11_*`. A whole release shipped the previous build under a
# new number and nothing reported a problem.
#
# The mirror lags the private repo by design, so this is easy to hit here: a tag
# pushed before `mirror-public` syncs the version bump builds the OLD version.
# Failing fast is the only honest outcome; re-run once the bump has mirrored.
#
# Environment: RAW_TAG, the requested tag. It arrives through `env:`, never
# interpolated into `run:`: a tag name is caller-supplied text and can carry
# shell metacharacters.
set -euo pipefail

conf="apps/desktop/src-tauri/tauri.conf.json"
if [ ! -f "$conf" ]; then
  echo "::notice::$conf is not mirrored here; skipping the version guard."
  exit 0
fi
tag="${RAW_TAG#v}"
src="$(python3 -c 'import json;print(json.load(open("apps/desktop/src-tauri/tauri.conf.json"))["version"])')"
echo "tag=$tag  source=$src"
if [ "$tag" != "$src" ]; then
  echo "::error::Tag v$tag does not match $conf ($src)."
  echo "::error::Installers are named from the SOURCE version, so this release would ship $src binaries labelled v$tag."
  echo "::error::Wait for the version bump to mirror from ryu-closed, then re-run."
  exit 1
fi
