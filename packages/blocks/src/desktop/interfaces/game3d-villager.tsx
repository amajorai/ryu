/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { type Camera, useFrame, useThree } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
	Euler,
	Group,
	InstancedMesh,
	Matrix4,
	Mesh,
	Vector3,
} from "three";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { shareHull } from "./game3d-instances.tsx";
import {
	compileLife,
	emptyLifeFrame,
	type LifeBubble,
	type LifeBubbleSide,
	type LifeItem,
	type LifePaths,
	type LifeScript,
	type LifeState,
	lifeStateAt,
	sampleLife,
} from "./game3d-life.ts";
import {
	bubbleWords,
	CarriedItem,
	LifeBubbleTag,
	LifeEffects,
	type LifeRuntime,
	poseLife,
} from "./game3d-life.tsx";
import {
	CurvedBasicMaterial,
	InkMaterial,
	ToonMaterial,
} from "./game3d-materials.tsx";
import { mathKit } from "./game3d-math.ts";
import {
	type AgentSwatch,
	ART_WHITE,
	accentFor,
	agentSwatches,
	swatchOf,
	type Vec3,
	VILLAGER_FEATURES,
	VILLAGER_GEAR,
	villagerLooks,
} from "./game3d-palette.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";

/**
 * The kit's villagers: the chibi characters of World 3D (a big round head
 * about as tall as the small body, stubby arms and feet) with anime faces:
 * large eyes with a colored iris, two highlights and a lash line, a small
 * mouth and blush, and anime hair (bangs, side locks, and a style per
 * agent: short, long, spiky with an ahoge, or a bun). Every villager is the
 * same rig drawn with one instanced mesh per body part (plus one ink hull
 * for the parts that are outlined), so a crowd stays a few dozen draw calls.
 *
 * - `VillagerRig` draws the rig for any number of villagers; the caller
 *   poses each one every frame (root transform and arm swings).
 * - `Villagers` is what a game uses: one villager per agent, posed by state
 *   (`idle`, `working` with a tool in hand, `needs-you` waving under a
 *   bouncing "!" bubble, `failed` slumped with a red mark, `waiting`
 *   looking around), optionally walking a looped path, each with a name
 *   plate that is the villager's focusable, clickable control.
 * - `useVillagerLooks` gives each agent its outfit (from its swatch), hair
 *   and a head accessory, so agents read apart at a glance.
 */

/** What a villager holds while it works. */
export type VillagerTool =
	| "basket"
	| "book"
	| "broom"
	| "can"
	| "clipboard"
	| "globe"
	| "hammer"
	| "hoe"
	| "knife"
	| "ladle"
	| "ledger"
	| "lens"
	| "pan"
	| "quill"
	| "scale"
	| "wrench";

/** What a villager wears on its head. */
export type VillagerAccessory =
	| "bandana"
	| "beanie"
	| "bow"
	| "cap"
	| "chef"
	| "flower"
	| "none"
	| "straw";

/** What a villager is doing, from its agent's state. */
export type VillagerPose =
	| "failed"
	| "idle"
	| "needs-you"
	| "waiting"
	| "working";

/**
 * Rim light strength on characters (scenery has none): softer on heads and
 * hair, so the edge light never rings a face like a helmet.
 */
export const CHARACTER_RIM = 0.45;
export const HEAD_RIM = 0.3;
/** Anime sheen band across the hair. */
export const HAIR_SHEEN = 0.17;
export const CHARACTER_INK = 0.02;
/** Thinner ink on the hair locks, so each reads without turning dark. */
export const LOCK_INK = 0.012;

const EYE_COLOR = VILLAGER_FEATURES.eye;
const LASH_COLOR = VILLAGER_FEATURES.lash;
const CHEEK_COLOR = VILLAGER_FEATURES.cheek;
export const SHOE_COLOR = VILLAGER_FEATURES.shoe;
const MOUTH_COLOR = VILLAGER_FEATURES.mouth;
/** Linear RGB past white: the eye glints catch the bloom. */
export const SHINE: Vec3 = [1.6, 1.6, 1.6];

/** Chibi proportions: a head about as tall as the body under it. */
export const HEAD_RADIUS = 0.33;
export const HEAD_Y = 0.82;
export const BODY_Y = 0.3;

/** A point on the head's surface, `lift` out along its normal. */
export function onHead(x: number, y: number, lift = 0): Vec3 {
	const z = Math.sqrt(Math.max(0, HEAD_RADIUS ** 2 - x * x - y * y));
	const scale = (HEAD_RADIUS + lift) / HEAD_RADIUS;
	return [x * scale, HEAD_Y + y * scale, z * scale];
}

/** Rotation that lays a flattened part onto the head at (x, y). */
export function headTurn(x: number, y: number, roll = 0): Vec3 {
	const [px, py, pz] = onHead(x, y);
	return [Math.asin(-(py - HEAD_Y) / HEAD_RADIUS), Math.atan2(px, pz), roll];
}

const EYE_X = 0.12;
/** The eyes sit on the face's vertical center, a step below the fringe. */
const EYE_DY = -0.012;
/** Eye white-less anime eye: a tall dark almond about a third of the face. */
const EYE_RADIUS = 0.104;
/** How far the upper lash line wraps over the top of the eye, radians. */
const LASH_ARC = 2.2;

export type PartGeometry =
	| "ahoge"
	| "arm"
	| "body"
	| "bun"
	| "cheek"
	| "collar"
	| "eye"
	| "hair"
	| "head"
	| "iris"
	| "lash"
	| "lock"
	| "mane"
	| "mouth"
	| "point"
	| "shine"
	| "shoe"
	// Unit shapes for held tools and head accessories (scaled per part).
	| "ball"
	| "box"
	| "cone"
	| "disc"
	| "dome"
	| "ring"
	| "stick";

/** What a villager looks like: shirt, hair and eyes from its color family. */
export interface MemberLooks {
	/** A second outfit color for accessories: bows, bandanas, flowers. */
	accent?: string;
	/** What the villager wears on its head (games and agents vary it). */
	accessory?: VillagerAccessory;
	body: string;
	/** Lighter shirt trim at the neck. */
	collar: string;
	hair: string;
	/** 0 short, 1 long, 2 spiky, 3 bun. */
	hairStyle: number;
	iris: string;
	skin: string;
	/** What the villager holds in its right hand. */
	tool?: VillagerTool;
}

export interface PartSpec {
	color: (looks: MemberLooks) => string;
	geometry: PartGeometry;
	/** Moves with this arm's swing (tools ride the right hand). */
	limb?: "left" | "right";
	position: Vec3;
	rotation?: Vec3;
	scale?: Vec3;
	shadow?: boolean;
	/** Only drawn for these hair styles. */
	styles?: readonly number[];
	/** Only drawn when this holds (tools and accessories). */
	when?: (looks: MemberLooks) => boolean;
}

export const fixed = (color: string) => () => color;
const bodyColor = (looks: MemberLooks) => looks.body;
const collarColor = (looks: MemberLooks) => looks.collar;
const skinColor = (looks: MemberLooks) => looks.skin;
const hairColor = (looks: MemberLooks) => looks.hair;
const irisColor = (looks: MemberLooks) => looks.iris;

/** Two of a part, mirrored left and right. */
export function pair(part: PartSpec): PartSpec[] {
	const [x, y, z] = part.position;
	const [rx, ry, rz] = part.rotation ?? [0, 0, 0];
	return [
		{ ...part, position: [-x, y, z], rotation: [rx, -ry, -rz] },
		{ ...part, position: [x, y, z], rotation: [rx, ry, rz] },
	];
}

/**
 * A soft, rounded lock of hair (a stretched sphere) from `root` to `tip` in
 * the rig's local space: `width` across at its fullest, `depth` thick.
 * Chunky and smooth like island hair, with rounded tips like anime bangs,
 * so a row of them reads as separate locks rather than paper cards.
 */
export function lock(
	root: Vec3,
	tip: Vec3,
	width: number,
	depth: number,
	styles?: readonly number[]
): PartSpec {
	const dx = tip[0] - root[0];
	const dy = tip[1] - root[1];
	const dz = tip[2] - root[2];
	const length = Math.hypot(dx, dy, dz);
	// Euler XYZ turning the sphere's +Y (toward the tip) onto the lock's
	// direction, which leaves its flattened Z facing out of the head.
	const roll = -Math.asin(dx / length);
	const pitch = Math.atan2(dz, dy);
	return {
		color: hairColor,
		geometry: "point",
		position: [root[0] + dx / 2, root[1] + dy / 2, root[2] + dz / 2],
		rotation: [pitch, 0, roll],
		scale: [width, length / 2, depth],
		styles,
	};
}

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

/** Where the right hand holds a tool, in the rig's local space. */
const HAND: Vec3 = [0.24, 0.21, 0.06];

function atHand(dx: number, dy: number, dz: number): Vec3 {
	return [HAND[0] + dx, HAND[1] + dy, HAND[2] + dz];
}

const GEAR = VILLAGER_GEAR;

/** One held tool's parts: each rides the right arm's swing. */
function toolParts(
	tool: VillagerTool,
	parts: Omit<PartSpec, "limb" | "when">[]
) {
	return parts.map<PartSpec>((part) => ({
		...part,
		limb: "right",
		when: (looks) => looks.tool === tool,
	}));
}

/**
 * Whether a frame whose villager anchors moved needs one more frame so
 * their plates catch up (drei places a plate before its anchor moves). Only
 * a still, reduced-motion canvas needs it: an animated stage keeps drawing,
 * and a strolling villager's anchor moves every frame, so asking then would
 * keep a paused demand canvas rendering forever.
 */
export function needsAnchorRedraw(
	moved: boolean,
	reducedMotion: boolean
): boolean {
	return moved && reducedMotion;
}

/**
 * Whether the scene needs another frame for its villagers: while any life
 * script still plays its one-off steps (a demand canvas would otherwise
 * stop a villager mid-walk), one more once they finish so the plates catch
 * up, and `needsAnchorRedraw`. A strolling (`walk`) villager is never busy,
 * so a paused demand canvas still goes idle.
 */
export function needsLifeFrame({
	busy,
	moved,
	reducedMotion,
	wasBusy,
}: {
	busy: number;
	moved: boolean;
	reducedMotion: boolean;
	wasBusy: boolean;
}): boolean {
	return busy > 0 || wasBusy || needsAnchorRedraw(moved, reducedMotion);
}

/** A monotonic clock over R3F's, which restarts at 0 on a frame-loop change. */
export interface LifeClock {
	/** The last time read (s). */
	last: number;
	/** Added to R3F's elapsed time (s): the time lost to its restarts. */
	offset: number;
}

/**
 * The life time (s) for R3F's `elapsed`: never earlier than the last read,
 * so a clock restart carries on from where it was instead of rewinding.
 * Reading the same elapsed time twice gives the same time.
 */
export function lifeClockAt(clock: LifeClock, elapsed: number): number {
	let time = elapsed + clock.offset;
	if (time < clock.last) {
		clock.offset += clock.last - time;
		time = clock.last;
	}
	clock.last = time;
	return time;
}

/** A work bubble ("Editing snapshot.ts"): plain-toned, not an ask, problem, limit or result. */
export function isWorkBubble(bubble: LifeBubble): boolean {
	return bubble.tone === undefined || bubble.tone === "plain";
}

/** The parts drawn for a villager holding `tool` (for tests and docs). */
export function toolPartsFor(tool: VillagerTool): readonly PartSpec[] {
	return TOOL_PARTS.filter((part) => part.when?.({ tool } as never));
}

/** Every tool a villager can hold, drawn only for the villagers holding it. */
const TOOL_PARTS: PartSpec[] = [
	...toolParts("hoe", [
		{
			color: fixed(GEAR.wood),
			geometry: "stick",
			position: atHand(0, 0.08, 0.06),
			rotation: [0.3, 0, 0],
			scale: [0.016, 0.62, 0.016],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(0, -0.2, 0.16),
			rotation: [0.3, 0, 0],
			scale: [0.12, 0.035, 0.1],
		},
	]),
	...toolParts("can", [
		{
			color: fixed(GEAR.tin),
			geometry: "disc",
			position: atHand(0.03, -0.07, 0.06),
			scale: [0.075, 0.13, 0.075],
			shadow: true,
		},
		{
			color: fixed(GEAR.tin),
			geometry: "stick",
			position: atHand(0.03, -0.04, 0.17),
			rotation: [1.0, 0, 0],
			scale: [0.012, 0.16, 0.012],
		},
		{
			color: fixed(GEAR.tin),
			geometry: "ring",
			position: atHand(0.03, 0.01, 0.04),
			rotation: [0, Math.PI / 2, 0],
			scale: [0.045, 0.045, 0.045],
		},
	]),
	...toolParts("basket", [
		{
			color: fixed(GEAR.wicker),
			geometry: "disc",
			position: atHand(0.02, -0.08, 0.08),
			scale: [0.11, 0.08, 0.1],
			shadow: true,
		},
		...[-1, 0, 1].map((index) => ({
			color: fixed(GEAR.produce[index + 1] ?? GEAR.produce[0]),
			geometry: "ball" as const,
			position: atHand(0.02 + index * 0.05, -0.02, 0.08 + (index % 2) * 0.03),
			scale: [0.04, 0.04, 0.04] as Vec3,
		})),
	]),
	...toolParts("pan", [
		{
			color: fixed(GEAR.pan),
			geometry: "disc",
			position: atHand(0, 0.02, 0.24),
			scale: [0.12, 0.025, 0.12],
			shadow: true,
		},
		{
			color: fixed(GEAR.pan),
			geometry: "stick",
			position: atHand(0, 0.02, 0.06),
			rotation: [Math.PI / 2, 0, 0],
			scale: [0.014, 0.16, 0.014],
		},
	]),
	...toolParts("ladle", [
		{
			color: fixed(GEAR.metal),
			geometry: "stick",
			position: atHand(0, 0.1, 0.05),
			scale: [0.012, 0.32, 0.012],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "dome",
			position: atHand(0, -0.06, 0.05),
			rotation: [Math.PI, 0, 0],
			scale: [0.06, 0.05, 0.06],
		},
	]),
	...toolParts("knife", [
		{
			color: fixed(GEAR.wood),
			geometry: "box",
			position: atHand(0, 0, 0.04),
			scale: [0.03, 0.08, 0.03],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(0, 0.12, 0.04),
			scale: [0.012, 0.17, 0.045],
		},
	]),
	...toolParts("hammer", [
		{
			color: fixed(GEAR.wood),
			geometry: "stick",
			position: atHand(0, 0.08, 0.04),
			scale: [0.016, 0.3, 0.016],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(0, 0.23, 0.04),
			scale: [0.12, 0.05, 0.05],
		},
	]),
	...toolParts("book", [
		{
			color: fixed(GEAR.wood),
			geometry: "box",
			position: atHand(-0.04, 0.04, 0.12),
			rotation: [-0.5, 0, 0],
			scale: [0.17, 0.21, 0.025],
		},
		{
			color: fixed(GEAR.paper),
			geometry: "box",
			position: atHand(-0.04, 0.045, 0.137),
			rotation: [-0.5, 0, 0],
			scale: [0.14, 0.17, 0.01],
		},
	]),
	// An account book held open-ish: a dark cover, cream pages, a metal clasp.
	...toolParts("ledger", [
		{
			color: fixed(GEAR.pan),
			geometry: "box",
			position: atHand(-0.04, 0.04, 0.12),
			rotation: [-0.5, 0, 0],
			scale: [0.18, 0.24, 0.035],
		},
		{
			color: fixed(GEAR.paper),
			geometry: "box",
			position: atHand(-0.04, 0.045, 0.141),
			rotation: [-0.5, 0, 0],
			scale: [0.15, 0.2, 0.012],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(0.05, 0.04, 0.125),
			rotation: [-0.5, 0, 0],
			scale: [0.02, 0.07, 0.04],
		},
	]),
	// A hand balance: a post, a beam, a pan hanging at each end.
	...toolParts("scale", [
		{
			color: fixed(GEAR.wood),
			geometry: "stick",
			position: atHand(0, 0.1, 0.05),
			scale: [0.014, 0.26, 0.014],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(0, 0.23, 0.05),
			scale: [0.26, 0.016, 0.016],
		},
		...[-1, 1].map((side) => ({
			color: fixed(GEAR.tin),
			geometry: "disc" as const,
			position: atHand(side * 0.12, 0.15, 0.05),
			scale: [0.06, 0.015, 0.06] as Vec3,
		})),
	]),
	...toolParts("broom", [
		{
			color: fixed(GEAR.wood),
			geometry: "stick",
			position: atHand(0, 0.08, 0.06),
			rotation: [0.2, 0, 0],
			scale: [0.014, 0.72, 0.014],
		},
		{
			color: fixed(GEAR.bristle),
			geometry: "cone",
			position: atHand(0, -0.3, -0.02),
			rotation: [0.2, 0, 0],
			scale: [0.08, 0.18, 0.08],
		},
	]),
	...toolParts("quill", [
		{
			color: fixed(GEAR.paper),
			geometry: "point",
			position: atHand(0, 0.14, 0.05),
			rotation: [0.25, 0, -0.2],
			scale: [0.045, 0.16, 0.012],
		},
		{
			color: fixed(GEAR.pan),
			geometry: "stick",
			position: atHand(0, -0.02, 0.03),
			rotation: [0.25, 0, -0.2],
			scale: [0.008, 0.07, 0.008],
		},
	]),
	...toolParts("lens", [
		{
			color: fixed(GEAR.wood),
			geometry: "stick",
			position: atHand(0, 0.02, 0.06),
			scale: [0.014, 0.12, 0.014],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "ring",
			position: atHand(0, 0.15, 0.06),
			scale: [0.07, 0.07, 0.07],
		},
		{
			color: fixed(GEAR.tin),
			geometry: "disc",
			position: atHand(0, 0.15, 0.06),
			rotation: [Math.PI / 2, 0, 0],
			scale: [0.06, 0.006, 0.06],
		},
	]),
	...toolParts("clipboard", [
		{
			color: fixed(GEAR.wood),
			geometry: "box",
			position: atHand(-0.04, 0.04, 0.12),
			rotation: [-0.5, 0, 0],
			scale: [0.16, 0.22, 0.015],
		},
		{
			color: fixed(GEAR.paper),
			geometry: "box",
			position: atHand(-0.04, 0.03, 0.13),
			rotation: [-0.5, 0, 0],
			scale: [0.13, 0.16, 0.008],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "box",
			position: atHand(-0.04, 0.14, 0.085),
			rotation: [-0.5, 0, 0],
			scale: [0.06, 0.025, 0.02],
		},
	]),
	...toolParts("wrench", [
		{
			color: fixed(GEAR.metal),
			geometry: "stick",
			position: atHand(0, 0.07, 0.05),
			scale: [0.016, 0.24, 0.016],
		},
		{
			color: fixed(GEAR.metal),
			geometry: "ring",
			position: atHand(0, 0.2, 0.05),
			scale: [0.05, 0.05, 0.05],
		},
	]),
	...toolParts("globe", [
		{
			color: fixed(GEAR.tin),
			geometry: "ball",
			position: atHand(0, 0.08, 0.12),
			scale: [0.1, 0.1, 0.1],
			shadow: true,
		},
		{
			color: fixed(GEAR.produce[2] ?? GEAR.wood),
			geometry: "dome",
			position: atHand(0.02, 0.12, 0.17),
			rotation: [0.8, 0.4, 0],
			scale: [0.05, 0.03, 0.05],
		},
		{
			color: fixed(GEAR.wood),
			geometry: "disc",
			position: atHand(0, -0.04, 0.12),
			scale: [0.06, 0.02, 0.06],
		},
	]),
];

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
const ACCESSORY_PARTS: PartSpec[] = [
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

/** Parts drawn with an ink outline, and how thick. */
const INKED: Partial<Record<PartGeometry, number>> = {
	ahoge: LOCK_INK,
	arm: CHARACTER_INK,
	body: CHARACTER_INK,
	bun: CHARACTER_INK,
	hair: CHARACTER_INK,
	head: CHARACTER_INK,
	lock: CHARACTER_INK,
	mane: CHARACTER_INK,
	point: LOCK_INK,
	shoe: CHARACTER_INK,
	ball: LOCK_INK,
	box: LOCK_INK,
	cone: LOCK_INK,
	disc: LOCK_INK,
	dome: CHARACTER_INK,
};

/** Rim light per part (lit by the toon ramp); the rest have none. */
const RIM_OF: Partial<Record<PartGeometry, number>> = {
	arm: CHARACTER_RIM,
	body: CHARACTER_RIM,
	bun: HEAD_RIM,
	hair: HEAD_RIM,
	head: HEAD_RIM,
	lock: HEAD_RIM,
	mane: HEAD_RIM,
	point: HEAD_RIM,
	dome: HEAD_RIM,
};

/** Hair parts with the anime sheen band. */
const SHEENED: ReadonlySet<PartGeometry> = new Set(["hair", "mane", "bun"]);

const PART_GEOMETRIES: readonly PartGeometry[] = [
	"ahoge",
	"arm",
	"body",
	"bun",
	"cheek",
	"collar",
	"eye",
	"hair",
	"head",
	"iris",
	"lash",
	"lock",
	"mane",
	"mouth",
	"point",
	"shine",
	"shoe",
	"ball",
	"box",
	"cone",
	"disc",
	"dome",
	"ring",
	"stick",
];

export function shortestAngle(from: number, to: number): number {
	const turn = to - from;
	return Math.atan2(Math.sin(turn), Math.cos(turn));
}

/** The shared mesh for one body part, in the rig's local units. */
export function PartShape({ kind }: { kind: PartGeometry }) {
	switch (kind) {
		case "ahoge":
			return <torusGeometry args={[0.075, 0.02, 6, 14, Math.PI * 1.3]} />;
		case "arm":
			return <capsuleGeometry args={[0.05, 0.13, 4, 10]} />;
		case "body":
			return <capsuleGeometry args={[0.165, 0.12, 6, 16]} />;
		case "bun":
			return <sphereGeometry args={[0.135, 18, 14]} />;
		case "cheek":
			return <sphereGeometry args={[0.05, 12, 8]} />;
		case "collar":
			return <torusGeometry args={[0.12, 0.035, 8, 20]} />;
		case "eye":
			return <sphereGeometry args={[EYE_RADIUS, 18, 14]} />;
		case "hair":
			return (
				<sphereGeometry
					args={[
						HEAD_RADIUS + 0.025,
						24,
						14,
						0,
						Math.PI * 2,
						0,
						Math.PI * 0.56,
					]}
				/>
			);
		case "head":
			return <sphereGeometry args={[HEAD_RADIUS, 22, 16]} />;
		case "iris":
			return <sphereGeometry args={[EYE_RADIUS * 0.76, 16, 12]} />;
		case "lash":
			return <torusGeometry args={[EYE_RADIUS, 0.017, 6, 18, LASH_ARC]} />;
		case "lock":
			return <capsuleGeometry args={[0.055, 0.18, 4, 10]} />;
		case "mane":
			return <sphereGeometry args={[HEAD_RADIUS + 0.02, 18, 12]} />;
		case "mouth":
			return <sphereGeometry args={[0.018, 10, 6]} />;
		case "shine":
			return <sphereGeometry args={[0.02, 8, 6]} />;
		case "point":
			return <sphereGeometry args={[1, 14, 10]} />;
		case "ball":
			return <sphereGeometry args={[1, 16, 12]} />;
		case "box":
			return <boxGeometry args={[1, 1, 1]} />;
		case "cone":
			return <coneGeometry args={[1, 1, 14]} />;
		case "disc":
			return <cylinderGeometry args={[1, 1, 1, 24]} />;
		case "dome":
			return (
				<sphereGeometry args={[1, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
			);
		case "ring":
			return <torusGeometry args={[1, 0.18, 8, 24]} />;
		case "stick":
			return <cylinderGeometry args={[1, 1, 1, 8]} />;
		default:
			return <sphereGeometry args={[0.075, 14, 10]} />;
	}
}

export interface PartGroup {
	ink: number;
	kind: PartGeometry;
	parts: PartSpec[];
	shadow: boolean;
}

export const PART_GROUPS: readonly PartGroup[] = PART_GEOMETRIES.map((kind) => {
	const parts = [...AGENT_PARTS, ...TOOL_PARTS, ...ACCESSORY_PARTS].filter(
		(part) => part.geometry === kind
	);
	return {
		ink: INKED[kind] ?? 0,
		kind,
		parts,
		shadow: parts.some((part) => part.shadow),
	};
}).filter((group) => group.parts.length > 0);

/** Each part's transform relative to the character's feet. */
export function localMatrices(
	mesh: InstancedMesh,
	group: PartGroup
): Matrix4[] {
	const { euler, matrix, position, quaternion, scale } = mathKit(mesh);
	return group.parts.map((part) => {
		position.set(...part.position);
		quaternion.setFromEuler(euler.set(...(part.rotation ?? [0, 0, 0])));
		scale.set(...(part.scale ?? [1, 1, 1]));
		return matrix.clone().compose(position, quaternion, scale);
	});
}

export function PartMaterial({ kind }: { kind: PartGeometry }) {
	if (kind === "shine") {
		return <CurvedBasicMaterial color={SHINE} toneMapped={false} />;
	}
	if (kind === "eye" || kind === "lash" || kind === "mouth") {
		return <CurvedBasicMaterial />;
	}
	if (kind === "iris") {
		return <ToonMaterial emissive={ART_WHITE} emissiveIntensity={0.12} />;
	}
	if (kind === "cheek") {
		return <ToonMaterial opacity={0.75} transparent />;
	}
	if (kind === "head") {
		return <ToonMaterial face rim={RIM_OF.head ?? 0} />;
	}
	return (
		<ToonMaterial
			rim={RIM_OF[kind] ?? 0}
			sheen={SHEENED.has(kind) ? HAIR_SHEEN : 0}
		/>
	);
}

/** Whether a member draws a part: its hair style, tool and accessory. */
function partShown(part: PartSpec, looks: MemberLooks): boolean {
	if (part.styles && !part.styles.includes(looks.hairStyle)) {
		return false;
	}
	return part.when ? part.when(looks) : true;
}

/** Which arm a part moves with, if any. */
function limbOf(part: PartSpec): "left" | "right" | null {
	if (part.limb) {
		return part.limb;
	}
	if (part.geometry === "arm") {
		return part.position[0] < 0 ? "left" : "right";
	}
	return null;
}

/** A villager's pose for one frame, written by `VillagerRig`'s caller. */
export interface RigPose {
	/** Forward swing of each arm about the shoulder (negative lifts it). */
	armLeft: number;
	armRight: number;
	/** Both hands hold a carried item: the held tool is put away. */
	holding?: boolean;
	/** Where the feet stand. */
	position: Vector3;
	/** Lean (x), facing (y) and sway (z). */
	rotation: Euler;
	scale: Vector3;
}

export interface RigFrame {
	camera: Camera;
	delta: number;
	time: number;
}

/** The shoulder the arms swing about, in the rig's local space. */
const SHOULDER_X = 0.15;
const SHOULDER_Y = BODY_Y + 0.1;

interface RigScratch {
	arms: Matrix4[][];
	holding: boolean[];
	pivot: Matrix4;
	pose: RigPose;
	roots: Matrix4[];
	swing: Matrix4;
}

/**
 * Every villager as instanced body parts. Each frame `pose` writes each
 * villager's root transform and arm swings; every part's local transform
 * is composed on top. Only the part groups some villager shows are drawn.
 */
export function VillagerRig({
	members,
	onHover,
	onPick,
	pose,
}: {
	members: readonly MemberLooks[];
	onHover?: (index: number | null) => void;
	onPick?: (index: number) => void;
	pose: (index: number, out: RigPose, frame: RigFrame) => void;
}) {
	const groups = useMemo(
		() =>
			PART_GROUPS.filter((group) =>
				members.some((looks) =>
					group.parts.some((part) => partShown(part, looks))
				)
			),
		[members]
	);
	const shown = useMemo(
		() =>
			groups.map((group) =>
				members.flatMap((looks) =>
					group.parts.map((part) => partShown(part, looks))
				)
			),
		[groups, members]
	);
	const meshes = useRef<(InstancedMesh | null)[]>([]);
	const hulls = useRef<(InstancedMesh | null)[]>([]);
	const locals = useRef<Matrix4[][]>([]);
	const scratch = useRef<RigScratch | null>(null);

	// Colors only change when the cast changes; outlines share each part's
	// transforms and colors.
	useLayoutEffect(() => {
		locals.current = [];
		const cleanups: (() => void)[] = [];
		for (const [index, group] of groups.entries()) {
			const mesh = meshes.current[index];
			const color = mesh ? mathKit(mesh).color : null;
			if (!(mesh && color)) {
				continue;
			}
			let slot = 0;
			for (const looks of members) {
				for (const part of group.parts) {
					mesh.setColorAt(slot, color.set(part.color(looks)));
					slot += 1;
				}
			}
			if (mesh.instanceColor) {
				mesh.instanceColor.needsUpdate = true;
			}
			const hull = hulls.current[index];
			if (hull) {
				cleanups.push(shareHull(mesh, hull));
			}
		}
		return () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		};
	}, [groups, members]);

	useFrame(({ camera, clock }, delta) => {
		const first = meshes.current.find(Boolean);
		if (!first) {
			return;
		}
		const kit = mathKit(first);
		scratch.current ??= {
			arms: [],
			holding: [],
			pivot: first.matrix.clone(),
			pose: {
				armLeft: 0,
				armRight: 0,
				position: kit.position.clone(),
				rotation: kit.euler.clone(),
				scale: kit.scale.clone(),
			},
			roots: [],
			swing: first.matrix.clone(),
		};
		const { arms, holding, pivot, pose: out, roots, swing } = scratch.current;
		const frame: RigFrame = { camera, delta, time: clock.elapsedTime };
		for (let index = 0; index < members.length; index++) {
			out.position.set(0, 0, 0);
			out.rotation.set(0, 0, 0);
			out.scale.set(1, 1, 1);
			out.armLeft = 0;
			out.armRight = 0;
			out.holding = false;
			pose(index, out, frame);
			holding[index] = out.holding;
			kit.quaternion.setFromEuler(out.rotation);
			const root = roots[index] ?? first.matrix.clone();
			roots[index] = root.compose(out.position, kit.quaternion, out.scale);
			const pair = arms[index] ?? [first.matrix.clone(), first.matrix.clone()];
			arms[index] = pair;
			for (const [side, angle] of [out.armLeft, out.armRight].entries()) {
				const limb = pair[side];
				if (!limb) {
					continue;
				}
				limb.copy(root);
				if (angle === 0) {
					continue;
				}
				const x = side === 0 ? -SHOULDER_X : SHOULDER_X;
				limb.multiply(pivot.makeTranslation(x, SHOULDER_Y, 0));
				limb.multiply(swing.makeRotationX(angle));
				limb.multiply(pivot.makeTranslation(-x, -SHOULDER_Y, 0));
			}
		}
		for (const [index, group] of groups.entries()) {
			const mesh = meshes.current[index];
			if (!mesh) {
				continue;
			}
			const parts = locals.current[index] ?? localMatrices(mesh, group);
			locals.current[index] = parts;
			const visible = shown[index] ?? [];
			const { matrix } = mathKit(mesh);
			let slot = 0;
			for (let member = 0; member < members.length; member++) {
				const root = roots[member];
				for (const [part, local] of parts.entries()) {
					const spec = group.parts[part];
					const limb = spec ? limbOf(spec) : null;
					let base = root;
					if (limb) {
						base = arms[member]?.[limb === "left" ? 0 : 1] ?? root;
					}
					// A held tool is put away while both hands carry something.
					const stowed =
						holding[member] === true && spec?.limb === "right" && spec.when;
					if (base && visible[slot] && !stowed) {
						matrix.multiplyMatrices(base, local);
					} else {
						matrix.makeScale(0, 0, 0);
					}
					mesh.setMatrixAt(slot, matrix);
					slot += 1;
				}
			}
			mesh.instanceMatrix.needsUpdate = true;
			mesh.computeBoundingSphere();
		}
	});

	if (members.length === 0) {
		return null;
	}
	const memberAt = (group: PartGroup, instanceId: number | undefined) =>
		Math.floor((instanceId ?? 0) / group.parts.length);
	return (
		<group>
			{groups.map((group, index) => {
				const count = members.length * group.parts.length;
				return (
					<group key={`${group.kind}:${members.length}`}>
						<instancedMesh
							args={[undefined, undefined, count]}
							castShadow={group.shadow}
							onClick={
								onPick
									? (event) => {
											event.stopPropagation();
											onPick(memberAt(group, event.instanceId));
										}
									: undefined
							}
							onPointerOut={onHover ? () => onHover(null) : undefined}
							onPointerOver={
								onHover
									? (event) => {
											event.stopPropagation();
											onHover(memberAt(group, event.instanceId));
										}
									: undefined
							}
							ref={(mesh) => {
								meshes.current[index] = mesh;
							}}
						>
							<PartShape kind={group.kind} />
							<PartMaterial kind={group.kind} />
						</instancedMesh>
						{group.ink > 0 ? (
							<instancedMesh
								args={[undefined, undefined, count]}
								ref={(mesh) => {
									hulls.current[index] = mesh;
								}}
							>
								<InkMaterial width={group.ink} />
							</instancedMesh>
						) : (
							<FreeHullSlot index={index} slots={hulls} />
						)}
					</group>
				);
			})}
		</group>
	);
}

/** Clears a group's hull slot when that group draws no outline. */
function FreeHullSlot({
	index,
	slots,
}: {
	index: number;
	slots: { current: (InstancedMesh | null)[] };
}) {
	useLayoutEffect(() => {
		slots.current[index] = null;
	}, [index, slots]);
	return null;
}

/** Accessories agents pick from by default (games may dress them). */
const EVERYDAY_ACCESSORIES: readonly VillagerAccessory[] = [
	"cap",
	"bow",
	"flower",
	"beanie",
	"bandana",
	"none",
];

function idHash(id: string): number {
	let hash = 7;
	for (const character of id) {
		hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 1_000_003;
	}
	return hash;
}

/** An agent's everyday head accessory, stable per agent. */
export function accessoryFor(agentId: string): VillagerAccessory {
	return (
		EVERYDAY_ACCESSORIES[idHash(agentId) % EVERYDAY_ACCESSORIES.length] ??
		"none"
	);
}

/** One agent's villager looks: outfit from its swatch, hair, accessory. */
export function villagerLooksFor(
	agentId: string,
	swatch: AgentSwatch,
	dress?: Partial<MemberLooks>
): MemberLooks {
	return {
		...villagerLooks(agentId, swatch),
		accent: accentFor(swatch),
		accessory: accessoryFor(agentId),
		...dress,
	};
}

/**
 * Every agent's villager looks, keyed by agent id, with distinct outfit
 * colors (see `agentSwatches`). `dress` lets a game put everyone in its
 * uniform (a chef's hat) or hand out tools.
 */
export function useVillagerLooks(
	agentIds: readonly string[],
	night: boolean,
	dress?: (agentId: string) => Partial<MemberLooks> | undefined
): {
	looks: ReadonlyMap<string, MemberLooks>;
	swatches: ReadonlyMap<string, AgentSwatch>;
} {
	const key = agentIds.join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the ids' contents, not the array's identity.
	return useMemo(() => {
		const ids = key ? key.split("\n") : [];
		const swatches = agentSwatches(ids, night);
		const looks = new Map<string, MemberLooks>();
		for (const id of ids) {
			looks.set(id, villagerLooksFor(id, swatchOf(swatches, id), dress?.(id)));
		}
		return { looks, swatches };
	}, [dress, key, night]);
}

/** One villager on stage. */
export interface VillagerSpec {
	/**
	 * The agent this plate is the per-agent target of (`data-act-agent`,
	 * for the act layer's browser checks).
	 */
	actAgent?: string;
	/**
	 * What activating the plate does instead of `onSelect` (an asking
	 * agent's plate opens its ask card). When set the plate is always
	 * focusable, does not touch the game's selection, and has no
	 * `aria-pressed`.
	 */
	activate?: () => void;
	/**
	 * False hides the life script's bubble on the plate (the overlay budget
	 * dropped it) without touching the script.
	 */
	bubble?: boolean;
	/** Where its bubble hangs (default "auto": clear of the neighbours). */
	bubbleSide?: LifeBubbleSide;
	/** Yaw in radians; by default the villager faces the isometric camera. */
	facing?: number;
	/**
	 * A walking body this villager keeps up with (an agent's own body, for its
	 * helpers): every frame the villager's position, plate and life script
	 * are offset by the body's ground x and z, so `position` and the script's
	 * places are relative to it. Default: none (world positions).
	 */
	follow?: () => { x: number; z: number } | undefined;
	/**
	 * Overrides `Villagers iconOnly` for this plate: false keeps a queue
	 * plate's words ("Ada · 14m") on narrow stages.
	 */
	iconOnly?: boolean;
	id: string;
	/** The name plate's accessible name ("Ada, needs you"). */
	label: string;
	/**
	 * A choreography to act out (game3d-life.ts). When set it drives the
	 * villager instead of `pose` and `walk`: a new `key` plays the new
	 * steps from wherever the villager is, then its `idle` loop runs.
	 */
	life?: LifeScript;
	looks: MemberLooks;
	name: string;
	/** False: no name plate (apprentices, background extras). */
	plate?: false;
	pose: VillagerPose;
	/** Where its feet stand (the start of `walk` when it strolls). */
	position: Vec3;
	/** Size against an ordinary villager (1); a game's mascot may stand taller. */
	scale?: number;
	/** A looped path to stroll along, in world points. */
	walk?: readonly Vec3[];
	/** This plate is a you-spot queue plate (`data-you-spot="slot"`). */
	youSpot?: "slot";
}

/** Facing the isometric camera (which looks from +x, +z). */
export const FACE_CAMERA = Math.PI / 4;
/** Name plates float this high over the feet, in world units. */
const PLATE_HEIGHT = 1.62;
/** A villager's head top above its feet (world units, at scale 1). */
const FIGURE_HEIGHT = 1.35;

/**
 * Two zero-size, hidden markers at a villager's head and feet
 * (`data-act-figure`, `data-figure-edge`), riding its plate anchor: where
 * the figure is on screen, for checks that nothing covers it.
 */
function FigureProbes({ id, scale }: { id: string; scale: number }) {
	const marker = (edge: "feet" | "head") => (
		<span
			aria-hidden="true"
			className="pointer-events-none block size-0"
			data-act-figure={id}
			data-figure-edge={edge}
		/>
	);
	return (
		<>
			<Html position={[0, (FIGURE_HEIGHT - PLATE_HEIGHT) * scale, 0]}>
				{marker("head")}
			</Html>
			<Html position={[0, -PLATE_HEIGHT * scale, 0]}>{marker("feet")}</Html>
		</>
	);
}
const WALK_SPEED = 0.85;
const IDLE_BOB = 2.6;

/** How far along a looped path `distance` is, and which way it heads. */
function alongPath(
	path: readonly Vec3[],
	distance: number,
	out: Vector3
): number {
	let total = 0;
	for (let index = 0; index < path.length; index++) {
		const from = path[index] as Vec3;
		const to = path[(index + 1) % path.length] as Vec3;
		total += Math.hypot(to[0] - from[0], to[2] - from[2]);
	}
	let left = total > 0 ? distance % total : 0;
	for (let index = 0; index < path.length; index++) {
		const from = path[index] as Vec3;
		const to = path[(index + 1) % path.length] as Vec3;
		const length = Math.hypot(to[0] - from[0], to[2] - from[2]);
		if (left <= length || index === path.length - 1) {
			const t = length > 0 ? left / length : 0;
			out.set(
				from[0] + (to[0] - from[0]) * t,
				from[1] + (to[1] - from[1]) * t,
				from[2] + (to[2] - from[2]) * t
			);
			return Math.atan2(to[0] - from[0], to[2] - from[2]);
		}
		left -= length;
	}
	out.set(...(path[0] ?? [0, 0, 0]));
	return FACE_CAMERA;
}

/** Writes one villager's pose for its state at `time`. */
function poseVillager(
	spec: VillagerSpec,
	index: number,
	out: RigPose,
	time: number,
	still: boolean
) {
	const phase = index * 1.7;
	let yaw = spec.facing ?? FACE_CAMERA;
	out.position.set(...spec.position);
	if (spec.walk && spec.walk.length > 1) {
		const distance = still ? 0 : time * WALK_SPEED + phase * 3;
		yaw = alongPath(spec.walk, distance, out.position);
		if (!still) {
			// A hop per step, arms swinging opposite.
			out.position.y += Math.abs(Math.sin(time * 7 + phase)) * 0.05;
			out.armLeft = Math.sin(time * 7 + phase) * 0.5;
			out.armRight = -out.armLeft;
		}
		out.rotation.set(0, yaw, 0);
		return;
	}
	if (still) {
		out.rotation.set(spec.pose === "failed" ? 0.22 : 0, yaw, 0);
		if (spec.pose === "failed") {
			out.scale.set(1.04, 0.9, 1.04);
		}
		if (spec.pose === "needs-you") {
			out.armRight = -2.5;
		}
		return;
	}
	let speed = IDLE_BOB;
	let lift = 0.045;
	let sway = Math.sin(time * 1.3 + phase) * 0.04;
	let lean = 0;
	switch (spec.pose) {
		case "working":
			speed = IDLE_BOB * 1.6;
			// A steady chop or stir with the tool hand.
			out.armRight = -0.35 + Math.sin(time * 6 + phase) * 0.55;
			out.armLeft = Math.sin(time * 3 + phase) * 0.12;
			break;
		case "needs-you": {
			// Hops on the spot, waving.
			const hop = Math.max(0, Math.sin(time * 5 + phase));
			lift = 0.16 * hop * hop;
			out.armRight = -2.5 + Math.sin(time * 10 + phase) * 0.35;
			break;
		}
		case "failed":
			// Slumped and still, head hung.
			speed = 0.9;
			lift = 0.01;
			sway = 0;
			lean = 0.22;
			out.scale.set(1.04, 0.9, 1.04);
			break;
		case "waiting":
			speed = IDLE_BOB * 0.6;
			yaw += Math.sin(time * 0.7 + phase) * 0.6;
			break;
		default:
			break;
	}
	const wave = Math.sin(time * speed + phase);
	out.position.y += Math.max(0, wave) * lift;
	out.rotation.set(lean, yaw, sway);
	const stretch = 1 + wave * 0.035;
	const squash = 1 / Math.sqrt(stretch);
	out.scale.set(
		out.scale.x * squash,
		out.scale.y * stretch,
		out.scale.z * squash
	);
}

const POSE_BADGE: Record<
	VillagerPose,
	{ className: string; mark: string } | null
> = {
	failed: { className: "bg-(--gk-bad) text-white", mark: "×" },
	idle: null,
	"needs-you": {
		className: "bg-(--gk-gold) text-(--gk-edge) motion-safe:animate-pulse",
		mark: "!",
	},
	waiting: { className: "bg-(--gk-plate) text-(--gk-ink-muted)", mark: "…" },
	working: { className: "bg-(--gk-info) text-white", mark: "•••" },
};

/** The plate's accessible name: a scripted villager's label already says it all. */
export function villagerPlateLabel(
	spec: Pick<VillagerSpec, "label" | "life">,
	bubble: LifeBubble | null | undefined
): string {
	const words = bubble ? bubbleWords(bubble) : "";
	return words && !spec.life ? `${spec.label}, says ${words}` : spec.label;
}

/** The first character of a name (whole, even an emoji). */
export function initialOf(name: string): string {
	return Array.from(name)[0] ?? "";
}

/**
 * A villager's name plate: the kit's HUD plate, billboarded over its head,
 * and the villager's control (click, Enter, focus ring). A badge sits on
 * the plate's top edge, always in the same place: a pulsing "!" when it
 * needs you, a red mark when it failed, dots while it works.
 *
 * With `spec.activate` it calls that and leaves the selection alone (no
 * `aria-pressed`); otherwise it selects through `onSelect`. `iconOnly` (narrow stages) shows the initial in a 28px
 * target and keeps the full accessible name.
 */
export function VillagerPlate({
	bubble,
	iconOnly = false,
	onSelect,
	selected,
	spec,
}: {
	bubble?: LifeBubble | null;
	iconOnly?: boolean;
	onSelect?: (id: string) => void;
	selected: boolean;
	spec: VillagerSpec;
}) {
	const badge = POSE_BADGE[spec.pose];
	const { activate } = spec;
	const actionable = Boolean(activate ?? onSelect);
	// A game's "work bubbles off" setting hides plain work bubbles; asks,
	// problems, limits and results still show (the plate's name keeps them all).
	const { workBubbles } = useGameKitSettings();
	const shownBubble =
		bubble && (workBubbles || !isWorkBubble(bubble)) ? bubble : null;
	return (
		<Html center zIndexRange={[40, 0]}>
			<button
				aria-label={villagerPlateLabel(spec, bubble)}
				aria-pressed={!activate && onSelect ? selected : undefined}
				className={cn(
					GAME_PLATE,
					GAME_FOCUS,
					"gk-display relative flex h-7 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-full text-[13px] leading-none",
					iconOnly ? "min-w-7" : "px-2.5",
					selected && !activate && "bg-(--gk-accent) text-(--gk-accent-ink)"
				)}
				data-act-agent={spec.actAgent}
				data-icon-only={iconOnly ? "" : undefined}
				data-iso-focus={spec.id}
				data-iso-target=""
				data-you-spot={spec.youSpot}
				onClick={() => (activate ? activate() : onSelect?.(spec.id))}
				tabIndex={actionable ? 0 : -1}
				type="button"
			>
				{badge ? (
					<span
						aria-hidden="true"
						className={cn(
							"absolute -top-5 left-1/2 grid h-6 min-w-6 -translate-x-1/2 place-items-center rounded-full border-(--gk-edge) border-2 px-1 font-bold text-[13px] leading-none",
							badge.className
						)}
					>
						{badge.mark}
					</span>
				) : null}
				{shownBubble ? (
					<LifeBubbleTag bubble={shownBubble} side={spec.bubbleSide} />
				) : null}
				<span className={iconOnly ? undefined : "max-w-28 truncate"}>
					{iconOnly ? initialOf(spec.name) : spec.name}
				</span>
			</button>
		</Html>
	);
}

/** What a scripted villager shows outside the rig: bubble and held item. */
interface LifeShown {
	bubble: LifeBubble | null;
	item: LifeItem | null;
}

const NO_SHOWN: ReadonlyMap<string, LifeShown> = new Map();

/** Where a scripted villager starts when it first appears. */
function lifeStart(spec: VillagerSpec): LifeState {
	return {
		action: "idle",
		bubble: null,
		item: null,
		position: spec.position,
		yaw: spec.facing ?? FACE_CAMERA,
	};
}

/**
 * The villagers of a game, posed by state, with their name plates. A
 * selected villager wears a pressed plate and a ring on the ground.
 *
 * A villager whose spec has a `life` script acts it out (walking `paths`,
 * the game's waypoints): villagers on stage at the first frame start
 * settled at their script's end, so a scene opens calm; later key changes
 * and newcomers play their steps. Under reduced motion every script snaps
 * to its settled end.
 */
export function Villagers({
	iconOnly = false,
	onHover,
	onSelect,
	paths,
	plates = true,
	reducedMotion,
	selectedId = null,
	villagers,
}: {
	/** Narrow stages: plates show the initial only (names stay accessible). */
	iconOnly?: boolean;
	onHover?: (id: string | null) => void;
	onSelect?: (id: string) => void;
	/** Waypoints scripted villagers walk along (straight lines without). */
	paths?: LifePaths;
	plates?: boolean;
	reducedMotion: boolean;
	selectedId?: string | null;
	villagers: readonly VillagerSpec[];
}) {
	const members = useMemo(
		() => villagers.map((villager) => villager.looks),
		[villagers]
	);
	const anchors = useRef<(Group | null)[]>([]);
	const lives = useRef(new Map<string, LifeRuntime>());
	const byIndex = useRef<(LifeRuntime | null)[]>([]);
	const seeded = useRef(false);
	// A plate's Html places itself before this moves its anchor in a frame,
	// so a moved anchor needs one more frame (a demand canvas draws none).
	const anchorsMoved = useRef(false);
	const wasBusy = useRef(false);
	// Life scripts run on a clock that never goes back: R3F restarts its
	// clock at 0 whenever the frame loop changes (a paused stage, one
	// scrolled off), which would rewind every script to its start.
	const clockBase = useRef<LifeClock>({ last: 0, offset: 0 });
	const dirty = useRef(false);
	const [shown, setShown] = useState(NO_SHOWN);
	const invalidate = useThree((state) => state.invalidate);
	const canvas = useThree((state) => state.gl.domElement);
	const lifeKeys = villagers
		.map((villager) =>
			villager.life ? `${villager.id}:${villager.life.key}` : ""
		)
		.join("\n");
	// A script change must draw even when the frame loop runs on demand.
	// biome-ignore lint/correctness/useExhaustiveDependencies: redraw whenever any script key changes.
	useEffect(() => {
		invalidate();
	}, [invalidate, lifeKeys, shown]);

	const publish = () => {
		if (dirty.current) {
			return;
		}
		dirty.current = true;
		queueMicrotask(() => {
			dirty.current = false;
			const next = new Map<string, LifeShown>();
			for (const [id, runtime] of lives.current) {
				next.set(id, runtime.shown);
			}
			setShown(next);
		});
	};

	const live = (spec: VillagerSpec, script: LifeScript, time: number) => {
		let runtime = lives.current.get(spec.id);
		if (!runtime || runtime.key !== script.key) {
			const start = runtime
				? lifeStateAt(runtime.timeline, time - runtime.startedAt, reducedMotion)
				: lifeStart(spec);
			const timeline = compileLife(start, script, paths);
			const settle = !(runtime || seeded.current);
			const startedAt = settle ? time - timeline.settled : time;
			if (runtime) {
				runtime.key = script.key;
				runtime.timeline = timeline;
				runtime.startedAt = startedAt;
			} else {
				runtime = {
					body: { scale: 1, x: 0, y: 0, yaw: 0, z: 0 },
					frame: emptyLifeFrame(),
					key: script.key,
					shown: { bubble: null, item: null },
					startedAt,
					timeline,
				};
				lives.current.set(spec.id, runtime);
			}
		}
		sampleLife(
			runtime.timeline,
			time - runtime.startedAt,
			runtime.frame,
			reducedMotion
		);
		const { bubble, item } = runtime.frame;
		if (bubble !== runtime.shown.bubble || item !== runtime.shown.item) {
			runtime.shown = { bubble, item };
			publish();
		}
		return runtime;
	};

	const pose = (index: number, out: RigPose, frame: RigFrame) => {
		const spec = villagers[index];
		if (!spec) {
			return;
		}
		const scale = spec.scale ?? 1;
		const time = lifeClockAt(clockBase.current, frame.time);
		const runtime = spec.life ? live(spec, spec.life, time) : null;
		byIndex.current[index] = runtime;
		if (runtime) {
			poseLife(runtime.frame, out, time, index * 1.7, reducedMotion);
		} else {
			poseVillager(spec, index, out, frame.time, reducedMotion);
		}
		const parent = spec.follow?.();
		if (parent) {
			out.position.x += parent.x;
			out.position.z += parent.z;
		}
		if (spec.scale) {
			out.scale.multiplyScalar(spec.scale);
		}
		if (runtime) {
			const { body } = runtime;
			body.x = out.position.x;
			body.y = out.position.y;
			body.z = out.position.z;
			body.yaw = out.rotation.y;
			body.scale = scale;
		}
		const anchor = anchors.current[index];
		if (anchor && (spec.walk || runtime || spec.follow)) {
			const y =
				(runtime ? runtime.frame.position[1] : spec.position[1]) +
				PLATE_HEIGHT * scale;
			const { position } = anchor;
			if (
				position.x !== out.position.x ||
				position.y !== y ||
				position.z !== out.position.z
			) {
				anchorsMoved.current = true;
			}
			position.set(out.position.x, y, out.position.z);
		}
	};

	useFrame(({ clock }) => {
		// Villagers present at the first frame have been settled; anyone
		// scripted from now on plays in.
		seeded.current = true;
		// How many villagers still play their one-off steps (walking to their
		// spot, delivering): `data-life-busy` on the canvas, for checks that
		// must wait for the scene to settle. Reduced motion reads the end.
		let busy = 0;
		if (!reducedMotion) {
			const time = lifeClockAt(clockBase.current, clock.elapsedTime);
			for (const runtime of lives.current.values()) {
				const elapsed = time - runtime.startedAt;
				if (elapsed >= 0 && elapsed < runtime.timeline.settled) {
					busy += 1;
				}
			}
		}
		if (
			needsLifeFrame({
				busy,
				moved: anchorsMoved.current,
				reducedMotion,
				wasBusy: wasBusy.current,
			})
		) {
			invalidate();
		}
		wasBusy.current = busy > 0;
		anchorsMoved.current = false;
		const count = String(busy);
		if (canvas.dataset.lifeBusy !== count) {
			canvas.dataset.lifeBusy = count;
		}
		byIndex.current.length = villagers.length;
		for (const id of lives.current.keys()) {
			if (!villagers.some((villager) => villager.id === id && villager.life)) {
				lives.current.delete(id);
			}
		}
	});

	const selected = villagers.find((villager) => villager.id === selectedId);
	const scripted = villagers.some((villager) => villager.life);
	return (
		<group>
			<VillagerRig
				members={members}
				onHover={
					onHover
						? (index) =>
								onHover(index === null ? null : (villagers[index]?.id ?? null))
						: undefined
				}
				onPick={
					onSelect || villagers.some((villager) => villager.activate)
						? (index) => {
								const villager = villagers[index];
								if (villager?.activate) {
									villager.activate();
								} else if (villager) {
									onSelect?.(villager.id);
								}
							}
						: undefined
				}
				pose={pose}
			/>
			{villagers.map((villager) => {
				const item = villager.life ? shown.get(villager.id)?.item : null;
				const runtime = lives.current.get(villager.id);
				return item && runtime ? (
					<CarriedItem body={runtime.body} item={item} key={villager.id} />
				) : null;
			})}
			{scripted && !reducedMotion ? (
				<LifeEffects count={villagers.length} runtimes={byIndex} />
			) : null}
			{plates
				? villagers.map((villager, index) =>
						villager.plate === false ? null : (
							<group
								key={villager.id}
								position={[
									villager.position[0],
									villager.position[1] + PLATE_HEIGHT * (villager.scale ?? 1),
									villager.position[2],
								]}
								ref={(group) => {
									anchors.current[index] = group;
								}}
							>
								<VillagerPlate
									bubble={
										villager.life && villager.bubble !== false
											? shown.get(villager.id)?.bubble
											: null
									}
									iconOnly={villager.iconOnly ?? iconOnly}
									onSelect={onSelect}
									selected={villager.id === selectedId}
									spec={villager}
								/>
								<FigureProbes
									id={villager.actAgent ?? villager.id}
									scale={villager.scale ?? 1}
								/>
							</group>
						)
					)
				: null}
			{selected && !selected.walk && !selected.life ? (
				<GroundRing
					color={selected.looks.body}
					position={selected.position}
					reducedMotion={reducedMotion}
				/>
			) : null}
		</group>
	);
}

/** A soft, pulsing ring on the ground: the selected villager or object. */
export function GroundRing({
	color,
	position,
	radius = 0.5,
	reducedMotion,
}: {
	color: string;
	position: Vec3;
	radius?: number;
	reducedMotion: boolean;
}) {
	const ref = useRef<Mesh>(null);
	useFrame(({ clock }) => {
		const ring = ref.current;
		if (!ring || reducedMotion) {
			return;
		}
		const pulse = 1 + (0.5 + Math.sin(clock.elapsedTime * 4) * 0.5) * 0.1;
		ring.scale.set(pulse, pulse, 1);
	});
	return (
		<mesh
			position={[position[0], position[1] + 0.04, position[2]]}
			ref={ref}
			renderOrder={2}
			rotation={[-Math.PI / 2, 0, 0]}
		>
			<ringGeometry args={[radius * 0.84, radius, 48, 2]} />
			<CurvedBasicMaterial
				color={color}
				depthWrite={false}
				opacity={0.8}
				polygonOffset
				polygonOffsetFactor={-4}
				toneMapped={false}
				transparent
			/>
		</mesh>
	);
}
