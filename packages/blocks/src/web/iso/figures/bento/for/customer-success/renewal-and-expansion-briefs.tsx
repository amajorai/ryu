import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Renewal and expansion briefs: a brief on a clipboard, its usage figures as
 * a small bar row, and the approval stamp that marks it ready (the lit
 * impression). The stamp itself waits on its ink pad beside it.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const BOARD = { x: -84, y: -42, w: 92, d: 84, r: 4 };
const BOARD_H = 4;
const SHEET = insetPlan({ ...BOARD, y: BOARD.y + 12, d: BOARD.d - 12 }, 5);
const SHEET_Z = BOARD_H;
const PAD = { x: 26, y: -30, w: 52, d: 40, r: 3 };
const PAD_H = 6;
const STAMP = { x: 38, y: -22, w: 28, d: 22, r: 2 };
const HANDLE: [number, number] = [52, -11];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[HANDLE[0], HANDLE[1], PAD_H + 40],
]);

benchPlate(s, PLATE);
// The clipboard and its clip.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 4, 0.6));
const sheetTop = SHEET_Z + 0.8;
s.solid(slabOf(SHEET, SHEET_Z, 0.8, s.P, 2), { crease: "none" });
const clip = { x: BOARD.x + 28, y: BOARD.y + 4, w: 36, d: 12, r: 3 };
s.solid(slabOf(clip, BOARD_H, 4, s.P, 4, 0.6), { tone: "lo" });
screws(
	s,
	[
		[clip.x + 6, clip.y + 6],
		[clip.x + clip.w - 6, clip.y + 6],
	],
	BOARD_H + 4,
	1.3
);
for (const [i, length] of [54, 40, 48].entries()) {
	const y = SHEET.y + 7 + i * 6;
	s.line(
		lineOnTop([SHEET.x + 6, y], [SHEET.x + 6 + length, y], sheetTop, s.P),
		{ tone: i === 0 ? "mid" : "lo" }
	);
}
// Usage bars rising across the page: the justification.
for (const [i, height] of [3, 5, 6, 9].entries()) {
	s.solid(
		slabOf(
			{ x: SHEET.x + 8 + i * 9, y: SHEET.y + 36, w: 6, d: 6, r: 0.5 },
			sheetTop,
			height,
			s.P,
			2
		),
		{ tone: "lo" }
	);
}
// The stamp's impression in the corner of the brief.
const mark = {
	x: SHEET.x + SHEET.w - 28,
	y: SHEET.y + SHEET.d - 24,
	w: 22,
	d: 18,
	r: 2,
};
s.solid(slabOf(mark, sheetTop, 0.6, s.P, 3), { lit: true, crease: "none" });
s.line(planOutline(insetPlan(mark, 3), sheetTop + 0.6, s.P, 2), {
	tone: "hi",
});
// Ink pad tin with the stamp resting on it.
s.halo(PAD, 0);
s.solid(slabOf(PAD, 0, PAD_H, s.P, 4, 0.8));
s.solid(slabOf(insetPlan(PAD, 4), PAD_H, 0.6, s.P, 2), {
	tone: "lo",
	crease: "none",
});
s.solid(slabOf(STAMP, PAD_H, 4, s.P, 3), { tone: "lo" });
s.solid(slabOf(insetPlan(STAMP, 2), PAD_H + 4, 6, s.P, 3, 0.6));
s.solid(cylinder(HANDLE[0], HANDLE[1], 3.5, PAD_H + 10, 14, s.P, 24));
s.solid(cylinder(HANDLE[0], HANDLE[1], 7, PAD_H + 24, 12, s.P, 32, 1.2));
s.line(knurl(HANDLE[0], HANDLE[1], 7, PAD_H + 26, PAD_H + 34, 30, s.P), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
