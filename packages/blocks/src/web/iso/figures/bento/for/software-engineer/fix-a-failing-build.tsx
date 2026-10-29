import { boxCorners, cylinder, ring, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Fix a failing build: a test-tube rack. The suite is the row of capped
 * tubes standing through the shelf; the one that failed has been lifted and
 * refilled (the lit tube), with a lamp per tube on the base to confirm the run.
 */

const PLATE = { x: -96, y: -44, w: 192, d: 88, r: 8 };
const BASE = { x: -76, y: -24, w: 152, d: 46, r: 4 };
const BASE_H = 5;
const SHELF_Z = 26;
const SHELF_H = 4;
const TUBE_Y = -8;
const TUBE_R = 6;
const TUBE_TOP = 50;
const FIXED = 3;
const XS = [-50, -30, -10, 10, 30, 50];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[60, TUBE_Y, TUBE_TOP + 16],
]);

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 6, 0.8));
screws(
	s,
	[
		[BASE.x + 7, BASE.y + 7],
		[BASE.x + BASE.w - 7, BASE.y + 7],
	],
	BASE_H,
	1.4
);
// Far end post, lower tube bodies, then the shelf and near end post.
s.solid(
	slabOf(
		{ x: BASE.x + 2, y: -18, w: 8, d: 20, r: 1 },
		BASE_H,
		SHELF_Z - BASE_H,
		s.P,
		2
	)
);
XS.forEach((x, i) => {
	const lift = i === FIXED ? 10 : 0;
	s.solid(
		cylinder(
			x,
			TUBE_Y,
			TUBE_R,
			BASE_H + lift,
			SHELF_Z - BASE_H - lift,
			s.P,
			28
		),
		{
			tone: "lo",
		}
	);
});
s.solid(
	slabOf(
		{ x: BASE.x + 2, y: -18, w: BASE.w - 4, d: 20, r: 2 },
		SHELF_Z,
		SHELF_H,
		s.P,
		4,
		0.6
	)
);
s.solid(
	slabOf(
		{ x: BASE.x + BASE.w - 10, y: -18, w: 8, d: 20, r: 1 },
		BASE_H,
		SHELF_Z - BASE_H,
		s.P,
		2
	)
);
XS.forEach((x, i) => {
	const lit = i === FIXED;
	const top = TUBE_TOP + (lit ? 10 : 0);
	const from = SHELF_Z + SHELF_H;
	s.line(ring(x, TUBE_Y, TUBE_R + 1.2, from, s.P, 28), { tone: "lo" });
	s.solid(cylinder(x, TUBE_Y, TUBE_R, from, top - from, s.P, 28), { lit });
	s.solid(cylinder(x, TUBE_Y, TUBE_R + 0.8, top, 4, s.P, 28), { tone: "lo" });
});
// One lamp per tube along the front of the base.
for (const x of XS) {
	lamp(s, [x, BASE.y + BASE.d - 8], BASE_H, { radius: 1.8 });
}

export const drawing = cardDrawing(s);
