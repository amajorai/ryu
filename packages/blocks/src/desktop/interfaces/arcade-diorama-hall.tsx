/* eslint-disable react/no-unknown-property */
import { RoundedBox } from "@react-three/drei";
import { useMemo } from "react";
import { SLAB, WALL_HEIGHT, WALL_THICK } from "./arcade-diorama-layout.ts";
import { emissive } from "./arcade-diorama-lettering.tsx";
import { ARCADE_3D } from "./arcade-palette.ts";
import type { FlowerPatch } from "./game3d-grass.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import {
	type PlacedBush,
	type PlantedTree,
	PROP_INK,
} from "./game3d-props.tsx";

/**
 * The prize counter at the front of the hall: a counter with a glass top,
 * shelves of plush prizes behind it, and a ticket booth sign (its plate is
 * the Collect control).
 */
export function PrizeCounter({
	at,
	night,
}: {
	at: [number, number];
	night: boolean;
}) {
	const prizes = useMemo(() => {
		const items: InstanceSpec[] = [];
		for (const [row, y] of [1.05, 1.45].entries()) {
			for (let index = 0; index < 7; index++) {
				items.push({
					color: ARCADE_3D.prizes[(index + row * 3) % ARCADE_3D.prizes.length],
					position: [at[0] - 0.9 + index * 0.3, SLAB + y, at[1] - 0.42],
					scale: 0.12 + ((index + row) % 3) * 0.02,
				});
			}
		}
		return items;
	}, [at]);
	return (
		<group>
			<RoundedBox
				args={[2.3, 0.9, 0.55]}
				castShadow
				position={[at[0], SLAB + 0.45, at[1]]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={ARCADE_3D.counter} />
			</RoundedBox>
			<mesh position={[at[0], SLAB + 0.92, at[1]]}>
				<boxGeometry args={[2.34, 0.05, 0.6]} />
				<ToonMaterial color={ARCADE_3D.counterTop} />
			</mesh>
			{/* Shelves behind with the prizes on them. */}
			{[0.92, 1.32].map((y) => (
				<ToonMesh
					color={ARCADE_3D.counter}
					ink={PROP_INK * 0.6}
					key={y}
					position={[at[0], SLAB + y, at[1] - 0.42]}
				>
					<boxGeometry args={[2.2, 0.05, 0.28]} />
				</ToonMesh>
			))}
			<InstancedParts castShadow ink={PROP_INK * 0.6} items={prizes}>
				<sphereGeometry args={[1, 14, 10]} />
				<ToonMaterial />
			</InstancedParts>
			<RoundedBox
				args={[1.3, 0.3, 0.06]}
				position={[at[0], SLAB + 1.95, at[1] - 0.42]}
				radius={0.04}
			>
				<ToonMaterial {...emissive(ARCADE_3D.topper, true, night)} />
			</RoundedBox>
		</group>
	);
}

/** A claw machine: a cabinet with a glass case full of plush and a claw. */
export function ClawMachine({
	at,
	night,
}: {
	at: [number, number];
	night: boolean;
}) {
	const plush = useMemo(
		() =>
			Array.from({ length: 9 }, (_, index) => ({
				color: ARCADE_3D.prizes[index % ARCADE_3D.prizes.length],
				position: [
					at[0] - 0.22 + (index % 3) * 0.22,
					SLAB + 1.02 + Math.floor(index / 3) * 0.05,
					at[1] - 0.2 + Math.floor(index / 3) * 0.2,
				] as Vec3,
				scale: 0.1,
			})),
		[at]
	);
	return (
		<group>
			<RoundedBox
				args={[0.85, 0.95, 0.85]}
				castShadow
				position={[at[0], SLAB + 0.475, at[1]]}
				radius={0.05}
				receiveShadow
			>
				<ToonMaterial color={ARCADE_3D.claw} />
			</RoundedBox>
			<InstancedParts ink={PROP_INK * 0.5} items={plush}>
				<sphereGeometry args={[1, 12, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<mesh position={[at[0], SLAB + 1.35, at[1]]}>
				<boxGeometry args={[0.82, 0.8, 0.82]} />
				<ToonMaterial
					color={ARCADE_3D.glass}
					depthWrite={false}
					opacity={0.28}
					transparent
				/>
			</mesh>
			<ToonMesh
				color={ARCADE_3D.lever}
				position={[at[0] + 0.1, SLAB + 1.55, at[1]]}
			>
				<cylinderGeometry args={[0.012, 0.012, 0.4, 6]} />
			</ToonMesh>
			<ToonMesh
				color={ARCADE_3D.lever}
				position={[at[0] + 0.1, SLAB + 1.33, at[1]]}
			>
				<coneGeometry args={[0.07, 0.08, 6]} />
			</ToonMesh>
			<RoundedBox
				args={[0.9, 0.2, 0.9]}
				position={[at[0], SLAB + 1.85, at[1]]}
				radius={0.05}
			>
				<ToonMaterial {...emissive(ARCADE_3D.neon[0], true, night)} />
			</RoundedBox>
		</group>
	);
}

/** Carpet squares with gold star dots. */
function carpetParts(halfWidth: number, halfDepth: number, night: boolean) {
	const tones = night ? ARCADE_3D.carpetNight : ARCADE_3D.carpet;
	const tiles: InstanceSpec[] = [];
	const stars: InstanceSpec[] = [];
	const columns = Math.floor(halfWidth * 2);
	const rows = Math.floor(halfDepth * 2);
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const x = -columns / 2 + column + 0.5;
			const z = -rows / 2 + row + 0.5;
			tiles.push({
				color: tones[(row + column) % 2],
				position: [x, SLAB + 0.005, z],
				scale: [1, 0.02, 1],
			});
			stars.push({
				color: ARCADE_3D.carpetStar,
				position: [x, SLAB + 0.017, z],
				rotation: [0, Math.PI / 4, 0],
				scale: [0.12, 0.005, 0.12],
			});
		}
	}
	return { stars, tiles };
}

/** The hall: slab, carpet, back and left walls with neon tubes. */
export function Hall({
	halfDepth,
	halfWidth,
	night,
}: {
	halfDepth: number;
	halfWidth: number;
	night: boolean;
}) {
	const carpet = useMemo(
		() => carpetParts(halfWidth, halfDepth, night),
		[halfDepth, halfWidth, night]
	);
	const wall = night ? ARCADE_3D.wallNight : ARCADE_3D.wall;
	const base = night ? ARCADE_3D.wallBaseNight : ARCADE_3D.wallBase;
	const back = -halfDepth;
	const left = -halfWidth;
	const neon = (index: number) => {
		const color =
			ARCADE_3D.neon[index % ARCADE_3D.neon.length] ?? ARCADE_3D.topper;
		return emissive(color, true, night);
	};
	return (
		<group>
			<RoundedBox
				args={[halfWidth * 2 + 0.3, SLAB, halfDepth * 2 + 0.3]}
				position={[0, SLAB / 2, 0]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={base} />
			</RoundedBox>
			<InstancedParts items={carpet.tiles} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={carpet.stars}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<ToonMesh
				castShadow
				color={wall}
				ink={PROP_INK}
				position={[0, SLAB + WALL_HEIGHT / 2, back]}
				receiveShadow
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, WALL_HEIGHT, WALL_THICK]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={wall}
				ink={PROP_INK}
				position={[left, SLAB + WALL_HEIGHT / 2, 0]}
				receiveShadow
			>
				<boxGeometry args={[WALL_THICK, WALL_HEIGHT, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			<ToonMesh
				color={base}
				position={[0, SLAB + 0.3, back + WALL_THICK / 2 + 0.01]}
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, 0.6, 0.02]} />
			</ToonMesh>
			<ToonMesh
				color={base}
				position={[left + WALL_THICK / 2 + 0.01, SLAB + 0.3, 0]}
			>
				<boxGeometry args={[0.02, 0.6, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			{/* Neon tubes along both walls, and a star and rings on the back. */}
			{[2.38, 2.6].map((y, index) => (
				<group key={y}>
					<mesh position={[0, SLAB + y, back + WALL_THICK / 2 + 0.04]}>
						<boxGeometry args={[halfWidth * 2 - 0.4, 0.05, 0.05]} />
						<ToonMaterial {...neon(index)} />
					</mesh>
					<mesh position={[left + WALL_THICK / 2 + 0.04, SLAB + y, 0]}>
						<boxGeometry args={[0.05, 0.05, halfDepth * 2 - 0.4]} />
						<ToonMaterial {...neon(index + 1)} />
					</mesh>
				</group>
			))}
			{night ? (
				<pointLight
					color={ARCADE_3D.neon[0]}
					decay={2}
					distance={8}
					intensity={2.4}
					position={[0, SLAB + 1.6, back + 1]}
				/>
			) : null}
		</group>
	);
}

/** Trees, shrubs and flowers around the hall. */
export function garden(
	shape: IslandShape,
	halfWidth: number,
	halfDepth: number
) {
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
				Math.abs(fx) < halfWidth + 0.9 && Math.abs(fz) < halfDepth + 0.9;
			if (inside || !onIsland(shape, fx, fz, 0.6)) {
				continue;
			}
			const hash = jitter(x, y, 3);
			if (fz < halfDepth && hash < 0.55) {
				let kind: PlantedTree["kind"] = "fruit";
				if (hash < 0.25) {
					kind = "cedar";
				} else if (hash > 0.47) {
					kind = "blossom";
				}
				trees.push({
					at: [fx, 0, fz],
					kind,
					scale: 0.8 + jitter(x, y, 9) * 0.3,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.72) {
				bushes.push({ at: [fx, 0, fz], scale: 0.85, seed: x * 13 + y });
			} else if (hash > 0.82) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}
