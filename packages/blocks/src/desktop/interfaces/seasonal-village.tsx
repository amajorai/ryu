/* eslint-disable react/no-unknown-property */
import { useMemo } from "react";
import { IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { onIsland } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Benches,
	LampPosts,
	type PlacedProp,
	type PlantedTree,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { linearRgb } from "./game3d-toon.ts";
import { type SeasonSceneProps, Snowfall } from "./seasonal-diorama.tsx";
import { SEASON_3D } from "./seasonal-palette.ts";
import { ADVENT_HOUSE } from "./seasonal-world.ts";

/**
 * Advent: a snowy village square round a big timbered advent house. Its 24
 * numbered doors (the ground row) and windows (the two rows above) face
 * the camera on the house's two front walls: closed ones behind coloured
 * shutters (a gold ribbon on those that need you, plain boards where
 * nothing is behind yet), opened ones lit from inside with the shutters
 * folded back. A lit tree, a snowman, cottages, lamps and snowy pines fill
 * the square, with snow drifting down.
 */

const ART = SEASON_3D.advent;
const [CX, CZ] = ADVENT_HOUSE.centre;
const HALF = ADVENT_HOUSE.half;
const WALL = ADVENT_HOUSE.height;
const RIDGE = 2.2;
const DOOR_WIDTH = 0.92;
const TREE_AT: Vec3 = [5.4, 0, -2.4];
const SNOWMAN_AT: Vec3 = [-3.4, 0, 4.9];
const COTTAGES: readonly { at: Vec3; size: Vec3 }[] = [
	{ at: [-6, 0, 0.6], size: [2, 1.6, 2.2] },
	{ at: [1.8, 0, -6.1], size: [2.4, 1.7, 1.9] },
	{ at: [-5.4, 0, -4.6], size: [1.8, 1.4, 1.8] },
];

/** A box on one of the house's front walls (yaw 0 is +z, pi/2 is +x). */
function wallBox(
	at: Vec3,
	yaw: number,
	along: number,
	out: number,
	size: Vec3,
	color?: string
): InstanceSpec {
	const ax = Math.cos(yaw);
	const az = -Math.sin(yaw);
	const nx = Math.sin(yaw);
	const nz = Math.cos(yaw);
	return {
		color,
		position: [
			at[0] + ax * along + nx * out,
			at[1],
			at[2] + az * along + nz * out,
		],
		rotation: [0, yaw, 0],
		scale: size,
	};
}

/** Every door and window: frames, shutters, ribbons and lit panes. */
function openingParts({ doors, world }: SeasonSceneProps) {
	const frames: InstanceSpec[] = [];
	const shutters: InstanceSpec[] = [];
	const ribbons: InstanceSpec[] = [];
	const panes: InstanceSpec[] = [];
	for (const place of world.doors) {
		const door = doors[place.number - 1];
		const row = ADVENT_HOUSE.rows.indexOf(place.at[1] as never);
		const height = ADVENT_HOUSE.rowHeight[row] ?? 0.82;
		const { at, yaw } = place;
		frames.push(
			wallBox(at, yaw, 0, 0.02, [DOOR_WIDTH + 0.16, height + 0.16, 0.06])
		);
		const filled = door?.thread != null;
		if (filled && door?.opened) {
			panes.push(wallBox(at, yaw, 0, 0.05, [DOOR_WIDTH, height, 0.02]));
			for (const side of [-1, 1]) {
				shutters.push(
					wallBox(
						at,
						yaw,
						side * (DOOR_WIDTH / 2 + 0.25),
						0.06,
						[0.44, height, 0.05],
						ART.shutters[place.number % ART.shutters.length]
					)
				);
			}
			continue;
		}
		shutters.push(
			wallBox(
				at,
				yaw,
				0,
				0.07,
				[DOOR_WIDTH, height, 0.07],
				filled
					? ART.shutters[place.number % ART.shutters.length]
					: ART.shutterEmpty
			)
		);
		if (door?.mark === "needs-you") {
			ribbons.push(
				wallBox(at, yaw, 0, 0.12, [0.1, height, 0.02]),
				wallBox(at, yaw, 0, 0.12, [DOOR_WIDTH, 0.1, 0.02])
			);
		}
	}
	return { frames, panes, ribbons, shutters };
}

/** A painted number plaque for a door, drawn once on a small canvas. */
function plaqueCanvas(number: number): HTMLCanvasElement | null {
	if (typeof document === "undefined") {
		return null;
	}
	const canvas = document.createElement("canvas");
	canvas.width = 128;
	canvas.height = 96;
	const context = canvas.getContext("2d");
	if (!context) {
		return null;
	}
	context.fillStyle = ART.plaque;
	context.beginPath();
	context.roundRect(5, 5, 118, 86, 18);
	context.fill();
	context.lineWidth = 8;
	context.strokeStyle = ART.plaqueEdge;
	context.stroke();
	context.fillStyle = ART.plaqueInk;
	context.font = "900 66px ui-rounded, system-ui, sans-serif";
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.fillText(String(number), 64, 52);
	return canvas;
}

/** Each door's number, painted on a plaque at the top of the door. */
function NumberPlaques({ world }: { world: SeasonSceneProps["world"] }) {
	const plaques = useMemo(
		() =>
			world.doors.map((place) => {
				const row = ADVENT_HOUSE.rows.indexOf(place.at[1] as never);
				const height = ADVENT_HOUSE.rowHeight[row] ?? 0.82;
				const box = wallBox(
					[place.at[0], place.at[1] - height * 0.05, place.at[2]],
					place.yaw,
					0,
					0.115,
					[1, 1, 1]
				);
				return {
					canvas: plaqueCanvas(place.number),
					number: place.number,
					...box,
				};
			}),
		[world]
	);
	return (
		<group>
			{plaques.map((plaque) =>
				plaque.canvas ? (
					<mesh
						key={plaque.number}
						position={plaque.position}
						rotation={plaque.rotation}
					>
						<planeGeometry args={[0.76, 0.57]} />
						<meshBasicMaterial toneMapped={false} transparent>
							<canvasTexture
								args={[plaque.canvas]}
								attach="map"
								colorSpace="srgb"
							/>
						</meshBasicMaterial>
					</mesh>
				) : null
			)}
		</group>
	);
}

/** The house's timber frame: corner posts and a beam at every floor. */
function timberParts(): InstanceSpec[] {
	const parts: InstanceSpec[] = [];
	for (const [x, z] of [
		[HALF, HALF],
		[HALF, -HALF],
		[-HALF, HALF],
	] as const) {
		parts.push({
			position: [CX + x, WALL / 2, CZ + z],
			scale: [0.2, WALL, 0.2],
		});
	}
	for (const y of [1.5, 2.7, WALL - 0.06]) {
		parts.push(
			{ position: [CX, y, CZ + HALF + 0.03], scale: [HALF * 2, 0.14, 0.12] },
			{ position: [CX + HALF + 0.03, y, CZ], scale: [0.12, 0.14, HALF * 2] }
		);
	}
	return parts;
}

/**
 * A gabled roof over a box of `halfWidth` x `halfDepth` whose walls rise to
 * `wall`, its ridge along x and a triangle of wall under each gable.
 */
export function Roof({
	at,
	color,
	halfDepth,
	halfWidth,
	ridge,
	snow,
	wall,
	wallColor,
}: {
	at: [number, number];
	color: string;
	halfDepth: number;
	halfWidth: number;
	ridge: number;
	snow: string;
	wall: number;
	wallColor: string;
}) {
	const slope = Math.atan2(ridge, halfDepth);
	const length = Math.hypot(halfDepth, ridge) + 0.35;
	const sx = halfDepth / 0.866;
	const sz = ridge / 1.5;
	return (
		<group position={[at[0], 0, at[1]]}>
			{/* The gable: a triangular prism of wall along the ridge. */}
			<group position={[0, wall + 0.5 * sz, 0]} rotation={[0, Math.PI / 2, 0]}>
				<mesh
					castShadow
					receiveShadow
					rotation={[-Math.PI / 2, 0, 0]}
					scale={[sx, halfWidth * 2, sz]}
				>
					<cylinderGeometry args={[1, 1, 1, 3]} />
					<ToonMaterial color={wallColor} />
				</mesh>
			</group>
			{[-1, 1].map((side) => (
				<group
					key={side}
					position={[0, wall + ridge / 2, (side * halfDepth) / 2]}
					rotation={[side * slope, 0, 0]}
				>
					<ToonMesh
						castShadow
						color={color}
						ink={PROP_INK}
						position={[0, 0.08, 0]}
					>
						<boxGeometry args={[halfWidth * 2 + 0.5, 0.16, length]} />
					</ToonMesh>
					<ToonMesh color={snow} position={[0, 0.2, 0]}>
						<boxGeometry args={[halfWidth * 2 + 0.42, 0.1, length - 0.1]} />
					</ToonMesh>
				</group>
			))}
		</group>
	);
}

/** The square's tree: three tiers of needles, a star and lights. */
function SquareTree({ night }: { night: boolean }) {
	const bulbs = useMemo<InstanceSpec[]>(() => {
		const out: InstanceSpec[] = [];
		for (let index = 0; index < 22; index++) {
			const tier = index % 3;
			const angle = index * 2.4;
			const radius = 1.15 - tier * 0.32;
			out.push({
				color: ART.bulbs[index % ART.bulbs.length],
				position: [
					TREE_AT[0] + Math.cos(angle) * radius,
					0.75 + tier * 0.82 + jitter(index, 1, 3) * 0.2,
					TREE_AT[2] + Math.sin(angle) * radius,
				],
				scale: 0.075,
			});
		}
		return out;
	}, []);
	return (
		<group>
			<ToonMesh
				castShadow
				color={ART.timber}
				position={[TREE_AT[0], 0.3, TREE_AT[2]]}
			>
				<cylinderGeometry args={[0.16, 0.2, 0.6, 8]} />
			</ToonMesh>
			{[0, 1, 2].map((tier) => (
				<ToonMesh
					castShadow
					color={ART.needles}
					ink={PROP_INK}
					key={tier}
					position={[TREE_AT[0], 1.15 + tier * 0.8, TREE_AT[2]]}
				>
					<coneGeometry args={[1.45 - tier * 0.36, 1.3, 18]} />
				</ToonMesh>
			))}
			<mesh
				position={[TREE_AT[0], 3.25, TREE_AT[2]]}
				rotation={[0, Math.PI / 4, 0]}
			>
				<octahedronGeometry args={[0.22, 0]} />
				<meshBasicMaterial color={ART.star} toneMapped={!night} />
			</mesh>
			<InstancedParts items={bulbs}>
				<sphereGeometry args={[1, 8, 6]} />
				<meshBasicMaterial toneMapped={!night} />
			</InstancedParts>
		</group>
	);
}

function Snowman() {
	const [x, , z] = SNOWMAN_AT;
	return (
		<group position={[x, 0, z]} rotation={[0, Math.PI / 4, 0]}>
			<ToonMesh
				castShadow
				color={ART.snowman}
				ink={PROP_INK}
				position={[0, 0.42, 0]}
			>
				<sphereGeometry args={[0.46, 18, 14]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={ART.snowman}
				ink={PROP_INK}
				position={[0, 1.02, 0]}
			>
				<sphereGeometry args={[0.33, 18, 14]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={ART.snowman}
				ink={PROP_INK}
				position={[0, 1.48, 0]}
			>
				<sphereGeometry args={[0.24, 16, 12]} />
			</ToonMesh>
			<ToonMesh
				color={ART.scarf}
				position={[0, 1.27, 0]}
				rotation={[Math.PI / 2, 0, 0]}
			>
				<torusGeometry args={[0.22, 0.06, 8, 20]} />
			</ToonMesh>
			<ToonMesh
				color={ART.nose}
				position={[0, 1.48, 0.3]}
				rotation={[Math.PI / 2, 0, 0]}
			>
				<coneGeometry args={[0.05, 0.2, 8]} />
			</ToonMesh>
			{[-1, 1].map((side) => (
				<ToonMesh
					color={ART.coal}
					key={side}
					position={[side * 0.09, 1.56, 0.21]}
				>
					<sphereGeometry args={[0.03, 6, 4]} />
				</ToonMesh>
			))}
		</group>
	);
}

/** The cottages' walls and the lit windows they show at night. */
function cottageParts(night: boolean) {
	const walls: InstanceSpec[] = [];
	const windows: InstanceSpec[] = [];
	for (const [index, cottage] of COTTAGES.entries()) {
		const [x, , z] = cottage.at;
		const [w, h, d] = cottage.size;
		walls.push({
			color: ART.cottages[index % ART.cottages.length],
			position: [x, h / 2, z],
			scale: [w, h, d],
		});
		windows.push(
			{
				color: night ? ART.glow : ART.timber,
				position: [x - w * 0.22, h * 0.55, z + d / 2 + 0.02],
				scale: [0.36, 0.42, 0.04],
			},
			{
				color: night ? ART.glow : ART.timber,
				position: [x + w / 2 + 0.02, h * 0.55, z],
				scale: [0.04, 0.42, 0.36],
			}
		);
	}
	return { walls, windows };
}

/** Snowy pines round the island's rim. */
function rimPines(scene: SeasonSceneProps): PlantedTree[] {
	const trees: PlantedTree[] = [];
	const columns = Math.ceil(scene.shape.halfWidth);
	const rows = Math.ceil(scene.shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const hash = jitter(x, y, 3);
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const radius = Math.hypot(fx, fz);
			if (
				!onIsland(scene.shape, fx, fz, 0.6) ||
				radius < 7.4 ||
				fx + fz > 6 ||
				hash > 0.62
			) {
				continue;
			}
			trees.push({
				at: [fx, 0, fz],
				kind: "cedar",
				scale: 0.75 + jitter(x, y, 9) * 0.4,
				seed: Math.round(hash * 1000),
			});
		}
	}
	return trees;
}

export function AdventSquare(scene: SeasonSceneProps) {
	const { night, reducedMotion, shape, theme } = scene;
	const paint = useMemo(() => {
		const snow = linearRgb(night ? ART.snowNight : ART.snow);
		const square = linearRgb(night ? ART.squareNight : ART.square);
		return (x: number, z: number): Rgb =>
			Math.hypot(x - CX * 0.4, z - CZ * 0.4) < 6.6 ? square : snow;
	}, [night]);
	// Snow on the cliff's lip and the pines: the kit's theme, frosted.
	const frosted = useMemo<Scene3dTheme>(
		() => ({ ...theme, pineLeaves: ART.pines }),
		[theme]
	);
	const openings = useMemo(() => openingParts(scene), [scene]);
	const timber = useMemo(() => timberParts(), []);
	const pines = useMemo(() => rimPines(scene), [scene]);
	const cottages = useMemo(() => cottageParts(night), [night]);
	const lamps = useMemo<Vec3[]>(
		() => [
			[3.6, 0, 3.6],
			[-4.6, 0, 3.4],
			[3.4, 0, -4.8],
			[6.2, 0, 1.4],
			[0.6, 0, 5.8],
		],
		[]
	);
	const benches = useMemo<PlacedProp[]>(
		() => [
			{ at: [5.6, 0, 0.6], yaw: -Math.PI / 2 },
			{ at: [-1.2, 0, 5.4], yaw: 0 },
		],
		[]
	);
	const snow = night ? ART.snowNight : ART.snow;
	return (
		<group>
			<IsoIsland paint={paint} shape={shape} theme={frosted} />
			<TreeGrove theme={frosted} trees={pines} />
			<LampPosts lamps={lamps} night={night} />
			<Benches benches={benches} />
			{/* The advent house. */}
			<ToonMesh
				castShadow
				color={ART.wall}
				ink={PROP_INK}
				position={[CX, WALL / 2, CZ]}
				receiveShadow
			>
				<boxGeometry args={[HALF * 2, WALL, HALF * 2]} />
			</ToonMesh>
			<InstancedParts castShadow items={timber}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.timber} />
			</InstancedParts>
			<Roof
				at={[CX, CZ]}
				color={ART.roof}
				halfDepth={HALF}
				halfWidth={HALF}
				ridge={RIDGE}
				snow={snow}
				wall={WALL}
				wallColor={ART.wall}
			/>
			<ToonMesh
				castShadow
				color={ART.chimney}
				ink={PROP_INK}
				position={[CX + HALF * 0.55, WALL + RIDGE * 0.75, CZ - HALF * 0.4]}
			>
				<boxGeometry args={[0.5, 1.3, 0.5]} />
			</ToonMesh>
			<InstancedParts items={openings.frames}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.timber} />
			</InstancedParts>
			<InstancedParts
				ink={PROP_INK * 0.6}
				inkColor={ART.timber}
				items={openings.shutters}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial planks />
			</InstancedParts>
			<InstancedParts items={openings.ribbons}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={ART.star} rim={0.3} />
			</InstancedParts>
			<NumberPlaques world={scene.world} />
			<InstancedParts items={openings.panes}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial color={ART.glow} toneMapped={!night} />
			</InstancedParts>
			{/* Cottages round the square. */}
			<InstancedParts
				castShadow
				ink={PROP_INK}
				inkColor={ART.timber}
				items={cottages.walls}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={cottages.windows}>
				<boxGeometry args={[1, 1, 1]} />
				<meshBasicMaterial toneMapped={!night} />
			</InstancedParts>
			{COTTAGES.map((cottage) => (
				<Roof
					at={[cottage.at[0], cottage.at[2]]}
					color={ART.cottageRoof}
					halfDepth={cottage.size[2] / 2}
					halfWidth={cottage.size[0] / 2}
					key={`${cottage.at[0]}:${cottage.at[2]}`}
					ridge={0.9}
					snow={snow}
					wall={cottage.size[1]}
					wallColor={ART.cottages[0]}
				/>
			))}
			<SquareTree night={night} />
			<Snowman />
			{scene.weather === false ? null : (
				<Snowfall
					color={ART.snowman}
					height={8}
					reducedMotion={reducedMotion}
					span={18}
				/>
			)}
		</group>
	);
}
