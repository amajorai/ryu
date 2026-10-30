/* eslint-disable react/no-unknown-property */
import { useMemo } from "react";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { PROP_INK } from "./game3d-props.tsx";
import {
	BELT_TOP,
	SLAB,
	TILE,
	tileToWorld,
} from "./warehouse-diorama-layout.ts";
import {
	AISLE_COUNT,
	BELT_PATH,
	PACKER_SPOT,
	RACK,
	rackRowY,
} from "./warehouse-model.ts";
import type { WarehouseArt } from "./warehouse-palette.ts";

/** Six rows of shelving, three levels each, stocked with boxes and bins. */
export function Racks({ art }: { art: WarehouseArt }) {
	const parts = useMemo(() => {
		const uprights: InstanceSpec[] = [];
		const beams: InstanceSpec[] = [];
		const decks: InstanceSpec[] = [];
		const stock: InstanceSpec[] = [];
		const levels = [0.3, 0.62, 0.94];
		const depth = RACK.depth * TILE;
		for (let row = 0; row < AISLE_COUNT; row++) {
			const y = rackRowY(row) + RACK.depth / 2;
			const [x0, , z] = tileToWorld(RACK.x0, y);
			const [x1] = tileToWorld(RACK.x1, y);
			for (let x = x0; x <= x1 + 0.01; x += (x1 - x0) / 4) {
				for (const side of [-1, 1]) {
					uprights.push({
						position: [x, SLAB + 0.55, z + side * (depth / 2 - 0.03)],
						scale: [0.05, 1.1, 0.05],
					});
				}
			}
			for (const level of levels) {
				for (const side of [-1, 1]) {
					beams.push({
						position: [
							(x0 + x1) / 2,
							SLAB + level,
							z + side * (depth / 2 - 0.03),
						],
						scale: [x1 - x0, 0.05, 0.04],
					});
				}
				decks.push({
					position: [(x0 + x1) / 2, SLAB + level + 0.03, z],
					scale: [x1 - x0, 0.02, depth - 0.04],
				});
				for (let x = x0 + 0.18; x < x1 - 0.1; x += 0.32) {
					const seed = Math.round(x * 13 + row * 7 + level * 31);
					if (jitter(seed, 1, 2) < 0.2) {
						continue;
					}
					const tall = 0.14 + jitter(seed, 3, 4) * 0.1;
					stock.push({
						color: jitter(seed, 5, 6) < 0.3 ? art.bin : art.box,
						position: [x, SLAB + level + 0.04 + tall / 2, z],
						scale: [0.24, tall, depth * 0.7],
					});
				}
			}
		}
		return { beams, decks, stock, uprights };
	}, [art]);
	return (
		<group>
			<InstancedParts castShadow items={parts.uprights}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.rackUpright} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.5}
				inkColor={art.rackBeam}
				items={parts.beams}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.rackBeam} />
			</InstancedParts>
			<InstancedParts items={parts.decks} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.rackDeck} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.5}
				inkColor={art.boxDamaged}
				items={parts.stock}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
		</group>
	);
}

/** The conveyor along its path, the packing table at its end. */
export function Conveyor({ art }: { art: WarehouseArt }) {
	const parts = useMemo(() => {
		const belts: InstanceSpec[] = [];
		const frames: InstanceSpec[] = [];
		const legs: InstanceSpec[] = [];
		for (let index = 1; index < BELT_PATH.length; index++) {
			const from = BELT_PATH[index - 1];
			const to = BELT_PATH[index];
			if (!(from && to)) {
				continue;
			}
			const a = tileToWorld(from.x, from.y);
			const b = tileToWorld(to.x, to.y);
			const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[2] - a[2]);
			const length = Math.hypot(b[0] - a[0], b[2] - a[2]) + 0.5;
			const mid: Vec3 = [(a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2];
			belts.push({
				position: [mid[0], SLAB + BELT_TOP - 0.02, mid[2]],
				scale: alongX ? [length, 0.04, 0.46] : [0.46, 0.04, length],
			});
			frames.push({
				position: [mid[0], SLAB + BELT_TOP - 0.08, mid[2]],
				scale: alongX ? [length, 0.1, 0.54] : [0.54, 0.1, length],
			});
			const steps = Math.max(2, Math.round(length / 0.9));
			for (let step = 0; step <= steps; step++) {
				const t = step / steps;
				const x = a[0] + (b[0] - a[0]) * t;
				const z = a[2] + (b[2] - a[2]) * t;
				for (const side of [-1, 1]) {
					legs.push({
						position: alongX
							? [x, SLAB + (BELT_TOP - 0.1) / 2, z + side * 0.22]
							: [x + side * 0.22, SLAB + (BELT_TOP - 0.1) / 2, z],
						scale: [0.04, BELT_TOP - 0.1, 0.04],
					});
				}
			}
		}
		return { belts, frames, legs };
	}, []);
	const table = tileToWorld(PACKER_SPOT.x + 0.15, PACKER_SPOT.y - 1.35, SLAB);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.6}
				inkColor={art.beltFrame}
				items={parts.frames}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.beltFrame} />
			</InstancedParts>
			<InstancedParts items={parts.belts} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.belt} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.legs}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.beltFrame} />
			</InstancedParts>
			{/* The packing table: a bench with a tape roll and flat-packs. */}
			<group position={table}>
				<ToonMesh
					castShadow
					color={art.station}
					ink={PROP_INK}
					position={[0, 0.25, 0]}
					receiveShadow
				>
					<boxGeometry args={[1.0, 0.5, 0.62]} />
				</ToonMesh>
				<ToonMesh color={art.stationTop} position={[0, 0.52, 0]}>
					<boxGeometry args={[1.08, 0.05, 0.7]} />
				</ToonMesh>
				<ToonMesh
					color={art.tape}
					position={[0.3, 0.6, -0.12]}
					rotation={[Math.PI / 2, 0, 0]}
				>
					<torusGeometry args={[0.06, 0.03, 8, 16]} />
				</ToonMesh>
				<ToonMesh color={art.box} position={[-0.25, 0.57, 0.05]}>
					<boxGeometry args={[0.4, 0.04, 0.3]} />
				</ToonMesh>
			</group>
		</group>
	);
}
