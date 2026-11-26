#!/usr/bin/env bash
# .github/scripts/assert-feature-set.sh
#
# Feature-set gate for the hub's release, canary and nightly `build` jobs.
# Asserts what cargo actually BUILT (it records each unit's resolved feature set
# in the fingerprint JSON) rather than re-resolving with `cargo tree`, which
# would happily pass its own `--features` and go green over a featureless binary.
#
# Environment: TARGET_DIR, TARGET_BIN and FEATURES (the matrix row's `dir`, `bin`
# and comma-separated `features`). The feature list is SPLIT OUT OF the matrix
# row rather than repeated, so the gate cannot drift from the flag it guards.
#
# MATCH THE `features` KEY, NOT THE WHOLE FILE. The fingerprint holds two lists
# and only one says what was built:
#   "features":"[\"default\", \"tool-exec-deno\"]"
#   "declared_features":"[\"default\", \"sandbox-wasmtime\", …]"
# `declared_features` is present verbatim whether or not a feature was enabled,
# so grepping the file as a whole passes unconditionally. The leading `"` in the
# pattern is what keeps it out of `declared_features` (whose `features` is
# preceded by `_`).
#
# TWO LOCATIONS, ONE FILE NAME. Cargo 1.100.0 (12 Nov 2026) moved the build
# directory around, and every nightly, canary and release Core build failed
# here until this script learned the second place:
#   up to 1.99   target/release/.fingerprint/<package>-<hash>/bin-<bin>.json
#   from 1.100   target/release/build/<package>/<hash>/fingerprint/bin-<bin>.json
# The file name and its two keys are the same in both, so both are searched and
# the grading below is unchanged. build-cargo-target.sh drops the stale record
# in the same two places.
set -euo pipefail

dir="${TARGET_DIR:?TARGET_DIR is required}"
bin="${TARGET_BIN:?TARGET_BIN is required}"
features="${FEATURES:?FEATURES is required}"
release="$dir/target/release"
found=0
missing=0
# Fingerprint paths contain no spaces, and `tr -d '\\'` deletes a literal
# backslash. A missing search root (only one layout exists per build) is why
# find's errors are discarded.
# shellcheck disable=SC2044,SC1003
for fingerprint in $(find "$release/.fingerprint" "$release/build" -path '*fingerprint/*' -name "bin-$bin.json" 2>/dev/null); do
  found=$((found + 1))
  enabled=$(grep -ao '"features":"\[[^]]*\]"' "$fingerprint" | tr -d '\\' || true)
  if [ -z "$enabled" ]; then
    echo "::error::could not read the ENABLED feature list out of $fingerprint. Cargo's fingerprint format changed, so this assertion no longer guards the shipped feature set. Fix the check rather than deleting it — and do NOT fall back to grepping the whole file, which matches 'declared_features' and passes on any build."
    exit 1
  fi
  for feature in $(printf '%s' "$features" | tr ',' ' '); do
    if ! printf '%s' "$enabled" | grep -qF -- "\"$feature\""; then
      echo "::error::$bin was built WITHOUT '$feature' — enabled set per $fingerprint is $enabled. The published binary would ship without it and degrade silently."
      missing=1
    fi
  done
done
if [ "$found" = "0" ]; then
  echo "::error::no $bin fingerprint under $release/.fingerprint or $release/build/<package>/<hash>/fingerprint. Cargo's layout changed again, so this assertion no longer guards the shipped feature set. Fix the check rather than deleting it."
  exit 1
fi
[ "$missing" = "0" ] || exit 1
echo "$bin carries $features ($found fingerprint(s) checked)"
