import { boxCorners, coil, cylinder, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Reproducibility checks: a bench vise with a die clamped in its jaws. Left
 * loose, the die rolls a new number every run; clamped by the screw it shows
 * the same face every time (the lit die, randomness pinned to a seed).
 */

const PLATE = { x: -96, y: -46, w: 192, d: 92, r: 8 };
const BED = { x: -80, y: -24, w: 150, d: 48, r: 4 };
const BED_H = 8;
const JAW_H = 34;
const DIE = 26;
const DIE_X = -48;
const SCREW_Z = BED_H + 14;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [-70, 0, JAW_H + 4]]);

benchPlate(s, PLATE);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 4, 0.8));
screws(
	s,
	[
		[BED.x + 6, BED.y + 6],
		[BED.x + BED.w - 6, BED.y + BED.d - 6],
	],
	BED_H,
	1.4
);
// Fixed jaw with its lamp.
const fixed = { x: -72, y: -22, w: 20, d: 44, r: 2 };
s.solid(slabOf(fixed, BED_H, JAW_H - BED_H, s.P, 3, 0.6));
lamp(s, [-62, -14], JAW_H, { radius: 1.8 });
// The die, clamped.
const die = { x: DIE_X - 4, y: -DIE / 2, w: DIE, d: DIE, r: 3 };
s.solid(slabOf(die, BED_H, DIE, s.P, 4, 0.8), { lit: true });
const pips: [number, number][] = [
	[-46, -6],
	[-35, 1],
	[-24, 8],
];
for (const [px, py] of pips) {
	s.solid(cylinder(px, py, 2.6, BED_H + DIE, 0.8, s.P, 16), {
		tone: "lo",
		crease: "none",
	});
}
// Moving jaw.
const moving = { x: DIE_X + DIE - 4, y: -22, w: 16, d: 44, r: 2 };
s.solid(slabOf(moving, BED_H, JAW_H - BED_H, s.P, 3, 0.6));
// Lead screw, bearing block and crank.
s.solid(
	slabOf(
		{ x: moving.x + moving.w, y: -3, w: 46, d: 6, r: 2 },
		SCREW_Z - 3,
		6,
		s.P,
		3
	),
	{ tone: "lo" }
);
const thread = coil(
	moving.x + moving.w + 2,
	32,
	[0, SCREW_Z],
	3.4,
	9,
	"x",
	s.P
);
s.line(thread.back, { tone: "lo" });
s.line(thread.front, { tone: "mid" });
const bearing = { x: 32, y: -12, w: 14, d: 24, r: 2 };
s.solid(slabOf(bearing, BED_H, 18, s.P, 3, 0.6));
s.solid(cylinder(58, 0, 6, BED_H, 18, s.P, 28, 0.4));
s.solid(slabOf({ x: 55, y: -22, w: 6, d: 44, r: 2 }, BED_H + 18, 4, s.P, 3));
s.solid(cylinder(58, -20, 4, BED_H + 22, 5, s.P, 20, 0.4), { tone: "lo" });
s.solid(cylinder(58, 20, 4, BED_H + 22, 5, s.P, 20, 0.4), { tone: "lo" });

export const drawing = cardDrawing(s);
