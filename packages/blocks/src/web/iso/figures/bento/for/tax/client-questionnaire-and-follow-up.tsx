import {
	boxCorners,
	cylinder,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Client questionnaire and follow-up: a clipboard with a checklist, some
 * boxes ticked and some still open, beside a mailbox whose flag is up (the
 * lit part): a follow-up request is out for the missing documents.
 */

const PLATE = { x: -96, y: -48, w: 192, d: 96, r: 8 };
const BOARD = { x: -84, y: -36, w: 84, d: 74, r: 4 };
const SHEET = { x: -78, y: -24, w: 72, d: 56, r: 1 };
const TICKED = 3;
const POST: [number, number] = [52, 0];
const BOX = { x: 26, y: -14, w: 56, d: 28, r: 3 };
const BOX_Z = 26;
const BOX_H = 24;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[66, 14, BOX_Z + BOX_H + 14],
]);

benchPlate(s, PLATE);
// Clipboard: board, sheet, and the spring clip along the top edge.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, 3, s.P, 4, 0.6));
s.solid(slabOf(SHEET, 3, 1, s.P, 2), { crease: "none" });
s.solid(slabOf({ x: -60, y: -40, w: 36, d: 12, r: 2 }, 3, 5, s.P, 3, 0.6), {
	tone: "lo",
});
s.solid(cylinder(-42, -34, 4, 8, 2, s.P, 20));
for (const [i, span] of [44, 36, 40, 30, 38].entries()) {
	const y = SHEET.y + 8 + i * 10;
	const box = { x: SHEET.x + 6, y: y - 3, w: 6, d: 6, r: 0.5 };
	s.line(planOutline(box, 4, s.P, 2), { tone: "mid" });
	if (i < TICKED) {
		s.solid(
			slabOf(
				{ x: box.x + 1.5, y: box.y + 1.5, w: 3, d: 3, r: 0.4 },
				4,
				1,
				s.P,
				2
			),
			{
				tone: "lo",
				crease: "none",
			}
		);
	}
	const end = SHEET.x + 18 + span;
	s.line(lineOnTop([SHEET.x + 18, y], [end, y], 4, s.P), {
		tone: i < TICKED ? "faint" : "lo",
	});
}
// Mailbox on its post.
s.halo({ x: POST[0] - 10, y: POST[1] - 10, w: 20, d: 20, r: 10 }, 0);
s.solid(cylinder(POST[0], POST[1], 9, 0, 2, s.P, 28, 0.4), { tone: "lo" });
screws(
	s,
	[
		[POST[0] - 6, POST[1]],
		[POST[0] + 6, POST[1]],
	],
	2,
	1
);
s.solid(cylinder(POST[0], POST[1], 3, 2, BOX_Z - 2, s.P, 20));
s.solid(slabOf(BOX, BOX_Z, BOX_H, s.P, 4, 0.8));
s.line(
	planOutline(
		{ x: BOX.x + 4, y: BOX.y + 4, w: BOX.w - 8, d: BOX.d - 8, r: 1 },
		BOX_Z + BOX_H,
		s.P,
		2
	),
	{
		tone: "faint",
	}
);
s.line(
	faceRect(
		s,
		"x",
		BOX.x + BOX.w,
		BOX.y + 4,
		BOX.y + BOX.d - 4,
		BOX_Z + 3,
		BOX_Z + BOX_H - 3
	),
	{
		tone: "lo",
	}
);
// A letter waiting in the door, and the raised flag on the near side.
s.solid(
	slabOf(
		{ x: BOX.x + BOX.w, y: -7, w: 5, d: 14, r: 0.5 },
		BOX_Z + 12,
		1.4,
		s.P,
		2
	),
	{ crease: "none" }
);
const flagX = BOX.x + BOX.w - 14;
const near = BOX.y + BOX.d;
s.solid(cylinder(flagX, near + 1.5, 2, BOX_Z + 8, 2, s.P, 16), { tone: "lo" });
s.solid(
	slabOf(
		{ x: flagX - 1, y: near + 0.5, w: 2, d: 2, r: 0.4 },
		BOX_Z + 9,
		24,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: flagX - 13, y: near + 0.6, w: 12, d: 1.8, r: 0.4 },
		BOX_Z + 25,
		8,
		s.P,
		2
	),
	{
		lit: true,
	}
);

export const drawing = cardDrawing(s);
