// Island placement: the popover-style contract between the main process (which
// owns where the island sits on screen) and the renderer (which lays the island
// out inside its window).
//
// The island is pinned to an *anchor point* on screen, and a placement says which
// point of the island's footprint sits on that anchor -- exactly like a popover's
// `bottom-end` / `top-start` placement. An island docked bottom-right is anchored
// by its bottom-right corner, so every footprint change (split, suggestion, the
// tall chat panel) grows up and to the left while that corner stays put, and a
// collapse shrinks back into the same corner with no drift. The placement is
// derived from the 3x3 snap zone the island rests in: the left column aligns
// `start`, the middle column `center`, the right column `end` (rows likewise).

/** Where a footprint aligns to its anchor along one axis. */
export type IslandAlign = "start" | "center" | "end";

/** Horizontal (`h`) and vertical (`v`) alignment of the footprint to its anchor. */
export interface IslandPlacement {
	h: IslandAlign;
	v: IslandAlign;
}

/** Snap zones per row/column (3x3). Mirrors `GRID` in `main/zones.ts`. */
const GRID = 3;

/** Axis alignment for a zone row/column index (0 = start, 1 = center, 2 = end). */
const ALIGN_BY_SLOT: readonly IslandAlign[] = ["start", "center", "end"];

/**
 * The placement for a resting snap zone (row-major, 0 = top-left, 8 =
 * bottom-right): the footprint grows away from the edges it is docked to.
 */
export function placementForZone(zone: number): IslandPlacement {
	const clamped = Math.min(Math.max(Math.trunc(zone), 0), GRID * GRID - 1);
	return {
		h: ALIGN_BY_SLOT[clamped % GRID],
		v: ALIGN_BY_SLOT[Math.floor(clamped / GRID)],
	};
}

/** The snap zone a placement docks to (inverse of {@link placementForZone}). */
export function zoneForPlacement(placement: IslandPlacement): number {
	return (
		ALIGN_BY_SLOT.indexOf(placement.v) * GRID +
		ALIGN_BY_SLOT.indexOf(placement.h)
	);
}

/** Whether two placements align the footprint identically. */
export function samePlacement(a: IslandPlacement, b: IslandPlacement): boolean {
	return a.h === b.h && a.v === b.v;
}

/** Runtime guard for placements arriving over IPC or from disk. */
export function isIslandPlacement(value: unknown): value is IslandPlacement {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const { h, v } = value as Record<string, unknown>;
	return (
		ALIGN_BY_SLOT.includes(h as IslandAlign) &&
		ALIGN_BY_SLOT.includes(v as IslandAlign)
	);
}

/**
 * Padding (px) between the fixed-size translucent window's edges and the island
 * group it aligns inside. The sides and bottom leave room for the shapes' drop
 * shadows; the top stays tight so a top-docked window never has to sit above the
 * screen (macOS keeps windows below the menu bar).
 */
export const TRANSLUCENT_WINDOW_INSET = {
	top: 8,
	right: 48,
	bottom: 48,
	left: 48,
} as const;

/** Command-line switch that seeds the renderer with the window's placement. */
const PLACEMENT_ARG_PREFIX = "--island-placement=";

/** Encode a placement as the window's `additionalArguments` switch. */
export function placementArg(placement: IslandPlacement): string {
	return `${PLACEMENT_ARG_PREFIX}${placement.h},${placement.v}`;
}

/**
 * Read the placement switch from a renderer's `process.argv`, falling back to
 * `fallback` when it is missing or malformed.
 */
export function parsePlacementArg(
	argv: readonly string[],
	fallback: IslandPlacement
): IslandPlacement {
	const arg = argv.find((value) => value.startsWith(PLACEMENT_ARG_PREFIX));
	if (!arg) {
		return fallback;
	}
	const [h, v] = arg.slice(PLACEMENT_ARG_PREFIX.length).split(",");
	const parsed = { h, v };
	return isIslandPlacement(parsed) ? parsed : fallback;
}
