import type { Vec3 } from "./game3d-palette.ts";
import { QUIZ_COLUMNS, QUIZ_PODIUMS, QUIZ_ROWS } from "./quiz-model.ts";

/**
 * The Quiz Show as a TV studio diorama on the 3D game kit
 * (game3d-stage.tsx): the board is a big wall of glowing tiles along the
 * back edge of the set, its face turned to the isometric camera, under a
 * curved backdrop lined with marquee bulbs; the contestants stand at
 * podiums on the stage in front of it with the host at a lectern beside
 * them, and the audience sits in theatre rows along the front edge.
 * Positions are world units (x right, z toward the viewer, y up; the
 * camera looks from +x, +z, so screen right runs along (1, 0, -1)). Pure
 * so it is testable.
 */

/** Screen right and toward the camera, on the ground. */
export const ACROSS: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
export const TOWARD: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];

/** The board wall: where it stands, its cells' spacing and heights. */
export const WALL = {
	/** The wall's foot, back from the middle of the set. */
	centre: [-2.9, -2.9] as [number, number],
	/** Spacing of the columns, and of the rows (tile height plus seam). */
	column: 1.72,
	row: 0.92,
	/** A cell's face. */
	cellWidth: 1.6,
	cellHeight: 0.8,
	/** Height of the lowest row's centre; the category row sits on top. */
	floor: 0.95,
} as const;

/** A point `along` the wall and `out` toward the camera from it. */
export function wallPoint(along: number, out: number, y: number): Vec3 {
	return [
		WALL.centre[0] + ACROSS[0] * along + TOWARD[0] * out,
		y,
		WALL.centre[1] + ACROSS[1] * along + TOWARD[1] * out,
	];
}

/** The centre of the cell at `column`, `row` (row 0 is the top, 100s). */
export function cellCentre(column: number, row: number): Vec3 {
	return wallPoint(
		(column - (QUIZ_COLUMNS - 1) / 2) * WALL.column,
		0.12,
		WALL.floor + (QUIZ_ROWS - 1 - row) * WALL.row
	);
}

/** The centre of a column's lit header panel, over its top row. */
export function categoryCentre(column: number): Vec3 {
	return wallPoint(
		(column - (QUIZ_COLUMNS - 1) / 2) * WALL.column,
		0.12,
		WALL.floor + QUIZ_ROWS * WALL.row + 0.1
	);
}

/** How far the podiums stand out from the wall, and their spacing. */
const PODIUM_OUT = 4.4;
const PODIUM_STEP = 2.3;

/** Where each contestant's podium stands, left to right on screen. */
export function podiumSpots(): [number, number][] {
	return Array.from({ length: QUIZ_PODIUMS }, (_, index) => {
		const [x, , z] = wallPoint(
			(index - (QUIZ_PODIUMS - 1) / 2) * PODIUM_STEP + 0.9,
			PODIUM_OUT,
			0
		);
		return [x, z];
	});
}

/** The host's lectern, left of the podiums. */
export function hostSpot(): [number, number] {
	const [x, , z] = wallPoint(-4.7, PODIUM_OUT - 0.2, 0);
	return [x, z];
}

/** The audience's theatre rows along the front edge, facing the stage. */
export const AUDIENCE = {
	out: 7.6,
	rows: 2,
	seats: 7,
	span: 8.4,
	step: 1,
} as const;

/** Every audience seat, front row first. */
export function audienceSeats(): { at: [number, number]; row: number }[] {
	const seats: { at: [number, number]; row: number }[] = [];
	for (let row = 0; row < AUDIENCE.rows; row++) {
		const count = AUDIENCE.seats - row;
		for (let index = 0; index < count; index++) {
			const along =
				(index / Math.max(1, count - 1) - 0.5) * (AUDIENCE.span - row * 1.2) +
				0.9;
			const [x, , z] = wallPoint(along, AUDIENCE.out + row * AUDIENCE.step, 0);
			seats.push({ at: [x, z], row });
		}
	}
	return seats;
}

/** The camera's box round the set. */
export const STUDIO_BOUNDS = {
	maxX: 6.6,
	maxZ: 6.6,
	minX: -7.4,
	minZ: -7.4,
} as const;

/** The studio floor's radius round the middle of the set. */
export const FLOOR_RADIUS = 7.2;

/** Height the studio lamps hang at (the backdrop's top), and the tallest content. */
export const TRUSS_HEIGHT = 6.45;
export const STUDIO_TOP = 6.6;
