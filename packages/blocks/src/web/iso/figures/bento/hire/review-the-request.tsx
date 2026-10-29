import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, jack, lamp } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Review the request: a clipboard holding the run's request sheet. Each row
 * is one connection it asks for (a socket and its line), each with an unlit
 * check lamp. Beside it stands the approval stamp, its face inked (the lit
 * part): nothing runs until you press it.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const BOARD = { x: -78, y: -40, w: 96, d: 80, r: 5 };
const BOARD_H = 4;
const SHEET = insetPlan({ ...BOARD, y: BOARD.y + 12, d: BOARD.d - 12 }, 6);
const SHEET_TOP = BOARD_H + 1;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [56, 10, 34]]);

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 6, 0.6));
s.solid(slabOf(SHEET, BOARD_H, 1, s.P, 3), { crease: "none" });
// The spring clip across the head of the board.
const clip = { x: BOARD.x + 26, y: BOARD.y + 3, w: 44, d: 10, r: 3 };
s.solid(slabOf(clip, BOARD_H, 5, s.P, 4, 0.6), { tone: "lo" });
s.solid(cylinder(BOARD.x + 48, BOARD.y + 8, 3, BOARD_H + 5, 3, s.P, 20));
for (const [i, span] of [40, 32, 44, 26].entries()) {
	const y = SHEET.y + 10 + i * 13;
	jack(s, [SHEET.x + 8, y], SHEET_TOP);
	s.line(
		lineOnTop([SHEET.x + 16, y], [SHEET.x + 16 + span, y], SHEET_TOP, s.P),
		{ tone: i === 0 ? "mid" : "lo" }
	);
	lamp(s, [SHEET.x + SHEET.w - 8, y], SHEET_TOP, { radius: 1.8 });
}
// Approval stamp: an inked pad on a block, with a turned handle.
const inkPad = { x: 34, y: -22, w: 40, d: 30, r: 3 };
s.halo(inkPad, 0);
s.solid(slabOf(inkPad, 0, 4, s.P, 4, 0.6), { tone: "lo" });
const head = { x: 40, y: 8, w: 28, d: 20, r: 3 };
s.halo(head, 0);
s.solid(slabOf(head, 0, 4, s.P, 4), { lit: true });
s.solid(slabOf(insetPlan(head, 2), 4, 10, s.P, 4, 0.6));
s.solid(cylinder(54, 18, 3, 14, 7, s.P, 24));
s.solid(cylinder(54, 18, 6, 21, 3, s.P, 32, 0.6), { tone: "lo" });
s.solid(cylinder(54, 18, 9, 24, 6, s.P, 32, 2));

export const drawing = cardDrawing(s);
