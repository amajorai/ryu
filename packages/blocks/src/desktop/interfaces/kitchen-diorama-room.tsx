/* eslint-disable react/no-unknown-property */
import { RoundedBox } from "@react-three/drei";
import { useMemo } from "react";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import { type KitchenPalette, pickById } from "./kitchen-palette.ts";
import { PROP_INK } from "./kitchen-props.tsx";

/** The kitchen diorama's cut-away room and heat lamps (kitchen-diorama.tsx). */

/** The room's floor is a raised slab; everything inside stands on it. */
export const SLAB = 0.16;
export const WALL_HEIGHT = 2.2;
export const WALL_THICK = 0.2;

function floorTiles(
	halfWidth: number,
	halfDepth: number,
	palette: KitchenPalette
): InstanceSpec[] {
	const tiles: InstanceSpec[] = [];
	const columns = Math.floor(halfWidth * 2);
	const rows = Math.floor(halfDepth * 2);
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			tiles.push({
				color: (row + column) % 2 ? palette.floorA : palette.floorB,
				position: [
					-columns / 2 + column + 0.5,
					SLAB + 0.005,
					-rows / 2 + row + 0.5,
				],
				scale: [0.96, 0.02, 0.96],
			});
		}
	}
	return tiles;
}

/** Jars and pots along the shelves on the back wall. */
function shelfJars(halfWidth: number, back: number, palette: KitchenPalette) {
	const jars: InstanceSpec[] = [];
	for (const [level, y] of [1.25, 1.75].entries()) {
		for (let x = -halfWidth + 0.7; x < halfWidth - 0.5; x += 0.42) {
			if (jitter(Math.round(x * 10), level, 3) < 0.25) {
				continue;
			}
			jars.push({
				color: pickById(palette.food, `${x}:${level}`) ?? palette.shelf,
				position: [x, SLAB + y + 0.12, back + WALL_THICK / 2 + 0.16],
				scale: [0.09, 0.2 + jitter(Math.round(x * 10), level, 5) * 0.1, 0.09],
			});
		}
	}
	return jars;
}

/** The cut-away room: slab, tiles, back and left walls, shelves, windows. */
export function Room({
	halfDepth,
	halfWidth,
	night,
	palette,
}: {
	halfDepth: number;
	halfWidth: number;
	night: boolean;
	palette: KitchenPalette;
}) {
	const back = -halfDepth;
	const left = -halfWidth;
	const tiles = useMemo(
		() => floorTiles(halfWidth, halfDepth, palette),
		[halfDepth, halfWidth, palette]
	);
	const jars = useMemo(
		() => shelfJars(halfWidth, back, palette),
		[back, halfWidth, palette]
	);
	const windowColor = night ? palette.lamp : palette.sky;
	const windows = [-halfWidth * 0.45, halfWidth * 0.45];
	return (
		<group>
			<RoundedBox
				args={[halfWidth * 2 + 0.3, SLAB, halfDepth * 2 + 0.3]}
				position={[0, SLAB / 2, 0]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={palette.floorEdge} />
			</RoundedBox>
			<InstancedParts items={tiles} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			{/* Back wall: a painted upper wall over a darker wainscot. */}
			<ToonMesh
				castShadow
				color={palette.wallA}
				ink={PROP_INK}
				position={[0, SLAB + WALL_HEIGHT / 2, back]}
				receiveShadow
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, WALL_HEIGHT, WALL_THICK]} />
			</ToonMesh>
			<ToonMesh
				color={palette.wallB}
				position={[0, SLAB + 0.45, back + WALL_THICK / 2 + 0.01]}
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, 0.9, 0.02]} />
			</ToonMesh>
			{/* Left wall, with a window per side. */}
			<ToonMesh
				castShadow
				color={palette.wallA}
				ink={PROP_INK}
				position={[left, SLAB + WALL_HEIGHT / 2, 0]}
				receiveShadow
			>
				<boxGeometry args={[WALL_THICK, WALL_HEIGHT, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			<ToonMesh
				color={palette.wallB}
				position={[left + WALL_THICK / 2 + 0.01, SLAB + 0.45, 0]}
			>
				<boxGeometry args={[0.02, 0.9, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			{[-halfDepth * 0.4, halfDepth * 0.35].map((z) => (
				<group
					key={z}
					position={[left + WALL_THICK / 2 + 0.02, SLAB + 1.45, z]}
				>
					<ToonMesh color={palette.wood}>
						<boxGeometry args={[0.04, 0.72, 0.92]} />
					</ToonMesh>
					<mesh position={[0.02, 0, 0]}>
						<boxGeometry args={[0.02, 0.58, 0.78]} />
						<ToonMaterial
							color={windowColor}
							emissive={windowColor}
							emissiveIntensity={night ? 1.4 : 0.15}
							toneMapped={!night}
						/>
					</mesh>
				</group>
			))}
			{/* Shelves with jars along the back wall, between two windows. */}
			{[1.25, 1.75].map((y) => (
				<ToonMesh
					castShadow
					color={palette.shelf}
					ink={PROP_INK}
					key={y}
					position={[0, SLAB + y, back + WALL_THICK / 2 + 0.16]}
				>
					<boxGeometry args={[halfWidth * 2 - 1, 0.05, 0.32]} />
				</ToonMesh>
			))}
			<InstancedParts castShadow ink={PROP_INK} items={jars}>
				<cylinderGeometry args={[1, 1, 1, 12]} />
				<ToonMaterial />
			</InstancedParts>
			{windows.map((x) => (
				<group key={x} position={[x, SLAB + 2.0, back + WALL_THICK / 2 + 0.02]}>
					<mesh>
						<boxGeometry args={[0.7, 0.24, 0.02]} />
						<ToonMaterial
							color={windowColor}
							emissive={windowColor}
							emissiveIntensity={night ? 1.4 : 0.15}
							toneMapped={!night}
						/>
					</mesh>
				</group>
			))}
		</group>
	);
}

/** Heat lamps hanging over the pass, glowing warm. */
export function HeatLamps({
	length,
	palette,
	z,
}: {
	length: number;
	palette: KitchenPalette;
	z: number;
}) {
	const xs = [-length / 3, 0, length / 3];
	return (
		<group>
			{xs.map((x) => (
				<group key={x} position={[x, SLAB + 1.55, z]}>
					<ToonMesh
						color={palette.steel}
						ink={PROP_INK}
						rotation={[Math.PI, 0, 0]}
					>
						<coneGeometry args={[0.2, 0.18, 16, 1, true]} />
					</ToonMesh>
					<mesh position={[0, -0.06, 0]}>
						<sphereGeometry args={[0.07, 12, 8]} />
						<meshBasicMaterial color={palette.lamp} toneMapped={false} />
					</mesh>
					<mesh position={[0, 0.4, 0]}>
						<cylinderGeometry args={[0.01, 0.01, 0.8, 6]} />
						<ToonMaterial color={palette.steel} />
					</mesh>
				</group>
			))}
		</group>
	);
}
