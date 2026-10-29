import { boxCorners, cylinder, ring, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, byDepth, ruler } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Prior-year comparison: a pair of column gauges on one base. The back row of
 * round posts is last year's figures, the front row of square columns this
 * year's; most pairs match, and the one column that jumped (the lit part) is
 * the change worth a closer look.
 */

const PLATE = { x: -94, y: -50, w: 188, d: 100, r: 8 };
const BASE = { x: -78, y: -32, w: 144, d: 52, r: 4 };
const BASE_H = 5;
const PRIOR_Y = -18;
const NOW_Y = 6;
const PRIOR = [20, 26, 16, 22, 18, 24];
const NOW = [22, 25, 18, 46, 17, 26] as const;
const JUMP = 3;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[-60 + JUMP * 24, NOW_Y, BASE_H + NOW[JUMP] + 2],
]);

type Column = [number, number, "prior" | "now", number];

const columns: Column[] = [];
PRIOR.forEach((height, i) => {
	columns.push([-60 + i * 24, PRIOR_Y, "prior", height]);
});
NOW.forEach((height, i) => {
	columns.push([-60 + i * 24, NOW_Y, "now", height]);
});

benchPlate(s, PLATE);
s.halo(BASE, 0);
s.solid(slabOf(BASE, 0, BASE_H, s.P, 4, 0.8));
for (const [x, y, row, height] of byDepth(columns, s, BASE_H)) {
	if (row === "prior") {
		s.solid(cylinder(x, y, 6, BASE_H, 1.4, s.P, 24), { tone: "lo" });
		s.solid(cylinder(x, y, 4.2, BASE_H + 1.4, height, s.P, 24), {
			tone: "lo",
		});
		s.line(ring(x, y, 2, BASE_H + 1.4 + height, s.P, 16), { tone: "faint" });
	} else {
		const lit = x === -60 + JUMP * 24;
		s.solid(
			slabOf(
				{ x: x - 5, y: y - 5, w: 10, d: 10, r: 1 },
				BASE_H,
				height,
				s.P,
				3,
				0.6
			),
			{ lit }
		);
	}
}
ruler(
	s,
	{ x: BASE.x + 4, y: BASE.y + BASE.d - 10, w: BASE.w - 8, d: 6, r: 1 },
	BASE_H
);

export const drawing = cardDrawing(s);
