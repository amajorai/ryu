import { type Vec3, VILLAGER_FEATURES } from "./game3d-palette.ts";

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

export const EYE_COLOR = VILLAGER_FEATURES.eye;
export const LASH_COLOR = VILLAGER_FEATURES.lash;
export const CHEEK_COLOR = VILLAGER_FEATURES.cheek;
export const SHOE_COLOR = VILLAGER_FEATURES.shoe;
export const MOUTH_COLOR = VILLAGER_FEATURES.mouth;
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

export const EYE_X = 0.12;
/** The eyes sit on the face's vertical center, a step below the fringe. */
export const EYE_DY = -0.012;
/** Eye white-less anime eye: a tall dark almond about a third of the face. */
export const EYE_RADIUS = 0.104;
/** How far the upper lash line wraps over the top of the eye, radians. */
export const LASH_ARC = 2.2;

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
export const bodyColor = (looks: MemberLooks) => looks.body;
export const collarColor = (looks: MemberLooks) => looks.collar;
export const skinColor = (looks: MemberLooks) => looks.skin;
export const hairColor = (looks: MemberLooks) => looks.hair;
export const irisColor = (looks: MemberLooks) => looks.iris;

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
