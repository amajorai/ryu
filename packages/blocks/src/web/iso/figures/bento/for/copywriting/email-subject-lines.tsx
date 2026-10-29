import {
	boxCorners,
	type Point3,
	pathOf,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, faceRules, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Email subject lines: a sorting rack of standing envelopes, each with its
 * index tab at a different place, one hook apiece. The one pulled up for the
 * campaign shows its tab (the lit part); preview text runs on the front one.
 */

const PLATE = { x: -84, y: -54, w: 168, d: 108, r: 8 };
const RACK = { x: -60, y: -44, w: 120, d: 84, r: 4 };
const BASE = 6;
const ENV_X = RACK.x + 10;
const ENV_W = 100;
const ENV_H = 30;
const ROWS = [
	{ y: -34, tab: 4, lift: 0 },
	{ y: -20, tab: 30, lift: 0 },
	{ y: -6, tab: 56, lift: 12 },
	{ y: 8, tab: 80, lift: 0 },
	{ y: 22, tab: 16, lift: 0 },
];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, -6, BASE + ENV_H + 22],
]);

benchPlate(s, PLATE);
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, BASE, s.P, 6, 0.8));
// Back board the envelopes lean on.
s.solid(
	slabOf(
		{ x: RACK.x + 4, y: RACK.y + 2, w: RACK.w - 8, d: 4, r: 1 },
		BASE,
		22,
		s.P,
		2
	)
);
ROWS.forEach(({ y, tab, lift }, index) => {
	const z = BASE + lift;
	const lit = lift > 0;
	s.solid(slabOf({ x: ENV_X, y, w: ENV_W, d: 3, r: 0.6 }, z, ENV_H, s.P, 2), {
		crease: "none",
	});
	s.solid(
		slabOf({ x: ENV_X + tab, y, w: 16, d: 3, r: 0.6 }, z + ENV_H, 6, s.P, 2),
		{
			lit,
			tone: "lo",
		}
	);
	if (index === ROWS.length - 1) {
		const front = y + 3;
		const v = (x: number, h: number): Point3 => [x, front, z + h];
		s.line(
			pathOf(
				[
					v(ENV_X, ENV_H),
					v(ENV_X + ENV_W / 2, ENV_H - 14),
					v(ENV_X + ENV_W, ENV_H),
				].map(s.at)
			),
			{ tone: "lo" }
		);
		faceRules(s, "y", front, ENV_X + 10, z + 11, [44, 30], 4);
	}
});
// Low front lip that keeps the envelopes standing.
s.solid(
	slabOf(
		{ x: RACK.x + 4, y: RACK.y + RACK.d - 8, w: RACK.w - 8, d: 4, r: 1 },
		BASE,
		6,
		s.P,
		2
	)
);
screws(
	s,
	[
		[RACK.x + 6, RACK.y + RACK.d - 3],
		[RACK.x + RACK.w - 6, RACK.y + RACK.d - 3],
	],
	BASE,
	1.4
);

export const drawing = cardDrawing(s);
