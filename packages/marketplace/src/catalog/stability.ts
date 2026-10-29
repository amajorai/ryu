// packages/marketplace/src/catalog/stability.ts
//
// How finished a listing is — "alpha", "beta", "rc", … — as the store renders it.
//
// Shared because the card and the detail header both show it, and a listing that
// reads "Beta" in one place and "beta" in the other looks like a bug.

/** Display label for a stability level.
 *
 *  Known levels get a proper label; anything else is title-cased and shown
 *  verbatim. That fallback is the point: the level is a free-form string in the
 *  published index precisely so a new tier can ship without a client release, and
 *  dropping an unrecognised value would defeat that. Same tolerance the surface
 *  labels settled on. */
const KNOWN = new Map(
	Object.entries({
		alpha: "Alpha",
		beta: "Beta",
		canary: "Canary",
		experimental: "Experimental",
		nightly: "Nightly",
		prerelease: "Pre-release",
		rc: "Release candidate",
	})
);

/** `null` when the listing is finished — absent, empty, or explicitly stable.
 *  Callers render nothing for `null`, so a stable listing never sprouts a badge. */
export function stabilityLabel(
	stability: string | null | undefined
): string | null {
	const raw = stability?.trim().toLowerCase();
	if (!raw || raw === "stable") {
		return null;
	}
	return KNOWN.get(raw) ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** Whether a listing should be hidden by the default stable-only catalog view.
 *
 * Missing and explicit `stable` values are the finished-release default. Any
 * other non-empty value is intentionally unstable, including a maturity level
 * this client has never heard of: a future release posture must opt in rather
 * than silently entering the safe-looking default list. */
export function isUnstableRelease(
	stability: string | null | undefined
): boolean {
	const raw = stability?.trim().toLowerCase();
	return Boolean(raw && raw !== "stable");
}

/** Display the maturity of one historical version without inventing metadata.
 *
 * A readable manifest with no `stability` field is a known stable version (the
 * manifest default). When the historical manifest could not be read, the
 * generic release flag is the only honest fallback available. */
export function versionStabilityLabel(
	stability: string | null | undefined,
	known: boolean,
	prerelease: boolean
): string {
	const raw = stability?.trim().toLowerCase();
	if (known || raw) {
		return raw && raw !== "stable" ? (stabilityLabel(raw) ?? raw) : "Stable";
	}
	if (prerelease) {
		return "Pre-release";
	}
	return "Stability unavailable";
}
