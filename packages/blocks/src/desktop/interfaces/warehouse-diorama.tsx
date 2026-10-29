/* eslint-disable react/no-unknown-property */
import { RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import type { InstancedMesh } from "three";
import { FlowerClusters, type FlowerPatch } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import {
	InstancedParts,
	type InstanceSpec,
	writeInstances,
} from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import type { LifePaths } from "./game3d-life.ts";
import {
	CurvedBasicMaterial,
	ToonMaterial,
	ToonMesh,
} from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Bushes,
	type PlacedBush,
	type PlantedTree,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoLabel, IsoMarker } from "./game3d-stage.tsx";
import { linearRgb, type RenderQuality } from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	GroundRing,
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import type { ShelfLabel } from "./warehouse-acts.tsx";
import {
	AISLE_COUNT,
	AISLE_LETTERS,
	AISLE_MOUTH_X,
	aisleY,
	BELT_PATH,
	BELT_REST,
	FLOOR,
	type FloorPlacement,
	type OrderTab,
	PACKER_SPOT,
	type Picker,
	plural,
	RACK,
	rackRowY,
	type Slot,
	STAGE_LABELS,
	type WarehouseOrder,
} from "./warehouse-model.ts";
import type { WarehouseArt } from "./warehouse-palette.ts";

/**
 * The Warehouse as an isometric diorama on the game kit (game3d-stage.tsx):
 * a cut-away toon warehouse on the island, its back and left walls hung
 * with high windows, a roller door at the receiving bay. Six aisles of blue
 * and orange shelving hold stock; every agent is a villager picker in a
 * cap, walking its aisle with a basket while it works, waiting at the
 * aisle's mouth when idle. Orders are cardboard boxes where their stage
 * lives: on pallets at receiving, riding the conveyor to the packing table,
 * staged with labels on the dock, flagged in the returns cage, or loaded on
 * the truck backed up to the dock. Zone plates and the pickers' name plates
 * are the controls; the clipboard lists every order.
 */

/** One floor tile is this many world units. */
export const TILE = 0.8;
const SLAB = 0.12;
const WALL_HEIGHT = 2.5;
const WALL_THICK = 0.16;
/** The truck backed up to the dock, and the returns cage (floor tiles). */
const TRUCK = { x: 17.4, y: 8.4 } as const;
const CAGE = { d: 2.9, w: 2.8, x: 10.55, y: 10.65 } as const;
const BELT_TOP = 0.44;
const BOX = 0.36;

/** A floor tile point (x along the dock wall, y toward the viewer) in world units. */
export function tileToWorld(x: number, y: number, height = 0): Vec3 {
	return [(x - FLOOR.width / 2) * TILE, height, (y - FLOOR.depth / 2) * TILE];
}

/** The floor's extent in world units, the yard and truck included. */
export const WAREHOUSE_BOUNDS = {
	maxX: (TRUCK.x + 3.4 - FLOOR.width / 2) * TILE,
	maxZ: (FLOOR.depth / 2) * TILE,
	minX: (-FLOOR.width / 2) * TILE,
	minZ: (-FLOOR.depth / 2) * TILE,
};

/** A picker's villager pose from what they carry and what waits for them. */
export function pickerPose(
	picker: Picker,
	orders: readonly WarehouseOrder[]
): VillagerPose {
	if (picker.pose === "picking" || picker.pose === "packing") {
		return "working";
	}
	const mine = orders.filter((order) => order.agent?.id === picker.agent.id);
	if (mine.some((order) => order.stage === "exception")) {
		return "failed";
	}
	if (mine.some((order) => order.stage === "ready")) {
		return "needs-you";
	}
	return "idle";
}

/** The zone a plate opens on the clipboard. */
export interface FloorZone {
	at: Vec3;
	count: number;
	id: string;
	label: string;
	tab: OrderTab;
}

/** The plates over the floor's zones, with their order counts. */
export function floorZones(
	placement: FloorPlacement,
	orders: readonly WarehouseOrder[],
	/** With acts the shipped plate drops beside the truck, clear of the queue. */
	acting = false
): FloorZone[] {
	const count = (stage: WarehouseOrder["stage"]) =>
		orders.filter((order) => order.stage === stage).length;
	const zones: FloorZone[] = [
		{
			// With acts it steps back by the door, clear of the queue's asks.
			at: acting ? tileToWorld(12, 0.4, 1.15) : tileToWorld(12.3, 1.05, 1.15),
			count: count("received"),
			id: "received",
			label: STAGE_LABELS.received,
			tab: "unfulfilled",
		},
		{
			at: tileToWorld(15.9, 3.6, 1.7),
			count: placement.packing.length + placement.overflow.packing,
			id: "packing",
			label: STAGE_LABELS.packing,
			tab: "unfulfilled",
		},
		{
			// With acts it steps forward, clear of the next picker's board.
			at: acting ? tileToWorld(14.1, 10.5, 1.15) : tileToWorld(14.1, 9.9, 1.15),
			count: count("ready"),
			id: "ready",
			label: STAGE_LABELS.ready,
			tab: "ready",
		},
		{
			// With acts the beacon stands over the cage: the plate drops to its front.
			at: acting
				? tileToWorld(CAGE.x + 0.6, CAGE.y + CAGE.d + 0.3, 1.0)
				: tileToWorld(CAGE.x + CAGE.w / 2, CAGE.y + CAGE.d / 2, 1.55),
			count: count("exception"),
			id: "exception",
			label: "Exceptions",
			tab: "exceptions",
		},
		{
			at: acting
				? tileToWorld(TRUCK.x + 1.4, TRUCK.y + 2.4, 1.6)
				: tileToWorld(TRUCK.x + 1.4, TRUCK.y + 0.9, 2.1),
			count: count("shipped"),
			id: "shipped",
			label: STAGE_LABELS.shipped,
			tab: "all",
		},
	];
	// With acts nothing packs on the belt (a live run is picking), so its
	// plate would always read 0.
	return acting ? zones.filter((zone) => zone.id !== "packing") : zones;
}

/** Where an order's box sits right now (world), for the selection ring. */
export function boxSpot(
	orderId: string,
	placement: FloorPlacement,
	pickers: readonly Picker[]
): Vec3 | null {
	const slotted = [
		...placement.received,
		...placement.ready,
		...placement.exception,
	].find((item) => item.order.id === orderId);
	if (slotted) {
		return tileToWorld(slotted.slot.x, slotted.slot.y, SLAB);
	}
	const belt = placement.packing.findIndex((order) => order.id === orderId);
	if (belt !== -1) {
		const slot = BELT_REST[belt] ?? BELT_REST[0];
		return slot ? tileToWorld(slot.x, slot.y, SLAB) : null;
	}
	const picker = pickers.find((item) =>
		item.carrying.some((order) => order.id === orderId)
	);
	if (picker) {
		return tileToWorld(picker.x, picker.y, SLAB);
	}
	if (placement.shipped.some((order) => order.id === orderId)) {
		return tileToWorld(TRUCK.x + 1.4, TRUCK.y + 0.9, SLAB);
	}
	return null;
}

function addBox(
	parts: {
		boxes: InstanceSpec[];
		tapes: InstanceSpec[];
		labels: InstanceSpec[];
	},
	at: Vec3,
	color: string,
	label: boolean,
	seed: number
) {
	const size = BOX * (0.9 + jitter(seed, 1, 3) * 0.2);
	const turn = (jitter(seed, 2, 5) - 0.5) * 0.4;
	parts.boxes.push({
		color,
		position: [at[0], at[1] + size / 2, at[2]],
		rotation: [0, turn, 0],
		scale: [size, size * 0.8, size],
	});
	parts.tapes.push({
		position: [at[0], at[1] + size * 0.8 + 0.004, at[2]],
		rotation: [0, turn, 0],
		scale: [size * 0.22, 0.01, size + 0.01],
	});
	if (label) {
		parts.labels.push({
			position: [at[0], at[1] + size * 0.4, at[2] + size / 2 + 0.004],
			rotation: [0, turn, 0],
			scale: [size * 0.5, size * 0.3, 0.01],
		});
	}
}

/** The building: slab, safety lines, walls, windows, roller door, lamps. */
function Building({ art, night }: { art: WarehouseArt; night: boolean }) {
	const half = { d: (FLOOR.depth / 2) * TILE, w: (FLOOR.width / 2) * TILE };
	const parts = useMemo(() => {
		const lines: InstanceSpec[] = [];
		// Walkway lines down the cross aisle and round the dock.
		const line = (from: Vec3, to: Vec3) => {
			const dx = to[0] - from[0];
			const dz = to[2] - from[2];
			lines.push({
				position: [(from[0] + to[0]) / 2, SLAB + 0.004, (from[2] + to[2]) / 2],
				scale: [Math.abs(dx) + 0.05, 0.008, Math.abs(dz) + 0.05],
			});
		};
		line(tileToWorld(9.0, 0.3), tileToWorld(9.0, 13.7));
		line(tileToWorld(9.0, 7.6), tileToWorld(15.8, 7.6));
		line(tileToWorld(13.1, 8.3), tileToWorld(13.1, 11.5));
		line(tileToWorld(13.1, 11.5), tileToWorld(15.3, 11.5));
		line(tileToWorld(10.2, 0.1), tileToWorld(10.2, 2.2));
		line(tileToWorld(10.2, 2.2), tileToWorld(14.6, 2.2));
		const windows: InstanceSpec[] = [];
		for (let x = 0.8; x < FLOOR.width - 6.5; x += 1.9) {
			const [wx] = tileToWorld(x + 0.7, 0);
			windows.push({
				position: [
					wx,
					SLAB + WALL_HEIGHT - 0.45,
					-half.d + WALL_THICK / 2 + 0.01,
				],
				scale: [1.0, 0.42, 0.02],
			});
		}
		for (let y = 1.2; y < FLOOR.depth - 0.5; y += 2.1) {
			const [, , wz] = tileToWorld(0, y + 0.6);
			windows.push({
				position: [
					-half.w + WALL_THICK / 2 + 0.01,
					SLAB + WALL_HEIGHT - 0.45,
					wz,
				],
				scale: [0.02, 0.42, 1.0],
			});
		}
		const lamps: Vec3[] = [];
		for (let x = 2; x < FLOOR.width; x += 4) {
			for (let y = 2.5; y < FLOOR.depth; y += 4.5) {
				lamps.push(tileToWorld(x, y, 2.1));
			}
		}
		return { lamps, lines, windows };
	}, [half.d, half.w]);
	const door = tileToWorld(12.4, 0);
	return (
		<group>
			<RoundedBox
				args={[half.w * 2 + 0.2, SLAB, half.d * 2 + 0.2]}
				position={[0, SLAB / 2, 0]}
				radius={0.05}
				receiveShadow
			>
				<ToonMaterial color={art.floor} />
			</RoundedBox>
			<InstancedParts items={parts.lines}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.safety} />
			</InstancedParts>
			{/* Back and left walls over a painted dado. */}
			<ToonMesh
				castShadow
				color={art.wallUpper}
				ink={PROP_INK}
				position={[0, SLAB + WALL_HEIGHT / 2, -half.d]}
				receiveShadow
			>
				<boxGeometry args={[half.w * 2 + 0.2, WALL_HEIGHT, WALL_THICK]} />
			</ToonMesh>
			<ToonMesh
				color={art.wallLower}
				position={[0, SLAB + 0.45, -half.d + WALL_THICK / 2 + 0.01]}
			>
				<boxGeometry args={[half.w * 2 + 0.2, 0.9, 0.02]} />
			</ToonMesh>
			<ToonMesh
				castShadow
				color={art.wallUpper}
				ink={PROP_INK}
				position={[-half.w, SLAB + WALL_HEIGHT / 2, 0]}
				receiveShadow
			>
				<boxGeometry args={[WALL_THICK, WALL_HEIGHT, half.d * 2 + 0.2]} />
			</ToonMesh>
			<ToonMesh
				color={art.wallLower}
				position={[-half.w + WALL_THICK / 2 + 0.01, SLAB + 0.45, 0]}
			>
				<boxGeometry args={[0.02, 0.9, half.d * 2 + 0.2]} />
			</ToonMesh>
			<InstancedParts items={parts.windows}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial
					color={art.window}
					emissive={art.window}
					emissiveIntensity={night ? 0.4 : 0.3}
				/>
			</InstancedParts>
			{/* The roller door at the receiving bay: slats and a frame. */}
			<group position={[door[0], SLAB, -half.d + WALL_THICK / 2 + 0.02]}>
				<ToonMesh color={art.safetyDark} position={[0, 0.95, 0]}>
					<boxGeometry args={[3.0, 1.9, 0.03]} />
				</ToonMesh>
				{[0.2, 0.5, 0.8, 1.1, 1.4, 1.7].map((y) => (
					<ToonMesh color={art.door} key={y} position={[0, y, 0.025]}>
						<boxGeometry args={[2.8, 0.24, 0.02]} />
					</ToonMesh>
				))}
			</group>
			{/* Hanging work lights. */}
			{parts.lamps.map((at) => (
				<group key={`${at[0]}:${at[2]}`} position={at}>
					<ToonMesh color={art.lampShade} rotation={[Math.PI, 0, 0]}>
						<coneGeometry args={[0.2, 0.14, 14, 1, true]} />
					</ToonMesh>
					<mesh position={[0, -0.05, 0]}>
						<sphereGeometry args={[0.06, 10, 8]} />
						{night ? (
							<CurvedBasicMaterial color={art.lamp} toneMapped={false} />
						) : (
							<ToonMaterial color={art.lamp} />
						)}
					</mesh>
				</group>
			))}
			{night
				? parts.lamps
						.slice(0, 4)
						.map((at) => (
							<pointLight
								color={art.lamp}
								decay={2}
								distance={5}
								intensity={1.4}
								key={`light:${at[0]}:${at[2]}`}
								position={[at[0], at[1] - 0.2, at[2]]}
							/>
						))
				: null}
		</group>
	);
}

/** Six rows of shelving, three levels each, stocked with boxes and bins. */
function Racks({ art }: { art: WarehouseArt }) {
	const parts = useMemo(() => {
		const uprights: InstanceSpec[] = [];
		const beams: InstanceSpec[] = [];
		const decks: InstanceSpec[] = [];
		const stock: InstanceSpec[] = [];
		const levels = [0.3, 0.62, 0.94];
		const depth = RACK.depth * TILE;
		for (let row = 0; row < AISLE_COUNT; row++) {
			const y = rackRowY(row) + RACK.depth / 2;
			const [x0, , z] = tileToWorld(RACK.x0, y);
			const [x1] = tileToWorld(RACK.x1, y);
			for (let x = x0; x <= x1 + 0.01; x += (x1 - x0) / 4) {
				for (const side of [-1, 1]) {
					uprights.push({
						position: [x, SLAB + 0.55, z + side * (depth / 2 - 0.03)],
						scale: [0.05, 1.1, 0.05],
					});
				}
			}
			for (const level of levels) {
				for (const side of [-1, 1]) {
					beams.push({
						position: [
							(x0 + x1) / 2,
							SLAB + level,
							z + side * (depth / 2 - 0.03),
						],
						scale: [x1 - x0, 0.05, 0.04],
					});
				}
				decks.push({
					position: [(x0 + x1) / 2, SLAB + level + 0.03, z],
					scale: [x1 - x0, 0.02, depth - 0.04],
				});
				for (let x = x0 + 0.18; x < x1 - 0.1; x += 0.32) {
					const seed = Math.round(x * 13 + row * 7 + level * 31);
					if (jitter(seed, 1, 2) < 0.2) {
						continue;
					}
					const tall = 0.14 + jitter(seed, 3, 4) * 0.1;
					stock.push({
						color: jitter(seed, 5, 6) < 0.3 ? art.bin : art.box,
						position: [x, SLAB + level + 0.04 + tall / 2, z],
						scale: [0.24, tall, depth * 0.7],
					});
				}
			}
		}
		return { beams, decks, stock, uprights };
	}, [art]);
	return (
		<group>
			<InstancedParts castShadow items={parts.uprights}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.rackUpright} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.5}
				inkColor={art.rackBeam}
				items={parts.beams}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.rackBeam} />
			</InstancedParts>
			<InstancedParts items={parts.decks} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.rackDeck} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.5}
				inkColor={art.boxDamaged}
				items={parts.stock}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
		</group>
	);
}

/** The conveyor along its path, the packing table at its end. */
function Conveyor({ art }: { art: WarehouseArt }) {
	const parts = useMemo(() => {
		const belts: InstanceSpec[] = [];
		const frames: InstanceSpec[] = [];
		const legs: InstanceSpec[] = [];
		for (let index = 1; index < BELT_PATH.length; index++) {
			const from = BELT_PATH[index - 1];
			const to = BELT_PATH[index];
			if (!(from && to)) {
				continue;
			}
			const a = tileToWorld(from.x, from.y);
			const b = tileToWorld(to.x, to.y);
			const alongX = Math.abs(b[0] - a[0]) > Math.abs(b[2] - a[2]);
			const length = Math.hypot(b[0] - a[0], b[2] - a[2]) + 0.5;
			const mid: Vec3 = [(a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2];
			belts.push({
				position: [mid[0], SLAB + BELT_TOP - 0.02, mid[2]],
				scale: alongX ? [length, 0.04, 0.46] : [0.46, 0.04, length],
			});
			frames.push({
				position: [mid[0], SLAB + BELT_TOP - 0.08, mid[2]],
				scale: alongX ? [length, 0.1, 0.54] : [0.54, 0.1, length],
			});
			const steps = Math.max(2, Math.round(length / 0.9));
			for (let step = 0; step <= steps; step++) {
				const t = step / steps;
				const x = a[0] + (b[0] - a[0]) * t;
				const z = a[2] + (b[2] - a[2]) * t;
				for (const side of [-1, 1]) {
					legs.push({
						position: alongX
							? [x, SLAB + (BELT_TOP - 0.1) / 2, z + side * 0.22]
							: [x + side * 0.22, SLAB + (BELT_TOP - 0.1) / 2, z],
						scale: [0.04, BELT_TOP - 0.1, 0.04],
					});
				}
			}
		}
		return { belts, frames, legs };
	}, []);
	const table = tileToWorld(PACKER_SPOT.x + 0.15, PACKER_SPOT.y - 1.35, SLAB);
	return (
		<group>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.6}
				inkColor={art.beltFrame}
				items={parts.frames}
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.beltFrame} />
			</InstancedParts>
			<InstancedParts items={parts.belts} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.belt} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.legs}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.beltFrame} />
			</InstancedParts>
			{/* The packing table: a bench with a tape roll and flat-packs. */}
			<group position={table}>
				<ToonMesh
					castShadow
					color={art.station}
					ink={PROP_INK}
					position={[0, 0.25, 0]}
					receiveShadow
				>
					<boxGeometry args={[1.0, 0.5, 0.62]} />
				</ToonMesh>
				<ToonMesh color={art.stationTop} position={[0, 0.52, 0]}>
					<boxGeometry args={[1.08, 0.05, 0.7]} />
				</ToonMesh>
				<ToonMesh
					color={art.tape}
					position={[0.3, 0.6, -0.12]}
					rotation={[Math.PI / 2, 0, 0]}
				>
					<torusGeometry args={[0.06, 0.03, 8, 16]} />
				</ToonMesh>
				<ToonMesh color={art.box} position={[-0.25, 0.57, 0.05]}>
					<boxGeometry args={[0.4, 0.04, 0.3]} />
				</ToonMesh>
			</group>
		</group>
	);
}

/** Order boxes riding the belt toward the packing table, in a loop. */
function BeltBoxes({
	art,
	count,
	running,
}: {
	art: WarehouseArt;
	count: number;
	running: boolean;
}) {
	const ref = useRef<InstancedMesh>(null);
	const path = useMemo(
		() => BELT_PATH.map((slot) => tileToWorld(slot.x, slot.y, SLAB + BELT_TOP)),
		[]
	);
	const rest = useMemo(
		() =>
			BELT_REST.slice(0, count).map<InstanceSpec>((slot: Slot) => ({
				color: art.box,
				position: tileToWorld(slot.x, slot.y, SLAB + BELT_TOP + BOX * 0.4),
				scale: [BOX, BOX * 0.8, BOX],
			})),
		[art, count]
	);
	const lengths = useMemo(() => {
		const out: number[] = [];
		for (let index = 1; index < path.length; index++) {
			const a = path[index - 1];
			const b = path[index];
			out.push(a && b ? Math.hypot(b[0] - a[0], b[2] - a[2]) : 0);
		}
		return out;
	}, [path]);
	const total = lengths.reduce((sum, value) => sum + value, 0);
	// Reused every frame: the boxes' positions are written in place.
	const moving = useMemo(
		() =>
			rest.map((item) => ({ ...item, position: [...item.position] as Vec3 })),
		[rest]
	);
	useLayoutEffect(() => {
		if (ref.current) {
			writeInstances(ref.current, rest);
		}
	}, [rest]);
	useFrame(({ clock }) => {
		const mesh = ref.current;
		if (!(mesh && running) || moving.length === 0 || total === 0) {
			return;
		}
		for (const [index, item] of moving.entries()) {
			let along =
				(clock.elapsedTime * 0.45 + (index * total) / moving.length) % total;
			let segment = 0;
			while (segment < lengths.length - 1 && along > (lengths[segment] ?? 0)) {
				along -= lengths[segment] ?? 0;
				segment += 1;
			}
			const a = path[segment] ?? item.position;
			const b = path[segment + 1] ?? a;
			const length = lengths[segment] ?? 0;
			const t = length > 0 ? along / length : 0;
			item.position[0] = a[0] + (b[0] - a[0]) * t;
			item.position[2] = a[2] + (b[2] - a[2]) * t;
		}
		writeInstances(mesh, moving);
	});
	if (count === 0) {
		return null;
	}
	return (
		<instancedMesh
			args={[undefined, undefined, rest.length]}
			castShadow
			key={rest.length}
			ref={ref}
		>
			<boxGeometry args={[1, 1, 1]} />
			<ToonMaterial />
		</instancedMesh>
	);
}

/**
 * The red beacon on a mast over the returns cage's back corner: lit while a
 * run is stopped (a counted blocker), with the newest stop's reason tagged
 * beside it. The cage's own "Stopped" plate sits at its front.
 */
function CageLight({
	art,
	reason,
}: {
	art: WarehouseArt;
	reason: string | null;
}) {
	const at = tileToWorld(CAGE.x + CAGE.w - 0.25, CAGE.y + 0.25, 1.18);
	return (
		<group position={at}>
			<ToonMesh color={art.rackBeam} position={[0, 0.3, 0]}>
				<cylinderGeometry args={[0.05, 0.05, 0.6, 8]} />
			</ToonMesh>
			<ToonMesh color={art.rackBeam} position={[0, 0.62, 0]}>
				<cylinderGeometry args={[0.2, 0.24, 0.1, 14]} />
			</ToonMesh>
			<mesh position={[0, 0.84, 0]}>
				<sphereGeometry args={[0.24, 16, 12]} />
				<meshBasicMaterial color={art.exception} toneMapped={false} />
			</mesh>
			{/* The reason hangs on the cage's front, below the beacon. */}
			{reason ? (
				<IsoLabel at={[-0.7, 0.2, 1.1]}>
					<span data-budgeted-overlay="text">{reason}</span>
				</IsoLabel>
			) : null}
		</group>
	);
}

/** Pallets and the order boxes on them, the returns cage and the dock. */
function Zones({
	art,
	fadedIds,
	placement,
}: {
	art: WarehouseArt;
	fadedIds: ReadonlySet<string>;
	placement: FloorPlacement;
}) {
	const parts = useMemo(() => {
		const pallets: InstanceSpec[] = [];
		const out = {
			boxes: [] as InstanceSpec[],
			labels: [] as InstanceSpec[],
			tapes: [] as InstanceSpec[],
		};
		const pallet = (slot: Slot) => {
			const [x, , z] = tileToWorld(slot.x, slot.y);
			pallets.push({
				position: [x, SLAB + 0.05, z],
				scale: [0.66, 0.1, 0.66],
			});
		};
		for (const { order, slot } of placement.received) {
			pallet(slot);
			addBox(
				out,
				tileToWorld(slot.x, slot.y, SLAB + 0.1),
				fadedIds.has(order.id) ? art.floorEdge : art.box,
				false,
				order.number.length + slot.x * 10
			);
		}
		for (const { order, slot } of placement.ready) {
			pallet(slot);
			addBox(
				out,
				tileToWorld(slot.x, slot.y, SLAB + 0.1),
				fadedIds.has(order.id) ? art.floorEdge : art.box,
				true,
				slot.y * 13 + slot.x
			);
		}
		for (const { order, slot } of placement.exception) {
			addBox(
				out,
				tileToWorld(slot.x, slot.y, SLAB),
				fadedIds.has(order.id) ? art.floorEdge : art.boxDamaged,
				false,
				slot.x * 7 + slot.y
			);
		}
		// The returns cage: corner posts, a top rail and see-through mesh.
		const cagePosts: InstanceSpec[] = [];
		const [cx0, , cz0] = tileToWorld(CAGE.x, CAGE.y);
		const [cx1, , cz1] = tileToWorld(CAGE.x + CAGE.w, CAGE.y + CAGE.d);
		for (const x of [cx0, (cx0 + cx1) / 2, cx1]) {
			for (const z of [cz0, (cz0 + cz1) / 2, cz1]) {
				if (x === (cx0 + cx1) / 2 && z === (cz0 + cz1) / 2) {
					continue;
				}
				cagePosts.push({
					position: [x, SLAB + 0.5, z],
					scale: [0.04, 1.0, 0.04],
				});
			}
		}
		const cagePanels: InstanceSpec[] = [
			{
				position: [(cx0 + cx1) / 2, SLAB + 0.5, cz0],
				scale: [cx1 - cx0, 1.0, 0.01],
			},
			{
				position: [cx0, SLAB + 0.5, (cz0 + cz1) / 2],
				scale: [0.01, 1.0, cz1 - cz0],
			},
			{
				position: [cx1, SLAB + 0.5, (cz0 + cz1) / 2],
				scale: [0.01, 1.0, cz1 - cz0],
			},
			{
				position: [(cx0 + cx1) / 2, SLAB + 0.5, cz1],
				scale: [cx1 - cx0, 1.0, 0.01],
			},
		];
		return {
			cage: { panels: cagePanels, posts: cagePosts, x: cx1, z: cz1 },
			pallets,
			...out,
		};
	}, [art, fadedIds, placement]);
	return (
		<group>
			<InstancedParts castShadow items={parts.pallets} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.pallet} />
			</InstancedParts>
			<InstancedParts
				castShadow
				ink={PROP_INK * 0.6}
				inkColor={art.boxDamaged}
				items={parts.boxes}
				receiveShadow
			>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={parts.tapes}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.tape} />
			</InstancedParts>
			<InstancedParts items={parts.labels}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.label} />
			</InstancedParts>
			<InstancedParts castShadow items={parts.cage.posts}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.cage} />
			</InstancedParts>
			<InstancedParts items={parts.cage.panels}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.cage} opacity={0.28} transparent />
			</InstancedParts>
			{/* The red exception flag on the cage's corner. */}
			<group position={[parts.cage.x, SLAB + 1.0, parts.cage.z]}>
				<ToonMesh color={art.cage} position={[0, 0.25, 0]}>
					<cylinderGeometry args={[0.015, 0.015, 0.5, 6]} />
				</ToonMesh>
				<ToonMesh color={art.exception} position={[0.12, 0.42, 0]}>
					<boxGeometry args={[0.24, 0.16, 0.02]} />
				</ToonMesh>
			</group>
		</group>
	);
}

/** The dock edge outside the right wall, the yard and the truck. */
function Dock({ art, shipped }: { art: WarehouseArt; shipped: number }) {
	const [dockX] = tileToWorld(FLOOR.width, 0);
	const truck = tileToWorld(TRUCK.x, TRUCK.y);
	const boxes = useMemo(() => {
		const out = {
			boxes: [] as InstanceSpec[],
			labels: [] as InstanceSpec[],
			tapes: [] as InstanceSpec[],
		};
		for (let index = 0; index < Math.min(6, shipped); index++) {
			addBox(
				out,
				[
					truck[0] + 0.4 + (index % 3) * 0.42,
					0.55,
					truck[2] + 0.35 + Math.floor(index / 3) * 0.42,
				],
				art.box,
				true,
				index * 9
			);
		}
		return out;
	}, [art, shipped, truck]);
	return (
		<group>
			{/* Yellow and black dock bumpers along the open edge. */}
			{[5.4, 7.6, 9.8, 12].map((y) => {
				const [, , z] = tileToWorld(0, y);
				return (
					<ToonMesh
						color={art.safetyDark}
						key={y}
						position={[dockX + 0.06, SLAB - 0.02, z]}
					>
						<boxGeometry args={[0.1, 0.18, 0.4]} />
					</ToonMesh>
				);
			})}
			<ToonMesh color={art.dockEdge} position={[dockX + 0.02, SLAB + 0.005, 0]}>
				<boxGeometry args={[0.08, 0.012, FLOOR.depth * TILE]} />
			</ToonMesh>
			{/* The trailer, open at the dock end, and its cab. */}
			<group position={truck}>
				<ToonMesh
					castShadow
					color={art.trailer}
					ink={PROP_INK}
					position={[1.4, 0.95, 0.9]}
					receiveShadow
				>
					<boxGeometry args={[2.6, 1.1, 1.3]} />
				</ToonMesh>
				<ToonMesh color={art.trailerStripe} position={[1.4, 0.7, 1.56]}>
					<boxGeometry args={[2.5, 0.12, 0.02]} />
				</ToonMesh>
				<ToonMesh color={art.trailer} position={[1.4, 0.39, 0.9]}>
					<boxGeometry args={[2.6, 0.06, 1.3]} />
				</ToonMesh>
				<group position={[3.1, 0, 0.9]}>
					<ToonMesh
						castShadow
						color={art.cab}
						ink={PROP_INK}
						position={[0.35, 0.65, 0]}
					>
						<boxGeometry args={[0.7, 0.8, 1.2]} />
					</ToonMesh>
					<ToonMesh color={art.window} position={[0.71, 0.82, 0]}>
						<boxGeometry args={[0.02, 0.3, 0.9]} />
					</ToonMesh>
				</group>
				{[0.6, 1.2, 2.2, 3.5].map((x) =>
					[0.3, 1.5].map((z) => (
						<ToonMesh
							color={art.wheel}
							key={`${x}:${z}`}
							position={[x, 0.18, z]}
							rotation={[Math.PI / 2, 0, 0]}
						>
							<cylinderGeometry args={[0.18, 0.18, 0.12, 14]} />
						</ToonMesh>
					))
				)}
			</group>
			<InstancedParts castShadow items={boxes.boxes}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			<InstancedParts items={boxes.labels}>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial color={art.label} />
			</InstancedParts>
		</group>
	);
}

/** Lawn round the building: trees, shrubs, flowers. */
function garden(shape: IslandShape) {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			if (
				!onIsland(shape, fx, fz, 0.6) ||
				(fx > WAREHOUSE_BOUNDS.minX - 0.9 &&
					fx < WAREHOUSE_BOUNDS.maxX + 0.5 &&
					fz > WAREHOUSE_BOUNDS.minZ - 0.9 &&
					fz < WAREHOUSE_BOUNDS.maxZ + 0.6)
			) {
				continue;
			}
			const hash = jitter(x, y, 3);
			if (hash < 0.5) {
				trees.push({
					at: [fx, 0, fz],
					kind: hash < 0.22 ? "cedar" : hash > 0.42 ? "blossom" : "fruit",
					scale: 0.85 + jitter(x, y, 9) * 0.3,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.66) {
				bushes.push({ at: [fx, 0, fz], scale: 0.85, seed: x * 17 + y });
			} else if (hash > 0.84) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}

/** The act layer's cast and props, when the snapshot carries acts. */
export interface WarehouseActors {
	/** The newest counted stop's reason (redaction-safe title), or null. */
	/** A run is stopped: the cage's red light is lit. */
	cageLit: boolean;
	/** The stop's reason tag, when the overlay budget shows it. */
	cageReason: string | null;
	/** Exempt plates collapse to glyphs on narrow stages. */
	iconOnly: boolean;
	paths: LifePaths;
	/** Pickers driven by their acts (and their helpers). */
	pickers: VillagerSpec[];
	/** The dispatch queue, the desk and each station's cues. */
	props: ReactNode;
	/** Shelf labels: what each working picker is at, on its rack (wide stages). */
	shelves: readonly ShelfLabel[];
}

export interface WarehouseDioramaProps {
	/** With the act layer: pickers act out their agents' state. */
	actors?: WarehouseActors;
	art: WarehouseArt;
	fadedIds: ReadonlySet<string>;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	onPickTab: (tab: OrderTab) => void;
	onSelectPicker: (agentId: string) => void;
	orders: readonly WarehouseOrder[];
	pickers: readonly Picker[];
	placement: FloorPlacement;
	quality: RenderQuality;
	reducedMotion: boolean;
	running: boolean;
	selectedAgentId: string | null;
	selectedOrder: WarehouseOrder | undefined;
	shape: IslandShape;
	theme: Scene3dTheme;
}

/** What a picker's name plate says to a screen reader. */
export function pickerLabel(picker: Picker): string {
	const aisle = AISLE_LETTERS[picker.aisle] ?? "A";
	const status =
		picker.pose === "picking"
			? `picking ${plural(picker.carrying.length, "order")}`
			: picker.pose === "packing"
				? "packing"
				: "idle";
	return `${picker.agent.name}, ${status}, aisle ${aisle}. Show their orders`;
}

/** The warehouse diorama: island, building, racks, conveyor, dock, pickers. */
export function WarehouseDioramaScene({
	actors,
	art,
	fadedIds,
	looks,
	night,
	onPickTab,
	onSelectPicker,
	orders,
	pickers,
	placement,
	quality,
	reducedMotion,
	running,
	selectedAgentId,
	selectedOrder,
	shape,
	theme,
}: WarehouseDioramaProps) {
	const acting = actors !== undefined;
	// With acts the yard is paved further back, round to the dispatch queue's
	// back places behind the dock wall.
	const yardBack = acting ? 1.6 : -2.2;
	const yard = useMemo(() => {
		const color: Rgb = linearRgb(art.yard);
		const [dockX] = tileToWorld(FLOOR.width, 0);
		return (x: number, z: number): Rgb | null =>
			x > dockX - 0.1 &&
			x < WAREHOUSE_BOUNDS.maxX + 0.4 &&
			z > WAREHOUSE_BOUNDS.minZ - yardBack &&
			z < WAREHOUSE_BOUNDS.maxZ + 0.3
				? color
				: null;
	}, [art, yardBack]);
	const avoid = useMemo(
		() => (x: number, z: number) =>
			x > WAREHOUSE_BOUNDS.minX - 0.3 &&
			x < WAREHOUSE_BOUNDS.maxX + 0.5 &&
			z > WAREHOUSE_BOUNDS.minZ - Math.max(0.3, yardBack) &&
			z < WAREHOUSE_BOUNDS.maxZ + 0.4,
		[yardBack]
	);
	const green = useMemo(() => garden(shape), [shape]);
	const pastVillagers = useMemo<VillagerSpec[]>(
		() =>
			pickers.flatMap((picker) => {
				const base = looks.get(picker.agent.id);
				if (!base) {
					return [];
				}
				const pose = pickerPose(picker, orders);
				const position = tileToWorld(picker.x, picker.y, SLAB);
				const walk =
					picker.pose === "picking" && !reducedMotion
						? picker.route.xs
								.filter((_, index) => index % 2 === 0)
								.map((x) => tileToWorld(x, picker.y, SLAB))
						: undefined;
				return [
					{
						facing: picker.pose === "packing" ? Math.PI : FACE_CAMERA,
						id: picker.agent.id,
						label: pickerLabel(picker),
						looks: {
							...base,
							accessory: "cap" as const,
							tool: picker.pose === "picking" ? ("basket" as const) : undefined,
						},
						name: picker.agent.name,
						pose,
						position:
							picker.pose === "picking"
								? tileToWorld(
										picker.route.xs[0] ?? AISLE_MOUTH_X,
										aisleY(picker.aisle),
										SLAB
									)
								: position,
						walk,
					},
				];
			}),
		[looks, orders, pickers, reducedMotion]
	);
	const villagers = actors?.pickers ?? pastVillagers;
	const zones = useMemo(
		() => floorZones(placement, orders, acting),
		[acting, orders, placement]
	);
	const selectedAt = selectedOrder
		? boxSpot(selectedOrder.id, placement, pickers)
		: null;
	return (
		<group>
			<IsoIsland paint={yard} shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reducedMotion}
				shape={shape}
				theme={theme}
			/>
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={green.bushes} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			<Building art={art} night={night} />
			<Racks art={art} />
			<Conveyor art={art} />
			<BeltBoxes
				art={art}
				count={placement.packing.length}
				running={running && !reducedMotion}
			/>
			<Zones art={art} fadedIds={fadedIds} placement={placement} />
			{actors?.cageLit ? (
				<CageLight art={art} reason={actors.cageReason} />
			) : null}
			<Dock art={art} shipped={placement.shipped.length} />
			{/* With acts, aisle letters would read as pickers' initials: a working
			    picker's shelf shows what it is at instead (wide stages only). */}
			{actors
				? actors.shelves.map((shelf) => (
						<IsoLabel at={shelf.at} key={shelf.id}>
							{shelf.target}
						</IsoLabel>
					))
				: AISLE_LETTERS.map((letter, aisle) => {
						const at = tileToWorld(RACK.x0 - 0.7, aisleY(aisle), 0.9);
						return (
							<IsoLabel at={at} key={letter}>
								{letter}
							</IsoLabel>
						);
					})}
			{(actors?.iconOnly ? [] : zones).map((zone) => (
				<IsoMarker
					at={zone.at}
					className="h-6 gap-1 px-2 text-[12px]"
					key={zone.id}
					label={`${actors && zone.id === "exception" ? "Stopped" : zone.label}: ${plural(zone.count, "order")}. Show them on the clipboard`}
					onSelect={() => onPickTab(zone.tab)}
				>
					<span className="font-semibold">
						{actors && zone.id === "exception" ? "Stopped" : zone.label}
					</span>
					<span className="tabular-nums opacity-70">{zone.count}</span>
				</IsoMarker>
			))}
			{selectedAt && selectedOrder ? (
				<>
					<GroundRing
						color={art.safety}
						position={[selectedAt[0], SLAB + 0.02, selectedAt[2]]}
						radius={0.42}
						reducedMotion={reducedMotion}
					/>
					<IsoLabel at={[selectedAt[0], 1.15, selectedAt[2]]}>
						{selectedOrder.number}
					</IsoLabel>
				</>
			) : null}
			{actors?.props ?? null}
			<Villagers
				iconOnly={actors?.iconOnly}
				onSelect={onSelectPicker}
				paths={actors?.paths}
				reducedMotion={reducedMotion}
				selectedId={selectedAgentId}
				villagers={villagers}
			/>
		</group>
	);
}
