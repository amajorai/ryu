import { boxCorners, cylinder, ring, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, ruler } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Interview scheduling: a pegboard calendar. Each row is one panelist's day,
 * each column a time slot; a peg marks a busy hour. The one column every row
 * leaves open holds the booking bar (the lit part), seated on two short pins.
 */

const PLATE = { x: -92, y: -58, w: 184, d: 116, r: 8 };
const BOARD = { x: -74, y: -46, w: 148, d: 92, r: 4 };
const BOARD_H = 8;
const COLS = 6;
const ROWS = 4;
const FREE = 3;
const BUSY = [
	[0, 1, 1, 0, 0, 1],
	[1, 0, 0, 0, 1, 0],
	[0, 1, 0, 0, 1, 1],
	[1, 0, 1, 0, 0, 1],
];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 24]]);

const cellX = (c: number) => -50 + c * 20;
const cellY = (r: number) => -24 + r * 18;

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 0.8));
ruler(s, { x: -62, y: -42, w: 124, d: 7, r: 1 }, BOARD_H);
const holes: [number, number, number][] = [];
for (let r = 0; r < ROWS; r++) {
	for (let c = 0; c < COLS; c++) {
		holes.push([cellX(c), cellY(r), BUSY[r]?.[c] ?? 0]);
	}
}
s.line(holes.map(([x, y]) => ring(x, y, 3.6, BOARD_H, s.P, 16)).join(""), {
	tone: "lo",
});
// Busy pegs in the far columns, then the booking bar, then the near columns.
const pegs = byDepth(
	holes.filter(([, , busy]) => busy),
	s,
	BOARD_H
);
function peg([x, y]: [number, number, number]) {
	s.solid(cylinder(x, y, 3, BOARD_H, 8, s.P, 16));
	s.solid(cylinder(x, y, 5, BOARD_H + 8, 2.5, s.P, 20), { tone: "lo" });
}
for (const p of pegs.filter(([x]) => x < cellX(FREE))) {
	peg(p);
}
const bx = cellX(FREE);
for (const y of [cellY(0), cellY(ROWS - 1)]) {
	s.solid(cylinder(bx, y, 3, BOARD_H, 6, s.P, 16));
}
s.solid(
	slabOf(
		{
			x: bx - 5,
			y: cellY(0) - 6,
			w: 10,
			d: cellY(ROWS - 1) - cellY(0) + 12,
			r: 2,
		},
		BOARD_H + 6,
		4,
		s.P,
		3,
		0.6
	),
	{ lit: true }
);
for (const p of pegs.filter(([x]) => x > cellX(FREE))) {
	peg(p);
}

export const drawing = cardDrawing(s);
