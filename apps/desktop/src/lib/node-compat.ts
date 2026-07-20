// Node compatibility: a minimum-version floor + capability negotiation, instead of a
// version-compatibility matrix. The desktop and a *local* node move in lockstep (one
// release train), so the only real skew is a *remote* node on an older build. We fail
// soft: surface a banner below the floor, and gate features on advertised capabilities
// rather than on version numbers.

/** The oldest Core version this desktop fully supports. Bump ONLY on a breaking API change. */
export const MIN_CORE_VERSION = "0.0.1";

/** Parse "1.2.3" (or "v1.2.3") → [1,2,3]. Returns null if unparseable. */
function parseSemver(v: string): [number, number, number] | null {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim().replace(/^v/, ""));
	if (!match) {
		return null;
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** -1 if a<b, 0 if equal, 1 if a>b. Unparseable inputs compare equal (fail-soft). */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!(pa && pb)) {
		return 0;
	}
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) {
			return pa[i] < pb[i] ? -1 : 1;
		}
	}
	return 0;
}

/**
 * Whether a node's version meets the desktop's minimum floor. An unknown version
 * (older nodes that don't report one, or unparseable) is treated as compatible
 * (fail-soft) — capability checks then handle per-feature gating.
 */
export function isNodeCompatible(version: string | null | undefined): boolean {
	if (!version) {
		return true;
	}
	return compareSemver(version, MIN_CORE_VERSION) >= 0;
}

/**
 * Whether a node advertises a capability. A node that reports no capability list is
 * a legacy node that predates capability advertisement — treated as "has it" so we
 * never falsely hide features (the version-floor banner warns the user instead).
 */
export function hasCapability(
	capabilities: string[] | undefined,
	cap: string
): boolean {
	if (!capabilities || capabilities.length === 0) {
		return true;
	}
	return capabilities.includes(cap);
}
