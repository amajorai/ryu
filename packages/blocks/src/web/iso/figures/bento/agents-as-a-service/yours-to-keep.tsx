import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceLine, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Yours to keep: the agent packed in a standard carry case, latched shut and
 * ready to leave with you. Its key (lit) lies on the bench in front: nothing
 * about it is locked to us, so you can take it in-house.
 */

const PLATE = { x: -92, y: -48, w: 184, d: 104, r: 8 };
const CASE = { x: -66, y: -34, w: 120, d: 58, r: 6 };
const CASE_H = 32;
const SEAM = 22;
const FRONT = CASE.y + CASE.d;
const GRIP_Z = CASE_H + 8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(CASE, 0, CASE_H + 1),
	[CASE.x + CASE.w / 2, 0, GRIP_Z + 6],
]);

benchPlate(s, PLATE);
// Feet under the case.
for (const [x, y] of byDepth(
	[
		[CASE.x + 12, CASE.y + 10],
		[CASE.x + CASE.w - 12, CASE.y + 10],
		[CASE.x + 12, FRONT - 10],
		[CASE.x + CASE.w - 12, FRONT - 10],
	] as [number, number][],
	s
)) {
	s.solid(cylinder(x, y, 4, 0, 2.5, s.P, 20), { tone: "lo" });
}
s.halo(CASE, 2.5);
s.solid(slabOf(CASE, 2.5, CASE_H - 2.5, s.P, 8, 1.2));
s.line(planOutline(insetPlan(CASE, 6), CASE_H, s.P, 4), { tone: "faint" });
// The lid seam running round the visible faces.
s.line(
	faceLine(s, "y", FRONT, CASE.x + CASE.r, CASE.x + CASE.w - CASE.r, SEAM),
	{
		tone: "mid",
	}
);
s.line(
	faceLine(s, "x", CASE.x + CASE.w, CASE.y + CASE.r, FRONT - CASE.r, SEAM),
	{ tone: "mid" }
);
// Handle: two brackets and the grip on top.
const mid = CASE.x + CASE.w / 2;
for (const x of [mid - 20, mid + 20]) {
	s.solid(slabOf({ x: x - 3, y: -6, w: 6, d: 8, r: 1.5 }, CASE_H, 8, s.P, 3), {
		tone: "lo",
	});
}
s.solid(
	slabOf({ x: mid - 24, y: -5, w: 48, d: 6, r: 3 }, GRIP_Z, 5, s.P, 5, 0.6)
);
screws(
	s,
	[
		[CASE.x + 12, CASE.y + 10],
		[CASE.x + CASE.w - 12, FRONT - 10],
	],
	CASE_H,
	1.5
);
// Two latches on the front face, clasped over the seam.
for (const x of [CASE.x + 22, CASE.x + CASE.w - 22]) {
	s.solid(
		slabOf({ x: x - 7, y: FRONT, w: 14, d: 2.4, r: 0.6 }, SEAM - 8, 14, s.P, 2),
		{ tone: "lo" }
	);
	s.solid(
		slabOf(
			{ x: x - 4, y: FRONT + 2.4, w: 8, d: 1.4, r: 0.4 },
			SEAM - 6,
			10,
			s.P,
			2
		)
	);
}
// The key, lying on the bench in front.
const BOW: [number, number] = [50, 40];
s.halo({ x: 2, y: 30, w: 60, d: 20, r: 8 }, 0);
s.solid(
	slabOf({ x: 4, y: BOW[1] - 2.5, w: BOW[0] - 8, d: 5, r: 1 }, 0, 2.4, s.P, 2),
	{ lit: true }
);
s.solid(slabOf({ x: 6, y: BOW[1] - 7, w: 5, d: 5, r: 0.4 }, 0, 2.4, s.P, 2), {
	lit: true,
});
s.solid(slabOf({ x: 15, y: BOW[1] - 6, w: 5, d: 4, r: 0.4 }, 0, 2.4, s.P, 2), {
	lit: true,
});
s.solid(cylinder(BOW[0], BOW[1], 10, 0, 3, s.P, 32, 0.4), { lit: true });
s.line(ring(BOW[0], BOW[1], 4, 3, s.P, 20), { tone: "lo" });
s.line(lineOnTop([6, BOW[1]], [BOW[0] - 11, BOW[1]], 2.4, s.P), {
	tone: "faint",
});

export const drawing = cardDrawing(s);
