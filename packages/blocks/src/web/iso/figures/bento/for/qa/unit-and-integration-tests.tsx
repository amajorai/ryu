import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Unit and integration tests: a bed-of-nails fixture. The new board sits on
 * its standoffs while a gantry lowers a row of spring probes onto its pads,
 * each probe one assertion; the pass lamp on the base (lit) shows the board
 * fits the existing fixture.
 */

const PLATE = { x: -96, y: -56, w: 192, d: 112, r: 8 };
const BASE = { x: -76, y: -44, w: 140, d: 88, r: 5 };
const BASE_H = 10;
const BOARD = { x: -52, y: -28, w: 88, d: 56, r: 2 };
const BOARD_Z = BASE_H + 6;
const BOARD_TOP = BOARD_Z + 2;
const GANTRY_X = -6;
const BAR_Z = 48;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[GANTRY_X, -40, BAR_Z + 6],
	[GANTRY_X, 40, BAR_Z + 6],
]);

function post(y: number) {
	const plan = { x: GANTRY_X - 5, y: y - 4, w: 10, d: 8, r: 1.5 };
	s.solid(slabOf(plan, BASE_H, BAR_Z - BASE_H, s.P, 3, 0.6));
}

function chip(x: number, y: number, w: number, d: number) {
	s.solid(slabOf({ x, y, w, d, r: 1 }, BOARD_TOP, 3, s.P, 2), { tone: "lo" });
}

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(BASE, 4), BASE_H, s.P, 4), { tone: "faint" });
post(-38);
// Standoffs and the board under test.
for (const [x, y] of [
	[BOARD.x + 5, BOARD.y + 5],
	[BOARD.x + BOARD.w - 5, BOARD.y + 5],
	[BOARD.x + 5, BOARD.y + BOARD.d - 5],
	[BOARD.x + BOARD.w - 5, BOARD.y + BOARD.d - 5],
] as const) {
	s.solid(cylinder(x, y, 2.4, BASE_H, BOARD_Z - BASE_H, s.P, 16));
}
s.solid(slabOf(BOARD, BOARD_Z, 2, s.P, 3));
screws(
	s,
	[
		[BOARD.x + 5, BOARD.y + 5],
		[BOARD.x + BOARD.w - 5, BOARD.y + BOARD.d - 5],
	],
	BOARD_TOP,
	1.4
);
chip(-44, -18, 18, 14);
chip(-42, 4, 14, 16);
// Probe head: a carriage on the bar with its pins resting on the pads.
const pins = [-18, -8, 2, 12];
for (const y of pins) {
	s.line(
		planOutline(
			{ x: GANTRY_X - 2, y: y - 2, w: 4, d: 4, r: 2 },
			BOARD_TOP,
			s.P
		),
		{
			tone: "mid",
		}
	);
	s.solid(cylinder(GANTRY_X, y, 1.2, BOARD_TOP, 18, s.P, 12));
}
s.solid(
	slabOf(
		{ x: GANTRY_X - 6, y: -24, w: 12, d: 42, r: 2 },
		BOARD_TOP + 18,
		BAR_Z - BOARD_TOP - 18,
		s.P,
		3,
		0.6
	),
	{ tone: "lo" }
);
s.solid(
	slabOf({ x: GANTRY_X - 5, y: -42, w: 10, d: 84, r: 2 }, BAR_Z, 6, s.P, 3, 0.6)
);
chip(10, -16, 16, 16);
chip(14, 6, 18, 12);
post(38);
lamp(s, [52, 34], BASE_H, { lit: true, radius: 3 });
lamp(s, [52, 22], BASE_H, { radius: 3 });

export const drawing = cardDrawing(s);
