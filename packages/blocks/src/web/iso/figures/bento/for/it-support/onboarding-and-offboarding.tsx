import {
	boxCorners,
	cylinder,
	dotGrid,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Onboarding and offboarding: a clipboard beside the laptop being issued (or
 * handed back). The sheet lists account, access and device, each with a tick
 * box; the first two are ticked, and the device box (lit) is the step left.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const BOARD = { x: -84, y: -40, w: 72, d: 86, r: 4 };
const SHEET = insetPlan(BOARD, 5);
const BASE = { x: 2, y: -12, w: 82, d: 50, r: 3 };
const LID_H = 46;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[40, -16, LID_H + 4],
]);

benchPlate(s, PLATE);
// Clipboard: board, sheet, and the spring clip along the top edge.
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, 3, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf(SHEET, 3, 0.8, s.P, 2), { crease: "none" });
const clip = { x: BOARD.x + 18, y: BOARD.y - 3, w: 36, d: 12, r: 2 };
s.solid(slabOf(clip, 3.8, 3, s.P, 3, 0.4));
s.solid(cylinder(BOARD.x + 36, BOARD.y + 3, 3.4, 6.8, 2, s.P, 20), {
	tone: "lo",
});
for (let row = 0; row < 3; row++) {
	const y = SHEET.y + 22 + row * 18;
	const box = { x: SHEET.x + 5, y: y - 4, w: 8, d: 8, r: 1 };
	const lit = row === 2;
	s.solid(slabOf(box, 3.8, 1.4, s.P, 2), { lit, crease: "none" });
	if (!lit) {
		const top = 5.2;
		s.line(
			lineOnTop(
				[box.x + 1.5, box.y + 4.5],
				[box.x + 3.5, box.y + 6.5],
				top,
				s.P
			) +
				lineOnTop(
					[box.x + 3.5, box.y + 6.5],
					[box.x + 7, box.y + 1.5],
					top,
					s.P
				),
			{ tone: "hi" }
		);
	}
	s.line(lineOnTop([SHEET.x + 18, y - 2], [SHEET.x + 52, y - 2], 3.8, s.P), {
		tone: "mid",
	});
	s.line(lineOnTop([SHEET.x + 18, y + 2], [SHEET.x + 40, y + 2], 3.8, s.P), {
		tone: "faint",
	});
}
// Laptop: lid standing open at the back, then the keyboard base.
const lid = { x: BASE.x + 2, y: BASE.y - 4, w: BASE.w - 4, d: 4, r: 1 };
s.halo(BASE, 0);
s.solid(slabOf(lid, 0, LID_H, s.P, 3, 0.4));
s.line(
	faceRect(s, "y", lid.y + lid.d, lid.x + 5, lid.x + lid.w - 5, 9, LID_H - 5),
	{
		tone: "lo",
	}
);
s.solid(slabOf(BASE, 0, 5, s.P, 4, 0.6));
s.dots(dotGrid(BASE.x + 10, BASE.y + 7, 12, 4, 5.5, 5, s.P), {
	size: 0.9,
	tone: "lo",
});
s.line(
	planOutline(
		{ x: BASE.x + 28, y: BASE.y + 32, w: 26, d: 13, r: 1.5 },
		5,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);
lamp(s, [BASE.x + BASE.w - 7, BASE.y + 38], 5, { radius: 1.4 });

export const drawing = cardDrawing(s);
