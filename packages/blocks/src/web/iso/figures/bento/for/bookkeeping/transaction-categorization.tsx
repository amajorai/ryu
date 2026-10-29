import {
	boxCorners,
	insetPlan,
	lineOnTop,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Transaction categorization: a sorting line. Slips leave the feed hopper on
 * a rail and a diverter drops each one into its account's bin along the
 * front. The one the sorter could not place stands alone in the query tray at
 * the end of the rail (the lit slip), waiting for a person.
 */

const PLATE = { x: -100, y: -52, w: 200, d: 104, r: 8 };
const HOPPER = { x: -88, y: -40, w: 34, d: 30, r: 3 };
const HOPPER_H = 34;
const RAIL = { x: -54, y: -30, w: 104, d: 12, r: 2 };
const RAIL_H = 5;
const TRAY = { x: 54, y: -40, w: 34, d: 30, r: 3 };
const BIN_H = 14;
const BINS = [-80, -46, -12, 22, 56];
const FILLS = [3, 1, 2, 3, 1];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-71, -25, HOPPER_H + 12],
]);

/** One account bin: an open-topped box with its slips standing in it. */
function bin(x: number, fill: number) {
	const plan = { x, y: -4, w: 28, d: 40, r: 3 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, BIN_H, s.P, 4, 0.6));
	s.line(planOutline(insetPlan(plan, 3), BIN_H, s.P, 3), { tone: "lo" });
	for (let i = 0; i < fill; i++) {
		s.solid(
			slabOf(
				{ x: x + 5, y: plan.y + 8 + i * 8, w: 18, d: 2, r: 0.4 },
				BIN_H,
				8 - i,
				s.P,
				2
			),
			{ crease: "none" }
		);
	}
}

benchPlate(s, PLATE);
// Feed hopper at the back, a slip showing in its mouth.
s.halo(HOPPER, 0);
s.solid(slabOf(HOPPER, 0, HOPPER_H, s.P, 4, 0.8));
s.line(planOutline(insetPlan(HOPPER, 4), HOPPER_H, s.P, 3), { tone: "lo" });
s.solid(slabOf({ x: -80, y: -27, w: 18, d: 2, r: 0.4 }, HOPPER_H, 10, s.P, 2), {
	crease: "none",
});
// The rail with its diverter knob, slips riding on it.
s.solid(slabOf(RAIL, 0, RAIL_H, s.P, 3, 0.6), { tone: "lo" });
s.line(lineOnTop([RAIL.x + 2, -24], [RAIL.x + RAIL.w - 2, -24], RAIL_H, s.P), {
	tone: "mid",
});
s.solid(slabOf({ x: -38, y: -29, w: 12, d: 10, r: 1 }, RAIL_H, 3, s.P, 2));
s.solid(slabOf({ x: 4, y: -29, w: 12, d: 10, r: 1 }, RAIL_H, 3, s.P, 2));
knob(s, [-14, -38], 0, 4, 6);
// Query tray at the end of the rail: the unclear one.
s.halo(TRAY, 0);
s.solid(slabOf(TRAY, 0, 8, s.P, 4, 0.6));
s.line(planOutline(insetPlan(TRAY, 3), 8, s.P, 3), { tone: "lo" });
s.solid(slabOf({ x: 62, y: -27, w: 18, d: 3, r: 0.5 }, 8, 18, s.P, 2), {
	lit: true,
});
screws(
	s,
	[
		[RAIL.x + 6, -24],
		[RAIL.x + RAIL.w - 6, -24],
	],
	RAIL_H,
	1.2
);
BINS.forEach((x, i) => bin(x, FILLS[i] ?? 1));

export const drawing = cardDrawing(s);
