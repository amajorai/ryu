import {
	boxCorners,
	cylinder,
	knurl,
	ring,
	slabOf,
	topTicks,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Document summarization: a screw press. A tall stack of records sits under
 * the platen and is squeezed down; what comes out is the timeline rail in
 * front, a few pegs standing for the facts in order. The lit peg is the fact
 * a handler checks first.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const BED = { x: -84, y: -44, w: 96, d: 52, r: 4 };
const BED_H = 6;
const POSTS = [
	[-76, -18],
	[4, -18],
] as const;
const POST_TOP = 54;
const STACK = { x: -58, y: -32, w: 36, d: 30, r: 1 };
const SHEETS = 9;
const SHEET_H = 1.6;
const SCREW: [number, number] = [-36, -18];
const RAIL = { x: -80, y: 22, w: 168, d: 12, r: 2 };
const RAIL_H = 5;
const PEGS = [-62, -30, 6, 38, 70];
const KEY = 2;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-36, -18, 72]]);

benchPlate(s, PLATE);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 0.8));
screws(
	s,
	[
		[BED.x + 6, BED.y + BED.d - 6],
		[BED.x + BED.w - 6, BED.y + BED.d - 6],
	],
	BED_H,
	1.4
);
s.solid(
	cylinder(POSTS[0][0], POSTS[0][1], 3.5, BED_H, POST_TOP - BED_H, s.P, 20)
);
for (let i = 0; i < SHEETS; i++) {
	s.solid(
		slabOf(
			{
				x: STACK.x + (i % 3) - 1,
				y: STACK.y + ((i + 1) % 2),
				w: STACK.w,
				d: STACK.d,
				r: 1,
			},
			BED_H + i * SHEET_H,
			SHEET_H,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
const stackTop = BED_H + SHEETS * SHEET_H;
s.solid(
	slabOf(
		{ x: STACK.x - 4, y: STACK.y - 3, w: STACK.w + 8, d: STACK.d + 6, r: 2 },
		stackTop,
		4,
		s.P,
		3,
		0.6
	),
	{ tone: "lo" }
);
s.solid(
	cylinder(
		SCREW[0],
		SCREW[1],
		2.6,
		stackTop + 4,
		POST_TOP - stackTop - 4,
		s.P,
		20
	)
);
s.solid(
	cylinder(POSTS[1][0], POSTS[1][1], 3.5, BED_H, POST_TOP - BED_H, s.P, 20)
);
s.solid(
	slabOf({ x: -84, y: -25, w: 96, d: 14, r: 3 }, POST_TOP, 8, s.P, 4, 0.8)
);
s.solid(cylinder(SCREW[0], SCREW[1], 2.6, POST_TOP + 8, 4, s.P, 20));
s.solid(cylinder(SCREW[0], SCREW[1], 13, POST_TOP + 12, 3, s.P, 40, 0.6));
s.line(
	knurl(SCREW[0], SCREW[1], 13, POST_TOP + 12.4, POST_TOP + 14.6, 40, s.P),
	{
		tone: "lo",
	}
);
s.line(ring(SCREW[0], SCREW[1], 8, POST_TOP + 15, s.P, 32), { tone: "lo" });
knob(s, [SCREW[0] + 9, SCREW[1]], POST_TOP + 15, 2, 4);
// The cover sheet the summary is written on.
s.solid(slabOf({ x: 26, y: -34, w: 40, d: 28, r: 2 }, 0, 2, s.P, 3, 0.4), {
	tone: "lo",
});
s.solid(slabOf({ x: 30, y: -31, w: 30, d: 22, r: 1 }, 2, 1, s.P, 2), {
	crease: "none",
});
// The timeline rail: the condensed output, facts in order.
s.halo(RAIL, 0);
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 4, 0.6));
const ticks = topTicks(
	RAIL.x + 6,
	RAIL.x + RAIL.w - 6,
	4,
	4,
	RAIL.y + 1,
	RAIL_H,
	[2, 3.5],
	s.P
);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
for (const [index, x] of PEGS.entries()) {
	const lit = index === KEY;
	s.solid(
		cylinder(
			x,
			RAIL.y + 8,
			2.4,
			RAIL_H,
			lit ? 16 : 9 + (index % 2) * 3,
			s.P,
			20
		),
		{
			lit,
		}
	);
}

export const drawing = cardDrawing(s);
