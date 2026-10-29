#!/usr/bin/env node
// The single source of truth for "what version does the next build carry?".
//
// WHY THIS EXISTS
// ---------------
// Before this script, rolling builds carried NO version of their own. The
// `canary`/`nightly` workflows (mirror/overlay/.github/workflows/) built straight
// from `main` and published under a rolling tag, so the binaries reported whatever
// `tauri.conf.json` happened to hold — the SAME version as the last stable release.
// A nightly built today and stable v0.0.12 were both "0.0.12", which made three
// things impossible:
//
//   1. telling a nightly binary apart from a stable one in a bug report;
//   2. ordering two nightlies (identical strings never compare as newer), so the
//      updater could never move a user from Monday's nightly to Tuesday's; and
//   3. ordering a prerelease against its stable (see `is_newer` in
//      apps/core/src/update/mod.rs, which used to discard the `-suffix` entirely).
//
// This script computes a REAL, ORDERED, semver-2.0-precedence version for every
// channel, so all three work. It never writes anything: it prints one version to
// stdout and `scripts/release/bump-version.sh` stamps it into the tree.
//
// FORMATS (semver 2.0 §9 prerelease identifiers, dot-separated)
//   stable   0.0.12
//   beta     0.0.12-beta.1              N auto-increments per base version
//   nightly  0.0.12-nightly.20260728.932   <UTC date>.<CI run number>
//   canary   0.0.12-canary.20260728.932    same shape, different channel id
//
// Numeric identifiers compare NUMERICALLY under semver, so `20260728.932` orders
// correctly both within a day (by run number) and across days (by date). And every
// prerelease sorts BELOW its own stable (§11.3), so a nightly user is correctly
// offered `0.0.12` when it ships. Commit SHA is deliberately NOT part of the
// version: semver ignores `+build` metadata for precedence, and it trips Cargo,
// WiX/MSI ProductVersion, and Tauri bundle versioning. The SHA travels in the
// release title/notes instead, giving the display form:
//   `0.0.30-nightly.20260728.932 (f1a68ac9b05c)`
//
// BASE VERSION AUTO-DETECTION
// ---------------------------
// The base `X.Y.Z` is the in-tree `tauri.conf.json` version (the same tag driver
// bump-version.sh uses), with the PATCH bumped past every already-published stable
// release. So:
//   in-tree 0.0.11, published v0.0.11 + v0.0.12  ->  base 0.0.13
//   in-tree 0.1.0  (a deliberate minor bump), nothing published  ->  base 0.1.0
// Deriving from the in-tree version rather than "latest release + 1" is what lets a
// deliberate `bump-version.sh 0.1.0` be respected: nightlies immediately become
// `0.1.0-nightly.*` instead of being dragged back to the old 0.0.x line.
//
// Usage:
//   node scripts/release/next-version.mjs <channel> [options]
//
//   <channel>              stable | beta | nightly | canary
//   --build <n>            CI build number (default: $GITHUB_RUN_NUMBER, else 0)
//   --date <YYYYMMDD>      override the UTC date stamp (tests / reproducibility)
//   --base <x.y.z>         override base detection entirely
//   --in-tree <x.y.z>      override the detected in-tree version (satellite trees)
//   --repo <owner/name>    repo to read published releases from (default: $GITHUB_REPOSITORY)
//   --tag                  print the git tag form (`v` prefixed) instead
//   --json                 print { version, tag, base, channel } as JSON
//
// Release discovery uses `gh release list` when available and falls back to local
// `git tag -l`. Both failing is NOT fatal — the base then comes from the in-tree
// version alone, which keeps a build green on a runner without gh auth.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CHANNELS = ["stable", "beta", "nightly", "canary"];

const VERSION_RE =
	/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

// This calculator is copied into release bootstraps before dependencies are
// installed. The native String decoder keeps it standalone and rejects boxed
// strings or objects with custom coercion instead of interpreting them as tags.
function versionText(input) {
	try {
		const text = String.prototype.valueOf.call(input);
		return text === input ? text : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Parse a semver string into its components. Returns `null` for anything that is
 * not valid semver, so callers can skip junk tags rather than crash on them.
 */
export function parseVersion(input) {
	const text = versionText(input);
	if (text === undefined) {
		return null;
	}
	const match = VERSION_RE.exec(text.trim().replace(/^[vV]/, ""));
	if (!match) {
		return null;
	}
	const [, major, minor, patch, prerelease, build] = match;
	return {
		major: Number(major),
		minor: Number(minor),
		patch: Number(patch),
		prerelease: prerelease ? prerelease.split(".") : [],
		build: build ?? null,
	};
}

/** `true` when the identifier is a pure numeric identifier (semver §11.4.1). */
function isNumericIdentifier(id) {
	return /^\d+$/.test(id);
}

/**
 * Compare two prerelease identifier lists per semver 2.0 §11.4.
 * Numeric identifiers compare numerically, alphanumerics lexically in ASCII order,
 * numeric always ranks lower than alphanumeric, and a SHORTER list ranks lower when
 * all preceding identifiers are equal.
 */
function comparePrerelease(a, b) {
	// §11.3: a version WITHOUT a prerelease outranks one with it.
	if (a.length === 0 && b.length === 0) {
		return 0;
	}
	if (a.length === 0) {
		return 1;
	}
	if (b.length === 0) {
		return -1;
	}
	const shared = Math.min(a.length, b.length);
	for (let i = 0; i < shared; i++) {
		const left = a[i];
		const right = b[i];
		if (left === right) {
			continue;
		}
		const leftNumeric = isNumericIdentifier(left);
		const rightNumeric = isNumericIdentifier(right);
		if (leftNumeric && rightNumeric) {
			return Number(left) < Number(right) ? -1 : 1;
		}
		if (leftNumeric !== rightNumeric) {
			// Numeric identifiers always have LOWER precedence than alphanumeric.
			return leftNumeric ? -1 : 1;
		}
		return left < right ? -1 : 1;
	}
	if (a.length === b.length) {
		return 0;
	}
	return a.length < b.length ? -1 : 1;
}

/**
 * Full semver 2.0 precedence comparison. Returns -1 / 0 / 1. Build metadata is
 * ignored (§10). Unparseable input sorts BELOW everything so a malformed tag can
 * never claim to be the newest.
 */
export function comparePrecedence(a, b) {
	const left = versionText(a) === undefined ? a : parseVersion(a);
	const right = versionText(b) === undefined ? b : parseVersion(b);
	if (!(left || right)) {
		return 0;
	}
	if (!left) {
		return -1;
	}
	if (!right) {
		return 1;
	}
	for (const field of ["major", "minor", "patch"]) {
		if (left[field] !== right[field]) {
			return left[field] < right[field] ? -1 : 1;
		}
	}
	return comparePrerelease(left.prerelease, right.prerelease);
}

/** `true` when `candidate` is strictly newer than `current` by semver precedence. */
export function isNewer(current, candidate) {
	return comparePrecedence(candidate, current) > 0;
}

/** `x.y.z` with any prerelease / build suffix removed. */
export function baseOf(version) {
	const parsed = parseVersion(version);
	if (!parsed) {
		return null;
	}
	return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/**
 * Resolve the base `x.y.z` the next build should sit on: the in-tree version, with
 * the patch bumped past every published STABLE release at or above it.
 *
 * Prereleases in `published` are ignored — an unreleased `0.0.12-beta.3` must not
 * push the base to 0.0.13, because beta.4 belongs on the SAME base.
 */
export function resolveBase(inTreeVersion, published = []) {
	const parsed = parseVersion(inTreeVersion);
	if (!parsed) {
		throw new Error(
			`cannot parse the in-tree version '${inTreeVersion}' as semver`
		);
	}
	const stable = published
		.map(parseVersion)
		.filter((v) => v && v.prerelease.length === 0);

	let { major, minor, patch } = parsed;
	// Bump while the candidate is already taken by a published stable release.
	// A bounded loop: `stable` is finite, and each iteration consumes one entry.
	for (let guard = 0; guard <= stable.length; guard++) {
		const taken = stable.some(
			(v) => v.major === major && v.minor === minor && v.patch === patch
		);
		if (!taken) {
			break;
		}
		patch += 1;
	}
	return `${major}.${minor}.${patch}`;
}

/**
 * Next `-beta.N` ordinal for `base`: one past the highest already published.
 * Reads the ordinal from the LAST identifier so `0.0.12-beta.7` yields 8.
 */
export function nextBetaOrdinal(base, published = []) {
	let highest = 0;
	for (const tag of published) {
		const parsed = parseVersion(tag);
		if (!parsed || baseOf(tag) !== base) {
			continue;
		}
		const [channel, ordinal] = parsed.prerelease;
		if (channel !== "beta" || !isNumericIdentifier(ordinal ?? "")) {
			continue;
		}
		highest = Math.max(highest, Number(ordinal));
	}
	return highest + 1;
}

/** UTC `YYYYMMDD` stamp used by the rolling channels. */
export function utcDateStamp(now = new Date()) {
	return now.toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * Build the next version string for `channel`.
 *
 * `published` is the list of already-published tags (any form; `v` prefix and
 * unparseable entries are tolerated).
 */
export function nextVersion({
	channel,
	inTreeVersion,
	published = [],
	build = 0,
	date,
	base: baseOverride,
}) {
	if (!CHANNELS.includes(channel)) {
		throw new Error(
			`unknown channel '${channel}' (expected one of: ${CHANNELS.join(", ")})`
		);
	}
	const base = baseOverride ?? resolveBase(inTreeVersion, published);
	if (channel === "stable") {
		return base;
	}
	if (channel === "beta") {
		return `${base}-beta.${nextBetaOrdinal(base, published)}`;
	}
	// nightly / canary: <base>-<channel>.<utc-date>.<build>
	const stamp = date ?? utcDateStamp();
	return `${base}-${channel}.${stamp}.${build}`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

// Candidate tag drivers, most authoritative first.
//
// The monorepo's driver is tauri.conf.json (the same file bump-version.sh reads).
// The rest are for SATELLITE trees: each apps-store app is mirrored to its own
// read-only repo (amajorai/ryu-<app>) whose rolling workflows run this script, and
// those trees have no desktop app. They carry the train version in whichever
// manifest their kind uses, so probe in order rather than making every generated
// workflow pass the right flag for its kind.
const TAG_DRIVERS = [
	"apps/desktop/src-tauri/tauri.conf.json",
	"backend/Cargo.toml",
	"sidecar/package.json",
	"package.json",
];

/** Pull a version out of a JSON (`"version": "x"`) or TOML (`version = "x"`) file. */
function versionFromFile(path) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null; // absent — try the next candidate
	}
	if (path.endsWith(".json")) {
		return JSON.parse(raw).version ?? null;
	}
	// Cargo.toml: the FIRST `version = "…"` is the package's own, which sits in
	// [package] above any [dependencies] entries.
	return /^version\s*=\s*"([^"]+)"/m.exec(raw)?.[1] ?? null;
}

/** Read the in-tree train version from the first tag driver that has one. */
function readInTreeVersion(override) {
	if (override) {
		return override;
	}
	for (const candidate of TAG_DRIVERS) {
		const version = versionFromFile(candidate);
		if (version) {
			return version;
		}
	}
	throw new Error(
		`no in-tree version found (looked in: ${TAG_DRIVERS.join(", ")}). Pass --in-tree <x.y.z>.`
	);
}

/**
 * Every published release tag, best-effort. `gh` first (it sees the real remote
 * state, including releases made by CI on other branches), local git tags as the
 * fallback. Neither working returns [] rather than throwing — base detection then
 * rests on the in-tree version alone and the build stays green.
 */
function publishedTags(repo) {
	try {
		const args = [
			"release",
			"list",
			"--limit",
			"200",
			"--json",
			"tagName",
			"--jq",
			".[].tagName",
		];
		if (repo) {
			args.push("-R", repo);
		}
		const out = execFileSync("gh", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const tags = out.split("\n").filter(Boolean);
		if (tags.length > 0) {
			return tags;
		}
	} catch {
		// gh missing / unauthenticated / no releases — fall through to git.
	}
	try {
		const out = execFileSync("git", ["tag", "-l", "v*"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

function parseArgs(argv) {
	const opts = { channel: null, tag: false, json: false };
	const rest = [...argv];
	while (rest.length > 0) {
		const arg = rest.shift();
		switch (arg) {
			case "--build":
				opts.build = Number(rest.shift());
				break;
			case "--date":
				opts.date = rest.shift();
				break;
			case "--base":
				opts.base = rest.shift();
				break;
			case "--in-tree":
				opts.inTree = rest.shift();
				break;
			case "--repo":
				opts.repo = rest.shift();
				break;
			case "--tag":
				opts.tag = true;
				break;
			case "--json":
				opts.json = true;
				break;
			case "-h":
			case "--help":
				opts.help = true;
				break;
			default:
				if (arg.startsWith("-")) {
					throw new Error(`unknown flag: ${arg}`);
				}
				if (opts.channel) {
					throw new Error(`unexpected argument: ${arg}`);
				}
				opts.channel = arg;
		}
	}
	return opts;
}

function main(argv) {
	const opts = parseArgs(argv);
	if (opts.help || !opts.channel) {
		const header = readFileSync(new URL(import.meta.url), "utf8")
			.split("\n")
			.filter((line) => line.startsWith("//"))
			.map((line) => line.replace(/^\/\/ ?/, ""))
			.join("\n");
		process.stdout.write(`${header}\n`);
		process.exit(opts.help ? 0 : 1);
	}

	const build = Number.isFinite(opts.build)
		? opts.build
		: Number(process.env.GITHUB_RUN_NUMBER ?? 0) || 0;
	const repo = opts.repo ?? process.env.GITHUB_REPOSITORY ?? null;

	const version = nextVersion({
		channel: opts.channel,
		inTreeVersion: readInTreeVersion(opts.inTree),
		published: opts.base ? [] : publishedTags(repo),
		build,
		date: opts.date,
		base: opts.base,
	});

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({
				version,
				tag: `v${version}`,
				base: baseOf(version),
				channel: opts.channel,
			})}\n`
		);
		return;
	}
	process.stdout.write(`${opts.tag ? `v${version}` : version}\n`);
}

// Only run the CLI when invoked directly, so the tests can import the pure parts.
// Compare RESOLVED paths (not a filename suffix) so importing this module from a
// script that happens to share its basename cannot trigger the CLI.
const invokedDirectly = (() => {
	if (!process.argv[1]) {
		return false;
	}
	try {
		return (
			realpathSync(fileURLToPath(import.meta.url)) ===
			realpathSync(process.argv[1])
		);
	} catch {
		return false;
	}
})();

if (invokedDirectly) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`error: ${error.message}\n`);
		process.exit(1);
	}
}
