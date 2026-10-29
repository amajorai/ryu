import {
	boxCorners,
	cylinder,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Spec drafting: a drafting board. A sheet is clipped down and ruled into
 * sections (goals, scope, edge cases) under a sliding T-square; one section
 * is still flagged with a tab (lit) for the open questions to review. The
 * pencil cup stands beside the board.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const BOARD = { x: -82, y: -46, w: 128, d: 92, r: 4 };
const BOARD_H = 6;
const SHEET = { x: -62, y: -38, w: 92, d: 72, r: 1 };
const TOP = BOARD_H + 1;
const CUP: [number, number] = [72, -14];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [72, -14, 42]]);

/** A section: a heading rule and its body rules. */
function section(y: number, widths: number[]) {
	s.line(lineOnTop([SHEET.x + 8, y], [SHEET.x + 40, y], TOP, s.P), {
		tone: "mid",
	});
	widths.forEach((width, index) => {
		const at = y + 5 + index * 4.5;
		s.line(
			lineOnTop([SHEET.x + 12, at], [SHEET.x + 12 + width, at], TOP, s.P),
			{ tone: "lo" }
		);
	});
}

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 4, 1));
// Pencil cup: a turned pot holding two pencils.
s.halo({ x: CUP[0] - 12, y: CUP[1] - 12, w: 24, d: 24, r: 12 }, 0);
s.solid(cylinder(CUP[0] - 3.5, CUP[1] - 3, 2.6, 0, 36, s.P, 12), {
	tone: "lo",
});
s.solid(cylinder(CUP[0] - 3.5, CUP[1] - 3, 1.2, 36, 4, s.P, 10), {
	tone: "lo",
});
s.solid(cylinder(CUP[0] + 3.5, CUP[1] - 1, 2.6, 0, 32, s.P, 12));
s.solid(cylinder(CUP[0] + 3.5, CUP[1] - 1, 1.2, 32, 4, s.P, 10));
s.solid(cylinder(CUP[0], CUP[1], 10, 0, 22, s.P, 36, 0.8));
s.line(ring(CUP[0], CUP[1], 8.5, 22, s.P, 36), { tone: "lo" });
// The sheet, clipped at its four corners.
s.solid(slabOf(SHEET, BOARD_H, 1, s.P, 2), { crease: "none" });
section(SHEET.y + 8, [64, 52]);
section(SHEET.y + 26, [70, 58, 44]);
section(SHEET.y + 48, [60, 40]);
for (const [x, y] of [
	[SHEET.x - 3, SHEET.y - 3],
	[SHEET.x + SHEET.w - 7, SHEET.y - 3],
	[SHEET.x - 3, SHEET.y + SHEET.d - 7],
	[SHEET.x + SHEET.w - 7, SHEET.y + SHEET.d - 7],
] as const) {
	s.solid(slabOf({ x, y, w: 10, d: 10, r: 1 }, BOARD_H, 2.6, s.P, 2), {
		tone: "lo",
	});
}
// Open-questions tab sticking out past the sheet's right edge.
s.solid(
	slabOf(
		{ x: SHEET.x + SHEET.w - 6, y: SHEET.y + 44, w: 16, d: 9, r: 1 },
		TOP,
		1.4,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// T-square: a head riding the board's left edge, its blade across the sheet.
s.solid(
	slabOf({ x: BOARD.x - 6, y: 10, w: 8, d: 16, r: 1 }, 0, BOARD_H + 6, s.P, 2)
);
s.solid(
	slabOf({ x: BOARD.x + 2, y: 14, w: 110, d: 8, r: 1 }, TOP, 2.4, s.P, 2)
);
screws(
	s,
	[
		[BOARD.x - 2, 14],
		[BOARD.x - 2, 22],
	],
	BOARD_H + 6,
	1.1
);

export const drawing = cardDrawing(s);
