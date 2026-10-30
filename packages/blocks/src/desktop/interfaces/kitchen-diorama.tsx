/* eslint-disable react/no-unknown-property */
import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { UtensilsCrossed } from "lucide-react";
import { useMemo } from "react";
import type { OffStage, YouSpotSlot } from "./game3d-acts.ts";
import { FlowerClusters } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import type { IslandShape } from "./game3d-island.ts";
import type { LifePaths } from "./game3d-life.ts";
import type { Scene3dTheme, Vec3 } from "./game3d-palette.ts";
import {
	Benches,
	Bushes,
	Crates,
	LampPosts,
	PathStones,
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
import { garden } from "./kitchen-diorama-garden.ts";
import { HeatLamps, Room, SLAB } from "./kitchen-diorama-room.tsx";
import {
	chefLabel,
	floorCentreZ,
	type KitchenService,
	type KitchenStation,
	type StationKind,
	ticketLabel,
} from "./kitchen-model.ts";
import type { KitchenPalette } from "./kitchen-palette.ts";
import { COUNTER_OFFSET, Counter, Dish, Station } from "./kitchen-props.tsx";

/**
 * The Kitchen as an isometric diorama on the game kit (game3d-stage.tsx):
 * a cut-away restaurant kitchen standing on the island, its back and side
 * walls hung with shelves and windows, a tiled floor, one station per chef
 * (stove, board or grill) and the pass at the front where plated dishes
 * wait under heat lamps. The chefs are the kit's villagers in chef's hats,
 * cooking with a pan, ladle or knife, waving when an order is ready and
 * slumped by a burnt one. A herb garden, crates and lamps sit outside.
 */

export { SLAB } from "./kitchen-diorama-room.tsx";

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
	const tl = useLiteralMessages();
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
						label: tl("{chef}. Open their tickets", {
							chef: chefLabel(station),
						}),
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
		[centreZ, looks, service.stations, tl]
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
							label={tl("Serve {ticket}", {
								ticket: ticketLabel(dish.ticket, now),
							})}
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
