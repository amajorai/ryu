import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Recurring journal entries: the ledger lies open beside a flip calendar
 * turned to the new period. This period's standard entry (the lit slip) is
 * already drafted onto the right-hand page, and the approval stamp stands on
 * its pad, waiting for the bookkeeper.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const BOOK = { x: -44, y: -34, w: 96, d: 68, r: 3 };
const COVER_H = 3;
const PAGE_H = 4;
const PAGE_Z = COVER_H + PAGE_H;
const CAL = { x: -90, y: -42, w: 36, d: 24, r: 3 };
const PAD = { x: 62, y: 6, w: 30, d: 30, r: 3 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-72, -34, 40]]);

function page(x: number, rows: number[]) {
	const plan = { x, y: BOOK.y + 4, w: 42, d: BOOK.d - 8, r: 1.5 };
	s.solid(slabOf(plan, COVER_H, PAGE_H, s.P, 3, 0.4), { crease: "none" });
	rows.forEach((length, i) => {
		const y = plan.y + 8 + i * 7;
		s.line(lineOnTop([plan.x + 5, y], [plan.x + 5 + length, y], PAGE_Z, s.P), {
			tone: i === 0 ? "mid" : "lo",
		});
	});
}

benchPlate(s, PLATE);
// Flip calendar: a base with a card standing on two rings.
s.halo(CAL, 0);
s.solid(slabOf(CAL, 0, 6, s.P, 4, 0.8), { tone: "lo" });
const card = { x: CAL.x + 4, y: CAL.y + 10, w: CAL.w - 8, d: 3, r: 0.5 };
s.solid(slabOf({ ...card, y: card.y - 3 }, 6, 26, s.P, 2), { tone: "lo" });
s.solid(slabOf(card, 6, 28, s.P, 2));
faceRules(s, "y", card.y + card.d, card.x + 5, 26, [18, 12], 6);
for (const dx of [8, 20]) {
	s.solid(cylinder(card.x + dx, card.y + 1, 2, 33, 2.5, s.P, 16), {
		tone: "lo",
	});
}
// The open ledger: cover, two pages, a spine down the middle.
s.halo(BOOK, 0);
s.solid(slabOf(BOOK, 0, COVER_H, s.P, 4, 0.6), { tone: "lo" });
page(BOOK.x + 4, [30, 24, 32, 20, 28, 26, 18]);
page(BOOK.x + 50, [28, 32, 22, 26]);
s.line(
	lineOnTop(
		[BOOK.x + 48, BOOK.y + 4],
		[BOOK.x + 48, BOOK.y + BOOK.d - 4],
		PAGE_Z,
		s.P
	),
	{
		tone: "mid",
	}
);
s.solid(
	slabOf(
		{ x: BOOK.x + 54, y: BOOK.y + 38, w: 34, d: 14, r: 1.5 },
		PAGE_Z,
		1.6,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// Approval stamp on its ink pad.
s.halo(PAD, 0);
s.solid(slabOf(PAD, 0, 4, s.P, 4, 0.6));
s.solid(
	slabOf({ x: PAD.x + 3, y: PAD.y + 3, w: 24, d: 24, r: 2 }, 4, 1, s.P, 3),
	{
		tone: "lo",
		crease: "none",
	}
);
const [sx, sy] = [PAD.x + 15, PAD.y + 15];
s.solid(
	slabOf({ x: sx - 9, y: sy - 9, w: 18, d: 18, r: 2 }, 5, 6, s.P, 3, 0.4)
);
s.solid(cylinder(sx, sy, 3, 11, 14, s.P, 20));
s.solid(cylinder(sx, sy, 7, 25, 7, s.P, 28, 0.6));
s.line(knurl(sx, sy, 7, 26, 31, 26, s.P), { tone: "lo" });

export const drawing = cardDrawing(s);
