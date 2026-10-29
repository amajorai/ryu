import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * SOP drafting and upkeep: an open ring binder. The right-hand stack holds
 * the procedure, one checkbox and rule per step; index tabs mark its
 * sections, and the newest revision tab (lit) stands out where the process
 * just changed. The pen that keeps it current lies on the left page.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const LEFT = { x: -84, y: -42, w: 78, d: 84, r: 3 };
const RIGHT = { x: 4, y: -42, w: 78, d: 84, r: 3 };
const COVER_H = 2;
const STACK_H = 7;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [74, -34, 22]]);

benchPlate(s, PLATE);
s.halo({ x: -86, y: -44, w: 172, d: 88, r: 4 }, 0);
// Covers and spine.
s.solid(slabOf(LEFT, 0, COVER_H, s.P, 3, 0.4), { tone: "lo" });
s.solid(slabOf({ x: -6, y: -42, w: 10, d: 84, r: 1 }, 0, COVER_H, s.P, 2), {
	tone: "lo",
});
s.solid(slabOf(RIGHT, 0, COVER_H, s.P, 3, 0.4), { tone: "lo" });
const rightPages = insetPlan(RIGHT, 4);
// Left page stack and the pen resting on it.
const leftPages = insetPlan(LEFT, 4);
s.solid(slabOf(leftPages, COVER_H, 3, s.P, 3), { crease: "none" });
for (let i = 0; i < 7; i++) {
	const y = leftPages.y + 10 + i * 9;
	s.line(
		lineOnTop([leftPages.x + 6, y], [leftPages.x + 50, y], COVER_H + 3, s.P),
		{
			tone: "faint",
		}
	);
}
// The pen, on top of the left pages.
const PEN_Z = COVER_H + 3;
s.solid(slabOf({ x: -40, y: -34, w: 6, d: 56, r: 3 }, PEN_Z, 5, s.P, 6, 0.6));
s.solid(slabOf({ x: -39, y: 22, w: 4, d: 8, r: 2 }, PEN_Z + 0.5, 4, s.P, 4), {
	tone: "lo",
});

// Ring posts along the spine.
for (const [x, y] of byDepth<[number, number]>(
	[
		[-1, -26],
		[-1, 0],
		[-1, 26],
	],
	s
)) {
	s.solid(cylinder(x, y, 3.4, COVER_H, 12, s.P, 20), { tone: "lo" });
	s.solid(cylinder(x, y, 4.2, COVER_H + 12, 2, s.P, 20));
}
s.solid(slabOf(rightPages, COVER_H, STACK_H, s.P, 3), { crease: "none" });
const top = COVER_H + STACK_H;
for (const [i, span] of [46, 38, 44, 30, 40, 24].entries()) {
	const y = rightPages.y + 9 + i * 11;
	s.line(
		planOutline(
			{ x: rightPages.x + 6, y: y - 3, w: 6, d: 6, r: 0.5 },
			top,
			s.P,
			1
		),
		{
			tone: i < 4 ? "mid" : "lo",
		}
	);
	s.line(
		lineOnTop([rightPages.x + 17, y], [rightPages.x + 17 + span, y], top, s.P),
		{ tone: "lo" }
	);
}
// Index tabs standing up out of the right stack, one per section.
const TABS: [number, number, boolean][] = [
	[-34, 5, false],
	[-14, 5, false],
	[6, 11, true],
];
for (const [y, rise, lit] of TABS) {
	s.solid(
		slabOf(
			{ x: rightPages.x + rightPages.w - 5, y, w: 2.5, d: 14, r: 0.8 },
			top,
			rise,
			s.P,
			2
		),
		{ lit, crease: "none" }
	);
}

export const drawing = cardDrawing(s);
