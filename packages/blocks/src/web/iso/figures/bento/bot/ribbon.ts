import { extrude, type Plane } from "../../../kit/iso-kit.ts";
import type { Sketch, SolidStyle } from "../../static/sketch.tsx";

/*
 * A strip with real thickness laid along a plan polyline: tape between reels,
 * or a cord along the bench. Each straight run is one thin extruded quad,
 * drawn far to near so the nearer runs cover the joints.
 */
export function ribbon(
	s: Sketch,
	points: Plane[],
	z: number,
	height: number,
	width: number,
	style: SolidStyle = {}
) {
	const half = width / 2;
	const runs: Plane[][] = [];
	for (let i = 1; i < points.length; i++) {
		const from = points[i - 1];
		const to = points[i];
		if (!(from && to)) {
			continue;
		}
		const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
		if (length < 0.01) {
			continue;
		}
		const nx = (-(to[1] - from[1]) / length) * half;
		const ny = ((to[0] - from[0]) / length) * half;
		runs.push([
			[from[0] + nx, from[1] + ny],
			[to[0] + nx, to[1] + ny],
			[to[0] - nx, to[1] - ny],
			[from[0] - nx, from[1] - ny],
		]);
	}
	const depth = (run: Plane[]) =>
		run.reduce((sum, [x, y]) => sum + x + y, 0) / run.length;
	runs.sort((a, b) => depth(a) - depth(b));
	for (const run of runs) {
		s.solid(extrude(run, z, height, s.P, { convex: true }), {
			crease: "none",
			...style,
		});
	}
}

/** Points where a strip leaves circle `a` and meets circle `b` on one side. */
export function tangent(
	[ax, ay, ar]: [number, number, number],
	[bx, by, br]: [number, number, number],
	side: 1 | -1
): [Plane, Plane] {
	const dx = bx - ax;
	const dy = by - ay;
	const length = Math.hypot(dx, dy);
	const ux = dx / length;
	const uy = dy / length;
	const k = (ar - br) / length;
	const h = Math.sqrt(Math.max(0, 1 - k * k)) * side;
	const mx = ux * k - uy * h;
	const my = uy * k + ux * h;
	return [
		[ax + ar * mx, ay + ar * my],
		[bx + br * mx, by + br * my],
	];
}

/** Points along a circle's arc from angle `a0` to `a1` (radians). */
export function arc(
	[cx, cy, r]: [number, number, number],
	a0: number,
	a1: number,
	steps = 6
): Plane[] {
	return Array.from({ length: steps + 1 }, (_, i) => {
		const angle = a0 + ((a1 - a0) * i) / steps;
		return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)] as Plane;
	});
}
