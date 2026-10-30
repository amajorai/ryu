import type { FlowerPatch } from "./game3d-grass.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import { jitter } from "./game3d-math.ts";
import type { PlacedBush, PlantedTree } from "./game3d-props.tsx";
import { inRect } from "./rides-diorama-city.tsx";
import {
	RIVER_HALF,
	type RidesCityPlan,
	riverAt,
	type Vec3,
	type WorldRect,
} from "./rides-scene.ts";

/** The park: trees, a pond, a path and benches. */
export function park(rect: WorldRect) {
	const trees: PlantedTree[] = [];
	const stones: Vec3[] = [];
	const cx = (rect.minX + rect.maxX) / 2;
	const cz = (rect.minZ + rect.maxZ) / 2;
	const width = rect.maxX - rect.minX;
	const depth = rect.maxZ - rect.minZ;
	for (let index = 0; index < 14; index++) {
		const x = rect.minX + 0.3 + jitter(index, 1, 3) * (width - 0.6);
		const z = rect.minZ + 0.3 + jitter(index, 2, 5) * (depth - 0.6);
		if (Math.hypot(x - cx, z - cz) < 1.1) {
			continue;
		}
		trees.push({
			at: [x, 0, z],
			kind: index % 3 === 0 ? "blossom" : index % 3 === 1 ? "fruit" : "cedar",
			scale: 0.5 + jitter(index, 4, 7) * 0.15,
			seed: index * 37,
		});
	}
	for (let t = 0; t <= 1; t += 0.06) {
		stones.push([
			rect.minX + t * width,
			0,
			cz + Math.sin(t * Math.PI * 2) * depth * 0.18,
		]);
	}
	return {
		benches: [{ at: [cx - 0.9, 0, cz + 0.55] as Vec3, scale: 0.6, yaw: 0 }],
		pond: {
			at: [cx + 0.2, 0, cz - 0.15] as Vec3,
			radius: Math.min(0.75, depth * 0.25),
		},
		stones,
		trees,
	};
}

/** Trees, shrubs and flowers on the lawn beyond the city, clear of the river. */
export function countryside(plan: RidesCityPlan, shape: IslandShape) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.6;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.6;
			if (
				!onIsland(shape, fx, fz, 0.5) ||
				inRect(fx, fz, plan.rect, 0.4) ||
				Math.abs(fz - riverAt(plan.frame, fx)) < RIVER_HALF + 0.35
			) {
				continue;
			}
			const hash = jitter(x, y, 3);
			if (hash < 0.5) {
				trees.push({
					at: [fx, 0, fz],
					kind: hash < 0.2 ? "cedar" : hash > 0.4 ? "blossom" : "fruit",
					scale: 0.7 + jitter(x, y, 9) * 0.25,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.65) {
				bushes.push({ at: [fx, 0, fz], scale: 0.75, seed: x * 17 + y });
			} else if (hash > 0.85) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}
