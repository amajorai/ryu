import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Metric investigation: a slicer on a carriage. The KPI is a block fed past a
 * guillotine blade and cut into standing slices along one dimension; the one
 * slice behind the change has been pulled forward out of the line (the lit
 * slice) to look at on its own.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const BED = { x: -88, y: -30, w: 156, d: 40, r: 3 };
const BED_H = 5;
const SLICE_H = 32;
const SLICES = 7;
const PULLED = 4;
const BLOCK = { x: 16, y: -26, w: 42, d: 32, r: 2 };
const POST = { x: 6, y: -48, w: 12, d: 14, r: 2 };
const POST_H = 52;
const ARM_Z = POST_H - 5;
const BLADE_X = 10;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	...boxCorners(BED, 0, BED_H + SLICE_H),
	[POST.x, POST.y, POST_H],
	[12, 12, ARM_Z + 13],
]);

benchPlate(s, PLATE);
// The guillotine post behind the bed.
s.halo(POST, 0);
s.solid(slabOf(POST, 0, POST_H, s.P, 4, 0.8));
// The carriage bed with its two guide rails.
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 4, 0.6), { tone: "lo" });
for (const y of [BED.y + 6, BED.y + BED.d - 6]) {
	s.line(lineOnTop([BED.x + 4, y], [BED.x + BED.w - 4, y], BED_H, s.P), {
		tone: "mid",
	});
}
screws(
	s,
	[
		[BED.x + 5, BED.y + 20],
		[BED.x + BED.w - 5, BED.y + 20],
	],
	BED_H,
	1.4
);
// Cut slices standing in line, then the uncut rest of the KPI block.
const slices: [number, number][] = [];
for (let i = 0; i < SLICES; i++) {
	if (i !== PULLED) {
		slices.push([BED.x + 8 + i * 13, BLOCK.y]);
	}
}
for (const [x, y] of byDepth(slices, s)) {
	const plan = { x, y, w: 9, d: BLOCK.d, r: 1.5 };
	s.halo(plan, BED_H);
	s.solid(slabOf(plan, BED_H, SLICE_H, s.P, 3, 0.4));
}
// Blade down through the cut, hung from the arm off the post.
s.solid(
	slabOf(
		{ x: BLADE_X - 1, y: BLOCK.y + 1, w: 2, d: BLOCK.d - 2, r: 0.5 },
		BED_H,
		ARM_Z - BED_H,
		s.P,
		1,
		0.2
	),
	{ tone: "lo" }
);
s.halo(BLOCK, BED_H);
s.solid(slabOf(BLOCK, BED_H, SLICE_H, s.P, 3, 0.6));
s.solid(
	slabOf({ x: BLADE_X - 3, y: POST.y + 3, w: 6, d: 60, r: 1 }, ARM_Z, 5, s.P, 2)
);
s.solid(cylinder(BLADE_X, 12, 3.5, ARM_Z + 5, 8, s.P, 24), { tone: "lo" });
// Feed knob at the carriage's start.
knob(s, [BED.x + 8, 26], 0, 5, 6);
// The pulled slice, standing forward of the line.
const pulled = { x: BED.x + 8 + PULLED * 13, y: 18, w: 9, d: BLOCK.d, r: 1.5 };
s.halo(pulled, 0);
s.solid(slabOf(pulled, 0, SLICE_H, s.P, 3, 0.4), { lit: true });

export const drawing = cardDrawing(s);
