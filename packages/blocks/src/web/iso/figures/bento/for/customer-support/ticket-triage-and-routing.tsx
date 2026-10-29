import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Ticket triage and routing: a sorting rack of pigeonholes, one per queue,
 * with the in-tray of unsorted tickets in front. Each ticket is slid into the
 * hole for its queue; the lit one has just been routed.
 */

const PLATE = { x: -92, y: -54, w: 184, d: 108, r: 8 };
const RACK = { x: -80, y: -44, w: 108, d: 40, r: 3 };
const FRONT = RACK.y + RACK.d;
const RACK_H = 66;
const COLS = [RACK.x + 6, RACK.x + 40, RACK.x + 74] as const;
const HOLE_W = 28;
const ROWS = [6, 36] as const;
const HOLE_H = 24;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[RACK.x, RACK.y, RACK_H + 4],
]);

/** A ticket sticking out of the pigeonhole at column `col`, row `row`. */
function ticket(col: 0 | 1 | 2, row: 0 | 1, reach: number, lit = false) {
	const plan = { x: COLS[col] + 3, y: FRONT, w: HOLE_W - 6, d: reach, r: 0.5 };
	s.solid(slabOf(plan, ROWS[row], 3, s.P, 1), { lit });
}

benchPlate(s, PLATE);
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 4, 1));
s.solid(slabOf(insetPlan(RACK, -2), RACK_H, 3, s.P, 4, 0.6), { tone: "lo" });
lamp(s, [RACK.x + RACK.w - 8, RACK.y + 8], RACK_H + 3, { radius: 1.8 });
for (const x of COLS) {
	for (const z of ROWS) {
		s.line(faceRect(s, "y", FRONT, x, x + HOLE_W, z, z + HOLE_H), {
			tone: "lo",
		});
	}
}
ticket(0, 1, 8);
ticket(2, 1, 6);
ticket(0, 0, 7);
ticket(1, 0, 18, true);
ticket(2, 0, 5);
// In-tray of unsorted tickets, front right.
const tray = { x: 38, y: -12, w: 44, d: 50, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 6, s.P, 4, 0.6), { tone: "lo" });
s.line(planOutline(insetPlan(tray, 4), 6, s.P, 3), { tone: "faint" });
const stack = [
	{ x: 44, y: -4, w: 32, d: 32, r: 1 },
	{ x: 46, y: -2, w: 32, d: 32, r: 1 },
	{ x: 43, y: -1, w: 32, d: 32, r: 1 },
];
for (const [index, plan] of stack.entries()) {
	s.solid(slabOf(plan, 6 + index * 2.5, 2.5, s.P, 1));
}
screws(
	s,
	[
		[tray.x + 5, tray.y + tray.d - 5],
		[tray.x + tray.w - 5, tray.y + 5],
	],
	6,
	1.2
);

export const drawing = cardDrawing(s);
