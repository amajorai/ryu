/* eslint-disable react/no-unknown-property */
import { RoundedBox } from "@react-three/drei";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { UtensilsCrossed } from "lucide-react";
import { useMemo } from "react";
import type { OffStage, YouSpotSlot } from "./game3d-acts.ts";
import { FlowerClusters, type FlowerPatch } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import { InstancedParts, type InstanceSpec } from "./game3d-instances.tsx";
import { type IslandShape, onIsland } from "./game3d-island.ts";
import type { LifePaths } from "./game3d-life.ts";
import { ToonMaterial, ToonMesh } from "./game3d-materials.tsx";
import { jitter } from "./game3d-math.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Benches,
	Bushes,
	Crates,
	LampPosts,
	PathStones,
	type PlacedBush,
	type PlantedTree,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoMarker } from "./game3d-stage.tsx";
import type { RenderQuality } from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	type MemberLooks,
	type VillagerPose,
	type VillagerSpec,
	Villagers,
	type VillagerTool,
} from "./game3d-villager.tsx";
import {
	type KitchenActHandlers,
	KitchenPassActs,
	KitchenStationActs,
	stationBurnt,
} from "./kitchen-acts.tsx";
import {
	chefLabel,
	floorCentreZ,
	type KitchenService,
	type KitchenStation,
	type StationKind,
	ticketLabel,
} from "./kitchen-model.ts";
import { type KitchenPalette, pickById } from "./kitchen-palette.ts";
import {
	COUNTER_OFFSET,
	Counter,
	Dish,
	PROP_INK,
	Station,
} from "./kitchen-props.tsx";

/**
 * The Kitchen as an isometric diorama on the game kit (game3d-stage.tsx):
 * a cut-away restaurant kitchen standing on the island, its back and side
 * walls hung with shelves and windows, a tiled floor, one station per chef
 * (stove, board or grill) and the pass at the front where plated dishes
 * wait under heat lamps. The chefs are the kit's villagers in chef's hats,
 * cooking with a pan, ladle or knife, waving when an order is ready and
 * slumped by a burnt one. A herb garden, crates and lamps sit outside.
 */

/** The room's floor is a raised slab; everything inside stands on it. */
export const SLAB = 0.16;
const WALL_HEIGHT = 2.2;
const WALL_THICK = 0.2;
/**
 * Stations and the pass are drawn at villager scale: counters about waist
 * high on a chibi, so every chef shows above their station.
 */
const STATION_SCALE = 0.68;
const PASS_HEIGHT = 0.56;
export const PASS_TOP = PASS_HEIGHT + 0.1;
/** Lawn around the room, for the garden and trees. */
export const KITCHEN_RIM = 2.8;

const TOOL_BY_KIND: Record<StationKind, VillagerTool> = {
	board: "knife",
	grill: "pan",
	stove: "ladle",
};

/** A chef's pose from their station. */
export function chefPoseOf(station: KitchenStation): VillagerPose {
	if (station.burnt) {
		return "failed";
	}
	if (station.working) {
		return "working";
	}
	if (station.orders.some((order) => order.state === "ready")) {
		return "needs-you";
	}
	if (station.orders.some((order) => order.state === "queued")) {
		return "waiting";
	}
	return "idle";
}

/** The kitchen room's extent (in the room's own frame, floor centred). */
export function roomRect(service: KitchenService) {
	const halfWidth = service.floor.width / 2;
	const halfDepth = service.floor.depth / 2;
	return { halfDepth, halfWidth };
}

function floorTiles(
	halfWidth: number,
	halfDepth: number,
	palette: KitchenPalette
): InstanceSpec[] {
	const tiles: InstanceSpec[] = [];
	const columns = Math.floor(halfWidth * 2);
	const rows = Math.floor(halfDepth * 2);
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			tiles.push({
				color: (row + column) % 2 ? palette.floorA : palette.floorB,
				position: [
					-columns / 2 + column + 0.5,
					SLAB + 0.005,
					-rows / 2 + row + 0.5,
				],
				scale: [0.96, 0.02, 0.96],
			});
		}
	}
	return tiles;
}

/** Jars and pots along the shelves on the back wall. */
function shelfJars(halfWidth: number, back: number, palette: KitchenPalette) {
	const jars: InstanceSpec[] = [];
	for (const [level, y] of [1.25, 1.75].entries()) {
		for (let x = -halfWidth + 0.7; x < halfWidth - 0.5; x += 0.42) {
			if (jitter(Math.round(x * 10), level, 3) < 0.25) {
				continue;
			}
			jars.push({
				color: pickById(palette.food, `${x}:${level}`) ?? palette.shelf,
				position: [x, SLAB + y + 0.12, back + WALL_THICK / 2 + 0.16],
				scale: [0.09, 0.2 + jitter(Math.round(x * 10), level, 5) * 0.1, 0.09],
			});
		}
	}
	return jars;
}

/** The cut-away room: slab, tiles, back and left walls, shelves, windows. */
function Room({
	halfDepth,
	halfWidth,
	night,
	palette,
}: {
	halfDepth: number;
	halfWidth: number;
	night: boolean;
	palette: KitchenPalette;
}) {
	const back = -halfDepth;
	const left = -halfWidth;
	const tiles = useMemo(
		() => floorTiles(halfWidth, halfDepth, palette),
		[halfDepth, halfWidth, palette]
	);
	const jars = useMemo(
		() => shelfJars(halfWidth, back, palette),
		[back, halfWidth, palette]
	);
	const windowColor = night ? palette.lamp : palette.sky;
	const windows = [-halfWidth * 0.45, halfWidth * 0.45];
	return (
		<group>
			<RoundedBox
				args={[halfWidth * 2 + 0.3, SLAB, halfDepth * 2 + 0.3]}
				position={[0, SLAB / 2, 0]}
				radius={0.06}
				receiveShadow
			>
				<ToonMaterial color={palette.floorEdge} />
			</RoundedBox>
			<InstancedParts items={tiles} receiveShadow>
				<boxGeometry args={[1, 1, 1]} />
				<ToonMaterial />
			</InstancedParts>
			{/* Back wall: a painted upper wall over a darker wainscot. */}
			<ToonMesh
				castShadow
				color={palette.wallA}
				ink={PROP_INK}
				position={[0, SLAB + WALL_HEIGHT / 2, back]}
				receiveShadow
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, WALL_HEIGHT, WALL_THICK]} />
			</ToonMesh>
			<ToonMesh
				color={palette.wallB}
				position={[0, SLAB + 0.45, back + WALL_THICK / 2 + 0.01]}
			>
				<boxGeometry args={[halfWidth * 2 + 0.3, 0.9, 0.02]} />
			</ToonMesh>
			{/* Left wall, with a window per side. */}
			<ToonMesh
				castShadow
				color={palette.wallA}
				ink={PROP_INK}
				position={[left, SLAB + WALL_HEIGHT / 2, 0]}
				receiveShadow
			>
				<boxGeometry args={[WALL_THICK, WALL_HEIGHT, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			<ToonMesh
				color={palette.wallB}
				position={[left + WALL_THICK / 2 + 0.01, SLAB + 0.45, 0]}
			>
				<boxGeometry args={[0.02, 0.9, halfDepth * 2 + 0.3]} />
			</ToonMesh>
			{[-halfDepth * 0.4, halfDepth * 0.35].map((z) => (
				<group
					key={z}
					position={[left + WALL_THICK / 2 + 0.02, SLAB + 1.45, z]}
				>
					<ToonMesh color={palette.wood}>
						<boxGeometry args={[0.04, 0.72, 0.92]} />
					</ToonMesh>
					<mesh position={[0.02, 0, 0]}>
						<boxGeometry args={[0.02, 0.58, 0.78]} />
						<ToonMaterial
							color={windowColor}
							emissive={windowColor}
							emissiveIntensity={night ? 1.4 : 0.15}
							toneMapped={!night}
						/>
					</mesh>
				</group>
			))}
			{/* Shelves with jars along the back wall, between two windows. */}
			{[1.25, 1.75].map((y) => (
				<ToonMesh
					castShadow
					color={palette.shelf}
					ink={PROP_INK}
					key={y}
					position={[0, SLAB + y, back + WALL_THICK / 2 + 0.16]}
				>
					<boxGeometry args={[halfWidth * 2 - 1, 0.05, 0.32]} />
				</ToonMesh>
			))}
			<InstancedParts castShadow ink={PROP_INK} items={jars}>
				<cylinderGeometry args={[1, 1, 1, 12]} />
				<ToonMaterial />
			</InstancedParts>
			{windows.map((x) => (
				<group key={x} position={[x, SLAB + 2.0, back + WALL_THICK / 2 + 0.02]}>
					<mesh>
						<boxGeometry args={[0.7, 0.24, 0.02]} />
						<ToonMaterial
							color={windowColor}
							emissive={windowColor}
							emissiveIntensity={night ? 1.4 : 0.15}
							toneMapped={!night}
						/>
					</mesh>
				</group>
			))}
		</group>
	);
}

/** Heat lamps hanging over the pass, glowing warm. */
function HeatLamps({
	length,
	palette,
	z,
}: {
	length: number;
	palette: KitchenPalette;
	z: number;
}) {
	const xs = [-length / 3, 0, length / 3];
	return (
		<group>
			{xs.map((x) => (
				<group key={x} position={[x, SLAB + 1.55, z]}>
					<ToonMesh
						color={palette.steel}
						ink={PROP_INK}
						rotation={[Math.PI, 0, 0]}
					>
						<coneGeometry args={[0.2, 0.18, 16, 1, true]} />
					</ToonMesh>
					<mesh position={[0, -0.06, 0]}>
						<sphereGeometry args={[0.07, 12, 8]} />
						<meshBasicMaterial color={palette.lamp} toneMapped={false} />
					</mesh>
					<mesh position={[0, 0.4, 0]}>
						<cylinderGeometry args={[0.01, 0.01, 0.8, 6]} />
						<ToonMaterial color={palette.steel} />
					</mesh>
				</group>
			))}
		</group>
	);
}

/** The garden outside: trees, shrubs, flowers clear of the room. */
function garden(
	shape: IslandShape,
	halfWidth: number,
	halfDepth: number
): { bushes: PlacedBush[]; flowers: FlowerPatch[]; trees: PlantedTree[] } {
	const trees: PlantedTree[] = [];
	const bushes: PlacedBush[] = [];
	const flowers: FlowerPatch[] = [];
	const columns = Math.ceil(shape.halfWidth);
	const rows = Math.ceil(shape.halfDepth);
	for (let y = -rows; y <= rows; y++) {
		for (let x = -columns; x <= columns; x++) {
			const fx = x + (jitter(x, y, 5) - 0.5) * 0.5;
			const fz = y + (jitter(x, y, 7) - 0.5) * 0.5;
			const inside =
				Math.abs(fx) < halfWidth + 1 && Math.abs(fz) < halfDepth + 1.2;
			if (inside || !onIsland(shape, fx, fz, 0.6)) {
				continue;
			}
			const hash = jitter(x, y, 3);
			const front = fz > halfDepth;
			if (!front && hash < 0.55) {
				trees.push({
					at: [fx, 0, fz],
					kind: hash < 0.25 ? "cedar" : hash > 0.47 ? "blossom" : "fruit",
					scale: 0.8 + jitter(x, y, 9) * 0.3,
					seed: Math.round(hash * 1000),
				});
			} else if (hash < 0.7) {
				bushes.push({ at: [fx, 0, fz], scale: 0.85, seed: x * 17 + y });
			} else if (hash > 0.8) {
				flowers.push({ at: [fx, 0, fz], x, y });
			}
		}
	}
	return { bushes, flowers, trees };
}

/**
 * The act layer, when the host sends asks (kitchen-acts.tsx): the chefs'
 * act villagers and the props at the stations and the pass. Without it the
 * kitchen draws today's poses and dishes.
 */
export interface KitchenActScene {
	acts: ReadonlyMap<string, InterfaceAgentAct>;
	handlers: KitchenActHandlers;
	offStage: OffStage;
	/** Chefs in stage (urgency) order: the dishes on the pass follow it. */
	onStage: readonly InterfaceAgentAct[];
	owners: ReadonlyMap<string, string>;
	paths: LifePaths;
	slots: { overflow: number; slots: readonly YouSpotSlot[] };
	villagers: readonly VillagerSpec[];
}

export interface KitchenDioramaProps {
	actScene?: KitchenActScene | null;
	hoverId: string | null;
	looks: ReadonlyMap<string, MemberLooks>;
	night: boolean;
	now: number;
	onHover: (id: string | null) => void;
	onSelectChef: (agentId: string) => void;
	onServe: (threadId: string) => void;
	palette: KitchenPalette;
	quality: RenderQuality;
	reduced: boolean;
	selectedChefId: string | null;
	service: KitchenService;
	shape: IslandShape;
	theme: Scene3dTheme;
}

/** The kitchen diorama: island, garden, the cut-away room, chefs, the pass. */
export function KitchenDioramaScene({
	actScene = null,
	hoverId,
	looks,
	night,
	now,
	onHover,
	onSelectChef,
	onServe,
	palette,
	quality,
	reduced,
	selectedChefId,
	service,
	shape,
	theme,
}: KitchenDioramaProps) {
	const { halfDepth, halfWidth } = roomRect(service);
	// The room's own frame puts its floor's centre at the origin.
	const centreZ = floorCentreZ(service.floor);
	const avoid = useMemo(
		() => (x: number, z: number) =>
			Math.abs(x) < halfWidth + 0.35 && Math.abs(z) < halfDepth + 0.35,
		[halfDepth, halfWidth]
	);
	const green = useMemo(
		() => garden(shape, halfWidth, halfDepth),
		[halfDepth, halfWidth, shape]
	);
	const outside = useMemo(() => {
		const front = halfDepth + 0.9;
		const stones: Vec3[] = [];
		for (let z = front; z < shape.halfDepth - 0.4; z += 0.7) {
			stones.push([halfWidth * 0.55 + Math.sin(z * 2) * 0.1, 0, z]);
		}
		return {
			benches: [{ at: [-halfWidth * 0.4, 0, front + 0.5] as Vec3, yaw: 0 }],
			crates: [
				{ at: [-halfWidth - 0.7, 0, -halfDepth + 0.6] as Vec3, yaw: 0.3 },
				{ at: [-halfWidth - 0.75, 0, -halfDepth + 1.2] as Vec3, yaw: -0.2 },
				{
					at: [-halfWidth - 0.72, 0.44, -halfDepth + 0.9] as Vec3,
					scale: 0.8,
					yaw: 0.5,
				},
			],
			lamps: [
				[halfWidth + 0.5, 0, front - 0.3],
				[-halfWidth - 0.5, 0, front - 0.3],
			] as Vec3[],
			stones,
		};
	}, [halfDepth, halfWidth, shape]);
	const villagers = useMemo<VillagerSpec[]>(
		() =>
			service.stations.flatMap((station) => {
				const base = looks.get(station.agent.id);
				if (!base) {
					return [];
				}
				const pose = chefPoseOf(station);
				return [
					{
						facing: pose === "working" || pose === "failed" ? 0 : FACE_CAMERA,
						id: station.agent.id,
						label: `${chefLabel(station)}. Open their tickets`,
						looks: {
							...base,
							accessory: "chef",
							tool: pose === "working" ? TOOL_BY_KIND[station.kind] : undefined,
						},
						name: station.agent.name,
						pose,
						position: [station.x, SLAB, station.z - centreZ],
					},
				];
			}),
		[centreZ, looks, service.stations]
	);
	const pass = service.floor.pass;
	const cast = actScene?.villagers ?? villagers;
	return (
		<group>
			<IsoIsland shape={shape} theme={theme} />
			<IslandGrass
				avoid={avoid}
				quality={quality}
				reducedMotion={reduced}
				shape={shape}
				theme={theme}
			/>
			<TreeGrove theme={theme} trees={green.trees} />
			<Bushes bushes={green.bushes} theme={theme} />
			<FlowerClusters patches={green.flowers} />
			<Benches benches={outside.benches} />
			<Crates crates={outside.crates} />
			<LampPosts lamps={outside.lamps} night={night} />
			<PathStones night={night} size={0.5} stones={outside.stones} />
			<Room
				halfDepth={halfDepth}
				halfWidth={halfWidth}
				night={night}
				palette={palette}
			/>
			<group position={[0, SLAB, -centreZ]}>
				{service.stations.map((station) => (
					<group
						key={station.agent.id}
						position={[station.x, 0, station.z + COUNTER_OFFSET * 0.85]}
						scale={STATION_SCALE}
					>
						<Station
							burnt={
								actScene
									? stationBurnt(
											actScene.acts.get(station.agent.id)?.blockers ?? []
										)
									: station.burnt
							}
							id={station.agent.id}
							kind={station.kind}
							palette={palette}
							position={[0, 0, 0]}
							reduced={reduced}
							working={
								actScene
									? actScene.acts.get(station.agent.id)?.act === "working"
									: station.working
							}
						/>
					</group>
				))}
				<Counter
					height={PASS_HEIGHT}
					palette={palette}
					position={[pass.x, 0, pass.z]}
					top={palette.steel}
					width={pass.length}
				/>
				<HeatLamps length={pass.length} palette={palette} z={pass.z} />
				{actScene
					? service.stations.map((station) => {
							const act = actScene.acts.get(station.agent.id);
							return act ? (
								<KitchenStationActs
									act={act}
									handlers={actScene.handlers}
									key={station.agent.id}
									station={station}
								/>
							) : null;
						})
					: null}
				{actScene ? (
					<KitchenPassActs
						handlers={actScene.handlers}
						offStage={actScene.offStage}
						onStage={actScene.onStage}
						owners={actScene.owners}
						palette={palette}
						passTop={PASS_TOP}
						service={service}
						slots={actScene.slots}
					/>
				) : null}
				{(actScene ? [] : service.dishes).map((dish) => (
					<group key={dish.ticket.id}>
						<Dish
							hovered={hoverId === dish.ticket.id}
							id={dish.ticket.id}
							onHover={onHover}
							onServe={onServe}
							palette={palette}
							position={[dish.x, PASS_TOP, dish.z]}
							reduced={reduced}
						/>
						<IsoMarker
							at={[dish.x, PASS_TOP + 0.75, dish.z]}
							className="size-8 justify-center px-0"
							label={`Serve ${ticketLabel(dish.ticket, now)}`}
							onSelect={() => onServe(dish.ticket.id)}
						>
							<UtensilsCrossed aria-hidden="true" className="size-4" />
						</IsoMarker>
					</group>
				))}
				{palette.lampIntensity > 0 ? (
					<pointLight
						color={palette.lampLight}
						decay={2}
						distance={7}
						intensity={palette.lampIntensity * 1.2}
						position={[pass.x, 2.4, pass.z - 0.2]}
					/>
				) : null}
			</group>
			<Villagers
				iconOnly={actScene?.handlers.iconOnly ?? false}
				onHover={onHover}
				onSelect={onSelectChef}
				paths={actScene?.paths}
				reducedMotion={reduced}
				selectedId={selectedChefId}
				villagers={cast}
			/>
		</group>
	);
}
