import {
	extrude,
	type Plane,
	type Projection,
} from "../../../../kit/iso-kit.ts";

/** A straight bar of `width` lying between two plan points, `height` tall. */
export function bar(
	from: Plane,
	to: Plane,
	width: number,
	z: number,
	height: number,
	projection: Projection
) {
	const dx = to[0] - from[0];
	const dy = to[1] - from[1];
	const length = Math.hypot(dx, dy) || 1;
	const nx = (-dy / length) * (width / 2);
	const ny = (dx / length) * (width / 2);
	const ring: Plane[] = [
		[from[0] + nx, from[1] + ny],
		[to[0] + nx, to[1] + ny],
		[to[0] - nx, to[1] - ny],
		[from[0] - nx, from[1] - ny],
	];
	return extrude(ring, z, height, projection, { convex: true });
}
