/* eslint-disable react/no-unknown-property */

import { RoundedBox } from "@react-three/drei";
import { useMemo } from "react";
import {
	type FarmDiorama,
	inRect,
	type PlacedBed,
	plotMood,
	type Rect,
} from "./farm-model.ts";
import { FARM_3D } from "./farm-palette.ts";
import type { FlowerPatch } from "./game3d-grass.tsx";
import { MeshGeometry } from "./game3d-ground.tsx";
import type { InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, type MeshData, onIsland } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import {
	type FenceRun,
	type PlacedBush,
	type PlantedTree,
	PROP_INK,
} from "./game3d-props.tsx";
import { linearRgb } from "./game3d-toon.ts";

/*
 * The Farm diorama's yard (farm-diorama.tsx): bed frames, the barn, silo
 * and hay, fences, the scenery around the farm and the ground's paint.
 */

/** Planks around each bed and furrow ridges across it. */
export function bedParts(beds: readonly PlacedBed[], night: boolean) {
	const frame = night ? FARM_3D.bedFrameNight : FARM_3D.bedFrame;
	const planks: InstanceSpec[] = [];
	const ridges: InstanceSpec[] = [];
	for (const { bed, plot } of beds) {
		const width = bed.maxX - bed.minX;
		const depth = bed.maxZ - bed.minZ;
		const cx = (bed.minX + bed.maxX) / 2;
		const cz = (bed.minZ + bed.maxZ) / 2;
		for (const side of [-1, 1]) {
			planks.push({
				color: frame,
				position: [cx, 0.08, cz + side * (depth / 2)],
				scale: [width + 0.08, 0.16, 0.09],
			});
			planks.push({
				color: frame,
				position: [cx + side * (width / 2), 0.08, cz],
				scale: [0.09, 0.16, depth - 0.02],
			});
		}
		for (let row = 0; row < plot.rows; row++) {
			ridges.push({
				color: FARM_3D.ridge,
				position: [cx, 0.02, bed.minZ + 0.32 + 0.92 * (row + 0.5)],
				scale: [width - 0.3, 0.05, 0.42],
			});
		}
	}
	return { planks, ridges };
}

/** A triangular prism: the barn's gable end, `width` wide and `rise` tall. */
function gablePrism(width: number, rise: number, depth: number): MeshData {
	const w = width / 2;
	const d = depth / 2;
	const corners: Vec3[] = [
		[-w, 0, d],
		[w, 0, d],
		[0, rise, d],
		[-w, 0, -d],
		[w, 0, -d],
		[0, rise, -d],
	];
	const faces: [number, number, number][] = [
		[0, 1, 2],
		[4, 3, 5],
	];
	const position: number[] = [];
	const normal: number[] = [];
	const index: number[] = [];
	for (const face of faces) {
		const [a, b, c] = face.map((corner) => corners[corner] as Vec3) as [
			Vec3,
			Vec3,
			Vec3,
		];
		const nz = a[2] > 0 ? 1 : -1;
		for (const point of [a, b, c]) {
			position.push(...point);
			normal.push(0, 0, nz);
		}
		const base = index.length;
		index.push(base, base + 1, base + 2);
	}
	return {
		index: new Uint32Array(index),
		normal: new Float32Array(normal),
		position: new Float32Array(position),
	};
}

const BARN_PITCH = 0.62;

/** The red barn: walls, white trim, a big X door, a loft window and roof. */
export function Barn({ night, rect }: { night: boolean; rect: Rect }) {
	const width = rect.maxX - rect.minX - 0.4;
	const depth = rect.maxZ - rect.minZ - 0.5;
	const cx = (rect.minX + rect.maxX) / 2;
	const cz = (rect.minZ + rect.maxZ) / 2;
	const wallHeight = 1.45;
	const rise = (width / 2) * Math.tan(BARN_PITCH);
	const gable = useMemo(
		() => gablePrism(width, rise, depth),
		[depth, rise, width]
	);
	const slope = (width / 2 + 0.28) / Math.cos(BARN_PITCH);
	const wall = night ? FARM_3D.barnWallNight : FARM_3D.barnWall;
	const roof = night ? FARM_3D.barnRoofNight : FARM_3D.barnRoof;
	const front = cz + depth / 2;
	return (
		<group>
			<RoundedBox
				args={[width, wallHeight, depth]}
				castShadow
				position={[cx, wallHeight / 2, cz]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={wall} />
			</RoundedBox>
			<mesh castShadow position={[cx, wallHeight, cz]}>
				<MeshGeometry data={gable} />
				<ToonMaterial color={wall} />
			</mesh>
			{[-1, 1].map((side) => (
				<ToonMesh
					castShadow
					color={roof}
					ink={PROP_INK}
					key={side}
					position={[
						cx + side * (width / 4 + 0.07),
						wallHeight + rise / 2 + 0.08,
						cz,
					]}
					receiveShadow
					rotation={[0, 0, -side * BARN_PITCH]}
				>
					<boxGeometry args={[slope, 0.1, depth + 0.4]} />
				</ToonMesh>
			))}
			{/* Corner trim and the door's frame and cross braces. */}
			{[-1, 1].map((side) => (
				<ToonMesh
					color={FARM_3D.barnTrim}
					key={`corner-${side}`}
					position={[cx + side * (width / 2), wallHeight / 2, front]}
				>
					<boxGeometry args={[0.1, wallHeight, 0.08]} />
				</ToonMesh>
			))}
			<group position={[cx, 0.6, front + 0.02]}>
				<ToonMesh color={FARM_3D.barnDoor} ink={PROP_INK * 0.6}>
					<boxGeometry args={[1.15, 1.2, 0.04]} />
				</ToonMesh>
				<ToonMesh color={wall} position={[0, 0, 0.03]}>
					<boxGeometry args={[0.98, 1.04, 0.02]} />
				</ToonMesh>
				{[-1, 1].map((side) => (
					<ToonMesh
						color={FARM_3D.barnDoor}
						key={side}
						position={[0, 0, 0.05]}
						rotation={[0, 0, side * 0.82]}
					>
						<boxGeometry args={[1.32, 0.08, 0.02]} />
					</ToonMesh>
				))}
			</group>
			<group position={[cx, wallHeight + rise * 0.4, front + 0.02]}>
				<ToonMesh color={FARM_3D.barnTrim}>
					<boxGeometry args={[0.46, 0.4, 0.04]} />
				</ToonMesh>
				<mesh position={[0, 0, 0.025]}>
					<boxGeometry args={[0.34, 0.28, 0.02]} />
					<ToonMaterial
						color={night ? FARM_3D.windowLit : FARM_3D.window}
						emissive={night ? FARM_3D.windowLit : FARM_3D.window}
						emissiveIntensity={night ? 1.6 : 0.1}
						toneMapped={!night}
					/>
				</mesh>
			</group>
		</group>
	);
}

/** The silo: a tall pale drum with bands and a domed cap. */
export function Silo({ at }: { at: [number, number] }) {
	return (
		<group position={[at[0], 0, at[1]]}>
			<ToonMesh
				castShadow
				color={FARM_3D.silo}
				ink={PROP_INK}
				position={[0, 1.15, 0]}
				receiveShadow
			>
				<cylinderGeometry args={[0.5, 0.52, 2.3, 24]} />
			</ToonMesh>
			{[0.6, 1.3, 2.0].map((y) => (
				<ToonMesh color={FARM_3D.siloRoof} key={y} position={[0, y, 0]}>
					<cylinderGeometry args={[0.525, 0.525, 0.05, 24]} />
				</ToonMesh>
			))}
			<ToonMesh
				castShadow
				color={FARM_3D.siloRoof}
				ink={PROP_INK}
				position={[0, 2.3, 0]}
			>
				<sphereGeometry args={[0.52, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
			</ToonMesh>
		</group>
	);
}

/** Round hay bales by the barn. */
export function HayBales({ at }: { at: [number, number] }) {
	const bales: Vec3[] = [
		[at[0], 0.22, at[1]],
		[at[0] + 0.52, 0.22, at[1] + 0.1],
		[at[0] + 0.26, 0.6, at[1] + 0.05],
	];
	return (
		<group>
			{bales.map((position) => (
				<group key={position.join(",")} position={position}>
					<ToonMesh
						castShadow
						color={FARM_3D.hay}
						ink={PROP_INK}
						receiveShadow
						rotation={[0, 0, Math.PI / 2]}
					>
						<cylinderGeometry args={[0.22, 0.22, 0.42, 18]} />
					</ToonMesh>
					<ToonMesh color={FARM_3D.hayBand} rotation={[0, 0, Math.PI / 2]}>
						<cylinderGeometry args={[0.225, 0.225, 0.05, 18]} />
					</ToonMesh>
				</group>
			))}
		</group>
	);
}

/** Fence runs around a field, leaving a gate in the front. */
export function fenceRuns(rect: Rect): FenceRun[] {
	const { maxX, maxZ, minX, minZ } = rect;
	const gate = (minX + maxX) / 2;
	return [
		{ from: [minX, 0, minZ], to: [maxX, 0, minZ] },
		{ from: [minX, 0, minZ], to: [minX, 0, maxZ] },
		{ from: [maxX, 0, minZ], to: [maxX, 0, maxZ] },
		{ from: [minX, 0, maxZ], to: [gate - 0.45, 0, maxZ] },
		{ from: [gate + 0.45, 0, maxZ], to: [maxX, 0, maxZ] },
	];
}

/** Trees, shrubs and flowers around the farm, clear of everything built. */
export function scenery(diorama: FarmDiorama, shape: IslandShape) {
	const clear = (x: number, z: number, margin: number) =>
		!inRect(diorama.bounds, x, z, margin);
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			if (!onIsland(shape, fx, fz, 0.6)) {
				continue;
			}
			if (clear(fx, fz, 1.1)) {
				// The back and sides grow a wood; the front stays open lawn.
				const front = fz > diorama.bounds.maxZ - 0.5;
				if (!front && hash < 0.62) {
					let kind: PlantedTree["kind"] = "fruit";
					if (hash < 0.3) {
						kind = "cedar";
					} else if (hash > 0.55) {
						kind = "blossom";
					}
					trees.push({
						at: [fx, 0, fz],
						kind,
						scale: 0.8 + jitter(x, y, 9) * 0.35,
						seed: Math.round(hash * 1000),
					});
				} else if (hash < 0.78) {
					bushes.push({ at: [fx, 0, fz], scale: 0.9, seed: x * 31 + y });
				} else {
					flowers.push({ at: [fx, 0, fz], x, y });
				}
			} else if (clear(fx, fz, 0.2) && hash > 0.82) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	// Shrubs along the fenced fields' sides.
	for (const { fence } of diorama.fields) {
		if (!fence) {
			continue;
		}
		for (const z of [fence.minZ + 0.6, fence.maxZ - 0.6]) {
			bushes.push({
				at: [fence.minX - 0.35, 0, z],
				scale: 0.7,
				seed: Math.round(z * 10),
			});
			bushes.push({
				at: [fence.maxX + 0.35, 0, z],
				scale: 0.7,
				seed: Math.round(z * 7),
			});
		}
	}
	return { bushes, flowers, trees };
}

/** The ground's paint: soil in the beds, packed earth on paths and the yard. */
export function groundPaint(diorama: FarmDiorama, night: boolean) {
	const soil = linearRgb(night ? FARM_3D.soilNight : FARM_3D.soil);
	const dry = linearRgb(FARM_3D.soilDry);
	const path = linearRgb(night ? FARM_3D.pathNight : FARM_3D.path);
	const yard: Rect = {
		maxX: diorama.barn.maxX + 0.2,
		maxZ: diorama.barn.maxZ + 1.4,
		minX: diorama.barn.minX + 0.6,
		minZ: diorama.barn.maxZ - 0.2,
	};
	return (x: number, z: number): Rgb | null => {
		for (const { bed, plot } of diorama.beds) {
			if (inRect(bed, x, z, -0.02)) {
				return plotMood(plot) === "withered" ? dry : soil;
			}
		}
		if (
			diorama.paths.some((rect) => inRect(rect, x, z)) ||
			inRect(yard, x, z)
		) {
			return path;
		}
		return null;
	};
}
