import type { Vec3 } from "./game3d-palette.ts";
import {
	bodyColor,
	collarColor,
	fixed,
	HEAD_Y,
	type MemberLooks,
	type PartSpec,
	type VillagerAccessory,
} from "./game3d-villager-model.ts";
import { GEAR } from "./game3d-villager-tools.ts";

const accentColor = (looks: MemberLooks) => looks.accent ?? looks.collar;

/** One head accessory's parts, drawn only for the villagers wearing it. */
function wornParts(kind: VillagerAccessory, parts: Omit<PartSpec, "when">[]) {
	return parts.map<PartSpec>((part) => ({
		...part,
		when: (looks) => looks.accessory === kind,
	}));
}

const FLOWER_PETALS = 5;

/** Every head accessory, sized to the chibi head. */
export const ACCESSORY_PARTS: PartSpec[] = [
	...wornParts("cap", [
		{
			color: bodyColor,
			geometry: "dome",
			position: [0, HEAD_Y + 0.07, -0.02],
			rotation: [-0.22, 0, 0],
			scale: [0.36, 0.3, 0.36],
			shadow: true,
		},
		{
			color: bodyColor,
			geometry: "disc",
			position: [0, HEAD_Y + 0.19, 0.27],
			rotation: [0.28, 0, 0],
			scale: [0.2, 0.02, 0.17],
		},
	]),
	...wornParts("beanie", [
		{
			color: accentColor,
			geometry: "dome",
			position: [0, HEAD_Y + 0.05, -0.03],
			rotation: [-0.3, 0, 0],
			scale: [0.365, 0.36, 0.365],
			shadow: true,
		},
		{
			color: collarColor,
			geometry: "ball",
			position: [0, HEAD_Y + 0.42, -0.12],
			scale: [0.07, 0.07, 0.07],
		},
	]),
	...wornParts("bow", [
		...[-1, 1].map((side) => ({
			color: accentColor,
			geometry: "ball" as const,
			position: [0.2 + side * 0.08, HEAD_Y + 0.3, -0.06] as Vec3,
			rotation: [0, 0, side * 0.5] as Vec3,
			scale: [0.09, 0.055, 0.04] as Vec3,
		})),
		{
			color: accentColor,
			geometry: "ball",
			position: [0.2, HEAD_Y + 0.3, -0.05],
			scale: [0.035, 0.035, 0.035],
		},
	]),
	...wornParts("flower", [
		...Array.from({ length: FLOWER_PETALS }, (_, index) => {
			const angle = (index / FLOWER_PETALS) * Math.PI * 2;
			return {
				color: accentColor,
				geometry: "ball" as const,
				position: [
					0.22 + Math.cos(angle) * 0.045,
					HEAD_Y + 0.24 + Math.sin(angle) * 0.045,
					0.13,
				] as Vec3,
				rotation: [0, 0.6, 0] as Vec3,
				scale: [0.04, 0.04, 0.02] as Vec3,
			};
		}),
		{
			color: fixed(GEAR.flowerHeart),
			geometry: "ball",
			position: [0.22, HEAD_Y + 0.24, 0.14],
			scale: [0.025, 0.025, 0.02],
		},
	]),
	...wornParts("bandana", [
		{
			color: accentColor,
			geometry: "dome",
			position: [0, HEAD_Y + 0.09, -0.02],
			rotation: [-0.5, 0, 0],
			scale: [0.36, 0.3, 0.36],
			shadow: true,
		},
		...[-1, 1].map((side) => ({
			color: accentColor,
			geometry: "ball" as const,
			position: [side * 0.05, HEAD_Y + 0.02, -0.36] as Vec3,
			rotation: [0.4, 0, side * 0.6] as Vec3,
			scale: [0.04, 0.09, 0.03] as Vec3,
		})),
	]),
	...wornParts("chef", [
		{
			color: fixed(GEAR.chef),
			geometry: "disc",
			position: [0, HEAD_Y + 0.36, -0.03],
			scale: [0.25, 0.24, 0.25],
			shadow: true,
		},
		{
			color: fixed(GEAR.chef),
			geometry: "ball",
			position: [0, HEAD_Y + 0.52, -0.03],
			scale: [0.31, 0.17, 0.31],
			shadow: true,
		},
	]),
	...wornParts("straw", [
		{
			color: fixed(GEAR.straw),
			geometry: "disc",
			position: [0, HEAD_Y + 0.25, -0.03],
			rotation: [-0.14, 0, 0.05],
			scale: [0.42, 0.025, 0.42],
			shadow: true,
		},
		{
			color: fixed(GEAR.straw),
			geometry: "dome",
			position: [0, HEAD_Y + 0.26, -0.04],
			rotation: [-0.14, 0, 0.05],
			scale: [0.24, 0.22, 0.24],
		},
		{
			color: fixed(GEAR.strawBand),
			geometry: "disc",
			position: [0, HEAD_Y + 0.29, -0.04],
			rotation: [-0.14, 0, 0.05],
			scale: [0.243, 0.04, 0.243],
		},
	]),
];
