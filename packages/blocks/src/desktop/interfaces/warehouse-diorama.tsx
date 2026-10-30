/* eslint-disable react/no-unknown-property */
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { type ReactNode, useMemo } from "react";
import { FlowerClusters } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import type { IslandShape } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import type { LifePaths } from "./game3d-life.ts";
import type { Scene3dTheme } from "./game3d-palette.ts";
import { Bushes, TreeGrove } from "./game3d-props.tsx";
import { IsoLabel, IsoMarker } from "./game3d-stage.tsx";
import { linearRgb, type RenderQuality } from "./game3d-toon.ts";
import {
	FACE_CAMERA,
	GroundRing,
	type MemberLooks,
	type VillagerSpec,
	Villagers,
} from "./game3d-villager.tsx";
import type { ShelfLabel } from "./warehouse-acts.tsx";
import { BeltBoxes, CageLight } from "./warehouse-diorama-belt.tsx";
import { Building } from "./warehouse-diorama-building.tsx";
import {
	boxSpot,
	floorZones,
	pickerPose,
	SLAB,
	tileToWorld,
	WAREHOUSE_BOUNDS,
} from "./warehouse-diorama-layout.ts";
import { Conveyor, Racks } from "./warehouse-diorama-racks.tsx";
import { Dock, garden } from "./warehouse-diorama-yard.tsx";
import { Zones } from "./warehouse-diorama-zones.tsx";
import {
	AISLE_LETTERS,
	AISLE_MOUTH_X,
	aisleY,
	FLOOR,
	type FloorPlacement,
	type OrderTab,
	type Picker,
	plural,
	RACK,
	type WarehouseOrder,
} from "./warehouse-model.ts";
import type { WarehouseArt } from "./warehouse-palette.ts";

export type { FloorZone } from "./warehouse-diorama-layout.ts";
export {
	boxSpot,
	floorZones,
	pickerPose,
	TILE,
	tileToWorld,
	WAREHOUSE_BOUNDS,
} from "./warehouse-diorama-layout.ts";

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
export function pickerLabel(picker: Picker, tl?: LiteralMessage): string {
	const aisle = AISLE_LETTERS[picker.aisle] ?? "A";
	const status =
		picker.pose === "picking"
			? `picking ${plural(picker.carrying.length, "order")}`
			: picker.pose === "packing"
				? "packing"
				: "idle";
	if (tl) {
		return tl("{name}, {status}, aisle {aisle}. Show their orders", {
			aisle,
			name: picker.agent.name,
			status,
		});
	}
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
	const tl = useLiteralMessages();
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
						label: pickerLabel(picker, tl),
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
		[looks, orders, pickers, reducedMotion, tl]
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
					label={tl("{zone}: {orders}. Show them on the clipboard", {
						orders: plural(zone.count, "order"),
						zone: actors && zone.id === "exception" ? "Stopped" : zone.label,
					})}
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
