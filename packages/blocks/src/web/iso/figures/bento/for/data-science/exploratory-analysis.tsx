import {
	boxCorners,
	cylinder,
	insetPlan,
	planOutline,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, knob, ruler } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Exploratory analysis: a histogram rack. A new dataset is sorted into bins of
 * standing bars (the distribution), one socket stands empty (a missing value),
 * and the peg board in front shows two columns moving together. The bar worth
 * modeling is the lit one.
 */

const PLATE = { x: -88, y: -46, w: 176, d: 92, r: 8 };
const RACK = { x: -78, y: -36, w: 148, d: 32, r: 3 };
const RACK_H = 5;
const HEIGHTS = [8, 14, 24, 36, 48, 54, 42, 0, 18, 10];
const BAR = 11;
const STEP = 14;
const BAR_Y = RACK.y + 11;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[RACK.x + 10 + 5 * STEP, BAR_Y, RACK_H + 56],
]);

benchPlate(s, PLATE);
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 4, 0.6));
ruler(
	s,
	{ x: RACK.x + 6, y: RACK.y + RACK.d - 8, w: RACK.w - 12, d: 5, r: 1 },
	RACK_H
);
HEIGHTS.forEach((height, index) => {
	const plan = {
		x: RACK.x + 6 + index * STEP,
		y: BAR_Y - BAR / 2,
		w: BAR,
		d: BAR,
		r: 1,
	};
	if (height === 0) {
		s.line(planOutline(plan, RACK_H, s.P, 2), { tone: "hi" });
		s.line(planOutline(insetPlan(plan, 2.5), RACK_H, s.P, 1), { tone: "mid" });
		return;
	}
	s.solid(slabOf(plan, RACK_H, height, s.P, 2, 0.4), { lit: index === 5 });
});
// Peg board: paired readings that rise together.
const BOARD = { x: -80, y: 4, w: 84, d: 36, r: 4 };
s.halo(BOARD, 0);
s.solid(slabOf(BOARD, 0, 5, s.P, 4, 0.6));
s.line(planOutline(insetPlan(BOARD, 4), 5, s.P, 3), { tone: "faint" });
const pegs: [number, number, number][] = [
	[-72, 32, 3],
	[-63, 30, 5],
	[-54, 26, 7],
	[-45, 24, 9],
	[-36, 19, 11],
	[-27, 17, 13],
	[-18, 12, 15],
	[-9, 10, 17],
];
for (const [x, y, height] of byDepth(pegs, s, 5)) {
	s.solid(cylinder(x, y, 3, 5, height, s.P, 18, 0.3));
}
knob(s, [44, 24], 0, 8, 7);

export const drawing = cardDrawing(s);
