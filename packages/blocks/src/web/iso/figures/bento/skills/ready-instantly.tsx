import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceLine,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Ready instantly: a cartridge console. Push a skill cartridge into the slot
 * and the ready lamp beside it (lit) comes on at once; the power switch next
 * to it was never touched, because nothing has to restart.
 */

const PLATE = { x: -86, y: -50, w: 172, d: 100, r: 8 };
const CONSOLE = { x: -62, y: -34, w: 124, d: 64, r: 6 };
const H = 18;
const SLOT = { x: -46, y: -22, w: 60, d: 10, r: 1.5 };
const CART = { x: -43, y: -20.5, w: 54, d: 7, r: 1 };
const CART_H = 24;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CART.x, CART.y, H + CART_H + 2],
]);

benchPlate(s, PLATE);
s.halo(CONSOLE, 0);
s.solid(slabOf(CONSOLE, 0, H, s.P, 8, 1.2));
s.line(planOutline(insetPlan(CONSOLE, 4), H, s.P, 6), { tone: "faint" });
// Slot throat and the cartridge seated in it.
s.solid(slabOf(SLOT, H, 1.2, s.P, 3), { tone: "lo" });
s.solid(slabOf(CART, H + 1.2, CART_H, s.P, 3, 0.4));
const cartFront = CART.y + CART.d;
const cartTop = H + 1.2 + CART_H;
// Grip ridges across the top of the cartridge, and its label recess.
for (let index = 0; index < 4; index += 1) {
	s.line(
		faceLine(
			s,
			"y",
			cartFront,
			CART.x + 4,
			CART.x + CART.w - 4,
			cartTop - 3 - index * 2.6
		),
		{ tone: "lo" }
	);
}
s.line(
	faceRect(s, "y", cartFront, CART.x + 12, CART.x + CART.w - 12, H + 5, H + 16),
	{ tone: "mid" }
);
// Ready lamp right by the slot: the one accent.
lamp(s, [32, -17], H, { lit: true, radius: 4.2 });
// Power switch, still in its original position.
s.solid(cylinder(36, 10, 6, H, 1.6, s.P, 28), { tone: "lo" });
s.solid(slabOf({ x: 33, y: 4, w: 6, d: 12, r: 1.5 }, H + 1.6, 3, s.P, 3));
s.solid(slabOf({ x: 34, y: 5, w: 4, d: 4, r: 1 }, H + 4.6, 5, s.P, 3), {
	tone: "lo",
});
knob(s, [-32, 14], H, 5, 5);
knob(s, [-12, 14], H, 4, 4);
// Vent slots along the near edge.
for (const y of [16, 20, 24]) {
	s.line(lineOnTop([2, y], [20, y], H, s.P), { tone: "lo" });
}
screws(
	s,
	[
		[CONSOLE.x + 6, CONSOLE.y + 6],
		[CONSOLE.x + CONSOLE.w - 6, CONSOLE.y + CONSOLE.d - 6],
	],
	H,
	1.5
);

export const drawing = cardDrawing(s);
