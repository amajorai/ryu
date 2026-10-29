import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, ruler, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Data extraction: a clipboard and a sorting grid. The paper is clamped on
 * the board at the back; its figures are lifted out one by one into the
 * cells of a ruled grid tray, a row per paper and a column per field. The
 * value just placed is the lit block.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const BOARD = { x: -90, y: -44, w: 60, d: 80, r: 4 };
const GRID = { x: -16, y: -36, w: 100, d: 76, r: 3 };
const GRID_H = 8;
const COLS = 4;
const ROWS = 4;
const FILLED = 13;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-60, -40, 14]]);

benchPlate(s, PLATE);
// Clipboard with the paper and its clip.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, 3, s.P, 4, 0.6), { tone: "lo" });
const page = { x: BOARD.x + 6, y: BOARD.y + 10, w: BOARD.w - 12, d: 64, r: 1 };
s.solid(slabOf(page, 3, 1, s.P, 2), { crease: "none" });
for (let i = 0; i < 7; i++) {
	const y = page.y + 10 + i * 7.6;
	const width = [38, 30, 36, 22, 34, 28, 18][i] ?? 30;
	s.line(lineOnTop([page.x + 5, y], [page.x + 5 + width, y], 4, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
}
s.solid(
	slabOf({ x: BOARD.x + 16, y: BOARD.y + 3, w: 28, d: 10, r: 2 }, 3, 6, s.P, 3)
);
s.solid(
	slabOf({ x: BOARD.x + 26, y: BOARD.y + 5, w: 8, d: 4, r: 1 }, 9, 3, s.P, 2),
	{ tone: "lo" }
);
// The grid tray: a column per field, a row per paper.
s.halo(GRID, 0);
s.solid(slabOf(GRID, 0, GRID_H, s.P, 4, 0.8));
const inner = insetPlan(GRID, 4);
s.line(planOutline(inner, GRID_H, s.P, 2), { tone: "mid" });
const cw = inner.w / COLS;
const rh = inner.d / ROWS;
for (let c = 1; c < COLS; c++) {
	s.line(
		lineOnTop(
			[inner.x + c * cw, inner.y],
			[inner.x + c * cw, inner.y + inner.d],
			GRID_H,
			s.P
		)
	);
}
for (let r = 1; r < ROWS; r++) {
	s.line(
		lineOnTop(
			[inner.x, inner.y + r * rh],
			[inner.x + inner.w, inner.y + r * rh],
			GRID_H,
			s.P
		)
	);
}
for (let r = 0; r < ROWS; r++) {
	for (let c = 0; c < COLS; c++) {
		const index = r * COLS + c;
		if (index >= FILLED) {
			continue;
		}
		const lit = index === FILLED - 1;
		s.solid(
			slabOf(
				{
					x: inner.x + c * cw + 5,
					y: inner.y + r * rh + 5,
					w: cw - 10,
					d: rh - 10,
					r: 1.5,
				},
				GRID_H,
				lit ? 8 : 3,
				s.P,
				3,
				0.4
			),
			{ lit, tone: "lo" }
		);
	}
}
screws(
	s,
	[
		[GRID.x + GRID.w - 2, GRID.y - 6],
		[BOARD.x + 6, BOARD.y + BOARD.d + 7],
	],
	0,
	1.4
);
ruler(s, { x: GRID.x, y: GRID.y + GRID.d + 3, w: GRID.w, d: 6, r: 1 }, 0);

export const drawing = cardDrawing(s);
