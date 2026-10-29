import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	ring,
	rise,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Audited reads: a reel-to-reel recorder. A paper ribbon runs from the supply
 * reel past the stamping head (its lamp lit) onto the take-up reel; every
 * read leaves one stamped mark on the ribbon, in order.
 */

const PLATE = { x: -92, y: -48, w: 184, d: 88, r: 8 };
const BASE = { x: -84, y: -36, w: 168, d: 60, r: 4 };
const BASE_H = 4;
const RIBBON_Y = -2;
const R1 = 16;
const HEAD = { x: -10, y: -32, w: 28, d: 22, r: 3 };
const HEAD_H = 30;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[4, -21, HEAD_H + 6],
]);

function reel(cx: number, radius: number) {
	const cy = RIBBON_Y - radius;
	s.solid(cylinder(cx, cy, radius + 3, BASE_H, 1.6, s.P, 40), { tone: "lo" });
	s.solid(cylinder(cx, cy, radius, BASE_H + 1.6, R1 - 3, s.P, 40));
	s.solid(cylinder(cx, cy, radius + 3, BASE_H + R1 - 1.4, 1.6, s.P, 40, 0.4));
	s.line(ring(cx, cy, 4, BASE_H + R1 + 0.2, s.P, 20), { tone: "mid" });
	s.solid(cylinder(cx, cy, 2, BASE_H + R1 + 0.2, 3, s.P, 16), { tone: "lo" });
}

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 4, 0.6), { tone: "lo" });
screws(
	s,
	[
		[BASE.x + 6, BASE.y + 6],
		[BASE.x + BASE.w - 6, BASE.y + BASE.d - 6],
	],
	BASE_H,
	1.4
);
// Stamping head behind the ribbon.
s.halo(HEAD, BASE_H);
s.solid(slabOf(HEAD, BASE_H, HEAD_H - BASE_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(HEAD, 4), HEAD_H, s.P, 3), { tone: "faint" });
lamp(s, [HEAD.x + HEAD.w / 2, HEAD.y + HEAD.d / 2], HEAD_H, {
	lit: true,
	radius: 3.4,
});
s.solid(
	slabOf({ x: -2, y: HEAD.y + HEAD.d, w: 12, d: 7, r: 1 }, 10, 10, s.P, 2),
	{ tone: "lo" }
);
reel(-58, 15);
reel(58, 11);
// The ribbon, with one mark per audited read past the head.
const ribbon = { x: -58, y: RIBBON_Y, w: 116, d: 1.2, r: 0 };
s.solid(slabOf(ribbon, BASE_H + 3, R1 - 6, s.P, 1), { crease: "none" });
const front = RIBBON_Y + 1.2;
const marks = [16, 22, 28, 34, 40];
s.line(
	marks.map((x) => rise([x, front], BASE_H + 6, BASE_H + R1 - 6, s.P)).join(""),
	{ tone: "mid" }
);
// Platen pad in front of the ribbon, opposite the head.
s.solid(slabOf({ x: -4, y: front, w: 16, d: 6, r: 1 }, BASE_H, 14, s.P, 2));

export const drawing = cardDrawing(s);
