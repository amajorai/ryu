#!/usr/bin/env bash
# .github/scripts/upload-release-assets.sh <tag> <dir> <fail|skip> <empty-message>
#
# Uploads every file in <dir> to the GitHub release <tag> with `--clobber`.
# Shared by the hub's release, canary and nightly workflows.
#
# Upload via `gh release upload` (assets endpoint only), NOT softprops.
# softprops does an update-a-release PATCH to locate/refresh the release, which
# the App-scoped GITHUB_TOKEN is refused ("Resource not accessible by
# integration"); re-running v0.0.7 via workflow_dispatch 403'd EVERY hub job that
# way. The assets endpoint alone is permitted, works on both tag-push and
# dispatch, and is exactly what the satellites already use.
#
# nullglob + count so an EMPTY match is handled explicitly: a bare `dist/*` that
# matched nothing is how v0.0.7 first lost its desktop/island installers while
# the jobs stayed green. The stable release passes `fail` (an empty directory
# fails the job instead of shipping nothing); the rolling canary/nightly builds
# pass `skip` (a platform that produced no installer skips, not fails).
set -euo pipefail

tag="${1:?usage: upload-release-assets.sh <tag> <dir> <fail|skip> <empty-message>}"
dir="${2:?usage: upload-release-assets.sh <tag> <dir> <fail|skip> <empty-message>}"
on_empty="${3:?usage: upload-release-assets.sh <tag> <dir> <fail|skip> <empty-message>}"
message="${4:?usage: upload-release-assets.sh <tag> <dir> <fail|skip> <empty-message>}"

case "$on_empty" in
  fail | skip) ;;
  *)
    echo "upload-release-assets.sh: <fail|skip> must be 'fail' or 'skip', got '$on_empty'" >&2
    exit 2
    ;;
esac

shopt -s nullglob
files=("$dir"/*)
if [ ${#files[@]} -eq 0 ]; then
  echo "$message" >&2
  if [ "$on_empty" = "skip" ]; then exit 0; fi
  exit 1
fi
gh release upload "$tag" "${files[@]}" --clobber
