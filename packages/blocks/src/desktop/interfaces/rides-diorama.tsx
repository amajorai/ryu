/* eslint-disable react/no-unknown-property */
import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import { useMemo } from "react";
import { stationLines } from "./game3d-act-stage.tsx";
import { YOU_SLOTS } from "./game3d-acts.ts";
import { FlowerClusters } from "./game3d-grass.tsx";
import { IslandGrass, IsoIsland } from "./game3d-ground.tsx";
import type { IslandShape } from "./game3d-island.ts";
import type { Rgb } from "./game3d-lawn.ts";
import { CurvedBasicMaterial, ToonMesh } from "./game3d-materials.tsx";
import type { AgentSwatch, Scene3dTheme } from "./game3d-palette.ts";
import {
	Benches,
	Bushes,
	PathStones,
	type PlantedTree,
	Pond,
	PROP_INK,
	TreeGrove,
} from "./game3d-props.tsx";
import { IsoLabel, IsoMarker } from "./game3d-stage.tsx";
import { linearRgb, type RenderQuality } from "./game3d-toon.ts";
import {
	RidesActProps,
	type RidesActView,
	RidesCarPlate,
	ridesBoardOffset,
	ridesCarTarget,
	ridesYouSpot,
} from "./rides-acts.tsx";
import { CityBlocks, inRect, Streets } from "./rides-diorama-city.tsx";
import { carLabel, pinText, ribbonColor } from "./rides-diorama-labels.ts";
import { countryside, park } from "./rides-diorama-parkland.ts";
import { Car, Pins, Routes } from "./rides-diorama-vehicles.tsx";
import { mapTrips, PICKUP, type RideCity, tripWord } from "./rides-model.ts";
import type { RidesArt } from "./rides-palette.ts";
import {
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
} from "./rides-scene.ts";

export { carLabel } from "./rides-diorama-labels.ts";

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
	const tl = useLiteralMessages();
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
									tl("{word} {title}. Open the trip", {
										title: trip.thread.title,
										word: pinText(trip, acted, acts?.view.trips),
									})
								: tl("{title}, {word}. Show the trip", {
										title: trip.thread.title,
										word: tripWord(trip, acts?.view.trips?.get(trip.id)),
									})
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
