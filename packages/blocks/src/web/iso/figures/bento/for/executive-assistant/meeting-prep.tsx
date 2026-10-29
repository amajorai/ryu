import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Meeting prep: a clipboard. Under its clip, the attendee card, the recent
 * threads and the agenda are squared into one stack, topped by the one-page
 * brief with its heading bar (the lit part). The card file beside it is
 * where the attendee background came from.
 */

const PLATE = { x: -96, y: -52, w: 192, d: 104, r: 8 };
const BOARD = { x: -74, y: -40, w: 92, d: 82, r: 4 };
const BOARD_H = 4;
const SHEET = { x: BOARD.x + 8, y: BOARD.y + 14, w: 76, d: 62, r: 1 };
const CLIP = { x: BOARD.x + 26, y: BOARD.y + 4, w: 40, d: 14, r: 3 };
const FILE = { x: 34, y: -34, w: 40, d: 46, r: 3 };
const FILE_H = 22;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, -40, 26]]);

benchPlate(s, PLATE);
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, BOARD_H, s.P, 4, 0.8));
// The three sources, a little out of square, then the brief on top.
let z = BOARD_H;
for (const [dx, dy] of [
	[3, 3],
	[-2, 1],
	[1, -1],
] as const) {
	s.solid(
		slabOf({ ...SHEET, x: SHEET.x + dx, y: SHEET.y + dy }, z, 1.2, s.P, 2),
		{
			crease: "none",
		}
	);
	z += 1.2;
}
s.solid(slabOf(SHEET, z, 1.2, s.P, 2), { crease: "none" });
z += 1.2;
s.solid(
	slabOf(
		{ x: SHEET.x + 8, y: SHEET.y + 14, w: 44, d: 5, r: 1 },
		z,
		1.4,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
for (const [i, span] of [60, 48, 56, 40, 30].entries()) {
	const y = SHEET.y + 28 + i * 7;
	s.line(lineOnTop([SHEET.x + 8, y], [SHEET.x + 8 + span, y], z, s.P), {
		tone: "lo",
	});
}
// The clip over the stack's top edge, with its lever and rivets.
s.solid(slabOf(CLIP, BOARD_H, 9, s.P, 4, 0.6));
s.line(planOutline(insetPlan(CLIP, 3), BOARD_H + 9, s.P, 2), { tone: "faint" });
s.solid(cylinder(CLIP.x + 8, CLIP.y + 7, 3, BOARD_H + 9, 4, s.P, 20), {
	tone: "lo",
});
s.solid(cylinder(CLIP.x + CLIP.w - 8, CLIP.y + 7, 3, BOARD_H + 9, 4, s.P, 20), {
	tone: "lo",
});
s.solid(
	slabOf(
		{ x: CLIP.x + 6, y: CLIP.y + 5, w: CLIP.w - 12, d: 4, r: 1.5 },
		BOARD_H + 13,
		3,
		s.P,
		2
	)
);
// Card file of attendee backgrounds: cards standing in an open box.
s.halo(FILE, 0);
s.solid(slabOf(FILE, 0, FILE_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(FILE, 3), FILE_H, s.P, 3), { tone: "lo" });
for (let i = 0; i < 4; i++) {
	s.solid(
		slabOf(
			{ x: FILE.x + 6, y: FILE.y + 8 + i * 9, w: FILE.w - 12, d: 2, r: 0.4 },
			FILE_H,
			4 - (i % 2) * 2,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
faceRules(s, "y", FILE.y + FILE.d, FILE.x + 10, 15, [20], 4);
screws(s, [[BOARD.x + 6, BOARD.y + BOARD.d - 6]], BOARD_H, 1.3);

export const drawing = cardDrawing(s);
