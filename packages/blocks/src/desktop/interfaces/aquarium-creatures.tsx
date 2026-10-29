/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import type { Group, InstancedMesh, Matrix4, Mesh } from "three";
import type { CreaturePlateAct, CreatureTarget } from "./aquarium-acts.tsx";
import {
	CREATURE_SCALE,
	PLATE_LIFT,
	plateBadge,
	type Swim,
	swimAt,
	TANK_FLOOR,
	TANK_SURFACE,
	TO_CAMERA,
} from "./aquarium-layout.ts";
import {
	type Creature,
	type CreatureKind,
	creatureDescription,
} from "./aquarium-model.ts";
import {
	creatureHue,
	hexColor,
	TANK_FITTINGS,
	type TankPalette,
} from "./aquarium-palette.ts";
import { GAME_PLATE } from "./game-hud.tsx";
import { shareHull } from "./game3d-instances.tsx";
import { LifeBubbleTag } from "./game3d-life.tsx";
import {
	CurvedBasicMaterial,
	InkMaterial,
	ToonMaterial,
} from "./game3d-materials.tsx";
import { mathKit } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { useGameKitSettings } from "./game3d-settings.tsx";
import { isWorkBubble } from "./game3d-villager.tsx";

/**
 * The Aquarium's creatures, instanced: every creature is a list of simple
 * parts (spheres, domes, cones, tapered tubes, a ring) and every part shape
 * is one instanced mesh for the whole tank (plus one for its ink outline),
 * so a tank of any size is a dozen draw calls. Each frame places every
 * creature on its swim loop and swings its tail, fins, flippers, wings or
 * tentacles; a creature holds still under the pointer and while its card
 * is open. Name plates, shadows and bubbles ride along.
 */

type Shape = "cone" | "cylinder" | "dome" | "sphere" | "torus";
type Paint =
	| "accent"
	| "belly"
	| "body"
	| "eye"
	| "fin"
	| "glow"
	| "pearl"
	| "pearlGlow"
	| "white";

interface Part {
	at: Vec3;
	/** Drawn unlit at night only (bioluminescent spots). */
	glow?: boolean;
	ink?: boolean;
	/** Which animated limb carries it. */
	limb?: "a" | "b";
	paint: Paint;
	/** Only on a creature that carries a pearl. */
	pearl?: boolean;
	rot?: Vec3;
	shape: Shape;
	size: Vec3;
}

/** How a species moves its two limbs. */
interface Rig {
	a?: { axis: "tentacles" | "x" | "y"; pivot: Vec3 };
	/** Swing amplitude (rad) and rate (rad/s). */
	amount: number;
	b?: { axis: "pulse" | "x"; pivot: Vec3; sign: number };
	/** Always faces the camera (jellyfish drift, they do not steer). */
	facesCamera?: boolean;
	rate: number;
}

const QUARTER = Math.PI / 2;

/** A four-sided fin cone of radius `r` and height `h`, flattened. */
function fin(
	paint: Paint,
	at: Vec3,
	rot: Vec3,
	r: number,
	h: number,
	limb?: "a" | "b"
): Part {
	return {
		at,
		ink: true,
		limb,
		paint,
		rot,
		shape: "cone",
		size: [2 * r, h, 0.64 * r],
	};
}

function ball(
	paint: Paint,
	at: Vec3,
	size: Vec3 | number,
	extra: Partial<Part> = {}
): Part {
	const s: Vec3 = typeof size === "number" ? [size, size, size] : size;
	return { at, paint, shape: "sphere", size: s, ...extra };
}

/** Two eyes (white, pupil) at ±z. */
function eyes(at: Vec3, size = 1, limb?: "a" | "b"): Part[] {
	const [x, y, z] = at;
	return [1, -1].flatMap((side) => [
		ball("white", [x, y, z * side], 0.15 * size, { limb }),
		ball(
			"eye",
			[x + 0.035 * size, y + 0.005, z * side + 0.04 * side * size],
			0.09 * size,
			{ limb }
		),
	]);
}

function glowDot(at: Vec3, size: number, limb?: "a" | "b"): Part {
	return ball("glow", at, size, { glow: true, limb });
}

const TENTACLES = [0, 1, 2, 3, 4, 5].map((index) => (index / 6) * Math.PI * 2);

const PARTS: Record<CreatureKind, Part[]> = {
	angelfish: [
		ball("body", [0, 0, 0], [0.7, 0.74, 0.24], { ink: true }),
		ball("accent", [0.1, 0, 0], [0.1, 0.74, 0.25]),
		ball("accent", [-0.12, 0, 0], [0.1, 0.7, 0.25]),
		fin("fin", [-0.14, 0.42, 0], [0, 0, 0.75], 0.14, 0.48),
		fin("fin", [-0.14, -0.42, 0], [0, 0, Math.PI - 0.75], 0.14, 0.48),
		fin("fin", [-0.42, 0, 0], [0, 0, -QUARTER], 0.18, 0.24, "a"),
		...eyes([0.2, 0.1, 0.09], 0.9),
		glowDot([0, 0.2, 0.13], 0.07),
	],
	fish: [
		ball("body", [0, 0, 0], [0.88, 0.6, 0.44], { ink: true }),
		ball("belly", [0.05, -0.12, 0], [0.7, 0.34, 0.4]),
		ball("accent", [0.08, 0, 0], [0.14, 0.6, 0.45]),
		fin("fin", [0, 0.3, 0], [0, 0, 0.6], 0.13, 0.26),
		fin("fin", [-0.5, 0, 0], [0, 0, -QUARTER], 0.2, 0.28, "a"),
		...eyes([0.27, 0.07, 0.15]),
		glowDot([-0.12, 0.08, 0.2], 0.07),
		glowDot([-0.12, 0.08, -0.2], 0.07),
	],
	jellyfish: [
		{
			at: [0, 0, 0],
			ink: true,
			limb: "b",
			paint: "body",
			shape: "dome",
			size: [0.78, 0.72, 0.78],
		},
		{
			at: [0, 0.01, 0],
			limb: "b",
			paint: "fin",
			rot: [QUARTER, 0, 0],
			shape: "torus",
			size: [0.74, 0.74, 0.74],
		},
		...eyes([0.3, 0.14, 0.11], 0.85, "b"),
		...TENTACLES.map<Part>((angle) => ({
			at: [Math.cos(angle) * 0.2, -0.28, Math.sin(angle) * 0.2],
			limb: "a",
			paint: "fin",
			shape: "cylinder",
			size: [0.05, 0.52, 0.05],
		})),
		...TENTACLES.map((angle) =>
			glowDot([Math.cos(angle) * 0.2, -0.55, Math.sin(angle) * 0.2], 0.06, "a")
		),
		glowDot([0, 0.12, 0], 0.3, "b"),
	],
	manta: [
		ball("body", [0, 0, 0], [0.72, 0.24, 0.6], { ink: true }),
		ball("belly", [0, -0.05, 0], [0.6, 0.16, 0.5]),
		...([1, -1] as const).flatMap((side) => {
			const limb = side === 1 ? "a" : "b";
			return [
				ball("body", [-0.04, 0, 0.62 * side], [0.56, 0.1, 0.92], {
					ink: true,
					limb,
					rot: [0, 0.35 * side, 0],
				}),
				ball("accent", [-0.02, 0.04, 0.56 * side], [0.16, 0.06, 0.16], {
					limb,
				}),
				glowDot([-0.1, 0.1, 0.5 * side], 0.07, limb),
			];
		}),
		{
			at: [-0.66, 0, 0],
			paint: "fin",
			rot: [0, 0, -QUARTER],
			shape: "cylinder",
			size: [0.06, 0.64, 0.06],
		},
		fin("fin", [0.38, 0, 0.13], [0, 0, -QUARTER], 0.06, 0.16),
		fin("fin", [0.38, 0, -0.13], [0, 0, -QUARTER], 0.06, 0.16),
		...eyes([0.26, 0.1, 0.15], 0.8),
	],
	turtle: [
		{
			at: [0, 0, 0],
			ink: true,
			paint: "body",
			shape: "dome",
			size: [0.92, 0.6, 0.8],
		},
		...(
			[
				[0, 0.29, 0],
				[0.2, 0.22, 0],
				[-0.2, 0.22, 0],
				[0, 0.22, 0.19],
				[0, 0.22, -0.19],
			] as const
		).map((at) => ball("accent", [...at], [0.2, 0.08, 0.18])),
		ball("belly", [0, -0.01, 0], [0.94, 0.14, 0.82], { ink: true }),
		ball("fin", [0.5, 0.05, 0], [0.36, 0.32, 0.32], { ink: true }),
		...eyes([0.58, 0.12, 0.09], 0.75),
		ball("fin", [0.14, 0, 0.46], [0.36, 0.07, 0.2], {
			ink: true,
			limb: "a",
			rot: [0, 0.5, 0],
		}),
		ball("fin", [0.14, 0, -0.46], [0.36, 0.07, 0.2], {
			ink: true,
			limb: "b",
			rot: [0, -0.5, 0],
		}),
		ball("fin", [-0.36, -0.02, 0.24], [0.2, 0.06, 0.12]),
		ball("fin", [-0.36, -0.02, -0.24], [0.2, 0.06, 0.12]),
		glowDot([0, 0.31, 0], 0.09),
	],
};

const RIGS: Record<CreatureKind, Rig> = {
	angelfish: { a: { axis: "y", pivot: [-0.32, 0, 0] }, amount: 0.45, rate: 4 },
	fish: { a: { axis: "y", pivot: [-0.4, 0, 0] }, amount: 0.55, rate: 6 },
	jellyfish: {
		a: { axis: "tentacles", pivot: [0, 0, 0] },
		amount: 0.18,
		b: { axis: "pulse", pivot: [0, 0, 0], sign: 1 },
		facesCamera: true,
		rate: 1.6,
	},
	manta: {
		a: { axis: "x", pivot: [0, 0, 0.2] },
		amount: 0.3,
		b: { axis: "x", pivot: [0, 0, -0.2], sign: -1 },
		rate: 1.8,
	},
	turtle: {
		a: { axis: "x", pivot: [0.18, 0, 0.32] },
		amount: 0.4,
		b: { axis: "x", pivot: [0.18, 0, -0.32], sign: -1 },
		rate: 2.2,
	},
};

/** Where a creature carries its pearl. */
function pearlParts(kind: CreatureKind): Part[] {
	const hold = kind === "turtle" ? 0.62 : 0.42;
	return [
		ball("pearl", [hold, -0.22, 0], 0.16, { ink: true, pearl: true }),
		ball("pearlGlow", [hold, -0.22, 0], 0.12, { glow: true, pearl: true }),
	];
}

const SHAPES: readonly Shape[] = [
	"sphere",
	"dome",
	"cone",
	"cylinder",
	"torus",
];

function ShapeGeometry({ shape }: { shape: Shape }) {
	if (shape === "dome") {
		return (
			<sphereGeometry args={[0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
		);
	}
	if (shape === "cone") {
		return <coneGeometry args={[0.5, 1, 4]} />;
	}
	if (shape === "cylinder") {
		return <cylinderGeometry args={[0.5, 0.24, 1, 6]} />;
	}
	if (shape === "torus") {
		return <torusGeometry args={[0.5, 0.0676, 8, 24]} />;
	}
	return <sphereGeometry args={[0.5, 18, 12]} />;
}

/** One instance: which creature and which of its parts. */
interface Slot {
	creature: number;
	part: Part;
}

/** A drawn batch: one shape, outlined or not, or the night glow. */
interface Batch {
	glow: boolean;
	ink: boolean;
	key: string;
	shape: Shape;
	slots: Slot[];
}

function batchesFor(creatures: readonly Creature[], night: boolean): Batch[] {
	const batches = new Map<string, Batch>();
	for (const [index, creature] of creatures.entries()) {
		const parts = creature.pearl
			? [...PARTS[creature.kind], ...pearlParts(creature.kind)]
			: PARTS[creature.kind];
		for (const part of parts) {
			if (part.glow && !night) {
				continue;
			}
			const glow = part.glow === true;
			const ink = !glow && part.ink === true;
			const key = `${part.shape}:${glow ? "glow" : ""}:${ink ? "ink" : ""}`;
			const batch = batches.get(key) ?? {
				glow,
				ink,
				key,
				shape: part.shape,
				slots: [],
			};
			batch.slots.push({ creature: index, part });
			batches.set(key, batch);
		}
	}
	return SHAPES.flatMap((shape) =>
		[...batches.values()].filter((batch) => batch.shape === shape)
	);
}

const INK = 0.024;
const BUBBLES_EACH = 5;

interface Pose {
	limbA: Matrix4;
	limbB: Matrix4;
	root: Matrix4;
	x: number;
	y: number;
	z: number;
}

export function CreatureSchool({
	creatures,
	focusedId,
	night,
	onSelect,
	palette,
	plates: plateTexts,
	reduced,
	selectedId,
	swims,
	targets,
}: {
	creatures: readonly Creature[];
	focusedId: string | null;
	night: boolean;
	onSelect: (agentId: string) => void;
	palette: TankPalette;
	reduced: boolean;
	selectedId: string | null;
	swims: ReadonlyMap<string, Swim>;
	/** The act layer's plate words (a queue plate's "Bo · ≤ 7m"), by agent. */
	plates?: ReadonlyMap<string, CreaturePlateAct>;
	/**
	 * The act layer's targets (aquarium-acts.tsx): each creature's swim
	 * home eases there (snaps under reduced motion), looping small and slow
	 * while it is away from home.
	 */
	targets?: ReadonlyMap<string, CreatureTarget>;
}) {
	const homes = useRef(new Map<string, Vec3>());
	const moved = useRef<Swim>({
		direction: 1,
		home: [0, 0, 0],
		phase: 0,
		radiusX: 0,
		radiusZ: 0,
		speed: 0,
	});
	const batches = useMemo(
		() => batchesFor(creatures, night),
		[creatures, night]
	);
	const fittings = TANK_FITTINGS[palette.mode];
	const meshes = useRef<(InstancedMesh | null)[]>([]);
	const hulls = useRef<(InstancedMesh | null)[]>([]);
	const locals = useRef<Matrix4[][]>([]);
	const poses = useRef<Pose[]>([]);
	const clocks = useRef<number[]>([]);
	const held = useRef<boolean[]>([]);
	const plates = useRef<(Group | null)[]>([]);
	const shadows = useRef<InstancedMesh | null>(null);
	const ring = useRef<Mesh | null>(null);
	const bubbles = useRef<InstancedMesh | null>(null);
	const scratch = useRef<{ pivot: Matrix4; swing: Matrix4 } | null>(null);
	const at = useRef({ heading: 0, x: 0, y: 0, z: 0 });
	const selectedRef = useRef(selectedId);
	selectedRef.current = selectedId;
	const workers = useMemo(
		() =>
			creatures.flatMap((creature, index) => (creature.working ? [index] : [])),
		[creatures]
	);

	// Colours are set once per cast; outlines share transforms and colours.
	useLayoutEffect(() => {
		const cleanups: (() => void)[] = [];
		const paints = creatures.map((creature) => {
			const hue = creatureHue(palette, creature.colorIndex);
			return {
				accent: hexColor(hue.accent),
				belly: hexColor(hue.belly),
				body: hexColor(hue.body),
				eye: hexColor(palette.eye),
				fin: hexColor(hue.fin),
				glow: hexColor(hue.glow),
				pearl: hexColor(palette.pearl),
				pearlGlow: hexColor(palette.pearlGlow),
				white: hexColor(palette.bubble),
			} satisfies Record<Paint, string>;
		});
		for (const [index, batch] of batches.entries()) {
			const mesh = meshes.current[index];
			const color = mesh ? mathKit(mesh).color : null;
			if (!(mesh && color)) {
				continue;
			}
			for (const [slot, { creature, part }] of batch.slots.entries()) {
				mesh.setColorAt(slot, color.set(paints[creature]?.[part.paint] ?? ""));
			}
			if (mesh.instanceColor) {
				mesh.instanceColor.needsUpdate = true;
			}
			const hull = hulls.current[index];
			if (hull) {
				cleanups.push(shareHull(mesh, hull));
			}
		}
		locals.current = [];
		return () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		};
	}, [batches, creatures, palette]);

	useFrame(({ clock }, delta) => {
		const first = meshes.current.find(Boolean);
		if (!first) {
			return;
		}
		const kit = mathKit(first);
		scratch.current ??= {
			pivot: first.matrix.clone(),
			swing: first.matrix.clone(),
		};
		const { pivot, swing } = scratch.current;
		const time = reduced ? 0 : clock.elapsedTime;
		const now = at.current;
		// Every creature's root and limbs this frame.
		for (const [index, creature] of creatures.entries()) {
			const swim = swims.get(creature.id);
			if (!swim) {
				continue;
			}
			const still =
				reduced || held.current[index] || selectedRef.current === creature.id;
			if (!still) {
				clocks.current[index] =
					(clocks.current[index] ?? 0) + Math.min(delta, 0.1);
			}
			const target = targets?.get(creature.id);
			if (!target) {
				// Back to its own loop: the next act eases from its home again.
				homes.current.delete(creature.id);
			}
			let path = swim;
			if (target) {
				const home = homes.current.get(creature.id) ?? [...swim.home];
				const ease = reduced ? 1 : 1 - Math.exp(-Math.min(delta, 0.1) * 1.6);
				for (const axis of [0, 1, 2] as const) {
					home[axis] += (target.at[axis] - home[axis]) * ease;
				}
				homes.current.set(creature.id, home);
				const loop = target.away ? 0.25 : 1;
				path = Object.assign(moved.current, swim, {
					home,
					radiusX: swim.radiusX * loop,
					radiusZ: swim.radiusZ * loop,
					speed: swim.speed * (target.away ? 0.5 : 1),
				});
			}
			swimAt(path, clocks.current[index] ?? 0, now);
			const rig = RIGS[creature.kind];
			const pose = poses.current[index] ?? {
				limbA: first.matrix.clone(),
				limbB: first.matrix.clone(),
				root: first.matrix.clone(),
				x: 0,
				y: 0,
				z: 0,
			};
			poses.current[index] = pose;
			pose.x = now.x;
			pose.y = now.y;
			pose.z = now.z;
			const turn = rig.facesCamera ? TO_CAMERA : now.heading;
			kit.position.set(now.x, now.y, now.z);
			kit.quaternion.setFromEuler(kit.euler.set(0, turn, 0));
			kit.scale.set(CREATURE_SCALE, CREATURE_SCALE, CREATURE_SCALE);
			pose.root.compose(kit.position, kit.quaternion, kit.scale);
			const beat = Math.sin(time * rig.rate * (creature.working ? 1.3 : 1));
			const angle = beat * rig.amount;
			pose.limbA.copy(pose.root);
			if (rig.a) {
				const [px, py, pz] = rig.a.pivot;
				pose.limbA.multiply(pivot.makeTranslation(px, py, pz));
				if (rig.a.axis === "y") {
					pose.limbA.multiply(swing.makeRotationY(angle));
				} else if (rig.a.axis === "x") {
					pose.limbA.multiply(swing.makeRotationX(angle));
				} else {
					pose.limbA.multiply(
						swing.makeRotationFromEuler(
							kit.euler.set(angle * 0.5, 0, angle * 0.4)
						)
					);
				}
				pose.limbA.multiply(pivot.makeTranslation(-px, -py, -pz));
			}
			pose.limbB.copy(pose.root);
			if (rig.b) {
				const [px, py, pz] = rig.b.pivot;
				pose.limbB.multiply(pivot.makeTranslation(px, py, pz));
				if (rig.b.axis === "pulse") {
					const grow = 1 + beat * 0.06;
					pose.limbB.multiply(swing.makeScale(grow, 1 - beat * 0.05, grow));
				} else {
					pose.limbB.multiply(swing.makeRotationX(angle * rig.b.sign));
				}
				pose.limbB.multiply(pivot.makeTranslation(-px, -py, -pz));
			}
			plates.current[index]?.position.set(now.x, now.y + PLATE_LIFT, now.z);
		}
		// Every batch's instances from their creature's pose.
		for (const [index, batch] of batches.entries()) {
			const mesh = meshes.current[index];
			if (!mesh) {
				continue;
			}
			const parts =
				locals.current[index] ??
				batch.slots.map(({ part }) => {
					const [rx, ry, rz] = part.rot ?? [0, 0, 0];
					kit.position.set(...part.at);
					kit.quaternion.setFromEuler(kit.euler.set(rx, ry, rz));
					kit.scale.set(...part.size);
					return first.matrix
						.clone()
						.compose(kit.position, kit.quaternion, kit.scale);
				});
			locals.current[index] = parts;
			const { matrix } = mathKit(mesh);
			for (const [slot, { creature, part }] of batch.slots.entries()) {
				const pose = poses.current[creature];
				const local = parts[slot];
				if (!(pose && local)) {
					continue;
				}
				let base = pose.root;
				if (part.limb === "a") {
					base = pose.limbA;
				} else if (part.limb === "b") {
					base = pose.limbB;
				}
				mesh.setMatrixAt(slot, matrix.multiplyMatrices(base, local));
			}
			mesh.instanceMatrix.needsUpdate = true;
			mesh.computeBoundingSphere();
		}
		// Shadows on the sand, the open card's ring, and bubbles.
		const shadow = shadows.current;
		if (shadow) {
			const { matrix } = mathKit(shadow);
			for (const [index] of creatures.entries()) {
				const pose = poses.current[index];
				if (!pose) {
					continue;
				}
				kit.position.set(pose.x, TANK_FLOOR + 0.02, pose.z);
				kit.quaternion.setFromEuler(kit.euler.set(-QUARTER, 0, 0));
				kit.scale.set(1, 1, 1);
				shadow.setMatrixAt(
					index,
					matrix.compose(kit.position, kit.quaternion, kit.scale)
				);
			}
			shadow.instanceMatrix.needsUpdate = true;
			shadow.computeBoundingSphere();
		}
		const selected = creatures.findIndex(
			(creature) => creature.id === selectedRef.current
		);
		const marker = ring.current;
		const chosen = poses.current[selected];
		if (marker) {
			marker.visible = chosen !== undefined;
			if (chosen) {
				marker.position.set(chosen.x, TANK_FLOOR + 0.03, chosen.z);
			}
		}
		const fizz = bubbles.current;
		if (fizz) {
			const { matrix } = mathKit(fizz);
			for (const [order, index] of workers.entries()) {
				const pose = poses.current[index];
				for (let bubble = 0; bubble < BUBBLES_EACH; bubble++) {
					const slot = order * BUBBLES_EACH + bubble;
					if (!pose) {
						fizz.setMatrixAt(slot, matrix.makeScale(0, 0, 0));
						continue;
					}
					const rise = (time * 0.4 + bubble / BUBBLES_EACH) % 1;
					const from = pose.y + 0.45;
					const y = from + rise * Math.max(0, TANK_SURFACE - 0.08 - from);
					const size = 0.1 + rise * 0.07;
					kit.position.set(
						pose.x + Math.sin(time * 2 + bubble * 2.3) * 0.06,
						y,
						pose.z
					);
					kit.quaternion.identity();
					kit.scale.set(size, size, size);
					fizz.setMatrixAt(
						slot,
						matrix.compose(kit.position, kit.quaternion, kit.scale)
					);
				}
			}
			fizz.instanceMatrix.needsUpdate = true;
			fizz.computeBoundingSphere();
		}
	});

	const pick = (batch: Batch, instanceId: number | undefined) => {
		const slot = batch.slots[instanceId ?? -1];
		const creature = slot ? creatures[slot.creature] : undefined;
		if (creature) {
			onSelect(creature.id);
		}
	};
	const selectedHue =
		creatures.find((creature) => creature.id === selectedId) ?? null;
	return (
		<group>
			{batches.map((batch, index) => (
				<group key={`${batch.key}:${batch.slots.length}`}>
					<instancedMesh
						args={[undefined, undefined, batch.slots.length]}
						frustumCulled={false}
						onClick={(event) => {
							event.stopPropagation();
							pick(batch, event.instanceId);
						}}
						ref={(mesh) => {
							meshes.current[index] = mesh;
						}}
					>
						<ShapeGeometry shape={batch.shape} />
						{batch.glow ? (
							<CurvedBasicMaterial toneMapped={false} />
						) : (
							<ToonMaterial />
						)}
					</instancedMesh>
					{batch.ink ? (
						<instancedMesh
							args={[undefined, undefined, batch.slots.length]}
							raycast={() => null}
							ref={(mesh) => {
								hulls.current[index] = mesh;
							}}
						>
							<InkMaterial width={INK} />
						</instancedMesh>
					) : (
						<FreeSlot index={index} slots={hulls} />
					)}
				</group>
			))}
			{creatures.length > 0 ? (
				<instancedMesh
					args={[undefined, undefined, creatures.length]}
					frustumCulled={false}
					key={`shadows:${creatures.length}`}
					raycast={() => null}
					ref={shadows}
				>
					<circleGeometry args={[0.5, 24]} />
					<CurvedBasicMaterial
						color={fittings.shadow}
						depthWrite={false}
						opacity={0.22}
						transparent
					/>
				</instancedMesh>
			) : null}
			<mesh raycast={() => null} ref={ring} rotation={[-QUARTER, 0, 0]}>
				<ringGeometry args={[0.62, 0.74, 36]} />
				<CurvedBasicMaterial
					color={
						selectedHue
							? hexColor(creatureHue(palette, selectedHue.colorIndex).glow)
							: fittings.glint
					}
					toneMapped={false}
				/>
			</mesh>
			{workers.length > 0 ? (
				<instancedMesh
					args={[undefined, undefined, workers.length * BUBBLES_EACH]}
					frustumCulled={false}
					key={`bubbles:${workers.length}`}
					raycast={() => null}
					ref={bubbles}
				>
					<sphereGeometry args={[0.5, 10, 8]} />
					<CurvedBasicMaterial
						color={hexColor(palette.bubble)}
						depthWrite={false}
						opacity={0.7}
						transparent
					/>
				</instancedMesh>
			) : null}
			{creatures.map((creature, index) => (
				<group
					key={creature.id}
					ref={(group) => {
						plates.current[index] = group;
					}}
				>
					<CreaturePlate
						act={plateTexts?.get(creature.id)}
						creature={creature}
						focused={focusedId === creature.id}
						onHold={(hold) => {
							held.current[index] = hold;
						}}
						onSelect={onSelect}
						selected={selectedId === creature.id}
					/>
				</group>
			))}
		</group>
	);
}

/** Clears a batch's hull slot when that batch draws no outline. */
function FreeSlot({
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

/**
 * A creature's kit name plate with its status badge. The keyboard path is
 * the tank's creature list (its focused creature's plate wears the focus
 * ring), so the plate itself is a pointer target only.
 */
function CreaturePlate({
	creature,
	focused,
	onHold,
	onSelect,
	selected,
	act,
}: {
	creature: Creature;
	focused: boolean;
	onHold: (hold: boolean) => void;
	onSelect: (agentId: string) => void;
	selected: boolean;
	/** The act layer's words and badge for the plate, when there are acts. */
	act?: CreaturePlateAct;
}): ReactNode {
	const badge = act ? act.badge : plateBadge(creature);
	const text = act?.text;
	// The kit's work-bubbles setting, as the kit's villagers read it.
	const { workBubbles } = useGameKitSettings();
	const kept = act?.bubble ?? null;
	const bubble = kept && (workBubbles || !isWorkBubble(kept)) ? kept : null;
	return (
		<Html center zIndexRange={[40, 0]}>
			<button
				aria-hidden="true"
				className={cn(
					GAME_PLATE,
					"gk-display relative flex h-7 cursor-pointer select-none items-center whitespace-nowrap rounded-full px-2.5 text-[13px] leading-none",
					selected && "bg-(--gk-accent) text-(--gk-accent-ink)",
					focused &&
						"outline-(--gk-focus) outline-3 outline-solid outline-offset-2"
				)}
				data-iso-focus={creature.id}
				// With acts every plate joins the stage's plate separation
				// (game3d-plates), so none sits on the queue, the chest or a prop.
				data-iso-plate={act ? "" : undefined}
				data-plate={creature.id}
				data-you-spot={act?.youSpot ? "slot" : undefined}
				onClick={() => (act?.activate ? act.activate() : onSelect(creature.id))}
				onPointerEnter={() => onHold(true)}
				onPointerLeave={() => onHold(false)}
				tabIndex={-1}
				// With acts the list row and the act sentence say it; no legacy
				// thread-count tooltip.
				title={act ? undefined : creatureDescription(creature)}
				type="button"
			>
				{bubble ? <LifeBubbleTag bubble={bubble} /> : null}
				{badge ? (
					<span
						className={cn(
							// With acts the badge sits inside the plate, so the plate
							// separation and the overlap checks see it.
							act
								? "-ms-1 me-1.5 grid h-5 min-w-5 place-items-center rounded-full border-(--gk-edge) border-2 px-0.5 font-bold text-[11px] leading-none"
								: "absolute -top-5 left-1/2 grid h-6 min-w-6 -translate-x-1/2 place-items-center rounded-full border-(--gk-edge) border-2 px-1 font-bold text-[13px] leading-none",
							badge.className
						)}
					>
						{badge.mark}
					</span>
				) : null}
				<span className={text ? undefined : "max-w-28 truncate"}>
					{text ?? creature.name}
				</span>
			</button>
		</Html>
	);
}
