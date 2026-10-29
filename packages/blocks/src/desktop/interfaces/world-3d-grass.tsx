import type { WorldLayout } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import {
	type Blade,
	FlowerClusters,
	GrassBlades,
	growBlades,
} from "./game3d-grass.tsx";
import {
	ISLAND_MARGIN,
	type IslandShape,
	islandShape,
	onIsland,
	steppingStone,
} from "./game3d-island.ts";
import {
	type Scene3dTheme,
	sunDirection,
	type Vec3,
} from "./game3d-palette.ts";
import { type HouseBox, houseBoxes } from "./world-3d-focus.ts";
import { tileToWorld } from "./world-3d-theme.ts";
import { tileKey, type VillageLayout } from "./world-village.ts";

/**
 * World 3D's lawn and wildflowers on the game kit's grass (see
 * game3d-grass.tsx): blades grow on lawn tiles only (never on paths, the
 * plaza, the beach or under cottages), thicker along the lawn's edges,
 * with cottage shadows baked into their color, and flowers dot the
 * village's flower tiles.
 */

/** Cottage height the baked shade assumes, in tiles. */
const SHADE_HEIGHT = 2.1;
/** Whether the ground at (x, z) lies in a cottage's shadow. */
function inShadow(
	x: number,
	z: number,
	boxes: readonly HouseBox[],
	toward: Vec3
): boolean {
	for (const box of boxes) {
		for (let step = 1; step <= 4; step++) {
			const h = (SHADE_HEIGHT * step) / 4;
			const sx = x + (toward[0] / toward[1]) * h;
			const sz = z + (toward[2] / toward[1]) * h;
			if (sx > box.minX && sx < box.maxX && sz > box.minZ && sz < box.maxZ) {
				return true;
			}
		}
	}
	return false;
}

/** Lawn tiles' weights: edges grow thicker than the middle of a lawn. */
function lawnTiles(
	layout: WorldLayout,
	village: VillageLayout
): { weight: number; x: number; y: number }[] {
	const houseTiles = new Set<string>();
	for (const house of village.houses) {
		for (let dy = 0; dy < house.h; dy++) {
			for (let dx = 0; dx < house.w; dx++) {
				houseTiles.add(tileKey(house.x + dx, house.y + dy));
			}
		}
	}
	const shape = islandShape(layout, true);
	const open = (x: number, y: number) => {
		const key = tileKey(x, y);
		if (houseTiles.has(key)) {
			return false;
		}
		// The plaza's front row is lawn with stepping stones (see terrain).
		return y === village.plaza.bottom || !village.paths.has(key);
	};
	const tiles: { weight: number; x: number; y: number }[] = [];
	// Rows past the grid's last row are beach: never grass.
	for (let y = -ISLAND_MARGIN; y < layout.height; y++) {
		for (let x = -ISLAND_MARGIN; x < layout.width + ISLAND_MARGIN; x++) {
			const [cx, , cz] = tileToWorld(layout, { x, y });
			if (!(open(x, y) && onIsland(shape, cx, cz, 0.2))) {
				continue;
			}
			const rim = x < 0 || y < 0 || x >= layout.width ? 0.7 : 1;
			let edge = 0;
			for (const [dx, dy] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			] as const) {
				if (!open(x + dx, y + dy)) {
					edge += 1;
				}
			}
			// Thicker along paths and around the cottages' plots.
			tiles.push({ weight: rim * (0.8 + Math.min(edge, 2) * 0.45), x, y });
		}
	}
	return tiles;
}

/** Whether (x, z) is still lawn: off the beach rows, the stones and the sea. */
function onLawn(
	layout: WorldLayout,
	village: VillageLayout,
	shape: IslandShape,
	tile: { x: number; y: number },
	at: { cx: number; cz: number; x: number; z: number }
): boolean {
	const onStone =
		tile.y === village.plaza.bottom &&
		steppingStone(tile.x) &&
		Math.max(Math.abs(at.x - at.cx), Math.abs(at.z - at.cz)) < 0.46;
	// The beach starts half a tile past the last row's center.
	const beach = at.z > tileToWorld(layout, { x: 0, y: layout.height })[2] - 0.6;
	return !(onStone || beach || !onIsland(shape, at.x, at.z, 0.12));
}

function buildBlades(
	layout: WorldLayout,
	village: VillageLayout,
	theme: Scene3dTheme,
	perTile: number,
	max: number
): Blade[] {
	const boxes = houseBoxes(layout, village.houses);
	const toward = sunDirection(theme);
	const shape = islandShape(layout, true);
	return growBlades({
		keep: (tile, x, z) =>
			onLawn(layout, village, shape, tile, { cx: tile.cx, cz: tile.cz, x, z }),
		max,
		perTile,
		shadeOf: ({ cx, cz }) => {
			const near = boxes.filter(
				(box) =>
					cx > box.minX - 4 &&
					cx < box.maxX + 4 &&
					cz > box.minZ - 4 &&
					cz < box.maxZ + 4
			);
			return (x, z) => inShadow(x, z, near, toward);
		},
		theme,
		tiles: lawnTiles(layout, village).map((tile) => {
			const [cx, , cz] = tileToWorld(layout, tile);
			return { ...tile, cx, cz };
		}),
	});
}

/** The swaying lawn. `reducedMotion` stills the wind. */
export function Grass({
	layout,
	max,
	perTile,
	reducedMotion,
	theme,
	village,
}: {
	layout: WorldLayout;
	max: number;
	perTile: number;
	reducedMotion: boolean;
	theme: Scene3dTheme;
	village: VillageLayout;
}) {
	const blades = useMemo(
		() => buildBlades(layout, village, theme, perTile, max),
		[layout, max, perTile, theme, village]
	);
	return (
		<GrassBlades blades={blades} reducedMotion={reducedMotion} theme={theme} />
	);
}

/** Wildflowers on the village's flower tiles. */
export function Flowers({
	layout,
	village,
}: {
	layout: WorldLayout;
	village: VillageLayout;
}) {
	const patches = useMemo(
		() =>
			village.flowers.map((tile) => ({
				at: tileToWorld(layout, tile),
				x: tile.x,
				y: tile.y,
			})),
		[layout, village]
	);
	return <FlowerClusters patches={patches} />;
}
