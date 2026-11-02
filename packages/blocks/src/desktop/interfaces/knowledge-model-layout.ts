import {
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	type ForceSettings,
	type KnowledgeGraph,
	type KnowledgeNodeKind,
	nodeRadius,
} from "./knowledge-model.ts";

/** Knowledge force layout: where nodes settle on the canvas. */

// ---------------------------------------------------------------------------
// Force layout
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

export interface Layout {
	alpha: number;
	dims: 2 | 3;
	ids: string[];
	index: Map<string, number>;
	/** Per-link bias toward the target (d3's degree-weighted split). */
	linkBias: Float32Array;
	/** Per-link base strength (1 / smaller endpoint degree). */
	linkStrength: Float32Array;
	/** Source and target index per link. */
	links: Int32Array;
	positions: Float32Array;
	radii: Float32Array;
	velocities: Float32Array;
}

const ALPHA_MIN = 0.002;
const ALPHA_DECAY = 1 - ALPHA_MIN ** (1 / 300);
const VELOCITY_DECAY = 0.42;
const DEPTH_GRAVITY = 1.15;
/** World units kept between two nodes' radii (about 4px at the fit). */
const COLLIDE_GAP = 4;
/** Share of an overlap resolved per tick (each node takes half). */
const COLLIDE_STRENGTH = 0.35;
/** How far the stage aspect may stretch the layout (each way). */
const ASPECT_LIMIT = 2.4;

/**
 * Ticks to run before the first frame: small graphs open settled (so the
 * loading outline is where they stay),
 * large ones (where a tick costs more) settle on screen.
 */
export function warmTicks(count: number): number {
	return Math.round(
		Math.min(300, Math.max(20, 1_500_000 / Math.max(1, count * count)))
	);
}

export function hashString(value: string): number {
	let hash = 2_166_136_261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/** A stable starting point for a node: a shell by kind, angle by id. */
function seedPosition(id: string, kind: KnowledgeNodeKind, dims: 2 | 3): Vec3 {
	const hash = hashString(id);
	const u = (hash & 0xff_ff) / 0xff_ff;
	const v = (hash >>> 16) / 0xff_ff;
	const shell =
		kind === "project" || kind === "team"
			? 18
			: kind === "agent"
				? 34
				: kind === "topic"
					? 50
					: 62;
	const theta = u * Math.PI * 2;
	if (dims === 2) {
		return [Math.cos(theta) * shell, Math.sin(theta) * shell, 0];
	}
	const phi = Math.acos(2 * v - 1);
	return [
		Math.sin(phi) * Math.cos(theta) * shell,
		Math.cos(phi) * shell,
		Math.sin(phi) * Math.sin(theta) * shell,
	];
}

/**
 * A layout for `graph`. Nodes already placed in `previous` keep their spot
 * (so toggling a filter does not reshuffle the graph); new ones start on a
 * deterministic shell. When `previous` holds exactly these nodes, its heat
 * carries over too, so a settled graph does not move.
 */
export function createLayout(
	graph: KnowledgeGraph,
	dims: 2 | 3,
	previous?: Layout | null
): Layout {
	const count = graph.nodes.length;
	const ids = graph.nodes.map((node) => node.id);
	const index = new Map(ids.map((id, position) => [id, position]));
	const positions = new Float32Array(count * 3);
	const radii = new Float32Array(count);
	let reused = 0;
	for (const [position, node] of graph.nodes.entries()) {
		radii[position] = nodeRadius(node);
		const before = previous?.index.get(node.id);
		const source =
			before !== undefined && previous
				? [
						previous.positions[before * 3] ?? 0,
						previous.positions[before * 3 + 1] ?? 0,
						dims === 3 ? (previous.positions[before * 3 + 2] ?? 0) : 0,
					]
				: seedPosition(node.id, node.kind, dims);
		if (before !== undefined) {
			reused += 1;
		}
		positions.set(source, position * 3);
	}
	const degree = new Int32Array(count);
	const pairs: number[] = [];
	for (const link of graph.links) {
		const source = index.get(link.source);
		const target = index.get(link.target);
		if (source === undefined || target === undefined) {
			continue;
		}
		pairs.push(source, target);
		degree[source] = (degree[source] ?? 0) + 1;
		degree[target] = (degree[target] ?? 0) + 1;
	}
	const links = Int32Array.from(pairs);
	const linkCount = links.length / 2;
	const linkBias = new Float32Array(linkCount);
	const linkStrength = new Float32Array(linkCount);
	for (let link = 0; link < linkCount; link += 1) {
		const sourceDegree = degree[links[link * 2] ?? 0] ?? 1;
		const targetDegree = degree[links[link * 2 + 1] ?? 0] ?? 1;
		linkBias[link] = sourceDegree / (sourceDegree + targetDegree);
		linkStrength[link] = 1 / Math.max(1, Math.min(sourceDegree, targetDegree));
	}
	const fresh = count === 0 ? 1 : 1 - reused / count;
	// The same nodes as before (back from a local graph): carry on from where
	// that layout was, so a settled graph stays exactly as it was.
	const same =
		previous !== null &&
		previous !== undefined &&
		reused === count &&
		previous.ids.length === count &&
		previous.dims === dims;
	return {
		alpha: same ? previous.alpha : Math.max(0.35, fresh),
		dims,
		ids,
		index,
		linkBias,
		links,
		linkStrength,
		positions,
		radii,
		velocities: new Float32Array(count * 3),
	};
}

export function isSettled(layout: Layout): boolean {
	return layout.alpha < ALPHA_MIN;
}

/** Wake the layout after a force setting changes. */
export function reheat(layout: Layout, alpha = 0.4): void {
	layout.alpha = Math.max(layout.alpha, alpha);
}

/**
 * Obsidian's "Animate": gather every node close to the centre and run the
 * simulation again from full heat, so the graph unfolds.
 */
export function replayLayout(layout: Layout, gather = 0.12): void {
	const count = layout.ids.length;
	const center = [0, 0, 0];
	for (let index = 0; index < count; index += 1) {
		for (let axis = 0; axis < 3; axis += 1) {
			center[axis] =
				(center[axis] ?? 0) + (layout.positions[index * 3 + axis] ?? 0) / count;
		}
	}
	for (let index = 0; index < count; index += 1) {
		for (let axis = 0; axis < 3; axis += 1) {
			const at = index * 3 + axis;
			const middle = center[axis] ?? 0;
			layout.positions[at] =
				middle + ((layout.positions[at] ?? 0) - middle) * gather;
			layout.velocities[at] = 0;
		}
	}
	layout.alpha = 1;
}

/** One tick: many-body repulsion, link springs, gravity to the centre. */
export function stepLayout(layout: Layout, forces: ForceSettings): void {
	if (isSettled(layout)) {
		return;
	}
	const { alpha, dims, links, linkBias, linkStrength, positions, velocities } =
		layout;
	const count = layout.ids.length;
	const axes = dims;
	const repel = 10 + forces.repelForce * 100;
	const gravity = 0.02 + forces.centerForce * 0.16;
	const aspect = Math.min(
		ASPECT_LIMIT,
		Math.max(1 / ASPECT_LIMIT, forces.aspect ?? 1)
	);
	const stretch = aspect ** 0.75;
	const axisGravity: Vec3 = [
		gravity * stretch,
		gravity / stretch,
		gravity * DEPTH_GRAVITY,
	];
	const spring = 0.2 + forces.linkForce * 1.6;
	// Repulsion stops past a few link lengths, so separate clusters drift
	// back together under gravity instead of pushing each other off screen.
	const reachSquared = (forces.linkDistance * 5) ** 2;

	for (let a = 0; a < count; a += 1) {
		for (let b = a + 1; b < count; b += 1) {
			let distanceSquared = 0;
			const delta: Vec3 = [0, 0, 0];
			for (let axis = 0; axis < axes; axis += 1) {
				const d =
					(positions[b * 3 + axis] ?? 0) - (positions[a * 3 + axis] ?? 0);
				delta[axis] = d;
				distanceSquared += d * d;
			}
			if (distanceSquared > reachSquared) {
				continue;
			}
			if (distanceSquared < 1) {
				// Coincident nodes: nudge apart deterministically.
				delta[0] = ((a * 7 + b * 13) % 11) / 11 - 0.5 || 0.3;
				distanceSquared = 1;
			}
			// Collide: two nodes never sit closer than their radii plus a
			// gap, so separate nodes never visually merge.
			const reach =
				(layout.radii[a] ?? 0) + (layout.radii[b] ?? 0) + COLLIDE_GAP;
			if (distanceSquared < reach * reach) {
				const distance = Math.sqrt(distanceSquared);
				const push = ((reach - distance) / distance) * COLLIDE_STRENGTH;
				for (let axis = 0; axis < axes; axis += 1) {
					const move = (delta[axis] ?? 0) * push;
					velocities[a * 3 + axis] = (velocities[a * 3 + axis] ?? 0) - move;
					velocities[b * 3 + axis] = (velocities[b * 3 + axis] ?? 0) + move;
				}
			}
			const weight = (repel * alpha) / distanceSquared;
			for (let axis = 0; axis < axes; axis += 1) {
				const push = (delta[axis] ?? 0) * weight;
				velocities[a * 3 + axis] = (velocities[a * 3 + axis] ?? 0) - push;
				velocities[b * 3 + axis] = (velocities[b * 3 + axis] ?? 0) + push;
			}
		}
	}

	const linkCount = links.length / 2;
	for (let link = 0; link < linkCount; link += 1) {
		const source = links[link * 2] ?? 0;
		const target = links[link * 2 + 1] ?? 0;
		const delta: Vec3 = [0, 0, 0];
		let length = 0;
		for (let axis = 0; axis < axes; axis += 1) {
			const d =
				(positions[target * 3 + axis] ?? 0) +
				(velocities[target * 3 + axis] ?? 0) -
				(positions[source * 3 + axis] ?? 0) -
				(velocities[source * 3 + axis] ?? 0);
			delta[axis] = d;
			length += d * d;
		}
		length = Math.sqrt(length) || 1e-3;
		const pull =
			((length - forces.linkDistance) / length) *
			alpha *
			spring *
			(linkStrength[link] ?? 1);
		const bias = linkBias[link] ?? 0.5;
		for (let axis = 0; axis < axes; axis += 1) {
			const move = (delta[axis] ?? 0) * pull;
			velocities[target * 3 + axis] =
				(velocities[target * 3 + axis] ?? 0) - move * bias;
			velocities[source * 3 + axis] =
				(velocities[source * 3 + axis] ?? 0) + move * (1 - bias);
		}
	}

	for (let node = 0; node < count; node += 1) {
		for (let axis = 0; axis < axes; axis += 1) {
			const slot = node * 3 + axis;
			// Depth pulls in a little harder, so the 3D graph is a thick
			// volume facing the camera: it turns in depth without stacking
			// nodes head-on. Width and height follow the stage's aspect.
			const pull = axisGravity[axis] ?? gravity;
			const velocity =
				((velocities[slot] ?? 0) - (positions[slot] ?? 0) * pull * alpha) *
				(1 - VELOCITY_DECAY);
			velocities[slot] = velocity;
			positions[slot] = (positions[slot] ?? 0) + velocity;
		}
	}
	layout.alpha += (0 - layout.alpha) * ALPHA_DECAY;
}

/** Run up to `ticks` steps at once (warm start, reduced motion, tests). */
export function settleLayout(
	layout: Layout,
	forces: ForceSettings,
	ticks: number
): void {
	for (let tick = 0; tick < ticks && !isSettled(layout); tick += 1) {
		stepLayout(layout, forces);
	}
}

/** Centre and radius of the bounding sphere around every node. */
export function layoutBounds(layout: Layout): {
	center: Vec3;
	radius: number;
} {
	const count = layout.ids.length;
	if (count === 0) {
		return { center: [0, 0, 0], radius: 40 };
	}
	const center: Vec3 = [0, 0, 0];
	for (let node = 0; node < count; node += 1) {
		for (let axis = 0; axis < 3; axis += 1) {
			center[axis] =
				(center[axis] ?? 0) + (layout.positions[node * 3 + axis] ?? 0);
		}
	}
	for (let axis = 0; axis < 3; axis += 1) {
		center[axis] = (center[axis] ?? 0) / count;
	}
	let radius = 0;
	for (let node = 0; node < count; node += 1) {
		const dx = (layout.positions[node * 3] ?? 0) - center[0];
		const dy = (layout.positions[node * 3 + 1] ?? 0) - center[1];
		const dz = (layout.positions[node * 3 + 2] ?? 0) - center[2];
		radius = Math.max(
			radius,
			Math.hypot(dx, dy, dz) + (layout.radii[node] ?? 0)
		);
	}
	// Room for the labels under the outermost nodes.
	radius *= 1.1;
	return { center, radius: Math.max(radius, 24) };
}

export function positionOf(layout: Layout, id: string): Vec3 | null {
	const index = layout.index.get(id);
	if (index === undefined) {
		return null;
	}
	return [
		layout.positions[index * 3] ?? 0,
		layout.positions[index * 3 + 1] ?? 0,
		layout.positions[index * 3 + 2] ?? 0,
	];
}

/** Threads by status for the panel's summary line. */
export function statusCounts(
	threads: readonly InterfaceThread[]
): Record<ThreadStatus, number> {
	const counts: Record<ThreadStatus, number> = {
		attention: 0,
		quiet: 0,
		waiting: 0,
		working: 0,
		"your-turn": 0,
	};
	for (const thread of threads) {
		counts[threadStatus(thread)] += 1;
	}
	return counts;
}
