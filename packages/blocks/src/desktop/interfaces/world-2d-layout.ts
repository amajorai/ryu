import type { WorldLayout, WorldPoint } from "@ryuhq/protocol/interfaces";
import { PX } from "./world-2d-pixel.ts";
import { tileHash, tileKey, type VillageLayout } from "./world-village.ts";

/**
 * Where everything stands in the 2D village, in tiles: the frame (world plus
 * a decorative forest margin that fills the viewport), the furniture placed
 * on free grass, and the trees of the surrounding forest. Pure data, so the
 * renderer can cache layers per layout.
 */

/** Tiles of decorative margin around the world, per axis. */
export interface SceneMargin {
	x: number;
	y: number;
}

export interface SceneFrame {
	/** Frame size in tiles. */
	cols: number;
	margin: SceneMargin;
	rows: number;
}

const MIN_MARGIN = 3;
const MAX_MARGIN = 14;

/** Enough forest around the world to fill the viewport, plus a little. */
export function sceneFrame(
	layout: WorldLayout,
	viewport: { height: number; width: number },
	tilePx: number
): SceneFrame {
	const marginFor = (view: number, tiles: number) =>
		Math.min(
			MAX_MARGIN,
			Math.max(MIN_MARGIN, Math.ceil((view / tilePx - tiles) / 2) + 2)
		);
	const margin = {
		x: marginFor(viewport.width, layout.width),
		y: marginFor(viewport.height, layout.height),
	};
	return {
		cols: layout.width + margin.x * 2,
		margin,
		rows: layout.height + margin.y * 2,
	};
}

export type DecorKind =
	| "barrel"
	| "bench"
	| "board"
	| "cabinet"
	| "crate"
	| "fence"
	| "planter"
	| "shelf"
	| "well";

/** A rectangle of tiles. */
export interface TileRect {
	h: number;
	w: number;
	x: number;
	y: number;
}

export interface VillageProps {
	/** Tiles the furniture stands on; the player walks around them. */
	blocking: ReadonlySet<string>;
	decor: { kind: DecorKind; point: WorldPoint }[];
	/** The town square's fountain (outdoors), centered on its middle tile. */
	fountain: WorldPoint | null;
	lamps: WorldPoint[];
	mailboxes: { agentId: string; point: WorldPoint }[];
	/** A small pond on open grass (outdoors, when there is room). */
	pond: TileRect | null;
	sign: WorldPoint | null;
}

/** On the pond or the ring of grass around it (and the row below). */
function nearPond(pond: TileRect | null, x: number, y: number): boolean {
	return (
		pond !== null &&
		x >= pond.x - 1 &&
		y >= pond.y - 1 &&
		x <= pond.x + pond.w &&
		y <= pond.y + pond.h + 1
	);
}

export function insidePond(
	pond: TileRect | null,
	x: number,
	y: number
): boolean {
	return (
		pond !== null &&
		x >= pond.x &&
		y >= pond.y &&
		x < pond.x + pond.w &&
		y < pond.y + pond.h
	);
}

/**
 * The open patch of grass closest to the spawn point that fits a pond:
 * never on a path, a cottage, a villager, the spawn column or furniture,
 * and never touching a cottage or villager. It may cover trees, whose tiles
 * already block walking.
 */
function findPond(
	layout: WorldLayout,
	village: VillageLayout,
	taken: ReadonlySet<string>
): TileRect | null {
	const homes = new Set<string>();
	for (const house of village.houses) {
		for (let dy = 0; dy < house.h; dy++) {
			for (let dx = 0; dx < house.w; dx++) {
				homes.add(tileKey(house.x + dx, house.y + dy));
			}
		}
	}
	for (const entity of layout.entities) {
		homes.add(tileKey(entity.x, entity.y));
	}
	const open = (x: number, y: number) =>
		insideWorld(layout, x, y) &&
		x !== layout.spawn.x &&
		!village.paths.has(tileKey(x, y)) &&
		!taken.has(tileKey(x, y)) &&
		!homes.has(tileKey(x, y));
	for (const [w, h] of [
		[3, 2],
		[2, 2],
	] as const) {
		let best: TileRect | null = null;
		let bestScore = Number.POSITIVE_INFINITY;
		for (let y = 0; y + h <= layout.height; y++) {
			for (let x = 0; x + w <= layout.width; x++) {
				let fits = true;
				for (let dy = -1; fits && dy <= h; dy++) {
					for (let dx = -1; fits && dx <= w; dx++) {
						const inner = dx >= 0 && dy >= 0 && dx < w && dy < h;
						fits = inner
							? open(x + dx, y + dy)
							: !homes.has(tileKey(x + dx, y + dy));
					}
				}
				const score =
					Math.abs(x + w / 2 - layout.spawn.x) +
					Math.abs(y + h / 2 - layout.spawn.y);
				if (fits && score < bestScore) {
					best = { h, w, x, y };
					bestScore = score;
				}
			}
		}
		if (best) {
			return best;
		}
	}
	// No room in the village: the pond sits in the woods just west of it,
	// above the road out of town, where the camera shows it on wide screens.
	return { h: 2, w: 3, x: -5, y: village.plaza.top - 3 };
}

export function insideWorld(
	layout: WorldLayout,
	x: number,
	y: number
): boolean {
	return x >= 0 && y >= 0 && x < layout.width && y < layout.height;
}

/**
 * Lamps at each cottage's corner, mailboxes and barrels in its yard, fences
 * in the gaps between cottages, and the town square: a fountain in the
 * middle of the cobbles below the spawn point, flanked by benches and
 * lamps, the village sign at the west end and the notice board at the east.
 * A picket fence with flower planters set into it runs along the top of the
 * square, open where the road and the spawn column come through.
 * Everything stands on free ground, never on a path, a doorstep, or the
 * spawn column, so every agent stays reachable along the streets.
 */
export function villageProps(
	layout: WorldLayout,
	village: VillageLayout,
	indoorScene: boolean
): VillageProps {
	const taken = new Set<string>();
	const free = (x: number, y: number) =>
		insideWorld(layout, x, y) &&
		x !== layout.spawn.x &&
		!taken.has(tileKey(x, y)) &&
		!village.blocked.has(tileKey(x, y)) &&
		!village.paths.has(tileKey(x, y)) &&
		!layout.entities.some((entity) => entity.x === x && entity.y === y);
	const take = (point: WorldPoint) => {
		taken.add(tileKey(point.x, point.y));
		return point;
	};
	const outdoor = !indoorScene;
	const lamps: WorldPoint[] = [];
	const mailboxes: { agentId: string; point: WorldPoint }[] = [];
	const decor: { kind: DecorKind; point: WorldPoint }[] = [];
	if (!outdoor) {
		// Each desk spans the villager's tile and both tiles beside it.
		for (const entity of layout.entities) {
			for (const dx of [-1, 1]) {
				if (free(entity.x + dx, entity.y)) {
					take({ x: entity.x + dx, y: entity.y });
				}
			}
		}
	}
	if (outdoor) {
		// Each cottage: a lamppost at its corner in the gap beside it (never
		// in front of the facade), a mailbox at the yard's right edge, and a
		// barrel or crate in the left corner of the yard.
		for (const entity of layout.entities) {
			const lamp = [entity.x + 2, entity.x - 2].find((x) => free(x, entity.y));
			if (lamp !== undefined) {
				lamps.push(take({ x: lamp, y: entity.y }));
			}
			if (free(entity.x + 1, entity.y)) {
				mailboxes.push({
					agentId: entity.agentId,
					point: take({ x: entity.x + 1, y: entity.y }),
				});
			}
			if (free(entity.x - 1, entity.y)) {
				const hash = tileHash(entity.x - 1, entity.y);
				decor.push({
					kind: hash % 2 === 0 ? "barrel" : "crate",
					point: take({ x: entity.x - 1, y: entity.y }),
				});
			}
		}
	}
	// Between neighboring cottages: a picket fence across the back of the
	// gap outdoors. Indoors the partition wall runs through the gap (the
	// tile stays blocked) with a filing cabinet in front of it.
	for (const house of village.houses) {
		const gapX = house.x + house.w;
		if (!free(gapX, house.y)) {
			continue;
		}
		const gap = take({ x: gapX, y: house.y });
		if (outdoor) {
			decor.push({ kind: "fence", point: gap });
		}
		if (!outdoor && free(gapX, house.y + 1)) {
			decor.push({ kind: "cabinet", point: take({ x: gapX, y: house.y + 1 }) });
		}
	}
	const sx = layout.spawn.x;
	const below = village.plaza.bottom + 1;
	let sign: WorldPoint | null = null;
	let fountain: WorldPoint | null = null;
	if (below < layout.height) {
		const place = (dx: number, kind: DecorKind | "lamp") => {
			if (!free(sx + dx, below)) {
				return;
			}
			const point = take({ x: sx + dx, y: below });
			if (kind === "lamp") {
				lamps.push(point);
			} else {
				decor.push({ kind, point });
			}
		};
		if (outdoor) {
			// The fountain's basin is three tiles wide.
			fountain = { x: sx, y: below };
			for (let dx = -1; dx <= 1; dx++) {
				taken.add(tileKey(sx + dx, below));
			}
			place(-2, "bench");
			place(2, "bench");
			place(-4, "lamp");
			place(4, "lamp");
			if (free(sx - 6, below)) {
				sign = take({ x: sx - 6, y: below });
			}
			place(6, "board");
		} else {
			sign = { x: sx, y: below };
			taken.add(tileKey(sx, below));
			place(-2, "bench");
			place(2, "bench");
			place(-4, "shelf");
			place(4, "shelf");
			place(-6, "well");
			place(6, "board");
		}
	}
	const above = village.plaza.top - 1;
	if (outdoor && above >= 0) {
		for (let x = 0; x < layout.width; x++) {
			if (free(x, above)) {
				const planter = Math.abs(x - sx) % 3 === 1;
				decor.push({
					kind: planter ? "planter" : "fence",
					point: take({ x, y: above }),
				});
			}
		}
	}
	const pond = outdoor ? findPond(layout, village, taken) : null;
	if (pond) {
		for (let dy = 0; dy < pond.h; dy++) {
			for (let dx = 0; dx < pond.w; dx++) {
				taken.add(tileKey(pond.x + dx, pond.y + dy));
			}
		}
	}
	return { blocking: taken, decor, fountain, lamps, mailboxes, pond, sign };
}

export interface MarginTree extends WorldPoint {
	variant: number;
}

/** Plaza rows continue out of the village as a road (outdoor only). */
export function isOuterRoad(
	layout: WorldLayout,
	village: VillageLayout,
	x: number,
	y: number
): boolean {
	return (
		!insideWorld(layout, x, y) &&
		y >= village.plaza.top &&
		y <= village.plaza.bottom
	);
}

/**
 * Open glades in the woods: about one 3x3 block in four stays grass (tall
 * grass and wildflowers grow there), so the forest reads as open lots.
 */
export function inClearing(x: number, y: number): boolean {
	return (
		tileHash(Math.floor((x + 60) / 3) + 7, Math.floor((y + 60) / 3)) % 4 === 0
	);
}

/** A loose wood filling the margin around the world, clear of the road. */
export function marginTrees(
	layout: WorldLayout,
	village: VillageLayout,
	frame: SceneFrame,
	pond: TileRect | null = null
): MarginTree[] {
	const trees: MarginTree[] = [];
	const { margin } = frame;
	for (let y = -margin.y; y < layout.height + margin.y + 2; y++) {
		for (let x = -margin.x; x < layout.width + margin.x; x++) {
			if (insideWorld(layout, x, y) || nearPond(pond, x, y)) {
				continue;
			}
			// A strip of open meadow along the square's south edge keeps tall
			// trees from covering its benches and planters.
			if (y === layout.height && x >= -1 && x <= layout.width) {
				continue;
			}
			if (
				isOuterRoad(layout, village, x, y) ||
				isOuterRoad(layout, village, x, y - 1) ||
				isOuterRoad(layout, village, x, y + 1)
			) {
				continue;
			}
			if (inClearing(x, y)) {
				continue;
			}
			const hash = tileHash(x + 911, y + 457);
			// Stagger: alternate rows offset so trunks never line up in a grid.
			if (hash < 400 && (x + y) % 2 === 0) {
				trees.push({ variant: hash % 4, x, y });
			} else if (hash < 130) {
				trees.push({ variant: hash % 4, x, y });
			}
		}
	}
	return trees;
}

/** Frame pixel of a world tile's top-left corner. */
export function tilePixel(frame: SceneFrame, x: number, y: number): WorldPoint {
	return { x: (x + frame.margin.x) * PX, y: (y + frame.margin.y) * PX };
}
