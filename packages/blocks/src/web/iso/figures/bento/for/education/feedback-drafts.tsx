import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Feedback drafts: a student's page on a clipboard with a rubric column of
 * boxes down its edge. The drafted comment is a note slip laid on the page
 * (the lit part) for the teacher to review; the pen cup and the approval
 * stamp wait beside it for the personal touch.
 */

const PLATE = { x: -92, y: -56, w: 184, d: 112, r: 8 };
const BOARD = { x: -76, y: -46, w: 88, d: 94, r: 4 };
const BOARD_H = 3;
const SHEET = { x: -70, y: -34, w: 76, d: 76, r: 1 };
const TOP = BOARD_H + 0.8;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [52, -26, 32]]);

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 0.6), { tone: "lo" });
s.solid(slabOf(SHEET, BOARD_H, 0.8, s.P, 2), { crease: "none" });
for (let i = 0; i < 8; i++) {
	const y = SHEET.y + 8 + i * 8;
	const length = [44, 52, 40, 50, 30, 48, 36, 24][i] ?? 40;
	s.line(lineOnTop([SHEET.x + 6, y], [SHEET.x + 6 + length, y], TOP, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
	if (i < 5) {
		s.line(
			planOutline(
				{ x: SHEET.x + 62, y: y - 2.5, w: 5, d: 5, r: 0.5 },
				TOP,
				s.P,
				2
			),
			{ tone: "mid" }
		);
	}
}
// The drafted note slip.
s.solid(slabOf({ x: -40, y: 18, w: 34, d: 18, r: 1 }, TOP, 1.4, s.P, 2), {
	lit: true,
	crease: "none",
});
// Clip across the top edge.
s.solid(
	slabOf({ x: -50, y: -44, w: 36, d: 12, r: 2 }, BOARD_H, 4, s.P, 3, 0.6)
);
s.solid(
	slabOf({ x: -44, y: -40, w: 24, d: 8, r: 3 }, BOARD_H + 4, 3, s.P, 4, 0.4),
	{
		tone: "lo",
	}
);
screws(
	s,
	[
		[-46, -38],
		[-18, -38],
	],
	BOARD_H + 4,
	1.2
);
// Pen cup with two pens.
s.halo({ x: 40, y: -38, w: 24, d: 24, r: 12 }, 0);
s.solid(cylinder(52, -26, 11, 0, 20, s.P, 36, 0.8));
s.line(cylinder(52, -26, 9, 20, 0.1, s.P, 36).top, { tone: "lo" });
s.solid(cylinder(49, -29, 2, 20, 12, s.P, 16), { tone: "lo" });
s.solid(cylinder(55, -23, 2, 20, 9, s.P, 16));
// Ink pad with its felt, and the approval stamp standing beside it.
const pad = { x: 22, y: 12, w: 34, d: 28, r: 3 };
s.halo(pad, 0);
s.solid(slabOf(pad, 0, 4, s.P, 3, 0.4), { tone: "lo" });
s.line(planOutline(insetPlan(pad, 4), 4, s.P, 2), { tone: "mid" });
const stamp = { x: 62, y: 16, w: 20, d: 20, r: 2 };
s.halo(stamp, 0);
s.solid(slabOf(insetPlan(stamp, 1.5), 0, 2, s.P, 2), { tone: "lo" });
s.solid(slabOf(stamp, 2, 9, s.P, 3, 0.8));
s.solid(cylinder(72, 26, 2.5, 11, 9, s.P, 16), { tone: "lo" });
s.solid(cylinder(72, 26, 6, 20, 6, s.P, 32, 1.6));

export const drawing = cardDrawing(s);
