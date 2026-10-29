import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Grant and proposal support: a binding press. Your prior work and the
 * literature are pressed together into one proposal under the screw; tabbed
 * dividers mark its sections, and the specific-aims tab (lit) is the one
 * pulled forward for your revision.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const STACK = { x: -34, y: -26, w: 68, d: 48, r: 2 };
const POST_X = 50;
const POST_R = 5;
const BEAM_Z = 56;
const LEAVES = 8;
const LEAF_H = 2.2;
const TABS = [2, 4, 6];
const LIT_TAB = 2;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BEAM_Z + 24]]);

const stackTop = 6 + LEAVES * LEAF_H;

function post(x: number) {
	s.solid(cylinder(x, 0, POST_R + 3, 0, 4, s.P, 28, 0.5), { tone: "lo" });
	s.solid(cylinder(x, 0, POST_R, 4, BEAM_Z - 4, s.P, 28));
}

benchPlate(s, PLATE);
post(-POST_X);
// Bed plate, the bound leaves, and the tabbed dividers between them.
s.halo(insetPlan(STACK, -6), 0);
s.solid(slabOf(insetPlan(STACK, -6), 0, 6, s.P, 4, 0.6), { tone: "lo" });
for (let i = 0; i < LEAVES; i++) {
	const z = 6 + i * LEAF_H;
	const tab = TABS.indexOf(i);
	s.solid(slabOf(STACK, z, LEAF_H, s.P, 2), { crease: "none" });
	if (tab >= 0) {
		s.solid(
			slabOf(
				{
					x: STACK.x + 8 + tab * 20,
					y: STACK.y + STACK.d - 1,
					w: 16,
					d: i === LIT_TAB ? 16 : 7,
					r: 1,
				},
				z,
				LEAF_H,
				s.P,
				2
			),
			{ lit: i === LIT_TAB, crease: "none" }
		);
	}
}
// Pressing platen on top, the screw down from the beam.
const platen = insetPlan(STACK, -2);
s.solid(slabOf(platen, stackTop, 5, s.P, 4, 0.6));
screws(
	s,
	[
		[platen.x + 6, platen.y + 6],
		[platen.x + platen.w - 6, platen.y + platen.d - 6],
	],
	stackTop + 5,
	1.4
);
s.solid(cylinder(0, 0, 8, stackTop + 5, 3, s.P, 28, 0.4), { tone: "lo" });
s.solid(cylinder(0, 0, 3.5, stackTop + 8, BEAM_Z - stackTop - 8, s.P, 20));
post(POST_X);
// Crossbeam and the hand wheel on top.
s.solid(
	slabOf(
		{ x: -POST_X - 9, y: -9, w: 2 * POST_X + 18, d: 18, r: 4 },
		BEAM_Z,
		10,
		s.P,
		6,
		0.8
	)
);
screws(
	s,
	[
		[-POST_X, 0],
		[POST_X, 0],
	],
	BEAM_Z + 10,
	2
);
s.solid(cylinder(0, 0, 4, BEAM_Z + 10, 4, s.P, 20), { tone: "lo" });
s.solid(cylinder(0, 0, 16, BEAM_Z + 14, 4, s.P, 40, 0.6));
s.line(knurl(0, 0, 16, BEAM_Z + 14, BEAM_Z + 18, 40, s.P), { tone: "lo" });
s.line(ring(0, 0, 9, BEAM_Z + 18, s.P, 32), { tone: "faint" });
s.solid(cylinder(0, 0, 3, BEAM_Z + 18, 3, s.P, 20), { tone: "lo" });

export const drawing = cardDrawing(s);
