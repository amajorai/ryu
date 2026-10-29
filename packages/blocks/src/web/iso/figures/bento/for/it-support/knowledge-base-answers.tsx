import {
	boxCorners,
	insetPlan,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceLine } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Knowledge base answers: the IT wiki as a shelf of manuals between two
 * bookends. One has been taken down and lies open in front (the lit pages),
 * its gap still showing on the shelf, so the answer points back to where it
 * came from.
 */

const PLATE = { x: -96, y: -56, w: 154, d: 112, r: 8 };
const SHELF = { x: -86, y: -48, w: 132, d: 40, r: 3 };
const SHELF_H = 4;
const BOOK_Y = SHELF.y + 4;
const BOOK_D = 32;
const BOOKS: [number, number][] = [
	[9, 38],
	[7, 34],
	[10, 40],
	[8, 36],
	[0, 0],
	[9, 42],
	[7, 33],
	[10, 38],
	[8, 35],
	[9, 40],
	[7, 32],
];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-60, -20, 50]]);

function bookend(x: number) {
	s.solid(
		slabOf({ x, y: SHELF.y + 2, w: 4, d: 36, r: 1 }, SHELF_H, 30, s.P, 2)
	);
}

benchPlate(s, PLATE);
s.halo(SHELF, 0);
s.solid(slabOf(SHELF, 0, SHELF_H, s.P, 4, 0.6), { tone: "lo" });
bookend(SHELF.x + 3);
let x = SHELF.x + 8;
for (const [width, height] of BOOKS) {
	if (width > 0) {
		const top = SHELF_H + height;
		s.solid(
			slabOf(
				{ x, y: BOOK_Y, w: width, d: BOOK_D, r: 1 },
				SHELF_H,
				height,
				s.P,
				2
			)
		);
		const front = BOOK_Y + BOOK_D;
		s.line(faceLine(s, "y", front, x + 1.5, x + width - 1.5, top - 5), {
			tone: "lo",
		});
		s.line(faceLine(s, "y", front, x + 1.5, x + width - 1.5, SHELF_H + 6), {
			tone: "lo",
		});
	}
	x += (width || 9) + 1.5;
}
bookend(x);
// The open manual lying in front: cover and two page blocks.
const COVER = { x: -48, y: 2, w: 96, d: 46, r: 2 };
s.halo(COVER, 0);
s.solid(slabOf(COVER, 0, 2, s.P, 3), { tone: "lo" });
const PAGE_W = (COVER.w - 6) / 2;
const left = {
	x: COVER.x + 2,
	y: COVER.y + 2,
	w: PAGE_W,
	d: COVER.d - 4,
	r: 1,
};
const right = { ...left, x: COVER.x + 4 + PAGE_W };
for (const page of [left, right]) {
	s.solid(slabOf(page, 2, 3, s.P, 2), { lit: true, crease: "none" });
	const area = insetPlan(page, 5);
	for (let i = 0; i < 5; i++) {
		const y = area.y + 2 + i * 6.5;
		const end = area.x + area.w - (i % 2 ? 6 : 0);
		s.line(lineOnTop([area.x, y], [end, y], 5, s.P), { tone: "mid" });
	}
}
export const drawing = cardDrawing(s);
