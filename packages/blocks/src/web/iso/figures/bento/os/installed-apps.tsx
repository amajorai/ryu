import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Installed Apps: a launcher dock with a row of app cartridges standing in
 * its slots. The built-ins sit seated; the app you just installed (the lit
 * cartridge) is being pushed into the next free slot beside them.
 */

const PLATE = { x: -96, y: -42, w: 192, d: 84, r: 8 };
const DOCK = { x: -82, y: -20, w: 164, d: 40, r: 4 };
const DOCK_H = 10;
const PITCH = 22;
const FIRST = -62;
const SLOTS = 7;
const NEW_SLOT = 4;
const CART_W = 14;
const CART_D = 30;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 52]]);

const slotPlan = (index: number) => ({
	x: FIRST + index * PITCH - CART_W / 2 - 1,
	y: -CART_D / 2 - 1,
	w: CART_W + 2,
	d: CART_D + 2,
	r: 1,
});

function cartridge(index: number, height: number, lit = false) {
	const plan = insetPlan(slotPlan(index), 1);
	s.solid(slabOf(plan, DOCK_H, height, s.P, 3, 0.6), { lit });
	const top = DOCK_H + height;
	s.line(planOutline(insetPlan(plan, 3), top, s.P, 2), { tone: "faint" });
	if (!lit) {
		lamp(s, [plan.x + plan.w / 2, plan.y + plan.d - 6], top, { radius: 1.6 });
	}
}

benchPlate(s, PLATE);
s.halo(DOCK, 0);
s.solid(slabOf(DOCK, 0, DOCK_H, s.P, 6, 1));
screws(
	s,
	[
		[DOCK.x + 6, DOCK.y + 6],
		[DOCK.x + DOCK.w - 6, DOCK.y + DOCK.d - 6],
	],
	DOCK_H,
	1.4
);
for (let index = 0; index < SLOTS; index++) {
	s.line(planOutline(slotPlan(index), DOCK_H, s.P, 2), { tone: "lo" });
	if (index < NEW_SLOT) {
		cartridge(index, 26);
	} else if (index === NEW_SLOT) {
		cartridge(index, 36, true);
	}
}

export const drawing = cardDrawing(s);
