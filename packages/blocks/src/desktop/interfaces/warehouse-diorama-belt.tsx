/* eslint-disable react/no-unknown-property */
import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { InstancedMesh } from "three";
import { type InstanceSpec, writeInstances } from "./game3d-instances.tsx";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import { IsoLabel } from "./game3d-stage.tsx";
import {
	BELT_TOP,
	BOX,
	CAGE,
	SLAB,
	tileToWorld,
} from "./warehouse-diorama-layout.ts";
import { BELT_PATH, BELT_REST, type Slot } from "./warehouse-model.ts";
import type { WarehouseArt } from "./warehouse-palette.ts";

/** Order boxes riding the belt toward the packing table, in a loop. */
export function BeltBoxes({
	art,
	count,
	running,
}: {
	art: WarehouseArt;
	count: number;
	running: boolean;
}) {
	const ref = useRef<InstancedMesh>(null);
	const path = useMemo(
		() => BELT_PATH.map((slot) => tileToWorld(slot.x, slot.y, SLAB + BELT_TOP)),
		[]
	);
	const rest = useMemo(
		() =>
			BELT_REST.slice(0, count).map<InstanceSpec>((slot: Slot) => ({
				color: art.box,
				position: tileToWorld(slot.x, slot.y, SLAB + BELT_TOP + BOX * 0.4),
				scale: [BOX, BOX * 0.8, BOX],
			})),
		[art, count]
	);
	const lengths = useMemo(() => {
		const out: number[] = [];
		for (let index = 1; index < path.length; index++) {
			const a = path[index - 1];
			const b = path[index];
			out.push(a && b ? Math.hypot(b[0] - a[0], b[2] - a[2]) : 0);
		}
		return out;
	}, [path]);
	const total = lengths.reduce((sum, value) => sum + value, 0);
	// Reused every frame: the boxes' positions are written in place.
	const moving = useMemo(
		() =>
			rest.map((item) => ({ ...item, position: [...item.position] as Vec3 })),
		[rest]
	);
	useLayoutEffect(() => {
		if (ref.current) {
			writeInstances(ref.current, rest);
		}
	}, [rest]);
	useFrame(({ clock }) => {
		const mesh = ref.current;
		if (!(mesh && running) || moving.length === 0 || total === 0) {
			return;
		}
		for (const [index, item] of moving.entries()) {
			let along =
				(clock.elapsedTime * 0.45 + (index * total) / moving.length) % total;
			let segment = 0;
			while (segment < lengths.length - 1 && along > (lengths[segment] ?? 0)) {
				along -= lengths[segment] ?? 0;
				segment += 1;
			}
			const a = path[segment] ?? item.position;
			const b = path[segment + 1] ?? a;
			const length = lengths[segment] ?? 0;
			const t = length > 0 ? along / length : 0;
			item.position[0] = a[0] + (b[0] - a[0]) * t;
			item.position[2] = a[2] + (b[2] - a[2]) * t;
		}
		writeInstances(mesh, moving);
	});
	if (count === 0) {
		return null;
	}
	return (
		<instancedMesh
			args={[undefined, undefined, rest.length]}
			castShadow
			key={rest.length}
			ref={ref}
		>
			<boxGeometry args={[1, 1, 1]} />
			<ToonMaterial />
		</instancedMesh>
	);
}

/**
 * The red beacon on a mast over the returns cage's back corner: lit while a
 * run is stopped (a counted blocker), with the newest stop's reason tagged
 * beside it. The cage's own "Stopped" plate sits at its front.
 */
export function CageLight({
	art,
	reason,
}: {
	art: WarehouseArt;
	reason: string | null;
}) {
	const at = tileToWorld(CAGE.x + CAGE.w - 0.25, CAGE.y + 0.25, 1.18);
	return (
		<group position={at}>
			<ToonMesh color={art.rackBeam} position={[0, 0.3, 0]}>
				<cylinderGeometry args={[0.05, 0.05, 0.6, 8]} />
			</ToonMesh>
			<ToonMesh color={art.rackBeam} position={[0, 0.62, 0]}>
				<cylinderGeometry args={[0.2, 0.24, 0.1, 14]} />
			</ToonMesh>
			<mesh position={[0, 0.84, 0]}>
				<sphereGeometry args={[0.24, 16, 12]} />
				<meshBasicMaterial color={art.exception} toneMapped={false} />
			</mesh>
			{/* The reason hangs on the cage's front, below the beacon. */}
			{reason ? (
				<IsoLabel at={[-0.7, 0.2, 1.1]}>
					<span data-budgeted-overlay="text">{reason}</span>
				</IsoLabel>
			) : null}
		</group>
	);
}
