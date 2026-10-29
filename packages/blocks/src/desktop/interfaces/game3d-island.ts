/** Island rim around the walkable grid, in tiles. Scenery only. */
export const ISLAND_MARGIN = 3;

/**
 * The island's shape, kept free of React and three.js: a rounded rectangle
 * around the village grid whose shore wobbles in and out, so from above it
 * reads as an island rather than a square board. Ground, cliffs, foam, the
 * rim forest and the grass all ask it what is land.
 *
 * Geometry here is plain typed arrays (positions, normals, colors, indices)
 * that the scene wraps in `<bufferGeometry>`; see game3d-math.ts for why
 * the world never imports three.js at runtime.
 */

export interface IslandShape {
	/** Half the island's width (x) and depth (z), in tiles. */
	halfDepth: number;
	halfWidth: number;
	/** Corner radius, in tiles. */
	radius: number;
	/** Whether the shore wobbles (outdoors) or runs straight (the office). */
	wobble: boolean;
}

export interface MeshData {
	color?: Float32Array;
	index: Uint32Array;
	normal: Float32Array;
	position: Float32Array;
}

/** The size of the grid an island is grown around, in tiles. */
export interface IslandGrid {
	height: number;
	width: number;
}

export function islandShape(
	grid: IslandGrid,
	outdoors: boolean,
	margin = ISLAND_MARGIN
): IslandShape {
	const halfWidth = grid.width / 2 + margin;
	const halfDepth = grid.height / 2 + margin;
	return {
		halfDepth,
		halfWidth,
		radius: outdoors
			? Math.min(3.6, Math.min(halfWidth, halfDepth) * 0.8)
			: 0.25,
		wobble: outdoors,
	};
}

/** Stepping stones on the plaza's lawn row (outdoors): every third tile. */
export function steppingStone(x: number): boolean {
	return x % 3 === 1;
}

/** How far the shore is pulled in at (x, z): 0 to about 0.7 tiles. */
function inset(shape: IslandShape, x: number, z: number): number {
	if (!shape.wobble) {
		return 0;
	}
	const wave =
		Math.sin(x * 0.83 + z * 0.37) * 0.2 +
		Math.sin(z * 1.31 - x * 0.53 + 1.7) * 0.14 +
		Math.sin((x + z) * 2.3 + 0.4) * 0.06;
	return 0.32 + wave;
}

/** Signed distance to the rounded rectangle (negative inside), in tiles. */
function roundedBox(shape: IslandShape, x: number, z: number): number {
	const qx = Math.abs(x) - (shape.halfWidth - shape.radius);
	const qz = Math.abs(z) - (shape.halfDepth - shape.radius);
	const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0));
	return outside + Math.min(Math.max(qx, qz), 0) - shape.radius;
}

/** Signed distance to the shore: negative on land. */
export function shoreDistance(
	shape: IslandShape,
	x: number,
	z: number
): number {
	return roundedBox(shape, x, z) + inset(shape, x, z);
}

/** Whether (x, z) is land at least `margin` tiles in from the shore. */
export function onIsland(
	shape: IslandShape,
	x: number,
	z: number,
	margin = 0
): boolean {
	return shoreDistance(shape, x, z) < -margin;
}

/** Moves a point outside the shore onto it (a few gradient steps). */
function toShore(shape: IslandShape, x: number, z: number): [number, number] {
	let px = x;
	let pz = z;
	for (let step = 0; step < 4; step++) {
		const d = shoreDistance(shape, px, pz);
		if (d <= 0) {
			break;
		}
		const e = 0.01;
		const gx =
			(shoreDistance(shape, px + e, pz) - shoreDistance(shape, px - e, pz)) /
			(2 * e);
		const gz =
			(shoreDistance(shape, px, pz + e) - shoreDistance(shape, px, pz - e)) /
			(2 * e);
		const length = Math.hypot(gx, gz) || 1;
		px -= (gx / length) * d;
		pz -= (gz / length) * d;
	}
	return [px, pz];
}

/** Points around the shore, `step` tiles apart, counterclockwise from +x. */
export function shoreLine(shape: IslandShape, step = 0.3): [number, number][] {
	const points: [number, number][] = [];
	const { halfDepth, halfWidth, radius } = shape;
	const straightX = 2 * (halfWidth - radius);
	const straightZ = 2 * (halfDepth - radius);
	const arc = (Math.PI / 2) * radius;
	const perimeter = 2 * straightX + 2 * straightZ + 4 * arc;
	const count = Math.max(16, Math.round(perimeter / step));
	const corners: [number, number][] = [
		[halfWidth - radius, halfDepth - radius],
		[-(halfWidth - radius), halfDepth - radius],
		[-(halfWidth - radius), -(halfDepth - radius)],
		[halfWidth - radius, -(halfDepth - radius)],
	];
	// Each side runs a straight edge then a quarter arc.
	const sides = [straightZ, straightX, straightZ, straightX];
	for (let index = 0; index < count; index++) {
		let along = (index / count) * perimeter;
		let point: [number, number] = [halfWidth, 0];
		for (let side = 0; side < 4; side++) {
			const straight = sides[side] ?? 0;
			const corner = corners[side] ?? [0, 0];
			if (along <= straight) {
				const t = along - straight / 2;
				// Counterclockwise from above: up the +x side, back along +z,
				// down the -x side, then along -z.
				if (side === 0) {
					point = [halfWidth, t];
				} else if (side === 1) {
					point = [-t, halfDepth];
				} else if (side === 2) {
					point = [-halfWidth, -t];
				} else {
					point = [t, -halfDepth];
				}
				break;
			}
			along -= straight;
			if (along <= arc) {
				const angle = (side * Math.PI) / 2 + along / radius;
				point = [
					corner[0] + Math.cos(angle) * radius,
					corner[1] + Math.sin(angle) * radius,
				];
				break;
			}
			along -= arc;
		}
		points.push(toShore(shape, point[0] * 1.02, point[1] * 1.02));
	}
	return points;
}

/** Outward unit normals for a closed counterclockwise line. */
function outwardNormals(line: readonly [number, number][]): [number, number][] {
	return line.map((_, index) => {
		const before = line[(index - 1 + line.length) % line.length] ?? [0, 0];
		const after = line[(index + 1) % line.length] ?? [0, 0];
		const tx = after[0] - before[0];
		const tz = after[1] - before[1];
		const length = Math.hypot(tx, tz) || 1;
		// The line runs counterclockwise in (x, z), so outward is (tz, -tx).
		return [tz / length, -tx / length];
	});
}

type Rgb = readonly [number, number, number];

/**
 * The ground: one grid mesh, `cell` tiles per vertex step, with every vertex
 * outside the shore pulled onto it, heights from `height` and colors from
 * `color` (blended across tile edges, so paths fade softly into the lawn).
 */
export function groundMesh(
	shape: IslandShape,
	height: (x: number, z: number) => number,
	color: (x: number, z: number) => Rgb,
	cell = 0.5
): MeshData {
	const columns = Math.ceil((shape.halfWidth * 2 + 1) / cell) + 1;
	const rows = Math.ceil((shape.halfDepth * 2 + 1) / cell) + 1;
	const position = new Float32Array(columns * rows * 3);
	const normal = new Float32Array(columns * rows * 3);
	const colors = new Float32Array(columns * rows * 3);
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const index = row * columns + column;
			const [x, z] = toShore(
				shape,
				-shape.halfWidth - 0.5 + column * cell,
				-shape.halfDepth - 0.5 + row * cell
			);
			const y = height(x, z);
			const e = 0.05;
			const nx = height(x - e, z) - height(x + e, z);
			const nz = height(x, z - e) - height(x, z + e);
			const length = Math.hypot(nx, 2 * e, nz);
			position.set([x, y, z], index * 3);
			normal.set([nx / length, (2 * e) / length, nz / length], index * 3);
			colors.set(color(x, z), index * 3);
		}
	}
	const index = new Uint32Array((columns - 1) * (rows - 1) * 6);
	let at = 0;
	for (let row = 0; row < rows - 1; row++) {
		for (let column = 0; column < columns - 1; column++) {
			const a = row * columns + column;
			const b = a + 1;
			const c = a + columns;
			const d = c + 1;
			index.set([a, c, b, b, c, d], at);
			at += 6;
		}
	}
	return { color: colors, index, normal, position };
}

/**
 * The cliff (or, along the beach, a sand slope into the sea): a wall around
 * the shore from the ground's edge down to `bottom`, bulging out unevenly
 * like rock and flaring at the foot. `color` picks a color per shore point
 * and height.
 */
export function cliffMesh(
	shape: IslandShape,
	top: (x: number, z: number) => number,
	bottom: number,
	color: (x: number, z: number, t: number) => Rgb
): MeshData {
	const line = shoreLine(shape, 0.3);
	const normals = outwardNormals(line);
	// Rows down the wall: lip, upper bulge, lower bulge, foot.
	const levels = [0, 0.3, 0.7, 1];
	const flare = [0, 0.16, 0.3, 0.55];
	const count = line.length;
	const position = new Float32Array(count * levels.length * 3);
	const normal = new Float32Array(count * levels.length * 3);
	const colors = new Float32Array(count * levels.length * 3);
	for (const [index, [x, z]] of line.entries()) {
		const [nx, nz] = normals[index] ?? [0, 0];
		const rock = shape.wobble
			? 0.5 + 0.5 * Math.sin(index * 0.9) * Math.cos(index * 0.37 + 1)
			: 0;
		const lip = top(x, z);
		for (const [level, t] of levels.entries()) {
			const out = (flare[level] ?? 0) * (0.7 + rock * 0.6);
			const vertex = index * levels.length + level;
			position.set(
				[x + nx * out, lip + (bottom - lip) * t, z + nz * out],
				vertex * 3
			);
			const tilt = 0.35;
			const length = Math.hypot(nx, tilt, nz) || 1;
			normal.set([nx / length, tilt / length, nz / length], vertex * 3);
			colors.set(color(x, z, t), vertex * 3);
		}
	}
	const rows = levels.length;
	const index = new Uint32Array(count * (rows - 1) * 6);
	let at = 0;
	for (let column = 0; column < count; column++) {
		const next = (column + 1) % count;
		for (let level = 0; level < rows - 1; level++) {
			const a = column * rows + level;
			const b = next * rows + level;
			const c = a + 1;
			const d = b + 1;
			index.set([a, b, c, b, d, c], at);
			at += 6;
		}
	}
	return { color: colors, index, normal, position };
}

/** A flat band on the water following the shore, `from` to `to` tiles out. */
export function shoreBand(
	shape: IslandShape,
	y: number,
	from: number,
	to: number
): MeshData {
	const line = shoreLine(shape, 0.4);
	const normals = outwardNormals(line);
	const count = line.length;
	const position = new Float32Array(count * 2 * 3);
	const normal = new Float32Array(count * 2 * 3);
	for (const [index, [x, z]] of line.entries()) {
		const [nx, nz] = normals[index] ?? [0, 0];
		const wave = shape.wobble ? Math.sin(index * 0.7) * 0.08 : 0;
		position.set(
			[x + nx * (from + wave), y, z + nz * (from + wave)],
			index * 6
		);
		position.set(
			[x + nx * (to + wave), y, z + nz * (to + wave)],
			index * 6 + 3
		);
		normal.set([0, 1, 0, 0, 1, 0], index * 6);
	}
	const index = new Uint32Array(count * 6);
	for (let column = 0; column < count; column++) {
		const next = (column + 1) % count;
		const a = column * 2;
		const b = next * 2;
		index.set([a, b, a + 1, b, b + 1, a + 1], column * 6);
	}
	return { index, normal, position };
}

/**
 * A unit tile with rounded corners (custom-design path stones), one unit
 * across and one tall, its base on y = 0: a top cap and straight sides.
 */
export function roundedTile(radius = 0.16, segments = 4): MeshData {
	const outline: [number, number][] = [];
	const inner = 0.5 - radius;
	const corners: [number, number, number][] = [
		[inner, inner, 0],
		[-inner, inner, Math.PI / 2],
		[-inner, -inner, Math.PI],
		[inner, -inner, (Math.PI * 3) / 2],
	];
	for (const [cx, cz, start] of corners) {
		for (let step = 0; step <= segments; step++) {
			const angle = start + (step / segments) * (Math.PI / 2);
			outline.push([
				cx + Math.cos(angle) * radius,
				cz + Math.sin(angle) * radius,
			]);
		}
	}
	const count = outline.length;
	// Cap: a center vertex plus the outline; sides: the outline twice.
	const position = new Float32Array((1 + count + count * 2) * 3);
	const normal = new Float32Array((1 + count + count * 2) * 3);
	position.set([0, 1, 0], 0);
	normal.set([0, 1, 0], 0);
	for (const [index, [x, z]] of outline.entries()) {
		position.set([x, 1, z], (1 + index) * 3);
		normal.set([0, 1, 0], (1 + index) * 3);
		const length = Math.hypot(x, z) || 1;
		const side = 1 + count + index * 2;
		position.set([x, 1, z, x, 0, z], side * 3);
		normal.set(
			[x / length, 0, z / length, x / length, 0, z / length],
			side * 3
		);
	}
	const index = new Uint32Array(count * 3 + count * 6);
	let at = 0;
	for (let edge = 0; edge < count; edge++) {
		const next = (edge + 1) % count;
		// Counterclockwise seen from above, so the cap faces up.
		index.set([0, 1 + next, 1 + edge], at);
		at += 3;
		const a = 1 + count + edge * 2;
		const b = 1 + count + next * 2;
		index.set([a, b, a + 1, b, b + 1, a + 1], at);
		at += 6;
	}
	return { index, normal, position };
}
