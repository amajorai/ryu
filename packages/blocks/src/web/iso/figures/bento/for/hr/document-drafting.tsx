import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Document drafting: a small arm press. Templates wait in a stack on the
 * left; the press stamps one onto a fresh sheet, and the drafted letter sits
 * in the out tray on the right (the lit sheet) for HR to finalize.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const STACK = { x: -86, y: -26, w: 38, d: 48, r: 2 };
const BED = { x: -38, y: -32, w: 56, d: 60, r: 4 };
const COLUMN = { x: -18, y: -30, w: 16, d: 14, r: 3 };
const HEAD = { x: -26, y: -6, w: 32, d: 26, r: 3 };
const ARM = { x: -20, y: -32, w: 20, d: 44, r: 4 };
const ARM_Z = 46;
const TRAY = { x: 36, y: -22, w: 50, d: 48, r: 3 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-10, 0, ARM_Z + 16],
]);

benchPlate(s, PLATE);
// Template stack: a pile of sheets with a weight on top.
s.halo(STACK, 0);
for (let i = 0; i < 5; i++) {
	s.solid(slabOf(STACK, i * 2.4, 2, s.P, 2), {
		crease: "none",
		tone: i % 2 ? "mid" : "hi",
	});
}
faceRules(s, "y", STACK.y + STACK.d, STACK.x + 4, 10, [28, 28, 28], 2.4);
s.solid(cylinder(STACK.x + 19, STACK.y + 24, 7, 12, 6, s.P, 28, 0.6), {
	tone: "lo",
});
// The press: bed, column at the back, head over the sheet, arm and screw.
s.halo(BED, 0);
s.solid(slabOf(BED, 0, 8, s.P, 6, 0.8));
screws(
	s,
	[
		[BED.x + 6, BED.y + BED.d - 6],
		[BED.x + BED.w - 6, BED.y + BED.d - 6],
	],
	8,
	1.4
);
s.solid(
	slabOf(
		{ x: HEAD.x - 2, y: HEAD.y - 2, w: HEAD.w + 4, d: HEAD.d + 4, r: 1 },
		8,
		1,
		s.P,
		2
	),
	{
		crease: "none",
	}
);
s.solid(slabOf(COLUMN, 8, ARM_Z - 8, s.P, 4, 0.8));
s.solid(slabOf(HEAD, 16, 8, s.P, 4, 0.6), { tone: "lo" });
s.solid(
	cylinder(HEAD.x + HEAD.w / 2, HEAD.y + HEAD.d / 2, 4, 24, ARM_Z - 24, s.P, 24)
);
s.solid(slabOf(ARM, ARM_Z, 8, s.P, 6, 0.8));
s.line(planOutline(insetPlan(ARM, 4), ARM_Z + 8, s.P, 4), { tone: "faint" });
const hub: [number, number] = [ARM.x + ARM.w / 2, HEAD.y + HEAD.d / 2];
s.solid(cylinder(hub[0], hub[1], 7, ARM_Z + 8, 6, s.P, 32));
s.line(knurl(hub[0], hub[1], 7, ARM_Z + 8, ARM_Z + 14, 30, s.P), {
	tone: "lo",
});
s.line(ring(hub[0], hub[1], 2.5, ARM_Z + 14, s.P, 20), { tone: "mid" });
lamp(s, [ARM.x + ARM.w / 2, ARM.y + 7], ARM_Z + 8, { radius: 1.8 });
// Out tray with the drafted letter.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 5, s.P, 4, 0.6), { tone: "lo" });
const letter = insetPlan(TRAY, 6);
s.solid(slabOf(letter, 5, 1.6, s.P, 2), { lit: true, crease: "none" });

export const drawing = cardDrawing(s);
