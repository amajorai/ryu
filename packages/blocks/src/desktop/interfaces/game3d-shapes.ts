import type { MeshData } from "./game3d-island.ts";

/**
 * Soft lathed shapes as plain typed arrays (see game3d-math.ts for why the
 * world never imports three.js at runtime): a profile of (radius, height)
 * points spun around the vertical axis, with smooth normals taken from the
 * profile's own slope, so silhouettes and cel bands stay round, never
 * faceted.
 */

type Profile = readonly (readonly [number, number])[];

/**
 * One cedar tier, island style: a plump cone with a rounded tip and a soft
 * lip that curls under, spanning y -0.5..0.5 and radius 1 (the same box as
 * a unit cone, so instance transforms carry over).
 */
const CEDAR_TIER: Profile = [
	[0, 0.5],
	[0.1, 0.47],
	[0.2, 0.4],
	[0.36, 0.25],
	[0.54, 0.07],
	[0.72, -0.12],
	[0.87, -0.29],
	[0.96, -0.4],
	[1, -0.46],
	[0.97, -0.51],
	[0.86, -0.55],
	[0.6, -0.56],
	[0.3, -0.55],
	[0, -0.54],
];

/** Outward normal of the profile at `index`, from its neighbors' slope. */
function profileNormal(profile: Profile, index: number): [number, number] {
	const [r, y] = profile[index] ?? [0, 0];
	if (r === 0) {
		// On the axis: straight up at the tip, straight down underneath.
		return index === 0 ? [0, 1] : [0, -1];
	}
	const before = profile[Math.max(0, index - 1)] ?? [r, y];
	const after = profile[Math.min(profile.length - 1, index + 1)] ?? [r, y];
	const dr = after[0] - before[0];
	const dy = after[1] - before[1];
	const length = Math.hypot(dr, dy) || 1;
	return [-dy / length, dr / length];
}

/** Spins `profile` (from the top down) around the y axis. */
export function latheMesh(profile: Profile, segments: number): MeshData {
	const rings = profile.length;
	const columns = segments + 1;
	const position = new Float32Array(rings * columns * 3);
	const normal = new Float32Array(rings * columns * 3);
	for (const [ring, [r, y]] of profile.entries()) {
		const [nr, ny] = profileNormal(profile, ring);
		for (let column = 0; column < columns; column++) {
			const angle = (column / segments) * Math.PI * 2;
			const cos = Math.cos(angle);
			const sin = Math.sin(angle);
			const at = (ring * columns + column) * 3;
			position.set([r * sin, y, r * cos], at);
			normal.set([nr * sin, ny, nr * cos], at);
		}
	}
	const index = new Uint32Array((rings - 1) * segments * 6);
	let cursor = 0;
	for (let ring = 0; ring < rings - 1; ring++) {
		for (let column = 0; column < segments; column++) {
			const a = ring * columns + column;
			const b = a + columns;
			// Counterclockwise from outside: the profile runs top to bottom.
			index.set([a, b, a + 1, a + 1, b, b + 1], cursor);
			cursor += 6;
		}
	}
	return { index, normal, position };
}

/** A rounded cedar tier, cut smooth enough to read round up close. */
export function cedarTier(segments = 20): MeshData {
	return latheMesh(CEDAR_TIER, segments);
}
