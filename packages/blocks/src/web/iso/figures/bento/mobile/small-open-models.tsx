import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Small open models: a phone lying on the bench with a small model cartridge
 * pushed into the port at its end (the lit part). Spare cartridges stand in a
 * rack beside it; nothing is cabled in, so it runs on its own, offline.
 */

const PLATE = { x: -90, y: -42, w: 180, d: 84, r: 8 };
const PHONE = { x: -78, y: -26, w: 92, d: 46, r: 7 };
const PHONE_H = 6;
const RACK = { x: 44, y: -30, w: 36, d: 52, r: 3 };
const RACK_H = 8;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [60, -20, 26]]);

benchPlate(s, PLATE);
// The phone, screen up: glass, earpiece, a reply on the screen.
s.halo(PHONE, 0);
s.solid(slabOf(PHONE, 0, PHONE_H, s.P, 8, 0.8), { tone: "hi", crease: "lo" });
const glass = insetPlan(PHONE, 3.5);
s.line(planOutline(glass, PHONE_H, s.P, 6), { tone: "mid" });
s.line(
	lineOnTop(
		[PHONE.x + 7, PHONE.y + 17],
		[PHONE.x + 7, PHONE.y + 29],
		PHONE_H,
		s.P
	),
	{ tone: "mid" }
);
const bubbles = [
	{ x: glass.x + 10, y: glass.y + 4, w: 30, d: 12 },
	{ x: glass.x + 44, y: glass.y + glass.d - 18, w: 32, d: 14 },
];
for (const bubble of bubbles) {
	s.line(planOutline({ ...bubble, r: 3 }, PHONE_H, s.P, 4), { tone: "lo" });
}
lamp(s, [PHONE.x + 8, PHONE.y + PHONE.d - 8], PHONE_H - 1.6, { radius: 1.4 });
// The port on the near end, with the model cartridge seated in it.
const end = PHONE.x + PHONE.w;
s.line(faceRect(s, "x", end, PHONE.y + 12, PHONE.y + 34, 1, 5), {
	tone: "lo",
});
const cartridge = { x: end, y: PHONE.y + 11, w: 24, d: 24, r: 2 };
s.solid(slabOf(cartridge, 0.5, 6, s.P, 3, 0.4), { lit: true });
s.line(
	lineOnTop(
		[cartridge.x + 6, cartridge.y + 5],
		[cartridge.x + 6, cartridge.y + 19],
		6.5,
		s.P
	),
	{ tone: "mid" }
);
// The rack of spare cartridges standing in their slots.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 4, 0.8));
screws(
	s,
	[
		[RACK.x + 6, RACK.y + 6],
		[RACK.x + RACK.w - 6, RACK.y + RACK.d - 6],
	],
	RACK_H,
	1.3
);
for (const y of [RACK.y + 12, RACK.y + 26, RACK.y + 40]) {
	const slot = { x: RACK.x + 8, y: y - 2.5, w: 22, d: 5, r: 1 };
	s.line(planOutline(slot, RACK_H, s.P, 2), { tone: "lo" });
	if (y < RACK.y + 40) {
		s.solid(
			slabOf(
				{ x: slot.x + 1, y: slot.y + 0.5, w: 20, d: 4, r: 1 },
				RACK_H,
				16,
				s.P,
				3,
				0.4
			)
		);
	}
}

export const drawing = cardDrawing(s);
