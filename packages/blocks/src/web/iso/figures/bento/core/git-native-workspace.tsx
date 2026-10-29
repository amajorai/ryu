import {
	boxCorners,
	insetPlan,
	lineOnTop,
	type Plan,
	planOutline,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, knob, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Git-native workspace: a shunting yard. The main line runs straight along
 * the back; each run is switched off onto its own siding loop (the lit wagon)
 * and parked under the inspection arch for review before it rejoins main.
 */

const PLATE = { x: -104, y: -60, w: 208, d: 120, r: 8 };
const BED_H = 4;
const MAIN_Y = -30;
const LOOP_Y = 24;
const TURN_X = 56;
const ARCH_Z = 28;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, ARCH_Z + 6]]);

function bed(plan: Plan, axis: "x" | "y") {
	s.halo(plan, 0, 3);
	s.solid(slabOf(plan, 0, BED_H, s.P, 3, 0.6));
	const mid = axis === "x" ? plan.y + plan.d / 2 : plan.x + plan.w / 2;
	for (const offset of [-3.5, 3.5]) {
		const from: [number, number] =
			axis === "x" ? [plan.x + 2, mid + offset] : [mid + offset, plan.y + 2];
		const to: [number, number] =
			axis === "x"
				? [plan.x + plan.w - 2, mid + offset]
				: [mid + offset, plan.y + plan.d - 2];
		s.line(lineOnTop(from, to, BED_H, s.P), { tone: "lo" });
	}
	// Sleepers across the bed, so it reads as track.
	const length = axis === "x" ? plan.w : plan.d;
	for (let at = 6; at < length - 3; at += 8) {
		const from: [number, number] =
			axis === "x" ? [plan.x + at, plan.y + 2] : [plan.x + 2, plan.y + at];
		const to: [number, number] =
			axis === "x"
				? [plan.x + at, plan.y + plan.d - 2]
				: [plan.x + plan.w - 2, plan.y + at];
		s.line(lineOnTop(from, to, BED_H, s.P), { tone: "faint" });
	}
}

function wagon(x: number, y: number, lit = false) {
	const plan = { x: x - 13, y: y - 7, w: 26, d: 14, r: 2 };
	s.halo(plan, BED_H);
	s.solid(slabOf(plan, BED_H, 11, s.P, 4, 0.6), { lit });
	s.line(planOutline(insetPlan(plan, 3), BED_H + 11, s.P, 2), {
		tone: "faint",
	});
}

function pillar(y: number) {
	const plan = { x: -4, y: y - 4, w: 8, d: 8, r: 1.5 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, ARCH_Z, s.P, 4, 0.6));
}

benchPlate(s, PLATE);
bed({ x: -92, y: MAIN_Y - 7, w: 184, d: 14, r: 2 }, "x");
bed(
	{ x: -TURN_X - 7, y: MAIN_Y + 7, w: 14, d: LOOP_Y - MAIN_Y - 14, r: 2 },
	"y"
);
bed(
	{ x: TURN_X - 7, y: MAIN_Y + 7, w: 14, d: LOOP_Y - MAIN_Y - 14, r: 2 },
	"y"
);
wagon(-78, MAIN_Y);
knob(s, [-TURN_X - 18, MAIN_Y + 16], 0, 4, 5);
wagon(20, MAIN_Y);
knob(s, [TURN_X + 18, MAIN_Y + 16], 0, 4, 5);
pillar(LOOP_Y - 18);
bed({ x: -TURN_X - 7, y: LOOP_Y - 7, w: TURN_X * 2 + 14, d: 14, r: 2 }, "x");
// The run under review, parked inside the arch on its own loop.
wagon(12, LOOP_Y, true);
pillar(LOOP_Y + 18);
s.solid(
	slabOf({ x: -6, y: LOOP_Y - 22, w: 12, d: 44, r: 2 }, ARCH_Z, 5, s.P, 4, 0.6)
);
lamp(s, [0, LOOP_Y], ARCH_Z + 5, { radius: 1.8 });
screws(
	s,
	[
		[-80, 46],
		[80, 46],
	],
	0,
	1.6
);

export const drawing = cardDrawing(s);
