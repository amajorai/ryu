import type { FlowerPatch } from "./game3d-grass.tsx";
import type { InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, type MeshData, onIsland } from "./game3d-island.ts";
import { jitter } from "./game3d-math.ts";
import type { Scene3dTheme } from "./game3d-palette.ts";
import type { PlacedBush, PlantedTree } from "./game3d-props.tsx";
import { linearRgb } from "./game3d-toon.ts";
import type { VillagerPose } from "./game3d-villager.tsx";
import type { PathStopState } from "./path-model.ts";
import { PATH_3D } from "./path-palette.ts";
import { type PathWorld, trailDistance } from "./path-world.ts";

/** The Path diorama's scene geometry: the hill, trail, pads, signs and woods. */

export const TRAIL_HALF_WIDTH = 0.46;
const PAD_RADIUS = 0.56;
const CURRENT_RADIUS = 0.74;
export const PAD_HEIGHT = 0.32;
/** The mascot stands a head taller than the other villagers. */
export const MASCOT_SCALE = 1.3;
export const VILLAGER_HEIGHT = 1.62;

const TOP_COLOR: Record<PathStopState, keyof typeof PATH_3D> = {
	attention: "attention",
	current: "current",
	done: "done",
	fresh: "fresh",
	reply: "reply",
	waiting: "waiting",
	working: "working",
};

/** The mascot's pose from the stop it stands at. */
export const POSE: Record<PathStopState, VillagerPose> = {
	attention: "failed",
	current: "needs-you",
	done: "idle",
	fresh: "idle",
	reply: "needs-you",
	waiting: "waiting",
	working: "working",
};

/** Stops that ask for you: a bouncing "!" and their title always shown. */
export function needsYou(state: PathStopState): boolean {
	return state === "attention" || state === "reply";
}

function color(key: keyof typeof PATH_3D): string {
	const value = PATH_3D[key];
	return typeof value === "string" ? value : (value[0] ?? "");
}

/** The narrow trail as a ribbon on the ground, its edges blending into grass. */
export function trailRibbon(
	world: PathWorld,
	night: boolean,
	theme: Scene3dTheme
): MeshData {
	const dirt = linearRgb(night ? PATH_3D.trailNight : PATH_3D.trail);
	const grass = linearRgb(theme.grass[0]);
	const edge = [0, 1, 2].map(
		(channel) => (dirt[channel] ?? 0) * 0.7 + (grass[channel] ?? 0) * 0.3
	);
	const count = world.trail.length;
	// A solid dirt band with a thin soft edge blending into the grass.
	const offsets = [
		-TRAIL_HALF_WIDTH,
		-TRAIL_HALF_WIDTH * 0.72,
		TRAIL_HALF_WIDTH * 0.72,
		TRAIL_HALF_WIDTH,
	];
	const lanes = offsets.length;
	const position = new Float32Array(count * lanes * 3);
	const normal = new Float32Array(count * lanes * 3);
	const colors = new Float32Array(count * lanes * 3);
	for (let index = 0; index < count; index++) {
		const point = world.trail[index] ?? [0, 0];
		const before = world.trail[Math.max(0, index - 1)] ?? point;
		const after = world.trail[Math.min(count - 1, index + 1)] ?? point;
		const dx = after[0] - before[0];
		const dz = after[1] - before[1];
		const length = Math.hypot(dx, dz) || 1;
		const nx = -dz / length;
		const nz = dx / length;
		const y = (world.trailHeights[index] ?? 0) + 0.07;
		for (const [lane, offset] of offsets.entries()) {
			const base = (index * lanes + lane) * 3;
			position[base] = point[0] + nx * offset;
			position[base + 1] = y;
			position[base + 2] = point[1] + nz * offset;
			normal[base + 1] = 1;
			const tone = lane === 0 || lane === lanes - 1 ? edge : dirt;
			colors[base] = tone[0] ?? 0;
			colors[base + 1] = tone[1] ?? 0;
			colors[base + 2] = tone[2] ?? 0;
		}
	}
	const strips = lanes - 1;
	const index = new Uint32Array(Math.max(0, count - 1) * strips * 6);
	for (let step = 0; step < count - 1; step++) {
		for (let lane = 0; lane < strips; lane++) {
			const a = step * lanes + lane;
			const b = a + lanes;
			index.set([a, a + 1, b, a + 1, b + 1, b], (step * strips + lane) * 6);
		}
	}
	return { color: colors, index, normal, position };
}

/** The hill's terraces: an earth riser under a grass top for each. */
export function terraceParts(world: PathWorld, theme: Scene3dTheme) {
	const bodies: InstanceSpec[] = [];
	const tops: InstanceSpec[] = [];
	const { maxX, minX } = world.width;
	const back = world.bounds.minZ + 0.6;
	for (const terrace of world.terraces) {
		const depth = terrace.front - back;
		const x = (minX + maxX) / 2;
		const z = (terrace.front + back) / 2;
		bodies.push({
			color: theme.cliff,
			position: [x, terrace.height / 2, z],
			scale: [maxX - minX, terrace.height, depth],
		});
		tops.push({
			color: theme.grass[terrace.row % theme.grass.length],
			position: [x, terrace.height - 0.04, z - 0.01],
			scale: [maxX - minX + 0.06, 0.1, depth + 0.06],
		});
	}
	return { bodies, tops };
}

/** Stone steps where the trail climbs a terrace. */
export function stairParts(world: PathWorld): InstanceSpec[] {
	const steps: InstanceSpec[] = [];
	for (const stair of world.stairs) {
		const dx = Math.sin(stair.yaw);
		const dz = Math.cos(stair.yaw);
		const rise = stair.to - stair.from;
		for (let step = 0; step < 3; step++) {
			const top = stair.from + (rise * (step + 1)) / 3;
			const along = (step - 1) * 0.24;
			steps.push({
				color: PATH_3D.stone,
				position: [
					stair.at[0] + dx * along,
					(stair.from + top) / 2,
					stair.at[1] + dz * along,
				],
				rotation: [0, stair.yaw, 0],
				scale: [0.78, top - stair.from + 0.02, 0.26],
			});
		}
	}
	return steps;
}

/** The pads: chunky stone bodies, coloured tops, flags, moss and glows. */
export function padParts(world: PathWorld, night: boolean) {
	const bodies: InstanceSpec[] = [];
	const tops: InstanceSpec[] = [];
	const glows: InstanceSpec[] = [];
	const poles: InstanceSpec[] = [];
	const flags: InstanceSpec[] = [];
	const moss: InstanceSpec[] = [];
	for (const stone of world.stones) {
		const [x, z] = stone.at;
		const { state } = stone.stop;
		const radius = state === "current" ? CURRENT_RADIUS : PAD_RADIUS;
		bodies.push({
			color: night ? PATH_3D.stoneNight : PATH_3D.stone,
			position: [x, stone.y + PAD_HEIGHT / 2, z],
			rotation: [0, stone.index, 0],
			scale: [radius, PAD_HEIGHT, radius],
		});
		const top: InstanceSpec = {
			color: color(TOP_COLOR[state]),
			position: [x, stone.y + PAD_HEIGHT + 0.012, z],
			scale: [radius * 0.8, 0.03, radius * 0.8],
		};
		// Done and current pads glow; the rest are painted stone.
		if (state === "done" || state === "current") {
			glows.push(top);
		} else {
			tops.push(top);
		}
		if (state === "done") {
			const fx = x - 0.4;
			const fz = z - 0.28;
			poles.push({
				position: [fx, stone.y + PAD_HEIGHT + 0.35, fz],
				scale: [0.03, 0.7, 0.03],
			});
			flags.push({
				color: PATH_3D.done,
				position: [fx + 0.17, stone.y + PAD_HEIGHT + 0.6, fz],
				rotation: [0, Math.PI / 4, 0],
				scale: [0.32, 0.2, 0.03],
			});
		}
		if (state === "waiting" || state === "fresh") {
			for (let tuft = 0; tuft < 3; tuft++) {
				const angle = stone.index * 1.7 + tuft * 2.1;
				moss.push({
					color: PATH_3D.moss,
					position: [
						x + Math.cos(angle) * radius * 0.62,
						stone.y + PAD_HEIGHT + 0.02,
						z + Math.sin(angle) * radius * 0.62,
					],
					scale: [0.16, 0.05, 0.12],
				});
			}
		}
	}
	return { bodies, flags, glows, moss, poles, tops };
}

/** Chunky signposts: a thick post, a capped board in the unit's colour. */
export function signParts(world: PathWorld) {
	const posts: InstanceSpec[] = [];
	const boards: InstanceSpec[] = [];
	for (const sign of world.signs) {
		const [x, z] = sign.at;
		posts.push({
			color: PATH_3D.signPost,
			position: [x, sign.y + 0.62, z],
			scale: [0.16, 1.24, 0.16],
		});
		boards.push(
			{
				color:
					PATH_3D.signBoards[(sign.unit.index - 1) % PATH_3D.signBoards.length],
				position: [x, sign.y + 1.06, z + 0.06],
				rotation: [0, Math.PI / 4, 0],
				scale: [1.3, 0.5, 0.12],
			},
			{
				color: PATH_3D.signPost,
				position: [x, sign.y + 1.36, z + 0.06],
				rotation: [0, Math.PI / 4, 0],
				scale: [1.42, 0.08, 0.18],
			}
		);
	}
	return { boards, posts };
}

/** The summit: a cairn of stones and a tall flag. */
export function summitParts(world: PathWorld) {
	const [x, z] = world.finish;
	const y = world.finishY;
	return {
		cairn: [
			{ position: [x, y + 0.2, z], scale: [0.55, 0.4, 0.5] },
			{ position: [x + 0.08, y + 0.52, z - 0.04], scale: [0.36, 0.3, 0.34] },
			{ position: [x - 0.04, y + 0.76, z], scale: [0.22, 0.2, 0.22] },
		] as InstanceSpec[],
		cloth: [
			{
				color: PATH_3D.flag,
				position: [x + 0.36, y + 1.95, z],
				rotation: [0, Math.PI / 4, 0],
				scale: [0.7, 0.42, 0.05],
			},
		] as InstanceSpec[],
		pole: [
			{
				color: PATH_3D.flagPole,
				position: [x, y + 1.25, z],
				scale: [0.05, 1.9, 0.05],
			},
		] as InstanceSpec[],
	};
}

/** Woods at the back and sides, shrubs and flowers, on the hill's levels. */
export function scenery(world: PathWorld, shape: IslandShape) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	const groundAt = (x: number, z: number) => {
		if (x < world.width.minX || x > world.width.maxX) {
			return 0;
		}
		let height = 0;
		for (const terrace of world.terraces) {
			if (z < terrace.front - 0.15) {
				height = Math.max(height, terrace.height);
			}
		}
		return height;
	};
	const nearRiser = (x: number, z: number) =>
		x > world.width.minX - 0.3 &&
		x < world.width.maxX + 0.3 &&
		world.terraces.some((terrace) => Math.abs(z - terrace.front) < 0.35);
	const signNear = (x: number, z: number) =>
		world.signs.some((sign) => Math.hypot(sign.at[0] - x, sign.at[1] - z) < 1);
	const summitNear = (x: number, z: number) =>
		Math.hypot(world.finish[0] - x, world.finish[1] - z) < 1.4;
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			if (
				!onIsland(shape, fx, fz, 0.6) ||
				signNear(fx, fz) ||
				summitNear(fx, fz) ||
				nearRiser(fx, fz)
			) {
				continue;
			}
			const clearance = trailDistance(world.trail, fx, fz);
			const ground = groundAt(fx, fz);
			const outside =
				fz < world.bounds.minZ + 0.9 ||
				fx < world.width.minX - 0.4 ||
				fx > world.width.maxX + 0.4;
			const front = fz > world.bounds.maxZ - 2.4;
			if (outside && !front && clearance > 1.9 && hash < 0.5) {
				let kind: PlantedTree["kind"] = "fruit";
				if (hash < 0.28) {
					kind = "cedar";
				} else if (hash > 0.46) {
					kind = "blossom";
				}
				trees.push({
					at: [fx, ground, fz],
					kind,
					scale: 0.8 + jitter(x, y, 9) * 0.35,
					seed: Math.round(hash * 1000),
				});
			} else if (clearance > 1.05 && hash > 0.86) {
				bushes.push({ at: [fx, ground, fz], scale: 0.75, seed: x * 31 + y });
			} else if (clearance > 0.75 && hash > 0.62) {
				flowers.push({ at: [fx, ground, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}
