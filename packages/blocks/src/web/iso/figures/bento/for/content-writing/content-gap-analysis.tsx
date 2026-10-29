import { boxCorners, lineOnTop, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, faceLine, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Content gap analysis: a bookshelf. Your published pieces stand in a row,
 * and the scan finds the gap where a topic is missing; the new piece to
 * write (the lit book) lies on the bench in front of it, ready to fill it.
 */

const PLATE = { x: -96, y: -46, w: 192, d: 92, r: 8 };
const BACK = { x: -86, y: -30, w: 172, d: 6, r: 1.5 };
const SHELF_H = 56;
const BASE = { x: -86, y: -24, w: 172, d: 32, r: 2 };
const BASE_H = 6;
const BOOK_Y = BASE.y + 3;
const BOOK_D = 26;
// [x, width, height] of each book; the gap sits between -2 and 14.
const BOOKS: [number, number, number][] = [
	[-80, 10, 40],
	[-69, 8, 34],
	[-60, 12, 44],
	[-47, 9, 38],
	[-37, 11, 42],
	[-25, 8, 32],
	[-16, 12, 40],
	[16, 10, 38],
	[27, 12, 44],
	[40, 8, 34],
	[49, 11, 40],
	[61, 9, 36],
	[71, 9, 42],
];
const NEW = { x: -6, y: 18, w: 24, d: 18, r: 1.5 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[BACK.x, BACK.y, SHELF_H],
]);

benchPlate(s, PLATE);
// Back panel, shelf board and end panels.
s.halo(BASE, 0);
s.solid(slabOf(BACK, 0, SHELF_H, s.P, 3, 0.6), { tone: "lo" });
s.solid(slabOf(BASE, 0, BASE_H, s.P, 3, 0.6));
s.solid(
	slabOf(
		{ x: BACK.x, y: BASE.y, w: 4, d: BASE.d, r: 1 },
		BASE_H,
		SHELF_H - BASE_H,
		s.P,
		2
	)
);
const spine = BOOK_Y + BOOK_D;
for (const [x, w, h] of BOOKS) {
	s.solid(
		slabOf({ x, y: BOOK_Y, w, d: BOOK_D, r: 0.8 }, BASE_H, h, s.P, 2, 0.3),
		{
			crease: "none",
		}
	);
	for (const band of [5, h - 6]) {
		s.line(faceLine(s, "y", spine, x + 1.5, x + w - 1.5, BASE_H + band), {
			tone: "faint",
		});
	}
}
s.solid(
	slabOf(
		{ x: BACK.x + BACK.w - 4, y: BASE.y, w: 4, d: BASE.d, r: 1 },
		BASE_H,
		SHELF_H - BASE_H,
		s.P,
		2
	)
);
screws(
	s,
	[
		[BASE.x + 8, BASE.y + BASE.d - 3],
		[BASE.x + BASE.w - 8, BASE.y + BASE.d - 3],
	],
	BASE_H,
	1.2
);
// The suggested new piece, lying in front of the gap.
s.halo(NEW, 0);
s.solid(slabOf(NEW, 0, 7, s.P, 2, 0.4), { lit: true, crease: "none" });
s.line(
	lineOnTop([NEW.x + 4, NEW.y + 6], [NEW.x + NEW.w - 4, NEW.y + 6], 7, s.P),
	{
		tone: "mid",
	}
);

export const drawing = cardDrawing(s);
