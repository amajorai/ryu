/* eslint-disable react/no-unknown-property */
import { useMemo } from "react";
import type { FlowerPatch } from "./game3d-grass.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import {
	type PlacedBush,
	type PlantedTree,
	PROP_INK,
} from "./game3d-props.tsx";
import {
	addBox,
	SLAB,
	TILE,
	TRUCK,
	tileToWorld,
	WAREHOUSE_BOUNDS,
} from "./warehouse-diorama-layout.ts";
import { FLOOR } from "./warehouse-model.ts";
import type { WarehouseArt } from "./warehouse-palette.ts";

/** The dock edge outside the right wall, the yard and the truck. */
export function Dock({ art, shipped }: { art: WarehouseArt; shipped: number }) {
	const [dockX] = tileToWorld(FLOOR.width, 0);
	const truck = tileToWorld(TRUCK.x, TRUCK.y);
	const boxes = useMemo(() => {
		const out = {
			boxes: [] as InstanceSpec[],
			labels: [] as InstanceSpec[],
			tapes: [] as InstanceSpec[],
		};
		for (let index = 0; index < Math.min(6, shipped); index++) {
			addBox(
				out,
				[
					truck[0] + 0.4 + (index % 3) * 0.42,
					0.55,
					truck[2] + 0.35 + Math.floor(index / 3) * 0.42,
				],
				art.box,
				true,
				index * 9
			);
		}
		return out;
	}, [art, shipped, truck]);
	return (
		<group>
			{/* Yellow and black dock bumpers along the open edge. */}
			{[5.4, 7.6, 9.8, 12].map((y) => {
				const [, , z] = tileToWorld(0, y);
				return (
					<ToonMesh
						color={art.safetyDark}
						key={y}
						position={[dockX + 0.06, SLAB - 0.02, z]}
					>
						<boxGeometry args={[0.1, 0.18, 0.4]} />
					</ToonMesh>
				);
			})}
			<ToonMesh color={art.dockEdge} position={[dockX + 0.02, SLAB + 0.005, 0]}>
				<boxGeometry args={[0.08, 0.012, FLOOR.depth * TILE]} />
			</ToonMesh>
			{/* The trailer, open at the dock end, and its cab. */}
			<group position={truck}>
				<ToonMesh
					castShadow
					color={art.trailer}
					ink={PROP_INK}
					position={[1.4, 0.95, 0.9]}
					receiveShadow
				>
					<boxGeometry args={[2.6, 1.1, 1.3]} />
				</ToonMesh>
				<ToonMesh color={art.trailerStripe} position={[1.4, 0.7, 1.56]}>
					<boxGeometry args={[2.5, 0.12, 0.02]} />
				</ToonMesh>
				<ToonMesh color={art.trailer} position={[1.4, 0.39, 0.9]}>
					<boxGeometry args={[2.6, 0.06, 1.3]} />
				</ToonMesh>
				<group position={[3.1, 0, 0.9]}>
					<ToonMesh
						castShadow
						color={art.cab}
						ink={PROP_INK}
						position={[0.35, 0.65, 0]}
					>
						<boxGeometry args={[0.7, 0.8, 1.2]} />
					</ToonMesh>
					<ToonMesh color={art.window} position={[0.71, 0.82, 0]}>
						<boxGeometry args={[0.02, 0.3, 0.9]} />
					</ToonMesh>
				</group>
				{[0.6, 1.2, 2.2, 3.5].map((x) =>
					[0.3, 1.5].map((z) => (
						<ToonMesh
							color={art.wheel}
							key={`${x}:${z}`}
							position={[x, 0.18, z]}
							rotation={[Math.PI / 2, 0, 0]}
						>
							<cylinderGeometry args={[0.18, 0.18, 0.12, 14]} />
						</ToonMesh>
					))
				)}
			</group>
			<InstancedParts castShadow items={boxes.boxes}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={boxes.labels}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.label} />
			</InstancedParts>
		</group>
	);
}

/** Lawn round the building: trees, shrubs, flowers. */
export function garden(shape: IslandShape) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			if (
				!onIsland(shape, fx, fz, 0.6) ||
				(fx > WAREHOUSE_BOUNDS.minX - 0.9 &&
					fx < WAREHOUSE_BOUNDS.maxX + 0.5 &&
					fz > WAREHOUSE_BOUNDS.minZ - 0.9 &&
					fz < WAREHOUSE_BOUNDS.maxZ + 0.6)
			) {
				continue;
			}
			const hash = jitter(x, y, 3);
			if (hash < 0.5) {
				trees.push({
					at: [fx, 0, fz],
					kind: hash < 0.22 ? "cedar" : hash > 0.42 ? "blossom" : "fruit",
					scale: 0.85 + jitter(x, y, 9) * 0.3,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.66) {
				bushes.push({ at: [fx, 0, fz], scale: 0.85, seed: x * 17 + y });
			} else if (hash > 0.84) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}
