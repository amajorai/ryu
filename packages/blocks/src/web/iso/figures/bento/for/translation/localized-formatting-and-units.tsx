import { boxCorners, slabOf, topTicks } from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Localized formatting and units: a slide rule. The source value is read on
 * one scale and the locale's on the other; the centre slide is set to the
 * target locale, and the cursor's hairline (the lit part) carries the same
 * value straight across into the new units.
 */

const PLATE = { x: -106, y: -44, w: 212, d: 88, r: 8 };
const RISER_H = 6;
const BACKING = { x: -86, y: -28, w: 172, d: 34, r: 3 };
const STOCK_Z = RISER_H + 2;
const STOCK_H = 5;
const UPPER = { x: -86, y: -28, w: 172, d: 11, r: 1.5 };
const SLIDE = { x: -62, y: -16.5, w: 160, d: 10, r: 1 };
const LOWER = { x: -86, y: -5, w: 172, d: 11, r: 1.5 };
const CURSOR_X = 16;
const CURSOR = { x: CURSOR_X - 8, y: -33, w: 16, d: 44, r: 1.5 };
const TOP = STOCK_Z + STOCK_H;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CURSOR_X, -33, TOP + 4],
]);

function scale(plan: typeof UPPER, z: number, step: number, edge: number) {
	const ticks = topTicks(
		plan.x + 6,
		plan.x + plan.w - 6,
		step,
		5,
		edge,
		z,
		[2.4, 4.4],
		s.P
	);
	s.line(ticks.minor, { tone: "lo" });
	s.line(ticks.major, { tone: "mid" });
}

benchPlate(s, PLATE);
// Two risers carry the rule clear of the plate.
for (const x of [-66, 54]) {
	const riser = { x, y: -26, w: 14, d: 30, r: 2 };
	s.halo(riser, 0);
	s.solid(slabOf(riser, 0, RISER_H, s.P, 3, 0.6), { tone: "lo" });
}
// Cursor back clip, behind the rule.
s.solid(
	slabOf(
		{ x: CURSOR.x, y: CURSOR.y, w: CURSOR.w, d: 5, r: 1 },
		RISER_H,
		8,
		s.P,
		2
	),
	{ tone: "lo" }
);
s.solid(slabOf(BACKING, RISER_H, 2, s.P, 3), { tone: "lo" });
s.solid(slabOf(UPPER, STOCK_Z, STOCK_H, s.P, 3, 0.4));
scale(UPPER, TOP, 6, UPPER.y + UPPER.d - 4.6);
s.solid(slabOf(SLIDE, STOCK_Z, STOCK_H - 0.6, s.P, 3, 0.4));
scale(SLIDE, TOP - 0.6, 6, SLIDE.y + 0.6);
s.solid(slabOf(LOWER, STOCK_Z, STOCK_H, s.P, 3, 0.4));
scale(LOWER, TOP, 4.5, LOWER.y + 0.6);
screws(
	s,
	[
		[LOWER.x + 5, LOWER.y + 7],
		[LOWER.x + LOWER.w - 5, LOWER.y + 7],
	],
	TOP,
	1.1
);
// Cursor: a glass bridge with a hairline, clipped round the front.
s.solid(slabOf(CURSOR, TOP, 1, s.P, 2), { tone: "faint", crease: "none" });
s.solid(
	slabOf(
		{ x: CURSOR_X - 0.7, y: CURSOR.y + 2, w: 1.4, d: CURSOR.d - 4, r: 0.2 },
		TOP + 1,
		0.8,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
s.solid(
	slabOf(
		{ x: CURSOR.x, y: CURSOR.y + CURSOR.d - 5, w: CURSOR.w, d: 5, r: 1 },
		RISER_H,
		TOP + 1 - RISER_H,
		s.P,
		2
	)
);
// Locale selector and its lamp on the plate in front.
knob(s, [-84, 26], 0, 5, 6);
lamp(s, [-68, 28], 0, { radius: 1.8 });

export const drawing = cardDrawing(s);
