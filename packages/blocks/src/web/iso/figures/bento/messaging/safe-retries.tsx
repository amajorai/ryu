import {
	boxCorners,
	cylinder,
	depthOf,
	extrude,
	insetPlan,
	type Plane,
	planOutline,
	ring,
	sideRing,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Safe retries: a ratchet wheel turned by a key. The pawl (the lit part)
 * drops into the next tooth, so the same key can turn it once and never back
 * through the same charge again; a retry only meets the pawl.
 */

const PLATE = { x: -96, y: -50, w: 192, d: 100, r: 8 };
const HOUSING = { x: -80, y: -38, w: 112, d: 76, r: 6 };
const HOUSING_H = 10;
const GEAR: [number, number] = [-30, 0];
const GEAR_R = 28;
const TEETH = 20;
const LOCK: [number, number] = [60, 8];
const LOCK_H = 16;

const s = createCardSketch([...boxCorners(PLATE, -15, 0), [60, 8, 46]]);

/** One sawtooth tooth: a convex wedge standing on the wheel rim. */
function tooth(i: number): Plane[] {
	const a = (i / TEETH) * Math.PI * 2;
	const b = ((i + 0.92) / TEETH) * Math.PI * 2;
	const inner = GEAR_R - 5;
	return [
		[GEAR[0] + Math.cos(a) * inner, GEAR[1] + Math.sin(a) * inner],
		[GEAR[0] + Math.cos(b) * GEAR_R, GEAR[1] + Math.sin(b) * GEAR_R],
		[GEAR[0] + Math.cos(b) * inner, GEAR[1] + Math.sin(b) * inner],
	];
}

/** Teeth sorted far to near, split by which side of the hub they sit on. */
function teethBySide(): { far: Plane[][]; near: Plane[][] } {
	const hub = depthOf([GEAR[0], GEAR[1], 0], s.P);
	const all = Array.from({ length: TEETH }, (_, i) => tooth(i)).map((ring) => {
		const cx = ring.reduce((sum, [x]) => sum + x, 0) / ring.length;
		const cy = ring.reduce((sum, [, y]) => sum + y, 0) / ring.length;
		return { ring, depth: depthOf([cx, cy, 0], s.P) };
	});
	all.sort((a, b) => a.depth - b.depth);
	return {
		far: all.filter((t) => t.depth <= hub).map((t) => t.ring),
		near: all.filter((t) => t.depth > hub).map((t) => t.ring),
	};
}

benchPlate(s, PLATE);
s.halo(HOUSING, 0);
s.solid(slabOf(HOUSING, 0, HOUSING_H, s.P, 6, 0.8));
s.line(planOutline(insetPlan(HOUSING, 4), HOUSING_H, s.P, 4), {
	tone: "faint",
});
lamp(s, [HOUSING.x + 10, HOUSING.y + 10], HOUSING_H, { radius: 1.8 });
// The ratchet wheel on its hub.
s.solid(cylinder(GEAR[0], GEAR[1], 10, HOUSING_H, 2, s.P, 28), { tone: "lo" });
const teeth = teethBySide();
for (const ring of teeth.far) {
	s.solid(extrude(ring, HOUSING_H + 2, 6, s.P));
}
s.solid(cylinder(GEAR[0], GEAR[1], GEAR_R - 5, HOUSING_H + 2, 6, s.P, 60));
for (const ring of teeth.near) {
	s.solid(extrude(ring, HOUSING_H + 2, 6, s.P));
}
s.line(ring(GEAR[0], GEAR[1], GEAR_R - 11, HOUSING_H + 8, s.P, 40), {
	tone: "faint",
});
s.solid(cylinder(GEAR[0], GEAR[1], 6, HOUSING_H + 8, 3, s.P, 24), {
	tone: "lo",
});
s.dots([s.at([GEAR[0], GEAR[1], HOUSING_H + 11])], { size: 0.8 });
// The pawl on its pivot, held into a tooth by a spring.
const pivot: [number, number] = [GEAR[0] + GEAR_R + 18, -6];
s.solid(cylinder(pivot[0], pivot[1], 5, HOUSING_H, 6, s.P, 24), {
	tone: "lo",
});
s.solid(
	slabOf(
		{ x: GEAR[0] + GEAR_R - 6, y: pivot[1] - 4, w: 28, d: 8, r: 3 },
		HOUSING_H + 6,
		5,
		s.P,
		3
	),
	{ lit: true }
);
s.solid(cylinder(pivot[0], pivot[1], 2.4, HOUSING_H + 11, 2, s.P, 16), {
	tone: "lo",
});
s.solid(cylinder(pivot[0] - 6, 20, 3, HOUSING_H, 9, s.P, 16));
screws(
	s,
	[
		[HOUSING.x + HOUSING.w - 8, HOUSING.y + HOUSING.d - 8],
		[HOUSING.x + 8, HOUSING.y + HOUSING.d - 8],
	],
	HOUSING_H,
	1.4
);
// The lock that takes the key, one turn per key.
s.halo({ x: LOCK[0] - 14, y: LOCK[1] - 14, w: 28, d: 28, r: 14 }, 0);
s.solid(cylinder(LOCK[0], LOCK[1], 14, 0, 4, s.P, 40, 0.6), { tone: "lo" });
s.solid(cylinder(LOCK[0], LOCK[1], 11, 4, LOCK_H - 4, s.P, 40, 0.6));
s.line(ring(LOCK[0], LOCK[1], 8, LOCK_H, s.P, 32), { tone: "lo" });
s.solid(
	slabOf(
		{ x: LOCK[0] - 1, y: LOCK[1] - 6, w: 2, d: 12, r: 0.5 },
		LOCK_H,
		8,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: LOCK[0] - 2, y: LOCK[1] - 10, w: 4, d: 20, r: 1.5 },
		LOCK_H + 8,
		16,
		s.P,
		3
	)
);
s.line(sideRing([LOCK[0] + 2, LOCK[1], LOCK_H + 18], 4, "x", s.P, 20), {
	tone: "lo",
});

export const drawing = cardDrawing(s);
