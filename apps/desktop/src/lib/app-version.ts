// apps/desktop/src/lib/app-version.ts
//
// WHICH ARTIFACT AN UPDATE VERDICT IS ABOUT.
//
// Core owns the update *verdict* (`/api/update/check`) but it answers about
// ITSELF: `UpdateCheck.current` is the answering Core binary's own
// `CARGO_PKG_VERSION`. That is the right answer for the Gateway dialog's Updates
// tab, which governs the node's Core/Gateway binaries — and the WRONG one for
// every surface that drives THIS APP'S bundle through `installUpdate`.
//
// The two are separate installs that routinely sit at different versions: on
// macOS the desktop downloads `ryu-core` into `~/.ryu/bin` and stamps a
// `ryu-core.version` marker beside it, so a failed or skipped re-download leaves
// an old Core answering for a new app. That is exactly the reported bug — an
// 0.1.3 app was told "Update available — v0.1.3", because the Core that answered
// was 0.0.14 and `is_newer("0.0.14", "0.1.3")` is perfectly true.
//
// So: ask Core WHETHER a release exists, then decide HERE whether it is newer
// than the running app. Same division of labour as `CheckForUpdateOptions.clamp`
// — the node supplies facts, the client owns the facts about itself.

import { channelOf } from "@ryuhq/core-client/node-compat.ts";
import type { UpdateCheck } from "@/src/lib/api/update.ts";

/**
 * The running desktop bundle's version, e.g. `"0.1.3"` or
 * `"0.1.2-nightly.20260804.24"` (rolling channels stamp the prerelease straight
 * into `tauri.conf.json`, so an app version is self-describing the same way a
 * Core build is).
 *
 * `null` outside a Tauri shell — the browser dev server and the e2e harness both
 * run this code with no `@tauri-apps/api` host. Every caller treats `null` as
 * "unknown", never as "old": an unknown app version must not suppress an update.
 */
let cached: string | null | undefined;

export async function getAppVersion(): Promise<string | null> {
	if (cached !== undefined) {
		return cached;
	}
	try {
		const { getVersion } = await import("@tauri-apps/api/app");
		cached = await getVersion();
	} catch {
		cached = null;
	}
	return cached;
}

interface Parsed {
	core: number[];
	pre: string[];
}

/**
 * Parse a version with FULL semver 2.0 precedence, prerelease included.
 *
 * Mirrors Core's `parse_version` (apps/core/src/update/mod.rs), including its
 * leniency (a short `1.2` pads to `1.2.0`) and its treatment of build metadata
 * (kept for display, ignored for ordering per §10). Deliberately NOT
 * `compareSemver` from `@ryuhq/core-client/node-compat`: that one discards the
 * prerelease on purpose, because a canary build of 0.0.18 really does clear an
 * 0.0.18 *floor*. Here the prerelease is the whole point — two nightlies differ
 * in nothing else, and dropping it makes every nightly compare equal to every
 * other, which is the exact bug Core's own doc comment records.
 */
function parse(version: string): Parsed | null {
	const raw = version.trim().replace(/^[vV]/, "");
	// Build metadata never affects precedence, so it is cut before anything else.
	const withoutBuild = raw.split("+")[0] ?? "";
	const dash = withoutBuild.indexOf("-");
	const corePart = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
	const prePart = dash === -1 ? "" : withoutBuild.slice(dash + 1);

	const segments = corePart.split(".");
	if (segments.length === 0 || segments.length > 3) {
		return null;
	}
	const core: number[] = [];
	for (const segment of segments) {
		if (!/^\d+$/.test(segment)) {
			return null;
		}
		core.push(Number(segment));
	}
	// Lenient pad: `1` → `1.0.0`, `1.2` → `1.2.0`.
	while (core.length < 3) {
		core.push(0);
	}
	const pre = prePart === "" ? [] : prePart.split(".");
	if (pre.some((id) => id === "")) {
		return null;
	}
	return { core, pre };
}

const NUMERIC = /^\d+$/;

/** Semver §11 prerelease precedence. Returns -1 / 0 / 1. */
function comparePrerelease(a: string[], b: string[]): number {
	// "a version with a prerelease has LOWER precedence than the same version
	// without one" — so an empty identifier list wins.
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
	for (let i = 0; i < shared; i += 1) {
		// SAFETY: This private helper receives only parse()'s fresh dense split arrays; i is below both lengths and neither array is mutated.
		const left = a[i];
		// SAFETY: b is the other fresh parse() split array; the same min-length loop bound proves this slot is a string.
		const right = b[i];
		const leftNumeric = NUMERIC.test(left);
		const rightNumeric = NUMERIC.test(right);
		if (leftNumeric && rightNumeric) {
			const diff = Number(left) - Number(right);
			if (diff !== 0) {
				return diff < 0 ? -1 : 1;
			}
			continue;
		}
		// Numeric identifiers always rank lower than alphanumeric ones.
		if (leftNumeric !== rightNumeric) {
			return leftNumeric ? -1 : 1;
		}
		if (left !== right) {
			return left < right ? -1 : 1;
		}
	}
	// A larger set of identifiers wins when every shared one is equal.
	if (a.length === b.length) {
		return 0;
	}
	return a.length < b.length ? -1 : 1;
}

/**
 * `true` when `latest` is strictly newer than `current` by semver precedence.
 *
 * Fail-safe in the same direction as Core's `is_newer`: an unparseable `latest`
 * NEVER claims to be newer (a malformed tag cannot trigger an update), while an
 * unparseable `current` loses to any real release (a corrupt install can still
 * recover onto a good build).
 */
export function isNewerVersion(current: string, latest: string): boolean {
	const a = parse(current);
	const b = parse(latest);
	if (!b) {
		return false;
	}
	if (!a) {
		return true;
	}
	for (let i = 0; i < 3; i += 1) {
		// SAFETY: parse() pushes numeric components and pads this private fresh array to exactly three entries; i is 0, 1, or 2.
		const left = a.core[i];
		// SAFETY: b is the other successful private parse() result with exactly three numeric entries; no mutation precedes this indexed read.
		const right = b.core[i];
		if (left !== right) {
			return right > left;
		}
	}
	return comparePrerelease(b.pre, a.pre) > 0;
}

/**
 * Whether a Core verdict describes an update to THIS APP'S bundle.
 *
 * Three ways this defers to Core's verdict untouched, all deliberate:
 *
 *   - `update_available` is already false — nothing to re-decide.
 *   - the app version is unknown (no Tauri shell). An unknown version must never
 *     suppress an update; the historical behaviour is the safe one.
 *   - the offered release is on a DIFFERENT channel than the running build. That
 *     is a channel *switch*, not an update, and semver precedence answers it
 *     wrongly by construction: a stable 0.1.3 outranks 0.1.3-nightly.x, so
 *     gating on it would make the channel picker inert — the exact class of
 *     silent-inertness bug Core's `channel_of` doc warns about.
 */
export function releaseIsNewerThanApp(
	appVersion: string | null | undefined,
	latest: string
): boolean {
	if (!appVersion) {
		return true;
	}
	if (channelOf(appVersion) !== channelOf(latest)) {
		return true;
	}
	return isNewerVersion(appVersion, latest);
}

/** {@link releaseIsNewerThanApp} against the running bundle, for async callers. */
export async function verdictAppliesToApp(
	verdict: UpdateCheck
): Promise<boolean> {
	if (!verdict.update_available) {
		return false;
	}
	return releaseIsNewerThanApp(await getAppVersion(), verdict.latest);
}
