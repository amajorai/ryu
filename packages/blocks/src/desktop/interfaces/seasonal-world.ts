import type { Vec3 } from "./game3d-palette.ts";
import { DOOR_COUNT, type Season } from "./seasonal-model.ts";

/**
 * The seasonal boards as dioramas on the 3D game kit (game3d-stage.tsx),
 * one per season, each with 24 numbered places for conversations:
 *
 * - Halloween: a night pumpkin patch, 24 pumpkins in four rows of six.
 * - Advent: a snowy village square round a big advent house whose 24
 *   numbered doors and windows face the camera on its two front walls.
 * - Lunar New Year: a lantern festival street, 24 lanterns hung on four
 *   wires strung along it.
 *
 * Positions are world units (x right, z toward the viewer, y up; the
 * camera looks from +x, +z, so screen right runs along (1, 0, -1)). Low
 * numbers sit where they read first. Pure so it is testable.
 */

export interface WorldDoor {
	/** Where the place's own object stands or hangs (its centre). */
	at: Vec3;
	number: number;
	/** Where its number plate floats. */
	plate: Vec3;
	/** Which way the object faces, for the advent house's two walls. */
	yaw: number;
}

export interface SeasonWorld {
	bounds: { maxX: number; maxZ: number; minX: number; minZ: number };
	doors: WorldDoor[];
	/** Tallest content, for the camera's fit. */
	top: number;
}

/** A small stable offset in [-0.5, 0.5) so rows look planted by hand. */
function wobble(index: number, salt: number): number {
	const value = Math.sin(index * 12.9898 + salt * 78.233) * 43_758.5453;
	return value - Math.floor(value) - 0.5;
}

/** The patch: rows of six from the front, 1 at the front left. */
export const PATCH = {
	columns: 6,
	rows: 4,
	step: 2.2,
} as const;

/**
 * Which cell each pumpkin (by number, from 1) stands in: row by row from
 * the front left, or, `sparse`, on a checkerboard: the twelve pumpkins
 * that fill first (today's, then the lowest numbers) take every other
 * cell, so no two busy pumpkins stand side by side and the act layer's
 * names, bubbles and boards fit between their numbers; the rest take the
 * cells between.
 */
function patchCells(sparse: boolean, today: number | null): number[] {
	const cells = Array.from({ length: DOOR_COUNT }, (_, index) => index);
	if (!sparse) {
		return cells;
	}
	const parity = (index: number) =>
		(Math.floor(index / PATCH.columns) + (index % PATCH.columns)) % 2;
	const half = DOOR_COUNT / 2;
	const first = new Set(
		[...(today ? [today] : []), ...cells.map((index) => index + 1)]
			.filter((number, index, all) => all.indexOf(number) === index)
			.slice(0, half)
	);
	const numbers = cells.map((index) => index + 1);
	const busy = numbers.filter((number) => first.has(number));
	const rest = numbers.filter((number) => !first.has(number));
	const evenCells = cells.filter((index) => parity(index) === 0);
	const oddCells = cells.filter((index) => parity(index) === 1);
	const cellOf: number[] = [];
	for (const [order, number] of busy.entries()) {
		cellOf[number - 1] = evenCells[order] ?? order;
	}
	for (const [order, number] of rest.entries()) {
		cellOf[number - 1] = oddCells[order] ?? order;
	}
	return cellOf;
}

function pumpkinPatch(sparse: boolean, today: number | null): SeasonWorld {
	const doors: WorldDoor[] = [];
	for (const [order, index] of patchCells(sparse, today).entries()) {
		const row = Math.floor(index / PATCH.columns);
		const column = index % PATCH.columns;
		const x =
			(column - (PATCH.columns - 1) / 2) * PATCH.step + wobble(index, 1) * 0.5;
		const z =
			((PATCH.rows - 1) / 2 - row) * PATCH.step + wobble(index, 2) * 0.4;
		doors.push({
			at: [x, 0, z],
			number: order + 1,
			plate: [x, 1.25, z],
			yaw: 0,
		});
	}
	doors.sort((a, b) => a.number - b.number);
	return {
		bounds: { maxX: 8.4, maxZ: 6.4, minX: -8.4, minZ: -6.4 },
		doors,
		top: 2.6,
	};
}

/** The advent house: its footprint, storeys and where it stands. */
export const ADVENT_HOUSE = {
	centre: [-0.8, -0.8] as [number, number],
	/** Floor heights: the ground row are doors, the two above windows. */
	rows: [0.78, 2.12, 3.28] as const,
	rowHeight: [1.24, 0.82, 0.82] as const,
	/** Height of the walls, under the roof. */
	height: 3.95,
	/** Spacing of the doors and windows along a wall. */
	step: 1.42,
	/** Half the footprint, on both axes. */
	half: 3.2,
} as const;

function adventSquare(): SeasonWorld {
	const doors: WorldDoor[] = [];
	const [cx, cz] = ADVENT_HOUSE.centre;
	const { half, step } = ADVENT_HOUSE;
	// Read like a calendar: row by row from the top, each row left to right
	// along the front wall (+z) and on round the corner along the right
	// wall (+x).
	const rowCount = ADVENT_HOUSE.rows.length;
	for (const [row, y] of ADVENT_HOUSE.rows.entries()) {
		for (let column = 0; column < 8; column++) {
			const number = (rowCount - 1 - row) * 8 + column + 1;
			// The status badge sits on the door's top edge; its number is painted on.
			const badge = y + (ADVENT_HOUSE.rowHeight[row] ?? 0.82) / 2;
			const along = ((column % 4) - 1.5) * step;
			if (column < 4) {
				const at: Vec3 = [cx + along, y, cz + half];
				doors.push({
					at,
					number,
					plate: [at[0], badge, at[2] + 0.14],
					yaw: 0,
				});
			} else {
				const at: Vec3 = [cx + half, y, cz - along];
				doors.push({
					at,
					number,
					plate: [at[0] + 0.14, badge, at[2]],
					yaw: Math.PI / 2,
				});
			}
		}
	}
	return {
		bounds: { maxX: 6.2, maxZ: 6.2, minX: -6.2, minZ: -6.2 },
		doors,
		top: 4.6,
	};
}

/** The festival street: four wires of six lanterns along it. */
export const STREET = {
	/** Where the wires run across the street (toward the camera) and how high. */
	heights: [3.3, 3.75, 4.2, 4.65] as const,
	length: 15,
	offsets: [2.6, 0.9, -0.8, -2.5] as const,
	/** The lantern's drop below its wire. */
	drop: 0.55,
	step: 2.3,
	width: 7.4,
} as const;

/**
 * A point on the street, which runs along x with its shopfronts facing +z
 * (the lit side): `t` along it, `n` across it toward the front.
 */
export function streetPoint(t: number, n: number): [number, number] {
	return [t, n];
}

function lanternStreet(): SeasonWorld {
	const doors: WorldDoor[] = [];
	// The front wire first, so the first lanterns hang nearest.
	for (const [wire, n] of STREET.offsets.entries()) {
		const y = (STREET.heights[wire] ?? 3) - STREET.drop;
		for (let index = 0; index < 6; index++) {
			// Each wire is staggered half a step, so plates never stack.
			const t = (index - 2.5) * STREET.step + (wire % 2 === 0 ? -0.4 : 0.4);
			const [x, z] = streetPoint(t, n);
			doors.push({
				at: [x, y, z],
				number: wire * 6 + index + 1,
				plate: [x, y - 0.95, z],
				yaw: 0,
			});
		}
	}
	return {
		bounds: { maxX: 8, maxZ: 6.2, minX: -8, minZ: -6.2 },
		doors,
		top: 4.8,
	};
}

/** Lays out the season's diorama. */
export function layoutSeasonWorld(
	season: Season,
	/**
	 * The act layer is on: the patch numbers its pumpkins on a
	 * checkerboard (see `patchCells`); the other boards are unchanged.
	 */
	sparse = false,
	/** Today's door, which fills first. */
	today: number | null = null
): SeasonWorld {
	if (season === "halloween") {
		return pumpkinPatch(sparse, today);
	}
	if (season === "lunar-new-year") {
		return lanternStreet();
	}
	return adventSquare();
}

/**
 * Where an agent's villager stands by its first item: beside a pumpkin in
 * the patch, in front of its door on the square, under its lantern on the
 * street. `crowd` nudges agents that share a place apart.
 */
export function villagerSpot(
	season: Season,
	place: WorldDoor,
	crowd: number
): [number, number] {
	const [x, , z] = place.at;
	const nudge = crowd * 0.85;
	if (season === "halloween") {
		// Along the front of the field, in line with its pumpkin's column,
		// so the names stay clear of the pumpkins' numbers.
		const front = ((PATCH.rows - 1) / 2) * PATCH.step + 1.9;
		return [x + 0.2, front + crowd * 0.9];
	}
	if (season === "lunar-new-year") {
		return [x + 0.45 + nudge, z + 0.55];
	}
	// The square: out in front of the wall the door is on.
	return place.yaw === 0 ? [x + nudge, z + 1.35] : [x + 1.35, z - nudge];
}
