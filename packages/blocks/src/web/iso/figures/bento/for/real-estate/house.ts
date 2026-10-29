import {
	cameraOf,
	type Flat,
	iso,
	type Plan,
	type Point3,
	type Projection,
	pathOf,
	type SolidPaths,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { faceRect } from "../../../static/parts.ts";
import type { Sketch } from "../../../static/sketch.tsx";

/*
 * Real-estate parts: a convex polyhedron solid (the kit only extrudes
 * vertically) and, built on it, a small gabled house model.
 */

type Vec = [number, number, number];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const centroid = (points: Vec[]): Vec => {
	const sum = points.reduce<Vec>(
		(total, point) => [
			total[0] + point[0],
			total[1] + point[1],
			total[2] + point[2],
		],
		[0, 0, 0]
	);
	return [
		sum[0] / points.length,
		sum[1] / points.length,
		sum[2] / points.length,
	];
};

function hull(points: Flat[]): Flat[] {
	const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const turn = (o: Flat, a: Flat, b: Flat) =>
		(a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const half = (list: Flat[]) => {
		const out: Flat[] = [];
		for (const point of list) {
			while (
				out.length >= 2 &&
				turn(out.at(-2) as Flat, out.at(-1) as Flat, point) <= 0
			) {
				out.pop();
			}
			out.push(point);
		}
		return out.slice(0, -1);
	};
	return [...half(sorted), ...half([...sorted].reverse())];
}

/** A convex solid from its faces, shaded and outlined like the kit's slabs. */
export function polyhedron(faces: Point3[][], P: Projection): SolidPaths {
	const { sinA, cosA, sinE, cosE } = cameraOf(P);
	const view: Vec = [cosA * cosE, sinA * cosE, sinE];
	const middle = centroid(faces.flat());
	const keyOf = (point: Point3) => point.map((v) => v.toFixed(2)).join(",");
	const edges = new Map<string, { a: Point3; b: Point3; seen: boolean[] }>();
	const top: string[] = [];
	const shades: string[][] = [[], [], [], []];
	for (const face of faces) {
		const [p0, p1, p2] = face as [Point3, Point3, Point3];
		let normal = cross(sub(p1, p0), sub(p2, p0));
		if (dot(normal, sub(centroid(face), middle)) < 0) {
			normal = [-normal[0], -normal[1], -normal[2]];
		}
		const length = Math.hypot(...normal) || 1;
		const [nx, ny, nz] = normal.map((v) => v / length) as Vec;
		const seen = dot([nx, ny, nz], view) > 1e-6;
		face.forEach((a, index) => {
			const b = face[(index + 1) % face.length] as Point3;
			const key = [keyOf(a), keyOf(b)].sort().join("|");
			const edge = edges.get(key) ?? { a, b, seen: [] };
			edge.seen.push(seen);
			edges.set(key, edge);
		});
		if (!seen) {
			continue;
		}
		const d = pathOf(
			face.map((point) => iso(point, P)),
			true
		);
		if (nz > 0.8) {
			top.push(d);
		} else {
			const flat = Math.hypot(nx, ny) || 1;
			const lit = ((nx / flat) * -sinA + (ny / flat) * cosA + 1) / 2;
			const bucket = Math.min(3, Math.max(0, Math.floor(lit * 4)));
			shades[bucket]?.push(d);
		}
	}
	const outline: string[] = [];
	const crease: string[] = [];
	for (const { a, b, seen } of edges.values()) {
		const visible = seen.filter(Boolean).length;
		const segment = pathOf([iso(a, P), iso(b, P)]);
		if (visible === 1) {
			outline.push(segment);
		} else if (visible === 2) {
			crease.push(segment);
		}
	}
	return {
		fill: pathOf(hull(faces.flat().map((point) => iso(point, P))), true),
		outline: outline.join(""),
		crease: crease.join(""),
		top: top.join(""),
		shades: shades.map((list) => list.join("")),
	};
}

/** A gable roof over `plan` at `z`, its ridge along x, rising `rise`. */
export function gableRoof(plan: Plan, z: number, rise: number, P: Projection) {
	const { x, y, w, d } = plan;
	const ridge = y + d / 2;
	const a: Point3 = [x, y, z];
	const b: Point3 = [x + w, y, z];
	const c: Point3 = [x + w, y + d, z];
	const e: Point3 = [x, y + d, z];
	const r0: Point3 = [x, ridge, z + rise];
	const r1: Point3 = [x + w, ridge, z + rise];
	return polyhedron(
		[
			[a, b, r1, r0],
			[e, c, r1, r0],
			[b, c, r1],
			[a, e, r0],
			[a, b, c, e],
		],
		P
	);
}

/**
 * A house model: walls with a door and windows on the front (y) face, two
 * windows on the side (x) face, and an overhanging gable roof with eaves.
 */
export function house(
	s: Sketch,
	walls: Plan,
	height: number,
	{ rise = height * 0.75, lit = false, z = 0 } = {}
) {
	const { x, y, w, d } = walls;
	s.halo(walls, z);
	s.solid(slabOf(walls, z, height, s.P, 2, 0.4), { lit });
	const front = y + d;
	const doorW = Math.min(8, w * 0.18);
	const doorX = x + w * 0.62;
	s.line(faceRect(s, "y", front, doorX, doorX + doorW, z, z + height * 0.6), {
		tone: "mid",
	});
	const sill = z + height * 0.35;
	const head = z + height * 0.7;
	const pane = Math.min(9, w * 0.2);
	s.line(
		faceRect(s, "y", front, x + w * 0.16, x + w * 0.16 + pane, sill, head),
		{
			tone: "lo",
		}
	);
	const side = x + w;
	for (const at of [y + d * 0.22, y + d * 0.6]) {
		s.line(faceRect(s, "x", side, at, at + d * 0.2, sill, head), {
			tone: "lo",
		});
	}
	const eave = 3;
	const roof = {
		x: x - eave,
		y: y - eave,
		w: w + eave * 2,
		d: d + eave * 2,
		r: 0,
	};
	s.solid(slabOf(roof, z + height, 1.6, s.P, 1), { tone: "lo" });
	s.solid(gableRoof(roof, z + height + 1.6, rise, s.P), { lit });
}
