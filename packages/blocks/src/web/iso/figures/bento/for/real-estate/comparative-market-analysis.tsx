import { boxCorners, cylinder, ring, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, ruler, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";
import { house } from "./house.ts";

/*
 * Comparative market analysis: a balance. The subject house sits on one pan,
 * a stack of comparable sales on the other; the pointer at the pivot (the
 * lit part) reads where the price settles.
 */

const PLATE = { x: -78, y: -38, w: 156, d: 80, r: 8 };
const BASE = { x: -20, y: -20, w: 40, d: 40, r: 4 };
const BASE_H = 8;
const BEAM_Z = 24;
const PAN_X = 48;
const PAN_Z = BEAM_Z + 12;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-PAN_X, 0, PAN_Z + 26],
	[0, 0, BEAM_Z + 36],
]);

function pan(x: number) {
	s.solid(cylinder(x, 0, 5, BEAM_Z + 6, 2, s.P, 24), { tone: "lo" });
	s.solid(cylinder(x, 0, 3, BEAM_Z + 8, PAN_Z - BEAM_Z - 8, s.P, 16));
	s.solid(cylinder(x, 0, 18, PAN_Z, 3, s.P, 48, 0.6));
	s.line(ring(x, 0, 14, PAN_Z + 3, s.P, 48), { tone: "faint" });
}

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.6));
screws(
	s,
	[
		[BASE.x + 6, BASE.y + 6],
		[BASE.x + BASE.w - 6, BASE.y + BASE.d - 6],
	],
	BASE_H,
	1.4
);
// Pillar and beam.
s.solid(
	slabOf({ x: -8, y: -8, w: 16, d: 16, r: 2 }, BASE_H, BEAM_Z - BASE_H, s.P, 4)
);
s.solid(
	slabOf(
		{ x: -PAN_X - 8, y: -5, w: 2 * PAN_X + 16, d: 10, r: 3 },
		BEAM_Z,
		6,
		s.P,
		4,
		0.6
	)
);
// Subject house on the far pan.
pan(-PAN_X);
house(s, { x: -PAN_X - 10, y: -8, w: 20, d: 16, r: 0.4 }, 10, {
	rise: 7,
	z: PAN_Z + 3,
});
// Pointer standing on the pivot.
s.solid(cylinder(0, 0, 5, BEAM_Z + 6, 2, s.P, 24), { tone: "lo" });
s.solid(
	slabOf({ x: -1.2, y: -1.2, w: 2.4, d: 2.4, r: 0.4 }, BEAM_Z + 8, 26, s.P, 1),
	{
		lit: true,
	}
);
// Comparable sales stacked on the near pan.
pan(PAN_X);
for (let i = 0; i < 3; i++) {
	s.solid(
		slabOf(
			{ x: PAN_X - 11 + i, y: -8 - i, w: 22, d: 16, r: 1 },
			PAN_Z + 3 + i * 5,
			5,
			s.P,
			2,
			0.4
		),
		{ tone: i === 2 ? "mid" : "lo" }
	);
}
ruler(s, { x: -44, y: 24, w: 88, d: 8, r: 1 }, 0);

export const drawing = cardDrawing(s);
