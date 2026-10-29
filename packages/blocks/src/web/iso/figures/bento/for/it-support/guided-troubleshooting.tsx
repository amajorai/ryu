import {
	boxCorners,
	cylinder,
	pathOf,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceLine } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Guided troubleshooting: a flight of steps with a handrail, one step per
 * line of the runbook, each marked with its number of pips. The pawn (lit)
 * stands on the step the user has reached and moves down one fix at a time.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const STEPS = 4;
const STEP_W = 36;
const START = -78;
const TREAD = { y: -32, d: 64 };
const RISE = 11;
const RAIL_Y = TREAD.y + 6;
const POST = 18;
const PAWN_STEP = 1;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-60, 0, 62]]);

const heightOf = (step: number) => (STEPS - step) * RISE;
const centerOf = (step: number) => START + step * STEP_W + STEP_W / 2;

benchPlate(s, PLATE);
for (let step = 0; step < STEPS; step++) {
	const plan = {
		x: START + step * STEP_W,
		y: TREAD.y,
		w: STEP_W,
		d: TREAD.d,
		r: 2,
	};
	const top = heightOf(step);
	if (step === 0) {
		s.halo({ x: START, y: TREAD.y, w: STEP_W * STEPS, d: TREAD.d, r: 3 }, 0);
	}
	s.solid(slabOf(plan, 0, top, s.P, 3, 0.6));
	// Nosing line along the tread's front face.
	s.line(
		faceLine(
			s,
			"y",
			TREAD.y + TREAD.d,
			plan.x + 3,
			plan.x + plan.w - 3,
			top - 3
		),
		{
			tone: "lo",
		}
	);
	// Pips: the step's number.
	s.dots(
		Array.from({ length: step + 1 }, (_, i) =>
			s.at([plan.x + 8 + i * 6, TREAD.y + TREAD.d - 10, top])
		),
		{ size: 0.9, tone: "mid" }
	);
	// Handrail post at the back of each tread.
	s.solid(cylinder(centerOf(step), RAIL_Y, 2.4, top, POST, s.P, 16));
}
// The rail falls with the steps, resting on each post.
s.line(
	pathOf(
		Array.from({ length: STEPS }, (_, step) =>
			s.at([centerOf(step), RAIL_Y, heightOf(step) + POST])
		)
	),
	{ tone: "mid" }
);
for (let step = 0; step < STEPS; step++) {
	s.solid(
		cylinder(centerOf(step), RAIL_Y, 3.4, heightOf(step) + POST, 2, s.P, 16),
		{ tone: "lo" }
	);
}
// The pawn on the current step.
const px = centerOf(PAWN_STEP) + 4;
const py = TREAD.y + 30;
const base = heightOf(PAWN_STEP);
s.halo({ x: px - 8, y: py - 8, w: 16, d: 16, r: 8 }, base);
s.solid(cylinder(px, py, 8, base, 3, s.P, 28, 0.6), { lit: true });
s.solid(cylinder(px, py, 4, base + 3, 10, s.P, 24), { lit: true });
s.solid(cylinder(px, py, 6, base + 13, 6, s.P, 24, 1.2), { lit: true });

export const drawing = cardDrawing(s);
