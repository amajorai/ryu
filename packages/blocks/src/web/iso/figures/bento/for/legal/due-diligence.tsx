import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, faceRect, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Due diligence: the data room is a filing cabinet with its top drawer
 * pulled. Each record's parties, dates and obligations end up as cards
 * slotted into a sorting table, one cell per fact; the newest card (lit) has
 * just been filed.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const CABINET = { x: -88, y: -8, w: 38, d: 52, r: 3 };
const CAB_H = 46;
const FACE = CABINET.x + CABINET.w;
const TABLE = { x: -22, y: -40, w: 106, d: 72, r: 4 };
const TABLE_H = 7;
const COLS = 4;
const ROWS = 3;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[CABINET.x, CABINET.y, CAB_H + 4],
]);

benchPlate(s, PLATE);
// Filing cabinet: three drawer fronts on the side facing the table.
s.halo(CABINET, 0);
s.solid(slabOf(CABINET, 0, CAB_H, s.P, 4, 0.8));
for (const [z0, z1] of [
	[3, 15],
	[17, 29],
] as const) {
	s.line(
		faceRect(s, "x", FACE, CABINET.y + 5, CABINET.y + CABINET.d - 5, z0, z1),
		{
			tone: "lo",
		}
	);
	s.solid(
		slabOf(
			{ x: FACE, y: CABINET.y + 20, w: 2.5, d: 12, r: 0.8 },
			z1 - 7,
			2.5,
			s.P,
			2
		),
		{ tone: "lo" }
	);
}
lamp(s, [CABINET.x + 9, CABINET.y + 9], CAB_H, { radius: 1.8 });
// Top drawer pulled out, folders standing in it.
const DRAWER = {
	x: FACE - 2,
	y: CABINET.y + 5,
	w: 26,
	d: CABINET.d - 10,
	r: 1.5,
};
s.solid(slabOf(DRAWER, 31, 12, s.P, 3, 0.6));
s.line(planOutline(insetPlan(DRAWER, 2.5), 43, s.P, 2), { tone: "lo" });
for (let i = 0; i < 4; i++) {
	s.solid(
		slabOf(
			{
				x: DRAWER.x + 4 + i * 5,
				y: DRAWER.y + 5,
				w: 1.6,
				d: DRAWER.d - 10,
				r: 0.4,
			},
			43,
			5,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
s.solid(
	slabOf(
		{ x: DRAWER.x + DRAWER.w - 1, y: DRAWER.y + 14, w: 3, d: 14, r: 0.8 },
		37,
		3,
		s.P,
		2
	),
	{ tone: "lo" }
);
// Sorting table: a grid of wells, cards filed into most of them.
s.halo(TABLE, 0);
s.solid(slabOf(TABLE, 0, TABLE_H, s.P, 6, 0.8));
const cellW = (TABLE.w - 10) / COLS;
const cellD = (TABLE.d - 10) / ROWS;
const cells: [number, number, number][] = [];
for (let r = 0; r < ROWS; r++) {
	for (let c = 0; c < COLS; c++) {
		cells.push([
			TABLE.x + 5 + c * cellW,
			TABLE.y + 5 + r * cellD,
			r * COLS + c,
		]);
	}
}
const empty = new Set([3, 7, 10, 11]);
const LIT = 6;
for (const [x, y, index] of byDepth(cells, s, TABLE_H)) {
	const cell = { x: x + 1.5, y: y + 1.5, w: cellW - 3, d: cellD - 3, r: 1.5 };
	s.line(planOutline(cell, TABLE_H, s.P, 2), { tone: "lo" });
	if (!empty.has(index)) {
		s.solid(
			slabOf(insetPlan(cell, 3), TABLE_H, index === LIT ? 5 : 2.5, s.P, 2, 0.4),
			{
				lit: index === LIT,
				crease: "none",
			}
		);
	}
}

export const drawing = cardDrawing(s);
