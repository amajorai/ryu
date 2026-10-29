import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Hosted Skills: a book rack of bound manuals between two bookends. Each
 * manual is a Skill; the last one is pulled forward (the lit book), ready to
 * be read by whichever client asks for it.
 */

const PLATE = { x: -80, y: -46, w: 160, d: 92, r: 8 };
const SHELF = { x: -60, y: -28, w: 110, d: 44, r: 3 };
const SHELF_H = 5;
const BOOKS: [number, number][] = [
	[8, 44],
	[10, 38],
	[7, 46],
	[9, 34],
	[12, 42],
	[8, 40],
	[10, 36],
	[7, 44],
];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(SHELF, 0, SHELF_H + 48),
]);

function bookend(x: number) {
	s.solid(
		slabOf({ x, y: SHELF.y + 2, w: 5, d: 30, r: 1 }, SHELF_H, 50, s.P, 3)
	);
}

benchPlate(s, PLATE);
s.halo(SHELF, 0);
s.solid(slabOf(SHELF, 0, SHELF_H, s.P, 4, 0.6), { tone: "lo" });
screws(
	s,
	[
		[SHELF.x + 6, SHELF.y + SHELF.d - 6],
		[SHELF.x + SHELF.w - 6, SHELF.y + 6],
	],
	SHELF_H,
	1.3
);
bookend(SHELF.x + 3);
let x = SHELF.x + 9;
for (const [w, h] of BOOKS) {
	const book = { x, y: SHELF.y + 4, w, d: 28, r: 1 };
	s.solid(slabOf(book, SHELF_H, h, s.P, 3, 0.4));
	s.line(
		lineOnTop([x + 1.5, book.y + 2], [x + 1.5, book.y + 26], SHELF_H + h, s.P),
		{ tone: "faint" }
	);
	x += w + 1;
}
// The pulled manual: forward of the row, cover rules on its top edge.
const pulled = { x: x + 1, y: SHELF.y + 14, w: 11, d: 28, r: 1 };
s.solid(slabOf(pulled, SHELF_H, 48, s.P, 3, 0.4), { lit: true });
s.line(planOutline(insetPlan(pulled, 2.5), SHELF_H + 48, s.P, 2), {
	tone: "mid",
});
bookend(pulled.x + pulled.w + 2);

export const drawing = cardDrawing(s);
