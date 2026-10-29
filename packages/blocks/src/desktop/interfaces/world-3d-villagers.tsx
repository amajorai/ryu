/* eslint-disable react/no-unknown-property */
import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import type { WorldDirection } from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import {
	type ReactNode,
	type RefObject,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { Group, InstancedMesh, Mesh, Points } from "three";
import { writeInstances } from "./game3d-instances.tsx";
import type { LifeItem } from "./game3d-life.ts";
import { CarriedItem, type LifeBody } from "./game3d-life.tsx";
import {
	CurvedBasicMaterial,
	CurvedPointsMaterial,
	InkMaterial,
	ToonMaterial,
	ToonMesh,
} from "./game3d-materials.tsx";
import { ADDITIVE_BLENDING, DOUBLE_SIDE } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import {
	ART_WHITE,
	PLAYER_OUTFIT,
	VILLAGER_FEATURES,
} from "./game3d-palette.ts";
import { curveDrop, hullGeometry } from "./game3d-toon.ts";
import {
	AGENT_PARTS,
	BODY_Y,
	CHARACTER_INK,
	CHARACTER_RIM,
	EAR_TUFTS,
	fringe,
	HAIR_SHEEN,
	HEAD_RADIUS,
	HEAD_RIM,
	HEAD_Y,
	LOCK_INK,
	type MemberLooks,
	type PartGeometry,
	PartShape,
	type PartSpec,
	type RigFrame,
	type RigPose,
	SHINE,
	SHOE_COLOR,
	SIDE_LOCKS,
	shortestAngle,
	VillagerRig,
} from "./game3d-villager.tsx";

/**
 * World 3D's people: every agent is one of the game kit's chibi villagers
 * (see game3d-villager.tsx), drawn on its instanced rig, turning to face
 * the player when they come near or talk.
 *
 * The player is a distinct traveler: straw hat with a red band, a red scarf
 * whose tail flutters, and a cream tunic. Walking is a squash-and-stretch
 * hop per tile with a little dust puff at every landing.
 */

const BOB_SPEED = 2.6;
/** Other villagers this close to a conversation leave the shot. */
const BYSTANDER_RADIUS = 9;
const TURN_SPEED = 6;
/** Player walking speed in tiles per second, and how fast it settles. */
const PLAYER_SPEED = 7;
const PLAYER_GLIDE = 10;
const PLAYER_TURN = 12;
const HOP_HEIGHT = 0.24;
/** The player moves before the camera reads its position each frame. */
const PLAYER_FRAME_PRIORITY = -2;
/** Rotation about Y that turns a character's face (+Z) toward a direction. */
export const FACING_YAW: Record<WorldDirection, number> = {
	down: 0,
	left: -Math.PI / 2,
	right: Math.PI / 2,
	up: Math.PI,
};

/** Where each agent stands. */
export interface CrowdMember {
	/**
	 * The act layer's body language: an asking agent stands tall and turned
	 * to the camera, a stopped one slumps, a limited one sits on its porch.
	 */
	act?: "asking" | "blocked" | "limited";
	agentId: string;
	/** What it carries for its act (its ask, its answer), in front of its chest. */
	carry?: LifeItem | null;
	looks: MemberLooks;
	/** Where it stands; a change walks it there (a jump under reduced motion). */
	position: Vec3;
	working: boolean;
}

/** How fast a villager walks to a new spot (share of the gap per second). */
const WALK_RATE = 1.6;

/**
 * All agents on the kit's villager rig. Each frame poses every agent: an
 * idle squash-and-stretch bounce, and turning to face the player when they
 * come near or talk.
 */
export function AgentCrowd({
	bodies,
	members,
	nearId,
	onHover,
	onTalk,
	playerRef,
	reducedMotion,
	talkingId,
	walk = false,
}: {
	/** Where each villager is drawn, shared with what follows it (its plate). */
	bodies?: Map<string, LifeBody>;
	members: readonly CrowdMember[];
	nearId: string | null;
	onHover: (agentId: string | null) => void;
	onTalk: (agentId: string) => void;
	playerRef: RefObject<Group | null>;
	reducedMotion: boolean;
	talkingId: string | null;
	/** Walk to a new spot (the act layer); otherwise a villager jumps there. */
	walk?: boolean;
}) {
	const yaw = useRef<number[]>([]);
	const presence = useRef<number[]>([]);
	// Where each villager is drawn now, walking toward its `position`.
	const own = useRef(new Map<string, LifeBody>());
	const walked = bodies ?? own.current;
	const bodyOf = (member: CrowdMember): LifeBody => {
		let body = walked.get(member.agentId);
		if (!body) {
			body = {
				scale: 1,
				x: member.position[0],
				y: member.position[1],
				yaw: 0,
				z: member.position[2],
			};
			walked.set(member.agentId, body);
		}
		return body;
	};
	const talker = members.find((member) => member.agentId === talkingId);
	// The same looks array while every member keeps its looks (the members
	// array is rebuilt as acts tick): the rig re-colours only on a change.
	const looksRef = useRef<MemberLooks[]>([]);
	const nextLooks = members.map((member) => member.looks);
	if (
		nextLooks.length !== looksRef.current.length ||
		nextLooks.some((item, index) => item !== looksRef.current[index])
	) {
		looksRef.current = nextLooks;
	}
	const looks = looksRef.current;
	const pose = (index: number, out: RigPose, frame: RigFrame) => {
		const member = members[index];
		if (!member) {
			return;
		}
		const { camera, delta, time } = frame;
		const player = playerRef.current?.position;
		const phase = index * 1.7;
		let wanted = 0;
		if (player && member.agentId === talkingId) {
			// In conversation: turned to the player, opened a touch toward
			// the lens so the face still reads in three-quarter view.
			const toPlayer = Math.atan2(
				player.x - member.position[0],
				player.z - member.position[2]
			);
			const toLens = Math.atan2(
				camera.position.x - member.position[0],
				camera.position.z - member.position[2]
			);
			wanted = toPlayer + shortestAngle(toPlayer, toLens) * 0.2;
		} else if (player && member.agentId === nearId) {
			wanted = Math.atan2(
				player.x - member.position[0],
				player.z - member.position[2]
			);
		} else if (member.act === "asking") {
			// Asking: turned to the lens, so it reads as calling for you.
			wanted = Math.atan2(
				camera.position.x - member.position[0],
				camera.position.z - member.position[2]
			);
		}
		const current = yaw.current[index] ?? 0;
		const next = reducedMotion
			? wanted
			: current +
				shortestAngle(current, wanted) * Math.min(1, delta * TURN_SPEED);
		yaw.current[index] = next;
		// Bystanders near a conversation step out of the shot (they shrink
		// away and pop back when it ends), so the pair has the frame.
		const bystander =
			talker !== undefined &&
			member !== talker &&
			Math.hypot(
				member.position[0] - talker.position[0],
				member.position[2] - talker.position[2]
			) < BYSTANDER_RADIUS;
		const shown = presence.current[index] ?? 1;
		const present = reducedMotion
			? Number(!bystander)
			: shown + (Number(!bystander) - shown) * Math.min(1, delta * 6);
		presence.current[index] = present;
		const speed = member.working ? BOB_SPEED * 1.6 : BOB_SPEED;
		const wave = reducedMotion ? 0 : Math.sin(time * speed + phase);
		const bounce = member.act ? 0 : Math.max(0, wave);
		const sit = member.act === "limited" ? -0.12 : 0;
		const body = bodyOf(member);
		const step = reducedMotion || !walk ? 1 : Math.min(1, delta * WALK_RATE);
		body.x += (member.position[0] - body.x) * step;
		body.z += (member.position[2] - body.z) * step;
		body.y = member.position[1];
		body.yaw = next;
		body.scale = present < 0.02 ? 0 : present;
		out.position.set(body.x, body.y + bounce * 0.045 + sit, body.z);
		const sway = reducedMotion ? 0 : Math.sin(time * 1.3 + phase) * 0.04;
		// A stopped run slumps forward; the others hold still while they wait.
		out.rotation.set(
			member.act === "blocked" ? 0.28 : 0,
			next,
			member.act ? 0 : sway
		);
		// Squash at the bottom of the bounce, stretch at the top.
		let stretch = 1 + wave * 0.035;
		if (member.act === "asking") {
			stretch = 1.06;
		} else if (member.act === "limited") {
			stretch = 0.85;
		} else if (member.act === "blocked") {
			stretch = 0.94;
		}
		const size = present < 0.02 ? 0 : present;
		out.scale.set(
			size / Math.sqrt(stretch),
			size * stretch,
			size / Math.sqrt(stretch)
		);
	};
	return (
		<>
			<VillagerRig
				members={looks}
				onHover={(index) =>
					onHover(index === null ? null : (members[index]?.agentId ?? null))
				}
				onPick={(index) => {
					const member = members[index];
					if (member) {
						onTalk(member.agentId);
					}
				}}
				pose={pose}
			/>
			{members.map((member) =>
				member.carry ? (
					<CarriedItem
						body={bodyOf(member)}
						item={member.carry}
						key={member.agentId}
					/>
				) : null
			)}
		</>
	);
}

/** Twinkles per working agent, circling over its head. */
const SPARKLES_PER_AGENT = 5;
/** Sparkles start at the top of the head (HEAD_Y + HEAD_RADIUS) and rise. */
const SPARKLE_BASE = HEAD_Y + HEAD_RADIUS + 0.08;

/**
 * Golden sparkles circling the heads of working agents (bright enough to
 * bloom). Hidden when motion is reduced.
 */
export function WorkSparkles({
	glow,
	positions,
}: {
	glow: HTMLCanvasElement | null;
	positions: readonly Vec3[];
}) {
	const ref = useRef<Points>(null);
	const count = positions.length * SPARKLES_PER_AGENT;
	const buffer = useMemo(() => new Float32Array(count * 3), [count]);
	useFrame(({ clock }) => {
		const points = ref.current;
		if (!points) {
			return;
		}
		const time = clock.elapsedTime;
		const attribute = points.geometry.getAttribute("position");
		for (const [agent, at] of positions.entries()) {
			for (let index = 0; index < SPARKLES_PER_AGENT; index++) {
				const angle = time * 0.9 + (index / SPARKLES_PER_AGENT) * Math.PI * 2;
				const rise = (time * 0.35 + index * 0.21 + agent * 0.13) % 1;
				// A halo ring around and above the head, never across the face.
				const radius = 0.38 + rise * 0.16;
				attribute.setXYZ(
					agent * SPARKLES_PER_AGENT + index,
					at[0] + Math.cos(angle + agent) * radius,
					at[1] + SPARKLE_BASE + rise * 0.5,
					at[2] + Math.sin(angle + agent) * radius
				);
			}
		}
		attribute.needsUpdate = true;
		const material = points.material;
		if (!Array.isArray(material)) {
			material.opacity = 0.7 + Math.sin(time * 5) * 0.3;
		}
	});
	if (!glow || count === 0) {
		return null;
	}
	return (
		<points frustumCulled={false} key={count} ref={ref}>
			<bufferGeometry>
				<bufferAttribute args={[buffer, 3]} attach="attributes-position" />
			</bufferGeometry>
			<CurvedPointsMaterial
				blending={ADDITIVE_BLENDING}
				color={[3, 2.5, 1.2]}
				depthWrite={false}
				size={0.2}
				sizeAttenuation
				toneMapped={false}
				transparent
			>
				<canvasTexture args={[glow]} attach="map" />
			</CurvedPointsMaterial>
		</points>
	);
}

/**
 * A soft glowing ring on the ground under the agent the player can talk to,
 * in the agent's color.
 */
export function NearRing({
	color,
	position,
	reducedMotion,
}: {
	color: string;
	position: Vec3;
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
			position={[position[0], 0.09, position[2]]}
			ref={ref}
			renderOrder={2}
			rotation={[-Math.PI / 2, 0, 0]}
		>
			<ringGeometry args={[0.42, 0.5, 48, 2]} />
			{/* A decal on the ground: depth-tested, nudged toward the lens. */}
			<CurvedBasicMaterial
				color={color}
				depthWrite={false}
				opacity={0.75}
				polygonOffset
				polygonOffsetFactor={-4}
				toneMapped={false}
				transparent
			/>
		</mesh>
	);
}

const PLAYER = PLAYER_OUTFIT;

const PLAYER_LOOKS: MemberLooks = {
	body: PLAYER.tunic,
	collar: PLAYER.scarf,
	hair: PLAYER.hair,
	hairStyle: 0,
	iris: PLAYER.iris,
	skin: PLAYER.skin,
};

const FACE_KINDS: ReadonlySet<PartGeometry> = new Set([
	"cheek",
	"eye",
	"iris",
	"lash",
	"mouth",
	"shine",
]);
const FACE_PARTS = AGENT_PARTS.filter((part) => FACE_KINDS.has(part.geometry));

/** One face part's paint, for a single (not instanced) mesh. */
function FacePaint({ color, kind }: { color: string; kind: PartGeometry }) {
	if (kind === "shine") {
		return <CurvedBasicMaterial color={SHINE} toneMapped={false} />;
	}
	if (kind === "iris") {
		return (
			<ToonMaterial
				color={color}
				emissive={ART_WHITE}
				emissiveIntensity={0.12}
			/>
		);
	}
	if (kind === "cheek") {
		return <ToonMaterial color={color} opacity={0.75} transparent />;
	}
	return <CurvedBasicMaterial color={color} />;
}

/** The anime face, for the player: the villagers' face parts, one mesh each. */
function PlayerFace() {
	return (
		<>
			{FACE_PARTS.map((part) => (
				<mesh
					key={`${part.geometry}:${part.position.join(",")}`}
					position={part.position}
					rotation={part.rotation}
					scale={part.scale}
				>
					<PartShape kind={part.geometry} />
					<FacePaint color={part.color(PLAYER_LOOKS)} kind={part.geometry} />
				</mesh>
			))}
		</>
	);
}

/**
 * A wide straw hat with a red band, the traveler's signature: the brim is
 * well over one and a half heads across, so from the follow camera it is
 * the dominant shape, with a woven ring and a slight droop at the edge.
 */
function StrawHat() {
	return (
		<group position={[0, HEAD_Y + 0.25, -0.04]} rotation={[-0.14, 0, 0.05]}>
			<ToonMesh castShadow color={PLAYER.hat} ink={CHARACTER_INK} rim={0.3}>
				<cylinderGeometry args={[0.38, 0.43, 0.045, 40]} />
			</ToonMesh>
			<ToonMesh
				color={PLAYER.hatWeave}
				position={[0, 0.024, 0]}
				rotation={[Math.PI / 2, 0, 0]}
			>
				<torusGeometry args={[0.31, 0.008, 6, 40]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={PLAYER.hat}
				ink={CHARACTER_INK}
				position={[0, 0.02, 0]}
				rim={0.3}
				scale={[1, 0.92, 1]}
			>
				<sphereGeometry
					args={[0.24, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.5]}
				/>
			</ToonMesh>
			<ToonMesh color={PLAYER.hatBand} position={[0, 0.07, 0]}>
				<cylinderGeometry args={[0.236, 0.242, 0.075, 32, 1, true]} />
			</ToonMesh>
		</group>
	);
}

/**
 * One scarf tail: a wide ribbon in two segments (the lower one flutters)
 * lying down the back from the knot, so from the follow camera it reads as
 * a red scarf on the traveler's back; walking lifts it into the wind.
 */
function ScarfTail({
	length,
	side,
	tailRef,
}: {
	/** Relative length: the two tails differ, like a knotted scarf. */
	length: number;
	side: number;
	tailRef: RefObject<Group | null>;
}) {
	return (
		<group position={[side * 0.04, 0, 0]} rotation={[0, 0, side * 0.14]}>
			<ToonMesh
				color={PLAYER.scarf}
				ink={CHARACTER_INK}
				position={[0, -0.11 * length, 0]}
				rim={CHARACTER_RIM}
				scale={[2.2, length, 0.34]}
			>
				<capsuleGeometry args={[0.044, 0.17, 4, 10]} />
			</ToonMesh>
			<group position={[0, -0.23 * length, 0]} ref={tailRef}>
				<ToonMesh
					color={PLAYER.scarf}
					ink={CHARACTER_INK}
					position={[0, -0.1 * length, 0]}
					rim={CHARACTER_RIM}
					scale={[1.9, length, 0.32]}
				>
					<capsuleGeometry args={[0.04, 0.15, 4, 10]} />
				</ToonMesh>
			</group>
		</group>
	);
}

/**
 * Cream tunic with a gold hem, a long red scarf whose two tails trail
 * behind (so it reads from the follow camera), sleeves and boots.
 */
function PlayerOutfit({
	scarfRef,
	tailRefs,
}: {
	scarfRef: RefObject<Group | null>;
	tailRefs: readonly [RefObject<Group | null>, RefObject<Group | null>];
}) {
	return (
		<>
			{[-1, 1].map((side) => (
				<ToonMesh
					castShadow
					color={SHOE_COLOR}
					ink={CHARACTER_INK}
					key={`shoe${side}`}
					position={[side * 0.085, 0.05, 0.03]}
					scale={[1, 0.72, 1.3]}
				>
					<sphereGeometry args={[0.075, 14, 10]} />
				</ToonMesh>
			))}
			<ToonMesh
				castShadow
				color={PLAYER.tunic}
				ink={CHARACTER_INK}
				position={[0, BODY_Y, 0]}
				rim={CHARACTER_RIM}
				scale={[1, 1, 0.92]}
			>
				<capsuleGeometry args={[0.165, 0.12, 6, 16]} />
			</ToonMesh>
			<ToonMesh
				color={PLAYER.tunicTrim}
				position={[0, BODY_Y - 0.12, 0]}
				rotation={[Math.PI / 2, 0, 0]}
			>
				<torusGeometry args={[0.155, 0.022, 8, 24]} />
			</ToonMesh>
			{[-1, 1].map((side) => (
				<ToonMesh
					castShadow
					color={PLAYER.tunic}
					ink={CHARACTER_INK}
					key={`arm${side}`}
					position={[side * 0.19, BODY_Y + 0.02, 0.02]}
					rim={CHARACTER_RIM}
					rotation={[0.15, 0, side * 0.42]}
				>
					<capsuleGeometry args={[0.05, 0.13, 4, 10]} />
				</ToonMesh>
			))}
			<ToonMesh
				color={PLAYER.scarf}
				ink={CHARACTER_INK}
				position={[0, BODY_Y + 0.2, 0]}
				rim={CHARACTER_RIM}
				rotation={[Math.PI / 2 + 0.1, 0, 0]}
			>
				<torusGeometry args={[0.135, 0.055, 10, 22]} />
			</ToonMesh>
			<TravelerCape />
			<group
				position={[0.05, BODY_Y + 0.22, -0.2]}
				ref={scarfRef}
				rotation={[SCARF_REST, 0, 0]}
			>
				<ScarfTail length={0.62} side={-1} tailRef={tailRefs[0]} />
				<ScarfTail length={0.76} side={1} tailRef={tailRefs[1]} />
			</group>
		</>
	);
}

/**
 * How far the scarf tails lift off the back (radians from hanging): lying
 * down the cape at rest (two red ribbons on cream from behind), streaming
 * out behind while walking.
 */
const SCARF_REST = 0.42;
const SCARF_WALK = 1.05;

/**
 * A short cream traveler's cape with a gold hem over the back, from the
 * shoulders to the hips: from the follow camera it gives the player a
 * clear, light back shape under the hat, with the red scarf over it.
 */
function TravelerCape() {
	return (
		<group position={[0, BODY_Y + 0.02, 0]}>
			<mesh castShadow position={[0, 0, -0.01]}>
				<cylinderGeometry
					args={[
						0.175,
						0.27,
						0.44,
						24,
						1,
						true,
						Math.PI / 2 + 0.3,
						Math.PI - 0.6,
					]}
				/>
				<ToonMaterial
					color={PLAYER.cape}
					rim={CHARACTER_RIM}
					side={DOUBLE_SIDE}
				/>
			</mesh>
			<mesh position={[0, -0.2, -0.01]}>
				<cylinderGeometry
					args={[
						0.268,
						0.276,
						0.045,
						24,
						1,
						true,
						Math.PI / 2 + 0.3,
						Math.PI - 0.6,
					]}
				/>
				<ToonMaterial color={PLAYER.capeHem} side={DOUBLE_SIDE} />
			</mesh>
		</group>
	);
}

/**
 * The traveler's locks: the fringe and the face-framing locks; the back is
 * cut short at the nape, so the cape and scarf read from behind.
 */
const PLAYER_LOCKS: readonly PartSpec[] = [
	// Rooted under the hat brim, so no lock pokes up through the straw.
	...fringe(0.09),
	...SIDE_LOCKS,
	...EAR_TUFTS,
];

/** Head and hair: a warm brown crop with a jagged fringe under the hat. */
function PlayerHead() {
	return (
		<>
			<ToonMesh
				castShadow
				color={PLAYER.skin}
				face
				ink={CHARACTER_INK}
				position={[0, HEAD_Y, 0]}
				rim={HEAD_RIM}
			>
				<sphereGeometry args={[HEAD_RADIUS, 28, 20]} />
			</ToonMesh>
			<HairMesh
				ink
				position={[0, HEAD_Y + 0.03, -0.07]}
				scale={[0.98, 0.86, 0.84]}
			>
				<sphereGeometry args={[HEAD_RADIUS + 0.02, 24, 16]} />
			</HairMesh>
			<HairMesh
				position={[0, HEAD_Y + 0.035, -0.05]}
				rotation={[-0.72, 0, 0]}
				scale={[1.05, 0.98, 1.03]}
			>
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
			</HairMesh>
			{PLAYER_LOCKS.map((part) => (
				<ToonMesh
					color={PLAYER.hair}
					ink={LOCK_INK}
					key={part.position.join(",")}
					position={part.position}
					rim={HEAD_RIM}
					rotation={part.rotation}
					scale={part.scale}
				>
					<PartShape kind="point" />
				</ToonMesh>
			))}
		</>
	);
}

/** A hair mass with the anime sheen band (and an optional ink outline). */
function HairMesh({
	children,
	ink = false,
	position,
	rotation,
	scale,
}: {
	children: ReactNode;
	ink?: boolean;
	position: Vec3;
	rotation?: Vec3;
	scale: Vec3;
}) {
	const main = useRef<Mesh>(null);
	const hull = useRef<Mesh>(null);
	useLayoutEffect(() => {
		if (!(ink && main.current && hull.current)) {
			return;
		}
		const geometry = hullGeometry(main.current.geometry);
		hull.current.geometry = geometry;
		return () => geometry.dispose();
	}, [ink]);
	return (
		<group position={position} rotation={rotation} scale={scale}>
			<mesh castShadow ref={main}>
				{children}
				<ToonMaterial color={PLAYER.hair} rim={HEAD_RIM} sheen={HAIR_SHEEN} />
			</mesh>
			{ink ? (
				<mesh ref={hull}>
					<InkMaterial color={PLAYER.hair} width={CHARACTER_INK} />
				</mesh>
			) : null}
		</group>
	);
}

/** Dust puffs kicked up at each landing. */
const PUFF_COUNT = 8;
const PUFF_LIFE = 0.45;

interface Puff {
	age: number;
	x: number;
	z: number;
}

function DustPuffs({ puffs }: { puffs: RefObject<Puff[]> }) {
	const ref = useRef<InstancedMesh>(null);
	useFrame((_, delta) => {
		const mesh = ref.current;
		if (!mesh) {
			return;
		}
		const items = puffs.current.map((puff) => {
			puff.age += delta;
			const t = Math.min(1, puff.age / PUFF_LIFE);
			const size = (0.06 + t * 0.1) * (1 - t * t);
			return {
				position: [puff.x, 0.05 + t * 0.12, puff.z] as Vec3,
				scale: Math.max(0, size),
			};
		});
		puffs.current = puffs.current.filter((puff) => puff.age < PUFF_LIFE);
		while (items.length < PUFF_COUNT) {
			items.push({ position: [0, -5, 0], scale: 0 });
		}
		writeInstances(mesh, items.slice(0, PUFF_COUNT));
	});
	return (
		<instancedMesh
			args={[undefined, undefined, PUFF_COUNT]}
			frustumCulled={false}
			ref={ref}
		>
			<sphereGeometry args={[1, 12, 8]} />
			<ToonMaterial
				color={VILLAGER_FEATURES.thoughtBubble}
				opacity={0.85}
				transparent
			/>
		</instancedMesh>
	);
}

/**
 * The player: a traveler in a straw hat and red scarf. Walks between tiles
 * with a squash-and-stretch hop per tile and turns toward the walking
 * direction; each landing kicks up a puff of dust. The group ref is shared
 * so the camera and nearby agents can follow it.
 */
export function PlayerCharacter({
	faceToward,
	facing,
	groupRef,
	marker,
	reducedMotion,
	target,
}: {
	/**
	 * The agent being talked to: the player turns to face it, opened a
	 * little toward the lens, instead of facing the way it walked.
	 */
	faceToward: Vec3 | null;
	facing: WorldDirection;
	groupRef: RefObject<Group | null>;
	/**
	 * Show the "You" marker. Off while an agent is in reach (the reach ring
	 * and the talk prompt say where you are) and through a conversation.
	 */
	marker: boolean;
	reducedMotion: boolean;
	target: Vec3;
}) {
	const bodyRef = useRef<Group>(null);
	const scarfRef = useRef<Group>(null);
	const tailLeft = useRef<Group>(null);
	const tailRight = useRef<Group>(null);
	const puffs = useRef<Puff[]>([]);
	const lastPhase = useRef(0);
	const squash = useRef(0);
	// Only the first position is a prop; later steps glide there in useFrame.
	const [spawn] = useState(() => target);
	const [spawnYaw] = useState(() => FACING_YAW[facing]);

	useFrame(({ camera, clock }, delta) => {
		const root = groupRef.current;
		const body = bodyRef.current;
		if (!(root && body)) {
			return;
		}
		const dx = target[0] - root.position.x;
		const dz = target[2] - root.position.z;
		const distance = Math.hypot(dx, dz);
		const step = reducedMotion
			? distance
			: Math.min(
					distance,
					distance * Math.min(1, delta * PLAYER_GLIDE),
					PLAYER_SPEED * delta
				);
		if (distance > 0) {
			root.position.x += (dx / distance) * step;
			root.position.z += (dz / distance) * step;
		}
		const remaining = distance - step;
		let wantedYaw = FACING_YAW[facing];
		if (faceToward) {
			const toAgent = Math.atan2(
				faceToward[0] - root.position.x,
				faceToward[2] - root.position.z
			);
			const toLens = Math.atan2(
				camera.position.x - root.position.x,
				camera.position.z - root.position.z
			);
			// Turned to the agent, opened only a little toward the lens.
			wantedYaw = toAgent + shortestAngle(toAgent, toLens) * 0.15;
		}
		body.rotation.y += reducedMotion
			? shortestAngle(body.rotation.y, wantedYaw)
			: shortestAngle(body.rotation.y, wantedYaw) *
				Math.min(1, delta * PLAYER_TURN);
		if (reducedMotion) {
			body.position.y = 0;
			body.scale.set(1, 1, 1);
			return;
		}
		const moving = remaining > 0.02;
		// One hop per tile crossed, however far the walk.
		const phase = moving ? remaining % 1 : 0;
		const landed =
			(moving && phase > lastPhase.current + 0.3) ||
			(!moving && lastPhase.current > 0.02);
		if (landed) {
			squash.current = 1;
			for (const side of [-1, 1]) {
				puffs.current.push({
					age: 0,
					x: root.position.x + side * 0.16,
					z: root.position.z + 0.06,
				});
			}
		}
		lastPhase.current = phase;
		const air = moving ? Math.sin(phase * Math.PI) : 0;
		squash.current = Math.max(0, squash.current - delta * 7);
		body.position.y = air * HOP_HEIGHT;
		const stretch = 1 + air * 0.1 - squash.current * 0.14;
		const wide = 1 / Math.sqrt(stretch);
		const breathe = moving ? 0 : Math.sin(clock.elapsedTime * 2.2) * 0.015;
		body.scale.set(wide, stretch + breathe, wide);
		body.rotation.z = moving ? Math.sin(clock.elapsedTime * 16) * 0.05 : 0;
		const scarf = scarfRef.current;
		const time = clock.elapsedTime;
		if (scarf) {
			// Tails stream out behind while walking, drift back at rest.
			// Lifted off the back even at rest, so they read under the brim.
			scarf.rotation.x =
				(moving ? SCARF_WALK : SCARF_REST) + Math.sin(time * 9) * 0.06;
		}
		for (const [index, tail] of [
			tailLeft.current,
			tailRight.current,
		].entries()) {
			if (tail) {
				const flutter = Math.sin(time * 11 + index * 1.4);
				tail.rotation.x = moving ? 0.4 + flutter * 0.22 : 0.2 + flutter * 0.07;
			}
		}
		// Before the follow camera (-1), so it frames this frame's position.
	}, PLAYER_FRAME_PRIORITY);

	return (
		<>
			<group position={spawn} ref={groupRef}>
				<group ref={bodyRef} rotation={[0, spawnYaw, 0]}>
					<PlayerOutfit scarfRef={scarfRef} tailRefs={[tailLeft, tailRight]} />
					<PlayerHead />
					<PlayerFace />
					<StrawHat />
				</group>
			</group>
			{marker ? (
				<FollowAnchor height={MARKER_HEIGHT} target={groupRef}>
					<PlayerMarker reducedMotion={reducedMotion} />
				</FollowAnchor>
			) : null}
			{reducedMotion ? null : <DustPuffs puffs={puffs} />}
		</>
	);
}

/** Height of the "You" marker over the player's feet. */
const MARKER_HEIGHT = 1.75;

/**
 * A top-level anchor that follows `target` every frame (and drops with the
 * ground under it), so DOM overlays stay pinned to a moving character.
 */
function FollowAnchor({
	children,
	height,
	target,
}: {
	children: ReactNode;
	height: number;
	target: RefObject<Group | null>;
}) {
	const ref = useRef<Group>(null);
	useFrame(() => {
		const anchor = ref.current;
		const followed = target.current;
		if (!(anchor && followed)) {
			return;
		}
		const { x, z } = followed.position;
		anchor.position.set(x, height - curveDrop(x, z), z);
		anchor.updateWorldMatrix(true, false);
	}, -0.5);
	return <group ref={ref}>{children}</group>;
}

/**
 * A bobbing diamond above the player's head labeled "You", in the theme's
 * primary color and drawn in the DOM so it stays crisp at any zoom. The
 * player leaves it out (unmounts it) while an agent is in reach or a
 * conversation is open, so it never sits over a roof or a face.
 */
function PlayerMarker({ reducedMotion }: { reducedMotion: boolean }) {
	return (
		<Html center zIndexRange={[50, 0]}>
			<motion.svg
				animate={reducedMotion ? { y: 0 } : { y: [0, -4, 0] }}
				aria-label="You"
				className="block"
				height="16"
				role="img"
				transition={
					reducedMotion
						? { duration: 0 }
						: {
								duration: 1.4,
								ease: "easeInOut",
								repeat: Number.POSITIVE_INFINITY,
							}
				}
				viewBox="0 0 16 16"
				width="16"
			>
				<path
					className="fill-primary stroke-background"
					d="M8 1.5 14.5 8 8 14.5 1.5 8Z"
					strokeLinejoin="round"
					strokeWidth="1.5"
				/>
			</motion.svg>
		</Html>
	);
}
