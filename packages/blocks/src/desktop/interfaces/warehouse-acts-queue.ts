import type { YouSlot } from "./game3d-acts.ts";
import type { LifeBubbleSide } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { SLAB } from "./warehouse-acts-stations.ts";
import { tileToWorld } from "./warehouse-diorama.tsx";

/**
 * The dispatch queue out on the yard by the outbound dock, in slot order
 * from the front: "you-1" by the dock wall, clear above the trailer, "you-2"
 * and "you-3" a plate's width and more to its right along the same row, and
 * "you-4" a row behind, so no two places share a screen column and each
 * queued picker's ask (`QUEUE_BUBBLE`) clears the plates beside it.
 */
const QUEUE_TILES = [
	{ x: 16.3, y: 5.7 },
	{ x: 17.8, y: 3.5 },
	{ x: 20.8, y: 0 },
	{ x: 17.1, y: -1.9 },
] as const;

/**
 * The queue on a phone, where a plate is several tiles wide and the yard
 * alone would stack the places in one column: from the front, "you-1" on
 * the apron before the dock, "you-2" in the dock door, "you-3" up the yard
 * above the trailer, "you-4" on the apron before the truck: each in its own
 * screen column (at least 1.7 tiles of x − y apart), "you-4" off "you-2"'s
 * row, every figure clear of the trailer.
 */
const NARROW_QUEUE_TILES = [
	{ x: 18.2, y: 13.4 },
	{ x: 15.3, y: 8.7 },
	{ x: 18.4, y: 3.6 },
	{ x: 21.2, y: 12.6 },
] as const;

/**
 * Where a queued picker's ask hangs, measured with every place filled (a
 * notice's pallets stand under its plate): straight up, between the plates
 * of the places behind and the asks in front, clear of the floor's pickers
 * (to the side, the front ask would read as theirs, or hang across the
 * pallets of the place behind).
 */
export const QUEUE_BUBBLE: Record<YouSlot, LifeBubbleSide> = {
	"you-1": "up",
	"you-2": "up",
	"you-3": "up",
	"you-4": "up",
};

function queueTile(index: number, narrow: boolean): { x: number; y: number } {
	const tiles = narrow ? NARROW_QUEUE_TILES : QUEUE_TILES;
	return tiles[index] ?? tiles[0];
}

/**
 * The you-spot at the dispatch desk: "you" by the dock, the queue
 * "you-1".."you-4" on the yard, and "you-tray" at the dispatch desk.
 */
export function youTiles(
	narrow = false
): Record<string, { x: number; y: number }> {
	return {
		dock: { x: 15.6, y: 7.6 },
		walk: { x: 11.5, y: 7.6 },
		you: { x: 16.2, y: 7.4 },
		"you-1": queueTile(0, narrow),
		"you-2": queueTile(1, narrow),
		"you-3": queueTile(2, narrow),
		"you-4": queueTile(3, narrow),
		"you-tray": { x: 20.4, y: 7.9 },
	};
}

/** The dispatch desk the tray sits on (tiles). */
export const DISPATCH_DESK = { x: 21, y: 7.1 } as const;

export function youPoints(narrow = false): Record<string, Vec3> {
	return Object.fromEntries(
		Object.entries(youTiles(narrow)).map(([id, tile]) => [
			id,
			tileToWorld(tile.x, tile.y, SLAB),
		])
	);
}
