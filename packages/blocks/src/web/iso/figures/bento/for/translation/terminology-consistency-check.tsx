import {
	boxCorners,
	cylinder,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRect, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Terminology consistency check: a gauge rail. Each term of the finished
 * translation is a peg on the rail; the termbase is the template bar behind,
 * notched to the approved height. One peg comes up short, and its flag (the
 * lit part) is raised where the term diverges.
 */

const PLATE = { x: -104, y: -42, w: 208, d: 84, r: 8 };
const TEMPLATE = { x: -90, y: -30, w: 180, d: 12, r: 2 };
const TEMPLATE_H = 26;
const RAIL = { x: -90, y: -10, w: 180, d: 26, r: 3 };
const RAIL_H = 6;
const PEG_H = 16;
const PEGS = 8;
const OFF = 5;
const pegX = (index: number) => -74 + index * 21;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[pegX(OFF) + 8, 12, RAIL_H + 30],
	[0, -24, TEMPLATE_H + 4],
]);

benchPlate(s, PLATE);
// Template bar: one notch per approved term, cut to the approved height.
s.halo(TEMPLATE, 0);
s.solid(slabOf(TEMPLATE, 0, TEMPLATE_H, s.P, 4, 0.8));
const face = TEMPLATE.y + TEMPLATE.d;
for (let i = 0; i < PEGS; i++) {
	const x = pegX(i);
	s.line(faceRect(s, "y", face, x - 4, x + 4, RAIL_H + PEG_H - 4, TEMPLATE_H), {
		tone: "lo",
	});
}
lamp(s, [TEMPLATE.x + TEMPLATE.w - 8, TEMPLATE.y + 6], TEMPLATE_H, {
	radius: 1.8,
});
// The rail with its guide groove.
s.halo(RAIL, 0);
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 4, 0.6), { tone: "lo" });
s.line(lineOnTop([RAIL.x + 6, 3], [RAIL.x + RAIL.w - 6, 3], RAIL_H, s.P), {
	tone: "faint",
});
screws(
	s,
	[
		[RAIL.x + 5, RAIL.y + 5],
		[RAIL.x + RAIL.w - 5, RAIL.y + RAIL.d - 5],
	],
	RAIL_H,
	1.3
);
for (let i = 0; i < PEGS; i++) {
	const x = pegX(i);
	const height = i === OFF ? PEG_H - 7 : PEG_H;
	s.solid(cylinder(x, 3, 5.5, RAIL_H, 1.4, s.P, 24), { tone: "lo" });
	s.solid(cylinder(x, 3, 4, RAIL_H + 1.4, height - 1.4, s.P, 24));
	s.line(ring(x, 3, 1.6, RAIL_H + height, s.P, 16), { tone: "lo" });
}
// The raised flag beside the short peg, in front of the peg row so the
// later pegs never cover it.
const flagX = pegX(OFF);
s.solid(cylinder(flagX + 8, 11, 1.2, RAIL_H, 24, s.P, 12));
s.solid(
	slabOf({ x: flagX + 9, y: 10, w: 15, d: 2, r: 0.4 }, RAIL_H + 14, 10, s.P, 2),
	{ lit: true, crease: "none" }
);

export const drawing = cardDrawing(s);
