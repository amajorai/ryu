/* eslint-disable react/no-unknown-property */
import { useMemo } from "react";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { onIsland } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import {
	type FenceRun,
	Fences,
	LampPosts,
	type PlantedTree,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { linearRgb } from "./game3d-toon.ts";
import type { SeasonSceneProps } from "./seasonal-diorama.tsx";
import { SEASON_3D } from "./seasonal-palette.ts";
import { PATCH } from "./seasonal-world.ts";

/**
 * Halloween: a pumpkin patch at night. Four ploughed rows of vines, a big
 * carved jack-o'-lantern for every conversation (its face lit from inside,
 * brightest where it needs you) and a pale gourd for every empty
 * place, a fence round the field, a scarecrow, hay bales, bare trees and
 * lamps.
 */

const ART = SEASON_3D.halloween;
/** Toward the camera on the ground. */
const TOWARD: [number, number] = [Math.SQRT1_2, Math.SQRT1_2];
const FIELD_X = ((PATCH.columns - 1) / 2) * PATCH.step + 1.2;
const FIELD_Z = ((PATCH.rows - 1) / 2) * PATCH.step + 1.1;
const ROW_HALF = 0.72;
/** A pumpkin's lobes round its core, for the ribbed look. */
const LOBES = 6;

function rowZ(row: number): number {
	return ((PATCH.rows - 1) / 2 - row) * PATCH.step;
}

function inField(x: number, z: number, margin = 0): boolean {
	return Math.abs(x) < FIELD_X + margin && Math.abs(z) < FIELD_Z + margin;
}

/** Every pumpkin's core, lobes, stem and carved face. */
function pumpkinParts({ doors, world }: SeasonSceneProps) {
	const lobes: InstanceSpec[] = [];
	const stems: InstanceSpec[] = [];
	const faces: InstanceSpec[] = [];
	const hot: InstanceSpec[] = [];
	for (const place of world.doors) {
		const door = doors[place.number - 1];
		const filled = door?.thread != null;
		const [x, , z] = place.at;
		const size = filled ? 0.62 : 0.34;
		let color: string = ART.gourd;
		if (filled) {
			color = door?.opened ? ART.pumpkinOpened : ART.pumpkin;
		}
		const height = size * 0.78;
		lobes.push({
			color,
			position: [x, height * 0.95, z],
			scale: [size * 0.8, height, size * 0.8],
		});
		for (let lobe = 0; lobe < LOBES; lobe++) {
			const angle = (lobe / LOBES) * Math.PI * 2 + place.number;
			lobes.push({
				color,
				position: [
					x + Math.cos(angle) * size * 0.38,
					height * 0.92,
					z + Math.sin(angle) * size * 0.38,
				],
				rotation: [0, -angle, 0],
				scale: [size * 0.55, height * 0.96, size * 0.5],
			});
		}
		stems.push({
			color: ART.stem,
			position: [x, height * 1.9, z],
			rotation: [0.25, place.number, 0.15],
			scale: [size * 0.09, size * 0.35, size * 0.09],
		});
		if (filled) {
			// Every conversation's pumpkin is a carved jack-o'-lantern, lit from
			// inside: brightest where it needs you.
			const glow = door?.mark === "needs-you" ? hot : faces;
			const out = size * 0.86;
			const fx = x + TOWARD[0] * out;
			const fz = z + TOWARD[1] * out;
			const across: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
			for (const side of [-1, 1]) {
				glow.push({
					position: [
						fx + across[0] * side * size * 0.32,
						height * 1.15,
						fz + across[1] * side * size * 0.32,
					],
					rotation: [0, Math.PI / 4, Math.PI / 4],
					scale: [size * 0.2, size * 0.2, 0.04],
				});
			}
			glow.push({
				position: [fx, height * 0.62, fz],
				rotation: [0, Math.PI / 4, 0],
				scale: [size * 0.64, size * 0.14, 0.04],
			});
		}
	}
	return { faces, hot, lobes, stems };
}

/** The rows' vines and leaves. */
function vineParts() {
	const vines: InstanceSpec[] = [];
	const leaves: InstanceSpec[] = [];
	for (let row = 0; row < PATCH.rows; row++) {
		const z = rowZ(row);
		vines.push({
			position: [0, 0.04, z + 0.42],
			scale: [FIELD_X * 2 - 0.8, 0.05, 0.06],
		});
		for (let index = 0; index < 26; index++) {
			const x = -FIELD_X + 0.6 + index * ((FIELD_X * 2 - 1.2) / 25);
			leaves.push({
				position: [x, 0.07, z + 0.42 + (jitter(index, row, 3) - 0.5) * 0.5],
				rotation: [0, jitter(index, row, 5) * Math.PI, 0],
				scale: [0.2, 0.05, 0.14],
			});
		}
	}
	return { leaves, vines };
}

/** A leafless tree: a tapered trunk and four crooked branches. */
function BareTree({ at, scale }: { at: Vec3; scale: number }) {
	const branches: [number, number, number][] = [
		[0.9, 0.7, 0.5],
		[-0.8, 0.55, 2.1],
		[0.75, 0.6, 3.8],
		[-0.6, 0.45, 5.2],
	];
	return (
		<group position={at} scale={scale}>
			<ToonMesh castShadow color={ART.bark} ink={PROP_INK} position={[0, 1, 0]}>
				<cylinderGeometry args={[0.1, 0.22, 2, 8]} />
			</ToonMesh>
			{branches.map(([tilt, height, yaw]) => (
				<group key={yaw} position={[0, 1 + height, 0]} rotation={[0, yaw, 0]}>
					<ToonMesh
						castShadow
						color={ART.bark}
						position={[0, 0.4, 0.3]}
						rotation={[tilt, 0, 0]}
					>
						<cylinderGeometry args={[0.03, 0.07, 1, 6]} />
					</ToonMesh>
				</group>
			))}
		</group>
	);
}

/** The scarecrow keeping watch over the patch. */
function Scarecrow({ at }: { at: Vec3 }) {
	return (
		<group position={at} rotation={[0, Math.PI / 4, 0]}>
			<ToonMesh castShadow color={ART.post} position={[0, 0.8, 0]}>
				<boxGeometry args={[0.1, 1.6, 0.1]} />
			</ToonMesh>
			<ToonMesh castShadow color={ART.post} position={[0, 1.25, 0]}>
				<boxGeometry args={[1.2, 0.08, 0.08]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={ART.shirt}
				ink={PROP_INK}
				position={[0, 1.1, 0]}
			>
				<boxGeometry args={[0.5, 0.55, 0.26]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={ART.straw}
				ink={PROP_INK}
				position={[0, 1.6, 0]}
			>
				<sphereGeometry args={[0.22, 14, 10]} />
			</ToonMesh>
			<ToonMesh castShadow color={ART.hat} position={[0, 1.78, 0]}>
				<cylinderGeometry args={[0.34, 0.34, 0.04, 16]} />
			</ToonMesh>
			<ToonMesh castShadow color={ART.hat} position={[0, 1.98, 0]}>
				<coneGeometry args={[0.18, 0.42, 14]} />
			</ToonMesh>
			{[-1, 1].map((side) => (
				<ToonMesh
					color={ART.straw}
					key={side}
					position={[side * 0.66, 1.2, 0]}
					rotation={[0, 0, side * 0.6]}
				>
					<coneGeometry args={[0.07, 0.24, 6]} />
				</ToonMesh>
			))}
		</group>
	);
}

/** Cedars round the rim, clear of the field and the yard behind it. */
function rimTrees(scene: SeasonSceneProps): PlantedTree[] {
	const trees: PlantedTree[] = [];
	const columns = Math.ceil(scene.shape.halfWidth);
	const rows = Math.ceil(scene.shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const front = fx + fz > 4;
			if (
				!onIsland(scene.shape, fx, fz, 0.6) ||
				inField(fx, fz, 1.6) ||
				front ||
				hash > 0.5
			) {
				continue;
			}
			// Keep the yard behind the field open for the scarecrow.
			if (fz < -FIELD_Z && fz > -FIELD_Z - 2.6 && Math.abs(fx) < 4) {
				continue;
			}
			trees.push({
				at: [fx, 0, fz],
				kind: "cedar",
				scale: 0.75 + jitter(x, y, 9) * 0.35,
				seed: Math.round(hash * 1000),
			});
		}
	}
	return trees;
}

export function PumpkinPatch(scene: SeasonSceneProps) {
	const { quality, reducedMotion, shape, theme } = scene;
	const paint = useMemo(() => {
		const soil = linearRgb(ART.soil);
		const furrow = linearRgb(ART.furrow);
		return (x: number, z: number): Rgb | null => {
			if (!inField(x, z)) {
				return null;
			}
			for (let row = 0; row < PATCH.rows; row++) {
				if (Math.abs(z - rowZ(row)) < ROW_HALF) {
					return soil;
				}
			}
			return furrow;
		};
	}, []);
	const avoid = useMemo(() => (x: number, z: number) => inField(x, z, 0.3), []);
	const pumpkins = useMemo(() => pumpkinParts(scene), [scene]);
	const vines = useMemo(() => vineParts(), []);
	const trees = useMemo(() => rimTrees(scene), [scene]);
	const fence = useMemo<FenceRun[]>(() => {
		const x = FIELD_X + 0.5;
		const z = FIELD_Z + 0.5;
		return [
			// The back has a gate too: the path to the yard and its queue.
			{ from: [-x, 0, -z], to: [-1.8, 0, -z] },
			{ from: [1.8, 0, -z], to: [x, 0, -z] },
			{ from: [x, 0, -z], to: [x, 0, z] },
			{ from: [-x, 0, -z], to: [-x, 0, z] },
			// The front is open, with a gap for the gate.
			{ from: [-x, 0, z], to: [-1, 0, z] },
			{ from: [1, 0, z], to: [x, 0, z] },
		];
	}, []);
	const lamps = useMemo<Vec3[]>(() => {
		const x = FIELD_X + 0.9;
		const z = FIELD_Z + 0.9;
		return [
			[-x, 0, -z],
			[x, 0, -z],
			[x, 0, z],
			[-x, 0, z],
			[-1.4, 0, z],
			[1.4, 0, z],
		];
	}, []);
	// Hay bales at the yard's right end, clear of the queue.
	const hay = useMemo<InstanceSpec[]>(
		() => [
			{
				position: [4.4, 0.3, -FIELD_Z - 1.8],
				rotation: [Math.PI / 2, 0.4, 0],
				scale: [0.42, 0.6, 0.42],
			},
			{
				position: [5.3, 0.3, -FIELD_Z - 1.5],
				rotation: [Math.PI / 2, 1.2, 0],
				scale: [0.42, 0.6, 0.42],
			},
			{
				position: [4.85, 0.82, -FIELD_Z - 1.65],
				rotation: [Math.PI / 2, 0.8, 0],
				scale: [0.42, 0.6, 0.42],
			},
		],
		[]
	);
	return (
		<group>
			<IsoIsland paint={paint} shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reducedMotion}
				shape={shape}
				theme={theme}
			/>
			<TreeGrove theme={theme} trees={trees} />
			<Fences runs={fence} style="wood" />
			<LampPosts lamps={lamps} night />
			<InstancedParts castShadow ink={PROP_INK} inkColor={ART.hay} items={hay}>
				<cylinderGeometry args={[1, 1, 1, 16]} />
				<ToonMaterial color={ART.hay} />
			</InstancedParts>
			<Scarecrow at={[1.6, 0, -FIELD_Z - 1.5]} />
			<BareTree at={[-FIELD_X - 2, 0, -FIELD_Z + 0.6]} scale={1.2} />
			<BareTree at={[FIELD_X + 1.6, 0, -FIELD_Z - 1.2]} scale={1} />
			<InstancedParts items={vines.vines}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.vine} />
			</InstancedParts>
			<InstancedParts items={vines.leaves}>
				<sphereGeometry args={[1, 8, 6]} />
				<ToonMaterial color={ART.leaf} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={ART.pumpkin}
				items={pumpkins.lobes}
				receiveShadow
			>
				<sphereGeometry args={[1, 16, 12]} />
				<ToonMaterial rim={0.25} />
			</InstancedParts>
			<InstancedParts castShadow items={pumpkins.stems}>
				<cylinderGeometry args={[0.7, 1, 1, 6]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={pumpkins.faces}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial color={ART.face} toneMapped={false} />
			</InstancedParts>
			<InstancedParts items={pumpkins.hot}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial color={ART.faceHot} toneMapped={false} />
			</InstancedParts>
		</group>
	);
}
