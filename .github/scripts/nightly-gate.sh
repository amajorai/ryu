#!/usr/bin/env bash
# .github/scripts/nightly-gate.sh
#
# The hub nightly's `gate` job. Writes `build=true|false` to GITHUB_OUTPUT:
# false only when a scheduled run's tree is identical to the newest nightly
# release's, so a quiet repo does not republish identical binaries. It compares
# against the release rather than a time window: a delayed schedule must still
# catch changes, while a repeated schedule must stay a no-op. Manual dispatch
# always builds.
#
# Environment: GH_TOKEN, GITHUB_EVENT_NAME, GITHUB_REPOSITORY, GITHUB_SHA and
# GITHUB_OUTPUT (all but GH_TOKEN set by the runner).
set -euo pipefail

if [ "$GITHUB_EVENT_NAME" = "workflow_dispatch" ]; then
  echo "Manual dispatch — building."
  echo "build=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

previous_tag="$(
  gh release list --repo "$GITHUB_REPOSITORY" --limit 200 --exclude-drafts \
    --json tagName,createdAt \
    --jq '[.[] | select(.tagName | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-nightly\\."))]
          | sort_by(.createdAt) | reverse | .[0].tagName // empty'
)"

if [ -z "$previous_tag" ]; then
  echo "No previous nightly release found — building."
  echo "build=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

# The release tag may not be present in the checkout even with full history when
# GitHub created it after the checkout ref was selected. Fetch exactly that tag so
# the comparison is against the release's committed tree, not its wall-clock age.
git fetch --no-tags origin "refs/tags/$previous_tag:refs/tags/$previous_tag"
previous_sha="$(git rev-list -n 1 "$previous_tag")"
if git diff --quiet "$previous_sha" "$GITHUB_SHA" --; then
  echo "No file changes since nightly $previous_tag ($previous_sha) — skipping nightly."
  echo "build=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

echo "Changes since nightly $previous_tag ($previous_sha) — building."
echo "build=true" >> "$GITHUB_OUTPUT"
