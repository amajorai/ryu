import {
	boxCorners,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Document prep: a desk sorter holding the standard templates upright, each
 * with its index tab. The drafted checklist lies in front for your review,
 * pinned under a clip: the lit sheet.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const SORTER = { x: -84, y: -42, w: 72, d: 62, r: 4 };
const SORTER_H = 6;
const SHEET = { x: 4, y: -32, w: 56, d: 70, r: 1 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(SORTER, 0, SORTER_H + 48),
]);

benchPlate(s, PLATE);
s.halo(SORTER, 0);
s.solid(slabOf(SORTER, 0, SORTER_H, s.P, 6, 0.8));
// Three template boards, tallest at the back, each with its own tab.
const boards = [
	{ y: -36, h: 44, tab: -74 },
	{ y: -18, h: 34, tab: -56 },
	{ y: 0, h: 24, tab: -38 },
];
for (const { y, h, tab } of boards) {
	s.solid(
		slabOf(
			{ x: SORTER.x + 4, y, w: SORTER.w - 8, d: 2.4, r: 0.4 },
			SORTER_H,
			h,
			s.P,
			1
		)
	);
	s.solid(
		slabOf({ x: tab, y, w: 14, d: 2.4, r: 0.4 }, SORTER_H + h, 4, s.P, 1),
		{
			tone: "lo",
		}
	);
	faceRules(s, "y", y + 2.4, SORTER.x + 10, SORTER_H + h - 6, [40, 30, 46], 5);
}
screws(
	s,
	[
		[SORTER.x + 6, SORTER.y + SORTER.d - 6],
		[SORTER.x + SORTER.w - 6, SORTER.y + SORTER.d - 6],
	],
	SORTER_H,
	1.3
);
// The checklist: boxes down the left, some ticked, rule lines beside them.
s.halo(SHEET, 0);
s.solid(slabOf(SHEET, 0, 1.4, s.P, 2), { lit: true, crease: "none" });
const top = 1.4;
for (let i = 0; i < 5; i++) {
	const y = SHEET.y + 18 + i * 10;
	const box = { x: SHEET.x + 6, y: y - 3, w: 6, d: 6, r: 0.5 };
	s.line(planOutline(box, top, s.P, 1), { tone: "mid" });
	if (i < 3) {
		s.line(
			lineOnTop([box.x + 1.2, y], [box.x + 2.6, y + 2], top, s.P) +
				lineOnTop([box.x + 2.6, y + 2], [box.x + 5, y - 2.4], top, s.P),
			{ tone: "hi" }
		);
	}
	const length = [34, 28, 38, 24, 30][i] ?? 30;
	s.line(lineOnTop([SHEET.x + 16, y], [SHEET.x + 16 + length, y], top, s.P), {
		tone: "lo",
	});
}
// Clip across the head of the sheet.
s.solid(
	slabOf(
		{ x: SHEET.x + 14, y: SHEET.y - 2, w: 28, d: 9, r: 2 },
		top,
		3,
		s.P,
		3
	),
	{
		tone: "lo",
	}
);
s.solid(
	slabOf(
		{ x: SHEET.x + 22, y: SHEET.y + 1, w: 12, d: 3, r: 1.5 },
		top + 3,
		2,
		s.P,
		3
	)
);

export const drawing = cardDrawing(s);
