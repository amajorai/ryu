import {
	boxCorners,
	cylinder,
	knurl,
	lineOnTop,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Escalation summaries: a screw press beside a two-step stand. The messy
 * thread goes under the press as a loose stack of sheets; what comes out is a
 * thin bound brief (lit), set on the upper step for the next tier.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const PRESS: [number, number] = [-48, -6];
const SPAN = 30;
const BAR_Z = 46;
const STACK_TOP = 12;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[PRESS[0], PRESS[1], BAR_Z + 20],
]);

function post(x: number) {
	s.solid(cylinder(x, PRESS[1], 5, 0, 2, s.P, 24), { tone: "lo" });
	s.solid(cylinder(x, PRESS[1], 3, 2, BAR_Z - 2, s.P, 20));
}

benchPlate(s, PLATE);
// Press bed, far post, the loose stack, platen, screw, near post, crossbar.
const bed = {
	x: PRESS[0] - SPAN - 8,
	y: PRESS[1] - 26,
	w: 2 * SPAN + 16,
	d: 52,
	r: 4,
};
s.halo(bed, 0);
s.solid(slabOf(bed, 0, 2, s.P, 4, 0.4), { tone: "lo" });
post(PRESS[0] - SPAN);
const sheets = [
	{ dx: -2, dy: 1 },
	{ dx: 2, dy: -2 },
	{ dx: -1, dy: 3 },
	{ dx: 3, dy: 0 },
];
for (const [index, { dx, dy }] of sheets.entries()) {
	const plan = {
		x: PRESS[0] - 18 + dx,
		y: PRESS[1] - 16 + dy,
		w: 36,
		d: 32,
		r: 1,
	};
	s.solid(slabOf(plan, 2 + index * 2.5, 2.5, s.P, 1));
}
const platen = { x: PRESS[0] - 21, y: PRESS[1] - 19, w: 42, d: 38, r: 3 };
s.solid(slabOf(platen, STACK_TOP, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(
	cylinder(
		PRESS[0],
		PRESS[1],
		2.4,
		STACK_TOP + 4,
		BAR_Z - STACK_TOP - 4,
		s.P,
		16
	)
);
post(PRESS[0] + SPAN);
const bar = {
	x: PRESS[0] - SPAN - 6,
	y: PRESS[1] - 6,
	w: 2 * SPAN + 12,
	d: 12,
	r: 3,
};
s.solid(slabOf(bar, BAR_Z, 6, s.P, 4, 0.8));
screws(
	s,
	[
		[PRESS[0] - SPAN, PRESS[1]],
		[PRESS[0] + SPAN, PRESS[1]],
	],
	BAR_Z + 6,
	1.4
);
// Screw through the bar and the handwheel on top.
s.solid(cylinder(PRESS[0], PRESS[1], 2.4, BAR_Z + 6, 8, s.P, 16));
s.solid(cylinder(PRESS[0], PRESS[1], 13, BAR_Z + 14, 3, s.P, 40), {
	tone: "lo",
});
s.line(knurl(PRESS[0], PRESS[1], 13, BAR_Z + 14, BAR_Z + 17, 40, s.P), {
	tone: "lo",
});
s.line(ring(PRESS[0], PRESS[1], 9, BAR_Z + 17, s.P, 32), { tone: "faint" });
s.solid(cylinder(PRESS[0], PRESS[1], 3.4, BAR_Z + 17, 3, s.P, 20));
// The two-step stand with the bound brief on the upper step.
const lower = { x: 14, y: -38, w: 72, d: 76, r: 4 };
const upper = { x: 14, y: -38, w: 72, d: 38, r: 4 };
s.halo(lower, 0);
s.solid(slabOf(lower, 0, 14, s.P, 4, 0.8));
s.solid(slabOf(upper, 14, 18, s.P, 4, 0.8));
const brief = { x: 26, y: -30, w: 46, d: 24, r: 1.5 };
s.halo(brief, 32, 3);
s.solid(slabOf(brief, 32, 4, s.P, 2), { lit: true });
s.line(planOutline({ x: 30, y: -30, w: 6, d: 24, r: 0 }, 36, s.P, 1), {
	tone: "mid",
});
s.line(lineOnTop([42, -24], [66, -24], 36, s.P), { tone: "mid" });
s.line(lineOnTop([42, -18], [62, -18], 36, s.P), { tone: "faint" });
s.line(lineOnTop([42, -12], [58, -12], 36, s.P), { tone: "faint" });
lamp(s, [lower.x + lower.w - 10, lower.y + lower.d - 10], 14, { radius: 1.8 });

export const drawing = cardDrawing(s);
