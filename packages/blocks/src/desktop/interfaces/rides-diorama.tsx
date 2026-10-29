/* eslint-disable react/no-unknown-property */
import { RoundedBoxGeometry } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { Group } from "three";
import { stationLines } from "./game3d-act-stage.tsx";
import { YOU_SLOTS } from "./game3d-acts.ts";
import { FlowerClusters, type FlowerPatch } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland, MeshGeometry } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, type MeshData, onIsland } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import {
	CurvedBasicMaterial,
	ToonMaterial,
	ToonMesh,
} from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { AgentSwatch, Scene3dTheme } from "./game3d-palette.ts";
import {
	Benches,
	Bushes,
	PathStones,
	type PlacedBush,
	type PlantedTree,
	Pond,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoLabel, IsoMarker } from "./game3d-stage.tsx";
import { linearRgb, type RenderQuality } from "./game3d-toon.ts";
import {
	RidesActProps,
	type RidesActTrip,
	type RidesActView,
	RidesCarPlate,
	ridesBoardOffset,
	ridesCarTarget,
	ridesYouSpot,
} from "./rides-acts.tsx";
import {
	chipText,
	mapTrips,
	PICKUP,
	type RideCar,
	type RideCity,
	type RideTrip,
	tripWord,
} from "./rides-model.ts";
import { type RidesArt, swatch } from "./rides-palette.ts";
import {
	type CarSpot,
	carSpots,
	inRiver,
	RIVER_HALF,
	type RidesCityPlan,
	riverAt,
	routePath,
	stackPlates,
	toWorld,
	tripLanes,
	type Vec3,
	type WorldRect,
} from "./rides-scene.ts";

/**
 * Rides as an isometric diorama on the game kit (game3d-stage.tsx): the
 * part of the city the trips use, as a toon city block on the island. Soft
 * grey roads with dashed avenues run between raised blocks of rounded
 * houses and little towers (windows warm at night); a river crosses the
 * city under bridges where the avenues meet it, and the park has a pond,
 * paths and trees. Every agent drives a small rounded car in its own
 * colour: it waits at home, drives its route toward the conversation it is
 * working on, and parks at the pin once it replies. You are the orange pin
 * every trip starts from. Pins and cars carry kit plates (their controls).
 */

/** Plate heights over a pin and over a car (before any climb to clear). */
const PIN_PLATE = 1.75;
const CAR_PLATE = 1.35;
/** How much higher a working car's two-line plate stands. */
const WORKING_LIFT = 0.45;
/** Cars and pins are drawn a size up, so they read over the rooftops. */
const CAR_SCALE = 2.4;
/** Below this the city's slabs and buildings sit; the kerb's height. */
const KERB = 0.06;

/** A unit triangular prism (base -0.5..0.5 on x at y 0, apex at y 1). */
function prismData(): MeshData {
	const position: number[] = [];
	const normal: number[] = [];
	const index: number[] = [];
	const face = (points: Vec3[], n: Vec3) => {
		const base = position.length / 3;
		for (const point of points) {
			position.push(...point);
			normal.push(...n);
		}
		for (let corner = 1; corner < points.length - 1; corner++) {
			index.push(base, base + corner, base + corner + 1);
		}
	};
	const slope = Math.hypot(1, 0.5);
	face(
		[
			[-0.5, 0, 0.5],
			[0.5, 0, 0.5],
			[0, 1, 0.5],
		],
		[0, 0, 1]
	);
	face(
		[
			[0.5, 0, -0.5],
			[-0.5, 0, -0.5],
			[0, 1, -0.5],
		],
		[0, 0, -1]
	);
	face(
		[
			[0.5, 0, 0.5],
			[0.5, 0, -0.5],
			[0, 1, -0.5],
			[0, 1, 0.5],
		],
		[1 / slope, 0.5 / slope, 0]
	);
	face(
		[
			[-0.5, 0, -0.5],
			[-0.5, 0, 0.5],
			[0, 1, 0.5],
			[0, 1, -0.5],
		],
		[-1 / slope, 0.5 / slope, 0]
	);
	return {
		index: new Uint32Array(index),
		normal: new Float32Array(normal),
		position: new Float32Array(position),
	};
}

const PRISM = prismData();

function inRect(x: number, z: number, rect: WorldRect, grow = 0): boolean {
	return (
		x >= rect.minX - grow &&
		x <= rect.maxX + grow &&
		z >= rect.minZ - grow &&
		z <= rect.maxZ + grow
	);
}

interface CityParts {
	glass: InstanceSpec[];
	litGlass: InstanceSpec[];
	prisms: InstanceSpec[];
	roofs: InstanceSpec[];
	slabs: InstanceSpec[];
	walls: InstanceSpec[];
}

/** Every block's slab, building, roof and window, ready to instance. */
function cityParts(
	plan: RidesCityPlan,
	art: RidesArt,
	night: boolean
): CityParts {
	const parts: CityParts = {
		glass: [],
		litGlass: [],
		prisms: [],
		roofs: [],
		slabs: [],
		walls: [],
	};
	for (const { rect } of plan.blocks) {
		parts.slabs.push({
			color: art.pavement,
			position: [
				(rect.minX + rect.maxX) / 2,
				KERB / 2,
				(rect.minZ + rect.maxZ) / 2,
			],
			scale: [rect.maxX - rect.minX, KERB, rect.maxZ - rect.minZ],
		});
	}
	for (const lot of plan.lots) {
		const [x, y, z] = lot.at;
		const wall = swatch(art.walls, lot.seed);
		const roof = swatch(art.roofs, lot.seed >> 3);
		parts.walls.push({
			color: wall,
			position: [x, y + lot.height / 2, z],
			scale: [lot.width, lot.height, lot.depth],
		});
		if (lot.kind === "house") {
			parts.prisms.push({
				color: wall,
				position: [x, y + lot.height, z],
				scale: [lot.width, 0.3, lot.depth],
			});
			const tilt = Math.atan2(0.3, lot.width / 2);
			const slope = Math.hypot(lot.width / 2 + 0.06, 0.3);
			for (const side of [-1, 1]) {
				parts.roofs.push({
					color: roof,
					position: [
						x + side * (lot.width / 4 + 0.015),
						y + lot.height + 0.16,
						z,
					],
					rotation: [0, 0, -side * tilt],
					scale: [slope, 0.05, lot.depth + 0.1],
				});
			}
		} else {
			parts.roofs.push({
				color: roof,
				position: [x, y + lot.height + 0.03, z],
				scale: [lot.width + 0.06, 0.06, lot.depth + 0.06],
			});
		}
		// Windows on the two faces the camera sees (+z and +x).
		const floors =
			lot.kind === "tower"
				? Math.max(1, Math.floor((lot.height - 0.2) / 0.27))
				: 1;
		for (let floor = 0; floor < floors; floor++) {
			const wy = y + 0.25 + floor * 0.27;
			for (const face of ["z", "x"] as const) {
				const span = face === "z" ? lot.width : lot.depth;
				const count = Math.max(1, Math.floor((span - 0.08) / 0.2));
				for (let index = 0; index < count; index++) {
					const along = -span / 2 + (span / count) * (index + 0.5);
					const lit = night
						? jitter(Math.round(x * 10) + index, floor, lot.seed % 7) > 0.25
						: false;
					const spec: InstanceSpec =
						face === "z"
							? {
									position: [x + along, wy, z + lot.depth / 2 + 0.006],
									scale: [0.1, 0.13, 0.012],
								}
							: {
									position: [x + lot.width / 2 + 0.006, wy, z + along],
									scale: [0.012, 0.13, 0.1],
								};
					if (lit) {
						parts.litGlass.push(spec);
					} else {
						parts.glass.push({ ...spec, color: art.glass });
					}
				}
			}
		}
	}
	return parts;
}

/** The blocks and their buildings, every part instanced. */
function CityBlocks({
	art,
	night,
	plan,
}: {
	art: RidesArt;
	night: boolean;
	plan: RidesCityPlan;
}) {
	const parts = useMemo(() => cityParts(plan, art, night), [art, night, plan]);
	return (
		<group>
			<InstancedParts
				ink={PROP_INK * 0.5}
				inkColor={art.kerb}
				items={parts.slabs}
				receiveShadow
			>
				<RoundedBoxGeometry args={[1, 1, 1]} radius={0.02} smoothness={2} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.8}
				inkColor={art.pinPost}
				items={parts.walls}
				receiveShadow
			>
				<RoundedBoxGeometry args={[1, 1, 1]} radius={0.04} smoothness={2} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts castShadow items={parts.prisms} receiveShadow>
				<MeshGeometry data={PRISM} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={art.pinPost}
				items={parts.roofs}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.glass}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial emissive={art.glass} emissiveIntensity={0.2} />
			</InstancedParts>
			<InstancedParts items={parts.litGlass}>
				<boxGeometry args={[1, 1, 1]} />
				<CurvedBasicMaterial color={art.litGlass} toneMapped={false} />
			</InstancedParts>
		</group>
	);
}

/** Bridges, lane dashes and the little street lamps. */
function Streets({
	art,
	night,
	plan,
}: {
	art: RidesArt;
	night: boolean;
	plan: RidesCityPlan;
}) {
	const parts = useMemo(() => {
		const decks: InstanceSpec[] = [];
		const rails: InstanceSpec[] = [];
		for (const bridge of plan.bridges) {
			decks.push({
				position: [bridge.x, 0.03, bridge.z],
				scale: [bridge.width, 0.08, bridge.length],
			});
			for (const side of [-1, 1]) {
				rails.push({
					position: [
						bridge.x + side * (bridge.width / 2 - 0.03),
						0.13,
						bridge.z,
					],
					scale: [0.05, 0.12, bridge.length],
				});
			}
		}
		const dashes = plan.dashes.map<InstanceSpec>(({ along, at }) => ({
			position: at,
			scale: along === "z" ? [0.05, 0.01, 0.22] : [0.22, 0.01, 0.05],
		}));
		const posts = plan.scenery.lamps.map<InstanceSpec>((at) => ({
			position: [at[0], at[1] + 0.28, at[2]],
			scale: [0.025, 0.56, 0.025],
		}));
		const bulbs = plan.scenery.lamps.map<InstanceSpec>((at) => ({
			position: [at[0], at[1] + 0.6, at[2]],
			scale: 0.055,
		}));
		return { bulbs, dashes, decks, posts, rails };
	}, [plan]);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.7}
				inkColor={art.pinPost}
				items={parts.decks}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.bridge} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.rails}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.bridgeRail} />
			</InstancedParts>
			<InstancedParts items={parts.dashes}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.dash} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.posts}>
				<cylinderGeometry args={[1, 1, 1, 8]} />
				<ToonMaterial color={art.pinPost} />
			</InstancedParts>
			<InstancedParts items={parts.bulbs}>
				<sphereGeometry args={[1, 10, 8]} />
				{night ? (
					<CurvedBasicMaterial color={art.carLight} toneMapped={false} />
				) : (
					<ToonMaterial color={art.carLight} />
				)}
			</InstancedParts>
		</group>
	);
}

/** The park: trees, a pond, a path and benches. */
function park(rect: WorldRect) {
	const trees: PlantedTree[] = [];
	const stones: Vec3[] = [];
	const cx = (rect.minX + rect.maxX) / 2;
	const cz = (rect.minZ + rect.maxZ) / 2;
	const width = rect.maxX - rect.minX;
	const depth = rect.maxZ - rect.minZ;
	for (let index = 0; index < 14; index++) {
		const x = rect.minX + 0.3 + jitter(index, 1, 3) * (width - 0.6);
		const z = rect.minZ + 0.3 + jitter(index, 2, 5) * (depth - 0.6);
		if (Math.hypot(x - cx, z - cz) < 1.1) {
			continue;
		}
		trees.push({
			at: [x, 0, z],
			kind: index % 3 === 0 ? "blossom" : index % 3 === 1 ? "fruit" : "cedar",
			scale: 0.5 + jitter(index, 4, 7) * 0.15,
			seed: index * 37,
		});
	}
	for (let t = 0; t <= 1; t += 0.06) {
		stones.push([
			rect.minX + t * width,
			0,
			cz + Math.sin(t * Math.PI * 2) * depth * 0.18,
		]);
	}
	return {
		benches: [{ at: [cx - 0.9, 0, cz + 0.55] as Vec3, scale: 0.6, yaw: 0 }],
		pond: {
			at: [cx + 0.2, 0, cz - 0.15] as Vec3,
			radius: Math.min(0.75, depth * 0.25),
		},
		stones,
		trees,
	};
}

/** Trees, shrubs and flowers on the lawn beyond the city, clear of the river. */
function countryside(plan: RidesCityPlan, shape: IslandShape) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.6;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.6;
			if (
				!onIsland(shape, fx, fz, 0.5) ||
				inRect(fx, fz, plan.rect, 0.4) ||
				Math.abs(fz - riverAt(plan.frame, fx)) < RIVER_HALF + 0.35
			) {
				continue;
			}
			const hash = jitter(x, y, 3);
			if (hash < 0.5) {
				trees.push({
					at: [fx, 0, fz],
					kind: hash < 0.2 ? "cedar" : hash > 0.4 ? "blossom" : "fruit",
					scale: 0.7 + jitter(x, y, 9) * 0.25,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.65) {
				bushes.push({ at: [fx, 0, fz], scale: 0.75, seed: x * 17 + y });
			} else if (hash > 0.85) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}

/** What a car's plate says to a screen reader. */
export function carLabel(car: RideCar, trip: RideTrip | undefined): string {
	if (car.state === "driving" && trip) {
		return `${car.agent.name}, driving to ${trip.thread.title}`;
	}
	if (car.state === "arrived" && trip) {
		return `${car.agent.name}, arrived at ${trip.thread.title}`;
	}
	if (car.state === "queued" && trip) {
		return `${car.agent.name}, requested for ${trip.thread.title}`;
	}
	return `${car.agent.name}, available. Book a trip with ${car.agent.name}`;
}

/** A small rounded toon car in its driver's colour, gliding to its spot. */
function Car({
	art,
	body,
	ghost,
	night,
	reducedMotion,
	spot,
}: {
	art: RidesArt;
	body: string;
	ghost: boolean;
	night: boolean;
	reducedMotion: boolean;
	spot: CarSpot;
}) {
	const ref = useRef<Group>(null);
	const target = useRef(spot);
	target.current = spot;
	const invalidate = useThree((state) => state.invalidate);
	// Under reduced motion the car is where its plate is on the same frame.
	useLayoutEffect(() => {
		const group = ref.current;
		if (!(reducedMotion && group)) {
			return;
		}
		group.position.set(spot.at[0], spot.at[1], spot.at[2]);
		group.rotation.y = spot.yaw;
		invalidate();
	}, [invalidate, reducedMotion, spot.at, spot.yaw]);
	useFrame((_, delta) => {
		const group = ref.current;
		if (!group) {
			return;
		}
		const { at, yaw } = target.current;
		const ease = reducedMotion ? 1 : Math.min(1, delta * 2.5);
		group.position.x += (at[0] - group.position.x) * ease;
		group.position.z += (at[2] - group.position.z) * ease;
		group.position.y = at[1];
		let turn = yaw - group.rotation.y;
		turn = Math.atan2(Math.sin(turn), Math.cos(turn));
		group.rotation.y += turn * ease;
	});
	const opacity = ghost ? 0.45 : 1;
	return (
		<group
			position={spot.at}
			ref={ref}
			rotation={[0, spot.yaw, 0]}
			scale={CAR_SCALE}
		>
			<mesh castShadow position={[0, 0.13, 0]}>
				<RoundedBoxGeometry
					args={[0.32, 0.15, 0.6]}
					radius={0.06}
					smoothness={3}
				/>
				<ToonMaterial color={body} opacity={opacity} transparent={ghost} />
			</mesh>
			<mesh castShadow position={[0, 0.24, -0.04]}>
				<RoundedBoxGeometry
					args={[0.27, 0.13, 0.32]}
					radius={0.05}
					smoothness={3}
				/>
				<ToonMaterial
					color={art.carGlass}
					opacity={opacity}
					transparent={ghost}
				/>
			</mesh>
			<mesh position={[0, 0.31, -0.04]}>
				<boxGeometry args={[0.24, 0.025, 0.26]} />
				<ToonMaterial color={body} opacity={opacity} transparent={ghost} />
			</mesh>
			{/* The roof light: lit while the car is on a trip. */}
			<mesh position={[0, 0.345, -0.04]}>
				<boxGeometry args={[0.12, 0.05, 0.07]} />
				{ghost ? (
					<ToonMaterial color={art.carLight} opacity={opacity} transparent />
				) : (
					<CurvedBasicMaterial color={art.carLight} toneMapped={false} />
				)}
			</mesh>
			{[-1, 1].map((side) =>
				[-1, 1].map((end) => (
					<mesh
						key={`${side}:${end}`}
						position={[side * 0.15, 0.06, end * 0.19]}
						rotation={[0, 0, Math.PI / 2]}
					>
						<cylinderGeometry args={[0.06, 0.06, 0.05, 12]} />
						<ToonMaterial
							color={art.carWheel}
							opacity={opacity}
							transparent={ghost}
						/>
					</mesh>
				))
			)}
			{[-1, 1].map((side) => (
				<group key={side}>
					<mesh position={[side * 0.1, 0.14, 0.3]}>
						<sphereGeometry args={[0.03, 8, 6]} />
						{night && !ghost ? (
							<CurvedBasicMaterial color={art.carLight} toneMapped={false} />
						) : (
							<ToonMaterial color={art.carLight} />
						)}
					</mesh>
					<mesh position={[side * 0.11, 0.14, -0.3]}>
						<boxGeometry args={[0.06, 0.03, 0.01]} />
						<ToonMaterial color={art.carTail} />
					</mesh>
				</group>
			))}
		</group>
	);
}

/** A trip's destination pin: a post with a flag in the trip's colour. */
function Pins({
	art,
	pins,
}: {
	art: RidesArt;
	pins: readonly { at: Vec3; color: string }[];
}) {
	const parts = useMemo(
		() => ({
			flags: pins.map<InstanceSpec>(({ at, color }) => ({
				color,
				position: [at[0] + 0.24, at[1] + 1.2, at[2]],
				scale: [0.46, 0.3, 0.05],
			})),
			heads: pins.map<InstanceSpec>(({ at }) => ({
				position: [at[0], at[1] + 1.38, at[2]],
				scale: 0.08,
			})),
			posts: pins.map<InstanceSpec>(({ at }) => ({
				position: [at[0], at[1] + 0.68, at[2]],
				scale: [0.05, 1.36, 0.05],
			})),
		}),
		[pins]
	);
	return (
		<group>
			<InstancedParts castShadow items={parts.posts}>
				<cylinderGeometry args={[1, 1, 1, 8]} />
				<ToonMaterial color={art.pinPost} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.6}
				inkColor={art.pinPost}
				items={parts.flags}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.heads}>
				<sphereGeometry args={[1, 10, 8]} />
				<ToonMaterial color={art.pinPost} />
			</InstancedParts>
		</group>
	);
}

/** Routes as flat ribbons on the road, the selected one bright. */
function Routes({
	ribbons,
}: {
	ribbons: readonly { color: string; path: Vec3[]; width: number }[];
}) {
	const items = useMemo(() => {
		const out: InstanceSpec[] = [];
		for (const { color, path, width } of ribbons) {
			for (let index = 1; index < path.length; index++) {
				const from = path[index - 1];
				const to = path[index];
				if (!(from && to)) {
					continue;
				}
				const dx = to[0] - from[0];
				const dz = to[2] - from[2];
				const length = Math.hypot(dx, dz);
				if (length < 0.01) {
					continue;
				}
				out.push({
					color,
					position: [(from[0] + to[0]) / 2, from[1], (from[2] + to[2]) / 2],
					rotation: [0, Math.atan2(dx, dz), 0],
					scale: [width, 0.012, length + width],
				});
			}
		}
		return out;
	}, [ribbons]);
	return (
		<InstancedParts items={items}>
			<boxGeometry args={[1, 1, 1]} />
			<CurvedBasicMaterial toneMapped={false} />
		</InstancedParts>
	);
}

export interface RidesDioramaProps {
	/** The act layer (a snapshot with `asks`); without it, today's map. */
	acts?: { onStage: readonly InterfaceAgentAct[]; view: RidesActView } | null;
	art: RidesArt;
	night: boolean;
	onOpenTrip: (tripId: string) => void;
	onPickDriver: (agentId: string) => void;
	onSelectTrip: (tripId: string) => void;
	plan: RidesCityPlan;
	quality: RenderQuality;
	reducedMotion: boolean;
	rides: RideCity;
	selectedTripId: string | null;
	shape: IslandShape;
	swatches: ReadonlyMap<string, AgentSwatch>;
	theme: Scene3dTheme;
}

/** A route's colour: bright when picked, plain en route (and with acts), else its stage's. */
function ribbonColor(
	art: RidesArt,
	trip: RideTrip,
	selected: boolean,
	acted: boolean
): string {
	if (selected) {
		return art.routeSelected;
	}
	return acted || trip.stage === "enroute" ? art.route : art.pin[trip.stage];
}

/** A pin plate's words: the act's word, or the chip's lead and tail. */
function pinText(
	trip: RideTrip,
	acted = false,
	trips?: ReadonlyMap<string, RidesActTrip>
): string {
	const actTrip = trips?.get(trip.id);
	if (actTrip) {
		return tripWord(trip, actTrip);
	}
	const { lead, tail } = chipText(trip, acted);
	return tail ? `${lead} ${tail}` : lead;
}

/** A station board's line height, in world units up (its rows sit 2 px apart). */
const BOARD_LINE = 0.5;

/** The city diorama: island, river, park, streets, buildings, cars and pins. */
export function RidesDioramaScene({
	acts = null,
	art,
	night,
	onOpenTrip,
	onPickDriver,
	onSelectTrip,
	plan,
	quality,
	reducedMotion,
	rides,
	selectedTripId,
	shape,
	swatches,
	theme,
}: RidesDioramaProps) {
	const { frame } = plan;
	const paint = useMemo(() => {
		const road: Rgb = linearRgb(art.road);
		const water: Rgb = linearRgb(art.water);
		return (x: number, z: number): Rgb | null => {
			if (inRiver(frame, x, z)) {
				return water;
			}
			if (plan.park && inRect(x, z, plan.park)) {
				return null;
			}
			return inRect(x, z, plan.rect) ? road : null;
		};
	}, [art, frame, plan]);
	const avoid = useMemo(
		() => (x: number, z: number) =>
			Math.abs(z - riverAt(frame, x)) < RIVER_HALF + 0.15 ||
			(inRect(x, z, plan.rect, 0.15) &&
				!(plan.park && inRect(x, z, plan.park, -0.1))),
		[frame, plan]
	);
	const green = useMemo(() => countryside(plan, shape), [plan, shape]);
	const parkScene = useMemo(() => (plan.park ? park(plan.park) : null), [plan]);
	const streetTrees = useMemo<PlantedTree[]>(
		() =>
			plan.scenery.trees.map(({ at, seed }) => ({
				at,
				kind: seed % 2 ? "fruit" : "blossom",
				scale: 0.45,
				seed,
			})),
		[plan]
	);
	const trips = useMemo(() => mapTrips(rides), [rides]);
	const lanes = useMemo(() => tripLanes(rides), [rides]);
	const acted = acts !== null;
	const actOf = useMemo(
		() => new Map((acts?.onStage ?? []).map((act) => [act.agentId, act])),
		[acts?.onStage]
	);
	const ribbons = useMemo(
		() =>
			trips.flatMap((trip) => {
				const selected = trip.id === selectedTripId;
				// With acts a ribbon is the picked trip, or a working car's
				// road ahead in the plain route colour; no stage colours.
				if (
					acted &&
					!selected &&
					(trip.stage !== "enroute" ||
						trip.carless ||
						actOf.get(trip.driver?.id ?? "")?.act !== "working")
				) {
					return [];
				}
				const path = routePath(frame, trip, selected, lanes);
				if (path.length < 2) {
					return [];
				}
				return [
					{
						color: ribbonColor(art, trip, selected, acted),
						path: path.map(
							(point): Vec3 => [point[0], selected ? 0.03 : 0.022, point[2]]
						),
						width: selected ? 0.3 : 0.17,
					},
				];
			}),
		[actOf, acted, art, frame, lanes, selectedTripId, trips]
	);
	// With acts the map keeps only the picked trip's pin: each driver's car
	// plate and the kerb say where everyone is.
	const pins = useMemo(
		() =>
			trips
				.filter((trip) => !acted || trip.id === selectedTripId)
				.map((trip) => ({
					at: toWorld(frame, trip.destination, 0.02),
					color: art.pin[trip.stage],
					trip,
				})),
		[acted, art, frame, selectedTripId, trips]
	);
	const cars = useMemo(() => carSpots(frame, rides), [frame, rides]);
	const pickup = toWorld(frame, PICKUP, 0.02);
	const narrow = acts?.view.iconOnly ?? false;
	const pickupKey = pickup.join();
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the pickup's place, not the array.
	const homes = useMemo(() => cars.map((spot) => spot.at), [cars]);
	const you = useMemo(
		() => ridesYouSpot(pickup, narrow, plan, homes),
		[homes, narrow, pickupKey, plan]
	);
	const youPoints = you.points;
	// With acts, an asking car pulls up at the kerb and a delivering one
	// drops its parcel there; every other car keeps its spot on the map.
	const actCars = useMemo(
		() =>
			cars.map((spot) => {
				const act = actOf.get(spot.car.agent.id);
				return act && acts
					? {
							...spot,
							at: ridesCarTarget(
								act,
								spot.at,
								youPoints,
								acts.view.slots.slots,
								reducedMotion
							),
						}
					: spot;
			}),
		[actOf, acts, cars, reducedMotion, youPoints]
	);
	const plateHeights = useMemo(
		() =>
			stackPlates([
				// Fixed first (nothing climbs over them): the kerb's queue and
				// notice places, and each limited car's board, where its
				// red-light words stand.
				...(acts
					? YOU_SLOTS.flatMap((slot) => {
							const at = youPoints[slot];
							return at
								? [
										{
											at: [at[0], CAR_PLATE, at[2]] as Vec3,
											chars: 12,
											id: `slot:${slot}`,
										},
									]
								: [];
						})
					: []),
				...actCars.flatMap((spot) => {
					if (actOf.get(spot.car.agent.id)?.act !== "limited") {
						return [];
					}
					const board = ridesBoardOffset(narrow, true);
					return [
						{
							at: [
								spot.at[0] + board[0],
								board[1] + 0.3,
								spot.at[2] + board[2],
							] as Vec3,
							chars: 20,
							id: `limit:${spot.car.id}`,
						},
					];
				}),
				// Each working car's station board ("3/7", "12m", "Next: …"), a
				// column the kit pins beside the car: fixed too, line by line, so
				// no plate climbs onto it.
				...(acts
					? actCars.flatMap((spot) => {
							const act = actOf.get(spot.car.agent.id);
							if (!act || act.act === "limited") {
								return [];
							}
							const lines = stationLines(act, acts.view.shown, {
								clock: acts.view.clock,
								nowMs: acts.view.nowMs,
							});
							const board = ridesBoardOffset(narrow);
							return lines.map((line, index) => ({
								at: [
									spot.at[0] + board[0],
									board[1] +
										0.3 +
										((lines.length - 1) / 2 - index) * BOARD_LINE,
									spot.at[2] + board[2],
								] as Vec3,
								chars: line.text.length,
								id: `board:${spot.car.id}:${index}`,
							}));
						})
					: []),
				...pins.map(({ at, trip }) => ({
					at: [at[0], PIN_PLATE, at[2]] as Vec3,
					chars:
						pinText(trip, acted, acts?.view.trips).length +
						(trip.id === selectedTripId && !narrow
							? Math.min(24, trip.thread.title.length)
							: 0),
					id: trip.id,
				})),
				// Plates stand where the cars are drawn: with acts, at the kerb
				// for the asking and delivering ones.
				...(acts ? actCars : cars)
					.filter((spot) => acts !== null || spot.car.state !== "arrived")
					.map((spot) => {
						// A working plate stands higher, with its roof sign's words
						// on a second line: stack it where it is drawn.
						const working = actOf.get(spot.car.agent.id)?.act === "working";
						const sign = working
							? (actOf.get(spot.car.agent.id)?.bubble?.text ?? "")
							: "";
						return {
							at: [
								spot.at[0],
								CAR_PLATE + (working ? WORKING_LIFT : 0),
								spot.at[2],
							] as Vec3,
							chars: Math.max(spot.car.agent.name.length, sign.length),
							id: `car:${spot.car.id}`,
						};
					}),
			]),
		[actCars, actOf, acted, acts, cars, narrow, pins, selectedTripId, youPoints]
	);
	const carYaws = useMemo(
		() => new Map(actCars.map((spot) => [spot.car.agent.id, spot.yaw])),
		[actCars]
	);
	const carsAt = useMemo(
		() => new Map(actCars.map((spot) => [spot.car.agent.id, spot.at])),
		[actCars]
	);
	return (
		<group>
			<IsoIsland paint={paint} shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reducedMotion}
				shape={shape}
				theme={theme}
			/>
			<TreeGrove
				theme={theme}
				trees={[...green.trees, ...streetTrees, ...(parkScene?.trees ?? [])]}
			/>
			<Bushes bushes={green.bushes} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			{parkScene ? (
				<>
					<Pond
						at={parkScene.pond.at}
						night={night}
						radius={parkScene.pond.radius}
					/>
					<PathStones night={night} size={0.3} stones={parkScene.stones} />
					<Benches benches={parkScene.benches} />
				</>
			) : null}
			<CityBlocks art={art} night={night} plan={plan} />
			<Streets art={art} night={night} plan={plan} />
			<Routes ribbons={ribbons} />
			<Pins art={art} pins={pins} />
			{/* You: the pickup every trip starts from. */}
			<group position={pickup}>
				<ToonMesh color={art.pinPost} position={[0, 0.35, 0]}>
					<cylinderGeometry args={[0.025, 0.025, 0.7, 8]} />
				</ToonMesh>
				<ToonMesh
					castShadow
					color={art.pickup}
					ink={PROP_INK}
					position={[0, 0.76, 0]}
				>
					<sphereGeometry args={[0.13, 18, 12]} />
				</ToonMesh>
				<mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
					<ringGeometry args={[0.16, 0.26, 32]} />
					<CurvedBasicMaterial color={art.pickup} opacity={0.75} transparent />
				</mesh>
			</group>
			<IsoLabel at={[pickup[0], 1.12, pickup[2]]}>You</IsoLabel>
			{acts ? (
				<RidesActProps
					cars={carsAt}
					onStage={acts.onStage}
					reduced={reducedMotion}
					view={acts.view}
					yaws={carYaws}
					youLayout={you.layout}
				/>
			) : null}
			{actCars.map((spot) => (
				<Car
					art={art}
					body={swatches.get(spot.car.agent.id)?.roof[0] ?? art.pickup}
					// A queued car waits as an outline; with acts a car's act
					// decides, and an asking car is honking at the kerb.
					ghost={!acts && spot.car.state === "queued"}
					key={spot.car.id}
					night={night}
					reducedMotion={reducedMotion}
					spot={spot}
				/>
			))}
			{pins.map(({ at, trip }) => {
				const selected = trip.id === selectedTripId;
				return (
					<IsoMarker
						at={[at[0], plateHeights.get(trip.id) ?? PIN_PLATE, at[2]]}
						className="h-6 gap-1 px-2 text-[12px]"
						key={trip.id}
						label={
							selected
								? // The visible words lead the name (label in name).
									`${pinText(trip, acted, acts?.view.trips)} ${trip.thread.title}. Open the trip`
								: `${trip.thread.title}, ${tripWord(trip, acts?.view.trips?.get(trip.id))}. Show the trip`
						}
						onSelect={() =>
							selected ? onOpenTrip(trip.id) : onSelectTrip(trip.id)
						}
						pressed={selected}
					>
						<span className="font-semibold">
							{pinText(trip, acted, acts?.view.trips)}
						</span>
						{selected && !narrow ? (
							<span className="max-w-36 truncate font-normal">
								{trip.thread.title}
							</span>
						) : null}
					</IsoMarker>
				);
			})}
			{acts
				? actCars.map((spot) => {
						const act = actOf.get(spot.car.agent.id);
						if (!act) {
							return null;
						}
						const trip = spot.trip;
						return (
							<RidesCarPlate
								act={act}
								at={[
									spot.at[0],
									act.act === "asking"
										? CAR_PLATE
										: (plateHeights.get(`car:${spot.car.id}`) ?? CAR_PLATE),
									spot.at[2],
								]}
								key={spot.car.id}
								label={trip ? "Show the trip." : "Book a trip."}
								onSelect={() =>
									trip ? onSelectTrip(trip.id) : onPickDriver(spot.car.agent.id)
								}
								pressed={trip !== undefined && trip.id === selectedTripId}
								reduced={reducedMotion}
								view={acts.view}
							/>
						);
					})
				: null}
			{(acts ? [] : cars)
				.filter((spot) => spot.car.state !== "arrived")
				.map((spot) => (
					<IsoMarker
						at={[
							spot.at[0],
							plateHeights.get(`car:${spot.car.id}`) ?? CAR_PLATE,
							spot.at[2],
						]}
						className="h-6 px-2 text-[12px]"
						key={spot.car.id}
						label={carLabel(spot.car, spot.trip)}
						onSelect={() =>
							spot.trip
								? onSelectTrip(spot.trip.id)
								: onPickDriver(spot.car.agent.id)
						}
						pressed={spot.trip !== undefined && spot.trip.id === selectedTripId}
					>
						{spot.car.agent.name}
					</IsoMarker>
				))}
		</group>
	);
}
