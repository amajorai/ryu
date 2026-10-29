import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceLine, faceRect, knob } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Tax research: a reference shelf between bookends, with a card catalogue
 * beside it. One volume has been drawn out of the row (the lit book): the
 * rule the answer quotes, from the source it came from.
 */

const PLATE = { x: -98, y: -46, w: 196, d: 92, r: 8 };
const SHELF = { x: -84, y: -28, w: 118, d: 36, r: 3 };
const SHELF_H = 4;
const BOOK_D = 30;
const PULLED = 5;
const PULL = 18;
// Book widths and heights, left to right.
const BOOKS: [number, number][] = [
	[9, 34],
	[7, 30],
	[10, 36],
	[8, 28],
	[11, 33],
	[9, 31],
	[7, 27],
	[10, 35],
];
const CATALOG = { x: 48, y: -24, w: 34, d: 40, r: 3 };
const CATALOG_H = 22;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[SHELF.x, SHELF.y, SHELF_H + 42],
]);

function bookend(x: number) {
	const plan = { x, y: SHELF.y + 2, w: 3, d: BOOK_D + 2, r: 0.6 };
	s.solid(slabOf(plan, SHELF_H, 40, s.P, 2, 0.4), { tone: "lo" });
}

function book(x: number, width: number, height: number, pulled: boolean) {
	const y = SHELF.y + 3 + (pulled ? PULL : 0);
	s.solid(
		slabOf({ x, y, w: width, d: BOOK_D, r: 1 }, SHELF_H, height, s.P, 3, 0.4),
		{ lit: pulled }
	);
	const front = y + BOOK_D;
	for (const z of [SHELF_H + 5, SHELF_H + height - 5]) {
		s.line(faceLine(s, "y", front, x + 1.5, x + width - 1.5, z), {
			tone: "faint",
			free: true,
		});
	}
}

benchPlate(s, PLATE);
s.halo(SHELF, 0);
s.solid(slabOf(SHELF, 0, SHELF_H, s.P, 4, 0.6));
bookend(SHELF.x + 3);
let x = SHELF.x + 7;
const starts: number[] = [];
for (const [width] of BOOKS) {
	starts.push(x);
	x += width + 0.6;
}
BOOKS.forEach(([width, height], index) => {
	if (index !== PULLED) {
		book(starts[index] ?? 0, width, height, false);
	}
});
bookend(x + 0.4);
const [pulledWidth, pulledHeight] = BOOKS[PULLED] ?? [9, 31];
book(starts[PULLED] ?? 0, pulledWidth, pulledHeight, true);
// The card catalogue: two drawers with pulls.
s.halo(CATALOG, 0);
s.solid(slabOf(CATALOG, 0, CATALOG_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(CATALOG, 4), CATALOG_H, s.P, 3), {
	tone: "faint",
});
const face = CATALOG.y + CATALOG.d;
for (const [z0, z1] of [
	[3, 10],
	[12, 19],
] as const) {
	s.line(
		faceRect(s, "y", face, CATALOG.x + 5, CATALOG.x + CATALOG.w - 5, z0, z1),
		{
			tone: "lo",
		}
	);
}
knob(s, [CATALOG.x + 12, CATALOG.y + 14], CATALOG_H, 4, 4);

export const drawing = cardDrawing(s);
