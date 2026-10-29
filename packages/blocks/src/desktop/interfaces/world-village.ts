import type { WorldLayout, WorldPoint } from "@ryuhq/protocol/interfaces";

/**
 * Scenery shared by the 2D and 3D worlds, derived only from the protocol's
 * world layout so both renderers draw the same village: every agent has a
 * house with the agent standing at its door, stone paths connect each
 * doorstep to the plaza, and trees fill the rest without ever touching a
 * path. Houses and trees block walking; paths and the plaza never do, so
 * every agent stays reachable from spawn.
 */
export interface VillageHouse {
	agentId: string;
	/** Door tile (directly above the agent). */
	door: WorldPoint;
	/** Footprint top-left tile and size in tiles. */
	h: number;
	w: number;
	x: number;
	y: number;
}

export interface VillageTree extends WorldPoint {
	/** Deterministic 0..3 size/shape variant. */
	variant: number;
}

export interface VillageLayout {
	blocked: ReadonlySet<string>;
	flowers: WorldPoint[];
	houses: VillageHouse[];
	paths: ReadonlySet<string>;
	/** First and last row of the plaza strip the player spawns on. */
	plaza: { bottom: number; top: number };
	trees: VillageTree[];
}

export const tileKey = (x: number, y: number) => `${x},${y}`;

/** Small deterministic hash so scenery never flickers between renders. */
export function tileHash(x: number, y: number): number {
	let h = (x * 374_761_393 + y * 668_265_263) | 0;
	h = (h ^ (h >>> 13)) * 1_274_126_177;
	return ((h ^ (h >>> 16)) >>> 0) % 1000;
}

export function layoutVillage(layout: WorldLayout): VillageLayout {
	const plaza = { bottom: layout.spawn.y, top: layout.spawn.y - 1 };
	const houses: VillageHouse[] = [];
	const houseTiles = new Set<string>();
	const paths = new Set<string>();
	const addPath = (x: number, y: number) => {
		if (x >= 0 && y >= 0 && x < layout.width && y < layout.height) {
			paths.add(tileKey(x, y));
		}
	};

	for (const entity of layout.entities) {
		const house: VillageHouse = {
			agentId: entity.agentId,
			door: { x: entity.x, y: entity.y - 1 },
			h: 2,
			w: 3,
			x: entity.x - 1,
			y: entity.y - 2,
		};
		houses.push(house);
		for (let dy = 0; dy < house.h; dy++) {
			for (let dx = 0; dx < house.w; dx++) {
				houseTiles.add(tileKey(house.x + dx, house.y + dy));
			}
		}
		// The agent stands on its doorstep.
		addPath(entity.x, entity.y);
	}

	// A street runs along the row below each row of agents. Houses sit in
	// columns, so the column just right of a house never holds a house in any
	// row: the main road runs down the gap nearest the spawn point and joins
	// every street to the plaza without cutting through anyone's home.
	const rows = new Map<number, number[]>();
	for (const entity of layout.entities) {
		const xs = rows.get(entity.y + 1) ?? [];
		xs.push(entity.x);
		rows.set(entity.y + 1, xs);
	}
	const agentColumns = [...new Set(layout.entities.map((entity) => entity.x))];
	const gapColumns = [
		Math.min(...agentColumns) - 2,
		...agentColumns.map((x) => x + 2),
	].filter((x) => x > 0 && x < layout.width - 1);
	const roadX = gapColumns.reduce(
		(best, x) =>
			Math.abs(x - layout.spawn.x) < Math.abs(best - layout.spawn.x) ? x : best,
		gapColumns[0] ?? layout.spawn.x
	);
	for (const [y, xs] of rows) {
		const from = Math.min(...xs, roadX);
		const to = Math.max(...xs, roadX);
		for (let x = from; x <= to; x++) {
			addPath(x, y);
		}
	}
	const topStreet = Math.min(...rows.keys(), plaza.top);
	for (let y = topStreet; y < plaza.top; y++) {
		addPath(roadX, y);
	}
	for (let x = 0; x < layout.width; x++) {
		addPath(x, plaza.top);
		addPath(x, plaza.bottom);
	}

	const trees: VillageTree[] = [];
	const flowers: WorldPoint[] = [];
	const nearPathOrHouse = (x: number, y: number) => {
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const key = tileKey(x + dx, y + dy);
				if (paths.has(key) || houseTiles.has(key)) {
					return true;
				}
			}
		}
		return false;
	};
	for (let y = 0; y < layout.height; y++) {
		for (let x = 0; x < layout.width; x++) {
			const key = tileKey(x, y);
			if (paths.has(key) || houseTiles.has(key)) {
				continue;
			}
			const hash = tileHash(x, y);
			const border = x === 0 || y === 0 || x === layout.width - 1;
			if (
				(border && hash % 5 !== 0) ||
				(!nearPathOrHouse(x, y) && hash < 220)
			) {
				trees.push({ variant: hash % 4, x, y });
			} else if (hash > 900) {
				flowers.push({ x, y });
			}
		}
	}

	const blocked = new Set<string>(houseTiles);
	for (const tree of trees) {
		blocked.add(tileKey(tree.x, tree.y));
	}
	return { blocked, flowers, houses, paths, plaza, trees };
}
