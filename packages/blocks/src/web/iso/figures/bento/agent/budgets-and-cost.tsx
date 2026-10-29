import { boxCorners, cylinder, ring, slabOf } from "../../../kit/iso-kit.ts";
import { benchPlate, byDepth, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Budgets and cost: a coin scale. Each run leaves a stack of coins under a
 * gantry whose crossbar is set at the budget height; the newest run's top
 * coin (the lit part) shows how close it came to the bar.
 */

const PLATE = { x: -92, y: -52, w: 184, d: 104, r: 8 };
const COIN_R = 11;
const COIN_H = 3.4;
const BAR_Z = 33;
const STACKS: [number, number, number][] = [
	[-40, -6, 3],
	[-4, -6, 6],
	[32, -6, 9],
];
const POSTS: [number, number][] = [
	[-70, -18],
	[62, -18],
];

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, BAR_Z + 6]]);

benchPlate(s, PLATE);
// The budget gantry behind the stacks: two posts and a crossbar on top.
for (const [x, y] of byDepth(POSTS, s)) {
	s.solid(cylinder(x, y, 7, 0, 2, s.P, 28), { tone: "lo" });
	s.solid(
		slabOf(
			{ x: x - 4, y: y - 4, w: 8, d: 8, r: 1.5 },
			2,
			BAR_Z - 2,
			s.P,
			3,
			0.4
		)
	);
}
s.solid(slabOf({ x: -76, y: -22, w: 144, d: 8, r: 2 }, BAR_Z, 5, s.P, 3, 0.6));
screws(s, POSTS, BAR_Z + 5, 1.6);
// One coin stack per run, back to front.
for (const [x, y, count] of byDepth(STACKS, s)) {
	s.halo(
		{ x: x - COIN_R, y: y - COIN_R, w: 2 * COIN_R, d: 2 * COIN_R, r: COIN_R },
		0
	);
	const last = count === 9;
	for (let i = 0; i < count; i++) {
		s.solid(cylinder(x, y, COIN_R, i * COIN_H, COIN_H, s.P, 36, 0.5), {
			tone: i % 2 ? "mid" : "lo",
			lit: last && i === count - 1,
		});
	}
	s.line(ring(x, y, COIN_R - 3, count * COIN_H, s.P, 32), { tone: "faint" });
}
// Coin tray at the front, where each run's coins come from.
const tray = { x: -74, y: 24, w: 56, d: 18, r: 3 };
s.halo(tray, 0);
s.solid(slabOf(tray, 0, 4, s.P, 4, 0.6), { tone: "lo" });
s.solid(slabOf({ x: -68, y: 28, w: 44, d: 10, r: 2 }, 4, 1.5, s.P, 3));
screws(
	s,
	[
		[50, 34],
		[62, 34],
	],
	0,
	1.6
);
lamp(s, [56, 42], 0, { radius: 2 });

export const drawing = cardDrawing(s);
