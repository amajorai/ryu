import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Job description and rubric drafting: a clipboard holding the draft. The top
 * of the sheet is the description as rule lines; below it the scorecard, one
 * row of rating boxes per criterion. The pencil drafting it lies alongside
 * (the lit part).
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const BOARD = { x: -74, y: -42, w: 104, d: 88, r: 6 };
const BOARD_H = 3;
const SHEET = { x: -68, y: -30, w: 92, d: 70, r: 1 };
const TOP = BOARD_H + 1;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 18]]);

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 0.6));
s.solid(slabOf(SHEET, BOARD_H, 1, s.P, 2), { crease: "none" });
// The description: a heading then body lines.
const lengths = [52, 80, 72, 78, 44];
lengths.forEach((length, i) => {
	const y = SHEET.y + 7 + i * 6;
	s.line(lineOnTop([SHEET.x + 6, y], [SHEET.x + 6 + length, y], TOP, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
});
// The scorecard: criterion line plus five rating boxes per row.
for (let row = 0; row < 4; row++) {
	const y = SHEET.y + 40 + row * 7.5;
	s.line(lineOnTop([SHEET.x + 6, y + 2], [SHEET.x + 34, y + 2], TOP, s.P), {
		tone: "lo",
	});
	const boxes = Array.from({ length: 5 }, (_, k) =>
		planOutline({ x: SHEET.x + 42 + k * 9, y, w: 5, d: 5, r: 0.5 }, TOP, s.P, 1)
	);
	s.line(boxes.join(""), { tone: "mid" });
}
// The clip across the top edge, with its two rivets.
const clip = { x: -46, y: -46, w: 48, d: 14, r: 3 };
s.solid(slabOf(clip, BOARD_H, 5, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(insetPlan(clip, 6), BOARD_H + 5, 3, s.P, 3, 0.4));
for (const x of [clip.x + 4, clip.x + clip.w - 4]) {
	s.solid(cylinder(x, clip.y + 7, 1.6, BOARD_H + 5, 0.8, s.P, 12));
}
// The pencil: body, ferrule and eraser, lying beside the board.
const PX = 46;
s.halo({ x: PX - 2, y: -38, w: 12, d: 82, r: 4 }, 0);
s.solid(slabOf({ x: PX, y: -36, w: 8, d: 6, r: 1 }, 0, 8, s.P, 2), {
	tone: "lo",
});
s.solid(slabOf({ x: PX, y: -30, w: 8, d: 4, r: 0.5 }, 0, 8, s.P, 2));
s.solid(slabOf({ x: PX, y: -26, w: 8, d: 58, r: 1 }, 0, 8, s.P, 2), {
	lit: true,
});
s.solid(slabOf({ x: PX + 2, y: 32, w: 4, d: 8, r: 1.5 }, 2, 4, s.P, 2));

export const drawing = cardDrawing(s);
