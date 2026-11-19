// packages/marketplace/src/catalog/types-compatibility.ts
//
// Host surfaces, per-surface support summaries, and the `engines` floor
// compatibility evaluator.
// Split out of `types.ts`, which re-exports everything here so existing import
// paths keep working.

/** The host surfaces a plugin can declare support for.
 *
 *  Mirrors the `Surface` enum in `crates/core/kernel-contracts/src/manifest.rs`
 *  (and its SDK mirror, `@ryuhq/sdk`'s generated `plugin-manifest.ts`). Duplicated
 *  here rather than imported so this package keeps no dependency on the SDK; the
 *  `satisfies Record<Surface, string>` on `SURFACE_LABELS` is what stops the two
 *  drifting silently, which is exactly how that map ended up defining `browser`
 *  and `tui` — two tokens that were never real surfaces.
 *
 *  `unknown` is not a surface anyone declares: it is the landing pad Core
 *  deserializes an unrecognised token onto so a manifest from a newer Ryu loads
 *  instead of failing outright. */
export type Surface =
	| "gateway"
	| "core"
	| "desktop"
	| "island"
	| "mobile"
	| "extension"
	| "web"
	| "cli"
	| "unknown";

/** One safe catalog row for a listing's per-surface support declaration.
 *
 * `support` stays a string so a newer Core can add a level without breaking an
 * older catalog client. `inheritedFrom` describes the host-shell relationship,
 * not package code inheritance: Web, Mobile, and the Browser extension reuse the
 * shared Desktop shell contract. */
export interface CatalogSurfaceSupport {
	inheritedFrom?: string | null;
	support?: string | null;
	surface: string;
}

/** A display-only summary of an existing host capability or shell slot this
 * listing extends. The signed manifest's `provides`/`contributes` declarations
 * remain the authority; this shape contains no executable binding. */
export interface CatalogExtensionSummary {
	features: string[];
	label: string;
	target: string;
}

/** A display-only ownership boundary for the listing's implementation. */
export interface CatalogImplementationSummary {
	features: string[];
	label: string;
	layer: string;
}

// ── Host version floors (`engines`) ──────────────────────────────────────────

/** The `engines` block: a semver requirement per host surface. Mirrors Core's
 *  `EnginesReq`.
 *
 *  `ryu` is the CORE floor under its legacy name — every manifest in the wild
 *  spells it that way, and Core's `Surface::engines_key()` maps `core` onto it.
 *  When naming the offending key in UI copy, use `engines_key`-equivalent wording
 *  (`ryu` for core), never the bare surface token, or the message points at a key
 *  that does not exist in any manifest. */
export interface HostFloors {
	cli?: string | null;
	desktop?: string | null;
	extension?: string | null;
	gateway?: string | null;
	island?: string | null;
	mobile?: string | null;
	/** The CORE floor. */
	ryu?: string | null;
	web?: string | null;
}

/** One unsatisfied floor. Tagged on `code`, mirroring Core's `UnmetRequirement`.
 *
 *  `unknown` is ADVISORY and must never block a verb: it means the evaluator did
 *  not know that surface's version, not that the surface is too old. */
export type UnmetRequirement =
	| { code: "too_old"; surface: Surface; required: string; present: string }
	| { code: "unknown"; surface: Surface; required: string }
	| {
			code: "invalid_requirement";
			surface: Surface;
			required: string;
			reason: string;
	  }
	/** `engines.host_api` unsatisfied: `required`/`present` are plugin host API
	 *  versions, not product versions. Always blocking (Core knows its host API). */
	| {
			code: "host_api_too_old";
			surface: Surface;
			required: string;
			present: string;
	  };

/** The result of checking {@link HostFloors} against the running hosts. */
export interface CompatibilityVerdict {
	/** True when nothing BLOCKING is unmet. Advisory `unknown` entries do not
	 *  clear this — a plugin whose only problem is an unobservable surface stays
	 *  installable. */
	compatible: boolean;
	/** Every unsatisfied floor, blocking and advisory alike. */
	unmet?: UnmetRequirement[];
}

/** The surface a floor key names, for display. `ryu` is Core. */
const FLOOR_KEY_TO_SURFACE = {
	cli: "cli",
	desktop: "desktop",
	extension: "extension",
	gateway: "gateway",
	island: "island",
	mobile: "mobile",
	ryu: "core",
	web: "web",
} satisfies Record<keyof HostFloors, Surface>;

/** Strip a leading `v` and any prerelease/build suffix, returning `[major, minor,
 *  patch]`, or `null` if it does not look like semver.
 *
 *  The suffix is DROPPED on purpose, matching Core: semver says a prerelease does
 *  not satisfy a plain `>=` range, so comparing `0.1.12-nightly.3` verbatim
 *  against `>=0.1.0` would mark every plugin incompatible on every nightly. */
function releaseTriple(version: string): [number, number, number] | null {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare two release triples: negative if `a < b`, 0 if equal, positive if `a > b`. */
function compareTriples(
	a: [number, number, number],
	b: [number, number, number]
): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Does `present` satisfy the semver requirement `required`?
 *
 *  Deliberately a SUBSET of semver's range grammar — the comparator forms Core's
 *  `VersionReq` actually sees in practice (`>=x`, `>x`, `<x`, `<=x`, `=x`, a bare
 *  version meaning `>=`, and comma-separated conjunctions). Returns `null` for
 *  anything it cannot parse, and every caller treats `null` as "cannot decide,
 *  do not claim incompatible" — the client is a DISPLAY refinement, and Core
 *  remains the authority that actually refuses the install. */
function satisfies(present: string, required: string): boolean | null {
	const have = releaseTriple(present);
	if (!have) {
		return null;
	}
	for (const rawPart of required.split(",")) {
		const part = rawPart.trim();
		if (part === "" || part === "*") {
			continue;
		}
		// Minor and patch are BOTH optional: a bound is routinely written `<2`, and
		// requiring `x.y` made that unparseable, so `">=1.2, <2"` silently degraded
		// to "cannot decide" and let a 2.0.0 host look compatible. An omitted
		// component is zero, matching semver's own reading of a partial version.
		const m = /^(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(
			part
		);
		if (!m) {
			return null;
		}
		const op = m[1] ?? ">=";
		const want: [number, number, number] = [
			Number(m[2]),
			Number(m[3] ?? 0),
			Number(m[4] ?? 0),
		];
		const cmp = compareTriples(have, want);
		const ok =
			(op === ">=" && cmp >= 0) ||
			(op === ">" && cmp > 0) ||
			(op === "<=" && cmp <= 0) ||
			(op === "<" && cmp < 0) ||
			(op === "=" && cmp === 0);
		if (!ok) {
			return false;
		}
	}
	return true;
}

/** Re-evaluate {@link HostFloors} with the versions THIS client knows.
 *
 *  Why a client-side pass exists at all: Core observes only its own version and
 *  the Gateway's, so it reports a desktop/island/mobile floor as advisory
 *  `unknown`. The desktop DOES know its own version (Tauri's `getVersion()`), so
 *  overlaying it turns that advisory into a real refusal — the whole point of
 *  declaring a per-surface floor.
 *
 *  Strictly a refinement: a floor this function cannot parse, or a surface it has
 *  no version for, is left exactly as Core reported it. It never marks something
 *  compatible that Core called incompatible.
 *
 *  @param floors    the listing's declared `engines`
 *  @param known     surface → running version, for surfaces this client knows
 *  @param serverVerdict Core's verdict, used as the base so server-only knowledge
 *                       (the observed Gateway version) is not lost. */
export function evaluateCompatibility(
	floors: HostFloors | null | undefined,
	known: Partial<Record<Surface, string>>,
	serverVerdict?: CompatibilityVerdict | null
): CompatibilityVerdict {
	if (!floors) {
		return serverVerdict ?? { compatible: true, unmet: [] };
	}

	const unmet: UnmetRequirement[] = [];
	// SAFETY: This private literal contains only HostFloors keys and Surface
	// values, checked above with satisfies. It has no other writes or exports;
	// Object.entries copies those own enumerable key/value pairs into tuples.
	for (const [key, surface] of Object.entries(FLOOR_KEY_TO_SURFACE) as [
		keyof HostFloors,
		Surface,
	][]) {
		const required = floors[key];
		if (!required) {
			continue;
		}
		// Prefer what this client knows; fall back to what the server already said
		// about the same surface so an observed Gateway version survives.
		const present = known[surface];
		if (present === undefined) {
			const fromServer = serverVerdict?.unmet?.find(
				(u) => u.surface === surface && u.code !== "host_api_too_old"
			);
			unmet.push(fromServer ?? { code: "unknown", required, surface });
			continue;
		}
		const ok = satisfies(present, required);
		if (ok === false) {
			unmet.push({ code: "too_old", present, required, surface });
		} else if (ok === null) {
			// Undecidable locally — defer to the server rather than invent a verdict.
			const fromServer = serverVerdict?.unmet?.find(
				(u) => u.surface === surface && u.code !== "host_api_too_old"
			);
			if (fromServer) {
				unmet.push(fromServer);
			}
		}
	}

	// The host API floor is not a surface this client can observe; keep Core's
	// verdict on it verbatim.
	for (const u of serverVerdict?.unmet ?? []) {
		if (u.code === "host_api_too_old") {
			unmet.push(u);
		}
	}

	return {
		compatible: !unmet.some(isBlockingUnmet),
		unmet,
	};
}

/** The entries that actually prevent an install (advisory `unknown` excluded).
 *
 *  Shared so no caller has to re-derive which codes block — getting that wrong in
 *  one place is how an advisory turns into a spurious refusal. The user-facing
 *  sentence lives in `surface-labels.ts` (`describeIncompatibility`), which owns
 *  the surface display names. */
export function blockingUnmet(
	verdict: CompatibilityVerdict | null | undefined
): UnmetRequirement[] {
	return (verdict?.unmet ?? []).filter(isBlockingUnmet);
}

function isBlockingUnmet(u: UnmetRequirement): boolean {
	return (
		u.code === "too_old" ||
		u.code === "invalid_requirement" ||
		u.code === "host_api_too_old"
	);
}
