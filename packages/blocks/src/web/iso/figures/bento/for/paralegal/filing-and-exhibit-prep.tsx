import {
	boxCorners,
	type Flat,
	lineOnTop,
	pathOf,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Filing and exhibit prep: an open ring binder. The left cover holds the
 * exhibit list and table of authorities; on the right, the records are
 * bound on the rings between tabbed dividers, one per exhibit, staggered
 * down the edge. The next exhibit's tab is the one being set (the lit tab).
 */

const PLATE = { x: -104, y: -54, w: 208, d: 108, r: 8 };
const COVER_Y = -42;
const COVER_D = 84;
const COVER_H = 2.4;
const RINGS = [-26, 0, 26];
const RING_R = 11;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [0, 0, RING_R + 6]]);

/** The upper half of a binder ring, standing in the x-z plane at `y`. */
function ringArc(y: number, z: number) {
	const points: Flat[] = [];
	for (let i = 0; i <= 20; i++) {
		const angle = (i / 20) * Math.PI;
		points.push(
			s.at([Math.cos(angle) * RING_R, y, z + Math.sin(angle) * RING_R])
		);
	}
	return pathOf(points);
}

benchPlate(s, PLATE);
const binder = { x: -92, y: COVER_Y, w: 184, d: COVER_D, r: 4 };
s.halo(binder, 0);
// Left cover with the exhibit list.
s.solid(slabOf({ ...binder, w: 82 }, 0, COVER_H, s.P, 4, 0.4));
const list = { x: -84, y: COVER_Y + 8, w: 66, d: COVER_D - 16, r: 1 };
s.solid(slabOf(list, COVER_H, 1.2, s.P, 2), { crease: "none" });
for (let i = 0; i < 7; i++) {
	const y = list.y + 8 + i * 8.6;
	const indent = i === 0 ? 0 : 6;
	s.line(
		lineOnTop(
			[list.x + 6 + indent, y],
			[list.x + 58 - (i % 3) * 8, y],
			COVER_H + 1.2,
			s.P
		),
		{ tone: i === 0 ? "mid" : "lo" }
	);
}
// Spine with the ring mechanism.
s.solid(
	slabOf(
		{ x: -10, y: COVER_Y, w: 20, d: COVER_D, r: 1 },
		0,
		COVER_H - 0.8,
		s.P,
		2
	),
	{
		tone: "lo",
	}
);
const mech = { x: -6, y: COVER_Y + 8, w: 12, d: COVER_D - 16, r: 4 };
s.solid(slabOf(mech, COVER_H - 0.8, 4, s.P, 4, 0.6));
screws(
	s,
	[
		[0, mech.y + 4],
		[0, mech.y + mech.d - 4],
	],
	COVER_H + 3.2,
	1.2
);
// Right cover: record bundles between staggered exhibit dividers.
s.solid(slabOf({ ...binder, x: 10, w: 82 }, 0, COVER_H, s.P, 4, 0.4));
let z = COVER_H;
const pages = { x: 14, y: COVER_Y + 4, w: 72, d: COVER_D - 8, r: 1 };
for (let i = 0; i < 4; i++) {
	s.solid(slabOf(pages, z, 2.4, s.P, 2), { crease: "none" });
	z += 2.4;
	const tabY = pages.y + 6 + i * 18;
	s.solid(slabOf({ x: 82, y: tabY, w: 13, d: 13, r: 1.5 }, z, 1, s.P, 2), {
		lit: i === 3,
		tone: i === 3 ? "hi" : "lo",
		crease: "none",
	});
	s.solid(slabOf({ ...pages, w: pages.w - 1 }, z, 1, s.P, 2), {
		tone: "lo",
		crease: "none",
	});
	z += 1;
}
for (const y of RINGS) {
	s.line(ringArc(y, COVER_H + 4), { tone: "hi" });
}

export const drawing = cardDrawing(s);
