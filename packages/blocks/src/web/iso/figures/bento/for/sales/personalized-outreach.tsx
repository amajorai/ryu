import {
	boxCorners,
	cylinder,
	knurl,
	pathOf,
	planOutline,
	ring,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Personalized outreach: a letter rack with one envelope standing in each
 * slot, one per account. The front envelope is the fresh draft waiting
 * for your review (the lit part); the sealing stamp waits beside the rack.
 */

const PLATE = { x: -96, y: -48, w: 192, d: 96, r: 8 };
const RACK = { x: -82, y: -32, w: 112, d: 64, r: 4 };
const RACK_H = 8;
const ENV_D = 50;
const ENV_H = 32;
const SLOTS = 6;
const GAP = 16;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[RACK.x + 8 + (SLOTS - 1) * GAP, 0, RACK_H + ENV_H + 2],
]);

function envelope(x: number, lit: boolean) {
	const y0 = RACK.y + (RACK.d - ENV_D) / 2;
	const z0 = RACK_H;
	s.solid(slabOf({ x, y: y0, w: 2, d: ENV_D, r: 0.4 }, z0, ENV_H, s.P, 2), {
		lit,
		crease: "none",
	});
	const face = x + 2;
	s.line(
		pathOf([
			s.at([face, y0 + 1, z0 + ENV_H - 1]),
			s.at([face, y0 + ENV_D / 2, z0 + ENV_H * 0.45]),
			s.at([face, y0 + ENV_D - 1, z0 + ENV_H - 1]),
		]),
		{ tone: lit ? "mid" : "lo" }
	);
}

benchPlate(s, PLATE);
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 6, 0.8));
for (let i = 0; i < SLOTS; i++) {
	const x = RACK.x + 8 + i * GAP;
	s.line(
		planOutline(
			{ x: x - 1, y: RACK.y + 5, w: 4, d: RACK.d - 10, r: 1 },
			RACK_H,
			s.P,
			2
		),
		{
			tone: "lo",
		}
	);
	envelope(x, i === SLOTS - 1);
}
// Sealing stamp: a turned handle on a square die.
const STAMP: [number, number] = [62, 8];
const die = { x: STAMP[0] - 12, y: STAMP[1] - 12, w: 24, d: 24, r: 3 };
s.halo(die, 0);
s.solid(slabOf(die, 0, 5, s.P, 3, 0.6), { tone: "lo" });
s.solid(cylinder(STAMP[0], STAMP[1], 4, 5, 18, s.P, 24));
s.solid(cylinder(STAMP[0], STAMP[1], 8, 23, 9, s.P, 32, 0.8));
s.line(knurl(STAMP[0], STAMP[1], 8, 23, 32, 28, s.P), { tone: "lo" });
s.line(ring(STAMP[0], STAMP[1], 4, 32, s.P, 24), { tone: "mid" });
screws(
	s,
	[
		[RACK.x + RACK.w - 6, RACK.y + 6],
		[RACK.x + RACK.w - 6, RACK.y + RACK.d - 6],
	],
	RACK_H,
	1.4
);

export const drawing = cardDrawing(s);
