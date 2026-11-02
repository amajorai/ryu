#!/usr/bin/env bash
# .github/scripts/rolling-prerelease.sh <canary|nightly>
#
# Creates this run's rolling-channel prerelease, then prunes the channel to its
# newest RETAIN builds. Shared by the hub's canary and nightly `prepare` jobs.
#
# Environment: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, VERSION and TAG (this
# build's version and `v<version>` tag, computed once in `prepare`), RETAIN, and
# the optional OPENCODE_API_KEY / OPENCODE_SESSION_ID read by rolling-notes.mjs.
#
# HISTORY IS KEPT (changed 2026-08-04). The channel used to `gh release delete
# <channel> --cleanup-tag` and recreate one rolling release, so it only ever held
# ONE build. Each build now gets its OWN versioned tag (`v<version>`, e.g.
# `v0.1.2-canary.20260804.36`) and old ones are pruned to RETAIN here.
set -e

channel="${1:?usage: rolling-prerelease.sh <canary|nightly>}"
case "$channel" in
  canary | nightly) ;;
  *)
    echo "rolling-prerelease.sh: channel must be canary or nightly, got '$channel'" >&2
    exit 2
    ;;
esac
title="${channel^}"

# Notes must be GENERATED before the release references them: the rolling-build
# banner, no changelog (mirror history is just sync commits, and no publish step
# follows to fill one in). Banner + install block only; the changelog is
# appended below.
node scripts/release-notes.mjs --channel "$channel" --repo "$GITHUB_REPOSITORY" --no-changelog > notes.md
# A rolling build has NO follow-up step that can fill in notes later; whatever is
# written here is what it ships with. The mirror commit bodies in range carry
# real summaries, so read them.
node scripts/rolling-notes.mjs --channel "$channel" --repo "$GITHUB_REPOSITORY" >> notes.md
# The tag CARRIES the version, so `release_version` reads it straight off the
# tag. The title keeps the same shape anyway: it is what a human reads, and it
# remains the fallback if a tag is ever hand-made. --prerelease is load-bearing:
# GitHub's `/releases/latest` excludes prereleases, which is what stops a stable
# node auto-updating onto a rolling build.
#
# "Re-run all jobs" keeps the run number, so on the same UTC day it computes this
# same tag and the first attempt's release already exists. Reuse it (the build
# jobs upload with --clobber) instead of failing here and never reaching the
# builds again.
if gh release view "$TAG" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  echo "Release $TAG already exists (re-run of this run number); reusing it."
else
  gh release create "$TAG" \
    --prerelease \
    --target "$GITHUB_SHA" \
    --title "$title $VERSION (${GITHUB_SHA:0:12})" \
    --notes-file notes.md
fi

# Prune: keep the newest $RETAIN releases of this channel, delete the rest with
# their tags. Selection is by tag shape (`v<x.y.z>-<channel>.*`), so it can never
# touch stable, beta or the other rolling channel. `--exclude-drafts` keeps a
# half-published build from being counted as the newest.
gh release list --repo "$GITHUB_REPOSITORY" --limit 200 --exclude-drafts \
  --json tagName,createdAt \
  --jq '[.[] | select(.tagName | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-'"$channel"'\\."))]
        | sort_by(.createdAt) | reverse | .['"$RETAIN"':][] | .tagName' \
  > stale.txt || true
while read -r old; do
  [ -n "$old" ] || continue
  echo "pruning old $channel release $old"
  gh release delete "$old" --repo "$GITHUB_REPOSITORY" --yes --cleanup-tag || true
done < stale.txt

# The pre-2026-08-04 unversioned rolling `<channel>` release/tag is obsolete: it
# can never win `pick_version_for_channel` against a versioned build, so leaving
# it up would only pin a stale entry to the top of the releases page. Remove it.
gh release delete "$channel" --repo "$GITHUB_REPOSITORY" --yes --cleanup-tag || true
