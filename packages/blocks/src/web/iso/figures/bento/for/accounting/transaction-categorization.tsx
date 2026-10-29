import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Transaction categorization: a pigeonhole cabinet, one cubby per account in
 * the chart of accounts. Filed receipts lie in their cubbies; the one being
 * slotted in now (lit) comes from the tray of uncategorized receipts in
 * front of the cabinet.
 */

const PLATE = { x: -90, y: -52, w: 184, d: 104, r: 8 };
const CABINET = { x: -78, y: -42, w: 100, d: 40, r: 3 };
const CAB_H = 56;
const FRONT = CABINET.y + CABINET.d;
const COLS = 4;
const ROWS = 3;
const CELL_W = 21;
const CELL_H = 14;
const FILED: [number, number][] = [
	[0, 0],
	[2, 0],
	[1, 1],
	[3, 2],
	[0, 2],
];
const INCOMING: [number, number] = [2, 1];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CABINET.x, CABINET.y, CAB_H],
]);

const cellX = (col: number) => CABINET.x + 6 + col * (CELL_W + 2.5);
const cellZ = (row: number) => 4 + row * (CELL_H + 3);

benchPlate(s, PLATE);
s.halo(CABINET, 0);
s.solid(slabOf(CABINET, 0, CAB_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(CABINET, 4), CAB_H, s.P, 3), { tone: "faint" });
for (let row = 0; row < ROWS; row++) {
	for (let col = 0; col < COLS; col++) {
		s.line(
			faceRect(
				s,
				"y",
				FRONT,
				cellX(col),
				cellX(col) + CELL_W,
				cellZ(row),
				cellZ(row) + CELL_H
			),
			{ tone: "lo" }
		);
	}
}
for (const [col, row] of FILED) {
	s.solid(
		slabOf(
			{ x: cellX(col) + 3, y: FRONT - 2, w: CELL_W - 6, d: 4, r: 0.5 },
			cellZ(row) + 1,
			1.2,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
const [inCol, inRow] = INCOMING;
s.solid(
	slabOf(
		{ x: cellX(inCol) + 3, y: FRONT - 2, w: CELL_W - 6, d: 14, r: 0.5 },
		cellZ(inRow) + 1,
		1.2,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// The tray of uncategorized receipts.
const tray = { x: 34, y: -24, w: 52, d: 58, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 6, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < 4; i++) {
	s.solid(
		slabOf(
			{
				x: tray.x + 6 + (i % 2) * 2,
				y: tray.y + 6 + i * 2,
				w: 34,
				d: 38,
				r: 1,
			},
			6 + i * 1.2,
			1.2,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
screws(
	s,
	[
		[tray.x + 5, tray.y + tray.d - 4],
		[tray.x + tray.w - 5, tray.y + tray.d - 4],
	],
	6,
	1.2
);

export const drawing = cardDrawing(s);
