import type { WorldLayout, WorldPoint } from "@ryuhq/protocol/interfaces";
import {
	tileHash,
	tileKey,
	type VillageLayout,
	type VillageTree,
} from "./world-village.ts";

/**
 * Extra lawn rows the 3D village draws between one row's street and the
 * backs of the next row's houses. The shared layout packs rows four tiles
 * apart, which reads fine from above (2D, minimap) but hides every back-row
 * agent behind the front-row roofs under a third-person camera. Spreading the
 * rows only in the 3D drawing keeps walking, adjacency and the minimap on the
 * shared grid while every doorstep faces an open street on screen.
 */
export const ROW_GAP = 3;

export interface SpreadVillage {
	layout: WorldLayout;
	/** Shared-grid tile to the tile it is drawn on. */
	mapPoint: (point: WorldPoint) => WorldPoint;
	village: VillageLayout;
}

function mapKeys(
	keys: ReadonlySet<string>,
	mapPoint: (point: WorldPoint) => WorldPoint
): Set<string> {
	const mapped = new Set<string>();
	for (const key of keys) {
		const [x = 0, y = 0] = key.split(",").map(Number);
		const point = mapPoint({ x, y });
		mapped.add(tileKey(point.x, point.y));
	}
	return mapped;
}

/** Lawn, flowers and the road's continuation in the inserted rows. */
function fillGaps(
	layout: WorldLayout,
	village: VillageLayout,
	streets: readonly number[],
	mapPoint: (point: WorldPoint) => WorldPoint,
	out: { flowers: WorldPoint[]; paths: Set<string>; trees: VillageTree[] }
) {
	for (const street of streets) {
		const top = mapPoint({ x: 0, y: street }).y + 1;
		for (let y = top; y < top + ROW_GAP; y++) {
			for (let x = 0; x < layout.width; x++) {
				// A road that crosses from the street to the next row keeps going.
				const road =
					village.paths.has(tileKey(x, street)) &&
					village.paths.has(tileKey(x, street + 1));
				if (road) {
					out.paths.add(tileKey(x, y));
					continue;
				}
				const hash = tileHash(x + 311, y - 977);
				const border = x === 0 || x === layout.width - 1;
				if (border && hash % 5 !== 0) {
					out.trees.push({ variant: hash % 4, x, y });
				} else if (hash > 780) {
					out.flowers.push({ x, y });
				}
			}
		}
	}
}

/**
 * The village as the 3D world draws it: the same scenery with `ROW_GAP`
 * lawn rows inserted after every street but the last.
 */
export function spreadVillage(
	layout: WorldLayout,
	village: VillageLayout
): SpreadVillage {
	const rows = [...new Set(layout.entities.map((entity) => entity.y))].sort(
		(a, b) => a - b
	);
	const streets = rows.slice(0, -1).map((y) => y + 1);
	if (streets.length === 0) {
		return { layout, mapPoint: (point) => point, village };
	}
	const mapPoint = (point: WorldPoint): WorldPoint => {
		let shift = 0;
		for (const street of streets) {
			if (street < point.y) {
				shift += ROW_GAP;
			}
		}
		return shift === 0 ? point : { x: point.x, y: point.y + shift };
	};
	const spreadLayout: WorldLayout = {
		entities: layout.entities.map((entity) => ({
			...entity,
			y: mapPoint(entity).y,
		})),
		height: layout.height + streets.length * ROW_GAP,
		spawn: mapPoint(layout.spawn),
		width: layout.width,
	};
	const paths = mapKeys(village.paths, mapPoint);
	const trees = village.trees.map((tree) => ({ ...tree, ...mapPoint(tree) }));
	const flowers = village.flowers.map(mapPoint);
	fillGaps(layout, village, streets, mapPoint, { flowers, paths, trees });
	const blocked = mapKeys(village.blocked, mapPoint);
	for (const tree of trees) {
		blocked.add(tileKey(tree.x, tree.y));
	}
	return {
		layout: spreadLayout,
		mapPoint,
		village: {
			blocked,
			flowers,
			houses: village.houses.map((house) => ({
				...house,
				door: mapPoint(house.door),
				y: mapPoint(house).y,
			})),
			paths,
			plaza: {
				bottom: mapPoint({ x: 0, y: village.plaza.bottom }).y,
				top: mapPoint({ x: 0, y: village.plaza.top }).y,
			},
			trees,
		},
	};
}
