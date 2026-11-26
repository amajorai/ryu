#!/usr/bin/env bash
# .github/scripts/retry-unacquired-jobs.sh
#
# Re-runs, once, the failed jobs of a finished nightly run in which GitHub
# cancelled a job because no hosted runner picked it up. Called by
# nightly-retry.yml when a nightly run completes without success.
#
# WHY. GitHub gives a queued job on a hosted runner about 15 minutes; after
# that it ends the job as `cancelled` with no runner, no steps and no log. The
# only trace is a check-run annotation: "The job was not acquired by Runner of
# type hosted even after multiple attempts" (the macOS arm64 pool adds "Due to
# capacity constraints, jobs targeting macOS arm64 runners may experience longer
# queue times"). The nightly asks for five macOS arm64 runners at once. Between
# 13 and 17 Nov 2026 three of its five builds lost a job this way: twice the
# macOS Core, once the macOS gateway, twice a desktop leg, and the release of
# 17 Nov shipped with no Apple Silicon desktop build. Which job loses is random
# and nothing in nightly.yml can queue it again, so the retry lives here.
#
# WHAT IT DOES NOT DO. It does not retry a run whose jobs all reached a runner:
# a compile error is not fixed by running it again. It asks for the annotation
# rather than trusting `cancelled`, because a run that the next nightly
# superseded also has cancelled jobs with no runner. It stops after
# MAX_ATTEMPTS (default 2, so one retry). It stands down while another nightly
# run is queued or running, because nightly.yml's concurrency group cancels the
# run in progress when a new one arrives, and a re-run counts as arriving.
#
# `gh run rerun --failed` re-runs every failed or cancelled job of the run and
# the jobs that depend on them. For the nightly that is what is wanted: the
# channel feed depends on the desktop legs, so a recovered desktop build is
# published into the feed too. `gate` and `prepare` succeeded and keep their
# outputs, so the re-run uploads into the same release tag.
#
# Environment: GH_TOKEN (needs `actions: write` and `checks: read`),
# GITHUB_REPOSITORY, RUN_ID and RUN_ATTEMPT (the finished run), and optionally
# MAX_ATTEMPTS and WORKFLOW_FILE (default nightly.yml).
set -euo pipefail

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
run_id="${RUN_ID:?RUN_ID is required}"
attempt="${RUN_ATTEMPT:?RUN_ATTEMPT is required}"
max_attempts="${MAX_ATTEMPTS:-2}"
workflow_file="${WORKFLOW_FILE:-nightly.yml}"

if [ "$attempt" -ge "$max_attempts" ]; then
  echo "Run $run_id is on attempt $attempt of at most $max_attempts. Not retrying."
  exit 0
fi

# Cancelled without ever being given a runner. The annotation check below
# separates "no runner came" from "the run was superseded".
candidates="$(
  gh api "repos/$repo/actions/runs/$run_id/attempts/$attempt/jobs?per_page=100" --paginate \
    --jq '.jobs[] | select(.conclusion == "cancelled" and ((.runner_name // "") == "")) | .id'
)"

unacquired=0
for job in $candidates; do
  # A job id is also its check-run id.
  if gh api "repos/$repo/check-runs/$job/annotations" --jq '.[].message' \
    | grep -qF "was not acquired by Runner"; then
    echo "Job $job was never picked up by a runner."
    unacquired=$((unacquired + 1))
  fi
done

if [ "$unacquired" = "0" ]; then
  echo "Every job of run $run_id reached a runner. Nothing to retry."
  exit 0
fi

active="$(
  gh api "repos/$repo/actions/workflows/$workflow_file/runs?per_page=30" \
    --jq '[.workflow_runs[] | select(.status != "completed")] | length'
)"
if [ "$active" != "0" ]; then
  echo "Another $workflow_file run is queued or running. A re-run would cancel it, so run $run_id is not retried."
  exit 0
fi

echo "Re-running the failed jobs of run $run_id ($unacquired never reached a runner)."
gh run rerun "$run_id" --repo "$repo" --failed
