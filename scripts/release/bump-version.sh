#!/usr/bin/env bash
# One-command version-bump train.
#
# Ryu ships ONE version across the whole release train. Bumping it used to mean
# hand-editing ~75 Cargo.toml, 9 package.json, the Java POM/README, a tauri.conf.json, ~27 Cargo.lock
# files, 5 inter-crate dep strings, and the create-ryu-app SDK range — the P1 1.0
# blocker this script closes. Run it once; it rewrites every version-carrying site
# that currently holds the train version, idempotently.
#
# WHY A SCRIPT AND NOT cargo workspace inheritance:
#   A script is mandatory REGARDLESS of inheritance — inheritance
#   (version.workspace = true) covers only workspace-member Cargo.toml *package*
#   versions. It cannot touch: the 5 inter-crate dep version strings, 9 package.json,
#   tauri.conf.json, ~27 Cargo.lock entries, or the create-ryu-app "^x.y.z" range.
#   All of those still need a script. Since the script must exist and already
#   automates the per-member edits, adding an inheritance refactor would only shrink
#   the machine-generated per-release diff (cosmetic) while adding a ~75-file one-time
#   churn, a second mechanism to keep in sync, and coupling to the public mirror's
#   standalone `--manifest-path apps/<x>/Cargo.toml` builds. The task's inheritance
#   precondition ("cleanly, for the excluded manifests too") is not met: the two
#   the desktop src-tauri crate is workspace-EXCLUDED (cannot inherit) and two crates
#   (predict, sdk/uniffi) sit off-train at 0.1.0. So: script-only.
#
# Self-selecting by current value: every site is rewritten ONLY if it currently
# holds the train version (OLD, read from the tauri.conf.json tag driver). Off-train
# crates at 0.1.0 never match and are left untouched, so the script is also a safe
# idempotent no-op when re-run at the same target.
#
# Usage:
#   scripts/release/bump-version.sh <new-version> [--from <old-version>]
#   scripts/release/bump-version.sh 0.0.5
#   scripts/release/bump-version.sh 0.1.0 --from 0.0.4
#
# The default OLD is apps/desktop/src-tauri/tauri.conf.json's "version" (the same
# value scripts/release/release-local.sh derives the release tag from).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TAG_DRIVER="apps/desktop/src-tauri/tauri.conf.json"

die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

NEW=""
OLD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) OLD="${2:-}"; shift 2 ;;
    -h|--help) grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag: $1" ;;
    *) [[ -z "$NEW" ]] && NEW="$1" || die "unexpected arg: $1"; shift ;;
  esac
done

[[ -n "$NEW" ]] || die "missing <new-version>. usage: bump-version.sh <new-version> [--from <old>]"
# semver-ish: major.minor.patch with an optional -prerelease and/or +build.
#
# The trailing `+` inside the character class is load-bearing: without it the
# pattern accepted `0.0.13-nightly.20260728.932` but REJECTED the same version
# carrying build metadata (`…932+f1a68ac9b05c`), because the class after the
# leading `[-+]` could not match a second `+`. Channel builds are stamped by
# scripts/release/next-version.mjs, which emits the prerelease form.
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]] || die "'$NEW' is not a semver-ish version (e.g. 0.0.5, 0.0.5-dry, or 0.0.13-nightly.20260728.932)"

if [[ -z "$OLD" ]]; then
  [[ -f "$TAG_DRIVER" ]] || die "cannot read the tag driver $TAG_DRIVER; pass --from <old>"
  OLD="$(grep -m1 '"version"' "$TAG_DRIVER" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
  [[ -n "$OLD" ]] || die "could not read the current version from $TAG_DRIVER; pass --from <old>"
fi

log "Bumping the release train: $OLD -> $NEW"
if [[ "$OLD" == "$NEW" ]]; then
  log "OLD == NEW ($NEW); nothing to do (idempotent no-op)."
  exit 0
fi

# perl-quotemeta the OLD version so its dots are literal in every regex below.
export OLD NEW

# 1) Cargo.toml — package version AND the 5 inter-crate path-dep version strings.
#    Every `version = "OLD"` in a Cargo.toml is ours (a member's own version or a
#    ryu-* path dep); no external dep is pinned to the train version. Off-train
#    crates carry `version = "0.1.0"` and are skipped. This also bumps the
#    ryu-sdk dep string inside off-train crates/sdk/uniffi/Cargo.toml (whose own
#    package version stays 0.1.0) so the dep stays in lockstep with ryu-sdk.
log "Cargo.toml (package + inter-crate dep versions)"
while IFS= read -r f; do
  perl -0777 -pi -e 'my ($o,$n)=($ENV{OLD},$ENV{NEW}); s/version = "\Q$o\E"/version = "$n"/g;' "$f"
done < <(git ls-files '*Cargo.toml')

# 2) package.json — the 9 train packages plus the create-ryu-app "^OLD" dep range.
#
#    The caret rewrite is scoped to OUR scopes (@ryu/, @ryuhq/). It used to rewrite
#    every "^OLD" range in the file, which is safe only while no third-party dep
#    shares the train version — true throughout 0.0.x by luck, and false the moment
#    the train reached 0.1.0: `@shadcn/react: "^0.1.0"` was rewritten to "^0.1.1",
#    a version that does not exist, and `bun install` failed outright. A version
#    bump must never touch a dependency we do not publish.
#
#    Selects exactly the files whose "version" (or a "^OLD" internal range) is on
#    the train; every other package.json is at 0.0.0 / 0.1.0 / 1.0.0 and skipped.
log "package.json (train packages + caret dep ranges)"
while IFS= read -r f; do
  perl -0777 -pi -e 'my ($o,$n)=($ENV{OLD},$ENV{NEW});
    s/"version": "\Q$o\E"/"version": "$n"/g;
    s/("\@ryu(?:hq)?\/[^"]+"\s*:\s*)"\^\Q$o\E"/$1"^$n"/g;' "$f"
done < <(git ls-files '*package.json')

# 3) Java SDK — Maven coordinates and the documented dependency version.
#    The Java binding is part of the SDK hub release train even though it is not
#    a Cargo or npm manifest, so keep its published coordinate and README example
#    in lockstep with the other SDKs.
log "Java SDK version (pom.xml + README.md)"
for f in bindings/java/pom.xml bindings/java/README.md; do
  [[ -f "$f" ]] || continue
  perl -0777 -pi -e 'my ($o,$n)=($ENV{OLD},$ENV{NEW}); s{<version>\Q$o\E</version>}{<version>$n</version>}g;' "$f"
  log "  $f -> $NEW"
done

# 4) tauri.conf.json — the desktop tag driver.
log "tauri.conf.json (desktop tag driver)"
while IFS= read -r f; do
  perl -0777 -pi -e 'my ($o,$n)=($ENV{OLD},$ENV{NEW}); s/"version": "\Q$o\E"/"version": "$n"/g;' "$f"
done < <(git ls-files '*tauri.conf.json')

# 5) create-ryu-app scaffolder — the SDK dependency range it writes into generated
#    projects, and its test's expectation of that range. Load-bearing: a stale range
#    404s `bun install` against npm (see docs/RELEASING.md §3).
log "create-ryu-app SDK range (index.ts + index.test.ts)"
for f in packages/create-ryu-app/index.ts packages/create-ryu-app/index.test.ts; do
  [[ -f "$f" ]] && perl -0777 -pi -e 'my ($o,$n)=($ENV{OLD},$ENV{NEW}); s/\^\Q$o\E/^$n/g;' "$f"
done

# 6) Cargo.lock — rewrite the local-crate `version` entries in EVERY tracked lock
#    (the root workspace lock + the standalone member locks the mirror / tauri build
#    resolve directly). A local crate == a [[package]] block with NO `source =` line;
#    external crates always carry a source, so this can never clobber a third-party
#    dep that happens to sit at the train version.
log "Cargo.lock (local-crate entries, all tracked locks)"
while IFS= read -r lk; do
  python3 - "$lk" <<'PY'
import sys, re
path = sys.argv[1]
import os
old, new = os.environ["OLD"], os.environ["NEW"]
src = open(path).read()
# Split into the pre-amble + each [[package]] record. Re-join with the marker.
parts = src.split("[[package]]")
head, records = parts[0], parts[1:]
out = [head]
changed = False
for rec in records:
    if ('version = "%s"' % old) in rec and "\nsource = " not in rec:
        rec2 = rec.replace('version = "%s"' % old, 'version = "%s"' % new, 1)
        if rec2 != rec:
            changed = True
            rec = rec2
    out.append(rec)
if changed:
    open(path, "w").write("[[package]]".join(out))
PY
done < <(git ls-files '*Cargo.lock')

# 7b) VITE_APP_VERSION in the committed .env.production files.
#
# Vite INLINES this into the shipped bundle, so it is what the desktop/webapp
# actually DISPLAY as their version. It was missed by every previous bump and
# had drifted to 0.0.3 while the real train was 0.0.6 — users downloaded
# "0.0.6" and saw 0.0.3. Kept in lockstep here so it can never drift again.
for f in apps/desktop/.env.production apps/webapp/.env.production; do
  [[ -f "$f" ]] || continue
  perl -0777 -pi -e 'my $n=$ENV{NEW}; s/^VITE_APP_VERSION=.*$/VITE_APP_VERSION=$n/m;' "$f"
  log "  $f -> $NEW"
done

# 7c) fumadocs docs version — the docs site labels the current URL space
# with /docs/<v>/... while keeping only one live deployment.
#
# Three sites carry the literal train version and none of them is a manifest, so
# nothing above catches them:
#   - src/lib/docs-version.ts  DOCS_VERSION, the single source the whole site
#     derives /docs/<v>/... paths from (docsPath / versionedDocsHref).
#   - next.config.mjs          the bare-/docs redirect target.
#   - README.md                the prose statement of the current release.
# Miss these and the mirrored ryu-docs satellite keeps serving the OLD version's
# URLs after the train has moved. Only these three files are touched, so the
# literal-version replace cannot hit unrelated prose elsewhere in the site.
log "fumadocs docs version (DOCS_VERSION + /docs redirect + README)"
for f in apps/fumadocs/src/lib/docs-version.ts apps/fumadocs/next.config.mjs apps/fumadocs/README.md; do
  [[ -f "$f" ]] || continue
  perl -0777 -pi -e 'my ($o,$n)=($ENV{OLD},$ENV{NEW}); s/\Q$o\E/$n/g;' "$f"
  log "  $f -> $NEW"
done

# 8) Validate the root workspace lock still resolves against the bumped manifests.
if command -v cargo >/dev/null 2>&1; then
  log "Validating: cargo metadata --locked --offline"
  if cargo metadata --locked --offline --format-version 1 >/dev/null 2>&1; then
    log "  root Cargo.lock is consistent with the bumped manifests."
  else
    printf '\033[1;33mwarn:\033[0m cargo metadata --locked --offline could not confirm the lock.\n' >&2
    printf '      Run `cargo metadata --locked` (online) to confirm, or `cargo update --workspace` if it drifted.\n' >&2
  fi
else
  printf '\033[1;33mwarn:\033[0m cargo not found — skipped Cargo.lock validation.\n' >&2
fi

# 9) Summary.
log "Bump complete: $OLD -> $NEW. Changed files:"
git diff --stat -- $(git ls-files '*Cargo.toml' '*Cargo.lock' '*package.json' '*tauri.conf.json' 'packages/create-ryu-app/index.ts' 'packages/create-ryu-app/index.test.ts') | tail -1
printf '\nReview with: git diff --stat\n'
printf 'Then sync bun.lock: bun install   (bun 1.3.14, matches CI)\n'
