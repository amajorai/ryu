#!/usr/bin/env bash
# .github/scripts/smoke-start-image.sh
#
# Starts one binary of a freshly built image once and fails when it does not
# run. images.yml calls it BEFORE it pushes a tag or calls a deploy hook.
#
# Why: on 26 Nov 2026 images.yml pushed ghcr.io/amajorai/ryu-core:latest and
# called the deploy hook for an image whose ryu-core exited 0.24 s after start
# (linked against a newer glibc than the image has). Docker Swarm kept the old
# container, but `latest` pointed at an image that could not start. The build
# was green because nothing ever ran the image.
#
# What it proves: the dynamic loader accepts the binary and every shared library
# it needs inside this image, as the image's own user, and (without
# `--entrypoint`) the image's entrypoint reaches the binary. It does NOT prove
# that the service boots with production configuration: `--version` returns
# before any state, network or configuration is touched.
#
# Usage, from the repository root:
#
#   bash .github/scripts/smoke-start-image.sh <image> <binary> [docker run options]
#
# <binary> is the name the version line must start with (`ryu-core 0.5.2`).
# Extra options go to `docker run` before the image, for example
# `--entrypoint ryu-gateway` to start the second binary of the Core image.
set -euo pipefail

image="${1:?usage: smoke-start-image.sh <image> <binary> [docker run options]}"
binary="${2:?usage: smoke-start-image.sh <image> <binary> [docker run options]}"
shift 2

status=0
# No network: nothing in a version check may reach out. The time limit turns a
# binary that boots the server instead of answering into a failure, not a hang.
output=$(timeout 120 docker run --rm --network none "$@" "$image" --version 2>&1) || status=$?
first_line=$(printf '%s\n' "$output" | head -n 1)

if [ "$status" = "0" ] && printf '%s' "$first_line" | grep -Eq "^$binary [0-9]"; then
  echo "$image: $first_line"
  exit 0
fi

echo "::error::$image did not start $binary (exit $status). Nothing was pushed and no deploy hook was called. Output follows."
printf '%s\n' "$output"
# Best effort, for the log only: the image's glibc and what the loader misses.
docker run --rm --network none --entrypoint /bin/sh "$image" -c \
  "ldd --version | head -n 1; ldd \"\$(command -v $binary)\" 2>&1 | grep -E 'not found' || true" || true
exit 1
