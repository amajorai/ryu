import { MAX_SEATS, SEAT_ANGLES } from "./card-table-model.ts";
import type { Vec3 } from "./game3d-palette.ts";

/**
 * The Card Table as a card room diorama on the 3D game kit
 * (game3d-stage.tsx): an oval felt table in the middle of a wood-floored
 * room, the agents seated round its far side in the same six chairs the
 * plain table uses (you sit at the near side, where your hand is), their
 * chips and cards on the felt in front of them, and the pot in the middle.
 * Positions are world units (x right, z toward the viewer, y up; the
 * camera looks from +x, +z, so screen right runs along (1, 0, -1)). Pure
 * so it is testable.
 */

/** Screen right, and away from the viewer, on the ground. */
const ACROSS: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
const AWAY: [number, number] = [-Math.SQRT1_2, -Math.SQRT1_2];

/** The table: the felt's half widths (across and deep) and its height. */
export const TABLE = { across: 3.3, deep: 2.1, height: 0.78 } as const;
/** How far beyond the felt's edge the chairs stand. */
const CHAIR_OUT = 0.78;
/** Where a seat's chips sit on the felt, as a share of the way out. */
const CHIP_SHARE = 0.66;

/** The room's floor and walls: half its size, and the walls' height. */
export const ROOM = { half: 5, wall: 2.3 } as const;

export interface RoomSeat {
	/** The chair (and its villager), on the floor. */
	at: [number, number];
	/** Where the seat's chips stack on the felt. */
	chips: [number, number];
	/** Which way the villager faces: toward the middle of the table. */
	facing: number;
	slot: number;
}

/** A point on the table's ellipse at `angle` degrees (0 is the far side). */
function onOval(angle: number, grow: number): [number, number] {
	const radians = (angle * Math.PI) / 180;
	const away = Math.cos(radians) * (TABLE.deep + grow);
	const across = Math.sin(radians) * (TABLE.across + grow);
	return [
		AWAY[0] * away + ACROSS[0] * across,
		AWAY[1] * away + ACROSS[1] * across,
	];
}

/** The six seats round the far side of the table, in the plain table's order. */
export function roomSeats(): RoomSeat[] {
	return Array.from({ length: MAX_SEATS }, (_, slot) => {
		const angle = SEAT_ANGLES[slot] ?? 0;
		const at = onOval(angle, CHAIR_OUT);
		const edge = onOval(angle, 0);
		return {
			at,
			chips: [edge[0] * CHIP_SHARE, edge[1] * CHIP_SHARE],
			facing: Math.atan2(-at[0], -at[1]),
			slot,
		};
	});
}

/** Where the pot's pile and its plate sit: the middle of the felt. */
export const POT: Vec3 = [0, TABLE.height, 0];

/** The camera's box round the room. */
export const ROOM_BOUNDS = {
	maxX: ROOM.half,
	maxZ: ROOM.half,
	minX: -ROOM.half,
	minZ: -ROOM.half,
} as const;

/** Tallest content: the lamp over the table. */
export const ROOM_TOP = 2.6;
