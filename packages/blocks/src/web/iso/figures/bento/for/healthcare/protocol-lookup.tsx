import { boxCorners, lineOnTop, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Protocol lookup: a shelf of your own guideline binders between bookends.
 * The binder that answers the question is pulled forward, and the slip
 * marking the quoted passage stands out of its top (the lit part); the
 * answer page lies open on the bench beside the shelf.
 */

const PLATE = { x: -104, y: -50, w: 208, d: 100, r: 8 };
const SHELF = { x: -92, y: -38, w: 136, d: 46, r: 3 };
const SHELF_H = 4;
const BINDER = { w: 13, d: 40 };
const BINDERS = [44, 38, 46, 40, 44, 36, 42, 46];
const PULLED = 4;
const PULL = 24;
const PAGE = { x: 54, y: -30, w: 42, d: 66, r: 2 };

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-30, -40, SHELF_H + 60],
]);

const binderX = (i: number) => SHELF.x + 8 + i * (BINDER.w + 2);

benchPlate(s, PLATE);
s.halo(SHELF, 0);
s.solid(slabOf(SHELF, 0, SHELF_H, s.P, 4, 0.6), { tone: "lo" });
// Left bookend, then the binders back to front, then the right bookend.
s.solid(
	slabOf(
		{ x: SHELF.x + 2, y: SHELF.y + 4, w: 4, d: 38, r: 1 },
		SHELF_H,
		34,
		s.P,
		2
	)
);
BINDERS.forEach((height, i) => {
	const pulled = i === PULLED;
	const x = binderX(i);
	const y = SHELF.y + 3 + (pulled ? PULL : 0);
	const plan = { x, y, w: BINDER.w, d: BINDER.d, r: 1.5 };
	s.solid(slabOf(plan, SHELF_H, height, s.P, 3, 0.4), {
		tone: i % 3 === 1 ? "lo" : "mid",
	});
	const spine = y + BINDER.d;
	const top = SHELF_H + height;
	s.line(faceRect(s, "y", spine, x + 3, x + BINDER.w - 3, top - 16, top - 6), {
		tone: "faint",
	});
	s.line(
		faceRect(s, "y", spine, x + 5, x + BINDER.w - 5, SHELF_H + 6, SHELF_H + 9),
		{
			tone: "faint",
		}
	);
	if (pulled) {
		s.solid(
			slabOf({ x: x + 4.5, y: y + 10, w: 4, d: 22, r: 0.5 }, top, 14, s.P, 2),
			{ lit: true, crease: "none" }
		);
	}
});
const endX = binderX(BINDERS.length);
s.solid(
	slabOf({ x: endX, y: SHELF.y + 4, w: 4, d: 38, r: 1 }, SHELF_H, 34, s.P, 2)
);
screws(
	s,
	[
		[SHELF.x + 6, SHELF.y + SHELF.d - 3],
		[SHELF.x + SHELF.w - 6, SHELF.y + SHELF.d - 3],
	],
	SHELF_H,
	1.2
);
// The answer page, with the quoted lines bracketed in the margin.
s.halo(PAGE, 0);
s.solid(slabOf(PAGE, 0, 2, s.P, 3, 0.4), { crease: "none" });
const widths = [30, 24, 28, 26, 30, 18, 26, 22];
widths.forEach((width, i) => {
	const y = PAGE.y + 10 + i * 6.6;
	const quoted = i === 3 || i === 4;
	s.line(lineOnTop([PAGE.x + 6, y], [PAGE.x + 6 + width, y], 2, s.P), {
		tone: quoted ? "mid" : "lo",
	});
});
const qy = PAGE.y + 10 + 3 * 6.6;
s.line(lineOnTop([PAGE.x + 3, qy - 2], [PAGE.x + 3, qy + 8.6], 2, s.P), {
	tone: "hi",
});

export const drawing = cardDrawing(s);
