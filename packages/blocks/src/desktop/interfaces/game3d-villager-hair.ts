import { ART_WHITE, type Vec3 } from "./game3d-palette.ts";
import {
	BODY_Y,
	bodyColor,
	CHEEK_COLOR,
	collarColor,
	EYE_COLOR,
	EYE_DY,
	EYE_X,
	fixed,
	HEAD_Y,
	hairColor,
	headTurn,
	irisColor,
	LASH_ARC,
	LASH_COLOR,
	lock,
	MOUTH_COLOR,
	onHead,
	type PartSpec,
	pair,
	SHOE_COLOR,
	skinColor,
} from "./game3d-villager-model.ts";

/** Hair on the head's surface, `lift` out: (x, y) across the face. */
const HAIR_LIFT = 0.03;
const onHair = (x: number, y: number, lift = HAIR_LIFT) => onHead(x, y, lift);

/**
 * The fringe: four chunky, rounded bangs of uneven length, parted to one
 * side. Every tip over the eyes stops above the lash line (only the outer
 * lock, clear of the eyes, reaches lower), so both eyes always read, even
 * in three-quarter view.
 * Each lock: root (x, y) and tip (x, y) across the face, width.
 */
const FRINGE_LOCKS = [
	[-0.26, 0.22, -0.3, 0.07, 0.07],
	[-0.14, 0.3, -0.16, 0.168, 0.086],
	[-0.02, 0.32, -0.03, 0.182, 0.088],
	[0.1, 0.31, 0.11, 0.172, 0.086],
] as const;

/**
 * The fringe locks, rooted on top of the cap (lowered by `drop` under a
 * hat brim) with their tips resting on the brow.
 */
export function fringe(drop = 0): PartSpec[] {
	return FRINGE_LOCKS.map(([rootX, rootY, tipX, tipY, width]) =>
		lock(
			onHair(rootX, rootY - drop, 0.03),
			onHair(tipX, tipY, 0.028),
			width,
			0.045
		)
	);
}

const FRINGE = fringe();

/** Long locks framing the face, down past the cheeks to the chin. */
export const SIDE_LOCKS: PartSpec[] = [-1, 1].map((side) =>
	lock(
		[side * 0.3, HEAD_Y + 0.16, 0.1],
		[side * 0.34, HEAD_Y - 0.34, 0.08],
		0.07,
		0.05
	)
);

/**
 * Tufts that break the round outline: points flaring out over the ears and
 * flicking back off the crown and the nape.
 */
export const EAR_TUFTS: PartSpec[] = [-1, 1].map((side) =>
	lock(
		[side * 0.26, HEAD_Y + 0.17, 0.02],
		[side * 0.44, HEAD_Y - 0.02, -0.02],
		0.075,
		0.05
	)
);
const NAPE_TUFTS: PartSpec[] = [
	...[-1, 1].map((side) =>
		lock(
			[side * 0.2, HEAD_Y - 0.06, -0.22],
			[side * 0.36, HEAD_Y - 0.3, -0.3],
			0.07,
			0.05
		)
	),
	lock([0.0, HEAD_Y - 0.12, -0.28], [0.02, HEAD_Y - 0.36, -0.36], 0.08, 0.05),
];
const CROWN_TUFTS: PartSpec[] = [
	lock([0.02, HEAD_Y + 0.3, -0.16], [0.04, HEAD_Y + 0.42, -0.36], 0.07, 0.05),
	lock([-0.12, HEAD_Y + 0.24, -0.2], [-0.2, HEAD_Y + 0.3, -0.4], 0.065, 0.05),
];

/** Long hair: tapered locks falling down the back to the shoulders. */
const LONG_HAIR: PartSpec[] = [-0.17, 0, 0.17].map((x, index) =>
	lock(
		[x, HEAD_Y + 0.02, -0.25],
		[x * 1.5, HEAD_Y - 0.66 - (index % 2) * 0.06, -0.32],
		0.14,
		0.07,
		[1]
	)
);

/** Spiky: points standing up off the crown. */
const SPIKES: PartSpec[] = [-0.17, -0.02, 0.15].map((x, index) =>
	lock(
		[x, HEAD_Y + 0.26 - Math.abs(x) * 0.3, -0.06],
		[x * 1.9, HEAD_Y + 0.5 - Math.abs(x) * 0.5 + (index % 2) * 0.05, -0.2],
		0.1,
		0.07,
		[2]
	)
);

/**
 * Anime eyes: a tall dark almond about a third of the face, a colored
 * iris, a thick upper lash line, and two glints set the same way in both
 * eyes (a large one up and to the left, a small one down and to the right).
 */
export function eyeParts(): PartSpec[] {
	const [ex, ey, ez] = onHead(EYE_X, EYE_DY, -0.014);
	const turn = headTurn(EYE_X, EYE_DY);
	const glints: PartSpec[] = [-1, 1].flatMap((side) => [
		{
			color: fixed(ART_WHITE),
			geometry: "shine" as const,
			position: [ex * side - 0.032, ey + 0.05, ez + 0.044] as Vec3,
			scale: [1.6, 1.75, 0.8] as Vec3,
		},
		{
			color: fixed(ART_WHITE),
			geometry: "shine" as const,
			position: [ex * side + 0.03, ey - 0.052, ez + 0.04] as Vec3,
			scale: [0.8, 0.8, 0.5] as Vec3,
		},
		{
			color: fixed(ART_WHITE),
			geometry: "shine" as const,
			position: [ex * side + 0.018, ey + 0.03, ez + 0.042] as Vec3,
			scale: [0.5, 0.5, 0.4] as Vec3,
		},
	]);
	return [
		...pair({
			color: fixed(EYE_COLOR),
			geometry: "eye",
			position: [ex, ey, ez],
			rotation: turn,
			scale: [0.76, 1.3, 0.38],
		}),
		...pair({
			color: irisColor,
			geometry: "iris",
			position: [ex, ey - 0.03, ez + 0.016],
			rotation: turn,
			scale: [0.68, 0.92, 0.32],
		}),
		...glints,
		// An arched upper lash hugging the top of each eye (not mirrored by
		// `pair`: the arch stays centered on top for both eyes).
		...[-1, 1].map<PartSpec>((side) => ({
			color: fixed(LASH_COLOR),
			geometry: "lash",
			position: [ex * side, ey + 0.006, ez + 0.006],
			rotation: [turn[0], turn[1] * side, Math.PI / 2 - LASH_ARC / 2],
			scale: [0.82, 1.32, 1],
		})),
	];
}

/** The villager rig, in local space with the feet at the origin facing +Z. */
export const AGENT_PARTS: PartSpec[] = [
	...pair({
		color: fixed(SHOE_COLOR),
		geometry: "shoe",
		position: [0.085, 0.05, 0.03],
		scale: [1, 0.72, 1.3],
		shadow: true,
	}),
	{
		color: bodyColor,
		geometry: "body",
		position: [0, BODY_Y, 0],
		scale: [1, 1, 0.92],
		shadow: true,
	},
	{
		color: collarColor,
		geometry: "collar",
		position: [0, BODY_Y + 0.2, 0.005],
		rotation: [Math.PI / 2 + 0.1, 0, 0],
	},
	...pair({
		color: bodyColor,
		geometry: "arm",
		position: [0.19, BODY_Y + 0.02, 0.02],
		rotation: [0.15, 0, 0.42],
		shadow: true,
	}),
	{
		color: skinColor,
		geometry: "head",
		position: [0, HEAD_Y, 0],
		shadow: true,
	},
	// Hair: a cap over the crown, tilted back so its front edge sits well
	// above the brows (the fringe makes the outline), and a fuller back.
	{
		color: hairColor,
		geometry: "hair",
		position: [0, HEAD_Y + 0.035, -0.05],
		rotation: [-0.72, 0, 0],
		scale: [1.05, 0.98, 1.03],
		shadow: true,
	},
	{
		color: hairColor,
		geometry: "mane",
		position: [0, HEAD_Y - 0.01, -0.11],
		scale: [1.01, 0.97, 0.9],
	},
	...FRINGE,
	...SIDE_LOCKS,
	...EAR_TUFTS,
	...NAPE_TUFTS,
	...CROWN_TUFTS,
	// Long: a mass down the back ending in tapered locks.
	{
		color: hairColor,
		geometry: "lock",
		position: [0, HEAD_Y - 0.28, -0.2],
		rotation: [0.16, 0, 0],
		scale: [2.9, 1.6, 1.3],
		styles: [1],
	},
	...LONG_HAIR,
	...SPIKES,
	// A cowlick curling up off the crown (the bun takes its place).
	{
		color: hairColor,
		geometry: "ahoge",
		position: [0.03, HEAD_Y + 0.4, 0.0],
		rotation: [0, Math.PI / 2, 0.3],
		styles: [0, 1, 2],
	},
	// Bun: one round bun high on the back of the head.
	{
		color: hairColor,
		geometry: "bun",
		position: [0, HEAD_Y + 0.27, -0.2],
		shadow: true,
		styles: [3],
	},
	...eyeParts(),
	{
		color: fixed(MOUTH_COLOR),
		geometry: "mouth",
		position: onHead(0, -0.19, -0.004),
		rotation: headTurn(0, -0.19),
		scale: [1.4, 0.7, 0.5],
	},
	...pair({
		color: fixed(CHEEK_COLOR),
		geometry: "cheek",
		position: onHead(0.2, -0.15, -0.012),
		rotation: headTurn(0.2, -0.15),
		scale: [1, 0.52, 0.3],
	}),
];
