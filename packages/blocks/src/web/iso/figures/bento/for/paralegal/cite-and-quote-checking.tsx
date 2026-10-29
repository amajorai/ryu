import {
	boxCorners,
	cylinder,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Cite and quote checking: a twin-stylus comparator. The draft lies on the
 * left bed and the source record on the right; one arm off the post carries
 * a stylus over each, set on the same line, so both read together. Where the
 * lines don't agree, the flag on the draft's stylus pops up (the lit flag).
 */

const PLATE = { x: -104, y: -52, w: 208, d: 104, r: 8 };
const BED_H = 5;
const ARM_Z = 32;
const ARM_Y = 8;
const STYLUS_X = 52;
const LINE_Y = [-13, -5, 3, 11, 19, 27];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, -40, ARM_Z + 10],
]);

function bed(x0: number, mismatch: boolean) {
	const plan = { x: x0, y: -22, w: 80, d: 62, r: 3 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, BED_H, s.P, 4, 0.6), { tone: "lo" });
	const sheet = { x: x0 + 6, y: -18, w: 68, d: 54, r: 1 };
	s.solid(slabOf(sheet, BED_H, 1.2, s.P, 2), { crease: "none" });
	const z = BED_H + 1.2;
	LINE_Y.forEach((y, i) => {
		const checked = y === ARM_Y + 3;
		const short = mismatch && checked ? 30 : 0;
		const length = ([52, 44, 50, 56, 40, 48][i] ?? 48) - short;
		s.line(lineOnTop([sheet.x + 6, y], [sheet.x + 6 + length, y], z, s.P), {
			tone: checked ? "mid" : "lo",
		});
	});
}

function stylus(x: number, flag: boolean) {
	const z = BED_H + 1.2;
	s.solid(cylinder(x, ARM_Y + 3, 1, z, 4, s.P, 12), { tone: "lo" });
	s.solid(cylinder(x, ARM_Y + 3, 2.6, z + 4, ARM_Z - z - 4, s.P, 20));
	s.solid(cylinder(x, ARM_Y + 3, 4, z + 12, 3, s.P, 24), { tone: "lo" });
	if (flag) {
		s.solid(
			slabOf(
				{ x: x + 2.6, y: ARM_Y + 2.4, w: 18, d: 1.6, r: 0.3 },
				17,
				13,
				s.P,
				2
			),
			{ lit: true, crease: "none" }
		);
	}
}

benchPlate(s, PLATE);
// The post at the back, its arm reaching forward to the crossbar.
const post = { x: -8, y: -46, w: 16, d: 16, r: 3 };
s.halo(post, 0);
s.solid(slabOf(post, 0, ARM_Z + 6, s.P, 4, 0.8));
bed(-92, true);
bed(12, false);
stylus(-STYLUS_X, true);
stylus(STYLUS_X, false);
s.solid(slabOf({ x: -5, y: -42, w: 10, d: 50, r: 1.5 }, ARM_Z, 6, s.P, 3, 0.6));
s.solid(
	slabOf(
		{ x: -STYLUS_X - 7, y: ARM_Y, w: STYLUS_X * 2 + 14, d: 7, r: 2 },
		ARM_Z,
		6,
		s.P,
		3,
		0.6
	)
);
screws(
	s,
	[
		[-STYLUS_X, ARM_Y + 3.5],
		[STYLUS_X, ARM_Y + 3.5],
	],
	ARM_Z + 6,
	1.4
);
knob(s, [0, -38], ARM_Z + 6, 4, 4);

export const drawing = cardDrawing(s);
