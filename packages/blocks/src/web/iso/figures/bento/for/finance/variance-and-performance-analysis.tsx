import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Variance and performance analysis: three coin stacks on coasters, prior
 * period, plan and actual. A straight edge laid on the plan stack shows the
 * level; the coins the actual stack carries above it are the swing (lit). The
 * slip tray in front holds the cited lines.
 */

const PLATE = { x: -96, y: -54, w: 192, d: 108, r: 8 };
const COIN = 3.6;
const COIN_R = 14;
const STACK_Y = -14;
const STACKS = [
	[-58, 5],
	[-16, 6],
	[30, 9],
] as const;
const PLAN_TOP = 2 + 6 * COIN;
const SWING = 6;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[30, STACK_Y, 2 + 9 * COIN + 2],
]);

function stack(x: number, coins: number) {
	s.halo({ x: x - 17, y: STACK_Y - 17, w: 34, d: 34, r: 17 }, 0);
	s.solid(cylinder(x, STACK_Y, COIN_R + 3, 0, 2, s.P, 40, 0.4), {
		tone: "lo",
	});
	for (let i = 0; i < coins; i++) {
		const z = 2 + i * COIN;
		s.solid(cylinder(x, STACK_Y, COIN_R, z, COIN, s.P, 40, 0.5), {
			lit: i >= SWING,
		});
	}
	const top = 2 + coins * COIN;
	s.line(ring(x, STACK_Y, COIN_R - 3.5, top, s.P, 36), { tone: "lo" });
}

benchPlate(s, PLATE);
const [prior, plan, actual] = STACKS;
stack(...prior);
stack(...plan);
// The straight edge resting on the plan stack, reaching toward the actual.
s.solid(
	slabOf(
		{ x: plan[0] - 10, y: STACK_Y - 3, w: 36, d: 6, r: 1 },
		PLAN_TOP,
		1.6,
		s.P,
		2
	),
	{ tone: "lo" }
);
stack(...actual);
// Slip tray with three cited lines.
const tray = { x: -70, y: 14, w: 96, d: 30, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 5, s.P, 4, 0.6), { tone: "lo" });
const slip = insetPlan(tray, 4);
s.solid(slabOf(slip, 3, 2.6, s.P, 3), { crease: "none" });
for (const [i, reach] of [70, 54, 62].entries()) {
	const y = slip.y + 6 + i * 6.5;
	s.line(lineOnTop([slip.x + 6, y], [slip.x + reach, y], 5.6, s.P), {
		tone: i === 0 ? "mid" : "lo",
	});
}

export const drawing = cardDrawing(s);
