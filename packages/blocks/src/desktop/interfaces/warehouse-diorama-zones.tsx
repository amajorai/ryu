/* eslint-disable react/no-unknown-property */
import { useMemo } from "react";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { PROP_INK } from "./game3d-props.tsx";
import { addBox, CAGE, SLAB, tileToWorld } from "./warehouse-diorama-layout.ts";
import type { FloorPlacement, Slot } from "./warehouse-model.ts";
import type { WarehouseArt } from "./warehouse-palette.ts";

/** Pallets and the order boxes on them, the returns cage and the dock. */
export function Zones({
	art,
	fadedIds,
	placement,
}: {
	art: WarehouseArt;
	fadedIds: ReadonlySet<string>;
	placement: FloorPlacement;
}) {
	const parts = useMemo(() => {
		const pallets: InstanceSpec[] = [];
		const out = {
			boxes: [] as InstanceSpec[],
			labels: [] as InstanceSpec[],
			tapes: [] as InstanceSpec[],
		};
		const pallet = (slot: Slot) => {
			const [x, , z] = tileToWorld(slot.x, slot.y);
			pallets.push({
				position: [x, SLAB + 0.05, z],
				scale: [0.66, 0.1, 0.66],
			});
		};
		for (const { order, slot } of placement.received) {
			pallet(slot);
			addBox(
				out,
				tileToWorld(slot.x, slot.y, SLAB + 0.1),
				fadedIds.has(order.id) ? art.floorEdge : art.box,
				false,
				order.number.length + slot.x * 10
			);
		}
		for (const { order, slot } of placement.ready) {
			pallet(slot);
			addBox(
				out,
				tileToWorld(slot.x, slot.y, SLAB + 0.1),
				fadedIds.has(order.id) ? art.floorEdge : art.box,
				true,
				slot.y * 13 + slot.x
			);
		}
		for (const { order, slot } of placement.exception) {
			addBox(
				out,
				tileToWorld(slot.x, slot.y, SLAB),
				fadedIds.has(order.id) ? art.floorEdge : art.boxDamaged,
				false,
				slot.x * 7 + slot.y
			);
		}
		// The returns cage: corner posts, a top rail and see-through mesh.
		const cagePosts: InstanceSpec[] = [];
		const [cx0, , cz0] = tileToWorld(CAGE.x, CAGE.y);
		const [cx1, , cz1] = tileToWorld(CAGE.x + CAGE.w, CAGE.y + CAGE.d);
		for (const x of [cx0, (cx0 + cx1) / 2, cx1]) {
			for (const z of [cz0, (cz0 + cz1) / 2, cz1]) {
				if (x === (cx0 + cx1) / 2 && z === (cz0 + cz1) / 2) {
					continue;
				}
				cagePosts.push({
					position: [x, SLAB + 0.5, z],
					scale: [0.04, 1.0, 0.04],
				});
			}
		}
		const cagePanels: InstanceSpec[] = [
			{
				position: [(cx0 + cx1) / 2, SLAB + 0.5, cz0],
				scale: [cx1 - cx0, 1.0, 0.01],
			},
			{
				position: [cx0, SLAB + 0.5, (cz0 + cz1) / 2],
				scale: [0.01, 1.0, cz1 - cz0],
			},
			{
				position: [cx1, SLAB + 0.5, (cz0 + cz1) / 2],
				scale: [0.01, 1.0, cz1 - cz0],
			},
			{
				position: [(cx0 + cx1) / 2, SLAB + 0.5, cz1],
				scale: [cx1 - cx0, 1.0, 0.01],
			},
		];
		return {
			cage: { panels: cagePanels, posts: cagePosts, x: cx1, z: cz1 },
			pallets,
			...out,
		};
	}, [art, fadedIds, placement]);
	return (
		<group>
			<InstancedParts castShadow items={parts.pallets} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.pallet} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.6}
				inkColor={art.boxDamaged}
				items={parts.boxes}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.tapes}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.tape} />
			</InstancedParts>
			<InstancedParts items={parts.labels}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.label} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.cage.posts}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.cage} />
			</InstancedParts>
			<InstancedParts items={parts.cage.panels}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.cage} opacity={0.28} transparent />
			</InstancedParts>
			{/* The red exception flag on the cage's corner. */}
			<group position={[parts.cage.x, SLAB + 1.0, parts.cage.z]}>
				<ToonMesh color={art.cage} position={[0, 0.25, 0]}>
					<cylinderGeometry args={[0.015, 0.015, 0.5, 6]} />
				</ToonMesh>
				<ToonMesh color={art.exception} position={[0.12, 0.42, 0]}>
					<boxGeometry args={[0.24, 0.16, 0.02]} />
				</ToonMesh>
			</group>
		</group>
	);
}
