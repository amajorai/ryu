import {
	axisVector,
	boxCorners,
	type Flat,
	fitProjection,
	iso,
	type Plan,
	type Point3,
} from "../../kit/iso-kit.ts";

/*
 * World layout. x runs along the shelf, y from back to front, z up. The camera looks
 * from the front right. Only two plinths and the cartridges are drawn: the shelf, and
 * the player that holds the one loaded engine.
 *
 * The shelf is representative: it draws SHELF_SLOTS cartridges, not one per engine, so
 * the row reads as one light mass. Engine `i` is drawn in slot `i % SHELF_SLOTS`; the
 * real engine count lives in the model and the accessible text only.
 */

export const WIDTH = 640;
export const HEIGHT = 300;
const PAD = 44;
export const AZIMUTH = 56;

/** How many cartridges the shelf draws: illustrative, not the engine count. */
export const SHELF_SLOTS = 6;

/* Cartridges: thin upright plates. */
export const PITCH = 13;
export const CART_T = 5;
export const CART_D = 24;
export const CART_H = 24;
export const ROW_Y = 0;
export const CART_Y = ROW_Y - CART_D / 2;

/* The shelf: a low plinth with one slot per drawn cartridge. */
export const FIRST_SLOT = -36;
export const SHELF_H = 4;
export const RACK_SEAT = SHELF_H;
export const SHELF: Plan = {
	x: FIRST_SLOT - PITCH / 2 - 3,
	y: ROW_Y - 18,
	w: PITCH * SHELF_SLOTS + 6,
	d: 36,
	r: 2,
};
export const slotX = (slot: number) => FIRST_SLOT + PITCH * slot;

/** The drawn slot that stands for engine `engine`. */
export const slotOf = (engine: number) => engine % SHELF_SLOTS;

/** Where engine `engine`'s cartridge sits on the shelf. */
export const engineX = (engine: number) => slotX(slotOf(engine));

/* The player: a second plinth that holds the one loaded engine. */
export const DECK_X = 84;
export const DECK: Plan = { x: DECK_X - 20, y: ROW_Y - 20, w: 40, d: 40, r: 3 };
export const DECK_H = 8;
export const DECK_SEAT = DECK_H;

/** Above every cartridge on the shelf: the height a moving cartridge travels at. */
export const CLEAR = RACK_SEAT + CART_H + 1;
export const TRAVEL = CLEAR + 3;

/** The health ring's centre and resting radius, on the player's top. */
export const PULSE_R = 15;

export const P = fitProjection(
	[
		...boxCorners(SHELF, 0, RACK_SEAT + CART_H),
		...boxCorners(DECK, 0, DECK_SEAT + CART_H),
	],
	WIDTH,
	HEIGHT,
	{ pad: PAD, azimuth: AZIMUTH }
);

export const at = (point: Point3): Flat => iso(point, P);

const fine = (value: number) => Math.round(value * 100) / 100;

/** A screen translate for a world offset. */
export function shift(dx: number, dy: number, dz: number) {
	const [x, y] = axisVector(P, [dx, dy, dz]);
	return `translate(${fine(x)} ${fine(y)})`;
}
