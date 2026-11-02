/* eslint-disable react/no-unknown-property */
import type { InstancedMesh, Matrix4 } from "three";
import { CurvedBasicMaterial, ToonMaterial } from "./game3d-materials.tsx";
import { mathKit } from "./game3d-math.ts";
import { ART_WHITE } from "./game3d-palette.ts";
import { ACCESSORY_PARTS } from "./game3d-villager-accessories.ts";
import { AGENT_PARTS } from "./game3d-villager-hair.ts";
import {
	CHARACTER_INK,
	CHARACTER_RIM,
	EYE_RADIUS,
	HAIR_SHEEN,
	HEAD_RADIUS,
	HEAD_RIM,
	LASH_ARC,
	LOCK_INK,
	type MemberLooks,
	type PartGeometry,
	type PartSpec,
	SHINE,
} from "./game3d-villager-model.ts";
import { TOOL_PARTS } from "./game3d-villager-tools.ts";

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
export function partShown(part: PartSpec, looks: MemberLooks): boolean {
	if (part.styles && !part.styles.includes(looks.hairStyle)) {
		return false;
	}
	return part.when ? part.when(looks) : true;
}

/** Which arm a part moves with, if any. */
export function limbOf(part: PartSpec): "left" | "right" | null {
	if (part.limb) {
		return part.limb;
	}
	if (part.geometry === "arm") {
		return part.position[0] < 0 ? "left" : "right";
	}
	return null;
}
