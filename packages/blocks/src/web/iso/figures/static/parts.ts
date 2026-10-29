import {
	corners,
	cylinder,
	depthOf,
	insetPlan,
	knurl,
	lineOnTop,
	type Plan,
	type Plane,
	type Point3,
	pathOf,
	planOutline,
	ring,
	slabOf,
	topTicks,
} from "../../kit/iso-kit.ts";
import type { Sketch } from "./sketch.tsx";

/*
 * Parts shared by the static product figures, each drawn into a sketch in
 * painter's order: the bench plate everything stands on, screws, knobs, lamps,
 * jack sockets, ruler strips and face outlines.
 */

/** Sort plan points back to front. */
export function byDepth<T extends readonly [number, number, ...unknown[]]>(
	points: T[],
	s: Sketch,
	z = 0
): T[] {
	return [...points].sort(
		(a, b) => depthOf([a[0], a[1], z], s.P) - depthOf([b[0], b[1], z], s.P)
	);
}

/** Counterbored screws: a ring with a centre dot. */
export function screws(s: Sketch, points: Plane[], z: number, radius = 2.2) {
	s.line(points.map(([x, y]) => ring(x, y, radius, z, s.P, 16)).join(""), {
		tone: "lo",
	});
	s.dots(
		points.map(([x, y]) => s.at([x, y, z])),
		{ size: 0.5 }
	);
}

/** The heavy plate on four turned feet that every figure stands on. */
export function benchPlate(
	s: Sketch,
	plan: Plan,
	{ height = 10, foot = 5 } = {}
) {
	const bottom = -height - foot;
	s.halo(plan, bottom, 9);
	for (const [x, y] of byDepth(corners(plan, 20), s)) {
		s.solid(cylinder(x, y, 6.5, bottom, 1.6, s.P, 28), { tone: "lo" });
		s.solid(cylinder(x, y, 5, bottom + 1.6, foot - 1.6, s.P, 28));
	}
	s.solid(slabOf(plan, -height, height, s.P, 8, 1.4));
	s.line(planOutline(insetPlan(plan, 5), 0, s.P), { tone: "lo" });
	screws(s, corners(plan, 10), 0);
}

/** A ruler strip lying on a face at `z`, ticks along x (or y). */
export function ruler(s: Sketch, strip: Plan, z = 0, axis: "x" | "y" = "x") {
	s.solid(slabOf(strip, z, 0.6, s.P, 3), { tone: "lo", crease: "none" });
	const ticks =
		axis === "x"
			? topTicks(
					strip.x + 4,
					strip.x + strip.w - 4,
					4,
					5,
					strip.y + 0.8,
					z + 0.6,
					[2, 3.6],
					s.P
				)
			: topTicks(
					strip.y + 4,
					strip.y + strip.d - 4,
					4,
					5,
					strip.x + 0.8,
					z + 0.6,
					[2, 3.6],
					s.P,
					"y"
				);
	s.line(ticks.minor, { tone: "lo" });
	s.line(ticks.major, { tone: "mid" });
}

/** A knurled knob on a collar, with a pointer on its cap. */
export function knob(
	s: Sketch,
	[x, y]: Plane,
	z: number,
	radius = 4,
	height = 4
) {
	const top = z + height;
	s.solid(cylinder(x, y, radius + 1.1, z, 1, s.P, 28), { tone: "lo" });
	s.solid(cylinder(x, y, radius, z + 1, height - 1, s.P, 32));
	s.line(knurl(x, y, radius, z + 1, top, 30, s.P), { tone: "lo" });
	s.line(lineOnTop([x, y], [x + radius - 0.8, y], top, s.P), { tone: "hi" });
}

/** A lamp in a bezel; `lit` makes it the figure's one accent. */
export function lamp(
	s: Sketch,
	[x, y]: Plane,
	z: number,
	{ lit = false, radius = 2.2 } = {}
) {
	s.solid(cylinder(x, y, radius + 1, z, 0.8, s.P, 24));
	s.solid(cylinder(x, y, radius, z + 0.8, 1.2, s.P, 24), {
		tone: lit ? "hi" : "lo",
		lit,
	});
}

/** A jack socket on a face at `z`. */
export function jack(s: Sketch, [x, y]: Plane, z: number) {
	s.line(ring(x, y, 2.4, z, s.P, 6), { tone: "mid" });
	s.line(ring(x, y, 1.4, z, s.P, 20), { tone: "lo" });
}

/** A rectangle on the vertical face at y (`face: "y"`) or x (`face: "x"`). */
export function faceRect(
	s: Sketch,
	face: "x" | "y",
	at: number,
	a0: number,
	a1: number,
	z0: number,
	z1: number
) {
	const corner = (a: number, z: number): Point3 =>
		face === "y" ? [a, at, z] : [at, a, z];
	return pathOf(
		[corner(a0, z0), corner(a1, z0), corner(a1, z1), corner(a0, z1)].map(s.at),
		true
	);
}

/** A straight segment on a vertical face (for rule lines standing for text). */
export function faceLine(
	s: Sketch,
	face: "x" | "y",
	at: number,
	a0: number,
	a1: number,
	z: number
) {
	const corner = (a: number): Point3 =>
		face === "y" ? [a, at, z] : [at, a, z];
	return pathOf([s.at(corner(a0)), s.at(corner(a1))]);
}

/** Rows of rule lines on a vertical face, standing for text or a list. */
export function faceRules(
	s: Sketch,
	face: "x" | "y",
	at: number,
	start: number,
	top: number,
	widths: number[],
	gap = 5
) {
	widths.forEach((width, index) => {
		s.line(faceLine(s, face, at, start, start + width, top - index * gap), {
			tone: index === 0 ? "mid" : "faint",
			free: true,
		});
	});
}
