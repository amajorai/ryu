import {
	boxCorners,
	cylinder,
	lineOnTop,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Rules on model calls: a metering drum every call rides through. It carries
 * a budget gauge on top and a key post behind it holds the managed keys; a
 * call that passed the checks leaves on the outlet track (the lit block).
 */

const PLATE = { x: -104, y: -48, w: 208, d: 96, r: 8 };
const TRACK_H = 6;
const DRUM_R = 30;
const DRUM_H = 26;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, 0, DRUM_H + 6],
	[31, -33, 28],
]);

const polar = (angle: number, radius: number): [number, number] => [
	Math.sin(angle) * radius,
	-Math.cos(angle) * radius,
];

function track(x0: number, x1: number) {
	s.solid(
		slabOf({ x: x0, y: -10, w: x1 - x0, d: 20, r: 2 }, 0, TRACK_H, s.P, 3, 0.6),
		{
			tone: "lo",
		}
	);
	s.line(lineOnTop([x0 + 3, 0], [x1 - 3, 0], TRACK_H, s.P), { tone: "faint" });
}

function call(x: number, lit = false) {
	const plan = { x: x - 10, y: -8, w: 20, d: 16, r: 2 };
	s.halo(plan, TRACK_H);
	s.solid(slabOf(plan, TRACK_H, 12, s.P, 4, 0.6), { lit });
}

benchPlate(s, PLATE);
track(-94, -DRUM_R - 4);
call(-72);
// Key post behind the drum, a keyed barrel on a square foot.
const post = { x: 22, y: -42, w: 18, d: 18, r: 2 };
s.halo(post, 0);
s.solid(slabOf(post, 0, 6, s.P, 3, 0.6), { tone: "lo" });
s.solid(cylinder(31, -33, 6, 6, 14, s.P, 28, 0.6));
s.line(lineOnTop([31, -36.5], [31, -29.5], 20, s.P), { tone: "hi" });
// The managed key standing in the barrel: blade and a flat bow.
s.solid(slabOf({ x: 30, y: -36, w: 2, d: 6, r: 0.4 }, 20, 6, s.P, 1), {
	tone: "lo",
});
s.solid(cylinder(31, -33, 5, 26, 2, s.P, 24, 0.4));
s.line(ring(31, -33, 1.6, 28, s.P, 16), { tone: "lo" });
// The drum, with the budget gauge on its lid.
s.halo({ x: -DRUM_R, y: -DRUM_R, w: DRUM_R * 2, d: DRUM_R * 2, r: DRUM_R }, 0);
s.solid(cylinder(0, 0, DRUM_R + 3, 0, 4, s.P, 56, 0.6), { tone: "lo" });
s.solid(cylinder(0, 0, DRUM_R, 4, DRUM_H - 4, s.P, 56, 0.8));
s.line(ring(0, 0, DRUM_R - 4, DRUM_H, s.P, 56), { tone: "lo" });
const ticks = radialTicks(0, 0, DRUM_R - 6, 32, 4, DRUM_H, [2.5, 5], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
const [nx, ny] = polar((Math.PI * 2 * 9) / 32, DRUM_R - 9);
s.line(lineOnTop([0, 0], [nx, ny], DRUM_H + 1.5, s.P), { tone: "hi" });
s.solid(cylinder(0, 0, 4, DRUM_H, 3, s.P, 24), { tone: "lo" });
track(DRUM_R + 4, 94);
call(70, true);

export const drawing = cardDrawing(s);
