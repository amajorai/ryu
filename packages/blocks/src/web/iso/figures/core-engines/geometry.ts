import {
	type Plan,
	planOutline,
	ring,
	type SolidPaths,
	slabOf,
} from "../../kit/iso-kit.ts";
import {
	at,
	CART_D,
	CART_H,
	CART_T,
	CART_Y,
	DECK,
	DECK_H,
	DECK_SEAT,
	DECK_X,
	P,
	PULSE_R,
	RACK_SEAT,
	ROW_Y,
	SHELF,
	SHELF_H,
	SHELF_SLOTS,
	slotX,
} from "./view.ts";

const solid = (plan: Plan, z: number, h: number, steps = 4) =>
	slabOf(plan, z, h, P, steps);

/** One engine cartridge: a plain plate standing on its edge. */
const cartridge = (cx: number, z: number): SolidPaths =>
	solid(
		{ x: cx - CART_T / 2, y: CART_Y, w: CART_T, d: CART_D, r: 0.8 },
		z,
		CART_H,
		3
	);

const SLOTS = Array.from({ length: SHELF_SLOTS }, (_, slot) => slot);

/** The drawn cartridges as they stand on the shelf, in slot order. */
export const SHELF_CARTS = SLOTS.map((slot) =>
	cartridge(slotX(slot), RACK_SEAT)
);

/** One cartridge built seated in the player, for the copy that moves or is loaded. */
export const DECK_CART = cartridge(DECK_X, DECK_SEAT);

export const SHELF_ART = {
	body: solid(SHELF, 0, SHELF_H, 5),
	/* Every slot's outline; only an empty slot shows it. */
	slots: SLOTS.map((slot) =>
		planOutline(
			{
				x: slotX(slot) - CART_T / 2 - 0.6,
				y: CART_Y - 0.6,
				w: CART_T + 1.2,
				d: CART_D + 1.2,
				r: 1,
			},
			SHELF_H,
			P,
			3
		)
	).join(""),
};

export const DECK_ART = {
	body: solid(DECK, 0, DECK_H, 6),
	pulse: ring(DECK_X, ROW_Y, PULSE_R, DECK_H, P, 64),
	pulseCentre: at([DECK_X, ROW_Y, DECK_H]),
};
