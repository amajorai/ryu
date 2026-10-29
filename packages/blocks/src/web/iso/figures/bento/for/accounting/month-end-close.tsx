import {
	boxCorners,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Month-end close: a checklist console beside the ledger, strapped shut.
 * Each slider is one close task (accruals, prepaids, open items); done tasks
 * are pushed home to the right. One slider is still back at the start, and
 * its lamp (lit) shows what is blocking the books.
 */

const PLATE = { x: -98, y: -52, w: 196, d: 104, r: 8 };
const CONSOLE = { x: -84, y: -40, w: 104, d: 80, r: 5 };
const CONSOLE_H = 16;
const ROWS = 5;
const BLOCKER = 3;
const SLOT_X = CONSOLE.x + 12;
const SLOT_W = 62;
const BOOK = { x: 34, y: -32, w: 48, d: 62, r: 2 };

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 26]]);

benchPlate(s, PLATE);
s.halo(CONSOLE, 0);
s.solid(slabOf(CONSOLE, 0, CONSOLE_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(CONSOLE, 5), CONSOLE_H, s.P, 4), {
	tone: "faint",
});
for (let i = 0; i < ROWS; i++) {
	const y = CONSOLE.y + 14 + i * 13;
	s.line(
		planOutline(
			{ x: SLOT_X, y: y - 2, w: SLOT_W, d: 4, r: 2 },
			CONSOLE_H,
			s.P,
			3
		),
		{
			tone: "lo",
		}
	);
	const done = i !== BLOCKER;
	const sx = done ? SLOT_X + SLOT_W - 10 : SLOT_X + 2;
	s.solid(
		slabOf({ x: sx, y: y - 3.5, w: 8, d: 7, r: 1.5 }, CONSOLE_H, 5, s.P, 3, 0.4)
	);
	lamp(s, [SLOT_X + SLOT_W + 10, y], CONSOLE_H, {
		lit: !done,
		radius: 2,
	});
}
screws(
	s,
	[
		[CONSOLE.x + 6, CONSOLE.y + 6],
		[CONSOLE.x + CONSOLE.w - 6, CONSOLE.y + CONSOLE.d - 6],
	],
	CONSOLE_H,
	1.4
);
// The ledger: covers, page block and a strap with its buckle.
s.halo(BOOK, 0);
s.solid(slabOf(BOOK, 0, 2.5, s.P, 3, 0.4), { tone: "lo" });
const pages = {
	x: BOOK.x + 1,
	y: BOOK.y + 2,
	w: BOOK.w - 3,
	d: BOOK.d - 4,
	r: 1,
};
s.solid(slabOf(pages, 2.5, 13, s.P, 2), { crease: "none" });
faceRules(s, "y", pages.y + pages.d, pages.x + 4, 13, [38, 38, 38, 38], 2.6);
s.solid(slabOf(BOOK, 15.5, 2.5, s.P, 3, 0.4), { tone: "lo" });
s.solid(
	slabOf(
		{ x: BOOK.x - 1, y: -6, w: BOOK.w + 2, d: 10, r: 0.6 },
		18,
		1.2,
		s.P,
		2
	)
);
s.solid(
	slabOf({ x: BOOK.x + 18, y: -8, w: 12, d: 14, r: 1.5 }, 19.2, 3, s.P, 3, 0.4),
	{
		tone: "lo",
	}
);

export const drawing = cardDrawing(s);
