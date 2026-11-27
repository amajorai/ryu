// apps/desktop/src/lib/usage-rail/usage-rail-fit.ts
//
// How many usage rings a side strip holds, and which rings go behind the "+N"
// ring when they do not all fit. Pure rules, kept out of the components so they
// can be tested against plain numbers.

/**
 * The most ring places a strip gives, also in a tall window: five rings, or
 * four rings and the "+N" ring.
 */
export const MAX_RING_PLACES = 5;

/** The space in pixels that stays free between the roster and the rings. */
export const RAIL_MIN_FREE = 12;

/** The chat list of the full sidebar is never squeezed under this height. */
export const SIDEBAR_MIN_LIST_HEIGHT = 240;

/** What the fitting reads from a ring: how much its source has left, 0 to 100. */
export interface FittedRing {
	leftPercent: number | null;
}

export interface RingLayout<T> {
	/** The rings behind the "+N" ring. Empty, or two and more. */
	more: T[];
	/** The rings that show on their own, in the order they came. */
	shown: T[];
}

/**
 * The ring places that `free` pixels hold when one place takes `slot` pixels.
 * Never under one, so a strip always has room for the "+N" ring, and never
 * over `max`.
 */
export function ringPlaces(
	free: number,
	slot: number,
	max: number = MAX_RING_PLACES
): number {
	if (!(Number.isFinite(free) && Number.isFinite(slot)) || slot <= 0) {
		return 1;
	}
	return Math.max(1, Math.min(max, Math.floor(free / slot)));
}

/**
 * The free height of the narrow rail for rings: what its roster can give up
 * without going under `minRoster`. The roster takes all the height the rail
 * has left, so the rings that already show are added back first.
 */
export function railFreeHeight({
	minRoster,
	renderedPlaces,
	rosterHeight,
	slot,
}: {
	minRoster: number;
	renderedPlaces: number;
	rosterHeight: number;
	slot: number;
}): number {
	return rosterHeight + renderedPlaces * slot - minRoster - RAIL_MIN_FREE;
}

/**
 * Splits the rings over `places`. All show when they fit. When they do not,
 * the rings with the least left keep their place, in their order, and one
 * "+N" ring takes the last place. So the "+N" ring never stands for one ring
 * alone, and with one place it holds every ring.
 */
export function fitUsageRings<T extends FittedRing>(
	rings: readonly T[],
	places: number
): RingLayout<T> {
	const slots = Math.max(1, Math.floor(places));
	if (rings.length <= slots) {
		return { shown: [...rings], more: [] };
	}
	const byLeastLeft = rings
		.map((ring, index) => ({ index, left: ring.leftPercent ?? 100 }))
		.sort((a, b) => a.left - b.left || a.index - b.index)
		.slice(0, slots - 1);
	const kept = new Set(byLeastLeft.map((entry) => entry.index));
	return {
		shown: rings.filter((_, index) => kept.has(index)),
		more: rings.filter((_, index) => !kept.has(index)),
	};
}

/**
 * Where the full sidebar shows its rings: as a row above the account footer,
 * or, when that row would squeeze the chat list under `minListHeight`, as one
 * ring beside the account button. The answer does not depend on which of the
 * two shows now, so a resize cannot make it flip back and forth.
 */
export function sidebarUsagePlacement({
	listHeight,
	minListHeight = SIDEBAR_MIN_LIST_HEIGHT,
	rowHeight,
	rowShown,
}: {
	listHeight: number;
	minListHeight?: number;
	rowHeight: number;
	rowShown: boolean;
}): "footer" | "row" {
	const withoutRow = listHeight + (rowShown ? rowHeight : 0);
	return withoutRow - rowHeight >= minListHeight ? "row" : "footer";
}
