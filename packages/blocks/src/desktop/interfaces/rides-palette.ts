import type { TripStage } from "./rides-model.ts";

/**
 * Rides art: the toon city's roads, kerbs, river, bridges, buildings, cars
 * and pins. This is the one Rides file where literal colours live; the trip
 * panel, chips and controls use the game kit's plates and the theme's
 * semantic tokens instead.
 *
 * The diorama sits on the game kit's shared scene palette
 * (`game3d-palette.ts`): `RIDES_3D` is the city by day and
 * `RIDES_3D_NIGHT` the same city under the stars, its windows warm and its
 * cars' headlights on.
 */

export interface RidesArt {
	bridge: string;
	bridgeRail: string;
	carGlass: string;
	carLight: string;
	carTail: string;
	carWheel: string;
	dash: string;
	glass: string;
	kerb: string;
	litGlass: string;
	pavement: string;
	pickup: string;
	/** Each stage's pin flag, and the route drawn to it. */
	pin: Record<TripStage, string>;
	pinPost: string;
	road: string;
	roofs: readonly string[];
	route: string;
	routeSelected: string;
	walls: readonly string[];
	water: string;
}

const PIN_DAY: Record<TripStage, string> = {
	arrived: "#3fbf7a",
	cancelled: "#e2574c",
	completed: "#9aa3ad",
	enroute: "#3d8bfd",
	requested: "#b9b2a8",
	unassigned: "#b9b2a8",
	unstarted: "#b9b2a8",
};

export const RIDES_3D: RidesArt = {
	bridge: "#c9c2b6",
	bridgeRail: "#f4efe6",
	carGlass: "#bfe3f2",
	carLight: "#fff3c4",
	carTail: "#f06a5a",
	carWheel: "#3a3d46",
	dash: "#fff6d8",
	glass: "#bfe0ee",
	kerb: "#efe6d6",
	litGlass: "#ffd98a",
	pavement: "#e9dfcd",
	pickup: "#ff7a45",
	pin: PIN_DAY,
	pinPost: "#5b616e",
	road: "#a9a6a8",
	roofs: ["#d0664e", "#6f8fc0", "#9a74b0", "#c98f45", "#4f9a8a", "#d07a90"],
	route: "#7fb4ff",
	routeSelected: "#2f7bf5",
	walls: [
		"#f6d2a8",
		"#c9e4b4",
		"#f5bfb4",
		"#bcd8f0",
		"#f7dc86",
		"#dccaf0",
		"#f4efe6",
	],
	water: "#56b8de",
};

export const RIDES_3D_NIGHT: RidesArt = {
	bridge: "#7d7a80",
	bridgeRail: "#b9b2a8",
	carGlass: "#46577a",
	carLight: "#ffe9a8",
	carTail: "#ff5a4a",
	carWheel: "#22252c",
	dash: "#c9c1a8",
	glass: "#34405e",
	kerb: "#9a95a0",
	litGlass: "#ffcf73",
	pavement: "#8b8692",
	pickup: "#ff8a55",
	pin: {
		...PIN_DAY,
		arrived: "#3ed985",
		enroute: "#5aa0ff",
		requested: "#8f8a96",
		unassigned: "#8f8a96",
		unstarted: "#8f8a96",
	},
	pinPost: "#3a3e48",
	road: "#5a5862",
	roofs: ["#8f4c40", "#4f6282", "#62507a", "#86663c", "#43695f", "#8c5766"],
	route: "#4f7fc8",
	routeSelected: "#6aa8ff",
	walls: [
		"#b89a80",
		"#90a882",
		"#b48a84",
		"#8aa0b8",
		"#b8a066",
		"#a294b8",
		"#b2aca2",
	],
	water: "#2a4f86",
};

export function ridesArt(night: boolean): RidesArt {
	return night ? RIDES_3D_NIGHT : RIDES_3D;
}

/** A palette entry by seed, wrapping. */
export function swatch(list: readonly string[], seed: number): string {
	return list[Math.abs(seed) % list.length] ?? list[0] ?? RIDES_3D.road;
}

/**
 * The act layer's car signals: hazard lights on a broken-down car, and the
 * red light a limited driver waits at (its post and the unlit lamps).
 */
export const RIDES_ACT_3D = {
	hazard: "#ffb020",
	hazardOff: "#8a6a2a",
	lightBox: "#2b2f36",
	lightOff: "#4a3a3a",
	lightPost: "#5b6470",
	redLight: "#ff3b2f",
	/** The taxi meter beside a car waiting at the kerb. */
	meter: "#ffcc33",
	/** The honk's sound arcs off a car pulled up at the kerb. */
	honk: "#fff4c2",
	/** Route pips: legs driven, legs ahead, and an estimate's hatching. */
	pipDone: "#ffcc33",
	pipEstimate: "#9fb4c8",
	pipTodo: "#5b6470",
	/** A working car's lit roof sign. */
	roofSign: "#ffd84d",
} as const;
