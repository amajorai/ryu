import {
	type CropStage,
	type FarmCrop,
	type FruitKind,
	growingScale,
} from "./farm-model.ts";
import { FARM_3D, FRUIT_3D } from "./farm-palette.ts";
import type { InstanceSpec } from "./game3d-instances.tsx";
import type { Vec3 } from "./game3d-palette.ts";

/*
 * The Farm diorama's crops (farm-diorama.tsx): every plant's parts by
 * stage, modelled small and grown to the bed's scale.
 */

export interface CropParts {
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
