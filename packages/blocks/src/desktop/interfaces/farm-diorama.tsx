/* eslint-disable react/no-unknown-property */
import { RoundedBox } from "@react-three/drei";
import {
	type InterfaceAgentAct,
	THREAD_STATUS_LABELS,
} from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import {
	bedsByAgent,
	type FarmActHandlers,
	FarmBedActs,
	FarmPorchActs,
	porchSpots,
} from "./farm-acts.tsx";
import {
	type CropStage,
	type FarmCrop,
	type FarmDiorama,
	type FruitKind,
	growingScale,
	inRect,
	type PlacedBed,
	plotLabel,
	plotMood,
	type Rect,
	STAGE_NAMES,
} from "./farm-model.ts";
import { FARM_3D, FRUIT_3D } from "./farm-palette.ts";
import type { OffStage, YouSpotSlot } from "./game3d-acts.ts";
import { FlowerClusters, type FlowerPatch } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland, MeshGeometry } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, type MeshData, onIsland } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Bushes,
	type FenceRun,
	Fences,
	LampPosts,
	PathStones,
	type PlacedBush,
	type PlantedTree,
	Pond,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoLabel, IsoMarker } from "./game3d-stage.tsx";
import { linearRgb, type RenderQuality } from "./game3d-toon.ts";
import {
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
	type VillagerTool,
} from "./game3d-villager.tsx";

/**
 * The Farm as an isometric diorama on the game kit (see game3d-stage.tsx):
 * an island farm with a red barn, a silo and hay by the pond, fenced fields
 * (one per project) and open plots, and one raised bed per agent whose
 * crops are its conversations. A crop's growth is its conversation's
 * state: a sprout with a water drop while it waits on the agent, a leafy
 * plant while the agent works, fruit when it is your turn, and a withered
 * brown plant when a run failed. Each plot's farmer is its agent, posed by
 * the plot's most urgent crop; their name plate opens the plot.
 */

const CROP_INK = PROP_INK * 0.6;

/** A farmer's pose from the plot's most urgent crop. */
const POSE_BY_MOOD: Record<CropStage, VillagerPose> = {
	fallow: "idle",
	growing: "working",
	ripe: "needs-you",
	seed: "waiting",
	withered: "failed",
};

interface CropParts {
	balls: InstanceSpec[];
	droplets: InstanceSpec[];
	leaves: InstanceSpec[];
	mounds: InstanceSpec[];
	stems: InstanceSpec[];
	trunks: InstanceSpec[];
}

function leafColor(stage: CropStage, seed: number): string {
	if (stage === "withered") {
		return seed % 2 ? FARM_3D.withered : FARM_3D.witheredDark;
	}
	if (stage === "seed") {
		return FARM_3D.leafYoung;
	}
	return seed % 3 ? FARM_3D.leaf : FARM_3D.leafDark;
}

/** A ring of `count` balls on a crop at radius `r`, height `y`. */
function ring(
	parts: InstanceSpec[],
	at: [number, number],
	count: number,
	r: number,
	y: number,
	size: Vec3,
	color: string,
	turn = 0
) {
	for (let index = 0; index < count; index++) {
		const angle = turn + (index / count) * Math.PI * 2;
		parts.push({
			color,
			position: [
				at[0] + Math.cos(angle) * r,
				y + (index % 2) * size[1] * 0.4,
				at[1] + Math.sin(angle) * r,
			],
			rotation: [0, -angle, 0],
			scale: size,
		});
	}
}

/** The leafy body of a plant: what every fruit grows from. */
function addPlantBody(
	parts: CropParts,
	fruit: FruitKind,
	at: [number, number],
	grown: number,
	stage: CropStage,
	seed: number
) {
	const leaf = leafColor(stage, seed);
	const droop = stage === "withered" ? 0.45 : 1;
	const turn = (seed % 7) * 0.4;
	switch (fruit) {
		case "apple":
			// A dwarf tree: trunk and one round crown.
			parts.trunks.push({
				color: FARM_3D.stake,
				position: [at[0], 0.22 * grown * droop, at[1]],
				scale: [0.045, 0.44 * grown * droop, 0.045],
			});
			parts.leaves.push({
				color: leaf,
				position: [at[0], 0.52 * grown * droop, at[1]],
				scale: [0.25 * grown, 0.22 * grown * droop, 0.25 * grown],
			});
			break;
		case "pumpkin":
			// A low spreading vine.
			ring(
				parts.leaves,
				at,
				4,
				0.15 * grown,
				0.06,
				[0.11 * grown, 0.045, 0.09 * grown],
				leaf,
				turn
			);
			break;
		case "blueberry":
			parts.leaves.push({
				color: leaf,
				position: [at[0], 0.17 * grown * droop, at[1]],
				scale: [0.2 * grown, 0.17 * grown * droop, 0.2 * grown],
			});
			break;
		case "grapes":
		case "tomato":
			// Staked: a cane up the middle with leaves along it.
			parts.trunks.push({
				color: FARM_3D.stake,
				position: [at[0], 0.3 * grown, at[1] - 0.04],
				scale: [0.018, 0.6 * grown, 0.018],
			});
			ring(
				parts.leaves,
				at,
				3,
				0.08,
				0.18 * grown * droop,
				[0.09 * grown, 0.07 * grown, 0.08 * grown],
				leaf,
				turn
			);
			ring(
				parts.leaves,
				at,
				3,
				0.06,
				0.38 * grown * droop,
				[0.08 * grown, 0.06 * grown, 0.07 * grown],
				leaf,
				turn + 1
			);
			break;
		default:
			// Strawberries: a low rosette.
			ring(
				parts.leaves,
				at,
				5,
				0.09 * grown,
				0.08 * droop,
				[0.075 * grown, 0.05, 0.06 * grown],
				leaf,
				turn
			);
	}
}

/** The fruit of a ripe plant. */
function addFruit(
	parts: CropParts,
	fruit: FruitKind,
	at: [number, number],
	seed: number
) {
	const [main, light] = FRUIT_3D[fruit];
	const turn = (seed % 5) * 0.5;
	switch (fruit) {
		case "apple":
			ring(parts.balls, at, 5, 0.2, 0.46, [0.055, 0.055, 0.055], main, turn);
			break;
		case "pumpkin":
			parts.balls.push({
				color: main,
				position: [at[0] + 0.03, 0.12, at[1] + 0.05],
				scale: [0.2, 0.14, 0.2],
			});
			parts.stems.push({
				color: FARM_3D.stem,
				position: [at[0] + 0.03, 0.27, at[1] + 0.05],
				rotation: [0.2, 0, 0.3],
				scale: [0.02, 0.07, 0.02],
			});
			break;
		case "blueberry":
			ring(parts.balls, at, 7, 0.17, 0.2, [0.035, 0.035, 0.035], main, turn);
			break;
		case "grapes":
			for (const [index, side] of [-1, 1].entries()) {
				for (let berry = 0; berry < 6; berry++) {
					const row = berry < 3 ? 0 : berry < 5 ? 1 : 2;
					const across =
						(berry < 3 ? berry - 1 : berry < 5 ? berry - 3.5 : 0) * 0.05;
					parts.balls.push({
						color: berry % 2 ? light : main,
						position: [
							at[0] + side * 0.1 + across,
							0.42 - row * 0.05 - index * 0.06,
							at[1] + 0.07,
						],
						scale: 0.035,
					});
				}
			}
			break;
		case "tomato":
			ring(parts.balls, at, 4, 0.1, 0.24, [0.06, 0.055, 0.06], main, turn);
			break;
		default:
			ring(parts.balls, at, 4, 0.13, 0.05, [0.04, 0.05, 0.04], main, turn);
	}
}

/** Every crop's parts: soil mound, then sprout, plant, fruit by stage. */
export function cropParts(
	crops: readonly { crop: FarmCrop; x: number; z: number }[]
): CropParts {
	const parts: CropParts = {
		balls: [],
		droplets: [],
		leaves: [],
		mounds: [],
		stems: [],
		trunks: [],
	};
	for (const [index, { crop, x, z }] of crops.entries()) {
		const at: [number, number] = [x, z];
		const seed = index * 13 + crop.thread.id.length;
		const starts = PART_KEYS.map((key) => parts[key].length);
		parts.mounds.push({
			color: crop.stage === "withered" ? FARM_3D.soilDry : FARM_3D.ridge,
			position: [x, 0.015, z],
			scale: [0.26, 0.07, 0.26],
		});
		switch (crop.stage) {
			case "seed":
				parts.stems.push({
					color: FARM_3D.stem,
					position: [x, 0.08, z],
					scale: [0.012, 0.1, 0.012],
				});
				ring(
					parts.leaves,
					at,
					2,
					0.04,
					0.13,
					[0.055, 0.02, 0.035],
					FARM_3D.leafYoung,
					seed
				);
				parts.droplets.push({
					color: FARM_3D.droplet,
					position: [x, 0.36, z],
					scale: [0.045, 0.06, 0.045],
				});
				break;
			case "growing":
				// A crop the act layer grew to its plan's steps stands that tall.
				addPlantBody(
					parts,
					crop.fruit,
					at,
					crop.growth === undefined ? 0.72 : growingScale(crop.growth) * 0.92,
					"growing",
					seed
				);
				break;
			case "ripe":
				addPlantBody(parts, crop.fruit, at, 1, "ripe", seed);
				addFruit(parts, crop.fruit, at, seed);
				// An answer left unread over-ripens: fruit drops to the soil.
				for (let fallen = 0; fallen < (crop.overripe ?? 0); fallen++) {
					const turn = seed + fallen * 2.1;
					parts.balls.push({
						color: FRUIT_3D[crop.fruit][0],
						position: [
							x + Math.cos(turn) * 0.24,
							0.05,
							z + Math.sin(turn) * 0.24,
						],
						scale: [0.06, 0.045, 0.06],
					});
				}
				break;
			case "withered":
				addPlantBody(parts, crop.fruit, at, 0.8, "withered", seed);
				break;
			default:
				break;
		}
		// Plants are modelled small and grown to the bed's scale here.
		for (const [key, start] of PART_KEYS.map(
			(name, slot) => [name, starts[slot] ?? 0] as const
		)) {
			const list = parts[key];
			for (let item = start; item < list.length; item++) {
				const spec = list[item];
				if (spec) {
					list[item] = growCrop(spec, at);
				}
			}
		}
	}
	return parts;
}

const PART_KEYS = [
	"balls",
	"droplets",
	"leaves",
	"mounds",
	"stems",
	"trunks",
] as const satisfies readonly (keyof CropParts)[];

/** How much bigger a plant is drawn than it is modelled. */
const CROP_SCALE = 1.85;

function growCrop(spec: InstanceSpec, at: [number, number]): InstanceSpec {
	const [x, y, z] = spec.position;
	const scale = spec.scale ?? 1;
	return {
		...spec,
		position: [
			at[0] + (x - at[0]) * CROP_SCALE,
			y * CROP_SCALE,
			at[1] + (z - at[1]) * CROP_SCALE,
		],
		scale:
			typeof scale === "number"
				? scale * CROP_SCALE
				: [scale[0] * CROP_SCALE, scale[1] * CROP_SCALE, scale[2] * CROP_SCALE],
	};
}

/** Planks around each bed and furrow ridges across it. */
function bedParts(beds: readonly PlacedBed[], night: boolean) {
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
function Barn({ night, rect }: { night: boolean; rect: Rect }) {
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
function Silo({ at }: { at: [number, number] }) {
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
function HayBales({ at }: { at: [number, number] }) {
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
function fenceRuns(rect: Rect): FenceRun[] {
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
function scenery(diorama: FarmDiorama, shape: IslandShape) {
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
function groundPaint(diorama: FarmDiorama, night: boolean) {
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

/**
 * The act layer, when the host sends asks (farm-acts.tsx): the farmers'
 * act villagers, their waypoints, and the props at the beds and the porch.
 * Without it the farm draws today's poses.
 */
export interface FarmActScene {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	/** `benchOf`: where each limited farmer sits. */
	benches: ReadonlyMap<string, string>;
	handlers: FarmActHandlers;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	paths: LifePaths;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	villagers: readonly VillagerSpec[];
}

export interface FarmDioramaProps {
	actScene?: FarmActScene | null;
	diorama: FarmDiorama;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onOpenBarn: () => void;
	onOpenCrop: (threadId: string) => void;
	onOpenPlot: (plotId: string) => void;
	quality: RenderQuality;
	reducedMotion: boolean;
	selectedPlotId: string | null;
	shape: IslandShape;
	theme: Scene3dTheme;
}

const TOOLS: readonly VillagerTool[] = ["can", "hoe", "basket"];

/** The farm's diorama: island, barn yard, fields, beds, crops and farmers. */
export function FarmDioramaScene({
	actScene = null,
	diorama,
	looks,
	night,
	onOpenBarn,
	onOpenCrop,
	onOpenPlot,
	quality,
	reducedMotion,
	selectedPlotId,
	shape,
	theme,
}: FarmDioramaProps) {
	const paint = useMemo(() => groundPaint(diorama, night), [diorama, night]);
	const avoid = useMemo(() => {
		const barn = diorama.barn;
		return (x: number, z: number) =>
			inRect(barn, x, z, 0.3) ||
			paint(x, z) !== null ||
			diorama.beds.some(({ bed }) => inRect(bed, x, z, 0.15)) ||
			Math.hypot(x - diorama.silo[0], z - diorama.silo[1]) < 0.7 ||
			Math.hypot(x - diorama.pond.x, z - diorama.pond.z) <
				diorama.pond.radius + 0.25;
	}, [diorama, paint]);
	const crops = useMemo(
		() => diorama.beds.flatMap((placed) => placed.crops),
		[diorama]
	);
	const parts = useMemo(() => cropParts(crops), [crops]);
	const beds = useMemo(() => bedParts(diorama.beds, night), [diorama, night]);
	const green = useMemo(() => scenery(diorama, shape), [diorama, shape]);
	const fences = useMemo(
		() =>
			diorama.fields.flatMap(({ fence }) => (fence ? fenceRuns(fence) : [])),
		[diorama]
	);
	const lamps = useMemo<Vec3[]>(() => {
		const points: Vec3[] = [
			[diorama.barn.maxX + 0.3, 0, diorama.barn.maxZ + 0.3],
		];
		for (const path of diorama.paths) {
			points.push([path.minX + 0.3, 0, path.minZ - 0.1]);
			points.push([path.maxX - 0.3, 0, path.maxZ + 0.1]);
		}
		return points;
	}, [diorama]);
	const stones = useMemo<Vec3[]>(() => {
		// Stepping stones from the barn door down to the front of the farm.
		const x = (diorama.barn.minX + diorama.barn.maxX) / 2;
		const points: Vec3[] = [];
		for (
			let z = diorama.barn.maxZ + 0.5;
			z < diorama.bounds.maxZ + 1.5;
			z += 0.75
		) {
			if (!diorama.beds.some(({ bed }) => inRect(bed, x, z, 0.4))) {
				points.push([x + Math.sin(z * 2.1) * 0.12, 0, z]);
			}
		}
		return points;
	}, [diorama]);
	const villagers = useMemo<VillagerSpec[]>(() => {
		const list: VillagerSpec[] = [];
		for (const [index, { farmer, plot }] of diorama.beds.entries()) {
			const agent = plot.agent;
			const base = agent ? looks.get(agent.id) : undefined;
			if (!(agent && base)) {
				continue;
			}
			const mood = plotMood(plot);
			const pose = POSE_BY_MOOD[mood];
			const ripe = plot.crops.filter((crop) => crop.stage === "ripe").length;
			const status =
				ripe > 0 ? `${ripe} ripe` : STAGE_NAMES[mood].toLowerCase();
			list.push({
				// Facing the bed (to its left) while it works.
				facing: pose === "working" ? -Math.PI / 2.6 : undefined,
				id: plot.id,
				label: `${plotLabel(plot)}, ${status}`,
				looks: {
					...base,
					tool: pose === "working" ? TOOLS[index % TOOLS.length] : undefined,
				},
				name: plot.name,
				pose,
				position: [farmer[0], 0, farmer[1]],
			});
		}
		return list;
	}, [diorama, looks]);
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
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={green.bushes} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			<Fences runs={fences} />
			<PathStones night={night} size={0.5} stones={stones} />
			<LampPosts lamps={lamps} night={night} />
			<Barn night={night} rect={diorama.barn} />
			<Silo at={diorama.silo} />
			<HayBales at={[diorama.barn.minX + 0.2, diorama.barn.maxZ + 0.55]} />
			<Pond
				at={[diorama.pond.x, 0, diorama.pond.z]}
				night={night}
				radius={diorama.pond.radius}
			/>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={FARM_3D.bedFrame}
				items={beds.planks}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={beds.ridges} receiveShadow>
				<sphereGeometry args={[0.5, 16, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.mounds} receiveShadow>
				<sphereGeometry args={[1, 14, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={parts.stems}>
				<cylinderGeometry args={[1, 1, 1, 6]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow ink={CROP_INK} items={parts.trunks}>
				<cylinderGeometry args={[1, 1, 1, 8]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={CROP_INK}
				items={parts.leaves}
				receiveShadow
			>
				<sphereGeometry args={[1, 14, 10]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow ink={CROP_INK} items={parts.balls}>
				<sphereGeometry args={[1, 14, 10]} />
				<ToonMaterial rim={0.25} />
			</InstancedParts>
			<InstancedParts items={parts.droplets}>
				<sphereGeometry args={[1, 12, 8]} />
				<ToonMaterial rim={0.4} />
			</InstancedParts>
			<CropHits crops={crops} onOpen={onOpenCrop} />
			<Villagers
				iconOnly={actScene?.handlers.iconOnly ?? false}
				// The kids who help are not plots: a pick on one opens nothing.
				onSelect={(id) => {
					if (!id.includes(":helper:")) {
						onOpenPlot(id);
					}
				}}
				paths={actScene?.paths}
				reducedMotion={reducedMotion}
				selectedId={selectedPlotId}
				villagers={actScene?.villagers ?? villagers}
			/>
			{actScene ? <FarmActProps actScene={actScene} diorama={diorama} /> : null}
			{diorama.beds
				.filter(({ plot }) => !plot.agent)
				.map(({ plot, sign }) => (
					<IsoMarker
						at={[sign[0], 0.35, sign[1]]}
						focusId={plot.id}
						key={plot.id}
						label={plotLabel(plot)}
						onSelect={() => onOpenPlot(plot.id)}
						pressed={selectedPlotId === plot.id}
					>
						{plot.name}
					</IsoMarker>
				))}
			{diorama.fields
				.filter(({ fence }) => fence)
				.map(({ field, sign }) => (
					<IsoLabel at={[sign[0], 0.75, sign[1]]} key={field.id}>
						{field.name}
					</IsoLabel>
				))}
			<IsoMarker
				at={[
					(diorama.barn.minX + diorama.barn.maxX) / 2,
					2.6,
					(diorama.barn.minZ + diorama.barn.maxZ) / 2,
				]}
				focusId="barn"
				label="Barn: every crop by status"
				onSelect={onOpenBarn}
			>
				Barn
			</IsoMarker>
		</group>
	);
}

/** The act props at every agent's bed and at the porch. */
function FarmActProps({
	actScene,
	diorama,
}: {
	actScene: FarmActScene;
	diorama: FarmDiorama;
}) {
	const beds = useMemo(() => bedsByAgent(diorama), [diorama]);
	const benches = porchSpots(diorama).benches;
	return (
		<group>
			{[...beds].map(([agentId, placed]) => {
				const act = actScene.acts.get(agentId);
				const bench = actScene.benches.get(agentId);
				return act ? (
					<FarmBedActs
						act={act}
						bench={
							bench
								? (benches[Number(bench.slice("bench-".length))] ?? null)
								: null
						}
						handlers={actScene.handlers}
						key={agentId}
						placed={placed}
					/>
				) : null;
			})}
			<FarmPorchActs
				diorama={diorama}
				handlers={actScene.handlers}
				offStage={actScene.offStage}
				onStage={actScene.onStage}
				owners={actScene.owners}
				slots={actScene.slots}
			/>
		</group>
	);
}

/** One invisible hit box per crop: clicking a plant opens its conversation. */
function CropHits({
	crops,
	onOpen,
}: {
	crops: readonly { crop: FarmCrop; x: number; z: number }[];
	onOpen: (threadId: string) => void;
}) {
	if (crops.length === 0) {
		return null;
	}
	return (
		<group>
			{crops.map(({ crop, x, z }) => (
				<mesh
					key={crop.thread.id}
					onClick={(event) => {
						event.stopPropagation();
						onOpen(crop.thread.id);
					}}
					position={[x, 0.3, z]}
				>
					<boxGeometry args={[0.7, 0.6, 0.7]} />
					<meshBasicMaterial visible={false} />
				</mesh>
			))}
		</group>
	);
}

/** A crop's accessible name, for lists outside the diorama. */
export function cropStatusLabel(crop: FarmCrop): string {
	return `${STAGE_NAMES[crop.stage]}, ${THREAD_STATUS_LABELS[crop.status].toLowerCase()}`;
}
