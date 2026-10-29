import {
	boxCorners,
	cylinder,
	lineOnTop,
	radialTicks,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Budgets and cost: a spend meter lying face up. The needle sweeps toward a
 * hard stop pin (the lit part) set at the budget; past it, nothing runs.
 */

const PLATE = { x: -90, y: -60, w: 180, d: 120, r: 8 };
const R = 44;
const Z = 10;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, 24]]);

// The same angle convention as the kit's radial ticks: 0 points to -y.
const polar = (angle: number, radius: number): [number, number] => [
	Math.sin(angle) * radius,
	-Math.cos(angle) * radius,
];

benchPlate(s, PLATE);
s.halo({ x: -R - 4, y: -R - 4, w: 2 * R + 8, d: 2 * R + 8, r: R + 4 }, 0);
s.solid(cylinder(0, 0, R + 4, 0, Z, s.P, 64, 0.8));
s.line(ring(0, 0, R, Z, s.P, 64), { tone: "lo" });
const ticks = radialTicks(0, 0, R - 2, 40, 5, Z, [3, 6], s.P);
s.line(ticks.minor, { tone: "lo" });
s.line(ticks.major, { tone: "mid" });
const stop = (Math.PI * 2 * 30) / 40;
const [sx, sy] = polar(stop, R - 12);
s.solid(cylinder(sx, sy, 2.4, Z, 6, s.P, 20), { lit: true });
const needle = stop - 0.55;
const [nx, ny] = polar(needle, R - 10);
s.line(lineOnTop([0, 0], [nx, ny], Z + 2, s.P), { tone: "hi" });
s.solid(cylinder(0, 0, 4.5, Z, 3, s.P, 24), { tone: "lo" });
screws(
	s,
	[
		[-70, -40],
		[70, 40],
	],
	0,
	1.6
);
s.solid(slabOf({ x: 56, y: -50, w: 24, d: 10, r: 2 }, 0, 2, s.P, 3), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
