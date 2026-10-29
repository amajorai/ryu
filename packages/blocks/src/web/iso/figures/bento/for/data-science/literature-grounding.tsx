import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Literature grounding: a shelf of papers between bookends. To answer a
 * question, one volume has been drawn forward out of the row with a slip
 * marking the page that backs the claim (the lit volume); the card box of
 * internal notes stands beside the shelf.
 */

const PLATE = { x: -92, y: -44, w: 184, d: 88, r: 8 };
const SHELF = { x: -82, y: -34, w: 106, d: 30, r: 3 };
const SHELF_H = 4;
const PULLED = 4;
const BOOKS: [number, number][] = [
	[11, 36],
	[9, 32],
	[12, 42],
	[10, 34],
	[11, 40],
	[9, 30],
	[12, 38],
	[10, 34],
];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-80, -30, 50]]);

function book(
	x: number,
	y: number,
	thick: number,
	height: number,
	lit = false
) {
	const plan = { x, y, w: thick, d: 24, r: 1 };
	s.solid(slabOf(plan, SHELF_H, height, s.P, 2, 0.4), { lit });
	s.line(
		faceRect(
			s,
			"y",
			y + 24,
			x + 1.5,
			x + thick - 1.5,
			SHELF_H + height - 8,
			SHELF_H + height - 4
		),
		{
			tone: lit ? "mid" : "faint",
		}
	);
}

benchPlate(s, PLATE);
s.halo(SHELF, 0);
s.solid(slabOf(SHELF, 0, SHELF_H, s.P, 4, 0.6));
// Back bookend.
s.solid(
	slabOf(
		{ x: SHELF.x + 2, y: SHELF.y + 3, w: 4, d: 24, r: 1 },
		SHELF_H,
		40,
		s.P,
		2
	)
);
let x = SHELF.x + 8;
let pulled: [number, number, number] = [0, 0, 0];
BOOKS.forEach(([thick, height], index) => {
	if (index === PULLED) {
		pulled = [x, thick, height];
	} else {
		book(x, SHELF.y + 3, thick, height);
	}
	x += thick + 1;
});
// Front bookend.
s.solid(slabOf({ x, y: SHELF.y + 3, w: 4, d: 24, r: 1 }, SHELF_H, 26, s.P, 2));
// The drawn volume, pulled forward to overhang the shelf, with its slip.
const [px, thick, height] = pulled;
book(px, SHELF.y + 14, thick, height, true);
s.solid(
	slabOf(
		{ x: px + thick / 2 - 0.6, y: SHELF.y + 20, w: 1.2, d: 8, r: 0.3 },
		SHELF_H + height,
		6,
		s.P,
		2
	),
	{ tone: "hi", crease: "none" }
);
// Card box of internal notes, with tabbed cards standing in it.
const BOX = { x: 34, y: 0, w: 48, d: 36, r: 3 };
s.halo(BOX, 0);
s.solid(slabOf(BOX, 0, 16, s.P, 4, 0.6));
s.line(planOutline(insetPlan(BOX, 3), 16, s.P, 3), { tone: "lo" });
for (let i = 0; i < 5; i++) {
	const cy = BOX.y + 7 + i * 5.5;
	s.solid(
		slabOf(
			{ x: BOX.x + 6, y: cy, w: 32, d: 1.4, r: 0.3 },
			16,
			6 + (i % 2) * 3,
			s.P,
			2
		),
		{ crease: "none" }
	);
}

export const drawing = cardDrawing(s);
