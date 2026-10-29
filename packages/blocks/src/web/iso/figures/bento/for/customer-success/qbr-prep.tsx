import {
	boxCorners,
	coil,
	insetPlan,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * QBR prep: a collating stand. Four stepped trays hold the four parts of the
 * review (adoption, value delivered, open issues, next-quarter plan); they
 * are gathered into the spiral-bound book in front, whose plan tab sticks
 * out as the lit part.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const STAND_X = -86;
const STAND_W = 84;
const TIER_D = 20;
const BOOK = { x: 10, y: -34, w: 70, d: 76, r: 2 };
const BOOK_H = 7;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [STAND_X, -44, 44]]);

function tier(index: number) {
	const height = 40 - index * 9;
	const plan = {
		x: STAND_X,
		y: -44 + index * TIER_D,
		w: STAND_W,
		d: TIER_D,
		r: 2,
	};
	s.solid(slabOf(plan, 0, height, s.P, 3, 0.6));
	const sheet = insetPlan({ ...plan, d: TIER_D - 2 }, 4);
	s.solid(slabOf(sheet, height, 1, s.P, 2), { crease: "none" });
	for (const [i, length] of [50, 36].entries()) {
		const y = sheet.y + 4 + i * 5;
		s.line(
			lineOnTop([sheet.x + 5, y], [sheet.x + 5 + length, y], height + 1, s.P),
			{ tone: i === 0 ? "mid" : "lo" }
		);
	}
}

benchPlate(s, PLATE);
s.halo({ x: STAND_X, y: -44, w: STAND_W, d: TIER_D * 4, r: 2 }, 0);
for (let i = 0; i < 4; i++) {
	tier(i);
}
// The bound review, spine wire along its back edge.
s.halo(BOOK, 0);
const wire = coil(
	BOOK.x + 5,
	BOOK.x + BOOK.w - 5,
	[BOOK.y + 3, BOOK_H],
	3.2,
	11,
	"x",
	s.P
);
s.line(wire.back, { tone: "lo" });
s.solid(slabOf(BOOK, 0, BOOK_H, s.P, 3, 0.6));
s.line(
	lineOnTop([BOOK.x + 8, BOOK.y + 18], [BOOK.x + 40, BOOK.y + 18], BOOK_H, s.P),
	{
		tone: "mid",
	}
);
s.line(
	lineOnTop([BOOK.x + 8, BOOK.y + 24], [BOOK.x + 30, BOOK.y + 24], BOOK_H, s.P),
	{
		tone: "lo",
	}
);
s.line(wire.front, { tone: "mid" });
// Section tabs stick out of the side, the plan's tab nearest and lit.
for (const [i, y] of [
	BOOK.y + 14,
	BOOK.y + 30,
	BOOK.y + 46,
	BOOK.y + 62,
].entries()) {
	s.solid(
		slabOf(
			{ x: BOOK.x + BOOK.w, y, w: i === 3 ? 14 : 9, d: 12, r: 1 },
			1.5 + i * 1.2,
			i === 3 ? 1.6 : 1,
			s.P,
			2
		),
		{ lit: i === 3, tone: "lo", crease: "none" }
	);
}

export const drawing = cardDrawing(s);
