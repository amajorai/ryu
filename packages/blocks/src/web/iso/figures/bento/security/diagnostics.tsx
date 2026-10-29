import {
	boxCorners,
	insetPlan,
	lineOnTop,
	pathOf,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import {
	benchPlate,
	faceRect,
	knob,
	lamp,
	screws,
} from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Diagnostics: a bench instrument with its trace running on the front screen
 * (the lit panel) and two lamps for analytics and crash reports. The export
 * slot on top stays empty: the export cartridge waits beside it on the bench.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const BOX = { x: -70, y: -36, w: 92, d: 56, r: 5 };
const BOX_H = 44;
const FRONT = BOX.y + BOX.d;
const SCREEN = { x0: BOX.x + 10, x1: BOX.x + 62, z0: 10, z1: 36 };
const CART = { x: 44, y: -4, w: 20, d: 32, r: 2 };
const CART_H = 4.5;
const SLOT = { x: BOX.x + 64, y: BOX.y + 14, w: 20, d: CART_H, r: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(BOX, BOX_H, BOX_H + 6),
]);

benchPlate(s, PLATE);
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, BOX_H, s.P, 6, 1));
s.line(planOutline(insetPlan(BOX, 5), BOX_H, s.P, 4), { tone: "faint" });
// The export slot on top, empty.
s.solid(
	slabOf(insetPlan({ ...SLOT, y: SLOT.y - 4, d: 12 }, -2), BOX_H, 1, s.P, 2),
	{
		tone: "lo",
	}
);
s.line(planOutline(SLOT, BOX_H + 1, s.P, 2), { tone: "mid" });
knob(s, [BOX.x + 16, BOX.y + 16], BOX_H, 6, 4);
knob(s, [BOX.x + 36, BOX.y + 16], BOX_H, 6, 4);
lamp(s, [BOX.x + 54, BOX.y + 12], BOX_H, { radius: 1.8 });
lamp(s, [BOX.x + 54, BOX.y + 22], BOX_H, { radius: 1.8 });
screws(
	s,
	[
		[BOX.x + 8, BOX.y + BOX.d - 8],
		[BOX.x + BOX.w - 8, BOX.y + BOX.d - 8],
	],
	BOX_H,
	1.4
);
// The screen: a lit panel proud of the front face, with the trace on it.
s.solid(
	slabOf(
		{ x: SCREEN.x0, y: FRONT, w: SCREEN.x1 - SCREEN.x0, d: 1.4, r: 0.5 },
		SCREEN.z0,
		SCREEN.z1 - SCREEN.z0,
		s.P,
		2
	),
	{ lit: true }
);
const face = FRONT + 1.4;
s.line(
	faceRect(
		s,
		"y",
		face,
		SCREEN.x0 + 3,
		SCREEN.x1 - 3,
		SCREEN.z0 + 3,
		SCREEN.z1 - 3
	),
	{ tone: "faint" }
);
const trace = [0, 0, 3, -5, 8, 2, 0, 0, 4, -6, 9, 1, 0, 0];
s.line(
	pathOf(
		trace.map((dz, i) =>
			s.at([
				SCREEN.x0 + 5 + (i * (SCREEN.x1 - SCREEN.x0 - 10)) / (trace.length - 1),
				face,
				(SCREEN.z0 + SCREEN.z1) / 2 - 4 + dz,
			])
		)
	),
	{ tone: "hi" }
);
s.line(faceRect(s, "y", FRONT, SCREEN.x1 + 8, SCREEN.x1 + 22, 8, 12), {
	tone: "lo",
});
// The export cartridge, out of its slot: as wide and thick as the slot.
s.halo(CART, 0);
s.solid(slabOf(CART, 0, CART_H, s.P, 3, 0.6));
s.line(planOutline(insetPlan(CART, 4), CART_H, s.P, 2), { tone: "faint" });
for (let x = CART.x + 4; x <= CART.x + CART.w - 4; x += 3) {
	s.line(lineOnTop([x, CART.y + 2], [x, CART.y + 6], CART_H, s.P), {
		tone: "mid",
	});
}

export const drawing = cardDrawing(s);
