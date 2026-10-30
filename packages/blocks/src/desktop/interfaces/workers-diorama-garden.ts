import type { FlowerPatch } from "./game3d-grass.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import { jitter } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type { PlacedBush, PlantedTree } from "./game3d-props.tsx";
import { SLAB } from "./workers-diorama-geometry.ts";
import type { OfficePlan } from "./workers-model.ts";

/** Tall potted plants in the room's corners and by the windows. */
export function cornerPlants(plan: OfficePlan): {
	bushes: PlacedBush[];
	pots: Vec3[];
} {
	const { halfDepth, halfWidth } = plan;
	const pots: Vec3[] = [
		[-halfWidth + 0.45, SLAB, -halfDepth + 0.45],
		[-halfWidth + 0.45, SLAB, halfDepth - 0.35],
		[halfWidth - 0.35, SLAB, halfDepth - 0.35],
	];
	const bushes: PlacedBush[] = pots.flatMap((at, index) => [
		{ at: [at[0], at[1] + 0.45, at[2]] as Vec3, scale: 1.1, seed: index + 70 },
		{ at: [at[0], at[1] + 0.8, at[2]] as Vec3, scale: 0.8, seed: index + 80 },
	]);
	return { bushes, pots };
}

/** The garden outside: trees, shrubs, flowers clear of the room. */
export function garden(shape: IslandShape, plan: OfficePlan) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const inside =
				Math.abs(fx) < plan.halfWidth + 0.9 &&
				Math.abs(fz) < plan.halfDepth + 1.1;
			if (inside || !onIsland(shape, fx, fz, 0.6)) {
				continue;
			}
			const hash = jitter(x, y, 3);
			const front = fz > plan.halfDepth || fx > plan.halfWidth;
			if (!front && hash < 0.6) {
				trees.push({
					at: [fx, 0, fz],
					kind: hash < 0.25 ? "cedar" : hash > 0.5 ? "blossom" : "fruit",
					scale: 0.85 + jitter(x, y, 9) * 0.3,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.3 && front) {
				trees.push({
					at: [fx, 0, fz],
					kind: "fruit",
					scale: 0.8,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.62) {
				bushes.push({ at: [fx, 0, fz], scale: 0.85, seed: x * 17 + y });
			} else if (hash > 0.82) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}
