#!/usr/bin/env bash
# .github/scripts/stable-release-notes.sh
#
# The hub release's `notes` job: generates the built-from banner plus a
# public-safe AI changelog, then creates the release as a PRERELEASE.
#
# The public repo has no private package history. Its mirror commit bodies are
# the public-safe source for AI summaries, exactly as they are for
# canary/nightly. Stable tags use the stable model explicitly (OPENCODE_MODEL is
# set by the workflow).
#
# Created as a PRERELEASE on purpose. The release exists from the very first job
# so the binaries have somewhere to attach, but at that point nothing is built
# yet, and a non-prerelease immediately becomes `releases/latest`, which is what
# install.sh, the desktop updater and every "download the latest build" link
# resolve. Publishing it stable up front therefore hands users a half-empty
# release for the ~40 minutes the matrix is still building. The workflow's
# `promote` job flips it to stable once every build job has actually succeeded.
#
# Environment: GH_TOKEN, TAG, GITHUB_REPOSITORY, GITHUB_SHA, and the OPENCODE_*
# settings read by rolling-notes.mjs.
set -euo pipefail

previous="$(git tag --merged "$TAG" --sort=-v:refname \
  --list 'v[0-9]*.[0-9]*.[0-9]*' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | grep -Fvx "$TAG" \
  | sed -n '1p' || true)"
if [ -z "$previous" ]; then
  echo "::error::Could not resolve the previous stable tag before $TAG."
  exit 1
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release $TAG already exists — leaving its notes alone."
  exit 0
fi
node scripts/release-notes.mjs \
  --tag "$TAG" --channel release --repo "$GITHUB_REPOSITORY" \
  --no-changelog --no-changelog-placeholder > notes.md
node scripts/rolling-notes.mjs \
  --tag "$TAG" --channel release --repo "$GITHUB_REPOSITORY" \
  --prev "$previous" --require-ai > ai-notes.md
cat ai-notes.md >> notes.md
gh release create "$TAG" --title "$TAG" --target "$GITHUB_SHA" --notes-file notes.md --prerelease
