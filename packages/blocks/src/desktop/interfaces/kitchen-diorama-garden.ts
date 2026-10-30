import type { FlowerPatch } from "./game3d-grass.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import { jitter } from "./game3d-math.ts";
import type { PlacedBush, PlantedTree } from "./game3d-props.tsx";

/** The garden outside: trees, shrubs, flowers clear of the room. */
export function garden(
	shape: IslandShape,
	halfWidth: number,
	halfDepth: number
): { bushes: PlacedBush[]; flowers: FlowerPatch[]; trees: PlantedTree[] } {
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
				Math.abs(fx) < halfWidth + 1 && Math.abs(fz) < halfDepth + 1.2;
			if (inside || !onIsland(shape, fx, fz, 0.6)) {
				continue;
			}
			const hash = jitter(x, y, 3);
			const front = fz > halfDepth;
			if (!front && hash < 0.55) {
				trees.push({
					at: [fx, 0, fz],
					kind: hash < 0.25 ? "cedar" : hash > 0.47 ? "blossom" : "fruit",
					scale: 0.8 + jitter(x, y, 9) * 0.3,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.7) {
				bushes.push({ at: [fx, 0, fz], scale: 0.85, seed: x * 17 + y });
			} else if (hash > 0.8) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}
