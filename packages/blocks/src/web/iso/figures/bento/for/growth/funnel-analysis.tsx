import {
	boxCorners,
	cylinder,
	depthOf,
	ring,
	segment,
	sideArc,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Funnel analysis: a stepped funnel on a stand, wide at the top and narrowing
 * stage by stage. One stage leaks through a spout into a catch cup on the
 * bench (the lit part): that is the biggest drop-off, where the next test goes.
 */

const PLATE = { x: -72, y: -64, w: 144, d: 128, r: 8 };
const CX = 0;
const CY = -14;
const TIERS: [radius: number, z: number, height: number][] = [
	[15, 8, 12],
	[22, 20, 12],
	[29, 32, 12],
	[36, 44, 12],
];
const TOP = 56;
const LEG_R = 33;
const LEGS = [0.4, 2.5, 4.6].map((angle): [number, number] => [
	CX + Math.cos(angle) * LEG_R,
	CY + Math.sin(angle) * LEG_R,
]);

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [CX, CY, TOP + 4]]);
const legDepth = (leg: [number, number]) => depthOf([leg[0], leg[1], 0], s.P);
const centreDepth = depthOf([CX, CY, 0], s.P);

function leg([x, y]: [number, number]) {
	s.solid(cylinder(x, y, 3.4, 0, 1.4, s.P, 20), { tone: "lo" });
	s.solid(cylinder(x, y, 2, 1.4, TOP - 12 - 1.4, s.P, 16));
}

benchPlate(s, PLATE);
s.halo({ x: CX - 14, y: CY - 14, w: 28, d: 28, r: 14 }, 0);
for (const far of LEGS.filter((point) => legDepth(point) < centreDepth)) {
	leg(far);
}
s.solid(cylinder(CX, CY, 12, 0, 8, s.P, 32), { tone: "lo" });
screws(s, [[CX, CY]], 8, 1.6);
for (const [index, [radius, z, height]] of TIERS.entries()) {
	s.solid(cylinder(CX, CY, radius, z, height, s.P, 48, 0.6));
	s.line(sideArc(CX, CY, radius, z + height / 2, s.P), { tone: "faint" });
	if (index === 2) {
		// The leaking stage: a spout out of its front.
		const spout = { x: CX - 4, y: CY + radius - 2, w: 8, d: 24, r: 1 };
		s.solid(slabOf(spout, z + 3, 4, s.P, 2, 0.3), { tone: "lo" });
	}
}
s.line(ring(CX, CY, TIERS[3]?.[0] ? TIERS[3][0] - 3 : 24, TOP, s.P, 48), {
	tone: "lo",
});
s.line(ring(CX, CY, 6, TOP, s.P, 24), { tone: "mid" });
for (const near of LEGS.filter((point) => legDepth(point) >= centreDepth)) {
	leg(near);
}
// Catch cup under the spout.
const CUP_Y = CY + 50;
s.halo({ x: CX - 10, y: CUP_Y - 10, w: 20, d: 20, r: 10 }, 0);
s.solid(cylinder(CX, CUP_Y, 10, 0, 12, s.P, 36, 0.5), { lit: true });
s.line(ring(CX, CUP_Y, 7.5, 12, s.P, 28), { tone: "lo" });
// The drip falling from the spout's lip into the cup.
s.line(segment([CX, CUP_Y - 2, 35], [CX, CUP_Y - 2, 12], s.P), {
	tone: "mid",
	dotted: true,
});

export const drawing = cardDrawing(s);
