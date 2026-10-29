/* eslint-disable react/no-unknown-property */
import { RoundedBoxGeometry } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { useMemo, useRef } from "react";
import type { Group, Mesh } from "three";
import {
	type AquariumActHandlers,
	AquariumActProps,
	type CreaturePlateAct,
	type CreatureTarget,
} from "./aquarium-acts.tsx";
import { CreatureSchool } from "./aquarium-creatures.tsx";
import {
	PLINTH,
	ROOM_FLOOR,
	SAND,
	TANK_FLOOR,
	TANK_SURFACE,
	TANK_TOP,
	type TankLayout,
	WALL_GAP,
} from "./aquarium-layout.ts";
import type { Creature } from "./aquarium-model.ts";
import {
	type AquariumWallpaper,
	hexColor,
	mixRgb,
	roomFittings,
	TANK_FITTINGS,
	type TankFittings,
	type TankPalette,
} from "./aquarium-palette.ts";
import type { OffStage, YouSpotSlot } from "./game3d-acts.ts";
import { CurvedBasicMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";

/**
 * The Aquarium as an isometric diorama on the game kit (game3d-stage.tsx):
 * a big glass tank on a wooden cabinet in a room (a board floor, a rug,
 * two walls with a window, a plant in the corner). Inside, a sand floor with rocks, coral, kelp and
 * starfish; above it the water (a translucent toon volume with a rippling
 * surface and glints on the glass). Each agent is a chunky cel-shaded
 * creature (reef fish, angelfish, jellyfish, sea turtle or manta ray) in
 * its own colours, swimming a small loop around its own spot in the tank:
 * high and brisk with a bubble trail while it works, low and slow near the
 * reef when idle. A creature whose run failed carries a pearl. At night
 * the reef glows: coral tips, jellyfish and spots on every creature.
 * Each creature has a kit name plate with the kit's status badge.
 */

// ---------------------------------------------------------------------------
// The tank and its reef
// ---------------------------------------------------------------------------

function Sphere({
	color,
	position,
	scale,
}: {
	color: string;
	position?: Vec3;
	scale: Vec3 | number;
}) {
	return (
		<ToonMesh color={color} position={position} scale={scale}>
			<sphereGeometry args={[0.5, 16, 12]} />
		</ToonMesh>
	);
}

/** A night glow (unlit, so the bloom catches it). */
function GlowDot({
	color,
	position,
	size,
}: {
	color: string;
	position: Vec3;
	size: number;
}) {
	return (
		<mesh position={position} raycast={() => null} scale={size}>
			<sphereGeometry args={[0.5, 10, 8]} />
			<CurvedBasicMaterial color={color} toneMapped={false} />
		</mesh>
	);
}

interface ReefPlan {
	brains: { at: Vec3; size: number; tone: number }[];
	branches: { at: Vec3; size: number; tone: number }[];
	fans: { at: Vec3; size: number; tone: number; yaw: number }[];
	kelp: { at: Vec3; height: number; tone: number }[];
	rocks: { at: Vec3; size: number; tone: number; yaw: number }[];
	stars: { at: Vec3; tone: number; yaw: number }[];
	tubes: { at: Vec3; size: number; tone: number }[];
}

/** The reef's furniture, hugging the back and the sides of the tank. */
export function planReef(halfWidth: number, halfDepth: number): ReefPlan {
	const floor = TANK_FLOOR;
	const plan: ReefPlan = {
		brains: [],
		branches: [],
		fans: [],
		kelp: [],
		rocks: [],
		stars: [],
		tubes: [],
	};
	const back = -halfDepth + 0.35;
	const left = -halfWidth + 0.35;
	let step = 0;
	for (let x = left + 0.3; x < halfWidth - 0.3; x += 0.62) {
		step += 1;
		const wobble = jitter(step, 1, 11);
		plan.kelp.push({
			at: [x + (wobble - 0.5) * 0.2, floor, back + jitter(step, 2, 11) * 0.25],
			height: 1.7 + jitter(step, 3, 11) * 1.1,
			tone: step % 2,
		});
	}
	for (let z = back + 0.7; z < halfDepth - 0.6; z += 0.7) {
		step += 1;
		plan.kelp.push({
			at: [left + jitter(step, 2, 13) * 0.2, floor, z],
			height: 1.4 + jitter(step, 3, 13) * 0.9,
			tone: step % 2,
		});
	}
	plan.rocks.push(
		{ at: [left + 0.5, floor, back + 0.5], size: 0.85, tone: 0, yaw: 0.4 },
		{ at: [left + 1.1, floor, back + 0.35], size: 0.55, tone: 1, yaw: 1.3 },
		{
			at: [halfWidth - 0.6, floor, back + 0.55],
			size: 0.75,
			tone: 1,
			yaw: 2.2,
		},
		{
			at: [halfWidth - 0.45, floor, halfDepth - 0.5],
			size: 0.5,
			tone: 0,
			yaw: 0.9,
		},
		{ at: [-0.2, floor, back + 0.3], size: 0.6, tone: 0, yaw: 2.9 }
	);
	plan.brains.push(
		{ at: [left + 0.55, floor + 0.32, back + 0.5], size: 0.42, tone: 0 },
		{ at: [halfWidth - 1.3, floor, back + 0.4], size: 0.5, tone: 3 },
		{ at: [left + 0.4, floor, halfDepth - 0.5], size: 0.38, tone: 2 }
	);
	plan.branches.push(
		{ at: [halfWidth - 0.65, floor + 0.28, back + 0.55], size: 0.75, tone: 1 },
		{ at: [0.9, floor, back + 0.35], size: 0.9, tone: 0 },
		{ at: [left + 0.45, floor, 0.4], size: 0.7, tone: 3 }
	);
	plan.fans.push(
		{ at: [-1.1, floor, back + 0.25], size: 0.9, tone: 2, yaw: 0.1 },
		{
			at: [halfWidth - 0.35, floor, -0.3],
			size: 0.8,
			tone: 0,
			yaw: Math.PI / 2,
		}
	);
	plan.tubes.push(
		{ at: [halfWidth - 0.6, floor, halfDepth - 0.85], size: 0.8, tone: 2 },
		{ at: [2 - halfWidth, floor, halfDepth - 0.45], size: 0.65, tone: 1 },
		{ at: [0.2, floor, halfDepth - 0.35], size: 0.55, tone: 3 }
	);
	plan.stars.push(
		{ at: [-0.6, floor, halfDepth - 0.7], tone: 0, yaw: 0.3 },
		{ at: [1.4, floor, 0.1], tone: 1, yaw: 1.1 },
		{ at: [halfWidth - 1.4, floor, halfDepth - 0.4], tone: 2, yaw: 2 }
	);
	return plan;
}

function Kelp({
	color,
	height,
	reduced,
	seed,
	tip,
	at,
}: {
	at: Vec3;
	color: string;
	height: number;
	reduced: boolean;
	seed: number;
	tip: string;
}) {
	const ref = useRef<Group>(null);
	useFrame(({ clock }) => {
		if (!ref.current || reduced) {
			return;
		}
		const time = clock.elapsedTime * 0.8 + seed;
		ref.current.rotation.set(
			Math.sin(time) * 0.07,
			0,
			Math.cos(time * 0.8) * 0.09
		);
	});
	const leaves = Math.max(2, Math.round(height / 0.55));
	return (
		<group position={at} ref={ref}>
			<ToonMesh color={color} position={[0, height / 2, 0]}>
				<cylinderGeometry args={[0.03, 0.05, height, 6]} />
			</ToonMesh>
			{Array.from({ length: leaves }, (_, index) => {
				const y = ((index + 0.7) / leaves) * height;
				const side = index % 2 === 0 ? 1 : -1;
				return (
					<ToonMesh
						color={index === leaves - 1 ? tip : color}
						ink={0.016}
						key={index}
						position={[0.12 * side, y, 0.02 * side]}
						rotation={[0, seed + index, 0.7 * side]}
						scale={[0.36, 0.12, 0.05]}
					>
						<sphereGeometry args={[0.5, 12, 8]} />
					</ToonMesh>
				);
			})}
		</group>
	);
}

const STAR_ARMS = [0, 1, 2, 3, 4];
const TUBE_RING = [0, 1, 2, 3, 4];
const BRANCH_ARMS = [0, 1, 2, 3];

function Reef({
	halfDepth,
	halfWidth,
	night,
	palette,
	reduced,
}: {
	halfDepth: number;
	halfWidth: number;
	night: boolean;
	palette: TankPalette;
	reduced: boolean;
}) {
	const plan = useMemo(
		() => planReef(halfWidth, halfDepth),
		[halfDepth, halfWidth]
	);
	const fittings = TANK_FITTINGS[palette.mode];
	const coral = palette.coral.map(hexColor);
	const glow = palette.glowSpots.map(hexColor);
	const rock = palette.rock.map(hexColor);
	const kelp = palette.kelp.map(hexColor);
	const kelpTip = hexColor(palette.kelpTip);
	const tipColor = (tone: number) =>
		night ? (glow[tone % glow.length] ?? kelpTip) : (coral[tone] ?? kelpTip);
	return (
		<group>
			{plan.kelp.map((stalk, index) => (
				<Kelp
					at={stalk.at}
					color={kelp[stalk.tone] ?? kelpTip}
					height={stalk.height}
					key={stalk.at.join()}
					reduced={reduced}
					seed={index * 1.7}
					tip={night ? (glow[index % glow.length] ?? kelpTip) : kelpTip}
				/>
			))}
			{plan.rocks.map((stone) => (
				<ToonMesh
					color={rock[stone.tone] ?? kelpTip}
					ink={0.03}
					key={stone.at.join()}
					position={[stone.at[0], stone.at[1] + stone.size * 0.22, stone.at[2]]}
					rotation={[0.2, stone.yaw, 0.1]}
					scale={[stone.size, stone.size * 0.62, stone.size * 0.85]}
				>
					<dodecahedronGeometry args={[0.5, 0]} />
				</ToonMesh>
			))}
			{plan.brains.map((brain) => (
				<group key={brain.at.join()} position={brain.at}>
					<ToonMesh
						color={coral[brain.tone] ?? kelpTip}
						ink={0.024}
						scale={[brain.size, brain.size * 0.7, brain.size]}
					>
						<sphereGeometry
							args={[0.5, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2]}
						/>
					</ToonMesh>
					<ToonMesh
						color={tipColor(brain.tone + 1)}
						position={[0, brain.size * 0.3, 0]}
						rotation={[Math.PI / 2, 0, 0]}
						scale={brain.size}
					>
						<torusGeometry args={[0.24, 0.035, 6, 18]} />
					</ToonMesh>
				</group>
			))}
			{plan.branches.map((branch) => (
				<group key={branch.at.join()} position={branch.at} scale={branch.size}>
					{BRANCH_ARMS.map((arm) => {
						const angle = arm * 1.7;
						const lean = 0.35 + (arm % 2) * 0.2;
						const length = 0.55 + (arm % 3) * 0.12;
						const x = Math.cos(angle) * Math.sin(lean) * length;
						const z = Math.sin(angle) * Math.sin(lean) * length;
						const y = Math.cos(lean) * length;
						return (
							<group key={arm}>
								<ToonMesh
									color={coral[branch.tone] ?? kelpTip}
									ink={0.02}
									position={[x / 2, y / 2, z / 2]}
									rotation={[
										Math.sin(angle) * lean,
										0,
										-Math.cos(angle) * lean,
									]}
								>
									<capsuleGeometry args={[0.06, length, 4, 8]} />
								</ToonMesh>
								{night ? (
									<GlowDot
										color={tipColor(branch.tone)}
										position={[x, y + 0.04, z]}
										size={0.11}
									/>
								) : (
									<Sphere
										color={tipColor(branch.tone + 2)}
										position={[x, y + 0.04, z]}
										scale={0.12}
									/>
								)}
							</group>
						);
					})}
				</group>
			))}
			{plan.fans.map((fan) => (
				<group
					key={fan.at.join()}
					position={fan.at}
					rotation={[0, fan.yaw, 0]}
					scale={fan.size}
				>
					<ToonMesh
						color={coral[fan.tone] ?? kelpTip}
						ink={0.02}
						position={[0, 0.5, 0]}
						scale={[1, 1, 0.12]}
					>
						<sphereGeometry
							args={[0.45, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2]}
						/>
					</ToonMesh>
					<ToonMesh color={coral[fan.tone] ?? kelpTip} position={[0, 0.25, 0]}>
						<cylinderGeometry args={[0.04, 0.06, 0.5, 6]} />
					</ToonMesh>
				</group>
			))}
			{plan.tubes.map((tube) => (
				<group key={tube.at.join()} position={tube.at} scale={tube.size}>
					{TUBE_RING.map((index) => {
						const angle = (index / TUBE_RING.length) * Math.PI * 2;
						const height = 0.35 + (index % 3) * 0.14;
						const x = Math.cos(angle) * 0.14;
						const z = Math.sin(angle) * 0.14;
						return (
							<group key={index} position={[x, 0, z]}>
								<ToonMesh
									color={coral[tube.tone] ?? kelpTip}
									ink={0.018}
									position={[0, height / 2, 0]}
								>
									<cylinderGeometry args={[0.07, 0.08, height, 8, 1, true]} />
								</ToonMesh>
								{night ? (
									<GlowDot
										color={tipColor(tube.tone)}
										position={[0, height, 0]}
										size={0.12}
									/>
								) : (
									<Sphere
										color={tipColor(tube.tone + 1)}
										position={[0, height, 0]}
										scale={[0.13, 0.05, 0.13]}
									/>
								)}
							</group>
						);
					})}
				</group>
			))}
			{plan.stars.map((star) => (
				<group
					key={star.at.join()}
					position={[star.at[0], star.at[1] + 0.03, star.at[2]]}
					rotation={[0, star.yaw, 0]}
				>
					{STAR_ARMS.map((arm) => {
						const angle = (arm / STAR_ARMS.length) * Math.PI * 2;
						return (
							<ToonMesh
								color={fittings.shells[star.tone] ?? kelpTip}
								ink={0.014}
								key={arm}
								position={[Math.cos(angle) * 0.1, 0, Math.sin(angle) * 0.1]}
								rotation={[0, -angle, 0]}
								scale={[0.24, 0.05, 0.09]}
							>
								<sphereGeometry args={[0.5, 10, 6]} />
							</ToonMesh>
						);
					})}
				</group>
			))}
		</group>
	);
}

const NO_HIT = () => null;

/** Rings of light spreading on the surface. */
function Ripples({
	color,
	halfDepth,
	halfWidth,
	reduced,
}: {
	color: string;
	halfDepth: number;
	halfWidth: number;
	reduced: boolean;
}) {
	const rings = useRef<(Mesh | null)[]>([]);
	const spots = useMemo<[number, number][]>(
		() => [
			[-halfWidth * 0.45, -halfDepth * 0.3],
			[halfWidth * 0.35, halfDepth * 0.25],
			[halfWidth * 0.05, -halfDepth * 0.5],
		],
		[halfDepth, halfWidth]
	);
	useFrame(({ clock }) => {
		for (const [index, ring] of rings.current.entries()) {
			if (!ring) {
				continue;
			}
			const age = reduced ? 0.5 : (clock.elapsedTime * 0.25 + index / 3) % 1;
			const size = 0.25 + age * 0.7;
			ring.scale.set(size, size, size);
			const material = ring.material as { opacity: number };
			material.opacity = (1 - age) * 0.6;
		}
	});
	return (
		<>
			{spots.map(([x, z], index) => (
				<mesh
					key={`${x}:${z}`}
					position={[x, TANK_SURFACE + 0.012, z]}
					raycast={NO_HIT}
					ref={(node) => {
						rings.current[index] = node;
					}}
					renderOrder={5}
					rotation={[-Math.PI / 2, 0, 0]}
				>
					<ringGeometry args={[0.85, 1, 40]} />
					<CurvedBasicMaterial
						color={color}
						depthWrite={false}
						opacity={0.5}
						transparent
					/>
				</mesh>
			))}
		</>
	);
}

function Tank({
	halfDepth,
	halfWidth,
	night,
	onDismiss,
	palette,
	reduced,
}: {
	halfDepth: number;
	halfWidth: number;
	night: boolean;
	onDismiss: () => void;
	palette: TankPalette;
	reduced: boolean;
}) {
	const fittings = TANK_FITTINGS[palette.mode];
	const width = halfWidth * 2;
	const depth = halfDepth * 2;
	const water = TANK_SURFACE - TANK_FLOOR;
	const glassHeight = TANK_TOP - PLINTH;
	const sand = hexColor(mixRgb(palette.sand[0], palette.water.mid, 0.2));
	const sandDeep = hexColor(palette.sand[1]);
	const corners: [number, number][] = [
		[halfWidth, halfDepth],
		[-halfWidth, halfDepth],
		[halfWidth, -halfDepth],
		[-halfWidth, -halfDepth],
	];
	return (
		<group>
			<group
				onClick={(event) => {
					event.stopPropagation();
					onDismiss();
				}}
			>
				<Cabinet depth={depth} fittings={fittings} width={width} />
				<ToonMesh color={sandDeep} position={[0, PLINTH + SAND * 0.3, 0]}>
					<boxGeometry args={[width, SAND * 0.6, depth]} />
				</ToonMesh>
				<ToonMesh color={sand} position={[0, PLINTH + SAND * 0.8, 0]}>
					<boxGeometry args={[width, SAND * 0.4, depth]} />
				</ToonMesh>
			</group>
			{/* The water: its far walls deep, its near walls a light tint. */}
			<mesh
				position={[0, TANK_FLOOR + water / 2, 0]}
				raycast={NO_HIT}
				renderOrder={1}
			>
				<boxGeometry args={[width - 0.02, water, depth - 0.02]} />
				<CurvedBasicMaterial
					color={hexColor(palette.water.mid)}
					depthWrite={false}
					opacity={0.88}
					side={1}
					transparent
				/>
			</mesh>
			{/* The side panes facing the camera (back faces cull the far ones). */}
			{[
				{ at: [0, 0, halfDepth] as Vec3, span: width, yaw: 0 },
				{ at: [0, 0, -halfDepth] as Vec3, span: width, yaw: Math.PI },
				{ at: [halfWidth, 0, 0] as Vec3, span: depth, yaw: Math.PI / 2 },
				{ at: [-halfWidth, 0, 0] as Vec3, span: depth, yaw: -Math.PI / 2 },
			].map((pane) => (
				<mesh
					key={pane.yaw}
					position={[pane.at[0], TANK_FLOOR + water / 2, pane.at[2]]}
					raycast={NO_HIT}
					renderOrder={4}
					rotation={[0, pane.yaw, 0]}
				>
					<planeGeometry args={[pane.span, water]} />
					<CurvedBasicMaterial
						color={hexColor(palette.water.mid)}
						depthWrite={false}
						opacity={night ? 0.38 : 0.34}
						transparent
					/>
				</mesh>
			))}
			<mesh
				position={[0, TANK_SURFACE, 0]}
				raycast={NO_HIT}
				renderOrder={4}
				rotation={[-Math.PI / 2, 0, 0]}
			>
				<planeGeometry args={[width - 0.02, depth - 0.02]} />
				<CurvedBasicMaterial
					color={hexColor(palette.water.surface)}
					depthWrite={false}
					opacity={night ? 0.12 : 0.16}
					transparent
				/>
			</mesh>
			{/* The water line along the glass. */}
			{[
				{ at: [0, halfDepth] as const, size: [width, 0.05, 0.05] as Vec3 },
				{ at: [0, -halfDepth] as const, size: [width, 0.05, 0.05] as Vec3 },
				{ at: [halfWidth, 0] as const, size: [0.05, 0.05, depth] as Vec3 },
				{ at: [-halfWidth, 0] as const, size: [0.05, 0.05, depth] as Vec3 },
			].map((line) => (
				<mesh
					key={line.at.join()}
					position={[line.at[0], TANK_SURFACE, line.at[1]]}
					raycast={NO_HIT}
					renderOrder={5}
				>
					<boxGeometry args={line.size} />
					<CurvedBasicMaterial
						color={fittings.ripple}
						depthWrite={false}
						opacity={0.85}
						transparent
					/>
				</mesh>
			))}
			{night ? (
				<pointLight
					color={hexColor(palette.glowSpots[0])}
					decay={1.2}
					distance={width * 1.6}
					intensity={2.4}
					position={[0, TANK_FLOOR + 1.2, 0]}
				/>
			) : null}
			<Ripples
				color={fittings.ripple}
				halfDepth={halfDepth}
				halfWidth={halfWidth}
				reduced={reduced}
			/>
			{/* Glints on the two near panes. */}
			{[0.25, 0.42].map((share) => (
				<group key={share}>
					<mesh
						position={[
							-halfWidth + width * share,
							PLINTH + glassHeight * 0.55,
							halfDepth + 0.012,
						]}
						raycast={NO_HIT}
						renderOrder={6}
						rotation={[0, 0, -0.55]}
					>
						<planeGeometry
							args={[share > 0.3 ? 0.05 : 0.13, glassHeight * 1.05]}
						/>
						<CurvedBasicMaterial
							color={fittings.glint}
							depthWrite={false}
							opacity={0.22}
							transparent
						/>
					</mesh>
					<mesh
						position={[
							halfWidth + 0.012,
							PLINTH + glassHeight * 0.55,
							halfDepth - depth * share,
						]}
						raycast={NO_HIT}
						renderOrder={6}
						rotation={[0, Math.PI / 2, 0.55]}
					>
						<planeGeometry
							args={[share > 0.3 ? 0.05 : 0.13, glassHeight * 1.05]}
						/>
						<CurvedBasicMaterial
							color={fittings.glint}
							depthWrite={false}
							opacity={0.22}
							transparent
						/>
					</mesh>
				</group>
			))}
			{/* The frame: corner posts and rims top and bottom. */}
			{corners.map(([x, z]) => (
				<ToonMesh
					color={fittings.frame}
					ink={0.025}
					key={`${x}:${z}`}
					position={[x, PLINTH + glassHeight / 2, z]}
				>
					<RoundedBoxGeometry
						args={[0.16, glassHeight, 0.16]}
						radius={0.05}
						smoothness={2}
					/>
				</ToonMesh>
			))}
			{[TANK_TOP, PLINTH + 0.06].map((y) => (
				<group key={y}>
					{[halfDepth, -halfDepth].map((z) => (
						<ToonMesh
							color={y > 1 ? fittings.frameTrim : fittings.frame}
							ink={0.022}
							key={z}
							position={[0, y, z]}
						>
							<RoundedBoxGeometry
								args={[width + 0.16, 0.12, 0.14]}
								radius={0.04}
								smoothness={2}
							/>
						</ToonMesh>
					))}
					{[halfWidth, -halfWidth].map((x) => (
						<ToonMesh
							color={y > 1 ? fittings.frameTrim : fittings.frame}
							ink={0.022}
							key={x}
							position={[x, y, 0]}
						>
							<RoundedBoxGeometry
								args={[0.14, 0.12, depth + 0.16]}
								radius={0.04}
								smoothness={2}
							/>
						</ToonMesh>
					))}
				</group>
			))}
		</group>
	);
}

// ---------------------------------------------------------------------------
// The cabinet and the room
// ---------------------------------------------------------------------------

/** The cabinet's height, from the room's floor to the tank's base. */
const CABINET = PLINTH - ROOM_FLOOR;
/** How far the cabinet reaches past the tank on each side. */
const CABINET_LIP = 0.3;
/** How wide one cabinet door is, at most. */
const DOOR_WIDTH = 1.7;

/** A row of cabinet doors across one face, each with its knob. */
function CabinetDoors({
	at,
	fittings,
	length,
	yaw,
}: {
	/** The face's centre, on its surface. */
	at: Vec3;
	fittings: TankFittings;
	length: number;
	yaw: number;
}) {
	const count = Math.max(1, Math.round(length / DOOR_WIDTH));
	const pitch = length / count;
	const height = CABINET - 0.32;
	return (
		<group position={at} rotation={[0, yaw, 0]}>
			{Array.from({ length: count }, (_, index) => {
				const x = -length / 2 + pitch * (index + 0.5);
				// Knobs meet at the middle of each pair of doors.
				const side = index % 2 === 0 ? 1 : -1;
				return (
					<group key={x} position={[x, 0, 0]}>
						<ToonMesh color={fittings.cabinetDoor} ink={0.02}>
							<boxGeometry args={[pitch - 0.12, height, 0.04]} />
						</ToonMesh>
						<ToonMesh
							color={fittings.cabinetKnob}
							position={[side * (pitch / 2 - 0.22), 0.08, 0.05]}
						>
							<sphereGeometry args={[0.05, 10, 8]} />
						</ToonMesh>
					</group>
				);
			})}
		</group>
	);
}

/** The wooden cabinet the tank stands on, doors on its two near faces. */
function Cabinet({
	depth,
	fittings,
	width,
}: {
	depth: number;
	fittings: TankFittings;
	width: number;
}) {
	const outerWidth = width + CABINET_LIP * 2;
	const outerDepth = depth + CABINET_LIP * 2;
	const middle = ROOM_FLOOR + CABINET / 2;
	return (
		<group>
			<ToonMesh color={fittings.cabinet} ink={0.03} position={[0, middle, 0]}>
				<RoundedBoxGeometry
					args={[outerWidth, CABINET, outerDepth]}
					radius={0.06}
					smoothness={3}
				/>
			</ToonMesh>
			<ToonMesh color={fittings.cabinetTop} position={[0, PLINTH - 0.04, 0]}>
				<boxGeometry args={[outerWidth + 0.12, 0.08, outerDepth + 0.12]} />
			</ToonMesh>
			<CabinetDoors
				at={[0, middle, outerDepth / 2]}
				fittings={fittings}
				length={outerWidth - 0.3}
				yaw={0}
			/>
			<CabinetDoors
				at={[outerWidth / 2, middle, 0]}
				fittings={fittings}
				length={outerDepth - 0.3}
				yaw={Math.PI / 2}
			/>
		</group>
	);
}

/** How far the room's floor and walls reach, past every edge of the frame. */
const ROOM_REACH = 40;
const WALL_HEIGHT = 9;
/** The spacing of the floor's boards. */
const BOARD = 0.7;
/** How far the boards' seams run each way from the tank. */
const SEAMS = 14;

/**
 * The room the tank stands in: a board floor with a rug under the cabinet,
 * two walls behind it (the iso camera looks in from the room's open
 * corner) with skirting boards and a window, and a potted plant in the
 * corner. Floor and walls reach past every edge of the frame, so no sky or
 * sea shows round them.
 */
function Room({
	fittings,
	halfDepth,
	halfWidth,
}: {
	fittings: TankFittings;
	halfDepth: number;
	halfWidth: number;
}) {
	const back = -halfDepth - WALL_GAP;
	const left = -halfWidth - WALL_GAP;
	const seams = useMemo(() => {
		const list: number[] = [];
		for (let z = -SEAMS; z <= SEAMS; z += BOARD) {
			list.push(Number(z.toFixed(2)));
		}
		return list;
	}, []);
	const rugWidth = halfWidth * 2 + 2.4;
	const rugDepth = halfDepth * 2 + 2.4;
	return (
		<group raycast={() => null}>
			<ToonMesh color={fittings.floor} position={[0, ROOM_FLOOR - 0.1, 0]}>
				<boxGeometry args={[ROOM_REACH * 2, 0.2, ROOM_REACH * 2]} />
			</ToonMesh>
			{seams.map((z) => (
				<ToonMesh
					color={fittings.floorSeam}
					key={z}
					position={[0, ROOM_FLOOR + 0.004, z]}
				>
					<boxGeometry args={[SEAMS * 2, 0.008, 0.03]} />
				</ToonMesh>
			))}
			<ToonMesh color={fittings.rugEdge} position={[0, ROOM_FLOOR + 0.01, 0]}>
				<boxGeometry args={[rugWidth + 0.3, 0.02, rugDepth + 0.3]} />
			</ToonMesh>
			<ToonMesh color={fittings.rug} position={[0, ROOM_FLOOR + 0.025, 0]}>
				<boxGeometry args={[rugWidth, 0.02, rugDepth]} />
			</ToonMesh>
			{/* The back wall, then the left wall, each with its skirting board. */}
			<ToonMesh
				color={fittings.wall}
				position={[0, ROOM_FLOOR + WALL_HEIGHT / 2, back - 0.1]}
			>
				<boxGeometry args={[ROOM_REACH * 2, WALL_HEIGHT, 0.2]} />
			</ToonMesh>
			<ToonMesh
				color={fittings.wallTrim}
				position={[0, ROOM_FLOOR + 0.14, back + 0.03]}
			>
				<boxGeometry args={[ROOM_REACH * 2, 0.28, 0.06]} />
			</ToonMesh>
			<mesh position={[left - 0.1, ROOM_FLOOR + WALL_HEIGHT / 2, 0]}>
				<boxGeometry args={[0.2, WALL_HEIGHT, ROOM_REACH * 2]} />
				<CurvedBasicMaterial color={fittings.wallSide} />
			</mesh>
			<mesh position={[left + 0.03, ROOM_FLOOR + 0.14, 0]}>
				<boxGeometry args={[0.06, 0.28, ROOM_REACH * 2]} />
				<CurvedBasicMaterial color={fittings.wallTrim} />
			</mesh>
			{/* A window on the back wall, beside the tank. */}
			<group position={[halfWidth + 1.2, ROOM_FLOOR + 3.3, back + 0.02]}>
				<ToonMesh color={fittings.windowFrame} ink={0.02}>
					<boxGeometry args={[1.9, 2.3, 0.06]} />
				</ToonMesh>
				<ToonMesh color={fittings.window} position={[0, 0, 0.035]}>
					<boxGeometry args={[1.6, 2, 0.02]} />
				</ToonMesh>
				<ToonMesh color={fittings.windowFrame} position={[0, 0, 0.05]}>
					<boxGeometry args={[0.07, 2, 0.02]} />
				</ToonMesh>
				<ToonMesh color={fittings.windowFrame} position={[0, 0, 0.05]}>
					<boxGeometry args={[1.6, 0.07, 0.02]} />
				</ToonMesh>
			</group>
			{/* A potted plant in the corner. */}
			<group position={[left + 0.8, ROOM_FLOOR, back + 0.8]}>
				<ToonMesh color={fittings.pot} ink={0.02} position={[0, 0.3, 0]}>
					<cylinderGeometry args={[0.32, 0.24, 0.6, 14]} />
				</ToonMesh>
				{[
					[0, 0.95, 0, 0.62],
					[0.25, 0.8, 0.12, 0.42],
					[-0.22, 0.78, -0.1, 0.4],
				].map(([x = 0, y = 0, z = 0, size = 0.4]) => (
					<ToonMesh
						color={fittings.leaf}
						key={`${x}:${y}`}
						position={[x, y, z]}
						scale={size}
					>
						<sphereGeometry args={[0.5, 12, 10]} />
					</ToonMesh>
				))}
			</group>
		</group>
	);
}

/** Marks the scene's first drawn frame. */
function FirstFrame({ onRendered }: { onRendered: () => void }) {
	const done = useRef(false);
	useFrame(() => {
		if (!done.current) {
			done.current = true;
			onRendered();
		}
	});
	return null;
}

/**
 * The act layer, when the host sends asks (aquarium-acts.tsx): where each
 * creature swims for its act, its plate words, and the act props.
 */
export interface AquariumActScene {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	handlers: AquariumActHandlers;
	offStage: OffStage;
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	plates: ReadonlyMap<string, CreaturePlateAct>;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	targets: ReadonlyMap<string, CreatureTarget>;
}

export interface AquariumDioramaProps {
	actScene?: AquariumActScene | null;
	creatures: readonly Creature[];
	focusedId: string | null;
	layout: TankLayout;
	night: boolean;
	onDismiss: () => void;
	onRendered: () => void;
	onSelect: (agentId: string) => void;
	palette: TankPalette;
	reduced: boolean;
	selectedId: string | null;
	/** The room's wallpaper (the aquarium's `wallpaper` setting). */
	wallpaper?: AquariumWallpaper;
}

export function AquariumDioramaScene({
	actScene = null,
	creatures,
	focusedId,
	layout,
	night,
	onDismiss,
	onRendered,
	onSelect,
	palette,
	reduced,
	selectedId,
	wallpaper = "cream",
}: AquariumDioramaProps) {
	const { halfDepth, halfWidth } = layout;
	const fittings = useMemo(
		() => roomFittings(palette.mode, wallpaper),
		[palette.mode, wallpaper]
	);
	return (
		<group>
			<FirstFrame onRendered={onRendered} />
			<Room fittings={fittings} halfDepth={halfDepth} halfWidth={halfWidth} />
			<Tank
				halfDepth={halfDepth}
				halfWidth={halfWidth}
				night={night}
				onDismiss={onDismiss}
				palette={palette}
				reduced={reduced}
			/>
			<Reef
				halfDepth={halfDepth}
				halfWidth={halfWidth}
				night={night}
				palette={palette}
				reduced={reduced}
			/>
			<CreatureSchool
				creatures={creatures}
				focusedId={focusedId}
				night={night}
				onSelect={onSelect}
				palette={palette}
				plates={actScene?.plates}
				reduced={reduced}
				selectedId={selectedId}
				swims={layout.swims}
				targets={actScene?.targets}
			/>
			{actScene ? (
				<AquariumActProps
					acts={actScene.acts}
					handlers={actScene.handlers}
					layout={layout}
					offStage={actScene.offStage}
					onStage={actScene.onStage}
					owners={actScene.owners}
					palette={{
						// Plan pips are a string of coral beads (a pearl means stopped).
						bubble: hexColor(palette.bubble),
						coral: hexColor(palette.coral[0]),
						pearl: hexColor(palette.coral[1]),
						sand: hexColor(palette.sand[0]),
						shell: hexColor(palette.coral[3]),
					}}
					slots={actScene.slots}
				/>
			) : null}
		</group>
	);
}
