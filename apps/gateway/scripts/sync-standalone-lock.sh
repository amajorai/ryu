#!/usr/bin/env bash
# Regenerate apps/gateway/Cargo.lock, the lock a STANDALONE Gateway build uses.
#
# In this monorepo apps/gateway is a member of the root Cargo workspace, so every
# in-repo build and test, and the Gateway image, resolve against the root
# Cargo.lock. The public mirror ships no root Cargo.toml: there apps/gateway is
# its own root package and builds against apps/gateway/Cargo.lock. That lock is
# therefore DERIVED from the root lock: the root lock is copied into a
# mirror-shaped tree and cargo prunes it to the Gateway's own dependency graph,
# so a standalone build uses exactly the versions CI tested. Never edit it by
# hand; re-run this after the root lock or a Gateway path dependency changes.
#
# The derivation is shared with the other standalone member locks (Core, Ghost,
# Shadow, Mail) in tools/sync-standalone-locks.sh, which this delegates to.
#
# Usage: apps/gateway/scripts/sync-standalone-lock.sh [--check]
#   --check  exit 1 (and change nothing) when the committed lock is stale.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SYNC="$ROOT/tools/sync-standalone-locks.sh"

if [[ ! -f "$SYNC" ]]; then
  echo "error: needs the monorepo's tools/sync-standalone-locks.sh" >&2
  exit 2
fi

exec bash "$SYNC" "$@" apps/gateway
