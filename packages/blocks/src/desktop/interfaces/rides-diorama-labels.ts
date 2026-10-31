import type { LiteralMessage } from "@ryu/i18n/react";
import type { RidesActTrip } from "./rides-acts.tsx";
import {
	chipText,
	type RideCar,
	type RideTrip,
	tripWord,
} from "./rides-model.ts";
import type { RidesArt } from "./rides-palette.ts";

/** What a car's plate says to a screen reader. */
export function carLabel(
	car: RideCar,
	trip: RideTrip | undefined,
	tl: LiteralMessage
): string {
	if (car.state === "driving" && trip) {
		return tl("{name}, driving to {title}", {
			name: car.agent.name,
			title: trip.thread.title,
		});
	}
	if (car.state === "arrived" && trip) {
		return tl("{name}, arrived at {title}", {
			name: car.agent.name,
			title: trip.thread.title,
		});
	}
	if (car.state === "queued" && trip) {
		return tl("{name}, requested for {title}", {
			name: car.agent.name,
			title: trip.thread.title,
		});
	}
	return tl("{name}, available. Book a trip with {name}", {
		name: car.agent.name,
	});
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
