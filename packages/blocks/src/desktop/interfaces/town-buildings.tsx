/* eslint-disable react/no-unknown-property */
import { Billboard, RoundedBoxGeometry } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import type { Group, Mesh, MeshBasicMaterial } from "three";
import { type CottageSpec, doorWood } from "./game3d-cottages.tsx";
import type { InstanceSpec } from "./game3d-instances.tsx";
import { type AgentSwatch, agentSwatches, swatchOf } from "./game3d-palette.ts";
import { TownMesh, useSim, type Vec3 } from "./town-art.tsx";
import {
	type BuildingKind,
	LOT,
	type TownBuilding,
	type TownFiller,
	type TownLot,
} from "./town-model.ts";
import { hashId, mixHex, type TownPalette } from "./town-palette.ts";

/**
 * The buildings: one per agent, cottage to shop to office tower as its
 * conversations grow, in a facade colour of its own; the houses that fill a
 * district's lots as it grows; and City Hall in the centre. Live work adds
 * a tower crane, a failed run a red beacon with smoke, and a reply waiting
 * on you a speech bubble over the roof.
 */

interface Footprint {
	depth: number;
	width: number;
}

/**
 * Every building is one of the kit's cottages (game3d-cottages.tsx), grown
 * with the agent: a cottage, a bigger shop cottage, then the largest house
 * on the street. Size steps up a little more with each storey.
 */
const COTTAGE_SCALE: Record<BuildingKind, number> = {
	cottage: 0.6,
	shop: 0.7,
	tower: 0.8,
};
/** A kit cottage's footprint and height at scale 1. */
const COTTAGE = { depth: 1.5, height: 2.45, width: 2.5 } as const;

/** The scale an agent's cottage is drawn at. */
export function cottageScale(kind: BuildingKind, floors: number): number {
	return COTTAGE_SCALE[kind] * Math.min(1.12, 1 + (floors - 1) * 0.03);
}

function footprint(kind: BuildingKind, floors: number): Footprint {
	const s = cottageScale(kind, floors);
	return { depth: COTTAGE.depth * s + 0.5, width: COTTAGE.width * s + 0.4 };
}

/** The highest point of an agent building (its roof ridge). */
export function buildingTop(kind: BuildingKind, floors: number): number {
	return COTTAGE.height * cottageScale(kind, floors);
}

/** The box an agent building fills, for hit targets and focus. */
export function buildingBox(building: TownBuilding): {
	max: Vec3;
	min: Vec3;
} {
	const { depth, width } = footprint(building.kind, building.floors);
	const top = buildingTop(building.kind, building.floors);
	return {
		max: [building.lot.x + width / 2, top, building.lot.z + depth / 2],
		min: [building.lot.x - width / 2, 0, building.lot.z - depth / 2],
	};
}

/**
 * Where a building's name tag hangs: just over the highest thing on its
 * lot (the speech bubble, the crane's jib or the beacon's mast), so the
 * tag never sits on the art it names.
 */
export function tagPoint(building: TownBuilding): Vec3 {
	const top = buildingTop(building.kind, building.floors);
	let clearance = 0.25;
	if (building.replied) {
		clearance = building.alert ? 2.25 : 1.45;
	} else if (building.working) {
		clearance = 1.3;
	} else if (building.alert) {
		clearance = 1.1;
	}
	return [building.lot.x, top + clearance, building.lot.z];
}

export const PAD_Y = 0.19;

/** A filler house's scale: a terrace is a touch bigger than a house. */
function fillerScale(filler: TownFiller): number {
	return filler.kind === "terrace" ? 0.5 : 0.44;
}

/**
 * Every building in town as kit cottages, for one instanced draw: agents'
 * buildings with their roof swatch (windows lit while they work), the
 * houses that fill the districts and the parks in quieter swatches, and
 * City Hall's hall. They all face the street toward the viewer.
 */
export function townCottages(
	buildings: readonly TownBuilding[],
	fillers: readonly TownFiller[],
	night: boolean,
	hall: CottageSpec | null
): CottageSpec[] {
	const ids = [
		...buildings.map((building) => building.agent.id),
		...fillers.map((filler) => filler.id),
	];
	const swatches = agentSwatches(ids, night);
	const spec = (
		id: string,
		lot: TownLot,
		scale: number,
		lit: boolean
	): CottageSpec => {
		const hash = hashId(id);
		return {
			chimneySide: hash % 2 === 0 ? 1 : -1,
			door: doorWood(hash >> 3),
			lit,
			origin: [lot.x, PAD_Y, lot.z],
			porch: (hash >> 5) % 2 === 0,
			scale,
			seed: hash % 997,
			swatch: swatchOf(swatches, id),
		};
	};
	return [
		...buildings.map((building) =>
			spec(
				building.agent.id,
				building.lot,
				cottageScale(building.kind, building.floors),
				building.working
			)
		),
		...fillers.map((filler) =>
			spec(filler.id, filler.lot, fillerScale(filler), false)
		),
		...(hall ? [hall] : []),
	];
}

export function AgentBuilding({
	building,
	hovered,
	palette,
	reduced,
	selected,
}: {
	building: TownBuilding;
	hovered: boolean;
	palette: TownPalette;
	reduced: boolean;
	selected: boolean;
}) {
	const { kind, floors, lot } = building;
	const { depth, width } = footprint(kind, floors);
	const top = buildingTop(kind, floors);
	return (
		<group position={[lot.x, PAD_Y, lot.z]}>
			{selected || hovered ? (
				<mesh position={[0, 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
					<ringGeometry args={[LOT * 0.47, LOT * 0.5, 48]} />
					<meshBasicMaterial
						color={palette.status.reply}
						opacity={selected ? 1 : 0.55}
						toneMapped={false}
						transparent
					/>
				</mesh>
			) : null}
			{building.working ? (
				<Crane
					height={top + 1.05}
					palette={palette}
					position={[width / 2 + 0.22, 0, -depth / 2 - 0.2]}
					reduced={reduced}
				/>
			) : null}
			{building.calendar ? (
				<CrossedCalendar
					palette={palette}
					position={[-width / 2 - 0.25, 0, depth / 2 + 0.1]}
				/>
			) : null}
			{building.alert ? (
				<Beacon
					depth={depth}
					kind={kind}
					palette={palette}
					reduced={reduced}
					tone={building.alarm ?? "red"}
					top={top}
					width={width}
				/>
			) : null}
			{building.replied ? (
				<Bubble
					palette={palette}
					reduced={reduced}
					y={top + (building.alert ? 1.55 : 0.7)}
				/>
			) : null}
		</group>
	);
}

/** A schedule that failed: a calendar sign on a post, crossed out in red. */
function CrossedCalendar({
	palette,
	position,
}: {
	palette: TownPalette;
	position: Vec3;
}) {
	return (
		<group position={position}>
			<TownMesh color={palette.craneDark} position={[0, 0.3, 0]}>
				<boxGeometry args={[0.05, 0.6, 0.05]} />
			</TownMesh>
			<TownMesh color={palette.windowLit} position={[0, 0.72, 0]}>
				<boxGeometry args={[0.42, 0.38, 0.04]} />
			</TownMesh>
			{[0.7, -0.7].map((turn) => (
				<TownMesh
					color={palette.status.alert}
					key={turn}
					position={[0, 0.72, 0.03]}
					rotation={[0, 0, turn]}
				>
					<boxGeometry args={[0.46, 0.05, 0.02]} />
				</TownMesh>
			))}
		</group>
	);
}

/** A tower crane beside a building at work; the jib slews slowly. */
function Crane({
	height,
	palette,
	position,
	reduced,
}: {
	height: number;
	palette: TownPalette;
	position: Vec3;
	reduced: boolean;
}) {
	const jib = useRef<Group>(null);
	const hook = useRef<Group>(null);
	const sim = useSim();
	const phase = position[0] * 1.7 + position[2];
	useFrame(() => {
		const time = sim.current.time;
		if (jib.current) {
			jib.current.rotation.y = reduced
				? 0.6
				: 0.6 + Math.sin(time * 0.35 + phase) * 1.1;
		}
		if (hook.current) {
			hook.current.position.y = reduced
				? -0.9
				: -0.9 + Math.sin(time * 0.8 + phase) * 0.35;
		}
	});
	return (
		<group position={position}>
			<TownMesh color={palette.crane} position={[0, height / 2, 0]}>
				<boxGeometry args={[0.1, height, 0.1]} />
			</TownMesh>
			<TownMesh color={palette.craneDark} position={[0, 0.06, 0]}>
				<boxGeometry args={[0.3, 0.12, 0.3]} />
			</TownMesh>
			<group position={[0, height, 0]} ref={jib}>
				<TownMesh color={palette.crane} position={[0.55, 0.04, 0]}>
					<boxGeometry args={[1.9, 0.08, 0.08]} />
				</TownMesh>
				<TownMesh color={palette.craneDark} position={[-0.32, 0.02, 0]}>
					<boxGeometry args={[0.24, 0.16, 0.16]} />
				</TownMesh>
				<TownMesh color={palette.crane} position={[0, 0.16, 0]}>
					<boxGeometry args={[0.16, 0.18, 0.16]} />
				</TownMesh>
				<group position={[1.15, 0, 0]} ref={hook}>
					<mesh position={[0, 0.45, 0]}>
						<boxGeometry args={[0.012, 0.9, 0.012]} />
						<meshBasicMaterial color={palette.ink} />
					</mesh>
					<TownMesh color={palette.craneDark} ink={0}>
						<boxGeometry args={[0.12, 0.08, 0.12]} />
					</TownMesh>
				</group>
			</group>
		</group>
	);
}

const PUFFS = 5;
const MAST = 0.78;

/**
 * A failed run, the loudest thing on the map: a tall mast over the roofline
 * with a red lamp that pulses (a glow ring pings out from it), a red ring
 * round the lot, and dark soot rising from the roof. Reduced motion holds a
 * steady lamp and a still column of smoke.
 */
function Beacon({
	depth,
	kind,
	palette,
	reduced,
	tone,
	top,
	width,
}: {
	depth: number;
	kind: BuildingKind;
	palette: TownPalette;
	reduced: boolean;
	/** Red: lamp, ping and smoke. Calendar: a red lamp, no smoke. Grey: still grey bunting. */
	tone: "calendar" | "grey" | "red";
	top: number;
	width: number;
}) {
	const smoke = tone === "red";
	const lampColor = tone === "grey" ? palette.smoke : palette.status.alert;
	const lamp = useRef<Group>(null);
	const halo = useRef<Mesh>(null);
	const puffs = useRef<(Group | null)[]>([]);
	const sim = useSim();
	const night = palette.mode === "dark";
	// The mast stands at the right of the roof as the mayor sees it, the
	// smoke rises from the left, so neither hides the other.
	// Both stand on the ridge, which runs front to back on every cottage.
	const mast: Vec3 = [0, top - 0.05, depth * 0.12 + width * 0];
	const vent: Vec3 = [0, top - 0.05, -depth * 0.3];
	void kind;
	useFrame(() => {
		const time = sim.current.time;
		// Grey bunting (an interrupted run) hangs still: no pulse, no ping.
		const still = reduced || tone === "grey";
		const pulse = still ? 1 : 0.5 + 0.5 * Math.sin(time * 6);
		if (lamp.current) {
			lamp.current.scale.setScalar(0.85 + pulse * 0.25);
		}
		if (halo.current) {
			const ping = reduced ? 0.4 : (time * 1.1) % 1;
			halo.current.scale.setScalar(0.6 + ping * 1.2);
			const material = halo.current.material as MeshBasicMaterial;
			material.opacity =
				tone === "grey" ? 0 : (night ? 0.6 : 0.45) * (1 - ping);
		}
		for (const [index, puff] of puffs.current.entries()) {
			if (!puff) {
				continue;
			}
			const cycle = reduced
				? (index + 0.5) / PUFFS
				: (time * 0.28 + index / PUFFS) % 1;
			puff.position.set(
				vent[0] - cycle * 1.1 + Math.sin(cycle * 6 + index) * 0.08,
				vent[1] + 0.15 + cycle * 2.2,
				vent[2] - cycle * 0.7
			);
			// Each puff swells as it rises, then thins out before it loops.
			puff.scale.setScalar(
				0.1 + Math.sin(cycle * Math.PI) * (0.18 + cycle * 0.2)
			);
		}
	});
	return (
		<group>
			<mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
				<ringGeometry args={[LOT * 0.44, LOT * 0.5, 48]} />
				<meshBasicMaterial
					color={lampColor}
					opacity={0.9}
					toneMapped={false}
					transparent
				/>
			</mesh>
			<group position={mast}>
				<TownMesh color={palette.craneDark} position={[0, MAST / 2, 0]}>
					<cylinderGeometry args={[0.035, 0.05, MAST, 8]} />
				</TownMesh>
				<TownMesh color={palette.craneDark} position={[0, MAST + 0.03, 0]}>
					<cylinderGeometry args={[0.1, 0.12, 0.08, 12]} />
				</TownMesh>
				<group position={[0, MAST + 0.2, 0]} ref={lamp}>
					<mesh>
						<sphereGeometry args={[0.16, 18, 12]} />
						<meshBasicMaterial color={lampColor} toneMapped={false} />
					</mesh>
				</group>
				<Billboard position={[0, MAST + 0.2, 0]}>
					<mesh ref={halo}>
						<circleGeometry args={[0.32, 32]} />
						<meshBasicMaterial
							color={lampColor}
							depthWrite={false}
							opacity={0.4}
							toneMapped={false}
							transparent
						/>
					</mesh>
				</Billboard>
			</group>
			{Array.from({ length: smoke ? PUFFS : 0 }, (_, index) => (
				<group
					key={`puff-${index.toString()}`}
					ref={(node) => {
						puffs.current[index] = node;
					}}
				>
					<TownMesh castShadow={false} color={palette.smoke} ink={0}>
						<icosahedronGeometry args={[1, 1]} />
					</TownMesh>
				</group>
			))}
		</group>
	);
}

/** A reply waiting on you: a speech bubble over the roof, facing the mayor. */
function Bubble({
	palette,
	reduced,
	y,
}: {
	palette: TownPalette;
	reduced: boolean;
	y: number;
}) {
	const group = useRef<Group>(null);
	const sim = useSim();
	useFrame(() => {
		if (group.current) {
			group.current.position.y = reduced
				? y
				: y + Math.sin(sim.current.time * 2.2) * 0.05;
		}
	});
	return (
		<group position={[0, y, 0]} ref={group} scale={1.45}>
			<Billboard>
				<TownMesh
					castShadow={false}
					color={palette.bubble}
					rotation={[0, 0, Math.PI / 2]}
				>
					<capsuleGeometry args={[0.2, 0.34, 4, 14]} />
				</TownMesh>
				<TownMesh
					castShadow={false}
					color={palette.bubble}
					position={[-0.14, -0.21, 0]}
					rotation={[0, 0, Math.PI]}
				>
					<coneGeometry args={[0.08, 0.14, 8]} />
				</TownMesh>
				{[-0.15, 0, 0.15].map((offset) => (
					<mesh key={`dot-${offset.toString()}`} position={[offset, 0, 0.2]}>
						<sphereGeometry args={[0.045, 10, 8]} />
						<meshBasicMaterial
							color={palette.status.reply}
							toneMapped={false}
						/>
					</mesh>
				))}
			</Billboard>
		</group>
	);
}

/**
 * A house that grew in the district: background stock, so it stays low,
 * small and washed out toward the pavement, with no windows, no plot and
 * no hit target. Only agents get the bright facades.
 */
/** City Hall's hall: the town's biggest cottage, centred on the plaza. */
const HALL_SCALE = 1.25;
const HALL_Z = -0.35;
/** The clock tower rising behind the hall. */
const TOWER = { depth: 1.05, height: 3.25, width: 1.05, z: -1.35 } as const;
const TOWER_ROOF = 1.0;
/** Height of the City Hall clock tower's top, for its label. */
export const HALL_TOP = PAD_Y + TOWER.height + TOWER_ROOF + 0.6;

/** The hall's roof: the town's own colours rather than an agent's swatch. */
function hallSwatch(palette: TownPalette): AgentSwatch {
	return {
		body: palette.hallRoof,
		dot: palette.hallRoof,
		hue: 0,
		lightness: 50,
		ridge: mixHex(palette.hallRoof, palette.ink, 0.4),
		roof: [palette.hallRoof, mixHex(palette.hallRoof, palette.ink, 0.12)],
		saturation: 40,
		tint: palette.hallWall,
	};
}

/** City Hall's hall, as a kit cottage drawn with the rest of the town. */
export function hallCottage(palette: TownPalette, night: boolean): CottageSpec {
	return {
		chimneySide: 1,
		door: doorWood(1),
		lit: night,
		origin: [0, PAD_Y + 0.16, HALL_Z],
		porch: true,
		scale: HALL_SCALE,
		seed: 7,
		swatch: hallSwatch(palette),
	};
}

/**
 * City Hall: a storybook town hall. The hall itself is the town's biggest
 * cottage (drawn with the others, see `hallCottage`); behind it a stone
 * clock tower under a tall tiled spire with a flag, on a paved plinth with
 * steps, and a fountain on the plaza in front.
 */
export function CityHall({
	hovered,
	palette,
	reduced,
}: {
	hovered: boolean;
	palette: TownPalette;
	reduced: boolean;
}) {
	const flag = useRef<Group>(null);
	const sim = useSim();
	useFrame(() => {
		if (flag.current) {
			flag.current.rotation.y = reduced
				? 0
				: Math.sin(sim.current.time * 1.6) * 0.18;
		}
	});
	const night = palette.mode === "dark";
	const front = TOWER.z + TOWER.depth / 2 + 0.01;
	return (
		<group position={[0, PAD_Y, 0]}>
			{hovered ? (
				<mesh position={[0, 0.17, 0]} rotation={[-Math.PI / 2, 0, 0]}>
					<ringGeometry args={[2.75, 2.85, 64]} />
					<meshBasicMaterial
						color={palette.status.reply}
						opacity={0.55}
						toneMapped={false}
						transparent
					/>
				</mesh>
			) : null}
			<TownMesh color={palette.sidewalk} position={[0, 0.08, -0.25]}>
				<RoundedBoxGeometry args={[4.2, 0.16, 3.4]} radius={0.06} />
			</TownMesh>
			{[0, 1].map((step) => (
				<TownMesh
					color={palette.sidewalk}
					ink={0}
					key={`step-${step.toString()}`}
					position={[0, 0.04 + step * 0.05, 1.6 - step * 0.16]}
				>
					<boxGeometry args={[1.6 - step * 0.2, 0.08, 0.3]} />
				</TownMesh>
			))}
			{/* The clock tower: stone walls, a clock face, a tiled spire, a flag. */}
			<TownMesh
				color={palette.hallWall}
				position={[0, 0.16 + TOWER.height / 2, TOWER.z]}
			>
				<RoundedBoxGeometry
					args={[TOWER.width, TOWER.height, TOWER.depth]}
					radius={0.07}
					smoothness={3}
				/>
			</TownMesh>
			<TownMesh
				color={mixHex(palette.hallWall, palette.ink, 0.2)}
				position={[0, 0.16 + TOWER.height - 0.08, TOWER.z]}
			>
				<boxGeometry args={[TOWER.width + 0.14, 0.16, TOWER.depth + 0.14]} />
			</TownMesh>
			<group
				position={[0, 0.16 + TOWER.height + TOWER_ROOF / 2, TOWER.z]}
				rotation={[0, Math.PI / 4, 0]}
			>
				<TownMesh color={palette.hallRoof}>
					<coneGeometry args={[0.92, TOWER_ROOF, 4]} />
				</TownMesh>
			</group>
			<group position={[0, 0.16 + TOWER.height - 0.6, front]}>
				<TownMesh
					castShadow={false}
					color={palette.column}
					rotation={[Math.PI / 2, 0, 0]}
				>
					<cylinderGeometry args={[0.32, 0.32, 0.05, 28]} />
				</TownMesh>
				<mesh position={[0, 0.08, 0.03]}>
					<boxGeometry args={[0.035, 0.19, 0.01]} />
					<meshBasicMaterial color={palette.ink} />
				</mesh>
				<mesh position={[0.06, 0, 0.03]}>
					<boxGeometry args={[0.14, 0.035, 0.01]} />
					<meshBasicMaterial color={palette.ink} />
				</mesh>
			</group>
			{/* A lit arch window under the clock. */}
			<mesh position={[0, 0.16 + TOWER.height * 0.48, front]}>
				<boxGeometry args={[0.26, 0.42, 0.02]} />
				<meshBasicMaterial
					color={night ? palette.windowLit : palette.windowOff}
					toneMapped={!night}
				/>
			</mesh>
			<group position={[0, 0.16 + TOWER.height + TOWER_ROOF, TOWER.z]}>
				<mesh position={[0, 0.3, 0]}>
					<cylinderGeometry args={[0.02, 0.02, 0.6, 6]} />
					<meshBasicMaterial color={palette.ink} />
				</mesh>
				<group position={[0, 0.5, 0]} ref={flag}>
					<mesh position={[0.17, 0, 0]}>
						<boxGeometry args={[0.32, 0.2, 0.015]} />
						<meshBasicMaterial color={palette.status.reply} />
					</mesh>
				</group>
			</group>
			<Fountain palette={palette} position={[0, 0.16, 2.0]} />
		</group>
	);
}

function Fountain({
	palette,
	position,
}: {
	palette: TownPalette;
	position: Vec3;
}) {
	return (
		<group position={position}>
			<TownMesh color={palette.column} position={[0, 0.09, 0]}>
				<cylinderGeometry args={[0.55, 0.6, 0.18, 24]} />
			</TownMesh>
			<mesh position={[0, 0.185, 0]}>
				<cylinderGeometry args={[0.47, 0.47, 0.02, 24]} />
				<meshBasicMaterial color={palette.water} />
			</mesh>
			<TownMesh color={palette.column} position={[0, 0.32, 0]}>
				<cylinderGeometry args={[0.07, 0.1, 0.3, 10]} />
			</TownMesh>
		</group>
	);
}

/** Lots that are zoned but empty: an outline per lot, as four thin rails. */
export function zoneRails(lots: TownLot[]): InstanceSpec[] {
	const items: InstanceSpec[] = [];
	const inset = LOT / 2 - 0.2;
	for (const lot of lots) {
		for (const side of [-1, 1]) {
			items.push({
				position: [lot.x, PAD_Y + 0.005, lot.z + side * inset],
				scale: [inset * 2, 1, 1],
			});
			items.push({
				position: [lot.x + side * inset, PAD_Y + 0.005, lot.z],
				rotation: [0, Math.PI / 2, 0],
				scale: [inset * 2, 1, 1],
			});
		}
	}
	return items;
}
