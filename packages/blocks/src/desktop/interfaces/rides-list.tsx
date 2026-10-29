import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { CarFront, Flag } from "lucide-react";
import { type ReactNode, useContext, useId } from "react";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { carLabel } from "./rides-diorama.tsx";
import {
	mapTrips,
	type RideCar,
	type RideCity,
	type RideTrip,
	tripWord,
} from "./rides-model.ts";
import { RidesActTrips } from "./rides-parts.tsx";

/**
 * A car's name in the list. With acts it is the car's own words and what
 * pressing it does (the act sentence describes it, so a stopped driver
 * with no trip is never called "available").
 */
function carName(
	car: RideCar,
	trip: RideTrip | undefined,
	acted: boolean,
	/** The trip's act word ("Waiting on you"). */
	word?: string
): string {
	if (!acted) {
		return carLabel(car, trip);
	}
	if (!trip) {
		return `${car.agent.name}. Book a trip`;
	}
	return word
		? `${car.agent.name}, ${word} for ${trip.thread.title}. Show the trip`
		: `${carLabel(car, trip)}. Show the trip`;
}

/**
 * The city as a plain list, for stages without WebGL (and tests): every car
 * and pin the diorama shows, as the same controls (a car shows its trip or
 * picks its driver; a pin shows its trip, and opens it once shown).
 */
export function RidesList({
	acts,
	onOpenTrip,
	onPickDriver,
	onSelectTrip,
	rides,
	selectedTripId,
}: {
	/**
	 * The act layer's rows (a snapshot with `asks`): each driver's act
	 * sentence (its car's description) and status line.
	 */
	acts?: (agentId: string) => { label: string; status: ReactNode } | null;
	onOpenTrip: (tripId: string) => void;
	onPickDriver: (agentId: string) => void;
	onSelectTrip: (tripId: string) => void;
	rides: RideCity;
	selectedTripId: string | null;
}) {
	const tl = useLiteralMessages();
	const trips = mapTrips(rides);
	const actTrips = useContext(RidesActTrips);
	const stageWord = (trip: RideTrip) => tripWord(trip, actTrips?.get(trip.id));
	const baseId = useId();
	const button = cn(
		GAME_FOCUS,
		"flex items-center gap-2 rounded-xl border-(--gk-plate-sunk) border-2 px-3 py-1.5 text-start text-[13px] hover:bg-(--gk-plate-sunk)"
	);
	return (
		<div
			className="absolute inset-0 overflow-auto bg-(--gk-backdrop) px-4 @min-[1000px]:ps-[440px] pt-24 pb-28"
			data-testid="rides-list"
		>
			<div className="mx-auto flex max-w-2xl flex-col gap-4">
				<section
					aria-label="Cars"
					className={cn(GAME_PLATE, "flex flex-col gap-2 p-4")}
				>
					<h2 className="gk-display text-[17px]">Cars</h2>
					<ul className="flex flex-wrap gap-2">
						{rides.cars.map((car) => {
							const trip = rides.trips.find((item) => item.id === car.tripId);
							const row = acts?.(car.agent.id) ?? null;
							const describedBy = `${baseId}-act-${car.id}`;
							return (
								<li
									className={row ? "flex basis-full flex-col gap-1" : undefined}
									key={car.id}
								>
									<button
										aria-describedby={row ? describedBy : undefined}
										// With acts the act sentence describes the car; its
										// name says only what pressing it does.
										aria-label={carName(
											car,
											trip,
											row !== null,
											trip && actTrips
												? tripWord(trip, actTrips.get(trip.id))
												: undefined
										)}
										className={button}
										data-act-agent={row ? car.agent.id : undefined}
										data-testid="rides-car"
										onClick={() =>
											trip ? onSelectTrip(trip.id) : onPickDriver(car.agent.id)
										}
										type="button"
									>
										<CarFront aria-hidden="true" className="size-4" />
										<span className="font-semibold">{car.agent.name}</span>
									</button>
									{row ? (
										<>
											<span className="sr-only" id={describedBy}>
												{row.label}
											</span>
											<div className="px-1">{row.status}</div>
										</>
									) : null}
								</li>
							);
						})}
					</ul>
				</section>
				{trips.length > 0 ? (
					<section
						aria-label="Pins"
						className={cn(GAME_PLATE, "flex flex-col gap-2 p-4")}
					>
						<h2 className="gk-display text-[17px]">On the map</h2>
						<ul className="flex flex-wrap gap-2">
							{trips.map((trip) => {
								const selected = trip.id === selectedTripId;
								return (
									<li key={trip.id}>
										<button
											aria-label={
												selected
													? tl("{tripTitle}, {stage}. Open the trip", {
															stage: stageWord(trip),
															tripTitle: trip.thread.title,
														})
													: tl("{tripTitle}, {stage}. Show the trip", {
															stage: stageWord(trip),
															tripTitle: trip.thread.title,
														})
											}
											aria-pressed={selected}
											className={button}
											data-testid="rides-pin"
											onClick={() =>
												selected ? onOpenTrip(trip.id) : onSelectTrip(trip.id)
											}
											type="button"
										>
											<Flag aria-hidden="true" className="size-4" />
											<span className="flex flex-col">
												<span className="font-semibold">
													{trip.thread.title}
												</span>
												<span className="text-(--gk-ink-muted)">
													{stageWord(trip)}
												</span>
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</section>
				) : null}
			</div>
		</div>
	);
}
