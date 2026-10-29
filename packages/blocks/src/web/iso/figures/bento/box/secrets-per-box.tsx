import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Secrets per Box: a carry case of small locking drawers, one set of drawers
 * per Box and a fixed number of them. One drawer is pulled out to hand its
 * secret to the run (the lit drawer); the rest stay shut.
 */

const PLATE = { x: -66, y: -48, w: 132, d: 92, r: 8 };
const CASE = { x: -46, y: -36, w: 92, d: 50, r: 3 };
const CASE_H = 50;
const FRONT = CASE.y + CASE.d;
const COLS = 4;
const ROWS = 4;
const CELL_W = (CASE.w - 12) / COLS;
const CELL_H = (CASE_H - 10) / ROWS;
const OPEN = { col: 2, row: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, -11, CASE_H + 14],
]);

const cellX = (col: number) => CASE.x + 6 + col * CELL_W;
const cellZ = (row: number) => 5 + row * CELL_H;

benchPlate(s, PLATE);
s.halo(CASE, 0);
s.solid(slabOf(CASE, 0, CASE_H, s.P, 4, 1));
s.line(planOutline(insetPlan(CASE, 5), CASE_H, s.P, 3), { tone: "faint" });
screws(
	s,
	[
		[CASE.x + 8, CASE.y + 8],
		[CASE.x + CASE.w - 8, CASE.y + CASE.d - 8],
	],
	CASE_H,
	1.4
);
lamp(s, [CASE.x + CASE.w - 10, CASE.y + 8], CASE_H, { radius: 1.6 });
// Carry handle: two posts and a bar across the lid.
for (const x of [-20, 20]) {
	s.solid(cylinder(x, -11, 2.6, CASE_H, 10, s.P, 20), { tone: "lo" });
}
s.solid(
	slabOf({ x: -23, y: -14, w: 46, d: 6, r: 3 }, CASE_H + 9, 4, s.P, 6, 0.4)
);
// Grid of drawer fronts, each with a pull.
const pulls: [number, number, number][] = [];
for (let row = 0; row < ROWS; row++) {
	for (let col = 0; col < COLS; col++) {
		if (row === OPEN.row && col === OPEN.col) {
			s.line(
				faceRect(
					s,
					"y",
					FRONT,
					cellX(col) + 1,
					cellX(col + 1) - 1,
					cellZ(row) + 1,
					cellZ(row + 1) - 1
				),
				{ tone: "mid" }
			);
			continue;
		}
		s.line(
			faceRect(
				s,
				"y",
				FRONT,
				cellX(col) + 1,
				cellX(col + 1) - 1,
				cellZ(row) + 1,
				cellZ(row + 1) - 1
			),
			{ tone: "lo" }
		);
		pulls.push([cellX(col) + CELL_W / 2, FRONT, cellZ(row) + CELL_H / 2]);
	}
}
s.dots(pulls.map(s.at), { size: 0.9 });
// The pulled drawer.
const x0 = cellX(OPEN.col) + 1.5;
const drawer = { x: x0, y: FRONT, w: CELL_W - 3, d: 20, r: 1 };
s.solid(slabOf(drawer, cellZ(OPEN.row) + 1.5, CELL_H - 3, s.P, 2, 0.4), {
	lit: true,
});

export const drawing = cardDrawing(s);
