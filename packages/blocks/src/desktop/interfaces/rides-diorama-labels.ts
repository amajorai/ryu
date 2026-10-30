import type { RidesActTrip } from "./rides-acts.tsx";
import {
	chipText,
	type RideCar,
	type RideTrip,
	tripWord,
} from "./rides-model.ts";
import type { RidesArt } from "./rides-palette.ts";

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

/** A route's colour: bright when picked, plain en route (and with acts), else its stage's. */
export function ribbonColor(
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
export function pinText(
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
