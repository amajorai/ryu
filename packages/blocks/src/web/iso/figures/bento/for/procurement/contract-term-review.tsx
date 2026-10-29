import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Contract term review: a contract on a clipboard, read clause by clause.
 * One clause strays from your standard terms, so a flag tab is clipped to the
 * sheet at that line (the lit tab); the reject stamp waits beside it.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const BOARD = { x: -74, y: -40, w: 100, d: 82, r: 4 };
const BOARD_H = 3;
const SHEET = insetPlan(BOARD, 6);
const SHEET_TOP = BOARD_H + 1;
const STAMP: [number, number] = [62, -4];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [62, -4, 34]]);

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(SHEET, BOARD_H, 1, s.P, 2), { crease: "none" });
const widths = [70, 58, 76, 64, 50, 72, 60, 44];
widths.forEach((width, index) => {
	const y = SHEET.y + 18 + index * 7;
	s.line(
		lineOnTop([SHEET.x + 6, y], [SHEET.x + 6 + width, y], SHEET_TOP, s.P),
		{
			tone: index === 4 ? "mid" : "faint",
		}
	);
});
// The spring clip across the head of the sheet.
const clip = { x: -46, y: -44, w: 44, d: 14, r: 3 };
s.solid(slabOf(clip, BOARD_H, 6, s.P, 4, 0.8));
s.solid(slabOf({ x: -36, y: -36, w: 24, d: 4, r: 1 }, BOARD_H + 6, 2, s.P, 2), {
	tone: "lo",
});
screws(
	s,
	[
		[clip.x + 6, clip.y + 7],
		[clip.x + clip.w - 6, clip.y + 7],
	],
	BOARD_H + 6,
	1.4
);
// Flag tab on the deviating clause, sticking out past the board edge.
const flagY = SHEET.y + 18 + 4 * 7;
s.solid(
	slabOf(
		{ x: SHEET.x + SHEET.w - 12, y: flagY - 3, w: 26, d: 6, r: 1 },
		SHEET_TOP,
		1.6,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// The stamp: a block foot, a stem and a knurled grip.
const foot = { x: STAMP[0] - 13, y: STAMP[1] - 10, w: 26, d: 20, r: 3 };
s.halo(foot, 0);
s.solid(slabOf(foot, 0, 3, s.P, 4, 0.4), { tone: "lo" });
s.solid(slabOf(insetPlan(foot, 2), 3, 6, s.P, 4, 0.6));
s.solid(cylinder(STAMP[0], STAMP[1], 3, 9, 12, s.P, 20));
s.solid(cylinder(STAMP[0], STAMP[1], 7, 21, 9, s.P, 32, 0.6));
s.line(knurl(STAMP[0], STAMP[1], 7, 21.5, 29.5, 28, s.P), { tone: "lo" });

export const drawing = cardDrawing(s);
