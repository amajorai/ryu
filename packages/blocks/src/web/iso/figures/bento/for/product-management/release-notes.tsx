import {
	boxCorners,
	coil,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Release notes: a binding bench. Merged work waits in three pigeonhole
 * trays (features, fixes, improvements); the pages are bound into a spiral
 * booklet in the same three sections, ready to hand to customers, with its
 * ribbon (lit) marking the new release.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const BOOK = { x: -20, y: -30, w: 96, d: 70, r: 2 };
const PAGES = 6;
const PAGE_H = 1;
const BOOK_TOP = PAGES * PAGE_H + 2;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-60, -40, 30]]);

/** One sorting tray with a short stack of sheets. */
function tray(y: number, sheets: number) {
	const plan = { x: -84, y, w: 44, d: 26, r: 2 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, 4, s.P, 3, 0.4), { tone: "lo" });
	for (let i = 0; i < sheets; i++) {
		s.solid(
			slabOf(
				{ x: -78 + (i % 2), y: y + 4, w: 32, d: 18, r: 0.5 },
				3 + i * 1.6,
				1.6,
				s.P,
				1
			),
			{ crease: "none" }
		);
	}
	const top = 3 + sheets * 1.6;
	s.line(lineOnTop([-72, y + 9], [-56, y + 9], top, s.P), { tone: "mid" });
	s.line(lineOnTop([-72, y + 13], [-60, y + 13], top, s.P), { tone: "faint" });
}

benchPlate(s, PLATE);
// Pigeonhole back stop behind the three trays.
s.solid(slabOf({ x: -88, y: -48, w: 52, d: 6, r: 1 }, 0, 24, s.P, 2, 0.4));
s.line(faceRect(s, "y", -42, -80, -44, 14, 20), { tone: "lo" });
tray(-40, 4);
tray(-12, 2);
tray(16, 3);
// The booklet: cover, page block, spiral along the back edge.
const spiral = coil(
	BOOK.x + 4,
	BOOK.x + BOOK.w - 4,
	[BOOK.y + 3, 5],
	5,
	16,
	"x",
	s.P,
	12
);
s.line(spiral.back, { tone: "lo" });
s.halo(BOOK, 0);
s.solid(slabOf(BOOK, 0, 2, s.P, 2, 0.4), { tone: "lo" });
for (let i = 0; i < PAGES; i++) {
	s.solid(
		slabOf(
			{ x: BOOK.x + 2, y: BOOK.y + 8, w: BOOK.w - 4, d: BOOK.d - 10, r: 1 },
			2 + i * PAGE_H,
			PAGE_H,
			s.P,
			2
		),
		{ crease: "none" }
	);
}
for (const [y, rules] of [
	[BOOK.y + 16, [56, 42, 50]],
	[BOOK.y + 36, [48, 36]],
	[BOOK.y + 52, [52, 30]],
] as const) {
	s.line(lineOnTop([BOOK.x + 10, y], [BOOK.x + 40, y], BOOK_TOP, s.P), {
		tone: "mid",
	});
	rules.forEach((width, index) => {
		const at = y + 4 + index * 3.6;
		s.line(
			lineOnTop([BOOK.x + 14, at], [BOOK.x + 14 + width, at], BOOK_TOP, s.P),
			{ tone: "faint" }
		);
	});
}
s.line(spiral.front, { tone: "mid" });
// Ribbon marker hanging out over the front edge.
s.solid(
	slabOf(
		{ x: BOOK.x + BOOK.w - 20, y: BOOK.y + 30, w: 7, d: 46, r: 0.5 },
		BOOK_TOP,
		1,
		s.P,
		1
	),
	{ lit: true, crease: "none" }
);

export const drawing = cardDrawing(s);
